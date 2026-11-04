// The Workspace's Pull Requests panel: the order of My PRs and Reviews, filters and search.
// Imports the compiled web module, so run `tsc -p tsconfig.web.json` first.
import assert from "node:assert/strict";
import {
    REVIEW_PAGE,
    activityLabel,
    attentionKey,
    myPrs,
    namesLine,
    prIdentity,
    reasonText,
    recencyReason,
    reviewPool,
    reviewsList,
    uniquePrs,
} from "../web/prPanelModel.js";

const NOW = Date.parse("2025-06-10T12:00:00Z");
const at = (hoursAgo) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const pr = (id, extra = {}) => ({
    org: "o",
    project: "p",
    repoId: "r",
    repo: "repo",
    id,
    title: `PR ${id}`,
    author: "Someone",
    created: at(100 - id),
    reviewers: [],
    ...extra,
});
const note = (id, prId, hoursAgo, extra = {}) => ({ id, pr_id: prId, org: "o", project: "p", repo_id: "r", unread: 1, kind: "comment", actor: "Dana", created_at: at(hoursAgo), ...extra });

// ---- identity and merging ----
assert.equal(prIdentity(pr(1)), prIdentity({ ...pr(1), id: "1" }), "numeric and string ids are the same PR");
assert.notEqual(prIdentity(pr(1)), prIdentity(pr(1, { repoId: "other" })));
assert.deepEqual(uniquePrs([[pr(1), pr(2)], [pr(2, { title: "copy" }), pr(3)]]).map((p) => [p.id, p.title]), [[1, "PR 1"], [2, "PR 2"], [3, "PR 3"]], "the first copy wins");
assert.equal(namesLine([]), "Someone");
assert.equal(namesLine(["Dana", "Dana"]), "Dana");
assert.equal(namesLine(["Dana", "Lee"]), "Dana and Lee");
assert.equal(namesLine(["Dana", "Lee", "Kim"]), "Dana and 2 others");

// ---- My PRs: new activity leads, then sent back, then published by last push, then drafts ----
const mine = [
    pr(10, { authoredByMe: true }),
    pr(11, { authoredByMe: true, isDraft: true }),
    pr(12, { authoredByMe: true, reviewers: [{ name: "Lee", vote: -10 }] }),
    pr(13, { authoredByMe: true, pushedAt: at(1) }),
    pr(20),
];
const authored = [pr(14, { isDraft: true }), pr(13, { title: "dup" })];
const inbox = [note("n1", 10, 3), note("n2", 10, 2, { actor: "Lee" }), note("n3", 20, 1), note("n4", 13, 1, { unread: 0 })];
const rows = myPrs(mine, authored, inbox);
assert.deepEqual(rows.map((r) => r.pr.id), [10, 12, 13, 14, 11], "activity, then rejected, then published by push, then drafts");
assert.equal(rows.find((r) => r.pr.id === 20), undefined, "other people's PRs never show in My PRs");
assert.equal(rows[0].attention, "activity");
assert.equal(rows[0].label, "2 new comments · Lee and Dana", "newest commenter first");
assert.deepEqual(rows[0].unread.map((n) => n.id), ["n2", "n1"]);
assert.equal(rows[1].label, "Rejected by Lee");
assert.equal(rows[1].tone, "bad");
assert.equal(rows[2].attention, null, "a read notification doesn't ask for you");
assert.equal(activityLabel([note("a", 1, 1, { kind: "reply" })]), "1 new reply · Dana");
const waiting = myPrs([pr(15, { authoredByMe: true, reviewers: [{ name: "Kim", vote: -5 }, { name: "Group", vote: -10, isContainer: true }] })], [], []);
assert.equal(waiting[0].attention, "waiting", "a group's vote doesn't count as a person rejecting");
assert.equal(waiting[0].label, "Waiting on you · Kim");

