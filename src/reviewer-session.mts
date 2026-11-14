// Follow-ups inside the exact Copilot session that produced a PR review:
// Elaborate, rephrase-before-post and the reviewer chat. Resuming the reviewer
// session gives them the diffs, findings and reasoning it already holds instead
// of re-deriving them from a bare prompt in a throwaway session.
//
// Sessions are resumed through the shared SDK runtime and kept open for a few
// minutes so a conversation does not pay the resume cost on every message.

import { spawn } from "node:child_process";
import { defineTool, type CopilotSession, type Tool } from "@github/copilot-sdk";
import {
    explainCopilotError,
    prSessionOptions,
    replyText,
    resumeCommand,
    sendAndSettle,
    sessionWorkingDirectory,
    withCopilotClient,
} from "./copilot-runtime.mjs";
import { ADD_REVIEW_FINDINGS_SCHEMA, addReviewFindings } from "./review-publish.mjs";
import { sharedMcpServers } from "./shared-playwright.mjs";
import { chatMessagesFromEvents, type ChatMessage, type EventLike } from "./chat-transcript.mjs";
import type { WorkItem } from "./service-files.mjs";

// Strict UUID. Session ids are only ever read from the review store, but a
// looser check could still let a malformed value select a different session.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Narrow an untrusted value to a session id safe to resume. */
export function asReviewerSessionId(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const id = value.trim();
    return SESSION_ID_RE.test(id) ? id : null;
}

/** The PR a reviewer session belongs to; selects its ado/bluebird MCP scope. */
export interface ReviewerScope {
    org?: string | null;
    project?: string | null;
}

const IDLE_CLOSE_MS = 10 * 60_000;
const CHAT_TURN_TIMEOUT_MS = 30 * 60_000;

interface OpenSession {
    session: Promise<CopilotSession>;
    idleTimer: ReturnType<typeof setTimeout> | null;
}

const openSessions = new Map<string, OpenSession>();

// One turn at a time per session: concurrent sends into the same session would
// interleave in its history. Different sessions still run in parallel.
const queues = new Map<string, Promise<unknown>>();
const busy = new Map<string, number>();

function enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = queues.get(sessionId) ?? Promise.resolve();
    busy.set(sessionId, (busy.get(sessionId) || 0) + 1);
    const started = previous.then(task).finally(() => {
        const left = (busy.get(sessionId) || 1) - 1;
        if (left) busy.set(sessionId, left);
        else busy.delete(sessionId);
    });
    const tail = started.catch(() => undefined);
    queues.set(sessionId, tail);
    void tail.then(() => {
        if (queues.get(sessionId) === tail) queues.delete(sessionId);
    });
    return started;
}

function scheduleClose(sessionId: string, entry: OpenSession): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => void closeReviewerSession(sessionId), IDLE_CLOSE_MS);
    entry.idleTimer.unref?.();
}

/**
 * Follow-up tool for a resumed reviewer session: stages more findings on the
 * review it produced. `publish_review` only completes an active review job, so
 * without this the chat could discuss new findings but never record them.
 */
export function addReviewFindingsTool(): Tool<unknown> {
    return defineTool("add_review_findings", {
        description:
            "Add new findings to the review of this pull request in Devis (the app's PR detail view). Use it when the user asks you to add, flag, record or update the review with new findings. Put line-anchored comments in `findings` and PR-level concerns (behavior, concurrency, design, contract, testing) in `semanticFindings`. Write each `comment` the way the review task asked, in the user's own language when it gave their writing voice. Findings are staged for the user to post; nothing is posted to Azure DevOps and the review summary and status are unchanged. Existing findings stay as they are; do not repeat them.",
        parameters: ADD_REVIEW_FINDINGS_SCHEMA as unknown as Record<string, unknown>,
        skipPermission: true,
        defer: "never",
        // The target review comes from the invoking session, never from the input.
        handler: async (args, invocation) => (await addReviewFindings(args, invocation.sessionId)).message,
    });
}

