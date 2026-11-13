// Jarvis workers: one Copilot session per worker, hosted by a task. A worker
// runs in a repository folder with the user's own Copilot setup, through Agency.
// Reads, the app's tools and MCP tools run freely; anything else (shell, edits,
// URLs) and every ask_user question waits under "Needs you" in the Workspace's
// Today pane.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import {
    defineTool,
    type CopilotSession,
    type PermissionRequest,
    type PermissionRequestResult,
    type ResumeSessionConfig,
    type SessionConfig,
    type Tool,
} from "@github/copilot-sdk";
import { CLIENT_NAME, replyText, resumeCommand, sendAndSettle, TurnStoppedError, WEB_BRIEF, withCopilotClient } from "./copilot-runtime.mjs";
import { sharedMcpServers } from "./shared-playwright.mjs";
import { effortProblem, carriedEffort, getModelCatalog, sessionModelState, switchSessionModel, type ModelChoice, type ModelState } from "./models.mjs";
import { MessageQueue, sendMode, steer, type QueuedMessage } from "./chat-queue.mjs";
import { imageAttachments, requestImages, type ChatImage } from "./chat-images.mjs";
import { promptFor, sameImages } from "./chat-transcript.mjs";
import { ChatTranscript, type ChatMessage, type EventLike } from "./chat-transcript.mjs";
import {
    JarvisError,
    NOTE_NAME,
    RECAP_NAME,
    appendArtifact,
    artifactsDir,
    asJarvisId,
    beginRemoval,
    clip,
    createTask,
    deleteTask,
    deleteWorker,
    describeTask,
    getTask,
    getWorker,
    insertWorker,
    isRemoving,
    listArtifacts,
    listStatuses,
    listTaskPrs,
    listWorkers,
    listWorktrees,
    insertWorktree,
    nextWorkerLabel,
    nextWorkerName,
    onTaskDone,
    pendingRemovals,
    readArtifact,
    recordEvent,
    updateWorker,
    writeArtifact,
    type JarvisTask,
    type JarvisWorker,
    type StatusUpdate,
    type TaskPr,
    type Worktree,
} from "./jarvis-store.mjs";
import { codebaseKey, readConfig } from "./config.mjs";
import {
    addWorktree,
    clonesInFlight,
    codebaseStatus,
    findRepo,
    isInside,
    removeFolder,
    removeWorktree,
} from "./jarvis-codebase.mjs";
import { postStatus, statusFromSummary } from "./jarvis-status.mjs";
import { isPrCreateCall, linkFromWorker, notePrCreated, noteWorkerTurn, type ToolCall } from "./jarvis-prs.mjs";
import type { WorkItem } from "./service-files.mjs";
import { runNotesAction } from "./jarvis-notes.mjs";
import { taskValidationTool } from "./jarvis-validation-agent.mjs";
import { taskPrBuildsTool } from "./jarvis-pr-builds.mjs";
import { taskPrCommentsTool } from "./jarvis-pr-comments.mjs";
import { openWorkspaceIde } from "./workspace-ide.mjs";
import { APP_NAME, LEAD_NAME } from "./brand.mjs";
import {
    MAIN,
    addDevisWorktree,
    catchUpWithMaster,
    checksReport,
    completeShip,
    devisChanges,
    requireDevis,
    runDevisChecks,
    shipGate,
    withShipLock,
    type DevisChecks,
    type DevisFile,
} from "./devis-self.mjs";

/** Where worker sessions come from. The harness swaps in a fake. */
export interface WorkerRuntime {
    create(config: SessionConfig): Promise<CopilotSession>;
    resume(sessionId: string, config: ResumeSessionConfig): Promise<CopilotSession>;
    remove(sessionId: string): Promise<void>;
    /** Models the user's Copilot can run, with their efforts. */
    catalog(): Promise<ModelChoice[]>;
}

const sdkRuntime: WorkerRuntime = {
    create: (config) => withCopilotClient((client) => client.createSession(config)),
    resume: (sessionId, config) => withCopilotClient((client) => client.resumeSession(sessionId, config)),
    remove: (sessionId) => withCopilotClient((client) => client.deleteSession(sessionId)),
    catalog: getModelCatalog,
};

let runtime: WorkerRuntime = sdkRuntime;

export function setWorkerRuntime(next: WorkerRuntime | null): void {
    runtime = next || sdkRuntime;
}

// The SDK's ask_user handler types are not exported by name.
type UserInputRequest = Parameters<NonNullable<SessionConfig["onUserInputRequest"]>>[0];
type UserInputResponse = Awaited<ReturnType<NonNullable<SessionConfig["onUserInputRequest"]>>>;

/** What a worker on a Devis task asks the user to ship. */
export interface ShipRequest {
    branch: string;
    files: DevisFile[];
    sensitive: string[];
    checks: { passed: number; total: number; preexisting: string[]; ms: number };
    /** Master has moved since the branch left it: it's rebased when it ships. */
    behind: boolean;
}

/** Something a worker is waiting on the user for. */
export interface WorkerRequest {
    id: string;
    /**
     * repos: the worker proposes repositories; the user confirms which it gets worktrees of.
     * ship: a worker on a Devis task asks to ship its change to Devis itself.
     */
    kind: "question" | "permission" | "repos" | "ship";
    title: string;
    detail: string;
    choices: string[];
    allowFreeform: boolean;
    /** For repos: the choices the worker proposed, checked to start with. */
    selected?: string[];
    ship?: ShipRequest;
    at: string;
}

export type PermissionDecision = "allow" | "always" | "deny";

interface Pending extends WorkerRequest {
    settle(value: string): void;
}

interface Live {
    session: CopilotSession | null;
    attaching: Promise<CopilotSession> | null;
    busy: boolean;
    /** The turn's message has gone to the session, so a message can be steered into it. */
    live: boolean;
    stopping: boolean;
    partial: string;
    /** The message id of the reply in `partial`, so a new reply never reads as more of the last one. */
    partialId: string;
    /**
     * This turn's messages as the session records them: the user's, then each reply as it ends.
     * Kept until the next turn starts, so a chat can show the turn whole until it reads the transcript.
     */
    turn: ChatTranscript;
    lastReply: string;
    activity: string;
    /** Messages the user sent into the current turn ("Send now"), until the turn ends. */
    steered: QueuedMessage[];
    /** What the session runs, from its model-change events; null until known. */
    modelState: ModelState | null;
    /** The worker posted its own status during the current turn. */
    postedStatus: boolean;
    /** The current turn writes the task's recap: it only reads, and asks nothing. */
    recapping: boolean;
    /** The current turn reviews PR comments: it only reads, asks nothing, and ends with a proposal. */
    auditing: boolean;
    requests: Map<string, Pending>;
    /** The session's slash commands, read once per attach. */
    commands: Promise<WorkerCommand[]> | null;
    /** Tool calls in flight that create a pull request, by call id. */
    prCalls: Map<string, ToolCall>;
    /** Last attach or turn end; an idle session is released after a while. */
    lastUsed: number;
    /** Ends the current turn's wait when the user stops it (see sendAndSettle). */
    stopTurn: AbortController | null;
    /** The tool call `activity` names, so it clears when that call ends. */
    activityCall: string | null;
    off: Array<() => void>;
}

const lives = new Map<string, Live>();
/**
 * What the user sent each worker while it was mid-turn. Kept apart from `lives`, which a
 * failed turn or an idle sweep drops, so a queue outlives its session being released.
 */
const queues = new Map<string, MessageQueue>();
/** Sessions handed to a `copilot --resume` terminal; the app leaves them alone until its next turn. */
const inTerminal = new Set<string>();

function queueOf(sessionId: string): MessageQueue {
    let queue = queues.get(sessionId);
    if (!queue) {
        queue = new MessageQueue();
        queues.set(sessionId, queue);
    }
    return queue;
}

function live(sessionId: string): Live {
    let entry = lives.get(sessionId);
    if (!entry) {
        entry = {
            session: null,
            attaching: null,
            busy: false,
            live: false,
            stopping: false,
            partial: "",
            partialId: "",
            turn: new ChatTranscript(),
            lastReply: "",
            activity: "",
            steered: [],
            modelState: null,
            postedStatus: false,
            recapping: false,
            auditing: false,
            requests: new Map(),
            commands: null,
            prCalls: new Map(),
            lastUsed: Date.now(),
            stopTurn: null,
            activityCall: null,
            off: [],
        };
        lives.set(sessionId, entry);
        ensureJanitor();
    }
    return entry;
}

// ---- idle sessions ------------------------------------------------------------------
//
// An attached worker session holds memory in the Copilot runtime. One that sits
// idle is released and resumed the next time it's used, and state for workers or
// tasks that are gone is dropped.

export const WORKER_IDLE = {
    releaseAfterMs: 20 * 60_000,
    sweepMs: 60_000,
    /** A failed recap's reason stays on the task this long. */
    failedRecapKeepMs: 24 * 60 * 60_000,
};

let janitor: ReturnType<typeof setInterval> | null = null;

function ensureJanitor(): void {
    if (janitor) return;
    janitor = setInterval(() => void sweepWorkers().catch((error: Error) => console.warn(`[jarvis] worker sweep failed: ${error.message}`)), WORKER_IDLE.sweepMs);
    janitor.unref?.();
}

/** Release idle worker sessions and forget state for workers and tasks that are gone. */
export async function sweepWorkers(now = Date.now()): Promise<{ released: string[] }> {
    const released: string[] = [];
    for (const [id, entry] of [...lives]) {
        if (entry.busy || entry.attaching || entry.requests.size) continue;
        if (now - entry.lastUsed < WORKER_IDLE.releaseAfterMs) continue;
        await detach(id).catch(() => undefined);
        released.push(id);
    }
    for (const id of [...inTerminal]) if (!(await getWorker(id))) inTerminal.delete(id);
    for (const id of [...queues.keys()]) if (!(await getWorker(id))) queues.delete(id);
    for (const [taskId, state] of [...recapStates]) {
        if (recapJobs.has(taskId)) continue;
        const old = state.state === "failed" && now - Date.parse(state.at) > WORKER_IDLE.failedRecapKeepMs;
        if (old || !(await getTask(taskId))) recapStates.delete(taskId);
    }
    return { released };
}

/** How many worker sessions are attached now (the harness). */
export function attachedWorkerCount(): number {
    return lives.size;
}

/** Worker turns, recaps and task removals in flight: what keeps the background service up with no window. */
export async function workerActivity(): Promise<WorkItem[]> {
    const items: WorkItem[] = [];
    for (const [id, entry] of [...lives]) {
        if (!entry.busy) continue;
        const worker = await getWorker(id).catch(() => null);
        const label = worker?.label || id.slice(0, 8);
        items.push({ kind: "worker", label: entry.requests.size ? `${label} (waiting for you)` : label });
    }
    for (const taskId of new Set([...recapJobs.keys(), ...removals.keys()])) {
        const task = await getTask(taskId).catch(() => null);
        items.push({ kind: "recap", label: `${removals.has(taskId) ? "Removing" : "Recap for"} ${task?.title || taskId.slice(0, 8)}` });
    }
    for (const repo of clonesInFlight()) items.push({ kind: "other", label: `Cloning ${repo}` });
    return items;
}

// A turn can wait on the user (questions, approvals) for a long time.
const TURN_TIMEOUT_MS = 12 * 60 * 60_000;
const PROMPT_MAX = 20_000;
/** What a turn is doing until its session takes the prompt in. */
const GETTING_STARTED = "Getting started";

// ---- what the user sees -------------------------------------------------------------

export interface WorkerLiveState {
    busy: boolean;
    /** The reply being written right now, or the last reply of this run. */
    partial: string;
    /** The message id of `partial`: a new id is a new reply. */
    partialId: string;
    activity: string;
    requests: WorkerRequest[];
    /** Messages sent while a turn ran, waiting their turn. */
    queue: QueuedMessage[];
    /** A stop or failure holds the queue until the user sends again. */
    queueHeld: boolean;
    /** Messages sent into the current turn. */
    steered: QueuedMessage[];
    /** A message sent now goes into the running turn. */
    canSteer: boolean;
    /** What the attached session runs; null when it isn't attached or not yet known. */
    currentModel: string | null;
    currentEffort: string | null;
}

export function workerLiveState(sessionId: string): WorkerLiveState {
    const entry = lives.get(sessionId);
    const queued = queues.get(sessionId)?.view() ?? { queue: [], queueHeld: false };
    if (!entry) return { busy: false, partial: "", partialId: "", activity: "", requests: [], ...queued, steered: [], canSteer: false, currentModel: null, currentEffort: null };
    return {
        busy: entry.busy,
        partial: entry.partial,
        partialId: entry.partialId,
        activity: entry.activity,
        requests: [...entry.requests.values()].map(({ settle: _settle, ...request }) => request),
        ...queued,
        steered: entry.steered.map((m) => ({ ...m })),
        canSteer: entry.busy && entry.live && !entry.stopping && !entry.recapping && !entry.auditing && !entry.requests.size,
        currentModel: entry.modelState?.model ?? null,
        currentEffort: entry.modelState?.effort ?? null,
    };
}

/** How many of a turn's messages a live read carries: the chat keeps the ones it saw before. */
const TURN_SHOWN = 30;

export interface WorkerTurnView extends WorkerLiveState {
    state: JarvisWorker["state"];
    summary: string;
    updatedAt: string;
    /** The turn's messages so far, its last TURN_SHOWN, exactly as the transcript will have them. */
    turn: ChatMessage[];
}

/**
 * One worker's turn as it happens, for a chat that's watching it: the live state, the saved
 * state, and the turn's finished messages. Never attaches the session, so it's cheap to poll.
 */
