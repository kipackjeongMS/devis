// Review-results store (the app's OWN private SQLite file — never the CLI's
// shared data.db). Reviewer sessions publish through the publish_review tool;
// the UI polls /api/review-result?prId=… to render the result.
// Zero-dependency: node:sqlite is a Node built-in.

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalReviewFilePath } from "./review-path.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const DB_PATH = process.env.ADO_PR_OPS_DB_PATH || join(DATA_DIR, "reviews.db");

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
    technicalExplanation?: string | null;
    humanizedComment?: string | null;
    posted?: boolean;
}

/** A PR-level concern that spans behavior or design rather than one diff line. */
export interface SemanticFinding {
    id?: string;
    category: string;
    severity: string;
    title: string;
    comment: string;
    files?: string[];
    humanizedComment?: string | null;
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
    semantic_findings_json: string | null;
    error: string | null;
    run_id: string | null;
    /** Copilot session that produced this review; follow-up subtasks resume into it. */
    reviewer_session_id: string | null;
    // Legacy mirror of the My feed hide preference. Kept for stored-review compatibility.
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
    task_prompt: string | null;
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
    semanticFindings?: SemanticFinding | SemanticFinding[] | null;
    error?: string | null;
    runId?: string | null;
    /**
     * Copilot session that performed the review. Taken from the publish_review
     * tool invocation (never from agent input), so it is only set on that path.
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

export function closeDb(): void {
    db?.close();
    db = null;
    dbInit = null;
}

async function initializeDb(): Promise<DatabaseSync> {
    await mkdir(dirname(DB_PATH), { recursive: true });
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
                semantic_findings_json TEXT,
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
                    semantic_findings_json TEXT,
                    error              TEXT,
                    run_id             TEXT,
                    reviewer_session_id TEXT,
                    dismissed          INTEGER NOT NULL DEFAULT 0,
                    created_at         TEXT,
                    updated_at         TEXT
                );
                INSERT INTO reviews
                    (review_key, pr_id, org, project, repo, repo_id, title, status,
                     summary, story, findings, findings_json, semantic_findings_json, error, run_id,
                     reviewer_session_id, dismissed, created_at, updated_at)
                SELECT 'legacy:' || pr_id, pr_id, org, project, repo, NULL, title, status,
                       summary, story, findings, findings_json, NULL, error, run_id,
                       reviewer_session_id, dismissed, created_at, updated_at
                FROM reviews_legacy;
                DROP TABLE reviews_legacy;
            `);
            reviewCols = connection.prepare("PRAGMA table_info(reviews)").all() as Array<{ name: string }>;
        }
        if (!reviewCols.some((c) => c.name === "semantic_findings_json")) {
            connection.exec("ALTER TABLE reviews ADD COLUMN semantic_findings_json TEXT");
        }
        connection.exec(`
            CREATE INDEX IF NOT EXISTS idx_reviews_identity
            ON reviews(org, project, repo_id, pr_id);
        `);

        // My feed can also contain activity-only PRs, so its preference key uses
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
            -- Whether the current user commented on a PR, persisted so /api/prs
            -- doesn't re-fetch every PR's threads on each load.
            CREATE TABLE IF NOT EXISTS pr_comment_activity (
                org        TEXT NOT NULL,
                project    TEXT NOT NULL,
                repo_id    TEXT NOT NULL,
                pr_id      TEXT NOT NULL,
                me_id      TEXT NOT NULL,
                commented  INTEGER NOT NULL,
                checked_at INTEGER NOT NULL,
                PRIMARY KEY (org, me_id, project, repo_id, pr_id)
            );
            CREATE INDEX IF NOT EXISTS idx_pr_comment_activity_checked
                ON pr_comment_activity(checked_at);
            -- When each PR's code last changed and when I last commented or voted,
            -- cached by the PR's head commit (see pr-recency.mts). Times are epoch ms.
            CREATE TABLE IF NOT EXISTS pr_recency (
                org        TEXT NOT NULL,
                project    TEXT NOT NULL,
                repo_id    TEXT NOT NULL,
                pr_id      TEXT NOT NULL,
                me_id      TEXT NOT NULL,
                head       TEXT NOT NULL,
                pushed_at  INTEGER,
                my_at      INTEGER,
                my_kind    TEXT,
                checked_at INTEGER NOT NULL,
                PRIMARY KEY (org, me_id, project, repo_id, pr_id)
            );
            CREATE TABLE IF NOT EXISTS inbox_meta (
                key   TEXT PRIMARY KEY,
                value TEXT
            );
            -- Durable watch list: every PR/thread the inbox must keep polling for
            -- new peer activity. 'authored' rows cover a whole PR the user created
            -- (thread_id NULL); 'participated' rows cover one specific thread the
            -- user commented in on a PR authored by someone else. Both kinds are
            -- polled regardless of PR status, so replies on a since-completed PR
            -- are still caught.
            CREATE TABLE IF NOT EXISTS inbox_watches (
                watch_key            TEXT PRIMARY KEY,
                kind                 TEXT NOT NULL CHECK (kind IN ('authored','participated')),
                org                  TEXT NOT NULL,
                project              TEXT,
                repo                 TEXT,
                repo_id              TEXT,
                pr_id                TEXT NOT NULL,
                thread_id            TEXT,
                title                TEXT,
                url                  TEXT,
                pr_status            TEXT,
                last_user_comment_id TEXT,
                last_user_comment_at TEXT,
                created_at           TEXT NOT NULL,
                updated_at           TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_inbox_watches_pr
            ON inbox_watches(org, project, repo_id, pr_id);
            CREATE INDEX IF NOT EXISTS idx_inbox_watches_kind
            ON inbox_watches(kind, org);
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
                task_prompt                  TEXT,
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
            CREATE INDEX IF NOT EXISTS idx_review_jobs_status_updated
            ON review_jobs(status, updated_at);
        `);
        const reviewJobCols = connection.prepare("PRAGMA table_info(review_jobs)").all() as Array<{
            name: string;
            notnull: number;
        }>;
        if (reviewJobCols.find((column) => column.name === "task_prompt")?.notnull === 1) {
            connection.exec(`
                ALTER TABLE review_jobs RENAME TO review_jobs_prompt_required;
                CREATE TABLE review_jobs (
                    run_id                        TEXT PRIMARY KEY,
                    pr_id                        TEXT NOT NULL,
                    org                          TEXT NOT NULL,
                    project                      TEXT NOT NULL,
                    repo                         TEXT NOT NULL,
                    repo_id                      TEXT NOT NULL,
                    title                        TEXT NOT NULL,
                    task_prompt                  TEXT,
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
                INSERT INTO review_jobs
                SELECT * FROM review_jobs_prompt_required;
                DROP TABLE review_jobs_prompt_required;
                CREATE INDEX idx_review_jobs_dispatch
                ON review_jobs(dispatcher_session_id, status, created_at);
                CREATE INDEX idx_review_jobs_pr
                ON review_jobs(pr_id, status, updated_at);
                CREATE INDEX idx_review_jobs_status_updated
                ON review_jobs(status, updated_at);
            `);
        }
        connection.exec(
            "UPDATE review_jobs SET task_prompt = NULL WHERE status IN ('done','error')",
        );
        connection.exec(`
            CREATE TABLE IF NOT EXISTS pipeline_chains (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                graph_json  TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pipeline_runs (
                run_id            TEXT PRIMARY KEY,
                chain_id          TEXT NOT NULL,
                status            TEXT NOT NULL,
                graph_json        TEXT NOT NULL,
                state_json        TEXT NOT NULL,
                cancel_requested  INTEGER NOT NULL DEFAULT 0,
                error             TEXT,
                created_at        TEXT NOT NULL,
                updated_at        TEXT NOT NULL,
                finished_at       TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_pipeline_runs_chain
            ON pipeline_runs(chain_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status
            ON pipeline_runs(status);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_runs_one_active
            ON pipeline_runs(chain_id) WHERE status = 'running';
            CREATE TABLE IF NOT EXISTS pipeline_run_commands (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id      TEXT NOT NULL,
                kind        TEXT NOT NULL,
                node_id     TEXT NOT NULL,
                status      TEXT NOT NULL DEFAULT 'pending',
                error       TEXT,
                created_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_pipeline_run_commands_run
            ON pipeline_run_commands(run_id, status);
        `);
        // Chain edits made during a run travel to the runner as a "graph" command.
        const commandCols = connection.prepare("PRAGMA table_info(pipeline_run_commands)").all() as Array<{ name: string }>;
        if (!commandCols.some((c) => c.name === "payload")) {
            connection.exec("ALTER TABLE pipeline_run_commands ADD COLUMN payload TEXT");
        }
        // A Jarvis task's validation chain: temporary, and removed with its task.
        const chainCols = connection.prepare("PRAGMA table_info(pipeline_chains)").all() as Array<{ name: string }>;
        if (!chainCols.some((c) => c.name === "owner_task_id")) {
            connection.exec("ALTER TABLE pipeline_chains ADD COLUMN owner_task_id TEXT");
        }
        connection.exec("CREATE INDEX IF NOT EXISTS idx_pipeline_chains_owner ON pipeline_chains(owner_task_id)");
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
            `SELECT review_key, pr_id, org, project, repo, repo_id, status, summary,
                    dismissed, updated_at
             FROM reviews ORDER BY updated_at DESC`,
        )
        .all() as unknown as ReviewListItem[];
}

export function listActiveReviewJobs(): Array<
    Pick<ReviewJobRow, "pr_id" | "org" | "project" | "repo" | "repo_id" | "status">
> {
    return requireDb()
        .prepare(
            `SELECT pr_id, org, project, repo, repo_id, status
             FROM review_jobs
             WHERE status IN ('queued','dispatching','created','running')`,
        )
        .all() as unknown as Array<
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
                         SET status = 'error', task_prompt = NULL,
                             error = ?, updated_at = ?
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
): ReviewJobRow & { task_prompt: string } {
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
        if (!row.task_prompt) {
            throw new Error("Review job task prompt is no longer available");
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
        return { ...row, task_prompt: row.task_prompt, status: "running", error: null, updated_at: now };
    } catch (e) {
        connection.exec("ROLLBACK");
        throw e;
    }
}

export function finishReviewJob(runId: string, status: "done" | "error", error?: string): void {
    requireDb()
        .prepare(
            `UPDATE review_jobs
             SET status = ?, task_prompt = NULL, error = ?, updated_at = ?
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
         SET status = 'error', task_prompt = NULL, error = ?, updated_at = ?
         WHERE run_id = ? AND status = 'dispatching'`,
    );
    for (const row of rows) {
        const info = update.run(error, now, row.run_id);
        if (Number(info.changes || 0) === 1) {
            upsertReview({ ...jobReviewInput(row), status: "error", error });
        }
    }
}

/** The unfinished review job a reviewer session was created for. */
export function getActiveReviewJobBySession(appSessionId: string): ReviewJobRow | null {
    return (
        (requireDb()
            .prepare(
                `SELECT * FROM review_jobs
                 WHERE app_session_id = ? AND status IN ('dispatching','created','running')
                 ORDER BY created_at DESC LIMIT 1`,
            )
            .get(appSessionId) as ReviewJobRow | undefined) || null
    );
}

/**
 * Return unfinished jobs started by an earlier app process to the queue. Their
 * reviewer sessions ended with that process, so each restarts from its stored
 * task; a job whose task is gone can only fail.
 */
export function requeueOrphanedReviewJobs(runnerId: string): number {
    const connection = requireDb();
    connection.exec("BEGIN IMMEDIATE");
    try {
        const rows = connection
            .prepare(
                `SELECT * FROM review_jobs
                 WHERE status IN ('dispatching','created','running')
                   AND dispatcher_session_id <> ?`,
            )
            .all(runnerId) as unknown as ReviewJobRow[];
        const now = new Date().toISOString();
        for (const row of rows) {
            if (row.task_prompt) {
                connection
                    .prepare(
                        `UPDATE review_jobs
                         SET status = 'queued', dispatcher_session_id = ?, batch_id = NULL,
                             app_session_id = NULL, error = NULL, updated_at = ?
                         WHERE run_id = ?`,
                    )
                    .run(runnerId, now, row.run_id);
                upsertReview({ ...jobReviewInput(row), status: "queued", error: null });
            } else {
                const error = "The review was interrupted and its task is no longer available.";
                connection
                    .prepare(
                        `UPDATE review_jobs SET status = 'error', error = ?, updated_at = ?
                         WHERE run_id = ?`,
                    )
                    .run(error, now, row.run_id);
                upsertReview({ ...jobReviewInput(row), status: "error", error });
            }
        }
        connection.exec("COMMIT");
        return rows.length;
    } catch (e) {
        connection.exec("ROLLBACK");
        throw e;
    }
}

/** Fail a job whose reviewer ended without publishing. Returns false once it has finished. */
export function failActiveReviewJob(runId: string, error: string): boolean {
    const connection = requireDb();
    connection.exec("BEGIN IMMEDIATE");
    try {
        const info = connection
            .prepare(
                `UPDATE review_jobs
                 SET status = 'error', task_prompt = NULL, error = ?, updated_at = ?
                 WHERE run_id = ? AND status IN ('dispatching','created','running')`,
            )
            .run(error, new Date().toISOString(), runId);
        const changed = Number(info.changes || 0) === 1;
        if (changed) {
            const row = getReviewJob(runId)!;
            const current = getReview(jobReviewInput(row));
            if (!current?.run_id || current.run_id === runId) {
                upsertReview({ ...jobReviewInput(row), status: "error", error });
            }
        }
        connection.exec("COMMIT");
        return changed;
    } catch (e) {
        connection.exec("ROLLBACK");
        throw e;
    }
}

export function isReviewJobActive(runId: string): boolean {
    const status = getReviewJob(runId)?.status;
    return status === "dispatching" || status === "created" || status === "running";
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
                     SET status = 'error', task_prompt = NULL, error = ?, updated_at = ?
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

/** Keep the review-row mirror of a scoped My feed hide preference in sync. */
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

/** Every PR currently hidden from My feed, including activity-only PRs. */
export function listPlateDismissals(): Set<string> {
    const rows = requireDb()
        .prepare("SELECT plate_key FROM plate_preferences WHERE dismissed = 1")
        .all() as Array<{ plate_key: string }>;
    return new Set(rows.map((row) => row.plate_key));
}

/** Persist a My feed hide even when the PR has no background-review row. */
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
    for (const listener of plateListeners) {
        try {
            listener(identities, dismissed);
        } catch (e) {
            console.error(`[store] plate listener failed: ${(e as Error).message}`);
        }
    }
    return changed;
}

type PlateListener = (identities: ReviewIdentity[], dismissed: boolean) => void;
const plateListeners = new Set<PlateListener>();

/** Hear every My feed hide or restore, including a review un-hiding its PR. */
export function onPlateDismissed(listener: PlateListener): () => void {
    plateListeners.add(listener);
    return () => plateListeners.delete(listener);
}
// never clobbers fields a later write (the agent's story/findings) has yet to add,
// and vice-versa. Only keys present & non-null in `r` overwrite existing values.
type MergeKey = "org" | "project" | "repo" | "title" | "summary" | "story" | "error";

/** Assign stable ids + defaults so each finding can be staged/posted independently. */
function normalizeFindings(list: Finding[]): Finding[] {
    return list
        .filter((f) => f && typeof f.comment === "string" && f.comment.trim() !== "")
        .map((f, i) => ({
            id: f.id != null && String(f.id).trim() !== "" ? String(f.id) : "f" + i,
            file: canonicalReviewFilePath(f.file) || null,
            line: f.line ?? null,
            endLine: f.endLine ?? null,
            side: f.side ?? (f.line != null ? "right" : null),
            severity: f.severity ?? null,
            title: f.title ?? null,
            comment: f.comment,
            technicalExplanation: f.technicalExplanation ?? null,
            humanizedComment: f.humanizedComment ?? null,
            posted: !!f.posted,
        }));
}

function normalizeSemanticFindings(list: SemanticFinding[]): SemanticFinding[] {
    return list
        .filter(
            (finding) =>
                finding &&
                typeof finding.title === "string" &&
                finding.title.trim() !== "" &&
                typeof finding.comment === "string" &&
                finding.comment.trim() !== "",
        )
        .map((finding, index) => ({
            id:
                finding.id != null && String(finding.id).trim() !== ""
                    ? String(finding.id)
                    : "s" + index,
            category: finding.category,
            severity: finding.severity,
            title: finding.title,
            comment: finding.comment,
            files: Array.isArray(finding.files)
                ? [
                      ...new Set(
                          finding.files
                              .filter((file) => typeof file === "string" && file.trim())
                              .map((file) => canonicalReviewFilePath(file))
                              .filter(Boolean),
                      ),
                  ]
                : [],
            humanizedComment: finding.humanizedComment ?? null,
            posted: !!finding.posted,
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
    let semanticFindingsJson =
        ex.semantic_findings_json != null ? ex.semantic_findings_json : null;
    if (Array.isArray(r.semanticFindings)) {
        semanticFindingsJson = JSON.stringify(normalizeSemanticFindings(r.semanticFindings));
    } else if (r.semanticFindings && typeof r.semanticFindings === "object") {
        semanticFindingsJson = JSON.stringify(normalizeSemanticFindings([r.semanticFindings]));
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
        semantic_findings_json: semanticFindingsJson,
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
        // dismissed PR in My feed; otherwise the user's choice is preserved.
        dismissed: r.status === "queued" || r.status === "running" ? 0 : (ex.dismissed ?? 0),
        created_at: ex.created_at != null ? ex.created_at : now,
        updated_at: now,
    };
    requireDb()
        .prepare(
            `INSERT OR REPLACE INTO reviews
             (review_key, pr_id, org, project, repo, repo_id, title, status, summary,
             story, findings, findings_json, semantic_findings_json, error, run_id,
             reviewer_session_id, dismissed, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
            row.review_key, row.pr_id, row.org, row.project, row.repo, row.repo_id,
            row.title, row.status,
            row.summary, row.story, row.findings, row.findings_json, row.semantic_findings_json,
            row.error, row.run_id, row.reviewer_session_id, row.dismissed, row.created_at,
            row.updated_at,
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
                 SET status = ?, task_prompt = NULL, error = ?, updated_at = ?
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

/** The review a reviewer session produced, while that session is still its reviewer. */
export function getReviewByReviewerSession(reviewerSessionId: string): ReviewRow | null {
    return (
        (requireDb()
            .prepare("SELECT * FROM reviews WHERE reviewer_session_id = ? ORDER BY updated_at DESC LIMIT 1")
            .get(reviewerSessionId) as ReviewRow | undefined) || null
    );
}

function parseStoredList<T>(json: string | null): T[] {
    if (!json) return [];
    try {
        const parsed = JSON.parse(json);
        return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
        return [];
    }
}

function nextFindingId(prefix: string, used: Set<string>): string {
    let n = used.size;
    while (used.has(prefix + n)) n++;
    used.add(prefix + n);
    return prefix + n;
}

const findingKey = (f: Finding) =>
    [canonicalReviewFilePath(f.file), f.line ?? "", f.side ?? "", f.comment.trim()].join("|");
const semanticFindingKey = (f: SemanticFinding) =>
    [f.title.trim().toLowerCase(), f.comment.trim()].join("|");

export interface AppendedFindings {
    review: ReviewRow;
    findings: Finding[];
    semanticFindings: SemanticFinding[];
    duplicates: number;
}

/**
 * Stage more findings on the finished review a reviewer session produced (the
 * reviewer chat's follow-ups). Existing findings, their posted state and the
 * review status are untouched; exact repeats are skipped.
 */
export function appendReviewFindings(
    reviewerSessionId: string,
    findings: Finding[],
    semanticFindings: SemanticFinding[],
): AppendedFindings {
    const connection = requireDb();
    connection.exec("BEGIN IMMEDIATE");
    try {
        const row = getReviewByReviewerSession(reviewerSessionId);
        if (!row) {
            throw new Error("This session is no longer the reviewer of record for its PR, so its findings cannot be added.");
        }
        if (row.status !== "done") {
            throw new Error(`The review is ${row.status}; findings can only be added to a finished review.`);
        }
        const existing = parseStoredList<Finding>(row.findings_json);
        const existingSemantic = parseStoredList<SemanticFinding>(row.semantic_findings_json);
        const seen = new Set(existing.map(findingKey));
        const seenSemantic = new Set(existingSemantic.map(semanticFindingKey));
        const usedIds = new Set(existing.map((f) => String(f.id)));
        const usedSemanticIds = new Set(existingSemantic.map((f) => String(f.id)));

        let duplicates = 0;
        const fresh = <T,>(list: T[], keyOf: (item: T) => string, seenKeys: Set<string>) =>
            list.filter((item) => {
                const key = keyOf(item);
                if (seenKeys.has(key)) {
                    duplicates++;
                    return false;
                }
                seenKeys.add(key);
                return true;
            });
        // New ids never reuse an existing one, and ids/posted/rewrites from the
        // input are discarded: every added finding starts staged and unposted.
        const added = fresh(normalizeFindings(findings), findingKey, seen).map((f) => ({
            ...f,
            id: nextFindingId("f", usedIds),
            posted: false,
            humanizedComment: null,
        }));
        const addedSemantic = fresh(
            normalizeSemanticFindings(semanticFindings),
            semanticFindingKey,
            seenSemantic,
        ).map((f) => ({ ...f, id: nextFindingId("s", usedSemanticIds), posted: false, humanizedComment: null }));

        let review = row;
        if (added.length || addedSemantic.length) {
            review = {
                ...row,
                findings_json: added.length ? JSON.stringify([...existing, ...added]) : row.findings_json,
                semantic_findings_json: addedSemantic.length
                    ? JSON.stringify([...existingSemantic, ...addedSemantic])
                    : row.semantic_findings_json,
                updated_at: new Date().toISOString(),
            };
            connection
                .prepare(
                    "UPDATE reviews SET findings_json = ?, semantic_findings_json = ?, updated_at = ? WHERE review_key = ?",
                )
                .run(review.findings_json, review.semantic_findings_json, review.updated_at, row.review_key);
        }
        connection.exec("COMMIT");
        return { review, findings: added, semanticFindings: addedSemantic, duplicates };
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

/** Store the latest generated rewrite on its scoped finding for reuse on reopen. */
export function setFindingHumanizedComment(
    identity: ReviewIdentity,
    findingId: string,
    humanizedComment: string,
): Finding {
    const row = getReview(identity);
    if (!row?.findings_json) throw new Error("review findings not found");

    let list: Finding[];
    try {
        const parsed = JSON.parse(row.findings_json);
        if (!Array.isArray(parsed)) throw new Error("invalid review findings");
        list = parsed as Finding[];
    } catch (e) {
        throw new Error(`invalid review findings: ${(e as Error).message}`);
    }

    const finding = list.find((item) => String(item.id) === String(findingId));
    if (!finding) throw new Error("finding not found");
    finding.humanizedComment = humanizedComment;
    requireDb()
        .prepare("UPDATE reviews SET findings_json = ?, updated_at = ? WHERE review_key = ?")
        .run(JSON.stringify(list), new Date().toISOString(), row.review_key);
    return finding;
}

function updateSemanticFinding(
    identity: ReviewIdentity,
    semanticFindingId: string,
    update: (finding: SemanticFinding) => void,
): SemanticFinding {
    const row = getReview(identity);
    if (!row?.semantic_findings_json) throw new Error("semantic review findings not found");

    let list: SemanticFinding[];
    try {
        const parsed = JSON.parse(row.semantic_findings_json);
        if (!Array.isArray(parsed)) throw new Error("invalid semantic review findings");
        list = parsed as SemanticFinding[];
    } catch (e) {
        throw new Error(`invalid semantic review findings: ${(e as Error).message}`);
    }

    const finding = list.find((item) => String(item.id) === String(semanticFindingId));
    if (!finding) throw new Error("semantic finding not found");
    update(finding);
    requireDb()
        .prepare(
            "UPDATE reviews SET semantic_findings_json = ?, updated_at = ? WHERE review_key = ?",
        )
        .run(JSON.stringify(list), new Date().toISOString(), row.review_key);
    return finding;
}

export function markSemanticFindingPosted(
    identity: ReviewIdentity,
    semanticFindingId: string,
): SemanticFinding {
    return updateSemanticFinding(identity, semanticFindingId, (finding) => {
        finding.posted = true;
    });
}

export function setSemanticFindingHumanizedComment(
    identity: ReviewIdentity,
    semanticFindingId: string,
    humanizedComment: string,
): SemanticFinding {
    return updateSemanticFinding(identity, semanticFindingId, (finding) => {
        finding.humanizedComment = humanizedComment;
    });
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

// ---------------------------------------------------------------------------
// Per-PR "I commented" activity cache (see comment-activity.mts).
// ---------------------------------------------------------------------------
export interface CommentActivityRow {
    org: string;
    project: string;
    repoId: string;
    prId: string;
    meId: string;
    commented: boolean;
    checkedAt: number; // epoch ms when the observation started
}

export function listCommentActivity(org: string, meId: string): CommentActivityRow[] {
    const rows = requireDb()
        .prepare(
            `SELECT org, project, repo_id, pr_id, me_id, commented, checked_at
             FROM pr_comment_activity WHERE org = ? AND me_id = ?`,
        )
        .all(org, meId) as any[];
    return rows.map((r) => ({
        org: r.org,
        project: r.project,
        repoId: r.repo_id,
        prId: r.pr_id,
        meId: r.me_id,
        commented: !!r.commented,
        checkedAt: Number(r.checked_at),
    }));
}

/** Upsert one observation; an older observation never overwrites a newer one. */
export function saveCommentActivity(row: CommentActivityRow): void {
    requireDb()
        .prepare(
            `INSERT INTO pr_comment_activity
                 (org, project, repo_id, pr_id, me_id, commented, checked_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (org, me_id, project, repo_id, pr_id) DO UPDATE SET
                 commented = excluded.commented, checked_at = excluded.checked_at
             WHERE excluded.checked_at >= pr_comment_activity.checked_at`,
        )
        .run(row.org, row.project, row.repoId, row.prId, row.meId, row.commented ? 1 : 0, row.checkedAt);
}

export function pruneCommentActivity(olderThanMs: number): number {
    const info = requireDb()
        .prepare("DELETE FROM pr_comment_activity WHERE checked_at < ?")
        .run(olderThanMs);
    return Number(info.changes ?? 0);
}

// ---------------------------------------------------------------------------
// Per-PR last push and my last comment or vote (see pr-recency.mts).
// ---------------------------------------------------------------------------
export type MyKind = "comment" | "vote";

export interface PrRecencyRow {
    org: string;
    project: string;
    repoId: string;
    prId: string;
    meId: string;
    head: string; // the head commit this was read at; "" when only my activity is known
    pushedAt: number | null;
    myAt: number | null;
    myKind: MyKind | null;
    checkedAt: number; // epoch ms when the read started; 0 when only my activity is known
}

const asKind = (v: unknown): MyKind | null => (v === "comment" || v === "vote" ? v : null);
const asMs = (v: unknown): number | null => (v == null ? null : Number(v));

export function listPrRecency(org: string, meId: string): PrRecencyRow[] {
    const rows = requireDb()
        .prepare(
            `SELECT org, project, repo_id, pr_id, me_id, head, pushed_at, my_at, my_kind, checked_at
             FROM pr_recency WHERE org = ? AND me_id = ?`,
        )
        .all(org, meId) as any[];
    return rows.map((r) => ({
        org: r.org,
        project: r.project,
        repoId: r.repo_id,
        prId: r.pr_id,
        meId: r.me_id,
        head: r.head,
        pushedAt: asMs(r.pushed_at),
        myAt: asMs(r.my_at),
        myKind: asKind(r.my_kind),
        checkedAt: Number(r.checked_at),
    }));
}

/**
 * Upsert one observation. The newer read wins the head and push time; my
 * activity only ever moves forward, so an in-app comment recorded while a read
 * was in flight isn't lost.
 */
export function savePrRecency(row: PrRecencyRow): void {
    requireDb()
        .prepare(
            `INSERT INTO pr_recency
                 (org, project, repo_id, pr_id, me_id, head, pushed_at, my_at, my_kind, checked_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (org, me_id, project, repo_id, pr_id) DO UPDATE SET
                 head = CASE WHEN excluded.checked_at >= pr_recency.checked_at
                             THEN excluded.head ELSE pr_recency.head END,
                 pushed_at = CASE WHEN excluded.checked_at >= pr_recency.checked_at
                                  THEN excluded.pushed_at ELSE pr_recency.pushed_at END,
                 checked_at = MAX(excluded.checked_at, pr_recency.checked_at),
                 my_kind = CASE WHEN excluded.my_at IS NOT NULL
                                 AND (pr_recency.my_at IS NULL OR excluded.my_at > pr_recency.my_at)
                                THEN excluded.my_kind ELSE pr_recency.my_kind END,
                 my_at = CASE WHEN excluded.my_at IS NOT NULL
                               AND (pr_recency.my_at IS NULL OR excluded.my_at > pr_recency.my_at)
                              THEN excluded.my_at ELSE pr_recency.my_at END`,
        )
        .run(
            row.org, row.project, row.repoId, row.prId, row.meId, row.head,
            row.pushedAt, row.myAt, row.myKind, row.checkedAt,
        );
}

/** Rows with no read and no activity of mine since the cutoff. */
export function prunePrRecency(olderThanMs: number): number {
    const info = requireDb()
        .prepare("DELETE FROM pr_recency WHERE MAX(checked_at, COALESCE(my_at, 0)) < ?")
        .run(olderThanMs);
    return Number(info.changes ?? 0);
}

/** Inbox events older than the cutoff; the inbox shows the latest 50. */
export function pruneNotifications(olderThanMs: number): number {
    const info = requireDb()
        .prepare("DELETE FROM notifications WHERE created_at < ?")
        .run(new Date(olderThanMs).toISOString());
    return Number(info.changes ?? 0);
}

/**
 * One org's watches with no sign of life since the cutoff. Discovery refreshes
 * every watch on an active PR each poll, and the poll touches a watch whose
 * thread gets a new comment, so these are quiet PRs that left the user's lists;
 * polling them forever would make every poll slower. The caller picks a cutoff
 * from the org's poll progress, so a closed app or a failing org never loses a
 * watch it hasn't polled yet.
 */
export function pruneInboxWatches(org: string, olderThanMs: number): number {
    const info = requireDb()
        .prepare("DELETE FROM inbox_watches WHERE org = ? AND updated_at < ?")
        .run(org, new Date(olderThanMs).toISOString());
    return Number(info.changes ?? 0);
}

export function listInboxWatchOrgs(): string[] {
    return (requireDb().prepare("SELECT DISTINCT org FROM inbox_watches").all() as unknown as { org: string }[]).map((r) => r.org);
}

/** Marks a watch as still active without changing anything else about it. */
export function touchInboxWatch(watchKey: string, at = new Date().toISOString()): void {
    requireDb().prepare("UPDATE inbox_watches SET updated_at = ? WHERE watch_key = ? AND updated_at < ?").run(at, watchKey, at);
}

export function deleteInboxWatch(watchKey: string): void {
    requireDb().prepare("DELETE FROM inbox_watches WHERE watch_key = ?").run(watchKey);
}

/** Finished review jobs older than the cutoff. Their review results stay in `reviews`. */
export function pruneReviewJobs(olderThanMs: number): number {
    const info = requireDb()
        .prepare("DELETE FROM review_jobs WHERE status IN ('done','error') AND updated_at < ?")
        .run(new Date(olderThanMs).toISOString());
    return Number(info.changes ?? 0);
}

// ---------------------------------------------------------------------------
// Durable inbox watches — the set of PRs/threads the poller must keep
// checking for new peer activity, independent of whether ADO's "active PRs"
// listing still returns them (a completed PR still needs its watched thread
// polled for late replies).
// ---------------------------------------------------------------------------

export type InboxWatchKind = "authored" | "participated";

export interface InboxWatchRow {
    watch_key: string;
    kind: InboxWatchKind;
    org: string;
    project: string | null;
    repo: string | null;
    repo_id: string | null;
    pr_id: string;
    thread_id: string | null;
    title: string | null;
    url: string | null;
    pr_status: string | null;
    last_user_comment_id: string | null;
    last_user_comment_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface InboxWatchInput {
    kind: InboxWatchKind;
    org: string;
    project?: string | null;
    repo?: string | null;
    repoId?: string | null;
    prId: string | number;
    /** Required for kind === "participated"; ignored (stored as NULL) for "authored". */
    threadId?: string | number | null;
    title?: string | null;
    url?: string | null;
    prStatus?: string | null;
    lastUserCommentId?: string | number | null;
    lastUserCommentAt?: string | null;
}

/** Deterministic scoped key: same shape family as notification ids, so a watch
 *  for one PR/thread never collides with the "same" PR number in another
 *  org/project/repo. */
export function inboxWatchKey(input: {
    kind: InboxWatchKind;
    org: string;
    project?: string | null;
    repoId?: string | null;
    prId: string | number;
    threadId?: string | number | null;
}): string {
    const threadPart = input.kind === "authored" ? "*" : String(input.threadId ?? "");
    return [input.org, input.project ?? "", input.repoId ?? "", String(input.prId), threadPart].join("::");
}

/** Insert or refresh one durable watch. Participation evidence (last user
 *  comment id/timestamp) only ever moves forward — a stale poll can never
 *  regress it. Returns the up-to-date row plus whether this watch is new
 *  (callers use that to decide whether to apply the bounded backfill window
 *  instead of the normal incremental cutoff). */
export function upsertInboxWatch(input: InboxWatchInput): { row: InboxWatchRow; created: boolean } {
    if (input.kind === "participated" && (input.threadId == null || String(input.threadId).trim() === "")) {
        throw new Error("a participated watch requires threadId");
    }
    const key = inboxWatchKey(input);
    const now = new Date().toISOString();
    const db = requireDb();
    const existing = db.prepare("SELECT * FROM inbox_watches WHERE watch_key = ?").get(key) as unknown as
        | InboxWatchRow
        | undefined;
    const created = !existing;

    let lastCommentId = existing?.last_user_comment_id ?? null;
    let lastCommentAt = existing?.last_user_comment_at ?? null;
    if (input.lastUserCommentAt && (!lastCommentAt || input.lastUserCommentAt > lastCommentAt)) {
        lastCommentAt = input.lastUserCommentAt;
        lastCommentId = input.lastUserCommentId != null ? String(input.lastUserCommentId) : lastCommentId;
    }

    const title = input.title ?? existing?.title ?? null;
    const url = input.url ?? existing?.url ?? null;
    const repo = input.repo ?? existing?.repo ?? null;
    const prStatus = input.prStatus ?? existing?.pr_status ?? null;

    db.prepare(
        `INSERT INTO inbox_watches
            (watch_key, kind, org, project, repo, repo_id, pr_id, thread_id, title, url, pr_status,
             last_user_comment_id, last_user_comment_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(watch_key) DO UPDATE SET
            title = excluded.title,
            url = excluded.url,
            repo = excluded.repo,
            pr_status = excluded.pr_status,
            last_user_comment_id = excluded.last_user_comment_id,
            last_user_comment_at = excluded.last_user_comment_at,
            updated_at = excluded.updated_at`,
    ).run(
        key,
        input.kind,
        input.org,
        input.project ?? null,
        repo,
        input.repoId ?? null,
        String(input.prId),
        input.kind === "participated" ? String(input.threadId) : null,
        title,
        url,
        prStatus,
        lastCommentId,
        lastCommentAt,
        existing?.created_at ?? now,
        now,
    );
    const row = db.prepare("SELECT * FROM inbox_watches WHERE watch_key = ?").get(key) as unknown as InboxWatchRow;
    return { row, created };
}

/** All durable watches, optionally scoped to one org (the poller's unit of work). */
export function listInboxWatches(org?: string): InboxWatchRow[] {
    if (org) {
        return requireDb()
            .prepare("SELECT * FROM inbox_watches WHERE org = ? ORDER BY pr_id, thread_id")
            .all(org) as unknown as InboxWatchRow[];
    }
    return requireDb().prepare("SELECT * FROM inbox_watches ORDER BY org, pr_id, thread_id").all() as unknown as InboxWatchRow[];
}
