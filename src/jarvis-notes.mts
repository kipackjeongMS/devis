// The user's own notes in the Workspace: a to-do list and a quick note. They
// belong to no day and no task, and last until the user changes them. The Lead
// and every worker can read them when the user asks; the Lead can also add and
// check off to-dos and add to the quick note, and workers can add to-dos.

import { JarvisError, asJarvisId, jarvisDb } from "./jarvis-store.mjs";
import { NEED_KEY, type NeedKind } from "./jarvis-needs.mjs";
import { openableOutlookLink } from "./outlook-link.mjs";

export interface Todo {
    id: number;
    text: string;
    done: boolean;
    /** Who added it: "you", the lead (Devis), or a worker's label. */
    author: string;
    createdAt: string;
    updatedAt: string;
    doneAt: string | null;
    /** The Needs you item it came from, if it did. */
    source: TodoSource | null;
    /** Why it was checked off when it ticked itself ("no longer waiting on you"). */
    doneNote: string | null;
}

/** A Needs you item a to-do was made from: the ask's key, and enough to show and open it. */
export interface TodoSource {
    key: string;
    /** The task it's about; empty for a Teams ask. */
    taskId: string;
    /** The task's title, or the PR's for a Teams ask. */
    taskTitle: string;
    /** Who asked: a worker's label, who proposed a validation chain, or who asked in Teams. */
    who: string;
    /** Where the ask is: the message or chat in Teams, or the email in Outlook on the web. */
    link?: string;
}

/** What a to-do that ticked itself says. */
export const NEED_DONE_NOTE = "no longer waiting on you";

export interface QuickNote {
    text: string;
    /** Bumps on every change; a save names the version it started from. */
    version: number;
    updatedAt: string | null;
    updatedBy: string | null;
    /**
     * The id the page gave the user's last save. Appends leave it, so a page that finds
     * its own save id here knows that save landed and everything after it was added.
     */
    lastSaveId: string | null;
}

export const NOTES_LIMITS = {
    todoChars: 500,
    openTodos: 500,
    /** Done to-dos kept, newest first; older ones go. */
    doneTodos: 200,
    noteChars: 50_000,
};

const NOTE_KEY = "quickNote";
const now = (): string => new Date().toISOString();

