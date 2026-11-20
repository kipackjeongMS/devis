// To-dos made from PRs tick themselves once the PR closes (todo-prs.mts), over a fake Azure DevOps:
// a PR in a list loaded in the last 15 minutes costs nothing, any other is asked about at most every
// 15 minutes and a few per pass, the longest unchecked first; completed and abandoned tick, anything
// else (open, gone, unreadable) leaves the to-do alone; one pass at a time; and a to-do kept by hand is never asked about.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "todo-prs-"));
process.env.ADO_PR_OPS_DB_PATH = join(root, "data", "reviews.db");
process.env.ADO_PR_OPS_JARVIS_DIR = join(root, "jarvis");
process.env.ADO_PR_OPS_CONFIG_PATH = join(root, "config.json");

const notes = await import("../jarvis-notes.mjs");
const prs = await import("../todo-prs.mjs");
const { closeDb } = await import("../store.mjs");

const MIN = 60_000;
let clock = Date.UTC(2026, 9, 27, 12);
/** What ADO says of each PR id: a status, "throw", or nothing (gone). */
const ado = new Map();
const asked = [];
let gate = null;
prs.setTodoPrRuntime({
    now: () => clock,
    pr: async (org, id) => {
        asked.push(id);
        if (gate) await gate;
        const s = ado.get(id);
        if (s === "throw") throw new Error("ADO is down");
        return s == null ? null : { status: s };
    },
});

const src = (id, org = "MSAzure") => ({
    key: `pr:${org.toLowerCase()}:${id}`,
    taskId: "",
    taskTitle: `PR ${id}: Something`,
    who: "Your PR",
    pr: { org, project: "One", repoId: "0d3c1a2b-1111-4222-8333-444455556666", id },
});
const add = (id) => notes.addTodo(`Review PR ${id}`, "you", src(id));
const state = async () => new Map((await notes.listTodos()).map((t) => [t.source?.pr?.id ?? t.text, [t.done, t.doneNote]]));
const sorted = (list) => [...list].sort((a, b) => a - b);
const perPass = prs.TODO_PR_LIMITS.perPass;

