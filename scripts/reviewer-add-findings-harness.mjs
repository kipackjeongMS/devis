import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = await mkdtemp(join(tmpdir(), "ado-pr-ops-add-findings-"));
process.env.ADO_PR_OPS_DB_PATH = join(tempDir, "reviews.db");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const source = (relative) => readFile(new URL(relative, import.meta.url), "utf8");

let store;
try {
    store = await import("../store.mjs");
    const { addReviewFindings, ADD_REVIEW_FINDINGS_SCHEMA, PUBLISH_REVIEW_SCHEMA } = await import(
        "../review-publish.mjs"
    );
    await store.ensureDb();

    const scope = { org: "org", project: "project" };
    const targetA = { ...scope, prId: "101", repoId: "repo-a" };
    const targetB = { ...scope, prId: "202", repoId: "repo-b" };
    const targetC = { ...scope, prId: "303", repoId: "repo-c" };
    const targetD = { ...scope, prId: "404", repoId: "repo-d" };
    const targetE = { ...scope, prId: "505", repoId: "repo-e" };
    const targetI = { ...scope, prId: "909", repoId: "repo-i" };
    const targetJ = { ...scope, prId: "1010", repoId: "repo-j" };
    const allTargets = [targetA, targetB, targetC, targetD, targetE, targetI, targetJ];

    const inline = (over = {}) => ({
        file: "src/a.mts",
        line: 5,
        side: "right",
        severity: "medium",
        title: "A concern",
        comment: "Could we rename this?",
        technicalExplanation: "The name hides what the function really does.",
        ...over,
    });
    const semantic = (over = {}) => ({
        category: "behavior",
        severity: "medium",
        title: "Retry semantics unclear",
        comment: "Retries may duplicate writes.",
        files: ["src/a.mts"],
        ...over,
    });
    const list = (row, column = "findings_json") => JSON.parse(row[column] || "[]");
    const snap = (target) => JSON.stringify(store.getReview(target));
    const snapAll = () => allTargets.map(snap);
    const ids = (items) => items.map((item) => item.id);

    // ---- setup: A has 2 inline (one posted) + 1 semantic; the others are independent reviews ----
    store.upsertReview({
        ...targetA,
        repo: "repo-a",
        title: "PR A",
        status: "done",
        summary: "Summary A",
        story: "Story A",
        runId: "run-a",
        reviewerSessionId: "sess-a",
        findings: [
            inline(),
            inline({
                file: "src/b.mts",
                line: 9,
                side: "left",
                severity: "low",
                comment: "Nit: spacing here.",
            }),
        ],
        semanticFindings: [semantic()],
    });
    store.markFindingPosted(targetA, "f1");
    store.upsertReview({
        ...targetB,
        repo: "repo-b",
        title: "PR B",
        status: "done",
        summary: "Summary B",
        story: "Story B",
        runId: "run-b",
        reviewerSessionId: "sess-b",
        findings: [inline({ file: "src/other.mts", line: 1, comment: "Could we drop this import?" })],
    });
    // A new launch nulls the session, so this one is no longer anyone's reviewer of record.
    store.upsertReview({ ...targetC, repo: "repo-c", status: "done", summary: "C", reviewerSessionId: "sess-c" });
    store.upsertReview({ ...targetC, status: "running", runId: "run-c2" });
    // Sessions that are retained but whose review is not finished.
    store.upsertReview({ ...targetD, repo: "repo-d", status: "done", summary: "D", reviewerSessionId: "sess-d" });
    store.upsertReview({ ...targetD, status: "error", error: "boom" });
    store.upsertReview({ ...targetE, repo: "repo-e", status: "running", reviewerSessionId: "sess-e" });
    // Non-sequential existing ids; none of the new ones may reuse them.
    store.upsertReview({
        ...targetI,
        repo: "repo-i",
        status: "done",
        summary: "I",
        reviewerSessionId: "sess-i",
        findings: [
            inline({ id: "f2", file: "src/i1.mts", comment: "First." }),
            inline({ id: "f3", file: "src/i2.mts", comment: "Second." }),
        ],
        semanticFindings: [semantic({ id: "s0", title: "Existing one" }), semantic({ id: "s9", title: "Existing two" })],
    });
    // A done review with no stored findings at all.
    store.upsertReview({ ...targetJ, repo: "repo-j", status: "done", summary: "J", reviewerSessionId: "sess-j" });

    const rowA = store.getReview(targetA);
    assert.deepEqual(ids(list(rowA)), ["f0", "f1"]);
    assert.equal(list(rowA)[0].file, "/src/a.mts", "stored files use the canonical leading-slash form");
    assert.equal(list(rowA)[1].posted, true);
    assert.equal(list(rowA, "semantic_findings_json").length, 1);
    assert.equal(store.getReview(targetC).reviewer_session_id, null);
    assert.equal(store.getReview(targetD).reviewer_session_id, "sess-d");
    assert.equal(store.getReview(targetE).reviewer_session_id, "sess-e");

    // ---- lookup by reviewer session ----
    assert.equal(store.getReviewByReviewerSession("sess-a").pr_id, "101");
    assert.equal(store.getReviewByReviewerSession("sess-b").pr_id, "202");
    assert.ok(!store.getReviewByReviewerSession("sess-x"), "an unknown session has no review");
    assert.ok(!store.getReviewByReviewerSession("sess-c"), "a re-launched review released its old session");

    // When two reviews name the same session the most recently updated one wins.
    store.upsertReview({
        prId: "7001", org: "org", project: "project", repoId: "repo-old",
        status: "done", summary: "older", reviewerSessionId: "sess-shared",
    });
    await sleep(20);
    store.upsertReview({
        prId: "7002", org: "org", project: "project", repoId: "repo-new",
        status: "done", summary: "newer", reviewerSessionId: "sess-shared",
    });
    assert.equal(store.getReviewByReviewerSession("sess-shared").pr_id, "7002");

    // ---- add one inline + one semantic finding through the tool entry point ----
    const beforeA = store.getReview(targetA);
    const beforeB = snap(targetB);
    await sleep(20);
    const added = await addReviewFindings(
        {
            findings: [
                inline({
                    file: "src/new-file.mts",
                    line: 10,
                    side: "right",
                    severity: "high",
                    title: "New concern",
                    comment: "Could we guard this call?",
                    technicalExplanation: "The caller can pass undefined here.",
                    // Not part of the tool input contract; must never leak into storage.
                    id: "f0",
                    posted: true,
                    humanizedComment: "forged rewrite",
                }),
            ],
            semanticFindings: [
                semantic({
                    category: "testing",
                    severity: "high",
                    title: "No coverage for the failure path",
                    comment: "Nothing exercises the error branch.",
                    files: ["src/new-file.mts", "src/new-file.mts"],
                }),
            ],
        },
        "sess-a",
    );
    assert.equal(added.prId, "101");
    assert.equal(added.findings, 1);
    assert.equal(added.semanticFindings, 1);
    assert.equal(added.duplicates, 0);
    assert.match(added.message, /Added 1 inline finding\(s\) and 1 PR-level finding\(s\)/);
    assert.match(added.message, /PR #101/);
    assert.match(added.message, /staged in the PR detail view/);
    assert.match(added.message, /nothing was posted to Azure DevOps/);
    assert.doesNotMatch(added.message, /Skipped|Nothing new/);

    const afterA = store.getReview(targetA);
    const findingsA = list(afterA);
    const semanticA = list(afterA, "semantic_findings_json");
    assert.equal(findingsA.length, 3);
    assert.equal(semanticA.length, 2);
    assert.deepEqual(ids(findingsA), ["f0", "f1", "f2"], "the colliding input id f0 was replaced, not reused");
    assert.equal(new Set(ids(findingsA)).size, findingsA.length);
    assert.deepEqual(ids(semanticA), ["s0", "s1"]);
    assert.deepEqual(findingsA.slice(0, 2), list(beforeA).slice(0, 2), "existing findings are untouched");
    assert.equal(findingsA[0].posted, false);
    assert.equal(findingsA[1].posted, true, "the previously posted finding stays posted");
    assert.deepEqual(semanticA[0], list(beforeA, "semantic_findings_json")[0]);

    const newFinding = findingsA[2];
    assert.equal(newFinding.file, "/src/new-file.mts");
    assert.equal(newFinding.line, 10);
    assert.equal(newFinding.side, "right");
    assert.equal(newFinding.severity, "high");
    assert.equal(newFinding.title, "New concern");
    assert.equal(newFinding.comment, "Could we guard this call?");
    assert.equal(newFinding.technicalExplanation, "The caller can pass undefined here.");
    assert.equal(newFinding.posted, false);
    assert.equal(newFinding.humanizedComment, null);
    const newSemantic = semanticA[1];
    assert.equal(newSemantic.id, "s1");
    assert.equal(newSemantic.category, "testing");
    assert.equal(newSemantic.severity, "high");
    assert.deepEqual(newSemantic.files, ["/src/new-file.mts"]);
    assert.equal(newSemantic.posted, false);
    assert.equal(newSemantic.humanizedComment, null);

    for (const column of ["status", "summary", "story", "run_id", "reviewer_session_id", "title", "created_at", "error"]) {
        assert.equal(afterA[column], beforeA[column], `${column} is unchanged`);
    }
    assert.ok(afterA.updated_at > beforeA.updated_at, "updated_at moves when something was added");
    assert.equal(store.getReviewByReviewerSession("sess-a").review_key, afterA.review_key);
    assert.equal(snap(targetB), beforeB, "another PR's review is untouched");

    // ---- dedupe against stored findings ----
    const staged = snapAll();
    const repeat = await addReviewFindings(
        {
            findings: [
                // Same finding as f0: path written differently, comment padded with whitespace.
                inline({ file: "src\\a.mts", comment: "   Could we rename this?  \n" }),
                // Same finding as the one just added.
                inline({
                    file: "/src/new-file.mts",
                    line: 10,
                    severity: "low",
                    comment: "Could we guard this call?",
                }),
            ],
            semanticFindings: [semantic({ title: "RETRY SEMANTICS UNCLEAR", comment: "  Retries may duplicate writes. " })],
        },
        "sess-a",
    );
    assert.equal(repeat.findings, 0);
    assert.equal(repeat.semanticFindings, 0);
    assert.equal(repeat.duplicates, 3);
    assert.match(repeat.message, /Nothing new was added/);
    assert.match(repeat.message, /PR #101/);
    assert.doesNotMatch(repeat.message, /Added /);
    assert.deepEqual(snapAll(), staged, "a duplicate-only call changes nothing, not even updated_at");
    assert.equal(list(store.getReview(targetA)).length, 3);
    assert.equal(list(store.getReview(targetA), "semantic_findings_json").length, 2);

    // ---- dedupe within one batch; the key includes line, side and file ----
    const batch = await addReviewFindings(
        {
            findings: [
                inline({ file: "src/c.mts", line: 3, comment: "Check for null." }),
                inline({ file: "src/c.mts", line: 3, comment: "  Check for null.  " }),
                inline({ file: "src/c.mts", line: 4, comment: "Check for null." }),
            ],
            semanticFindings: [
                semantic({ category: "contract", title: "Public shape changed", comment: "Callers break." }),
                semantic({ category: "contract", title: "public SHAPE changed", comment: "Callers break." }),
            ],
        },
        "sess-a",
    );
    assert.equal(batch.findings, 2);
    assert.equal(batch.semanticFindings, 1);
    assert.equal(batch.duplicates, 2);
    assert.match(batch.message, /Added 2 inline finding\(s\) and 1 PR-level finding\(s\)/);
    assert.match(batch.message, /Skipped 2 already staged\./);
    const batchRow = store.getReview(targetA);
    assert.deepEqual(ids(list(batchRow)), ["f0", "f1", "f2", "f3", "f4"]);
    assert.deepEqual(ids(list(batchRow, "semantic_findings_json")), ["s0", "s1", "s2"]);
    assert.deepEqual(
        list(batchRow).slice(3).map((f) => [f.file, f.line]),
        [["/src/c.mts", 3], ["/src/c.mts", 4]],
    );
    assert.equal(list(batchRow)[1].posted, true);

    // ---- sessions that cannot take findings ----
    const rejected = snapAll();
    await assert.rejects(() => addReviewFindings({ findings: [inline()] }, "sess-x"), /no longer the reviewer of record/);
    await assert.rejects(
        () => addReviewFindings({ findings: [inline()] }, "sess-c"),
        /no longer the reviewer of record/,
        "a re-launched review no longer accepts its previous session's findings",
    );
    await assert.rejects(() => addReviewFindings({ findings: [inline()] }, "sess-d"), /review is error/);
    await assert.rejects(() => addReviewFindings({ semanticFindings: [semantic()] }, "sess-e"), /review is running/);
    assert.throws(() => store.appendReviewFindings("sess-x", [inline()], []), /no longer the reviewer of record/);
    assert.throws(() => store.appendReviewFindings("sess-e", [], [semantic()]), /findings can only be added to a finished review/);
    assert.deepEqual(snapAll(), rejected, "rejected sessions leave every review untouched");

    // ---- validation: every rejection leaves the database unchanged ----
    const invalid = [
        [{ findings: [inline()], prId: "101" }, /unexpected field prId/],
        [{ findings: [inline()], target: { prId: "202" } }, /unexpected field target/],
        [{ semanticFindings: [semantic()], status: "running" }, /unexpected field status/],
        [{ findings: "x" }, /findings must be an array/],
        [{ findings: {} }, /findings must be an array/],
        [{ semanticFindings: "x" }, /semanticFindings must be an array/],
        [{}, /Provide at least one entry/],
        [{ findings: [], semanticFindings: [] }, /Provide at least one entry/],
        [null, /must be an object/],
        [[inline()], /must be an object/],
        [{ findings: ["x"] }, /findings\[0\] must be an object/],
        [{ findings: Array.from({ length: 51 }, (_, i) => inline({ line: i + 1 })) }, /Add at most 50/],
        [
            {
                findings: Array.from({ length: 26 }, (_, i) => inline({ line: i + 1 })),
                semanticFindings: Array.from({ length: 25 }, (_, i) => semantic({ title: `Title ${i}` })),
            },
            /Add at most 50/,
        ],
        [{ findings: [inline({ technicalExplanation: undefined })] }, /findings\[0\]\.technicalExplanation is required/],
        [{ findings: [inline({ technicalExplanation: "   " })] }, /technicalExplanation is required/],
        [{ findings: [inline({ side: "middle" })] }, /findings\[0\]\.side must be left or right/],
        [{ findings: [inline({ side: undefined })] }, /side is required/],
        [{ findings: [inline({ severity: "urgent" })] }, /findings\[0\]\.severity is invalid/],
        [{ findings: [inline({ file: undefined })] }, /file is required/],
        [{ findings: [inline({ comment: "  " })] }, /comment is required/],
        [{ findings: [inline({ line: undefined })] }, /findings\[0\]\.line is required/],
        [{ findings: [inline({ line: 0 })] }, /line must be a positive integer/],
        [{ findings: [inline({ line: "5" })] }, /line must be a positive integer/],
        [{ findings: [inline({ line: 5, endLine: 4 })] }, /endLine must be greater than or equal to line/],
        [{ semanticFindings: [semantic({ category: "style" })] }, /semanticFindings\[0\]\.category is invalid/],
        [{ semanticFindings: [semantic({ severity: "nit" })] }, /semanticFindings\[0\]\.severity is invalid/],
        [{ semanticFindings: [semantic({ title: undefined })] }, /title is required/],
        [{ semanticFindings: [semantic({ comment: "" })] }, /comment is required/],
        [{ semanticFindings: [semantic({ files: "src/a.mts" })] }, /files must be an array/],
        [{ semanticFindings: [semantic({ files: [""] })] }, /files\[0\] must be a string/],
        // One bad entry rejects the whole call; the valid entries are not partially stored.
        [{ findings: [inline({ line: 77, comment: "Valid but unlucky." }), inline({ side: "middle" })] }, /side must be/],
        [
            { findings: [inline({ line: 78, comment: "Also valid." })], semanticFindings: [semantic({ category: "style" })] },
            /category is invalid/,
        ],
    ];
    for (const [input, pattern] of invalid) {
        await assert.rejects(
            () => addReviewFindings(input, "sess-a"),
            pattern,
            `rejects ${JSON.stringify(input)?.slice(0, 80)}`,
        );
    }
    assert.deepEqual(snapAll(), rejected, "validation failures never touch the database");

    // Validation runs before the session lookup, so a bad call never reaches storage.
    await assert.rejects(() => addReviewFindings({}, "sess-x"), /Provide at least one entry/);

    // The schema's required fields are all enforced by the validator.
    const findingSchema = PUBLISH_REVIEW_SCHEMA.properties.findings.items;
    const semanticSchema = PUBLISH_REVIEW_SCHEMA.properties.semanticFindings.items;
    for (const key of findingSchema.required) {
        await assert.rejects(
            () => addReviewFindings({ findings: [inline({ [key]: undefined })] }, "sess-a"),
            new RegExp(`${key} is required|${key} must be`),
            `findings.${key} is required`,
        );
    }
    for (const key of semanticSchema.required) {
        await assert.rejects(
            () => addReviewFindings({ semanticFindings: [semantic({ [key]: undefined })] }, "sess-a"),
            new RegExp(`${key} is required|${key} is invalid`),
            `semanticFindings.${key} is required`,
        );
    }
    assert.deepEqual(snapAll(), rejected);

    // ---- store: ids never collide, input ids/posted/rewrites are discarded ----
    const storeAdded = store.appendReviewFindings(
        "sess-i",
        [
            inline({ id: "f2", posted: true, humanizedComment: "forged", file: "src/i3.mts", comment: "Third." }),
            inline({ id: "f3", file: "src/i4.mts", comment: "Fourth." }),
            inline({ id: "f4", file: "src/i5.mts", comment: "Fifth." }),
        ],
        [semantic({ id: "s0", posted: true, title: "Existing three", comment: "A new concern." })],
    );
    assert.equal(storeAdded.review.pr_id, "909");
    assert.equal(storeAdded.duplicates, 0);
    const iRow = store.getReview(targetI);
    const iFindings = list(iRow);
    const iSemantic = list(iRow, "semantic_findings_json");
    assert.equal(iFindings.length, 5);
    assert.equal(new Set(ids(iFindings)).size, 5, "ids stay unique in a list with gaps");
    assert.deepEqual(ids(iFindings).slice(0, 2), ["f2", "f3"]);
    assert.ok(ids(iFindings).slice(2).every((id) => /^f\d+$/.test(id) && id !== "f2" && id !== "f3"));
    assert.ok(iFindings.slice(2).every((f) => f.posted === false && f.humanizedComment === null));
    assert.equal(new Set(ids(iSemantic)).size, 3);
    assert.deepEqual(ids(iSemantic).slice(0, 2), ["s0", "s9"]);
    assert.ok(/^s\d+$/.test(iSemantic[2].id) && !["s0", "s9"].includes(iSemantic[2].id));
    assert.equal(iSemantic[2].posted, false);
    assert.deepEqual(ids(storeAdded.findings), ids(iFindings.slice(2)));

    // Only the list that grew is rewritten; a review with no stored findings still works.
    const jBefore = store.getReview(targetJ);
    assert.equal(jBefore.findings_json, null);
    assert.equal(jBefore.semantic_findings_json, null);
    const jAdded = await addReviewFindings({ findings: [inline({ comment: "First ever." })] }, "sess-j");
    assert.equal(jAdded.findings, 1);
    const jAfter = store.getReview(targetJ);
    assert.deepEqual(ids(list(jAfter)), ["f0"]);
    assert.equal(jAfter.semantic_findings_json, null, "an untouched list is not rewritten");
    assert.equal(jAfter.status, "done");
    const jSemantic = await addReviewFindings({ semanticFindings: [semantic({ files: undefined })] }, "sess-j");
    assert.equal(jSemantic.semanticFindings, 1);
    assert.deepEqual(list(store.getReview(targetJ), "semantic_findings_json").map((f) => [f.id, f.files]), [["s0", []]]);
    assert.deepEqual(ids(list(store.getReview(targetJ))), ["f0"], "the inline list is left alone");

    // ---- schema contract ----
    assert.equal(ADD_REVIEW_FINDINGS_SCHEMA.type, "object");
    assert.equal(ADD_REVIEW_FINDINGS_SCHEMA.additionalProperties, false);
    assert.deepEqual(Object.keys(ADD_REVIEW_FINDINGS_SCHEMA.properties).sort(), ["findings", "semanticFindings"]);
    assert.deepEqual(ADD_REVIEW_FINDINGS_SCHEMA.properties.findings, PUBLISH_REVIEW_SCHEMA.properties.findings);
    assert.deepEqual(ADD_REVIEW_FINDINGS_SCHEMA.properties.semanticFindings, PUBLISH_REVIEW_SCHEMA.properties.semanticFindings);
    assert.equal(ADD_REVIEW_FINDINGS_SCHEMA.required, undefined, "either list may be omitted");
    assert.ok(!("prId" in ADD_REVIEW_FINDINGS_SCHEMA.properties), "the target review is never a tool input");

    // Every value the schema allows is accepted, and 50 entries in one call is the limit.
    const sides = findingSchema.properties.side.enum;
    const severities = findingSchema.properties.severity.enum;
    const categories = semanticSchema.properties.category.enum;
    const semanticSeverities = semanticSchema.properties.severity.enum;
    let line = 100;
    const enumFindings = severities.flatMap((severity) =>
        sides.map((side) => inline({ file: "src/enums.mts", line: line++, side, severity, comment: `${severity}/${side}` })),
    );
    const enumSemantic = categories.map((category, i) =>
        semantic({
            category,
            severity: semanticSeverities[i % semanticSeverities.length],
            title: `Enum ${category}`,
            comment: `Covers ${category}.`,
        }),
    );
    const enumResult = await addReviewFindings({ findings: enumFindings, semanticFindings: enumSemantic }, "sess-b");
    assert.equal(enumResult.findings, enumFindings.length);
    assert.equal(enumResult.semanticFindings, enumSemantic.length);
    assert.equal(enumResult.duplicates, 0);

    const limitFindings = Array.from({ length: 30 }, (_, i) =>
        inline({ file: "src/limit.mts", line: i + 1, comment: `Limit inline ${i}` }),
    );
    const limitSemantic = Array.from({ length: 20 }, (_, i) =>
        semantic({ title: `Limit semantic ${i}`, comment: `Limit comment ${i}` }),
    );
    const limit = await addReviewFindings({ findings: limitFindings, semanticFindings: limitSemantic }, "sess-b");
    assert.equal(limit.findings + limit.semanticFindings, 50);

    const finalB = store.getReview(targetB);
    const bFindings = list(finalB);
    const bSemantic = list(finalB, "semantic_findings_json");
    assert.equal(bFindings.length, 1 + enumFindings.length + 30);
    assert.equal(bSemantic.length, enumSemantic.length + 20);
    assert.deepEqual(ids(bFindings), bFindings.map((_, i) => `f${i}`), "ids stay sequential and unique");
    assert.deepEqual(ids(bSemantic), bSemantic.map((_, i) => `s${i}`));
    assert.ok(bFindings.slice(1).every((f) => f.posted === false));
    assert.equal(bFindings[0].comment, "Could we drop this import?");
    assert.equal(finalB.summary, "Summary B");
    assert.equal(finalB.status, "done");

    // The earlier work on PR B did not leak into PR A, and the rejected sessions' rows are unchanged.
    const finalA = store.getReview(targetA);
    assert.equal(list(finalA).length, 5);
    assert.equal(list(finalA, "semantic_findings_json").length, 3);
    assert.equal(finalA.summary, "Summary A");
    assert.equal(list(finalA)[1].posted, true);
    assert.equal(store.getReview(targetC).status, "running");
    assert.equal(store.getReview(targetD).status, "error");
    assert.equal(store.getReview(targetE).findings_json, null);

    // ---- source wiring ----
    const session = await source("../src/reviewer-session.mts");
    assert.match(session, /defineTool\("add_review_findings"/);
    assert.match(session, /invocation\.sessionId/);
    assert.match(session, /addReviewFindings\(args, invocation\.sessionId\)/);
    assert.match(session, /parameters: ADD_REVIEW_FINDINGS_SCHEMA/);
    assert.match(session, /skipPermission: true/);
    assert.match(session, /defer: "never"/);
    assert.match(session, /tools: \[addReviewFindingsTool\(\)\]/);
    const toolSource = session.slice(
        session.indexOf("export function addReviewFindingsTool"),
        session.indexOf("function acquire("),
    );
    assert.ok(toolSource.includes("add_review_findings"), "the tool body was located");
    assert.doesNotMatch(
        toolSource,
        /\b(args|input)\??\.(prId|pr|org|project|repoId|target|reviewKey|sessionId)\b/,
        "the target review never comes from the tool arguments",
    );
    const acquireSource = session.slice(session.indexOf("function acquire("));
    assert.match(acquireSource, /resumeSession\(sessionId,[\s\S]*?tools: \[addReviewFindingsTool\(\)\]/);

    const api = await source("../src/api.mts");
    assert.match(api, /findingCount: reviewFindingCount\(/);
    assert.match(api, /\{ \.\.\.chat, findingCount: reviewFindingCount\(getReview\(identity\)\) \}/);

    const chat = await source("../web/src/reviewerChat.ts");
    assert.match(chat, /export function reviewerChatSection\(pr: PR, sessionId: string, onReviewChanged\?: \(\) => void\)/);
    assert.match(chat, /section\.dataset\.session = sessionId/);
    assert.match(chat, /function trackFindings\(/);
    assert.match(chat, /onReviewChanged\?\.\(\)/);

    const panel = await source("../web/src/reviewPanel.ts");
    assert.match(panel, /_refreshStaged\?\.\(\)/);
    assert.match(panel, /dataset\.session === review\.reviewer_session_id/);
    assert.match(panel, /reviewerChatSection\(pr, review\.reviewer_session_id, \(\) => refreshReviewPanel\(pr, panel, onUpdate\)\)/);

    const diff = await source("../web/src/diff.ts");
    assert.match(diff, /box\._refreshStaged =/);
    assert.match(diff, /wrap\._insertStaged = insertStaged/);
    assert.match(diff, /renderedStaged\.has\(String\(f\.id\)\)/);

    console.log("Reviewer add-findings harness passed");
} finally {
    store?.closeDb();
    await rm(tempDir, { recursive: true, force: true });
}
