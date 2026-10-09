import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const tempDir = await mkdtemp(join(tmpdir(), "ado-pr-ops-semantic-review-"));
const dbPath = join(tempDir, "reviews.db");
process.env.ADO_PR_OPS_DB_PATH = dbPath;

const legacyDb = new DatabaseSync(dbPath);
legacyDb.exec(`
    CREATE TABLE reviews (
        review_key TEXT PRIMARY KEY, pr_id TEXT NOT NULL, org TEXT, project TEXT,
        repo TEXT, repo_id TEXT, title TEXT, status TEXT NOT NULL DEFAULT 'pending',
        summary TEXT, story TEXT, findings TEXT, findings_json TEXT, error TEXT,
        run_id TEXT, reviewer_session_id TEXT, dismissed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT, updated_at TEXT
    )
`);
legacyDb.close();

let store;
try {
    store = await import("../store.mjs");
    const { publishReview } = await import("../review-publish.mjs");
    const { buildReviewTask } = await import("../review-task.mjs");
    const { renderMarkdown } = await import("../reviews-md.mjs");
    await store.ensureDb();

    const target = { prId: "42", org: "org", project: "project", repoId: "repo-a" };
    const otherTarget = { ...target, repoId: "repo-b" };
    store.upsertReview({ ...target, repo: "repo-a", status: "running", runId: "run-1" });
    store.upsertReview({ ...otherTarget, repo: "repo-b", status: "done", findings: [] });

    await publishReview(
        {
            ...target,
            repo: "repo-a",
            title: "Semantic review",
            runId: "run-1",
            status: "done",
            summary: "The change has one high-level compatibility concern.",
            story: "This change updates a persisted contract.",
            findings: [
                {
                    file: "src/store.mts",
                    line: 42,
                    side: "right",
                    severity: "high",
                    title: "Keep older review records readable",
                    comment:
                        "Could we keep a compatible default here? Older review records do not have this field, so requiring it would make existing data fail to load.",
                    technicalExplanation:
                        "The persisted review format is read without a migration step. Existing rows therefore deserialize without the newly added property. Treating that property as required at read time changes the storage contract retroactively and causes valid historical reviews to fail validation. The write path can require the field for new reviews, but the read path should preserve a fallback for legacy rows.",
                },
            ],
            semanticFindings: [
                {
                    category: "compatibility",
                    severity: "high",
                    title: "Existing records need a migration path",
                    comment:
                        "The new required field makes previously stored records unreadable. Add a migration or retain a compatible default.",
                    files: ["src/store.mts", "src/api.mts"],
                },
            ],
        },
        target,
        "reviewer-session",
    );

    const row = store.getReview(target);
    const findings = JSON.parse(row.findings_json);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, "f0");
    assert.match(findings[0].comment, /^Could we /);
    assert.match(findings[0].technicalExplanation, /persisted review format/);
    const semanticFindings = JSON.parse(row.semantic_findings_json);
    assert.equal(semanticFindings.length, 1);
    assert.equal(semanticFindings[0].id, "s0");
    assert.equal(semanticFindings[0].posted, false);
    // Files are stored in ADO's canonical leading-slash form so they match diff paths.
    assert.deepEqual(semanticFindings[0].files, ["/src/store.mts", "/src/api.mts"]);

    const humanized = store.setSemanticFindingHumanizedComment(
        target,
        "s0",
        "Could we add a migration or compatible default for existing records?",
    );
    assert.equal(
        humanized.humanizedComment,
        "Could we add a migration or compatible default for existing records?",
    );
    store.markSemanticFindingPosted(target, "s0");
    assert.equal(JSON.parse(store.getReview(target).semantic_findings_json)[0].posted, true);
    assert.equal(
        JSON.parse(store.getReview(otherTarget).semantic_findings_json || "[]").length,
        0,
        "same PR number in another repo must stay untouched",
    );

    const markdown = renderMarkdown(store.getReview(target));
    assert.match(markdown, /## Semantic findings/);
    assert.match(markdown, /Existing records need a migration path/);

    const prompt = buildReviewTask({
        prId: "42",
        prContext: "# PR context",
        org: "org",
        project: "project",
        repo: "repo-a",
        repoId: "repo-a",
        title: "Semantic review",
        runId: "run-2",
    });
    assert.match(prompt, /semanticFindings/);
    assert.match(prompt, /intent alignment/i);
    assert.match(prompt, /architecture/i);
    assert.match(prompt, /backward compatibility/i);
    assert.match(prompt, /operability/i);
    assert.match(prompt, /human reviewer/i);
    assert.match(prompt, /plain English/i);
    assert.match(prompt, /technicalExplanation/);
    assert.match(prompt, /in-depth technical explanation/i);
    assert.match(prompt, /`publish_review` tool/);
    assert.doesNotMatch(prompt, /invoke_canvas_action|canvas/i);

    await assert.rejects(
        () =>
            publishReview(
                { ...target, runId: "run-other", status: "error", error: "x" },
                { ...target, runId: "run-1" },
                "reviewer-session",
            ),
        /does not match this review's PR/,
        "a session may only publish the run it was started for",
    );

    await assert.rejects(
        () =>
            publishReview(
                {
                    ...target,
                    runId: "run-1",
                    status: "done",
                    summary: "Invalid",
                    story: "Invalid",
                    findings: [
                        {
                            file: "src/store.mts",
                            line: 42,
                            side: "right",
                            severity: "high",
                            title: "Missing explanation",
                            comment: "Could we keep this compatible with older records?",
                        },
                    ],
                    semanticFindings: [],
                },
                target,
                "reviewer-session",
            ),
        /findings\[0\]\.technicalExplanation is required/,
    );

    await assert.rejects(
        () =>
            publishReview(
                {
                    ...target,
                    runId: "run-1",
                    status: "done",
                    summary: "Invalid",
                    story: "Invalid",
                    findings: [],
                    semanticFindings: [
                        {
                            category: "style",
                            severity: "low",
                            title: "Not semantic",
                            comment: "Style belongs in inline findings.",
                        },
                    ],
                },
                target,
                "reviewer-session",
            ),
        /semanticFindings\[0\]\.category is invalid/,
    );

    console.log("Semantic review harness passed");
} finally {
    store?.closeDb();
    await rm(tempDir, { recursive: true, force: true });
}
