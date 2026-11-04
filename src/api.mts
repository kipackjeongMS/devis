// JSON API router. Kept pure of transport concerns: server.mts wires this into
// the loopback server.

import type { IncomingMessage, ServerResponse } from "node:http";
import { BodyTooLargeError, sendJson, sendBuffer, readBody } from "./http.mjs";
import { readConfig, writeConfig } from "./config.mjs";
import { ensureDb, getReview, listReviews, listActiveReviewJobs, upsertReview, publishReviewRun, expireStaleReviews, markFindingPosted, markSemanticFindingPosted, setFindingHumanizedComment, setSemanticFindingHumanizedComment, setDismissed, listPlateDismissals, onPlateDismissed, setPlateDismissed, listNotifications, unreadCount, markNotificationsRead, markAllNotificationsRead, reviewIdentityKey, legacyReviewKey, pruneCommentActivity, prunePrRecency, type ReviewIdentity } from "./store.mjs";
import { commentActivity } from "./comment-activity.mjs";
import { prRecency } from "./pr-recency.mjs";
import { answerAsks } from "./comms.mjs";
import { readPrSnapshot, savePrSnapshot } from "./pr-snapshot.mjs";
import type { WorkItem } from "./service-files.mjs";
import type { Finding, SemanticFinding } from "./store.mjs";
import { writeReviewMarkdown } from "./reviews-md.mjs";
import { scanInbox, recordWatchFromAdoWrite } from "./inbox.mjs";
import { rephraseComment, buildRephrasePrompt, cleanRephrase, REPHRASE_INSTRUCTIONS_MAX } from "./rephrase.mjs";
import { voiceGuide } from "./user-skills.mjs";
import {
    asReviewerSessionId,
    getReviewerChat,
    reviewerSessionExists,
    openReviewerTerminal,
    runInReviewerSession,
    sendReviewerChat,
} from "./reviewer-session.mjs";
import { resolveCopilotRuntime, runOneShot } from "./copilot-runtime.mjs";
import { queueReviewTargets } from "./review-task.mjs";
import {
    listAssignedPRs,
    listActivePRs,
    listAuthoredPRs,
    listOlderActivePRs,
    ACTIVE_PR_PAGE,
    getPrSummary,
    getPrDetail,
    getFileDiff,
    postReply,
    createThread,
    createGeneralThread,
    updateThreadStatus,
    setMyVote,
    updatePrLifecycle,
    listBuildDefinitions,
    getDefinitionInfo,
    getRunParameters,
    type PipelineDefinition,
    type Pr,
} from "./ado.mjs";
import { normalizeBranch, validateGraph } from "./pipeline-graph.mjs";
import {
    PipelineStoreError,
    appBuilds,
    blockResults,
    deleteChain,
    enqueueRunCommand,
    getChain,
    getRun,
    latestRun,
    listChains,
    requestRunCancel,
    saveChain,
    startChainRun,
    takeCommandResult,
    triggerNode,
} from "./pipeline-store.mjs";
import { describeAdoError, tickPipelineRunner, wakePipelineRunner } from "./pipeline-runner.mjs";
import { parseThreadStatus, parseVote, parseLifecycleAction, parseCompletionOptions } from "./pr-actions.mjs";
import { parsePrCanvasTarget } from "./canvas-target.mjs";
import { getModelCatalog } from "./models.mjs";
import { handleJarvisApi } from "./jarvis-api.mjs";
import { notePrActivity, rememberPrs } from "./jarvis-today.mjs";
import { recordEvent } from "./jarvis-store.mjs";
import {
    getPrDescriptionImage,
    PrDescriptionImageError,
} from "./pr-description-image.mjs";

// Identifies this server's process instance. The webview pings this route at
// boot and again on failures to tell "genuine app error" apart from "I'm
// talking to a server instance that no longer matches the one I loaded
// against" — see web/src/api.ts.
const STARTED_AT = Date.now();

