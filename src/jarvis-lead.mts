// The Lead (Devis): one persistent Copilot session that oversees the Today dashboard
// and its history. It reads the dashboard through its own tools, can create and
// close tasks and direct workers when asked, but never approves a worker's
// permission request; that stays with the user.

import { mkdirSync } from "node:fs";
import { defineTool, type CopilotSession, type PermissionRequest, type ResumeSessionConfig, type Tool } from "@github/copilot-sdk";
import { CLIENT_NAME, sendAndSettle, TurnStoppedError, WEB_BRIEF, withCopilotClient } from "./copilot-runtime.mjs";
import type { WorkItem } from "./service-files.mjs";
import { runNotesAction } from "./jarvis-notes.mjs";
import { readConfig } from "./config.mjs";
import { effortProblem, getModelCatalog, sessionModelState, switchSessionModel, type ModelChoice, type ModelState } from "./models.mjs";
import { MessageQueue, sendMode, steer, type QueuedMessage } from "./chat-queue.mjs";
import { imageAttachments, requestImages, type ChatImage } from "./chat-images.mjs";
import { promptFor } from "./chat-transcript.mjs";
import { chatMessagesFromEvents, type ChatMessage } from "./reviewer-session.mjs";
import {
    JarvisError,
    asJarvisId,
    clip,
    describeTask,
    getMeta,
    getTask,
    jarvisDir,
    listEvents,
    listWriteups,
    setMeta,
    updateTask,
} from "./jarvis-store.mjs";
import { postStatus } from "./jarvis-status.mjs";
import { overviewState } from "./jarvis-overview.mjs";
import { createTaskFromInput, reviewQueue, reviewQueueAge, startOfToday, todaySnapshot, type TodayTask } from "./jarvis-today.mjs";
import { messageWorker, runArtifactAction, spawnResumeTerminal, startDevisTask, startWorker, stopWorker } from "./jarvis-workers.mjs";
import { leadValidationTool } from "./jarvis-validation-agent.mjs";
import { APP_NAME, FORMER_LEAD_NAME, LEAD_NAME } from "./brand.mjs";

const LEAD_KEY = "leadSessionId";
const MODEL_KEY = "leadModel";
const EFFORT_KEY = "leadEffort";
const TURN_TIMEOUT_MS = 30 * 60_000;
const MODEL_ID = /^[\w.:/-]{1,100}$/;

/** Where the Lead's session comes from. The harness swaps in a fake. */
export interface LeadRuntime {
    create(config: ResumeSessionConfig): Promise<CopilotSession>;
    resume(sessionId: string, config: ResumeSessionConfig): Promise<CopilotSession>;
    /** False only when the CLI confirms the session is gone. */
    exists(sessionId: string): Promise<boolean>;
    /** The models the user's Copilot can run, with their efforts. */
    catalog(): Promise<ModelChoice[]>;
}

const sdkRuntime: LeadRuntime = {
    create: (config) => withCopilotClient((client) => client.createSession(config)),
    resume: (sessionId, config) => withCopilotClient((client) => client.resumeSession(sessionId, config)),
    exists: (sessionId) => withCopilotClient((client) => client.getSessionMetadata(sessionId)).then((metadata) => !!metadata),
    catalog: getModelCatalog,
};

let runtime: LeadRuntime = sdkRuntime;

export function setLeadRuntime(next: LeadRuntime | null): void {
    runtime = next || sdkRuntime;
}

// ---- what the Lead can see and do ---------------------------------------------------

const json = (value: unknown): string => JSON.stringify(value, null, 1);

function taskView(task: TodayTask) {
    const latest = task.updates.latest;
    return {
        taskId: task.id,
        title: describeTask(task),
        status: task.status,
        latestUpdate: latest ? { text: latest.text, by: latest.author, at: latest.at } : null,
        updatesToday: task.updates.today.length,
        service: task.org && task.project ? `${task.org}/${task.project}` : null,
        description: task.description ? clip(task.description, 600) : undefined,
        folder: task.folder || undefined,
        workItemState: task.workItem?.state || null,
        parent: task.workItem?.parent ? `${task.workItem.parent.type} #${task.workItem.parent.id} ${task.workItem.parent.title}` : null,
        doneAt: task.doneAt,
        pullRequests: (task.prs || []).map((p) => ({
            pr: `#${p.prId}`,
            title: p.snapshot?.title ?? null,
            repo: p.snapshot?.repo ?? null,
            status: p.snapshot ? (p.snapshot.isDraft && p.snapshot.status === "active" ? "draft" : p.snapshot.status) : null,
            failingChecks: p.checks?.failing.length ? p.checks.failing : undefined,
            conflicts: p.snapshot?.mergeStatus === "conflicts" || undefined,
            url: p.snapshot?.url ?? null,
        })),
        validation: task.validation
            ? {
                  chain: task.validation.name,
                  pipelines: task.validation.blocks,
                  lastRun: task.validation.run
                      ? {
                            status: task.validation.run.status,
                            passed: `${task.validation.run.done} of ${task.validation.run.total}`,
                            running: task.validation.run.current || undefined,
                            failedAt: task.validation.run.failed || undefined,
                            startedAt: task.validation.run.startedAt,
                        }
                      : null,
                  proposalWaiting: task.validation.proposal ? `by ${task.validation.proposal.by}, ${task.validation.proposal.blocks} pipelines` : undefined,
              }
            : null,
        workers: task.workers.map((w) => ({
            workerSessionId: w.sessionId,
            label: w.label,
            folder: w.cwd,
            repositories: w.worktrees.length ? w.worktrees.map((t) => `${t.repo} (${t.branch})`) : undefined,
            state: w.busy && w.state !== "needsInput" ? "working" : w.state,
            doing: w.activity || null,
            latest: w.summary,
            waitingOnUser: w.requests.map((r) => ({ requestId: r.id, kind: r.kind, title: r.title, detail: r.detail || undefined })),
        })),
    };
}

