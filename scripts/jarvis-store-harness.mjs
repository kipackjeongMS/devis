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
    assert.deepEqual(names.slice(2).sort(), ["design.md", "findings.md"], "temp files, other types and folders are left out");
    await assert.rejects(store.readArtifact(custom.id, "missing.md"), /no artifact named missing\.md/);
    await assert.rejects(store.readArtifact(custom.id, "../note.md"), /Name it like/);
    await assert.rejects(store.deleteArtifact(custom.id, "NOTE.md"), /shared note/);
    await store.deleteArtifact(custom.id, "design.md");
    await assert.rejects(store.deleteArtifact(custom.id, "design.md"), /no artifact named design\.md/);
    await assert.rejects(store.listArtifacts("00000000-0000-4000-8000-000000000000"), /Task not found/);
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
    assert.equal(await store.nextWorkerLabel(cwd), "appconfig.tests");
    await store.insertWorker({
        sessionId: "11111111-1111-4111-8111-111111111111",
        taskId: first.task.id,
        label: await store.nextWorkerLabel(cwd),
        cwd,
        model: null,
        state: "working",
        summary: "Starting",
    });
    assert.equal(await store.nextWorkerLabel(cwd + "\\"), "appconfig.tests-2", "labels are numbered when the folder repeats");
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
