// The user's notes: to-dos in their order, checked off and back, moved, cleared;
// the quick note saved against the version it started from; and what the Lead
// and workers can do with them.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "jarvis-notes-"));
process.env.ADO_PR_OPS_DB_PATH = join(root, "data", "reviews.db");
process.env.ADO_PR_OPS_JARVIS_DIR = join(root, "jarvis");

const notes = await import("../jarvis-notes.mjs");
const { closeDb } = await import("../store.mjs");

const texts = async () => (await notes.listTodos()).map((t) => `${t.done ? "x" : " "} ${t.text}`);

try {
    // ---- to-dos ----
    assert.deepEqual(await notes.listTodos(), []);
    const a = await notes.addTodo("  Reply to   Sam  ");
    assert.equal(a.text, "Reply to Sam", "whitespace is tidied");
    assert.equal(a.author, "you");
    const b = await notes.addTodo("Check the canary", "Jarvis");
    const c = await notes.addTodo("Write the design doc");
    assert.deepEqual(await texts(), ["  Reply to Sam", "  Check the canary", "  Write the design doc"], "new ones go to the end");
    await assert.rejects(notes.addTodo("   "), /Write the to-do/);
    await assert.rejects(notes.addTodo("x".repeat(notes.NOTES_LIMITS.todoChars + 1)), /under/);

    await notes.moveTodo(c.id, "up");
    assert.deepEqual(await texts(), ["  Reply to Sam", "  Write the design doc", "  Check the canary"]);
    await notes.moveTodo(a.id, "up");
    assert.deepEqual((await texts())[0], "  Reply to Sam", "the first can't go higher");
    await notes.moveTodo(b.id, "down");
    assert.deepEqual((await texts())[2], "  Check the canary", "the last can't go lower");
    await assert.rejects(notes.moveTodo(a.id, "sideways"), /up or down/);

    await notes.updateTodo(a.id, { done: true });
    assert.deepEqual(await texts(), ["  Write the design doc", "  Check the canary", "x Reply to Sam"], "done ones follow the open ones");
    const reopened = await notes.updateTodo(a.id, { done: false });
    assert.equal(reopened.doneAt, null);
    assert.deepEqual(await texts(), ["  Write the design doc", "  Check the canary", "  Reply to Sam"], "reopened, it goes to the end");
    await notes.updateTodo(c.id, { text: "Write the design doc (v2)" });
    assert.equal((await notes.listTodos())[0].text, "Write the design doc (v2)");
    await assert.rejects(notes.updateTodo(999, { done: true }), /gone/);
    await assert.rejects(notes.updateTodo("nope", { done: true }), /Unknown to-do/);

    await notes.updateTodo(b.id, { done: true });
    await notes.updateTodo(c.id, { done: true });
    assert.equal(await notes.clearDoneTodos(), 2);
    assert.deepEqual(await texts(), ["  Reply to Sam"]);
    await notes.deleteTodo(a.id);
    assert.deepEqual(await notes.listTodos(), []);

    // Only the newest done to-dos are kept.
    const keep = notes.NOTES_LIMITS.doneTodos;
    notes.NOTES_LIMITS.doneTodos = 3;
    for (let i = 1; i <= 5; i++) {
        const t = await notes.addTodo(`done ${i}`);
        await notes.updateTodo(t.id, { done: true });
        await new Promise((r) => setTimeout(r, 2));
    }
    assert.deepEqual(await texts(), ["x done 5", "x done 4", "x done 3"]);
    notes.NOTES_LIMITS.doneTodos = keep;
    await notes.clearDoneTodos();

    // ---- the quick note ----
    let note = await notes.getQuickNote();
    assert.deepEqual(note, { text: "", version: 0, updatedAt: null, updatedBy: null, lastSaveId: null });
    note = await notes.saveQuickNote("Standup at 10.\nAsk about the rollout.", 0, "save-1");
    assert.equal(note.version, 1);
    assert.equal(note.updatedBy, "you");
    assert.equal(note.lastSaveId, "save-1", "the page's save id is kept");
    const appended = await notes.appendQuickNote("Canary is green in WUS2.", "Jarvis");
    assert.equal(appended.version, 2);
    assert.equal(appended.lastSaveId, "save-1", "…through appends, so the page can tell its save landed");
    assert.match(appended.text, /^Standup at 10\.\nAsk about the rollout\.\n\n\[Jarvis, .+\] Canary is green in WUS2\.$/, "an append is a dated, signed paragraph");
    await assert.rejects(notes.saveQuickNote("my stale edit", 1), (e) => e.status === 409, "an edit that started before the append is refused, not lost");
    assert.equal((await notes.getQuickNote()).text, appended.text);
    assert.equal((await notes.saveQuickNote("merged", 2)).text, "merged");
    assert.equal((await notes.getQuickNote()).lastSaveId, null, "a save without an id clears it");
    assert.equal((await notes.saveQuickNote("merged", 3, "bad id!")).lastSaveId, null, "an id that isn't plain is ignored");
    await notes.saveQuickNote("merged", 4);
    await assert.rejects(notes.saveQuickNote("x".repeat(notes.NOTES_LIMITS.noteChars + 1), (await notes.getQuickNote()).version), /under/);
    await assert.rejects(notes.appendQuickNote("  ", "Jarvis"), /text to add/);

    // A save and an agent's append at the same moment: neither is lost.
    for (const order of ["save first", "append first"]) {
        const before = await notes.getQuickNote();
        const save = () => notes.saveQuickNote(`${before.text}\nmine (${order})`, before.version);
        const append = () => notes.appendQuickNote(`theirs (${order})`, "Jarvis");
        const results = await Promise.allSettled(order === "save first" ? [save(), append()] : [append(), save()]);
        const after = await notes.getQuickNote();
        assert.match(after.text, new RegExp(`theirs \\(${order}\\)`), `the append survives (${order})`);
        const saved = results.find((r) => r.status === "fulfilled" && r.value.updatedBy === "you");
        if (saved) assert.match(after.text, new RegExp(`mine \\(${order}\\)`), `a save that went through survives (${order})`);
        else assert.ok(results.some((r) => r.status === "rejected" && r.reason.status === 409), "or the save is refused, for the page to merge");
        assert.equal(after.version, before.version + (saved ? 2 : 1), "each write is its own version");
    }
    await notes.saveQuickNote("merged", (await notes.getQuickNote()).version);

    // ---- for agents ----
    await notes.addTodo("Ping the on-call");
    const lead = new Set(["read", "add_todo", "complete_todo", "append_note"]);
    const worker = new Set(["read", "add_todo"]);
    assert.match(await notes.runNotesAction("w1", { action: "add_todo", text: "Rebase the branch" }, worker), /^Added to-do \[\d+\]: Rebase the branch$/);
    const read = await notes.runNotesAction("w1", { action: "read" }, worker);
    assert.match(read, /- \[\d+\] Ping the on-call\n- \[\d+\] Rebase the branch \(added by w1\)/, "agents see ids, order and who added what");
    assert.match(read, /Quick note:\nmerged/);
    assert.match(await notes.runNotesAction("w1", { action: "append_note", text: "hi" }, worker), /^Use action read, add_todo\.$/, "workers can't edit the quick note");
    assert.match(await notes.runNotesAction("w1", { action: "complete_todo", id: 1 }, worker), /^Use action/, "…nor check off the user's to-dos");
    const rebase = (await notes.listTodos()).find((t) => t.text === "Rebase the branch");
    assert.match(await notes.runNotesAction("Jarvis", { action: "complete_todo", id: rebase.id }, lead), /^Checked off/);
    assert.match(await notes.runNotesAction("Jarvis", { action: "complete_todo", id: 12345 }, lead), /^Not done: That to-do is gone/);
    assert.match(await notes.runNotesAction("Jarvis", { action: "append_note", text: "Done for today." }, lead), /Added to the quick note/);
    assert.match((await notes.getQuickNote()).text, /\[Jarvis, .+\] Done for today\.$/);

    // ---- to-dos made from Needs you items ----
    {
        const taskId = "11111111-2222-4333-8444-555555555555";
        const src = (key, over = {}) => ({ key, taskId, taskTitle: "Canary   scope", who: "appconfig", ...over });
        const answer = await notes.addTodo("Answer appconfig: Which region?", "you", src("need:req:s1:r1"));
        assert.deepEqual(answer.source, { key: "need:req:s1:r1", taskId, taskTitle: "Canary scope", who: "appconfig" }, "it remembers the ask");
        assert.equal(answer.doneNote, null);
        const again = await notes.addTodo("Answer it again", "you", src("need:req:s1:r1"));
        assert.equal(again.id, answer.id, "the same ask makes one to-do while it's open");
        assert.equal((await notes.listTodos()).filter((t) => t.source?.key === "need:req:s1:r1").length, 1);
        await assert.rejects(notes.addTodo("x", "you", src("need:other:s1")), /isn't a Needs you item/);
        await assert.rejects(notes.addTodo("x", "you", src("../../etc")), /isn't a Needs you item/);
        await assert.rejects(notes.addTodo("x", "you", src("need:req:s1:r2", { taskId: "nope" })), /has no task/);
        const failed = await notes.addTodo("See why ui's turn failed", "you", src("need:fail:s2:2026-10-26T10:00:00.000Z", { who: "ui" }));
        const proposal = await notes.addTodo("Review the validation chain", "you", src(`need:val:${taskId}:proposal:2026-10-26T09:00:00.000Z`));
        assert.match(await notes.notesForAgent(), /Answer appconfig: Which region\? \(from Needs you: Canary scope\)/, "agents see where it came from");

        // The ask goes: its to-do ticks itself, once. What's still there stays open; skipped kinds aren't touched.
        assert.equal(await notes.settleNeedTodos(new Set([failed.source.key]), ["val"]), 1);
        let byId = new Map((await notes.listTodos()).map((t) => [t.id, t]));
        assert.deepEqual([byId.get(answer.id).done, byId.get(answer.id).doneNote], [true, notes.NEED_DONE_NOTE], "answered elsewhere: done by itself");
        assert.equal(byId.get(failed.id).done, false, "still waiting: still open");
        assert.equal(byId.get(proposal.id).done, false, "validation couldn't be read: left alone");
        assert.equal(await notes.settleNeedTodos(new Set()), 2, "both go once their asks do");
        // Reopened by hand, it stays open, and no longer says why it was done.
        await notes.updateTodo(answer.id, { done: false });
        assert.equal(await notes.settleNeedTodos(new Set()), 0);
        byId = new Map((await notes.listTodos()).map((t) => [t.id, t]));
        assert.deepEqual([byId.get(answer.id).done, byId.get(answer.id).doneNote], [false, null]);
        // Checked off by hand and reopened, it's the user's: once the ask is gone it still stays open.
        const handled = await notes.addTodo("Answer it", "you", src("need:req:s9:r9"));
        await notes.updateTodo(handled.id, { done: true });
        assert.equal(await notes.settleNeedTodos(new Set()), 0, "already done: nothing to tick");
        await notes.updateTodo(handled.id, { done: false });
        assert.equal(await notes.settleNeedTodos(new Set()), 0, "reopened by hand: never ticked again");
        assert.equal((await notes.listTodos()).find((t) => t.id === handled.id).done, false);
        // A to-do of the user's own is never touched.
        const own = await notes.addTodo("My own thing");
        await notes.settleNeedTodos(new Set());
        assert.equal((await notes.listTodos()).find((t) => t.id === own.id).done, false);
        // Once its to-do is done, the same ask can be taken on again.
        const reAdded = await notes.addTodo("Review it again", "you", src(`need:val:${taskId}:proposal:2026-10-26T09:00:00.000Z`));
        assert.notEqual(reAdded.id, proposal.id);
    }

    console.log("jarvis-notes harness: ok");
} finally {
    closeDb();
    rmSync(root, { recursive: true, force: true });
}
