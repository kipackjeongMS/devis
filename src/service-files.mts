// The background service's footprint in the user's data folder, and how a client
// (the window app, the deploy script's equivalent, the harness) finds, starts,
// watches and stops it. No Electron here: the window app and plain Node share it.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ServiceInfo {
    pid: number;
    url: string;
    buildId: string;
    appDir: string;
    startedAt: string;
    /** The git commit the installed build was packaged from (build-info.json), when known. */
    commit?: string | null;
}

export interface WorkItem {
    kind: "worker" | "recap" | "lead" | "review" | "reviewer" | "pipeline" | "other";
    label: string;
}

export interface ServiceStatus extends ServiceInfo {
    /** Windows attached to the service right now. */
    attached: number;
    /** What keeps it running with no window: turns, reviews and pipeline runs in flight. */
    work: WorkItem[];
    /** starting → running → stopping; a stopping service takes no new windows. */
    state: "starting" | "running" | "stopping";
    stopping: boolean;
}

export function serviceFiles(userData: string) {
    const logs = join(userData, "logs");
    return {
        info: join(userData, "service.json"),
        lock: join(userData, "service.lock"),
        /** The port the last service listened on; the next one takes it again, so the page keeps its origin and its storage. */
        port: join(userData, "service.port"),
        logs,
        log: join(logs, "service.log"),
        boot: join(logs, "service-boot.log"),
    };
}

/** The port the last service used, or 0 for any. */
export function readServicePort(userData: string): number {
    try {
        const port = Number(readFileSync(serviceFiles(userData).port, "utf8").trim());
        return Number.isInteger(port) && port > 1024 && port < 65536 ? port : 0;
    } catch {
        return 0;
    }
}

export function writeServicePort(userData: string, port: number): void {
    try {
        writeFileSync(serviceFiles(userData).port, String(port));
    } catch {
        /* the next service picks any port */
    }
}

/** The installed backend's identity: a hash of its modules. A client only reuses a service built from the same code. */
export function buildId(appDir: string): string {
    const hash = createHash("sha256");
    for (const name of readdirSync(appDir).filter((n) => n.endsWith(".mjs")).sort()) {
        hash.update(name).update("\0").update(readFileSync(join(appDir, name))).update("\0");
    }
    return hash.digest("hex").slice(0, 16);
}

/** The commit the build in appDir was packaged from, or null for a dev build. */
export function buildCommit(appDir: string): string | null {
    try {
        const info = JSON.parse(readFileSync(join(appDir, "build-info.json"), "utf8")) as { commit?: unknown };
        return typeof info.commit === "string" && /^[0-9a-f]{7,40}$/i.test(info.commit) ? info.commit : null;
    } catch {
        return null;
    }
}

export function readServiceInfo(userData: string): ServiceInfo | null {
    try {
        const info = JSON.parse(readFileSync(serviceFiles(userData).info, "utf8")) as ServiceInfo;
        return Number.isInteger(info.pid) && typeof info.url === "string" ? info : null;
    } catch {
        return null;
    }
}

/**
 * libuv's UV_FS_O_EXLOCK: on Windows the file is opened with no sharing, so
 * nobody else can open, read or delete it until the holder closes it or exits,
 * crash included. The service holds service.lock this way for its whole life.
 */
export const EXLOCK = 0x10000000;

/** Open the lock file exclusively, or null when another process holds it. */
export function openLock(path: string): number | null {
    try {
        return openSync(path, constants.O_RDWR | constants.O_CREAT | EXLOCK);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EBUSY" || code === "EPERM" || code === "EACCES") return null;
        throw error;
    }
}

/** True while a live service holds this data folder's lock. */
export function lockHeld(userData: string): boolean {
    const files = serviceFiles(userData);
    mkdirSync(dirname(files.lock), { recursive: true });
    const fd = openLock(files.lock);
    if (fd === null) return true;
    closeSync(fd);
    return false;
}

export function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM: it exists, it just isn't ours to signal.
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** When a process started, in ms since the epoch, or null when that can't be read. */
export async function processStartedAt(pid: number): Promise<number | null> {
    if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) return null;
    try {
        const { stdout } = await execFileAsync(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
            { windowsHide: true, timeout: 15_000 },
        );
        const at = Date.parse(stdout.trim());
        return Number.isFinite(at) ? at : null;
    } catch {
        return null;
    }
}

/**
 * Whether `info.pid` is still the process that wrote `info`. A service writes its info a
 * few seconds after it starts; a process that reused the pid started after the service
 * ended, so after `startedAt`. When the start time can't be read, the answer is no.
 */
export async function isServiceProcess(info: ServiceInfo): Promise<boolean> {
    const wrote = Date.parse(info.startedAt);
    if (!Number.isFinite(wrote) || !isAlive(info.pid)) return false;
    if (process.platform !== "win32") return true;
    const started = await processStartedAt(info.pid);
    return started !== null && started <= wrote + 2_000 && started >= wrote - 5 * 60_000;
}

