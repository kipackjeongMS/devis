// One Copilot CLI runtime shared by every SDK session the desktop app runs:
// background reviewers, the reviewer chat, Ask/Elaborate, rephrase, the model
// catalog, and the Workspace's Lead, workers and write-ups. It runs through Agency
// (`agency copilot`), so every session gets Agency's MCP servers, plugins and
// session tracking, on the user's own Copilot login and session store (a
// session can be reopened with `agency copilot --resume <id>`). Agency would run
// whatever `copilot` it finds, so Devis points it (AGENCY_COPILOT_PATH) at the Copilot
// runtime that ships inside Devis (the SDK's platform package), the version this SDK
// is built for. Without Agency it runs that runtime directly, and only when that's
// missing too, the `copilot` CLI on PATH; either way it says so.
//
// To keep the machine responsive, the runtime and every MCP server under it run at
// below-normal CPU priority (runtime-priority.mts), and sessions share one
// Playwright MCP server over HTTP instead of each starting its own (shared-playwright.mts).

import {
    CopilotClient,
    RuntimeConnection,
    type CopilotSession,
    type MCPServerConfig,
    type MessageOptions,
    type PermissionHandler,
} from "@github/copilot-sdk";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { APP_NAME } from "./brand.mjs";
import { keepTreeLow } from "./runtime-priority.mjs";
import { sharedMcpServers, sharedPlaywrightReady, startSharedPlaywright, stopSharedPlaywright } from "./shared-playwright.mjs";

const execFileAsync = promisify(execFile);

/** How long a starting runtime waits on for the shared Playwright server, so the first sessions get it too. */
const PLAYWRIGHT_GRACE_MS = 5_000;

export const CLIENT_NAME = "ado-pr-ops";

let cliPathPromise: Promise<string> | null = null;
let clientPromise: Promise<CopilotClient> | null = null;

async function locateCopilotCli(): Promise<string> {
    const override = process.env.ADO_PR_OPS_COPILOT_PATH?.trim();
    if (override) return override;
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const { stdout } = await execFileAsync(locator, ["copilot"], { windowsHide: true });
    const candidates = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    // A .cmd/.ps1 shim cannot be spawned without a shell; prefer the real binary.
    const cliPath =
        process.platform === "win32"
            ? candidates.find((path) => /\.exe$/i.test(path)) || candidates[0]
            : candidates[0];
    if (!cliPath) throw new Error("Copilot CLI is not available on PATH");
    return cliPath;
}

export function resolveCopilotCliPath(): Promise<string> {
    if (!cliPathPromise) {
        cliPathPromise = locateCopilotCli().catch((error) => {
            cliPathPromise = null;
            throw error;
        });
    }
    return cliPathPromise;
}

/** How the app starts Copilot. */
export interface CopilotRuntime {
    /** Agency's `copilot`, the runtime built into Devis, or the `copilot` CLI on PATH. */
    via: "agency" | "bundled" | "copilot";
    /** The program to run, and the arguments that come before Copilot's own. */
    command: string;
    args: string[];
    /** Environment added for the runtime: Agency's AGENCY_COPILOT_PATH, when Devis pins its own Copilot. */
    env?: Record<string, string>;
    /** Whether the Copilot that runs is the one built into Devis (directly, or under Agency). */
    builtIn: boolean;
    /** Set when Copilot runs without Agency: what's missing, for the user to see. */
    warning: string | null;
}

/**
 * The oldest Copilot CLI this SDK works with: older ones don't know `session.options.update`, which the
 * SDK sends for any session that skips custom instructions (the Lead, reviews, summaries), so those fail
 * with "Unhandled method session.options.update" while workers still run.
 */
export const MIN_COPILOT_VERSION = "1.0.51";

/** a < b, comparing major.minor.patch (a pre-release or build suffix is ignored). Unreadable is never older. */
export function olderThan(a: string | null | undefined, b: string): boolean {
    const parse = (v: string | null | undefined) => /^v?(\d+)\.(\d+)\.(\d+)/.exec((v || "").trim())?.slice(1).map(Number) ?? null;
    const x = parse(a);
    const y = parse(b);
    if (!x || !y) return false;
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]!;
    return false;
}

let runningVersion: string | null = null;

/** The Copilot version the shared runtime reported when it started, or null before it has. */
export const copilotVersion = (): string | null => runningVersion;

/** What to say when the runtime is too old for something Devis asked of it. */
export function explainCopilotError(message: string): string {
    if (!/Unhandled method session\.options\.update/i.test(message)) return message;
    return `Copilot ${runningVersion ? `CLI ${runningVersion} is` : "is"} too old for ${APP_NAME}: it needs ${MIN_COPILOT_VERSION} or newer. Run copilot update in a terminal, then restart ${APP_NAME}.`;
}

