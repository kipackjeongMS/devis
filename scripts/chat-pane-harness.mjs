import assert from "node:assert/strict";

const c = await import("../web/chatPane.js");

const note = (over = {}) => ({
    id: "n1",
    at: "2026-01-01T00:00:00Z",
    kind: "note",
    command: "/usage",
    text: "3 turns",
    markdown: false,
    url: null,
    choiceCommand: "",
    options: [],
    ...over,
});
const msg = (role, content, id) => ({ role, content, ...(id ? { id } : {}) });

// ---- messages ----
const hist = c.messageHtml(msg("user", "hi <b>", "m1"));
assert.match(hist, /class="chat-msg user"/);
assert.match(hist, /data-key="m:m1" data-v="6"/);
assert.match(hist, /hi &lt;b&gt;/, "user text is escaped");

const sending = c.messageHtml(msg("user", "now"), "sending");
assert.match(sending, /class="chat-msg user sending" data-key="sending"/);
assert.doesNotMatch(sending, /data-v=/);
const sent = c.messageHtml(msg("user", "now"), "sent");
assert.match(sent, /class="chat-msg user sent" data-key="sending"/, "sent keeps the sending key, so the bubble stays put as it turns solid");

const streaming = c.messageHtml(msg("assistant", "par"), "streaming");
assert.match(streaming, /class="chat-msg assistant md streaming" data-key="streaming"/);

const reply = c.messageHtml(msg("assistant", "**bold**", "m2"));
assert.match(reply, /data-key="m:m2" data-v="8"/);
assert.match(reply, /<strong>bold<\/strong>/);

// ---- notes ----
const plain = c.noteHtml(note());
assert.match(plain, /data-key="n:n1" data-v="1"/);
assert.match(plain, /<div class="chat-out-cmd">\/usage<\/div>/);
assert.match(plain, /<pre class="chat-out-text">3 turns<\/pre>/);

const err = c.noteHtml(note({ kind: "error", text: "no <session>" }));
assert.match(err, /class="chat-out err"/);
assert.match(err, /no &lt;session&gt;/);

const md = c.noteHtml(note({ markdown: true, text: "**x**", url: "https://example.com/a?b=1&c=2" }));
assert.match(md, /<div class="md">/);
assert.match(md, /class="chat-out-link" href="https:\/\/example.com\/a\?b=1&amp;c=2"/);

const choices = c.noteHtml(
    note({
        kind: "choices",
        choiceCommand: "model",
        text: "Pick one",
        options: [
            { name: "gpt-5", description: "Current", group: null },
            { name: "claude", description: "", group: "Anthropic" },
        ],
    })
);
assert.match(choices, /data-run="\/model gpt-5"/);
assert.match(choices, /<span class="chat-current">current<\/span>/);
assert.match(choices, /<p class="chat-out-group">Anthropic<\/p>/);
assert.ok(choices.indexOf("gpt-5") < choices.indexOf("Anthropic"), "ungrouped options come first");

// ---- the log ----
const empty = c.emptyHtml("Talk to Jarvis", "Ask <anything>", `<div class="chat-starters"></div>`);
assert.match(empty, /class="chat-empty-title">Talk to Jarvis</);
assert.match(empty, /<p>Ask <anything><\/p>/, "the body is trusted markup");
assert.match(empty, /chat-starters/);
assert.doesNotMatch(c.emptyHtml("t", ""), /<p><\/p>/, "no empty body paragraph");

assert.equal(c.chatLogHtml({ items: [], empty: empty }), empty, "an idle, empty log shows the empty card");
assert.equal(c.chatLogHtml({ items: [] }), "", "and nothing without one");

const items = [
    { type: "message", message: msg("user", "q", "a") },
    { type: "note", note: note() },
    { type: "message", message: msg("assistant", "a", "b") },
];
const full = c.chatLogHtml({ items, empty });
assert.doesNotMatch(full, /chat-empty/, "the empty card gives way to a conversation");
assert.ok(full.indexOf('m:a"') < full.indexOf("n:n1") && full.indexOf("n:n1") < full.indexOf('m:b"'), "items keep their order");