function call<T>(url: string, method: "GET" | "POST", timeoutMs: number, body?: unknown): Promise<{ status: number; data: T }> {
    return new Promise((resolve, reject) => {
        const req = request(url, { method, timeout: timeoutMs, headers: body ? { "Content-Type": "application/json" } : {} }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
                try {
                    const text = Buffer.concat(chunks).toString("utf8");
                    resolve({ status: res.statusCode || 0, data: (text ? JSON.parse(text) : null) as T });
                } catch (error) {
                    reject(error);
                }
            });
        });
        req.on("timeout", () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
        req.on("error", reject);
        req.end(body ? JSON.stringify(body) : undefined);
    });
}

/** The service's status, or null when nothing answers as that service at that address. */
export async function serviceStatus(info: ServiceInfo, timeoutMs = 3_000): Promise<ServiceStatus | null> {
    try {
        const { status, data } = await call<ServiceStatus>(new URL("api/service/status", info.url).toString(), "GET", timeoutMs);
        return status === 200 && data?.pid === info.pid ? data : null;
    } catch {
        return null;
    }
}

/** The running service described by the info file, if it answers. */
export async function findService(userData: string): Promise<ServiceStatus | null> {
    const info = readServiceInfo(userData);
    if (!info || !isAlive(info.pid)) return null;
    return serviceStatus(info);
}

/**
 * Ask the service to stop, and resolve once its process is gone. With
 * `whenIdle`, only a service that agrees (it has nothing in flight) is stopped:
 * one that refuses says what it's doing, and one that doesn't answer clearly is
 * left alone, never killed, since it may be in the middle of work.
 */
