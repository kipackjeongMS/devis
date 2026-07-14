// JSON API router. Kept pure of transport concerns: extension.mts wires this into
// the loopback server and injects the live session via setSession().

import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionRef } from "@github/copilot-sdk/extension";
import { sendJson, readBody } from "./http.mjs";
import { readConfig, writeConfig } from "./config.mjs";
import { ensureDb, getReview, listReviews, upsertReview, markFindingPosted } from "./store.mjs";
import type { Finding } from "./store.mjs";
import {
    listAssignedPRs,
    listActivePRs,
    getPrDetail,
    getFileDiff,
    postReply,
    createThread,
    type Pr,
} from "./ado.mjs";
import { getServiceGroupRollouts, getRolloutGrid } from "./ev2.mjs";
import { getAvailableModels } from "./models.mjs";

// The active CLI session, injected after joinSession resolves. The bridge
// endpoint pushes prompts through it.
let sessionRef: SessionRef | null = null;

export function setSession(s: SessionRef | null): void {
    sessionRef = s;
}

// ---- "Ask Copilot about this selection" round-trip -------------------------
// session.send() is fire-and-forget (the model answers in the chat), so to show
// the answer back in the canvas modal we register a pending ask, tell the agent
// to POST its answer to /api/ask-result, and let the modal poll for it. Asks are
// ephemeral (one session, in-process) — an in-memory map is enough; no DB.
interface AskEntry {
    status: "pending" | "done" | "error";
    answer?: string;
    error?: string;
    ts: number;
}
const asks = new Map<string, AskEntry>();
const ASK_TTL_MS = 10 * 60 * 1000;

function pruneAsks(): void {
    const cutoff = Date.now() - ASK_TTL_MS;
    for (const [id, e] of asks) if (e.ts < cutoff) asks.delete(id);
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

        // ---- available AI models for PR review ----
        if (p === "/api/models" && req.method === "GET") {
            const refresh = q.get("refresh") === "1";
            return sendJson(res, 200, { models: await getAvailableModels(refresh) });
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

        // ---- "Ask Copilot" about a diff selection: register + send ----
        if (p === "/api/ask" && req.method === "POST") {
            const b = await readBody(req);
            const askId = b.askId != null ? String(b.askId).trim() : "";
            if (!askId) return sendJson(res, 400, { error: "askId required" });
            if (!b.prompt || !String(b.prompt).trim()) return sendJson(res, 400, { error: "empty prompt" });
            if (!sessionRef || typeof sessionRef.send !== "function") {
                return sendJson(res, 503, { error: "session not available" });
            }
            pruneAsks();
            asks.set(askId, { status: "pending", ts: Date.now() });
            await sessionRef.send({ prompt: String(b.prompt) });
            return sendJson(res, 200, { ok: true });
        }
        // The agent POSTs its answer here; the modal reads it back.
        if (p === "/api/ask-result" && req.method === "POST") {
            const b = await readBody(req);
            const askId = b.askId != null ? String(b.askId).trim() : "";
            if (!askId) return sendJson(res, 400, { error: "askId required" });
            const entry: AskEntry = b.error
                ? { status: "error", error: String(b.error), ts: Date.now() }
                : { status: "done", answer: String(b.answer ?? ""), ts: Date.now() };
            asks.set(askId, entry);
            return sendJson(res, 200, { ok: true });
        }
        // The modal polls this until the answer (or error) arrives.
        if (p === "/api/ask-result" && req.method === "GET") {
            const askId = (q.get("askId") || "").trim();
            const entry = askId ? asks.get(askId) : undefined;
            return sendJson(res, 200, entry || { status: "pending" });
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
        // Single PR's stored review (or null). Parse structured findings for the client.
        if (p === "/api/review-result" && req.method === "GET") {
            await ensureDb();
            return sendJson(res, 200, { review: shapeReview(getReview(q.get("prId")!)) });
        }
        // All stored reviews (compact — for list badges).
        if (p === "/api/review-results" && req.method === "GET") {
            await ensureDb();
            return sendJson(res, 200, { reviews: listReviews() });
        }

        // ---- post ONE staged finding as a real ADO thread, then persist it posted ----
        // Reuses createThread; keeps staging local until the user clicks "Post".
        if (p === "/api/review/post-finding" && req.method === "POST") {
            const b = await readBody(req);
            if (!b.content || !String(b.content).trim()) return sendJson(res, 400, { error: "empty comment" });
            const created = await createThread(b.org, b.project, b.repoId, b.prId, {
                filePath: b.filePath, line: b.line, endLine: b.endLine, side: b.side, content: b.content,
            });
            await ensureDb();
            if (b.findingId != null) markFindingPosted(b.prId, String(b.findingId));
            return sendJson(res, 200, created);
        }

        // ---- Ev2 rollouts: all service groups, status-enriched summaries ----
        // Lightweight "Release Dashboard" — auth via the same az login as ADO.
        if (p === "/api/ev2/rollouts" && req.method === "GET") {
            return sendJson(res, 200, await getServiceGroupRollouts());
        }

        // ---- Ev2 rollout: lazy per-rollout stage/region grid (heavy embed detail) ----
        if (p === "/api/ev2/rollout" && req.method === "GET") {
            const grid = await getRolloutGrid(q.get("serviceGroup")!, q.get("id")!);
            return sendJson(res, 200, grid);
        }

        return sendJson(res, 404, { error: "no such endpoint" });
    } catch (e) {
        return sendJson(res, 500, { error: (e as Error).message || String(e) });
    }
}

// Shape a stored review row for the client: parse structured findings out of the
// findings_json column into a `findingsList` array; drop the raw JSON string.
function shapeReview(row: ReturnType<typeof getReview>): Record<string, unknown> | null {
    if (!row) return null;
    const { findings_json, ...rest } = row;
    let findingsList: Finding[] = [];
    if (findings_json) {
        try {
            const parsed = JSON.parse(findings_json);
            if (Array.isArray(parsed)) findingsList = parsed;
        } catch {
            /* ignore malformed json */
        }
    }
    return { ...rest, findingsList };
}