const loading = c.chatLogHtml({ items: [], loading: true, empty });
assert.match(loading, /Loading the conversation/);
assert.doesNotMatch(loading, /chat-empty/, "loading is not empty");

const ordered = c.chatLogHtml({ items, notice: `<p class="chat-muted">stale</p>`, sending: "next", busy: true, thinking: "Reading…" });
assert.ok(ordered.indexOf("stale") < ordered.indexOf('m:a"'), "the notice leads");
assert.ok(ordered.indexOf('data-key="sending"') > ordered.indexOf('m:b"'), "what was just sent follows the history");
assert.ok(ordered.indexOf('data-key="thinking"') > ordered.indexOf('data-key="sending"'), "thinking comes last");
assert.match(ordered, /Reading…/);

const busyDefault = c.chatLogHtml({ items: [], busy: true });
assert.match(busyDefault, /Thinking…/);

const partial = c.chatLogHtml({ items: [], busy: true, partial: "so far", thinking: "Reading…" });
assert.match(partial, /data-key="streaming"/);
assert.doesNotMatch(partial, /thinking/, "a streaming reply replaces the thinking line");

const trailer = `<div class="chat-out err">failed</div>`;
assert.match(c.chatLogHtml({ items, trailer }), /failed/);
assert.doesNotMatch(c.chatLogHtml({ items, trailer, busy: true }), /failed/, "a trailer waits for the turn to end");

// ---- the signature ----
const spec = { items, sending: null, busy: false };
assert.equal(c.chatLogSig(spec), c.chatLogSig({ ...spec, items: [...items] }), "the same content has the same signature");
assert.notEqual(c.chatLogSig(spec), c.chatLogSig({ ...spec, busy: true }));
assert.notEqual(c.chatLogSig(spec), c.chatLogSig({ ...spec, sending: "x" }));
assert.notEqual(c.chatLogSig(spec), c.chatLogSig({ ...spec, items: items.slice(0, 2) }));
assert.notEqual(c.chatLogSig(spec), c.chatLogSig({ ...spec, loading: true }));
const grown = [items[0], items[1], { type: "message", message: msg("assistant", "a longer reply", "b") }];
assert.notEqual(c.chatLogSig(spec), c.chatLogSig({ ...spec, items: grown }), "a reply that grew repaints");
const s1 = c.chatLogSig({ items: [], busy: true, partial: "abc" });
assert.notEqual(s1, c.chatLogSig({ items: [], busy: true, partial: "abcd" }), "a streaming reply repaints as it grows");
assert.notEqual(c.chatLogSig({ items: [], sending: "x" }), c.chatLogSig({ items: [], sending: "x", sendingAccepted: true }), "a message turning sent repaints");

// ---- the host's own items in the thread (Devis's notices) ----
const hostItem = { type: "html", key: "nt:x", sig: "1", html: '<article class="nt" data-key="nt:x">ask</article>' };
const withHost = c.chatLogParts({ items: [items[0], hostItem, items[1]] }).history;
assert.ok(withHost.indexOf('m:a"') < withHost.indexOf("nt:x") && withHost.indexOf("nt:x") < withHost.indexOf("n:n1"), "a host item sits where the host puts it");
assert.notEqual(c.chatLogSig({ items: [hostItem] }), c.chatLogSig({ items: [{ ...hostItem, sig: "2" }] }), "a host item that changed repaints");

// ---- a message sent with a notice attached: its name over the words, its details only for Devis ----
const aboutMsg = c.messageHtml(msg("user", "[Needs you: Nova's question]\nTask (id t1).\n---\nIs it quick?", "u9"));
assert.match(aboutMsg, /class="chat-about">.*Nova.{1,6}s question<\/span><\/span><p>Is it quick\?<\/p>/);
assert.doesNotMatch(aboutMsg, /id t1/, "the details are for Devis");
assert.match(c.queueHtml({ queued: [{ id: "q9", text: "[Needs you: X]\nctx\n---\nlater" }] }), /chat-about[\s\S]*<p>later<\/p>/, "queued ones show it too");
assert.doesNotMatch(c.queueHtml({ queued: [{ id: "q9", text: "[Needs you: X]\nctx\n---\nlater" }] }), /ctx/);