async function todayForLead(): Promise<string> {
    const [snapshot, overview] = await Promise.all([todaySnapshot(), overviewState().catch(() => null)]);
    const age = reviewQueueAge();
    return json({
        now: new Date().toString(),
        overview: overview?.text ? { text: overview.text, writtenAt: overview.at, outOfDate: overview.stale } : null,
        tasks: snapshot.tasks.map(taskView),
        pullRequestsToReview:
            age === null
                ? "Not loaded yet: the Pull requests list has not been fetched since the app started."
                : reviewQueue().map((pr) => ({
                      pr: `#${pr.prId}`,
                      title: pr.title,
                      repo: pr.repo,
                      author: pr.author,
                      created: pr.created,
                      draft: pr.isDraft || undefined,
                      url: pr.url,
                  })),
        reviewedToday: snapshot.reviewed.map((e) => ({ at: e.at, what: e.text })),
    });
}

function tool<T>(name: string, description: string, properties: Record<string, unknown>, required: string[], handler: (args: T) => Promise<string>): Tool<T> {
    return defineTool<T>(name, {
        description,
        parameters: { type: "object", properties, required, additionalProperties: false },
        skipPermission: true,
        defer: "never",
        handler: async (args) => {
            try {
                return await handler((args || {}) as T);
            } catch (error) {
                return `Failed: ${(error as Error).message}`;
            }
        },
    });
}

const str = { type: "string" };

