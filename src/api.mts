// JSON API router. Kept pure of transport concerns: extension.mts wires this into
// the loopback server and injects the live session via setSession().

import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionRef } from "@github/copilot-sdk/extension";
import { sendJson, readBody } from "./http.mjs";
import { readConfig, writeConfig } from "./config.mjs";
import { ensureDb, getReview, getReviewAutomationProvenance, listReviews, listActiveReviewJobs, upsertReview, publishReviewRun, expireStaleReviews, markFindingPosted, markSemanticFindingPosted, setFindingHumanizedComment, setSemanticFindingHumanizedComment, setDismissed, listPlateDismissals, setPlateDismissed, listNotifications, unreadCount, markNotificationsRead, markAllNotificationsRead, reviewIdentityKey, legacyReviewKey, type ReviewIdentity } from "./store.mjs";
import type { Finding, SemanticFinding } from "./store.mjs";
import { writeReviewMarkdown } from "./reviews-md.mjs";
import { scanInbox, recordWatchFromAdoWrite } from "./inbox.mjs";
import { rephraseComment, buildRephrasePrompt, cleanRephrase } from "./rephrase.mjs";
import { runInReviewerSession, asReviewerSessionId } from "./reviewer-session.mjs";
import { queueReviewJobs, setReviewDispatchSession } from "./review-dispatch.mjs";
import { queueReviewTargets } from "./review-task.mjs";
import {
    getTeamsReviewIntakeState,
    ingestTeamsReviewRequests,
} from "./teams-review-intake.mjs";
import {
    listAssignedPRs,
    listActivePRs,
    getPrSummary,
    getPrDetail,
    getFileDiff,
    postReply,
    createThread,
    createGeneralThread,
    type Pr,
} from "./ado.mjs";
import { parsePrCanvasTarget } from "./canvas-target.mjs";
import { getServiceGroupRollouts, getRolloutGrid } from "./ev2.mjs";
import { getAvailableModels } from "./models.mjs";

// The active CLI session, injected after joinSession resolves. The bridge
// endpoint pushes prompts through it.
let sessionRef: SessionRef | null = null;

export function setSession(s: SessionRef | null): void {
    sessionRef = s;
    setReviewDispatchSession(s);
}

// Identifies this server's process instance. The loopback server binds an
// ephemeral port fresh on every extension (re)start, but a webview panel
// caches the URL from whenever it was opened. If the extension process gets
// reloaded, old panels are left pointing at a dead/stale port. Rather than
// let that surface as a confusing raw 404 ("no such endpoint") or network
// error, the webview pings this route at boot and again on failures to tell
// "genuine app error" apart from "I'm talking to a server instance that no
// longer matches the one I loaded against" — see web/src/api.ts.
const STARTED_AT = Date.now();

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

// ---- reviewer-session handoff ----------------------------------------------
// Follow-ups (Elaborate, rephrase-before-post) are answered by the Copilot
// session that actually produced the PR's review, so they inherit its context.
// The client names only the PR; the session id is looked up here from the row
// this extension stamped at publish time. That way nothing on the loopback port
// can steer a `copilot --resume` run into a session of its choosing.
function asReviewIdentity(value: Record<string, unknown>): ReviewIdentity {
    return {
        prId: value.prId == null ? "" : String(value.prId),
        org: value.org == null ? null : String(value.org),
        project: value.project == null ? null : String(value.project),
        repoId: value.repoId == null ? null : String(value.repoId),
    };
}

