import assert from "node:assert/strict";
import {
  FEED_LANES,
  feedLane,
  feedSummary,
  laneNote,
  matchesQuery,
  needsAuthorAction,
  parseQuery,
  plural,
  sortLane,
} from "../web/queueModel.js";

const DAY = 86_400_000;
const NOW = Date.parse("2025-06-10T12:00:00Z");
const ago = (days) => new Date(NOW - days * DAY).toISOString();

let nextId = 100;
const pr = (over = {}) => ({
  id: nextId++,
  title: "Add feature",
  author: "Dana Lee",
  repo: "AppConfig-Service",
  project: "Azure AppConfig",
  org: "msazure",
  sourceRef: "users/dana/feature",
  targetRef: "main",
  created: ago(1),
  isDraft: false,
  mine: false,
  authoredByMe: false,
  myVote: 0,
  iCommented: false,
  reviewers: [],
  ...over,
});
const none = () => ({ phase: null });

// ---- lanes ------------------------------------------------------------------
assert.deepEqual(
  FEED_LANES.map((l) => l.id),
  ["review", "copilot", "weighed", "yours"],
  "the most actionable lane leads"
);
assert.equal(feedLane(pr({ authoredByMe: true, mine: true, myVote: 10 }), "done"), "yours", "authored wins over everything");
assert.equal(feedLane(pr({ mine: true, myVote: 10 }), null), "weighed", "a vote moves an assigned PR out of Needs your review");
assert.equal(feedLane(pr({ mine: true, iCommented: true }), null), "weighed");
assert.equal(feedLane(pr({ myVote: -5 }), "done"), "weighed", "weighing in outranks a Copilot review");
assert.equal(feedLane(pr({ mine: true }), "done"), "review", "assigned outranks a Copilot review");
assert.equal(feedLane(pr(), "active"), "copilot");
assert.equal(feedLane(pr(), "error"), "copilot");
assert.equal(feedLane(pr(), null), null, "unrelated PRs stay out of My feed");

// ---- author action ----------------------------------------------------------
assert.equal(needsAuthorAction(undefined), false);
assert.equal(needsAuthorAction([{ vote: -5, isContainer: true }]), false, "group votes do not count");
assert.equal(needsAuthorAction([{ vote: 5, isContainer: false }, { vote: -5, isContainer: false }]), true);
assert.equal(needsAuthorAction([{ vote: -10, isContainer: false }]), true);
assert.equal(needsAuthorAction([{ vote: 0, isContainer: false }]), false);

// ---- sorting ----------------------------------------------------------------
{
  const oldPub = pr({ created: ago(5) });
  const newDraft = pr({ created: ago(0), isDraft: true });
  const newPub = pr({ created: ago(1) });
  assert.deepEqual(sortLane("review", [oldPub, newDraft, newPub], none), [newPub, oldPub, newDraft], "drafts last, newest first");

  const waiting = pr({ created: ago(9), reviewers: [{ vote: -5, isContainer: false }] });
  const draftWaiting = pr({ created: ago(0), isDraft: true, reviewers: [{ vote: -10, isContainer: false }] });
  const fresh = pr({ created: ago(0) });
  assert.deepEqual(
    sortLane("yours", [fresh, draftWaiting, waiting], none),
    [waiting, draftWaiting, fresh],
    "your lane floats PRs waiting on you, even drafts"
  );

  const done = pr({ created: ago(0) });
  const doneLater = pr({ created: ago(3) });
  const active = pr({ created: ago(9) });
  const phases = new Map([
    [done, { phase: "done", updatedAt: ago(2) }],
    [doneLater, { phase: "done", updatedAt: ago(1) }],
    [active, { phase: "active" }],
  ]);
  assert.deepEqual(
    sortLane("copilot", [done, doneLater, active], (p) => phases.get(p)),
    [active, doneLater, done],
    "reviews in progress lead, then the most recently finished"
  );

  const twinA = pr({ created: ago(2) });
  const twinB = pr({ created: ago(2) });
  assert.deepEqual(sortLane("weighed", [twinA, twinB], none), [twinA, twinB], "ties keep input order");
  assert.deepEqual(sortLane("weighed", [twinB, twinA], none), [twinB, twinA]);
}

