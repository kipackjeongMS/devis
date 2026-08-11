import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = await mkdtemp(join(tmpdir(), "ado-pr-ops-dispatcher-"));
process.env.ADO_PR_OPS_DB_PATH = join(tempDir, "reviews.db");

let store;
try {
    store = await import("../store.mjs");
    await store.ensureDb();
    const jobs = Array.from({ length: 4 }, (_, index) => ({
        runId: `run-${index + 1}`,
        prId: index + 1,
        org: "org",
        project: "project",
        repo: "repo",
        repoId: "repo-guid",
        title: `PR ${index + 1}`,
        taskPrompt: `prompt-${index + 1}`,
        targetCanvasInstanceId: `canvas-${index + 1}`,
        dispatcherSessionId: "dispatcher",
        dispatcherCanvasInstanceId: "root-canvas",
    }));
    assert.equal(store.enqueueReviewJobs(jobs).accepted.length, 4);

    const firstBatch = store.claimQueuedReviewJobs(
        "dispatcher",
        "root-canvas",
        "batch-1",
        3,
        "1970-01-01T00:00:00.000Z",
    );
    assert.equal(firstBatch.length, 3);
    store.acknowledgeReviewJobs(
        "dispatcher",
        "batch-1",
        firstBatch.map((job) => ({
            runId: job.run_id,
            ok: true,
            appSessionId: `session-${job.run_id}`,
        })),
    );
    assert.equal(
        store.claimQueuedReviewJobs(
            "dispatcher",
            "root-canvas",
            "batch-blocked",
            3,
            "1970-01-01T00:00:00.000Z",
        ).length,
        0,
    );

    const claimed = store.claimReviewTask("run-1", {
        prId: "1",
        org: "org",
        project: "project",
        repoId: "repo-guid",
    });
    assert.equal(claimed.task_prompt, "prompt-1");
    store.finishReviewJob("run-1", "done");
    assert.equal(store.getReviewJob("run-1").task_prompt, null);
    assert.throws(
        () =>
            store.claimReviewTask("run-1", {
                prId: "1",
                org: "org",
                project: "project",
                repoId: "repo-guid",
            }),
        /cannot be claimed/,
    );

    const secondBatch = store.claimQueuedReviewJobs(
        "dispatcher",
        "root-canvas",
        "batch-2",
        3,
        "1970-01-01T00:00:00.000Z",
    );
    assert.equal(secondBatch.length, 1);
    assert.equal(secondBatch[0].run_id, "run-4");
    console.log("Review dispatcher harness passed");
} finally {
    store?.closeDb();
    await rm(tempDir, { recursive: true, force: true });
}