async function reviewerSessionFor(identity: ReviewIdentity): Promise<string | null> {
    if (String(identity.prId).trim() === "") return null;
    try {
        await ensureDb();
        return asReviewerSessionId(getReview(identity)?.reviewer_session_id);
    } catch (e) {
        console.error(`[reviewer-session] lookup failed: ${(e as Error).message}`);
        return null;
    }
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const p = url.pathname;
    const q = url.searchParams;
    console.error(`[api] ${req.method} ${p}`);

    try {
        // ---- server identity (stale-connection detection, see STARTED_AT above) ----
        if (p === "/api/ping" && req.method === "GET") {
            return sendJson(res, 200, { pid: process.pid, startedAt: STARTED_AT });
        }

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
            const refreshActivity = q.get("refresh") === "1";
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
                                    const found = await listActivePRs(org, project, refreshActivity);
                                    prs.push(...found);
                                    for (const pr of found) {
                                        if (pr.activityError) errors.push(`${org}/${project}: ${pr.activityError}`);
                                    }
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
                                const found = await listAssignedPRs(org, refreshActivity);
                                prs.push(...found);
                                for (const pr of found) {
                                    if (pr.activityError) errors.push(`${org}: ${pr.activityError}`);
                                }
                            } catch (e) {
                                errors.push(`${org}: ${(e as Error).message}`);
                            }
                        })(),
                    );
                }
            }
            await Promise.all(tasks);
            await ensureDb();
            const dismissed = listPlateDismissals();
            for (const pr of prs) {
                const identity = { prId: pr.id, org: pr.org, project: pr.project, repoId: pr.repoId };
                pr.plateDismissed =
                    dismissed.has(reviewIdentityKey(identity)) ||
                    dismissed.has(legacyReviewKey(pr.id));
            }
            prs.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
            return sendJson(res, 200, { prs, errors });
        }

        // ---- resolve one PR summary for a canvas deep-link ----
        if (p === "/api/pr-summary" && req.method === "GET") {
            let target;
            try {
                target = parsePrCanvasTarget({
                    org: q.get("org"),
                    project: q.get("project"),
                    repoId: q.get("repoId"),
                    prId: q.get("prId"),
                });
            } catch (e) {
                return sendJson(res, 400, { error: (e as Error).message });
            }
            if (!target) return sendJson(res, 400, { error: "PR target required" });
            const pr = await getPrSummary(target.org, target.project, target.repoId, target.prId);
            await ensureDb();
            const dismissed = listPlateDismissals();
            pr.plateDismissed =
                dismissed.has(reviewIdentityKey({
                    prId: pr.id,
                    org: pr.org,
                    project: pr.project,
                    repoId: pr.repoId,
                })) || dismissed.has(legacyReviewKey(pr.id));
            return sendJson(res, 200, { pr });
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
            // Record/refresh the durable watch from THIS successful write so a later
            // peer reply doesn't wait for the next discovery poll. The ADO write
            // already succeeded above; any failure here is logged and swallowed.
            await recordWatchFromAdoWrite({
                org: b.org, project: b.project, repoId: b.repoId, prId: b.prId, threadId: b.threadId,
                commentId: created?.id, publishedAt: created?.publishedDate ?? null,
            });
            return sendJson(res, 200, created);
        }

        // ---- create a new line-anchored thread (ADO write — user-initiated from the diff) ----
        if (p === "/api/thread" && req.method === "POST") {
            const b = await readBody(req);
            if (!b.content || !String(b.content).trim()) return sendJson(res, 400, { error: "empty comment" });
            const created = await createThread(b.org, b.project, b.repoId, b.prId, {
                filePath: b.filePath, line: b.line, endLine: b.endLine, side: b.side, content: b.content,
            });
            await recordWatchFromAdoWrite({
                org: b.org, project: b.project, repoId: b.repoId, prId: b.prId, threadId: created.id,
                commentId: created.comments?.[0]?.id, publishedAt: created.comments?.[0]?.published ?? null,
            });
            return sendJson(res, 200, created);
        }

        // ---- durable, bounded dispatch into independent app-managed sessions ----
        if (p === "/api/review/queue" && req.method === "POST") {
            return sendJson(res, 200, await queueReviewJobs(await readBody(req)));
        }
        if (p === "/api/review/queue-targets" && req.method === "POST") {
            return sendJson(res, 200, await queueReviewTargets(await readBody(req)));
        }
        if (p === "/api/teams-review-intake/state" && req.method === "POST") {
            return sendJson(res, 200, await getTeamsReviewIntakeState(await readBody(req)));
        }
        if (p === "/api/teams-review-intake/ingest" && req.method === "POST") {
            const body = await readBody(req);
            const canvasInstanceId =
                typeof body.canvasInstanceId === "string" ? body.canvasInstanceId.trim() : "";
            if (!canvasInstanceId) {
                return sendJson(res, 400, { error: "canvasInstanceId required" });
            }
            const { canvasInstanceId: _canvasInstanceId, ...intake } = body;
            return sendJson(
                res,
                200,
                await ingestTeamsReviewRequests(intake, canvasInstanceId),
            );
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
        // Two transports. When the PR has a recorded reviewer session and the
        // caller supplied a prompt suitable for it, the prompt is resumed inside
        // that session and its reply fills the ask entry directly. Otherwise it
        // goes to the local chat session and the agent POSTs its answer back to
        // /api/ask-result.
        if (p === "/api/ask" && req.method === "POST") {
            const b = await readBody(req);
            const askId = b.askId != null ? String(b.askId).trim() : "";
            if (!askId) return sendJson(res, 400, { error: "askId required" });
            if (!b.prompt || !String(b.prompt).trim()) return sendJson(res, 400, { error: "empty prompt" });
            pruneAsks();
            const reviewerPrompt = b.reviewerPrompt != null ? String(b.reviewerPrompt).trim() : "";
            const reviewerSessionId = reviewerPrompt ? await reviewerSessionFor(asReviewIdentity(b)) : null;
            if (reviewerSessionId) {
                asks.set(askId, { status: "pending", ts: Date.now() });
                void runInReviewerSession({ sessionId: reviewerSessionId, prompt: reviewerPrompt })
                    .then((answer) => asks.set(askId, { status: "done", answer, ts: Date.now() }))
                    .catch((e: Error) =>
                        asks.set(askId, { status: "error", error: e.message || "reviewer session failed", ts: Date.now() }),
                    );
                return sendJson(res, 200, { ok: true, via: "reviewer-session" });
            }
            if (!sessionRef || typeof sessionRef.send !== "function") {
                return sendJson(res, 503, { error: "session not available" });
            }
            asks.set(askId, { status: "pending", ts: Date.now() });
            await sessionRef.send({
                prompt: String(b.prompt),
                attachments: Array.isArray(b.attachments) ? b.attachments : undefined,
            });
            return sendJson(res, 200, { ok: true, via: "session" });
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
            const status = b.status == null ? "" : String(b.status);
            const current = getReview(asReviewIdentity(b));
            if (
                (status === "done" || status === "error") &&
                current?.run_id &&
                (!b.runId || String(b.runId) !== current.run_id)
            ) {
                return sendJson(res, 409, { error: "stale review run" });
            }
            // reviewer_session_id is stamped from this extension's own session on
            // the canvas-action publish path. Accepting it over HTTP would let the
            // reviewing agent — or anything else that reaches the loopback port —
            // pick which session later follow-ups resume into, so drop it here.
            const { reviewerSessionId: _clientSuppliedSession, ...safe } = b;
            const merged =
                (status === "done" || status === "error") && b.runId
                    ? publishReviewRun({ ...safe, runId: String(b.runId) })
                    : upsertReview(safe);
            return sendJson(res, 200, merged);
        }
        // On-demand: write the stored review to the configured markdown folder.
        // Saving is opt-in (a "Save as .md" button in the canvas), so this returns
        // a precise outcome the UI can surface (saved+path / disabled / empty).
        if (p === "/api/review-md" && req.method === "POST") {
            const b = await readBody(req);
            if (b.prId == null || String(b.prId).trim() === "") {
                return sendJson(res, 400, { error: "prId required" });
            }
            await ensureDb();
            const row = getReview(asReviewIdentity(b));
            if (!row) return sendJson(res, 404, { error: "no review for this PR" });
            const result = await writeReviewMarkdown(row);
            return sendJson(res, 200, result);
        }
        // Single PR's stored review (or null). Parse structured findings for the client.
        if (p === "/api/review-result" && req.method === "GET") {
            await ensureDb();
            expireStaleReviews();
            return sendJson(res, 200, {
                review: shapeReview(getReview({
                    prId: q.get("prId") || "",
                    org: q.get("org"),
                    project: q.get("project"),
                    repoId: q.get("repoId"),
                })),
            });
        }
        // All stored reviews (compact — for list badges).
        if (p === "/api/review-results" && req.method === "GET") {
            await ensureDb();
            expireStaleReviews();
            return sendJson(res, 200, {
                reviews: listReviews(),
                activeJobs: listActiveReviewJobs(),
            });
        }
        // User-driven My Plate lifecycle: remove (dismiss) or restore any PR.
        // Body: { prs: ReviewIdentity[], dismissed?: boolean } — dismissed defaults to true.
        if (p === "/api/review/dismiss" && req.method === "POST") {
            const b = await readBody(req);
            const identities: ReviewIdentity[] = Array.isArray(b.prs)
                ? b.prs.map((item: Record<string, unknown>) => asReviewIdentity(item))
                : Array.isArray(b.prIds)
                  ? b.prIds.map((prId: unknown) => ({ prId: String(prId) }))
                  : [];
            if (!identities.length) return sendJson(res, 400, { error: "prs required" });
            const dismissed = b.dismissed === undefined ? true : !!b.dismissed;
            await ensureDb();
            const changed = setPlateDismissed(identities, dismissed);
            setDismissed(identities, dismissed);
            return sendJson(res, 200, { ok: true, dismissed, changed });
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
            if (b.findingId != null) {
                markFindingPosted(asReviewIdentity(b), String(b.findingId));
            }
            return sendJson(res, 200, created);
        }

        if (p === "/api/review/post-semantic-finding" && req.method === "POST") {
            const b = await readBody(req);
            if (!b.content || !String(b.content).trim()) {
                return sendJson(res, 400, { error: "empty comment" });
            }
            const semanticFindingId =
                b.semanticFindingId == null ? "" : String(b.semanticFindingId).trim();
            if (!semanticFindingId) {
                return sendJson(res, 400, { error: "semanticFindingId required" });
            }
            const created = await createGeneralThread(
                b.org,
                b.project,
                b.repoId,
                b.prId,
                String(b.content),
            );
            await ensureDb();
            markSemanticFindingPosted(asReviewIdentity(b), semanticFindingId);
            await recordWatchFromAdoWrite({
                org: b.org,
                project: b.project,
                repoId: b.repoId,
                prId: b.prId,
                threadId: created.id,
                commentId: created.comments?.[0]?.id,
                publishedAt: created.comments?.[0]?.published ?? null,
            });
            return sendJson(res, 200, created);
        }

        // ---- optionally rephrase a staged finding before posting ----
        // Preferred: resume the session that produced the review, so the rewrite
        // knows why the comment was written. Otherwise (legacy reviews, or that
        // session is gone) fall back to a throwaway headless `copilot -p`.
        // Neither path creates a visible chat session.
        if (p === "/api/rephrase" && req.method === "POST") {
            const b = await readBody(req);
            if (!b.comment || !String(b.comment).trim()) return sendJson(res, 400, { error: "empty comment" });
            const identity = asReviewIdentity(b);
            const findingId = b.findingId == null ? "" : String(b.findingId).trim();
            const semanticFindingId =
                b.semanticFindingId == null ? "" : String(b.semanticFindingId).trim();
            if (findingId && semanticFindingId) {
                return sendJson(res, 400, { error: "only one finding id may be provided" });
            }
            const input = {
                comment: String(b.comment),
                title: b.title ? String(b.title) : undefined,
                model: b.model ? String(b.model) : undefined,
            };
            const persist = async (text: string): Promise<string> => {
                if (findingId) {
                    await ensureDb();
                    setFindingHumanizedComment(identity, findingId, text);
                } else if (semanticFindingId) {
                    await ensureDb();
                    setSemanticFindingHumanizedComment(identity, semanticFindingId, text);
                }
                return text;
            };
            const reviewerSessionId = await reviewerSessionFor(identity);
            if (reviewerSessionId) {
                let text = "";
                try {
                    const reply = await runInReviewerSession({
                        sessionId: reviewerSessionId,
                        prompt: buildRephrasePrompt(input),
                    });
                    text = cleanRephrase(reply);
                } catch (e) {
                    console.error(`[rephrase] reviewer session unavailable, using a fresh run: ${(e as Error).message}`);
                }
                if (text) return sendJson(res, 200, { text: await persist(text), via: "reviewer-session" });
            }
            return sendJson(res, 200, { text: await persist(await rephraseComment(input)), via: "fresh" });
        }

        // ---- notification inbox (peer comments/replies on my authored PRs) ----
        // GET lists the persisted feed; POST /poll runs a scan (ADO fetch + diff +
        // dedup) and returns the refreshed feed; POST /read marks items read.
        if (p === "/api/inbox" && req.method === "GET") {
            await ensureDb();
            return sendJson(res, 200, { items: listNotifications(), unread: unreadCount() });
        }
        if (p === "/api/inbox/poll" && req.method === "POST") {
            await ensureDb();
            const { inserted, diagnostics } = await scanInbox();
            return sendJson(res, 200, { items: listNotifications(), unread: unreadCount(), inserted, diagnostics });
        }
        if (p === "/api/inbox/read" && req.method === "POST") {
            await ensureDb();
            const b = await readBody(req);
            if (b && b.all) markAllNotificationsRead();
            else if (b && Array.isArray(b.ids)) markNotificationsRead(b.ids.map(String));
            return sendJson(res, 200, { unread: unreadCount() });
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

// Shape structured review arrays for the client and drop their raw JSON columns.
function shapeReview(row: ReturnType<typeof getReview>): Record<string, unknown> | null {
    if (!row) return null;
    const { findings_json, semantic_findings_json, ...rest } = row;
    let findingsList: Finding[] = [];
    let semanticFindingsList: SemanticFinding[] = [];
    if (findings_json) {
        try {
            const parsed = JSON.parse(findings_json);
            if (Array.isArray(parsed)) findingsList = parsed;
        } catch {
            /* ignore malformed json */
        }
    }
    if (semantic_findings_json) {
        try {
            const parsed = JSON.parse(semantic_findings_json);
            if (Array.isArray(parsed)) semanticFindingsList = parsed;
        } catch {
            /* ignore malformed json */
        }
    }
    return {
        ...rest,
        ...getReviewAutomationProvenance(row.run_id),
        findingsList,
        semanticFindingsList,
    };
}
