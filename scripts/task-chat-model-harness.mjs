import assert from "node:assert/strict";

const m = await import("../web/taskChatModel.js");

const cmd = (name, over = {}) => ({
    name,
    aliases: [],
    description: "",
    kind: "builtin",
    hint: "",
    required: false,
    choices: [],
    duringTurn: false,
    ...over,
});
const commands = [
    cmd("usage", { description: "Show session usage", duringTurn: true }),
    cmd("compact", { description: "Summarize the conversation" }),
    cmd("session", { aliases: ["s"] }),
    cmd("model", { description: "Switch this worker's model", hint: "model" }),
    cmd("no-ai-slop", { kind: "skill", description: "Edit writing so it sounds human" }),
    cmd("security-review", { description: "Review for vulnerabilities" }),
    cmd("security-and-hardening", { kind: "skill", description: "Harden code" }),
    cmd("pdf", { kind: "skill", description: "Work with PDF files" }),
];

// ---- what's being typed ----
assert.equal(m.slashQuery("/"), "");
assert.equal(m.slashQuery("/Se"), "se");
assert.equal(m.slashQuery("  /no-ai"), "no-ai");
assert.equal(m.slashQuery("/model "), null, "a space ends the name");
assert.equal(m.slashQuery("hello /x"), null);
assert.equal(m.slashQuery(""), null);
assert.equal(m.slashQuery("/a\nb"), null);

// ---- ranking ----
const names = (q) => m.matchCommands(commands, q).map((c) => c.name);
assert.deepEqual(names(""), ["compact", "model", "security-review", "session", "usage", "no-ai-slop", "pdf", "security-and-hardening"], "all of them, built-ins first");
assert.deepEqual(
    names("s"),
    ["session", "security-review", "security-and-hardening", "no-ai-slop", "usage", "compact", "model", "pdf"],
    "exact alias, name prefixes, word prefix, name contains, then descriptions",
);
assert.equal(names("s")[0], "session", "an exact alias wins");
assert.deepEqual(names("sec"), ["security-review", "security-and-hardening"], "name prefixes, built-ins first on a tie");
assert.deepEqual(names("slop"), ["no-ai-slop"], "a word inside a name matches");
assert.deepEqual(names("pdf"), ["pdf"]);
assert.deepEqual(names("vulnerab"), ["security-review"], "descriptions match last");
assert.deepEqual(names("zzz"), []);
assert.equal(m.matchCommands(commands, "", 3).length, 3);

// ---- resolving what was sent ----
assert.deepEqual(m.resolveCommand(commands, "/No-AI-Slop tighten\nthe intro "), { command: commands[4], input: "tighten\nthe intro" });
assert.equal(m.resolveCommand(commands, "/s").command.name, "session");
assert.equal(m.resolveCommand(commands, "/nope"), null);
assert.equal(m.resolveCommand(commands, "plain"), null);

// ---- what Send does ----
assert.deepEqual(m.composerIntent("  "), { kind: "empty" });
assert.deepEqual(m.composerIntent("/usage"), { kind: "command", text: "/usage" });
assert.deepEqual(m.composerIntent(" /no-ai-slop fix it "), { kind: "command", text: "/no-ai-slop fix it" });
assert.deepEqual(m.composerIntent("/src/app.ts is slow"), { kind: "message", text: "/src/app.ts is slow" }, "a path is a message");
assert.deepEqual(m.composerIntent("//tmp is full"), { kind: "message", text: "/tmp is full" }, "a double slash sends one slash");
assert.deepEqual(m.composerIntent("Add tests"), { kind: "message", text: "Add tests" });

// ---- notes from command results ----
const at = "2026-10-15T20:00:00.000Z";
assert.deepEqual(m.noteFromOutcome({ kind: "note", text: "Usage", markdown: true, url: null }, "/usage", "n1", at), {
    id: "n1",
    at,
    command: "/usage",
    kind: "note",
    text: "Usage",
    markdown: true,
    url: null,
    choiceCommand: "",
    options: [],
});
const choices = m.noteFromOutcome({ kind: "choices", title: "MCP", command: "mcp", options: [{ name: "show", description: "", group: null }] }, "/mcp", "n2", at);
assert.equal(choices.kind, "choices");
assert.equal(choices.choiceCommand, "mcp");
assert.equal(choices.text, "MCP");
assert.equal(m.noteFromOutcome({ kind: "sent", display: "/pdf", notice: null }, "/pdf", "n3", at), null, "a started turn shows as a message instead");
assert.equal(m.noteFromOutcome({ kind: "sent", display: "/research x", notice: "Takes a while" }, "/research x", "n4", at).text, "Takes a while");