// ---- "Ask Copilot about this selection" round-trip -------------------------
// An ask runs in a headless session in the background; the modal polls
// /api/ask-result until the answer lands. Asks are ephemeral (in-process), so
// an in-memory map is enough; no DB.
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
// stamped at publish time. That way nothing on the loopback port can steer a
// follow-up into a session of its choosing.
function asReviewIdentity(value: Record<string, unknown>): ReviewIdentity {
    return {
        prId: value.prId == null ? "" : String(value.prId),
        org: value.org == null ? null : String(value.org),
        project: value.project == null ? null : String(value.project),
        repoId: value.repoId == null ? null : String(value.repoId),
    };
}

const COMMENT_ACTIVITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Hiding, restoring, and a queued review un-hiding a PR all change the review queue
// the overview and the Lead count, so the remembered PR list follows every one.
onPlateDismissed((identities, dismissed) => notePrActivity(identities, { hidden: dismissed }));

// Best-effort: the ADO write (or read) already succeeded, so never fail the request.
async function noteCommentActivity(value: Record<string, unknown>, commented: boolean, wrote = false): Promise<void> {
    const ref = {
        org: String(value.org ?? ""),
        project: String(value.project ?? ""),
        repoId: String(value.repoId ?? ""),
        prId: String(value.prId ?? ""),
    };
    if (!ref.org || !ref.project || !ref.repoId || !ref.prId) return;
    notePrActivity([ref], { commented });
    // Only a comment written now answers a Teams ask: having commented before says nothing about a newer ask.
    if (wrote) void answerAsks([ref], "you commented on the PR").catch((error: Error) => console.warn(`[comms] answering asks: ${error.message}`));
    try {
        await ensureDb();
        await commentActivity.record(ref, commented);
        if (wrote) await prRecency.record(ref, "comment");
    } catch (e) {
        console.error(`[comment-activity] record failed: ${(e as Error).message}`);
    }
}

// Whether a PR was dismissed from the plate, by its full identity or the legacy id-only key.
function markDismissed(list: Pr[]): void {
    const dismissed = listPlateDismissals();
    for (const pr of list) {
        const identity = { prId: pr.id, org: pr.org, project: pr.project, repoId: pr.repoId };
        pr.plateDismissed = dismissed.has(reviewIdentityKey(identity)) || dismissed.has(legacyReviewKey(pr.id));
    }
}

const prIdentity = (pr: Pr): string => JSON.stringify([pr.org, pr.repoId, pr.id]);

async function reviewerSessionFor(identity: ReviewIdentity): Promise<string | null> {
    if (String(identity.prId).trim() === "") return null;
    try {
        await ensureDb();
        return await availableReviewerSession(getReview(identity)?.reviewer_session_id);
    } catch (e) {
        console.error(`[reviewer-session] lookup failed: ${(e as Error).message}`);
        return null;
    }
}

/** The recorded reviewer session, or null when it is invalid or the CLI deleted it. */
async function availableReviewerSession(value: unknown): Promise<string | null> {
    const sessionId = asReviewerSessionId(value);
    if (!sessionId) return null;
    try {
        return (await reviewerSessionExists(sessionId)) ? sessionId : null;
    } catch {
        // The CLI is unreachable; let the follow-up surface that error.
        return sessionId;
    }
}

/** Inline plus semantic finding count. Findings are append-only, so growth means new ones. */
function reviewFindingCount(row: ReturnType<typeof getReview>): number {
    const shaped = shapeReview(row);
    if (!shaped) return 0;
    return (shaped.findingsList as unknown[]).length + (shaped.semanticFindingsList as unknown[]).length;
}

/** Review batches being prepared (PR files read, nothing queued yet). */
let preparingReviews = 0;