export async function workerTurnView(sessionId: unknown): Promise<WorkerTurnView> {
    const worker = await requireWorker(sessionId);
    const entry = lives.get(worker.sessionId);
    return {
        ...workerLiveState(worker.sessionId),
        state: worker.state,
        summary: worker.summary,
        updatedAt: worker.updatedAt,
        turn: entry ? entry.turn.messages().slice(-TURN_SHOWN) : [],
    };
}

function short(value: unknown, max = 400): string {
    return clip(typeof value === "string" ? value : value == null ? "" : JSON.stringify(value), max);
}

/** A one-line title and the specifics for an approval prompt. */
export function describePermission(request: PermissionRequest): { title: string; detail: string } {
    const r = request as PermissionRequest & Record<string, unknown>;
    switch (request.kind) {
        case "shell":
            return { title: short(r.intention) || "Run a shell command", detail: short(r.fullCommandText, 1200) };
        case "write":
            return { title: short(r.intention) || "Edit a file", detail: short(r.fileName) };
        case "mcp":
            return {
                title: `Use ${short(r.toolTitle || r.toolName)} (${short(r.serverName)})`,
                detail: short(r.args, 1200),
            };
        case "url":
            return { title: short(r.intention) || "Fetch a URL", detail: short(r.url) };
        case "memory":
            return { title: "Store a memory", detail: short(r.fact || r.subject) };
        default:
            return { title: `Allow ${request.kind}`, detail: short(r.intention) };
    }
}

// ---- session plumbing ---------------------------------------------------------------

function workerBrief(task: JarvisTask, worker: { label: string; cwd: string }, worktrees: Worktree[] = []): string {
    const service = task.org && task.project ? `${task.org} / ${task.project}` : "no ADO project";
    const parent = task.workItem?.parent
        ? ` It sits under ${task.workItem.parent.type} #${task.workItem.parent.id} ${task.workItem.parent.title}.`
        : "";
    const devis = task.kind === "devis";
    const where = devis
        ? devisBrief(task, worker, worktrees)
        : task.folder
        ? [
              `You work in ${worker.cwd}, your own folder inside the task's folder (${task.folder}). Other workers on this task have their own folders beside yours; leave them alone.`,
              worktrees.length
                  ? `Your repositories are git worktrees in your folder, each on your own branch:\n${worktrees
                        .map((w) => `- ${w.org}/${w.project}/${w.repo}: ${w.path} (branch ${w.branch}, from ${w.base})`)
                        .join("\n")}`
                  : "You have no repositories yet.",
              "Get repositories with task_workspace: action repos lists what you can use, action propose asks the user to confirm the ones you need, and the app then makes a worktree of each in your folder. Never clone repositories or make worktrees yourself, and don't work outside your folder.",
              "Have a clear goal, scope and definition of done before you change anything: confirm your understanding with the user through ask_user, and ask about anything the title and description leave open.",
          ]
        : [`You work in ${worker.cwd}.`];
    const delivery = devis
        ? []
        : [
              `Pull requests you open for this task are linked to it on their own when you use az repos pr create or the Azure DevOps tools.${
                  task.workItem ? ` Also link work item #${task.workItem.id} when you create one (for example, az repos pr create --work-items ${task.workItem.id}).` : ""
              } If you open one another way, link it with task_link_pr.`,
          ];
    const reviews = devis
        ? []
        : [
              "The task can have a validation chain: Azure DevOps pipelines that prove the change works, run in order. Find and propose one with task_validation (candidates, then propose) when the user asks or the app does; the user accepts it and decides when it runs.",
              "When reviewers comment on your pull requests, the app asks you to review them and propose a response per thread with task_pr_comments. The user accepts the proposal before anything changes; then make only the accepted changes and report with task_pr_comments done.",
              "When blocking builds fail on your pull requests, the app asks you to read the failures and propose, per build, a fix or a rerun with task_pr_builds. The user accepts before anything changes; then make only the accepted fixes, push, and report with task_pr_builds done. Don't queue builds yourself.",
          ];
    return [
        `You are "${worker.label}", a Copilot worker in the user's Workspace in ${APP_NAME}, working with the lead agent ${LEAD_NAME}.`,
        `Your task: ${describeTask(task)}${devis ? "" : ` (service: ${service})`}.${parent}`,
        ...(task.description
            ? [`The task's description:\n${task.description.length > 6_000 ? `${task.description.slice(0, 5_999).trimEnd()}…` : task.description}`]
            : []),
        ...where,
        `The task has an Artifacts folder that you, the task's other workers and the user share (${artifactsDir(task.id)}); use the task_artifacts tool for it.`,
        "note.md there is the shared note: read it before you start. Add to it only what others need to know, like decisions, findings and open questions, not progress: task_status is the progress record. Save longer work, like a design or plan, as its own .md artifact.",
        "Before you end each turn, post one status line with task_status: where the task stands now and what is next, in under 160 characters (for example, \"API change done, tests next\"). It shows on the task's card in the user's Workspace and builds the task's timeline.",
        ...delivery,
        "When you need a decision from the user, ask with ask_user instead of guessing.",
        "Start another worker on this task with task_start_worker only when the user explicitly asks for one, never on your own to split up the work; pass on what the user asked in its instructions.",
        WEB_BRIEF,
        "The user keeps a to-do list and a quick note in the Workspace that every agent can read with user_notes: check them when the user mentions their notes or to-dos.",
        ...reviews,
        "End each turn with a short plain summary of what you did and what is next.",
    ].join("\n");
}

/** Where a worker on a Devis task works, and the rules for changing the app that runs it. */
function devisBrief(task: JarvisTask, worker: { label: string; cwd: string }, worktrees: Worktree[]): string[] {
    const tree = worktrees.find((w) => w.repo === "devis");
    return [
        `This task changes ${APP_NAME} itself: the app you run in. You work in ${worker.cwd}, your own folder inside the task's folder (${task.folder}).`,
        tree
            ? `Your worktree of ${APP_NAME}' source is ${tree.path}, on your own branch ${tree.branch}, off ${MAIN}. Make every change there, and nowhere else.`
            : `Your worktree of ${APP_NAME}' source is missing. Tell the user, and don't change anything.`,
        "Read DESIGN.md in your worktree before you change anything, and the code your change touches. Follow how the code around it is written. When what you change is described in DESIGN.md, update it in the same change.",
        "Have a clear goal, scope and definition of done before you change anything: confirm your understanding with the user through ask_user, and ask about anything the title and description leave open.",
        "Build with `node node_modules/typescript/bin/tsc -p tsconfig.backend.json` and the same with tsconfig.web.json, and run a harness with `node scripts/<name>-harness.mjs`, from your worktree.",
        "Your worktree's node_modules is a link to the source folder's: don't run npm install, and don't add, remove or upgrade packages. If the change needs one, ask the user with ask_user first.",
        `Commit your work on your branch with clear messages. When the change is done and committed, call devis_ready_to_ship: the app runs the builds and every harness, then shows the user your change to review. Nothing ships until they say so; then the app merges your branch into ${MAIN}, deploys it, checks it came up, and rolls back when it didn't.`,
        `Never deploy, restart or stop ${APP_NAME} yourself: don't run scripts/deploy-desktop.ps1, the packaging scripts or the updater. Don't push, and don't touch the source folder${tree ? ` (${tree.clonePath})` : ""} or its ${MAIN} branch directly.`,
    ];
}

function taskStatusTool(): Tool<unknown> {
    return defineTool("task_status", {
        description:
            "Post one status line for this task: where it stands now and what is next, under 160 characters. Call it once before you end each turn. It appears on the task's card in the user's Workspace and in the task's timeline.",
        parameters: {
            type: "object",
            properties: {
                text: { type: "string", description: "One plain line, under 160 characters. No Markdown." },
            },
            required: ["text"],
            additionalProperties: false,
        },
        skipPermission: true,
        defer: "never",
        // The task and author come from the invoking session, never from the input.
        handler: async (args, invocation) => {
            const worker = await getWorker(invocation.sessionId);
            if (!worker) return "This session is not one of the Workspace's workers.";
            try {
                const { created } = await postStatus({
                    taskId: worker.taskId,
                    text: (args as { text?: unknown })?.text,
                    author: worker.label,
                    sessionId: worker.sessionId,
                });
                const entry = lives.get(worker.sessionId);
                if (entry) entry.postedStatus = true;
                return created ? "Status posted." : "That status is already posted.";
            } catch (error) {
                return `Status not posted: ${(error as Error).message}`;
            }
        },
    });
}

