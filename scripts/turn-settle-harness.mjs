// sendAndSettle: a turn ends on session.idle like the SDK's sendAndWait, and also when the
// idle never arrives but the runtime says it's done; a stop always ends the wait.
import assert from "node:assert/strict";

const rt = await import("../copilot-runtime.mjs");
const { sendAndSettle, SETTLE, TurnStoppedError } = rt;
Object.assign(SETTLE, { checkMs: 20, checkTimeoutMs: 40, stopPollMs: 10, stopGraceMs: 200 });

const SAVED = new Set(["user.message", "assistant.message", "tool.execution_start", "tool.execution_complete"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A session with the live events, send and the runtime's isProcessing. */
class Fake {
    constructor(script) {
        this.script = script;
        this.handlers = new Set();
        this.saved = [];
        this.sent = [];
        this.processing = false;
        this.checks = 0;
        this.check = null; // replaces isProcessing's answer: () => value | throw | never
        this.pendingResponseWaits = new Set();
        this.rpc = {
            metadata: {
                isProcessing: async () => {
                    this.checks++;
                    if (this.check) return this.check();
                    return { processing: this.processing };
                },
            },
        };
    }
    on(handler) {
        assert.equal(typeof handler, "function", "sendAndSettle listens to every event");
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }
    emit(type, data = {}, extra = {}) {
        const event = { id: `e${this.saved.length}`, type, data, timestamp: new Date().toISOString(), ...extra };
        if (SAVED.has(type)) this.saved.push(event);
        for (const handler of [...this.handlers]) handler(event);
    }
    async send(message) {
        this.sent.push(message);
        this.processing = true;
        void Promise.resolve().then(() => this.script?.(this, message));
        return "m1";
    }
    async sendAndWait() {
        throw new Error("sendAndSettle must not fall back when send and on exist");
    }
    async getEvents() {
        return this.saved;
    }
}

const clean = (s, label) => {
    assert.equal(s.handlers.size, 0, `${label}: listeners removed`);
    assert.equal(s.pendingResponseWaits.size, 0, `${label}: disconnect hook removed`);
};
const settleIn = async (promise, ms, label) => {
    let timer;
    const result = await Promise.race([
        promise.then(
            (value) => ({ value }),
            (error) => ({ error }),
        ),
        new Promise((r) => (timer = setTimeout(() => r({ hung: true }), ms))),
    ]);
    clearTimeout(timer);
    assert.ok(!result.hung, `${label}: settled within ${ms}ms`);
    return result;
};

// ---- the normal end: session.idle, with the last top-level reply ----
{
    const s = new Fake(async (s) => {
        s.emit("assistant.message", { content: "Working on it" });
        s.emit("session.idle", { mode: "autopilot" }); // an autopilot idle isn't the end
        await sleep(5);
        s.emit("assistant.message", { content: "sub-agent chatter" }, { agentId: "sub-1" });
        s.emit("assistant.message", { content: "All done" });
        s.emit("assistant.message", { content: "late sub-agent" }, { agentId: "sub-1" });
        s.processing = false;
        s.emit("session.idle", {});
    });
    let missed = 0;
    const reply = await sendAndSettle(s, { prompt: "Go" }, 5000, { onMissedIdle: () => missed++ });
    assert.equal(rt.replyText(reply), "All done");
    assert.deepEqual(s.sent, [{ prompt: "Go" }]);
    assert.equal(missed, 0);
    clean(s, "idle");
}

// ---- session.error fails the turn ----
{
    const s = new Fake((s) => s.emit("session.error", { message: "model overloaded", stack: "at model" }));
    const { error } = await settleIn(sendAndSettle(s, { prompt: "Go" }, 5000), 1000, "error");
    assert.equal(error.message, "model overloaded");
    assert.equal(error.stack, "at model");
    clean(s, "error");
}

// ---- THE BUG: the turn finished but its session.idle never came ----
{
    const s = new Fake(async (s) => {
        s.emit("tool.execution_start", { toolCallId: "t1", toolName: "task_status" });
        s.emit("tool.execution_complete", { toolCallId: "t1", success: true });
        s.emit("assistant.message", { content: "Posted the status." });
        s.processing = false; // …and no session.idle
    });
    let missed = 0;
    const started = Date.now();
    const { value, error } = await settleIn(sendAndSettle(s, { prompt: "Go" }, 60_000, { onMissedIdle: () => missed++ }), 1000, "missed idle");
    assert.equal(error, undefined);
    assert.equal(rt.replyText(value), "Posted the status.", "the live reply is kept");
    assert.equal(missed, 1, "the caller hears about it once");
    assert.ok(Date.now() - started >= SETTLE.checkMs * 2, "two quiet checks, not one");
    clean(s, "missed idle");
}

// ---- …and when the live reply went missing too, the saved one is used ----
{
    const s = new Fake(async (s) => {
        s.saved.push({ type: "assistant.message", timestamp: new Date(Date.now() - 60_000).toISOString(), data: { content: "an old reply" } });
        s.saved.push({ type: "assistant.message", timestamp: new Date().toISOString(), data: { content: "Saved reply" } });
        s.saved.push({ type: "assistant.message", timestamp: new Date().toISOString(), agentId: "sub", data: { content: "sub-agent" } });
        s.saved.push({ type: "assistant.message", timestamp: new Date().toISOString(), data: { content: "tool chatter", parentToolCallId: "t9" } });
        s.processing = false;
    });
    const reply = await sendAndSettle(s, { prompt: "Go" }, 60_000);
    assert.equal(rt.replyText(reply), "Saved reply");

    const none = new Fake(async (s) => {
        s.saved.push({ type: "assistant.message", timestamp: new Date(Date.now() - 60_000).toISOString(), data: { content: "an old reply" } });
        s.processing = false;
    });
    assert.equal(rt.replyText(await sendAndSettle(none, { prompt: "Go" }, 60_000)), "", "nothing from an earlier turn");
    clean(none, "saved reply");
}

// ---- no false ends ----
// still processing: only the idle ends it
{
    const s = new Fake(async (s) => {
        await sleep(SETTLE.checkMs * 8);
        s.emit("assistant.message", { content: "Long job done" });
        s.processing = false;
        s.emit("session.idle", {});
    });
    let missed = 0;
    const reply = await sendAndSettle(s, { prompt: "Go" }, 60_000, { onMissedIdle: () => missed++ });
    assert.equal(rt.replyText(reply), "Long job done");
    assert.equal(missed, 0);
    assert.ok(s.checks >= 4, "it kept asking meanwhile");
}
// waiting on the user (a question or approval): not over, even if the runtime says idle
{
    let waiting = true;
    const s = new Fake(async (s) => {
        s.processing = false;
        await sleep(SETTLE.checkMs * 8);
        waiting = false;
        s.emit("assistant.message", { content: "Answered" });
        s.emit("session.idle", {});
    });
    let missed = 0;
    const reply = await sendAndSettle(s, { prompt: "Go" }, 60_000, { waiting: () => waiting, onMissedIdle: () => missed++ });
    assert.equal(rt.replyText(reply), "Answered");
    assert.equal(missed, 0, "a turn waiting on the user is never cut short");
}
// events still flowing: the turn is alive whatever isProcessing says
{
    const s = new Fake(async (s) => {
        s.processing = false;
        for (let i = 0; i < 20; i++) {
            s.emit("assistant.message_delta", { deltaContent: "." });
            await sleep(SETTLE.checkMs / 2);
        }
        s.emit("assistant.message", { content: "Streamed" });
        s.emit("session.idle", {});
    });
    let missed = 0;
    assert.equal(rt.replyText(await sendAndSettle(s, { prompt: "Go" }, 60_000, { onMissedIdle: () => missed++ })), "Streamed");
    assert.equal(missed, 0);
}
// an event that lands while the runtime is being asked counts too
{
    let asked = 0;
    const s = new Fake(async (s) => {
        await sleep(SETTLE.checkMs * 8);
        s.emit("assistant.message", { content: "Raced" });
        s.emit("session.idle", {});
    });
    s.check = async () => {
        asked++;
        s.emit("assistant.message_delta", { deltaContent: "." });
        return { processing: false };
    };
    let missed = 0;
    assert.equal(rt.replyText(await sendAndSettle(s, { prompt: "Go" }, 60_000, { onMissedIdle: () => missed++ })), "Raced");
    assert.ok(asked >= 3);
    assert.equal(missed, 0, "a reply racing the question isn't mistaken for silence");
}
// the runtime can't answer (throws, or hangs): no guess, the idle still ends it
for (const [label, check] of [
    ["throws", () => Promise.reject(new Error("unknown method"))],
    ["hangs", () => new Promise(() => {})],
    ["odd answer", async () => ({})],
]) {
    const s = new Fake(async (s) => {
        s.processing = false;
        await sleep(SETTLE.checkMs * 6);
        s.emit("assistant.message", { content: label });
        s.emit("session.idle", {});
    });
    s.check = check;
    let missed = 0;
    assert.equal(rt.replyText(await sendAndSettle(s, { prompt: "Go" }, 60_000, { onMissedIdle: () => missed++ })), label);
    assert.equal(missed, 0, `isProcessing ${label}: no false end`);
    clean(s, label);
}
// no rpc at all: plain idle wait
{
    const s = new Fake((s) => {
        s.emit("assistant.message", { content: "ok" });
        s.emit("session.idle", {});
    });
    delete s.rpc;
    assert.equal(rt.replyText(await sendAndSettle(s, { prompt: "Go" }, 5000)), "ok");
}

// ---- stop ----
// the runtime lets go: ends fast with TurnStoppedError
{
    const s = new Fake(); // never idles by itself
    const ctl = new AbortController();
    const turn = sendAndSettle(s, { prompt: "Go" }, 60_000, { signal: ctl.signal });
    await sleep(5);
    ctl.abort();
    await sleep(20);
    s.processing = false;
    const started = Date.now();
    const { error } = await settleIn(turn, 150, "stop, runtime let go");
    assert.ok(error instanceof TurnStoppedError);
    assert.equal(error.message, "stopped");
    assert.ok(Date.now() - started < SETTLE.stopGraceMs, "before the grace runs out");
    clean(s, "stop");
}
// THE BUG's second half: the session is already idle (abort emits nothing): Stop still ends it
{
    const s = new Fake((s) => {
        s.emit("assistant.message", { content: "done" });
        s.processing = false; // idle lost
    });
    const saved = SETTLE.checkMs;
    SETTLE.checkMs = 60_000; // the watchdog hasn't noticed yet
    const ctl = new AbortController();
    const turn = sendAndSettle(s, { prompt: "Go" }, 60_000, { signal: ctl.signal });
    await sleep(10);
    ctl.abort();
    const { error } = await settleIn(turn, 100, "stop an idle session");
    SETTLE.checkMs = saved;
    assert.ok(error instanceof TurnStoppedError);
    clean(s, "stop idle");
}
// the runtime never lets go (or can't say): ends after the grace
for (const label of ["busy", "no answer"]) {
    const s = new Fake();
    if (label === "no answer") s.check = () => Promise.reject(new Error("gone"));
    const ctl = new AbortController();
    const turn = sendAndSettle(s, { prompt: "Go" }, 60_000, { signal: ctl.signal });
    await sleep(5);
    const started = Date.now();
    ctl.abort();
    const { error } = await settleIn(turn, SETTLE.stopGraceMs + 300, `stop, ${label}`);
    assert.ok(error instanceof TurnStoppedError);
    assert.ok(Date.now() - started >= SETTLE.stopGraceMs - 20, `${label}: waited the grace for the runtime`);
    clean(s, `stop ${label}`);
}
// a stop before sending: nothing is sent
{
    const s = new Fake();
    const ctl = new AbortController();
    ctl.abort();
    await assert.rejects(sendAndSettle(s, { prompt: "Go" }, 60_000, { signal: ctl.signal }), TurnStoppedError);
    assert.deepEqual(s.sent, []);
}

// ---- a dropped connection fails the wait, like the SDK's ----
{
    const s = new Fake();
    const turn = sendAndSettle(s, { prompt: "Go" }, 60_000);
    await sleep(5);
    assert.equal(s.pendingResponseWaits.size, 1);
    for (const fail of s.pendingResponseWaits) fail(new Error("Connection is closed"));
    const { error } = await settleIn(turn, 100, "disconnect");
    assert.equal(error.message, "Connection is closed");
    clean(s, "disconnect");
}

// ---- the timeout, with the SDK's wording ----
{
    const s = new Fake();
    const { error } = await settleIn(sendAndSettle(s, { prompt: "Go" }, 80), 500, "timeout");
    assert.match(error.message, /^Timeout after 80ms waiting for session\.idle$/);
    clean(s, "timeout");
}

// ---- a send that fails cleans up ----
{
    const s = new Fake();
    s.send = async () => {
        throw new Error("not connected");
    };
    await assert.rejects(sendAndSettle(s, { prompt: "Go" }, 60_000), /not connected/);
    clean(s, "send failed");
}

// ---- a double with only sendAndWait gets the SDK's wait ----
{
    const calls = [];
    const double = {
        async sendAndWait(message, timeout) {
            calls.push([message, timeout]);
            return { data: { content: "from sendAndWait" } };
        },
    };
    assert.equal(rt.replyText(await sendAndSettle(double, { prompt: "Go" }, 1234)), "from sendAndWait");
    assert.deepEqual(calls, [[{ prompt: "Go" }, 1234]]);
}

// ---- every caller uses it; none waits on session.idle alone ----
{
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = (name) => readFileSync(join(import.meta.dirname, "..", "src", name), "utf8").replace(/\r\n/g, "\n");
    for (const file of ["jarvis-workers.mts", "jarvis-lead.mts", "jarvis-overview.mts", "reviewer-session.mts", "review-runner.mts", "copilot-runtime.mts"]) {
        const code = src(file).replace(/^\s*(\/\/|\*).*$/gm, "");
        assert.doesNotMatch(code.replace(/session\.sendAndWait\(message, timeoutMs\)/, ""), /\.sendAndWait\(/, `${file} waits through sendAndSettle`);
        if (file !== "copilot-runtime.mts") assert.match(code, /sendAndSettle\(/, `${file} uses sendAndSettle`);
    }
    const workers = src("jarvis-workers.mts");
    assert.match(workers, /signal: stopTurn\.signal/, "a worker's Stop ends its turn's wait");
    assert.match(workers, /entry\.stopTurn\?\.abort\(\)/);
}

console.log("turn-settle harness: ok");
