// Notification inbox: derive persisted, deduped events from ADO. ADO has no push
// to a local process (service hooks need a public webhook), so this is the same
// shape notify.ts uses for reviews: poll -> diff against a watermark -> INSERT OR
// IGNORE.
//
// v1 only scanned active PRs the current user AUTHORED, so a reply to the
// user's own comment on someone else's PR was invisible (the classic case: you
// left review feedback, the author replied, and the inbox never noticed). v2
// adds a durable "watch" concept (see store.mts `inbox_watches`): any thread the
// user has commented in gets a persistent watch that keeps getting polled for
// new peer replies — including after the PR completes — independent of whether
// that PR still shows up in an "active PRs" listing.
//
// Two watch kinds:
//   "authored"     — a whole PR the user created. Every peer non-system comment
//                    anywhere on it qualifies (unchanged from v1).
//   "participated" — one specific thread, on a PR authored by someone else,
//                    where the user left a non-system comment. Only later peer
//                    comments in THAT thread, posted after the user's own
//                    comment, qualify — robust to ADO's flat parentCommentId
//                    (replies don't reliably point at the specific comment they
//                    answer, only at the thread root).
import { prScopes, readConfig } from "./config.mjs";
import {
    getMe,
    getPrSummary,
    listAssignedPRs,
    listActivePRs,
    listAuthoredPRs,
    getPrThreads,
    type Pr,
    type Me,
    type InboxComment,
} from "./ado.mjs";
import {
    ensureDb,
    insertNotifications,
    getMeta,
    setMeta,
    upsertInboxWatch,
    listInboxWatches,
    listInboxWatchOrgs,
    pruneInboxWatches,
    touchInboxWatch,
    deleteInboxWatch,
    type NotificationInput,
    type InboxWatchRow,
} from "./store.mjs";

/** ADO calls scanInbox needs, factored out so a test harness can inject a fake
 *  ADO layer instead of hitting the network. */
export interface InboxAdoDependencies {
    getMe: typeof getMe;
    listAuthoredPRs: typeof listAuthoredPRs;
    listActivePRs: typeof listActivePRs;
    listAssignedPRs: typeof listAssignedPRs;
    getPrThreads: typeof getPrThreads;
    getPrSummary: typeof getPrSummary;
}

const defaultDeps: InboxAdoDependencies = {
    getMe,
    listAuthoredPRs,
    listActivePRs,
    listAssignedPRs,
    getPrThreads,
    getPrSummary,
};

const SNIPPET_LEN = 200;

// Pre-v2 single global watermark. Kept readable-only so upgrading an existing
// install doesn't look like a brand-new first run (which would suppress every
// authored-PR notification the moment the per-org keys below are introduced).
const LEGACY_WATERMARK_KEY = "inbox_last_poll";
const orgWatermarkKey = (org: string): string => `inbox_last_poll:${org}`;

// A poll never re-derives *exactly* at the previous watermark — a few minutes
// of overlap absorbs clock skew between this process and ADO without risking a
// missed event, and re-derived events are always dedup-safe (INSERT OR IGNORE
// on a scoped id), so replaying the overlap window is harmless.
const WATERMARK_OVERLAP_MS = 5 * 60 * 1000;

// A thread the user participated in can be years old. The very first time the
// inbox discovers that watch, only look back this far — otherwise a comment
// left long ago would suddenly surface its entire reply history as "new".
const BACKFILL_MS = 30 * 24 * 60 * 60 * 1000;

// Bounded worker pools — replace the old flat "first 25 authored PRs" cap with
// something that scans every configured PR/thread but never fans out
// unbounded ADO calls at once.
const PROJECT_CONCURRENCY = 4;
const THREAD_FETCH_CONCURRENCY = 6;

/** ADO's answer when the PR or its repo is gone, or no longer visible to you. */
const PR_GONE = /^ADO GET 404\b/;

const newestAt = (comments: InboxComment[]): number => {
    let at = -Infinity;
    for (const c of comments) {
        const t = c.published ? Date.parse(c.published) : NaN;
        if (t > at) at = t;
    }
    return at;
};