type Row = Record<string, unknown>;
/** Only a link into Teams, or into Outlook on the web, is kept as where an ask is. */
const TEAMS_LINK = /^https:\/\/teams\.microsoft\.com\/l\/[\w\-.~%/?=&:+@!$'()*,;]{1,2000}$/;
/** Where an ask is: a Teams link, or an email's link in Outlook (an old one made one that opens). */
const askLink = (link: unknown): string => (typeof link === "string" && TEAMS_LINK.test(link) ? link : openableOutlookLink(link));
/** A meeting's action item (comms.mts addMeetingTodo): meet:<meeting id>:<its index>. Not a Needs you item, so it never ticks itself. */
export const MEET_KEY = /^meet:[0-9a-f]{24}:\d{1,2}$/;

function parseSource(r: Row): TodoSource | null {
    if (typeof r.source_key !== "string" || !r.source_key) return null;
    try {
        const s = JSON.parse(String(r.source_json || "{}")) as Partial<TodoSource>;
        const link = askLink(s.link);
        return { key: r.source_key, taskId: String(s.taskId || ""), taskTitle: String(s.taskTitle || ""), who: String(s.who || ""), ...(link ? { link } : {}) };
    } catch {
        return { key: r.source_key, taskId: "", taskTitle: "", who: "" };
    }
}

const toTodo = (r: Row): Todo => ({
    id: Number(r.id),
    text: String(r.text),
    done: Number(r.done) === 1,
    author: String(r.author),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    doneAt: (r.done_at as string | null) ?? null,
    source: parseSource(r),
    doneNote: (r.done_note as string | null) ?? null,
});

const clipField = (value: unknown, max = 200): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

/**
 * A Needs you item, as a request names it: its key must be one Needs you gives, and its task a real
 * id. A Teams ask has no task; it can name the message in Teams instead. A chat or email thread
 * waiting on the user names the chat in Teams or the email in Outlook; a meeting's action item
 * (meet:…) the meeting's chat.
 */
function cleanSource(value: unknown): TodoSource | null {
    if (value == null) return null;
    const s = value as Partial<Record<keyof TodoSource, unknown>>;
    const key = typeof s.key === "string" ? s.key : "";
    if (!NEED_KEY.test(key) && !MEET_KEY.test(key)) throw new JarvisError("That isn't a Needs you item.");
    if (key.startsWith("need:teams:") || key.startsWith("need:chat:") || key.startsWith("meet:")) {
        const link = typeof s.link === "string" && TEAMS_LINK.test(s.link) ? s.link : "";
        return { key, taskId: "", taskTitle: clipField(s.taskTitle), who: clipField(s.who, 80), ...(link ? { link } : {}) };
    }
    if (key.startsWith("need:mail:")) {
        const link = openableOutlookLink(s.link);
        return { key, taskId: "", taskTitle: clipField(s.taskTitle), who: clipField(s.who, 80), ...(link ? { link } : {}) };
    }
    const taskId = asJarvisId(s.taskId);
    if (!taskId) throw new JarvisError("That Needs you item has no task.");
    return { key, taskId, taskTitle: clipField(s.taskTitle), who: clipField(s.who, 80) };
}

function cleanText(value: unknown): string {
    const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    if (!text) throw new JarvisError("Write the to-do first.");
    if (text.length > NOTES_LIMITS.todoChars) throw new JarvisError(`Keep a to-do under ${NOTES_LIMITS.todoChars} characters.`);
    return text;
}

function asTodoId(value: unknown): number {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new JarvisError("Unknown to-do.");
    return id;
}

/** Open to-dos in their order, then done ones, most recently done first. */
export async function listTodos(): Promise<Todo[]> {
    const db = await jarvisDb();
    const open = db.prepare("SELECT * FROM jarvis_todos WHERE done = 0 ORDER BY position, id").all() as Row[];
    const done = db.prepare("SELECT * FROM jarvis_todos WHERE done = 1 ORDER BY done_at DESC, id DESC LIMIT ?").all(NOTES_LIMITS.doneTodos) as Row[];
    return [...open, ...done].map(toTodo);
}

async function getTodo(id: number): Promise<Todo> {
    const row = (await jarvisDb()).prepare("SELECT * FROM jarvis_todos WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new JarvisError("That to-do is gone.", 404);
    return toTodo(row);
}

/**
 * Add a to-do at the end of the open list. One made from a Needs you item (`source`) is added once:
 * while it's open, adding the same item again gives it back.
 */
export async function addTodo(text: unknown, author = "you", sourceValue?: unknown): Promise<Todo> {
    const clean = cleanText(text);
    const source = cleanSource(sourceValue);
    const db = await jarvisDb();
    if (source) {
        const open = db.prepare("SELECT id FROM jarvis_todos WHERE source_key = ? AND done = 0 ORDER BY id LIMIT 1").get(source.key) as { id: number } | undefined;
        if (open) return getTodo(Number(open.id));
    }
    const { open } = db.prepare("SELECT count(*) AS open FROM jarvis_todos WHERE done = 0").get() as { open: number };
    if (open >= NOTES_LIMITS.openTodos) throw new JarvisError(`That's ${NOTES_LIMITS.openTodos} open to-dos. Check some off first.`);
    const { last } = db.prepare("SELECT max(position) AS last FROM jarvis_todos").get() as { last: number | null };
    const at = now();
    const info = db
        .prepare("INSERT INTO jarvis_todos (text, done, position, author, created_at, updated_at, source_key, source_json) VALUES (?, 0, ?, ?, ?, ?, ?, ?)")
        .run(
            clean,
            (last ?? 0) + 1,
            author,
            at,
            at,
            source?.key ?? null,
            source ? JSON.stringify({ taskId: source.taskId, taskTitle: source.taskTitle, who: source.who, ...(source.link ? { link: source.link } : {}) }) : null,
        );
    return getTodo(Number(info.lastInsertRowid));
}

/**
 * Tick off the open to-dos made from Needs you items that are gone (`active` holds the keys still
 * there): the ask was answered, the worker moved on, the task closed. Each ticks itself once;
 * reopened, it stays open. Keys of the `skip` kinds are left alone, for when what decides them
 * couldn't be read. Returns how many were ticked.
 */
export async function settleNeedTodos(active: ReadonlySet<string>, skip: ReadonlyArray<NeedKind> = []): Promise<number> {
    const db = await jarvisDb();
    const rows = db
        .prepare("SELECT id, source_key FROM jarvis_todos WHERE done = 0 AND source_settled = 0 AND source_key LIKE 'need:%'")
        .all() as Array<{
        id: number;
        source_key: string;
    }>;
    const gone = rows.filter((r) => !active.has(r.source_key) && !skip.some((kind) => r.source_key.startsWith(`need:${kind}:`)));
    if (!gone.length) return 0;
    const at = now();
    const tick = db.prepare("UPDATE jarvis_todos SET done = 1, done_at = ?, updated_at = ?, source_settled = 1, done_note = ? WHERE id = ? AND done = 0");
    for (const r of gone) tick.run(at, at, NEED_DONE_NOTE, r.id);
    db.prepare(
        "DELETE FROM jarvis_todos WHERE done = 1 AND id NOT IN (SELECT id FROM jarvis_todos WHERE done = 1 ORDER BY done_at DESC, id DESC LIMIT ?)",
    ).run(NOTES_LIMITS.doneTodos);
    return gone.length;
}

/** Change a to-do's text, or check it off and back on. */
export async function updateTodo(idValue: unknown, change: { text?: unknown; done?: unknown }): Promise<Todo> {
    const id = asTodoId(idValue);
    const todo = await getTodo(id);
    const db = await jarvisDb();
    const at = now();
    if (change.text !== undefined) {
        db.prepare("UPDATE jarvis_todos SET text = ?, updated_at = ? WHERE id = ?").run(cleanText(change.text), at, id);
    }
    if (typeof change.done === "boolean" && change.done !== todo.done) {
        // Checked off or reopened by hand, a to-do from Needs you is the user's to keep: it never ticks itself after.
        if (todo.source) db.prepare("UPDATE jarvis_todos SET source_settled = 1 WHERE id = ?").run(id);
        if (change.done) {
            db.prepare("UPDATE jarvis_todos SET done = 1, done_at = ?, updated_at = ? WHERE id = ?").run(at, at, id);
            // Done ones past the limit go, oldest first.
            db.prepare(
                "DELETE FROM jarvis_todos WHERE done = 1 AND id NOT IN (SELECT id FROM jarvis_todos WHERE done = 1 ORDER BY done_at DESC, id DESC LIMIT ?)",
            ).run(NOTES_LIMITS.doneTodos);
        } else {
            // Reopened, it goes back to the end of the open list, and no longer says why it was done.
            const { last } = db.prepare("SELECT max(position) AS last FROM jarvis_todos WHERE done = 0").get() as { last: number | null };
            db.prepare("UPDATE jarvis_todos SET done = 0, done_at = NULL, done_note = NULL, position = ?, updated_at = ? WHERE id = ?").run(
                (last ?? 0) + 1,
                at,
                id,
            );
        }
    }
    return getTodo(id);
}

export async function deleteTodo(idValue: unknown): Promise<void> {
    const id = asTodoId(idValue);
    (await jarvisDb()).prepare("DELETE FROM jarvis_todos WHERE id = ?").run(id);
}

/** Move an open to-do one place up or down. */
export async function moveTodo(idValue: unknown, direction: unknown): Promise<void> {
    const id = asTodoId(idValue);
    if (direction !== "up" && direction !== "down") throw new JarvisError("Move a to-do up or down.");
    const todo = await getTodo(id);
    if (todo.done) return;
    const db = await jarvisDb();
    const open = db.prepare("SELECT id, position FROM jarvis_todos WHERE done = 0 ORDER BY position, id").all() as Array<{ id: number; position: number }>;
    const order = open.map((r) => Number(r.id));
    const at = order.indexOf(id);
    const to = direction === "up" ? at - 1 : at + 1;
    if (at < 0 || to < 0 || to >= order.length) return;
    [order[at], order[to]] = [order[to], order[at]];
    // Renumber the open list in its new order, so equal positions can't stall a move.
    const set = db.prepare("UPDATE jarvis_todos SET position = ? WHERE id = ?");
    order.forEach((todoId, i) => set.run(i + 1, todoId));
}

/** Remove every done to-do. */
export async function clearDoneTodos(): Promise<number> {
    const info = (await jarvisDb()).prepare("DELETE FROM jarvis_todos WHERE done = 1").run();
    return Number(info.changes ?? 0);
}

// ---- the quick note -------------------------------------------------------------------
// Each change reads the note, checks it and writes it back with no await in between, so a
// save and an agent's append can't interleave and drop one another.

type Db = Awaited<ReturnType<typeof jarvisDb>>;

function readNote(db: Db): QuickNote {
    try {
        const row = db.prepare("SELECT value FROM jarvis_meta WHERE key = ?").get(NOTE_KEY) as { value: string } | undefined;
        const saved = JSON.parse(row?.value || "null") as Partial<QuickNote> | null;
        if (saved && typeof saved.text === "string") {
            return {
                text: saved.text,
                version: Number(saved.version) || 0,
                updatedAt: saved.updatedAt ?? null,
                updatedBy: saved.updatedBy ?? null,
                lastSaveId: typeof saved.lastSaveId === "string" ? saved.lastSaveId : null,
            };
        }
    } catch {
        /* unreadable: start over */
    }
    return { text: "", version: 0, updatedAt: null, updatedBy: null, lastSaveId: null };
}

function writeNote(db: Db, current: QuickNote, text: string, by: string, lastSaveId: string | null): QuickNote {
    if (text.length > NOTES_LIMITS.noteChars) throw new JarvisError(`Keep the quick note under ${NOTES_LIMITS.noteChars.toLocaleString()} characters.`);
    const note: QuickNote = { text, version: current.version + 1, updatedAt: now(), updatedBy: by, lastSaveId };
    db.prepare("INSERT INTO jarvis_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(NOTE_KEY, JSON.stringify(note));
    return note;
}

export async function getQuickNote(): Promise<QuickNote> {
    return readNote(await jarvisDb());
}

/**
 * Save the user's edit. `base` is the version the edit started from: if the note
 * changed since (Jarvis added to it), the save is refused rather than lost.
 */
export async function saveQuickNote(text: unknown, base: unknown, saveId?: unknown): Promise<QuickNote> {
    if (typeof text !== "string") throw new JarvisError("The note must be text.");
    const db = await jarvisDb();
    const current = readNote(db);
    if (Number(base) !== current.version) throw new JarvisError("The note changed while you were editing it.", 409);
    const id = typeof saveId === "string" && /^[\w-]{1,64}$/.test(saveId) ? saveId : null;
    return writeNote(db, current, text, "you", id);
}

/** Add a dated, signed paragraph to the end of the quick note. */
export async function appendQuickNote(text: unknown, author: string): Promise<QuickNote> {
    const add = typeof text === "string" ? text.trim() : "";
    if (!add) throw new JarvisError("Put the text to add in content.");
    const db = await jarvisDb();
    const current = readNote(db);
    const stamp = new Date().toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const entry = `[${author}, ${stamp}] ${add}`;
    const next = current.text.trim() ? `${current.text.replace(/\s+$/, "")}\n\n${entry}` : entry;
    return writeNote(db, current, next, author, current.lastSaveId);
}

// ---- for agents ---------------------------------------------------------------------------

/** The notes as plain text for an agent: open to-dos with their ids, recent done ones, and the quick note. */
export async function notesForAgent(): Promise<string> {
    const [todos, note] = await Promise.all([listTodos(), getQuickNote()]);
    const open = todos.filter((t) => !t.done);
    const done = todos.filter((t) => t.done).slice(0, 10);
    const lines = ["To-dos (open, in the user's order):"];
    const from = (t: Todo) =>
        !t.source?.taskTitle ? "" : t.source.key.startsWith("meet:") ? ` (from the meeting: ${t.source.taskTitle})` : ` (from Needs you: ${t.source.taskTitle})`;
    lines.push(...(open.length ? open.map((t) => `- [${t.id}] ${t.text}${t.author !== "you" ? ` (added by ${t.author})` : ""}${from(t)}`) : ["- none"]));
    if (done.length) lines.push("", "Recently done:", ...done.map((t) => `- [${t.id}] ${t.text}`));
    lines.push("", "Quick note:", note.text.trim() ? note.text : "(empty)");
    return lines.join("\n");
}

/** One call on the notes from an agent's tool. Workers get read and add_todo; the Lead also complete_todo and append_note. */
export async function runNotesAction(author: string, args: unknown, allowed: ReadonlySet<string>): Promise<string> {
    const a = (args || {}) as { action?: unknown; text?: unknown; id?: unknown };
    const action = typeof a.action === "string" ? a.action : "";
    if (!allowed.has(action)) return `Use action ${[...allowed].join(", ")}.`;
    try {
        switch (action) {
            case "read":
                return await notesForAgent();
            case "add_todo": {
                const todo = await addTodo(a.text, author);
                return `Added to-do [${todo.id}]: ${todo.text}`;
            }
            case "complete_todo": {
                const todo = await updateTodo(a.id, { done: true });
                return `Checked off [${todo.id}]: ${todo.text}`;
            }
            case "append_note":
                await appendQuickNote(a.text, author);
                return "Added to the quick note.";
            default:
                return `Use action ${[...allowed].join(", ")}.`;
        }
    } catch (error) {
        return `Not done: ${(error as Error).message}`;
    }
}