// ---- the transcript with notes in time order ----
const msg = (id, role, content, timestamp) => ({ id, role, content, timestamp });
const messages = [msg("a", "user", "Add tests", "2026-10-15T19:00:00Z"), msg("b", "assistant", "Done.", "2026-10-15T19:01:00Z"), msg("c", "user", "/usage", "2026-10-15T19:30:00Z")];
const notes = [
    { id: "x", at: "2026-10-15T19:10:00Z", kind: "note", command: "/usage", text: "Usage", markdown: false, url: null, choiceCommand: "", options: [] },
    { id: "y", at: "2026-10-15T19:40:00Z", kind: "error", command: "/nope", text: "Unknown", markdown: false, url: null, choiceCommand: "", options: [] },
];
assert.deepEqual(
    m.chatItems(messages, notes).map((i) => (i.type === "message" ? i.message.id : i.note.id)),
    ["a", "b", "x", "c", "y"],
);
assert.deepEqual(m.chatItems([msg("p", "user", "no time", ""), msg("q", "assistant", "also none", "")], []).map((i) => i.message.id), ["p", "q"]);

// ---- a sent message shows until the transcript has it ----
const sentAt = Date.parse("2026-10-15T19:29:58Z");
assert.equal(m.pendingShown(messages, { text: "/usage", at: sentAt }), false, "the transcript has it now");
assert.equal(m.pendingShown(messages, { text: "Add tests", at: sentAt }), true, "an older identical message doesn't count");
assert.equal(m.pendingShown(messages, null), false);
assert.equal(m.pendingShown([], { text: "hi", at: sentAt }), true);

// ---- choices grouped ----
assert.deepEqual(
    m.groupOptions([
        { name: "a", description: "", group: "Servers" },
        { name: "b", description: "", group: null },
        { name: "c", description: "", group: "Servers" },
        { name: "d", description: "", group: "Other" },
    ]).map((g) => [g.group, g.options.map((o) => o.name).join("")]),
    [[null, "b"], ["Servers", "ac"], ["Other", "d"]],
);

// ---- the turn in flight ----
// A live read lists the turn's finished messages (transcript ids); the chat shows them after the
// transcript until the transcript has them, so a reply never leaves the chat between reads.
{
    const t = (id, role, content, timestamp = "2026-01-01T00:00:00Z") => ({ id, role, content, timestamp });
    const transcript = [t("u0", "user", "Earlier"), t("a0", "assistant", "Earlier reply")];
    let seen = m.noteTurn([], [t("u1", "user", "Go"), t("a1", "assistant", "Step one")], 1000);
    assert.deepEqual(seen.map((s) => [s.id, s.seenAt]), [["u1", 1000], ["a1", 1000]]);
    seen = m.noteTurn(seen, [t("u1", "user", "Go"), t("a1", "assistant", "Step one, longer"), t("a2", "assistant", "Step two")], 2000);
    assert.deepEqual(seen.map((s) => [s.id, s.content, s.seenAt]), [
        ["u1", "Go", 1000],
        ["a1", "Step one, longer", 1000],
        ["a2", "Step two", 2000],
    ], "new messages join in order; ones seen before take their latest content and keep when they were seen");
    assert.equal(m.noteTurn(seen, [], 3000), seen, "an empty read changes nothing");
    // A later read that lists only the turn's tail (it carries its last few) loses nothing seen.
    seen = m.noteTurn(seen, [t("a2", "assistant", "Step two")], 3000);
    assert.equal(seen.length, 3);

    const shown = m.withTurn(transcript, seen);
    assert.deepEqual(shown.map((x) => x.id), ["u0", "a0", "u1", "a1", "a2"]);
    assert.ok(shown.every((x) => !("seenAt" in x)), "shown as plain messages");
    assert.equal(m.withTurn(transcript, []), transcript, "nothing seen: the transcript as is");
    // The transcript now has the first two: they show once, from the transcript.
    const read = [...transcript, t("u1", "user", "Go"), t("a1", "assistant", "Step one, longer (final)")];
    assert.deepEqual(m.withTurn(read, seen).map((x) => [x.id, x.content]).slice(2), [
        ["u1", "Go"],
        ["a1", "Step one, longer (final)"],
        ["a2", "Step two"],
    ], "the transcript's copy wins, and what it lacks still follows");

    // Settling after a transcript read started at 2500: what it has goes; seen before the read
    // began means the transcript would have had it, so it goes too; seen after stays.
    assert.deepEqual(m.settleSeen(seen, read, 2500).map((s) => s.id), []);
    const late = m.noteTurn(seen, [t("a3", "assistant", "Step three")], 4000);
    assert.deepEqual(m.settleSeen(late, read, 2500).map((s) => s.id), ["a3"], "a message seen after the read began waits for the next read");

    // A message the user sent stops showing as sent once the turn lists it.
    const sentAt = Date.parse("2026-01-01T00:00:00Z");
    assert.equal(m.pendingShown(m.withTurn(transcript, seen), { text: "Go", at: sentAt }), false);
}

console.log("task-chat-model harness: ok");
