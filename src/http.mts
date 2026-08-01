// HTTP plumbing shared by the extension's loopback server: JSON helpers plus a
// path-traversal-safe static file server. Pure — the caller supplies WEB_DIR.

import { readFile } from "node:fs/promises";
import { normalize, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
};

export function sendJson(res: ServerResponse, status: number, obj: unknown): void {
    const buf = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": buf.length,
    });
    res.end(buf);
}

export function readBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const s = Buffer.concat(chunks).toString("utf8");
            try {
                resolve(s ? JSON.parse(s) : {});
            } catch {
                reject(new Error("invalid JSON body"));
            }
        });
        req.on("error", reject);
    });
}

export async function serveStatic(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    webDir: string,
): Promise<void> {
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    // Prevent path traversal: normalize and ensure it stays under webDir.
    const full = normalize(join(webDir, path));
    if (!full.startsWith(webDir)) {
        res.writeHead(403).end("forbidden");
        return;
    }
    try {
        const data = await readFile(full);
        const ext = full.slice(full.lastIndexOf("."));
        res.writeHead(200, {
            "Content-Type": MIME[ext] || "application/octet-stream",
            "Content-Length": data.length,
            // Loopback dev server: never let the webview cache assets. Ephemeral
            // ports can be reused across extension reloads, so a cached app.js
            // under the same origin would otherwise mask freshly deployed code.
            "Cache-Control": "no-store, must-revalidate",
        });
        res.end(data);
    } catch {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    }
}
