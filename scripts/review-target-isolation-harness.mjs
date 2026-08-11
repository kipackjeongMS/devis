import assert from "node:assert/strict";

// Deterministic, DB-free harness proving that queueReviewTargets isolates
// malformed targets from valid ones within a single <=50-target batch:
//   - a malformed prId ("not-a-number")
//   - an oversized org (>300 chars, well beyond the requiredString limit)
// must each land in failed[] with a recovered-but-safe scoped identity and a
// concise validation error, while every syntactically valid target in the
// same batch still flows through prepareReview -> queueReviewJobs and ends
// up in accepted[].

const tasks = await import("../review-task.mjs");

const fakePrepare = async (target, reviewModel) => ({
    target,
    job: {
        prId: target.prId,
        runId: `run-${target.prId}`,
        org: target.org,
        project: target.project,
        repo: target.repoId,
        repoId: target.repoId,
        title: `PR ${target.prId}`,
        taskPrompt: `prompt for ${target.prId}`,
        targetCanvasInstanceId: `canvas-${target.prId}`,
        reviewModel,
    },
});

const fakeQueue = async ({ jobs }) => ({
    accepted: jobs.map((job) => ({
        prId: job.prId,
        org: job.org,
        project: job.project,
        repo: job.repo,
        repoId: job.repoId,
        runId: job.runId,
        status: "queued",
    })),
    skipped: [],
});

// --- Scenario 1: mixed valid + malformed targets in one batch ---
const oversizedOrg = "o".repeat(400);
const mixedResult = await tasks.queueReviewTargets(
    {
        canvasInstanceId: "root-canvas",
        targets: [
            { org: "contoso", project: "proj", repoId: "repo-1", prId: "1" },
            // malformed: prId is not a positive integer string/number
            { org: "contoso", project: "proj", repoId: "repo-2", prId: "not-a-number" },
            { org: "contoso", project: "proj", repoId: "repo-3", prId: 3 },
            // malformed: org exceeds the 300 char requiredString limit
            { org: oversizedOrg, project: "proj", repoId: "repo-4", prId: "4" },
            { org: "contoso", project: "proj", repoId: "repo-5", prId: "5" },
        ],
    },
    { prepareReview: fakePrepare, queueReviewJobs: fakeQueue },
);

assert.equal(mixedResult.accepted.length, 3, "all 3 valid targets should be queued");
assert.deepEqual(
    mixedResult.accepted.map((job) => job.prId).sort(),
    ["1", "3", "5"],
);
assert.equal(mixedResult.failed.length, 2, "both malformed targets should be isolated as failed");

const prIdFailure = mixedResult.failed.find((entry) => entry.repoId === "repo-2");
assert.ok(prIdFailure, "malformed prId target must be present in failed[]");
assert.equal(prIdFailure.org, "contoso");
assert.equal(prIdFailure.project, "proj");
assert.equal(prIdFailure.repoId, "repo-2");
assert.equal(prIdFailure.prId, "(unknown)");
assert.match(prIdFailure.error, /prId must be a positive integer/);

const orgFailure = mixedResult.failed.find((entry) => entry.repoId === "repo-4");
assert.ok(orgFailure, "oversized org target must be present in failed[]");
assert.equal(orgFailure.org, "(unknown)", "oversized org must never bypass the length constraint");
assert.equal(orgFailure.project, "proj");
assert.equal(orgFailure.repoId, "repo-4");
assert.equal(orgFailure.prId, "4");
assert.match(orgFailure.error, /org is too long/);

// The oversized raw org value must never leak verbatim into a failed[] entry.
assert.equal(JSON.stringify(mixedResult.failed).includes(oversizedOrg), false);

// --- Scenario 2: every target malformed must not throw, just report failed ---
const allMalformed = await tasks.queueReviewTargets(
    {
        canvasInstanceId: "root-canvas",
        targets: [
            { org: "contoso", project: "proj", repoId: "repo-1", prId: "abc" },
            { org: "contoso", project: "proj", repoId: "repo-2", prId: -1 },
        ],
    },
    { prepareReview: fakePrepare, queueReviewJobs: fakeQueue },
);
assert.deepEqual(allMalformed, { accepted: [], skipped: [], failed: allMalformed.failed });
assert.equal(allMalformed.failed.length, 2);
assert.equal(allMalformed.accepted.length, 0);

// --- Scenario 3: a single malformed target among valid ones must not affect
// preparation-phase or queueing-phase failures for the remaining targets ---
const prepFailureResult = await tasks.queueReviewTargets(
    {
        canvasInstanceId: "root-canvas",
        targets: [
            { org: "contoso", project: "proj", repoId: "repo-1", prId: "1" },
            { org: "contoso", project: "proj", repoId: "repo-2", prId: "bad" },
            { org: "contoso", project: "proj", repoId: "repo-3", prId: "3" },
        ],
    },
    {
        prepareReview: async (target, reviewModel) => {
            if (target.prId === "3") throw new Error("upstream ADO lookup failed");
            return fakePrepare(target, reviewModel);
        },
        queueReviewJobs: fakeQueue,
    },
);
assert.equal(prepFailureResult.accepted.length, 1);
assert.equal(prepFailureResult.accepted[0].prId, "1");
assert.equal(prepFailureResult.failed.length, 2);
const parseFailure = prepFailureResult.failed.find((entry) => entry.repoId === "repo-2");
assert.match(parseFailure.error, /prId must be a positive integer/);
const upstreamFailure = prepFailureResult.failed.find((entry) => entry.repoId === "repo-3");
assert.match(upstreamFailure.error, /upstream ADO lookup failed/);

// --- Scenario 4: parseReviewTarget itself still throws on a single malformed
// value when used directly (unit-level contract used by other callers,
// e.g. Teams single-target retries) ---
assert.throws(
    () => tasks.parseReviewTarget({ org: "o", project: "p", repoId: "r", prId: "nope" }),
    /prId must be a positive integer/,
);

console.log("Review target isolation harness passed");