function acquire(sessionId: string, scope: ReviewerScope): Promise<CopilotSession> {
    let entry = openSessions.get(sessionId);
    if (!entry) {
        const options = prSessionOptions(scope.org || "", scope.project || "");
        const session = withCopilotClient((client) =>
            client.resumeSession(sessionId, {
                ...options,
                mcpServers: scope.org && scope.project ? options.mcpServers : sharedMcpServers(),
                skipCustomInstructions: true,
                streaming: true,
                tools: [addReviewFindingsTool()],
            }),
        ).then(async (resumed) => {
            await ensureInteractiveMode(resumed).catch((error: Error) =>
                console.warn(`[ado-pr-ops] could not switch ${sessionId} to interactive mode: ${error.message}`),
            );
            return resumed;
        });
        const created: OpenSession = { session, idleTimer: null };
        openSessions.set(sessionId, created);
        session.catch(() => {
            if (openSessions.get(sessionId) === created) {
                if (created.idleTimer) clearTimeout(created.idleTimer);
                openSessions.delete(sessionId);
            }
        });
        entry = created;
    }
    scheduleClose(sessionId, entry);
    return entry.session;
}

/**
 * Sessions started in autopilot (e.g. by the retired extension) resume in autopilot,
 * where sendAndWait ignores session.idle and the runtime adds task_complete nudges.
 */
export async function ensureInteractiveMode(session: {
    rpc: { mode: Pick<CopilotSession["rpc"]["mode"], "get" | "set"> };
}): Promise<void> {
    if ((await session.rpc.mode.get()) !== "autopilot") return;
    await session.rpc.mode.set({ mode: "interactive", expectedMode: "autopilot" });
}

// The CLI can delete sessions (cleanup, archive), and a deleted session cannot be
// resumed. Answers are cached for a while, and the cache is capped.
const sessionExists = new Map<string, { at: number; known: Promise<boolean> }>();
const EXISTS_TTL_MS = 10 * 60_000;
const EXISTS_MAX = 500;

/** Whether the Copilot CLI still has this session. */
export function reviewerSessionExists(sessionId: string): Promise<boolean> {
    if (openSessions.has(sessionId)) return Promise.resolve(true);
    const cached = sessionExists.get(sessionId);
    if (cached && Date.now() - cached.at < EXISTS_TTL_MS) return cached.known;
    sessionExists.delete(sessionId);
    const known = withCopilotClient((client) => client.getSessionMetadata(sessionId)).then((metadata) => !!metadata);
    sessionExists.set(sessionId, { at: Date.now(), known });
    known.catch(() => sessionExists.delete(sessionId));
    // Oldest first: a Map keeps insertion order.
    while (sessionExists.size > EXISTS_MAX) sessionExists.delete(sessionExists.keys().next().value!);
    return known;
}

