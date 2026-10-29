// Loopback HTTP server: the static UI from ./web plus the JSON API (api.mts).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { handleApi } from "./api.mjs";
import { sendJson, serveStatic } from "./http.mjs";

export interface RunningServer {
    server: Server;
    url: string;
    /** Stop taking requests and close every open connection, idle keep-alive ones first. */
    close(): Promise<void>;
}

export interface ServerOptions {
    /** Extra API routes, tried first; return true when the request was handled. */
    routes?: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean | Promise<boolean>;
    /** A port to take if it's free, so the page keeps its origin (and its storage) across restarts. */
    port?: number;
}

/** Listen on `port`, or on any free port when that's 0 or taken for longer than a moment. */
async function listenOn(server: Server, port: number): Promise<void> {
    const attempt = (p: number) =>
        new Promise<void>((resolve, reject) => {
            const fail = (error: Error) => reject(error);
            server.once("error", fail);
            server.listen(p, "127.0.0.1", () => {
                server.off("error", fail);
                resolve();
            });
        });
    if (port > 0) {
        // A service that just ended may still be letting go of it.
        for (let tries = 0; tries < 5; tries++) {
            try {
                return await attempt(port);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") break;
                await new Promise((r) => setTimeout(r, 200));
            }
        }
    }
    await attempt(0);
}

export async function startServer(webDir: string, options: ServerOptions = {}): Promise<RunningServer> {
    let origin = "";
    const server = createServer((req, res) => {
        // Only this app's own window may drive the API: reject other hosts (DNS
        // rebinding) and cross-site requests from pages in a local browser.
        const host = `http://${req.headers.host || ""}`;
        const requestOrigin = req.headers.origin;
        if (host !== origin || (requestOrigin && requestOrigin !== origin)) {
            res.writeHead(403, { "Content-Type": "text/plain" }).end("forbidden");
            return;
        }
        const url = new URL(req.url || "/", origin);
        if (url.pathname.startsWith("/api/")) {
            void (async () => {
                try {
                    if (options.routes && (await options.routes(req, res, url))) return;
                } catch (error) {
                    if (!res.headersSent) sendJson(res, 500, { error: (error as Error).message || String(error) });
                    return;
                }
                await handleApi(req, res, url);
            })();
            return;
        }
        return void serveStatic(req, res, url, webDir);
    });
    // A stalled client can't hold a socket open forever.
    server.headersTimeout = 30_000;
    server.requestTimeout = 10 * 60_000;
    server.keepAliveTimeout = 15_000;
    await listenOn(server, options.port ?? 0);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    origin = `http://127.0.0.1:${port}`;
    const close = () =>
        new Promise<void>((resolve) => {
            let finished = false;
            const finish = () => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                resolve();
            };
            server.close(() => finish());
            server.closeIdleConnections?.();
            // Requests still running get a moment, then their sockets go too.
            const timer = setTimeout(() => {
                server.closeAllConnections?.();
                finish();
            }, 2_000);
        });
    return { server, url: `${origin}/`, close };
}