/** API work in flight that ends in saved state, for the background service's idle check. */
export function apiActivity(): WorkItem[] {
    return preparingReviews ? [{ kind: "review", label: `Preparing ${preparingReviews === 1 ? "a review batch" : `${preparingReviews} review batches`}` }] : [];
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const p = url.pathname;
    const q = url.searchParams;
    if (p.startsWith("/api/jarvis/")) return handleJarvisApi(req, res, url);
    console.log(`[api] ${req.method} ${p}`);

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

        // ---- available AI models (ids), and each with the reasoning efforts it takes ----
        if (p === "/api/models" && req.method === "GET") {
            const catalog = await getModelCatalog();
            return sendJson(res, 200, { models: catalog.map((m) => m.id), catalog });
        }
        // ---- how Copilot runs: through Agency, or the plain CLI with a warning ----
        if (p === "/api/copilot/runtime" && req.method === "GET") {
            try {
                const { via, command, warning } = await resolveCopilotRuntime();
                return sendJson(res, 200, { via, command, warning });
            } catch (error) {
                return sendJson(res, 200, { via: null, command: null, warning: `Copilot isn't available: ${(error as Error).message}` });
            }
        }

        // ---- active PRs across all configured (org, project) scopes ----
        // Orgs with configured projects return ALL active PRs in those projects
        // (each tagged `mine`); orgs without projects fall back to reviewer=me.
        // Filtering by org/project/assignment happens client-side.
        if (p === "/api/prs" && req.method === "GET") {
            const cfg = await readConfig();
            // The last complete list, for the page's first paint while the live one loads.
            if (q.get("cached") === "1") {
                await ensureDb();
                const snapshot = readPrSnapshot(cfg);
                if (!snapshot) return sendJson(res, 200, { prs: null });
                markDismissed(snapshot.prs);
                return sendJson(res, 200, { prs: snapshot.prs, errors: [], activityPending: 0, cached: true, at: snapshot.at });
            }
            const refreshActivity = q.get("refresh") === "1";
            const prs: Pr[] = [];
            const authoredAll: Pr[] = [];
            const capped: Array<{ org: string; project: string }> = [];
            const errors: string[] = [];
            const tasks: Promise<void>[] = [];
            for (const org of cfg.organizations) {
                const projects = cfg.projects[org] || [];
                if (projects.length) {
                    for (const project of projects) {
                        tasks.push(
                            (async () => {
                                try {
                                    const found = await listActivePRs(org, project);
                                    prs.push(...found);
                                    if (found.length >= ACTIVE_PR_PAGE) capped.push({ org, project });
                                } catch (e) {
                                    errors.push(`${org}/${project}: ${(e as Error).message}`);
                                }
                            })(),
                        );
                    }
                    // My PRs lists everything I authored, including PRs in projects
                    // that aren't configured or past the first page. Best-effort.
                    tasks.push(
                        (async () => {
                            try {
                                authoredAll.push(...(await listAuthoredPRs(org)));
                            } catch (e) {
                                console.warn(`[api] authored PRs for ${org}: ${(e as Error).message}`);
                            }
                        })(),
                    );
                } else {
                    tasks.push(
                        (async () => {
                            try {
                                const found = await listAssignedPRs(org);
                                prs.push(...found);
                            } catch (e) {
                                errors.push(`${org}: ${(e as Error).message}`);
                            }
                        })(),
                    );
                }
            }
            await Promise.all(tasks);
            await ensureDb();
            const listed = new Set(prs.map(prIdentity));
            const authored = authoredAll.filter((pr) => !listed.has(prIdentity(pr)));
            markDismissed(prs);
            markDismissed(authored);
            prs.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
            pruneCommentActivity(Date.now() - COMMENT_ACTIVITY_RETENTION_MS);
            prunePrRecency(Date.now() - COMMENT_ACTIVITY_RETENTION_MS);
            // Phase 1: cached "I commented" values only; stale PRs are checked in the
            // background and the client collects them from /api/pr-activity.
            const activityPending = await commentActivity.apply(prs, refreshActivity);
            // Same for last push and my last comment or vote; see /api/pr-recency.
            const recencyPending = await prRecency.apply([...prs, ...authored]);
            rememberPrs(prs);
            if (!errors.length) {
                try {
                    savePrSnapshot(cfg, prs);
                } catch (e) {
                    console.warn(`[api] could not keep the PR list for the next launch: ${(e as Error).message}`);
                }
            }
            return sendJson(res, 200, { prs, authored, capped, errors, activityPending, recencyPending });
        }

        // ---- older active PRs in one configured project, past the first `skip` ----
        if (p === "/api/prs/older" && req.method === "GET") {
            const cfg = await readConfig();
            const org = q.get("org") || "";
            const project = q.get("project") || "";
            const skip = Number(q.get("skip"));
            if (!cfg.organizations.includes(org) || !(cfg.projects[org] || []).includes(project)) {
                return sendJson(res, 400, { error: "not a configured project" });
            }
            if (!Number.isFinite(skip) || skip < 0) return sendJson(res, 400, { error: "skip must be a number" });
            const page = await listOlderActivePRs(org, project, skip);
            await ensureDb();
            markDismissed(page.prs);
            const activityPending = await commentActivity.apply(page.prs);
            const recencyPending = await prRecency.apply(page.prs);
            return sendJson(res, 200, { prs: page.prs, more: page.more, activityPending, recencyPending });
        }

        // ---- phase 2 of /api/prs: settled "I commented" activity ----
        if (p === "/api/pr-activity" && req.method === "GET") {
            const cfg = await readConfig();
            await ensureDb();
            const settled = await commentActivity.settle(cfg.organizations);
            notePrActivity(settled.commented, { commented: true });
            return sendJson(res, 200, settled);
        }

        // ---- phase 2 for last push and my last comment or vote ----
        // Waits a little for reads in flight; `pending` says whether to ask again.
        if (p === "/api/pr-recency" && req.method === "GET") {
            const cfg = await readConfig();
            await ensureDb();
            return sendJson(res, 200, await prRecency.settle(cfg.organizations, 15_000));
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
            // Threads were fetched only when the PR has an iteration.
            if (detail.commits?.iteration != null) {
                await noteCommentActivity(
                    { org: q.get("org"), project: q.get("project"), repoId: q.get("repoId"), prId: q.get("id") },
                    detail.iCommented,
                );
            }
            return sendJson(res, 200, detail);
        }

        // ---- authenticated images embedded in PR descriptions ----
        if (p === "/api/pr-description-image" && req.method === "GET") {
            const org = q.get("org") || "";
            const source = q.get("url") || "";
            if (!org.trim() || !source.trim()) {
                return sendJson(res, 400, { error: "org and url are required" });
            }
            try {
                const image = await getPrDescriptionImage(org, source);
                return sendBuffer(res, 200, image.body, image.contentType, {
                    "Cache-Control": "private, max-age=300",
                    "Cross-Origin-Resource-Policy": "same-origin",
                    "X-Content-Type-Options": "nosniff",
                });
            } catch (error) {
                if (error instanceof PrDescriptionImageError) {
                    return sendJson(res, error.status, { error: error.message });
                }
                throw error;
            }
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
            await noteCommentActivity(b, true, true);
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
            await noteCommentActivity(b, true, true);
            return sendJson(res, 200, created);
        }

        // ---- PR/thread state changes (ADO writes — user-initiated from the PR detail) ----
        if (p === "/api/thread-status" && req.method === "POST") {
            const b = await readBody(req);
            let status;
            try {
                status = parseThreadStatus(b.status);
            } catch (e) {
                return sendJson(res, 400, { error: (e as Error).message });
            }
            return sendJson(res, 200, await updateThreadStatus(b.org, b.project, b.repoId, b.prId, b.threadId, status));
        }
        if (p === "/api/pr-vote" && req.method === "POST") {
            const b = await readBody(req);
            let vote;
            try {
                vote = parseVote(b.vote);
            } catch (e) {
                return sendJson(res, 400, { error: (e as Error).message });
            }
            const voted = await setMyVote(b.org, b.project, b.repoId, b.prId, vote);
            notePrActivity([{ org: b.org, project: b.project, repoId: b.repoId, prId: b.prId }], { vote });
            if (vote !== 0) {
                try {
                    await ensureDb();
                    await prRecency.record(
                        { org: String(b.org), project: String(b.project), repoId: String(b.repoId), prId: String(b.prId) },
                        "vote",
                    );
                } catch (e) {
                    console.error(`[pr-recency] record failed: ${(e as Error).message}`);
                }
            }
            if (vote !== 0) void answerAsks([{ org: b.org, prId: b.prId }], "you voted on the PR").catch((error: Error) => console.warn(`[comms] answering asks: ${error.message}`));
            // Jarvis keeps reviews in its history; a failure there must not undo the vote.
            if (vote !== 0) {
                const title = typeof b.title === "string" ? b.title.slice(0, 200) : "";
                await recordEvent(
                    "pr.reviewed",
                    `${vote === 10 ? "Approved" : "Approved with suggestions"} PR #${b.prId}${title ? ` ${title}` : ""}`,
                    { ref: { org: b.org, project: b.project, repoId: b.repoId, prId: Number(b.prId), vote, title } },
                ).catch((e: Error) => console.error(`[jarvis] review not recorded: ${e.message}`));
            }
            return sendJson(res, 200, voted);
        }
        if (p === "/api/pr-lifecycle" && req.method === "POST") {
            const b = await readBody(req);
            let action;
            try {
                action = parseLifecycleAction(b.action);
                if (action === "complete" || action === "autoComplete") parseCompletionOptions(b.options);
            } catch (e) {
                return sendJson(res, 400, { error: (e as Error).message });
            }
            return sendJson(res, 200, await updatePrLifecycle(b.org, b.project, b.repoId, b.prId, action, b.options));
        }

        // ---- durable, bounded review queue run by the desktop review runner ----
        if (p === "/api/review/queue-targets" && req.method === "POST") {
            const body = await readBody(req);
            // Preparing a batch reads every PR's files before anything is queued; the service waits for it.
            preparingReviews++;
            try {
                return sendJson(res, 200, await queueReviewTargets(body));
            } finally {
                preparingReviews--;
            }
        }

        // ---- chat with the session that reviewed a PR ----
        if (p === "/api/reviewer-chat" && req.method === "GET") {
            const identity = {
                prId: q.get("prId") || "",
                org: q.get("org"),
                project: q.get("project"),
                repoId: q.get("repoId"),
            };
            const sessionId = await reviewerSessionFor(identity);
            if (!sessionId) return sendJson(res, 404, { error: "The Copilot session that reviewed this PR is no longer available." });
            const chat = await getReviewerChat(sessionId, identity);
            // Lets the chat refresh the review when the reviewer stages new findings.
            return sendJson(res, 200, { ...chat, findingCount: reviewFindingCount(getReview(identity)) });
        }
        if (p === "/api/reviewer-chat" && req.method === "POST") {
            const b = await readBody(req);
            const text = typeof b.text === "string" ? b.text.trim() : "";
            if (!text) return sendJson(res, 400, { error: "empty message" });
            if (text.length > 20_000) return sendJson(res, 400, { error: "message is too long" });
            const identity = asReviewIdentity(b);
            const sessionId = await reviewerSessionFor(identity);
            if (!sessionId) return sendJson(res, 404, { error: "The Copilot session that reviewed this PR is no longer available." });
            sendReviewerChat(sessionId, identity, text);
            return sendJson(res, 200, { ok: true });
        }
        if (p === "/api/reviewer-terminal" && req.method === "POST") {
            const b = await readBody(req);
            const identity = asReviewIdentity(b);
            const sessionId = await reviewerSessionFor(identity);
            if (!sessionId) return sendJson(res, 404, { error: "The Copilot session that reviewed this PR is no longer available." });
            try {
                await openReviewerTerminal(sessionId, `PR #${identity.prId} reviewer`);
            } catch (e) {
                return sendJson(res, 409, { error: (e as Error).message });
            }
            return sendJson(res, 200, { ok: true });
        }

        // ---- "Ask Copilot" about a diff selection ----
        // When the PR has a recorded reviewer session and the caller supplied a
        // prompt suitable for it, the prompt runs inside that session.
        // Otherwise it runs in a throwaway session. Either way the reply fills
        // the ask entry the modal polls.
        if (p === "/api/ask" && req.method === "POST") {
            const b = await readBody(req);
            const askId = b.askId != null ? String(b.askId).trim() : "";
            if (!askId) return sendJson(res, 400, { error: "askId required" });
            if (!b.prompt || !String(b.prompt).trim()) return sendJson(res, 400, { error: "empty prompt" });
            pruneAsks();
            const identity = asReviewIdentity(b);
            const reviewerPrompt = b.reviewerPrompt != null ? String(b.reviewerPrompt).trim() : "";
            const reviewerSessionId = reviewerPrompt ? await reviewerSessionFor(identity) : null;
            const answer = reviewerSessionId
                ? runInReviewerSession({ ...identity, sessionId: reviewerSessionId, prompt: reviewerPrompt })
                : runOneShot(String(b.prompt), {
                      // Only inline code selections: a file attachment would let
                      // the caller pull arbitrary local files into the prompt.
                      attachments: Array.isArray(b.attachments)
                          ? b.attachments.filter(
                                (a: unknown) =>
                                    !!a && typeof a === "object" && (a as { type?: unknown }).type === "selection",
                            )
                          : undefined,
                  });
            asks.set(askId, { status: "pending", ts: Date.now() });
            void answer
                .then((text) => asks.set(askId, { status: "done", answer: text, ts: Date.now() }))
                .catch((e: Error) =>
                    asks.set(askId, { status: "error", error: e.message || "Copilot did not answer", ts: Date.now() }),
                );
            return sendJson(res, 200, { ok: true, via: reviewerSessionId ? "reviewer-session" : "fresh" });
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
            // reviewer_session_id is stamped only by the publish_review tool,
            // from the tool invocation itself. Accepting it over HTTP would let
            // anything that reaches the loopback port pick which session later
            // follow-ups resume into, so drop it here.
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
            const review = shapeReview(getReview({
                prId: q.get("prId") || "",
                org: q.get("org"),
                project: q.get("project"),
                repoId: q.get("repoId"),
            }));
            // Hide follow-up affordances (chat, terminal) for a deleted session.
            if (review?.reviewer_session_id) {
                review.reviewer_session_id = await availableReviewerSession(review.reviewer_session_id);
            }
            return sendJson(res, 200, { review });
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
        // User-driven My feed lifecycle: hide (dismiss) or restore any PR.
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
            await noteCommentActivity(b, true, true);
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
            await noteCommentActivity(b, true, true);
            return sendJson(res, 200, created);
        }

        // ---- optionally rephrase a staged finding before posting ----
        // Preferred: resume the session that produced the review, so the rewrite
        // knows why the comment was written. Otherwise (legacy reviews, or that
        // session is gone) fall back to a throwaway headless session.
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
                instructions: typeof b.instructions === "string" ? b.instructions.trim().slice(0, REPHRASE_INSTRUCTIONS_MAX) : undefined,
                // Posted under the user's name: written in their voice when they have the skill for it.
                voice: voiceGuide(),
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
                        ...identity,
                        sessionId: reviewerSessionId,
                        prompt: buildRephrasePrompt(input),
                    });
                    text = cleanRephrase(reply);
                } catch (e) {
                    console.error(`[rephrase] reviewer session unavailable, using a fresh run: ${(e as Error).message}`);
                }
                if (text) return sendJson(res, 200, { text: await persist(text), via: "reviewer-session", voice: !!input.voice });
            }
            return sendJson(res, 200, { text: await persist(await rephraseComment(input)), via: "fresh", voice: !!input.voice });
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

        // ---- pipelines: catalog of build definitions + chains of them ----
        // Only configured projects are listed; orgs without projects are
        // reported so the UI can point at Settings.
        if (p === "/api/pipelines" && req.method === "GET") {
            const cfg = await readConfig();
            const refresh = q.get("refresh") === "1";
            const pipelines: PipelineDefinition[] = [];
            const errors: string[] = [];
            const unscopedOrgs: string[] = [];
            await Promise.all(
                cfg.organizations.flatMap((org) => {
                    const projects = cfg.projects[org] || [];
                    if (!projects.length) {
                        unscopedOrgs.push(org);
                        return [];
                    }
                    return projects.map(async (project) => {
                        try {
                            pipelines.push(...(await cachedDefinitions(org, project, refresh)));
                        } catch (e) {
                            errors.push(`${org}/${project}: ${describeAdoError(e)}`);
                        }
                    });
                }),
            );
            return sendJson(res, 200, { pipelines, errors, unscopedOrgs });
        }
        if (p === "/api/pipeline-chains" && req.method === "GET") {
            return sendJson(res, 200, { chains: await listChains() });
        }
        if (p === "/api/pipeline-chain" && req.method === "GET") {
            const id = q.get("id") || "";
            const chain = await getChain(id);
            if (!chain) return sendJson(res, 404, { error: "Chain not found" });
            return sendJson(res, 200, { chain, run: await latestRun(id) });
        }
        if (p === "/api/pipeline-chain-builds" && req.method === "GET") {
            return sendJson(res, 200, { builds: await appBuilds(q.get("id") || "") });
        }
        if (p === "/api/pipeline-chain-results" && req.method === "GET") {
            return sendJson(res, 200, { results: await blockResults(q.get("id") || "") });
        }
        if (p === "/api/pipeline-run" && req.method === "GET") {
            const run = await getRun(q.get("runId") || "");
            if (!run) return sendJson(res, 404, { error: "Run not found" });
            return sendJson(res, 200, { run });
        }
        if (p === "/api/pipeline-chains/save" && req.method === "POST") {
            const b = await readBody(req);
            const cfg = await readConfig();
            let graph;
            try {
                graph = validateGraph(b?.graph, cfg.organizations);
            } catch (e) {
                return sendJson(res, 400, { error: (e as Error).message });
            }
            const id = typeof b?.id === "string" && b.id ? b.id : undefined;
            const expectedUpdatedAt = typeof b?.updatedAt === "string" && b.updatedAt ? b.updatedAt : undefined;
            const chain = await saveChain({ id, name: b?.name, graph, expectedUpdatedAt });
            // A save during a run queued a "graph" command; apply it now, not on the next poll.
            wakePipelineRunner();
            return sendJson(res, 200, { chain });
        }
        // Runtime parameters and pipeline resources of one YAML pipeline on a branch,
        // for the block inspector. The runner looks these up again, uncached, at queue time.
        if (p === "/api/pipeline-definition-info" && req.method === "GET") {
            const cfg = await readConfig();
            const org = cfg.organizations.find((o) => o.toLowerCase() === (q.get("org") || "").toLowerCase());
            const project = (q.get("project") || "").trim();
            const definitionId = Number(q.get("id"));
            if (!org || !project || !Number.isInteger(definitionId) || definitionId <= 0) {
                return sendJson(res, 400, { error: "Unknown pipeline" });
            }
            const refresh = q.get("refresh") === "1";
            try {
                const definition = await cachedLookup(
                    `def\u0000${org}\u0000${project}\u0000${definitionId}`,
                    DEFINITION_INFO_MS,
                    refresh,
                    () => getDefinitionInfo(org, project, definitionId),
                );
                const base = { yaml: definition.yaml, defaultBranch: definition.defaultBranch };
                if (!definition.yaml) return sendJson(res, 200, { ...base, parameters: [], resources: [], repositories: [], errors: [] });
                const branch = normalizeBranch(q.get("branch")) || definition.defaultBranch;
                const info = await cachedLookup(
                    `params\u0000${org}\u0000${project}\u0000${definitionId}\u0000${branch}`,
                    RUN_PARAMETERS_MS,
                    refresh,
                    () => getRunParameters(org, project, definition.projectId, definitionId, branch),
                );
                return sendJson(res, 200, { ...base, ...info });
            } catch (e) {
                return sendJson(res, 502, { error: describeAdoError(e) });
            }
        }
        if (p === "/api/pipeline-chains/delete" && req.method === "POST") {
            const b = await readBody(req);
            return sendJson(res, 200, { deleted: await deleteChain(String(b?.id || "")) });
        }
        if (p === "/api/pipeline-chains/run" && req.method === "POST") {
            const b = await readBody(req);
            const run = await startChainRun(String(b?.id || ""));
            wakePipelineRunner();
            return sendJson(res, 200, { run });
        }
        if (p === "/api/pipeline-runs/cancel" && req.method === "POST") {
            const b = await readBody(req);
            const runId = String(b?.runId || "");
            if (!(await requestRunCancel(runId))) {
                return sendJson(res, 409, { error: "This run has already finished" });
            }
            wakePipelineRunner();
            return sendJson(res, 200, { run: await getRun(runId) });
        }
        if (p === "/api/pipeline-chains/trigger" && req.method === "POST") {
            const b = await readBody(req);
            const { run, commandId } = await triggerNode(String(b?.id || ""), String(b?.nodeId || ""));
            if (commandId === null) {
                wakePipelineRunner();
                return sendJson(res, 200, { run });
            }
            return sendCommandResult(res, run.runId, commandId);
        }
        if (p === "/api/pipeline-runs/stop-node" && req.method === "POST") {
            const b = await readBody(req);
            const runId = String(b?.runId || "");
            const commandId = await enqueueRunCommand(runId, "stop", String(b?.nodeId || ""));
            return sendCommandResult(res, runId, commandId);
        }

        return sendJson(res, 404, { error: "no such endpoint" });
    } catch (e) {
        if (e instanceof PipelineStoreError) return sendJson(res, e.status, { error: e.message });
        if (e instanceof BodyTooLargeError) return sendJson(res, e.status, { error: e.message });
        return sendJson(res, 500, { error: (e as Error).message || String(e) });
    }
}