export function leadTools(): Tool<any>[] {
    return [
        tool(
            "devis_today",
            "The user's Workspace right now: open tasks with their workers (state, latest reply, anything waiting on the user), tasks done today, pull requests waiting for the user's review, and PRs reviewed today. Call this before answering anything about current work.",
            {},
            [],
            todayForLead,
        ),
        tool<{ days?: number; taskId?: string }>(
            "devis_history",
            "What happened before: status updates, task, worker and PR review events, newest first, and the day's overview write-ups. Use it for standups, recaps and 'what did I do' questions.",
            {
                days: { type: "number", description: "How many days back, counting today as 1. Default 1, max 30." },
                taskId: { ...str, description: "Only this task's events." },
            },
            [],
            async ({ days, taskId }) => {
                const span = Math.max(1, Math.min(Math.floor(Number(days) || 1), 30));
                const since = new Date(startOfToday());
                since.setDate(since.getDate() - (span - 1));
                const id = asJarvisId(taskId);
                const [events, writeups] = await Promise.all([
                    listEvents({ since: since.toISOString(), taskId: id, limit: 400 }),
                    id ? Promise.resolve([]) : listWriteups({ since: since.toISOString(), validOnly: true, limit: 40 }),
                ]);
                if (!events.length && !writeups.length) return "No events in that range.";
                const lines = events.map((e) => `${new Date(e.at).toLocaleString()} · ${e.kind} · ${e.text}`);
                if (writeups.length) {
                    lines.push("", "Overview write-ups (newest first):");
                    for (const w of writeups) lines.push(`${new Date(w.at).toLocaleString()} · ${w.text.replace(/\[\[|\]\]/g, "")}`);
                }
                return lines.join("\n");
            },
        ),
        tool<{ taskId: string; text: string }>(
            "devis_post_status",
            "Post a status line on a task: where it stands and what is next, under 160 characters. It shows on the task's card and in its timeline. Only when the user asks.",
            { taskId: str, text: { ...str, description: "One plain line, under 160 characters." } },
            ["taskId", "text"],
            async ({ taskId, text }) => {
                const { status, created } = await postStatus({ taskId, text, author: LEAD_NAME });
                return created ? `Posted: ${status.text}` : `Already posted: ${status.text}`;
            },
        ),
        tool<{ title?: string; workItem?: string; org?: string; description?: string }>(
            "devis_create_task",
            "Add a task to the user's Tasks board. Give `workItem` (a number or link) for an ADO work item, or `title` for a custom task, and a `description` of what it's for when the user gives one. With a task folder set in Settings, the task gets its own folder and a worker starts on it at once: it proposes the repositories, which the user confirms, and settles the goal with the user before it works.",
            {
                workItem: { ...str, description: "Work item number, #number, or URL." },
                title: { ...str, description: "Title for a custom task." },
                description: { ...str, description: "What the task is for. A work item's own description is used when left out." },
                org: { ...str, description: "ADO organization, when the work item is not a URL and several are configured." },
            },
            [],
            async (args) => {
                const cfg = await readConfig();
                const { task, created, worker, workerError } = await createTaskFromInput(args, cfg.organizations, { taskRoot: cfg.taskRoot });
                const lines = [`${created ? "Created" : "Already in Tasks"}: ${describeTask(task)} (taskId ${task.id})`];
                if (created && task.folder) lines.push(`Its folder: ${task.folder}`);
                if (worker) lines.push(`${worker.label} started setting it up (workerSessionId ${worker.sessionId}).`);
                if (workerError) lines.push(`Its worker didn't start: ${workerError}`);
                return lines.join("\n");
            },
        ),
        tool<{ taskId: string; status: "open" | "done" }>(
            "devis_set_task_status",
            "Mark a task done, or reopen it. Only do this when the user asks.",
            { taskId: str, status: { type: "string", enum: ["open", "done"] } },
            ["taskId", "status"],
            async ({ taskId, status }) => {
                const id = asJarvisId(taskId);
                if (!id) throw new JarvisError("Unknown taskId.");
                const task = await updateTask(id, { status: status === "done" ? "done" : "open" });
                return `${describeTask(task)} is now ${task.status}.`;
            },
        ),
        tool<{ taskId: string; action: "list" | "read" | "append"; name?: string; content?: string }>(
            "devis_task_artifacts",
            `A task's Artifacts: note.md (the note the user and the task's workers share), recap.md once the task is done, and other notes. action list names them, read returns one (note.md by default), append adds a dated entry signed ${LEAD_NAME} (note.md by default). Append only when the user asks.`,
            {
                taskId: str,
                action: { type: "string", enum: ["list", "read", "append"] },
                name: { ...str, description: "File name, like recap.md. Defaults to note.md." },
                content: { ...str, description: "Markdown to append." },
            },
            ["taskId", "action"],
            async ({ taskId, action, name, content }) => {
                const id = asJarvisId(taskId);
                if (!id || !(await getTask(id))) throw new JarvisError("Unknown taskId.");
                if (action !== "list" && action !== "read" && action !== "append") throw new JarvisError("Use action list, read or append.");
                return runArtifactAction(id, LEAD_NAME, { action, name, content });
            },
        ),
        tool<{ taskId: string; folder?: string; instructions?: string; model?: string }>(
            "devis_start_worker",
            "Start a Copilot worker on a task with its first instructions. On a task with its own folder the worker gets a folder there and sets up its repositories first, so `folder` is left out and the instructions are optional. On an older task without one, give the repository `folder` it runs in. Only when the user asks.",
            {
                taskId: str,
                folder: { ...str, description: "Full path of the folder the worker runs in; only for a task without its own folder." },
                instructions: str,
                model: { ...str, description: "Optional model id." },
            },
            ["taskId"],
            async (args) => {
                const worker = await startWorker({ taskId: args.taskId, cwd: args.folder, prompt: args.instructions, model: args.model });
                return `Started ${worker.label} in ${worker.cwd} (workerSessionId ${worker.sessionId}).`;
            },
        ),
        tool<{ workerSessionId: string; text: string; requestId?: string }>(
            "devis_message_worker",
            "Send a worker a new instruction, or answer its open question by passing that question's requestId. You cannot answer permission requests; the user approves those under Needs you.",
            { workerSessionId: str, text: str, requestId: { ...str, description: "The open question this answers." } },
            ["workerSessionId", "text"],
            async ({ workerSessionId, text, requestId }) =>
                (await messageWorker(workerSessionId, text, requestId)) === "answered" ? "Answered." : "Sent.",
        ),
        tool<{ workerSessionId: string }>(
            "devis_stop_worker",
            "Stop a worker's current turn.",
            { workerSessionId: str },
            ["workerSessionId"],
            async ({ workerSessionId }) => {
                await stopWorker(workerSessionId);
                return "Stopped.";
            },
        ),
        tool<{ action: string; text?: string; id?: number }>(
            "devis_notes",
            `The user's own notes in the Workspace, kept across days: a to-do list and a quick note. action read: the open to-dos with their ids, recently done ones, and the quick note. add_todo: add \`text\` as a to-do. complete_todo: check off to-do \`id\`. append_note: add \`text\` to the end of the quick note, dated and signed ${LEAD_NAME}. Change them only when the user asks.`,
            {
                action: { type: "string", enum: ["read", "add_todo", "complete_todo", "append_note"] },
                text: { ...str, description: "The to-do, or the text to add to the quick note." },
                id: { type: "number", description: "The to-do to check off, from read." },
            },
            ["action"],
            async (args) => runNotesAction(LEAD_NAME, args, LEAD_NOTE_ACTIONS),
        ),
        tool<{ title: string; description: string }>(
            "devis_change_self",
            `Start a change to ${APP_NAME} itself: a new task whose worker gets a worktree of ${APP_NAME}' source, makes the change on its own branch, and asks the user to review it before anything ships. Shipping merges it, deploys it and checks it came up. Only when the user clearly asks to change ${APP_NAME} (this app, you, the Workspace) itself.`,
            {
                title: { ...str, description: "Short title for the change." },
                description: { ...str, description: "What to change and why, with everything the user said about it." },
            },
            ["title", "description"],
            async ({ title, description }) => {
                const { task, worker, workerError } = await startDevisTask({ title, description });
                const lines = [`Created: ${describeTask(task)} (taskId ${task.id})`];
                if (worker) lines.push(`${worker.label} started on it (workerSessionId ${worker.sessionId}). It confirms the goal with the user before it changes anything.`);
                if (workerError) lines.push(`Its worker didn't start: ${workerError}`);
                return lines.join("\n");
            },
        ),
        leadValidationTool(),
    ];
}

