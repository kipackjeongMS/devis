// JSON API router. Kept pure of transport concerns: extension.mts wires this into
// the loopback server and injects the live session via setSession().

import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionRef } from "@github/copilot-sdk/extension";
import { sendJson, readBody } from "./http.mjs";
import { readConfig, writeConfig } from "./config.mjs";
import { ensureDb, getReview, listReviews, upsertReview } from "./store.mjs";
import {
    listAssignedPRs,
    listActivePRs,
    getPrDetail,
    getFileDiff,
    postReply,
    createThread,
    type Pr,
} from "./ado.mjs";

// The active CLI session, injected after joinSession resolves. The bridge
// endpoint pushes prompts through it.
let sessionRef: SessionRef | null = null;

export function setSession(s: SessionRef | null): void {
    sessionRef = s;
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const p = url.pathname;
    const q = url.searchParams;

    try {
        // ---- config ----
        if (p === "/api/config" && req.method === "GET") {
            return sendJson(res, 200, await readConfig());
        }
        if (p === "/api/config" && req.method === "POST") {
            const body = await readBody(req);
            return sendJson(res, 200, await writeConfig(body));
        }

        // ---- active PRs across all configured (org, project) scopes ----
        // Orgs with configured projects return ALL active PRs in those projects
        // (each tagged `mine`); orgs without projects fall back to reviewer=me.
        // Filtering by org/project/assignment happens client-side.
        if (p === "/api/prs" && req.method === "GET") {
            const cfg = await readConfig();
            const prs: Pr[] = [];
            const errors: string[] = [];
            const tasks: Promise<void>[] = [];
            for (const org of cfg.organizations) {
                const projects = cfg.projects[org] || [];
                if (projects.length) {
                    for (const project of projects) {
                        tasks.push(
                            (async () => {
                                try {
                                    prs.push(...(await listActivePRs(org, project)));
                                } catch (e) {
                                    errors.push(`${org}/${project}: ${(e as Error).message}`);
                                }
                            })(),
                        );
                    }
                } else {
                    tasks.push(
                        (async () => {
                            try {
                                prs.push(...(await listAssignedPRs(org)));
                            } catch (e) {
                                errors.push(`${org}: ${(e as Error).message}`);
                            }
                        })(),
                    );
                }
            }
            await Promise.all(tasks);
            prs.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
            return sendJson(res, 200, { prs, errors });
        }

        // ---- one PR's detail (files + threads + commits) ----
        if (p === "/api/pr" && req.method === "GET") {
            const detail = await getPrDetail(
                q.get("org")!, q.get("project")!, q.get("repoId")!, q.get("id")!,
            );
            return sendJson(res, 200, detail);
        }

        // ---- lazy per-file diff ----
        if (p === "/api/diff" && req.method === "GET") {
            const diff = await getFileDiff(
                q.get("org")!, q.get("project")!, q.get("repoId")!, q.get("path")!,
                q.get("src")!, q.get("base")!, q.get("changeType")!,
            );
            return sendJson(res, 200, diff);
        }

        // ---- post a reply (ADO write — user-initiated from the reply box) ----
        if (p === "/api/reply" && req.method === "POST") {
            const b = await readBody(req);
            const created = await postReply(
                b.org, b.project, b.repoId, b.prId, b.threadId, b.content, b.parentCommentId,
            );
            return sendJson(res, 200, created);
        }

        // ---- create a new line-anchored thread (ADO write — user-initiated from the diff) ----
        if (p === "/api/thread" && req.method === "POST") {
            const b = await readBody(req);
            if (!b.content || !String(b.content).trim()) return sendJson(res, 400, { error: "empty comment" });
            const created = await createThread(b.org, b.project, b.repoId, b.prId, {
                filePath: b.filePath, line: b.line, endLine: b.endLine, side: b.side, content: b.content,
            });
            return sendJson(res, 200, created);
        }

        // ---- bridge a prompt into the Copilot CLI session ----
        if (p === "/api/bridge" && req.method === "POST") {
            const b = await readBody(req);
            if (!b.prompt || !String(b.prompt).trim()) return sendJson(res, 400, { error: "empty prompt" });
            if (!sessionRef || typeof sessionRef.send !== "function") {
                return sendJson(res, 503, { error: "session not available" });
            }
            await sessionRef.send({ prompt: String(b.prompt) });
            return sendJson(res, 200, { ok: true });
        }

        // ---- review results (extension's own SQLite store) ----
        // A background review agent POSTs its finished result here; the canvas
        // reads it back to render "Reviewed ✓" inline. Upsert-by-prId.
        if (p === "/api/review-result" && req.method === "POST") {
            const b = await readBody(req);
            if (b.prId == null || String(b.prId).trim() === "") {
                return sendJson(res, 400, { error: "prId required" });
            }
            await ensureDb();
            return sendJson(res, 200, upsertReview(b));
        }
        // Single PR's stored review (or null).
        if (p === "/api/review-result" && req.method === "GET") {
            await ensureDb();
            return sendJson(res, 200, { review: getReview(q.get("prId")!) });
        }
        // All stored reviews (compact — for list badges).
        if (p === "/api/review-results" && req.method === "GET") {
            await ensureDb();
            return sendJson(res, 200, { reviews: listReviews() });
        }

        return sendJson(res, 404, { error: "no such endpoint" });
    } catch (e) {
        return sendJson(res, 500, { error: (e as Error).message || String(e) });
    }
}