function formatSize(bytes: number): string {
    return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 102.4) / 10} KB`;
}

/**
 * One call on a task's Artifacts, for a worker's or the Lead's tool. note.md
 * takes appends only, so nobody wipes the shared note, and recap.md is the
 * app's to write when the task ends.
 */
export async function runArtifactAction(taskId: string, author: string, args: unknown): Promise<string> {
    const a = (args || {}) as { action?: unknown; name?: unknown; content?: unknown };
    const named = typeof a.name === "string" && a.name.trim() ? a.name.trim() : "";
    const name = named || NOTE_NAME;
    const content = typeof a.content === "string" ? a.content : "";
    try {
        switch (a.action) {
            case "list": {
                const items = await listArtifacts(taskId);
                const lines = items.map((i) => `${i.name} · ${formatSize(i.size)} · changed ${new Date(i.modifiedAt).toLocaleString()}`);
                return [...(lines.length ? lines : ["No artifacts yet."]), `Folder: ${artifactsDir(taskId)}`].join("\n");
            }
            case "read": {
                const artifact = await readArtifact(taskId, name);
                return artifact.content.trim() ? artifact.content : `(${artifact.name} is empty)`;
            }
            case "append":
                if (!content.trim()) return "Put the text to add in content.";
                await appendArtifact(taskId, name, content.slice(0, 20_000), author);
                return `Added to ${name}.`;
            case "write": {
                if (!named) return "Name the artifact to write, like design.md.";
                const lower = named.toLowerCase();
                if (lower === NOTE_NAME) return "note.md is shared: add to it with append instead of replacing it.";
                if (lower === RECAP_NAME) return "recap.md is written when the task ends.";
                if (!content.trim()) return "Put the artifact's text in content.";
                await writeArtifact(taskId, named, content);
                return `Saved ${named}.`;
            }
            default:
                return "Use action list, read, append or write.";
        }
    } catch (error) {
        return `Not done: ${(error as Error).message}`;
    }
}

function taskArtifactsTool(): Tool<unknown> {
    return defineTool("task_artifacts", {
        description:
            "The task's Artifacts folder, shared with the user and the task's other workers. action list: name the artifacts. read: one artifact (note.md by default). append: add a dated entry signed with your name (note.md by default). write: create or replace another artifact, like design.md. note.md takes appends only; recap.md is written when the task ends.",
        parameters: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["list", "read", "append", "write"] },
                name: { type: "string", description: "File name, like design.md. Defaults to note.md for read and append." },
                content: { type: "string", description: "Markdown to append or write." },
            },
            required: ["action"],
            additionalProperties: false,
        },
        skipPermission: true,
        defer: "never",
        // The task and author come from the invoking session, never from the input.
        handler: async (args, invocation) => {
            const worker = await getWorker(invocation.sessionId);
            if (!worker) return "This session is not one of the Workspace's workers.";
            return runArtifactAction(worker.taskId, worker.label, args);
        },
    });
}

const WORKER_NOTE_ACTIONS: ReadonlySet<string> = new Set(["read", "add_todo", "set_due"]);

/** The user's own to-dos and quick note: workers read them, and add a to-do when asked. */
function userNotesTool(): Tool<unknown> {
    return defineTool("user_notes", {
        description:
            "The user's own notes in the Workspace, kept across days and shared by every agent: a to-do list, where a to-do can have subtasks to any depth, a priority and a due date, and a quick note. action read: the open to-dos with their ids, subtasks indented under them, and recently done ones, and the quick note. add_todo: add `text` as a to-do signed with your name, or as a subtask of `parent_id`, with an optional `due` date. set_due: set to-do `id`'s `due` date, or clear it with an empty one. Read them when the user asks or points you to them; add or change a to-do only when the user asks.",
        parameters: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["read", "add_todo", "set_due"] },
                text: { type: "string", description: "The to-do to add." },
                id: { type: "number", description: "For set_due: the to-do to date, from read." },
                parent_id: { type: "number", description: "For add_todo: the to-do to add it under as a subtask, from read." },
                due: { type: "string", description: "A date as YYYY-MM-DD; empty clears it." },
            },
            required: ["action"],
            additionalProperties: false,
        },
        skipPermission: true,
        defer: "never",
        // The author comes from the invoking session, never from the input.
        handler: async (args, invocation) => {
            const worker = await getWorker(invocation.sessionId);
            if (!worker) return "This session is not one of the Workspace's workers.";
            return runNotesAction(worker.label, args, WORKER_NOTE_ACTIONS);
        },
    });
}

function taskLinkPrTool(): Tool<unknown> {
    return defineTool("task_link_pr", {
        description:
            "Link a pull request you opened for this task, so it shows on the task. PRs created with az repos pr create or the Azure DevOps tools are linked on their own; use this for one opened another way. Pass its link, or its number when it's in this folder's repository. Only PRs you opened after the task started can be linked.",
        parameters: {
            type: "object",
            properties: {
                pr: { type: "string", description: "The PR's link (https://dev.azure.com/…/pullrequest/123) or its number." },
            },
            required: ["pr"],
            additionalProperties: false,
        },
        skipPermission: true,
        defer: "never",
        // The task comes from the invoking session, never from the input.
        handler: async (args, invocation) => linkFromWorker(invocation.sessionId, (args as { pr?: unknown })?.pr),
    });
}

/** Another worker on the invoking worker's own task, beside it: only when the user explicitly asks for one. */
function taskStartWorkerTool(): Tool<unknown> {
    return defineTool("task_start_worker", {
        description:
            "Start another worker on this task, beside you, with its first instructions. Only when the user explicitly asks you to start one, never on your own to split up the work. On a task with its own folder it gets its own folder beside yours, sets up its own repositories (or its own worktree, on a task that changes the app), and confirms its goal with the user before it changes anything. On an older task without a folder it works in your folder. Returns its name and folder.",
        parameters: {
            type: "object",
            properties: {
                instructions: { type: "string", description: "What the new worker should do, from what the user asked." },
                model: { type: "string", description: "A model id, only when the user names one; otherwise the default." },
            },
            required: ["instructions"],
            additionalProperties: false,
        },
        skipPermission: true,
        defer: "never",
        // The task comes from the invoking session, never from the input.
        handler: async (args, invocation) => {
            const worker = await getWorker(invocation.sessionId);
            if (!worker) return "This session is not one of the Workspace's workers.";
            if (lives.get(worker.sessionId)?.recapping) return "While writing the recap, only read.";
            const a = (args || {}) as { instructions?: unknown; model?: unknown };
            const instructions = typeof a.instructions === "string" ? a.instructions.trim() : "";
            if (!instructions) return "Put what the new worker should do in instructions.";
            try {
                const started = await startWorker({
                    taskId: worker.taskId,
                    cwd: worker.cwd,
                    prompt: instructions,
                    model: typeof a.model === "string" ? a.model : null,
                    startedBy: worker.label,
                });
                return `Started ${started.label} in ${started.cwd}. It works beside you on this task and reads note.md: add what it needs to know there.`;
            } catch (error) {
                return `Not started: ${(error as Error).message}`;
            }
        },
    });
}

/**
 * The app's own tools skip the permission check, so a PR feedback review is held to reading here:
 * per tool, the actions that only read. A tool not listed does nothing during a review.
 */
const AUDIT_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
    task_artifacts: new Set(["list", "read"]),
    user_notes: new Set(["read"]),
    task_validation: new Set(["status", "candidates"]),
    task_pr_comments: new Set(["threads", "propose"]),
    task_pr_builds: new Set(["builds", "propose"]),
    task_workspace: new Set(["repos"]),
};

function readOnlyWhileAuditing(tool: Tool<unknown>): Tool<unknown> {
    const run = tool.handler;
    if (!run) return tool;
    const allowed = AUDIT_ACTIONS[tool.name];
    return {
        ...tool,
        handler: (args, invocation) => {
            const action = (args as { action?: unknown } | null)?.action;
            if (lives.get(invocation.sessionId)?.auditing && !(typeof action === "string" && allowed?.has(action))) {
                return `While reviewing PR feedback, only read; ${tool.name}${typeof action === "string" ? ` ${action}` : ""} can't run now. Put what you'd change in the proposal.`;
            }
            return run(args, invocation);
        },
    };
}

// ---- a worker's repositories (tasks with a folder) -----------------------------------

const STATE_TEXT: Record<string, string> = { cloning: "still cloning", missing: "not cloned yet", error: "clone failed" };

/** task_workspace repos: the repositories in Settings and the worker's own worktrees. */
async function workspaceRepos(worker: JarvisWorker): Promise<string> {
    const [entries, mine] = await Promise.all([codebaseStatus(), listWorktrees({ sessionId: worker.sessionId })]);
    const lines = entries.length
        ? entries.map((e) => `- ${e.key}${STATE_TEXT[e.state] ? ` (${STATE_TEXT[e.state]}; it's cloned when you get it)` : ""}`)
        : ["None yet. Ask the user to add repositories under Settings > Workspace > Codebase."];
    return [
        "Repositories you can use (pass these names to propose):",
        ...lines,
        "",
        mine.length ? `Your worktrees:\n${mine.map((w) => `- ${w.org}/${w.project}/${w.repo}: ${w.path} (branch ${w.branch})`).join("\n")}` : "You have no worktrees yet.",
    ].join("\n");
}

/** task_workspace propose: the user confirms the repositories; the app makes a worktree of each. */
async function proposeRepos(worker: JarvisWorker, args: { repos?: unknown; reason?: unknown }): Promise<string> {
    const task = await getTask(worker.taskId);
    if (!task?.folder) return "This task has no folder; work in your folder as it is.";
    const all = (await readConfig()).codebase;
    if (!all.length) return "No repositories are set up yet. Ask the user to add them under Settings > Workspace > Codebase, then propose again.";
    const names = Array.isArray(args.repos) ? args.repos.map((r) => String(r)) : typeof args.repos === "string" ? [args.repos] : [];
    const mine = await listWorktrees({ sessionId: worker.sessionId });
    const have = new Set(mine.map((w) => codebaseKey(w).toLowerCase()));
    const open = all.filter((r) => !have.has(codebaseKey(r).toLowerCase()));
    if (!open.length) return "You already have a worktree of every repository in Settings.";
    const proposed: string[] = [];
    const unknown: string[] = [];
    for (const name of names) {
        const repo = findRepo(all, name);
        if (!repo) unknown.push(name);
        else if (!have.has(codebaseKey(repo).toLowerCase())) proposed.push(codebaseKey(repo));
    }
    if (!proposed.length && unknown.length) {
        return `Unknown repositories: ${unknown.join(", ")}. Use task_workspace with action repos for the names.`;
    }
    const reason = typeof args.reason === "string" ? clip(args.reason, 2_000) : "";
    const answer = await waitForUser(worker.sessionId, {
        kind: "repos",
        title: reason || `${worker.label} proposes the repositories for this task.`,
        detail: unknown.length ? `Not in Settings, so left out: ${unknown.join(", ")}` : "",
        choices: open.map(codebaseKey),
        selected: [...new Set(proposed)],
        allowFreeform: false,
    });
    let chosen: unknown;
    try {
        chosen = JSON.parse(answer);
    } catch {
        chosen = null;
    }
    if (!Array.isArray(chosen)) return "The user didn't confirm any repositories: the request was closed. Ask them how they want to go on.";
    if (!chosen.length) return "The user chose no repositories. Ask them what they want you to work in, or go on without one.";
    const entry = lives.get(worker.sessionId);
    const lines: string[] = [];
    const made: string[] = [];
    for (const key of chosen.map(String)) {
        const repo = findRepo(all, key);
        if (!repo) continue;
        if (entry) entry.activity = `Making a worktree of ${repo.repo}`;
        try {
            const taken = (await listWorktrees({ sessionId: worker.sessionId })).map((w) => basename(w.path));
            const wt = await addWorktree({
                repo,
                workerFolder: worker.cwd,
                taskName: basename(task.folder),
                workerName: worker.label,
                taken,
            });
            await insertWorktree({ sessionId: worker.sessionId, taskId: task.id, ...repo, ...wt });
            lines.push(`- ${codebaseKey(repo)}: ${wt.path} (branch ${wt.branch}, from ${wt.base})`);
            made.push(repo.repo);
        } catch (error) {
            lines.push(`- ${codebaseKey(repo)}: not made: ${(error as Error).message}`);
        }
    }
    if (made.length) {
        await recordEvent("worker.worktrees", `${worker.label} got worktrees of ${made.join(", ")}`, { taskId: task.id, sessionId: worker.sessionId });
    }
    return [
        `The user confirmed. ${made.length ? "Your worktrees:" : "No worktree was made:"}`,
        ...lines,
        made.length ? "Work in these folders, on these branches." : "Tell the user what went wrong.",
    ].join("\n");
}

function taskWorkspaceTool(): Tool<unknown> {
    return defineTool("task_workspace", {
        description:
            "Your repositories for this task. action repos: the repositories you can use and your worktrees. action propose: ask the user to confirm the repositories this task needs (`repos`, by the names from repos, and `reason`: why each one, briefly); it waits for the user, then the app makes a git worktree of each confirmed one in your folder, on your own branch off the repo's default branch, and returns their paths. Propose again later to add more.",
        parameters: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["repos", "propose"] },
                repos: { type: "array", items: { type: "string" }, description: "For propose: repository names, like org/project/repo." },
                reason: { type: "string", description: "For propose: why the task needs them, in a sentence or a short list." },
            },
            required: ["action"],
            additionalProperties: false,
        },
        skipPermission: true,
        defer: "never",
        // The worker and task come from the invoking session, never from the input.
        handler: async (args, invocation) => {
            const worker = await getWorker(invocation.sessionId);
            if (!worker) return "This session is not one of the Workspace's workers.";
            if (lives.get(worker.sessionId)?.recapping) return "While writing the recap, only read.";
            const a = (args || {}) as { action?: unknown; repos?: unknown; reason?: unknown };
            try {
                if (a.action === "repos") return await workspaceRepos(worker);
                if (a.action === "propose") return await proposeRepos(worker, a);
                return "Use action repos or propose.";
            } catch (error) {
                return `Not done: ${(error as Error).message}`;
            }
        },
    });
}

// ---- shipping a change to Devis itself (tasks of kind devis) --------------------------

const checksLine = (c: DevisChecks): ShipRequest["checks"] => ({
    passed: c.harnesses.passed,
    total: c.harnesses.total,
    preexisting: c.harnesses.preexisting,
    ms: c.ms,
});

/** The user's answer to a ship request: ship when the workers are idle, ship now, or send it back. */
function shipAnswer(answer: string): { decision: "idle" | "now" | "back"; note: string } | null {
    try {
        const a = JSON.parse(answer) as { decision?: unknown; note?: unknown };
        if (a.decision !== "idle" && a.decision !== "now" && a.decision !== "back") return null;
        return { decision: a.decision, note: typeof a.note === "string" ? a.note : "" };
    } catch {
        return null;
    }
}

/**
 * devis_ready_to_ship: check the worker's branch, run the builds and harnesses,
 * and, when they pass, ask the user to ship it. On Ship, rebase onto master if
 * it moved (and check again), merge, and start the updater.
 */
async function readyToShip(worker: JarvisWorker, args: { title?: unknown; summary?: unknown }): Promise<string> {
    const task = await getTask(worker.taskId);
    if (task?.kind !== "devis") return `Only a worker on a task that changes ${APP_NAME} itself can ship.`;
    const entry = lives.get(worker.sessionId);
    if (entry?.recapping || entry?.auditing) return "Not while writing the recap or reviewing feedback.";
    const title = typeof args.title === "string" ? clip(args.title.trim(), 200) : "";
    const summary = typeof args.summary === "string" ? clip(args.summary.trim(), 2_000) : "";
    if (!title) return "Give the change a title: one line the user sees in the ship card and the ship history.";
    if (!summary) return "Give a summary: what changed and why, and how you checked it, in a few lines.";
    const tree = (await listWorktrees({ sessionId: worker.sessionId })).find((w) => w.repo === "devis");
    if (!tree) return `You have no worktree of ${APP_NAME}' source, so there's nothing to ship. Tell the user.`;
    const source = await requireDevis();
    const changes = await devisChanges(tree.path);
    if (changes.uncommitted.length) {
        const shown = changes.uncommitted.slice(0, 12).join(", ");
        return `Commit everything on your branch first. Not committed: ${shown}${changes.uncommitted.length > 12 ? `, and ${changes.uncommitted.length - 12} more` : ""}.`;
    }
    if (!changes.ahead) return `Your branch has no commits that ${MAIN} doesn't. Commit your change, then call devis_ready_to_ship again.`;
    if (entry) entry.activity = "Running Devis' checks";
    let checks = await runDevisChecks({ worktree: tree.path, source, label: worker.label });
    if (!checks.ok) return checksReport(checks);
    if (entry) entry.activity = "";
    const answer = await waitForUser(worker.sessionId, {
        kind: "ship",
        title,
        detail: summary,
        choices: [],
        allowFreeform: false,
        ship: { branch: tree.branch, files: changes.files, sensitive: changes.sensitive, checks: checksLine(checks), behind: changes.behind },
    });
    const decided = shipAnswer(answer);
    if (!decided) return "The ship request was closed without a decision. Ask the user how they want to go on.";
    if (decided.decision === "back") {
        return [
            decided.note ? `The user sent the change back:\n${decided.note}` : "The user sent the change back without a note. Ask them what to change.",
            "Make what they ask for, commit, and call devis_ready_to_ship again.",
        ].join("\n\n");
    }
    const mode = decided.decision;
    try {
        const ship = await withShipLock(async () => {
            if (entry) entry.activity = `Catching up with ${MAIN}`;
            const caught = await catchUpWithMaster(tree.path);
            if (caught.problem) throw new JarvisError(caught.problem);
            if (caught.rebased) {
                if (entry) entry.activity = "Running Devis' checks again";
                checks = await runDevisChecks({ worktree: tree.path, source, label: worker.label });
                if (!checks.ok) throw new JarvisError(`${MAIN} moved, so your branch was rebased onto it, and then the checks failed.\n\n${checksReport(checks)}`);
            }
            if (entry) entry.activity = "Shipping";
            return completeShip({
                source,
                worktree: tree.path,
                branch: tree.branch,
                taskId: task.id,
                sessionId: worker.sessionId,
                worker: worker.label,
                title,
                summary,
                mode,
                checks,
            });
        });
        if (ship.state === "failed") return `Ship ${ship.n} didn't start: ${ship.note} Tell the user.`;
        return [
            `Shipped as ship ${ship.n}: ${MAIN} is at ${ship.commit.slice(0, 8)}, and the updater deploys it ${mode === "now" ? "in a few seconds" : "once no worker is busy"}.`,
            `${APP_NAME} restarts for it, so end your turn now with a short summary. If it doesn't come up, the previous build is put back and the app tells you why.`,
        ].join(" ");
    } catch (error) {
        return `Not shipped: ${(error as Error).message}`;
    } finally {
        if (entry) entry.activity = "";
    }
}