/**
 * Drops watches with no sign of life for `quietMs` before each org's last
 * complete poll. Measuring from the poll, not the clock, means a closed app or
 * an org whose polls keep failing never loses a watch before it has been
 * checked; an org that has never been polled keeps everything.
 */
export function pruneStaleInboxWatches(quietMs: number): number {
    const legacy = getMeta(LEGACY_WATERMARK_KEY);
    let removed = 0;
    for (const org of listInboxWatchOrgs()) {
        const polled = Date.parse(getMeta(orgWatermarkKey(org)) ?? legacy ?? "");
        if (!Number.isFinite(polled)) continue;
        removed += pruneInboxWatches(org, polled - quietMs);
    }
    return removed;
}

/** Run `fn` over every item with at most `size` calls in flight at once. */
async function mapPool<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        for (;;) {
            const idx = next++;
            if (idx >= items.length) return;
            results[idx] = await fn(items[idx]);
        }
    };
    const workerCount = Math.max(1, Math.min(size, items.length));
    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
}

function isPeerComment(c: InboxComment, meId: string | undefined): boolean {
    if (c.commentType === "system") return false;
    if (!c.content || !c.content.trim()) return false;
    if (!c.published) return false;
    if (meId && c.authorId === meId) return false;
    return true;
}

/** Scoped, collision-proof notification id — the actual bug this replaces:
 *  bare `comment:<id>` collided whenever two PRs happened to contain a comment
 *  with the same numeric id (ADO ids are only unique within one thread). */
function notificationId(
    org: string,
    project: string | null | undefined,
    repoId: string | null | undefined,
    prId: string | number,
    threadId: string | number | null | undefined,
    commentId: string | number,
): string {
    return [
        "comment",
        org,
        project || "",
        repoId || "",
        String(prId),
        threadId != null ? String(threadId) : "0",
        String(commentId),
    ].join(":");
}

interface PrShape {
    id: number | string;
    org: string;
    project?: string | null;
    repo?: string | null;
    repoId?: string | null;
    title?: string | null;
    url?: string | null;
}

function toNotification(pr: PrShape, c: InboxComment, threadId: string | number | null): NotificationInput {
    const isReply = c.parentCommentId > 0;
    return {
        id: notificationId(pr.org, pr.project, pr.repoId, pr.id, threadId, c.id),
        kind: isReply ? "reply" : "comment",
        prId: pr.id,
        org: pr.org,
        project: pr.project ?? null,
        repo: pr.repo ?? null,
        repoId: pr.repoId ?? null,
        title: pr.title ?? null,
        actor: c.authorName,
        summary: `${c.authorName} ${isReply ? "replied" : "commented"} on PR #${pr.id}`,
        snippet: c.content.replace(/\s+/g, " ").trim().slice(0, SNIPPET_LEN),
        url: pr.url ?? null,
        createdAt: c.published ?? null,
    };
}

/**
 * Pure: a PR the user authored — every peer (non-system, non-own) comment
 * newer than `cutoffIso` qualifies, root comments included (not "only
 * replies"). `firstRun` seeds cleanly: a brand-new install never floods the
 * inbox with a PR's entire comment history.
 */
export function authoredPrEvents(
    pr: PrShape,
    comments: readonly InboxComment[],
    meId: string | undefined,
    cutoffIso: string | null,
    firstRun: boolean,
): NotificationInput[] {
    if (firstRun) return [];
    const out: NotificationInput[] = [];
    for (const c of comments) {
        if (!isPeerComment(c, meId)) continue;
        if (cutoffIso && c.published! <= cutoffIso) continue;
        out.push(toNotification(pr, c, c.threadId));
    }
    return out;
}

