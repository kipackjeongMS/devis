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

    // ---- subtasks, due dates and priorities ----
    {
        for (const t of await notes.listTodos()) if (t.parentId == null) await notes.deleteTodo(t.id);
        const ids = async () => (await notes.listTodos()).map((t) => `${t.done ? "x" : " "} ${t.text}`);
        const byId = async () => new Map((await notes.listTodos()).map((t) => [t.id, t]));
        const ship = await notes.addTodo("Ship it");
        const s1 = await notes.addTodo("Write the code", "you", undefined, { parentId: ship.id });
        const s2 = await notes.addTodo("Get it reviewed", "you", undefined, { parentId: ship.id, due: "2026-03-04" });
        const s1a = await notes.addTodo("Tests first", "you", undefined, { parentId: s1.id });
        const other = await notes.addTodo("Something else");
        assert.equal(s1.parentId, ship.id);
        assert.equal(s2.due, "2026-03-04");
        assert.deepEqual(await ids(), ["  Ship it", "  Write the code", "  Tests first", "  Get it reviewed", "  Something else"], "subtasks follow their to-do, depth first");

        await assert.rejects(notes.addTodo("x", "you", undefined, { parentId: 9999 }), /gone/);
        await assert.rejects(notes.addTodo("x", "you", undefined, { due: "2026-02-30" }), /real date/);
        await assert.rejects(notes.addTodo("x", "you", undefined, { due: "tomorrow" }), /YYYY-MM-DD/);
        await assert.rejects(
            notes.addTodo("x", "you", { key: "need:req:s1:r1", taskId: "11111111-2222-4333-8444-555555555555" }, { parentId: ship.id }),
            /top of the list/,
            "a to-do from Needs you can't be a subtask",
        );

        // Subtasks move among their siblings only.
        await notes.moveTodo(s2.id, "up");
        assert.deepEqual(await ids(), ["  Ship it", "  Get it reviewed", "  Write the code", "  Tests first", "  Something else"]);
        await notes.moveTodo(s2.id, "up");
        assert.equal((await ids())[1], "  Get it reviewed", "the first subtask can't go higher");
        await notes.moveTodo(s2.id, "down");

        // Checking one off checks off what's under it; its parent stays open.
        await notes.updateTodo(s1.id, { done: true });
        let m = await byId();
        assert.deepEqual([m.get(s1.id).done, m.get(s1a.id).done, m.get(ship.id).done], [true, true, false]);
        assert.equal(m.get(s1a.id).doneNote, null);
        assert.deepEqual(await ids(), ["  Ship it", "x Write the code", "x Tests first", "  Get it reviewed", "  Something else"], "a done subtask keeps its place");
        await assert.rejects(notes.addTodo("x", "you", undefined, { parentId: s1.id }), /Reopen it/);
        // Reopening one reopens what's above it, not what's beside or under it.
        await notes.updateTodo(ship.id, { done: true });
        await notes.updateTodo(s1a.id, { done: false });
        m = await byId();
        assert.deepEqual([m.get(s1a.id).done, m.get(s1.id).done, m.get(ship.id).done, m.get(s2.id).done], [false, false, false, true]);
        assert.equal((await notes.listTodos())[0].id, other.id, "a reopened top-level to-do goes to the end of the open list");

        // Due dates: set, changed and cleared, on any level.
        assert.equal((await notes.updateTodo(s1a.id, { due: "2026-01-09" })).due, "2026-01-09");
        assert.equal((await notes.updateTodo(ship.id, { due: "2026-01-31" })).due, "2026-01-31");
        assert.equal((await byId()).get(s1a.id).due, "2026-01-09", "a subtask's date is its own");
        assert.equal((await notes.updateTodo(s1a.id, { due: null })).due, null);
        assert.equal((await notes.updateTodo(ship.id, { text: "Ship it!" })).due, "2026-01-31", "other changes leave the date");
        await assert.rejects(notes.updateTodo(ship.id, { due: "2026-13-01" }), /real date/);

        // Priorities: top level only, highest first, then the user's order.
        await assert.rejects(notes.updateTodo(s1.id, { priority: 3 }), /Only top-level/);
        await assert.rejects(notes.updateTodo(ship.id, { priority: 7 }), /high, medium, low or none/);
        const third = await notes.addTodo("A third thing");
        assert.deepEqual((await notes.listTodos()).filter((t) => t.parentId == null && !t.done).map((t) => t.text), ["Something else", "Ship it!", "A third thing"]);
        assert.equal((await notes.updateTodo(third.id, { priority: "high" })).priority, 3);
        await notes.updateTodo(ship.id, { priority: 1 });
        assert.deepEqual(
            (await notes.listTodos()).filter((t) => t.parentId == null && !t.done).map((t) => t.text),
            ["A third thing", "Ship it!", "Something else"],
            "high, then low, then none",
        );
        await notes.moveTodo(other.id, "up");
        assert.equal((await notes.listTodos()).filter((t) => t.parentId == null).at(-1).text, "Something else", "moving stays within a priority");
        await notes.updateTodo(third.id, { priority: "none" });

        // Agents see the tree, and can add a subtask and set a date.
        const worker = new Set(["read", "add_todo", "set_due"]);
        assert.match(
            await notes.runNotesAction("w1", { action: "add_todo", text: "Write the rollout note", parent_id: ship.id, due: "2026-02-01" }, worker),
            new RegExp(`^Added to-do \\[\\d+\\] under \\[${ship.id}\\]: Write the rollout note \\(due 2026-02-01\\)$`),
        );
        assert.match(await notes.runNotesAction("w1", { action: "set_due", id: s2.id, due: "" }, worker), /has no due date now/);
        assert.match(await notes.runNotesAction("w1", { action: "set_due", id: s2.id, due: "2026-02-02" }, worker), /is due 2026-02-02/);
        assert.match(await notes.runNotesAction("w1", { action: "set_due", id: s2.id, due: "soon" }, worker), /^Not done: Give the due date/);
        const read = await notes.notesForAgent();
        assert.match(read, new RegExp(`- \\[${ship.id}\\] Ship it! \\(low priority, due 2026-01-31\\)\\n  - \\[${s1.id}\\] Write the code\\n    - \\[${s1a.id}\\] Tests first\\n`), "subtasks are indented under their to-do");
        assert.match(read, new RegExp(`  - \\[${s2.id}\\] Get it reviewed \\(done, due 2026-02-02\\)`), "a done subtask shows as done");

        // Starting a task: groups are checked, a subtask goes with its picked parent, and each must be open.
        const plan = await notes.planTodoStart([[s1a.id, ship.id], [other.id, s1a.id], []]);
        assert.deepEqual(plan.groups, [[ship.id], [other.id]], "a subtask goes with its picked to-do; a repeat counts once; empty groups go");
        assert.deepEqual(
            plan.todos.map((t) => t.id),
            [ship.id, other.id],
        );
        assert.match(plan.outline, new RegExp(`^- \\[${ship.id}\\] Ship it!.*\\n  - \\[${s1.id}\\] Write the code`));
        assert.equal(plan.groupOutlines.length, 2);
        assert.match(plan.groupOutlines[1], new RegExp(`^- \\[${other.id}\\] Something else$`));
        assert.deepEqual((await notes.planTodoStart([[s1.id]])).groups, [[s1.id]], "a subtask can be started on its own");
        await assert.rejects(notes.planTodoStart([[s2.id]]), /is done/);
        await assert.rejects(notes.planTodoStart([]), /Pick the to-dos/);
        await assert.rejects(notes.planTodoStart([[]]), /Pick the to-dos/);
        await assert.rejects(notes.planTodoStart([[123456]]), /gone/);
        await assert.rejects(notes.planTodoStart(Array.from({ length: notes.TODO_START_MAX_WORKERS + 1 }, () => [ship.id])), /at most/);

        // Linked to a task, its to-dos show it, and tick when it's done.
        const store = await import("../jarvis-store.mjs");
        const { task } = await store.createTask({ title: "Ship it", description: "" });
        await notes.linkTodosToTask([ship.id], task.id);
        assert.equal((await byId()).get(ship.id).taskId, task.id);
        await store.updateTask(task.id, { status: "done" });
        await new Promise((r) => setTimeout(r, 50));
        m = await byId();
        assert.deepEqual([m.get(ship.id).done, m.get(ship.id).doneNote, m.get(s1a.id).done], [true, notes.TASK_DONE_NOTE, true], "the task done ticks its to-dos");
        assert.equal(m.get(other.id).done, false, "other to-dos are left alone");

        // Deleting and clearing take the subtasks too; done ones past the limit go whole.
        const sub = await notes.addTodo("Under the third", "you", undefined, { parentId: third.id });
        await notes.deleteTodo(third.id);
        assert.equal((await byId()).has(sub.id), false);
        const keep = notes.NOTES_LIMITS.doneTodos;
        notes.NOTES_LIMITS.doneTodos = 1;
        const newer = await notes.addTodo("Newer");
        const newerSub = await notes.addTodo("Newer's subtask", "you", undefined, { parentId: newer.id });
        await new Promise((r) => setTimeout(r, 5));
        await notes.updateTodo(newer.id, { done: true });
        m = await byId();
        assert.equal(m.has(ship.id) || m.has(s1.id) || m.has(s1a.id), false, "the older done to-do goes with its subtasks");
        assert.equal(m.get(newerSub.id).done, true, "the kept one keeps its subtasks");
        notes.NOTES_LIMITS.doneTodos = keep;
        assert.equal(await notes.clearDoneTodos(), 2, "a cleared to-do takes its subtasks");
        assert.deepEqual(await ids(), ["  Something else"]);
    }

    console.log("jarvis-notes harness: ok");
} finally {
    closeDb();
    rmSync(root, { recursive: true, force: true });
}
