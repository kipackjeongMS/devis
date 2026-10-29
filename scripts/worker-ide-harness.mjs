import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "worker-ide-"));
process.env.ADO_PR_OPS_DB_PATH = join(root, "data", "reviews.db");
process.env.ADO_PR_OPS_JARVIS_DIR = join(root, "jarvis");
const store = await import("../jarvis-store.mjs");
const { openWorkerIde } = await import("../jarvis-workers.mjs");
const { openWorkspaceIde } = await import("../workspace-ide.mjs");
const { handleJarvisApi } = await import("../jarvis-api.mjs");
const { closeDb } = await import("../store.mjs");
const originalSpawn = childProcess.spawn;
const envKeys = ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "PATH", "ELECTRON_RUN_AS_NODE", "VSCODE_IPC_HOOK_CLI"];
const oldEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
const calls = [];
let spawnError = null;
let unrefs = 0;
let server;

function install(path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "fake editor");
}

try {
    for (const key of envKeys) delete process.env[key];
    process.env.LOCALAPPDATA = join(root, "Local AppData");
    process.env.ProgramFiles = join(root, "Program Files");
    process.env["ProgramFiles(x86)"] = join(root, "Program Files (x86)");
    process.env.ELECTRON_RUN_AS_NODE = "1";
    process.env.VSCODE_IPC_HOOK_CLI = "another-editor-pipe";
    childProcess.spawn = (command, args, options) => {
        calls.push({ command, args, options });
        const child = new EventEmitter();
        child.unref = () => unrefs++;
        queueMicrotask(() => child.emit(spawnError ? "error" : "spawn", ...(spawnError ? [spawnError] : [])));
        return child;
    };
    syncBuiltinESMExports();

    const { task } = await store.createTask({ title: "IDE actions" });
    const worker = async (label, cwd, state = "turnDone") => {
        mkdirSync(cwd, { recursive: true });
        return store.insertWorker({ sessionId: randomUUID(), taskId: task.id, label, cwd, model: null, state, summary: "Keep this state" });
    };
    const atlas = await worker("atlas", join(root, "Task with spaces & %", "atlas"), "working");
    const birch = await worker("birch", join(root, "Task with spaces & %", "birch"));
    const legacy = await worker("legacy", join(root, "existing checkout"));

    await assert.rejects(openWorkerIde("not-an-id", "vscode"), (e) => e.status === 404);
    await assert.rejects(openWorkerIde(randomUUID(), "vscode"), (e) => e.status === 404);
    for (const bad of [undefined, null, "", "code", "vscode & calc", {}, ["vscode"]]) {
        await assert.rejects(openWorkerIde(atlas.sessionId, bad), (e) => e.status === 400);
    }
    await assert.rejects(openWorkerIde(atlas.sessionId, "vscode"), /VSCode was not found/);
    await assert.rejects(openWorkerIde(atlas.sessionId, "vscode-insiders"), /VSCode Insiders was not found/);
    assert.equal(calls.length, 0, "bad requests never launch a process");

    const stable = join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe");
    const insiders = join(process.env.ProgramFiles, "Microsoft VS Code Insiders", "Code - Insiders.exe");
    install(stable);
    install(insiders);
    await openWorkerIde(atlas.sessionId, "vscode");
    await openWorkerIde(birch.sessionId, "vscode-insiders");
    await openWorkerIde(legacy.sessionId, "vscode");
    assert.deepEqual(calls.map((c) => [c.command, c.args, c.options.cwd]), [
        [stable, ["--new-window", atlas.cwd], atlas.cwd],
        [insiders, ["--new-window", birch.cwd], birch.cwd],
        [stable, ["--new-window", legacy.cwd], legacy.cwd],
    ], "each edition opens only the selected worker's folder, including legacy folders");
    assert.equal(unrefs, 3, "IDE windows outlive the service");
    for (const { options } of calls) {
        assert.equal(options.detached, true);
        assert.equal(options.stdio, "ignore");
        assert.ok(!options.shell, "paths and metacharacters never pass through a shell");
        assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
        assert.equal(options.env.VSCODE_IPC_HOOK_CLI, undefined);
    }
    assert.deepEqual(await store.getWorker(atlas.sessionId), atlas, "opening a working worker's IDE changes no session state");
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, "1", "the service's environment stays untouched");

    // Custom/portable installs on PATH, including the standard bin entry.
    rmSync(stable);
    const portable = join(root, "portable editor", "Code.exe");
    install(portable);
    process.env.PATH = `"${join(dirname(portable), "bin")}"`;
    await openWorkerIde(atlas.sessionId, "vscode");
    assert.equal(calls.at(-1).command, portable);
    process.env.PATH = dirname(portable);
    await openWorkerIde(birch.sessionId, "vscode");
    assert.equal(calls.at(-1).command, portable);

    // Real HTTP boundary; the browser supplies an ID and edition, never a folder or command.
    server = createServer((req, res) => void handleJarvisApi(req, res, new URL(req.url, "http://localhost")));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/jarvis/workers/ide`;
    const post = async (body) => {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        return { status: res.status, body: await res.json() };
    };
    assert.deepEqual(await post({ sessionId: birch.sessionId, ide: "vscode-insiders", cwd: atlas.cwd }), { status: 200, body: { ok: true } });
    assert.equal(calls.at(-1).options.cwd, birch.cwd, "a supplied cwd cannot redirect the launch");
    assert.equal((await post({ sessionId: atlas.sessionId, ide: "terminal" })).status, 400);
    assert.equal((await post({ ide: "vscode" })).status, 404);
    spawnError = new Error("Access denied");
    const failure = await post({ sessionId: atlas.sessionId, ide: "vscode" });
    assert.equal(failure.status, 500);
    assert.match(failure.body.error, /Could not open VSCode: Access denied/);
    spawnError = null;
    const beforeMissing = calls.length;
    rmSync(birch.cwd, { recursive: true });
    const missing = await post({ sessionId: birch.sessionId, ide: "vscode-insiders" });
    assert.equal(missing.status, 409);
    assert.match(missing.body.error, /folder no longer exists/);
    await assert.rejects(openWorkspaceIde("relative", "vscode"), (e) => e.status === 409);
    assert.equal(calls.length, beforeMissing);
    console.log("worker-ide-harness: ok");
} finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    for (const [key, value] of oldEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    closeDb();
    rmSync(root, { recursive: true, force: true });
}