export async function stopService(
    info: ServiceInfo,
    opts: { whenIdle?: boolean; timeoutMs?: number } = {},
): Promise<{ stopped: true } | { stopped: false; work: WorkItem[]; unanswered?: true }> {
    const ask = () =>
        call<{ work?: WorkItem[] }>(new URL("api/service/stop", info.url).toString(), "POST", 5_000, { whenIdle: !!opts.whenIdle }).catch(
            () => ({ status: 0, data: null as { work?: WorkItem[] } | null }),
        );
    let answer = await ask();
    if (opts.whenIdle && answer.status !== 202) {
        if (answer.status === 409) return { stopped: false, work: answer.data?.work || [] };
        if (!isAlive(info.pid)) return { stopped: true };
        // No clear answer (a timeout, a reset): ask once more before giving up.
        answer = await ask();
        if (answer.status === 409) return { stopped: false, work: answer.data?.work || [] };
        if (answer.status !== 202) {
            if (!isAlive(info.pid)) return { stopped: true };
            return { stopped: false, work: (await serviceStatus(info))?.work || [], unanswered: true };
        }
    }
    const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
    while (isAlive(info.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    // It agreed to stop (or was told to), but its shutdown hung: end it, if the pid is still it.
    if (isAlive(info.pid) && (await isServiceProcess(info))) {
        try {
            process.kill(info.pid);
        } catch {
            /* already gone */
        }
    }
    return { stopped: true };
}

export interface StartOptions {
    userData: string;
    appDir: string;
    /** The runtime to run service.mjs with: node, or Electron in node mode. */
    execPath: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
}

/** Start a detached service and wait until it answers. It outlives the process that started it. */
export async function startService(opts: StartOptions): Promise<ServiceStatus> {
    const files = serviceFiles(opts.userData);
    mkdirSync(files.logs, { recursive: true });
    // Only the start that failed is worth keeping: anything the service prints before its own log is open.
    if (existsSync(files.boot) && statSync(files.boot).size > 0) {
        try {
            renameSync(files.boot, `${files.boot}.prev`);
        } catch {
            /* in use by a service that's still starting */
        }
    }
    const out = openSync(files.boot, "a");
    const started = Date.now();
    let child;
    try {
        child = spawn(opts.execPath, [join(opts.appDir, "service.mjs")], {
            detached: true,
            windowsHide: true,
            // Not the install folder: a process working there would keep an update from replacing it.
            cwd: opts.userData,
            stdio: ["ignore", out, out],
            env: { ...process.env, ...opts.env, ELECTRON_RUN_AS_NODE: "1", ADO_PR_OPS_USER_DATA: opts.userData },
        });
    } finally {
        closeSync(out);
    }
    let exited: number | null = null;
    let spawnError: Error | null = null;
    child.once("error", (error) => {
        spawnError = error;
        exited = -1;
    });
    child.once("exit", (code) => (exited = code ?? -1));
    child.unref();
    const deadline = started + (opts.timeoutMs ?? 30_000);
    while (Date.now() < deadline) {
        // A start that lost the race to another one exits at once; either way, the one that answers is the service.
        const info = readServiceInfo(opts.userData);
        if (info && isAlive(info.pid)) {
            const status = await serviceStatus(info);
            if (status) return status;
        }
        if (exited !== null && exited !== 0) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    let boot = "";
    try {
        boot = readFileSync(files.boot, "utf8").slice(-2_000);
    } catch {
        /* nothing written */
    }
    const why = spawnError ? `: ${(spawnError as Error).message}` : exited !== null ? ` (exit ${exited})` : "";
    throw new Error(`The background service didn't start${why}.${boot ? `\n${boot}` : ""}`);
}

export type EnsureResult =
    | { kind: "ready"; status: ServiceStatus }
    | { kind: "outdated"; status: ServiceStatus; unanswered?: boolean }
    /** Alive and holding the lock, but not answering: hung. Safe to end by its pid. */
    | { kind: "unresponsive"; info: ServiceInfo };

/** How long a service that holds the lock may go without answering before it counts as hung. */
export const UNRESPONSIVE_AFTER_MS = 15_000;

/**
 * The service for this build: reuse the running one, or start one. A service
 * from other code (an earlier install, a dev build) is replaced when it's idle,
 * and reported as outdated when it has work in flight or won't say, for the
 * caller to decide. A hung one is reported as unresponsive, never duplicated.
 */
export async function ensureService(opts: StartOptions & { expectedBuildId?: string; hangAfterMs?: number }): Promise<EnsureResult> {
    const want = opts.expectedBuildId ?? buildId(opts.appDir);
    let running = await findService(opts.userData);
    if (!running) {
        // Nothing answers. A live pid that holds the lock is our service, busy or hung: give it a
        // moment (a long pause, a slow start) before calling it hung. A free lock means no service.
        let info = readServiceInfo(opts.userData);
        if (info && isAlive(info.pid) && lockHeld(opts.userData)) {
            const deadline = Date.now() + (opts.hangAfterMs ?? UNRESPONSIVE_AFTER_MS);
            while (!running && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 500));
                // Read the info again each time: another start may have taken over meanwhile.
                const now = readServiceInfo(opts.userData);
                if (!now || !isAlive(now.pid) || !lockHeld(opts.userData)) {
                    info = null;
                    break;
                }
                info = now;
                running = await serviceStatus(info);
            }
            if (!running && info && isAlive(info.pid) && lockHeld(opts.userData)) return { kind: "unresponsive", info };
        }
        running ??= await findService(opts.userData);
    }
    if (running && running.buildId === want && running.appDir === opts.appDir && running.state !== "stopping") {
        return { kind: "ready", status: running };
    }
    if (running) {
        const result = await stopService(running, { whenIdle: true });
        if (!result.stopped) return { kind: "outdated", status: { ...running, work: result.work }, unanswered: result.unanswered };
    }
    return { kind: "ready", status: await startService(opts) };
}

/** End a hung service by its pid. Only for one `ensureService` reported unresponsive. */
export async function endService(info: ServiceInfo, userData: string): Promise<boolean> {
    // The lock says a service holds this folder; the start time says it's this one. A held lock alone
    // isn't enough: a newer service may hold it while `info` names a pid Windows has since reused.
    if (!isAlive(info.pid) || !lockHeld(userData) || !(await isServiceProcess(info))) return false;
    try {
        process.kill(info.pid);
    } catch {
        /* already gone */
    }
    const deadline = Date.now() + 10_000;
    while (isAlive(info.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    return true;
}

export interface WatchOptions {
    /** The service went away: its process exited, or the connection broke. */
    onLost: () => void;
    /** The service is still there but stopped answering for `misses` checks in a row. */
    onUnresponsive: () => void;
    intervalMs?: number;
    timeoutMs?: number;
    misses?: number;
}

/**
 * Watch the service a window shows: hold a connection open (the service counts
 * attached windows and stays up while any is) and check that it still answers.
 * A connection that drops means it's gone; one that stays open while status
 * calls keep timing out means it's hung.
 */
export function watchService(info: ServiceInfo, opts: WatchOptions): { close(): void } {
    let closed = false;
    let missed = 0;
    let checking = false;
    const lost = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        opts.onLost();
    };
    const req = request(new URL("api/service/attach", info.url), { method: "GET" }, (res) => {
        // A stopping service turns windows away: treat it as gone, so the window starts a fresh one.
        if (res.statusCode !== 200) req.destroy();
        res.resume();
        res.on("close", lost);
    });
    req.on("error", lost);
    req.end();
    const timer = setInterval(() => {
        if (closed || checking) return;
        checking = true;
        void serviceStatus(info, opts.timeoutMs ?? 5_000)
            .then((status) => {
                if (closed) return;
                if (status) {
                    missed = 0;
                    return;
                }
                if (!isAlive(info.pid)) return lost();
                if (++missed >= (opts.misses ?? 4)) {
                    missed = 0;
                    opts.onUnresponsive();
                }
            })
            .finally(() => (checking = false));
    }, opts.intervalMs ?? 15_000);
    timer.unref?.();
    return {
        close() {
            closed = true;
            clearInterval(timer);
            req.destroy();
        },
    };
}

/** Hold a connection open while a window shows the service; `onLost` runs if the service goes away. */
export function attachToService(info: ServiceInfo, onLost: () => void): { close(): void } {
    return watchService(info, { onLost, onUnresponsive: () => {}, intervalMs: 60 * 60_000 });
}