function devisShipTool(): Tool<unknown> {
    return defineTool("devis_ready_to_ship", {
        description:
            `Ask to ship your committed change to ${APP_NAME}. The app checks everything on your branch is committed, runs both TypeScript builds and every harness (the ones that fail on ${MAIN} too don't block), and returns the failures when there are any. When they pass, it shows the user your change and waits: they ship it, or send it back with a note. On ship, the app merges your branch into ${MAIN} and deploys it. It can take several minutes.`,
        parameters: {
            type: "object",
            properties: {
                title: { type: "string", description: "One line: what the change does, for the ship card and history." },
                summary: { type: "string", description: "What changed and why, and how you checked it, in a few plain lines." },
            },
            required: ["title", "summary"],
            additionalProperties: false,
        },
        skipPermission: true,
        defer: "never",
        // The worker and task come from the invoking session, never from the input.
        handler: async (args, invocation) => {
            const worker = await getWorker(invocation.sessionId);
            if (!worker) return "This session is not one of the Workspace's workers.";
            try {
                return await readyToShip(worker, (args || {}) as { title?: unknown; summary?: unknown });
            } catch (error) {
                return `Not shipped: ${(error as Error).message}`;
            }
        },
    });
}

/** Skill folders of the user's enabled Copilot CLI plugins, from the CLI's own config. */
function pluginSkillDirectories(home: string): string[] {
    try {
        // The CLI writes this file with "//" comment lines at the top.
        const text = readFileSync(join(home, ".copilot", "config.json"), "utf8").replace(/^\s*\/\/.*$/gm, "");
        const config = JSON.parse(text);
        const plugins: unknown[] = Array.isArray(config?.installedPlugins) ? config.installedPlugins : [];
        return plugins
            .filter((p): p is { enabled?: boolean; cache_path: string } => !!p && typeof (p as { cache_path?: unknown }).cache_path === "string")
            .filter((p) => p.enabled !== false)
            .map((p) => join(p.cache_path, "skills"));
    } catch {
        return [];
    }
}

/**
 * Where a worker finds skills, as the CLI does: the repo's first, then the
 * user's own, then enabled plugins'. Only skill folders: turning on the CLI's
 * full config discovery would also start the user's extensions, which ask for
 * access before the worker's first turn.
 */
export function workerSkillDirectories(cwd: string, home = homedir()): string[] {
    const dirs = [
        join(cwd, ".github", "skills"),
        join(cwd, ".agents", "skills"),
        join(cwd, ".claude", "skills"),
        join(home, ".copilot", "skills"),
        join(home, ".agents", "skills"),
        join(home, ".claude", "skills"),
        ...pluginSkillDirectories(home),
    ];
    return [...new Set(dirs)].filter(isDirectory);
}

function sessionConfig(
    task: JarvisTask,
    worker: { label: string; cwd: string; model: string | null; effort?: string | null },
    worktrees: Worktree[] = [],
): ResumeSessionConfig {
    const model = worker.model?.trim();
    const effort = worker.effort?.trim();
    const devis = task.kind === "devis";
    const tools = devis
        ? [taskArtifactsTool(), taskStatusTool(), userNotesTool(), taskStartWorkerTool(), devisShipTool()]
        : [taskArtifactsTool(), taskStatusTool(), taskLinkPrTool(), userNotesTool(), taskStartWorkerTool(), taskValidationTool(), taskPrCommentsTool(), taskPrBuildsTool()];
    if (task.folder && !devis) tools.push(taskWorkspaceTool());
    // Skills come from each repository first, then the worker's folder, then the user's own and plugins'.
    const roots = [...worktrees.map((w) => w.path), worker.cwd];
    const own = roots.flatMap((dir) => workerSkillDirectories(dir).filter((d) => isInside(d, dir)));
    const skills = [...new Set([...own, ...workerSkillDirectories(worker.cwd)])];
    return {
        clientName: CLIENT_NAME,
        workingDirectory: worker.cwd,
        model: model && model !== "auto" ? model : undefined,
        // An effort is only ever saved with the model it belongs to.
        ...(model && model !== "auto" && effort ? { reasoningEffort: effort as ResumeSessionConfig["reasoningEffort"] } : {}),
        streaming: true,
        skillDirectories: skills,
        mcpServers: sharedMcpServers(),
        tools: tools.map(readOnlyWhileAuditing),
        systemMessage: { mode: "append", content: workerBrief(task, worker, worktrees) },
        onPermissionRequest: (request, invocation) => onPermission(invocation.sessionId, request),
        onUserInputRequest: (request, invocation) => onUserInput(invocation.sessionId, request),
    };
}

function wire(sessionId: string, entry: Live, session: CopilotSession): void {
    for (const off of entry.off) off();
    entry.off = [
        session.on("assistant.message_delta", (event) => {
            if (event.data.parentToolCallId) return;
            const id = (event.data as { messageId?: string }).messageId || "";
            if (id && id !== entry.partialId) {
                entry.partialId = id;
                entry.partial = "";
            }
            entry.partial += event.data.deltaContent;
        }),
        session.on("user.message", (event) => {
            const message = entry.turn.add(event as unknown as EventLike);
            if (message) claimSteered(entry, message);
            if (entry.activity === GETTING_STARTED) entry.activity = "";
        }),
        session.on("assistant.message", (event) => {
            if (event.data.parentToolCallId || event.agentId) return;
            // Into the turn first, then off the stream: the reply never leaves the chat in between.
            entry.turn.add(event as unknown as EventLike);
            if (event.data.content?.trim()) entry.lastReply = event.data.content;
            entry.partial = "";
            entry.partialId = "";
        }),
        session.on("tool.execution_start", (event) => {
            if (!event.data.parentToolCallId) {
                entry.activity = event.data.toolName;
                entry.activityCall = event.data.toolCallId;
            }
            const call: ToolCall = { toolName: event.data.toolName, mcpToolName: event.data.mcpToolName, arguments: event.data.arguments };
            if (isPrCreateCall(call)) entry.prCalls.set(event.data.toolCallId, call);
        }),
        // A PR the worker just created is linked to the task, whichever way it made it.
        session.on("tool.execution_complete", (event) => {
            // "Using <tool>…" lasts as long as that call, not until the turn ends.
            if (event.data.toolCallId === entry.activityCall) {
                entry.activity = "";
                entry.activityCall = null;
            }
            const call = entry.prCalls.get(event.data.toolCallId);
            if (!call) return;
            entry.prCalls.delete(event.data.toolCallId);
            if (!event.data.success) return;
            const result = event.data.result;
            const output = [result?.detailedContent, result?.content, result?.structuredContent ? JSON.stringify(result.structuredContent) : ""]
                .filter(Boolean)
                .join("\n");
            void notePrCreated(sessionId, output, call);
        }),
        // What the session runs, kept current so the chat head never asks the runtime.
        session.on("session.model_change", (event) => {
            entry.modelState = { model: event.data.newModel || null, effort: event.data.reasoningEffort || null };
        }),
    ];
    entry.session = session;
    if (!entry.modelState) {
        void sessionModelState(session).then((state) => {
            if (!entry.modelState && entry.session === session && state.model) entry.modelState = state;
        });
    }
}

async function attach(sessionId: string): Promise<CopilotSession> {
    const entry = live(sessionId);
    entry.lastUsed = Date.now();
    if (entry.session) return entry.session;
    if (!entry.attaching) {
        entry.attaching = (async () => {
            const worker = await getWorker(sessionId);
            if (!worker) throw new JarvisError("Worker not found.", 404);
            const task = await getTask(worker.taskId);
            if (!task) throw new JarvisError("The worker's task no longer exists.", 404);
            const worktrees = task.folder ? await listWorktrees({ sessionId }) : [];
            const session = await runtime.resume(sessionId, sessionConfig(task, worker, worktrees));
            wire(sessionId, entry, session);
            return session;
        })().finally(() => {
            entry.attaching = null;
        });
    }
    return entry.attaching;
}

async function detach(sessionId: string): Promise<void> {
    const entry = lives.get(sessionId);
    if (!entry) return;
    lives.delete(sessionId);
    for (const off of entry.off) off();
    for (const pending of entry.requests.values()) pending.settle(pending.kind === "permission" ? "deny" : "");
    const session = entry.session || (await entry.attaching?.catch(() => null));
    await session?.disconnect().catch(() => undefined);
}

// ---- waiting on the user ------------------------------------------------------------

async function waitForUser(
    sessionId: string,
    request: Omit<WorkerRequest, "id" | "at">,
): Promise<string> {
    const entry = live(sessionId);
    const worker = await getWorker(sessionId);
    const id = randomUUID();
    const answer = new Promise<string>((resolve) => {
        entry.requests.set(id, {
            ...request,
            id,
            at: new Date().toISOString(),
            settle: (value) => {
                if (!entry.requests.delete(id)) return;
                resolve(value);
                if (!entry.requests.size && entry.busy && !entry.stopping) {
                    void updateWorker(sessionId, { state: "working" }).catch(() => undefined);
                }
            },
        });
    });
    await updateWorker(sessionId, { state: "needsInput" });
    await recordEvent(
        "worker.needsInput",
        request.kind === "repos"
            ? `${worker?.label || "A worker"} proposes repositories: ${(request.selected || []).join(", ") || "none yet"}`
            : request.kind === "ship"
              ? `${worker?.label || "A worker"} is ready to ship: ${request.title}`
              : `${worker?.label || "A worker"} ${request.kind === "question" ? "asked" : "needs approval"}: ${request.title}`,
        { taskId: worker?.taskId, sessionId },
    );
    return answer;
}

/**
 * Ask the user to approve something one of the app's tools wants to do for a worker (like
 * running the task's validation). It waits under Needs you like any approval; true when allowed.
 * Allow all for this worker counts once and doesn't turn on approving everything.
 */
export async function askWorkerApproval(sessionId: string, title: string, detail: string): Promise<boolean> {
    const decision = await waitForUser(sessionId, { kind: "permission", title, detail, choices: [], allowFreeform: false });
    return decision === "allow" || decision === "always";
}

/** While reviewing PR feedback a worker only reads: files, web pages, the app's tools, and MCP tools that don't change anything. */
const MCP_WRITE_WORDS = new Set(
    (
        "write create update delete remove post put patch set add insert upsert push queue run start restart resume suspend stop cancel skip retry " +
        "send reply forward flag approve reject accept decline merge complete abandon vote edit upload link unlink register unregister install share " +
        "submit mitigate resolve acknowledge transfer reactivate click type press drag drop navigate fill select evaluate execute exec invoke call do " +
        "ingest command commit apply assign move rename archive publish deploy trigger enable disable lock unlock save clear upsert"
    ).split(" "),
);
/** Arguments that pick what a combined MCP tool does, like action: "update". */
const MCP_VERB_ARGS = /^(action|operation|method|op|verb)$/i;
function auditPermission(request: PermissionRequest): PermissionRequestResult {
    if (request.kind === "read" || request.kind === "url" || request.kind === "custom-tool") return { kind: "approve-once" };
    if (request.kind === "mcp") {
        if (request.readOnly) return { kind: "approve-once" };
        const args = request.args && typeof request.args === "object" && !Array.isArray(request.args) ? request.args : {};
        const verbs = Object.entries(args).filter(([k, v]) => MCP_VERB_ARGS.test(k) && typeof v === "string").map(([, v]) => v);
        const words = [request.toolName, request.toolTitle, ...verbs]
            .join(" ")
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean);
        if (words.length && !words.some((w) => MCP_WRITE_WORDS.has(w))) return { kind: "approve-once" };
    }
    return {
        kind: "reject",
        feedback: "While reviewing PR feedback, only read (view, grep, read-only tools). Put what you'd change in the proposal; nothing changes until the user accepts it.",
    };
}

async function onPermission(sessionId: string, request: PermissionRequest): Promise<PermissionRequestResult> {
    if (lives.get(sessionId)?.auditing) return auditPermission(request);
    // MCP servers (Agency's and the user's own) are on in every session, and their tools run without
    // asking; so do web pages (web_fetch). Shell commands and edits wait for the user.
    if (request.kind === "read" || request.kind === "custom-tool" || request.kind === "mcp" || request.kind === "url") return { kind: "approve-once" };
    if (lives.get(sessionId)?.recapping) {
        return { kind: "reject", feedback: "While writing the recap, only read. Write it from what you already know." };
    }
    const worker = await getWorker(sessionId);
    if (worker?.autoApprove) return { kind: "approve-once" };
    const { title, detail } = describePermission(request);
    const decision = await waitForUser(sessionId, { kind: "permission", title, detail, choices: [], allowFreeform: false });
    if (decision === "always") {
        await updateWorker(sessionId, { autoApprove: true });
        return { kind: "approve-once" };
    }
    if (decision === "allow") return { kind: "approve-once" };
    return { kind: "reject", feedback: "The user declined this request. Continue without it, or ask what they want instead." };
}

async function onUserInput(sessionId: string, request: UserInputRequest): Promise<UserInputResponse> {
    if (lives.get(sessionId)?.recapping) {
        return { answer: "The user isn't here right now. Write the recap from what you already know.", wasFreeform: true };
    }
    if (lives.get(sessionId)?.auditing) {
        return {
            answer: "The user isn't here right now. Put open questions in the proposal: verdict unclear, or choice with the options.",
            wasFreeform: true,
        };
    }
    const choices = (request.choices || []).map(String);
    const answer = await waitForUser(sessionId, {
        kind: "question",
        title: clip(request.question, 2000),
        detail: "",
        choices,
        allowFreeform: request.allowFreeform !== false || !choices.length,
    });
    return { answer, wasFreeform: !choices.includes(answer) };
}

// ---- turns --------------------------------------------------------------------------

interface TurnOptions {
    /** A PR feedback review (comments or failed builds): it only reads, asks nothing, and leaves the user's queue alone. */
    audit?: boolean;
    /** Called once the turn ends, however it ends. */
    onEnd?: (ended: "done" | "stopped" | "failed") => void;
}