// The runner applies run commands on its next tick; wait for it (bounded) so the
// caller learns whether the command was accepted. 202 = still pending.
const COMMAND_WAIT_MS = 20_000;

async function sendCommandResult(res: ServerResponse, runId: string, commandId: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([tickPipelineRunner(), new Promise((resolve) => (timer = setTimeout(resolve, COMMAND_WAIT_MS)))]);
    clearTimeout(timer);
    const result = await takeCommandResult(commandId);
    if (result?.status === "rejected") return sendJson(res, 409, { error: result.error || "The runner refused this request" });
    const run = await getRun(runId);
    if (result?.status === "done") return sendJson(res, 200, { run });
    return sendJson(res, 202, { run, pending: true });
}

// Build definitions change rarely; cache per project for ten minutes and share
// in-flight requests. A failed fetch is dropped so the next call retries.
const PIPELINE_CACHE_MS = 10 * 60_000;
const pipelineCache = new Map<string, { at: number; items: Promise<PipelineDefinition[]> }>();

function cachedDefinitions(org: string, project: string, refresh: boolean): Promise<PipelineDefinition[]> {
    const key = `${org}\u0000${project}`;
    const hit = pipelineCache.get(key);
    if (hit && !refresh && Date.now() - hit.at < PIPELINE_CACHE_MS) return hit.items;
    const items = listBuildDefinitions(org, project);
    pipelineCache.set(key, { at: Date.now(), items });
    items.catch(() => {
        if (pipelineCache.get(key)?.items === items) pipelineCache.delete(key);
    });
    return items;
}

// Inspector lookups: a definition's kind rarely changes; parameters follow the YAML on
// a branch, so they expire quickly. Failures are dropped so the next call retries.
const DEFINITION_INFO_MS = 5 * 60_000;
const RUN_PARAMETERS_MS = 60_000;
const lookupCache = new Map<string, { at: number; ttl: number; value: Promise<unknown> }>();

function cachedLookup<T>(key: string, ttl: number, refresh: boolean, load: () => Promise<T>): Promise<T> {
    const at = Date.now();
    const hit = lookupCache.get(key);
    if (hit && !refresh && at - hit.at < hit.ttl) return hit.value as Promise<T>;
    for (const [k, v] of lookupCache) if (at - v.at >= v.ttl) lookupCache.delete(k);
    const value = load();
    lookupCache.set(key, { at, ttl, value });
    value.catch(() => {
        if (lookupCache.get(key)?.value === value) lookupCache.delete(key);
    });
    return value;
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
        findingsList,
        semanticFindingsList,
    };
}
