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
    pr_id: string;
    org: string | null;
    project: string | null;
    repo: string | null;
    title: string | null;
    status: string;
    summary: string | null;
    story: string | null;
    findings: string | null;
    findings_json: string | null;
    error: string | null;
    run_id: string | null;
    // Legacy mirror of the My Plate preference. Kept for stored-review compatibility.
    // A fresh review clears both this field and the dedicated preference row.
    // fresh review starts, so a re-review re-surfaces it.
    dismissed: number;
    created_at: string | null;
    updated_at: string | null;
}

/** Compact row used for list badges. */
export type ReviewListItem = Pick<ReviewRow, "pr_id" | "status" | "summary" | "dismissed" | "updated_at">;

/** The POST payload an agent (or the canvas) writes; only `prId` is required. */
export interface ReviewInput {
    prId: string | number;
    org?: string | null;
    project?: string | null;
    repo?: string | null;
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
                pr_id      TEXT PRIMARY KEY,
                org        TEXT,
                project    TEXT,
                repo       TEXT,
                title      TEXT,
                status     TEXT NOT NULL DEFAULT 'pending',
                summary    TEXT,
                story      TEXT,
                findings   TEXT,
                error      TEXT,
                created_at TEXT,
                updated_at TEXT
            );
        `);
        // Re-check under the write lock so parallel extension processes cannot
        // both attempt the same ALTER TABLE migration.
        const cols = connection.prepare("PRAGMA table_info(reviews)").all() as Array<{ name: string }>;
        if (!cols.some((c) => c.name === "findings_json")) {
            connection.exec("ALTER TABLE reviews ADD COLUMN findings_json TEXT");
        }
        if (!cols.some((c) => c.name === "dismissed")) {
            connection.exec("ALTER TABLE reviews ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0");
        }
        if (!cols.some((c) => c.name === "run_id")) {
            connection.exec("ALTER TABLE reviews ADD COLUMN run_id TEXT");
        }
        // My Plate can now contain activity-only PRs with no Copilot review row,
        // so dismissal state has its own table. Preserve existing user choices.
        connection.exec(`
            CREATE TABLE IF NOT EXISTS plate_preferences (
                pr_id      TEXT PRIMARY KEY,
                dismissed INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT
            );
            INSERT OR IGNORE INTO plate_preferences (pr_id, dismissed, updated_at)
            SELECT pr_id, 1, updated_at FROM reviews WHERE dismissed = 1;
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

export function getReview(prId: string | number): ReviewRow | null {
    return (
        (requireDb().prepare("SELECT * FROM reviews WHERE pr_id = ?").get(String(prId)) as
            | ReviewRow
            | undefined) || null
    );
}

export function listReviews(): ReviewListItem[] {
    return requireDb()
        .prepare("SELECT pr_id, status, summary, dismissed, updated_at FROM reviews ORDER BY updated_at DESC")
        .all() as unknown as ReviewListItem[];
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

/**
 * Set (or clear) the legacy review-row dismissal flag for one or more PRs.
 */
export function setDismissed(prIds: Array<string | number>, dismissed: boolean): number {
    const ids = prIds.map(String).filter((s) => s.trim() !== "");
    if (!ids.length) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const info = requireDb()
        .prepare(`UPDATE reviews SET dismissed = ?, updated_at = ? WHERE pr_id IN (${placeholders})`)
        .run(dismissed ? 1 : 0, new Date().toISOString(), ...ids);
    return Number(info.changes ?? 0);
}

/** Every PR currently hidden from My Plate, including activity-only PRs. */
export function listPlateDismissals(): Set<string> {
    const rows = requireDb()
        .prepare("SELECT pr_id FROM plate_preferences WHERE dismissed = 1")
        .all() as Array<{ pr_id: string }>;
    return new Set(rows.map((row) => row.pr_id));
}

/** Persist a My Plate removal even when the PR has no background-review row. */
export function setPlateDismissed(prIds: Array<string | number>, dismissed: boolean): number {
    const ids = prIds.map(String).filter((s) => s.trim() !== "");
    if (!ids.length) return 0;
    const stmt = requireDb().prepare(
        `INSERT INTO plate_preferences (pr_id, dismissed, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(pr_id) DO UPDATE SET dismissed = excluded.dismissed, updated_at = excluded.updated_at`,
    );
    const now = new Date().toISOString();
    let changed = 0;
    for (const id of ids) {
        const info = stmt.run(id, dismissed ? 1 : 0, now);
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
    const ex: Partial<ReviewRow> = getReview(prId) || {};
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
        pr_id: prId,
        org: pick("org"),
        project: pick("project"),
        repo: pick("repo"),
        title: pick("title"),
        status: r.status != null ? r.status : ex.status != null ? ex.status : "pending",
        summary: pick("summary"),
        story: pick("story"),
        findings,
        findings_json: findingsJson,
        error: pick("error"),
        run_id: r.runId != null ? r.runId : ex.run_id != null ? ex.run_id : null,
        // A fresh review (status flips to "running") re-surfaces a previously
        // dismissed PR in My Plate; otherwise the user's choice is preserved.
        dismissed: r.status === "running" ? 0 : (ex.dismissed ?? 0),
        created_at: ex.created_at != null ? ex.created_at : now,
        updated_at: now,
    };
    requireDb()
        .prepare(
            `INSERT OR REPLACE INTO reviews
             (pr_id, org, project, repo, title, status, summary, story, findings, findings_json, error, run_id, dismissed, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
            row.pr_id, row.org, row.project, row.repo, row.title, row.status,
            row.summary, row.story, row.findings, row.findings_json, row.error, row.run_id,
            row.dismissed, row.created_at, row.updated_at,
        );
    if (r.status === "running") setPlateDismissed([prId], false);
    return row;
}

/** Complete only the currently-active launch, preventing stale child overwrites. */
export function publishReviewRun(r: ReviewInput & { runId: string }): ReviewRow {
    const connection = requireDb();
    connection.exec("BEGIN IMMEDIATE");
    try {
        const current = getReview(r.prId);
        if (current?.run_id && current.run_id !== r.runId) {
            throw new Error("This review run is stale and can no longer publish");
        }
        const row = upsertReview(r);
        connection.exec("COMMIT");
        return row;
    } catch (e) {
        connection.exec("ROLLBACK");
        throw e;
    }
}

/** Mark one staged finding as posted (survives the next review re-render/poll). */
export function markFindingPosted(prId: string | number, findingId: string): Finding[] {
    const row = getReview(prId);
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
            .prepare("UPDATE reviews SET findings_json = ?, updated_at = ? WHERE pr_id = ?")
            .run(JSON.stringify(list), new Date().toISOString(), String(prId));
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
