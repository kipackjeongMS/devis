import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const tempDir = await mkdtemp(join(tmpdir(), "ado-pr-ops-migration-"));
const dbPath = join(tempDir, "reviews.db");
process.env.ADO_PR_OPS_DB_PATH = dbPath;

const legacy = new DatabaseSync(dbPath);
legacy.exec(`
    CREATE TABLE review_jobs (
        run_id TEXT PRIMARY KEY,
        pr_id TEXT NOT NULL,
        org TEXT NOT NULL,
        project TEXT NOT NULL,
        repo TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        title TEXT NOT NULL,
        task_prompt TEXT NOT NULL,
        target_canvas_instance_id TEXT NOT NULL,
        dispatcher_session_id TEXT NOT NULL,
        dispatcher_canvas_instance_id TEXT NOT NULL,
        review_model TEXT,
        status TEXT NOT NULL,
        batch_id TEXT,
        app_session_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
`);
const insert = legacy.prepare(
    `INSERT INTO review_jobs VALUES
     (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?)`,
);
insert.run(
    "done-run",
    "1",
    "org",
    "project",
    "repo",
    "repo-guid",
    "Done",
    "terminal prompt",
    "canvas-1",
    "dispatcher",
    "root-canvas",
    "done",
    "2026-08-11T00:00:00.000Z",
    "2026-08-11T00:00:00.000Z",
);
insert.run(
    "running-run",
    "2",
    "org",
    "project",
    "repo",
    "repo-guid",
    "Running",
    "claimable prompt",
    "canvas-2",
    "dispatcher",
    "root-canvas",
    "running",
    "2026-08-11T00:00:00.000Z",
    "2026-08-11T00:00:00.000Z",
);
legacy.close();

let store;
try {
    store = await import("../store.mjs");
    const db = await store.ensureDb();
    const promptColumn = db
        .prepare("PRAGMA table_info(review_jobs)")
        .all()
        .find((column) => column.name === "task_prompt");
    assert.equal(promptColumn.notnull, 0);
    assert.equal(store.getReviewJob("done-run").task_prompt, null);
    assert.equal(store.getReviewJob("running-run").task_prompt, "claimable prompt");

    const claimed = store.claimReviewTask("running-run", {
        prId: "2",
        org: "org",
        project: "project",
        repoId: "repo-guid",
    });
    assert.equal(claimed.task_prompt, "claimable prompt");
    store.finishReviewJob("running-run", "error", "diagnostic retained");
    assert.equal(store.getReviewJob("running-run").task_prompt, null);
    assert.equal(store.getReviewJob("running-run").error, "diagnostic retained");

    const indexes = db.prepare("PRAGMA index_list(review_jobs)").all();
    assert.equal(
        indexes.some((index) => index.name === "idx_review_jobs_status_updated"),
        true,
    );
    console.log("Review job migration harness passed");
} finally {
    store?.closeDb();
    await rm(tempDir, { recursive: true, force: true });
}
