// A small MCP client over stdio, for the Agency MCP servers the service reads itself
// (Teams for the comms bridge). It starts `agency mcp <server>`, speaks JSON-RPC line by
// line, and is closed after each use: nothing stays running between scans.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { agencyExePath } from "./copilot-runtime.mjs";

export const MCP_LIMITS = {
    startMs: 60_000,
    callMs: 90_000,
    /** A line longer than this is dropped rather than parsed. */
    lineChars: 8 * 1024 * 1024,
};

export class McpError extends Error {
    /** The server or the service behind it said to slow down (429). */
    readonly throttled: boolean;
    constructor(message: string, throttled = false) {
        super(message);
        this.name = "McpError";
        this.throttled = throttled;
    }
}

export interface McpResult {
    /** The tool's text, every part joined. */
    text: string;
    /** The result as JSON: structuredContent, else the first JSON object in the text. */
    json: any;
}

export interface McpClient {
    call(tool: string, args: Record<string, unknown>): Promise<McpResult>;
    close(): void;
}

const THROTTLED = /\b429\b|too ?many ?requests|throttl/i;

/** The first JSON object or array in a tool's text: whole, or on a line of its own between notes. */
export function jsonInText(text: string): any {
    const whole = text.trim();
    if (!whole) return null;
    try {
        return JSON.parse(whole);
    } catch {
        /* not one document: look line by line */
    }
    for (const line of whole.split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith("{") && !t.startsWith("[")) continue;
        try {
            return JSON.parse(t);
        } catch {
            /* the next line, then */
        }
    }
    return null;
}

/** A tool result as text and JSON. An error result throws, flagged when it was throttling. */
export function readResult(tool: string, result: any): McpResult {
    const text = Array.isArray(result?.content)
        ? result.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("\n")
        : "";
    if (result?.isError) throw new McpError(`${tool}: ${text.slice(0, 300) || "failed"}`, THROTTLED.test(text));
    const json = result?.structuredContent ?? jsonInText(text);
    return { text, json };
}

/** Start an Agency MCP server and connect to it. Throws when Agency isn't installed or the server doesn't start. */
export async function openMcp(server: string, options: { command?: string; args?: string[] } = {}): Promise<McpClient> {
    const command = options.command ?? agencyExePath();
    if (!command) throw new McpError("Agency isn't installed, so the Teams MCP server can't start.");
    const child: ChildProcessWithoutNullStreams = spawn(command, options.args ?? ["mcp", server], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
    const pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    let nextId = 1;
    let closed = false;
    let stderr = "";
    const failAll = (error: Error) => {
        for (const [id, p] of pending) {
            clearTimeout(p.timer);
            p.reject(error);
            pending.delete(id);
        }
    };
    child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    child.on("error", (error) => {
        closed = true;
        failAll(new McpError(`${server} MCP server: ${error.message}`));
    });
    child.on("exit", (code) => {
        closed = true;
        const tail = stderr.trim().split(/\r?\n/).slice(-2).join(" ").slice(0, 300);
        failAll(new McpError(`${server} MCP server exited (${code ?? "signal"})${tail ? `: ${tail}` : ""}`, THROTTLED.test(tail)));
    });
    child.stdin.on("error", () => {
        /* the exit handler reports it */
    });
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
        if (line.length > MCP_LIMITS.lineChars) return;
        let message: any;
        try {
            message = JSON.parse(line);
        } catch {
            return;
        }
        const p = typeof message?.id === "number" ? pending.get(message.id) : undefined;
        if (!p) return;
        pending.delete(message.id);
        clearTimeout(p.timer);
        if (message.error) {
            const text = String(message.error.message || JSON.stringify(message.error)).slice(0, 300);
            p.reject(new McpError(text, THROTTLED.test(text)));
        } else p.resolve(message.result);
    });

    const send = (payload: object) => {
        if (!closed) child.stdin.write(JSON.stringify(payload) + "\n");
    };
    const rpc = (method: string, params: object, timeoutMs: number): Promise<any> =>
        new Promise((resolve, reject) => {
            if (closed) return reject(new McpError(`${server} MCP server isn't running.`));
            const id = nextId++;
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new McpError(`${server} MCP server didn't answer ${method} in ${Math.round(timeoutMs / 1000)}s.`));
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            send({ jsonrpc: "2.0", id, method, params });
        });
    const close = () => {
        if (closed) return;
        closed = true;
        failAll(new McpError(`${server} MCP server closed.`));
        child.kill();
    };

    try {
        await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "devis", version: "1" } }, MCP_LIMITS.startMs);
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
    } catch (error) {
        close();
        throw error;
    }
    return {
        call: async (tool, args) => readResult(tool, await rpc("tools/call", { name: tool, arguments: args }, MCP_LIMITS.callMs)),
        close,
    };
}