function runTurn(sessionId: string, prompt: string, displayPrompt?: string, images: readonly ChatImage[] = [], opts: TurnOptions = {}): void {
    const entry = live(sessionId);
    const attachments = imageAttachments(images);
    inTerminal.delete(sessionId);
    entry.busy = true;
    entry.auditing = !!opts.audit;
    entry.stopping = false;
    entry.partial = "";
    entry.partialId = "";
    entry.turn = new ChatTranscript();
    // Until the session takes the prompt in (it may still be resuming, starting its MCP servers
    // or running hooks), the chat says so rather than "Thinking".
    entry.activity = GETTING_STARTED;
    entry.activityCall = null;
    entry.postedStatus = false;
    entry.live = false;
    entry.steered = [];
    // A turn the user starts lets what's queued run after it.
    if (!opts.audit) queues.get(sessionId)?.resume();
    const stopTurn = new AbortController();
    entry.stopTurn = stopTurn;
    void (async () => {
        let worker: JarvisWorker | null = null;
        let ended: "done" | "stopped" | "failed" = "done";
        try {
            await updateWorker(sessionId, { state: "working" });
            worker = await getWorker(sessionId);
            const session = await attach(sessionId);
            // Stop can land while the session is still resuming; nothing to abort yet.
            if (entry.stopping) throw new Error("stopped");
            entry.live = true;
            const reply = replyText(
                await sendAndSettle(
                    session,
                    { prompt, ...(displayPrompt ? { displayPrompt } : {}), ...(attachments.length ? { attachments } : {}) },
                    TURN_TIMEOUT_MS,
                    {
                        signal: stopTurn.signal,
                        waiting: () => entry.requests.size > 0,
                        onMissedIdle: () => console.warn(`[jarvis] ${worker?.label || sessionId}'s turn ended without session.idle; picked up from the runtime`),
                    },
                ),
            );
            if (entry.stopping) throw new Error("stopped");
            const said = reply || entry.lastReply;
            const summary = said || "Finished the turn.";
            await updateWorker(sessionId, { state: "turnDone", summary });
            await recordEvent("worker.turnDone", `${worker?.label} finished a turn: ${clip(summary, 300)}`, {
                taskId: worker?.taskId,
                sessionId,
            });
            // A worker that forgot task_status still leaves a line in the task's timeline.
            const fallback = said && !entry.postedStatus && !opts.audit ? statusFromSummary(said) : "";
            if (fallback && worker) {
                await postStatus({ taskId: worker.taskId, text: fallback, author: worker.label, sessionId }).catch((error: Error) =>
                    console.warn(`[jarvis] status from ${worker?.label}'s summary not posted: ${error.message}`),
                );
            }
        } catch (error) {
            const stopped = entry.stopping || error instanceof TurnStoppedError;
            ended = stopped ? "stopped" : "failed";
            await entry.session?.abort().catch(() => undefined);
            // A failed turn may mean the Copilot runtime went away; resume afresh next time.
            if (!stopped && lives.get(sessionId) === entry) await detach(sessionId).catch(() => undefined);
            const message = (error as Error).message || "The worker failed.";
            await updateWorker(sessionId, {
                state: stopped ? "stopped" : "error",
                summary: stopped ? "Stopped by you. Send a message to continue." : message,
            }).catch(() => undefined);
            await recordEvent(
                stopped ? "worker.stopped" : "worker.error",
                stopped ? `${worker?.label} was stopped.` : `${worker?.label} failed: ${message}`,
                { taskId: worker?.taskId, sessionId },
            ).catch(() => undefined);
        } finally {
            entry.busy = false;
            entry.auditing = false;
            entry.live = false;
            entry.stopping = false;
            entry.partial = "";
            entry.partialId = "";
            entry.activity = "";
            entry.activityCall = null;
            entry.steered = [];
            if (entry.stopTurn === stopTurn) entry.stopTurn = null;
            entry.prCalls.clear();
            entry.lastUsed = Date.now();
            for (const pending of entry.requests.values()) pending.settle(pending.kind === "permission" ? "deny" : "");
            // The branch the turn left the folder on, and your PRs from it.
            void noteWorkerTurn(sessionId);
            try {
                opts.onEnd?.(ended);
            } catch (error) {
                console.warn(`[jarvis] ${worker?.label || sessionId}'s turn-end hook failed: ${(error as Error).message}`);
            }
            // What the user queued runs next; after a stop or a failure it waits for them.
            if (ended !== "done") queues.get(sessionId)?.hold();
            void drainQueue(sessionId).catch((error: Error) => console.warn(`[jarvis] ${worker?.label || sessionId}'s queue didn't run: ${error.message}`));
        }
    })();
}

/**
 * A read-only turn that reviews a pull request's new comments or failed builds (see jarvis-pr-comments
 * and jarvis-pr-builds). It starts
 * only when the worker is free and resolves when the turn ends, however it ends.
 */
export async function auditTurn(sessionId: string, prompt: string, display: string): Promise<"done" | "stopped" | "failed"> {
    const worker = await getWorker(sessionId);
    if (!worker) throw new JarvisError("That worker is gone.", 404);
    if (inTerminal.has(sessionId)) throw new JarvisError(`${worker.label} is open in a terminal.`, 409);
    const task = await getTask(worker.taskId);
    if (!task || task.status !== "open" || (await isRemoving(task.id))) throw new JarvisError("The task isn't open.", 409);
    if (lives.get(sessionId)?.busy) throw new JarvisError(`${worker.label} is busy.`, 409);
    return new Promise((resolve) => runTurn(sessionId, prompt, display, [], { audit: true, onEnd: resolve }));
}

/** Start the next queued message when the worker is free to take it. */
async function drainQueue(sessionId: string): Promise<void> {
    const queue = queues.get(sessionId);
    if (!queue?.size || queue.held || lives.get(sessionId)?.busy) return;
    const worker = await getWorker(sessionId);
    if (!worker) {
        queues.delete(sessionId);
        return;
    }
    const task = await getTask(worker.taskId);
    if (!task || task.status !== "open" || (await isRemoving(task.id))) {
        queue.hold();
        return;
    }
    // Something else (a notice, the user) may have started a turn meanwhile; it drains when that ends.
    if (lives.get(sessionId)?.busy) return;
    const next = queue.next();
    if (next) runTurn(sessionId, promptFor(next.text, next.images ?? []), undefined, next.images);
}

/** What the user typed to a worker, checked. It may be empty when images go with it. */
function cleanMessage(value: unknown, images: readonly ChatImage[]): string {
    if (images.length && !(typeof value === "string" && value.trim())) return "";
    return cleanPrompt(value);
}

function cleanPrompt(value: unknown): string {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) throw new JarvisError("Tell the worker what to do.");
    if (text.length > PROMPT_MAX) throw new JarvisError("The message is too long.");
    return text;
}

function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

function cleanFolder(value: unknown): string {
    const folder = typeof value === "string" ? value.trim().replace(/^"(.*)"$/, "$1") : "";
    if (!folder || !isAbsolute(folder)) throw new JarvisError("Choose the worker's folder as a full path, like C:\\src\\repo.");
    if (!isDirectory(folder)) throw new JarvisError(`Folder not found: ${folder}`);
    return folder;
}

export interface StartWorker {
    taskId: string;
    /** The folder to run in, for a task without a folder of its own. */
    cwd?: string | null;
    /** First instructions. Optional on a task with a folder: the worker sets up first either way. */
    prompt?: string | null;
    model?: string | null;
    /** Reasoning effort for `model`; "" or null for its default. */
    effort?: string | null;
    /** The worker on the same task that started this one, at the user's request. */
    startedBy?: string | null;
}

/** How a new worker's first instructions are introduced: the user's own, or passed on by another worker. */
function instructionsFrom(instructions: string, from: string | null | undefined): string {
    if (!instructions) return "";
    return from ? `Instructions from ${from}, another worker on this task, passing on what the user asked:\n${instructions}` : `The user's instructions:\n${instructions}`;
}

/** The first turn of a worker on a task with a folder: get its repositories, settle the goal, then start. */
export function setupPrompt(instructions: string, from?: string | null): string {
    return [
        "Set up your workspace for this task, then start on it.",
        "1. Call task_workspace with action repos to see the repositories you can use. From the task's title and description (and the instructions below, if any), pick the ones this work needs and call task_workspace with action propose, saying briefly why each. The user confirms or changes the list, and the app makes a git worktree of each in your folder, on your own branch.",
        "2. Before you change anything, make sure the goal, the scope and what done means are clear: state your understanding to the user with ask_user and ask them to confirm or correct it, along with anything the title and description leave open. One question at a time.",
        "3. Then start the work right away.",
        instructionsFrom(instructions, from),
    ]
        .filter(Boolean)
        .join("\n\n");
}

/** The first turn of a worker on a task that changes Devis itself: read up, settle the goal, then start. */
export function devisSetupPrompt(instructions: string, from?: string | null): string {
    return [
        `Get ready to change ${APP_NAME}, then start.`,
        "1. Read DESIGN.md in your worktree, then the code this change touches.",
        "2. Before you change anything, make sure the goal, the scope and what done means are clear: state your understanding to the user with ask_user and ask them to confirm or correct it, along with anything the title and description leave open. One question at a time.",
        "3. Make the change on your branch, build it, run the harnesses it touches, and commit. Then call devis_ready_to_ship.",
        instructionsFrom(instructions, from),
    ]
        .filter(Boolean)
        .join("\n\n");
}

/** Start a worker on a task and send it its first instructions. */
export async function startWorker(input: StartWorker): Promise<JarvisWorker> {
    const taskId = asJarvisId(input.taskId);
    const task = taskId ? await getTask(taskId) : null;
    if (!task) throw new JarvisError("Task not found.", 404);
    if (task.status === "done") throw new JarvisError("Reopen the task before starting a worker on it.", 409);
    if (await isRemoving(task.id)) throw new JarvisError("That task is being removed.", 409);
    const model = typeof input.model === "string" && input.model.trim() ? input.model.trim().slice(0, 100) : null;
    const effort = typeof input.effort === "string" ? input.effort.trim() : "";
    if (model && !MODEL_ID.test(model)) throw new JarvisError("Unknown model.");
    if (effort) {
        const problem = effortProblem(model || "", effort, await runtime.catalog().catch(() => null));
        if (problem) throw new JarvisError(problem);
    }
    let cwd: string;
    let label: string;
    let prompt: string;
    let display: string | undefined;
    const startedBy = typeof input.startedBy === "string" && input.startedBy.trim() ? input.startedBy.trim().slice(0, 60) : null;
    const devis = task.kind === "devis";
    if (devis && !task.folder) throw new JarvisError(`A task that changes ${APP_NAME} needs a folder: set the task folder under Settings > Workspace.`, 409);
    const source = devis ? await requireDevis() : null;
    if (task.folder) {
        // The worker gets its own folder in the task's folder, named for it; its worktrees go there.
        const instructions = typeof input.prompt === "string" ? input.prompt.trim() : "";
        if (instructions.length > PROMPT_MAX) throw new JarvisError("The message is too long.");
        const root = task.folder;
        try {
            mkdirSync(root, { recursive: true });
        } catch (error) {
            throw new JarvisError(`The task's folder ${root} can't be made: ${(error as Error).message}`, 409);
        }
        label = await nextWorkerName((name) => !existsSync(join(root, name)));
        cwd = join(root, label);
        mkdirSync(cwd, { recursive: true });
        prompt = devis ? devisSetupPrompt(instructions, startedBy) : setupPrompt(instructions, startedBy);
        display = instructions || (devis ? "Get ready and start on this change." : "Set up your workspace and start on this task.");
    } else {
        cwd = cleanFolder(input.cwd);
        const instructions = cleanPrompt(input.prompt);
        prompt = startedBy ? instructionsFrom(instructions, startedBy) : instructions;
        if (startedBy) display = instructions;
        label = await nextWorkerLabel(cwd);
    }
    const sessionId = randomUUID();
    const worker = await insertWorker({ sessionId, taskId: task.id, label, cwd, model, effort: effort || null, state: "working", summary: "" });
    const entry = live(sessionId);
    const worktrees: Worktree[] = [];
    try {
        if (source) {
            entry.activity = `Making a worktree of ${APP_NAME}' source`;
            const wt = await addDevisWorktree({ source, workerFolder: cwd, title: task.title });
            worktrees.push(await insertWorktree({ sessionId, taskId: task.id, org: "", project: "", repo: "devis", ...wt }));
            entry.activity = "";
        }
        const session = await runtime.create({ ...sessionConfig(task, worker, worktrees), sessionId } as SessionConfig);
        wire(sessionId, entry, session);
    } catch (error) {
        lives.delete(sessionId);
        await deleteWorker(sessionId);
        for (const w of worktrees) await removeWorktree(w).catch(() => undefined);
        if (task.folder && isInside(cwd, task.folder)) removeFolder(cwd);
        throw new JarvisError(`Could not start the worker: ${(error as Error).message}`, 502);
    }
    await recordEvent("worker.started", `${label} started on ${describeTask(task)} in ${cwd}${startedBy ? `, by ${startedBy}` : ""}`, { taskId: task.id, sessionId });
    runTurn(sessionId, prompt, display);
    return (await getWorker(sessionId))!;
}

/** A task that changes Devis itself, with a worker started on it. The task stays when its worker can't start. */
export async function startDevisTask(input: { title: unknown; description: unknown }): Promise<{ task: JarvisTask; worker: JarvisWorker | null; workerError: string | null }> {
    await requireDevis();
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const description = typeof input.description === "string" ? input.description : "";
    if (!title) throw new JarvisError("Give the change a title.");
    if (!description.trim()) throw new JarvisError("Describe the change: what to do, and why.");
    const cfg = await readConfig();
    if (!cfg.taskRoot) throw new JarvisError(`Set the task folder under Settings > Workspace first: a change to ${APP_NAME} works in a folder there.`, 409);
    const { task } = await createTask({ title, description, folderRoot: cfg.taskRoot, kind: "devis" });
    try {
        return { task, worker: await startWorker({ taskId: task.id }), workerError: null };
    } catch (error) {
        return { task, worker: null, workerError: (error as Error).message };
    }
}