// A row's attention key changes when new activity lands, so it can flash once.
const before = attentionKey(rows[0]);
const after = attentionKey(myPrs(mine, authored, [...inbox, note("n5", 10, 0.5)])[0]);
assert.notEqual(before, after);
assert.equal(attentionKey(rows[2]), null);

// ---- Reviews: the reason a PR sits where it does ----
assert.equal(recencyReason(pr(1, { created: at(5) }), null, undefined).kind, "opened");
assert.equal(recencyReason(pr(1, { created: at(5), pushedAt: at(6) }), null, undefined).kind, "opened", "a push before the PR opened doesn't count");
assert.equal(recencyReason(pr(1, { created: at(5), pushedAt: at(2) }), null, undefined).kind, "pushed");
assert.equal(recencyReason(pr(1, { created: at(5), pushedAt: at(2), myAt: at(1), myKind: "vote" }), null, undefined).kind, "voted");
assert.equal(recencyReason(pr(1, { created: at(5), myAt: at(2) }), "done", at(1)).kind, "copilot");
assert.equal(recencyReason(pr(1, { created: at(5) }), "active", at(1)).kind, "copilot-active");
assert.equal(recencyReason(pr(1, { created: at(5), pushedAt: at(1) }), "done", at(1)).kind, "copilot", "a review beats the push it followed");
assert.equal(reasonText("copilot", "2h ago"), "Copilot reviewed 2h ago");
assert.equal(reasonText("opened", ""), "Opened");

// ---- Reviews: order, filters and search ----
const pool = [
    pr(30, { created: at(50), mine: true }),
    pr(31, { created: at(40), pushedAt: at(3) }),
    pr(32, { created: at(30), myAt: at(2), myKind: "comment", iCommented: true }),
    pr(33, { created: at(20), isDraft: true }),
    pr(34, { created: at(60), title: "Fix the flaky cache test" }),
    pr(35, { authoredByMe: true }),
    pr(36, { plateDismissed: true }),
    pr(37, { project: "elsewhere" }),
];
const older = [pr(38, { created: at(500) }), pr(31)];
const copilot = { 30: at(1) };
const opts = (extra = {}) => ({
    query: "",
    filters: new Set(),
    phaseOf: (p) => (copilot[p.id] ? "done" : null),
    copilotAt: (p) => copilot[p.id],
    asked: (p) => p.id === 34,
    inScope: (p) => p.project === "p",
    ...extra,
});
assert.deepEqual(reviewPool(pool, older, (p) => p.project === "p").map((p) => p.id), [30, 31, 32, 33, 34, 38], "not yours, not hidden, in scope, older pages once");
assert.deepEqual(reviewsList(pool, older, opts()).map((r) => r.pr.id), [34, 30, 32, 31, 33, 38], "Teams asks lead, then the latest review, comment, push or opening");
assert.equal(reviewsList(pool, older, opts())[1].reason.kind, "copilot");
assert.deepEqual(reviewsList(pool, older, opts({ filters: new Set(["assigned"]) })).map((r) => r.pr.id), [30]);
assert.deepEqual(reviewsList(pool, older, opts({ filters: new Set(["copilot"]) })).map((r) => r.pr.id), [30]);
assert.deepEqual(reviewsList(pool, older, opts({ filters: new Set(["weighed"]) })).map((r) => r.pr.id), [32]);
assert.deepEqual(reviewsList(pool, older, opts({ filters: new Set(["drafts"]) })).map((r) => r.pr.id), [33]);
assert.deepEqual(reviewsList(pool, older, opts({ filters: new Set(["assigned", "drafts"]) })).map((r) => r.pr.id), [], "filters narrow together");
assert.deepEqual(reviewsList(pool, older, opts({ query: "flaky" })).map((r) => r.pr.id), [34], "search matches the title");
assert.deepEqual(reviewsList(pool, older, opts({ query: "nothing-like-this" })), []);
assert.equal(REVIEW_PAGE, 20);

console.log("pr-panel-model-harness: ok");
