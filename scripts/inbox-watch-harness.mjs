// Regression + unit coverage for the durable watched-thread inbox fix.
//
// Root cause under test: v1's scanInbox() only ever looked at
// listAuthoredPRs(org) — a reply to the current user's own comment on a PR
// someone ELSE authored (the reported case: 3 missed replies on non-authored
// PR #16723874) was never discovered at all, and the watermark still
// advanced past it. Bare `comment:<commentId>` notification ids could also
// collide across PRs (ADO comment ids are only unique within one thread).
//
// This harness drives the real scanInbox()/recordWatchFromAdoWrite() (from
// the compiled inbox.mjs) against an in-memory fake ADO layer (dependency
// injection — see InboxAdoDependencies in inbox.mts) and a real, temp SQLite
// store, so every assertion below exercises the actual production code path.
// Every "must notify" assertion in Cases 1, 3, 4 and 5 is FALSE under the
// pre-fix implementation: it only scanned `listAuthoredPRs`, so a fake
// dependency's `getPrThreads` would never even be called for a non-authored
// PR (Cases 1/2/3), and the un-scoped `comment:<id>` id would have thrown
// away one of the two same-numbered-comment notifications as a duplicate
// (Case 5). Comments are left throughout marking exactly which requirement
// each block covers.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = await mkdtemp(join(tmpdir(), "ado-pr-ops-inbox-"));
process.env.ADO_PR_OPS_DB_PATH = join(tempDir, "reviews.db");
const configPath = join(tempDir, "config.json");
process.env.ADO_PR_OPS_CONFIG_PATH = configPath;

async function writeConfigFile(cfg) {
    await writeFile(configPath, JSON.stringify(cfg), "utf8");
}

// ---------------------------------------------------------------------------
// Fake ADO layer -- a mutable in-memory model, keyed exactly the way the real
// client is (org -> project/repoId/prId -> comments), so scanInbox()'s
// bounded-concurrency fetch loops exercise real branching (per-PR success vs.
// failure) without any network access.
// ---------------------------------------------------------------------------
const orgs = new Map();
function org(name) {
    if (!orgs.has(name)) {
        orgs.set(name, {
            me: { id: `me-${name}`, name: "Test User" },
            authoredPrs: [],
            activePool: [],
            threads: new Map(), // groupKey -> { comments, error }
            summaries: new Map(), // groupKey -> { pr, error }
        });
    }
    return orgs.get(name);
}
function groupKey(project, repoId, prId) {
    return `${project}::${repoId}::${prId}`;
}
function makePr({
    orgName,
    id,
    project,
    repoId,
    repo,
    title,
    authoredByMe = false,
    status = "active",
    created,
}) {
    return {
        org: orgName,
        id,
        mine: authoredByMe,
        authoredByMe,
        title: title || `PR ${id}`,
        project,
        repo: repo || project.toLowerCase(),
        repoId,
        author: authoredByMe ? "Test User" : "Peer",
        authorId: authoredByMe ? `me-${orgName}` : "peer-1",
        created: created || new Date(0).toISOString(),
        isDraft: false,
        status,
        reviewers: [],
        myVote: 0,
        iCommented: !authoredByMe,
        sourceRef: "feature",
        targetRef: "main",
        url: `https://dev.azure.com/${orgName}/${project}/_git/${repo || project.toLowerCase()}/pullrequest/${id}`,
    };
}
function c({ id, threadId, mine, content, parentCommentId = 0, published, orgName }) {
    return {
        id,
        threadId,
        authorId: mine ? `me-${orgName}` : "peer-1",
        authorName: mine ? "Test User" : "Peer",
        content,
        parentCommentId,
        published,
        commentType: "text",
    };
}
function setThreads(orgName, project, repoId, prId, comments, error = null) {
    org(orgName).threads.set(groupKey(project, repoId, prId), { comments, error });
}
function setSummary(orgName, project, repoId, prId, pr, error = null) {
    org(orgName).summaries.set(groupKey(project, repoId, prId), { pr, error });
}

