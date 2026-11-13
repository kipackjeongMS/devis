// The user's own notes in the Workspace: a to-do list and a quick note. They
// belong to no day and no task, and last until the user changes them. A to-do
// can have subtasks, to any depth, and a due date; a top-level one can have a
// priority, and a task can be started from it. The Lead and every worker can
// read them when the user asks; the Lead can also add and check off to-dos and
// add to the quick note, and workers can add to-dos. Both can add subtasks and
// set due dates.

import { JarvisError, asJarvisId, getTask, jarvisDb, onTaskDone } from "./jarvis-store.mjs";
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
    /** The to-do it's a subtask of; null for a top-level one. */
    parentId: number | null;
    /** The day it's due, YYYY-MM-DD, with no time. */
    due: string | null;
    /** 3 high, 2 medium, 1 low, 0 none. Only a top-level to-do has one. */
    priority: number;
    /** The task last started from it. */
    taskId: string | null;
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
    parentId: r.parent_id == null ? null : Number(r.parent_id),
    due: typeof r.due === "string" && r.due ? r.due : null,
    priority: Number(r.priority) || 0,
    taskId: typeof r.task_id === "string" && r.task_id ? r.task_id : null,
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

type Db = Awaited<ReturnType<typeof jarvisDb>>;

/** Run `fn` as one transaction, so a cascade lands whole or not at all. */
function inTransaction<T>(db: Db, fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
        const result = fn();
        db.exec("COMMIT");
        return result;
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}

const DUE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A due date: a real calendar day, YYYY-MM-DD. Empty or null clears it. */
export function cleanDue(value: unknown): string | null {
    if (value == null || value === "") return null;
    const m = typeof value === "string" ? DUE.exec(value.trim()) : null;
    if (!m) throw new JarvisError("Give the due date as YYYY-MM-DD.");
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const day = new Date(Date.UTC(y, mo - 1, d));
    if (y < 2000 || y > 2100 || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) throw new JarvisError("That isn't a real date.");
    return m[0];
}

/** Priorities, highest first. Only a top-level to-do has one; 0 is none. */
export const TODO_PRIORITIES = { high: 3, medium: 2, low: 1, none: 0 } as const;

function cleanPriority(value: unknown): number {
    const named = typeof value === "string" && value in TODO_PRIORITIES ? TODO_PRIORITIES[value as keyof typeof TODO_PRIORITIES] : value;
    const p = Number(named);
    if (!Number.isInteger(p) || p < 0 || p > 3) throw new JarvisError("Priority is high, medium, low or none.");
    return p;
}