// ---- the log's two parts ----
// The conversation repaints only when it changes; the live tail (sent, steered, streaming, queue) moves on its own.
const parts = c.chatLogParts({ items, notice: "<p>n</p>", sending: "next", sendingAccepted: true, steered: [{ id: "s1", text: "st" }], busy: true, partial: "so far", queued: q0() });
function q0() {
    return [{ id: "q1", text: "later" }];
}
assert.match(parts.history, /<p>n<\/p>[\s\S]*m:a"[\s\S]*n:n1[\s\S]*m:b"/);
assert.doesNotMatch(parts.history, /sending|streaming|chat-queue|steered/, "nothing live in the conversation part");
assert.match(parts.tail, /class="chat-msg user sent" data-key="sending"/, "a message the app has reads as sent");
assert.match(c.chatLogParts({ items: [], sending: "next" }).tail, /class="chat-msg user sending"/, "until then it's on its way");
assert.ok(
    parts.tail.indexOf('class="chat-msg user sent"') < parts.tail.indexOf("steered") &&
        parts.tail.indexOf("steered") < parts.tail.indexOf("streaming") &&
        parts.tail.indexOf("streaming") < parts.tail.indexOf("chat-queue"),
    "sent, then steered, then the reply, then the queue"
);
assert.equal(parts.history + parts.tail, c.chatLogHtml({ items, notice: "<p>n</p>", sending: "next", sendingAccepted: true, steered: [{ id: "s1", text: "st" }], busy: true, partial: "so far", queued: q0() }));
assert.match(c.chatLogParts({ items: [], busy: true, partial: "the whole reply" }, "the who").tail, />the who</, "the tail shows as much of the reply as is revealed");
assert.equal(c.chatLogParts({ items: [], busy: true, partial: "x" }, "").tail.includes("chat-thinking"), true, "nothing revealed yet reads as thinking");
assert.equal(c.chatLogParts({ items: [], empty }).history, empty, "the empty card is part of the conversation");
assert.equal(c.chatLogParts({ items: [], empty, sending: "hi" }).history, "", "and gives way to anything live");

// ---- revealing a streaming reply ----
assert.equal(c.revealStep(10, 10, 31), 10);
assert.equal(c.revealStep(0, 320, 32), 32, "a chunk is shown over about REVEAL_CATCHUP_MS");
assert.equal(c.revealStep(0, 3200, 32), 320, "the pace rises with what's left, so it never falls far behind");
assert.equal(c.revealStep(0, 5, 31), 3, "a small remainder still moves at the slowest pace");
assert.equal(c.revealStep(4, 5, 1), 5, "at least a character a step");
let shownChars = 0;
let frames = 0;
while (shownChars < 400 && frames < 100) {
    shownChars = c.revealStep(shownChars, 400, 31);
    frames++;
}
assert.ok(frames <= 40, `400 characters show within ~1.2s at 32 fps (took ${frames} frames)`);
assert.equal(c.revealKept("Hello wor", 9, "Hello world, more"), 9, "a reply that carries on keeps what's shown");
assert.equal(c.revealKept("Hello wor", 5, "Hello world"), 5);
assert.equal(c.revealKept("Hello world", 11, "Next reply"), 0, "a different reply starts from nothing");
assert.equal(c.revealKept("Hello world", 11, "Hello"), 5, "an older, shorter copy shows what it has rather than restarting");
assert.equal(c.revealKept("Hello", 5, ""), 0);