const activeCalls = [];
const deps = {
    async getMe(orgName) {
        const rec = org(orgName);
        if (rec.meError) throw new Error(rec.meError);
        return rec.me;
    },
    async listAuthoredPRs(orgName) {
        const rec = org(orgName);
        if (rec.authoredError) throw new Error(rec.authoredError);
        return rec.authoredPrs;
    },
    async listActivePRs(orgName, project, repo) {
        activeCalls.push({ org: orgName, project, repo });
        const rec = org(orgName);
        if (rec.discoveryError) throw new Error(rec.discoveryError);
        return rec.activePool.filter((p) => p.project === project);
    },
    async listAssignedPRs(orgName) {
        const rec = org(orgName);
        if (rec.discoveryError) throw new Error(rec.discoveryError);
        return rec.activePool;
    },
    async getPrThreads(orgName, project, repoId, prId) {
        const rec = org(orgName);
        const key = groupKey(project, repoId, prId);
        const entry = rec.threads.get(key);
        if (!entry) return [];
        if (entry.error) throw new Error(entry.error);
        return entry.comments;
    },
    async getPrSummary(orgName, project, repoId, prId) {
        const rec = org(orgName);
        const key = groupKey(project, repoId, prId);
        const entry = rec.summaries.get(key);
        if (!entry) throw new Error(`no fake summary registered for ${key}`);
        if (entry.error) throw new Error(entry.error);
        return entry.pr;
    },
};

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

