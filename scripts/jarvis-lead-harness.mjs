import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "jarvis-lead-"));
process.env.ADO_PR_OPS_DB_PATH = join(root, "data", "reviews.db");
process.env.ADO_PR_OPS_JARVIS_DIR = join(root, "jarvis");
process.env.ADO_PR_OPS_CONFIG_PATH = join(root, "config.json");

const store = await import("../jarvis-store.mjs");
const today = await import("../jarvis-today.mjs");
const lead = await import("../jarvis-lead.mjs");
const images = await import("../chat-images.mjs");
const { closeDb } = await import("../store.mjs");

async function until(check, label, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

// ---- a fake Lead session ------------------------------------------------------------
class FakeLead {
    constructor(sessionId, config) {
        this.sessionId = sessionId;
        this.config = config;
        this.handlers = new Map();
        this.all = new Set();
        this.events = [];
        this.disconnected = 0;
        this.model = config.model || "cli-default";
        this.effort = config.reasoningEffort || null;
        this.modelSwitches = [];
        this.effortSwitches = [];
        this.prompts = [];
        this.steered = [];
        /** The attachments of each message, turn or steered, in order. */
        this.attached = [];
        this.turn = 0;
        this.inTurn = false;
        this.rpc = {
            model: {
                getCurrent: async () => ({ modelId: this.model, ...(this.effort ? { reasoningEffort: this.effort } : {}) }),
                // Like the runtime: a switch during a turn waits for the turn to end.
                switchTo: async ({ modelId, reasoningEffort }) => {
                    this.modelSwitches.push(modelId);
                    this.effortSwitches.push(reasoningEffort ?? null);
                    if (this.inTurn) return { deferred: true, status: "queued" };
                    this.model = modelId;
                    this.effort = reasoningEffort || null;
                    return { deferred: false, status: "applied", modelId };
                },
            },
        };
        this.reply = (prompt) => `You said: ${prompt}`;
    }
    on(type, handler) {
        if (typeof type === "function") {
            this.all.add(type);
            return () => this.all.delete(type);
        }
        const list = this.handlers.get(type) || [];
        list.push(handler);
        this.handlers.set(type, list);
        return () => {
            const now = this.handlers.get(type) || [];
            const at = now.indexOf(handler);
            if (at >= 0) now.splice(at, 1);
        };
    }
    emit(type, data) {
        for (const handler of this.handlers.get(type) || []) handler({ type, data });
        for (const handler of [...this.all]) handler({ type, data });
    }
    /** A turn ("enqueue", the default) or a message steered into the running one ("immediate"). */
    async send({ prompt, mode, attachments }) {
        // Like the runtime, the message keeps its attachments.
        const data = { content: prompt, ...(attachments ? { attachments } : {}) };
        this.attached.push(attachments || null);
        if (mode === "immediate") {
            this.steered.push(prompt);
            this.events.push({ id: `u${this.events.length}`, type: "user.message", data });
            this.emit("user.message", data);
            return `s${this.steered.length}`;
        }
        const turn = ++this.turn;
        this.prompts.push(prompt);
        this.inTurn = true;
        this.events.push({ id: `u${this.events.length}`, type: "user.message", data });
        this.emit("user.message", data);
        this.emit("assistant.message_delta", { deltaContent: "partial" });
        void (async () => {
            let content;
            try {
                content = await this.reply(prompt);
            } catch (error) {
                if (turn !== this.turn || !this.inTurn) return;
                this.inTurn = false;
                return this.emit("session.error", { message: error.message });
            }
            if (turn !== this.turn || !this.inTurn) return;
            this.events.push({ id: `a${this.events.length}`, type: "assistant.message", data: { messageId: `m${this.events.length}`, content } });
            this.emit("assistant.message", { content });
            this.inTurn = false;
            this.emit("session.idle", {});
        })();
        return `m${turn}`;
    }
    async sendAndWait() {
        throw new Error("turns go through send");
    }
    async getEvents() {
        this.reads = (this.reads || 0) + 1;
        return this.events;
    }
    /** Aborting a running turn ends it with session.idle, as the runtime does. */
    async abort() {
        this.aborted = (this.aborted || 0) + 1;
        if (!this.inTurn) return;
        this.inTurn = false;
        this.emit("session.idle", { aborted: true });
    }
    async disconnect() {
        this.disconnected++;
    }
}
const created = [];
const resumed = [];
let resumeFails = false;
let resumeDelay = 0;
/** Per-call resume delays, used up in order; then resumeDelay applies. */
const resumeDelays = [];
let sessionExists = true;
let resumedModel = "older-model";
lead.setLeadRuntime({
    async create(config) {
        const s = new FakeLead(`00000000-0000-4000-8000-00000000000${created.length + 1}`, config);
        created.push(s);
        return s;
    },
    async resume(id, config) {
        const delay = resumeDelays.length ? resumeDelays.shift() : resumeDelay;
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (resumeFails) throw new Error("session not found");
        const s = new FakeLead(id, config);
        // A real resume keeps the conversation and the model the session last ran.
        const prior = [...created, ...resumed].reverse().find((x) => x.sessionId === id);
        if (prior) s.events = [...prior.events];
        s.model = resumedModel;
        resumed.push(s);
        return s;
    },
    async exists() {
        return sessionExists;
    },
    async catalog() {
        return [
            { id: "gpt-x", name: "GPT X", efforts: ["low", "medium", "high"] },
            { id: "claude-y", name: "Claude Y", efforts: [] },
            { id: "cli-default", name: "Default", efforts: [] },
        ];
    },
});

try {
    // ---- work item references ----
    assert.deepEqual(today.parseWorkItemRef("2841124"), { org: null, id: 2841124 });
    assert.deepEqual(today.parseWorkItemRef(" #42 "), { org: null, id: 42 });
    assert.deepEqual(
        today.parseWorkItemRef("https://dev.azure.com/msazure/Azure%20AppConfig/_workitems/edit/2841124/"),
        { org: "msazure", id: 2841124 },
    );
    assert.deepEqual(today.parseWorkItemRef("https://contoso.visualstudio.com/Proj/_workitems/edit/7"), { org: "contoso", id: 7 });
    assert.equal(today.parseWorkItemRef("fix the build"), null);
    await assert.rejects(today.createTaskFromInput({ workItem: "fix it" }, ["msazure"]), /work item number/);
    await assert.rejects(today.createTaskFromInput({ workItem: "42" }, ["a", "b"]), /Choose the organization/);

    // ---- the review lane matches "Needs your review" ----
    const pr = (over) => ({
        org: "msazure", project: "P", repo: "R", repoId: "r", id: 1, title: "T", author: "A", created: "2026-10-15T00:00:00Z",
        isDraft: false, status: "active", url: "u", mine: true, authoredByMe: false, myVote: 0, iCommented: false, plateDismissed: false, ...over,
    });
    const queue = today.reviewQueue([
        pr({ id: 1 }),
        pr({ id: 2, authoredByMe: true }),
        pr({ id: 3, myVote: 10 }),
        pr({ id: 4, iCommented: true }),
        pr({ id: 5, mine: false }),
        pr({ id: 6, plateDismissed: true }),
        pr({ id: 7, status: "completed" }),
        pr({ id: 8, isDraft: true }),
    ]);
    assert.deepEqual(queue.map((r) => r.prId), [1, 8]);
    assert.equal(queue[1].isDraft, true);

    // ---- the Lead's tools ----
    const tools = Object.fromEntries(lead.leadTools().map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(tools).sort(), [
        "devis_change_self", "devis_create_task", "devis_history", "devis_message_worker", "devis_notes", "devis_post_status", "devis_set_task_status",
        "devis_start_worker", "devis_stop_worker", "devis_task_artifacts", "devis_task_validation", "devis_today",
    ]);
    assert.ok(Object.values(tools).every((t) => t.skipPermission), "the Lead's own tools never prompt");
    assert.match(
        String(await tools.devis_change_self.handler({ title: "Bigger font", description: "Make the font bigger." })),
        /Changing Devis itself is off/,
        "changing Devis waits for Settings to turn it on",
    );

    let view = JSON.parse(await tools.devis_today.handler({}));
    assert.match(view.pullRequestsToReview, /Not loaded yet/);
    today.notePrActivity([{ org: "msazure", prId: 1 }], { vote: 10 });

    // ---- the remembered queue follows what the user does after it loaded ----
    const memo = [pr({ id: 21 }), pr({ id: 22 }), pr({ id: 23 }), pr({ id: 24, org: "other" })];
    today.rememberPrs(memo);
    assert.deepEqual(today.reviewQueue().map((r) => r.prId), [21, 22, 23, 24]);
    today.notePrActivity([{ org: "msazure", project: "P", repoId: "r", prId: "21" }], { commented: true });
    today.notePrActivity([{ org: "msazure", prId: 22 }], { vote: 10 });
    today.notePrActivity([{ prId: "23", org: "msazure" }], { hidden: true });
    today.notePrActivity([{ org: "msazure", prId: 24 }], { vote: 10 });
    assert.deepEqual(today.reviewQueue().map((r) => r.prId), [24], "comment, vote and hide leave the queue; another org's PR is untouched");
    today.notePrActivity([{ org: "msazure", prId: "23" }], { hidden: false });
    assert.deepEqual(today.reviewQueue().map((r) => r.prId), [23, 24], "restoring brings it back");

    // A queued Copilot review un-hides its PR in the store; the queue hears it (api.mts wires this).
    const reviews = await import("../store.mjs");
    await reviews.ensureDb();
    const unhook = reviews.onPlateDismissed((ids, dismissed) => today.notePrActivity(ids, { hidden: dismissed }));
    reviews.setPlateDismissed([{ prId: "23", org: "msazure", project: "P", repoId: "r" }], true);
    assert.deepEqual(today.reviewQueue().map((r) => r.prId), [24]);
    reviews.upsertReview({ prId: "23", org: "msazure", project: "P", repoId: "r", title: "PR 23", status: "queued" });
    assert.deepEqual(today.reviewQueue().map((r) => r.prId), [23, 24], "a queued review brings its PR back");
    unhook();

    today.rememberPrs([pr({ id: 17514805, title: "Pin upstream builds" }), pr({ id: 9, myVote: 5 })]);

    assert.match(await tools.devis_create_task.handler({ title: "Onboarding docs refresh" }), /^Created: Onboarding docs refresh \(taskId [0-9a-f-]{36}\)$/);
    const [task] = await store.listTasks();
    view = JSON.parse(await tools.devis_today.handler({}));
    assert.equal(view.tasks.length, 1);
    assert.equal(view.tasks[0].taskId, task.id);
    assert.deepEqual(view.tasks[0].pullRequests, [], "each task carries its PRs");
    assert.deepEqual(view.pullRequestsToReview.map((p) => p.pr), ["#17514805"]);

    const arts = tools.devis_task_artifacts;
    assert.equal(await arts.handler({ taskId: task.id, action: "append", content: "Standup: docs half done." }), "Added to note.md.");
    assert.match(await arts.handler({ taskId: task.id, action: "read" }), /· Devis\n\nStandup: docs half done\./);
    assert.match(await arts.handler({ taskId: task.id, action: "list" }), /^note\.md · \d+ B · changed .+\nFolder: .+artifacts$/);
    assert.match(await arts.handler({ taskId: task.id, action: "read", name: "recap.md" }), /^Not done: There is no artifact named recap\.md/);
    assert.match(await arts.handler({ taskId: task.id, action: "write", name: "x.md", content: "y" }), /^Failed: Use action list, read or append/, "the Lead only reads and appends");
    assert.match(await arts.handler({ taskId: "nope", action: "read" }), /^Failed: Unknown taskId/);

    // ---- the user's own to-dos and quick note through the Lead ----
    const notes = tools.devis_notes;
    assert.match(await notes.handler({ action: "add_todo", text: "Book the design review" }), /^Added to-do \[\d+\]: Book the design review$/);
    assert.equal(await notes.handler({ action: "append_note", text: "Canary is green." }), "Added to the quick note.");
    const noteText = await notes.handler({ action: "read" });
    assert.match(noteText, /- \[(\d+)\] Book the design review \(added by Devis\)/);
    assert.match(noteText, /Quick note:\n\[Devis, .+\] Canary is green\.$/);
    const todoId = Number(/\[(\d+)\] Book the design review/.exec(noteText)[1]);
    assert.equal(await notes.handler({ action: "set_due", id: todoId, due: "2026-03-02" }), `[${todoId}] is due 2026-03-02.`, "the Lead can date a to-do");
    assert.match(await notes.handler({ action: "complete_todo", id: String(todoId) }), /^Checked off \[\d+\]: Book the design review$/, "an id given as text works too");
    assert.match(await notes.handler({ action: "delete", id: todoId }), /^Use action read, add_todo, complete_todo, set_due, append_note\.$/);

    // ---- status updates through the Lead ----
    assert.equal(await tools.devis_post_status.handler({ taskId: task.id, text: "Setup guide rewritten" }), "Posted: Setup guide rewritten");
    assert.equal(await tools.devis_post_status.handler({ taskId: task.id, text: "Setup guide rewritten" }), "Already posted: Setup guide rewritten");
    assert.match(await tools.devis_post_status.handler({ taskId: "nope", text: "x" }), /^Failed: Task not found/);
    view = JSON.parse(await tools.devis_today.handler({}));
    assert.equal(view.tasks[0].latestUpdate.text, "Setup guide rewritten");
    assert.equal(view.tasks[0].latestUpdate.by, "Devis");
    assert.equal(view.tasks[0].updatesToday, 1);
    assert.equal(view.overview, null, "no overview before the first write-up");
    await store.insertWriteup({ inputsHash: "h", model: "m", text: "[[Onboarding docs refresh]] is moving.", valid: true, error: null });
    await store.insertWriteup({ inputsHash: "h2", model: "m", text: "rejected", valid: false, error: "check: x" });
    const withOverview = await tools.devis_history.handler({ days: 1 });
    assert.match(withOverview, /task\.status · Devis: Setup guide rewritten/);
    assert.match(withOverview, /Overview write-ups \(newest first\):\n.+ · Onboarding docs refresh is moving\./);
    assert.ok(!withOverview.includes("rejected"), "rejected write-ups stay out of the Lead's history");

    assert.match(await tools.devis_set_task_status.handler({ taskId: task.id, status: "done" }), /is now done/);
    view = JSON.parse(await tools.devis_today.handler({}));
    assert.equal(view.tasks[0].status, "done", "done today still shows on Today");
    await store.recordEvent("pr.reviewed", "Approved PR #17510211 Throttle snapshot export");
    view = JSON.parse(await tools.devis_today.handler({}));
    assert.deepEqual(view.reviewedToday.map((r) => r.what), ["Approved PR #17510211 Throttle snapshot export"]);

    const history = await tools.devis_history.handler({ days: 3 });
    assert.match(history, /task\.created · Task created: Onboarding docs refresh/);
    assert.match(history, /task\.done · Done: Onboarding docs refresh/);
    assert.match(await tools.devis_history.handler({ taskId: "00000000-0000-4000-8000-0000000000ff" }), /No events/);
    assert.match(await tools.devis_message_worker.handler({ workerSessionId: "nope", text: "hi" }), /^Failed: Worker not found/);
    assert.match(
        await tools.devis_start_worker.handler({ taskId: task.id, folder: root, instructions: "go" }),
        /^Failed: Reopen the task/,
        "a done task takes no workers, even from the Lead",
    );

    // ---- Lead permissions: its tools and reads only ----
    // Opening the tab does not start a session.
    let chat = await lead.getLeadChat();
    assert.deepEqual(chat, {
        sessionId: null, messages: [], pending: false, partial: "", activity: "", error: null, stopped: false,
        model: "", effort: "", currentModel: null, currentEffort: null, queue: [], queueHeld: false, canSteer: false,
    });
    assert.equal(created.length, 0);

    await lead.sendLead("What needs me today?");
    await assert.rejects(lead.sendLead("again"), /still answering/);
    await until(async () => !(await lead.getLeadChat()).pending, "lead reply");
    assert.equal(created.length, 1);
    const config = created[0].config;
    assert.equal(config.workingDirectory, join(root, "jarvis"));
    assert.match(config.systemMessage.content, /overseeing the user's Workspace/);
    assert.match(config.systemMessage.content, /Read them with devis_notes/, "the Lead knows where the user's notes are");
    assert.deepEqual(await config.onPermissionRequest({ kind: "read" }), { kind: "approve-once" });
    assert.deepEqual(await config.onPermissionRequest({ kind: "mcp", serverName: "workiq", toolName: "ask" }), { kind: "approve-once" }, "the Lead calls MCP tools");
    assert.equal("disabledMcpServers" in config, false, "every MCP server is on for the Lead");
    assert.match(config.systemMessage.content, /You also have the user's MCP servers/);
    assert.equal((await config.onPermissionRequest({ kind: "shell", fullCommandText: "del *" })).kind, "reject");
    assert.equal((await config.onPermissionRequest({ kind: "write", fileName: "x" })).kind, "reject");
    assert.deepEqual(await config.onPermissionRequest({ kind: "url", url: "https://sre.azure.com/docs-internal" }), { kind: "approve-once" }, "the Lead reads web pages");
    assert.match(config.systemMessage.content, /search it with web_search and read any page with web_fetch, without asking the user/, "the Lead knows it has the web");
    assert.match((await config.onPermissionRequest({ kind: "shell", fullCommandText: "x" })).feedback, /MCP tools and the web only/);
    chat = await lead.getLeadChat();
    assert.equal(chat.sessionId, created[0].sessionId);
    assert.deepEqual(chat.messages.map((m) => [m.role, m.content]), [
        ["user", "What needs me today?"],
        ["assistant", "You said: What needs me today?"],
    ]);
    assert.equal(await store.getMeta("leadSessionId"), created[0].sessionId, "the Lead's session is remembered");

    // ---- polling an unchanged chat doesn't re-read the whole session ----
    const reads = created[0].reads;
    await lead.getLeadChat();
    await lead.getLeadChat();
    assert.equal(created[0].reads, reads, "nothing landed, nothing read");
    created[0].emit("user.message", { content: "from elsewhere" });
    await lead.getLeadChat();
    assert.equal(created[0].reads, reads + 1, "a message landing reads it again");
    assert.equal(lead.LEAD_MESSAGES_SHOWN, 200);

    // ---- a failed turn is reported, not thrown ----
    created[0].reply = () => {
        throw new Error("model unavailable");
    };
    await lead.sendLead("hello");
    chat = await until(async () => {
        const c = await lead.getLeadChat();
        return !c.pending && c;
    }, "failed turn");
    assert.equal(chat.error, "model unavailable");
    assert.ok(created[0].disconnected >= 1, "a failed turn drops the cached session so the next use resumes");
    assert.equal(await store.getMeta("leadSessionId"), created[0].sessionId, "…but keeps the conversation");

    // ---- after a restart: the chat as last read shows at once, and the same session resumes behind it ----
    const live = await until(async () => {
        const c = await lead.getLeadChat();
        return !c.resuming && c;
    }, "the Lead live again after the failed turn");
    const lastRead = live.messages;
    const resumedBefore = resumed.length;
    assert.ok(lastRead.length > 0);
    await lead.closeLead();
    const [first, second] = await Promise.all([lead.getLeadChat(), lead.getLeadChat()]);
    assert.equal(first.resuming, true, "a cold read doesn't wait on the resume");
    assert.deepEqual(first.messages, lastRead, "…and shows the chat as it was last read");
    assert.equal(second.resuming, true);
    await until(() => resumed.length > resumedBefore, "background resume");
    chat = await lead.getLeadChat();
    assert.ok(!chat.resuming, "once resumed, reads are live");
    assert.deepEqual(chat.messages, lastRead);
    assert.equal(resumed.length, resumedBefore + 1, "reads at the same time resume once");
    assert.equal(resumed.at(-1).sessionId, created[0].sessionId);
    await lead.closeLead();
    // A temporary failure (CLI down, auth) keeps the saved conversation, and the next read reports it.
    resumeFails = true;
    assert.equal((await lead.getLeadChat()).resuming, true);
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(lead.getLeadChat(), /session not found/, "after a failed resume, reads wait on the next one");
    assert.equal(await store.getMeta("leadSessionId"), created[0].sessionId, "a temporary failure never forgets the Lead");
    // Only a session the CLI confirms is gone is replaced.
    sessionExists = false;
    chat = await lead.getLeadChat();
    assert.deepEqual(chat.messages, [], "a lost session reads as empty");
    assert.equal(await store.getMeta("leadSessionId"), null);
    resumeFails = false;
    sessionExists = true;

    // ---- New session ----
    await lead.sendLead("first");
    await until(async () => !(await lead.getLeadChat()).pending, "reply in a new session");
    assert.equal(created.length, 2);
    // Started over while the old session is still resuming: a read during the reset never brings it back.
    await lead.getLeadChat();
    await lead.closeLead();
    resumeDelay = 150;
    const resumedAt = resumed.length;
    assert.equal((await lead.getLeadChat()).resuming, true);
    const resetting = lead.resetLead();
    await new Promise((r) => setTimeout(r, 10));
    await lead.getLeadChat();
    await resetting;
    await new Promise((r) => setTimeout(r, 400));
    resumeDelay = 0;
    const fresh = await lead.getLeadChat();
    assert.equal(fresh.sessionId, null, "the old session isn't back");
    assert.deepEqual(fresh.messages, []);
    assert.ok(resumed.length > resumedAt);
    assert.ok(resumed.slice(resumedAt).every((s) => s.disconnected >= 1), "a resume overtaken by the reset lets its session go");
    await lead.resetLead();

    // A slow resume overtaken by a release, finishing after the newer one, never takes over its events.
    await lead.sendLead("again");
    await until(async () => !(await lead.getLeadChat()).pending, "reply before the slow resume");
    await lead.getLeadChat();
    await lead.closeLead();
    const raceAt = resumed.length;
    resumeDelays.push(300, 30);
    assert.equal((await lead.getLeadChat()).resuming, true, "slow resume started");
    const closing = lead.closeLead();
    await new Promise((r) => setTimeout(r, 10));
    await lead.getLeadChat();
    await closing;
    await new Promise((r) => setTimeout(r, 450));
    const alive = resumed.slice(raceAt).filter((s) => !s.disconnected);
    assert.equal(alive.length, 1, "only the newer resume stays connected");
    const shown = (await lead.getLeadChat()).messages.length;
    alive[0].events.push({ id: `u${alive[0].events.length}`, type: "user.message", data: { content: "landed later" } });
    alive[0].emit("user.message", {});
    assert.equal((await lead.getLeadChat()).messages.length, shown + 1, "the live session's messages still reach the chat");
    await lead.resetLead();
    assert.equal(await store.getMeta("leadSessionId"), null);
    assert.equal(await store.getMeta("leadChatSnapshot"), null, "a new session forgets the old chat");
    assert.ok(created[1].disconnected >= 1);
    assert.equal((await lead.getLeadChat()).messages.length, 0);

    // ---- the Lead's model and effort ----
    const res = (model, currentModel, extra = {}) => ({ model, effort: "", currentModel, currentEffort: null, deferred: false, ...extra });
    // Chosen with no session: saved, and the next session starts on it.
    assert.deepEqual(await lead.setLeadModel("gpt-x"), res("gpt-x", null));
    await assert.rejects(lead.setLeadModel("not-in-catalog"), /isn't available/);
    await assert.rejects(lead.setLeadModel("bad id; rm"), /Unknown model/);
    // An effort goes with a chosen model that takes it.
    await assert.rejects(lead.setLeadModel("claude-y", "high"), /claude-y doesn't take a reasoning effort/);
    await assert.rejects(lead.setLeadModel("", "high"), /Choose a model before its reasoning effort/);
    await assert.rejects(lead.setLeadModel("gpt-x", "ultra"), /gpt-x takes low, medium, high, not ultra/);
    assert.deepEqual(await lead.setLeadModel("gpt-x", "high"), res("gpt-x", null, { effort: "high" }));
    await lead.sendLead("hi");
    await until(async () => !(await lead.getLeadChat()).pending, "reply on the chosen model");
    const modeled = created.at(-1);
    assert.equal(modeled.config.model, "gpt-x", "a new session starts on the chosen model");
    assert.equal(modeled.config.reasoningEffort, "high", "…and effort");
    chat = await lead.getLeadChat();
    assert.deepEqual([chat.model, chat.effort, chat.currentModel, chat.currentEffort], ["gpt-x", "high", "gpt-x", "high"]);

    // Changed on a live session: switches now and keeps the conversation.
    assert.deepEqual(await lead.setLeadModel("gpt-x", "low"), res("gpt-x", "gpt-x", { effort: "low", currentEffort: "low" }));
    assert.deepEqual(await lead.setLeadModel("claude-y"), res("claude-y", "claude-y"));
    assert.deepEqual(modeled.modelSwitches, ["gpt-x", "claude-y"]);
    assert.deepEqual(modeled.effortSwitches, ["low", null], "no effort clears the session's override");
    assert.equal((await lead.getLeadChat()).messages.length, 2, "switching keeps the conversation");

    // Back to the default: saved for new sessions; the running conversation keeps its model.
    assert.deepEqual(await lead.setLeadModel(""), res("", "claude-y"));
    assert.deepEqual(modeled.modelSwitches, ["gpt-x", "claude-y"], "Copilot only picks its default when a session starts");
    assert.equal(await store.getMeta("leadModel"), null);
    await lead.resetLead();
    await lead.sendLead("fresh");
    await until(async () => !(await lead.getLeadChat()).pending, "reply in a default session");
    assert.equal(created.at(-1).config.model, undefined, "a new session starts on the Copilot default");
    assert.equal("reasoningEffort" in created.at(-1).config, false);

    // A resumed session is held to the chosen model and effort.
    await lead.setLeadModel("gpt-x", "medium");
    await lead.closeLead();
    resumedModel = "older-model";
    const resumedCount = resumed.length;
    await lead.getLeadChat();
    await until(() => resumed.length > resumedCount && resumed.at(-1).modelSwitches.length, "resumed on the chosen model");
    chat = await lead.getLeadChat();
    assert.deepEqual(resumed.at(-1).modelSwitches, ["gpt-x"]);
    assert.deepEqual(resumed.at(-1).effortSwitches, ["medium"]);
    assert.equal(resumed.at(-1).config.reasoningEffort, "medium");
    assert.deepEqual([chat.currentModel, chat.currentEffort], ["gpt-x", "medium"]);

    // Mid-answer the switch waits for the turn to end.
    const session = resumed.at(-1);
    let release;
    session.reply = (prompt) => (prompt === "slow" ? new Promise((r) => (release = r)) : `You said: ${prompt}`);
    await lead.sendLead("slow");
    await until(() => release, "slow turn started");
    assert.equal((await lead.setLeadModel("gpt-x", "high")).deferred, true, "a switch mid-turn is deferred, not refused");

    // ---- queue and steer while Jarvis answers ----
    await assert.rejects(lead.sendLead("no mode"), /still answering/, "without a mode a busy Lead still refuses");
    chat = await lead.getLeadChat();
    assert.equal(chat.canSteer, true);
    const q1 = await lead.sendLead("first queued", "queue");
    assert.equal(q1.result, "queued");
    const q2 = await lead.sendLead("second queued", "queue");
    const q3 = await lead.sendLead("dropped", "queue");
    assert.deepEqual((await lead.getLeadChat()).queue.map((m) => m.text), ["first queued", "second queued", "dropped"]);
    lead.removeLeadQueued(q3.id);
    assert.throws(() => lead.removeLeadQueued(q3.id), /already left the queue/);
    assert.deepEqual(await lead.sendLead("look at PR 7 instead", "now"), { result: "steered" });
    assert.deepEqual(session.steered, ["look at PR 7 instead"], "steered into the running turn");
    assert.ok((await lead.getLeadChat()).messages.some((m) => m.content === "look at PR 7 instead"), "and it shows in the chat");
    assert.deepEqual(await lead.sendLeadQueuedNow(q2.id), { result: "steered" }, "a queued message can go in now");
    assert.deepEqual(session.steered, ["look at PR 7 instead", "second queued"]);
    assert.deepEqual((await lead.getLeadChat()).queue.map((m) => m.text), ["first queued"]);
    release("done");
    // The turn ends and the queue runs, one turn per message.
    await until(async () => session.prompts.includes("first queued") && !(await lead.getLeadChat()).pending, "the queued message ran");
    assert.deepEqual(session.prompts.slice(-2), ["slow", "first queued"]);
    assert.deepEqual((await lead.getLeadChat()).queue, []);

    // Steering before the turn's message is out queues instead.
    await lead.closeLead();
    resumeDelays.push(150);
    await lead.sendLead("waking up");
    assert.equal((await lead.sendLead("too early", "now")).result, "queued");
    await until(async () => !(await lead.getLeadChat()).pending && resumed.at(-1).prompts.includes("too early"), "ran after");
    assert.deepEqual(resumed.at(-1).steered, []);

    // ---- Stop: ends the turn, and holds the queue until the user sends again ----
    const stopper = resumed.at(-1);
    stopper.reply = (prompt) => (prompt === "endless" ? new Promise(() => {}) : `You said: ${prompt}`);
    await lead.sendLead("endless");
    await until(async () => (await lead.getLeadChat()).canSteer, "endless turn live");
    await lead.sendLead("after the stop", "queue");
    await lead.stopLead();
    chat = await until(async () => {
        const c = await lead.getLeadChat();
        return !c.pending && c;
    }, "stopped");
    assert.equal(chat.stopped, true);
    assert.equal(chat.error, null, "a stop isn't a failure");
    assert.equal(chat.queueHeld, true);
    assert.deepEqual(chat.queue.map((m) => m.text), ["after the stop"]);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(!stopper.prompts.includes("after the stop"), "a held queue doesn't start on its own");
    assert.ok(stopper.aborted >= 1);
    await lead.sendLead("carry on");
    await until(async () => stopper.prompts.includes("after the stop") && !(await lead.getLeadChat()).pending, "the queue ran after the next turn");
    assert.deepEqual(stopper.prompts.slice(-2), ["carry on", "after the stop"]);
    chat = await lead.getLeadChat();
    assert.deepEqual([chat.stopped, chat.queueHeld, chat.queue.length], [false, false, 0]);
    await lead.stopLead(); // idle: nothing to do

    // Sending a queued message while idle starts it.
    stopper.reply = (prompt) => (prompt === "long" ? new Promise((r) => (release = r)) : `You said: ${prompt}`);
    await lead.sendLead("long");
    await until(() => (lead.getLeadChat().then((c) => c.canSteer)), "long live");
    const parked = await lead.sendLead("parked", "queue");
    await lead.stopLead();
    await until(async () => !(await lead.getLeadChat()).pending, "long stopped");
    assert.deepEqual(await lead.sendLeadQueuedNow(parked.id), { result: "sent" });
    await until(async () => stopper.prompts.at(-1) === "parked" && !(await lead.getLeadChat()).pending, "parked ran");

    // The queue has a limit; a new session forgets it.
    stopper.reply = (prompt) => (prompt === "busy" ? new Promise((r) => (release = r)) : `You said: ${prompt}`);
    await lead.sendLead("busy");
    await until(() => (lead.getLeadChat().then((c) => c.canSteer)), "busy live");
    for (let i = 0; i < 20; i++) await lead.sendLead(`q${i}`, "queue");
    await assert.rejects(lead.sendLead("one too many", "queue"), /The queue holds 20 messages/);
    await lead.stopLead();
    await until(async () => !(await lead.getLeadChat()).pending, "busy stopped");
    await lead.resetLead();
    assert.deepEqual((await lead.getLeadChat()).queue, [], "a new session starts with an empty queue");

    // ---- images: pasted ones go with the message as files, in turns, steered and queued ----
    const png = (seed) => {
        const bytes = Buffer.alloc(64, seed);
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
        return bytes.toString("base64");
    };
    const shot = await images.saveImage({ data: png(1), name: "shot.png" });
    const other = await images.saveImage({ data: `data:image/png;base64,${png(2)}`, name: "C:\\Users\\me\\other.png" });
    assert.equal(other.name, "other.png", "a pasted name keeps no folders");
    const createdBefore = created.length;
    await lead.sendLead("what's wrong here?", undefined, [{ id: shot.id, name: shot.name }]);
    const imgLead = await until(() => created.length > createdBefore && created.at(-1), "a new Lead session");
    await until(async () => !(await lead.getLeadChat()).pending && imgLead.prompts.includes("what's wrong here?"), "image turn ran");
    assert.deepEqual(imgLead.attached.at(-1), [{ type: "file", path: images.imagePath(shot.id), displayName: "shot.png" }], "the image goes as a file");
    chat = await lead.getLeadChat();
    let mine = chat.messages.filter((m) => m.role === "user").at(-1);
    assert.deepEqual([mine.content, mine.images], ["what's wrong here?", [{ id: shot.id, name: "shot.png" }]], "the chat shows the image with the words");
    // Only images: the session gets a line pointing at them; the chat shows just the images.
    await lead.sendLead("  ", undefined, [{ id: shot.id, name: "shot.png" }, { id: other.id, name: other.name }]);
    await until(async () => !(await lead.getLeadChat()).pending && imgLead.prompts.at(-1) === "Take a look at the attached images.", "image-only turn ran");
    chat = await lead.getLeadChat();
    mine = chat.messages.filter((m) => m.role === "user").at(-1);
    assert.equal(mine.content, "", "no placeholder text in the chat");
    assert.deepEqual(mine.images.map((i) => i.id), [shot.id, other.id]);
    await assert.rejects(lead.sendLead("", undefined, []), /Type a message/, "nothing at all is still refused");
    await assert.rejects(lead.sendLead("x", undefined, [{ id: "../../secret.png", name: "x" }]), /isn't one the app saved/);
    await assert.rejects(lead.sendLead("x", undefined, [{ id: "0".repeat(32) + ".png", name: "x" }]), /is gone/);
    await assert.rejects(lead.sendLead("x", undefined, "nope"), /must be a list/);
    await assert.rejects(lead.sendLead("x", undefined, Array.from({ length: 7 }, () => ({ id: shot.id, name: "a" }))), /up to 6 images/);
    // Mid-turn: steered in with its image, or queued with it and sent when the turn ends.
    imgLead.reply = (prompt) => (prompt === "hold" ? new Promise((r) => (release = r)) : `You said: ${prompt}`);
    await lead.sendLead("hold");
    await until(async () => (await lead.getLeadChat()).canSteer, "hold live");
    assert.equal((await lead.sendLead("this one", "now", [{ id: other.id, name: "other.png" }])).result, "steered");
    assert.deepEqual(imgLead.attached.at(-1), [{ type: "file", path: images.imagePath(other.id), displayName: "other.png" }], "steered with its image");
    const withImage = await lead.sendLead("", "queue", [{ id: shot.id, name: "shot.png" }]);
    chat = await lead.getLeadChat();
    assert.deepEqual(chat.queue.map((m) => [m.text, m.images?.map((i) => i.id)]), [["", [shot.id]]], "the queue shows its image");
    assert.ok(withImage.id);
    release("done");
    await until(async () => !(await lead.getLeadChat()).pending && imgLead.prompts.at(-1) === "Take a look at the attached image.", "queued image ran");
    assert.deepEqual(imgLead.attached.at(-1), [{ type: "file", path: images.imagePath(shot.id), displayName: "shot.png" }], "and it went with its image");
    await lead.resetLead();

    console.log("jarvis-lead harness: ok");
} finally {
    await lead.closeLead().catch(() => undefined);
    closeDb();
    rmSync(root, { recursive: true, force: true });
}