/**
 * Pure: one thread the user participated in but did not author the PR of.
 * Only comments strictly newer than the user's own last comment in THAT
 * thread qualify — this is what makes the check robust to ADO's flat
 * parentCommentId (a reply's parentCommentId typically points at the thread
 * root, not the specific comment it answers, so parentCommentId equality is
 * not a reliable "replied to me" signal). `cutoffIso` additionally bounds
 * both the ordinary incremental watermark AND the one-time 30-day backfill
 * window for a newly discovered watch.
 */
export function participatedThreadEvents(
    pr: PrShape,
    threadId: string | number,
    comments: readonly InboxComment[],
    meId: string | undefined,
    myLastCommentAt: string | null,
    cutoffIso: string | null,
): NotificationInput[] {
    const out: NotificationInput[] = [];
    const tid = String(threadId);
    for (const c of comments) {
        if (String(c.threadId) !== tid) continue;
        if (!isPeerComment(c, meId)) continue;
        if (myLastCommentAt && c.published! <= myLastCommentAt) continue;
        if (cutoffIso && c.published! <= cutoffIso) continue;
        out.push(toNotification(pr, c, threadId));
    }
    return out;
}

function dedupeById(events: readonly NotificationInput[]): NotificationInput[] {
    const seen = new Set<string>();
    const out: NotificationInput[] = [];
    for (const e of events) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        out.push(e);
    }
    return out;
}

/** One org/project/repo/PR's identity, used as the key for grouping watch rows
 *  so a completed-PR's authored watch and its participated-thread watches
 *  share a single `getPrThreads` fetch. */
function prGroupKey(project: string | null, repoId: string | null, prId: string): string {
    return `${project ?? ""}::${repoId ?? ""}::${prId}`;
}

function rowToPrShape(row: InboxWatchRow, org: string): PrShape {
    return {
        id: row.pr_id,
        org,
        project: row.project,
        repo: row.repo,
        repoId: row.repo_id,
        title: row.title,
        url: row.url,
    };
}

/** Per-thread comment identity of the user's own non-system comments, used
 *  both by discovery (does this thread qualify as a watch at all?) and by
 *  ongoing polling (has the user commented again since the watch was made,
 *  moving the "after participation" floor forward?). */
function latestOwnComment(
    comments: readonly InboxComment[],
    meId: string | undefined,
): { id: number; published: string } | null {
    let best: { id: number; published: string } | null = null;
    for (const c of comments) {
        if (!meId || c.authorId !== meId) continue;
        if (c.commentType === "system") continue;
        if (!c.content || !c.content.trim()) continue;
        if (!c.published) continue;
        if (!best || c.published > best.published) best = { id: c.id, published: c.published };
    }
    return best;
}

export interface OrgScanDiagnostics {
    org: string;
    scannedWatches: number;
    discovered: number;
    failed: string[];
    watermarkAdvanced: boolean;
}

export interface ScanResult {
    inserted: number;
    diagnostics: OrgScanDiagnostics[];
}

/**
 * One poll pass, scoped per org so one org's outage never blocks another's
 * watermark from advancing (or its events from persisting):
 *   1. Authored PRs (active) → refresh/insert an "authored" watch per PR.
 *   2. Discovery: configured active PRs (or the org-wide reviewer/author
 *      fallback when no projects are configured) → any thread carrying a
 *      non-system comment from the current user becomes a "participated"
 *      watch. Brand-new watches get a bounded 30-day backfill so a just-
 *      discovered missed reply still surfaces without replaying years of
 *      history.
 *   3. Every durable watch on file (including ones discovery didn't touch
 *      this pass — e.g. a watch on a PR that has since completed and no
 *      longer appears in any "active" listing) is polled for new peer
 *      comments.
 * The watermark for an org only advances when every required fetch for that
 * org succeeded this pass; a partial failure still persists whatever events
 * were derived from the calls that DID succeed (dedup makes replay safe).
 * Each org's derived events are inserted BEFORE that org's watermark is
 * advanced (insert-then-commit-cursor), so a crash between the two can only
 * ever leave the watermark un-advanced (safe to retry), never advanced past
 * events that were never actually persisted.
 */