// ---- the pane ----
const pane = c.chatPaneHtml({ id: "tm", inputLabel: "Message the worker", commands: true });
for (const part of ["chat-head", "chat-view", "chat-log", "chat-jump", "chat-requests", "chat-tools", "chat-compose", "chat-popup", "chat-input", "chat-sr", "chat-bar", "chat-hint", "chat-send"]) {
    assert.match(pane, new RegExp(`class="[^"]*\\b${part}\\b`), `pane has ${part}`);
}
assert.match(
    pane,
    /<div class="chat-view">\s*<div class="chat-log"[^>]*><\/div>\s*<button type="button" class="chat-jump" title="Jump to the latest message" aria-label="Jump to the latest message">[\s\S]*?<\/button>\s*<nav class="chat-index"[^>]*><\/nav>\s*<div class="chat-index-card"[^>]*><\/div>\s*<\/div>\s*<div class="chat-requests"/,
    "the jump button floats over the log's foot, after it in tab order; then the prompt rail, before the request cards"
);
assert.match(pane, /<div class="chat-head" hidden>/, "a pane without head content hides it");
assert.match(pane, /<div class="chat-tools" hidden><\/div>\s*<form class="chat-compose">/, "the model picker's row sits right over the composer, hidden until filled");
assert.match(pane, /aria-controls="tm-popup"/);
assert.match(pane, /id="tm-popup"/);
assert.match(pane, /aria-autocomplete="list"/);
assert.match(pane, /aria-label="Message the worker"/);

const lead = c.chatPaneHtml({ id: "lead", inputLabel: "Message Jarvis", headHtml: "<span>model</span>", label: "Lead chat" });
assert.doesNotMatch(lead, /aria-autocomplete/, "no / list without commands");
assert.doesNotMatch(lead, /aria-controls/);
assert.match(lead, /<div class="chat-head"><span>model<\/span><\/div>/, "head content is kept and shown");
assert.match(lead, /role="group" aria-label="Lead chat"/);
assert.match(lead, /id="lead-popup"/, "ids are prefixed so two panes don't collide");
assert.match(pane, /class="btn sm ghost chat-steer" hidden/, "Send now is hidden until a turn runs");

// ---- the model and effort picker ----
const m = await import("../web/modelChoice.js");
const catalog = [
    { id: "gpt-x", name: "GPT X", efforts: ["none", "low", "high", "xhigh"] },
    { id: "haiku", name: "Haiku", efforts: [] },
];
const st = (over = {}) => ({ model: "", effort: "", currentModel: null, currentEffort: null, catalog, busy: false, switching: false, who: "Jarvis", ...over });
assert.deepEqual(m.effortsFor(catalog, "gpt-x"), ["none", "low", "high", "xhigh"]);
assert.deepEqual(m.effortsFor(catalog, ""), [], "the Copilot default has no efforts to choose");
assert.deepEqual(m.effortsFor(null, "gpt-x"), []);
assert.equal(m.effortLabel("xhigh"), "Extra high");
assert.equal(m.effortLabel("none"), "No reasoning");
assert.equal(m.effortLabel("turbo"), "turbo", "a provider's own effort keeps its name");
assert.deepEqual(m.nextChoice(st({ model: "gpt-x", effort: "high" }), "haiku"), { model: "haiku", effort: "" }, "an effort the new model doesn't take is dropped");
assert.deepEqual(m.nextChoice(st({ model: "gpt-x", effort: "high" }), "gpt-x"), { model: "gpt-x", effort: "high" });

let view = m.pickerView(st({ currentModel: "claude-z" }));
assert.deepEqual(view.models.map((o) => [o.value, o.label, o.selected]), [
    ["", "Copilot default · claude-z", true],
    ["gpt-x", "gpt-x", false],
    ["haiku", "haiku", false],
]);
assert.equal(view.efforts, null, "no effort to pick on the Copilot default");
view = m.pickerView(st({ model: "gpt-x", effort: "high", currentModel: "gpt-x", currentEffort: "high" }));
assert.deepEqual(view.efforts.map((o) => [o.value, o.label, o.selected]), [
    ["", "Default effort", false],
    ["none", "No reasoning", false],
    ["low", "Low", false],
    ["high", "High", true],
    ["xhigh", "Extra high", false],
]);
assert.match(view.modelTitle, /Jarvis is running gpt-x \(high\)\. Changing the model keeps the conversation\./);
assert.equal(view.note, "");
assert.equal(m.pickerView(st({ model: "haiku" })).efforts, null, "nor on a model that takes none");
assert.ok(m.pickerView(st({ model: "gone" })).models.some((o) => o.value === "gone" && o.selected), "a saved model the catalog no longer lists stays shown");
assert.equal(m.pickerView(st({ model: "gpt-x", effort: "low", currentModel: "gpt-x", currentEffort: "high", busy: true })).note, "after this turn");
assert.equal(m.pickerView(st({ model: "gpt-x", effort: "low", currentModel: "gpt-x", currentEffort: "high" })).note, "", "idle, the switch is already applied or applies on resume");
assert.equal(m.pickerView(st({ model: "gpt-x", currentModel: "gpt-x", busy: true })).note, "", "nothing pending when they match");
assert.equal(m.pickerView(st({ switching: true })).note, "Switching…");
assert.equal(m.pickerView(st({ switching: true })).disabled, true);

