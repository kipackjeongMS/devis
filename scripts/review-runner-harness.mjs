import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Drives the desktop review runner with fake Copilot sessions against a
// temporary database: queue -> session -> publish_review tool -> stored review.

const tempDir = await mkdtemp(join(tmpdir(), "ado-pr-ops-review-runner-"));
process.env.ADO_PR_OPS_DB_PATH = join(tempDir, "reviews.db");

const until = async (predicate, label, timeoutMs = 5_000) => {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

const job = (prId, extra = {}) => ({
    runId: `run-${prId}`,
    prId,
    org: "org",
    project: "project",
    repo: "repo",
    repoId: "repo-guid",
    title: `PR ${prId}`,
    taskPrompt: `===REVIEW TASK START===\nreview ${prId}\n===REVIEW TASK END===`,
    ...extra,
});

const donePayload = (prId, overrides = {}) => ({
    prId,
    runId: `run-${prId}`,
    org: "org",
    project: "project",
    repoId: "repo-guid",
    repo: "repo",
    status: "done",
    summary: "Looks good with one nit.",
    story: "Adds a feature.\n\n## What changed\n- one thing",
    semanticFindings: [],
    findings: [
        {
            file: "src/a.ts",
            line: 3,
            side: "right",
            severity: "nit",
            title: "Typo in name",
            comment: "Small typo here.",
            technicalExplanation: "The identifier is misspelled, which hurts searchability.",
        },
    ],
    ...overrides,
});

// Each PR's behavior: a function receiving (prompt, turn, publish) per turn.
const behaviors = new Map();
const sessions = [];
let activeSessions = 0;
let maxActiveSessions = 0;

class FakeSession {
    constructor(prId, tools) {
        this.sessionId = `session-${prId}-${sessions.length}`;
        this.prId = prId;
        this.tools = tools;
        this.prompts = [];
        this.aborted = false;
        this.disconnected = false;
        this.release = null;
        activeSessions++;
        maxActiveSessions = Math.max(maxActiveSessions, activeSessions);
        sessions.push(this);
    }
    publish(args) {
        const tool = this.tools.find((candidate) => candidate.name === "publish_review");
        return tool.handler(args, {
            sessionId: this.sessionId,
            toolCallId: `call-${this.prompts.length}`,
            toolName: "publish_review",
            arguments: args,
        });
    }
    async sendAndWait(options) {
        this.prompts.push(options);
        const behavior = behaviors.get(this.prId) || (async () => undefined);
        return behavior(options, this.prompts.length, this);
    }
    async abort() {
        this.aborted = true;
        this.release?.();
    }
    async disconnect() {
        this.disconnected = true;
        activeSessions--;
    }
}

const createSession = async (row, tools) => {
    if (row.pr_id === "50") throw new Error("model not available");
    return new FakeSession(row.pr_id, tools);
};

let store;
let runner;
try {
    store = await import("../store.mjs");
    runner = await import("../review-runner.mjs");
    await store.ensureDb();

    // An unfinished job from a previous launch is requeued at startup; a task-less one fails.
    store.enqueueReviewJobs([
        {
            ...job(90),
            targetCanvasInstanceId: "old",
            dispatcherSessionId: "old-session",
            dispatcherCanvasInstanceId: "old",
        },
        {
            ...job(91),
            targetCanvasInstanceId: "old",
            dispatcherSessionId: "old-session",
            dispatcherCanvasInstanceId: "old",
        },
    ]);
    assert.equal(
        store.claimQueuedReviewJobs("old-session", "old", "old-batch", 5, "1970-01-01T00:00:00.000Z").length,
        2,
    );
    store.acknowledgeReviewJobs("old-session", "old-batch", [{ runId: "run-90", ok: true, appSessionId: "dead" }]);
    store.claimReviewTask("run-90", { prId: "90", org: "org", project: "project", repoId: "repo-guid" });
    const dbHandle = await store.ensureDb();
    dbHandle.prepare("UPDATE review_jobs SET task_prompt = NULL WHERE run_id = 'run-91'").run();
    behaviors.set("90", async (_options, turn, session) => {
        if (turn === 1) await session.publish(donePayload("90"));
    });

    await runner.startReviewRunner({ createSession, pollMs: 20 });
    await until(() => store.getReviewJob("run-90").status === "done", "orphan requeue");
    assert.equal(store.getReviewJob("run-91").status, "error");
    assert.match(store.getReview({ prId: "91", org: "org", project: "project", repoId: "repo-guid" }).error, /interrupted/);

    // Happy path: the task is sent with a short display prompt and publish stores the review.
    behaviors.set("1", async (_options, turn, session) => {
        if (turn === 1) {
            await assert.rejects(
                () => session.publish(donePayload("2")),
                /does not match this review's PR/,
                "a session cannot publish another PR",
            );
            const result = await session.publish(donePayload("1"));
            assert.match(result, /Published the review for PR #1/);
        }
    });
    const queued = await runner.queueReviewJobs({ jobs: [job(1, { reviewModel: "gpt-5.5" })] });
    assert.equal(queued.accepted.length, 1);
    assert.equal((await runner.queueReviewJobs({ jobs: [job(1)] })).skipped.length, 1, "an active PR is not queued twice");
    await until(() => store.getReviewJob("run-1").status === "done", "happy path");
    const first = sessions.find((session) => session.prId === "1");
    assert.equal(first.prompts.length, 1, "a published review needs no nudge");
    assert.match(first.prompts[0].prompt, /===REVIEW TASK START===/);
    assert.equal(first.prompts[0].displayPrompt, "Review PR #1: PR 1");
    assert.equal(first.aborted, false);
    await until(() => first.disconnected, "disconnect after publish");
    const review = store.getReview({ prId: "1", org: "org", project: "project", repoId: "repo-guid" });
    assert.equal(review.status, "done");
    assert.equal(review.reviewer_session_id, first.sessionId);
    assert.equal(JSON.parse(review.findings_json).length, 1);
    assert.equal(store.getReviewJob("run-1").app_session_id, first.sessionId);
    assert.equal(store.getReviewJob("run-1").review_model, "gpt-5.5");
    await assert.rejects(() => first.publish(donePayload("1")), /no unfinished review/);

    // A reviewer that forgets to publish is nudged once.
    behaviors.set("2", async (options, turn, session) => {
        if (turn === 2) {
            assert.match(options.prompt, /publish_review/);
            await session.publish(donePayload("2"));
        }
    });
    // One that never publishes fails explicitly; a failing turn aborts the session.
    behaviors.set("3", async () => undefined);
    behaviors.set("4", async () => {
        throw new Error("Timeout after 90 minutes");
    });
    await runner.queueReviewJobs({ jobs: [job(2), job(3), job(4), job(50)] });
    await until(
        () => ["run-2", "run-3", "run-4", "run-50"].every((runId) => ["done", "error"].includes(store.getReviewJob(runId).status)),
        "nudge and failure paths",
    );
    assert.equal(store.getReviewJob("run-2").status, "done");
    assert.equal(sessions.find((session) => session.prId === "2").prompts.length, 2);
    assert.equal(store.getReviewJob("run-3").status, "error");
    assert.match(store.getReviewJob("run-3").error, /without publishing/);
    assert.equal(sessions.find((session) => session.prId === "3").prompts.length, 2);
    assert.equal(store.getReviewJob("run-4").status, "error");
    assert.match(store.getReviewJob("run-4").error, /Timeout after 90 minutes/);
    assert.equal(sessions.find((session) => session.prId === "4").aborted, true);
    assert.match(store.getReviewJob("run-50").error, /Could not start the reviewer session: model not available/);
    assert.equal(
        store.getReview({ prId: "50", org: "org", project: "project", repoId: "repo-guid" }).status,
        "error",
    );

    // At most three reviewer sessions run at once.
    maxActiveSessions = activeSessions;
    for (const prId of ["10", "11", "12", "13", "14"]) {
        behaviors.set(prId, (_options, turn, session) =>
            turn === 1
                ? new Promise((resolve) => {
                      session.release = resolve;
                  }).then(() => (session.aborted ? undefined : session.publish(donePayload(prId))))
                : undefined,
        );
    }
    await runner.queueReviewJobs({ jobs: ["10", "11", "12", "13", "14"].map((prId) => job(prId)) });
    await until(() => sessions.filter((session) => Number(session.prId) >= 10 && session.release).length === 3, "three running");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(activeSessions, 3);
    sessions.find((session) => session.prId === "10").release();
    await until(() => sessions.some((session) => session.prId === "13" && session.release), "next review starts");
    assert.equal(maxActiveSessions, 3);

    // Shutdown aborts in-flight reviews without failing them, so the next launch requeues them.
    await runner.stopReviewRunner(1_000);
    assert.equal(store.getReviewJob("run-10").status, "done");
    for (const runId of ["run-11", "run-12", "run-13"]) {
        assert.equal(store.getReviewJob(runId).status, "running", `${runId} stays resumable`);
    }
    assert.equal(store.getReviewJob("run-14").status, "queued");
    assert.ok(sessions.filter((session) => ["11", "12", "13"].includes(session.prId)).every((session) => session.aborted));

    console.log("Review runner harness passed");
} finally {
    await runner?.stopReviewRunner(0);
    store?.closeDb();
    await rm(tempDir, { recursive: true, force: true });
}
