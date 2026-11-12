// The background service: the loopback UI/API server, the review and pipeline
// runners, the Workspace and its Copilot sessions, in a process of its own. The window
// app starts it (detached) and shows its URL; closing the window leaves it
// running while work is in flight, and it exits on its own once it's idle.
//
// One per user-data folder: service.lock holds the pid, service.json the
// address. Logs go to logs/service.log (rotated).

import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { buildCommit, buildId, openLock, readServiceInfo, readServicePort, serviceFiles, serviceStatus, writeServicePort, type ServiceInfo, type ServiceStatus } from "./service-files.mjs";
import { ServiceLifecycle } from "./service-lifecycle.mjs";
import { DATA_FOLDER } from "./brand.mjs";

const appDir = dirname(fileURLToPath(import.meta.url));
const SHUTDOWN_BUDGET_MS = 10_000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const num = (value: string | undefined, fallback: number): number => (Number(value) > 0 ? Number(value) : fallback);
/** No window and nothing in flight for this long, and the service exits. */
const IDLE_EXIT_MS = num(process.env.ADO_PR_OPS_SERVICE_IDLE_MS, 2 * 60_000);
const IDLE_CHECK_MS = num(process.env.ADO_PR_OPS_SERVICE_CHECK_MS, 10_000);

const userData = process.env.ADO_PR_OPS_USER_DATA || join(process.env.APPDATA || homedir(), DATA_FOLDER);
const files = serviceFiles(userData);
// Electron reads ELECTRON_RUN_AS_NODE only at start. Left set, everything this process launches
// (the Copilot CLI, workers' shells, resume terminals) would inherit it, and any Electron app
// started from them would run as plain Node instead of opening a window.
delete process.env.ELECTRON_RUN_AS_NODE;
delete process.env.ADO_PR_OPS_USER_DATA;

// ---- the log ------------------------------------------------------------------------

/** Console output goes to logs/service.log; past 5 MB it moves to service.1.log and starts over. */
function openLog(): void {
    mkdirSync(files.logs, { recursive: true });
    const old = files.log.replace(/\.log$/, ".1.log");
    let fd = openSync(files.log, "a");
    let size = statSync(files.log).size;
    const write = (level: string, args: unknown[]) => {
        const line = `${new Date().toISOString()} ${level} ${format(...args)}\n`;
        try {
            if (size + line.length > LOG_MAX_BYTES) {
                closeSync(fd);
                renameSync(files.log, old);
                fd = openSync(files.log, "a");
                size = 0;
            }
            size += writeSync(fd, line);
        } catch {
            /* a log that can't be written must never take the service down */
        }
    };
    console.log = (...args: unknown[]) => write("info", args);
    console.info = console.log;
    console.warn = (...args: unknown[]) => write("warn", args);
    console.error = (...args: unknown[]) => write("error", args);
}

// ---- one service per user-data folder -----------------------------------------------

/** The open, exclusive handle on service.lock: held until the process ends, however it ends. */
let lockFd: number | null = null;

/**
 * Take this data folder's lock: true when this process now holds it, false when
 * a live service does. Windows releases the lock when its holder exits, crash
 * included, so a leftover file is never stale, and a reused pid can't fake a
 * holder. A service that is stopping is waited out.
 */
async function acquireLock(): Promise<boolean> {
    mkdirSync(dirname(files.lock), { recursive: true });
    const deadline = Date.now() + 20_000;
    for (;;) {
        const fd = openLock(files.lock);
        if (fd !== null) {
            lockFd = fd;
            writeSync(fd, String(process.pid));
            return true;
        }
        const info = readServiceInfo(userData);
        const status = info && (await serviceStatus(info));
        if (status && status.state !== "stopping") return false;
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 250));
    }
}

function releaseFiles(): void {
    // Only ever remove our own info: a successor may already have taken over.
    if (readServiceInfo(userData)?.pid === process.pid) rmSync(files.info, { force: true });
    if (lockFd !== null) {
        try {
            closeSync(lockFd);
        } catch {
            /* closing on the way out */
        }
        lockFd = null;
        rmSync(files.lock, { force: true });
    }
}

