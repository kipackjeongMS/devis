// The background service: when it may exit (fake clock), and the real process:
// started detached and reused, one per data folder, kept up by an attached
// window, gone once idle, replaced when it's from other code, and recovered
// from stale files.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const svc = await import("../service-files.mjs");
const { ServiceLifecycle } = await import("../service-lifecycle.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, timeoutMs = 15_000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
        await sleep(50);
    }
}

// ---- when the service may exit ----------------------------------------------------------
{
    let clock = 0;
    let work = [];
    const life = new ServiceLifecycle({ idleExitMs: 1_000, checkMs: 10, onIdle() {}, now: () => clock });
    life.register("fake", () => work);
    life.register("broken", () => {
        throw new Error("source down");
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
        assert.equal(await life.check(), false, "a fresh service waits for its first window");
        clock = 1_000;
        assert.equal(await life.check(), true, "…but not forever");

        const detach = life.attach();
        clock = 60_000;
        assert.equal(await life.check(), false, "an attached window keeps it up");
        assert.equal(life.attached, 1);
        detach();
        detach();
        assert.equal(life.attached, 0, "detaching twice counts once");
        assert.equal(await life.check(), false, "the grace period starts when the window goes");
        clock += 999;
        assert.equal(await life.check(), false);
        clock += 1;
        assert.equal(await life.check(), true);

        work = [{ kind: "worker", label: "w1" }];
        clock += 10_000;
        assert.equal(await life.check(), false, "work in flight keeps it up");
        assert.deepEqual(await life.work(), work, "a broken source doesn't hide the others' work, nor pin the service");
        work = [];
        assert.equal(await life.check(), false, "the grace period starts again once the work ends");
        clock += 1_000;
        assert.equal(await life.check(), true);
    } finally {
        console.warn = warn;
    }
}

// ---- a source that doesn't answer counts as busy, without freezing the check ----
{
    const warn = console.warn;
    console.warn = () => {};
    try {
        const life = new ServiceLifecycle({ idleExitMs: 0, checkMs: 10, onIdle() {}, sourceTimeoutMs: 50 });
        life.register("stuck", () => new Promise(() => {}));
        life.register("quick", () => [{ kind: "lead", label: "Jarvis Lead reply" }]);
        const t0 = Date.now();
        const work = await life.work();
        assert.ok(Date.now() - t0 < 1_000, "a stuck source doesn't hold the check");
        assert.deepEqual(work.map((w) => w.label).sort(), ["Jarvis Lead reply", "stuck (not answering)"]);
        assert.equal(await life.check(), false, "…and keeps the service up rather than cutting work short");
    } finally {
        console.warn = warn;
    }
}

// ---- the real process ---------------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "service-harness-"));
const userData = join(root, "user");
const files = svc.serviceFiles(userData);
const env = { ADO_PR_OPS_SERVICE_IDLE_MS: "1500", ADO_PR_OPS_SERVICE_CHECK_MS: "100", ADO_PR_OPS_NO_COPILOT_WARMUP: "1" };
const options = { userData, appDir: repo, execPath: process.execPath, env };
const started = [];

try {
    // Started detached, and found again rather than started twice.
    const first = await svc.ensureService(options);
    assert.equal(first.kind, "ready");
    const a = first.status;
    started.push(a.pid);
    assert.ok(svc.isAlive(a.pid));
    assert.equal(a.buildId, svc.buildId(repo), "it runs this build");
    assert.equal(a.appDir, repo);
    assert.deepEqual(a.work, []);
    assert.equal(a.state, "running");
    assert.ok(existsSync(files.info) && existsSync(files.lock));
    assert.ok(svc.lockHeld(userData), "it holds the data folder's lock");
    assert.throws(() => readFileSync(files.lock), /EBUSY/, "…exclusively: nobody else can even read it");
    const again = await svc.ensureService(options);
    assert.equal(again.status.pid, a.pid, "a running service is reused");

    // One per data folder: a second one started by hand bows out.
    const second = spawn(process.execPath, [join(repo, "service.mjs")], {
        env: { ...process.env, ...env, ADO_PR_OPS_USER_DATA: userData },
        stdio: "ignore",
    });
    const code = await new Promise((r) => second.once("exit", r));
    assert.equal(code, 0, "the second service exits quietly");
    assert.ok(svc.isAlive(a.pid), "…and the first keeps running");
    assert.equal(svc.readServiceInfo(userData).pid, a.pid);

    // An attached window keeps it up well past the idle grace period.
    const attachment = svc.attachToService(a, () => {});
    await until(async () => (await svc.serviceStatus(a))?.attached === 1, "attached");
    await sleep(2_500);
    assert.ok(svc.isAlive(a.pid), "attached, it stays");

    // The window goes: it exits once idle, and cleans up after itself.
    attachment.close();
    await until(() => !svc.isAlive(a.pid), "idle exit", 10_000);
    assert.ok(!existsSync(files.info) && !existsSync(files.lock), "its files go with it");

    // A window notices when its service goes away.
    const b = (await svc.ensureService(options)).status;
    started.push(b.pid);
    let lost = false;
    svc.attachToService(b, () => (lost = true));
    await until(async () => (await svc.serviceStatus(b))?.attached === 1, "attached to b");
    process.kill(b.pid);
    await until(() => lost, "the window sees the loss");

    // Stale files from a service that died: the next start takes over.
    assert.ok(existsSync(files.info) || existsSync(files.lock), "a killed service leaves its files");
    writeFileSync(files.lock, "999999");
    const c = (await svc.ensureService(options)).status;
    started.push(c.pid);
    assert.notEqual(c.pid, b.pid);
    assert.equal(new URL(c.url).port, new URL(b.url).port, "a new service takes the last one's port, so the page keeps its storage");
    assert.equal(svc.readServicePort(userData), Number(new URL(c.url).port));

    // A service from other code is replaced when it's idle.
    const d = await svc.ensureService({ ...options, expectedBuildId: "another-build" });
    assert.equal(d.kind, "ready");
    started.push(d.status.pid);
    assert.notEqual(d.status.pid, c.pid, "an idle service from other code is stopped and replaced");
    assert.ok(!svc.isAlive(c.pid));

    // Asked to stop when idle, it stops.
    const stopped = await svc.stopService(d.status, { whenIdle: true });
    assert.deepEqual(stopped, { stopped: true });
    assert.ok(!svc.isAlive(d.status.pid));
    assert.ok(!existsSync(files.info) && !existsSync(files.lock));
    assert.equal(await svc.findService(userData), null);

    // A runtime that can't start says so instead of hanging.
    await assert.rejects(
        svc.startService({ ...options, execPath: join(root, "no-such-runtime.exe"), timeoutMs: 5_000 }),
        /didn't start/,
    );

    // Asked to stop when idle but no clear answer: it may be busy, so it's left alone, never killed.
    // (The pid is this harness's own: killing it would end the run.)
    const silent = { pid: process.pid, url: "http://127.0.0.1:1/", buildId: "x", appDir: repo, startedAt: new Date().toISOString() };
    const left = await svc.stopService(silent, { whenIdle: true });
    assert.deepEqual(left, { stopped: false, work: [], unanswered: true });
    assert.ok(svc.isAlive(process.pid));

    // A live pid without the lock is some other process that reused the pid: never "hung", never ended.
    writeFileSync(files.info, JSON.stringify(silent));
    await svc.endService(silent, userData);
    assert.ok(svc.isAlive(process.pid), "ending checks the lock first");
    const fresh = await svc.ensureService({ ...options, hangAfterMs: 300 });
    assert.equal(fresh.kind, "ready", "a free lock means no service: a fresh one starts");
    started.push(fresh.status.pid);
    await svc.stopService(fresh.status);

    // A process that holds the lock but never answers is hung: reported, never duplicated, and ended on request.
    const hangServer = createServer(() => {}); // takes requests, answers none
    await new Promise((r) => hangServer.listen(0, "127.0.0.1", r));
    const hangUrl = `http://127.0.0.1:${hangServer.address().port}/`;
    const holder = spawn(
        process.execPath,
        ["-e", `const fs=require("fs");fs.openSync(${JSON.stringify(files.lock)},fs.constants.O_RDWR|fs.constants.O_CREAT|0x10000000);process.stdout.write("held\\n");setInterval(()=>{},1000);`],
        { stdio: ["ignore", "pipe", "ignore"] },
    );
    started.push(holder.pid);
    await new Promise((r) => holder.stdout.once("data", r));
    const hungInfo = { pid: holder.pid, url: hangUrl, buildId: "x", appDir: repo, startedAt: new Date().toISOString() };
    writeFileSync(files.info, JSON.stringify(hungInfo));
    const hung = await svc.ensureService({ ...options, hangAfterMs: 500 });
    assert.equal(hung.kind, "unresponsive", "a hung service is reported");
    assert.equal(hung.info.pid, holder.pid);
    assert.ok(svc.isAlive(holder.pid), "…and left alone until asked");
    // The lock is held, but the info names a process that started after it was written: a reused
    // pid (the lock may be a newer service's). That process is never ended.
    const innocent = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    started.push(innocent.pid);
    await new Promise((r) => setTimeout(r, 300));
    const reused = { ...hungInfo, pid: innocent.pid, startedAt: new Date(Date.now() - 60_000).toISOString() };
    assert.equal(await svc.endService(reused, userData), false);
    assert.ok(svc.isAlive(innocent.pid), "a pid that started after its info was written is someone else's");
    assert.equal(await svc.endService({ ...hungInfo, startedAt: "" }, userData), false, "no start time, no kill");
    assert.ok(svc.isAlive(holder.pid));
    innocent.kill();
    assert.equal(await svc.endService(hung.info, userData), true);
    assert.ok(!svc.isAlive(holder.pid), "ending it ends the process that held the lock");
    const after = await svc.ensureService(options);
    assert.equal(after.kind, "ready", "with the lock free, a fresh service starts");
    started.push(after.status.pid);

    // The window's watch: a service that keeps the connection open but stops answering is flagged.
    const half = createServer((req, res) => {
        if (req.url === "/api/service/attach") return res.writeHead(200).write("attached\n");
        // status: never answers
    });
    await new Promise((r) => half.listen(0, "127.0.0.1", r));
    let flagged = 0;
    let gone = false;
    const watching = svc.watchService(
        { pid: process.pid, url: `http://127.0.0.1:${half.address().port}/`, buildId: "x", appDir: repo, startedAt: "" },
        { onLost: () => (gone = true), onUnresponsive: () => flagged++, intervalMs: 50, timeoutMs: 50, misses: 3 },
    );
    await until(() => flagged > 0, "unresponsive flagged", 5_000);
    assert.equal(gone, false, "hung isn't gone: the connection is still open");
    watching.close();
    half.closeAllConnections();
    half.close();

    // A stopping service turns a window away, and the window treats it as gone.
    const stoppingNow = svc.stopService(after.status);
    let refused = false;
    svc.watchService(after.status, { onLost: () => (refused = true), onUnresponsive() {}, intervalMs: 60_000 });
    await until(() => refused, "a stopping service turns the window away", 10_000);
    await stoppingNow;
    hangServer.closeAllConnections();
    hangServer.close();

    console.log("service harness: ok");
} finally {
    for (const pid of started) {
        try {
            if (svc.isAlive(pid)) process.kill(pid);
        } catch {
            /* gone */
        }
    }
    await sleep(300);
    rmSync(root, { recursive: true, force: true });
}
