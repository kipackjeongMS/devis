// Review-results store (the extension's OWN private SQLite file — never the
// CLI's shared data.db). A background review agent POSTs its finished result to
// /api/review-result; the canvas polls /api/review-result?prId=… to render it.
// Zero-dependency: node:sqlite is a Node built-in (experimental; warns on stderr
// only, which does not disturb the JSON-RPC stdout pipe).

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const DB_PATH = join(DATA_DIR, "reviews.db");

/**
 * One structured, line-anchored review finding — rendered as a STAGED inline
 * comment in the diff (never auto-posted). `id`/`posted` are managed server-side.
 */
export interface Finding {
    id?: string;
    file?: string | null;
    line?: number | null;
    endLine?: number | null;
    side?: string | null; // "left" | "right"
    severity?: string | null; // "critical" | "high" | "medium" | "low" | "nit"
    title?: string | null;
    comment: string;
    posted?: boolean;
}

/** A stored review row (one per PR). String columns are null until written. */
export interface ReviewRow {
    review_key: string;
    pr_id: string;
    org: string | null;
    project: string | null;
    repo: string | null;
    repo_id: string | null;
    title: string | null;
    status: string;
    summary: string | null;
    story: string | null;
    findings: string | null;
    findings_json: string | null;
    error: string | null;
    run_id: string | null;
    /** Copilot session that produced this review; follow-up subtasks resume into it. */
    reviewer_session_id: string | null;
    // Legacy mirror of the My Plate preference. Kept for stored-review compatibility.
    // A fresh review clears both this field and the dedicated preference row.
    // fresh review starts, so a re-review re-surfaces it.
    dismissed: number;
    created_at: string | null;
    updated_at: string | null;
}

/** Compact row used for list badges. Scope fields prevent cross-repo PR-number collisions. */
export type ReviewListItem = Pick<
    ReviewRow,
    "review_key" | "pr_id" | "org" | "project" | "repo" | "repo_id" | "status" | "summary" | "dismissed" | "updated_at"
>;

export interface ReviewIdentity {
    prId: string | number;
    org?: string | null;
    project?: string | null;
    repoId?: string | null;
}

export type ReviewJobStatus = "queued" | "dispatching" | "created" | "running" | "done" | "error";

/** One durable request to create an independent app-managed reviewer session. */
export interface ReviewJobRow {
    run_id: string;
    pr_id: string;
    org: string;
    project: string;
    repo: string;
    repo_id: string;
    title: string;
    task_prompt: string;
    target_canvas_instance_id: string;
    dispatcher_session_id: string;
    dispatcher_canvas_instance_id: string;
    review_model: string | null;
    status: ReviewJobStatus;
    batch_id: string | null;
    app_session_id: string | null;
    error: string | null;
    created_at: string;
    updated_at: string;
}

export interface ReviewJobInput {
    runId: string;
    prId: string | number;
    org: string;
    project: string;
    repo: string;
    repoId: string;
    title: string;
    taskPrompt: string;
    targetCanvasInstanceId: string;
    dispatcherSessionId: string;
    dispatcherCanvasInstanceId: string;
    reviewModel?: string | null;
}

/** The POST payload an agent (or the canvas) writes; only `prId` is required. */
export interface ReviewInput {
    prId: string | number;
    org?: string | null;
    project?: string | null;
    repo?: string | null;
    repoId?: string | null;
    title?: string | null;
    status?: string | null;
    summary?: string | null;
    story?: string | null;
    // Legacy: freeform markdown. Structured: an array of anchored Findings
    // (or a single Finding object — PowerShell's ConvertTo-Json can collapse a
    // one-element array into a bare object).
    findings?: string | Finding | Finding[] | null;
    error?: string | null;
    runId?: string | null;
    /**
     * Copilot session that performed the review. Sourced from the publishing
     * extension process (never from agent input), so it is only set on the
     * canvas-action publish path.
     */
    reviewerSessionId?: string | null;
}

let db: DatabaseSync | null = null;
let dbInit: Promise<DatabaseSync> | null = null;

export async function ensureDb(): Promise<DatabaseSync> {
    if (db) return db;
    if (dbInit) return dbInit;
    dbInit = initializeDb();
    try {
        return await dbInit;
    } catch (e) {
        dbInit = null;
        throw e;
    }
}