// ---- lane notes -------------------------------------------------------------
assert.equal(laneNote("review", [pr({ created: ago(12.5) }), pr({ created: ago(1) })], none, NOW), "oldest 12d");
assert.equal(laneNote("review", [pr({ created: ago(0.2) })], none, NOW), "", "under a day is not worth a note");
assert.equal(laneNote("review", [], none, NOW), "");
{
  const a = pr();
  const b = pr();
  const c = pr();
  const map = new Map([[a, { phase: "active" }], [b, { phase: "error" }], [c, { phase: "done" }]]);
  assert.equal(laneNote("copilot", [a, b, c], (p) => map.get(p), NOW), "1 in progress · 1 failed");
  assert.equal(laneNote("copilot", [c], (p) => map.get(p), NOW), "");
}
assert.equal(
  laneNote("yours", [pr({ reviewers: [{ vote: -5, isContainer: false }] }), pr()], none, NOW),
  "1 waiting on you"
);
assert.equal(laneNote("weighed", [pr()], none, NOW), "");

// ---- copy -------------------------------------------------------------------
assert.equal(plural(1, "draft"), "1 draft");
assert.equal(plural(3, "draft"), "3 drafts");
assert.equal(plural(0, "repository", "repositories"), "0 repositories");
assert.equal(feedSummary({ review: 31, copilot: 2, yours: 35 }), "31 need your review · 2 from Copilot", "first two non-empty lanes");
assert.equal(feedSummary({ review: 1 }), "1 needs your review");
assert.equal(feedSummary({ weighed: 4, yours: 1 }), "4 you've weighed in on · 1 of yours");
assert.equal(feedSummary({ review: 0 }), "Nothing in your feed");
assert.equal(feedSummary({}), "Nothing in your feed");

// ---- search -----------------------------------------------------------------
assert.deepEqual(parseQuery("  Fix   -is:Draft repo:Core #123 - # "), [
  { neg: false, key: "text", value: "fix" },
  { neg: true, key: "is", value: "draft" },
  { neg: false, key: "repo", value: "core" },
  { neg: false, key: "text", value: "123" },
  { neg: false, key: "text", value: "-" },
  { neg: false, key: "text", value: "#" },
]);
assert.deepEqual(parseQuery(""), []);

const sample = pr({
  id: 4242,
  title: "Throttle snapshot export",
  author: "Kim Park",
  repo: "AppConfig-Core",
  sourceRef: "users/kim/throttle",
  targetRef: "release/2025",
  isDraft: true,
  mine: true,
});
const hit = (q, phase = null) => matchesQuery(sample, parseQuery(q), phase);
assert.equal(hit(""), true, "an empty query matches everything");
assert.equal(hit("throttle"), true);
assert.equal(hit("SNAPSHOT export"), true, "terms are ANDed and case-insensitive");
assert.equal(hit("snapshot import"), false);
assert.equal(hit("#4242"), true);
assert.equal(hit("4242"), true);
assert.equal(hit("kim"), true, "free text covers author and branches");
assert.equal(hit("release/2025"), true);
assert.equal(hit("azure appconfig"), true, "free text covers project");
assert.equal(hit("is:draft"), true);
assert.equal(hit("-is:draft"), false);
assert.equal(hit("is:published"), false);
assert.equal(hit("is:assigned"), true);
assert.equal(hit("is:yours"), false);
assert.equal(hit("is:mine"), false);
assert.equal(hit("is:reviewed"), false);
assert.equal(hit("is:reviewed", "done"), true);
assert.equal(hit("is:reviewed", "active"), false, "only finished reviews count");
assert.equal(hit("is:nonsense"), false, "an unknown is: matches nothing");
assert.equal(hit("-is:nonsense"), true);
assert.equal(hit("repo:core"), true);
assert.equal(hit("repo:service"), false);
assert.equal(hit("author:park"), true);
assert.equal(hit("author:dana"), false);
assert.equal(hit("branch:release"), true);
assert.equal(hit("branch:hotfix"), false);
assert.equal(hit("-repo:core"), false);
assert.equal(hit("-"), true, "a lone dash is literal text (AppConfig-Core), not an empty negation");
assert.equal(hit("-throttle"), false);
assert.equal(matchesQuery(pr({ authoredByMe: true, mine: true }), parseQuery("is:assigned"), null), false, "your own PRs are not assigned to you");
assert.equal(matchesQuery(pr({ authoredByMe: true }), parseQuery("is:yours"), null), true);

console.log("Queue model harness passed");
