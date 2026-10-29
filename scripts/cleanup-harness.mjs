import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cleanup-"));
process.env.ADO_PR_OPS_DB_PATH = join(root, "data", "reviews.db");
process.env.ADO_PR_OPS_JARVIS_DIR = join(root, "jarvis");

const http = await import("../http.mjs");
const { startServer } = await import("../server.mjs");
const { diffLines, DIFF_MAX_EDITS } = await import("../ado.mjs");
const store = await import("../store.mjs");
const jarvisStore = await import("../jarvis-store.mjs");
const maintenance = await import("../maintenance.mjs");
const chatImages = await import("../chat-images.mjs");
const notify = await import("../web/notify.js");

const post = (port, body, headers = {}, agent = undefined) =>
    new Promise((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, method: "POST", path: "/", headers, agent }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
        });
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });

try {
    // ---- request bodies are capped ----
    const echo = createServer(async (req, res) => {
        try {
            http.sendJson(res, 200, await http.readBody(req));
        } catch (e) {
            http.sendJson(res, e instanceof http.BodyTooLargeError ? 413 : 400, { error: e.message });
        }
    });
    await new Promise((r) => echo.listen(0, "127.0.0.1", r));
    const port = echo.address().port;
    assert.deepEqual(JSON.parse((await post(port, JSON.stringify({ a: 1 }))).text), { a: 1 });
    const big = Buffer.alloc(http.MAX_BODY_BYTES + 1024, 0x61);
    const tooBig = await post(port, big);
    assert.equal(tooBig.status, 413, "a body past the cap is refused");
    assert.match(tooBig.text, /larger than 10 MB/);
    assert.equal((await post(port, "{not json")).status, 400);
    // A client that declares a huge body and never sends it gets its 413, and its socket is dropped.
    const declared = await post(port, null, { "Content-Length": String(http.MAX_BODY_BYTES + 1) }, false);
    assert.equal(declared.status, 413, "a declared size past the cap is refused before reading");
    const closing = Date.now();
    await new Promise((r) => echo.close(r));
    assert.ok(Date.now() - closing < http.BODY_DRAIN_MS + 2_000, `a stalled refused body doesn't hold the server open (${Date.now() - closing} ms)`);

    // ---- the app server closes with keep-alive sockets open ----
    const running = await startServer(join(root, "web"));
    const url = new URL(running.url);
    const agent = new (await import("node:http")).Agent({ keepAlive: true });
    await new Promise((resolve) =>
        request({ host: url.hostname, port: url.port, path: "/api/ping", agent, headers: { Host: url.host } }, (res) => {
            res.resume();
            res.on("end", resolve);
        }).end(),
    );
    const started = Date.now();
    await running.close();
    assert.ok(Date.now() - started < 3_000, `close finishes with a kept-alive socket (${Date.now() - started} ms)`);
    assert.equal(running.server.listening, false);
    agent.destroy();

    // ---- the diff: a shortest edit script, with memory that grows with the edits, not the file ----
    const naive = (a, b) => {
        const n = a.length;
        const m = b.length;
        const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
        for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        return dp[0][0];
    };
    // Every op points at its own line, line numbers run on within a hunk and only move forward,
    // and nothing beyond a shortest edit script is marked changed.
    const checkDiff = (a, b, lcs = naive(a, b)) => {
        const hunks = diffLines(a, b);
        let edits = 0;
        let lastO = 0;
        let lastN = 0;
        for (const h of hunks) {
            assert.ok(h.length > 0);
            let o = null;
            let nn = null;
            for (const op of h) {
                if (op.t !== "add") {
                    assert.equal(a[op.o - 1], op.text, `old line ${op.o}`);
                    assert.ok(op.o > lastO);
                    if (o !== null) assert.equal(op.o, o + 1);
                    o = lastO = op.o;
                } else assert.equal(op.o, null);
                if (op.t !== "del") {
                    assert.equal(b[op.nn - 1], op.text, `new line ${op.nn}`);
                    assert.ok(op.nn > lastN);
                    if (nn !== null) assert.equal(op.nn, nn + 1);
                    nn = lastN = op.nn;
                } else assert.equal(op.nn, null);
                if (op.t !== "ctx") edits++;
            }
        }
        assert.equal(edits, a.length + b.length - 2 * lcs, "a shortest edit script");
        return hunks;
    };
    let seed = 7;
    const rand = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    for (let trial = 0; trial < 600; trial++) {
        const a = Array.from({ length: Math.floor(rand() * 60) }, () => "l" + Math.floor(rand() * (trial % 3 ? 4 : 12)));
        const b = trial % 7 === 0
            ? Array.from({ length: Math.floor(rand() * 60) }, () => "l" + Math.floor(rand() * 4))
            : a.filter(() => rand() > 0.15).map((x) => (rand() > 0.85 ? x + "'" : x));
        for (let k = Math.floor(rand() * 4); k > 0; k--) b.splice(Math.floor(rand() * (b.length + 1)), 0, "new" + k);
        checkDiff(a, b);
    }
    for (const [a, b] of [[[], []], [["a"], []], [[], ["a"]], [["a"], ["a"]], [["a", "b"], ["b", "a"]], [["a", "a", "a"], ["a"]]]) checkDiff(a, b);
    assert.deepEqual(diffLines([], []), []);
    assert.deepEqual(diffLines(["a"], ["a"]), [], "nothing changed, no hunks");
    assert.deepEqual(diffLines(["a", "b"], ["a", "c"]).flat().map((op) => op.t), ["ctx", "del", "add"], "a change reads removed, then added");

    const file = Array.from({ length: 6000 }, (_, i) => `line ${i}`);
    // A 6,000-line file with one changed line.
    const edited = [...file];
    edited[3000] = "changed";
    let t0 = Date.now();
    const one = checkDiff(file, edited, 5999);
    assert.ok(Date.now() - t0 < 500, "fast with common ends trimmed");
    assert.deepEqual(one.flat().filter((op) => op.t !== "ctx").map((op) => [op.t, op.text, op.o, op.nn]), [
        ["del", "line 3000", 3001, null],
        ["add", "changed", null, 3001],
    ]);
    // Two small edits far apart stay two small hunks.
    const far = file.slice(0, 5000);
    const farEdited = [...far];
    farEdited[100] = "near the top";
    farEdited[4900] = "near the end";
    t0 = Date.now();
    const two = checkDiff(far, farEdited, 4998);
    assert.ok(Date.now() - t0 < 500, `far-apart edits are fast (${Date.now() - t0} ms)`);
    assert.equal(two.length, 2, "two hunks");
    assert.ok(two.every((h) => h.length === 8), "each is the change with 3 lines either side");
    // Hundreds of scattered edits still line up.
    const scattered = file.map((l, i) => (i % 10 === 5 ? l + " edited" : l));
    t0 = Date.now();
    const many = checkDiff(file, scattered, 5400);
    assert.ok(Date.now() - t0 < 3_000, `1,200 edits line up quickly (${Date.now() - t0} ms)`);
    assert.equal(many.flat().filter((op) => op.t === "del").length, 600);
    // Rewritten top to bottom: past the edit budget the middle shows as replaced.
    const other = Array.from({ length: 6000 }, (_, i) => `other ${i}`);
    assert.ok(12_000 > DIFF_MAX_EDITS);
    t0 = Date.now();
    const replaced = diffLines(file, other).flat();
    assert.ok(Date.now() - t0 < 1_500, `a rewrite gives up quickly (${Date.now() - t0} ms)`);
    assert.equal(replaced.filter((op) => op.t === "del").length, 6000);
    assert.equal(replaced.filter((op) => op.t === "add").length, 6000);
    // ---- old rows are pruned; recent ones stay ----
    await store.ensureDb();
    const day = 86_400_000;
    const ago = (days) => new Date(Date.now() - days * day).toISOString();
    store.insertNotifications([
        { id: "old", kind: "reply", createdAt: ago(120) },
        { id: "new", kind: "reply", createdAt: ago(1) },
    ]);
    // Watches go quiet relative to the org's last complete poll, not the clock.
    for (const [org, prId] of [["msazure", "1"], ["msazure", "2"], ["closed", "3"], ["never", "4"]]) {
        store.upsertInboxWatch({ kind: "authored", org, project: "P", repoId: "r", prId });
    }
    const db = await store.ensureDb();
    db.prepare("UPDATE inbox_watches SET updated_at = ? WHERE pr_id IN ('1', '3', '4')").run(ago(45));
    store.setMeta("inbox_last_poll:msazure", ago(0));
    store.setMeta("inbox_last_poll:closed", ago(40)); // the app was closed for 40 days: not checked yet, kept
    for (const [runId, status, at] of [["done-old", "done", ago(60)], ["err-old", "error", ago(60)], ["done-new", "done", ago(2)], ["queued-old", "queued", ago(60)]]) {
        db.prepare(
            `INSERT INTO review_jobs (run_id, pr_id, org, project, repo, repo_id, title, target_canvas_instance_id,
                dispatcher_session_id, dispatcher_canvas_instance_id, status, created_at, updated_at)
             VALUES (?, '1', 'o', 'p', 'r', 'ri', 't', 'c', 'd', 'dc', ?, ?, ?)`,
        ).run(runId, status, at, at);
    }
    const jdb = await jarvisStore.jarvisDb();
    jdb.prepare("INSERT INTO jarvis_events (at, kind, text) VALUES (?, 'x', 'ancient')").run(ago(200));
    await jarvisStore.recordEvent("x", "recent");
    // A chat image not sent or pasted for 30 days goes; a recent one stays.
    const pngOf = (seed) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, seed)]).toString("base64");
    const oldImage = await chatImages.saveImage({ data: pngOf(1) });
    const newImage = await chatImages.saveImage({ data: pngOf(2) });
    utimesSync(chatImages.imagePath(oldImage.id), new Date(Date.now() - 31 * day), new Date(Date.now() - 31 * day));
    // A Teams ask closed over two weeks ago goes, with a chat's cursor that old; open ones and recent ones stay.
    const comms = await import("../comms.mjs");
    await comms.openAsks();
    jdb.prepare("INSERT INTO comms_asks (org, pr_id, state, opened_at, updated_at, closed_at) VALUES ('o', 1, 'done', ?, ?, ?)").run(ago(20), ago(20), ago(15));
    jdb.prepare("INSERT INTO comms_asks (org, pr_id, state, opened_at, updated_at, closed_at) VALUES ('o', 2, 'dismissed', ?, ?, ?)").run(ago(5), ago(5), ago(3));
    jdb.prepare("INSERT INTO comms_asks (org, pr_id, state, opened_at, updated_at) VALUES ('o', 3, 'open', ?, ?)").run(ago(20), ago(20));
    jdb.prepare("INSERT INTO comms_cursors (key, at) VALUES ('teams:old', ?), ('teams:new', ?)").run(ago(15), ago(1));
    const removed = await maintenance.runMaintenance();
    assert.deepEqual(removed, { notifications: 1, inboxWatches: 1, reviewJobs: 2, jarvisEvents: 1, chatImages: 1, comms: 2 });
    assert.deepEqual(jdb.prepare("SELECT pr_id FROM comms_asks ORDER BY pr_id").all().map((r) => r.pr_id), [2, 3]);
    assert.deepEqual(jdb.prepare("SELECT key FROM comms_cursors").all().map((r) => r.key), ["teams:new"]);
    assert.deepEqual([existsSync(chatImages.imagePath(oldImage.id)), existsSync(chatImages.imagePath(newImage.id))], [false, true]);
    assert.deepEqual(store.listNotifications().map((n) => n.id), ["new"]);
    assert.deepEqual(store.listInboxWatches().map((w) => w.pr_id), ["3", "2", "4"], "only a watch quiet for 30 days of polling goes");
    assert.deepEqual(db.prepare("SELECT run_id FROM review_jobs ORDER BY run_id").all().map((r) => r.run_id), ["done-new", "queued-old"], "unfinished jobs are never pruned");
    assert.deepEqual((await jarvisStore.listEvents()).map((e) => e.text), ["recent"]);
    assert.deepEqual(await maintenance.runMaintenance(), { notifications: 0, inboxWatches: 0, reviewJobs: 0, jarvisEvents: 0, chatImages: 0, comms: 0 }, "a second pass finds nothing");
    maintenance.startMaintenance();
    maintenance.startMaintenance();
    await maintenance.stopMaintenance();

    // ---- a review that never finishes stops being watched ----
    notify.markTriggered("pr-1", Date.now() - notify.TRIGGER_TTL_MS - 1);
    notify.markTriggered("pr-2");
    assert.equal(notify.expireTriggered(), 1);
    assert.deepEqual([...notify.getTriggered()], ["pr-2"]);
    notify.unmarkTriggered("pr-2");
    assert.equal(notify.triggeredCount(), 0);

    console.log("cleanup harness: ok");
} finally {
    store.closeDb();
    rmSync(root, { recursive: true, force: true });
}
