import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = await mkdtemp(join(tmpdir(), "ado-pr-ops-visibility-"));
process.env.ADO_PR_OPS_DB_PATH = join(tempDir, "reviews.db");

let store;
try {
    const intake = await import("../teams-review-intake.mjs");
    const tasks = await import("../review-task.mjs");
    store = await import("../store.mjs");
    const db = await store.ensureDb();
    const stalePlan = db
        .prepare(
            "EXPLAIN QUERY PLAN SELECT * FROM review_jobs WHERE status = ? AND updated_at < ?",
        )
        .all("running", "2026-08-11T00:00:00.000Z");
    assert.equal(
        stalePlan.some((row) => String(row.detail).includes("idx_review_jobs_status_updated")),
        true,
    );

    const sourceId = "teams:channel:review-requests";
    const seeded = await intake.getTeamsReviewIntakeState({ sourceId });
    assert.equal(seeded.kind, "seeded");
    const scan = await intake.getTeamsReviewIntakeState({ sourceId });
    assert.equal(scan.kind, "scan");

    let queueCalls = 0;
    const queueReviewTargets = async ({ targets }) => {
        queueCalls++;
        const target = targets[0];
        const runId = `run-${queueCalls}`;
        const repoId = `repo-guid-${target.repoId}`;
        const taskPrompt = tasks.buildReviewTask({
            prId: target.prId,
            prContext: `# PR ${target.prId}`,
            canvasInstanceId: "root-canvas",
            org: target.org,
            project: target.project,
            repo: target.repoId,
            repoId,
            title: `PR ${target.prId}`,
            runId,
        });
        assert.match(taskPrompt, /already authorized this review/);
        assert.match(taskPrompt, /without asking for approach selection or confirmation/);
        const queued = store.enqueueReviewJobs([
            {
                runId,
                prId: target.prId,
                org: target.org,
                project: target.project,
                repo: target.repoId,
                repoId,
                title: `PR ${target.prId}`,
                taskPrompt,
                targetCanvasInstanceId: "root-canvas",
                dispatcherSessionId: "dispatcher",
                dispatcherCanvasInstanceId: "root-canvas",
            },
        ]);
        return {
            accepted: queued.accepted.map((job) => ({
                runId: job.run_id,
                repoId: job.repo_id,
                status: job.status,
            })),
            skipped: queued.skipped.map((job) => ({
                runId: job.run_id,
                repoId: job.repo_id,
                status: job.status,
            })),
            failed: [],
        };
    };

    const request = (messageId, repo, sender = "Ada Reviewer") => ({
        sourceMessageId: messageId,
        sourceMessageUrl: `https://teams.microsoft.com/l/message/${messageId}`,
        sender,
        sentAt: scan.expectedWatermark,
        excerpt: "Please review this pull request.",
        prUrl: `https://dev.azure.com/org/project/_git/${repo}/pullrequest/42`,
    });

    const first = await intake.ingestTeamsReviewRequests(
        {
            sourceId,
            expectedWatermark: scan.expectedWatermark,
            scanToken: scan.scanToken,
            nextWatermark: scan.to,
            complete: true,
            requests: [request("message-1", "repo-a")],
        },
        "root-canvas",
        { queueReviewTargets },
    );
    assert.equal(first.outcomes[0]?.status, "queued");
    assert.equal(queueCalls, 1);

    const activeFirst = store.listActiveReviewJobs();
    assert.equal(activeFirst.length, 1);
    assert.equal(activeFirst[0].status, "queued");
    assert.equal(activeFirst[0].automation_source, "teams");
    assert.equal(activeFirst[0].automation_requester, "Ada Reviewer");
    assert.match(activeFirst[0].automation_source_url, /message-1/);

    const replayScan = await intake.getTeamsReviewIntakeState({ sourceId });
    const replay = await intake.ingestTeamsReviewRequests(
        {
            sourceId,
            expectedWatermark: replayScan.expectedWatermark,
            scanToken: replayScan.scanToken,
            nextWatermark: replayScan.to,
            complete: true,
            requests: [request("message-1", "repo-a")],
        },
        "root-canvas",
        { queueReviewTargets },
    );
    assert.equal(replay.outcomes[0]?.status, "duplicate");
    assert.equal(queueCalls, 1);

    const secondScan = await intake.getTeamsReviewIntakeState({ sourceId });
    const secondRepo = await intake.ingestTeamsReviewRequests(
        {
            sourceId,
            expectedWatermark: secondScan.expectedWatermark,
            scanToken: secondScan.scanToken,
            nextWatermark: secondScan.to,
            complete: true,
            requests: [request("message-2", "repo-b", "Grace Reviewer")],
        },
        "root-canvas",
        { queueReviewTargets },
    );
    assert.equal(secondRepo.outcomes[0]?.status, "queued");
    const scoped = store.listReviews().filter((review) => review.pr_id === "42");
    assert.equal(scoped.length, 2);
    assert.deepEqual(
        new Set(scoped.map((review) => review.repo_id)),
        new Set(["repo-guid-repo-a", "repo-guid-repo-b"]),
    );

    const firstRunId = first.outcomes[0].runId;
    const claimed = store.claimQueuedReviewJobs(
        "dispatcher",
        "root-canvas",
        "batch-1",
        2,
        "1970-01-01T00:00:00.000Z",
    );
    assert.equal(claimed.length, 2);
    store.acknowledgeReviewJobs(
        "dispatcher",
        "batch-1",
        claimed.map((job) => ({ runId: job.run_id, ok: true, appSessionId: `session-${job.run_id}` })),
    );
    const reviewing = store.listReviews().filter((review) => review.pr_id === "42");
    assert.equal(reviewing.length, 2);
    assert.equal(reviewing.every((review) => review.status === "running"), true);
    assert.equal(reviewing.every((review) => review.automation_source === "teams"), true);

    store.publishReviewJobRun({
        prId: 42,
        runId: firstRunId,
        org: "org",
        project: "project",
        repo: "repo-a",
        repoId: "repo-guid-repo-a",
        title: "PR 42",
        status: "done",
        summary: "Published automation review",
        story: "Visible in the canvas.",
        findings: [],
    });
    const published = store.listReviews().find((review) => review.repo_id === "repo-guid-repo-a");
    assert.equal(published?.status, "done");
    assert.equal(published?.automation_requester, "Ada Reviewer");
    assert.equal(store.getReviewJob(firstRunId)?.task_prompt, null);

    store.publishReviewJobRun({
        prId: 42,
        runId: secondRepo.outcomes[0].runId,
        org: "org",
        project: "project",
        repo: "repo-b",
        repoId: "repo-guid-repo-b",
        title: "PR 42",
        status: "error",
        error: "Reviewer session failed",
    });
    const failed = store.listReviews().find((review) => review.repo_id === "repo-guid-repo-b");
    assert.equal(failed?.status, "error");
    assert.equal(failed?.automation_requester, "Grace Reviewer");
    assert.equal(store.getReviewJob(secondRepo.outcomes[0].runId)?.task_prompt, null);

    store.upsertReview({
        prId: 7,
        org: "org",
        project: "project",
        repo: "legacy-repo",
        repoId: "legacy-repo-id",
        title: "Canvas-originated review",
        status: "done",
    });
    const legacy = store.listReviews().find((review) => review.repo_id === "legacy-repo-id");
    assert.equal(legacy?.automation_source, null);
    assert.equal(legacy?.automation_requester, null);
    assert.equal(legacy?.automation_source_url, null);

    const reReviewScan = await intake.getTeamsReviewIntakeState({ sourceId });
    const reReview = await intake.ingestTeamsReviewRequests(
        {
            sourceId,
            expectedWatermark: reReviewScan.expectedWatermark,
            scanToken: reReviewScan.scanToken,
            nextWatermark: reReviewScan.to,
            complete: true,
            requests: [request("message-3", "repo-a", "Lin Reviewer")],
        },
        "root-canvas",
        { queueReviewTargets },
    );
    assert.equal(reReview.outcomes[0]?.status, "queued");
    assert.notEqual(reReview.outcomes[0]?.runId, firstRunId);
    assert.equal(queueCalls, 3);

    const beforeFailedScan = store.getTeamsReviewIntakeState(sourceId).watermark;
    await assert.rejects(async () => {
        throw new Error("WorkIQ scan failed");
    }, /WorkIQ scan failed/);
    assert.equal(store.getTeamsReviewIntakeState(sourceId).watermark, beforeFailedScan);

    console.log("Teams review visibility harness passed");
} finally {
    store?.closeDb();
    await rm(tempDir, { recursive: true, force: true });
}
