import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const { chatMessagesFromEvents, ensureInteractiveMode, REVIEW_TASK_LABEL } = await import("../reviewer-session.mjs");
const { chatItems, chatFingerprint } = await import("../web/reviewerChatModel.js");

// ---- server: session events -> chat messages ----
const events = [
    { id: "e1", type: "session.start", data: {} },
    {
        id: "e2",
        type: "user.message",
        timestamp: "t1",
        data: { content: "===REVIEW TASK START===\nsecret PR data", source: "user" },
    },
    { id: "e3", type: "assistant.message", timestamp: "t2", data: { messageId: "m1", content: "Looking" } },
    { id: "e4", type: "assistant.message", timestamp: "t2", data: { messageId: "m1", content: " now." } },
    {
        id: "e5",
        type: "assistant.message",
        agentId: "sub",
        data: { messageId: "m2", content: "sub-agent chatter" },
    },
    {
        id: "e6",
        type: "assistant.message",
        data: { messageId: "m3", content: "tool chatter", parentToolCallId: "call-1" },
    },
    { id: "e7", type: "user.message", data: { content: "system nudge", source: "system" } },
    { id: "e8", type: "assistant.message", data: { messageId: "m4", content: "   " } },
    { id: "e9", type: "user.message", timestamp: "t3", data: { content: "Why is line 4 risky?" } },
    { id: "e10", type: "assistant.message", timestamp: "t4", data: { messageId: "m5", content: "Because." } },
];
const messages = chatMessagesFromEvents(events);
assert.deepEqual(
    messages.map((m) => [m.role, m.content]),
    [
        ["user", REVIEW_TASK_LABEL],
        ["assistant", "Looking now."],
        ["user", "Why is line 4 risky?"],
        ["assistant", "Because."],
    ],
);
assert.ok(!JSON.stringify(messages).includes("secret PR data"), "the raw review task is never exposed");

// ---- server: resumed autopilot sessions are switched to interactive ----
// sendAndWait ignores autopilot-mode session.idle, so a chat turn would never settle.
function fakeModeSession(mode) {
    const calls = [];
    return {
        calls,
        rpc: {
            mode: {
                get: async () => mode,
                set: async (params) => {
                    calls.push(params);
                    mode = params.mode;
                    return { status: "applied", modelChanged: false, modeApplied: true };
                },
            },
        },
    };
}
const autopilot = fakeModeSession("autopilot");
await ensureInteractiveMode(autopilot);
assert.deepEqual(autopilot.calls, [{ mode: "interactive", expectedMode: "autopilot" }]);
const interactive = fakeModeSession("interactive");
await ensureInteractiveMode(interactive);
assert.deepEqual(interactive.calls, [], "an interactive session is left alone");

// ---- web: chat -> render items ----
const settled = { messages, pending: false, partial: "", error: null };
assert.deepEqual(
    chatItems(settled).map((item) => item.kind),
    ["task", "assistant", "user", "assistant"],
);
assert.equal(chatItems(settled)[0].text, REVIEW_TASK_LABEL);

const streaming = { ...settled, pending: true, partial: "Partial **answer**" };
const streamingItems = chatItems(streaming);
assert.deepEqual(streamingItems.at(-1), { kind: "assistant", text: "Partial **answer**", streaming: true });

const thinking = chatItems({ ...settled, pending: true, partial: "" });
assert.deepEqual(thinking.at(-1), { kind: "thinking", text: "" });

// A message sent this turn but not yet in the session history is shown optimistically.
const optimistic = chatItems({ ...settled, pending: true, partial: "" }, "Follow-up?");
assert.deepEqual(
    optimistic.slice(-2).map((item) => [item.kind, item.text]),
    [
        ["user", "Follow-up?"],
        ["thinking", ""],
    ],
);
// ...but not duplicated once the history contains it.
const echoed = {
    messages: [...messages, { id: "u9", role: "user", content: "Follow-up?", timestamp: "t5" }],
    pending: true,
    partial: "",
    error: null,
};
assert.equal(chatItems(echoed, "Follow-up?").filter((item) => item.text === "Follow-up?").length, 1);

assert.notEqual(chatFingerprint(settled), chatFingerprint(streaming));
assert.equal(chatFingerprint(settled), chatFingerprint({ ...settled }));

// ---- wiring: the done panel offers chat + terminal only with a reviewer session ----
const panel = await readFile(new URL("../web/src/reviewPanel.ts", import.meta.url), "utf8");
assert.match(panel, /reviewerChatSection\(pr, review\.reviewer_session_id,/);
assert.match(panel, /\/api\/reviewer-terminal/);
assert.doesNotMatch(panel, /provenance|Teams/i);

console.log("Reviewer chat harness passed");