const picker = c.modelPickerHtml(st({ model: "gpt-x", effort: "low", who: "appconfig-2" }));
assert.match(picker, /<select class="filter-select chat-model-select" data-model-pick="model" aria-label="appconfig-2's model">/);
assert.match(picker, /<option value="gpt-x" selected>gpt-x<\/option>/, "the picker is full markup, so patchHtml keeps the select and its value");
assert.match(picker, /data-model-pick="effort" aria-label="appconfig-2's reasoning effort"/);
assert.match(picker, /<option value="low" selected>Low<\/option>/);
assert.doesNotMatch(picker, /data-pick=/, "never the / list's data-pick, whose click handler cancels the event");
assert.doesNotMatch(c.modelPickerHtml(st()), /data-model-pick="effort"/);
assert.match(c.modelPickerHtml(st({ switching: true })), /data-model-pick="model" aria-label="[^"]+" disabled/);

// ---- what's sent mid-turn, and the queue ----
assert.match(c.steeredHtml({ id: "s1", text: "use <v2>" }), /class="chat-msg user steered" data-key="st:s1" data-v="1"><p>use &lt;v2&gt;<\/p><span class="chat-msg-tag">Sent mid-turn<\/span>/);
assert.equal(c.queueHtml({ queued: [] }), "");
const q = [{ id: "q1", text: "next <one>" }, { id: "q2", text: "after" }];
let queue = c.queueHtml({ queued: q, busy: true, canSteer: true });
assert.match(queue, /data-key="queue"/);
assert.match(queue, /Queued · run in order when this turn ends/);
assert.match(queue, /data-key="q:q1"[\s\S]*next &lt;one&gt;[\s\S]*data-queue-send="q1"[\s\S]*data-queue-remove="q1"/);
assert.doesNotMatch(queue, /data-queue-send="q1"[^>]*disabled/);
assert.match(c.queueHtml({ queued: [q[0]], busy: true, canSteer: true }), /Queued · runs when this turn ends/);
queue = c.queueHtml({ queued: q, busy: true, canSteer: false });
assert.match(queue, /data-queue-send="q1" title="Not now: the turn is starting, stopping or waiting on you" disabled/, "Send now waits while it can't go in");
queue = c.queueHtml({ queued: q, busy: false, queueHeld: true });
assert.match(queue, /class="chat-queue held"/);
assert.match(queue, /Held · runs after your next message/);
assert.doesNotMatch(queue, /disabled/, "a held message can be sent now, as a new turn");

const live = { items: [], steered: [{ id: "s1", text: "steer" }], busy: true, partial: "", thinking: "Using grep…", queued: q, canSteer: true };
const html = c.chatLogHtml(live);
assert.ok(html.indexOf("steered") < html.indexOf("chat-thinking") && html.indexOf("chat-thinking") < html.indexOf("chat-queue"), "steered, then the turn, then the queue");
assert.match(c.chatLogHtml({ items: [], trailer: "<p>Stopped</p>", queued: q, queueHeld: true }), /<p>Stopped<\/p><div class="chat-queue held"/);
const sig = c.chatLogSig(live);
assert.notEqual(sig, c.chatLogSig({ ...live, queued: [q[0]] }), "a message leaving the queue repaints");
assert.notEqual(sig, c.chatLogSig({ ...live, steered: [] }));
assert.notEqual(sig, c.chatLogSig({ ...live, canSteer: false }));
assert.notEqual(c.chatLogSig({ ...live, busy: false }), c.chatLogSig({ ...live, busy: false, queueHeld: true }));