let store;
let inbox;
let route;
try {
    await writeConfigFile({
        organizations: ["org-a", "org-b"],
        projects: { "org-a": [], "org-b": ["ProjB"] },
        reviewModel: "",
        reviewsDir: "",
    });

    store = await import("../store.mjs");
    inbox = await import("../inbox.mjs");
    route = await import("../web/inboxRoute.js");
    await store.ensureDb();

    const notifIds = () => store.listNotifications(500).map((n) => n.id);
    const hasCommentId = (needle) =>
        notifIds().some((id) => id.split(":").pop() === String(needle));
    const countForComment = (needle) =>
        notifIds().filter((id) => id.split(":").pop() === String(needle)).length;

    // =========================================================================
    // POLL 1 -- seed: org-a has an authored PR (200, pre-existing old comment
    // that must NOT surface -- firstRun seeds cleanly) and a non-authored,
    // participated PR (100) whose thread already has the exact shape of the
    // real bug: a peer root comment BEFORE the user's own comment (must never
    // notify), the user's own comment, then a peer reply AFTER it (Req #1/#2).
    // org-b (configured project "ProjB") has two participated PRs (400, 500)
    // where the user has commented but no peer reply exists yet.
    // =========================================================================
    org("org-a").authoredPrs = [
        makePr({ orgName: "org-a", id: 200, project: "ProjA2", repoId: "repo-a2-guid", authoredByMe: true }),
    ];
    setThreads("org-a", "ProjA2", "repo-a2-guid", 200, [
        c({ id: 10, threadId: 9001, mine: false, content: "pre-existing root comment", published: iso(-10 * DAY), orgName: "org-a" }),
    ]);
    org("org-a").activePool = [
        makePr({ orgName: "org-a", id: 100, project: "ProjA1", repoId: "repo-a1-guid", authoredByMe: false }),
    ];
    setThreads("org-a", "ProjA1", "repo-a1-guid", 100, [
        c({ id: 41, threadId: 5001, mine: false, content: "root comment before user", published: iso(-3 * MIN), orgName: "org-a" }),
        c({ id: 42, threadId: 5001, mine: true, content: "thanks, LGTM with a nit", parentCommentId: 41, published: iso(-2 * MIN), orgName: "org-a" }),
        c({ id: 99, threadId: 5001, mine: false, content: "actually see my follow up", parentCommentId: 41, published: iso(-1 * MIN), orgName: "org-a" }),
    ]);

    org("org-b").activePool = [
        makePr({ orgName: "org-b", id: 400, project: "ProjB", repoId: "repo-b4-guid", authoredByMe: false }),
        makePr({ orgName: "org-b", id: 500, project: "ProjB", repoId: "repo-b5-guid", authoredByMe: false }),
    ];
    setThreads("org-b", "ProjB", "repo-b4-guid", 400, [
        c({ id: 50, threadId: 7001, mine: true, content: "my own root comment", published: iso(-4 * MIN), orgName: "org-b" }),
    ]);
    setThreads("org-b", "ProjB", "repo-b5-guid", 500, [
        c({ id: 55, threadId: 7501, mine: true, content: "root comment on PR500", published: iso(-4 * MIN), orgName: "org-b" }),
    ]);

    const poll1 = await inbox.scanInbox(deps);
    // Req #1: later peer reply on a NON-authored PR the user merely commented
    // on must notify -- this is the exact bug (PR #16723874) that v1 missed
    // entirely because it never called getPrThreads for a non-authored PR.
    assert.equal(hasCommentId(99), true, "peer reply after user participation must notify");
    assert.equal(countForComment(99), 1);
    // Req #2: the peer root comment BEFORE the user's own comment must not.
    assert.equal(hasCommentId(41), false, "comment before user participation must not notify");
    assert.equal(hasCommentId(42), false, "the user's own comment is never a notification");
    // firstRun seeding: the pre-existing comment on the authored PR must not
    // flood the inbox the moment the PR is first discovered.
    assert.equal(hasCommentId(10), false, "authored-PR firstRun must seed cleanly, not backfill");
    // No peer replies yet on org-b's PRs.
    assert.equal(hasCommentId(50), false);
    assert.equal(hasCommentId(55), false);
    assert.equal(store.listNotifications(500).length, 1);

    const watchesAfterPoll1 = store.listInboxWatches();
    assert.equal(watchesAfterPoll1.some((w) => w.kind === "authored" && w.org === "org-a" && w.pr_id === "200"), true);
    assert.equal(
        watchesAfterPoll1.some((w) => w.kind === "participated" && w.org === "org-a" && w.pr_id === "100" && w.thread_id === "5001"),
        true,
    );
    assert.equal(
        watchesAfterPoll1.some((w) => w.kind === "participated" && w.org === "org-b" && w.pr_id === "400" && w.thread_id === "7001"),
        true,
    );
    assert.equal(
        watchesAfterPoll1.some((w) => w.kind === "participated" && w.org === "org-b" && w.pr_id === "500" && w.thread_id === "7501"),
        true,
    );

    const wmA1 = store.getMeta("inbox_last_poll:org-a");
    const wmB1 = store.getMeta("inbox_last_poll:org-b");
    assert.ok(wmA1);
    assert.ok(wmB1);
    const diagA1 = poll1.diagnostics.find((d) => d.org === "org-a");
    const diagB1 = poll1.diagnostics.find((d) => d.org === "org-b");
    assert.equal(diagA1.watermarkAdvanced, true);
    assert.equal(diagB1.watermarkAdvanced, true);
    console.log("Case 1/2 (participated-thread reply notifies, pre-participation comment does not) passed");

    // =========================================================================
    // POLL 2 -- Req #4: a peer ROOT comment (not a reply) on an AUTHORED PR
    // must notify too (authored watches were never "replies only"). Req #3:
    // PR400 completes and is dropped from the "active" listing entirely, yet
    // its durable watch must still be polled for a later reply. Req #5: that
    // later reply on PR400 reuses the exact same raw comment id (99) as
    // PR100's poll-1 reply -- both must be persisted as DISTINCT
    // notifications (the bare `comment:<id>` scheme this replaces would have
    // silently dropped one of the two as a false "duplicate").
    // =========================================================================
    setThreads("org-a", "ProjA2", "repo-a2-guid", 200, [
        c({ id: 10, threadId: 9001, mine: false, content: "pre-existing root comment", published: iso(-10 * DAY), orgName: "org-a" }),
        c({ id: 11, threadId: 9001, mine: false, content: "new root comment from a peer", published: iso(0), orgName: "org-a" }),
    ]);
    // PR400 completes and disappears from "active" -- discovery no longer
    // returns it, but the watch persisted in poll 1 must still be polled.
    org("org-b").activePool = [
        makePr({ orgName: "org-b", id: 500, project: "ProjB", repoId: "repo-b5-guid", authoredByMe: false }),
    ];
    setThreads("org-b", "ProjB", "repo-b4-guid", 400, [
        c({ id: 50, threadId: 7001, mine: true, content: "my own root comment", published: iso(-4 * MIN - 60 * MIN), orgName: "org-b" }),
        c({ id: 99, threadId: 7001, mine: false, content: "collides in raw id with PR100's comment 99", parentCommentId: 50, published: iso(0), orgName: "org-b" }),
    ]);

    const poll2 = await inbox.scanInbox(deps);
    assert.equal(hasCommentId(11), true, "authored-PR peer ROOT comment (not a reply) must notify");
    assert.equal(hasCommentId(99), true, "PR400's reply (completed PR, durable watch) must notify");
    assert.equal(countForComment(99), 2, "same raw comment id on two different PRs must stay distinct");
    const ninetyNineIds = notifIds().filter((id) => id.split(":").pop() === "99");
    assert.notEqual(ninetyNineIds[0], ninetyNineIds[1]);
    assert.equal(ninetyNineIds.some((id) => id.includes(":100:")), true);
    assert.equal(ninetyNineIds.some((id) => id.includes(":400:")), true);
    assert.equal(store.listNotifications(500).length, 3);
    assert.equal(poll2.inserted, 2);
    console.log("Case 3/4/5 (completed-PR polling, authored root comment, scoped id distinctness) passed");

    // =========================================================================
    // POLL 3 -- Req #6: re-polling identical state is idempotent.
    // =========================================================================
    const poll3 = await inbox.scanInbox(deps);
    assert.equal(poll3.inserted, 0, "duplicate polling must not re-insert existing events");
    assert.equal(store.listNotifications(500).length, 3);
    console.log("Case 6 (duplicate polling is idempotent) passed");

    // =========================================================================
    // POLL 4 -- Req #7 (part 1): a new PR700 discovery candidate whose thread
    // fetch fails outright must (a) not advance org-b's watermark, while
    // (b) PR500's independent, successful reply in the SAME poll still
    // persists (a partial per-org failure never blocks unrelated successes).
    // =========================================================================
    const wmB3 = store.getMeta("inbox_last_poll:org-b");
    org("org-b").activePool = [
        makePr({ orgName: "org-b", id: 500, project: "ProjB", repoId: "repo-b5-guid", authoredByMe: false }),
        makePr({ orgName: "org-b", id: 700, project: "ProjB", repoId: "repo-b7-guid", authoredByMe: false }),
    ];
    setThreads("org-b", "ProjB", "repo-b5-guid", 500, [
        c({ id: 55, threadId: 7501, mine: true, content: "root comment on PR500", published: iso(-4 * MIN - 60 * MIN), orgName: "org-b" }),
        c({ id: 56, threadId: 7501, mine: false, content: "peer reply on PR500", parentCommentId: 55, published: iso(0), orgName: "org-b" }),
    ]);
    setThreads("org-b", "ProjB", "repo-b7-guid", 700, [], "simulated ADO outage fetching PR700 threads");

    const poll4 = await inbox.scanInbox(deps);
    assert.equal(hasCommentId(56), true, "PR500's reply must persist despite PR700 failing in the same org/poll");
    const diagB4 = poll4.diagnostics.find((d) => d.org === "org-b");
    assert.equal(diagB4.watermarkAdvanced, false, "a failed required fetch must block the org's watermark advance");
    assert.equal(diagB4.failed.length > 0, true);
    assert.equal(store.getMeta("inbox_last_poll:org-b"), wmB3, "watermark must stay pinned at the last successful poll");
    const diagA4 = poll4.diagnostics.find((d) => d.org === "org-a");
    assert.equal(diagA4.watermarkAdvanced, true, "an unaffected org's watermark must still advance");
    console.log("Case 7a (one failing fetch blocks only its own org's watermark; other events persist) passed");

    // =========================================================================
    // POLL 5 -- Req #7 (part 2): once PR700's fetch recovers, its events
    // (discovered fresh, so bounded by the backfill window) surface and the
    // org watermark resumes advancing. A repeat poll of the same state stays
    // idempotent, proving replay safety across a failure/recovery cycle.
    // =========================================================================
    setThreads("org-b", "ProjB", "repo-b7-guid", 700, [
        c({ id: 80, threadId: 8001, mine: true, content: "my root comment on PR700", published: iso(-2 * MIN), orgName: "org-b" }),
        c({ id: 81, threadId: 8001, mine: false, content: "peer reply on PR700", parentCommentId: 80, published: iso(0), orgName: "org-b" }),
    ]);
    const poll5 = await inbox.scanInbox(deps);
    assert.equal(hasCommentId(81), true, "PR700's reply must surface once its fetch recovers");
    const diagB5 = poll5.diagnostics.find((d) => d.org === "org-b");
    assert.equal(diagB5.watermarkAdvanced, true, "watermark resumes advancing once the outage clears");

    const poll5b = await inbox.scanInbox(deps);
    assert.equal(poll5b.inserted, 0, "replaying after a recovered failure must stay idempotent");
    console.log("Case 7b (recovery + idempotent replay after a transient failure) passed");

    // =========================================================================
    // Req #8: 30-day backfill boundary. A brand-new org (never polled before)
    // discovers a thread where the user's own comment is 60 days old; a peer
    // reply 40 days old (older than the 30-day backfill window) must NOT
    // notify, but one 10 days old (inside the window) must.
    // =========================================================================
    await writeConfigFile({
        organizations: ["org-a", "org-b", "org-d"],
        projects: { "org-a": [], "org-b": ["ProjB"], "org-d": [] },
        reviewModel: "",
        reviewsDir: "",
    });
    org("org-d").activePool = [
        makePr({ orgName: "org-d", id: 800, project: "ProjD", repoId: "repo-d8-guid", authoredByMe: false }),
    ];
    setThreads("org-d", "ProjD", "repo-d8-guid", 800, [
        c({ id: 60, threadId: 8801, mine: true, content: "old root comment", published: iso(-60 * DAY), orgName: "org-d" }),
        c({ id: 61, threadId: 8801, mine: false, content: "too-old peer reply", parentCommentId: 60, published: iso(-40 * DAY), orgName: "org-d" }),
        c({ id: 62, threadId: 8801, mine: false, content: "recent peer reply", parentCommentId: 60, published: iso(-10 * DAY), orgName: "org-d" }),
    ]);
    const pollBackfill = await inbox.scanInbox(deps);
    assert.equal(hasCommentId(62), true, "a reply inside the 30-day backfill window must notify");
    assert.equal(hasCommentId(61), false, "a reply older than the 30-day backfill window must not notify");
    void pollBackfill;
    console.log("Case 8 (30-day backfill boundary) passed");

    // =========================================================================
    // Req #9 (post-write immediate watch recording): recordWatchFromAdoWrite()
    // must persist a watch straight from the ADO response -- no discovery
    // delay -- for BOTH authored and participated PRs, and must never throw
    // even when the extra getPrSummary lookup itself fails (the ADO write
    // already succeeded and must not be reported as failed).
    // =========================================================================
    setSummary(
        "org-a",
        "ProjA9",
        "repo-a9-guid",
        900,
        makePr({ orgName: "org-a", id: 900, project: "ProjA9", repoId: "repo-a9-guid", authoredByMe: false }),
    );
    await inbox.recordWatchFromAdoWrite(
        { org: "org-a", project: "ProjA9", repoId: "repo-a9-guid", prId: 900, threadId: 9101, commentId: 70, publishedAt: iso(-1 * MIN) },
        { getPrSummary: deps.getPrSummary },
    );
    const watchParticipated = store
        .listInboxWatches("org-a")
        .find((w) => w.kind === "participated" && w.pr_id === "900" && w.thread_id === "9101");
    assert.ok(watchParticipated, "a participated watch must be recorded immediately after a successful reply/thread write");
    assert.equal(watchParticipated.last_user_comment_id, "70");

    setSummary(
        "org-a",
        "ProjA9",
        "repo-a9-guid",
        901,
        makePr({ orgName: "org-a", id: 901, project: "ProjA9", repoId: "repo-a9-guid", authoredByMe: true }),
    );
    await inbox.recordWatchFromAdoWrite(
        { org: "org-a", project: "ProjA9", repoId: "repo-a9-guid", prId: 901, threadId: 9102, commentId: 71, publishedAt: iso(0) },
        { getPrSummary: deps.getPrSummary },
    );
    const watchAuthored = store.listInboxWatches("org-a").find((w) => w.kind === "authored" && w.pr_id === "901");
    assert.ok(watchAuthored, "an authored watch must be recorded immediately after a successful reply/thread write");

    // getPrSummary failing must be swallowed, not thrown, and must not fake a watch.
    const countBefore = store.listInboxWatches("org-a").length;
    await assert.doesNotReject(() =>
        inbox.recordWatchFromAdoWrite(
            { org: "org-a", project: "ProjA9", repoId: "repo-a9-guid", prId: 902, threadId: 9103, commentId: 72 },
            { getPrSummary: async () => { throw new Error("simulated ADO summary outage"); } },
        ),
    );
    assert.equal(store.listInboxWatches("org-a").length, countBefore, "a failed watch-recording must not throw nor fabricate a row");
    console.log("Case 9a (write-time watch recording, incl. swallowed failure) passed");

    // Prove there is no discovery delay: PR900 was NEVER in any authored/active
    // pool -- it is only known to the poller via the watch just recorded
    // above. A later peer reply on it must still surface on the very next
    // poll.
    setThreads("org-a", "ProjA9", "repo-a9-guid", 900, [
        c({ id: 70, threadId: 9101, mine: true, content: "my new thread", published: iso(-1 * MIN), orgName: "org-a" }),
        c({ id: 73, threadId: 9101, mine: false, content: "peer reply, no discovery needed", parentCommentId: 70, published: iso(0), orgName: "org-a" }),
    ]);
    await inbox.scanInbox(deps);
    assert.equal(hasCommentId(73), true, "a watch recorded at write-time must be polled without any discovery delay");
    console.log("Case 9b (no discovery delay for a write-time-recorded watch) passed");

    // =========================================================================
    // Case 10 -- watch upkeep. A watch outside discovery stays while its thread
    // is active, goes once it has been quiet for 30 days of polling, and a PR
    // that no longer exists is dropped instead of failing the org forever.
    // =========================================================================
    const db = await store.ensureDb();
    const watch900 = () => store.listInboxWatches("org-a").find((w) => w.pr_id === "900" && w.thread_id === "9101");
    db.prepare("UPDATE inbox_watches SET updated_at = ? WHERE org = 'org-a' AND pr_id = '900'").run(iso(-40 * DAY));
    setThreads("org-a", "ProjA9", "repo-a9-guid", 900, [
        c({ id: 70, threadId: 9101, mine: true, content: "my new thread", published: iso(-2 * MIN), orgName: "org-a" }),
        c({ id: 74, threadId: 9101, mine: false, content: "still talking", parentCommentId: 70, published: iso(0), orgName: "org-a" }),
    ]);
    await inbox.scanInbox(deps);
    assert.ok(watch900().updated_at > iso(-1 * MIN), "a peer reply keeps a watch outside discovery alive");
    inbox.pruneStaleInboxWatches(30 * DAY);
    assert.ok(watch900(), "an active watch is never pruned");

    db.prepare("UPDATE inbox_watches SET updated_at = ? WHERE org = 'org-a' AND pr_id = '900'").run(iso(-40 * DAY));
    setThreads("org-a", "ProjA9", "repo-a9-guid", 900, [
        c({ id: 70, threadId: 9101, mine: true, content: "my new thread", published: iso(-60 * DAY), orgName: "org-a" }),
        c({ id: 75, threadId: 9101, mine: false, content: "long ago", parentCommentId: 70, published: iso(-50 * DAY), orgName: "org-a" }),
    ]);
    const quietPoll = await inbox.scanInbox(deps);
    assert.ok(watch900().updated_at < iso(-39 * DAY), "a quiet thread isn't touched");
    assert.equal(quietPoll.diagnostics.find((d) => d.org === "org-a").watermarkAdvanced, true);
    assert.ok(inbox.pruneStaleInboxWatches(30 * DAY) >= 1);
    assert.equal(watch900(), undefined, "quiet for 30 days of polling: no longer watched");

    assert.ok(store.listInboxWatches("org-a").some((w) => w.pr_id === "901"));
    setThreads("org-a", "ProjA9", "repo-a9-guid", 901, [], "ADO GET 404: TF401019: The Git repository does not exist");
    const gonePoll = await inbox.scanInbox(deps);
    assert.equal(store.listInboxWatches("org-a").some((w) => w.pr_id === "901"), false, "a PR that no longer exists is dropped");
    assert.equal(gonePoll.diagnostics.find((d) => d.org === "org-a").watermarkAdvanced, true, "and doesn't hold the org's watermark back");
    console.log("Case 10 (watch upkeep: touch, quiet prune, gone PRs) passed");

    // =========================================================================
    // CASE 11 -- a busy project narrowed to picked repos: discovery lists each
    // picked repo, not the whole project; a project without picks stays whole.
    // =========================================================================
    await writeConfigFile({
        organizations: ["org-a", "org-b"],
        projects: { "org-a": [], "org-b": ["ProjB", "ProjC"] },
        repos: { "org-b": { ProjB: ["repo-one", "repo-two"] } },
        reviewModel: "",
        reviewsDir: "",
    });
    activeCalls.length = 0;
    await inbox.scanInbox(deps);
    assert.deepEqual(
        activeCalls.filter((call) => call.org === "org-b").map(({ project, repo }) => `${project}/${repo ?? "*"}`).sort(),
        ["ProjB/repo-one", "ProjB/repo-two", "ProjC/*"],
    );
    console.log("Case 11 (repo-scoped discovery) passed");

    // =========================================================================
    // Scoped UI route helper: matchNotificationPr must scope by org/project/
    // repoId, not merely the bare PR id (the actual bug: two orgs/projects
    // can share the same numeric PR id).
    // =========================================================================
    const prList = [
        { id: 100, org: "org-a", project: "ProjA1", repoId: "repo-a1-guid", title: "A" },
        { id: 100, org: "org-x", project: "ProjX", repoId: "repo-x-guid", title: "B" },
    ];
    const scopedMatch = route.matchNotificationPr(prList, {
        pr_id: "100",
        org: "org-a",
        project: "ProjA1",
        repo_id: "repo-a1-guid",
    });
    assert.equal(scopedMatch?.title, "A", "must match the PR scoped by org/project/repoId, not the first bare-id hit");
    const mismatchedProject = route.matchNotificationPr(prList, {
        pr_id: "100",
        org: "org-a",
        project: "SomeOtherProject",
        repo_id: "repo-a1-guid",
    });
    assert.equal(mismatchedProject, undefined, "a bare id match under the wrong project must not resolve (old-behavior regression)");
    const legacyRowFallsBackToBareId = route.matchNotificationPr([prList[0]], {
        pr_id: "100",
        org: null,
        project: null,
        repo_id: null,
    });
    assert.equal(legacyRowFallsBackToBareId?.title, "A", "a legacy notification row without scope fields still matches by bare id");
    console.log("Scoped UI route helper (matchNotificationPr) passed");

    console.log("Inbox watch harness passed");
} finally {
    store?.closeDb();
    await rm(tempDir, { recursive: true, force: true });
}
