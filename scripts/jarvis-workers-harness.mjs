import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "jarvis-workers-"));
process.env.ADO_PR_OPS_DB_PATH = join(root, "data", "reviews.db");
process.env.ADO_PR_OPS_JARVIS_DIR = join(root, "jarvis");
const repo = join(root, "repos", "AppConfig");
mkdirSync(join(repo, ".github", "skills"), { recursive: true });

const store = await import("../jarvis-store.mjs");
const workers = await import("../jarvis-workers.mjs");
const images = await import("../chat-images.mjs");
const prsModule = await import("../jarvis-prs.mjs");
const { closeDb } = await import("../store.mjs");

// PRs a worker creates are read from a fake ADO; git finds no repository.
const fakePrs = new Map();
prsModule.setPrsRuntime({
    now: () => Date.now(),
    me: async () => ({ id: "me-1", name: "Me" }),
    getPr: async (org, project, repo, prId) => (fakePrs.has(prId) ? structuredClone(fakePrs.get(prId)) : null),
    workItem: async () => null,
    branchPrs: async () => [],
    checks: async () => ({ passed: 0, failed: 0, running: 0, total: 0, failing: [] }),
    unresolved: async () => 0,
    git: async () => null,
    orgs: async () => ["msazure"],
});
const fakePr = (id) => ({
    pullRequestId: id,
    title: `PR ${id}`,
    status: "active",
    createdBy: { id: "me-1", displayName: "Me" },
    creationDate: new Date().toISOString(),
    repository: { name: "R", id: "r-id", project: { name: "P", id: "p-id" } },
});

// ---- a fake Copilot runtime ---------------------------------------------------------
const FAKE_COMMANDS = [
    { name: "usage", description: "Show usage", kind: "builtin", allowDuringAgentExecution: true },
    { name: "compact", description: "Compact the context", kind: "builtin", input: { hint: "focus instructions" }, allowDuringAgentExecution: false },
    { name: "cwd", description: "Change directory", kind: "builtin", input: { hint: "directory" }, allowDuringAgentExecution: false },
    { name: "plan", description: "Plan mode", kind: "builtin", input: { hint: "prompt" }, allowDuringAgentExecution: true },
    { name: "research", description: "Research a topic", kind: "builtin", input: { hint: "topic", required: true }, allowDuringAgentExecution: false },
    { name: "mcp", description: "MCP servers", kind: "builtin", input: { hint: "", choices: [{ name: "show", description: "Show" }] }, allowDuringAgentExecution: false },
    { name: "model", description: "Select model", kind: "builtin", input: { hint: "model" }, allowDuringAgentExecution: true },
    { name: "Session", aliases: ["S"], description: "Session info", kind: "builtin", allowDuringAgentExecution: true },
    { name: "blame", description: "Blame", kind: "builtin", allowDuringAgentExecution: false },
    { name: "no-ai-slop", description: "Edit writing", kind: "skill", input: { hint: "instructions for the skill" }, allowDuringAgentExecution: false },
    { name: "ext-thing", description: "From an extension", kind: "client", allowDuringAgentExecution: true },
];
const COMMAND_RESULTS = {
    usage: { kind: "text", text: "\u001b[1mSession Usage\u001b[0m\n\nRequests: 0", preserveAnsi: true },
    compact: { kind: "completed", message: "Compacted." },
    mcp: { kind: "select-subcommand", command: "mcp", title: "MCP servers", options: [{ name: "show", description: "Show servers" }] },
    session: { kind: "show-dialog", dialog: { kind: "model-picker" } },
    blame: { kind: "agent-prompt", prompt: "blame it", displayPrompt: "/blame", mode: "plan" },
    research: (input) => ({ kind: "agent-prompt", prompt: `RESEARCH ${input}`, displayPrompt: `/research ${input}`, notice: "\u001b[2mResearch can take a while\u001b[0m" }),
    "no-ai-slop": (input) => ({ kind: "agent-prompt", prompt: `SKILL BODY ${input}`, displayPrompt: `/no-ai-slop ${input}`.trim() }),
};

class FakeSession {
    constructor(sessionId, config) {
        this.sessionId = sessionId;
        this.config = config;
        this.handlers = new Map();
        this.sent = [];
        this.displayed = [];
        this.aborted = 0;
        this.disconnected = 0;
        this.script = null;
        this.onAbort = null;
        this.current = config.model || "claude-sonnet-5";
        this.effort = config.reasoningEffort || null;
        this.switches = [];
        this.inTurn = false;
        this.invoked = [];
        this.lists = 0;
        this.rpc = {
            commands: {
                list: async (options) => {
                    this.lists++;
                    this.listOptions = options;
                    return { commands: FAKE_COMMANDS };
                },
                invoke: async ({ name, input }) => {
                    this.invoked.push([name, input]);
                    const result = COMMAND_RESULTS[name];
                    if (!result) throw new Error(`no command ${name}`);
                    return typeof result === "function" ? result(input) : result;
                },
            },
            model: {
                getCurrent: async () => ({ modelId: this.current, ...(this.effort ? { reasoningEffort: this.effort } : {}) }),
                // Like the runtime: a switch during a turn waits for the turn to end.
                switchTo: async ({ modelId, reasoningEffort }) => {
                    this.switches.push([modelId, reasoningEffort ?? null]);
                    if (this.inTurn) return { deferred: true };
                    this.current = modelId;
                    this.effort = reasoningEffort || null;
                    this.emit("session.model_change", { newModel: modelId, reasoningEffort: reasoningEffort || undefined });
                    return { deferred: false, modelId };
                },
            },
        };
    }
    async setModel(model) {
        this.current = model;
    }
    on(type, handler) {
        const list = this.handlers.get(type) || [];
        list.push(handler);
        this.handlers.set(type, list);
        return () => this.handlers.set(type, (this.handlers.get(type) || []).filter((h) => h !== handler));
    }
    emit(type, data, id) {
        for (const handler of this.handlers.get(type) || []) handler({ ...(id ? { id } : {}), type, data });
    }
    async sendAndWait({ prompt, displayPrompt }) {
        this.sent.push(prompt);
        this.displayed.push(displayPrompt ?? null);
        this.inTurn = true;
        try {
            const content = this.script ? await this.script(this, prompt) : `Did: ${prompt}`;
            return { data: { content } };
        } finally {
            this.inTurn = false;
        }
    }
    async abort() {
        this.aborted++;
        this.onAbort?.();
    }
    async disconnect() {
        this.disconnected++;
    }
    async getEvents() {
        return [];
    }
    ask(request) {
        return this.config.onPermissionRequest(request, { sessionId: this.sessionId });
    }
    question(request) {
        return this.config.onUserInputRequest(request, { sessionId: this.sessionId });
    }
}

/** Streams events and answers isProcessing like the real runtime, so its session.idle can go missing. */
class LiveFakeSession extends FakeSession {
    constructor(sessionId, config) {
        super(sessionId, config);
        this.all = new Set();
        this.processing = false;
        this.live = null;
        this.pendingResponseWaits = new Set();
        this.rpc.metadata = { isProcessing: async () => ({ processing: this.processing }) };
    }
    on(type, handler) {
        if (typeof type !== "function") return super.on(type, handler);
        this.all.add(type);
        return () => this.all.delete(type);
    }
    emit(type, data, id) {
        super.emit(type, data, id);
        for (const handler of [...this.all]) handler({ ...(id ? { id } : {}), type, data });
    }
    async send({ prompt, displayPrompt, mode, attachments }) {
        this.attached = [...(this.attached || []), attachments || null];
        // Steered into the running turn: the runtime takes it in at its next step (takeIn).
        if (mode === "immediate") {
            this.steeredIn = [...(this.steeredIn || []), prompt];
            this.toTakeIn = [...(this.toTakeIn || []), { prompt, attachments }];
            return "s1";
        }
        this.sent.push(prompt);
        this.displayed.push(displayPrompt ?? null);
        this.processing = true;
        // Like the runtime, the turn's prompt is recorded as the user's message, with its attachments.
        this.emit("user.message", { content: prompt, ...(attachments ? { attachments } : {}) }, `u-${this.sent.length}`);
        void Promise.resolve().then(() => this.live?.(this, prompt));
        return "m1";
    }
    /** The turn's next step: what was steered in shows up as the user's messages. */
    takeIn() {
        for (const [i, { prompt, attachments }] of (this.toTakeIn || []).entries()) {
            this.emit("user.message", { content: prompt, ...(attachments ? { attachments } : {}) }, `st-${this.sent.length}-${i}`);
        }
        this.toTakeIn = [];
    }
}

