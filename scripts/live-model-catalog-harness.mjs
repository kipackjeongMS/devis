import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [models, runtime, settings] = await Promise.all([
    readFile(new URL("../src/models.mts", import.meta.url), "utf8"),
    readFile(new URL("../src/copilot-runtime.mts", import.meta.url), "utf8"),
    readFile(new URL("../web/src/app.ts", import.meta.url), "utf8"),
]);

assert.match(models, /withCopilotClient/);
assert.match(runtime, /@github\/copilot-sdk/);
assert.match(runtime, /resolveCopilotCliPath/);
assert.match(runtime, /process\.platform === "win32" \? "where\.exe" : "which"/);
assert.match(runtime, /RuntimeConnection\.forStdio\(\{\s*path:\s*runtime\.command,\s*args:\s*runtime\.args[,\s}]/);
assert.match(models, /client\.listModels\(\)/);
assert.doesNotMatch(models, /FALLBACK|comma-separated list|copilot -p/);
assert.match(models, /throw new Error\("Copilot returned no available models"\)/);

assert.match(settings, /Loading available Copilot models/);
assert.match(settings, /selectedModel && !models\.includes\(selectedModel\)/);
assert.match(settings, /selectedModel = ""/);
assert.doesNotMatch(settings, /leave auto-only if probe fails/);

// ---- each model with the reasoning efforts it takes ----
const m = await import("../models.mjs");
const choices = m.modelChoices([
    { id: "auto", name: "Auto" },
    { id: "gpt-x", name: "GPT X", supportedReasoningEfforts: ["none", "low", "high", "low", 7, "BAD"] },
    { id: "haiku", name: "  ", capabilities: { supports: { reasoningEffort: false } } },
    { id: "gpt-x", name: "dupe" },
    { id: " " },
]);
assert.deepEqual(choices, [
    { id: "gpt-x", name: "GPT X", efforts: ["none", "low", "high"] },
    { id: "haiku", name: "haiku", efforts: [] },
], "auto, blanks and repeats drop out; efforts are deduped and checked");
assert.equal(m.effortProblem("gpt-x", "", choices), null);
assert.equal(m.effortProblem("gpt-x", "high", choices), null);
assert.match(m.effortProblem("gpt-x", "max", choices), /gpt-x takes none, low, high, not max/);
assert.match(m.effortProblem("haiku", "low", choices), /haiku doesn't take a reasoning effort/);
assert.match(m.effortProblem("", "low", choices), /Choose a model before its reasoning effort/);
assert.match(m.effortProblem("gpt-x", "Low; rm", choices), /Unknown reasoning effort/);
assert.equal(m.effortProblem("unlisted", "low", choices), null, "a model the catalog doesn't list is left to the runtime");
assert.equal(m.effortProblem("gpt-x", "low", null), null, "without a catalog only the spelling is checked");
assert.equal(m.carriedEffort("gpt-x", "high", choices), "high");
assert.equal(m.carriedEffort("haiku", "high", choices), "");
assert.equal(m.carriedEffort("", "high", choices), "");

const switched = [];
const session = {
    rpc: {
        model: {
            getCurrent: async () => ({ modelId: "gpt-x", reasoningEffort: "low" }),
            switchTo: async (req) => (switched.push(req), { deferred: req.modelId === "later" }),
        },
    },
};
assert.deepEqual(await m.sessionModelState(session), { model: "gpt-x", effort: "low" });
assert.deepEqual(await m.sessionModelState({ rpc: { model: { getCurrent: async () => { throw new Error("gone"); } } } }), { model: null, effort: null });
assert.deepEqual(await m.switchSessionModel(session, "gpt-x", "high"), { deferred: false });
assert.deepEqual(await m.switchSessionModel(session, "later", ""), { deferred: true });
assert.deepEqual(switched, [
    { modelId: "gpt-x", reasoningEffort: "high", deferIfModelChangeQueued: true },
    { modelId: "later", reasoningEffort: null, deferIfModelChangeQueued: true },
], "no effort clears the session's override, so the model's default applies");

// ---- what's sent while a turn runs ----
const { MessageQueue, QUEUE_MAX, sendMode, steer } = await import("../chat-queue.mjs");
assert.equal(sendMode("queue"), "queue");
assert.equal(sendMode("now"), "now");
assert.equal(sendMode("later"), null);
const queue = new MessageQueue();
const a = queue.add("a");
const b = queue.add("b");
queue.add("c");
assert.deepEqual(queue.view().queue.map((x) => x.text), ["a", "b", "c"]);
assert.equal(queue.take(b.id).text, "b");
assert.equal(queue.take(b.id), null);
queue.restore(b);
assert.deepEqual(queue.view().queue.map((x) => x.text), ["b", "a", "c"], "a message that failed to go now goes back to the front");
queue.hold();
assert.equal(queue.next(), null, "a held queue doesn't run on its own");
assert.equal(queue.view().queueHeld, true);
queue.resume();
assert.equal(queue.next().text, "b");
assert.equal(queue.find(a.id).text, "a");
queue.clear();
queue.hold();
assert.equal(queue.view().queueHeld, false, "an empty queue is never shown as held");
for (let i = 0; i < QUEUE_MAX; i++) queue.add(`q${i}`);
assert.throws(() => queue.add("too many"), /The queue holds 20 messages/);
const sent = [];
await steer({ send: async (msg) => sent.push(msg) }, "go left");
assert.deepEqual(sent, [{ prompt: "go left", mode: "immediate" }], "steering is the runtime's immediate mode");

console.log("Live model catalog harness passed");
