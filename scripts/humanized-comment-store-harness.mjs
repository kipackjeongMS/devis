import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = await mkdtemp(join(tmpdir(), "ado-pr-ops-humanized-comment-"));
process.env.ADO_PR_OPS_DB_PATH = join(tempDir, "reviews.db");

let store;
try {
    store = await import("../store.mjs");
    await store.ensureDb();

    const first = { prId: "42", org: "org", project: "project", repoId: "repo-a" };
    const second = { prId: "42", org: "org", project: "project", repoId: "repo-b" };
    const finding = {
        id: "f0",
        file: "src/app.ts",
        line: 10,
        comment: "Could we simplify this branch before merging?",
        technicalExplanation:
            "The current branch duplicates the same condition in two paths, which can cause the paths to diverge.",
    };

    store.upsertReview({ ...first, status: "done", findings: [finding] });
    store.upsertReview({ ...second, status: "done", findings: [finding] });

    const updated = store.setFindingHumanizedComment(first, "f0", "Please simplify this branch.");
    assert.equal(updated.humanizedComment, "Please simplify this branch.");

    const firstFindings = JSON.parse(store.getReview(first).findings_json);
    const secondFindings = JSON.parse(store.getReview(second).findings_json);
    assert.equal(firstFindings[0].humanizedComment, "Please simplify this branch.");
    assert.match(firstFindings[0].technicalExplanation, /duplicates the same condition/);
    assert.equal(secondFindings[0].humanizedComment, null, "same PR number in another repo must stay untouched");

    const rephrased = store.setFindingHumanizedComment(first, "f0", "Could we simplify this branch?");
    assert.equal(rephrased.humanizedComment, "Could we simplify this branch?");
    assert.equal(
        JSON.parse(store.getReview(first).findings_json)[0].humanizedComment,
        "Could we simplify this branch?",
        "rephrasing should replace the persisted text",
    );

    assert.throws(
        () => store.setFindingHumanizedComment(first, "missing", "No match"),
        /finding not found/,
    );

    console.log("Rephrased comment store harness passed");
} finally {
    store?.closeDb();
    await rm(tempDir, { recursive: true, force: true });
}