const LEAD_NOTE_ACTIONS: ReadonlySet<string> = new Set(["read", "add_todo", "complete_todo", "append_note"]);

const LEAD_BRIEF = [
    `You are ${LEAD_NAME}, the user's lead agent in the ${APP_NAME} app.`,
    `You used to be called ${FORMER_LEAD_NAME}, and your tools were named jarvis_*; they are devis_* now. Earlier messages may use the old names.`,
    "Your main job is overseeing the user's Workspace and keeping track of its history: the tasks (ADO work items or custom tasks) on the Tasks board, the Copilot workers each task hosts, and the pull requests waiting for the user's review. The Workspace's Today pane shows Today so far, Needs you (what workers wait on), and the user's own to-dos and quick note.",
    "Always read the current state with devis_today, and the past with devis_history, before you answer. Do not rely on memory for state; it changes.",
    "Each task carries short status updates (latestUpdate in devis_today, task.status lines in devis_history). They are the best record of progress; use them for standups and recaps. devis_today also has the dashboard's current overview and each task's pull requests. A finished task's recap.md (devis_task_artifacts) sums up its design and decisions.",
    "Lead with what needs the user: workers waiting on them, failed workers, and PRs to review. Then what is running, then what is done.",
    "You may create tasks, mark them done, post status updates, add to a task's note.md, and start, message or stop workers, but only when the user asks. Permission requests from workers are the user's to approve under Needs you in the Workspace; point them there.",
    "The user also keeps their own to-do list and quick note, kept across days. Read them with devis_notes when the user asks about their notes or to-dos, or what to work on; add, check off or append only when they ask.",
    "A task can have a validation chain: Azure DevOps pipelines run in order to prove its change. devis_today shows each task's validation; devis_task_validation reads it, finds candidates and proposes a chain when the user asks. The user accepts and runs it from the task.",
    `When the user clearly asks to change ${APP_NAME} itself (a feature, a fix or a tweak to this app, the Workspace or you), start it with devis_change_self, passing on everything they said. Follow up through devis_message_worker. The worker asks the user to review the change before it ships, and only the user ships it. Never change ${APP_NAME}' source or deploy it yourself.`,
    "You also have the user's MCP servers (Agency's ADO, Bluebird, WorkIQ, mail, calendar, Teams, Kusto, IcM and the rest) for anything outside the Workspace. Anything that changes something outside the app, like sending mail or updating a work item, only when the user asks.",
    WEB_BRIEF,
    "Answer briefly, in plain Markdown that reads well in a terminal: short lines, simple lists, ids in backticks.",
].join("\n");

// Reads, the app's tools, MCP tools and web pages (web_fetch) run without asking; shell commands and edits are a worker's job.
const leadPermission = (request: PermissionRequest) =>
    request.kind === "read" || request.kind === "custom-tool" || request.kind === "mcp" || request.kind === "url"
        ? { kind: "approve-once" as const }
        : { kind: "reject" as const, feedback: `${LEAD_NAME} uses its devis_* tools, MCP tools and the web only. Ask the user, or direct a worker.` };

function leadConfig(model: string, effort: string): ResumeSessionConfig {
    const cwd = jarvisDir();
    mkdirSync(cwd, { recursive: true });
    return {
        clientName: CLIENT_NAME,
        workingDirectory: cwd,
        model: model || undefined,
        // An effort is only ever saved with the model it belongs to.
        ...(model && effort ? { reasoningEffort: effort as ResumeSessionConfig["reasoningEffort"] } : {}),
        streaming: true,
        skipCustomInstructions: true,
        tools: leadTools(),
        systemMessage: { mode: "append", content: LEAD_BRIEF },
        onPermissionRequest: leadPermission,
    };
}

