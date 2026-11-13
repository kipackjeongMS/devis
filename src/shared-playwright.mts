// One Playwright MCP server for every session the app runs, over HTTP on loopback, in
// place of the copy the user's Copilot config starts for each session (a Node process and,
// once used, a browser each: about 250 MB a session). It runs headless and isolated, so
// each session still gets its own browser context, in memory, and none sees another's
// pages or cookies. It only stands in for a Playwright server the user's config has and
// hasn't turned off, under the same name and tools. Until it's listening, and whenever
// it's down, sessions start with the user's own server as before.
//
// Over HTTP, Playwright doesn't notice the service ending, so it runs under process-guard,
// which takes its whole tree down when the service goes, killed included.
// ADO_PR_OPS_NO_SHARED_PLAYWRIGHT turns it off; ADO_PR_OPS_PLAYWRIGHT_MCP picks the package.

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MCPServerConfig } from "@github/copilot-sdk";
import { keepTreeLow, lowPriorityEnabled, lowerProcess } from "./runtime-priority.mjs";

/** Pinned: the feed's `latest` tag points at an old alpha without the HTTP server. */
export const PLAYWRIGHT_MCP_SPEC = "@playwright/mcp@0.0.84";

const START_TIMEOUT_MS = 120_000; // the first run downloads the package
const RESTART_MIN_MS = 2_000;
const RESTART_MAX_MS = 60_000;
const STABLE_MS = 60_000;

export interface UserPlaywright {
    /** The entry's name in the user's config, which the shared server takes over. */
    name: string;
    tools: string[];
}

/** The user's Playwright server in their Copilot MCP config: the local entry that runs @playwright/mcp and isn't turned off. */
export function userPlaywrightEntry(config: unknown): UserPlaywright | null {
    const servers = (config as { mcpServers?: unknown } | null)?.mcpServers;
    if (!servers || typeof servers !== "object") return null;
    for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
        if (!raw || typeof raw !== "object") continue;
        const entry = raw as { type?: unknown; command?: unknown; args?: unknown; tools?: unknown; disabled?: unknown };
        if (entry.disabled === true) continue;
        if (entry.type !== undefined && entry.type !== "local" && entry.type !== "stdio") continue;
        const parts = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])];
        if (!parts.some((part) => typeof part === "string" && /^@playwright\/mcp(?:@|$)/.test(part))) continue;
        const tools = Array.isArray(entry.tools) && entry.tools.every((tool) => typeof tool === "string") ? (entry.tools as string[]) : ["*"];
        return { name, tools };
    }
    return null;
}

function readUserMcpConfig(): unknown {
    const home = process.env.COPILOT_HOME?.trim() || join(homedir(), ".copilot");
    try {
        return JSON.parse(readFileSync(join(home, "mcp-config.json"), "utf8"));
    } catch {
        return null;
    }
}

export interface CommandLine {
    command: string;
    args: string[];
    /** Pass `args` to Windows as they are (a cmd.exe line that's already quoted). */
    verbatim?: boolean;
}