function writeInfo(info: ServiceInfo): void {
    const tmp = `${files.info}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(info, null, 1));
    renameSync(tmp, files.info);
}

// ---- data -----------------------------------------------------------------------------

function configureDataPaths(): { dbPath: string; configPath: string } {
    const dbPath = (process.env.ADO_PR_OPS_DB_PATH ||= join(userData, "data", "reviews.db"));
    const configPath = (process.env.ADO_PR_OPS_CONFIG_PATH ||= join(userData, "config.json"));
    process.env.ADO_PR_OPS_WORK_DIR ||= join(userData, "sessions");
    process.env.ADO_PR_OPS_JARVIS_DIR ||= join(userData, "jarvis");
    return { dbPath, configPath };
}

/** Copy the retired canvas extension's reviews and settings once, when this app has none yet. */
async function migrateExtensionData(dbPath: string, configPath: string): Promise<void> {
    const legacy = join(homedir(), ".copilot", "extensions", "ado-pr-ops");
    await mkdir(dirname(dbPath), { recursive: true });
    await mkdir(dirname(configPath), { recursive: true });

    const legacyDb = join(legacy, "data", "reviews.db");
    if (!existsSync(dbPath) && existsSync(legacyDb)) {
        const staging = `${dbPath}.migrating`;
        await rm(staging, { force: true });
        try {
            // VACUUM INTO reads through the WAL, so it is consistent even while
            // the extension still has the database open.
            const source = new DatabaseSync(legacyDb);
            try {
                source.exec(`VACUUM INTO '${staging.replace(/'/g, "''")}'`);
            } finally {
                source.close();
            }
            await rename(staging, dbPath);
        } catch (error) {
            await rm(staging, { force: true });
            console.error(`[migrate] reviews were not copied: ${(error as Error).message}`);
        }
    }

    const legacyConfig = join(legacy, "config.json");
    if (!existsSync(configPath) && existsSync(legacyConfig)) {
        await copyFile(legacyConfig, configPath).catch((error: Error) =>
            console.error(`[migrate] settings were not copied: ${error.message}`),
        );
    }
}

// ---- run --------------------------------------------------------------------------------