/** The model the user chose for the Lead, or "" for the Copilot default. */
async function savedModel(): Promise<string> {
    const value = (await getMeta(MODEL_KEY)) || "";
    return MODEL_ID.test(value) ? value : "";
}

/** The reasoning effort chosen with that model, or "" for the model's own default. */
async function savedEffort(): Promise<string> {
    return (await savedModel()) ? (await getMeta(EFFORT_KEY)) || "" : "";
}

/** The model the session is running now, or null when it can't be read. */
async function currentModel(session: CopilotSession): Promise<ModelState> {
    return sessionModelState(session);
}

// ---- the session --------------------------------------------------------------------

interface LeadState {
    session: Promise<CopilotSession> | null;
    sessionId: string | null;
    busy: boolean;
    /** The turn's message has gone to the session, so a message can be steered into it. */
    live: boolean;
    stopping: boolean;
    /** The last turn was stopped by the user. */
    stopped: boolean;
    stopTurn: AbortController | null;
    partial: string;
    activity: string;
    error: string | null;
    /** What the user sent while a turn ran. */
    queue: MessageQueue;
    off: Array<() => void>;
    /** Bumps when a message lands, so the chat is read from the session only when it changed. */
    version: number;
    cache: { version: number; at: number; session: CopilotSession; messages: ChatMessage[]; model: ModelState } | null;
    /** Bumps on every release: a resume that started before it lets its session go instead of taking over. */
    generation: number;
}

const lead: LeadState = {
    session: null,
    sessionId: null,
    busy: false,
    live: false,
    stopping: false,
    stopped: false,
    stopTurn: null,
    partial: "",
    activity: "",
    error: null,
    queue: new MessageQueue(),
    off: [],
    version: 0,
    cache: null,
    generation: 0,
};

/** The Lead's reply in flight, for the background service's idle check. */
export function leadActivity(): WorkItem[] {
    return lead.busy ? [{ kind: "lead", label: `${LEAD_NAME}'s reply` }] : [];
}

/** The page shows the latest messages; older ones stay in the session. */
export const LEAD_MESSAGES_SHOWN = 200;
/** Even with no event seen, the cached chat is read again after this. */
const LEAD_CACHE_MS = 30_000;

function wire(session: CopilotSession): void {
    for (const off of lead.off) off();
    lead.off = [
        session.on("assistant.message_delta", (event) => {
            if (!event.data.parentToolCallId) lead.partial += event.data.deltaContent;
        }),
        session.on("assistant.message", (event) => {
            if (!event.data.parentToolCallId) lead.partial = "";
            lead.version++;
        }),
        session.on("user.message", () => {
            lead.version++;
        }),
        session.on("tool.execution_start", (event) => {
            if (!event.data.parentToolCallId) {
                lead.activity = event.data.toolName;
                activityCall = event.data.toolCallId;
            }
        }),
        session.on("tool.execution_complete", (event) => {
            if (event.data.toolCallId === activityCall) {
                lead.activity = "";
                activityCall = null;
            }
        }),
    ];
}

/** The tool call lead.activity names, so it clears when that call ends. */
let activityCall: string | null = null;

/** The Lead's session, resumed or created. `create` is false for reads, so opening the tab costs nothing. */
async function acquire(create: boolean): Promise<CopilotSession | null> {
    try {
        return await acquireOnce(create);
    } catch (error) {
        // A resume overtaken by a release (New session, close) is retried against what's saved now.
        if (error instanceof LeadReleased) return acquireOnce(create);
        throw error;
    }
}

class LeadReleased extends JarvisError {
    constructor() {
        super("The Lead was released while its session was resuming.", 409);
    }
}

async function acquireOnce(create: boolean): Promise<CopilotSession | null> {
    if (lead.session) return lead.session;
    const saved = asJarvisId(await getMeta(LEAD_KEY));
    // Another read may have started the resume while the id was read; never resume twice.
    if (lead.session) return lead.session;
    if (!saved && !create) return null;
    const generation = lead.generation;
    const pending: Promise<CopilotSession> = (async () => {
        const model = await savedModel();
        const effort = await savedEffort();
        let session: CopilotSession | null = null;
        if (saved) {
            try {
                session = await runtime.resume(saved, leadConfig(model, effort));
            } catch (error) {
                // Only a session the CLI confirms is gone gets replaced; anything
                // else (CLI down, auth, timeout) keeps the saved conversation.
                if (await runtime.exists(saved).catch(() => true)) throw error;
                console.warn(`[jarvis] lead session ${saved} is gone: ${(error as Error).message}`);
                await setMeta(LEAD_KEY, null);
            }
            // A resumed session keeps the model and effort it last ran; hold it to the chosen ones.
            if (session && model) {
                const now = await currentModel(session);
                if (now.model !== model || (now.effort || "") !== effort) {
                    await switchSessionModel(session, model, effort).catch((error: Error) =>
                        console.warn(`[jarvis] lead could not switch to ${model}${effort ? ` (${effort})` : ""}: ${error.message}`),
                    );
                }
            }
        }
        if (!session) {
            if (!create) throw new JarvisError("The Lead session is gone. Send a message to start a new one.", 410);
            session = await runtime.create(leadConfig(model, effort));
            if (lead.generation === generation) await setMeta(LEAD_KEY, session.sessionId);
        }
        // Released (started over, closed) while this resumed: let it go rather than bring it back.
        if (lead.generation !== generation) {
            await session.disconnect().catch(() => undefined);
            throw new LeadReleased();
        }
        lead.sessionId = session.sessionId;
        wire(session);
        // A resume that works again lifts the wait a failed one imposed on cold reads.
        warmFailedAt = 0;
        return session;
    })();
    lead.session = pending;
    pending.catch(() => {
        // Only forget the attempt that failed, never a newer one.
        if (lead.session === pending) lead.session = null;
    });
    return pending;
}

