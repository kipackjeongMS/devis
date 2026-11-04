import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = await mkdtemp(join(tmpdir(), "ado-pr-ops-pr-recency-"));
process.env.ADO_PR_OPS_DB_PATH = join(tempDir, "reviews.db");

const pr = (id, extra = {}) => ({ org: "o", project: "p", repoId: "r", id, headCommit: `h${id}`, ...extra });
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
};
const at = (iso) => Date.parse(iso);

let store;
try {
    const { createPrRecency, summarizeThreads } = await import("../pr-recency.mjs");
    store = await import("../store.mjs");
    await store.ensureDb();

    // ---- store: the newer read wins head and push; my activity only moves forward ----
    const ref = { org: "o", project: "p", repoId: "r", prId: "1", meId: "me" };
    store.savePrRecency({ ...ref, head: "b", pushedAt: 500, myAt: 300, myKind: "comment", checkedAt: 200 });
    store.savePrRecency({ ...ref, head: "a", pushedAt: 100, myAt: 100, myKind: "vote", checkedAt: 100 });
    let [row] = store.listPrRecency("o", "me");
    assert.deepEqual([row.head, row.pushedAt, row.myAt, row.myKind, row.checkedAt], ["b", 500, 300, "comment", 200]);
    // An in-app record (checkedAt 0, head "") keeps the read but moves my activity forward.
    store.savePrRecency({ ...ref, head: "", pushedAt: null, myAt: 900, myKind: "vote", checkedAt: 0 });
    [row] = store.listPrRecency("o", "me");
    assert.deepEqual([row.head, row.pushedAt, row.myAt, row.myKind, row.checkedAt], ["b", 500, 900, "vote", 200]);
    // A later read that saw no activity of mine doesn't erase it.
    store.savePrRecency({ ...ref, head: "c", pushedAt: 700, myAt: null, myKind: null, checkedAt: 1000 });
    [row] = store.listPrRecency("o", "me");
    assert.deepEqual([row.head, row.pushedAt, row.myAt, row.myKind], ["c", 700, 900, "vote"]);
    assert.equal(store.listPrRecency("o", "someone-else").length, 0);
    store.savePrRecency({ ...ref, prId: "old", head: "x", pushedAt: 1, myAt: null, myKind: null, checkedAt: 5 });
    store.savePrRecency({ ...ref, prId: "mine", head: "", pushedAt: null, myAt: 2000, myKind: "comment", checkedAt: 0 });
    assert.equal(store.prunePrRecency(950), 1, "only the row with nothing newer than the cutoff goes");
    assert.deepEqual(store.listPrRecency("o", "me").map((r) => r.prId).sort(), ["1", "mine"]);

    // ---- thread parsing ----
    const threads = [
        { publishedDate: "2026-01-01T00:00:00Z", properties: { CodeReviewThreadType: { $value: "RefUpdate" } },
          comments: [{ commentType: "system", content: "Pushed", publishedDate: "2026-01-02T00:00:00Z", author: { id: "bot" } }] },
        // Text fallback when the properties are missing.
        { comments: [{ commentType: "system", content: "The reference refs/heads/feature was updated.", publishedDate: "2026-01-03T00:00:00Z", author: { id: "dev" } }] },
        { comments: [{ commentType: "system", content: "Someone voted 10", publishedDate: "2026-01-09T00:00:00Z", author: { id: "peer" } }] },
        { comments: [
            { commentType: "text", content: "LGTM", publishedDate: "2026-01-04T00:00:00Z", author: { id: "me" } },
            { commentType: "text", content: "edited", publishedDate: "2026-01-02T00:00:00Z", lastContentUpdatedDate: "2026-01-05T00:00:00Z", author: { id: "me" } },
            { commentType: "text", content: "gone", publishedDate: "2026-01-08T00:00:00Z", isDeleted: true, author: { id: "me" } },
            { commentType: "text", content: "peer", publishedDate: "2026-01-07T00:00:00Z", author: { id: "peer" } },
        ] },
    ];
    let s = summarizeThreads(threads, "me");
    assert.equal(s.pushedAt, at("2026-01-03T00:00:00Z"));
    assert.equal(s.myAt, at("2026-01-05T00:00:00Z"), "an edit counts; deleted comments and peers don't");
    assert.equal(s.myKind, "comment");
    s = summarizeThreads([...threads,
        { properties: { CodeReviewThreadType: { $value: "VoteUpdate" } },
          comments: [{ commentType: "system", content: "Me voted 5", publishedDate: "2026-01-06T00:00:00Z", author: { id: "me" } }] },
    ], "me");
    assert.equal(s.myAt, at("2026-01-06T00:00:00Z"));
    assert.equal(s.myKind, "vote");
    assert.deepEqual(summarizeThreads([], "me"), { pushedAt: null, myAt: null, myKind: null });

    // ---- planning: cached values fill in at once; only new or moved heads are read ----
    const rows = [
        { org: "o", project: "p", repoId: "r", prId: "2", meId: "me", head: "h2", pushedAt: at("2026-02-01T00:00:00Z"), myAt: null, myKind: null, checkedAt: 1 },
        { org: "o", project: "p", repoId: "r", prId: "3", meId: "me", head: "old", pushedAt: at("2026-02-02T00:00:00Z"), myAt: at("2026-02-03T00:00:00Z"), myKind: "comment", checkedAt: 1 },
        { org: "o", project: "p", repoId: "r", prId: "4", meId: "me", head: "", pushedAt: null, myAt: at("2026-02-04T00:00:00Z"), myKind: "vote", checkedAt: 0 },
    ];
    const saved = [];
    const gates = new Map();
    const read = [];
    const recency = createPrRecency({
        getMeId: async () => "me",
        read: (p) => {
            read.push(String(p.id));
            const d = deferred();
            gates.set(String(p.id), d);
            return d.promise;
        },
        load: () => [...rows, ...saved],
        save: (r) => saved.push(r),
        now: () => 42,
        concurrency: 4,
    });
    const prs = [pr(1), pr(2), pr(3), pr(4), pr(5, { headCommit: undefined })];
    const pending = await recency.apply(prs);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(prs.map((p) => p.pushedAt), [null, "2026-02-01T00:00:00.000Z", "2026-02-02T00:00:00.000Z", null, null]);
    assert.deepEqual(prs.map((p) => p.myKind), [null, null, "comment", "vote", null]);
    assert.equal(pending, 4, "unknown, moved head, record-only, and no-head PRs are read");
    assert.deepEqual(read.sort(), ["1", "3", "4", "5"]);
    assert.equal(await recency.apply([pr(1)]), 4);
    assert.deepEqual(read.sort(), ["1", "3", "4", "5"], "in-flight reads are deduplicated");

    // settle waits only so long, and reports what's still in flight.
    const early = await recency.settle(["o"], 10);
    assert.equal(early.pending, 4);
    for (const id of ["1", "3", "4"]) gates.get(id).resolve({ pushedAt: 1000, myAt: null, myKind: null });
    gates.get("5").reject(new Error("boom"));
    const done = await recency.settle(["o"], 5000);
    assert.equal(done.pending, 0);
    assert.deepEqual(done.errors, ["PR #5 recency: boom"]);
    assert.deepEqual(saved.map((r) => [r.prId, r.head, r.checkedAt]).sort(), [["1", "h1", 42], ["3", "h3", 42], ["4", "h4", 42]]);
    assert.ok(done.recency.some((r) => r.prId === "2" && r.pushedAt === "2026-02-01T00:00:00.000Z"));

    // A PR with no head is cached under a marker, so it isn't read again.
    rows.push({ ...rows[0], prId: "6", head: "none" });
    read.length = 0;
    await recency.apply([pr(6, { headCommit: undefined })]);
    assert.deepEqual(read, []);

    // ---- record: an in-app comment shows up without a read ----
    const real = createPrRecency({
        getMeId: async () => "me",
        read: async () => ({ pushedAt: null, myAt: null, myKind: null }),
        load: store.listPrRecency,
        save: store.savePrRecency,
        now: () => 5000,
    });
    await real.record({ org: "o", project: "p", repoId: "r", prId: "1" }, "vote");
    [row] = store.listPrRecency("o", "me").filter((r) => r.prId === "1");
    assert.deepEqual([row.head, row.myAt, row.myKind], ["c", 5000, "vote"]);

    // ---- wiring ----
    const [apiSrc, appSrc, recencySrc] = await Promise.all([
        readFile(new URL("../src/api.mts", import.meta.url), "utf8"),
        readFile(new URL("../web/src/app.ts", import.meta.url), "utf8"),
        readFile(new URL("../web/src/prRecency.ts", import.meta.url), "utf8"),
    ]);
    assert.match(apiSrc, /prRecency\.apply\(\[\.\.\.prs, \.\.\.authored\]\)/);
    assert.match(apiSrc, /p === "\/api\/pr-recency"/);
    assert.match(apiSrc, /p === "\/api\/prs\/older"/);
    assert.match(apiSrc, /prRecency\.record\(ref, "comment"\)/);
    assert.match(recencySrc, /\/api\/pr-recency/);
    assert.match(appSrc, /loadPrRecency\(/);

    console.log("PR recency harness passed");
} finally {
    store?.closeDb();
    await rm(tempDir, { recursive: true, force: true });
}