export async function scanInbox(deps: InboxAdoDependencies = defaultDeps): Promise<ScanResult> {
    const cfg = await readConfig();
    const now = new Date().toISOString();
    const legacyWatermark = getMeta(LEGACY_WATERMARK_KEY);

    const diagnostics: OrgScanDiagnostics[] = [];
    let inserted = 0;

    for (const org of cfg.organizations) {
        const diag: OrgScanDiagnostics = { org, scannedWatches: 0, discovered: 0, failed: [], watermarkAdvanced: false };
        diagnostics.push(diag);
        const orgEvents: NotificationInput[] = [];

        let me: Me;
        try {
            me = await deps.getMe(org);
        } catch (e) {
            diag.failed.push(`getMe: ${(e as Error).message}`);
            continue; // nothing in this org is attributable to "me" without an identity
        }
        const meId = me.id;

        const watermarkKey = orgWatermarkKey(org);
        const storedWatermark = getMeta(watermarkKey);
        const lastPoll = storedWatermark ?? legacyWatermark; // migrate the legacy global watermark on first per-org poll
        const firstRunOrg = lastPoll === null;
        const cutoff = lastPoll ? new Date(Date.parse(lastPoll) - WATERMARK_OVERLAP_MS).toISOString() : null;
        const backfillCutoff = new Date(Date.now() - BACKFILL_MS).toISOString();

        let orgFailed = false;

        // ---- 1. Authored PRs: durable "authored" watch, one row per PR ----
        try {
            const authoredPrs = await deps.listAuthoredPRs(org);
            for (const pr of authoredPrs) {
                upsertInboxWatch({
                    kind: "authored",
                    org,
                    project: pr.project ?? null,
                    repo: pr.repo ?? null,
                    repoId: pr.repoId ?? null,
                    prId: pr.id,
                    title: pr.title,
                    url: pr.url,
                    prStatus: pr.status ?? null,
                });
            }
        } catch (e) {
            diag.failed.push(`listAuthoredPRs: ${(e as Error).message}`);
            orgFailed = true;
        }

        // ---- 2. Discovery: configured active PRs, or the org-wide fallback ----
        const fetchedByGroup = new Map<string, { comments: InboxComment[]; error: string | null }>();
        // Threads whose events step 2 already derived (with the correct,
        // possibly backfill-bounded cutoff) this pass. Step 3 below must skip
        // these rather than re-deriving them with the plain org cutoff, or a
        // brand-new watch's backfill window would be silently discarded the
        // instant the "ongoing polling" loop touches the same thread again in
        // the same pass.
        const handledThreadKeys = new Set<string>();
        let discoveryPool: Pr[] = [];
        const scopes = prScopes(cfg, org);
        try {
            if (scopes.length) {
                const perProject = await mapPool(scopes, PROJECT_CONCURRENCY, ({ project, repo }) =>
                    deps.listActivePRs(org, project, repo),
                );
                for (const list of perProject) discoveryPool.push(...list);
            } else {
                discoveryPool = await deps.listAssignedPRs(org);
            }
        } catch (e) {
            diag.failed.push(`discovery listing: ${(e as Error).message}`);
            orgFailed = true;
        }
        // Authored PRs are already fully covered by step 1; only non-authored PRs
        // can produce a NEW "participated" watch.
        const candidates = discoveryPool.filter((pr) => !pr.authoredByMe && pr.project && pr.repoId);

        const discoveryResults = await mapPool(candidates, THREAD_FETCH_CONCURRENCY, async (pr) => {
            try {
                const comments = await deps.getPrThreads(org, pr.project!, pr.repoId!, pr.id);
                return { pr, comments, error: null as string | null };
            } catch (e) {
                return { pr, comments: [] as InboxComment[], error: (e as Error).message };
            }
        });

        for (const { pr, comments, error } of discoveryResults) {
            diag.scannedWatches++;
            const groupKey = prGroupKey(pr.project ?? null, pr.repoId ?? null, String(pr.id));
            if (error) {
                diag.failed.push(`PR #${pr.id} threads: ${error}`);
                orgFailed = true;
                fetchedByGroup.set(groupKey, { comments: [], error });
                continue;
            }
            fetchedByGroup.set(groupKey, { comments, error: null });

            const byThread = new Map<string, InboxComment[]>();
            for (const c of comments) {
                const tid = String(c.threadId);
                if (!byThread.has(tid)) byThread.set(tid, []);
                byThread.get(tid)!.push(c);
            }
            for (const [threadId, threadComments] of byThread) {
                const mine = latestOwnComment(threadComments, meId);
                if (!mine) continue; // the user never commented in this thread
                const { row, created } = upsertInboxWatch({
                    kind: "participated",
                    org,
                    project: pr.project ?? null,
                    repo: pr.repo ?? null,
                    repoId: pr.repoId ?? null,
                    prId: pr.id,
                    threadId,
                    title: pr.title,
                    url: pr.url,
                    prStatus: pr.status ?? null,
                    lastUserCommentId: mine.id,
                    lastUserCommentAt: mine.published,
                });
                if (created) diag.discovered++;
                // A brand-new watch has no prior "last successful poll" of its own,
                // so its only relevant lower bound is the 30-day backfill window --
                // NOT the org's (much more recent) incremental watermark. Using the
                // org cutoff here would silently drop legitimately-missed replies
                // older than the last poll but within the backfill window (the
                // exact shape of the PR #16723874 bug).
                const effectiveCutoff = created ? backfillCutoff : cutoff;
                orgEvents.push(
                    ...participatedThreadEvents(
                        pr,
                        threadId,
                        threadComments,
                        meId,
                        row.last_user_comment_at,
                        effectiveCutoff,
                    ),
                );
                handledThreadKeys.add(`${groupKey}::${threadId}`);
            }
        }

        // ---- 3. Ongoing polling: every durable watch on file for this org ----
        const watches = listInboxWatches(org);
        const grouped = new Map<string, InboxWatchRow[]>();
        for (const w of watches) {
            const key = prGroupKey(w.project, w.repo_id, w.pr_id);
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key)!.push(w);
        }

        const toFetch = [...grouped.entries()].filter(([key]) => !fetchedByGroup.has(key));
        const polled = await mapPool(toFetch, THREAD_FETCH_CONCURRENCY, async ([key, rows]) => {
            const sample = rows[0];
            try {
                const comments = await deps.getPrThreads(org, sample.project!, sample.repo_id!, sample.pr_id);
                return { key, comments, error: null as string | null };
            } catch (e) {
                return { key, comments: [] as InboxComment[], error: (e as Error).message };
            }
        });
        for (const { key, comments, error } of polled) {
            fetchedByGroup.set(key, { comments, error });
        }

        for (const [groupKey, rows] of grouped) {
            const fetched = fetchedByGroup.get(groupKey);
            diag.scannedWatches += rows.length;
            if (fetched?.error && PR_GONE.test(fetched.error)) {
                // The PR or its repo no longer exists (or is no longer visible): nothing
                // left to poll, and keeping it would hold the org's watermark back forever.
                for (const row of rows) deleteInboxWatch(row.watch_key);
                continue;
            }
            if (!fetched || fetched.error) {
                if (fetched?.error) diag.failed.push(`watch fetch (PR #${rows[0].pr_id}): ${fetched.error}`);
                orgFailed = orgFailed || !!fetched?.error;
                continue;
            }
            const comments = fetched.comments;
            for (const row of rows) {
                const prShape = rowToPrShape(row, org);
                if (row.kind === "authored") {
                    if (newestAt(comments) > Date.parse(row.updated_at)) touchInboxWatch(row.watch_key);
                    orgEvents.push(...authoredPrEvents(prShape, comments, meId, cutoff, firstRunOrg));
                    continue;
                }
                // Discovery (step 2) already derived this thread's events this
                // pass, with the correct cutoff (backfill-bounded if the watch
                // was just created) -- redoing it here with the plain org
                // cutoff would silently widen or narrow that window.
                if (handledThreadKeys.has(`${groupKey}::${row.thread_id}`)) continue;
                const threadComments = comments.filter((c) => String(c.threadId) === row.thread_id);
                const mine = latestOwnComment(threadComments, meId);
                let lastAt = row.last_user_comment_at;
                let lastId = row.last_user_comment_id;
                if (mine && (!lastAt || mine.published > lastAt)) {
                    lastAt = mine.published;
                    lastId = String(mine.id);
                }
                if (lastAt !== row.last_user_comment_at) {
                    upsertInboxWatch({
                        kind: "participated",
                        org,
                        project: row.project,
                        repo: row.repo,
                        repoId: row.repo_id,
                        prId: row.pr_id,
                        threadId: row.thread_id!,
                        title: row.title,
                        url: row.url,
                        prStatus: row.pr_status,
                        lastUserCommentId: lastId,
                        lastUserCommentAt: lastAt,
                    });
                } else if (newestAt(threadComments) > Date.parse(row.updated_at)) {
                    touchInboxWatch(row.watch_key);
                }
                orgEvents.push(
                    ...participatedThreadEvents(prShape, row.thread_id!, threadComments, meId, lastAt, cutoff),
                );
            }
        }

        // Insert this org's derived events BEFORE advancing its watermark:
        // if the process dies between the two, the watermark simply doesn't
        // move and the next poll safely re-derives the same (dedup-safe)
        // events, instead of the watermark advancing past events that were
        // never actually persisted.
        const orgUniqueEvents = dedupeById(orgEvents);
        if (orgUniqueEvents.length) inserted += insertNotifications(orgUniqueEvents);

        if (!orgFailed) {
            setMeta(watermarkKey, now);
            diag.watermarkAdvanced = true;
        }
    }

    return { inserted, diagnostics };
}