async function initializeDb(): Promise<DatabaseSync> {
    await mkdir(DATA_DIR, { recursive: true });
    const connection = new DatabaseSync(DB_PATH);
    connection.exec("PRAGMA busy_timeout = 5000");
    connection.prepare("PRAGMA journal_mode = WAL").get();
    connection.exec("BEGIN IMMEDIATE");
    try {
        connection.exec(`
            CREATE TABLE IF NOT EXISTS reviews (
                review_key         TEXT PRIMARY KEY,
                pr_id              TEXT NOT NULL,
                org                TEXT,
                project            TEXT,
                repo               TEXT,
                repo_id            TEXT,
                title              TEXT,
                status             TEXT NOT NULL DEFAULT 'pending',
                summary            TEXT,
                story              TEXT,
                findings           TEXT,
                findings_json      TEXT,
                error              TEXT,
                run_id             TEXT,
                reviewer_session_id TEXT,
                dismissed          INTEGER NOT NULL DEFAULT 0,
                created_at         TEXT,
                updated_at         TEXT
            );
        `);
        // Older builds keyed reviews by bare PR number. Preserve those rows as
        // explicit legacy records while allowing scoped rows for every repo.
        let reviewCols = connection.prepare("PRAGMA table_info(reviews)").all() as Array<{ name: string }>;
        if (!reviewCols.some((c) => c.name === "review_key")) {
            if (!reviewCols.some((c) => c.name === "findings_json")) {
                connection.exec("ALTER TABLE reviews ADD COLUMN findings_json TEXT");
            }
            if (!reviewCols.some((c) => c.name === "dismissed")) {
                connection.exec("ALTER TABLE reviews ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0");
            }
            if (!reviewCols.some((c) => c.name === "run_id")) {
                connection.exec("ALTER TABLE reviews ADD COLUMN run_id TEXT");
            }
            if (!reviewCols.some((c) => c.name === "reviewer_session_id")) {
                connection.exec("ALTER TABLE reviews ADD COLUMN reviewer_session_id TEXT");
            }
            connection.exec(`
                ALTER TABLE reviews RENAME TO reviews_legacy;
                CREATE TABLE reviews (
                    review_key         TEXT PRIMARY KEY,
                    pr_id              TEXT NOT NULL,
                    org                TEXT,
                    project            TEXT,
                    repo               TEXT,
                    repo_id            TEXT,
                    title              TEXT,
                    status             TEXT NOT NULL DEFAULT 'pending',
                    summary            TEXT,
                    story              TEXT,
                    findings           TEXT,
                    findings_json      TEXT,
                    error              TEXT,
                    run_id             TEXT,
                    reviewer_session_id TEXT,
                    dismissed          INTEGER NOT NULL DEFAULT 0,
                    created_at         TEXT,
                    updated_at         TEXT
                );
                INSERT INTO reviews
                    (review_key, pr_id, org, project, repo, repo_id, title, status,
                     summary, story, findings, findings_json, error, run_id,
                     reviewer_session_id, dismissed, created_at, updated_at)
                SELECT 'legacy:' || pr_id, pr_id, org, project, repo, NULL, title, status,
                       summary, story, findings, findings_json, error, run_id,
                       reviewer_session_id, dismissed, created_at, updated_at
                FROM reviews_legacy;
                DROP TABLE reviews_legacy;
            `);
            reviewCols = connection.prepare("PRAGMA table_info(reviews)").all() as Array<{ name: string }>;
        }
        connection.exec(`
            CREATE INDEX IF NOT EXISTS idx_reviews_identity
            ON reviews(org, project, repo_id, pr_id);
        `);

        // My Plate can also contain activity-only PRs, so its preference key uses
        // the same scoped identity. Legacy bare-number choices remain readable.
        connection.exec(`
            CREATE TABLE IF NOT EXISTS plate_preferences (
                plate_key  TEXT PRIMARY KEY,
                pr_id      TEXT NOT NULL,
                org        TEXT,
                project    TEXT,
                repo_id    TEXT,
                dismissed INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT
            );
        `);
        const plateCols = connection.prepare("PRAGMA table_info(plate_preferences)").all() as Array<{ name: string }>;
        if (!plateCols.some((c) => c.name === "plate_key")) {
            connection.exec(`
                ALTER TABLE plate_preferences RENAME TO plate_preferences_legacy;
                CREATE TABLE plate_preferences (
                    plate_key  TEXT PRIMARY KEY,
                    pr_id      TEXT NOT NULL,
                    org        TEXT,
                    project    TEXT,
                    repo_id    TEXT,
                    dismissed INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT
                );
                INSERT INTO plate_preferences
                    (plate_key, pr_id, org, project, repo_id, dismissed, updated_at)
                SELECT 'legacy:' || pr_id, pr_id, NULL, NULL, NULL, dismissed, updated_at
                FROM plate_preferences_legacy;
                DROP TABLE plate_preferences_legacy;
            `);
        }
        connection.exec(`
            INSERT OR IGNORE INTO plate_preferences
                (plate_key, pr_id, org, project, repo_id, dismissed, updated_at)
            SELECT review_key, pr_id, org, project, repo_id, 1, updated_at
            FROM reviews WHERE dismissed = 1;
        `);
        // Notification inbox: deduped, persisted ADO events.
        connection.exec(`
            CREATE TABLE IF NOT EXISTS notifications (
                id         TEXT PRIMARY KEY,
                kind       TEXT NOT NULL,
                pr_id      TEXT,
                org        TEXT,
                project    TEXT,
                repo       TEXT,
                repo_id    TEXT,
                title      TEXT,
                actor      TEXT,
                summary    TEXT,
                snippet    TEXT,
                url        TEXT,
                unread     INTEGER NOT NULL DEFAULT 1,
                created_at TEXT,
                read_at    TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);
            CREATE TABLE IF NOT EXISTS inbox_meta (
                key   TEXT PRIMARY KEY,
                value TEXT
            );
        `);
        connection.exec(`
            CREATE TABLE IF NOT EXISTS review_jobs (
                run_id                        TEXT PRIMARY KEY,
                pr_id                        TEXT NOT NULL,
                org                          TEXT NOT NULL,
                project                      TEXT NOT NULL,
                repo                         TEXT NOT NULL,
                repo_id                      TEXT NOT NULL,
                title                        TEXT NOT NULL,
                task_prompt                  TEXT NOT NULL,
                target_canvas_instance_id    TEXT NOT NULL,
                dispatcher_session_id        TEXT NOT NULL,
                dispatcher_canvas_instance_id TEXT NOT NULL,
                review_model                 TEXT,
                status                       TEXT NOT NULL,
                batch_id                     TEXT,
                app_session_id               TEXT,
                error                        TEXT,
                created_at                   TEXT NOT NULL,
                updated_at                   TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_review_jobs_dispatch
            ON review_jobs(dispatcher_session_id, status, created_at);
            CREATE INDEX IF NOT EXISTS idx_review_jobs_pr
            ON review_jobs(pr_id, status, updated_at);
        `);
        connection.exec("COMMIT");
        db = connection;
        return connection;
    } catch (e) {
        try {
            connection.exec("ROLLBACK");
        } finally {
            connection.close();
        }
        throw e;
    }
}