/**
 * The headless Copilot runtime in the SDK's platform package, which ships inside Devis.
 * It reads the same Copilot login and session store as the CLI. Null when it isn't there.
 */
export function bundledRuntimePath(): string | null {
    if (process.env.ADO_PR_OPS_NO_BUNDLED_COPILOT) return null;
    const platform = `${process.platform}-${process.arch}`;
    try {
        const pkg = createRequire(import.meta.url).resolve(`@github/copilot-sdk-${platform}/package.json`);
        const exe = join(dirname(pkg), "prebuilds", platform, process.platform === "win32" ? "copilot-runtime.exe" : "copilot-runtime");
        return existsSync(exe) && existsSync(join(dirname(exe), "runtime.node")) ? exe : null;
    } catch {
        return null;
    }
}

let runtimePromise: Promise<CopilotRuntime> | null = null;

const WITHOUT_AGENCY =
    "no Agency MCP servers or plugins in reviews and the Workspace, so Teams catch-up, meeting recaps and code search wait for it. Install Agency, then restart Devis.";

async function locateRuntime(): Promise<CopilotRuntime> {
    const agency = agencyExePath();
    const bundled = bundledRuntimePath();
    if (agency) {
        // Agency runs whatever `copilot` it finds, which can be older than this SDK supports (or
        // newer than it was tested with). Point it at the runtime built into Devis, which matches the SDK.
        if (bundled && !process.env.ADO_PR_OPS_AGENCY_OWN_COPILOT) {
            return { via: "agency", command: agency, args: ["copilot"], env: { AGENCY_COPILOT_PATH: bundled }, builtIn: true, warning: null };
        }
        return { via: "agency", command: agency, args: ["copilot"], builtIn: false, warning: null };
    }
    const looked = `Agency isn't installed (looked for ${agencyExpectedPath()})`;
    if (bundled) {
        const warning = `${looked}, so Copilot runs on the runtime built into Devis: ${WITHOUT_AGENCY}`;
        console.warn(`[copilot] ${warning}`);
        return { via: "bundled", command: bundled, args: [], builtIn: true, warning };
    }
    const cli = await resolveCopilotCliPath();
    const warning = `${looked}, so Copilot runs on the Copilot CLI: ${WITHOUT_AGENCY}`;
    console.warn(`[copilot] ${warning}`);
    return { via: "copilot", command: cli, args: [], builtIn: false, warning };
}

/** Agency's `copilot` when it's installed, else the built-in runtime, else the CLI. Read once per service. */
export function resolveCopilotRuntime(): Promise<CopilotRuntime> {
    if (!runtimePromise) {
        runtimePromise = locateRuntime().catch((error) => {
            runtimePromise = null;
            throw error;
        });
    }
    return runtimePromise;
}

/**
 * The command line that reopens a session in an interactive CLI, through Agency when it's there.
 * The built-in runtime has no terminal of its own, so then it takes the `copilot` CLI on PATH,
 * which reads the same session store.
 */
export async function resumeCommand(sessionId: string): Promise<{ command: string; args: string[] }> {
    const runtime = await resolveCopilotRuntime();
    if (runtime.via !== "bundled") return { command: runtime.command, args: [...runtime.args, "--resume", sessionId] };
    const cli = await resolveCopilotCliPath().catch(() => null);
    if (!cli) throw new Error("Opening a session in a terminal needs Agency or the Copilot CLI. Install Agency, then restart Devis.");
    return { command: cli, args: ["--resume", sessionId] };
}

const RUNTIME_LABEL: Record<CopilotRuntime["via"], string> = {
    agency: "Agency",
    bundled: "the runtime built into Devis",
    copilot: "the plain Copilot CLI",
};