async function main(): Promise<void> {
    openLog();
    if (!(await acquireLock())) {
        console.log(`[service] another service is running for ${userData}; this one (${process.pid}) exits`);
        process.exit(0);
    }

    let state: ServiceStatus["state"] = "starting";
    let stop: (reason: string) => Promise<void> = async () => {
        releaseFiles();
        process.exit(0);
    };
    process.on("SIGINT", () => void stop("SIGINT"));
    process.on("SIGTERM", () => void stop("SIGTERM"));
    process.on("SIGBREAK", () => void stop("SIGBREAK"));
    process.on("uncaughtException", (error) => {
        console.error(`[service] uncaught: ${error.stack || error.message}`);
        releaseFiles();
        process.exit(1);
    });
    process.on("unhandledRejection", (reason) => console.error(`[service] unhandled rejection: ${(reason as Error)?.stack || reason}`));

    const { dbPath, configPath } = configureDataPaths();
    await migrateExtensionData(dbPath, configPath);
    // Before anything reads the config, which creates it: no config yet means a new install, set up on first open.
    const { initSetupState, readSetupState } = await import("./setup-state.mjs");
    initSetupState(configPath);
    // Before anything runs git: Devis' own Git goes on PATH when the machine's won't do.
    (await import("./machine-tools.mjs")).prepareGit();

    const { startServer } = await import("./server.mjs");
    const { apiActivity } = await import("./api.mjs");
    const { sendJson, readBody } = await import("./http.mjs");
    const { startReviewRunner, stopReviewRunner, reviewRunnerActivity } = await import("./review-runner.mjs");
    const { startPipelineRunner, stopPipelineRunner, pipelineActivity } = await import("./pipeline-runner.mjs");
    const { closeAllReviewerSessions, reviewerActivity } = await import("./reviewer-session.mjs");
    const { closeAllWorkers, messageWorker, workerActivity } = await import("./jarvis-workers.mjs");
    const { closeLead, leadActivity } = await import("./jarvis-lead.mjs");
    const { startOverviewRunner, stopOverviewRunner } = await import("./jarvis-overview.mjs");
    const { startPrsRunner, stopPrsRunner } = await import("./jarvis-prs.mjs");
    const { startValidationRunner, stopValidationRunner } = await import("./jarvis-validation.mjs");
    const { startPrCommentsRunner, stopPrCommentsRunner } = await import("./jarvis-pr-comments.mjs");
    const { startPrBuildsRunner, stopPrBuildsRunner } = await import("./jarvis-pr-builds.mjs");
    const { startCommsRunner, stopCommsRunner } = await import("./comms.mjs");
    const { startMaintenance, stopMaintenance } = await import("./maintenance.mjs");
    const { watchShips } = await import("./devis-self.mjs");
    const { stopCopilotClient, warmCopilot } = await import("./copilot-runtime.mjs");
    const { setupActivity } = await import("./setup-actions.mjs");
    const { closeDb } = await import("./store.mjs");

    const lifecycle = new ServiceLifecycle({
        idleExitMs: IDLE_EXIT_MS,
        checkMs: IDLE_CHECK_MS,
        onIdle: () => void stop("idle"),
        keepAlive: () => readSetupState().startAtSignIn,
    });
    lifecycle.register("setup", setupActivity);
    lifecycle.register("workers", workerActivity);
    lifecycle.register("lead", leadActivity);
    lifecycle.register("reviews", reviewRunnerActivity);
    lifecycle.register("reviewer sessions", reviewerActivity);
    lifecycle.register("pipelines", pipelineActivity);
    lifecycle.register("api", apiActivity);

    const info: ServiceInfo = { pid: process.pid, url: "", buildId: buildId(appDir), appDir, startedAt: new Date().toISOString(), commit: buildCommit(appDir) };
    const status = async (): Promise<ServiceStatus> => ({
        ...info,
        attached: lifecycle.attached,
        work: await lifecycle.work(),
        state,
        stopping: state === "stopping",
    });

    const routes = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
        if (!url.pathname.startsWith("/api/service/")) return false;
        if (url.pathname === "/api/service/status" && req.method === "GET") {
            sendJson(res, 200, await status());
            return true;
        }
        // A window holds this open while it shows the service; the service stays up while any does.
        if (url.pathname === "/api/service/attach" && req.method === "GET") {
            // A stopping service takes no new windows: the window starts a fresh one instead.
            if (state === "stopping") {
                sendJson(res, 503, { error: "The service is stopping." });
                return true;
            }
            const detach = lifecycle.attach();
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
            res.write("attached\n");
            req.socket.setKeepAlive(true, 30_000);
            res.on("close", detach);
            return true;
        }
        if (url.pathname === "/api/service/stop" && req.method === "POST") {
            const body = await readBody(req);
            const work = await lifecycle.work();
            if (body?.whenIdle && work.length) {
                sendJson(res, 409, { error: "The service has work in flight.", work });
                return true;
            }
            sendJson(res, 202, { stopping: true });
            setImmediate(() => void stop("requested"));
            return true;
        }
        sendJson(res, 404, { error: "not found" });
        return true;
    };

    const running = await startServer(join(appDir, "web"), { routes, port: readServicePort(userData) });
    info.url = running.url;
    writeServicePort(userData, Number(new URL(running.url).port));
    let stopShipWatch = (): void => undefined;
    stop = async (reason: string) => {
        if (state === "stopping") return;
        state = "stopping";
        lifecycle.stop();
        console.log(`[service] stopping (${reason})`);
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
            (async () => {
                const closing = running.close();
                await Promise.all([stopReviewRunner(), stopPipelineRunner(), stopOverviewRunner(), stopPrsRunner(), stopCommsRunner(), stopMaintenance()]);
                stopValidationRunner();
                stopPrCommentsRunner();
                stopPrBuildsRunner();
                stopShipWatch();
                await Promise.all([closeAllReviewerSessions(), closeAllWorkers(), closeLead()]);
                await stopCopilotClient();
                await closing;
                closeDb();
            })().catch((error: Error) => console.error(`[service] shutdown: ${error.message}`)),
            new Promise((resolve) => (timer = setTimeout(resolve, SHUTDOWN_BUDGET_MS))),
        ]);
        clearTimeout(timer);
        releaseFiles();
        console.log("[service] stopped");
        process.exit(0);
    };

    await startReviewRunner();
    await startPipelineRunner();
    startOverviewRunner();
    startPrsRunner();
    startValidationRunner();
    startPrCommentsRunner();
    startPrBuildsRunner();
    startCommsRunner();
    startMaintenance();
    // A ship of Devis' own change that didn't go live goes back to the worker that made it.
    stopShipWatch = watchShips({
        notGoneLive: (ship, message) =>
            void messageWorker(ship.sessionId, message, undefined, "queue").catch((error: Error) => console.warn(`[devis] ship ${ship.n}: ${error.message}`)),
    });
    writeInfo(info);
    state = "running";
    lifecycle.start();
    console.log(`[service] ${process.pid} serving ${running.url} (build ${info.buildId})`);
    // Copilot runs through Agency, which takes a few seconds to start: start it now, not on the first review.
    void warmCopilot().catch((error: Error) => console.warn(`[copilot] could not start the runtime early: ${error.message}`));
}

main().catch((error: Error) => {
    console.error(`[service] could not start: ${error.stack || error.message}`);
    // Also to the boot log, which the window shows when the service doesn't come up.
    process.stderr.write(`could not start: ${error.stack || error.message}\n`);
    releaseFiles();
    process.exit(1);
});