// getReview / listReviews / upsertReview assume ensureDb() has already run.
function requireDb(): DatabaseSync {
    if (!db) throw new Error("review store not initialized");
    return db;
}

function cleanIdentityPart(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed || null;
}

export function legacyReviewKey(prId: string | number): string {
    return `legacy:${String(prId)}`;
}

export function reviewIdentityKey(identity: ReviewIdentity): string {
    const prId = String(identity.prId);
    const org = cleanIdentityPart(identity.org);
    const project = cleanIdentityPart(identity.project);
    const repoId = cleanIdentityPart(identity.repoId);
    return org && project && repoId
        ? JSON.stringify([org, project, repoId, prId])
        : legacyReviewKey(prId);
}

function exactReview(identity: ReviewIdentity): ReviewRow | null {
    return (
        (requireDb()
            .prepare("SELECT * FROM reviews WHERE review_key = ?")
            .get(reviewIdentityKey(identity)) as ReviewRow | undefined) || null
    );
}

export function getReview(identity: ReviewIdentity | string | number): ReviewRow | null {
    const normalized: ReviewIdentity =
        typeof identity === "object" ? identity : { prId: identity };
    const exact = exactReview(normalized);
    if (exact || reviewIdentityKey(normalized).startsWith("legacy:")) return exact;
    return exactReview({ prId: normalized.prId });
}

export function listReviews(): ReviewListItem[] {
    return requireDb()
        .prepare(
            `SELECT review_key, pr_id, org, project, repo, repo_id, status, summary, dismissed, updated_at
             FROM reviews ORDER BY updated_at DESC`,
        )
        .all() as unknown as ReviewListItem[];
}

export function listActiveReviewJobs(): Array<
    Pick<ReviewJobRow, "pr_id" | "org" | "project" | "repo" | "repo_id" | "status">
> {
    return requireDb()
        .prepare(
            `SELECT pr_id, org, project, repo, repo_id, status FROM review_jobs
             WHERE status IN ('queued','dispatching','created','running')`,
        )
        .all() as Array<
        Pick<ReviewJobRow, "pr_id" | "org" | "project" | "repo" | "repo_id" | "status">
    >;
}

export function getReviewJob(runId: string): ReviewJobRow | null {
    return (
        (requireDb().prepare("SELECT * FROM review_jobs WHERE run_id = ?").get(runId) as
            | ReviewJobRow
            | undefined) || null
    );
}