export function getCopilotClient(): Promise<CopilotClient> {
    if (!clientPromise) {
        clientPromise = (async () => {
            const runtime = await resolveCopilotRuntime();
            // `env` replaces the inherited environment, so it carries all of it plus the additions.
            const env = runtime.env ? { ...inheritedEnv(), ...runtime.env } : undefined;
            const client = new CopilotClient({
                connection: RuntimeConnection.forStdio({ path: runtime.command, args: runtime.args, ...(env ? { env } : {}) }),
                // Agency gives the runtime access to the folder it starts in: start it in the empty one.
                workingDirectory: sessionWorkingDirectory(),
            });
            startSharedPlaywright(sessionWorkingDirectory());
            await client.start();
            runningVersion = await client
                .getStatus()
                .then((s) => s.version || null)
                .catch(() => null);
            const which = runtime.builtIn && runtime.via === "agency" ? ", on the Copilot built into Devis" : "";
            console.log(`[copilot] runtime ${runningVersion ?? "(version unknown)"} started through ${RUNTIME_LABEL[runtime.via]}${which} (${runtime.command})`);
            if (olderThan(runningVersion, MIN_COPILOT_VERSION)) {
                console.warn(`[copilot] Copilot ${runningVersion} is older than ${MIN_COPILOT_VERSION}: the Lead, reviews and summaries will fail until it's updated (copilot update).`);
            }
            keepTreeLow(runtimeProcessId(client), "copilot runtime");
            await sharedPlaywrightReady(PLAYWRIGHT_GRACE_MS);
            return client;
        })().catch((error) => {
            clientPromise = null;
            throw error;
        });
    }
    return clientPromise;
}

/** This process's environment, without unset entries (the SDK takes strings only). */
function inheritedEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
    return env;
}

const DEAD_RUNTIME = /not connected|connection (?:closed|failed)|server exited|EPIPE|ECONNRESET|disposed/i;

/** Run `task` on the shared client, restarting the runtime once if it died. */
export async function withCopilotClient<T>(task: (client: CopilotClient) => Promise<T>): Promise<T> {
    const client = await getCopilotClient();
    try {
        return await task(client);
    } catch (error) {
        if (!DEAD_RUNTIME.test((error as Error)?.message || "")) throw error;
        if (clientPromise) {
            const stale = clientPromise;
            clientPromise = null;
            void stale.then((old) => old.forceStop()).catch(() => undefined);
        }
        return task(await getCopilotClient());
    }
}

/**
 * Start the runtime before anyone needs it: through Agency it takes about 10 s (Agency
 * starts its MCP proxies), which would otherwise land on the first review or Lead reply.
 * Only the runtime: warming the MCP servers with a throwaway session didn't make the
 * first real turn measurably faster.
 */
export async function warmCopilot(): Promise<void> {
    if (process.env.ADO_PR_OPS_NO_COPILOT_WARMUP) return;
    await getCopilotClient();
}

/** The runtime's own process (Agency's, through Agency): the SDK keeps it in a private field. */
function runtimeProcessId(client: CopilotClient): number | undefined {
    return (client as unknown as { cliProcess?: { pid?: number } | null }).cliProcess?.pid;
}

export async function stopCopilotClient(): Promise<void> {
    stopSharedPlaywright();
    const pending = clientPromise;
    clientPromise = null;
    if (!pending) return;
    try {
        const client = await pending;
        for (const error of await client.stop()) {
            console.error(`[copilot] shutdown: ${error.message}`);
        }
    } catch (error) {
        console.error(`[copilot] shutdown failed: ${(error as Error).message}`);
    }
}

/** Empty working directory for app-run sessions, so no repo instructions leak in. */
export function sessionWorkingDirectory(): string {
    const dir = process.env.ADO_PR_OPS_WORK_DIR || join(tmpdir(), "ado-pr-ops-sessions");
    mkdirSync(dir, { recursive: true });
    return dir;
}

/** Where Agency installs itself, unless `ADO_PR_OPS_AGENCY_PATH` says otherwise. */
function agencyExpectedPath(): string {
    const override = process.env.ADO_PR_OPS_AGENCY_PATH?.trim();
    if (override) return override;
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "agency", "CurrentVersion", "agency.exe");
}

export function agencyExePath(): string | null {
    const path = agencyExpectedPath();
    return existsSync(path) ? path : null;
}

// Agency MCP servers attached to PR sessions, scoped to the PR's own org and
// project: ADO (related PRs, repos) and Bluebird (code search). They replace
// Agency's unscoped servers of the same names in that session.
export function reviewMcpServers(org: string, project: string): Record<string, MCPServerConfig> {
    const agency = agencyExePath();
    if (!agency) return {};
    return {
        ado: { type: "local", command: agency, args: ["mcp", "ado", "--org", org], tools: ["*"] },
        bluebird: {
            type: "local",
            command: agency,
            args: ["mcp", "bluebird", "--org", org, "--project", project],
            tools: ["*"],
        },
    };
}

/**
 * PR sessions process untrusted PR content. They may read files, use the app's
 * tools and call any MCP tool (every server Agency and the user's config provide
 * is on, by the user's choice); shell commands, file writes and URL fetches are
 * refused.
 */