export interface LeadChat {
    sessionId: string | null;
    messages: ChatMessage[];
    pending: boolean;
    partial: string;
    activity: string;
    error: string | null;
    /** The last turn was stopped by the user. */
    stopped: boolean;
    /** The chosen model, or "" for the Copilot default. */
    model: string;
    /** The effort chosen with that model, or "" for its default. */
    effort: string;
    /** What the session is actually running, when there is one. */
    currentModel: string | null;
    currentEffort: string | null;
    /** Messages sent while a turn ran, waiting their turn. */
    queue: QueuedMessage[];
    /** A stop or failure holds the queue until the user sends again. */
    queueHeld: boolean;
    /** A message sent now goes into the running turn. */
    canSteer: boolean;
    /** The session is still resuming; these are the messages as last read. */
    resuming?: boolean;
}

/** What the chat shows of the turn in flight and the queue, whichever way the chat was read. */
function liveFields(): Pick<LeadChat, "pending" | "partial" | "activity" | "error" | "stopped" | "queue" | "queueHeld" | "canSteer"> {
    return {
        pending: lead.busy,
        partial: lead.partial,
        activity: lead.activity,
        error: lead.error,
        stopped: lead.stopped,
        ...lead.queue.view(),
        canSteer: lead.busy && lead.live && !lead.stopping,
    };
}

// ---- the chat as last read, for the seconds a resume takes --------------------------------

const SNAPSHOT_KEY = "leadChatSnapshot";
/** After a background resume fails, reads wait on the resume (and report its error) for this long. */
const WARM_RETRY_MS = 30_000;

interface LeadSnapshot {
    sessionId: string;
    messages: ChatMessage[];
    model: string | null;
    effort?: string | null;
}

let snapshotSig = "";
let warmFailedAt = 0;

async function saveSnapshot(sessionId: string, messages: ChatMessage[], model: ModelState): Promise<void> {
    const last = messages[messages.length - 1];
    const sig = JSON.stringify([sessionId, messages.length, last?.id, last?.content.length, model.model, model.effort]);
    if (sig === snapshotSig) return;
    snapshotSig = sig;
    const snapshot: LeadSnapshot = { sessionId, messages, model: model.model, effort: model.effort };
    await setMeta(SNAPSHOT_KEY, JSON.stringify(snapshot)).catch((error: Error) => {
        snapshotSig = "";
        console.warn(`[jarvis] could not keep the Lead chat: ${error.message}`);
    });
}

async function readSnapshot(sessionId: string): Promise<LeadSnapshot | null> {
    try {
        const snapshot = JSON.parse((await getMeta(SNAPSHOT_KEY)) || "null") as LeadSnapshot | null;
        return snapshot && snapshot.sessionId === sessionId && Array.isArray(snapshot.messages) ? snapshot : null;
    } catch {
        return null;
    }
}

export async function getLeadChat(): Promise<LeadChat> {
    // Resuming the session takes seconds after a launch. Show the chat as it was last read and resume
    // behind it; the page reads again until it's live. A resume that just failed is waited on instead.
    if (!lead.session && Date.now() - warmFailedAt > WARM_RETRY_MS) {
        const saved = asJarvisId(await getMeta(LEAD_KEY));
        const snapshot = saved ? await readSnapshot(saved) : null;
        if (snapshot && !lead.session) {
            void acquire(false).catch((error: Error) => {
                warmFailedAt = Date.now();
                console.warn(`[jarvis] lead session didn't resume: ${error.message}`);
            });
            return {
                sessionId: snapshot.sessionId,
                messages: snapshot.messages,
                ...liveFields(),
                model: await savedModel(),
                effort: await savedEffort(),
                currentModel: snapshot.model,
                currentEffort: snapshot.effort ?? null,
                resuming: true,
            };
        }
    }
    let session: CopilotSession | null = null;
    try {
        session = await acquire(false);
    } catch (error) {
        if (!(error instanceof JarvisError && error.status === 410)) throw error;
    }
    let messages: ChatMessage[] = [];
    let model: ModelState = { model: null, effort: null };
    if (session) {
        const cached = lead.cache;
        if (cached && cached.session === session && cached.version === lead.version && Date.now() - cached.at < LEAD_CACHE_MS) {
            messages = cached.messages;
            model = cached.model;
        } else {
            // Read at this version; a message landing mid-read bumps it, so the next poll reads again.
            const version = lead.version;
            try {
                messages = chatMessagesFromEvents((await session.getEvents()) as never).slice(-LEAD_MESSAGES_SHOWN);
            } catch (error) {
                // The runtime may have restarted under us; resume on the next read.
                if (!lead.busy) await release();
                throw error;
            }
            model = await currentModel(session);
            lead.cache = { version, at: Date.now(), session, messages, model };
            if (lead.sessionId) void saveSnapshot(lead.sessionId, messages, model);
        }
    }
    return {
        sessionId: lead.sessionId,
        messages,
        ...liveFields(),
        model: await savedModel(),
        effort: await savedEffort(),
        currentModel: model.model,
        currentEffort: model.effort,
    };
}

