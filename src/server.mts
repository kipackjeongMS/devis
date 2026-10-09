// Loopback HTTP server: the static UI from ./web plus the JSON API (api.mts).

import { createServer, type Server } from "node:http";
import { handleApi } from "./api.mjs";
import { serveStatic } from "./http.mjs";

export interface RunningServer {
    server: Server;
    url: string;
}

export async function startServer(webDir: string): Promise<RunningServer> {
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
        if (url.pathname.startsWith("/api/")) return void handleApi(req, res, url);
        return void serveStatic(req, res, url, webDir);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    origin = `http://127.0.0.1:${port}`;
    return { server, url: `${origin}/` };
}