function rowById(db: Db, id: number): Row {
    const row = db.prepare("SELECT * FROM jarvis_todos WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new JarvisError("That to-do is gone.", 404);
    return row;
}

/** A row's parent, if it still has one; a to-do whose parent is gone counts as top-level. */
function parentOf(db: Db, row: Row): number | null {
    if (row.parent_id == null) return null;
    const parent = db.prepare("SELECT id FROM jarvis_todos WHERE id = ?").get(Number(row.parent_id)) as { id: number } | undefined;
    return parent ? Number(parent.id) : null;
}

/** Every to-do under `id`, at any depth. */
function descendantIds(db: Db, id: number): number[] {
    const rows = db
        .prepare(
            `WITH RECURSIVE sub(id) AS (
                SELECT id FROM jarvis_todos WHERE parent_id = ?
                UNION SELECT t.id FROM jarvis_todos t JOIN sub ON t.parent_id = sub.id)
             SELECT id FROM sub`,
        )
        .all(id) as Array<{ id: number }>;
    return rows.map((r) => Number(r.id));
}

/** The to-dos above `id`, nearest first. */
function ancestorIds(db: Db, id: number): number[] {
    const out: number[] = [];
    const seen = new Set([id]);
    let row = rowById(db, id);
    for (let parent = parentOf(db, row); parent != null && !seen.has(parent); parent = parentOf(db, row)) {
        out.push(parent);
        seen.add(parent);
        row = rowById(db, parent);
    }
    return out;
}

const nextPosition = (db: Db): number => {
    const { last } = db.prepare("SELECT max(position) AS last FROM jarvis_todos").get() as { last: number | null };
    return (last ?? 0) + 1;
};

/** Tick `id` and everything open under it. Only `id` gets `note`; its subtasks just follow it. */
function tickSubtree(db: Db, id: number, at: string, note: string | null): void {
    db.prepare("UPDATE jarvis_todos SET done = 1, done_at = ?, updated_at = ?, done_note = ? WHERE id = ? AND done = 0").run(at, at, note, id);
    const tick = db.prepare("UPDATE jarvis_todos SET done = 1, done_at = ?, updated_at = ?, done_note = NULL WHERE id = ? AND done = 0");
    for (const sub of descendantIds(db, id)) tick.run(at, at, sub);
}

/** Done top-level to-dos past the limit go, oldest first, with their subtasks. */
function pruneDone(db: Db): void {
    db.prepare(
        `WITH RECURSIVE roots(id, done_at) AS (
            SELECT t.id, t.done_at FROM jarvis_todos t LEFT JOIN jarvis_todos p ON p.id = t.parent_id
            WHERE t.done = 1 AND p.id IS NULL),
         gone(id) AS (
            SELECT id FROM roots WHERE id NOT IN (SELECT id FROM roots ORDER BY done_at DESC, id DESC LIMIT ?)
            UNION SELECT t.id FROM jarvis_todos t JOIN gone ON t.parent_id = gone.id)
         DELETE FROM jarvis_todos WHERE id IN (SELECT id FROM gone)`,
    ).run(NOTES_LIMITS.doneTodos);
}

/**
 * Every to-do as one list, depth first: each top-level to-do, then its subtasks under it.
 * Open top-level ones come first, by priority and then the user's order; done ones follow,
 * most recently done first. Subtasks keep their order whether or not they're done.
 */
function treeOrder(rows: Row[]): Todo[] {
    const todos = rows.map(toTodo);
    const pos = new Map(rows.map((r) => [Number(r.id), Number(r.position) || 0]));
    const byId = new Map(todos.map((t) => [t.id, t]));
    const kids = new Map<number, Todo[]>();
    const roots: Todo[] = [];
    for (const t of todos) {
        if (t.parentId != null && byId.has(t.parentId)) {
            const list = kids.get(t.parentId) || [];
            list.push(t);
            kids.set(t.parentId, list);
        } else roots.push(t);
    }
    const inOrder = (a: Todo, b: Todo) => pos.get(a.id)! - pos.get(b.id)! || a.id - b.id;
    const open = roots.filter((t) => !t.done).sort((a, b) => b.priority - a.priority || inOrder(a, b));
    const done = roots
        .filter((t) => t.done)
        .sort((a, b) => (b.doneAt || "").localeCompare(a.doneAt || "") || b.id - a.id)
        .slice(0, NOTES_LIMITS.doneTodos);
    const out: Todo[] = [];
    const seen = new Set<number>();
    const walk = (t: Todo): void => {
        if (seen.has(t.id)) return;
        seen.add(t.id);
        out.push(t);
        for (const k of (kids.get(t.id) || []).sort(inOrder)) walk(k);
    };
    for (const t of [...open, ...done]) walk(t);
    return out;
}

/** Every to-do, top-level ones each followed by their subtasks (see treeOrder). */
export async function listTodos(): Promise<Todo[]> {
    const db = await jarvisDb();
    return treeOrder(db.prepare("SELECT * FROM jarvis_todos").all() as Row[]);
}

async function getTodo(id: number): Promise<Todo> {
    return toTodo(rowById(await jarvisDb(), id));
}

/**
 * Add a to-do at the end of the open list, or a subtask at the end of `parentId`'s. One made from a
 * Needs you item (`source`) is added once: while it's open, adding the same item again gives it back.
 */
export async function addTodo(
    text: unknown,
    author = "you",
    sourceValue?: unknown,
    extra: { parentId?: unknown; due?: unknown } = {},
): Promise<Todo> {
    const clean = cleanText(text);
    const source = cleanSource(sourceValue);
    const due = cleanDue(extra.due);
    const parentId = extra.parentId == null || extra.parentId === "" ? null : asTodoId(extra.parentId);
    const db = await jarvisDb();
    if (parentId != null) {
        if (source) throw new JarvisError("A to-do from Needs you goes at the top of the list.");
        if (Number(rowById(db, parentId).done) === 1) throw new JarvisError("That to-do is done. Reopen it to add a subtask.");
    }
    if (source) {
        const open = db.prepare("SELECT id FROM jarvis_todos WHERE source_key = ? AND done = 0 ORDER BY id LIMIT 1").get(source.key) as { id: number } | undefined;
        if (open) return getTodo(Number(open.id));
    }
    const { open } = db.prepare("SELECT count(*) AS open FROM jarvis_todos WHERE done = 0").get() as { open: number };
    if (open >= NOTES_LIMITS.openTodos) throw new JarvisError(`That's ${NOTES_LIMITS.openTodos} open to-dos. Check some off first.`);
    const at = now();
    const info = db
        .prepare(
            "INSERT INTO jarvis_todos (text, done, position, author, created_at, updated_at, source_key, source_json, parent_id, due) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
            clean,
            nextPosition(db),
            author,
            at,
            at,
            source?.key ?? null,
            source ? JSON.stringify({ taskId: source.taskId, taskTitle: source.taskTitle, who: source.who, ...(source.link ? { link: source.link } : {}) }) : null,
            parentId,
            due,
        );
    return getTodo(Number(info.lastInsertRowid));
}

/**
 * Tick off the open to-dos made from Needs you items that are gone (`active` holds the keys still
 * there): the ask was answered, the worker moved on, the task closed. Each ticks itself once, with
 * its subtasks; reopened, it stays open. Keys of the `skip` kinds are left alone, for when what
 * decides them couldn't be read. Returns how many were ticked.
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
    inTransaction(db, () => {
        const settle = db.prepare("UPDATE jarvis_todos SET source_settled = 1 WHERE id = ?");
        for (const r of gone) {
            tickSubtree(db, Number(r.id), at, NEED_DONE_NOTE);
            settle.run(r.id);
        }
        pruneDone(db);
    });
    return gone.length;
}

/**
 * Change a to-do: its text, due date or priority, or check it off and back on. Checking one off
 * checks off everything under it; reopening one reopens the to-dos above it, since an open
 * subtask can't sit under a done to-do. Only a top-level to-do has a priority.
 */
export async function updateTodo(
    idValue: unknown,
    change: { text?: unknown; done?: unknown; due?: unknown; priority?: unknown },
): Promise<Todo> {
    const id = asTodoId(idValue);
    const db = await jarvisDb();
    const row = rowById(db, id);
    const text = change.text !== undefined ? cleanText(change.text) : undefined;
    const due = change.due !== undefined ? cleanDue(change.due) : undefined;
    const priority = change.priority !== undefined ? cleanPriority(change.priority) : undefined;
    const isRoot = parentOf(db, row) == null;
    if (priority !== undefined && priority !== 0 && !isRoot) throw new JarvisError("Only top-level to-dos have a priority.");
    const at = now();
    inTransaction(db, () => {
        if (text !== undefined) db.prepare("UPDATE jarvis_todos SET text = ?, updated_at = ? WHERE id = ?").run(text, at, id);
        if (due !== undefined) db.prepare("UPDATE jarvis_todos SET due = ?, updated_at = ? WHERE id = ?").run(due, at, id);
        if (priority !== undefined && priority !== Number(row.priority)) {
            // A new priority puts it at the end of that priority's to-dos.
            db.prepare("UPDATE jarvis_todos SET priority = ?, position = ?, updated_at = ? WHERE id = ?").run(priority, nextPosition(db), at, id);
        }
        const wasDone = Number(row.done) === 1;
        if (typeof change.done !== "boolean" || change.done === wasDone) return;
        // Checked off or reopened by hand, a to-do from Needs you is the user's to keep: it never ticks itself after.
        if (row.source_key) db.prepare("UPDATE jarvis_todos SET source_settled = 1 WHERE id = ?").run(id);
        if (change.done) {
            tickSubtree(db, id, at, null);
            pruneDone(db);
            return;
        }
        // Reopened, it no longer says why it was done; a top-level one goes to the end of the open list.
        const reopen = (todoId: number, root: boolean) =>
            root
                ? db
                      .prepare("UPDATE jarvis_todos SET done = 0, done_at = NULL, done_note = NULL, position = ?, updated_at = ? WHERE id = ?")
                      .run(nextPosition(db), at, todoId)
                : db.prepare("UPDATE jarvis_todos SET done = 0, done_at = NULL, done_note = NULL, updated_at = ? WHERE id = ?").run(at, todoId);
        reopen(id, isRoot);
        const above = ancestorIds(db, id);
        above.forEach((up, i) => {
            const upRow = rowById(db, up);
            if (Number(upRow.done) !== 1) return;
            reopen(up, i === above.length - 1);
            if (upRow.source_key) db.prepare("UPDATE jarvis_todos SET source_settled = 1 WHERE id = ?").run(up);
        });
    });
    return getTodo(id);
}

/** Delete a to-do and everything under it. */
export async function deleteTodo(idValue: unknown): Promise<void> {
    const id = asTodoId(idValue);
    const db = await jarvisDb();
    inTransaction(db, () => {
        const del = db.prepare("DELETE FROM jarvis_todos WHERE id = ?");
        for (const sub of descendantIds(db, id)) del.run(sub);
        del.run(id);
    });
}

/**
 * Move a to-do one place up or down among its siblings: an open top-level to-do among the others
 * of its priority, a subtask among its parent's subtasks. Done top-level to-dos keep their order.
 */
export async function moveTodo(idValue: unknown, direction: unknown): Promise<void> {
    const id = asTodoId(idValue);
    if (direction !== "up" && direction !== "down") throw new JarvisError("Move a to-do up or down.");
    const db = await jarvisDb();
    const row = rowById(db, id);
    const parent = parentOf(db, row);
    let order: number[];
    if (parent == null) {
        if (Number(row.done) === 1) return;
        const peers = db
            .prepare(
                `SELECT t.id FROM jarvis_todos t LEFT JOIN jarvis_todos p ON p.id = t.parent_id
                 WHERE p.id IS NULL AND t.done = 0 AND t.priority = ? ORDER BY t.position, t.id`,
            )
            .all(Number(row.priority)) as Array<{ id: number }>;
        order = peers.map((r) => Number(r.id));
    } else {
        const peers = db.prepare("SELECT id FROM jarvis_todos WHERE parent_id = ? ORDER BY position, id").all(parent) as Array<{ id: number }>;
        order = peers.map((r) => Number(r.id));
    }
    const at = order.indexOf(id);
    const to = direction === "up" ? at - 1 : at + 1;
    if (at < 0 || to < 0 || to >= order.length) return;
    [order[at], order[to]] = [order[to], order[at]];
    // Renumber the siblings in their new order, so equal positions can't stall a move.
    inTransaction(db, () => {
        const set = db.prepare("UPDATE jarvis_todos SET position = ? WHERE id = ?");
        order.forEach((todoId, i) => set.run(i + 1, todoId));
    });
}

/** Remove every done top-level to-do, with its subtasks. Done subtasks of open to-dos stay. Returns how many rows went. */
export async function clearDoneTodos(): Promise<number> {
    const info = (await jarvisDb())
        .prepare(
            `WITH RECURSIVE gone(id) AS (
                SELECT t.id FROM jarvis_todos t LEFT JOIN jarvis_todos p ON p.id = t.parent_id WHERE t.done = 1 AND p.id IS NULL
                UNION SELECT t.id FROM jarvis_todos t JOIN gone ON t.parent_id = gone.id)
             DELETE FROM jarvis_todos WHERE id IN (SELECT id FROM gone)`,
        )
        .run();
    return Number(info.changes ?? 0);
}

// ---- starting a task from to-dos -----------------------------------------------------------

/** Workers one start makes, at most. */
export const TODO_START_MAX_WORKERS = 8;

const PRIORITY_NAME: Record<number, string> = { 3: "high", 2: "medium", 1: "low" };

/** A to-do's line for an agent: its id, text, and priority, due date and task if it has them. */
function agentLine(t: Todo, depth: number, taskTitle?: (id: string) => string | null): string {
    const bits: string[] = [];
    if (t.done) bits.push("done");
    if (PRIORITY_NAME[t.priority]) bits.push(`${PRIORITY_NAME[t.priority]} priority`);
    if (t.due) bits.push(`due ${t.due}`);
    const task = t.taskId ? taskTitle?.(t.taskId) : null;
    if (task) bits.push(`task: ${task}`);
    if (t.author !== "you") bits.push(`added by ${t.author}`);
    const from = !t.source?.taskTitle ? "" : t.source.key.startsWith("meet:") ? `from the meeting: ${t.source.taskTitle}` : `from Needs you: ${t.source.taskTitle}`;
    if (from) bits.push(from);
    return `${"  ".repeat(depth)}- [${t.id}] ${t.text}${bits.length ? ` (${bits.join(", ")})` : ""}`;
}

/** `ids` and everything under each of them, as indented lines in the list's order. */
function subtreeLines(all: Todo[], ids: number[], taskTitle?: (id: string) => string | null): string[] {
    const byId = new Map(all.map((t) => [t.id, t]));
    const lines: string[] = [];
    for (const id of ids) {
        const top = byId.get(id);
        if (!top) continue;
        const depthOf = new Map([[top.id, 0]]);
        const start = all.indexOf(top);
        lines.push(agentLine(top, 0, taskTitle));
        // Its subtasks follow it in the list until the next to-do that isn't under it.
        for (let i = start + 1; i < all.length; i++) {
            const t = all[i];
            const parentDepth = t.parentId != null ? depthOf.get(t.parentId) : undefined;
            if (parentDepth === undefined) break;
            depthOf.set(t.id, parentDepth + 1);
            lines.push(agentLine(t, parentDepth + 1, taskTitle));
        }
    }
    return lines;
}

export interface TodoStartPlan {
    /** Each worker's to-dos: the topmost ones picked, each bringing its subtasks. */
    groups: number[][];
    /** Every picked to-do, in the list's order. */
    todos: Todo[];
    /** The to-dos as indented lines, for the task's description. */
    outline: string;
    /** Each group's to-dos as indented lines, for that worker's prompt. */
    groupOutlines: string[];
}

/**
 * Check the to-dos a task is started from, split into one group per worker. Each must be open.
 * A to-do picked twice counts once, in its first group; one under another picked to-do goes
 * with it, so a whole subtree always goes to one worker.
 */
export async function planTodoStart(value: unknown): Promise<TodoStartPlan> {
    if (!Array.isArray(value) || !value.length || !value.every(Array.isArray)) throw new JarvisError("Pick the to-dos to start from.");
    if (value.length > TODO_START_MAX_WORKERS) throw new JarvisError(`Start at most ${TODO_START_MAX_WORKERS} workers at once.`);
    const all = await listTodos();
    const byId = new Map(all.map((t) => [t.id, t]));
    const picked = new Set<number>();
    const groups: number[][] = [];
    for (const group of value as unknown[][]) {
        const ids: number[] = [];
        for (const raw of group) {
            const id = asTodoId(raw);
            const todo = byId.get(id);
            if (!todo) throw new JarvisError("One of those to-dos is gone.", 404);
            if (todo.done) throw new JarvisError(`"${todo.text}" is done. Reopen it to start from it.`);
            if (picked.has(id)) continue;
            picked.add(id);
            ids.push(id);
        }
        groups.push(ids);
    }
    // A picked to-do under another picked one goes with that one.
    const under = (id: number): boolean => {
        const seen = new Set<number>();
        for (let p = byId.get(id)?.parentId; p != null && !seen.has(p); p = byId.get(p)?.parentId) {
            if (picked.has(p)) return true;
            seen.add(p);
        }
        return false;
    };
    const order = new Map(all.map((t, i) => [t.id, i]));
    const tops = groups.map((ids) => ids.filter((id) => !under(id)).sort((a, b) => order.get(a)! - order.get(b)!)).filter((ids) => ids.length);
    if (!tops.length) throw new JarvisError("Pick the to-dos to start from.");
    const todos = tops
        .flat()
        .sort((a, b) => order.get(a)! - order.get(b)!)
        .map((id) => byId.get(id)!);
    return {
        groups: tops,
        todos,
        outline: subtreeLines(
            all,
            todos.map((t) => t.id),
        ).join("\n"),
        groupOutlines: tops.map((ids) => subtreeLines(all, ids).join("\n")),
    };
}

/** Note on each to-do which task was started from it, so it shows the task and ticks when the task is done. */
export async function linkTodosToTask(ids: number[], taskId: string): Promise<void> {
    const db = await jarvisDb();
    const at = now();
    inTransaction(db, () => {
        const link = db.prepare("UPDATE jarvis_todos SET task_id = ?, updated_at = ? WHERE id = ?");
        for (const id of ids) link.run(taskId, at, id);
    });
}

/** What a to-do says when its task being done ticked it. */
export const TASK_DONE_NOTE = "its task is done";

/** Tick the open to-dos a task was started from, with their subtasks. Returns how many were ticked. */
export async function tickTaskTodos(taskId: string): Promise<number> {
    const db = await jarvisDb();
    const rows = db.prepare("SELECT id, source_key FROM jarvis_todos WHERE task_id = ? AND done = 0").all(taskId) as Array<{ id: number; source_key: string | null }>;
    if (!rows.length) return 0;
    const at = now();
    inTransaction(db, () => {
        for (const r of rows) {
            tickSubtree(db, Number(r.id), at, TASK_DONE_NOTE);
            if (r.source_key) db.prepare("UPDATE jarvis_todos SET source_settled = 1 WHERE id = ?").run(r.id);
        }
        pruneDone(db);
    });
    return rows.length;
}

onTaskDone((task) => {
    void tickTaskTodos(task.id).catch((error) => console.warn(`[jarvis] task's to-dos not ticked: ${(error as Error).message}`));
});

// ---- the quick note -------------------------------------------------------------------
// Each change reads the note, checks it and writes it back with no await in between, so a
// save and an agent's append can't interleave and drop one another.

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

/** The notes as plain text for an agent: open to-dos with their ids and subtasks, recent done ones, and the quick note. */
export async function notesForAgent(): Promise<string> {
    const [todos, note] = await Promise.all([listTodos(), getQuickNote()]);
    const titles = new Map<string, string | null>();
    for (const id of new Set(todos.flatMap((t) => (t.taskId ? [t.taskId] : [])))) titles.set(id, (await getTask(id))?.title ?? null);
    const taskTitle = (id: string) => titles.get(id) ?? null;
    const openRoots = todos.filter((t) => !t.done && t.parentId == null).map((t) => t.id);
    const doneRoots = todos.filter((t) => t.done && t.parentId == null).slice(0, 10);
    const lines = ["To-dos (open, in the user's order, highest priority first; subtasks indented under their to-do):"];
    lines.push(...(openRoots.length ? subtreeLines(todos, openRoots, taskTitle) : ["- none"]));
    if (doneRoots.length) lines.push("", "Recently done:", ...doneRoots.map((t) => `- [${t.id}] ${t.text}`));
    lines.push("", "Quick note:", note.text.trim() ? note.text : "(empty)");
    return lines.join("\n");
}

/**
 * One call on the notes from an agent's tool. Workers get read, add_todo and set_due; the Lead
 * also complete_todo and append_note. add_todo takes a parent_id to add a subtask, and a due date.
 */
export async function runNotesAction(author: string, args: unknown, allowed: ReadonlySet<string>): Promise<string> {
    const a = (args || {}) as { action?: unknown; text?: unknown; id?: unknown; parent_id?: unknown; due?: unknown };
    const action = typeof a.action === "string" ? a.action : "";
    if (!allowed.has(action)) return `Use action ${[...allowed].join(", ")}.`;
    try {
        switch (action) {
            case "read":
                return await notesForAgent();
            case "add_todo": {
                const todo = await addTodo(a.text, author, undefined, { parentId: a.parent_id, due: a.due });
                const where = todo.parentId != null ? ` under [${todo.parentId}]` : "";
                return `Added to-do [${todo.id}]${where}: ${todo.text}${todo.due ? ` (due ${todo.due})` : ""}`;
            }
            case "complete_todo": {
                const todo = await updateTodo(a.id, { done: true });
                return `Checked off [${todo.id}]: ${todo.text}`;
            }
            case "set_due": {
                const todo = await updateTodo(a.id, { due: a.due ?? null });
                return todo.due ? `[${todo.id}] is due ${todo.due}.` : `[${todo.id}] has no due date now.`;
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