async function requireWorker(sessionId: unknown): Promise<JarvisWorker> {
    const id = asJarvisId(sessionId);
    const worker = id ? await getWorker(id) : null;
    if (!worker) throw new JarvisError("Worker not found.", 404);
    return worker;
}

/**
 * Answer the worker's open question when `requestId` names one; otherwise send
 * a new instruction, which starts a turn. While a turn runs, mode "queue" keeps it
 * for after the turn and "now" steers it into the turn; without a mode a busy
 * worker refuses it (the Lead and app notices rely on that).
 */
export async function messageWorker(
    sessionId: unknown,
    text: unknown,
    requestId?: unknown,
    modeValue?: unknown,
    imagesValue?: unknown,
): Promise<"answered" | "sent" | "queued" | "steered"> {
    const worker = await requireWorker(sessionId);
    const entry = lives.get(worker.sessionId);
    const pending = typeof requestId === "string" ? entry?.requests.get(requestId) : undefined;
    const images = await requestImages(imagesValue);
    if (pending) {
        if (images.length) throw new JarvisError("An answer is text only. Send the image as a message once you've answered.");
        if (pending.kind === "permission") throw new JarvisError("That request needs Allow or Deny.");
        if (pending.kind === "repos") throw new JarvisError("That request needs the user to confirm the repositories in the card.");
        if (pending.kind === "ship") throw new JarvisError("That request needs Ship or Send back in the card.");
        const answer = typeof text === "string" ? text.trim() : "";
        if (!answer) throw new JarvisError("Type an answer.");
        pending.settle(answer.slice(0, PROMPT_MAX));
        await recordEvent("worker.answered", `You answered ${worker.label}: ${clip(answer, 200)}`, {
            taskId: worker.taskId,
            sessionId: worker.sessionId,
        });
        return "answered";
    }
    if (typeof requestId === "string" && requestId) throw new JarvisError("That question was already answered.", 409);
    const typed = cleanMessage(text, images);
    const mode = sendMode(modeValue);
    if (entry?.busy && !mode) throw new JarvisError(`${worker.label} is still working. Wait for its turn to end, or stop it.`, 409);
    const task = await getTask(worker.taskId);
    if (task?.status === "done") throw new JarvisError("Reopen the task before sending its workers more work.", 409);
    if (await isRemoving(worker.taskId)) throw new JarvisError("That task is being removed.", 409);
    // The turn may have ended while the task was read.
    const now = lives.get(worker.sessionId);
    if (!now?.busy) {
        runTurn(worker.sessionId, promptFor(typed, images), undefined, images);
        return "sent";
    }
    if (now.recapping) throw new JarvisError(`${worker.label} is writing the task's recap. Send it when that's done.`, 409);
    // A comment review only reads; what the user sends runs after it.
    if (mode === "now" && now.live && !now.stopping && !now.auditing) {
        if (now.requests.size) throw new JarvisError(`${worker.label} is waiting on you. Answer above, or queue the message.`, 409);
        await steerWorker(worker, now, typed, images);
        return "steered";
    }
    // Still starting the turn (or stopping it): it runs after.
    queueOf(worker.sessionId).add(typed, images);
    return "queued";
}

async function steerWorker(worker: JarvisWorker, entry: Live, text: string, images: readonly ChatImage[] = []): Promise<void> {
    if (!entry.session) throw new JarvisError(`${worker.label}'s session isn't ready. Queue the message instead.`, 409);
    // Listed before it goes, so the session taking it in (user.message) always finds it here.
    const item: QueuedMessage = { id: randomUUID(), text, at: new Date().toISOString(), ...(images.length ? { images: [...images] } : {}) };
    entry.steered.push(item);
    try {
        await steer(entry.session, promptFor(text, images), imageAttachments(images));
    } catch (error) {
        entry.steered = entry.steered.filter((m) => m !== item);
        throw new JarvisError(`Couldn't send it to ${worker.label} now: ${(error as Error).message}`, 502);
    }
}

/** The session took in a message: one sent mid-turn now shows in the conversation, where the worker read it. */
function claimSteered(entry: Live, message: Pick<ChatMessage, "content" | "images">): void {
    const at = entry.steered.findIndex((m) => m.text.trim() === message.content.trim() && sameImages(m.images, message.images));
    if (at >= 0) entry.steered = entry.steered.filter((_, i) => i !== at);
}

export async function removeQueuedMessage(sessionId: unknown, id: unknown): Promise<void> {
    const worker = await requireWorker(sessionId);
    if (!queues.get(worker.sessionId)?.take(id)) throw new JarvisError("That message already left the queue.", 409);
}

/** Send a queued message now: into the running turn, or as a new turn when none runs. */
export async function sendQueuedNow(sessionId: unknown, id: unknown): Promise<"sent" | "steered"> {
    const worker = await requireWorker(sessionId);
    const queue = queues.get(worker.sessionId);
    const item = queue?.find(id);
    if (!queue || !item) throw new JarvisError("That message already left the queue.", 409);
    const task = await getTask(worker.taskId);
    if (task?.status === "done") throw new JarvisError("Reopen the task before sending its workers more work.", 409);
    if (await isRemoving(worker.taskId)) throw new JarvisError("That task is being removed.", 409);
    const entry = lives.get(worker.sessionId);
    if (!entry?.busy) {
        queue.take(item.id);
        runTurn(worker.sessionId, promptFor(item.text, item.images ?? []), undefined, item.images);
        return "sent";
    }
    if (entry.recapping) throw new JarvisError(`${worker.label} is writing the task's recap. Send it when that's done.`, 409);
    if (entry.auditing) throw new JarvisError(`${worker.label} is reviewing PR feedback. It runs when that's done.`, 409);
    if (!entry.live || entry.stopping) throw new JarvisError(`${worker.label} is between turns. Try again in a moment.`, 409);
    if (entry.requests.size) throw new JarvisError(`${worker.label} is waiting on you. Answer above first.`, 409);
    queue.take(item.id);
    try {
        await steerWorker(worker, entry, item.text, item.images);
    } catch (error) {
        queue.restore(item);
        throw error;
    }
    return "steered";
}

export interface WorkerModelResult {
    model: string;
    effort: string;
    currentModel: string | null;
    currentEffort: string | null;
    /** The switch waits for the turn in flight to end. */
    deferred: boolean;
}

/**
 * Choose a worker's model and reasoning effort ("" for the Copilot default and the model's
 * own effort). An attached session switches now, or once its turn ends, and keeps its
 * conversation; a released one picks them up when it resumes. A "" model applies to
 * sessions Copilot starts, so a running one keeps what it runs.
 */
export async function setWorkerModel(sessionId: unknown, modelValue: unknown, effortValue: unknown): Promise<WorkerModelResult> {
    const worker = await requireWorker(sessionId);
    const model = typeof modelValue === "string" ? modelValue.trim() : "";
    const effort = typeof effortValue === "string" ? effortValue.trim() : "";
    if (model && !MODEL_ID.test(model)) throw new JarvisError("Unknown model.");
    const catalog = await runtime.catalog().catch(() => null);
    if (model && catalog && !catalog.some((m) => m.id === model)) throw new JarvisError(`${model} isn't available to your Copilot.`);
    const problem = effortProblem(model, effort, catalog);
    if (problem) throw new JarvisError(problem);
    const entry = lives.get(worker.sessionId);
    const session = entry?.session ?? (await entry?.attaching?.catch(() => null)) ?? null;
    let deferred = false;
    if (session && model) {
        try {
            deferred = (await switchSessionModel(session, model, effort)).deferred;
        } catch (error) {
            throw new JarvisError(`Could not switch ${worker.label} to ${model}: ${(error as Error).message}`, 502);
        }
        if (!deferred && entry) entry.modelState = { model, effort: effort || null };
    }
    await updateWorker(worker.sessionId, { model: model || null, effort: effort || null });
    const state = entry?.modelState ?? null;
    return { model, effort, currentModel: state?.model ?? null, currentEffort: state?.effort ?? null, deferred };
}

export async function decidePermission(sessionId: unknown, requestId: unknown, decision: unknown): Promise<void> {
    const worker = await requireWorker(sessionId);
    const pending = typeof requestId === "string" ? lives.get(worker.sessionId)?.requests.get(requestId) : undefined;
    if (!pending || pending.kind !== "permission") throw new JarvisError("That request is no longer waiting.", 409);
    if (decision !== "allow" && decision !== "always" && decision !== "deny") throw new JarvisError("Unknown decision.");
    pending.settle(decision);
    const verb = decision === "deny" ? "declined" : decision === "always" ? "allowed (and everything after it)" : "allowed";
    await recordEvent("worker.permission", `You ${verb} for ${worker.label}: ${pending.title}`, {
        taskId: worker.taskId,
        sessionId: worker.sessionId,
    });
}

/**
 * The user's call on a worker's ship request: ship when no worker is busy
 * ("idle"), ship now, or send it back with a note. A ship that can't go now
 * (another one deploying, the source folder off master, a sensitive file not
 * ticked) throws, and the card stays.
 */
export async function decideShip(sessionId: unknown, requestId: unknown, decision: unknown, note: unknown, ack: unknown): Promise<void> {
    const worker = await requireWorker(sessionId);
    const pending = typeof requestId === "string" ? lives.get(worker.sessionId)?.requests.get(requestId) : undefined;
    if (!pending || pending.kind !== "ship") throw new JarvisError("That request is no longer waiting.", 409);
    if (decision !== "idle" && decision !== "now" && decision !== "back") throw new JarvisError("Unknown decision.");
    const text = typeof note === "string" ? note.trim().slice(0, PROMPT_MAX) : "";
    if (decision !== "back") await shipGate({ sensitive: pending.ship?.sensitive || [], ack: ack === true });
    pending.settle(JSON.stringify({ decision, note: text }));
    await recordEvent(
        "worker.answered",
        decision === "back"
            ? `You sent ${worker.label}'s change back${text ? `: ${clip(text, 200)}` : "."}`
            : `You shipped ${worker.label}'s change${decision === "now" ? " now" : " for when the workers are done"}: ${pending.title}`,
        { taskId: worker.taskId, sessionId: worker.sessionId },
    );
}

/** The user confirms which of the proposed repositories the worker gets; an empty list gives it none. */
export async function confirmRepos(sessionId: unknown, requestId: unknown, repos: unknown): Promise<string[]> {
    const worker = await requireWorker(sessionId);
    const pending = typeof requestId === "string" ? lives.get(worker.sessionId)?.requests.get(requestId) : undefined;
    if (!pending || pending.kind !== "repos") throw new JarvisError("That request is no longer waiting.", 409);
    if (!Array.isArray(repos)) throw new JarvisError("Say which repositories to use.");
    const wanted = new Set(repos.map((r) => String(r).toLowerCase()));
    const picked = pending.choices.filter((c) => wanted.has(c.toLowerCase()));
    pending.settle(JSON.stringify(picked));
    await recordEvent(
        "worker.answered",
        picked.length ? `You gave ${worker.label} ${picked.join(", ")}` : `You gave ${worker.label} no repositories.`,
        { taskId: worker.taskId, sessionId: worker.sessionId },
    );
    return picked;
}

