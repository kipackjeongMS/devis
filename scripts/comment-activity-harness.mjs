import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = await mkdtemp(join(tmpdir(), "ado-pr-ops-comment-activity-"));
process.env.ADO_PR_OPS_DB_PATH = join(tempDir, "reviews.db");

const pr = (id, extra = {}) => ({
    org: "o", project: "p", repoId: "r", id, myVote: 0, iCommented: false, ...extra,
});
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setImmediate(r));

let store;
try {
    const { createCommentActivity, COMMENT_ACTIVITY_RECHECK_MS } = await import("../comment-activity.mjs");
    store = await import("../store.mjs");
    await store.ensureDb();

    // ---- store: newer check wins, older result never overwrites a newer one ----
    const ref = { org: "o", project: "p", repoId: "r", prId: "1", meId: "me" };
    store.saveCommentActivity({ ...ref, commented: true, checkedAt: 200 });
    store.saveCommentActivity({ ...ref, commented: false, checkedAt: 100 });
    assert.deepEqual(
        store.listCommentActivity("o", "me").map((r) => [r.prId, r.commented, r.checkedAt]),
        [["1", true, 200]],
    );
    assert.equal(store.listCommentActivity("o", "someone-else").length, 0);
    store.saveCommentActivity({ ...ref, prId: "old", commented: false, checkedAt: 5 });
    assert.equal(store.pruneCommentActivity(50), 1);
    assert.equal(store.listCommentActivity("o", "me").length, 1);

    // ---- planning: cached values render immediately; only stale/unknown PRs are checked ----
    const now = 10 * COMMENT_ACTIVITY_RECHECK_MS;
    const rows = [
        { org: "o", project: "p", repoId: "r", prId: "3", meId: "me", commented: true, checkedAt: 1 },
        { org: "o", project: "p", repoId: "r", prId: "4", meId: "me", commented: false, checkedAt: now - 1000 },
        { org: "o", project: "p", repoId: "r", prId: "5", meId: "me", commented: false, checkedAt: now - COMMENT_ACTIVITY_RECHECK_MS },
    ];
    const gates = new Map();
    const checked = [];
    const saved = [];
    const activity = createCommentActivity({
        getMeId: async () => "me",
        check: (p) => {
            checked.push(String(p.id));
            const d = deferred();
            gates.set(String(p.id), d);
            return d.promise;
        },
        load: () => [...rows, ...saved],
        save: (row) => saved.push(row),
        now: () => now,
        concurrency: 6,
    });
    const prs = [pr(1), pr(2, { myVote: 10 }), pr(3), pr(4), pr(5)];
    const pending = await activity.apply(prs);
    assert.deepEqual(prs.map((p) => p.iCommented), [false, false, true, false, false]);
    assert.equal(pending, 2, "only the unknown PR and the expired false entry need checks");
    assert.deepEqual(checked.sort(), ["1", "5"]);

    // apply() must not wait for ADO, and a second apply joins the in-flight checks.
    assert.equal(await activity.apply([pr(1), pr(5)]), 2);
    assert.deepEqual(checked.sort(), ["1", "5"], "in-flight checks are deduplicated");

    // settle() waits for every in-flight check and reports commented PRs + errors.
    let settledValue = null;
    const settling = activity.settle(["o"]).then((v) => (settledValue = v));
    await tick();
    assert.equal(settledValue, null, "settle waits for in-flight checks");
    gates.get("1").resolve(true);
    gates.get("5").reject(new Error("ADO GET 500"));
    await settling;
    assert.deepEqual(
        settledValue.commented.map((r) => r.prId).sort(),
        ["1", "3"],
    );
    assert.equal(settledValue.errors.length, 1);
    assert.match(settledValue.errors[0], /PR #5 comment activity: ADO GET 500/);
    assert.deepEqual(saved.map((r) => [r.prId, r.commented, r.checkedAt]), [["1", true, now]]);
    assert.deepEqual((await activity.settle(["o"])).errors, [], "errors are reported once");

    // A forced refresh rechecks fresh "false" entries, but a known "true" stays sticky.
    checked.length = 0;
    await activity.apply([pr(3), pr(4)], true);
    assert.deepEqual(checked, ["4"]);
    gates.get("4").resolve(false);
    await activity.settle(["o"]);

    // ---- concurrency is bounded across all in-flight checks ----
    let active = 0;
    let peak = 0;
    const bounded = createCommentActivity({
        getMeId: async () => "me",
        check: async () => {
            active++;
            peak = Math.max(peak, active);
            await tick();
            active--;
            return false;
        },
        load: () => [],
        save: () => {},
        concurrency: 2,
    });
    await bounded.apply(Array.from({ length: 7 }, (_, i) => pr(100 + i)));
    await bounded.settle(["o"]);
    assert.equal(peak, 2);

    // ---- a user comment recorded mid-check is not overwritten by the older check ----
    let clock = 1000;
    const gate = deferred();
    const real = createCommentActivity({
        getMeId: async () => "me2",
        check: () => gate.promise,
        load: store.listCommentActivity,
        save: store.saveCommentActivity,
        now: () => clock,
    });
    await real.apply([pr(9)]);
    clock = 2000;
    await real.record({ org: "o", project: "p", repoId: "r", prId: "9" }, true);
    gate.resolve(false);
    const after = await real.settle(["o"]);
    assert.deepEqual(after.commented.map((r) => r.prId), ["9"]);

    // ---- wiring: list calls no longer fan out; the UI fills activity in a second phase ----
    const [adoSrc, apiSrc, appSrc] = await Promise.all([
        readFile(new URL("../src/ado.mts", import.meta.url), "utf8"),
        readFile(new URL("../src/api.mts", import.meta.url), "utf8"),
        readFile(new URL("../web/src/app.ts", import.meta.url), "utf8"),
    ]);
    assert.doesNotMatch(adoSrc, /addCommentActivity|_commentActivityCache/);
    assert.match(apiSrc, /commentActivity\.apply\(prs, refreshActivity\)/);
    assert.match(apiSrc, /p === "\/api\/pr-activity"/);
    assert.match(appSrc, /\/api\/pr-activity/);

    console.log("Comment activity harness passed");
} finally {
    store?.closeDb();
    await rm(tempDir, { recursive: true, force: true });
}
