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
    error: string | null;
    created_at: string | null;
    updated_at: string | null;
}

/** Compact row used for list badges. */
export type ReviewListItem = Pick<ReviewRow, "pr_id" | "status" | "summary" | "updated_at">;

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
    findings?: string | null;
    error?: string | null;
}

let db: DatabaseSync | null = null;

export async function ensureDb(): Promise<DatabaseSync> {
    if (db) return db;
    await mkdir(DATA_DIR, { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec(`
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
    return db;
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
        .prepare("SELECT pr_id, status, summary, updated_at FROM reviews ORDER BY updated_at DESC")
        .all() as unknown as ReviewListItem[];
}

// Merge-then-replace so a partial write (e.g. the canvas marking status='running')
// never clobbers fields a later write (the agent's story/findings) has yet to add,
// and vice-versa. Only keys present & non-null in `r` overwrite existing values.
type MergeKey = "org" | "project" | "repo" | "title" | "summary" | "story" | "findings" | "error";

export function upsertReview(r: ReviewInput): ReviewRow {
    const now = new Date().toISOString();
    const prId = String(r.prId);
    const ex: Partial<ReviewRow> = getReview(prId) || {};
    const pick = (k: MergeKey): string | null => (r[k] != null ? r[k]! : ex[k] != null ? ex[k]! : null);
    const row: ReviewRow = {
        pr_id: prId,
        org: pick("org"),
        project: pick("project"),
        repo: pick("repo"),
        title: pick("title"),
        status: r.status != null ? r.status : ex.status != null ? ex.status : "pending",
        summary: pick("summary"),
        story: pick("story"),
        findings: pick("findings"),
        error: pick("error"),
        created_at: ex.created_at != null ? ex.created_at : now,
        updated_at: now,
    };
    requireDb()
        .prepare(
            `INSERT OR REPLACE INTO reviews
             (pr_id, org, project, repo, title, status, summary, story, findings, error, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
            row.pr_id, row.org, row.project, row.repo, row.title, row.status,
            row.summary, row.story, row.findings, row.error, row.created_at, row.updated_at,
        );
    return row;
}
