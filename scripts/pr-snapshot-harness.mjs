// The PR list kept for the page's first paint: shown only for the same orgs and
// projects, only while recent, and never when what's stored can't be read.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pr-snapshot-"));
process.env.ADO_PR_OPS_DB_PATH = join(root, "data", "reviews.db");

const store = await import("../store.mjs");
const snap = await import("../pr-snapshot.mjs");

try {
    await store.ensureDb();
    const cfg = { organizations: ["msazure", "other"], projects: { msazure: ["B", "A"] } };
    const prs = [{ id: 1, org: "msazure", project: "A", title: "one" }, { id: 2, org: "other", project: "X", title: "two" }];
    const now = Date.parse("2026-10-20T12:00:00Z");

    assert.equal(snap.readPrSnapshot(cfg, now), null, "nothing kept yet");
    snap.savePrSnapshot(cfg, prs, now);
    assert.deepEqual(snap.readPrSnapshot(cfg, now + 60_000), { prs, at: new Date(now).toISOString() });

    // Project order doesn't matter; a different scope does.
    assert.ok(snap.readPrSnapshot({ organizations: ["msazure", "other"], projects: { msazure: ["A", "B"] } }, now));
    assert.equal(snap.readPrSnapshot({ organizations: ["msazure"], projects: { msazure: ["A", "B"] } }, now), null, "another org list");
    assert.equal(snap.readPrSnapshot({ organizations: ["msazure", "other"], projects: { msazure: ["A"] } }, now), null, "another project list");

    // Too old, or from the future (a clock change), is not shown.
    assert.equal(snap.readPrSnapshot(cfg, now + snap.PR_SNAPSHOT_MAX_AGE_MS + 1), null);
    assert.equal(snap.readPrSnapshot(cfg, now - 60_000), null);

    // A newer list replaces it; unreadable data reads as nothing.
    snap.savePrSnapshot(cfg, prs.slice(0, 1), now + 1000);
    assert.equal(snap.readPrSnapshot(cfg, now + 2000).prs.length, 1);
    store.setMeta("prs_snapshot", "{not json");
    assert.equal(snap.readPrSnapshot(cfg, now), null);
    store.setMeta("prs_snapshot", JSON.stringify({ scope: snap.prScopeKey(cfg), at: new Date(now).toISOString(), prs: "nope" }));
    assert.equal(snap.readPrSnapshot(cfg, now), null);

    console.log("pr-snapshot harness: ok");
} finally {
    store.closeDb();
    rmSync(root, { recursive: true, force: true });
}