/** Persist review tasks before dispatch. An active PR is returned as skipped. */
export function enqueueReviewJobs(inputs: ReviewJobInput[]): {
    accepted: ReviewJobRow[];
    skipped: ReviewJobRow[];
} {
    const connection = requireDb();
    const findActive = connection.prepare(
        `SELECT * FROM review_jobs
         WHERE org = ? AND project = ? AND repo_id = ? AND pr_id = ?
           AND status IN ('queued','dispatching','created','running')
         ORDER BY created_at DESC LIMIT 1`,
    );
    const insert = connection.prepare(
        `INSERT INTO review_jobs
         (run_id, pr_id, org, project, repo, repo_id, title, task_prompt,
          target_canvas_instance_id, dispatcher_session_id, dispatcher_canvas_instance_id,
          review_model, status, batch_id, app_session_id, error, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const accepted: ReviewJobRow[] = [];
    const skipped: ReviewJobRow[] = [];
    connection.exec("BEGIN IMMEDIATE");
    try {
        for (const input of inputs) {
            const prId = String(input.prId);
            const active = findActive.get(
                input.org,
                input.project,
                input.repoId,
                prId,
            ) as ReviewJobRow | undefined;
            if (active) {
                skipped.push(active);
                continue;
            }
            const now = new Date().toISOString();
            insert.run(
                input.runId,
                prId,
                input.org,
                input.project,
                input.repo,
                input.repoId,
                input.title,
                input.taskPrompt,
                input.targetCanvasInstanceId,
                input.dispatcherSessionId,
                input.dispatcherCanvasInstanceId,
                input.reviewModel || null,
                "queued",
                null,
                null,
                null,
                now,
                now,
            );
            upsertReview({
                prId,
                runId: input.runId,
                org: input.org,
                project: input.project,
                repo: input.repo,
                repoId: input.repoId,
                title: input.title,
                status: "queued",
                error: null,
            });
            accepted.push(getReviewJob(input.runId)!);
        }
        connection.exec("COMMIT");
        return { accepted, skipped };
    } catch (e) {
        connection.exec("ROLLBACK");
        throw e;
    }
}

/** Heartbeat queued work so another app session adopts it only after this owner disappears. */
export function touchQueuedReviewJobs(dispatcherSessionId: string): void {
    requireDb()
        .prepare(
            `UPDATE review_jobs SET updated_at = ?
             WHERE dispatcher_session_id = ? AND status = 'queued'`,
        )
        .run(new Date().toISOString(), dispatcherSessionId);
}

/** Atomically reserve the next queued jobs for one parent-session dispatch turn. */
export function claimQueuedReviewJobs(
    dispatcherSessionId: string,
    dispatcherCanvasInstanceId: string,
    batchId: string,
    maxConcurrent: number,
    orphanedBefore: string,
): ReviewJobRow[] {
    if (maxConcurrent < 1) return [];
    const connection = requireDb();
    connection.exec("BEGIN IMMEDIATE");
    try {
        // Reserve capacity under the same write lock as the status transition.
        // `dispatching` already represents a promised reviewer session, so it
        // occupies a slot alongside created/running sessions.
        const active = connection
            .prepare(
                `SELECT COUNT(*) AS count FROM review_jobs
                 WHERE status IN ('dispatching','created','running')`,
            )
            .get() as { count: number };
        const limit = Math.max(0, maxConcurrent - Number(active.count));
        if (!limit) {
            connection.exec("COMMIT");
            return [];
        }
        const rows = connection
            .prepare(
                `SELECT * FROM review_jobs
                 WHERE status = 'queued'
                   AND (dispatcher_session_id = ? OR updated_at < ?)
                 ORDER BY CASE WHEN dispatcher_session_id = ? THEN 0 ELSE 1 END,
                          created_at ASC
                 LIMIT ?`,
            )
            .all(dispatcherSessionId, orphanedBefore, dispatcherSessionId, limit) as unknown as ReviewJobRow[];
        const now = new Date().toISOString();
        const update = connection.prepare(
            `UPDATE review_jobs
             SET status = 'dispatching',
                 dispatcher_session_id = ?,
                 dispatcher_canvas_instance_id = ?,
                 batch_id = ?,
                 updated_at = ?
             WHERE run_id = ? AND status = 'queued'`,
        );
        const claimed: ReviewJobRow[] = [];
        for (const row of rows) {
            if (
                Number(
                    update.run(
                        dispatcherSessionId,
                        dispatcherCanvasInstanceId,
                        batchId,
                        now,
                        row.run_id,
                    ).changes || 0,
                ) === 1
            ) {
                claimed.push({
                    ...row,
                    status: "dispatching",
                    dispatcher_session_id: dispatcherSessionId,
                    dispatcher_canvas_instance_id: dispatcherCanvasInstanceId,
                    batch_id: batchId,
                    updated_at: now,
                });
            }
        }
        connection.exec("COMMIT");
        return claimed;
    } catch (e) {
        connection.exec("ROLLBACK");
        throw e;
    }
}

export function listReviewBatchJobs(
    dispatcherSessionId: string,
    batchId: string,
): ReviewJobRow[] {
    return requireDb()
        .prepare(
            `SELECT * FROM review_jobs
             WHERE dispatcher_session_id = ? AND batch_id = ?
             ORDER BY created_at ASC`,
        )
        .all(dispatcherSessionId, batchId) as unknown as ReviewJobRow[];
}

export interface ReviewDispatchAck {
    runId: string;
    ok: boolean;
    appSessionId?: string | null;
    error?: string | null;
}

function jobReviewInput(row: ReviewJobRow): ReviewInput {
    return {
        prId: row.pr_id,
        org: row.org,
        project: row.project,
        repo: row.repo,
        repoId: row.repo_id,
        title: row.title,
        runId: row.run_id,
    };
}

/** Record create_session outcomes without overwriting a child that already claimed its task. */
export function acknowledgeReviewJobs(
    dispatcherSessionId: string,
    batchId: string,
    results: ReviewDispatchAck[],
): void {
    const connection = requireDb();
    connection.exec("BEGIN IMMEDIATE");
    try {
        for (const result of results) {
            const row = connection
                .prepare(
                    `SELECT * FROM review_jobs
                     WHERE run_id = ? AND dispatcher_session_id = ? AND batch_id = ?`,
                )
                .get(result.runId, dispatcherSessionId, batchId) as ReviewJobRow | undefined;
            if (!row || row.status === "done" || row.status === "error") continue;
            const now = new Date().toISOString();
            if (result.ok) {
                const info =
                    row.status === "running"
                        ? connection
                              .prepare(
                                  `UPDATE review_jobs
                                   SET app_session_id = ?, updated_at = ?
                                   WHERE run_id = ? AND status = 'running'`,
                              )
                              .run(result.appSessionId || null, now, row.run_id)
                        : connection
                              .prepare(
                                  `UPDATE review_jobs
                                   SET status = 'created', app_session_id = ?,
                                       error = NULL, updated_at = ?
                                   WHERE run_id = ? AND status = 'dispatching'`,
                              )
                              .run(result.appSessionId || null, now, row.run_id);
                if (Number(info.changes || 0) === 1) {
                    upsertReview({ ...jobReviewInput(row), status: "running", error: null });
                }
            } else if (row.status === "dispatching") {
                const error = result.error || "Could not create the reviewer session.";
                const info = connection
                    .prepare(
                        `UPDATE review_jobs
                         SET status = 'error', error = ?, updated_at = ?
                         WHERE run_id = ? AND status = 'dispatching'`,
                    )
                    .run(error, now, row.run_id);
                if (Number(info.changes || 0) === 1) {
                    upsertReview({ ...jobReviewInput(row), status: "error", error });
                }
            }
        }
        connection.exec("COMMIT");
    } catch (e) {
        connection.exec("ROLLBACK");
        throw e;
    }
}

/** Claim the stored prompt from the reviewer session opened on the matching PR. */
export function claimReviewTask(
    runId: string,
    target: { prId: string; org: string; project: string; repoId: string },
): ReviewJobRow {
    const connection = requireDb();
    connection.exec("BEGIN IMMEDIATE");
    try {
        const row = getReviewJob(runId);
        if (!row) throw new Error("Review job not found");
        if (
            row.pr_id !== target.prId ||
            row.org !== target.org ||
            row.project !== target.project ||
            row.repo_id !== target.repoId
        ) {
            throw new Error("Review job does not match this canvas target");
        }
        if (!["dispatching", "created", "running"].includes(row.status)) {
            throw new Error(`Review job cannot be claimed while ${row.status}`);
        }
        const now = new Date().toISOString();
        connection
            .prepare(
                `UPDATE review_jobs
                 SET status = 'running', error = NULL, updated_at = ?
                 WHERE run_id = ?`,
            )
            .run(now, runId);
        upsertReview({ ...jobReviewInput(row), status: "running", error: null });
        connection.exec("COMMIT");
        return { ...row, status: "running", error: null, updated_at: now };
    } catch (e) {
        connection.exec("ROLLBACK");
        throw e;
    }
}

export function finishReviewJob(runId: string, status: "done" | "error", error?: string): void {
    requireDb()
        .prepare(
            `UPDATE review_jobs
             SET status = ?, error = ?, updated_at = ?
             WHERE run_id = ?`,
        )
        .run(status, error || null, new Date().toISOString(), runId);
}

export function failReviewBatch(
    dispatcherSessionId: string,
    batchId: string,
    error: string,
): void {
    const rows = requireDb()
        .prepare(
            `SELECT * FROM review_jobs
             WHERE dispatcher_session_id = ? AND batch_id = ? AND status = 'dispatching'`,
        )
        .all(dispatcherSessionId, batchId) as unknown as ReviewJobRow[];
    const now = new Date().toISOString();
    const update = requireDb().prepare(
        `UPDATE review_jobs
         SET status = 'error', error = ?, updated_at = ?
         WHERE run_id = ? AND status = 'dispatching'`,
    );
    for (const row of rows) {
        const info = update.run(error, now, row.run_id);
        if (Number(info.changes || 0) === 1) {
            upsertReview({ ...jobReviewInput(row), status: "error", error });
        }
    }
}

/** Release capacity held by sessions that were never acknowledged, started, or completed. */
export function expireStaleReviewJobs(nowMs = Date.now()): number {
    const cutoffs: Array<{ status: ReviewJobStatus; before: string; message: string }> = [
        {
            status: "dispatching",
            before: new Date(nowMs - 3 * 60 * 1000).toISOString(),
            message: "The review dispatcher did not acknowledge the session creation.",
        },
        {
            status: "created",
            before: new Date(nowMs - 10 * 60 * 1000).toISOString(),
            message: "The reviewer session was created but did not start.",
        },
        {
            status: "running",
            before: new Date(nowMs - 2 * 60 * 60 * 1000).toISOString(),
            message: "Background review did not complete before the timeout.",
        },
    ];
    let changed = 0;
    const connection = requireDb();
    for (const item of cutoffs) {
        const rows = connection
            .prepare("SELECT * FROM review_jobs WHERE status = ? AND updated_at < ?")
            .all(item.status, item.before) as unknown as ReviewJobRow[];
        for (const row of rows) {
            const info = connection
                .prepare(
                    `UPDATE review_jobs
                     SET status = 'error', error = ?, updated_at = ?
                     WHERE run_id = ? AND status = ?`,
                )
                .run(item.message, new Date(nowMs).toISOString(), row.run_id, item.status);
            if (Number(info.changes || 0) === 1) {
                upsertReview({
                    ...jobReviewInput(row),
                    status: "error",
                    error: item.message,
                });
                changed++;
            }
        }
    }
    return changed;
}

/** Convert abandoned running reviews into an explicit recoverable error state. */
export function expireStaleReviews(maxAgeMs = 2 * 60 * 60 * 1000): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const now = new Date().toISOString();
    const info = requireDb()
        .prepare(
            `UPDATE reviews
             SET status = 'error',
                 error = 'Background review did not complete before the timeout.',
                 updated_at = ?
             WHERE status = 'running' AND updated_at < ?`,
        )
        .run(now, cutoff);
    return Number(info.changes ?? 0);
}

/** Keep the review-row mirror of a scoped My Plate preference in sync. */
export function setDismissed(identities: ReviewIdentity[], dismissed: boolean): number {
    if (!identities.length) return 0;
    const update = requireDb().prepare(
        "UPDATE reviews SET dismissed = ?, updated_at = ? WHERE review_key = ?",
    );
    const now = new Date().toISOString();
    let changed = 0;
    for (const identity of identities) {
        changed += Number(
            update.run(dismissed ? 1 : 0, now, reviewIdentityKey(identity)).changes ?? 0,
        );
    }
    return changed;
}

/** Every PR currently hidden from My Plate, including activity-only PRs. */
export function listPlateDismissals(): Set<string> {
    const rows = requireDb()
        .prepare("SELECT plate_key FROM plate_preferences WHERE dismissed = 1")
        .all() as Array<{ plate_key: string }>;
    return new Set(rows.map((row) => row.plate_key));
}

/** Persist a My Plate removal even when the PR has no background-review row. */
export function setPlateDismissed(identities: ReviewIdentity[], dismissed: boolean): number {
    if (!identities.length) return 0;
    const stmt = requireDb().prepare(
        `INSERT INTO plate_preferences
            (plate_key, pr_id, org, project, repo_id, dismissed, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(plate_key) DO UPDATE SET
            dismissed = excluded.dismissed,
            updated_at = excluded.updated_at`,
    );
    const now = new Date().toISOString();
    let changed = 0;
    for (const identity of identities) {
        const info = stmt.run(
            reviewIdentityKey(identity),
            String(identity.prId),
            cleanIdentityPart(identity.org),
            cleanIdentityPart(identity.project),
            cleanIdentityPart(identity.repoId),
            dismissed ? 1 : 0,
            now,
        );
        changed += Number(info.changes ?? 0);
    }
    return changed;
}

// Merge-then-replace so a partial write (e.g. the canvas marking status='running')
// never clobbers fields a later write (the agent's story/findings) has yet to add,
// and vice-versa. Only keys present & non-null in `r` overwrite existing values.
type MergeKey = "org" | "project" | "repo" | "title" | "summary" | "story" | "error";

/** Assign stable ids + defaults so each finding can be staged/posted independently. */
function normalizeFindings(list: Finding[]): Finding[] {
    return list
        .filter((f) => f && typeof f.comment === "string" && f.comment.trim() !== "")
        .map((f, i) => ({
            id: f.id != null && String(f.id).trim() !== "" ? String(f.id) : "f" + i,
            file: f.file ?? null,
            line: f.line ?? null,
            endLine: f.endLine ?? null,
            side: f.side ?? (f.line != null ? "right" : null),
            severity: f.severity ?? null,
            title: f.title ?? null,
            comment: f.comment,
            posted: !!f.posted,
        }));
}

export function upsertReview(r: ReviewInput): ReviewRow {
    const now = new Date().toISOString();
    const prId = String(r.prId);
    const identity: ReviewIdentity = {
        prId,
        org: r.org,
        project: r.project,
        repoId: r.repoId,
    };
    const reviewKey = reviewIdentityKey(identity);
    const ex: Partial<ReviewRow> = exactReview(identity) || {};
    const pick = (k: MergeKey): string | null => (r[k] != null ? r[k]! : ex[k] != null ? ex[k]! : null);

    // Findings can arrive as structured (array -> findings_json) or legacy markdown
    // (string -> findings). A structured write supersedes; absent input preserves.
    let findings: string | null = ex.findings != null ? ex.findings : null;
    let findingsJson: string | null = ex.findings_json != null ? ex.findings_json : null;
    if (Array.isArray(r.findings)) {
        findingsJson = JSON.stringify(normalizeFindings(r.findings));
        findings = null;
    } else if (r.findings && typeof r.findings === "object") {
        // Single Finding object (PowerShell one-element array collapse) -> wrap.
        findingsJson = JSON.stringify(normalizeFindings([r.findings]));
        findings = null;
    } else if (typeof r.findings === "string" && r.findings.trim() !== "") {
        findings = r.findings;
    }

    const row: ReviewRow = {
        review_key: reviewKey,
        pr_id: prId,
        org: pick("org"),
        project: pick("project"),
        repo: pick("repo"),
        repo_id: r.repoId != null ? r.repoId : ex.repo_id != null ? ex.repo_id : null,
        title: pick("title"),
        status: r.status != null ? r.status : ex.status != null ? ex.status : "pending",
        summary: pick("summary"),
        story: pick("story"),
        findings,
        findings_json: findingsJson,
        error: r.status === "queued" || r.status === "running" ? null : pick("error"),
        run_id: r.runId != null ? r.runId : ex.run_id != null ? ex.run_id : null,
        // A new launch invalidates the previous reviewer session: follow-ups must
        // never resume a session that reviewed an earlier run of this PR.
        reviewer_session_id:
            r.reviewerSessionId != null
                ? r.reviewerSessionId
                : r.status === "queued" || r.status === "running"
                  ? null
                  : (ex.reviewer_session_id ?? null),
        // A fresh review (status flips to "running") re-surfaces a previously
        // dismissed PR in My Plate; otherwise the user's choice is preserved.
        dismissed: r.status === "queued" || r.status === "running" ? 0 : (ex.dismissed ?? 0),
        created_at: ex.created_at != null ? ex.created_at : now,
        updated_at: now,
    };
    requireDb()
        .prepare(
            `INSERT OR REPLACE INTO reviews
             (review_key, pr_id, org, project, repo, repo_id, title, status, summary,
              story, findings, findings_json, error, run_id, reviewer_session_id,
              dismissed, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
            row.review_key, row.pr_id, row.org, row.project, row.repo, row.repo_id,
            row.title, row.status,
            row.summary, row.story, row.findings, row.findings_json, row.error, row.run_id,
            row.reviewer_session_id, row.dismissed, row.created_at, row.updated_at,
        );
    if (r.status === "queued" || r.status === "running") setPlateDismissed([identity], false);
    return row;
}

function publishReviewRunLocked(r: ReviewInput & { runId: string }): ReviewRow {
    const current = getReview(r);
    if (current?.run_id && current.run_id !== r.runId) {
        throw new Error("This review run is stale and can no longer publish");
    }
    return upsertReview(r);
}

/** Complete only the currently-active launch, preventing stale child overwrites. */
export function publishReviewRun(r: ReviewInput & { runId: string }): ReviewRow {
    const connection = requireDb();
    connection.exec("BEGIN IMMEDIATE");
    try {
        const row = publishReviewRunLocked(r);
        connection.exec("COMMIT");
        return row;
    } catch (e) {
        connection.exec("ROLLBACK");
        throw e;
    }
}

/** Publish the review and release its dispatcher slot in one transaction. */
export function publishReviewJobRun(r: ReviewInput & { runId: string }): ReviewRow {
    const connection = requireDb();
    connection.exec("BEGIN IMMEDIATE");
    try {
        const row = publishReviewRunLocked(r);
        connection
            .prepare(
                `UPDATE review_jobs
                 SET status = ?, error = ?, updated_at = ?
                 WHERE run_id = ? AND status IN ('dispatching','created','running')`,
            )
            .run(
                r.status === "error" ? "error" : "done",
                r.status === "error" ? r.error || null : null,
                new Date().toISOString(),
                r.runId,
            );
        connection.exec("COMMIT");
        return row;
    } catch (e) {
        connection.exec("ROLLBACK");
        throw e;
    }
}

/** Mark one staged finding as posted (survives the next review re-render/poll). */
export function markFindingPosted(identity: ReviewIdentity, findingId: string): Finding[] {
    const row = getReview(identity);
    if (!row || !row.findings_json) return [];
    let list: Finding[];
    try {
        list = JSON.parse(row.findings_json) as Finding[];
    } catch {
        return [];
    }
    let changed = false;
    for (const f of list) {
        if (f.id === String(findingId)) {
            f.posted = true;
            changed = true;
        }
    }
    if (changed) {
        requireDb()
            .prepare("UPDATE reviews SET findings_json = ?, updated_at = ? WHERE review_key = ?")
            .run(JSON.stringify(list), new Date().toISOString(), row.review_key);
    }
    return list;
}

// ---------------------------------------------------------------------------
// Notification inbox
// ---------------------------------------------------------------------------

/** A stored notification row (one ADO event; `id` is a stable, dedup-safe key). */
export interface NotificationRow {
    id: string;
    kind: string; // "comment" | "reply"
    pr_id: string | null;
    org: string | null;
    project: string | null;
    repo: string | null;
    repo_id: string | null;
    title: string | null;
    actor: string | null;
    summary: string | null;
    snippet: string | null;
    url: string | null;
    unread: number;
    created_at: string | null;
    read_at: string | null;
}

/** The write payload for one derived event. `id` MUST be stable so re-polling
 *  the same ADO event is a no-op (INSERT OR IGNORE). */
export interface NotificationInput {
    id: string;
    kind: string;
    prId?: string | number | null;
    org?: string | null;
    project?: string | null;
    repo?: string | null;
    repoId?: string | null;
    title?: string | null;
    actor?: string | null;
    summary?: string | null;
    snippet?: string | null;
    url?: string | null;
    createdAt?: string | null;
}

/** Insert events, ignoring any whose id already exists. Returns rows added. */
export function insertNotifications(list: NotificationInput[]): number {
    const stmt = requireDb().prepare(
        `INSERT OR IGNORE INTO notifications
         (id, kind, pr_id, org, project, repo, repo_id, title, actor, summary, snippet, url, unread, created_at, read_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,NULL)`,
    );
    let n = 0;
    for (const x of list) {
        const info = stmt.run(
            x.id, x.kind,
            x.prId != null ? String(x.prId) : null,
            x.org ?? null, x.project ?? null, x.repo ?? null, x.repoId ?? null, x.title ?? null,
            x.actor ?? null, x.summary ?? null, x.snippet ?? null, x.url ?? null,
            x.createdAt ?? new Date().toISOString(),
        );
        n += Number(info.changes ?? 0);
    }
    return n;
}

export function listNotifications(limit = 50): NotificationRow[] {
    return requireDb()
        .prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?")
        .all(limit) as unknown as NotificationRow[];
}

export function unreadCount(): number {
    const row = requireDb()
        .prepare("SELECT COUNT(*) AS n FROM notifications WHERE unread = 1")
        .get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
}

export function markNotificationsRead(ids: string[]): number {
    const clean = ids.map(String).filter((s) => s.trim() !== "");
    if (!clean.length) return 0;
    const ph = clean.map(() => "?").join(",");
    const info = requireDb()
        .prepare(`UPDATE notifications SET unread = 0, read_at = ? WHERE id IN (${ph}) AND unread = 1`)
        .run(new Date().toISOString(), ...clean);
    return Number(info.changes ?? 0);
}

export function markAllNotificationsRead(): number {
    const info = requireDb()
        .prepare("UPDATE notifications SET unread = 0, read_at = ? WHERE unread = 1")
        .run(new Date().toISOString());
    return Number(info.changes ?? 0);
}

/** Small key/value store for inbox bookkeeping (e.g. the poll watermark). */
export function getMeta(key: string): string | null {
    const row = requireDb().prepare("SELECT value FROM inbox_meta WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
    return row ? row.value : null;
}

export function setMeta(key: string, value: string): void {
    requireDb().prepare("INSERT OR REPLACE INTO inbox_meta (key, value) VALUES (?, ?)").run(key, value);
}