try {
    // Nothing to settle: ADO isn't asked.
    assert.equal(await prs.settlePrTodosNow(null), 0);
    assert.deepEqual(asked, []);

    for (const id of [1, 2, 3, 4, 5, 6, 7]) await add(id);
    await notes.addTodo("My own thing");
    ado.set(3, "completed").set(4, "abandoned").set(5, "active").set(7, "throw");
    // The PR list holds 1 (open) and 2 (closed as the list last saw it), under the org however ADO
    // spells it; contoso's PR 3 is another PR.
    const listed = {
        prs: [
            { org: "MSAzure", id: 1, status: "active" },
            { org: "msazure", id: 2, status: "completed" },
            { org: "contoso", id: 3, status: "active" },
        ],
        at: clock,
    };
    assert.equal(await prs.settlePrTodosNow(listed), 3);
    assert.deepEqual(sorted(asked), [3, 4, 5, 6, 7], "listed PRs aren't asked about");
    let s = await state();
    assert.deepEqual(s.get(1), [false, null], "open in the list: stays");
    assert.deepEqual(s.get(2), [true, "the PR was completed"], "closed in the list: ticks");
    assert.deepEqual(s.get(3), [true, "the PR was completed"]);
    assert.deepEqual(s.get(4), [true, "the PR was abandoned"]);
    assert.deepEqual([s.get(5), s.get(6), s.get(7)], [[false, null], [false, null], [false, null]], "open, gone or unreadable: left alone");
    assert.deepEqual(s.get("My own thing"), [false, null], "a to-do of the user's own is never touched");

    // Asked again only once 15 minutes have gone by.
    asked.length = 0;
    clock += 5 * MIN;
    assert.equal(await prs.settlePrTodosNow(listed), 0);
    assert.deepEqual(asked, [], "checked a moment ago: not asked again");
    clock += prs.TODO_PR_LIMITS.checkMs;
    ado.set(5, "completed").set(7, "abandoned");
    // No list now: 1 is asked about too, and ADO doesn't know it (gone), so it stays.
    assert.equal(await prs.settlePrTodosNow(null), 2);
    assert.deepEqual(sorted(asked), [1, 5, 6, 7]);
    s = await state();
    assert.deepEqual([s.get(1), s.get(5), s.get(6), s.get(7)], [[false, null], [true, "the PR was completed"], [false, null], [true, "the PR was abandoned"]]);

    // The list can go days without loading again: once it's 15 minutes old, its PRs are asked about too.
    await add(11);
    ado.set(11, "completed");
    clock += prs.TODO_PR_LIMITS.checkMs;
    const fresh = { prs: [{ org: "MSAzure", id: 11, status: "active" }], at: clock };
    asked.length = 0;
    await prs.settlePrTodosNow(fresh);
    assert.ok(!asked.includes(11), "in a list loaded just now: not asked about");
    assert.deepEqual((await state()).get(11), [false, null]);
    clock += prs.TODO_PR_LIMITS.checkMs - 1;
    asked.length = 0;
    await prs.settlePrTodosNow(fresh);
    assert.ok(!asked.includes(11), "a list under 15 minutes old still counts");
    clock += 1;
    asked.length = 0;
    await prs.settlePrTodosNow(fresh);
    assert.ok(asked.includes(11), "the same list, 15 minutes on: asked about");
    assert.deepEqual((await state()).get(11), [true, "the PR was completed"]);

    // A few per pass, the longest unchecked first, so a long list gets round to every PR.
    prs.TODO_PR_LIMITS.perPass = 2;
    for (const id of [8, 9, 10]) await add(id);
    asked.length = 0;
    clock += prs.TODO_PR_LIMITS.checkMs;
    await prs.settlePrTodosNow(null);
    assert.equal(asked.length, 2);
    assert.ok(asked.every((id) => [8, 9, 10].includes(id)), "never asked about: first");
    const first = [...asked];
    asked.length = 0;
    await prs.settlePrTodosNow(null);
    assert.equal(asked.length, 2);
    assert.ok(asked.includes([8, 9, 10].find((id) => !first.includes(id))), "the one left over goes next");
    assert.ok(!asked.some((id) => first.includes(id)), "those just asked about wait their 15 minutes");
    prs.TODO_PR_LIMITS.perPass = perPass;

    // Kept by hand (checked off and reopened), a PR's to-do is never asked about, nor ticked.
    const six = (await notes.listTodos()).find((t) => t.source?.pr?.id === 6);
    await notes.updateTodo(six.id, { done: true });
    await notes.updateTodo(six.id, { done: false });
    ado.set(6, "completed");
    asked.length = 0;
    clock += prs.TODO_PR_LIMITS.checkMs;
    await prs.settlePrTodosNow(null);
    assert.ok(!asked.includes(6));
    assert.deepEqual((await state()).get(6), [false, null]);

    // One pass at a time: a call while one runs gets that pass.
    let release;
    gate = new Promise((resolve) => (release = resolve));
    ado.set(8, "completed");
    asked.length = 0;
    clock += prs.TODO_PR_LIMITS.checkMs;
    const p1 = prs.settlePrTodosNow(null);
    const p2 = prs.settlePrTodosNow(null);
    assert.equal(p1, p2, "the same pass");
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    gate = null;
    assert.equal(await p1, 1);
    assert.equal(new Set(asked).size, asked.length, "each PR asked about once");
    assert.notEqual(prs.settlePrTodosNow(null), p1, "a call after it ends starts a new pass");
    await prs.settlePrTodosNow(null);
    assert.deepEqual((await state()).get(8), [true, "the PR was completed"]);

    console.log("todo-prs harness: all passed");
} finally {
    prs.TODO_PR_LIMITS.perPass = perPass;
    prs.setTodoPrRuntime(null);
    closeDb();
    rmSync(root, { recursive: true, force: true });
}
