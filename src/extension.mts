// Extension: ado-pr-ops
// Azure DevOps PR operations canvas — active PRs assigned to you, grouped by
// repo, with inline diffs, comments, replies, and a bridge to the Copilot CLI.
//
// Architecture:
//   - ONE shared loopback HTTP server (started lazily on first canvas open).
//   - Serves the static UI from ./web and a small JSON API (see api.mts).
//   - Config, review store, ADO client, and HTTP helpers live in sibling modules.
//   - The Copilot CLI bridge posts a user-built prompt into the session via
//     session.send(). Never use console.log here — stdout is the JSON-RPC pipe.
//
// This entry file MUST compile to `extension.mjs` at the extension root: the
// Copilot loader imports it by filename convention (there is no manifest).

import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { joinSession, createCanvas, type CanvasActionContext } from "@github/copilot-sdk/extension";
import { handleApi, setSession } from "./api.mjs";
import { serveStatic } from "./http.mjs";
import { parsePrCanvasTarget, targetUrl, type PrCanvasTarget } from "./canvas-target.mjs";
import { publishCanvasReview } from "./canvas-review.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "web");

// ---------------------------------------------------------------------------
// Shared server (one for the whole extension, started on first open)
// ---------------------------------------------------------------------------
interface ServerEntry {
    server: Server;
    url: string;
}

let serverEntry: ServerEntry | null = null;
const canvasTargets = new Map<string, PrCanvasTarget>();

async function ensureServer(): Promise<ServerEntry> {
    if (serverEntry) return serverEntry;
    const server = createServer((req, res) => {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        if (url.pathname.startsWith("/api/")) return void handleApi(req, res, url);
        return void serveStatic(req, res, url, WEB_DIR);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    serverEntry = { server, url: `http://127.0.0.1:${port}/` };
    return serverEntry;
}

// ---------------------------------------------------------------------------
// Canvas registration
// ---------------------------------------------------------------------------
const session = await joinSession({
    canvases: [
        createCanvas({
            id: "ado-pr-ops",
            displayName: "ADO DevOps",
            description:
                "Active Azure DevOps pull requests assigned to you — grouped by repo, with inline diffs, comments, replies, and a bridge into this Copilot session.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                anyOf: [
                    { maxProperties: 0 },
                    { required: ["org", "project", "repoId", "prId"] },
                ],
                properties: {
                    org: { type: "string", minLength: 1 },
                    project: { type: "string", minLength: 1 },
                    repoId: { type: "string", minLength: 1 },
                    prId: {
                        oneOf: [
                            { type: "integer", minimum: 1 },
                            { type: "string", pattern: "^[1-9][0-9]*$" },
                        ],
                    },
                },
            },
            actions: [
                {
                    name: "refresh",
                    description:
                        "No-op hook; the UI refreshes itself. Present so the agent can acknowledge the canvas.",
                    handler: async (ctx: CanvasActionContext) => ({ ok: true, instanceId: ctx.instanceId }),
                },
                {
                    name: "publishReview",
                    description:
                        "Persist a completed or failed PR review so every ADO DevOps canvas session can render it.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        required: ["prId", "runId", "org", "project", "repoId", "status"],
                        properties: {
                            prId: {
                                oneOf: [
                                    { type: "integer", minimum: 1 },
                                    { type: "string", pattern: "^[1-9][0-9]*$" },
                                ],
                            },
                            runId: { type: "string", minLength: 1 },
                            org: { type: "string" },
                            project: { type: "string" },
                            repoId: { type: "string" },
                            repo: { type: "string" },
                            title: { type: "string" },
                            status: { type: "string", enum: ["done", "error"] },
                            summary: { type: "string" },
                            story: { type: "string" },
                            error: { type: "string" },
                            findings: {
                                type: "array",
                                items: {
                                    type: "object",
                                    additionalProperties: false,
                                    required: ["file", "line", "side", "severity", "comment"],
                                    properties: {
                                        file: { type: "string", minLength: 1 },
                                        line: { type: "integer", minimum: 1 },
                                        endLine: { type: ["integer", "null"], minimum: 1 },
                                        side: { type: "string", enum: ["left", "right"] },
                                        severity: {
                                            type: "string",
                                            enum: ["critical", "high", "medium", "low", "nit"],
                                        },
                                        title: { type: ["string", "null"] },
                                        comment: { type: "string", minLength: 1 },
                                    },
                                },
                            },
                        },
                    },
                    handler: async (ctx: CanvasActionContext) => {
                        const target = canvasTargets.get(ctx.instanceId);
                        if (!target) throw new Error("This canvas instance has no PR target");
                        return publishCanvasReview(ctx.input, target);
                    },
                },
            ],
            open: async (ctx) => {
                const entry = await ensureServer();
                const target = parsePrCanvasTarget(ctx.input);
                if (target) canvasTargets.set(ctx.instanceId, target);
                else canvasTargets.delete(ctx.instanceId);
                return target
                    ? { title: `ADO DevOps · PR #${target.prId}`, url: targetUrl(entry.url, target) }
                    : { title: "ADO DevOps", url: entry.url };
            },
            // Shared server is intentionally left running across instance closes;
            // it is cheap (loopback, idle) and reused by the next open.
            onClose: async (ctx) => {
                canvasTargets.delete(ctx.instanceId);
            },
        }),
    ],
});

// Inject the live session so the bridge endpoint can push prompts into the CLI.
setSession(session);