// ---- the composer's keys ----
const key = (over) => c.composerKey({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...over });
assert.equal(key({}), "send");
assert.equal(key({ ctrlKey: true }), "steer");
assert.equal(key({ metaKey: true }), "steer");
assert.equal(key({ shiftKey: true }), null, "Shift+Enter is a new line");
assert.equal(key({ isComposing: true }), null);
assert.equal(key({ key: "a" }), null);

// ---- the prompt index ----
const railPane = c.chatPaneHtml({ id: "t", inputLabel: "Message" });
assert.match(railPane, /<nav class="chat-index" aria-label="Your prompts" hidden><\/nav>/, "the rail starts hidden");
assert.match(railPane, /<div class="chat-index-card" aria-hidden="true" hidden><\/div>/, "the card repeats the tick's name, so screen readers skip it");
assert.ok(railPane.indexOf("chat-jump") < railPane.indexOf("chat-index"), "the rail is in the view, after the jump button");

assert.equal(c.promptText("  fix the\n\n  build  "), "fix the build", "one line");
assert.equal(c.promptText("", 1), "An image");
assert.equal(c.promptText("  ", 3), "3 images");
assert.equal(c.promptText(""), "");
assert.equal(c.promptText("[Needs you: PR 12 is blocked]\nsome context\n---\nlook at this"), "look at this", "the words, not the attached item's details");
assert.equal(c.promptText("[Needs you: PR 12 is blocked]\nsome context\n---\n"), "PR 12 is blocked", "just the item: its name");
const longText = c.promptText("word ".repeat(80));
assert.ok(longText.length <= 200 && longText.endsWith("…"), "a long prompt is clipped");

const local = (d, h, m, y = 2026, mo = 4) => new Date(y, mo, d, h, m).getTime();
const now = local(14, 15, 0);
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
assert.equal(c.promptTime(local(14, 9, 19), now), `Today, ${clock(local(14, 9, 19))}`);
assert.equal(c.promptTime(local(14, 0, 0), now), `Today, ${clock(local(14, 0, 0))}`, "midnight is today");
assert.equal(c.promptTime(local(13, 23, 59), now), `Yesterday, ${clock(local(13, 23, 59))}`);
assert.equal(c.promptTime(local(8, 0, 0), now), `${new Date(local(8, 0, 0)).toLocaleDateString([], { weekday: "short" })}, ${clock(local(8, 0, 0))}`, "within the week: the weekday");
assert.equal(c.promptTime(local(7, 23, 59), now), `${new Date(local(7, 23, 59)).toLocaleDateString([], { month: "short", day: "numeric" })}, ${clock(local(7, 23, 59))}`, "older: the date");
const lastYear = local(12, 9, 19, 2025, 10);
assert.equal(c.promptTime(lastYear, now), `${new Date(lastYear).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}, ${clock(lastYear)}`, "another year: with it");
assert.equal(c.promptTime(NaN, now), "", "no time when the transcript has none");