export interface LeadModelResult {
    model: string;
    effort: string;
    currentModel: string | null;
    currentEffort: string | null;
    /** The switch waits for the turn in flight to end. */
    deferred: boolean;
}

/**
 * Choose the Lead's model and reasoning effort; "" means the Copilot default (and the
 * model's own effort). A running session switches now, or once the turn in flight ends,
 * and keeps its conversation. Copilot only picks its default when a session starts, so
 * a "" model applies from the next new session.
 */
export async function setLeadModel(value: unknown, effortValue?: unknown): Promise<LeadModelResult> {
    const model = typeof value === "string" ? value.trim() : "";
    const effort = typeof effortValue === "string" ? effortValue.trim() : "";
    if (model && !MODEL_ID.test(model)) throw new JarvisError("Unknown model.");
    const catalog = await runtime.catalog().catch(() => null);
    if (model && catalog && !catalog.some((m) => m.id === model)) throw new JarvisError(`${model} isn't available to your Copilot.`);
    const problem = effortProblem(model, effort, catalog);
    if (problem) throw new JarvisError(problem);
    let session: CopilotSession | null = null;
    try {
        session = await acquire(false);
    } catch (error) {
        if (!(error instanceof JarvisError && error.status === 410)) throw error;
    }
    let deferred = false;
    if (session && model) {
        try {
            deferred = (await switchSessionModel(session, model, effort)).deferred;
        } catch (error) {
            throw new JarvisError(`Could not switch ${LEAD_NAME} to ${model}: ${(error as Error).message}`, 502);
        }
    }
    await setMeta(MODEL_KEY, model || null);
    await setMeta(EFFORT_KEY, effort || null);
    lead.version++;
    const now = session ? await currentModel(session) : { model: null, effort: null };
    return { model, effort, currentModel: now.model, currentEffort: now.effort, deferred };
}

/** What the user typed, checked. It may be empty when images go with it. */
function leadText(text: unknown, images: readonly ChatImage[]): string {
    const prompt = typeof text === "string" ? text.trim() : "";
    if (!prompt && !images.length) throw new JarvisError("Type a message.");
    if (prompt.length > 20_000) throw new JarvisError("The message is too long.");
    return prompt;
}

/**
 * Send the Lead a message; the reply streams into the chat state. While a turn runs, mode
 * "queue" keeps it for after the turn and "now" steers it into the turn; without a mode a
 * busy Lead refuses it.
 */
export async function sendLead(
    text: unknown,
    modeValue?: unknown,
    imagesValue?: unknown,
): Promise<{ result: "sent" | "queued" | "steered"; id?: string }> {
    const images = await requestImages(imagesValue);
    const typed = leadText(text, images);
    const mode = sendMode(modeValue);
    if (!lead.busy) {
        startLeadTurn(typed, images);
        return { result: "sent" };
    }
    if (!mode) throw new JarvisError(`${LEAD_NAME} is still answering.`, 409);
    if (mode === "now" && lead.live && !lead.stopping) {
        await steerLead(typed, images);
        return { result: "steered" };
    }
    // Still starting the turn (or stopping it): it runs after.
    const item = lead.queue.add(typed, images);
    lead.version++;
    return { result: "queued", id: item.id };
}

async function steerLead(text: string, images: readonly ChatImage[] = []): Promise<void> {
    const session = await lead.session?.catch(() => null);
    if (!session) throw new JarvisError(`${LEAD_NAME}'s session isn't ready. Queue the message instead.`, 409);
    try {
        await steer(session, promptFor(text, images), imageAttachments(images));
    } catch (error) {
        throw new JarvisError(`Couldn't send it now: ${(error as Error).message}`, 502);
    }
    lead.version++;
}

