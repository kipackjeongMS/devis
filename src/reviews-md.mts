// One-way markdown mirror of completed reviews. SQLite (store.mts) stays the
// canonical operational store; this derives a human-readable record file per PR
// at <reviewsDir>/<RepoName>/<prId>-<title>.md for the user's notes vault.
//
// Contract: NEVER throw into the request path. Any failure (bad path, offline
// OneDrive, permissions) is logged to stderr and swallowed — the mirror is a
// convenience, not a dependency. stdout is the JSON-RPC pipe, so only
// console.error (stderr) is safe here.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readConfig } from "./config.mjs";
import type { ReviewRow, Finding } from "./store.mjs";

// Characters Windows forbids in file/dir names, plus control chars.
const ILLEGAL = /[<>:"/\\|?*\x00-\x1f]/g;

/** Make one path segment safe for Windows: strip illegal chars, collapse
 *  whitespace, trim trailing dots/spaces, cap length. Falls back when empty. */
function sanitizeSegment(input: string | null | undefined, fallback: string): string {
    const s = String(input ?? "")
        .replace(ILLEGAL, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[. ]+$/, "") // Windows: no trailing dot/space
        .slice(0, 120)
        .trim();
    return s || fallback;
}

const SEV_ICON: Record<string, string> = {
    high: "🔴",
    medium: "🟠",
    low: "🟡",
    nit: "⚪",
};

// Severity ordering for the findings list (high first). Anything unknown sinks
// to the bottom.
const SEV_RANK: Record<string, number> = { high: 0, medium: 1, low: 2, nit: 3 };

function sevRank(sev: string | null | undefined): number {
    const r = SEV_RANK[(sev || "").toLowerCase()];
    return r == null ? 4 : r;
}

/** One finding as a markdown block, mirroring an inline diff comment. */
function renderFinding(f: Finding): string {
    const sev = (f.severity || "").toLowerCase();
    const icon = SEV_ICON[sev] || "•";
    const sevLabel = f.severity ? String(f.severity) : "note";
    const lineRange = f.line != null ? `:${f.line}${f.endLine != null && f.endLine !== f.line ? `-${f.endLine}` : ""}` : "";
    const loc = f.file ? `\`${f.file}${lineRange}\`` : "_general_";
    const heading = f.title ? `${icon} ${sevLabel} · ${f.title}` : `${icon} ${sevLabel} · ${loc}`;
    const locLine = f.title && f.file ? `${loc}\n\n` : "";
    const comment = (f.comment || "").trim();
    return `### ${heading}\n\n${locLine}${comment}\n`;
}

/** Parse the structured findings array off a row (JSON column first). */
function parseFindings(row: ReviewRow): Finding[] {
    if (!row.findings_json) return [];
    try {
        const parsed = JSON.parse(row.findings_json);
        return Array.isArray(parsed) ? (parsed as Finding[]) : [];
    } catch {
        return [];
    }
}

/** Build the ADO pull-request URL when we have enough context, else null. */
function prUrl(row: ReviewRow): string | null {
    if (!row.org || !row.project || !row.repo || !row.pr_id) return null;
    const e = encodeURIComponent;
    return `https://dev.azure.com/${e(row.org)}/${e(row.project)}/_git/${e(row.repo)}/pullrequest/${e(String(row.pr_id))}`;
}

/** Compact bold metadata line under the title. */
function metaLine(row: ReviewRow): string {
    const bits: string[] = [];
    const url = prUrl(row);
    bits.push(url ? `**PR:** [${row.pr_id}](${url})` : `**PR:** ${row.pr_id}`);
    if (row.repo) bits.push(`**Repo:** ${row.repo}`);
    const when = row.updated_at || "";
    const day = /^\d{4}-\d{2}-\d{2}/.test(when) ? when.slice(0, 10) : when;
    if (day) bits.push(`**Reviewed:** ${day}`);
    // The session that produced the review: resume it with
    // `copilot --resume <id>` to pick the review back up later.
    if (row.reviewer_session_id) bits.push(`**Session:** \`${row.reviewer_session_id}\``);
    return bits.join(" · ");
}

/**
 * Render a stored review row into a standalone markdown document that mirrors
 * the in-canvas review panel: title + one-line summary, then the semantic
 * story verbatim, then findings grouped by severity (the panel stages these as
 * inline diff comments; a file has no diff to attach to, so we list them).
 */
export function renderMarkdown(row: ReviewRow): string {
    const title = row.title || `PR ${row.pr_id}`;
    const parts: string[] = [`# Copilot Review — ${title}`];

    if (row.summary && row.summary.trim()) parts.push(`> ${row.summary.trim()}`);
    parts.push(metaLine(row));

    // Semantic story — the heart of the review, verbatim. May contain its own
    // "## What changed" bullets and ```mermaid fences, which Obsidian renders.
    if (row.story && row.story.trim()) {
        parts.push("## Semantic story");
        parts.push(row.story.trim());
    }

    const findings = parseFindings(row).sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
    if (findings.length) {
        parts.push("## Findings");
        parts.push(findings.map(renderFinding).join("\n"));
    } else if (row.findings && row.findings.trim()) {
        parts.push("## Findings");
        parts.push(row.findings.trim());
    }

    return parts.join("\n\n") + "\n";
}

/** True when a row carries enough to be worth mirroring (avoid empty files). */
function hasContent(row: ReviewRow): boolean {
    return !!(row.summary || row.story || row.findings || row.findings_json);
}

/** Outcome of an on-demand save, so the UI can give precise feedback. */
export interface SaveResult {
    saved: boolean;
    path?: string;
    /** Why nothing was written: "disabled" (no folder set), "empty" (no
     *  content), "not-done" (still running/error), or "error" (write failed). */
    reason?: "disabled" | "empty" | "not-done" | "error";
}

/**
 * Write a completed review's markdown record to disk on demand. Never rejects;
 * returns a SaveResult describing what happened so callers can surface it.
 */
export async function writeReviewMarkdown(row: ReviewRow): Promise<SaveResult> {
    try {
        // Only save finished, substantive reviews — not a "running" partial or a
        // content-less error row.
        if (row.status !== "done") return { saved: false, reason: "not-done" };
        if (!hasContent(row)) return { saved: false, reason: "empty" };

        const { reviewsDir } = await readConfig();
        if (!reviewsDir) return { saved: false, reason: "disabled" };

        const repoDir = sanitizeSegment(row.repo, "unknown-repo");
        const fileName = `${sanitizeSegment(String(row.pr_id), "0")}-${sanitizeSegment(row.title, "untitled")}.md`;
        const dir = join(reviewsDir, repoDir);
        await mkdir(dir, { recursive: true });
        const fullPath = join(dir, fileName);
        await writeFile(fullPath, renderMarkdown(row), "utf8");
        return { saved: true, path: fullPath };
    } catch (e) {
        // Non-fatal: the SQLite write already succeeded. stderr only.
        console.error(`[reviews-md] save failed for PR ${row?.pr_id}: ${(e as Error).message || e}`);
        return { saved: false, reason: "error" };
    }
}
