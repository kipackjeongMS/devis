// Checks the code window's backend: the change list and file diff of a worker's
// worktrees, read from a real temporary git repo, and the path guard. Run after
// `npm run build`: node scripts/worker-changes-harness.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "worker-changes-"));
process.env.ADO_PR_OPS_DB_PATH = join(root, "data", "reviews.db");
process.env.ADO_PR_OPS_JARVIS_DIR = join(root, "jarvis");
const store = await import("../jarvis-store.mjs");
const changes = await import("../worker-changes.mjs");
const { handleJarvisApi } = await import("../jarvis-api.mjs");
const { closeDb } = await import("../store.mjs");
let server;
let watcher;

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
function write(path, content) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}
const lines = (n, label = "line") => Array.from({ length: n }, (_, i) => `${label} ${i + 1}`).join("\n") + "\n";
const UNICODE = "dir with space/ünïcode.txt";

try {
    // ---- a clone with a worker worktree, like the app makes ----
    const clone = join(root, "codebase", "org", "proj", "repo");
    mkdirSync(clone, { recursive: true });
    git(clone, "init", "-q", "-b", "master");
    git(clone, "config", "user.name", "Harness");
    git(clone, "config", "user.email", "harness@example.com");
    git(clone, "config", "core.autocrlf", "false");
    write(join(clone, "a.txt"), lines(10));
    write(join(clone, "crlf.txt"), "one\r\ntwo\r\nthree\r\n");
    write(join(clone, "to-delete.txt"), lines(4, "gone"));
    write(join(clone, "to-rename.txt"), lines(12, "moving"));
    write(join(clone, "bin.dat"), Buffer.from([1, 2, 0, 3, 4, 0, 5]));
    write(join(clone, UNICODE), "héllo\nwörld\n");
    write(join(clone, "same.txt"), lines(3, "same"));
    write(join(clone, "logo.bin"), Buffer.from([0, 1, 2, 0, 3]));
    git(clone, "add", "-A");
    git(clone, "commit", "-q", "-m", "base");

    const tree = join(root, "Task folder", "atlas", "repo");
    git(clone, "worktree", "add", "-q", "-b", "me/task/atlas", tree, "master");
    const { task } = await store.createTask({ title: "Code window" });
    const atlas = await store.insertWorker({ sessionId: randomUUID(), taskId: task.id, label: "atlas", cwd: dirname(tree), model: null, state: "turnDone", summary: "" });
    const wt = { sessionId: atlas.sessionId, taskId: task.id, org: "org", project: "proj", repo: "repo", path: tree, branch: "me/task/atlas", base: "master", clonePath: clone };
    await store.insertWorktree(wt);
    const key = "org/proj/repo";

    // Two commits on the worker's branch.
    write(join(tree, "a.txt"), lines(10).replace("line 3\n", "line three\n"));
    write(join(tree, "src", "new.ts"), "export const x = 1;\nexport const y = 2;\n");
    git(tree, "add", "-A");
    git(tree, "commit", "-q", "-m", "first");
    write(join(tree, UNICODE), "héllo\nwörld!\n");
    git(tree, "commit", "-q", "-am", "second");

    // Uncommitted: staged, unstaged, rename, delete, binary, untracked.
    write(join(tree, "a.txt"), lines(10).replace("line 3\n", "line three\n").replace("line 7\n", "line seven\n"));
    git(tree, "add", "a.txt");
    write(join(tree, "crlf.txt"), "one\r\nTWO\r\nthree\r\n");
    git(tree, "mv", "to-rename.txt", "renamed.txt");
    unlinkSync(join(tree, "to-delete.txt"));
    write(join(tree, "bin.dat"), Buffer.from([1, 2, 0, 3, 9, 0, 5, 6]));
    write(join(tree, "notes", "todo.md"), "- one\n- two\n- three\n");
    write(join(tree, "img.bin"), Buffer.from([0, 0, 0, 1]));
    write(join(tree, "big.txt"), lines(7000));
    write(join(tree, "huge.txt"), "x".repeat(2 * 1024 * 1024 + 10));

    // Make the index's stat data stale, so a git that may refresh the index would rewrite it.
    const gitDir = resolve(tree, git(tree, "rev-parse", "--git-dir"));
    const indexPath = join(gitDir, "index");
    const later = new Date(Date.now() + 5000);
    for (const touched of ["src/new.ts", "same.txt", "logo.bin"]) utimesSync(join(tree, touched), later, later);
    const indexBefore = readFileSync(indexPath);
    const locks = [];
    watcher = watch(gitDir, (_event, name) => {
        if (String(name).includes("index.lock")) locks.push(String(name));
    });

    // ---- the change list ----
    const byPath = (repo) => Object.fromEntries(repo.files.map((f) => [f.path, f]));
    const branch = await changes.listWorkerChanges(atlas.sessionId, "branch");
    assert.equal(branch.mode, "branch");
    assert.deepEqual(branch.worker, { name: "atlas", task: "Code window", busy: false, state: "turnDone", taskId: task.id });
    assert.equal(branch.repos.length, 1);
    const repo = branch.repos[0];
    assert.equal(repo.key, key);
    assert.equal(repo.name, "repo");
    assert.equal(repo.branch, "me/task/atlas");
    assert.equal(repo.base, "master");
    assert.equal(repo.fromRef, git(clone, "rev-parse", "master").slice(0, 7));
    assert.equal(repo.error, undefined);
    const f = byPath(repo);
    assert.deepEqual(Object.keys(f), ["a.txt", "big.txt", "bin.dat", "crlf.txt", UNICODE, "huge.txt", "img.bin", "notes/todo.md", "renamed.txt", "src/new.ts", "to-delete.txt"]);
    assert.equal(f["a.txt"].status, "M");
    assert.deepEqual([f["a.txt"].added, f["a.txt"].removed], [2, 2]);
    assert.equal(f["src/new.ts"].status, "A");
    assert.deepEqual([f["src/new.ts"].added, f["src/new.ts"].removed], [2, 0]);
    assert.equal(f[UNICODE].status, "M", "spaces and non-ASCII paths come back intact");
    assert.equal(f["crlf.txt"].status, "M");
    assert.equal(f["renamed.txt"].status, "R");
    assert.equal(f["renamed.txt"].oldPath, "to-rename.txt");
    assert.equal(f["to-delete.txt"].status, "D");
    assert.equal(f["to-delete.txt"].size, undefined);
    assert.equal(f["bin.dat"].binary, true);
    assert.equal(f["bin.dat"].added, null);
    assert.equal(f["notes/todo.md"].status, "U");
    assert.deepEqual([f["notes/todo.md"].added, f["notes/todo.md"].removed], [3, 0]);
    assert.equal(f["img.bin"].binary, true);
    assert.equal(f["big.txt"].added, 7000);
    assert.equal(f["huge.txt"].added, null, "files over the read cap aren't read to count lines");
    assert.equal(f["a.txt"].size, statSync(join(tree, "a.txt")).size);
    assert.ok(f["a.txt"].mtimeMs > 0);

    const uncommitted = byPath((await changes.listWorkerChanges(atlas.sessionId, "uncommitted")).repos[0]);
    assert.deepEqual(Object.keys(uncommitted), ["a.txt", "big.txt", "bin.dat", "crlf.txt", "huge.txt", "img.bin", "notes/todo.md", "renamed.txt", "to-delete.txt"]);
    assert.deepEqual([uncommitted["a.txt"].added, uncommitted["a.txt"].removed], [1, 1]);

    const last = (await changes.listWorkerChanges(atlas.sessionId, "last")).repos[0];
    assert.deepEqual(last.files.map((x) => [x.path, x.status, x.added, x.removed]), [[UNICODE, "M", 1, 1]]);
    assert.equal(last.fromRef, git(tree, "rev-parse", "HEAD~1").slice(0, 7));
    assert.equal(last.head, git(tree, "rev-parse", "HEAD"));
    assert.equal(last.files[0].size, undefined, "Last commit has no working side");

    // ---- one file's diff ----
    const diff = (path, mode = "branch", oldPath) => changes.workerFileDiff(atlas.sessionId, key, path, mode, oldPath);
    const ops = (d) => d.hunks.flat().filter((l) => l.t !== "ctx").map((l) => `${l.t}:${l.text}`);
    const aDiff = await diff("a.txt");
    assert.deepEqual(ops(aDiff), ["del:line 3", "add:line three", "del:line 7", "add:line seven"]);
    assert.equal(aDiff.editable, true);
    assert.equal(aDiff.hash, createHash("sha256").update(readFileSync(join(tree, "a.txt"))).digest("hex"));
    assert.deepEqual([aDiff.oldCount, aDiff.newCount], [10, 10]);
    assert.deepEqual(ops(await diff("a.txt", "uncommitted")), ["del:line 7", "add:line seven"]);
    const crlf = await diff("crlf.txt");
    assert.deepEqual(ops(crlf), ["del:two", "add:TWO"], "CRLF lines diff without carriage returns");
    assert.deepEqual(ops(await diff("src/new.ts")), ["add:export const x = 1;", "add:export const y = 2;"]);
    const deleted = await diff("to-delete.txt");
    assert.deepEqual(ops(deleted), ["del:gone 1", "del:gone 2", "del:gone 3", "del:gone 4"]);
    assert.equal(deleted.editable, false);
    const renamed = await diff("renamed.txt", "branch", "to-rename.txt");
    assert.deepEqual(renamed.hunks, [], "an unchanged rename has no textual changes");
    assert.equal(renamed.oldCount, 12);
    assert.deepEqual(ops(await diff("notes/todo.md")), ["add:- one", "add:- two", "add:- three"]);
    assert.deepEqual(ops(await diff(UNICODE)), ["del:wörld", "add:wörld!"]);
    assert.deepEqual(ops(await diff(UNICODE.replace(/\//g, "\\"))), ["del:wörld", "add:wörld!"], "backslashes work as separators");
    const lastDiff = await diff(UNICODE, "last");
    assert.deepEqual(ops(lastDiff), ["del:wörld", "add:wörld!"]);
    assert.equal(lastDiff.editable, false, "history isn't editable");
    const bin = await diff("bin.dat");
    assert.equal(bin.binary, true);
    assert.equal(bin.hunks, undefined);
    assert.deepEqual([bin.oldSize, bin.newSize], [7, 8]);
    assert.equal(bin.editable, false);
    const big = await diff("big.txt");
    assert.equal(big.tooLarge, true);
    assert.deepEqual([big.oldCount, big.newCount], [0, 7000]);
    const huge = await diff("huge.txt");
    assert.equal(huge.tooLarge, true);
    assert.equal(huge.newSize, 2 * 1024 * 1024 + 10);
    assert.equal(huge.editable, false);

    // Nothing here took the index lock or rewrote the index.
    await new Promise((r) => setTimeout(r, 200));
    watcher.close();
    watcher = null;
    assert.deepEqual(locks, [], "index.lock is never created");
    assert.ok(readFileSync(indexPath).equals(indexBefore), "the index is untouched");
    assert.ok(!existsSync(join(gitDir, "index.lock")));
    git(tree, "diff", "HEAD", "--stat");
    assert.ok(!readFileSync(indexPath).equals(indexBefore), "control: porcelain diff does rewrite this stale index");

    // ---- the path guard ----
    for (const bad of ["", "../outside.txt", "a/../../x", "/etc/passwd", "\\\\server\\share\\x", "C:/x", "C:x", "a\0b", ".git/config", ".git", "sub/.GIT/x", ".git./config", ".git /config", "a//b", "./a.txt", "a/./b", "...", "x".repeat(5000), 42, null]) {
        assert.throws(() => changes.cleanRelPath(bad), (e) => e.status === 400, `rejects ${JSON.stringify(bad)?.slice(0, 40)}`);
        await assert.rejects(changes.workerFileDiff(atlas.sessionId, key, bad, "branch"), (e) => e.status === 400);
    }
    assert.equal(changes.cleanRelPath(".gitignore"), ".gitignore");
    assert.equal(changes.cleanRelPath("a\\b.txt"), "a/b.txt");
    await assert.rejects(diff("a.txt", "branch", "../../secret"), (e) => e.status === 400, "the old path is checked too");
    await assert.rejects(diff("src"), (e) => e.status === 400, "a folder isn't a file");

    const outside = join(root, "outside");
    write(join(outside, "secret.txt"), "secret\n");
    symlinkSync(outside, join(tree, "link"), "junction");
    await assert.rejects(diff("link/secret.txt"), /outside the worktree/, "a junction can't lead out");
    const resolved = await changes.resolveWorkerPath(atlas.sessionId, key, "notes/todo.md");
    assert.equal(resolved.abs, join(tree, "notes", "todo.md"));
    const withLink = byPath((await changes.listWorkerChanges(atlas.sessionId, "branch")).repos[0]);
    for (const [path, file] of Object.entries(withLink)) {
        if (path.startsWith("link")) assert.equal(file.added, null, "lines behind a junction aren't counted");
    }
    if (existsSync(join(tree, "GIT~1"))) {
        await assert.rejects(diff("GIT~1"), (e) => e.status === 400, "a short name can't reach .git");
    }

    // ---- other workers and repos ----
    const birchTree = join(root, "Task folder", "birch", "repo");
    git(clone, "worktree", "add", "-q", "-b", "me/task/birch", birchTree, "master");
    const birch = await store.insertWorker({ sessionId: randomUUID(), taskId: task.id, label: "birch", cwd: dirname(birchTree), model: null, state: "idle", summary: "" });
    await store.insertWorktree({ ...wt, sessionId: birch.sessionId, path: birchTree, branch: "me/task/birch" });
    await store.insertWorktree({ ...wt, sessionId: birch.sessionId, repo: "gone", path: join(root, "Task folder", "birch", "gone") });
    const birchLast = await changes.listWorkerChanges(birch.sessionId, "last");
    const [gone, fresh] = birchLast.repos.sort((a, b) => a.name.localeCompare(b.name));
    assert.match(gone.error, /folder is gone/, "a missing worktree fails alone");
    assert.equal(fresh.note, "birch hasn't committed yet");
    assert.deepEqual(fresh.files, []);
    assert.deepEqual((await changes.listWorkerChanges(birch.sessionId, "branch")).repos.find((r) => r.name === "repo").files, []);
    await assert.rejects(changes.workerFileDiff(birch.sessionId, key, "../atlas/repo/a.txt", "branch"), (e) => e.status === 400);
    await assert.rejects(changes.workerFileDiff(birch.sessionId, "org/proj/other", "a.txt", "branch"), (e) => e.status === 404);

    const legacy = await store.insertWorker({ sessionId: randomUUID(), taskId: task.id, label: "legacy", cwd: root, model: null, state: "idle", summary: "" });
    assert.deepEqual((await changes.listWorkerChanges(legacy.sessionId)).repos, [], "a worker with no worktrees has no changes");
    await assert.rejects(changes.listWorkerChanges(atlas.sessionId, "all"), (e) => e.status === 400);
    await assert.rejects(changes.listWorkerChanges(randomUUID(), "branch"), (e) => e.status === 404);
    await assert.rejects(changes.listWorkerChanges("not-an-id", "branch"), (e) => e.status === 404);

    // ---- HTTP ----
    server = createServer((req, res) => void handleJarvisApi(req, res, new URL(req.url, "http://localhost")));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}/api/jarvis/workers`;
    const get = async (path, params) => {
        const res = await fetch(`${base}/${path}?${new URLSearchParams(params)}`);
        return { status: res.status, body: await res.json() };
    };
    const listed = await get("changes", { sessionId: atlas.sessionId, mode: "uncommitted" });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.repos[0].files.find((x) => x.path === "a.txt").added, 1);
    assert.equal((await get("changes", { sessionId: randomUUID() })).status, 404);
    assert.equal((await get("changes", { sessionId: atlas.sessionId, mode: "nope" })).status, 400);
    assert.deepEqual((await get("changes", { sessionId: legacy.sessionId })).body.repos, []);
    const httpDiff = await get("diff", { sessionId: atlas.sessionId, repo: key, path: UNICODE, mode: "branch" });
    assert.equal(httpDiff.status, 200);
    assert.deepEqual(ops(httpDiff.body), ["del:wörld", "add:wörld!"]);
    assert.equal((await get("diff", { sessionId: atlas.sessionId, repo: "org/proj/nope", path: "a.txt", mode: "branch" })).status, 404);
    const escape = await get("diff", { sessionId: atlas.sessionId, repo: key, path: "../../../outside/secret.txt", mode: "branch" });
    assert.equal(escape.status, 400);
    assert.ok(!JSON.stringify(escape.body).includes("secret\\n"));
    assert.equal((await get("diff", { sessionId: atlas.sessionId, repo: key, path: ".git/config", mode: "branch" })).status, 400);
    assert.equal((await get("diff", { sessionId: atlas.sessionId, repo: key, mode: "branch" })).status, 400);

    console.log("worker-changes-harness: ok");
} finally {
    watcher?.close();
    if (server) await new Promise((r) => server.close(r));
    closeDb();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