export const reviewPermissionHandler: PermissionHandler = (request) => {
    if (request.kind === "read" || request.kind === "custom-tool" || request.kind === "mcp") return { kind: "approve-once" };
    return {
        kind: "reject",
        feedback: `${request.kind} access is disabled in PR sessions because they process untrusted PR content. Use the PR data you were given and your MCP tools.`,
    };
};

export function prSessionOptions(org: string, project: string) {
    return {
        clientName: CLIENT_NAME,
        workingDirectory: sessionWorkingDirectory(),
        mcpServers: { ...sharedMcpServers(), ...reviewMcpServers(org, project) },
        onPermissionRequest: reviewPermissionHandler,
    };
}

/**
 * What the Lead and workers are told about the web. web_fetch is the runtime's own tool
 * (a "url" permission request, approved without asking); web_search comes from the
 * GitHub MCP server, which may be deferred behind tool_search_tool.
 */
export const WEB_BRIEF =
    "You have the web: search it with web_search and read any page with web_fetch, without asking the user. If web_search isn't in your tool list, find it with tool_search_tool. Use them for docs, release notes, error messages and anything the repositories and MCP servers don't cover, and say which pages you used.";

/** Last top-level assistant reply text, or "" when the turn produced none. */
export function replyText(reply: Awaited<ReturnType<CopilotSession["sendAndWait"]>>): string {
    const content = (reply as { data?: { content?: unknown } } | undefined)?.data?.content;
    return typeof content === "string" ? content.trim() : "";
}

// ---- waiting for a turn ------------------------------------------------------------------------
//
// The SDK's sendAndWait ends a turn only on `session.idle`, a transient event that is never
// saved or sent again. When it doesn't arrive, the wait runs to its timeout (12 hours for a
// worker) while the session sits idle, and Stop can't help: aborting an idle session emits
// nothing. sendAndSettle waits for the same events, and also asks the runtime now and then
// whether the session is still processing, so a turn whose idle got lost still ends; and a
// caller's stop signal always ends the wait.

type AssistantReply = Awaited<ReturnType<CopilotSession["sendAndWait"]>>;

/** The parts of a session sendAndSettle uses. A test double may offer only sendAndWait. */
export interface SettleSession extends Partial<Pick<CopilotSession, "send" | "on" | "getEvents" | "rpc">> {
    sendAndWait(message: MessageOptions, timeout?: number): Promise<unknown>;
}

export const SETTLE = {
    /** How often to ask whether the session is still processing. Two quiet "no"s in a row end the turn. */
    checkMs: 15_000,
    /** How long one such question may take before it counts as no answer. */
    checkTimeoutMs: 10_000,
    /** After a stop: how often to check that the runtime let go, and how long to wait at most. */
    stopPollMs: 500,
    stopGraceMs: 10_000,
};

export interface SettleOptions {
    /** Aborted when the caller stops the turn: the wait ends (with "stopped") once the runtime lets go, or after a grace. */
    signal?: AbortSignal;
    /** The turn ended without `session.idle`: the runtime said it was no longer processing. */
    onMissedIdle?: () => void;
    /** True while the turn waits on the user (a question or approval): the turn isn't over then. */
    waiting?: () => boolean;
}

export class TurnStoppedError extends Error {
    constructor() {
        super("stopped");
    }
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("no answer")), ms))),
    ]).finally(() => clearTimeout(timer));
}

/** The last top-level reply saved since `since`, for a turn whose live events went missing. */
async function savedReply(session: SettleSession, since: number): Promise<AssistantReply> {
    if (!session.getEvents) return undefined;
    const events = (await session.getEvents()) as Array<{ type: string; agentId?: string; timestamp?: string; data?: { content?: unknown; parentToolCallId?: string } }>;
    for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e.timestamp && Date.parse(e.timestamp) < since - 1000) break;
        if (e.type === "assistant.message" && !e.agentId && !e.data?.parentToolCallId && typeof e.data?.content === "string" && e.data.content.trim()) {
            return e as unknown as AssistantReply;
        }
    }
    return undefined;
}

/**
 * Send a message and wait for the turn to end, like sendAndWait, but robust to a lost
 * `session.idle` and stoppable. Resolves with the last top-level assistant message.
 */