function startLeadTurn(text: string, images: readonly ChatImage[] = []): void {
    const prompt = promptFor(text, images);
    const attachments = imageAttachments(images);
    lead.busy = true;
    lead.live = false;
    lead.stopping = false;
    lead.stopped = false;
    lead.partial = "";
    lead.activity = "";
    lead.error = null;
    // A turn the user starts lets what's queued run after it.
    lead.queue.resume();
    const stopTurn = new AbortController();
    lead.stopTurn = stopTurn;
    lead.version++;
    void (async () => {
        let ended: "done" | "stopped" | "failed" = "done";
        try {
            const session = (await acquire(true))!;
            // Stop can land while the session is still resuming; nothing to abort yet.
            if (lead.stopping) throw new TurnStoppedError();
            lead.live = true;
            await sendAndSettle(session, attachments.length ? { prompt, attachments } : { prompt }, TURN_TIMEOUT_MS, {
                signal: stopTurn.signal,
                onMissedIdle: () => console.warn("[jarvis] the Lead's turn ended without session.idle; picked up from the runtime"),
            });
            if (lead.stopping) throw new TurnStoppedError();
        } catch (error) {
            const stopped = lead.stopping || error instanceof TurnStoppedError;
            ended = stopped ? "stopped" : "failed";
            if (stopped) lead.stopped = true;
            else lead.error = (error as Error).message || `${LEAD_NAME} did not reply.`;
            const session = await lead.session?.catch(() => null);
            await session?.abort().catch(() => undefined);
            // Drop the cached session (not the saved id) so the next message resumes it afresh.
            if (!stopped) await release();
        } finally {
            lead.busy = false;
            lead.live = false;
            lead.stopping = false;
            lead.partial = "";
            lead.activity = "";
            activityCall = null;
            if (lead.stopTurn === stopTurn) lead.stopTurn = null;
            // A finished turn always reads the chat again.
            lead.version++;
            if (ended !== "done") lead.queue.hold();
            const next = lead.queue.next();
            if (next) startLeadTurn(next.text, next.images);
        }
    })();
}

/** Stop the Lead's turn. What's queued stays, held until the user sends again. */
export async function stopLead(): Promise<void> {
    if (!lead.busy) return;
    lead.stopping = true;
    lead.version++;
    // The wait ends once the runtime lets go (or after a grace) even if no event says so.
    lead.stopTurn?.abort();
    const wait = (ms: number) => new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));
    const session = await Promise.race([lead.session?.catch(() => null) ?? null, wait(5_000)]);
    await Promise.race([session?.abort().catch(() => undefined), wait(5_000)]);
}

export function removeLeadQueued(id: unknown): void {
    if (!lead.queue.take(id)) throw new JarvisError("That message already left the queue.", 409);
    lead.version++;
}

/** Send a queued message now: into the running turn, or as a new turn when none runs. */
export async function sendLeadQueuedNow(id: unknown): Promise<{ result: "sent" | "steered" }> {
    const item = lead.queue.find(id);
    if (!item) throw new JarvisError("That message already left the queue.", 409);
    if (!lead.busy) {
        lead.queue.take(item.id);
        startLeadTurn(item.text, item.images);
        return { result: "sent" };
    }
    if (!lead.live || lead.stopping) throw new JarvisError(`${LEAD_NAME} is between turns. Try again in a moment.`, 409);
    lead.queue.take(item.id);
    try {
        await steerLead(item.text, item.images);
    } catch (error) {
        lead.queue.restore(item);
        throw error;
    }
    return { result: "steered" };
}

async function release(): Promise<void> {
    lead.generation++;
    const pending = lead.session;
    lead.session = null;
    lead.cache = null;
    for (const off of lead.off) off();
    lead.off = [];
    const session = await pending?.catch(() => null);
    await session?.disconnect().catch(() => undefined);
}

/** Start the Lead over in a new session. Its history of events stays. */
export async function resetLead(): Promise<void> {
    if (lead.busy) throw new JarvisError(`${LEAD_NAME} is still answering.`, 409);
    // Forget the old session first, so a read that lands meanwhile can't resume it again.
    await setMeta(LEAD_KEY, null);
    await setMeta(SNAPSHOT_KEY, null);
    snapshotSig = "";
    await release();
    lead.sessionId = null;
    lead.error = null;
    lead.stopped = false;
    lead.queue.clear();
}

/** Hand the Lead's session to an interactive `agency copilot --resume` terminal. */
export async function openLeadTerminal(): Promise<void> {
    if (lead.busy) throw new JarvisError(`${LEAD_NAME} is still answering. Try again when it finishes.`, 409);
    const id = asJarvisId(await getMeta(LEAD_KEY));
    if (!id) throw new JarvisError(`Send ${LEAD_NAME} a message first.`, 409);
    await release();
    const cwd = jarvisDir();
    mkdirSync(cwd, { recursive: true });
    await spawnResumeTerminal(id, cwd, `${LEAD_NAME} (Lead)`);
}

export async function closeLead(): Promise<void> {
    lead.queue.clear();
    if (lead.busy) {
        lead.stopping = true;
        lead.stopTurn?.abort();
        const session = await lead.session?.catch(() => null);
        await session?.abort().catch(() => undefined);
    }
    await release();
}