/** Release a resumed session so another process (a terminal) can take it over. */
export async function closeReviewerSession(sessionId: string): Promise<void> {
    const entry = openSessions.get(sessionId);
    if (!entry) return;
    openSessions.delete(sessionId);
    // A reply still streaming keeps its state until it settles.
    if (!chatStates.get(sessionId)?.pending) chatStates.delete(sessionId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try {
        await (await entry.session).disconnect();
    } catch {
        /* already gone */
    }
}

export async function closeAllReviewerSessions(): Promise<void> {
    await Promise.all([...openSessions.keys()].map((id) => closeReviewerSession(id)));
}

export function isReviewerSessionBusy(sessionId: string): boolean {
    return busy.has(sessionId);
}

/** Reviewer chat replies, asks and rephrases in flight, for the background service's idle check. */
export function reviewerActivity(): WorkItem[] {
    return [...busy.keys()].map((id) => ({ kind: "reviewer", label: `Reviewer session ${id.slice(0, 8)}` }));
}

export interface ReviewerSessionRun extends ReviewerScope {
    sessionId: string;
    prompt: string;
    timeoutMs?: number;
}

/**
 * Send `prompt` to an existing reviewer session and resolve with its reply.
 * The model is deliberately not overridden: the session keeps whatever model
 * it reviewed with.
 */
export function runInReviewerSession(run: ReviewerSessionRun): Promise<string> {
    const sessionId = asReviewerSessionId(run.sessionId);
    if (!sessionId) return Promise.reject(new Error("invalid reviewer session id"));
    return enqueue(sessionId, async () => {
        const session = await acquire(sessionId, run);
        let text = "";
        try {
            text = replyText(
                await sendAndSettle(session, { prompt: run.prompt }, run.timeoutMs ?? 180_000, {
                    onMissedIdle: () => console.warn(`[reviewer] ${sessionId}'s turn ended without session.idle; picked up from the runtime`),
                }),
            );
        } catch (error) {
            await session.abort().catch(() => undefined);
            throw new Error(`reviewer session ${sessionId} failed: ${(error as Error).message}`);
        }
        if (!text) throw new Error("reviewer session returned an empty reply");
        return text;
    });
}

// ---- reviewer chat ----------------------------------------------------------

export { ChatTranscript, chatMessagesFromEvents, REVIEW_TASK_LABEL, type ChatMessage, type EventLike } from "./chat-transcript.mjs";

interface ChatState {
    pending: boolean;
    partial: string;
    error: string | null;
}

const chatStates = new Map<string, ChatState>();

export interface ReviewerChat {
    messages: ChatMessage[];
    pending: boolean;
    partial: string;
    error: string | null;
}

export async function getReviewerChat(sessionId: string, scope: ReviewerScope): Promise<ReviewerChat> {
    const id = asReviewerSessionId(sessionId);
    if (!id) throw new Error("invalid reviewer session id");
    const session = await acquire(id, scope);
    const messages = chatMessagesFromEvents((await session.getEvents()) as unknown as EventLike[]);
    const state = chatStates.get(id);
    return {
        messages,
        pending: !!state?.pending,
        partial: state?.partial || "",
        error: state?.error || null,
    };
}

/** Queue a chat message; the reply streams into the chat state. */
export function sendReviewerChat(sessionId: string, scope: ReviewerScope, text: string): void {
    const id = asReviewerSessionId(sessionId);
    if (!id) throw new Error("invalid reviewer session id");
    const state: ChatState = { pending: true, partial: "", error: null };
    chatStates.set(id, state);
    const settle = (error: string | null) => {
        state.pending = false;
        state.partial = "";
        state.error = error;
        // A clean finish leaves nothing to show; only an error is kept for the chat to read.
        if (!error && chatStates.get(id) === state) chatStates.delete(id);
    };
    void enqueue(id, async () => {
        const session = await acquire(id, scope);
        const off = session.on("assistant.message_delta", (event) => {
            if (!event.data.parentToolCallId) state.partial += event.data.deltaContent;
        });
        try {
            await sendAndSettle(session, { prompt: text }, CHAT_TURN_TIMEOUT_MS, {
                onMissedIdle: () => console.warn(`[reviewer] ${id}'s chat turn ended without session.idle; picked up from the runtime`),
            });
        } catch (error) {
            await session.abort().catch(() => undefined);
            throw error;
        } finally {
            off();
        }
    }).then(
        () => settle(null),
        (error: Error) => settle(explainCopilotError(error.message || "") || "The reviewer did not reply."),
    );
}

/** Reopen a reviewer session in an interactive `agency copilot --resume` terminal. */
export async function openReviewerTerminal(sessionId: string, title: string): Promise<void> {
    const id = asReviewerSessionId(sessionId);
    if (!id) throw new Error("invalid reviewer session id");
    if (isReviewerSessionBusy(id)) {
        throw new Error("The reviewer is still answering. Try again when it finishes.");
    }
    // Two runtimes writing one session would interleave its history.
    await closeReviewerSession(id);
    const { command, args } = await resumeCommand(id);
    const safeTitle = title.replace(/["^&|<>%]/g, "").slice(0, 80) || "Copilot reviewer";
    const child = spawn(
        process.env.ComSpec || "cmd.exe",
        ["/d", "/c", "start", `"${safeTitle}"`, `"${command}"`, ...args],
        {
            cwd: sessionWorkingDirectory(),
            detached: true,
            stdio: "ignore",
            windowsVerbatimArguments: true,
        },
    );
    child.unref();
}
