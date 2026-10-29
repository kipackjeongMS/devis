// Status updates: short, timestamped lines that build up a task's day. Workers
// post one at the end of a turn, the Lead posts one when asked, and the user
// posts from a task card. Every path goes through postStatus so the rules hold
// everywhere: one clean line, no repeats, a daily cap, and a line in history.
// The timeline is the task's progress record; note.md is not.

import {
    JarvisError,
    asJarvisId,
    countStatuses,
    getTask,
    latestStatuses,
    insertStatus,
    recordEvent,
    type StatusUpdate,
} from "./jarvis-store.mjs";

export const STATUS_MAX = 160;
/** A runaway worker can't flood a task's timeline. */
export const STATUS_DAILY_CAP = 100;
/** The same line from the same author within this window is a repeat. */
const REPEAT_WINDOW_MS = 10 * 60_000;

/** Only ~160 characters survive, so longer input is cut before any pattern runs on it. */
const INPUT_MAX = 1000;

/** Strip Markdown emphasis only where it wraps words, so my_func_name and a*b stay intact. */
export function stripEmphasis(text: string): string {
    return text
        .replace(/(^|[^\w*])(\*\*|__)(?=\S)(.+?)(?<=\S)\2(?![\w*])/g, "$1$3")
        .replace(/(^|[^\w*])([*_])(?=\S)(.+?)(?<=\S)\2(?![\w*])/g, "$1$3");
}

/** One plain line: whitespace collapsed, list and heading markers dropped, clipped. */
export function cleanStatusText(value: unknown): string {
    if (typeof value !== "string") return "";
    const flat = value
        .slice(0, INPUT_MAX)
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^(?:[-*+•]\s+|#{1,6}\s+|>\s+)+/, "");
    // Code spans keep their text as written (`__init__.py`); emphasis is stripped around them.
    const spans: string[] = [];
    const masked = flat.replace(/`([^`]*)`/g, (_, code: string) => `\u0000${spans.push(code) - 1}\u0000`);
    let text = stripEmphasis(masked)
        .replace(/\u0000(\d+)\u0000/g, (_, i: string) => spans[Number(i)] ?? "")
        .trim();
    if (text.length > STATUS_MAX) text = text.slice(0, STATUS_MAX - 1).trimEnd() + "…";
    return text;
}

/** Sentences from the start of a line until there's enough to say something. */
function leadingSentences(line: string, min = 24): string {
    let out = "";
    let rest = line;
    while (rest) {
        const m = /^(.+?[.!?])(?:\s+|$)/.exec(rest);
        const piece = m ? m[1] : rest;
        out = out ? `${out} ${piece}` : piece;
        rest = m ? rest.slice(m[0].length) : "";
        if (out.length >= min) break;
    }
    return out;
}

/**
 * A status line from a turn's closing summary. Headings, bold labels and
 * lead-ins ("Here is what I did:") are skipped; the first real line gives its
 * opening sentence. Empty when the summary has nothing usable.
 */
export function statusFromSummary(summary: string): string {
    let inFence = false;
    for (const line of String(summary ?? "").slice(0, 50_000).split(/\r?\n/)) {
        const raw = line.trim().slice(0, INPUT_MAX);
        if (/^(?:```|~~~)/.test(raw)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        if (!raw || /^#{1,6}\s/.test(raw) || /^(?:-{3,}|\*{3,}|_{3,}|\|.*\|)$/.test(raw)) continue;
        if (/^(\*\*|__)[^*_]+\1:?$/.test(raw)) continue;
        // A bold label in front of the text: "**Summary:** Fixed the build."
        const unlabeled = raw.replace(/^(\*\*|__)[^*_\n]{1,60}?(?::\1|\1:)\s+(?=\S)/, "");
        const plain = cleanStatusText(unlabeled.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"));
        if (!plain || /:$/.test(plain)) continue;
        // Already clean; a second pass would strip emphasis from code that lost its backticks.
        return leadingSentences(plain).trim();
    }
    return "";
}

export interface PostStatus {
    taskId: unknown;
    text: unknown;
    author: string;
    sessionId?: string | null;
}

/** Post a status line. A repeat of the author's last line returns that line instead. */
export async function postStatus(input: PostStatus): Promise<{ status: StatusUpdate; created: boolean }> {
    const taskId = asJarvisId(input.taskId);
    const task = taskId ? await getTask(taskId) : null;
    if (!task) throw new JarvisError("Task not found.", 404);
    const text = cleanStatusText(input.text);
    if (!text) throw new JarvisError("Write a short status line.");
    const author = cleanStatusText(input.author).slice(0, 60) || "you";

    const last = (await latestStatuses([task.id])).get(task.id);
    if (
        last &&
        last.author === author &&
        last.text.toLowerCase() === text.toLowerCase() &&
        Date.now() - Date.parse(last.at) < REPEAT_WINDOW_MS
    ) {
        return { status: last, created: false };
    }
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    if ((await countStatuses(task.id, dayStart.toISOString())) >= STATUS_DAILY_CAP) {
        throw new JarvisError(`This task already has ${STATUS_DAILY_CAP} updates today.`, 429);
    }

    const status = await insertStatus({ taskId: task.id, author, sessionId: input.sessionId ?? null, text });
    await recordEvent("task.status", `${author}: ${text}`, {
        taskId: task.id,
        sessionId: input.sessionId ?? null,
        ref: { statusId: status.id },
    });
    return { status, created: true };
}