export async function sendAndSettle(session: SettleSession, message: MessageOptions, timeoutMs: number, options: SettleOptions = {}): Promise<AssistantReply> {
    if (options.signal?.aborted) throw new TurnStoppedError();
    // A double without events or send: the SDK's own wait is all there is.
    if (!session.send || !session.on) return (await session.sendAndWait(message, timeoutMs)) as AssistantReply;

    type Outcome = { kind: "idle" } | { kind: "missedIdle" } | { kind: "stopped" } | { kind: "error"; error: Error };
    let settled = false;
    let settle!: (outcome: Outcome) => void;
    const outcome = new Promise<Outcome>((resolve) => {
        settle = (o) => {
            if (settled) return;
            settled = true;
            resolve(o);
        };
    });
    let last: AssistantReply;
    let events = 0;
    const off = session.on((event) => {
        events++;
        if (event.agentId) return;
        if (event.type === "assistant.message") last = event as AssistantReply;
        else if (event.type === "session.idle" && event.data.mode !== "autopilot") settle({ kind: "idle" });
        else if (event.type === "session.error") {
            const error = new Error(event.data.message);
            error.stack = event.data.stack;
            settle({ kind: "error", error });
        }
    });
    // A dropped connection fails the wait, as it does for sendAndWait.
    const waits = (session as unknown as { pendingResponseWaits?: unknown }).pendingResponseWaits;
    const fail = (error: Error) => settle({ kind: "error", error });
    if (waits instanceof Set) waits.add(fail);

    const isProcessing = async (): Promise<boolean | null> => {
        try {
            const result = await within(session.rpc!.metadata.isProcessing(), SETTLE.checkTimeoutMs);
            return typeof result?.processing === "boolean" ? result.processing : null;
        } catch {
            return null;
        }
    };
    let watch: ReturnType<typeof setInterval> | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const onStop = () => {
        const until = Date.now() + SETTLE.stopGraceMs;
        const poll = async (): Promise<void> => {
            if (settled) return;
            if (Date.now() >= until || (await isProcessing()) === false) return settle({ kind: "stopped" });
            stopTimer = setTimeout(() => void poll(), SETTLE.stopPollMs);
        };
        void poll();
    };
    const sentAt = Date.now();
    try {
        await session.send(message);
        if (session.rpc?.metadata?.isProcessing) {
            // "Not processing" counts only with nothing from the session since the previous check, and
            // never while the caller is waiting on the user. Two such checks in a row end the turn.
            let quiet = 0;
            let seen = events;
            let checking = false;
            watch = setInterval(async () => {
                if (checking || settled) return;
                checking = true;
                try {
                    const before = events;
                    const processing = await isProcessing();
                    if (processing !== false || events !== before || options.waiting?.()) quiet = 0;
                    else quiet = before === seen ? quiet + 1 : 1;
                    seen = events;
                    if (quiet >= 2) settle({ kind: "missedIdle" });
                } finally {
                    checking = false;
                }
            }, SETTLE.checkMs);
        }
        options.signal?.addEventListener("abort", onStop, { once: true });
        if (options.signal?.aborted) onStop();
        timeout = setTimeout(() => settle({ kind: "error", error: new Error(`Timeout after ${timeoutMs}ms waiting for session.idle`) }), timeoutMs);
        const result = await outcome;
        if (result.kind === "error") throw result.error;
        if (result.kind === "stopped") throw new TurnStoppedError();
        if (result.kind === "missedIdle") {
            options.onMissedIdle?.();
            if (!last) last = await savedReply(session, sentAt).catch(() => undefined);
        }
        return last;
    } finally {
        settled = true;
        off();
        if (waits instanceof Set) waits.delete(fail);
        if (watch) clearInterval(watch);
        if (stopTimer) clearTimeout(stopTimer);
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onStop);
    }
}

export interface OneShotOptions {
    model?: string;
    attachments?: MessageOptions["attachments"];
    timeoutMs?: number;
}

/** Answer one prompt in a throwaway session that is deleted afterwards. */
export function runOneShot(prompt: string, options: OneShotOptions = {}): Promise<string> {
    return withCopilotClient(async (client) => {
        const model = options.model?.trim();
        const session = await client.createSession({
            clientName: CLIENT_NAME,
            workingDirectory: sessionWorkingDirectory(),
            model: model && model !== "auto" ? model : undefined,
            skipCustomInstructions: true,
            mcpServers: sharedMcpServers(),
            onPermissionRequest: reviewPermissionHandler,
        });
        try {
            const reply = await sendAndSettle(
                session,
                { prompt, attachments: options.attachments },
                options.timeoutMs ?? 180_000,
                { onMissedIdle: () => console.warn("[copilot] a one-shot reply ended without session.idle; recovered") },
            );
            const text = replyText(reply);
            if (!text) throw new Error("Copilot returned an empty reply");
            return text;
        } catch (error) {
            await session.abort().catch(() => undefined);
            throw error;
        } finally {
            await session.disconnect().catch(() => undefined);
            await client.deleteSession(session.sessionId).catch(() => undefined);
        }
    });
}