export interface RecordWatchFromAdoWriteInput {
    org: string;
    project: string;
    repoId: string;
    prId: string | number;
    threadId: string | number;
    commentId: string | number | null | undefined;
    publishedAt?: string | null;
}

/**
 * Called right after a successful ADO write from /api/thread or /api/reply so
 * the watch exists immediately — no discovery-poll delay before later peer
 * replies on THIS thread start producing notifications. Any failure here
 * (store unavailable, PR summary fetch failing, etc.) is logged to stderr and
 * swallowed: the ADO write already succeeded and the caller must not report it
 * as failed just because the local bookkeeping didn't land.
 */
export async function recordWatchFromAdoWrite(
    input: RecordWatchFromAdoWriteInput,
    deps: Pick<InboxAdoDependencies, "getPrSummary"> = defaultDeps,
): Promise<void> {
    try {
        await ensureDb();
        const pr = await deps.getPrSummary(input.org, input.project, input.repoId, input.prId);
        const commentId = input.commentId != null ? String(input.commentId) : null;
        const publishedAt = input.publishedAt || new Date().toISOString();
        if (pr.authoredByMe) {
            upsertInboxWatch({
                kind: "authored",
                org: input.org,
                project: pr.project ?? input.project,
                repo: pr.repo ?? null,
                repoId: pr.repoId ?? input.repoId,
                prId: input.prId,
                title: pr.title,
                url: pr.url,
                prStatus: pr.status ?? null,
            });
        } else {
            upsertInboxWatch({
                kind: "participated",
                org: input.org,
                project: pr.project ?? input.project,
                repo: pr.repo ?? null,
                repoId: pr.repoId ?? input.repoId,
                prId: input.prId,
                threadId: input.threadId,
                title: pr.title,
                url: pr.url,
                prStatus: pr.status ?? null,
                lastUserCommentId: commentId,
                lastUserCommentAt: publishedAt,
            });
        }
    } catch (e) {
        console.error(
            `[inbox] failed to persist watch after posting to PR #${input.prId} (ADO write already succeeded): ${(e as Error).message}`,
        );
    }
}
