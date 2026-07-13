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
    severity?: string | null; // "high" | "medium" | "low" | "nit"
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
    // Legacy: freeform markdown. Structured: an array of anchored Findings
    // (or a single Finding object — PowerShell's ConvertTo-Json can collapse a
    // one-element array into a bare object).
    findings?: string | Finding | Finding[] | null;
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
    // Migration: structured, line-anchored findings (staged inline comments).
    const cols = db.prepare("PRAGMA table_info(reviews)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "findings_json")) {
        db.exec("ALTER TABLE reviews ADD COLUMN findings_json TEXT");
    }
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
        created_at: ex.created_at != null ? ex.created_at : now,
        updated_at: now,
    };
    requireDb()
        .prepare(
            `INSERT OR REPLACE INTO reviews
             (pr_id, org, project, repo, title, status, summary, story, findings, findings_json, error, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
            row.pr_id, row.org, row.project, row.repo, row.title, row.status,
            row.summary, row.story, row.findings, row.findings_json, row.error, row.created_at, row.updated_at,
        );
    return row;
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