const cmdArg = (arg: string): string => (/[\s&|<>^()"]/.test(arg) || !arg ? `"${arg.replace(/"/g, '""')}"` : arg);

/** `npx` runs the package; on Windows through cmd.exe, since npx is a .cmd there. */
export function playwrightCommand(spec: string, port: number): CommandLine {
    const args = ["-y", spec, "--port", String(port), "--host", "127.0.0.1", "--isolated", "--headless"];
    if (process.platform !== "win32") return { command: "npx", args };
    return {
        command: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", `"${["npx", ...args].map(cmdArg).join(" ")}"`],
        verbatim: true,
    };
}

const GUARD = join(dirname(fileURLToPath(import.meta.url)), "process-guard.mjs");

/** Stop the guard and the server under it. */
function killTree(guard: ChildProcess): void {
    if (!guard.pid) return;
    if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(guard.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
        return;
    }
    // The server is in its own process group, which the guard takes down on its way out.
    guard.stdin?.end();
    guard.kill("SIGTERM");
}

export interface SharedPlaywrightOptions {
    command?: (port: number) => CommandLine;
    readConfig?: () => unknown;
    kill?: (child: ChildProcess) => void;
    /** Called with the guard's process, the root of the server's tree, once it's listening (to lower its priority). */
    onListening?: (pid: number) => void;
    startTimeoutMs?: number;
    restartMinMs?: number;
}

/** The shared server: started once, restarted when it exits, stopped with the runtime. */
export class SharedPlaywright {
    private child: ChildProcess | null = null;
    private url: string | null = null;
    private port = 0;
    private entry: UserPlaywright | null = null;
    private running = false;
    private cwd = process.cwd();
    private failures = 0;
    private restartTimer: ReturnType<typeof setTimeout> | null = null;
    private waiters = new Set<(ready: boolean) => void>();

    constructor(private readonly options: SharedPlaywrightOptions = {}) {}

    /** Start it, unless it's running or the user has no Playwright server to stand in for. */
    start(cwd: string): void {
        if (this.running) return;
        this.entry = userPlaywrightEntry((this.options.readConfig ?? readUserMcpConfig)());
        if (!this.entry) return;
        this.running = true;
        this.cwd = cwd;
        this.failures = 0;
        this.port = 0;
        this.launch();
    }

    stop(): void {
        this.running = false;
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = null;
        const child = this.child;
        this.child = null;
        this.url = null;
        if (child) (this.options.kill ?? killTree)(child);
        this.settle(false);
    }

    /** Its MCP endpoint while it's listening, else null. */
    get endpoint(): string | null {
        return this.url;
    }

    /** Whether it's listening, waiting up to `timeoutMs` for a start in progress. */
    whenReady(timeoutMs: number): Promise<boolean> {
        if (this.url) return Promise.resolve(true);
        if (!this.running) return Promise.resolve(false);
        return new Promise((resolve) => {
            const done = (ready: boolean) => {
                clearTimeout(timer);
                this.waiters.delete(done);
                resolve(ready);
            };
            const timer = setTimeout(() => done(false), timeoutMs);
            this.waiters.add(done);
        });
    }

    /** What a session's `mcpServers` takes to use it in place of the user's own: nothing until it's listening. */
    servers(): Record<string, MCPServerConfig> {
        if (!this.url || !this.entry) return {};
        return { [this.entry.name]: { type: "http", url: this.url, tools: [...this.entry.tools] } };
    }

    private settle(ready: boolean): void {
        for (const waiter of [...this.waiters]) waiter(ready);
    }

    private launch(): void {
        const line = (this.options.command ?? ((port: number) => playwrightCommand(process.env.ADO_PR_OPS_PLAYWRIGHT_MCP?.trim() || PLAYWRIGHT_MCP_SPEC, port)))(this.port);
        let child: ChildProcess;
        try {
            // The guard runs on this executable, as Node: Electron's in the app. Detached, so it
            // outlives the service long enough to take the server down with it.
            child = spawn(process.execPath, [GUARD, JSON.stringify(line)], {
                cwd: this.cwd,
                env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
                windowsHide: true,
                detached: true,
                stdio: ["pipe", "pipe", "pipe"],
            });
        } catch (error) {
            console.warn(`[playwright] could not start the shared server: ${(error as Error).message}`);
            this.exited(Date.now(), false);
            return;
        }
        this.child = child;
        if (child.pid && lowPriorityEnabled()) lowerProcess(child.pid);
        const startedAt = Date.now();
        let output = "";
        const timeout = setTimeout(() => {
            if (this.child !== child || this.url) return;
            console.warn(`[playwright] the shared server didn't start listening within ${Math.round((this.options.startTimeoutMs ?? START_TIMEOUT_MS) / 1000)} s`);
            (this.options.kill ?? killTree)(child);
        }, this.options.startTimeoutMs ?? START_TIMEOUT_MS);
        timeout.unref();
        const read = (chunk: Buffer) => {
            output = (output + chunk.toString("utf8")).slice(-4000);
            if (this.child !== child || this.url) return;
            const match = /Listening on (https?:\/\/[^\s"'<>]+)/.exec(output);
            if (!match) return;
            clearTimeout(timeout);
            const base = new URL(match[1]);
            this.port = Number(base.port) || this.port;
            this.url = `${base.origin}/mcp`;
            console.log(`[playwright] shared server listening on ${this.url} for every session (pid ${child.pid})`);
            if (child.pid) this.options.onListening?.(child.pid);
            this.settle(true);
        };
        child.stdout?.on("data", read);
        child.stderr?.on("data", read);
        // Never written to: the guard takes the server down when this pipe ends, as it does when the service goes.
        child.stdin?.on("error", () => undefined);
        let ended = false;
        const end = (reason: string) => {
            if (ended) return;
            ended = true;
            clearTimeout(timeout);
            if (this.child !== child) return;
            const wasListening = !!this.url;
            this.child = null;
            this.url = null;
            if (!this.running) return;
            const tail = output.trim().split(/\r?\n/).slice(-3).join(" | ");
            console.warn(`[playwright] the shared server ${wasListening ? "stopped" : "didn't start"} (${reason})${tail ? `: ${tail}` : ""}`);
            if (!wasListening) this.settle(false);
            this.exited(startedAt, wasListening);
        };
        child.on("error", (error) => end(error.message));
        child.on("exit", (code, signal) => end(signal ? `signal ${signal}` : `exit code ${code}`));
    }

    /** Start it again: on the same port, so sessions using it can carry on, unless that's what failed. */
    private exited(startedAt: number, wasListening: boolean): void {
        if (!this.running) return;
        this.failures = Date.now() - startedAt >= STABLE_MS ? 1 : this.failures + 1;
        if (!wasListening) this.port = 0;
        const min = this.options.restartMinMs ?? RESTART_MIN_MS;
        const delay = Math.min(RESTART_MAX_MS, min * 2 ** (this.failures - 1));
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (this.running) this.launch();
        }, delay);
        this.restartTimer.unref();
    }
}

const shared = new SharedPlaywright({ onListening: (pid) => keepTreeLow(pid, "shared Playwright") });

export const sharedPlaywrightEnabled = (): boolean => !process.env.ADO_PR_OPS_NO_SHARED_PLAYWRIGHT;

/** Start the shared server (once), with `cwd` as the folder for output when a session gives no roots. */
export function startSharedPlaywright(cwd: string): void {
    if (sharedPlaywrightEnabled()) shared.start(cwd);
}

export function stopSharedPlaywright(): void {
    shared.stop();
}

export function sharedPlaywrightReady(timeoutMs: number): Promise<boolean> {
    return shared.whenReady(timeoutMs);
}

/** MCP servers every app session takes in place of the user's own: the shared Playwright server once it's listening. */
export function sharedMcpServers(): Record<string, MCPServerConfig> {
    return shared.servers();
}
