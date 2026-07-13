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
            displayName: "ADO PR Ops",
            description:
                "Active Azure DevOps pull requests assigned to you — grouped by repo, with inline diffs, comments, replies, and a bridge into this Copilot session.",
            actions: [
                {
                    name: "refresh",
                    description:
                        "No-op hook; the UI refreshes itself. Present so the agent can acknowledge the canvas.",
                    handler: async (ctx: CanvasActionContext) => ({ ok: true, instanceId: ctx.instanceId }),
                },
            ],
            open: async () => {
                const entry = await ensureServer();
                return { title: "ADO PR Ops", url: entry.url };
            },
            // Shared server is intentionally left running across instance closes;
            // it is cheap (loopback, idle) and reused by the next open.
            onClose: async () => {},
        }),
    ],
});

// Inject the live session so the bridge endpoint can push prompts into the CLI.
setSession(session);