/** Abort the worker's current turn. The worker stays and can be messaged again. */
export async function stopWorker(sessionId: unknown): Promise<void> {
    const worker = await requireWorker(sessionId);
    const entry = lives.get(worker.sessionId);
    if (!entry?.busy) return;
    entry.stopping = true;
    for (const pending of entry.requests.values()) pending.settle(pending.kind === "permission" ? "deny" : "");
    // The turn's wait ends as soon as the runtime lets go (or after a short grace) even if no
    // event ever says so: aborting a session that's already idle emits nothing.
    entry.stopTurn?.abort();
    await Promise.race([entry.session?.abort().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

/** Stop the worker, delete its Copilot session and its row, and, on a task with a folder, its folder and worktrees. */
export async function removeWorker(sessionId: unknown): Promise<void> {
    const worker = await requireWorker(sessionId);
    const task = await getTask(worker.taskId);
    const worktrees = await listWorktrees({ sessionId: worker.sessionId });
    // Nothing queued may start once the turn below stops.
    queues.delete(worker.sessionId);
    await stopWorker(worker.sessionId);
    await detach(worker.sessionId);
    inTerminal.delete(worker.sessionId);
    await runtime.remove(worker.sessionId).catch(() => undefined);
    await deleteWorker(worker.sessionId);
    // Only a folder the app made for the worker goes; a folder the user chose is theirs.
    const folder = task?.folder && isInside(worker.cwd, task.folder) ? worker.cwd : null;
    const problems = await discardWorkspace(worktrees, folder);
    await recordEvent(
        "worker.removed",
        `${worker.label} was removed.${problems.length ? ` ${problems.join(" ")}` : ""}`,
        { taskId: worker.taskId, sessionId: worker.sessionId },
    );
}

/** Remove worktrees (and their local branches), then the folder that held them. Returns what was left behind. */
export async function discardWorkspace(worktrees: Worktree[], folder: string | null): Promise<string[]> {
    const problems: string[] = [];
    for (const w of worktrees) {
        const problem = await removeWorktree(w).catch((error: Error) => error.message);
        if (problem) problems.push(problem);
    }
    const problem = removeFolder(folder);
    if (problem) problems.push(problem);
    for (const p of problems) console.warn(`[jarvis] ${p}`);
    return problems;
}

/** Release and delete the sessions of a deleted task's workers. */
export async function discardWorkerSessions(sessionIds: string[]): Promise<void> {
    for (const id of sessionIds) {
        queues.delete(id);
        const entry = lives.get(id);
        if (entry?.busy) {
            entry.stopping = true;
            await entry.session?.abort().catch(() => undefined);
        }
        await detach(id);
        inTerminal.delete(id);
        await runtime.remove(id).catch(() => undefined);
    }
}

export function isWorkerBusy(sessionId: string): boolean {
    return !!lives.get(sessionId)?.busy;
}

// ---- recaps -------------------------------------------------------------------------
//
// When a task is done or removed, one of its workers writes recap.md: the goal,
// design, decisions and outcome, for whoever picks it up later. The recap turn
// only reads; it can't ask the user anything or wait on an approval.

export const RECAP_LIMITS = {
    /** A recap turn gets this long. */
    turnMs: 5 * 60_000,
    /** A task marked done mid-turn: the recap waits this long for a worker to finish. */
    waitMs: 20 * 60_000,
    /** A task being removed: its workers are stopped, and get this long to wind down. */
    stopWaitMs: 30_000,
    pollMs: 2_000,
    maxChars: 20_000,
};

export type RecapReason = "done" | "removed" | "requested";

export interface RecapState {
    state: "waiting" | "writing" | "failed";
    /** The worker writing it, or the one that last tried. */
    by: string | null;
    error: string | null;
    at: string;
}

const recapStates = new Map<string, RecapState>();
const recapJobs = new Map<string, Promise<boolean>>();

/** Where the task's recap stands, if one is on its way or failed. */
export function recapState(taskId: string): RecapState | null {
    return recapStates.get(taskId) || null;
}

/** Resolves once no recap is being written (for this task, or any). */
export async function recapIdle(taskId?: string): Promise<void> {
    const jobs = taskId ? [recapJobs.get(taskId)] : [...recapJobs.values()];
    await Promise.all(jobs.map((job) => job?.catch(() => false)));
}

/**
 * Ask one of the task's workers to write recap.md. One recap at a time per
 * task; a second call joins the first. Resolves true when it was written.
 */
export function writeRecap(taskId: string, reason: RecapReason): Promise<boolean> {
    const running = recapJobs.get(taskId);
    if (running) return running;
    const job = recapJob(taskId, reason)
        .catch((error: Error) => {
            recapStates.set(taskId, { state: "failed", by: null, error: error.message, at: new Date().toISOString() });
            return false;
        })
        .finally(() => recapJobs.delete(taskId));
    recapJobs.set(taskId, job);
    return job;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function recapJob(taskId: string, reason: RecapReason): Promise<boolean> {
    const set = (state: RecapState["state"], by: string | null = null, error: string | null = null) =>
        recapStates.set(taskId, { state, by, error, at: new Date().toISOString() });
    const fail = async (error: string, by: string | null = null): Promise<boolean> => {
        set("failed", by, error);
        await recordEvent("task.recap", `No recap written: ${error}`, { taskId }).catch(() => undefined);
        return false;
    };
    if (!(await getTask(taskId))) return false;
    let workers = await listWorkers(taskId);
    if (!workers.length) {
        recapStates.delete(taskId);
        return false;
    }
    set("waiting");
    // A worker writing the recap is busy too, but stopping it would lose the recap.
    const stopOthers = async () => {
        for (const w of workers) {
            const entry = lives.get(w.sessionId);
            if (entry?.busy && !entry.recapping) await stopWorker(w.sessionId).catch(() => undefined);
        }
    };
    if (reason === "removed") await stopOthers();
    const deadline = Date.now() + (reason === "removed" ? RECAP_LIMITS.stopWaitMs : RECAP_LIMITS.waitMs);
    // A session open in a terminal isn't the app's to prompt.
    const free = (w: JarvisWorker) => !inTerminal.has(w.sessionId) && !lives.get(w.sessionId)?.busy;
    for (;;) {
        const task = await getTask(taskId);
        // Reopened while waiting: the work isn't over, so no recap yet.
        if (!task || (reason === "done" && task.status !== "done")) {
            recapStates.delete(taskId);
            return false;
        }
        workers = await listWorkers(taskId);
        if (!workers.length) return fail("its workers were removed.");
        if (workers.every((w) => inTerminal.has(w.sessionId))) return fail("its worker is open in a terminal. Close it, then Try again.");
        if (workers.some(free)) break;
        if (Date.now() > deadline) return fail("its workers were still busy. Try again when they finish.");
        await sleep(RECAP_LIMITS.pollMs);
    }
    // The freshest free worker; one that failed its last turn goes last.
    const order = workers
        .filter(free)
        .sort((a, b) => Number(a.state === "error") - Number(b.state === "error") || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    let lastError = "";
    for (const worker of order.slice(0, 2)) {
        set("writing", worker.label);
        try {
            await recapTurn(worker, reason);
            recapStates.delete(taskId);
            await recordEvent("task.recap", `${worker.label} wrote the recap (recap.md).`, { taskId, sessionId: worker.sessionId });
            return true;
        } catch (error) {
            lastError = `${worker.label}: ${(error as Error).message}`;
        }
    }
    return fail(lastError || "no worker could write it.", order[0]?.label ?? null);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The recap sees the task's whole life: all of its updates, or the first and latest with a gap noted. */
export const RECAP_TIMELINE = { first: 50, latest: 150 };

export function recapPrompt(
    task: Pick<JarvisTask, "title">,
    reason: RecapReason,
    statuses: StatusUpdate[],
    prs: TaskPr[] = [],
    validation: string[] = [],
): string {
    const line = (s: StatusUpdate) => `- ${new Date(s.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} · ${s.author}: ${s.text}`;
    const oldestFirst = [...statuses].reverse();
    const { first, latest } = RECAP_TIMELINE;
    const timeline =
        oldestFirst.length <= first + latest
            ? oldestFirst.map(line)
            : [
                  ...oldestFirst.slice(0, first).map(line),
                  `- (${oldestFirst.length - first - latest} updates in between left out)`,
                  ...oldestFirst.slice(-latest).map(line),
              ];
    const opening =
        reason === "removed"
            ? `The user is removing the task "${task.title}". Before it goes, write its recap.`
            : reason === "done"
              ? `The task "${task.title}" is done. Write its recap.`
              : `Write a recap of the task "${task.title}" so far.`;
    return [
        opening,
        "It is saved as recap.md in the task's Artifacts, for whoever picks this work up later.",
        "",
        "Rules:",
        `- Start with the line "# Recap: ${task.title}".`,
        "- Brief and clear. Cover the goal, the approach and design, the key decisions and why, the outcome, and anything left open.",
        "- High-level context only. Leave out step-by-step progress, commands and file-by-file changes.",
        "- Short sections or bullets, under 300 words.",
        "- Draw on this session, note.md and the other artifacts (read them with task_artifacts), and the status timeline below. Don't invent anything.",
        "- Don't edit files, run commands or post a status. Reply with the recap Markdown only.",
        "",
        "Status timeline over the task's life, oldest first:",
        ...(timeline.length ? timeline : ["(no status updates)"]),
        ...(prs.length
            ? [
                  "",
                  "Pull requests linked to the task:",
                  ...prs.map((p) => {
                      const s = p.snapshot;
                      const state = s ? (s.isDraft && s.status === "active" ? "draft" : s.status) : "unknown";
                      return `- PR ${p.prId}${s ? ` · ${s.title} · ${s.repo} · ${state}` : ""}`;
                  }),
              ]
            : []),
        ...(validation.length ? ["", "Validation runs, newest first:", ...validation.map((v) => `- ${v}`)] : []),
    ].join("\n");
}

/** The worker's reply as recap.md: fences and lead-ins dropped, a heading and a byline added. */
export function cleanRecap(raw: string, title: string, byline: string): string {
    let text = String(raw ?? "").replace(/\r\n?/g, "\n").trim();
    const fenced = /^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```$/i.exec(text);
    if (fenced) text = fenced[1].trim();
    if (!/[\p{L}\p{N}]/u.test(text)) return "";
    // "Here's the recap:" before the heading goes.
    const heading = text.search(/^# /m);
    if (heading > 0 && heading < 200) text = text.slice(heading);
    if (text.length > RECAP_LIMITS.maxChars) text = text.slice(0, RECAP_LIMITS.maxChars).trimEnd() + "\n\n…";
    const lines = text.split("\n");
    if (!/^# /.test(lines[0])) lines.unshift(`# Recap: ${title}`);
    lines.splice(1, 0, "", `_${byline}_`, "");
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

async function recapTurn(worker: JarvisWorker, reason: RecapReason): Promise<void> {
    const entry = live(worker.sessionId);
    if (entry.busy) throw new Error("it is busy.");
    entry.busy = true;
    entry.recapping = true;
    entry.stopping = false;
    entry.partial = "";
    entry.partialId = "";
    entry.turn = new ChatTranscript();
    entry.lastReply = "";
    entry.activity = "Writing the recap";
    entry.activityCall = null;
    const stopTurn = new AbortController();
    entry.stopTurn = stopTurn;
    try {
        await updateWorker(worker.sessionId, { state: "working" });
        const task = await getTask(worker.taskId);
        if (!task) throw new Error("the task is gone.");
        const session = await attach(worker.sessionId);
        if (entry.stopping) throw new Error("stopped.");
        const statuses = await listStatuses({ taskId: task.id, limit: 2000 });
        const prs = await listTaskPrs(task.id);
        const validation = await import("./jarvis-validation.mjs")
            .then(async (v) => (await v.validationView(task.id)).runs.map((r) => `${r.createdAt}: ${r.text}`))
            .catch(() => [] as string[]);
        const minutes = Math.round(RECAP_LIMITS.turnMs / 60_000);
        const result = await withTimeout(
            sendAndSettle(
                session,
                { prompt: recapPrompt(task, reason, statuses, prs, validation), displayPrompt: "Write the task's recap (recap.md)." },
                RECAP_LIMITS.turnMs,
                {
                    signal: stopTurn.signal,
                    waiting: () => entry.requests.size > 0,
                    onMissedIdle: () => console.warn(`[jarvis] ${worker.label}'s recap turn ended without session.idle; picked up from the runtime`),
                },
            ),
            RECAP_LIMITS.turnMs + 5_000,
            `no recap after ${minutes} minutes.`,
        );
        if (entry.stopping) throw new Error("stopped.");
        const when = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
        const verb = reason === "removed" ? "Task removed" : reason === "done" ? "Task done" : "Written";
        const text = cleanRecap(replyText(result) || entry.lastReply, task.title, `${verb} ${when} · recap by ${worker.label}`);
        if (!text) throw new Error("its reply had no recap.");
        await writeArtifact(task.id, RECAP_NAME, text);
        await updateWorker(worker.sessionId, { state: "turnDone", summary: "Wrote the task's recap (recap.md)." });
    } catch (error) {
        await entry.session?.abort().catch(() => undefined);
        const message = (error as Error).message || "the recap failed.";
        await updateWorker(worker.sessionId, { state: "idle", summary: `Recap not written: ${message}` }).catch(() => undefined);
        throw new Error(message);
    } finally {
        entry.busy = false;
        entry.recapping = false;
        entry.stopping = false;
        entry.partial = "";
        entry.partialId = "";
        entry.activity = "";
        entry.activityCall = null;
        if (entry.stopTurn === stopTurn) entry.stopTurn = null;
        entry.prCalls.clear();
        entry.lastUsed = Date.now();
        for (const pending of entry.requests.values()) pending.settle(pending.kind === "permission" ? "deny" : "");
    }
}

// Any path that marks a task done (the page, the Lead) gets a recap.
onTaskDone((task) => {
    void writeRecap(task.id, "done");
});

// ---- removing a task ----------------------------------------------------------------

const removals = new Map<string, Promise<void>>();

/**
 * Remove a task: it leaves Today at once, one of its workers writes recap.md,
 * then the task, its workers and their Copilot sessions are deleted, along with
 * the task's own folder and its workers' worktrees and branches. Its Artifacts
 * folder (note.md, recap.md and the rest) stays on disk. Resolves once the removal has started.
 */
export async function removeTask(taskId: unknown): Promise<{ recap: boolean }> {
    const id = asJarvisId(taskId);
    const task = id ? await getTask(id) : null;
    if (!task) throw new JarvisError("Task not found.", 404);
    const recap = (await listWorkers(task.id)).length > 0;
    if (!removals.has(task.id)) {
        await beginRemoval(task.id);
        startRemoval(task.id);
    }
    return { recap };
}

function startRemoval(taskId: string): void {
    removals.set(
        taskId,
        finishRemoval(taskId).finally(() => removals.delete(taskId)),
    );
}

async function finishRemoval(taskId: string): Promise<void> {
    try {
        const workers = await listWorkers(taskId);
        // A recap already waiting on a busy worker (the task was just marked done) can go now.
        // The worker writing a recap keeps going: stopping it would lose the recap.
        for (const w of workers) {
            const entry = lives.get(w.sessionId);
            if (entry?.busy && !entry.recapping) await stopWorker(w.sessionId).catch(() => undefined);
        }
        if (workers.length) await writeRecap(taskId, "removed");
    } catch (error) {
        console.warn(`[jarvis] recap before removing ${taskId} failed: ${(error as Error).message}`);
    }
    try {
        // The task's validation chain goes with it; task.json keeps what it was and how it last ran.
        const { retireValidation } = await import("./jarvis-validation.mjs");
        const validation = await retireValidation(taskId).catch((error: Error) => {
            console.warn(`[jarvis] validation of ${taskId} not retired: ${error.message}`);
            return null;
        });
        const { retirePrComments } = await import("./jarvis-pr-comments.mjs");
        await retirePrComments(taskId).catch((error: Error) => console.warn(`[jarvis] PR comment reviews of ${taskId} not retired: ${error.message}`));
        const { retirePrBuilds } = await import("./jarvis-pr-builds.mjs");
        await retirePrBuilds(taskId).catch((error: Error) => console.warn(`[jarvis] PR build reviews of ${taskId} not retired: ${error.message}`));
        // The task's folder and its workers' worktrees go too; read them before the rows go.
        const task = await getTask(taskId);
        const worktrees = await listWorktrees({ taskId });
        const record: Record<string, unknown> = {};
        if (validation) record.validation = validation;
        if (worktrees.length) record.worktrees = worktrees.map((w) => ({ repo: `${w.org}/${w.project}/${w.repo}`, path: w.path, branch: w.branch, base: w.base }));
        await discardWorkerSessions(await deleteTask(taskId, Object.keys(record).length ? record : undefined));
        const problems = await discardWorkspace(worktrees, task?.folder || null);
        if (problems.length) await recordEvent("task.cleanup", `Left behind after removing ${task?.title || taskId}: ${problems.join(" ")}`, { taskId });
    } catch (error) {
        console.warn(`[jarvis] removing task ${taskId} failed: ${(error as Error).message}`);
    }
    recapStates.delete(taskId);
}

let removalsResumed = false;

/** Finish removals the app was closed in the middle of. Runs once per start. */
export function resumeRemovals(): void {
    if (removalsResumed) return;
    removalsResumed = true;
    void pendingRemovals()
        .then((ids) => {
            for (const id of ids) if (!removals.has(id)) startRemoval(id);
        })
        .catch((error: Error) => console.warn(`[jarvis] pending removals not resumed: ${error.message}`));
}

/** Resolves once no removal is in flight. */
export async function removalsIdle(): Promise<void> {
    await Promise.all([...removals.values()]);
}

/**
 * Open `agency copilot --resume <id>` (or plain `copilot` without Agency) in a new console
 * window. Resolves once Windows has started it; a missing folder or shell rejects instead
 * of crashing the app.
 */
export async function spawnResumeTerminal(sessionId: string, cwd: string, title: string): Promise<void> {
    if (!isDirectory(cwd)) throw new JarvisError(`Folder not found: ${cwd}`, 409);
    const id = asJarvisId(sessionId);
    if (!id) throw new JarvisError("invalid session id");
    const { command, args } = await resumeCommand(id);
    const safeTitle = title.replace(/["^&|<>%]/g, "").slice(0, 80) || "Copilot";
    await new Promise<void>((resolve, reject) => {
        const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", "start", `"${safeTitle}"`, `"${command}"`, ...args], {
            cwd,
            detached: true,
            stdio: "ignore",
            windowsVerbatimArguments: true,
        });
        child.once("error", (error) => reject(new JarvisError(`Could not open a terminal: ${error.message}`, 500)));
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
    });
}

/** Opening the workspace does not hand off or interrupt the worker's Copilot session. */
export async function openWorkerIde(sessionId: unknown, ide: unknown): Promise<void> {
    const worker = await requireWorker(sessionId);
    await openWorkspaceIde(worker.cwd, ide);
}

/** Hand the worker's session to an interactive `copilot --resume` terminal. */
export async function openWorkerTerminal(sessionId: unknown): Promise<void> {
    const worker = await requireWorker(sessionId);
    if (isWorkerBusy(worker.sessionId)) {
        throw new JarvisError(`${worker.label} is working. Stop it or wait for its turn to end first.`, 409);
    }
    if (!isDirectory(worker.cwd)) throw new JarvisError(`${worker.label}'s folder no longer exists: ${worker.cwd}`, 409);
    // Two runtimes writing one session would interleave its history.
    await detach(worker.sessionId);
    await spawnResumeTerminal(worker.sessionId, worker.cwd, `${worker.label} (${APP_NAME} worker)`);
    inTerminal.add(worker.sessionId);
    await updateWorker(worker.sessionId, { state: "idle", summary: "Opened in a terminal." });
    await recordEvent("worker.terminal", `${worker.label} was opened in a terminal.`, {
        taskId: worker.taskId,
        sessionId: worker.sessionId,
    });
}

// ---- slash commands -----------------------------------------------------------------

/** A slash command the worker's chat can run: a CLI built-in or one of the user's skills. */
export interface WorkerCommand {
    name: string;
    aliases: string[];
    description: string;
    kind: "builtin" | "skill";
    /** What the command takes after its name; empty when it takes nothing. */
    hint: string;
    required: boolean;
    choices: Array<{ name: string; description: string }>;
    /** It can run while the worker is mid-turn. */
    duringTurn: boolean;
}

/** What running a command did, for the chat to show. */
export type CommandOutcome =
    | { kind: "sent"; display: string; notice: string | null }
    | { kind: "note"; text: string; markdown: boolean; url: string | null }
    | {
          kind: "choices";
          title: string;
          command: string;
          options: Array<{ name: string; description: string; group: string | null }>;
      };

type CommandInfo = Awaited<ReturnType<CopilotSession["rpc"]["commands"]["list"]>>["commands"][number];
type CommandResult = Awaited<ReturnType<CopilotSession["rpc"]["commands"]["invoke"]>>;

/**
 * Built-ins that don't fit a worker's chat: they move the worker to another
 * folder or mode, or schedule work the app wouldn't see.
 */
const CHAT_UNSUPPORTED: Record<string, string> = {
    cwd: "A worker stays in its folder. Start another worker for a different folder.",
    autopilot: "Autopilot mode isn't available in the worker chat.",
    plan: "Plan mode isn't available in the worker chat.",
    every: "Schedules aren't available in the worker chat.",
    after: "Schedules aren't available in the worker chat.",
    remote: "Remote control isn't available in the worker chat.",
    sandbox: "Sandbox settings aren't available in the worker chat.",
};
const MODEL_ID = /^[\w.:/-]{1,100}$/;
const NOTE_MAX = 20_000;

/** The CLI's color and link escapes, which a chat can't show. */
export function stripAnsi(text: string): string {
    return text.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** "/name rest" into the command name and its input. */
export function parseSlash(text: string): { name: string; input: string } | null {
    const m = /^\/([\w.:-]{1,100})(?:\s+([\s\S]*))?$/.exec(text.trim());
    return m ? { name: m[1].toLowerCase(), input: (m[2] || "").trim() } : null;
}

function toCommand(info: CommandInfo): WorkerCommand {
    const command: WorkerCommand = {
        name: info.name.toLowerCase(),
        aliases: (info.aliases || []).map((a) => a.toLowerCase()),
        description: info.description || "",
        kind: info.kind === "skill" ? "skill" : "builtin",
        hint: info.input?.hint?.trim() || "",
        required: !!info.input?.required,
        choices: (info.input?.choices || []).map((c) => ({ name: c.name, description: c.description || "" })),
        duringTurn: !!info.allowDuringAgentExecution,
    };
    // The app switches the model itself, so the user's saved CLI default stays as it is.
    if (command.name === "model") {
        Object.assign(command, { description: "Switch this worker's model", hint: "model", required: false, choices: [], duringTurn: true });
    }
    return command;
}

async function sessionCommands(sessionId: string): Promise<WorkerCommand[]> {
    const session = await attach(sessionId);
    const entry = live(sessionId);
    if (!entry.commands) {
        const loading = session.rpc.commands
            .list({ includeBuiltins: true, includeSkills: true, includeClientCommands: false })
            .then(({ commands }) =>
                commands
                    .filter((c) => c.kind !== "client" && !CHAT_UNSUPPORTED[c.name.toLowerCase()])
                    .map(toCommand)
                    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "builtin" ? -1 : 1)),
            );
        entry.commands = loading;
        loading.catch(() => {
            if (entry.commands === loading) entry.commands = null;
        });
    }
    return entry.commands;
}

function failure(worker: JarvisWorker, what: string, error: unknown): JarvisError {
    if (error instanceof JarvisError) return error;
    return new JarvisError(`Could not ${what} for ${worker.label}: ${(error as Error).message}`, 502);
}

/** The slash commands the worker's chat offers: the CLI's built-ins, then the user's skills. */
export async function listWorkerCommands(sessionId: unknown): Promise<WorkerCommand[]> {
    const worker = await requireWorker(sessionId);
    try {
        return await sessionCommands(worker.sessionId);
    } catch (error) {
        if (!isWorkerBusy(worker.sessionId)) await detach(worker.sessionId).catch(() => undefined);
        throw failure(worker, "read the commands", error);
    }
}

function note(text: string, markdown = false, url: string | null = null): CommandOutcome {
    // Keep the CLI's line layout; only the length is capped.
    let body = stripAnsi(text).replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
    if (body.length > NOTE_MAX) body = body.slice(0, NOTE_MAX - 1).trimEnd() + "…";
    return { kind: "note", text: body || "Done.", markdown, url };
}

async function currentWorkerModel(worker: JarvisWorker): Promise<string | null> {
    try {
        return (await sessionModelState(await attach(worker.sessionId))).model || worker.model;
    } catch {
        return worker.model;
    }
}

/** /model: a list to pick from, or a switch that keeps the conversation (and the effort, when the new model takes it). */
async function switchWorkerModel(worker: JarvisWorker, value: string): Promise<CommandOutcome> {
    const model = value.trim();
    const catalog = await runtime.catalog().catch(() => null);
    if (!model) {
        if (!catalog?.length) throw new JarvisError("Couldn't read the models your Copilot can run.", 502);
        const current = await currentWorkerModel(worker);
        return {
            kind: "choices",
            title: `Model for ${worker.label}`,
            command: "model",
            options: catalog.map((m) => ({ name: m.id, description: m.id === current ? "Current" : "", group: null })),
        };
    }
    // The session resumes for the switch, so the change shows in the chat head at once.
    await attach(worker.sessionId);
    const effort = carriedEffort(model, worker.effort || "", catalog);
    const result = await setWorkerModel(worker.sessionId, model, effort);
    const label = `${model}${effort ? ` (${effort})` : ""}`;
    return note(result.deferred ? `${worker.label} switches to ${label} when this turn ends.` : `${worker.label} now uses ${label}.`);
}

async function applyCommandResult(worker: JarvisWorker, command: WorkerCommand, result: CommandResult): Promise<CommandOutcome> {
    switch (result.kind) {
        case "text":
            return note(result.text, !!result.markdown);
        case "completed":
            return note(result.message || `/${command.name} done.`);
        case "add-timeline-entry":
            return note(result.entry.text, false, result.entry.url || null);
        case "set-plan-model":
            return note(result.message);
        case "select-subcommand":
            return {
                kind: "choices",
                title: result.title,
                command: result.command,
                options: result.options.map((o) => ({ name: o.name, description: o.description || "", group: o.group || null })),
            };
        case "set-model":
            return switchWorkerModel(worker, result.model);
        case "show-dialog":
            if (result.dialog.kind === "model-picker") return switchWorkerModel(worker, "");
            return note(`/${command.name} opens a picker the worker chat doesn't have. Run it from the Copilot CLI instead.`);
        case "agent-prompt": {
            if (result.mode && result.mode !== "interactive") {
                return note(`/${command.name} needs ${result.mode} mode, which the worker chat doesn't have. Run it from the Copilot CLI instead.`);
            }
            const task = await getTask(worker.taskId);
            if (task?.status === "done") throw new JarvisError("Reopen the task before sending its workers more work.", 409);
            if (isWorkerBusy(worker.sessionId)) {
                throw new JarvisError(`${worker.label} is still working. Wait for its turn to end, or stop it.`, 409);
            }
            const display = (result.displayPrompt || `/${command.name}`).trim();
            runTurn(worker.sessionId, result.prompt, display);
            return { kind: "sent", display, notice: result.notice ? stripAnsi(result.notice) : null };
        }
        default:
            return note(`/${command.name} ran.`);
    }
}

/**
 * Run "/name input" in the worker's session. Skills and prompt commands start a
 * turn, shown as the command rather than its expanded prompt; the rest answer
 * with text or a list of choices for the chat.
 */
export async function runWorkerCommand(sessionId: unknown, text: unknown): Promise<CommandOutcome> {
    const worker = await requireWorker(sessionId);
    const parsed = typeof text === "string" ? parseSlash(text) : null;
    if (!parsed) throw new JarvisError("Type a command, like /usage.");
    if (parsed.input.length > PROMPT_MAX) throw new JarvisError("The message is too long.");
    const unsupported = CHAT_UNSUPPORTED[parsed.name];
    if (unsupported) throw new JarvisError(unsupported);
    const commands = await listWorkerCommands(worker.sessionId);
    const command = commands.find((c) => c.name === parsed.name || c.aliases.includes(parsed.name));
    if (!command) throw new JarvisError(`Unknown command /${parsed.name}. Type / to see what ${worker.label} can run.`, 404);
    if (isWorkerBusy(worker.sessionId) && !command.duringTurn) {
        throw new JarvisError(`${worker.label} is working. Wait for its turn to end, or stop it.`, 409);
    }
    if (command.required && !parsed.input) throw new JarvisError(`/${command.name} needs ${command.hint || "more input"}.`);
    if (command.name === "model") return switchWorkerModel(worker, parsed.input);
    let result: CommandResult;
    try {
        const session = await attach(worker.sessionId);
        result = await session.rpc.commands.invoke({ name: command.name, ...(parsed.input ? { input: parsed.input } : {}) });
    } catch (error) {
        throw failure(worker, `run /${command.name}`, error);
    }
    return applyCommandResult(worker, command, result);
}

/** The worker's conversation so far (top-level user and assistant messages). */
export async function workerTranscript(sessionId: unknown): Promise<{ events: unknown[] }> {
    const worker = await requireWorker(sessionId);
    const session = await attach(worker.sessionId);
    try {
        return { events: (await session.getEvents()) as unknown[] };
    } catch (error) {
        if (!isWorkerBusy(worker.sessionId)) await detach(worker.sessionId).catch(() => undefined);
        throw error;
    }
}

export async function closeAllWorkers(): Promise<void> {
    if (janitor) clearInterval(janitor);
    janitor = null;
    await Promise.all(
        [...lives.keys()].map(async (id) => {
            const entry = lives.get(id);
            if (entry?.busy) {
                entry.stopping = true;
                await entry.session?.abort().catch(() => undefined);
            }
            await detach(id);
        }),
    );
}
