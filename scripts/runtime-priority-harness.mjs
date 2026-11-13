// The Copilot runtime's process tree runs below normal: the tree is read parents first and
// ids Windows reused aren't mistaken for children; a below-normal or idle process is left
// alone; a real parent and its child are both lowered; and the switch turns it all off.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants, getPriority, setPriority } from "node:os";

const BELOW_NORMAL = constants.priority.PRIORITY_BELOW_NORMAL;
const IDLE = constants.priority.PRIORITY_LOW;
let fresh = 0;
const load = () => import(`../runtime-priority.mjs?case=${++fresh}`);

const started = [];
const sleeper = (code = "setInterval(() => {}, 1 << 30)") => {
    const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    started.push(child.pid);
    return child;
};
const firstLine = (child) =>
    new Promise((resolve, reject) => {
        let text = "";
        child.stdout.on("data", (chunk) => {
            text += chunk;
            const line = text.split(/\r?\n/)[0];
            if (text.includes("\n")) resolve(line.trim());
        });
        child.on("exit", () => reject(new Error("exited before writing a line")));
    });

try {
    delete process.env.ADO_PR_OPS_NO_LOW_PRIORITY;
    const pr = await load();

    // ---- reading the process list ----
    assert.deepEqual(pr.parseProcessRows("12 4 100\r\n  junk line\n13 12 200\n\n0 0 0\n-1 2 3\n14 13\n"), [
        { pid: 12, ppid: 4, created: 100 },
        { pid: 13, ppid: 12, created: 200 },
        { pid: 14, ppid: 13, created: 0 },
    ], "the System idle row (pid 0) and junk are skipped; a missing start time is unknown");

    // ---- the tree under a process ----
    const rows = [
        { pid: 0, ppid: 0, created: 0 },
        { pid: 10, ppid: 1, created: 500 },
        { pid: 11, ppid: 10, created: 600 },
        { pid: 12, ppid: 10, created: 700 },
        { pid: 13, ppid: 11, created: 800 },
        { pid: 20, ppid: 10, created: 100 }, // older than 10: its parent died and Windows gave 10 its id
        { pid: 21, ppid: 20, created: 150 },
        { pid: 14, ppid: 12, created: 0 }, // start time unknown: taken
        { pid: 30, ppid: 99, created: 900 },
    ];
    assert.deepEqual(pr.descendantsOf(10, rows), [10, 11, 12, 13, 14], "parents come before their children; reused ids are left out");
    assert.deepEqual(pr.descendantsOf(0, rows), [0], "a process that names itself as parent isn't its own child");
    assert.deepEqual(pr.descendantsOf(77, rows), [77], "an unknown root is just itself");
    const loop = [
        { pid: 1, ppid: 2, created: 0 },
        { pid: 2, ppid: 1, created: 0 },
    ];
    assert.deepEqual(pr.descendantsOf(1, loop), [1, 2], "a cycle ends");

    // ---- lowering a tree: the root at once, then everything under it ----
    const order = [];
    let listed = false;
    const changed = await pr.lowerProcessTree(10, {
        list: async () => {
            assert.deepEqual(order, [10], "the root is lowered before the list is read");
            listed = true;
            return rows;
        },
        lower: (pid) => {
            order.push(pid);
            return pid !== 12; // 12 was already low
        },
    });
    assert.ok(listed);
    assert.deepEqual(order, [10, 11, 12, 13, 14]);
    assert.equal(changed, 4, "what was already low isn't counted");
    await assert.rejects(pr.lowerProcessTree(10, { list: async () => Promise.reject(new Error("no list")), lower: () => true }), /no list/);

    // ---- real processes ----
    const one = sleeper();
    await new Promise((resolve) => one.once("spawn", resolve));
    assert.equal(pr.lowerProcess(one.pid), true);
    assert.equal(getPriority(one.pid), BELOW_NORMAL);
    assert.equal(pr.lowerProcess(one.pid), false, "already below normal: left alone");
    setPriority(one.pid, IDLE);
    assert.equal(pr.lowerProcess(one.pid), false, "an idle process isn't raised to below normal");
    assert.equal(getPriority(one.pid), IDLE);
    assert.equal(pr.lowerProcess(2 ** 30), false, "a process that's gone is no error");

    const parent = sleeper(
        "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1 << 30);",
    );
    const childPid = Number(await firstLine(parent));
    started.push(childPid);
    assert.ok(childPid > 0);
    // Windows may give the child a console host of its own, which is in the tree too.
    assert.ok((await pr.lowerProcessTree(parent.pid)) >= 2, "the parent and the child it started");
    assert.equal(getPriority(parent.pid), BELOW_NORMAL);
    assert.equal(getPriority(childPid), BELOW_NORMAL, "the child, found through the real process list");
    pr.keepTreeLow(undefined, "nothing"); // no runtime process yet: nothing to do, and no throw

    // ---- turned off ----
    process.env.ADO_PR_OPS_NO_LOW_PRIORITY = "1";
    const off = await load();
    assert.equal(off.lowPriorityEnabled(), false);
    const two = sleeper();
    await new Promise((resolve) => two.once("spawn", resolve));
    const before = getPriority(two.pid);
    off.keepTreeLow(two.pid, "switched off");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(getPriority(two.pid), before, "the switch leaves priorities alone");
    delete process.env.ADO_PR_OPS_NO_LOW_PRIORITY;

    console.log("runtime-priority harness: ok");
} finally {
    for (const pid of started) {
        try {
            process.kill(pid);
        } catch {
            /* already gone */
        }
    }
}
