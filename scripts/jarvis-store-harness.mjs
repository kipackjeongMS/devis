import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "jarvis-store-"));
process.env.ADO_PR_OPS_DB_PATH = join(root, "data", "reviews.db");
process.env.ADO_PR_OPS_JARVIS_DIR = join(root, "jarvis");

const store = await import("../jarvis-store.mjs");
const { closeDb } = await import("../store.mjs");

try {
    // ---- ids ----
    assert.equal(store.asJarvisId("../../etc/passwd"), null);
    assert.equal(store.asJarvisId(" 0A1B2C3D-0000-4000-8000-000000000000 "), "0a1b2c3d-0000-4000-8000-000000000000");
    assert.throws(() => store.notePath("..\\evil"), /invalid task id/);

    // ---- custom task + note.md ----
    const { task: custom, created } = await store.createTask({ title: "  Onboarding   docs refresh " });
    assert.equal(created, true);
    assert.equal(custom.title, "Onboarding docs refresh");
    assert.equal(custom.workItem, null);
    assert.equal(custom.status, "open");
    assert.equal(store.notePath(custom.id), join(root, "jarvis", "tasks", custom.id, "artifacts", "note.md"));
    assert.ok(existsSync(store.notePath(custom.id)), "note.md is created in the task's Artifacts");
    assert.match(await store.readNote(custom.id), /^# Onboarding docs refresh/);
    await store.appendNote(custom.id, "Rewrote setup.md.", "devtools-docs");
    assert.match(await store.readNote(custom.id), /## .+ · devtools-docs\n\nRewrote setup\.md\.\n$/);
    // An editor that started from an older copy can't overwrite a worker's newer entry.
    const opened = await store.readNote(custom.id);
    await store.appendNote(custom.id, "Worker entry while you edit.", "devtools-docs");
    await assert.rejects(store.writeNote(custom.id, opened + "\nmine", opened), /changed while you were editing/);
    assert.match(await store.readNote(custom.id), /Worker entry while you edit\./, "the worker's entry survives");
    const latest = await store.readNote(custom.id);
    await store.writeNote(custom.id, latest + "\nmine\n", latest);
    assert.match(await store.readNote(custom.id), /mine\n$/, "a save from the latest copy goes through");
    await store.writeNote(custom.id, latest, undefined);
    assert.equal(await store.readNote(custom.id), latest, "no base: a plain overwrite, as before");
    await assert.rejects(store.createTask({ title: "   " }), /needs a title/);

    // ---- artifacts ----
    for (const bad of ["", "../x.md", "a/b.md", "a\\b.md", "con.md", "LPT1.txt", "x.exe", ".hidden.md", "x..md", "a".repeat(90) + ".md", 42]) {
        assert.throws(() => store.artifactName(bad), /Name it like design\.md/, `rejects ${String(bad).slice(0, 20)}`);
    }
    assert.equal(store.artifactName("  design notes.md "), "design notes.md");
    const design = await store.writeArtifact(custom.id, "design.md", "# Design\n", { create: true });
    assert.equal(design.name, "design.md");
    assert.equal(design.content, "# Design\n");
    await assert.rejects(store.writeArtifact(custom.id, "design.md", "x", { create: true }), /already an artifact named design\.md/);
    await assert.rejects(store.writeArtifact(custom.id, "big.md", "x".repeat(store.ARTIFACT_MAX + 1)), /too long/);
    await assert.rejects(store.writeArtifact(custom.id, "x.md", 5), /text is missing/);
    await assert.rejects(store.writeArtifact(custom.id, "design.md", "mine", { base: "stale" }), /design\.md changed while you were editing/);
    await store.appendArtifact(custom.id, "findings.md", "Cache misses on cold start.", "appconfig");
    assert.match((await store.readArtifact(custom.id, "findings.md")).content, /^## .+ · appconfig\n\nCache misses on cold start\.\n$/, "append creates the file");
    await store.writeArtifact(custom.id, "recap.md", "# Recap\n");
    writeFileSync(join(store.artifactsDir(custom.id), ".note.md.1234.tmp"), "half");
    writeFileSync(join(store.artifactsDir(custom.id), "binary.exe"), "x");
    mkdirSync(join(store.artifactsDir(custom.id), "sub.md"));
    const names = (await store.listArtifacts(custom.id)).map((a) => a.name);
    assert.deepEqual(names.slice(0, 2), ["note.md", "recap.md"], "note.md, then recap.md, first");
    assert.deepEqual(names.slice(2).sort(), ["binary.exe", "design.md", "findings.md"], "every file is listed, whatever its type; temp files and folders are left out");
    await assert.rejects(store.readArtifact(custom.id, "missing.md"), /no artifact named missing\.md/);
    await assert.rejects(store.readArtifact(custom.id, "../note.md"), /Name it like/);
    await assert.rejects(store.deleteArtifact(custom.id, "NOTE.md"), /shared note/);
    await store.deleteArtifact(custom.id, "design.md");
    await assert.rejects(store.deleteArtifact(custom.id, "design.md"), /no artifact named design\.md/);
    await assert.rejects(store.listArtifacts("00000000-0000-4000-8000-000000000000"), /Task not found/);

    // ---- any file shows; only text is edited, and a new file still needs a text file's name ----
    const artsDir = store.artifactsDir(custom.id);
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    writeFileSync(join(artsDir, "shot.png"), png);
    writeFileSync(join(artsDir, "tool.bin"), Buffer.from([0x4d, 0x5a, 0x00, 0x01, 0xff]));
    writeFileSync(join(artsDir, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    writeFileSync(join(artsDir, "run.ps1"), "Write-Host hi\n");
    writeFileSync(join(artsDir, "résumé – notes.md"), "# Ünïcode\n");
    writeFileSync(join(artsDir, "huge.log"), "x".repeat(store.ARTIFACT_MAX + 1));
    writeFileSync(join(artsDir, "wide.md"), "é".repeat(store.ARTIFACT_MAX));
    const kinds = Object.fromEntries((await Promise.all(
        ["shot.png", "tool.bin", "latin1.txt", "run.ps1", "résumé – notes.md", "huge.log", "wide.md", "binary.exe", "note.md"].map((n) => store.readArtifact(custom.id, n)),
    )).map((a) => [a.name, a.kind]));
    assert.deepEqual(kinds, {
        "shot.png": "image",
        "tool.bin": "binary",
        "latin1.txt": "binary",
        "run.ps1": "text",
        "résumé – notes.md": "text",
        "huge.log": "large",
        "wide.md": "text",
        "binary.exe": "text",
        "note.md": "text",
    }, "a picture, a binary, text that isn't UTF-8, a script, a Unicode name, too long, and long only in bytes");
    const shot = await store.readArtifact(custom.id, "shot.png");
    assert.equal(shot.content, "", "only text comes back as content");
    assert.equal(shot.size, png.length);
    assert.equal(shot.path, join(artsDir, "shot.png"));
    assert.equal((await store.readArtifact(custom.id, "résumé – notes.md")).content, "# Ünïcode\n");
    assert.ok((await store.listArtifacts(custom.id)).some((a) => a.name === "résumé – notes.md"), "a Unicode name is listed");
    const script = await store.readArtifact(custom.id, "run.ps1");
    await store.writeArtifact(custom.id, "run.ps1", "Write-Host bye\n", { base: script.content });
    assert.equal(readFileSync(join(artsDir, "run.ps1"), "utf8"), "Write-Host bye\n", "an existing text file of any type can be edited");
    await store.appendArtifact(custom.id, "run.ps1", "# added", "me");
    assert.match(readFileSync(join(artsDir, "run.ps1"), "utf8"), /^Write-Host bye\n\n## .+ · me\n\n# added\n$/);
    await assert.rejects(store.writeArtifact(custom.id, "new.ps1", "x"), /Name it like design\.md/, "a new file still needs a text file's name");
    await assert.rejects(store.appendArtifact(custom.id, "new.exe", "x", "me"), /Name it like design\.md/);
    await assert.rejects(store.writeArtifact(custom.id, "tool.bin", "x"), /tool\.bin isn't a text file/);
    await assert.rejects(store.writeArtifact(custom.id, "latin1.txt", "x"), /isn't a text file/, "a save can't damage text in another encoding");
    await assert.rejects(store.appendArtifact(custom.id, "shot.png", "x", "me"), /shot\.png isn't a text file/);
    await assert.rejects(store.appendArtifact(custom.id, "huge.log", "x", "me"), /huge\.log is too large to change here/);
    await assert.rejects(store.writeArtifact(custom.id, "shot.png", "x", { create: true }), /already an artifact named shot\.png/);
    await assert.rejects(store.writeArtifact(custom.id, "sub.md", "x"), /sub\.md is a folder/);
    assert.equal(readFileSync(join(artsDir, "tool.bin")).length, 5, "a refused write leaves the file alone");
    assert.deepEqual(await store.artifactFile(custom.id, " tool.bin "), { name: "tool.bin", path: join(artsDir, "tool.bin"), size: 5 });
    await assert.rejects(store.artifactFile(custom.id, "missing.bin"), /no artifact named missing\.bin/);
    await assert.rejects(store.artifactFile(custom.id, "sub.md"), /no artifact named sub\.md/);
    for (const bad of ["../note.md", "..\\note.md", "C:\\x.png", ".hidden", "con.png", "x.png.", "a\u0001.png", 7]) {
        await assert.rejects(store.artifactFile(custom.id, bad), /Name it like/, `artifactFile rejects ${String(bad)}`);
    }
    assert.equal(store.artifactImageType("A.PNG"), "image/png");
    assert.equal(store.artifactImageType("x.svg"), "image/svg+xml");
    assert.equal(store.artifactImageType("x.png.exe"), null);
    for (const n of ["shot.png", "tool.bin", "latin1.txt", "run.ps1", "résumé – notes.md", "huge.log", "wide.md", "binary.exe"]) {
        await store.deleteArtifact(custom.id, n);
    }
    assert.ok(!existsSync(join(artsDir, "tool.bin")), "any file can be deleted");
    // A name ending in another kind of space isn't listed: trimmed, as names asked for are, it would be another file.
    const oddNames = ["report.md\u00a0", "report.md\u3000", "report.md\ufeff", "report.md\u2028"];
    writeFileSync(join(artsDir, "report.md"), "plain");
    for (const n of oddNames) writeFileSync(join(artsDir, n), "odd");
    const listedNames = (await store.listArtifacts(custom.id)).map((a) => a.name);
    assert.deepEqual(listedNames.filter((n) => n.startsWith("report.md")), ["report.md"], "only the plain name is listed");
    for (const n of listedNames) assert.equal(n.trim(), n, `${JSON.stringify(n)} is listed as it's asked for`);
    for (const n of oddNames) assert.equal(store.isListedArtifactName(n), false);
    await store.deleteArtifact(custom.id, "report.md");
    for (const n of oddNames) {
        assert.ok(existsSync(join(artsDir, n)), "deleting report.md leaves the odd names alone");
        rmSync(join(artsDir, n));
    }
    // The app's own notes stay text whatever a worker's shell wrote in them (another encoding, UTF-16), so the
    // shared note never locks: it reads as it did before, and appends and edits go through.
    const notePathOnDisk = join(artsDir, "note.md");
    const recapPathOnDisk = join(artsDir, "recap.md");
    const noteBytes = readFileSync(notePathOnDisk);
    const recapBytes = existsSync(recapPathOnDisk) ? readFileSync(recapPathOnDisk) : null;
    writeFileSync(notePathOnDisk, Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9]), Buffer.from(" with a NUL \u0000 here\n")]));
    const oddNote = await store.readArtifact(custom.id, "NOTE.md");
    assert.equal(oddNote.kind, "text", "note.md is text, whatever bytes it has");
    assert.equal(oddNote.content, "caf\ufffd with a NUL \u0000 here\n");
    await store.appendNote(custom.id, "Still takes entries.", "me");
    assert.match(await store.readNote(custom.id), /^caf\ufffd with a NUL [^]*## .+ · me\n\nStill takes entries\.\n$/);
    await store.writeNote(custom.id, "café\n", await store.readNote(custom.id));
    assert.equal(readFileSync(notePathOnDisk, "utf8"), "café\n", "an edit fixes it");
    writeFileSync(recapPathOnDisk, Buffer.from([0xff, 0xfe, 0x23, 0x00, 0x0a, 0x00]));
    assert.equal((await store.readArtifact(custom.id, "recap.md")).kind, "text", "recap.md too");
    await store.writeArtifact(custom.id, "recap.md", "# Recap\n");
    writeFileSync(notePathOnDisk, noteBytes);
    if (recapBytes) writeFileSync(recapPathOnDisk, recapBytes);
    else rmSync(recapPathOnDisk);
    // A cap per task, so a runaway worker can't fill the disk with files.
    for (let i = (await store.listArtifacts(custom.id)).length; i < store.ARTIFACTS_PER_TASK; i++) {
        await store.writeArtifact(custom.id, `f${i}.md`, "x");
    }
    await assert.rejects(store.writeArtifact(custom.id, "one-more.md", "x"), /already has 50 artifacts/);
    await assert.rejects(store.appendArtifact(custom.id, "one-more.md", "x", "me"), /already has 50 artifacts/);
    await store.writeArtifact(custom.id, "f10.md", "replacing is fine at the cap");
    for (let i = 3; i < store.ARTIFACTS_PER_TASK; i++) await store.deleteArtifact(custom.id, `f${i}.md`).catch(() => undefined);

    // ---- an old task.md moves into Artifacts as note.md, without its status copies ----
    const legacyNote = [
        "# Old task",
        "",
        "## Oct 1, 2026, 9:00 AM · appconfig",
        "",
        "Status: API change done, tests next",
        "",
        "## Oct 1, 2026, 9:05 AM · you",
        "",
        "Decided: keep the v1 schema.",
        "",
        "## Oct 1, 2026, 9:10 AM · appconfig",
        "",
        "Status: tests pass",
        "",
    ].join("\n");
    assert.equal(store.withoutStatusCopies(legacyNote), "# Old task\n\n## Oct 1, 2026, 9:05 AM · you\n\nDecided: keep the v1 schema.\n");
    assert.equal(store.withoutStatusCopies("## a · b\n\nStatus: x\nand more\n"), "## a · b\n\nStatus: x\nand more\n", "an entry with more than the status stays");
    const { task: old } = await store.createTask({ title: "Old task" });
    rmSync(store.artifactsDir(old.id), { recursive: true });
    const legacyPath = join(root, "jarvis", "tasks", `${old.id}.md`);
    writeFileSync(legacyPath, legacyNote);
    assert.match(await store.readNote(old.id), /Decided: keep the v1 schema\./);
    assert.doesNotMatch(await store.readNote(old.id), /Status:/);
    assert.ok(!existsSync(legacyPath), "the old file is gone");
    writeFileSync(legacyPath, "# Older copy\n");
    await store.listArtifacts(old.id);
    assert.equal((await store.readArtifact(old.id, "task.md")).content, "# Older copy\n", "with note.md taken, it arrives as task.md");
    assert.match(await store.readNote(old.id), /keep the v1 schema/);

    // ---- task-done listeners ----
    const doneSeen = [];
    const off = store.onTaskDone((t) => doneSeen.push([t.id, t.status]));
    await store.updateTask(old.id, { status: "done" });
    await store.updateTask(old.id, { status: "done" });
    await store.updateTask(old.id, { status: "open" });
    off();
    await store.updateTask(old.id, { status: "done" });
    assert.deepEqual(doneSeen, [[old.id, "done"]], "once per change to done, and not after unsubscribing");

    // ---- work item task: one task per work item ----
    const workItem = {
        id: 2841124,
        title: "Canary test scope",
        project: "Azure AppConfig",
        type: "Task",
        state: "Active",
        url: "https://dev.azure.com/msazure/Azure%20AppConfig/_workitems/edit/2841124",
        parent: { id: 2841117, type: "User Story", title: "Pin upstream artifacts in chains" },
    };
    const first = await store.createTask({ org: "msazure", workItem });
    assert.equal(first.created, true);
    assert.equal(first.task.project, "Azure AppConfig");
    assert.deepEqual(first.task.workItem.parent, workItem.parent);
    await assert.rejects(store.createTask({ workItem }), /needs its organization/);

    await store.updateTask(first.task.id, { status: "done" });
    const again = await store.createTask({ org: "MSAZURE", workItem });
    assert.equal(again.created, false, "the same work item (org compared case-insensitively) reuses its task");
    assert.equal(again.task.id, first.task.id);
    assert.equal(again.task.status, "open", "re-adding a done work item reopens it");

    await store.refreshWorkItems("msazure", [{ ...workItem, title: "Canary scope", state: "Resolved", parent: null }]);
    const refreshed = await store.getTask(first.task.id);
    assert.equal(refreshed.title, "Canary scope");
    assert.equal(refreshed.workItem.state, "Resolved");
    assert.equal(refreshed.workItem.parent, null);

    // ---- done tasks drop out of Today after their day ----
    await store.updateTask(custom.id, { status: "done" });
    const doneAt = (await store.getTask(custom.id)).doneAt;
    assert.ok(doneAt);
    assert.ok((await store.listTasks(doneAt)).some((t) => t.id === custom.id));
    assert.ok(!(await store.listTasks("9999-01-01")).some((t) => t.id === custom.id));
    assert.ok((await store.listTasks()).some((t) => t.id === first.task.id), "open tasks always list");
    // A done task whose worker is still live stays listed, so its approvals stay visible.
    await store.insertWorker({ sessionId: "22222222-2222-4222-8222-222222222222", taskId: custom.id, label: "live", cwd: root, model: null, state: "needsInput", summary: "" });
    assert.ok((await store.listTasks("9999-01-01")).some((t) => t.id === custom.id));
    await store.deleteWorker("22222222-2222-4222-8222-222222222222");

    // ---- workers ----
    const cwd = join(root, "repos", "AppConfig.Tests");
    assert.equal(store.workerAlias("AKS RBAC"), "aks-rbac");
    assert.equal(store.workerAlias("aks-rbac-2"), "aks-rbac-2", "a numbered task folder keeps its number");
    assert.equal(store.workerAlias("Investigate deployment failures in westus2"), "investigate-deployment", "a long alias is cut at a dash");
    assert.equal(store.workerAlias("x".repeat(40)), "x".repeat(30), "with no dash near the limit, at the limit");
    assert.equal(store.workerAlias("ab-" + "c".repeat(40)), "ab-" + "c".repeat(27), "a dash too early isn't used");
    assert.equal(store.workerAlias("!!!"), "task");
    const label = await store.nextWorkerName(first.task.id, "Canary scope");
    assert.equal(label, "canary-scope-worker-1", "a task's first worker");
    await store.insertWorker({
        sessionId: "11111111-1111-4111-8111-111111111111",
        taskId: first.task.id,
        label,
        cwd,
        model: null,
        state: "working",
        summary: "Starting",
    });
    {
        const idle = (sessionId, taskId, name) => store.insertWorker({ sessionId, taskId, label: name, cwd, model: null, state: "idle", summary: "" });
        const failed = await store.nextWorkerName(first.task.id, "Canary scope");
        assert.equal(failed, "canary-scope-worker-2");
        await store.releaseWorkerName(first.task.id, failed);
        const second = await store.nextWorkerName(first.task.id, "Canary scope");
        assert.equal(second, "canary-scope-worker-2", "a worker that never started gives its number back");
        await idle("33333333-3333-4333-8333-333333333333", first.task.id, second);
        await store.deleteWorker("33333333-3333-4333-8333-333333333333");
        const third = await store.nextWorkerName(first.task.id, "Canary scope");
        assert.equal(third, "canary-scope-worker-3", "a removed worker's number isn't used again");
        await store.releaseWorkerName(first.task.id, second);
        assert.equal(
            await store.nextWorkerName(first.task.id, "Canary scope", (name) => name !== "canary-scope-worker-4"),
            "canary-scope-worker-5",
            "releasing an older number changes nothing; a name whose folder is taken is skipped",
        );
        // A task from before the count numbers after the workers it has.
        await idle("44444444-4444-4444-8444-444444444444", old.id, "atlas");
        await idle("55555555-5555-4555-8555-555555555555", old.id, "birch");
        assert.equal(await store.nextWorkerName(old.id, old.title), "old-task-worker-3");
        await store.deleteWorker("44444444-4444-4444-8444-444444444444");
        await store.deleteWorker("55555555-5555-4555-8555-555555555555");
        // Two folderless tasks with one title don't share a name.
        assert.equal(await store.nextWorkerName(custom.id, "Canary scope"), "canary-scope-worker-2", "another task's worker has worker-1");
    }
    await store.updateWorker("11111111-1111-4111-8111-111111111111", { state: "needsInput", autoApprove: true, summary: "x".repeat(900) });
    let worker = await store.getWorker("11111111-1111-4111-8111-111111111111");
    assert.equal(worker.state, "needsInput");
    assert.equal(worker.autoApprove, true);
    assert.ok(worker.summary.length <= 600 && worker.summary.endsWith("…"), "summaries are clipped");
    assert.deepEqual(await store.recentFolders(), [cwd]);
    // stateAt moves when the state changes, not on any other update (a model switch).
    {
        const id = "11111111-1111-4111-8111-111111111111";
        const before = (await store.getWorker(id)).stateAt;
        await new Promise((r) => setTimeout(r, 5));
        await store.updateWorker(id, { model: "gpt-x" });
        assert.equal((await store.getWorker(id)).stateAt, before, "a model switch leaves stateAt");
        await store.updateWorker(id, { state: "needsInput", summary: "same state" });
        assert.equal((await store.getWorker(id)).stateAt, before, "the same state again leaves it too");
        await store.updateWorker(id, { state: "error" });
        const failedAt = (await store.getWorker(id)).stateAt;
        assert.ok(failedAt > before, "a new state moves it");
        await store.updateWorker(id, { state: "needsInput" });
    }

    // ---- a restart turns live workers idle and records it ----
    closeDb();
    store.resetJarvisDb();
    worker = await store.getWorker("11111111-1111-4111-8111-111111111111");
    assert.equal(worker.state, "idle");
    assert.match(worker.summary, /Interrupted/);
    const interrupted = await store.listEvents({ kinds: ["worker.interrupted"] });
    assert.equal(interrupted.length, 1);
    assert.equal(interrupted[0].taskId, first.task.id);

    // ---- history ----
    await store.recordEvent("pr.reviewed", "Approved PR #17510211", { ref: { org: "msazure", prId: 17510211, vote: 10 } });
    const events = await store.listEvents();
    assert.equal(events[0].kind, "pr.reviewed", "newest first");
    assert.deepEqual(events[0].ref, { org: "msazure", prId: 17510211, vote: 10 });
    assert.ok(events.some((e) => e.kind === "task.created"));
    assert.ok(events.some((e) => e.kind === "task.done"));
    assert.ok(events.some((e) => e.kind === "task.reopened"));
    assert.equal((await store.listEvents({ taskId: custom.id, kinds: ["task.done"] })).length, 1);

    // ---- meta ----
    await store.setMeta("leadSessionId", "abc");
    assert.equal(await store.getMeta("leadSessionId"), "abc");
    await store.setMeta("leadSessionId", null);
    assert.equal(await store.getMeta("leadSessionId"), null);

    // ---- a task's timeline pages back over its whole life ----
    for (let i = 0; i < 5; i++) await store.insertStatus({ taskId: first.task.id, author: "w", text: `s${i}` });
    const newest = await store.listStatuses({ taskId: first.task.id, limit: 2 });
    assert.deepEqual(newest.map((s) => s.text), ["s4", "s3"], "newest first");
    const older = await store.listStatuses({ taskId: first.task.id, before: newest[1].id, limit: 2 });
    assert.deepEqual(older.map((s) => s.text), ["s2", "s1"]);
    const oldest = await store.listStatuses({ taskId: first.task.id, before: older[1].id, limit: 2 });
    assert.deepEqual(oldest.map((s) => s.text), ["s0"]);
    assert.equal((await store.listStatuses({ taskId: first.task.id, before: 0 })).length, 5, "no cursor, no filter");

    // ---- removing: hidden from Today first, then deleted; the Artifacts folder stays ----
    await store.beginRemoval(first.task.id);
    await store.beginRemoval(first.task.id);
    assert.equal((await store.listEvents({ taskId: first.task.id, kinds: ["task.removing"] })).length, 1, "recorded once");
    assert.ok(await store.isRemoving(first.task.id));
    assert.ok(!(await store.listTasks()).some((t) => t.id === first.task.id), "a task being removed leaves Today");
    assert.ok(await store.getTask(first.task.id), "but stays readable while its recap is written");
    assert.deepEqual(await store.pendingRemovals(), [first.task.id]);
    await assert.rejects(store.createTask({ org: "msazure", workItem }), /being removed/);
    await assert.rejects(store.updateTask(first.task.id, { status: "done" }), /being removed/);
    // The flag survives a restart, so the removal can finish.
    closeDb();
    store.resetJarvisDb();
    assert.deepEqual(await store.pendingRemovals(), [first.task.id]);

    const sessions = await store.deleteTask(first.task.id);
    assert.deepEqual(sessions, ["11111111-1111-4111-8111-111111111111"]);
    assert.equal(await store.getTask(first.task.id), null);
    assert.equal(await store.getWorker("11111111-1111-4111-8111-111111111111"), null);
    assert.deepEqual(await store.pendingRemovals(), []);
    assert.ok(existsSync(store.notePath(first.task.id)), "the Artifacts folder stays on disk");
    const record = JSON.parse(readFileSync(join(store.taskDir(first.task.id), "task.json"), "utf8"));
    assert.equal(record.title, "Canary scope");
    assert.equal(record.workItem.id, 2841124);
    assert.ok(record.removedAt);
    await assert.rejects(store.readNote(first.task.id), /not found/);
    assert.equal((await store.listEvents({ taskId: first.task.id, kinds: ["task.deleted"] }))[0].text, "Removed: Task #2841124 Canary scope");

    // ---- the lead was called Jarvis: what it signed then reads as Devis after a restart ----
    {
        const kept = (await store.createTask({ title: "Rename check" })).task;
        const jdb = await store.jarvisDb();
        await store.insertStatus({ taskId: kept.id, author: "Jarvis", text: "signed by the old name" });
        await store.insertStatus({ taskId: kept.id, author: "appconfig", text: "a worker's" });
        const t = new Date().toISOString();
        jdb.prepare("INSERT INTO jarvis_todos (text, done, position, author, created_at, updated_at) VALUES (?, 0, 1, ?, ?, ?)").run("old todo", "Jarvis", t, t);
        closeDb();
        store.resetJarvisDb();
        const statuses = await store.listStatuses({ taskId: kept.id, limit: 2 });
        assert.deepEqual(statuses.map((s) => s.author), ["appconfig", "Devis"], "the lead's lines read Devis; others keep their names");
        const todos = (await store.jarvisDb()).prepare("SELECT author FROM jarvis_todos WHERE text = 'old todo'").all();
        assert.deepEqual(todos.map((r) => r.author), ["Devis"]);
    }

    console.log("jarvis-store harness: ok");
} finally {
    closeDb();
    rmSync(root, { recursive: true, force: true });
}