const created = [];
const resumed = [];
const removed = [];
let nextScript = null;
let nextLive = null;
let resumeGate = null;
const fakeSession = (sessionId, config) => {
    const session = nextLive ? new LiveFakeSession(sessionId, config) : new FakeSession(sessionId, config);
    if (nextLive) session.live = nextLive;
    nextLive = null;
    session.script = nextScript;
    nextScript = null;
    return session;
};
workers.setWorkerRuntime({
    async create(config) {
        const session = fakeSession(config.sessionId, config);
        created.push(session);
        return session;
    },
    async resume(sessionId, config) {
        if (resumeGate) await resumeGate;
        const session = fakeSession(sessionId, config);
        resumed.push(session);
        return session;
    },
    async remove(sessionId) {
        removed.push(sessionId);
    },
    async catalog() {
        return [
            { id: "claude-haiku-4.5", name: "Haiku", efforts: [] },
            { id: "claude-sonnet-5", name: "Sonnet", efforts: ["low", "medium", "high"] },
            { id: "gpt-5-mini", name: "Mini", efforts: ["low", "medium", "high"] },
        ];
    },
});

async function until(check, label, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}
const stateOf = async (id) => (await store.getWorker(id)).state;
const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
    return { promise, resolve, reject };
};

try {
    const { task } = await store.createTask({ title: "Parameter editor", org: "msazure", project: "Azure AppConfig" });

    // ---- validation ----
    await assert.rejects(workers.startWorker({ taskId: "nope", cwd: repo, prompt: "x" }), /Task not found/);
    await assert.rejects(workers.startWorker({ taskId: task.id, cwd: "relative\\path", prompt: "x" }), /full path/);
    await assert.rejects(workers.startWorker({ taskId: task.id, cwd: join(root, "missing"), prompt: "x" }), /Folder not found/);
    await assert.rejects(workers.startWorker({ taskId: task.id, cwd: repo, prompt: "   " }), /Tell the worker/);

    // ---- a plain turn ----
    const plain = await workers.startWorker({ taskId: task.id, cwd: `"${repo}"`, prompt: "Add tests", model: "auto" });
    assert.equal(plain.label, "appconfig");
    assert.equal(plain.cwd, repo, "quotes around a pasted path are dropped");
    const session = created.at(-1);
    assert.equal(session.config.sessionId, plain.sessionId, "the worker row and the session share one id");
    assert.equal(session.config.workingDirectory, repo);
    assert.equal(session.config.model, undefined, "auto leaves the model to Copilot");
    assert.match(session.config.systemMessage.content, /Your task: Parameter editor \(service: msazure \/ Azure AppConfig\)/);
    await until(async () => (await stateOf(plain.sessionId)) === "turnDone", "turnDone");
    assert.equal((await store.getWorker(plain.sessionId)).summary, "Did: Add tests");
    assert.deepEqual(session.sent, ["Add tests"]);

    // reads, the app's own tools and web pages never wait on the user
    assert.deepEqual(await session.ask({ kind: "read", path: "x" }), { kind: "approve-once" });
    assert.deepEqual(await session.ask({ kind: "custom-tool", toolName: "task_artifacts" }), { kind: "approve-once" });
    assert.deepEqual(await session.ask({ kind: "url", url: "https://learn.microsoft.com/azure" }), { kind: "approve-once" }, "web_fetch runs without asking");
    assert.equal(workers.workerLiveState(plain.sessionId).requests.length, 0);
    assert.match(session.config.systemMessage.content, /search it with web_search and read any page with web_fetch, without asking the user/, "workers know they have the web");

    // ---- the task's Artifacts through the worker's tool ----
    assert.match(session.config.systemMessage.content, /note\.md there is the shared note/);
    assert.ok(session.config.systemMessage.content.includes(store.artifactsDir(task.id)), "the brief names the folder");
    assert.doesNotMatch(session.config.systemMessage.content, /task\.md/);
    const artTool = session.config.tools.find((t) => t.name === "task_artifacts");
    assert.ok(artTool.skipPermission);
    assert.equal(session.config.tools.find((t) => t.name === "task_note"), undefined);
    const art = (args, sessionId = plain.sessionId) => artTool.handler(args, { sessionId });
    assert.equal(await art({ action: "append", content: "Picked option B." }), "Added to note.md.");
    assert.match(await art({ action: "read" }), /· appconfig\n\nPicked option B\./);
    assert.equal(await art({ action: "write", name: "design.md", content: "# Design\n\nOption B." }), "Saved design.md.");
    assert.match(await art({ action: "list" }), /^note\.md · .+\ndesign\.md · .+\nFolder: .+artifacts$/);
    assert.equal(await art({ action: "read", name: "design.md" }), "# Design\n\nOption B.");
    assert.equal(await art({ action: "write", name: "note.md", content: "wipe" }), "note.md is shared: add to it with append instead of replacing it.");
    assert.equal(await art({ action: "write", name: "Recap.md", content: "x" }), "recap.md is written when the task ends.");
    assert.equal(await art({ action: "write", content: "x" }), "Name the artifact to write, like design.md.");
    assert.match(await art({ action: "write", name: "..\\evil.md", content: "x" }), /^Not done: Name it like/);
    assert.match(await art({ action: "read", name: "missing.md" }), /^Not done: There is no artifact named missing\.md/);
    assert.equal(await art({ action: "append" }), "Put the text to add in content.");
    assert.equal(await art({ action: "nope" }), "Use action list, read, append or write.");
    assert.match(await art({ action: "read" }, "not-a-worker"), /not one of the Workspace's workers/);

    // ---- the user's own notes: every worker reads them, and adds a to-do signed with its name ----
    assert.match(session.config.systemMessage.content, /read with user_notes/);
    const notesTool = session.config.tools.find((t) => t.name === "user_notes");
    assert.ok(notesTool.skipPermission);
    const userNotes = (args, sessionId = plain.sessionId) => notesTool.handler(args, { sessionId });
    const added = await userNotes({ action: "add_todo", text: "Ask about the rollout window" });
    assert.match(added, /^Added to-do \[\d+\]: Ask about the rollout window$/);
    assert.match(await userNotes({ action: "read" }), /Ask about the rollout window \(added by appconfig\)/, "signed by the worker, not by what it passed");
    const askId = Number(/\[(\d+)\]/.exec(added)[1]);
    assert.equal(await userNotes({ action: "set_due", id: askId, due: "2026-03-02" }), `[${askId}] is due 2026-03-02.`, "workers can date a to-do");
    assert.match(await userNotes({ action: "complete_todo", id: 1 }), /^Use action read, add_todo, set_due\.$/, "workers can't check off the user's to-dos");
    assert.match(await userNotes({ action: "append_note", text: "x" }), /^Use action read, add_todo, set_due\.$/, "…or edit the quick note");
    assert.match(await userNotes({ action: "read" }, "not-a-worker"), /not one of the Workspace's workers/);

    // ---- the task's validation chain: every worker can read it and propose one ----
    assert.match(session.config.systemMessage.content, /validation chain: Azure DevOps pipelines/);
    const validationTool = session.config.tools.find((t) => t.name === "task_validation");
    assert.ok(validationTool?.skipPermission, "the worker has task_validation");
    const validate = (args, sessionId = plain.sessionId) => validationTool.handler(args, { sessionId });
    assert.equal(await validate({ action: "status" }), "No validation chain yet.");
    assert.equal(await validate({ action: "run" }), "This task has no accepted validation chain yet. Propose one first.");
    assert.equal(await validate({ action: "nope" }), "Use action status, candidates, propose or run.");
    assert.match(await validate({ action: "status" }, "not-a-worker"), /not one of the Workspace's workers/);

    // ---- a PR the worker creates is linked to the task, whichever way it made it ----
    assert.match(session.config.systemMessage.content, /Pull requests you open for this task are linked to it on their own/);
    const linkTool = session.config.tools.find((t) => t.name === "task_link_pr");
    assert.ok(linkTool.skipPermission);
    const prUrl = (id) => `https://dev.azure.com/msazure/P/_git/R/pullrequest/${id}`;
    const linkedIds = async () => (await store.listTaskPrs(task.id)).map((p) => p.prId).sort();
    fakePrs.set(42, fakePr(42));
    session.emit("tool.execution_start", { toolCallId: "c1", toolName: "powershell", arguments: { command: "az repos pr create --title Fix" } });
    session.emit("tool.execution_complete", { toolCallId: "c1", success: true, result: { content: `Created ${prUrl(42)}` } });
    await until(async () => (await linkedIds()).includes(42), "the created PR linked");
    assert.equal((await store.listTaskPrs(task.id))[0].source, "created");
    fakePrs.set(43, fakePr(43));
    fakePrs.set(44, fakePr(44));
    session.emit("tool.execution_start", { toolCallId: "c2", toolName: "powershell", arguments: { command: "az repos pr create --title Fix" } });
    session.emit("tool.execution_complete", { toolCallId: "c2", success: false, result: { content: prUrl(43) } });
    session.emit("tool.execution_start", { toolCallId: "c3", toolName: "view", arguments: { path: "notes.md" } });
    session.emit("tool.execution_complete", { toolCallId: "c3", success: true, result: { content: prUrl(44) } });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(await linkedIds(), [42], "a failed create, or a PR link a worker only read, isn't linked");
    assert.equal(await linkTool.handler({ pr: prUrl(44) }, { sessionId: plain.sessionId }), "Linked PR 44 to the task.");
    assert.equal(await linkTool.handler({ pr: prUrl(44) }, { sessionId: plain.sessionId }), "PR 44 is already linked to the task.");
    assert.match(await linkTool.handler({ pr: "44" }, { sessionId: plain.sessionId }), /isn't an Azure DevOps git repository/);

    // ---- status lines: the worker's own, or one from its summary ----
    assert.match(session.config.systemMessage.content, /post one status line with task_status/);
    let statuses = await store.listStatuses({ taskId: task.id });
    assert.deepEqual(
        statuses.map((s) => [s.author, s.text, s.sessionId]),
        [["appconfig", "Did: Add tests", plain.sessionId]],
        "a turn that posted no status leaves its summary's first line",
    );
    const statusTool = session.config.tools.find((t) => t.name === "task_status");
    assert.ok(statusTool.skipPermission);
    assert.match(await statusTool.handler({ text: "x" }, { sessionId: "not-a-worker" }), /not one of the Workspace's workers/);
    assert.match(await statusTool.handler({ text: "  " }, { sessionId: plain.sessionId }), /^Status not posted: Write a short status line/);
    session.script = async (s) => {
        await statusTool.handler({ text: "Schema done; wiring the editor next" }, { sessionId: s.sessionId });
        return "I finished the schema.\nNext is the editor.";
    };
    await workers.messageWorker(plain.sessionId, "Do the schema");
    await until(async () => (await stateOf(plain.sessionId)) === "turnDone" && (await store.listStatuses({ taskId: task.id })).length === 2, "status from the tool");
    await new Promise((r) => setTimeout(r, 30));
    statuses = await store.listStatuses({ taskId: task.id });
    assert.deepEqual(
        statuses.map((s) => s.text),
        ["Schema done; wiring the editor next", "Did: Add tests"],
        "a turn that posted its own status gets no extra one",
    );
    session.script = null;

    // ---- a PR-comment review only reads, through the app's tools and MCP alike ----
    const commentsTool = session.config.tools.find((t) => t.name === "task_pr_comments");
    assert.ok(commentsTool?.skipPermission, "the worker has task_pr_comments");
    const buildsTool = session.config.tools.find((t) => t.name === "task_pr_builds");
    assert.ok(buildsTool?.skipPermission, "the worker has task_pr_builds");
    const linkedBefore = await linkedIds();
    const notesBefore = await userNotes({ action: "read" });
    const seen = {};
    const mcp = (toolName, args, readOnly = false) => ({ kind: "mcp", serverName: "ado", toolName, toolTitle: toolName, readOnly, args });
    session.script = async (s) => {
        const as = { sessionId: s.sessionId };
        seen.append = await art({ action: "append", content: "x" }, s.sessionId);
        seen.write = await art({ action: "write", name: "x.md", content: "x" }, s.sessionId);
        seen.noAction = await art({}, s.sessionId);
        seen.read = await art({ action: "read", name: "design.md" }, s.sessionId);
        seen.list = await art({ action: "list" }, s.sessionId);
        seen.todo = await userNotes({ action: "add_todo", text: "Sneaky" }, s.sessionId);
        seen.notes = await userNotes({ action: "read" }, s.sessionId);
        seen.status = await statusTool.handler({ text: "Reviewing" }, as);
        seen.link = await linkTool.handler({ pr: prUrl(43) }, as);
        seen.vstatus = await validate({ action: "status" }, s.sessionId);
        seen.vpropose = await validate({ action: "propose" }, s.sessionId);
        seen.vrun = await validate({ action: "run" }, s.sessionId);
        seen.check = await commentsTool.handler({ action: "check" }, as);
        seen.done = await commentsTool.handler({ action: "done" }, as);
        seen.buildCheck = await buildsTool.handler({ action: "check", prId: 7 }, as);
        seen.buildDone = await buildsTool.handler({ action: "done", prId: 7 }, as);
        seen.mcpUpdate = await s.ask(mcp("wit_work_item", { action: "update", id: 1 }));
        seen.mcpGet = await s.ask(mcp("wit_work_item", { action: "get", id: 1 }));
        seen.mcpWriteTool = await s.ask(mcp("repo_pull_request_thread_write", { action: "get" }));
        seen.mcpReadOnly = await s.ask(mcp("anything", { action: "update" }, true));
        seen.shell = await s.ask({ kind: "shell", intention: "Edit", fullCommandText: "echo x > a.txt" });
        return "Reviewed.";
    };
    const reviewStatusCount = (await store.listStatuses({ taskId: task.id })).length;
    assert.equal(await workers.auditTurn(plain.sessionId, "Review PR 7's comments", "Review PR 7"), "done");
    const refused = /^While reviewing PR feedback, only read; /;
    for (const key of ["append", "write", "noAction", "todo", "status", "link", "vpropose", "vrun", "check", "done", "buildCheck", "buildDone"]) {
        assert.match(String(seen[key]), refused, `${key} is refused during a review`);
    }
    assert.match(seen.append, /task_artifacts append can't run now/);
    assert.match(seen.status, /task_status can't run now/);
    assert.equal(seen.read, "# Design\n\nOption B.", "reading an artifact still works");
    assert.match(seen.list, /^note\.md · /);
    assert.equal(seen.notes, notesBefore);
    assert.equal(seen.vstatus, "No validation chain yet.");
    assert.equal(seen.mcpUpdate.kind, "reject", "an MCP tool told to update is refused");
    assert.deepEqual(seen.mcpGet, { kind: "approve-once" }, "…told to get, it runs");
    assert.equal(seen.mcpWriteTool.kind, "reject", "a write tool is refused whatever its action");
    assert.deepEqual(seen.mcpReadOnly, { kind: "approve-once" }, "a tool marked read-only runs");
    assert.equal(seen.shell.kind, "reject");
    assert.deepEqual(await linkedIds(), linkedBefore, "nothing was linked");
    assert.equal((await store.listStatuses({ taskId: task.id })).length, reviewStatusCount, "nothing was posted");
    assert.doesNotMatch(await art({ action: "list" }), /x\.md/, "nothing was written");
    // Once the review ends, the same tools work again.
    assert.equal(await art({ action: "append", content: "After the review." }), "Added to note.md.");
    session.script = null;

    // ---- an approval: Needs you, then allow ----
    const gate = deferred();
    session.script = async (s) => {
        gate.resolve(await s.ask({ kind: "shell", intention: "Run the tests", fullCommandText: "npm test" }));
        return "Tests pass.";
    };
    await workers.messageWorker(plain.sessionId, "Run the tests");
    await assert.rejects(workers.messageWorker(plain.sessionId, "more"), /still working/);
    const waiting = await until(() => workers.workerLiveState(plain.sessionId).requests[0], "a pending approval");
    assert.equal(waiting.kind, "permission");
    assert.equal(waiting.title, "Run the tests");
    assert.equal(waiting.detail, "npm test");
    await until(async () => (await stateOf(plain.sessionId)) === "needsInput", "needsInput");
    await assert.rejects(workers.messageWorker(plain.sessionId, "yes", waiting.id), /Allow or Deny/);
    await workers.decidePermission(plain.sessionId, waiting.id, "allow");
    assert.deepEqual(await gate.promise, { kind: "approve-once" });
    await until(async () => (await stateOf(plain.sessionId)) === "turnDone", "turnDone after approval");
    assert.equal((await store.getWorker(plain.sessionId)).summary, "Tests pass.");
    await assert.rejects(workers.decidePermission(plain.sessionId, waiting.id, "allow"), /no longer waiting/);

    // ---- deny, then "always" ----
    const denied = deferred();
    session.script = async (s) => {
        denied.resolve(await s.ask({ kind: "write", intention: "Edit the config", fileName: "app.json" }));
        return "Skipped the edit.";
    };
    await workers.messageWorker(plain.sessionId, "Edit config");
    let req = await until(() => workers.workerLiveState(plain.sessionId).requests[0], "write approval");
    assert.equal(req.detail, "app.json");
    await workers.decidePermission(plain.sessionId, req.id, "deny");
    assert.equal((await denied.promise).kind, "reject");
    await until(async () => (await stateOf(plain.sessionId)) === "turnDone", "turnDone after deny");

    const always = deferred();
    session.script = async (s) => {
        // MCP tools run without asking, writes included, and so do web pages: they don't wait under Needs you.
        const mcp = await s.ask({ kind: "mcp", serverName: "ado", toolName: "wit_update", toolTitle: "Update work item", args: { id: 1 } });
        const web = await s.ask({ kind: "url", url: "https://example.com", intention: "Read the docs" });
        const first = await s.ask({ kind: "write", fileName: "notes.md", intention: "Edit notes.md" });
        const second = await s.ask({ kind: "shell", fullCommandText: "git status" });
        always.resolve([mcp, web, first, second]);
        return "Updated.";
    };
    await workers.messageWorker(plain.sessionId, "Update the work item");
    req = await until(() => workers.workerLiveState(plain.sessionId).requests[0], "write approval");
    assert.equal(req.detail, "notes.md", "the first thing that waits is the edit, not the web page");
    assert.equal(workers.workerLiveState(plain.sessionId).requests.length, 1);
    await workers.decidePermission(plain.sessionId, req.id, "always");
    assert.deepEqual(
        await always.promise,
        [{ kind: "approve-once" }, { kind: "approve-once" }, { kind: "approve-once" }, { kind: "approve-once" }],
        "always covers later requests",
    );
    assert.equal((await store.getWorker(plain.sessionId)).autoApprove, true);
    await until(async () => (await stateOf(plain.sessionId)) === "turnDone", "turnDone after always");

    // ---- ask_user: answered from Today ----
    const { task: second } = await store.createTask({ title: "Canary test scope" });
    const answered = deferred();
    nextScript = async (s) => {
        answered.resolve(await s.question({ question: "Which regions?", choices: ["West US 2", "East US"] }));
        const free = await s.question({ question: "Anything else?" });
        return `Using ${free.answer}`;
    };
    const asker = await workers.startWorker({ taskId: second.id, cwd: repo, prompt: "Scope the canary" });
    assert.equal(asker.label, "appconfig-2");
    let q = await until(() => workers.workerLiveState(asker.sessionId).requests[0], "a question");
    assert.equal(q.kind, "question");
    assert.equal(q.title, "Which regions?");
    assert.deepEqual(q.choices, ["West US 2", "East US"]);
    assert.equal(q.allowFreeform, true);
    assert.equal(await stateOf(asker.sessionId), "needsInput");
    assert.equal(await workers.messageWorker(asker.sessionId, "East US", q.id), "answered");
    assert.deepEqual(await answered.promise, { answer: "East US", wasFreeform: false });
    q = await until(() => workers.workerLiveState(asker.sessionId).requests.find((r) => r.title === "Anything else?"), "second question");
    await workers.messageWorker(asker.sessionId, "Keep it small", q.id);
    await until(async () => (await stateOf(asker.sessionId)) === "turnDone", "asker turnDone");
    assert.equal((await store.getWorker(asker.sessionId)).summary, "Using Keep it small");
    await assert.rejects(workers.messageWorker(asker.sessionId, "late", q.id), /already answered/);

    // ---- stop: pending approvals are declined and the turn ends as stopped ----
    const aborting = deferred();
    created.at(-1).script = async (s) => {
        const aborted = new Promise((_, reject) => (s.onAbort = () => reject(new Error("aborted"))));
        aborted.catch(() => undefined);
        aborting.resolve(await s.ask({ kind: "shell", fullCommandText: "rm -rf build" }));
        await aborted;
        return "never";
    };
    await workers.messageWorker(asker.sessionId, "Clean the build");
    await until(() => workers.workerLiveState(asker.sessionId).requests[0], "shell approval before stop");
    await workers.stopWorker(asker.sessionId);
    assert.equal((await aborting.promise).kind, "reject", "stopping declines what was waiting");
    await until(async () => (await stateOf(asker.sessionId)) === "stopped", "stopped");
    assert.match((await store.getWorker(asker.sessionId)).summary, /Stopped by you/);
    assert.equal(workers.isWorkerBusy(asker.sessionId), false);

    // ---- idle sessions are released, a busy one is left alone ----
    const askerSession = created.find((s) => s.sessionId === asker.sessionId);
    const holdIdle = deferred();
    askerSession.script = async () => {
        await holdIdle.promise;
        return "Done holding.";
    };
    await workers.messageWorker(asker.sessionId, "Hold");
    await until(() => workers.isWorkerBusy(asker.sessionId), "asker busy");
    assert.deepEqual((await workers.sweepWorkers(Date.now() + 60_000)).released, [], "nothing has been idle long enough");
    const far = () => Date.now() + workers.WORKER_IDLE.releaseAfterMs + 1_000;
    let swept = await workers.sweepWorkers(far());
    assert.ok(swept.released.includes(plain.sessionId), "the idle worker's session is let go");
    assert.ok(!swept.released.includes(asker.sessionId), "a worker mid-turn keeps its session");
    assert.ok(session.disconnected >= 1);
    holdIdle.resolve();
    await until(async () => (await stateOf(asker.sessionId)) === "turnDone", "asker finished");
    askerSession.script = null;
    swept = await workers.sweepWorkers(far());
    assert.ok(swept.released.includes(asker.sessionId));
    assert.equal(workers.attachedWorkerCount(), 0);

    // ---- after a restart the session is resumed for the next message ----
    await workers.closeAllWorkers();
    assert.ok(created.every((s) => s.disconnected >= 1), "closing releases every session");
    await workers.messageWorker(plain.sessionId, "Continue");
    await until(async () => (await stateOf(plain.sessionId)) === "turnDone" && resumed.length === 1, "resumed turn");
    assert.equal(resumed[0].sessionId, plain.sessionId);
    assert.equal(resumed[0].config.workingDirectory, repo);
    assert.deepEqual(resumed[0].sent, ["Continue"]);

    // ---- Stop while the session is still resuming sends nothing ----
    await workers.closeAllWorkers();
    const slow = deferred();
    resumeGate = slow.promise;
    await workers.messageWorker(plain.sessionId, "Long job");
    assert.equal(workers.workerLiveState(plain.sessionId).activity, "Getting started", "until the session takes the prompt in, the chat says so");
    await workers.stopWorker(plain.sessionId);
    resumeGate = null;
    slow.resolve();
    await until(async () => (await stateOf(plain.sessionId)) === "stopped", "stopped before sending");
    assert.deepEqual(resumed.at(-1).sent, [], "a turn stopped during resume never reaches the model");

    // ---- a failed turn drops the session, so the next message resumes afresh ----
    const before = resumed.length;
    resumed.at(-1).script = async () => {
        throw new Error("connection closed");
    };
    await workers.messageWorker(plain.sessionId, "Try");
    await until(async () => (await stateOf(plain.sessionId)) === "error", "error state");
    assert.match((await store.getWorker(plain.sessionId)).summary, /connection closed/);
    await workers.messageWorker(plain.sessionId, "Try again");
    await until(async () => (await stateOf(plain.sessionId)) === "turnDone" && resumed.length === before + 1, "re-resumed after failure");
    assert.deepEqual(resumed.at(-1).sent, ["Try again"]);

    // ---- slash commands: the CLI's built-ins and the user's skills ----
    assert.equal(created[0].config.enableConfigDiscovery, undefined, "no full discovery: it would start the user's extensions");
    assert.ok(created[0].config.skillDirectories.includes(join(repo, ".github", "skills")), "the repo's skills load");
    const fakeHome = join(root, "home");
    const pluginOn = join(root, "plugins", "on");
    const pluginOff = join(root, "plugins", "off");
    for (const dir of [join(fakeHome, ".agents", "skills"), join(fakeHome, ".copilot"), join(pluginOn, "skills"), join(pluginOff, "skills")]) {
        mkdirSync(dir, { recursive: true });
    }
    writeFileSync(
        join(fakeHome, ".copilot", "config.json"),
        "// User settings belong in settings.json.\n// This file is managed automatically.\n" +
            JSON.stringify({ installedPlugins: [{ name: "on", enabled: true, cache_path: pluginOn }, { name: "off", enabled: false, cache_path: pluginOff }, { name: "bad" }] }),
    );
    assert.deepEqual(
        workers.workerSkillDirectories(repo, fakeHome),
        [join(repo, ".github", "skills"), join(fakeHome, ".agents", "skills"), join(pluginOn, "skills")],
        "repo first, then the user's own, then enabled plugins; folders that don't exist are skipped",
    );
    writeFileSync(join(fakeHome, ".copilot", "config.json"), "{ not json");
    assert.deepEqual(workers.workerSkillDirectories(repo, fakeHome), [join(repo, ".github", "skills"), join(fakeHome, ".agents", "skills")], "a broken CLI config only drops plugin skills");
    assert.deepEqual(workers.parseSlash("  /No-AI-Slop  fix this\nplease "), { name: "no-ai-slop", input: "fix this\nplease" });
    assert.equal(workers.parseSlash("no slash"), null);
    assert.equal(workers.parseSlash("/"), null);
    assert.equal(workers.stripAnsi("\u001b[1mBold\u001b[0m \u001b]8;;http://x\u0007link\u001b]8;;\u0007"), "Bold link");
    const live = resumed.at(-1);
    const commands = await workers.listWorkerCommands(plain.sessionId);
    assert.deepEqual(live.listOptions, { includeBuiltins: true, includeSkills: true, includeClientCommands: false });
    assert.deepEqual(
        commands.map((c) => c.name),
        ["blame", "compact", "mcp", "model", "research", "session", "usage", "no-ai-slop"],
        "built-ins first, then skills; folder, mode, schedule and extension commands are left out",
    );
    const modelCommand = commands.find((c) => c.name === "model");
    assert.equal(modelCommand.duringTurn, true, "a switch mid-turn waits for the turn, so /model runs any time");
    assert.match(modelCommand.description, /this worker's model/);
    assert.deepEqual(commands.find((c) => c.name === "mcp").choices, [{ name: "show", description: "Show" }]);
    assert.deepEqual(commands.find((c) => c.name === "session").aliases, ["s"]);
    assert.equal(commands.find((c) => c.name === "research").required, true);
    await workers.listWorkerCommands(plain.sessionId);
    assert.equal(live.lists, 1, "the list is read once per attached session");

    assert.deepEqual(await workers.runWorkerCommand(plain.sessionId, "/usage"), {
        kind: "note",
        text: "Session Usage\n\nRequests: 0",
        markdown: false,
        url: null,
    });
    assert.deepEqual(await workers.runWorkerCommand(plain.sessionId, "/compact"), { kind: "note", text: "Compacted.", markdown: false, url: null });
    assert.deepEqual(await workers.runWorkerCommand(plain.sessionId, "/mcp"), {
        kind: "choices",
        title: "MCP servers",
        command: "mcp",
        options: [{ name: "show", description: "Show servers", group: null }],
    });
    await assert.rejects(workers.runWorkerCommand(plain.sessionId, "hello"), /Type a command/);
    await assert.rejects(workers.runWorkerCommand(plain.sessionId, "/nope"), /Unknown command \/nope\. Type \/ to see/);
    await assert.rejects(workers.runWorkerCommand(plain.sessionId, "/cwd C:\\x"), /stays in its folder/);
    await assert.rejects(workers.runWorkerCommand(plain.sessionId, "/plan do it"), /Plan mode isn't available/);
    await assert.rejects(workers.runWorkerCommand(plain.sessionId, "/research"), /\/research needs topic/);
    const sentBefore = live.sent.length;
    assert.match((await workers.runWorkerCommand(plain.sessionId, "/blame")).text, /needs plan mode/);
    assert.equal(live.sent.length, sentBefore, "a prompt for another mode isn't sent");

    // A skill starts a turn shown as the command, not its expanded instructions.
    assert.deepEqual(await workers.runWorkerCommand(plain.sessionId, "/no-ai-slop tighten the intro"), {
        kind: "sent",
        display: "/no-ai-slop tighten the intro",
        notice: null,
    });
    await until(async () => live.sent.length === sentBefore + 1 && (await stateOf(plain.sessionId)) === "turnDone", "skill turn");
    assert.equal(live.sent.at(-1), "SKILL BODY tighten the intro");
    assert.equal(live.displayed.at(-1), "/no-ai-slop tighten the intro");
    assert.deepEqual(live.invoked.at(-1), ["no-ai-slop", "tighten the intro"]);
    assert.equal(live.displayed[0], null, "plain messages carry no display text");
    const researched = await workers.runWorkerCommand(plain.sessionId, "/research flaky tests");
    assert.deepEqual(researched, { kind: "sent", display: "/research flaky tests", notice: "Research can take a while" });
    await until(async () => live.sent.at(-1) === "RESEARCH flaky tests" && (await stateOf(plain.sessionId)) === "turnDone", "research turn");

    // /model is the app's: a list to pick from, then a switch that the worker keeps.
    const picker = await workers.runWorkerCommand(plain.sessionId, "/model");
    assert.equal(picker.kind, "choices");
    assert.equal(picker.command, "model");
    assert.deepEqual(picker.options.map((o) => [o.name, o.description]), [["claude-haiku-4.5", ""], ["claude-sonnet-5", "Current"], ["gpt-5-mini", ""]]);
    assert.deepEqual(await workers.runWorkerCommand(plain.sessionId, "/s"), picker, "aliases work; a model-picker dialog becomes the same list");
    assert.equal(live.invoked.filter(([n]) => n === "model").length, 0, "the CLI's /model never runs, so its saved default stays");
    assert.match((await workers.runWorkerCommand(plain.sessionId, "/model claude-haiku-4.5")).text, /now uses claude-haiku-4\.5/);
    assert.equal(live.current, "claude-haiku-4.5");
    assert.equal((await store.getWorker(plain.sessionId)).model, "claude-haiku-4.5", "a resumed session keeps the new model");
    await assert.rejects(workers.runWorkerCommand(plain.sessionId, "/model gpt-9"), /isn't available/);
    await assert.rejects(workers.runWorkerCommand(plain.sessionId, "/model bad model!"), /Unknown model|isn't available/);

    // ---- model and effort from the chat head ----
    await assert.rejects(workers.setWorkerModel(plain.sessionId, "claude-haiku-4.5", "high"), /claude-haiku-4\.5 doesn't take a reasoning effort/);
    await assert.rejects(workers.setWorkerModel(plain.sessionId, "", "high"), /Choose a model before its reasoning effort/);
    await assert.rejects(workers.setWorkerModel(plain.sessionId, "gpt-5-mini", "max"), /gpt-5-mini takes low, medium, high, not max/);
    await assert.rejects(workers.setWorkerModel(plain.sessionId, "gpt-9", ""), /isn't available/);
    assert.deepEqual(await workers.setWorkerModel(plain.sessionId, "claude-sonnet-5", "high"), {
        model: "claude-sonnet-5",
        effort: "high",
        currentModel: "claude-sonnet-5",
        currentEffort: "high",
        deferred: false,
    });
    assert.deepEqual(live.switches.at(-1), ["claude-sonnet-5", "high"]);
    let row = await store.getWorker(plain.sessionId);
    assert.deepEqual([row.model, row.effort], ["claude-sonnet-5", "high"]);
    assert.deepEqual(
        [workers.workerLiveState(plain.sessionId).currentModel, workers.workerLiveState(plain.sessionId).currentEffort],
        ["claude-sonnet-5", "high"],
        "the chat head shows what the session runs",
    );
    // /model keeps the effort when the new model takes it, and drops it when it doesn't.
    assert.match((await workers.runWorkerCommand(plain.sessionId, "/model gpt-5-mini")).text, /now uses gpt-5-mini \(high\)/);
    assert.equal((await store.getWorker(plain.sessionId)).effort, "high");
    assert.match((await workers.runWorkerCommand(plain.sessionId, "/model claude-haiku-4.5")).text, /now uses claude-haiku-4\.5\./);
    assert.equal((await store.getWorker(plain.sessionId)).effort, null);
    // A released session picks them up when it resumes.
    await workers.setWorkerModel(plain.sessionId, "claude-sonnet-5", "low");
    await workers.closeAllWorkers();
    await workers.messageWorker(plain.sessionId, "On the new effort");
    await until(async () => (await stateOf(plain.sessionId)) === "turnDone" && resumed.at(-1).sent.includes("On the new effort"), "resumed turn");
    assert.deepEqual([resumed.at(-1).config.model, resumed.at(-1).config.reasoningEffort], ["claude-sonnet-5", "low"]);
    // "Copilot default" drops the effort: the default model picks its own.
    await workers.setWorkerModel(plain.sessionId, "", "");
    row = await store.getWorker(plain.sessionId);
    assert.deepEqual([row.model, row.effort], [null, null]);
    const relive = resumed.at(-1);

    // Mid-turn, only commands the CLI allows during a turn run; a model switch waits for the turn.
    const holding = deferred();
    relive.script = async () => {
        await holding.promise;
        return "Held.";
    };
    await workers.messageWorker(plain.sessionId, "Hold on");
    await until(() => workers.isWorkerBusy(plain.sessionId), "busy");
    assert.equal((await workers.runWorkerCommand(plain.sessionId, "/usage")).kind, "note", "/usage runs mid-turn");
    await assert.rejects(workers.runWorkerCommand(plain.sessionId, "/no-ai-slop x"), /is working/);
    assert.match((await workers.runWorkerCommand(plain.sessionId, "/model gpt-5-mini")).text, /switches to gpt-5-mini when this turn ends/);
    assert.equal((await workers.setWorkerModel(plain.sessionId, "gpt-5-mini", "medium")).deferred, true);
    assert.deepEqual((await store.getWorker(plain.sessionId)).effort, "medium", "saved now, applied after the turn");
    holding.resolve();
    await until(async () => (await stateOf(plain.sessionId)) === "turnDone", "held turn done");
    relive.script = null;

    // A failed lookup surfaces as an error the chat can show.
    const listFails = workers.listWorkerCommands("00000000-0000-4000-8000-00000000dead");
    await assert.rejects(listFails, /Worker not found/);

    // ---- a terminal for a folder that is gone is refused, not crashed into ----
    const gone = join(root, "repos", "Gone");
    mkdirSync(gone, { recursive: true });
    const { task: third } = await store.createTask({ title: "Folder moves" });
    const mover = await workers.startWorker({ taskId: third.id, cwd: gone, prompt: "hi" });
    await until(async () => (await stateOf(mover.sessionId)) === "turnDone", "mover turn");
    rmSync(gone, { recursive: true, force: true });
    await assert.rejects(workers.openWorkerTerminal(mover.sessionId), /folder no longer exists/);
    assert.equal(created.at(-1).disconnected, 0, "a refused handoff keeps the session attached");
    await assert.rejects(workers.spawnResumeTerminal(mover.sessionId, gone, "x"), /Folder not found/);

    // ---- a done task: one of its workers writes recap.md ----
    workers.RECAP_LIMITS.pollMs = 10;
    const statusCount = (await store.listStatuses({ taskId: task.id })).length;
    const guard = [];
    relive.script = async (s) => {
        guard.push(await s.ask({ kind: "shell", fullCommandText: "git push" }));
        guard.push(await s.question({ question: "Should I push?" }));
        return "Here's the recap:\n\n# Recap: Parameter editor\n\n- Goal: an editor for block parameters.\n- Decision: option B, for the simpler schema.";
    };
    await store.updateTask(task.id, { status: "done" });
    await workers.recapIdle(task.id);
    const recap = await store.readArtifact(task.id, "recap.md");
    assert.match(
        recap.content,
        /^# Recap: Parameter editor\n\n_Task done .+ · recap by appconfig_\n\n- Goal: an editor for block parameters\.\n- Decision: option B, for the simpler schema\.\n$/,
        "the lead-in goes; a byline is added under the heading",
    );
    assert.equal(relive.displayed.at(-1), "Write the task's recap (recap.md).");
    assert.match(relive.sent.at(-1), /^The task "Parameter editor" is done\. Write its recap\./);
    assert.match(relive.sent.at(-1), /Status timeline over the task's life, oldest first:\n- .+ · appconfig: Did: Add tests\n- .+ · appconfig: Schema done; wiring the editor next\n/);
    // A long task: the first and latest updates, with the gap between them named.
    const many = Array.from({ length: 260 }, (_, i) => ({ id: 260 - i, at: new Date(2026, 9, 1, 9, 0, 260 - i).toISOString(), author: "w", text: `u${260 - i}` }));
    const long = workers.recapPrompt({ title: "Long task" }, "done", many);
    assert.match(long, /- .+ · w: u1\n/, "the very first update is in");
    assert.match(long, /- .+ · w: u50\n- \(60 updates in between left out\)\n- .+ · w: u111\n/);
    assert.match(long, /- .+ · w: u260$/, "and the latest");
    assert.equal(long.match(/· w: u\d+/g).length, 200);
    assert.equal(guard[0].kind, "reject", "a recap turn can't run commands");
    assert.match(guard[1].answer, /isn't here/, "or wait on a question");
    assert.equal(workers.workerLiveState(plain.sessionId).requests.length, 0, "nothing reached Needs you");
    assert.equal((await store.listStatuses({ taskId: task.id })).length, statusCount, "the recap posts no status");
    assert.equal((await store.getWorker(plain.sessionId)).summary, "Wrote the task's recap (recap.md).");
    assert.equal(workers.recapState(task.id), null);
    assert.match((await store.listEvents({ taskId: task.id, kinds: ["task.recap"] }))[0].text, /appconfig wrote the recap/);
    relive.script = null;

    // ---- a done task takes no more work ----
    await assert.rejects(workers.messageWorker(plain.sessionId, "More"), /Reopen the task/);
    await assert.rejects(workers.startWorker({ taskId: task.id, cwd: repo, prompt: "x" }), /Reopen the task/);

    // ---- marked done mid-turn: the recap waits for the turn to end ----
    const moverSession = created.find((s) => s.sessionId === mover.sessionId);
    const held = deferred();
    moverSession.script = async (s, prompt) => {
        if (prompt.startsWith("The task")) return "# Recap: Folder moves\n\nMoved the folders.";
        await held.promise;
        return "Moved.";
    };
    await workers.messageWorker(mover.sessionId, "Move them");
    await until(() => workers.isWorkerBusy(mover.sessionId), "mover busy");
    await store.updateTask(third.id, { status: "done" });
    await until(() => workers.recapState(third.id)?.state === "waiting", "recap waiting on the turn");
    assert.ok(!existsSync(join(store.artifactsDir(third.id), "recap.md")));
    held.resolve();
    await workers.recapIdle(third.id);
    assert.match((await store.readArtifact(third.id, "recap.md")).content, /^# Recap: Folder moves\n\n_Task done .+ · recap by gone_/);
    assert.deepEqual(moverSession.sent.slice(-2).map((p) => p.slice(0, 16)), ["Move them", 'The task "Folder']);

    // ---- reopened while it waits: no recap, the work isn't over ----
    const held2 = deferred();
    moverSession.script = async () => {
        await held2.promise;
        return "Again.";
    };
    await store.updateTask(third.id, { status: "open" });
    await workers.messageWorker(mover.sessionId, "One more");
    await until(() => workers.isWorkerBusy(mover.sessionId), "busy again");
    await store.updateTask(third.id, { status: "done" });
    await until(() => workers.recapState(third.id)?.state === "waiting", "waiting again");
    await store.updateTask(third.id, { status: "open" });
    held2.resolve();
    assert.equal(await workers.writeRecap(third.id, "done"), false, "a second call joins the running one");
    assert.equal(workers.recapState(third.id), null);
    assert.equal(moverSession.sent.at(-1), "One more");

    // ---- a recap that fails says why; Try again asks once more ----
    await until(async () => !workers.isWorkerBusy(mover.sessionId), "mover free");
    moverSession.script = async () => "  ";
    assert.equal(await workers.writeRecap(third.id, "requested"), false);
    assert.equal(workers.recapState(third.id).state, "failed");
    assert.equal(workers.recapState(third.id).by, "gone");
    assert.match(workers.recapState(third.id).error, /gone: its reply had no recap/);
    assert.match((await store.getWorker(mover.sessionId)).summary, /^Recap not written/);
    moverSession.script = async () => "```markdown\n- Folders moved to the new layout.\n```";
    assert.equal(await workers.writeRecap(third.id, "requested"), true);
    assert.match((await store.readArtifact(third.id, "recap.md")).content, /^# Recap: Folder moves\n\n_Written .+ · recap by gone_\n\n- Folders moved to the new layout\.\n$/);
    assert.equal(workers.recapState(third.id), null);
    moverSession.script = null;
    const { task: lonely } = await store.createTask({ title: "No workers" });
    assert.equal(await workers.writeRecap(lonely.id, "done"), false, "no workers, no recap");
    assert.equal(workers.recapState(lonely.id), null);
    await store.deleteTask(lonely.id);

    // ---- remove deletes the session and the row ----
    await workers.removeWorker(asker.sessionId);
    assert.deepEqual(removed, [asker.sessionId]);
    assert.equal(await store.getWorker(asker.sessionId), null);

    // ---- task delete discards its workers' sessions ----
    await workers.discardWorkerSessions(await store.deleteTask(task.id));
    assert.deepEqual(removed, [asker.sessionId, plain.sessionId]);
    await workers.discardWorkerSessions(await store.deleteTask(third.id));

    // ---- removing a task: it leaves Today, a worker writes the recap, then all but its Artifacts goes ----
    const { task: fourth } = await store.createTask({ title: "Retire the old API" });
    const retirer = await workers.startWorker({ taskId: fourth.id, cwd: repo, prompt: "Plan it" });
    await until(async () => (await stateOf(retirer.sessionId)) === "turnDone", "retirer turn");
    const retirerSession = created.find((s) => s.sessionId === retirer.sessionId);
    retirerSession.script = async (s, prompt) => {
        if (prompt.startsWith("The user is removing")) return "# Recap: Retire the old API\n\n- Kept v1 for one more release.";
        const aborted = new Promise((_, reject) => (s.onAbort = () => reject(new Error("aborted"))));
        aborted.catch(() => undefined);
        await aborted;
        return "never";
    };
    await workers.messageWorker(retirer.sessionId, "Long work");
    await until(() => workers.isWorkerBusy(retirer.sessionId), "retirer busy");
    assert.deepEqual(await workers.removeTask(fourth.id), { recap: true });
    assert.ok(!(await store.listTasks()).some((t) => t.id === fourth.id), "it leaves Today at once");
    await assert.rejects(workers.startWorker({ taskId: fourth.id, cwd: repo, prompt: "x" }), /being removed/);
    assert.deepEqual(await workers.removeTask(fourth.id), { recap: true }, "a second Remove joins the first");
    await workers.removalsIdle();
    assert.equal(await store.getTask(fourth.id), null);
    assert.ok(retirerSession.aborted >= 1, "its running turn was stopped first");
    assert.ok(removed.includes(retirer.sessionId), "its worker's Copilot session is deleted");
    assert.match(readFileSync(join(store.artifactsDir(fourth.id), "recap.md"), "utf8"), /^# Recap: Retire the old API\n\n_Task removed .+ · recap by appconfig/);
    assert.ok(existsSync(store.notePath(fourth.id)), "the Artifacts folder stays");
    assert.ok(existsSync(join(store.taskDir(fourth.id), "task.json")));

    // Marked done, then removed while the recap is being written: the recap still lands.
    const { task: fifth } = await store.createTask({ title: "Ship the editor" });
    const shipper = await workers.startWorker({ taskId: fifth.id, cwd: repo, prompt: "Ship it" });
    await until(async () => (await stateOf(shipper.sessionId)) === "turnDone", "shipper turn");
    const shipperSession = created.find((s) => s.sessionId === shipper.sessionId);
    const writing = deferred();
    shipperSession.script = async () => {
        await writing.promise;
        return "# Recap: Ship the editor\n\n- Shipped behind a flag.";
    };
    await store.updateTask(fifth.id, { status: "done" });
    await until(() => workers.recapState(fifth.id)?.state === "writing", "recap being written");
    await workers.removeTask(fifth.id);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(shipperSession.aborted, 0, "the worker writing the recap isn't stopped");
    writing.resolve();
    await workers.removalsIdle();
    assert.equal(await store.getTask(fifth.id), null);
    assert.match(readFileSync(join(store.artifactsDir(fifth.id), "recap.md"), "utf8"), /^# Recap: Ship the editor\n\n_Task done .+\n\n- Shipped behind a flag\.\n$/);

    const { task: empty } = await store.createTask({ title: "Nothing here" });
    assert.deepEqual(await workers.removeTask(empty.id), { recap: false });
    await workers.removalsIdle();
    assert.equal(await store.getTask(empty.id), null);
    assert.ok(!existsSync(join(store.artifactsDir(empty.id), "recap.md")));
    await assert.rejects(workers.removeTask(empty.id), /Task not found/);

    // A removal the app closed in the middle of finishes on the next start.
    const { task: half } = await store.createTask({ title: "Half removed" });
    await store.beginRemoval(half.id);
    workers.resumeRemovals();
    workers.resumeRemovals();
    await until(async () => !(await store.getTask(half.id)), "resumed removal");
    await workers.removalsIdle();

    // ---- a turn whose session.idle never arrives still ends, and Stop always ends one ----
    const { SETTLE } = await import("../copilot-runtime.mjs");
    const settleDefaults = { ...SETTLE };
    Object.assign(SETTLE, { checkMs: 20, checkTimeoutMs: 40, stopPollMs: 10, stopGraceMs: 300 });
    const { task: lostTask } = await store.createTask({ title: "Lost idle" });
    const seenActivity = [];
    nextLive = async (s) => {
        s.emit("tool.execution_start", { toolCallId: "ts1", toolName: "task_status", arguments: {} });
        seenActivity.push(workers.workerLiveState(s.sessionId).activity);
        s.emit("tool.execution_complete", { toolCallId: "ts1", success: true, result: { content: "ok" } });
        seenActivity.push(workers.workerLiveState(s.sessionId).activity);
        s.emit("assistant.message", { content: "Posted the status." });
        s.processing = false; // the turn is over, and its session.idle is lost
    };
    const lost = await workers.startWorker({ taskId: lostTask.id, cwd: repo, prompt: "Post a status" });
    const lostSession = created.at(-1);
    assert.ok(lostSession instanceof LiveFakeSession);
    await until(async () => (await stateOf(lost.sessionId)) === "turnDone", "a turn without session.idle ended");
    assert.equal((await store.getWorker(lost.sessionId)).summary, "Posted the status.");
    assert.deepEqual(seenActivity, ["task_status", ""], "“Using task_status…” lasts as long as the call");
    assert.equal(workers.workerLiveState(lost.sessionId).busy, false);
    assert.equal(lostSession.all.size, 0, "the turn's listener is gone");

    // the idle is lost and the user presses Stop before the watchdog notices: aborting an idle
    // session emits nothing, and the turn still ends at once
    SETTLE.checkMs = 60_000;
    lostSession.live = (s) => {
        s.emit("assistant.message", { content: "Done again." });
        s.processing = false;
    };
    await workers.messageWorker(lost.sessionId, "Again");
    await until(() => lostSession.sent.length === 2, "second turn sent");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(workers.workerLiveState(lost.sessionId).busy, true, "hung, as in the bug");
    let started = Date.now();
    await workers.stopWorker(lost.sessionId);
    await until(async () => (await stateOf(lost.sessionId)) === "stopped", "Stop released an idle session");
    assert.ok(Date.now() - started < SETTLE.stopGraceMs, "without waiting out the grace");
    assert.equal(workers.workerLiveState(lost.sessionId).busy, false);
    SETTLE.checkMs = 20;

    // the runtime keeps processing and ignores the abort: Stop still ends the turn after a grace
    lostSession.live = (s) => s.emit("tool.execution_start", { toolCallId: "ts2", toolName: "powershell", arguments: {} });
    await workers.messageWorker(lost.sessionId, "Stuck job");
    await until(() => workers.workerLiveState(lost.sessionId).activity === "powershell", "busy on a tool");
    await new Promise((r) => setTimeout(r, SETTLE.checkMs * 4));
    assert.equal(workers.workerLiveState(lost.sessionId).busy, true, "a busy runtime is never cut short");
    started = Date.now();
    await workers.stopWorker(lost.sessionId);
    await until(async () => (await stateOf(lost.sessionId)) === "stopped", "Stop released a turn the runtime never ended", SETTLE.stopGraceMs + 2000);
    assert.ok(Date.now() - started >= SETTLE.stopGraceMs - 20);
    assert.ok(lostSession.aborted >= 1);
    assert.deepEqual(
        { busy: workers.workerLiveState(lost.sessionId).busy, activity: workers.workerLiveState(lost.sessionId).activity },
        { busy: false, activity: "" },
    );

    // and the worker takes the next message as usual
    lostSession.processing = false;
    lostSession.live = (s) => {
        s.emit("assistant.message", { content: "Back on track." });
        s.processing = false;
        s.emit("session.idle", {});
    };
    await workers.messageWorker(lost.sessionId, "Continue");
    await until(async () => (await stateOf(lost.sessionId)) === "turnDone", "next turn after a stop");
    assert.equal((await store.getWorker(lost.sessionId)).summary, "Back on track.");
    Object.assign(SETTLE, settleDefaults);

    // ---- queue and steer while a worker works ----
    {
        const { task: qTask } = await store.createTask({ title: "Queue while working" });
        await assert.rejects(
            workers.startWorker({ taskId: qTask.id, cwd: repo, prompt: "x", model: "claude-haiku-4.5", effort: "high" }),
            /doesn't take a reasoning effort/,
        );
        const turns = [];
        let finish = null;
        nextLive = (s, prompt) => {
            turns.push(prompt);
            finish = () => {
                finish = null;
                s.emit("assistant.message", { content: `Did ${prompt}` });
                s.processing = false;
                s.emit("session.idle", {});
            };
        };
        const qw = await workers.startWorker({ taskId: qTask.id, cwd: repo, prompt: "Long job", model: "gpt-5-mini", effort: "low" });
        const qs = created.at(-1);
        assert.deepEqual([qs.config.model, qs.config.reasoningEffort], ["gpt-5-mini", "low"], "a worker starts on the chosen model and effort");
        qs.onAbort = () => (qs.processing = false);
        const view = () => workers.workerLiveState(qw.sessionId);
        await until(() => view().canSteer && finish, "long job live");
        assert.equal(view().activity, "", "the session took the prompt in: no longer getting started");

        await assert.rejects(workers.messageWorker(qw.sessionId, "no mode"), /still working/, "without a mode a busy worker still refuses");
        assert.equal(await workers.messageWorker(qw.sessionId, "Queued one", undefined, "queue"), "queued");
        await workers.messageWorker(qw.sessionId, "Queued two", undefined, "queue");
        await workers.messageWorker(qw.sessionId, "Drop me", undefined, "queue");
        assert.deepEqual(view().queue.map((m) => m.text), ["Queued one", "Queued two", "Drop me"]);
        await workers.removeQueuedMessage(qw.sessionId, view().queue[2].id);
        await assert.rejects(workers.removeQueuedMessage(qw.sessionId, "gone"), /already left the queue/);
        assert.equal(await workers.messageWorker(qw.sessionId, "Use the v2 API", undefined, "now"), "steered");
        assert.deepEqual(qs.steeredIn, ["Use the v2 API"], "steered into the running turn");
        assert.deepEqual(await workers.sendQueuedNow(qw.sessionId, view().queue[1].id), "steered");
        assert.deepEqual(qs.steeredIn, ["Use the v2 API", "Queued two"]);
        assert.deepEqual(view().steered.map((m) => m.text), ["Use the v2 API", "Queued two"], "the chat shows what went in mid-turn");
        assert.deepEqual(view().queue.map((m) => m.text), ["Queued one"]);

        // The turn as it happens: a reply streams under its id, a new id starts a new reply, and a
        // finished reply moves into the turn in the same step, so it never leaves the chat.
        const turnOf = async () => (await workers.workerTurnView(qw.sessionId)).turn.map((m) => [m.id, m.role, m.content]);
        qs.emit("assistant.message_delta", { deltaContent: "Reading ", messageId: "a1" });
        qs.emit("assistant.message_delta", { deltaContent: "the docs", messageId: "a1" });
        assert.deepEqual([view().partial, view().partialId], ["Reading the docs", "a1"]);
        qs.emit("assistant.message", { content: "Reading the docs.", messageId: "a1" }, "e1");
        assert.deepEqual([view().partial, view().partialId], ["", ""]);
        assert.deepEqual(await turnOf(), [["u-1", "user", "Long job"], ["a1", "assistant", "Reading the docs."]]);
        qs.emit("assistant.message_delta", { deltaContent: "Half a reply", messageId: "a2" });
        qs.emit("assistant.message_delta", { deltaContent: "Another", messageId: "a3" });
        assert.equal(view().partial, "Another", "a new message id is a new reply, not more of the last");
        // A sub-agent's chatter stays out of the turn.
        qs.emit("assistant.message", { content: "inner", messageId: "x", parentToolCallId: "t1" }, "e-x");
        // The runtime takes the steered messages in at its next step: they join the turn where it
        // read them and leave "sent mid-turn".
        qs.takeIn();
        assert.deepEqual(view().steered, [], "taken in, so no longer shown as sent mid-turn");
        assert.deepEqual((await turnOf()).slice(2), [
            ["st-1-0", "user", "Use the v2 API"],
            ["st-1-1", "user", "Queued two"],
        ]);
        const live = await workers.workerTurnView(qw.sessionId);
        assert.deepEqual([live.busy, live.state, typeof live.updatedAt], [true, "working", "string"], "the live view carries the saved state too");

        // The turn ends; the queue runs as the next turn, and what was steered is part of the last one.
        finish();
        await until(() => turns.includes("Queued one") && finish, "the queued message ran");
        assert.deepEqual(turns, ["Long job", "Queued one"]);
        assert.deepEqual([view().queue.length, view().steered.length], [0, 0]);
        assert.deepEqual(await turnOf(), [["u-2", "user", "Queued one"]], "a new turn starts its own list");

        // Waiting on the user: Send now waits for the answer; queueing still works.
        const answer = qs.question({ question: "Which region?" });
        await until(() => view().requests.length, "a question");
        assert.equal(view().canSteer, false);
        await assert.rejects(workers.messageWorker(qw.sessionId, "Now?", undefined, "now"), /waiting on you\. Answer above, or queue the message/);
        assert.equal(await workers.messageWorker(qw.sessionId, "After the answer", undefined, "queue"), "queued");
        await workers.messageWorker(qw.sessionId, "West US", view().requests[0].id);
        assert.equal((await answer).answer, "West US");
        finish();
        await until(() => turns.at(-1) === "After the answer" && finish, "queued after a question");

        // Stop: the turn ends and the queue waits for the user's next message.
        await workers.messageWorker(qw.sessionId, "After the stop", undefined, "queue");
        await workers.stopWorker(qw.sessionId);
        await until(async () => (await stateOf(qw.sessionId)) === "stopped", "stopped");
        assert.equal(view().queueHeld, true);
        await new Promise((r) => setTimeout(r, 40));
        assert.equal(turns.at(-1), "After the answer", "a held queue doesn't start on its own");
        await workers.messageWorker(qw.sessionId, "Carry on");
        await until(() => turns.at(-1) === "Carry on" && finish, "carry on");
        assert.equal(view().queueHeld, false, "a turn the user starts releases the queue");
        finish();
        await until(() => turns.at(-1) === "After the stop" && finish, "the held message ran after it");

        // Sending a queued message on an idle worker starts it.
        await workers.messageWorker(qw.sessionId, "Parked", undefined, "queue");
        await workers.stopWorker(qw.sessionId);
        await until(async () => (await stateOf(qw.sessionId)) === "stopped", "stopped again");
        assert.equal(await workers.sendQueuedNow(qw.sessionId, view().queue[0].id), "sent");
        await until(() => turns.at(-1) === "Parked" && finish, "parked ran");
        // What was sent mid-turn shows until that turn ends, even with nothing queued after it.
        await until(() => view().canSteer, "parked live");
        assert.equal(await workers.messageWorker(qw.sessionId, "One more thing", undefined, "now"), "steered");
        assert.equal(view().steered.length, 1);
        finish();
        await until(() => !view().busy, "parked done");
        assert.deepEqual(view().steered, [], "cleared with the turn");
        assert.deepEqual(
            (await workers.workerTurnView(qw.sessionId)).turn.map((m) => m.content),
            ["Parked", "Did Parked"],
            "the ended turn stays readable until the next one, so the chat bridges to the transcript"
        );

        // Removing the worker drops its queue.
        await workers.messageWorker(qw.sessionId, "Busy again");
        await until(() => view().canSteer, "busy again");
        await workers.messageWorker(qw.sessionId, "Never runs", undefined, "queue");
        await workers.removeWorker(qw.sessionId);
        assert.deepEqual(view().queue, []);
        assert.ok(!turns.includes("Never runs"));
    }

    // ---- images: pasted ones go with the message as files, in turns, steered and queued ----
    {
        const { task: iTask } = await store.createTask({ title: "Images" });
        const png = (seed) => {
            const bytes = Buffer.alloc(64, seed);
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
            return bytes.toString("base64");
        };
        const a = await images.saveImage({ data: png(7), name: "error.png" });
        const b = await images.saveImage({ data: png(8), name: "after.png" });
        const file = (img, name) => ({ type: "file", path: images.imagePath(img.id), displayName: name });
        const turns = [];
        let finish = null;
        nextLive = (s, prompt) => {
            turns.push(prompt);
            finish = () => {
                finish = null;
                s.emit("assistant.message", { content: `Did ${prompt}` });
                s.processing = false;
                s.emit("session.idle", {});
            };
        };
        const iw = await workers.startWorker({ taskId: iTask.id, cwd: repo, prompt: "Start" });
        const is = created.at(-1);
        is.onAbort = () => (is.processing = false);
        const view = () => workers.workerLiveState(iw.sessionId);
        await until(() => view().canSteer && finish, "image worker live");

        // Sent mid-turn with only an image: the session gets a line pointing at it, the chat just the image.
        assert.equal(await workers.messageWorker(iw.sessionId, "", undefined, "now", [{ id: a.id, name: "error.png" }]), "steered");
        assert.deepEqual(is.attached.at(-1), [file(a, "error.png")]);
        assert.equal(is.steeredIn.at(-1), "Take a look at the attached image.");
        assert.deepEqual(view().steered.map((m) => [m.text, m.images.map((i) => i.id)]), [["", [a.id]]]);
        is.takeIn();
        assert.deepEqual(view().steered, [], "an image-only message leaves 'sent mid-turn' once taken in");
        const last = (await workers.workerTurnView(iw.sessionId)).turn.at(-1);
        assert.deepEqual([last.content, last.images], ["", [{ id: a.id, name: "error.png" }]], "the turn shows it as the image");

        // Queued with an image: it runs after the turn, with the image.
        assert.equal(await workers.messageWorker(iw.sessionId, "Compare with this", undefined, "queue", [{ id: b.id, name: "after.png" }]), "queued");
        assert.deepEqual(view().queue.map((m) => [m.text, m.images.map((i) => i.id)]), [["Compare with this", [b.id]]]);
        finish();
        await until(() => turns.at(-1) === "Compare with this" && finish, "the queued image ran");
        assert.deepEqual(is.attached.at(-1), [file(b, "after.png")]);
        finish();
        await until(() => !view().busy, "image worker idle");

        // A new turn of images only.
        await workers.messageWorker(iw.sessionId, undefined, undefined, undefined, [{ id: a.id, name: "error.png" }, { id: b.id, name: "after.png" }]);
        await until(() => turns.at(-1) === "Take a look at the attached images." && finish, "image-only turn");
        assert.deepEqual(is.attached.at(-1), [file(a, "error.png"), file(b, "after.png")]);

        // An answer is text only; the refused one leaves the question open.
        const answer = is.question({ question: "Which one?" });
        await until(() => view().requests.length, "a question");
        await assert.rejects(workers.messageWorker(iw.sessionId, "This", view().requests[0].id, undefined, [{ id: a.id, name: "x" }]), /An answer is text only/);
        await workers.messageWorker(iw.sessionId, "This", view().requests[0].id);
        assert.equal((await answer).answer, "This");
        finish();
        await until(() => !view().busy, "answered and done");
        await assert.rejects(workers.messageWorker(iw.sessionId, "x", undefined, undefined, [{ id: "nope.png", name: "x" }]), /isn't one the app saved/);
        await assert.rejects(workers.messageWorker(iw.sessionId, "", undefined, undefined, []), /Tell the worker/);
        await workers.removeWorker(iw.sessionId);
    }

    // ---- the history records what happened ----
    const kinds = new Set((await store.listEvents({ limit: 500 })).map((e) => e.kind));
    for (const kind of ["worker.started", "worker.turnDone", "worker.needsInput", "worker.permission", "worker.answered", "worker.stopped", "worker.removed", "task.recap", "task.removing"]) {
        assert.ok(kinds.has(kind), `history has ${kind}`);
    }

    // ---- approval wording ----
    assert.deepEqual(workers.describePermission({ kind: "url", intention: "Read docs", url: "https://x" }), {
        title: "Read docs",
        detail: "https://x",
    });

    console.log("jarvis-workers harness: ok");
} finally {
    await workers.closeAllWorkers().catch(() => undefined);
    closeDb();
    rmSync(root, { recursive: true, force: true });
}