const sentAt = new Date(local(14, 9, 19)).toISOString();
const promptSpec = {
  items: [
    { type: "message", message: { id: "a", role: "user", content: "first  prompt", timestamp: sentAt } },
    { type: "message", message: { id: "b", role: "assistant", content: "reply" } },
    { type: "note", note: note() },
    { type: "message", message: { role: "user", content: "no id: not in the conversation" } },
    { type: "html", key: "nt:1", sig: "1", html: "<div>notice</div>" },
    { type: "message", message: { id: "c", role: "user", content: "", images: [{ id: "i1", name: "shot.png" }] } },
  ],
  sending: "now",
  steered: [{ id: "s1", text: "and this" }],
  busy: true,
};
const marks = c.promptMarks(promptSpec);
assert.deepEqual(marks.map((m) => m.key), ["m:a", "m:c", "sending", "st:s1"], "the user's prompts, in the log's order");
assert.equal(marks[0].text, "first prompt");
assert.equal(marks[0].at, Date.parse(sentAt));
assert.ok(Number.isNaN(marks[1].at), "no timestamp: no time");
assert.equal(marks[1].text, "An image");
assert.equal(marks[2].note, "Just now");
assert.equal(marks[3].note, "Sent mid-turn");
const promptLog = c.chatLogHtml(promptSpec);
for (const m of marks) assert.ok(promptLog.includes(`class="chat-msg user`) && promptLog.includes(`data-key="${m.key}"`), `the log paints a bubble keyed ${m.key}`);
assert.deepEqual(c.promptMarks({ items: [], sendingImages: [{ id: "i2", name: "x.png" }] }).map((m) => m.text), ["An image"], "images being sent count");
assert.deepEqual(c.promptMarks({ items: [] }), []);

assert.equal(c.promptIndexHtml(marks.slice(0, 1), now), "", "one prompt: no rail");
const rail = c.promptIndexHtml(marks, now);
assert.equal((rail.match(/<button type="button" class="chat-index-tick"/g) || []).length, 4, "a tick per prompt");
assert.ok(rail.includes(`data-key="m:a" data-i="0" tabindex="-1" aria-label="Prompt 1 of 4: first prompt (Today, ${clock(local(14, 9, 19))})"`), "a tick names its prompt and when");
assert.match(rail, /aria-label="Prompt 2 of 4: An image"/, "no time, no brackets");
assert.match(rail, /aria-label="Prompt 3 of 4: now \(Just now\)"/);
assert.match(rail, /data-key="st:s1" data-i="3" tabindex="-1" aria-label="Prompt 4 of 4: and this \(Sent mid-turn\)"/);
const escaped = c.promptIndexHtml([{ key: "m:<x>", text: 'a "b" <c>', at: NaN }, { key: "m:y", text: "y", at: NaN }], now);
assert.match(escaped, /data-key="m:&lt;x&gt;"/);
assert.match(escaped, /aria-label="Prompt 1 of 2: a &quot;b&quot; &lt;c&gt;"/);

// Prompts starting at 16, 500 and 2700 in a 3000px log, seen through 600px.
const tops = [16, 500, 2700];
assert.equal(c.currentPrompt([], 0, 600, 3000), -1);
assert.equal(c.currentPrompt(tops, 0, 600, 3000), 0);
assert.equal(c.currentPrompt(tops, 470, 600, 3000), 0, "a prompt below the reading line isn't current yet");
assert.equal(c.currentPrompt(tops, 480, 600, 3000), 1, "it is once it reaches the line");
assert.equal(c.currentPrompt(tops, 1800, 600, 3000), 1, "reading its reply");
assert.equal(c.currentPrompt(tops, 2100, 600, 3000), 1, "over the last screen the line slides down…");
assert.equal(c.currentPrompt(tops, 2400, 600, 3000), 2, "…so at the end the last prompt in view is current");
assert.equal(c.currentPrompt([16, NaN, 900], 1000, 600, 3000), 2, "a prompt not on the page is skipped");
assert.equal(c.currentPrompt([16, 300], 0, 600, 500), 1, "a log that doesn't scroll: the last prompt");

const at = [16, 500, 1200, 2000];
assert.equal(c.stepPrompt(at, 1, 488, 1), 2);
assert.equal(c.stepPrompt(at, 3, 1988, 1), -1, "nothing after the last");
assert.equal(c.stepPrompt(at, 1, 488, -1), 0, "at a prompt's start, up goes to the one before");
assert.equal(c.stepPrompt(at, 1, 800, -1), 1, "scrolled past its start, up goes back to it first");
assert.equal(c.stepPrompt(at, 0, 0, -1), -1, "nothing before the first");
assert.equal(c.stepPrompt(at, -1, 0, 1), 0);
assert.equal(c.stepPrompt([], 0, 0, 1), -1);

console.log("chat-pane harness ok");
