// Jarvis: the Today dashboard's tasks, the Copilot workers they host, and the
// event history the Lead reads. Rows live in the app's SQLite file next to the
// reviews. Each task has an Artifacts folder under the Jarvis folder: note.md,
// the note the user and the task's workers share, recap.md once the task ends,
// and any other notes they add. They are plain files, so any editor opens them.
// A task also gets its own folder, named after its title, under a folder the
// user picks; each of its workers works in a folder there holding git worktrees
// of the repos it needs (see jarvis-codebase.mts).

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { ensureDb } from "./store.mjs";
import { FORMER_LEAD_NAME, LEAD_NAME } from "./brand.mjs";

export type TaskStatus = "open" | "done";
export type WorkerState = "working" | "needsInput" | "turnDone" | "idle" | "stopped" | "error";

export interface TaskWorkItem {
    id: number;
    type: string;
    state: string;
    url: string;
    parent: { id: number; type: string; title: string } | null;
}

export interface JarvisTask {
    id: string;
    title: string;
    /** What the task is for, in the user's words (or the work item's description). */
    description: string;
    /** The task's own folder, where each worker gets a folder with its worktrees. Null for tasks made before task folders. */
    folder: string | null;
    /** The task's service: an ADO org and project. Null for custom tasks created without one. */
    org: string | null;
    project: string | null;
    workItem: TaskWorkItem | null;
    status: TaskStatus;
    /** "devis": a change to Devis itself, made in a worktree of its source and shipped through Settings' self-change pipeline. */
    kind?: "devis";
    createdAt: string;
    updatedAt: string;
    doneAt: string | null;
}

export interface JarvisWorker {
    sessionId: string;
    taskId: string;
    label: string;
    cwd: string;
    model: string | null;
    /** Reasoning effort chosen with `model`; null for the model's own default. */
    effort: string | null;
    state: WorkerState;
    /** The worker's latest reply, trimmed, or a short status note. */
    summary: string;
    autoApprove: boolean;
    createdAt: string;
    updatedAt: string;
    /** When `state` last changed: a failed turn is known by it (a model switch moves updatedAt, not this). */
    stateAt: string;
}

export interface JarvisEvent {
    id: number;
    at: string;
    kind: string;
    taskId: string | null;
    sessionId: string | null;
    ref: Record<string, unknown> | null;
    text: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A task or session id, or null when the value is not a well-formed UUID. */
export function asJarvisId(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const id = value.trim().toLowerCase();
    return UUID_RE.test(id) ? id : null;
}

export class JarvisError extends Error {
    constructor(
        message: string,
        readonly status = 400,
    ) {
        super(message);
    }
}

const STATES: readonly WorkerState[] = ["working", "needsInput", "turnDone", "idle", "stopped", "error"];
const SUMMARY_MAX = 600;
const TITLE_MAX = 200;

export function jarvisDir(): string {
    if (process.env.ADO_PR_OPS_JARVIS_DIR) return process.env.ADO_PR_OPS_JARVIS_DIR;
    const db = process.env.ADO_PR_OPS_DB_PATH || join(dirname(fileURLToPath(import.meta.url)), "data", "reviews.db");
    return join(dirname(db), "jarvis");
}

const now = (): string => new Date().toISOString();

export function clip(text: string, max = SUMMARY_MAX): string {
    const t = text.replace(/\s+\n/g, "\n").trim();
    return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

let ready: Promise<DatabaseSync> | null = null;

/** The shared database with the Jarvis tables in place. */
export function jarvisDb(): Promise<DatabaseSync> {
    if (!ready) {
        ready = (async () => {
            const db = await ensureDb();
            db.exec(`
                CREATE TABLE IF NOT EXISTS jarvis_tasks (
                    id            TEXT PRIMARY KEY,
                    title         TEXT NOT NULL,
                    org           TEXT,
                    project       TEXT,
                    wi_id         INTEGER,
                    wi_type       TEXT,
                    wi_state      TEXT,
                    wi_url        TEXT,
                    parent_id     INTEGER,
                    parent_type   TEXT,
                    parent_title  TEXT,
                    status        TEXT NOT NULL DEFAULT 'open',
                    created_at    TEXT NOT NULL,
                    updated_at    TEXT NOT NULL,
                    done_at       TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_jarvis_tasks_work_item
                ON jarvis_tasks(lower(org), wi_id) WHERE wi_id IS NOT NULL;
                CREATE TABLE IF NOT EXISTS jarvis_workers (
                    session_id    TEXT PRIMARY KEY,
                    task_id       TEXT NOT NULL,
                    label         TEXT NOT NULL,
                    cwd           TEXT NOT NULL,
                    model         TEXT,
                    state         TEXT NOT NULL,
                    summary       TEXT NOT NULL DEFAULT '',
                    auto_approve  INTEGER NOT NULL DEFAULT 0,
                    created_at    TEXT NOT NULL,
                    updated_at    TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_jarvis_workers_task ON jarvis_workers(task_id);
                CREATE TABLE IF NOT EXISTS jarvis_events (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    at          TEXT NOT NULL,
                    kind        TEXT NOT NULL,
                    task_id     TEXT,
                    session_id  TEXT,
                    ref_json    TEXT,
                    text        TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_jarvis_events_at ON jarvis_events(at);
                CREATE TABLE IF NOT EXISTS jarvis_meta (
                    key    TEXT PRIMARY KEY,
                    value  TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS jarvis_status (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id     TEXT NOT NULL,
                    at          TEXT NOT NULL,
                    author      TEXT NOT NULL,
                    session_id  TEXT,
                    text        TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_jarvis_status_task ON jarvis_status(task_id, id);
                CREATE INDEX IF NOT EXISTS idx_jarvis_status_at ON jarvis_status(at);
                CREATE TABLE IF NOT EXISTS jarvis_writeups (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    at           TEXT NOT NULL,
                    inputs_hash  TEXT NOT NULL,
                    model        TEXT,
                    text         TEXT NOT NULL,
                    valid        INTEGER NOT NULL,
                    error        TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_jarvis_writeups_at ON jarvis_writeups(at);
                CREATE TABLE IF NOT EXISTS jarvis_task_prs (
                    task_id        TEXT NOT NULL,
                    org            TEXT NOT NULL,
                    pr_id          INTEGER NOT NULL,
                    source         TEXT NOT NULL,
                    in_workitem    INTEGER NOT NULL DEFAULT 0,
                    linked_at      TEXT NOT NULL,
                    hidden         INTEGER NOT NULL DEFAULT 0,
                    snapshot_json  TEXT,
                    checks_json    TEXT,
                    unresolved     INTEGER,
                    refreshed_at   TEXT,
                    error          TEXT,
                    PRIMARY KEY (task_id, org, pr_id)
                );
                CREATE TABLE IF NOT EXISTS jarvis_worker_branches (
                    task_id     TEXT NOT NULL,
                    session_id  TEXT NOT NULL,
                    org         TEXT NOT NULL,
                    project     TEXT NOT NULL,
                    repo        TEXT NOT NULL,
                    branch      TEXT NOT NULL,
                    seen_at     TEXT NOT NULL,
                    PRIMARY KEY (task_id, org, project, repo, branch)
                );
                CREATE TABLE IF NOT EXISTS jarvis_todos (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    text        TEXT NOT NULL,
                    done        INTEGER NOT NULL DEFAULT 0,
                    position    REAL NOT NULL,
                    author      TEXT NOT NULL,
                    created_at  TEXT NOT NULL,
                    updated_at  TEXT NOT NULL,
                    done_at     TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_jarvis_todos_open ON jarvis_todos(done, position);
            `);
            // A to-do made from a Needs you item remembers it (source_key, source_json), and ticks itself once
            // that ask is gone (source_settled, done_note). The columns came later.
            const todoCols = db.prepare("PRAGMA table_info(jarvis_todos)").all() as Array<{ name: string }>;
            if (!todoCols.some((c) => c.name === "source_key")) db.exec("ALTER TABLE jarvis_todos ADD COLUMN source_key TEXT");
            if (!todoCols.some((c) => c.name === "source_json")) db.exec("ALTER TABLE jarvis_todos ADD COLUMN source_json TEXT");
            if (!todoCols.some((c) => c.name === "source_settled")) db.exec("ALTER TABLE jarvis_todos ADD COLUMN source_settled INTEGER NOT NULL DEFAULT 0");
            if (!todoCols.some((c) => c.name === "done_note")) db.exec("ALTER TABLE jarvis_todos ADD COLUMN done_note TEXT");
            // Subtasks (any depth), a due date, a priority on top-level ones, and the task one was started as.
            if (!todoCols.some((c) => c.name === "parent_id")) db.exec("ALTER TABLE jarvis_todos ADD COLUMN parent_id INTEGER");
            if (!todoCols.some((c) => c.name === "due")) db.exec("ALTER TABLE jarvis_todos ADD COLUMN due TEXT");
            if (!todoCols.some((c) => c.name === "priority")) db.exec("ALTER TABLE jarvis_todos ADD COLUMN priority INTEGER NOT NULL DEFAULT 0");
            if (!todoCols.some((c) => c.name === "task_id")) db.exec("ALTER TABLE jarvis_todos ADD COLUMN task_id TEXT");
            db.exec("CREATE INDEX IF NOT EXISTS idx_jarvis_todos_source ON jarvis_todos(source_key) WHERE source_key IS NOT NULL");
            db.exec("CREATE INDEX IF NOT EXISTS idx_jarvis_todos_parent ON jarvis_todos(parent_id) WHERE parent_id IS NOT NULL");
            db.exec("CREATE INDEX IF NOT EXISTS idx_jarvis_todos_task ON jarvis_todos(task_id) WHERE task_id IS NOT NULL");
            // A task being removed is hidden while its recap is written; the column came later.
            const taskCols = db.prepare("PRAGMA table_info(jarvis_tasks)").all() as Array<{ name: string }>;
            if (!taskCols.some((c) => c.name === "removing_at")) db.exec("ALTER TABLE jarvis_tasks ADD COLUMN removing_at TEXT");
            if (!taskCols.some((c) => c.name === "description")) db.exec("ALTER TABLE jarvis_tasks ADD COLUMN description TEXT NOT NULL DEFAULT ''");
            if (!taskCols.some((c) => c.name === "folder")) db.exec("ALTER TABLE jarvis_tasks ADD COLUMN folder TEXT");
            if (!taskCols.some((c) => c.name === "kind")) db.exec("ALTER TABLE jarvis_tasks ADD COLUMN kind TEXT");
            const workerCols = db.prepare("PRAGMA table_info(jarvis_workers)").all() as Array<{ name: string }>;
            if (!workerCols.some((c) => c.name === "effort")) db.exec("ALTER TABLE jarvis_workers ADD COLUMN effort TEXT");
            if (!workerCols.some((c) => c.name === "state_at")) {
                db.exec("ALTER TABLE jarvis_workers ADD COLUMN state_at TEXT");
                db.exec("UPDATE jarvis_workers SET state_at = updated_at WHERE state_at IS NULL");
            }
            // A worker's worktrees: one per repo it works in, under its folder in the task's folder.
            db.exec(`
                CREATE TABLE IF NOT EXISTS jarvis_worktrees (
                    session_id  TEXT NOT NULL,
                    task_id     TEXT NOT NULL,
                    org         TEXT NOT NULL,
                    project     TEXT NOT NULL,
                    repo        TEXT NOT NULL,
                    path        TEXT NOT NULL,
                    branch      TEXT NOT NULL,
                    base        TEXT NOT NULL,
                    clone_path  TEXT NOT NULL,
                    created_at  TEXT NOT NULL,
                    PRIMARY KEY (session_id, org, project, repo)
                );
                CREATE INDEX IF NOT EXISTS idx_jarvis_worktrees_task ON jarvis_worktrees(task_id);
            `);
            // The lead was called Jarvis: what it signed then reads as its name now.
            db.prepare("UPDATE jarvis_status SET author = ? WHERE author = ?").run(LEAD_NAME, FORMER_LEAD_NAME);
            db.prepare("UPDATE jarvis_todos SET author = ? WHERE author = ?").run(LEAD_NAME, FORMER_LEAD_NAME);
            // A turn or a pending question does not survive the background service stopping.
            const interrupted = db
                .prepare("SELECT session_id, task_id, label FROM jarvis_workers WHERE state IN ('working','needsInput')")
                .all() as Array<{ session_id: string; task_id: string; label: string }>;
            for (const row of interrupted) {
                const at = now();
                db.prepare("UPDATE jarvis_workers SET state = 'idle', summary = ?, updated_at = ?, state_at = ? WHERE session_id = ?").run(
                    "Interrupted when the background service stopped. Send a message to continue.",
                    at,
                    at,
                    row.session_id,
                );
                insertEvent(db, "worker.interrupted", `${row.label} was interrupted when the background service stopped.`, {
                    taskId: row.task_id,
                    sessionId: row.session_id,
                });
            }
            return db;
        })().catch((error) => {
            ready = null;
            throw error;
        });
    }
    return ready;
}

/** Forget the cached handle (the database was closed). */
export function resetJarvisDb(): void {
    ready = null;
}

// ---- rows ---------------------------------------------------------------------------

interface TaskRow {
    id: string;
    title: string;
    org: string | null;
    project: string | null;
    wi_id: number | null;
    wi_type: string | null;
    wi_state: string | null;
    wi_url: string | null;
    parent_id: number | null;
    parent_type: string | null;
    parent_title: string | null;
    status: string;
    created_at: string;
    updated_at: string;
    done_at: string | null;
    removing_at?: string | null;
    description?: string | null;
    folder?: string | null;
    kind?: string | null;
}

function toTask(r: TaskRow): JarvisTask {
    return {
        id: r.id,
        title: r.title,
        description: r.description || "",
        folder: r.folder || null,
        ...(r.kind === "devis" ? { kind: "devis" as const } : {}),
        org: r.org,
        project: r.project,
        workItem:
            r.wi_id == null
                ? null
                : {
                      id: r.wi_id,
                      type: r.wi_type || "Work item",
                      state: r.wi_state || "",
                      url: r.wi_url || "",
                      parent:
                          r.parent_id == null
                              ? null
                              : { id: r.parent_id, type: r.parent_type || "Work item", title: r.parent_title || "" },
                  },
        status: r.status === "done" ? "done" : "open",
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        doneAt: r.done_at,
    };
}

interface WorkerRow {
    session_id: string;
    task_id: string;
    label: string;
    cwd: string;
    model: string | null;
    effort?: string | null;
    state: string;
    summary: string;
    auto_approve: number;
    created_at: string;
    updated_at: string;
    state_at?: string | null;
}

function toWorker(r: WorkerRow): JarvisWorker {
    return {
        sessionId: r.session_id,
        taskId: r.task_id,
        label: r.label,
        cwd: r.cwd,
        model: r.model,
        effort: r.effort || null,
        state: (STATES as readonly string[]).includes(r.state) ? (r.state as WorkerState) : "idle",
        summary: r.summary || "",
        autoApprove: !!r.auto_approve,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        stateAt: r.state_at || r.updated_at,
    };
}

// ---- events -------------------------------------------------------------------------

interface EventLinks {
    taskId?: string | null;
    sessionId?: string | null;
    ref?: Record<string, unknown> | null;
}

function insertEvent(db: DatabaseSync, kind: string, text: string, links: EventLinks = {}): void {
    db.prepare(
        "INSERT INTO jarvis_events (at, kind, task_id, session_id, ref_json, text) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(now(), kind, links.taskId ?? null, links.sessionId ?? null, links.ref ? JSON.stringify(links.ref) : null, clip(text, 1000));
}

/** Append one line to the history the Lead and the Today page read. */
export async function recordEvent(kind: string, text: string, links: EventLinks = {}): Promise<void> {
    insertEvent(await jarvisDb(), kind, text, links);
}

/** History older than this goes; History shows two weeks and the Lead reads at most 30 days. */
export const EVENT_RETENTION_DAYS = 120;

/** Drop history older than the retention window. Returns rows removed. */
export async function pruneEvents(olderThanMs = Date.now() - EVENT_RETENTION_DAYS * 86_400_000): Promise<number> {
    const db = await jarvisDb();
    return Number(db.prepare("DELETE FROM jarvis_events WHERE at < ?").run(new Date(olderThanMs).toISOString()).changes ?? 0);
}

export interface EventQuery {
    since?: string;
    until?: string;
    taskId?: string | null;
    kinds?: string[];
    limit?: number;
}

/** Events newest first. */
export async function listEvents(query: EventQuery = {}): Promise<JarvisEvent[]> {
    const db = await jarvisDb();
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (query.since) {
        where.push("at >= ?");
        args.push(query.since);
    }
    if (query.until) {
        where.push("at < ?");
        args.push(query.until);
    }
    if (query.taskId) {
        where.push("task_id = ?");
        args.push(query.taskId);
    }
    if (query.kinds?.length) {
        where.push(`kind IN (${query.kinds.map(() => "?").join(",")})`);
        args.push(...query.kinds);
    }
    const limit = Math.max(1, Math.min(query.limit ?? 200, 1000));
    const rows = db
        .prepare(
            `SELECT id, at, kind, task_id, session_id, ref_json, text FROM jarvis_events
             ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ${limit}`,
        )
        .all(...args) as Array<{
        id: number;
        at: string;
        kind: string;
        task_id: string | null;
        session_id: string | null;
        ref_json: string | null;
        text: string;
    }>;
    return rows.map((r) => {
        let ref: Record<string, unknown> | null = null;
        try {
            ref = r.ref_json ? JSON.parse(r.ref_json) : null;
        } catch {
            ref = null;
        }
        return { id: r.id, at: r.at, kind: r.kind, taskId: r.task_id, sessionId: r.session_id, ref, text: r.text };
    });
}

// ---- tasks --------------------------------------------------------------------------

export interface NewTask {
    title?: string;
    description?: string;
    org?: string | null;
    project?: string | null;
    workItem?: (TaskWorkItem & { title: string; project: string }) | null;
    /** Where the task's own folder goes; the folder is named after its title. Without it the task gets no folder. */
    folderRoot?: string | null;
    kind?: "devis";
}

function cleanText(value: unknown, max: number): string {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export const DESCRIPTION_MAX = 8_000;

/** A task's description: its own lines kept, trailing space and runs of blank lines trimmed. */
export function cleanDescription(value: unknown): string {
    if (typeof value !== "string") return "";
    const text = value.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
    return text.length > DESCRIPTION_MAX ? text.slice(0, DESCRIPTION_MAX - 1).trimEnd() + "…" : text;
}

/**
 * The task folder's name: the title in lowercase with spaces as dashes. Characters a
 * folder or git branch can't hold are dropped, so it also works inside branch names.
 */
export function taskSlug(title: string): string {
    let slug = title
        .normalize("NFKC")
        .toLowerCase()
        .trim()
        .replace(/\s+/g, "-")
        .replace(/[^\p{L}\p{N}._-]+/gu, "")
        .replace(/\.{2,}/g, ".")
        .replace(/-{2,}/g, "-")
        .replace(/^[-.]+|[-.]+$/g, "")
        .slice(0, 60)
        .replace(/[-.]+$/g, "")
        .replace(/\.lock$/, "-lock");
    if (!slug) slug = "task";
    if (RESERVED_NAME.test(slug)) slug += "-task";
    return slug;
}

/** A folder the user typed: quotes, %VARS% and ~ resolved. It must be a full path. */
export function cleanFolderRoot(value: unknown): string {
    const raw = typeof value === "string" ? value.trim().replace(/^"(.*)"$/, "$1").trim() : "";
    const expanded = raw
        .replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole)
        .replace(/^~(?=$|[\\/])/, homedir());
    if (!expanded || !isAbsolute(expanded)) {
        throw new JarvisError("Choose where the task's folder goes as a full path, like C:\\work\\tasks.");
    }
    return resolve(expanded);
}

/** Make the task's own folder under `root`: its slug, numbered when that name is taken. */
export function allocateTaskFolder(root: string, title: string): string {
    const base = cleanFolderRoot(root);
    try {
        mkdirSync(base, { recursive: true });
    } catch (error) {
        throw new JarvisError(`Couldn't make the folder ${base}: ${(error as Error).message}`);
    }
    const slug = taskSlug(title);
    for (let n = 1; n < 1000; n++) {
        const path = join(base, n === 1 ? slug : `${slug}-${n}`);
        if (existsSync(path)) continue;
        try {
            mkdirSync(path);
            return path;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
            throw new JarvisError(`Couldn't make the task's folder ${path}: ${(error as Error).message}`);
        }
    }
    throw new JarvisError(`Too many folders named ${slug} in ${base}.`);
}

/** Open tasks, tasks finished at or after `doneSince`, and any task whose workers are still live. A task being removed is left out. */
export async function listTasks(doneSince?: string): Promise<JarvisTask[]> {
    const db = await jarvisDb();
    const rows = db
        .prepare(
            `SELECT * FROM jarvis_tasks
             WHERE removing_at IS NULL
               AND (status = 'open'
                OR (done_at IS NOT NULL AND done_at >= ?)
                OR id IN (SELECT task_id FROM jarvis_workers WHERE state IN ('working','needsInput')))
             ORDER BY created_at DESC`,
        )
        .all(doneSince || "9999") as unknown as TaskRow[];
    return rows.map(toTask);
}

export async function getTask(id: string): Promise<JarvisTask | null> {
    const db = await jarvisDb();
    const row = db.prepare("SELECT * FROM jarvis_tasks WHERE id = ?").get(id) as unknown as TaskRow | undefined;
    return row ? toTask(row) : null;
}

/**
 * Create a task, from a work item or as a custom task. A work item already on
 * the dashboard returns its existing task (reopened if it was done).
 */
export async function createTask(input: NewTask): Promise<{ task: JarvisTask; created: boolean }> {
    const db = await jarvisDb();
    const wi = input.workItem || null;
    const org = cleanText(input.org, 200) || null;
    if (wi) {
        if (!org) throw new JarvisError("A work item task needs its organization.");
        const existing = db
            .prepare("SELECT * FROM jarvis_tasks WHERE lower(org) = lower(?) AND wi_id = ?")
            .get(org, wi.id) as unknown as TaskRow | undefined;
        if (existing) {
            if (existing.removing_at) throw new JarvisError("That task is being removed. Add it again in a minute.", 409);
            if (existing.status === "done") await updateTask(existing.id, { status: "open" });
            return { task: (await getTask(existing.id))!, created: false };
        }
    }
    const title = cleanText(wi ? wi.title : input.title, TITLE_MAX);
    if (!title) throw new JarvisError("A task needs a title.");
    const project = cleanText(wi ? wi.project : input.project, 200) || null;
    const description = cleanDescription(input.description);
    const folder = input.folderRoot ? allocateTaskFolder(input.folderRoot, title) : null;
    const id = randomUUID();
    const at = now();
    try {
        db.prepare(
            `INSERT INTO jarvis_tasks (id, title, org, project, wi_id, wi_type, wi_state, wi_url,
                parent_id, parent_type, parent_title, status, created_at, updated_at, description, folder, kind)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
        ).run(
            id,
            title,
            org,
            project,
            wi?.id ?? null,
            wi?.type ?? null,
            wi?.state ?? null,
            wi?.url ?? null,
            wi?.parent?.id ?? null,
            wi?.parent?.type ?? null,
            wi?.parent?.title ?? null,
            at,
            at,
            description,
            folder,
            input.kind === "devis" ? "devis" : null,
        );
    } catch (error) {
        if (folder) rmSync(folder, { recursive: true, force: true });
        throw error;
    }
    const task = (await getTask(id))!;
    writeFileAtomic(join(ensureArtifacts(id), NOTE_NAME), initialNote(task));
    insertEvent(db, "task.created", `Task created: ${describeTask(task)}${folder ? ` in ${folder}` : ""}`, { taskId: id });
    return { task, created: true };
}

export function describeTask(task: Pick<JarvisTask, "title" | "workItem">): string {
    return task.workItem ? `${task.workItem.type} #${task.workItem.id} ${task.title}` : task.title;
}

export interface TaskPatch {
    status?: TaskStatus;
    title?: string;
    description?: string;
}

type TaskListener = (task: JarvisTask) => void;
const doneListeners = new Set<TaskListener>();

/** Called whenever a task is marked done, from any path (the page, the Lead). */
export function onTaskDone(listener: TaskListener): () => void {
    doneListeners.add(listener);
    return () => doneListeners.delete(listener);
}

export async function updateTask(id: string, patch: TaskPatch): Promise<JarvisTask> {
    const db = await jarvisDb();
    const task = await getTask(id);
    if (!task) throw new JarvisError("Task not found.", 404);
    if (await isRemoving(id)) throw new JarvisError("That task is being removed.", 409);
    const at = now();
    if (patch.title !== undefined) {
        const title = cleanText(patch.title, TITLE_MAX);
        if (!title) throw new JarvisError("A task needs a title.");
        db.prepare("UPDATE jarvis_tasks SET title = ?, updated_at = ? WHERE id = ?").run(title, at, id);
    }
    if (patch.description !== undefined) {
        db.prepare("UPDATE jarvis_tasks SET description = ?, updated_at = ? WHERE id = ?").run(cleanDescription(patch.description), at, id);
    }
    if (patch.status && patch.status !== task.status) {
        const done = patch.status === "done";
        db.prepare("UPDATE jarvis_tasks SET status = ?, done_at = ?, updated_at = ? WHERE id = ?").run(
            patch.status,
            done ? at : null,
            at,
            id,
        );
        insertEvent(db, done ? "task.done" : "task.reopened", `${done ? "Done" : "Reopened"}: ${describeTask(task)}`, {
            taskId: id,
        });
        if (done) {
            const updated = (await getTask(id))!;
            for (const listener of doneListeners) {
                try {
                    listener(updated);
                } catch (error) {
                    console.warn(`[jarvis] task-done listener failed: ${(error as Error).message}`);
                }
            }
        }
    }
    return (await getTask(id))!;
}

/** Fresh work item fields from ADO, for tasks already on the dashboard. */
export async function refreshWorkItems(
    org: string,
    items: Array<{ id: number; title: string; type: string; state: string; url: string; parent?: { id: number; type: string; title: string } | null }>,
): Promise<void> {
    const db = await jarvisDb();
    const update = db.prepare(
        `UPDATE jarvis_tasks SET title = ?, wi_type = ?, wi_state = ?, wi_url = ?,
            parent_id = ?, parent_type = ?, parent_title = ?
         WHERE lower(org) = lower(?) AND wi_id = ?`,
    );
    for (const item of items) {
        update.run(
            cleanText(item.title, TITLE_MAX) || `Work item ${item.id}`,
            item.type,
            item.state,
            item.url,
            item.parent?.id ?? null,
            item.parent?.type ?? null,
            item.parent?.title ?? null,
            org,
            item.id,
        );
    }
}

/** Hide a task from Today while it is being removed (its recap is written first). */
export async function beginRemoval(id: string): Promise<JarvisTask> {
    const db = await jarvisDb();
    const task = await getTask(id);
    if (!task) throw new JarvisError("Task not found.", 404);
    const res = db.prepare("UPDATE jarvis_tasks SET removing_at = ? WHERE id = ? AND removing_at IS NULL").run(now(), id);
    if (res.changes) insertEvent(db, "task.removing", `Removing: ${describeTask(task)}`, { taskId: id });
    return task;
}

export async function isRemoving(id: string): Promise<boolean> {
    const db = await jarvisDb();
    const row = db.prepare("SELECT removing_at FROM jarvis_tasks WHERE id = ?").get(id) as { removing_at: string | null } | undefined;
    return !!row?.removing_at;
}

/** Tasks whose removal started but never finished, say because the app closed. */
export async function pendingRemovals(): Promise<string[]> {
    const db = await jarvisDb();
    return (db.prepare("SELECT id FROM jarvis_tasks WHERE removing_at IS NOT NULL").all() as Array<{ id: string }>).map((r) => r.id);
}

/**
 * Remove a task's rows: the task, its workers and its status lines. Its
 * Artifacts folder stays on disk, with a task.json beside it saying what the
 * task was (plus `extra`, like its validation). Returns the workers' session ids for cleanup.
 */
export async function deleteTask(id: string, extra?: Record<string, unknown>): Promise<string[]> {
    const db = await jarvisDb();
    const task = await getTask(id);
    if (!task) throw new JarvisError("Task not found.", 404);
    const sessions = (
        db.prepare("SELECT session_id FROM jarvis_workers WHERE task_id = ?").all(id) as Array<{ session_id: string }>
    ).map((r) => r.session_id);
    const prs = await listTaskPrs(id, { includeHidden: true });
    db.exec("BEGIN IMMEDIATE");
    try {
        db.prepare("DELETE FROM jarvis_workers WHERE task_id = ?").run(id);
        db.prepare("DELETE FROM jarvis_status WHERE task_id = ?").run(id);
        db.prepare("DELETE FROM jarvis_task_prs WHERE task_id = ?").run(id);
        db.prepare("DELETE FROM jarvis_worker_branches WHERE task_id = ?").run(id);
        db.prepare("DELETE FROM jarvis_worktrees WHERE task_id = ?").run(id);
        db.prepare("DELETE FROM jarvis_tasks WHERE id = ?").run(id);
        insertEvent(db, "task.deleted", `Removed: ${describeTask(task)}`, { taskId: id });
        db.exec("COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
    try {
        ensureArtifacts(id);
        const pullRequests = prs
            .filter((p) => !p.hidden)
            .map((p) => ({ org: p.org, id: p.prId, title: p.snapshot?.title ?? null, status: p.snapshot?.status ?? null, url: p.snapshot?.url ?? null }));
        writeFileAtomic(join(taskDir(id), "task.json"), JSON.stringify({ ...task, pullRequests, ...(extra || {}), removedAt: now() }, null, 2) + "\n");
    } catch (error) {
        console.warn(`[jarvis] removed task's record not written: ${(error as Error).message}`);
    }
    return sessions;
}

// ---- artifacts ----------------------------------------------------------------------

/** The note the user and the task's workers share. */
export const NOTE_NAME = "note.md";
/** Written by one of the task's workers when the task is done or removed. */
export const RECAP_NAME = "recap.md";
export const ARTIFACT_MAX = 200_000;
export const ARTIFACTS_PER_TASK = 50;
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,78}\.(?:md|markdown|txt|json|ya?ml|csv|log|mmd)$/i;
// Windows reserves these names whatever the extension.
const RESERVED_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;

export interface ArtifactInfo {
    name: string;
    size: number;
    modifiedAt: string;
}

export interface Artifact extends ArtifactInfo {
    content: string;
    path: string;
}

/** The task's own folder; the Artifacts folder sits inside it. */
export function taskDir(taskId: string): string {
    const id = asJarvisId(taskId);
    if (!id) throw new JarvisError("invalid task id");
    return join(jarvisDir(), "tasks", id);
}

export function artifactsDir(taskId: string): string {
    return join(taskDir(taskId), "artifacts");
}

export function notePath(taskId: string): string {
    return join(artifactsDir(taskId), NOTE_NAME);
}

function isArtifactName(name: string): boolean {
    return ARTIFACT_NAME.test(name) && !name.includes("..") && !RESERVED_NAME.test(name);
}

/** A safe file name for an artifact, or an error that says what is allowed. */
export function artifactName(value: unknown): string {
    const name = typeof value === "string" ? value.trim() : "";
    if (!isArtifactName(name)) {
        throw new JarvisError(
            "Name it like design.md: letters, numbers, spaces, dots, dashes or underscores, ending in .md, .txt, .json, .yaml, .csv, .log or .mmd.",
        );
    }
    return name;
}

/**
 * Old builds kept the note in tasks/<id>.md and copied every status line into
 * it. Those copies duplicate the status timeline, so they are left out.
 */
export function withoutStatusCopies(markdown: string): string {
    return markdown
        .replace(/(^|\n)## [^\n]+ · [^\n]+\n\nStatus: [^\n]*\n?(?=\n*## |\s*$)/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/\s*$/, "\n");
}

/** The Artifacts folder, created on first use, with an old task.md moved in as note.md. */
function ensureArtifacts(taskId: string): string {
    const dir = artifactsDir(taskId);
    mkdirSync(dir, { recursive: true });
    const legacy = join(jarvisDir(), "tasks", `${asJarvisId(taskId)}.md`);
    if (existsSync(legacy)) {
        const note = join(dir, NOTE_NAME);
        const target = existsSync(note) ? join(dir, "task.md") : note;
        if (!existsSync(target)) writeFileAtomic(target, withoutStatusCopies(readFileSync(legacy, "utf8")));
        rmSync(legacy, { force: true });
    }
    return dir;
}

/** Readers never see half a file: write beside it, then swap it in. */
function writeFileAtomic(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.${basename(path)}.${randomUUID().slice(0, 8)}.tmp`);
    writeFileSync(tmp, text, "utf8");
    try {
        renameSync(tmp, path);
    } catch {
        // An editor holding the file open can block the swap on Windows.
        writeFileSync(path, text, "utf8");
    } finally {
        rmSync(tmp, { force: true });
    }
}

async function requireTask(taskId: string): Promise<JarvisTask> {
    const id = asJarvisId(taskId);
    const task = id ? await getTask(id) : null;
    if (!task) throw new JarvisError("Task not found.", 404);
    return task;
}

const RANK: Record<string, number> = { [NOTE_NAME]: 0, [RECAP_NAME]: 1 };

/** note.md first, then recap.md, then the rest, newest first. */
export async function listArtifacts(taskId: string): Promise<ArtifactInfo[]> {
    const task = await requireTask(taskId);
    const dir = ensureArtifacts(task.id);
    const items: ArtifactInfo[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !isArtifactName(entry.name)) continue;
        try {
            const stat = statSync(join(dir, entry.name));
            items.push({ name: entry.name, size: stat.size, modifiedAt: stat.mtime.toISOString() });
        } catch {
            /* removed while listing */
        }
    }
    const rank = (name: string) => RANK[name.toLowerCase()] ?? 2;
    return items.sort((a, b) => rank(a.name) - rank(b.name) || b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name));
}

function readText(path: string): string | null {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return null;
    }
}

export async function readArtifact(taskId: string, name: string): Promise<Artifact> {
    const task = await requireTask(taskId);
    const file = artifactName(name);
    const path = join(ensureArtifacts(task.id), file);
    const content = readText(path);
    // The note always exists as far as anyone can tell; an empty one is fine.
    if (content === null && file.toLowerCase() !== NOTE_NAME) throw new JarvisError(`There is no artifact named ${file}.`, 404);
    let size = 0;
    let modifiedAt = task.createdAt;
    try {
        const stat = statSync(path);
        size = stat.size;
        modifiedAt = stat.mtime.toISOString();
    } catch {
        /* the empty note */
    }
    return { name: file, content: content ?? "", path, size, modifiedAt };
}

export interface WriteArtifact {
    /** The text the editor started from: the save is refused if the file changed since. */
    base?: string;
    /** Only create: refused when the name is taken. */
    create?: boolean;
}

export async function writeArtifact(taskId: string, name: string, content: unknown, options: WriteArtifact = {}): Promise<Artifact> {
    const task = await requireTask(taskId);
    const file = artifactName(name);
    if (typeof content !== "string") throw new JarvisError("The artifact's text is missing.");
    if (content.length > ARTIFACT_MAX) throw new JarvisError(`${file} is too long.`);
    const dir = ensureArtifacts(task.id);
    const path = join(dir, file);
    const current = readText(path);
    if (current !== null && options.create) throw new JarvisError(`There is already an artifact named ${file}.`, 409);
    if (current === null && listCount(dir) >= ARTIFACTS_PER_TASK) {
        throw new JarvisError(`This task already has ${ARTIFACTS_PER_TASK} artifacts. Delete one first.`, 409);
    }
    if (options.base !== undefined && (current ?? "") !== options.base) {
        throw new JarvisError(`${file} changed while you were editing it.`, 409);
    }
    writeFileAtomic(path, content);
    return readArtifact(task.id, file);
}

function listCount(dir: string): number {
    try {
        return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && isArtifactName(e.name)).length;
    } catch {
        return 0;
    }
}

/** Add a dated, signed entry to the end of an artifact (note.md by default). */
export async function appendArtifact(taskId: string, name: string, text: string, author: string): Promise<void> {
    const task = await requireTask(taskId);
    const file = artifactName(name);
    const body = String(text ?? "").trim();
    if (!body) throw new JarvisError("Nothing to add.");
    const dir = ensureArtifacts(task.id);
    const path = join(dir, file);
    // Read and write with no await between, so two entries never interleave.
    const current = readText(path);
    if (current === null && listCount(dir) >= ARTIFACTS_PER_TASK) {
        throw new JarvisError(`This task already has ${ARTIFACTS_PER_TASK} artifacts. Delete one first.`, 409);
    }
    const stamp = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    const next = `${(current ?? "").replace(/\s*$/, "")}\n\n## ${stamp} · ${author}\n\n${body}\n`.replace(/^\n+/, "");
    if (next.length > ARTIFACT_MAX) throw new JarvisError(`${file} is full. Start a new artifact.`);
    writeFileAtomic(path, next);
}

export async function deleteArtifact(taskId: string, name: string): Promise<void> {
    const task = await requireTask(taskId);
    const file = artifactName(name);
    if (file.toLowerCase() === NOTE_NAME) throw new JarvisError("note.md is the task's shared note; clear it instead of deleting it.");
    const path = join(ensureArtifacts(task.id), file);
    if (readText(path) === null) throw new JarvisError(`There is no artifact named ${file}.`, 404);
    rmSync(path, { force: true });
}

function initialNote(task: JarvisTask): string {
    const lines = [`# ${task.title}`, ""];
    if (task.workItem) {
        lines.push(`${task.workItem.type} #${task.workItem.id}: ${task.workItem.url}`);
        if (task.workItem.parent) lines.push(`Parent: ${task.workItem.parent.type} #${task.workItem.parent.id} ${task.workItem.parent.title}`);
        lines.push("");
    }
    return lines.join("\n");
}

export const NOTE_MAX = ARTIFACT_MAX;

export async function readNote(taskId: string): Promise<string> {
    return (await readArtifact(taskId, NOTE_NAME)).content;
}

/**
 * Replace note.md. With `base`, the text the editor started from, the save is
 * refused when the file changed since, so a worker's entry isn't overwritten.
 */
export async function writeNote(taskId: string, markdown: string, base?: string): Promise<void> {
    await writeArtifact(taskId, NOTE_NAME, markdown, { base });
}

/** Add a dated entry to the end of note.md. */
export async function appendNote(taskId: string, text: string, author: string): Promise<void> {
    await appendArtifact(taskId, NOTE_NAME, text, author);
}

// ---- workers ------------------------------------------------------------------------

export async function listWorkers(taskId?: string): Promise<JarvisWorker[]> {
    const db = await jarvisDb();
    const rows = (
        taskId
            ? db.prepare("SELECT * FROM jarvis_workers WHERE task_id = ? ORDER BY created_at").all(taskId)
            : db.prepare("SELECT * FROM jarvis_workers ORDER BY created_at").all()
    ) as unknown as WorkerRow[];
    return rows.map(toWorker);
}

export async function getWorker(sessionId: string): Promise<JarvisWorker | null> {
    const db = await jarvisDb();
    const row = db.prepare("SELECT * FROM jarvis_workers WHERE session_id = ?").get(sessionId) as unknown as
        | WorkerRow
        | undefined;
    return row ? toWorker(row) : null;
}

export async function insertWorker(
    worker: Omit<JarvisWorker, "createdAt" | "updatedAt" | "stateAt" | "autoApprove" | "effort"> & { effort?: string | null },
): Promise<JarvisWorker> {
    const db = await jarvisDb();
    const at = now();
    db.prepare(
        `INSERT INTO jarvis_workers (session_id, task_id, label, cwd, model, effort, state, summary, auto_approve, created_at, updated_at, state_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(worker.sessionId, worker.taskId, worker.label, worker.cwd, worker.model, worker.effort ?? null, worker.state, clip(worker.summary), at, at, at);
    return (await getWorker(worker.sessionId))!;
}

export interface WorkerPatch {
    state?: WorkerState;
    summary?: string;
    autoApprove?: boolean;
    model?: string | null;
    effort?: string | null;
}

export async function updateWorker(sessionId: string, patch: WorkerPatch): Promise<void> {
    const db = await jarvisDb();
    const at = now();
    const sets: string[] = ["updated_at = ?"];
    const args: Array<string | number | null> = [at];
    if (patch.state) {
        // SET reads the row as it was, so this compares with the old state.
        sets.push("state_at = CASE WHEN state IS NOT ? THEN ? ELSE state_at END", "state = ?");
        args.push(patch.state, at, patch.state);
    }
    if (patch.summary !== undefined) {
        sets.push("summary = ?");
        args.push(clip(patch.summary));
    }
    if (patch.autoApprove !== undefined) {
        sets.push("auto_approve = ?");
        args.push(patch.autoApprove ? 1 : 0);
    }
    if (patch.model !== undefined) {
        sets.push("model = ?");
        args.push(patch.model);
    }
    if (patch.effort !== undefined) {
        sets.push("effort = ?");
        args.push(patch.effort);
    }
    db.prepare(`UPDATE jarvis_workers SET ${sets.join(", ")} WHERE session_id = ?`).run(...args, sessionId);
}

export async function deleteWorker(sessionId: string): Promise<void> {
    const db = await jarvisDb();
    db.prepare("DELETE FROM jarvis_workers WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM jarvis_worktrees WHERE session_id = ?").run(sessionId);
}

// ---- worktrees ----------------------------------------------------------------------

/** One repo a worker works in: a git worktree of the app's clone, on the worker's own branch. */
export interface Worktree {
    sessionId: string;
    taskId: string;
    org: string;
    project: string;
    repo: string;
    path: string;
    branch: string;
    /** What the branch started from, like origin/main. */
    base: string;
    /** The app's clone the worktree belongs to. */
    clonePath: string;
    createdAt: string;
}

interface WorktreeRow {
    session_id: string;
    task_id: string;
    org: string;
    project: string;
    repo: string;
    path: string;
    branch: string;
    base: string;
    clone_path: string;
    created_at: string;
}

const toWorktree = (r: WorktreeRow): Worktree => ({
    sessionId: r.session_id,
    taskId: r.task_id,
    org: r.org,
    project: r.project,
    repo: r.repo,
    path: r.path,
    branch: r.branch,
    base: r.base,
    clonePath: r.clone_path,
    createdAt: r.created_at,
});

/** Worktrees of a worker, of a task's workers, or all of them, oldest first. */
export async function listWorktrees(filter: { taskId?: string; sessionId?: string } = {}): Promise<Worktree[]> {
    const db = await jarvisDb();
    const rows = (
        filter.sessionId
            ? db.prepare("SELECT * FROM jarvis_worktrees WHERE session_id = ? ORDER BY created_at, repo").all(filter.sessionId)
            : filter.taskId
              ? db.prepare("SELECT * FROM jarvis_worktrees WHERE task_id = ? ORDER BY created_at, repo").all(filter.taskId)
              : db.prepare("SELECT * FROM jarvis_worktrees ORDER BY created_at, repo").all()
    ) as unknown as WorktreeRow[];
    return rows.map(toWorktree);
}

export async function insertWorktree(w: Omit<Worktree, "createdAt">): Promise<Worktree> {
    const db = await jarvisDb();
    const at = now();
    db.prepare(
        `INSERT OR REPLACE INTO jarvis_worktrees (session_id, task_id, org, project, repo, path, branch, base, clone_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(w.sessionId, w.taskId, w.org, w.project, w.repo, w.path, w.branch, w.base, w.clonePath, at);
    return { ...w, createdAt: at };
}

/** Names for the workers of tasks with a folder: the worker's folder and branch carry it. */
const WORKER_NAMES = [
    "atlas", "birch", "cedar", "dune", "ember", "fjord", "grove", "harbor", "iris", "juniper", "kestrel", "lumen",
    "maple", "nova", "onyx", "pine", "quill", "river", "sage", "tide", "vale", "willow", "yarrow", "zephyr",
];

/** A name no worker has, that `free` accepts (say, its folder isn't taken). */
export async function nextWorkerName(free: (name: string) => boolean = () => true): Promise<string> {
    const db = await jarvisDb();
    const used = new Set((db.prepare("SELECT label FROM jarvis_workers").all() as Array<{ label: string }>).map((r) => r.label.toLowerCase()));
    const ok = (name: string) => !used.has(name) && free(name);
    for (const name of WORKER_NAMES) if (ok(name)) return name;
    for (let n = 2; n < 1000; n++) for (const name of WORKER_NAMES) if (ok(`${name}-${n}`)) return `${name}-${n}`;
    return `worker-${randomUUID().slice(0, 8)}`;
}

/** A short label for a new worker: the folder name, numbered when it repeats. */
export async function nextWorkerLabel(cwd: string): Promise<string> {
    const base =
        cwd
            .replace(/[\\/]+$/, "")
            .split(/[\\/]/)
            .pop()
            ?.replace(/[^\w.-]+/g, "-")
            .toLowerCase()
            .slice(0, 40) || "worker";
    const db = await jarvisDb();
    const used = new Set(
        (db.prepare("SELECT label FROM jarvis_workers").all() as Array<{ label: string }>).map((r) => r.label),
    );
    if (!used.has(base)) return base;
    for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Folders workers ran in, most recent first. */
export async function recentFolders(limit = 8): Promise<string[]> {
    const db = await jarvisDb();
    return (
        db
            .prepare("SELECT cwd, MAX(created_at) AS last FROM jarvis_workers GROUP BY lower(cwd) ORDER BY last DESC LIMIT ?")
            .all(limit) as Array<{ cwd: string }>
    ).map((r) => r.cwd);
}

// ---- status updates -----------------------------------------------------------------

export interface StatusUpdate {
    id: number;
    taskId: string;
    at: string;
    /** A worker's label, "you", or the lead (Devis). */
    author: string;
    sessionId: string | null;
    text: string;
}

interface StatusRow {
    id: number;
    task_id: string;
    at: string;
    author: string;
    session_id: string | null;
    text: string;
}

const toStatus = (r: StatusRow): StatusUpdate => ({
    id: r.id,
    taskId: r.task_id,
    at: r.at,
    author: r.author,
    sessionId: r.session_id,
    text: r.text,
});

/** Store one status line. Validation lives in jarvis-status.mts. */
export async function insertStatus(input: { taskId: string; author: string; sessionId?: string | null; text: string }): Promise<StatusUpdate> {
    const db = await jarvisDb();
    const result = db
        .prepare("INSERT INTO jarvis_status (task_id, at, author, session_id, text) VALUES (?, ?, ?, ?, ?)")
        .run(input.taskId, now(), input.author, input.sessionId ?? null, input.text);
    const row = db.prepare("SELECT * FROM jarvis_status WHERE id = ?").get(Number(result.lastInsertRowid)) as unknown as StatusRow;
    return toStatus(row);
}

/** The newest status of each task, keyed by task id. */
export async function latestStatuses(taskIds: string[]): Promise<Map<string, StatusUpdate>> {
    const out = new Map<string, StatusUpdate>();
    if (!taskIds.length) return out;
    const db = await jarvisDb();
    const latest = db.prepare("SELECT * FROM jarvis_status WHERE task_id = ? ORDER BY id DESC LIMIT 1");
    for (const id of taskIds) {
        const row = latest.get(id) as unknown as StatusRow | undefined;
        if (row) out.set(id, toStatus(row));
    }
    return out;
}

/** Statuses newest first: one task's, or every task's since a time. `before` pages back by id. */
export async function listStatuses(query: { taskId?: string; since?: string; before?: number; limit?: number } = {}): Promise<StatusUpdate[]> {
    const db = await jarvisDb();
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (query.taskId) {
        where.push("task_id = ?");
        args.push(query.taskId);
    }
    if (query.since) {
        where.push("at >= ?");
        args.push(query.since);
    }
    if (Number.isInteger(query.before) && (query.before as number) > 0) {
        where.push("id < ?");
        args.push(query.before as number);
    }
    const limit = Math.max(1, Math.min(query.limit ?? 200, 2000));
    const rows = db
        .prepare(`SELECT * FROM jarvis_status ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ${limit}`)
        .all(...args) as unknown as StatusRow[];
    return rows.map(toStatus);
}

/** How many statuses a task got since a time. */
export async function countStatuses(taskId: string, since: string): Promise<number> {
    const db = await jarvisDb();
    const row = db.prepare("SELECT COUNT(*) AS n FROM jarvis_status WHERE task_id = ? AND at >= ?").get(taskId, since) as { n: number };
    return Number(row.n) || 0;
}

// ---- overview write-ups -------------------------------------------------------------

export interface Writeup {
    id: number;
    at: string;
    inputsHash: string;
    model: string | null;
    text: string;
    valid: boolean;
    error: string | null;
}

interface WriteupRow {
    id: number;
    at: string;
    inputs_hash: string;
    model: string | null;
    text: string;
    valid: number;
    error: string | null;
}

const toWriteup = (r: WriteupRow): Writeup => ({
    id: r.id,
    at: r.at,
    inputsHash: r.inputs_hash,
    model: r.model,
    text: r.text,
    valid: !!r.valid,
    error: r.error,
});

/** Write-ups are kept this long, so the Lead can recap recent weeks. */
export const WRITEUP_RETENTION_DAYS = 30;

export async function insertWriteup(input: Omit<Writeup, "id" | "at"> & { at?: string }): Promise<Writeup> {
    const db = await jarvisDb();
    const cutoff = new Date(Date.now() - WRITEUP_RETENTION_DAYS * 86_400_000).toISOString();
    db.prepare("DELETE FROM jarvis_writeups WHERE at < ?").run(cutoff);
    const result = db
        .prepare("INSERT INTO jarvis_writeups (at, inputs_hash, model, text, valid, error) VALUES (?, ?, ?, ?, ?, ?)")
        .run(input.at ?? now(), input.inputsHash, input.model, clip(input.text, 2000), input.valid ? 1 : 0, input.error ? clip(input.error, 500) : null);
    return toWriteup(db.prepare("SELECT * FROM jarvis_writeups WHERE id = ?").get(Number(result.lastInsertRowid)) as unknown as WriteupRow);
}

/** The newest write-up, or the newest valid one. */
export async function latestWriteup(validOnly = false): Promise<Writeup | null> {
    const db = await jarvisDb();
    const row = db
        .prepare(`SELECT * FROM jarvis_writeups ${validOnly ? "WHERE valid = 1" : ""} ORDER BY id DESC LIMIT 1`)
        .get() as unknown as WriteupRow | undefined;
    return row ? toWriteup(row) : null;
}

export async function listWriteups(query: { since?: string; validOnly?: boolean; limit?: number } = {}): Promise<Writeup[]> {
    const db = await jarvisDb();
    const where: string[] = [];
    const args: string[] = [];
    if (query.since) {
        where.push("at >= ?");
        args.push(query.since);
    }
    if (query.validOnly) where.push("valid = 1");
    const limit = Math.max(1, Math.min(query.limit ?? 50, 500));
    const rows = db
        .prepare(`SELECT * FROM jarvis_writeups ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ${limit}`)
        .all(...args) as unknown as WriteupRow[];
    return rows.map(toWriteup);
}

/** Write-ups attempted since a time, valid or not. Caps the daily cost. */
export async function countWriteups(since: string): Promise<number> {
    const db = await jarvisDb();
    return Number((db.prepare("SELECT COUNT(*) AS n FROM jarvis_writeups WHERE at >= ?").get(since) as { n: number }).n) || 0;
}

/** Attempts made for one set of inputs. Limits retries. */
export async function countWriteupsFor(inputsHash: string): Promise<number> {
    const db = await jarvisDb();
    return Number((db.prepare("SELECT COUNT(*) AS n FROM jarvis_writeups WHERE inputs_hash = ?").get(inputsHash) as { n: number }).n) || 0;
}

// ---- a task's pull requests ---------------------------------------------------------

/** How a PR came to be linked, strongest first. */
export type PrSource = "workitem" | "user" | "created" | "worker" | "branch";
const SOURCE_RANK: Record<PrSource, number> = { workitem: 5, user: 4, created: 3, worker: 2, branch: 1 };

export interface PrReviewer {
    name: string;
    vote: number;
    isRequired: boolean;
    isContainer: boolean;
}

/** What the PR looked like when last read from ADO. */
export interface PrSnapshot {
    project: string;
    projectId: string;
    repo: string;
    repoId: string;
    title: string;
    /** active | completed | abandoned */
    status: string;
    isDraft: boolean;
    author: string;
    authorId: string;
    created: string;
    closed: string | null;
    sourceRef: string;
    targetRef: string;
    /** The newest commit on the source branch, when ADO says; a change means new commits. */
    sourceCommit?: string;
    url: string;
    /** succeeded | conflicts | queued | failure… */
    mergeStatus: string;
    reviewers: PrReviewer[];
}

export interface PrChecksSummary {
    passed: number;
    failed: number;
    running: number;
    total: number;
    failing: string[];
}

export interface TaskPr {
    taskId: string;
    org: string;
    prId: number;
    source: PrSource;
    linkedAt: string;
    hidden: boolean;
    snapshot: PrSnapshot | null;
    checks: PrChecksSummary | null;
    unresolved: number | null;
    refreshedAt: string | null;
    /** Why the last read failed, if it did. */
    error: string | null;
}

interface TaskPrRow {
    task_id: string;
    org: string;
    pr_id: number;
    source: string;
    in_workitem: number;
    linked_at: string;
    hidden: number;
    snapshot_json: string | null;
    checks_json: string | null;
    unresolved: number | null;
    refreshed_at: string | null;
    error: string | null;
}

function parseJson<T>(text: string | null): T | null {
    if (!text) return null;
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
}

const toTaskPr = (r: TaskPrRow): TaskPr => ({
    taskId: r.task_id,
    org: r.org,
    prId: Number(r.pr_id),
    // A link in ADO outranks how the app found it, for as long as ADO has it.
    source: r.in_workitem ? "workitem" : ((r.source in SOURCE_RANK ? r.source : "worker") as PrSource),
    linkedAt: r.linked_at,
    hidden: !!r.hidden,
    snapshot: parseJson<PrSnapshot>(r.snapshot_json),
    checks: parseJson<PrChecksSummary>(r.checks_json),
    unresolved: r.unresolved == null ? null : Number(r.unresolved),
    refreshedAt: r.refreshed_at,
    error: r.error,
});

const orgKey = (org: string) => org.trim().toLowerCase();

/**
 * Link a PR to a task. Linking it again keeps one row and the strongest
 * source. A PR the user unlinked stays unlinked, unless the user links it again
 * or ADO links it to the task's work item. The work item link is kept apart
 * from how the app found the PR, so it can go away when ADO drops it.
 */
export async function upsertTaskPr(
    taskId: string,
    org: string,
    prId: number,
    source: PrSource,
    snapshot?: PrSnapshot | null,
): Promise<{ pr: TaskPr; created: boolean }> {
    const db = await jarvisDb();
    const key = orgKey(org);
    const fromWorkItem = source === "workitem";
    const existing = db.prepare("SELECT * FROM jarvis_task_prs WHERE task_id = ? AND org = ? AND pr_id = ?").get(taskId, key, prId) as
        | TaskPrRow
        | undefined;
    if (!existing) {
        db.prepare(
            `INSERT INTO jarvis_task_prs (task_id, org, pr_id, source, in_workitem, linked_at, hidden, snapshot_json, refreshed_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        ).run(taskId, key, prId, source, fromWorkItem ? 1 : 0, now(), snapshot ? JSON.stringify(snapshot) : null, snapshot ? now() : null);
    } else {
        const old = existing.source as PrSource;
        // "workitem" in `source` means ADO was the only way it was found.
        const stronger = fromWorkItem ? old : old === "workitem" || (SOURCE_RANK[source] ?? 0) > (SOURCE_RANK[old] ?? 0) ? source : old;
        const unhide = source === "user" || fromWorkItem ? 0 : existing.hidden;
        db.prepare("UPDATE jarvis_task_prs SET source = ?, in_workitem = ?, hidden = ? WHERE task_id = ? AND org = ? AND pr_id = ?").run(
            stronger,
            fromWorkItem ? 1 : existing.in_workitem,
            unhide,
            taskId,
            key,
            prId,
        );
        if (snapshot) await updateTaskPr(taskId, org, prId, { snapshot });
    }
    const row = db.prepare("SELECT * FROM jarvis_task_prs WHERE task_id = ? AND org = ? AND pr_id = ?").get(taskId, key, prId) as unknown as TaskPrRow;
    return { pr: toTaskPr(row), created: !existing || (!!existing.hidden && !row.hidden) };
}

/**
 * ADO no longer links these PRs to the task's work item. A PR the app also
 * found another way stays, under that source; one ADO alone linked is unlinked.
 * Returns the PRs unlinked.
 */
export async function dropWorkItemLinks(taskId: string, keep: Array<{ org: string; prId: number }>): Promise<TaskPr[]> {
    const db = await jarvisDb();
    const kept = new Set(keep.map((k) => `${orgKey(k.org)}|${k.prId}`));
    const rows = db.prepare("SELECT * FROM jarvis_task_prs WHERE task_id = ? AND in_workitem = 1").all(taskId) as unknown as TaskPrRow[];
    const dropped: TaskPr[] = [];
    for (const r of rows) {
        if (kept.has(`${r.org}|${r.pr_id}`)) continue;
        const onlyAdo = r.source === "workitem";
        db.prepare("UPDATE jarvis_task_prs SET in_workitem = 0, hidden = ? WHERE task_id = ? AND org = ? AND pr_id = ?").run(
            onlyAdo ? 1 : r.hidden,
            taskId,
            r.org,
            r.pr_id,
        );
        if (onlyAdo && !r.hidden) dropped.push(toTaskPr({ ...r, in_workitem: 0, hidden: 1 }));
    }
    return dropped;
}

/** Store what was just read from ADO, or why it couldn't be read. */
export async function updateTaskPr(
    taskId: string,
    org: string,
    prId: number,
    patch: { snapshot?: PrSnapshot; checks?: PrChecksSummary | null; unresolved?: number | null; error?: string | null },
): Promise<void> {
    const db = await jarvisDb();
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    if (patch.snapshot) {
        sets.push("snapshot_json = ?", "refreshed_at = ?");
        args.push(JSON.stringify(patch.snapshot), now());
    }
    if (patch.checks !== undefined) {
        sets.push("checks_json = ?");
        args.push(patch.checks ? JSON.stringify(patch.checks) : null);
    }
    if (patch.unresolved !== undefined) {
        sets.push("unresolved = ?");
        args.push(patch.unresolved);
    }
    if (patch.error !== undefined) {
        sets.push("error = ?");
        args.push(patch.error ? clip(patch.error, 300) : null);
    }
    if (!sets.length) return;
    db.prepare(`UPDATE jarvis_task_prs SET ${sets.join(", ")} WHERE task_id = ? AND org = ? AND pr_id = ?`).run(...args, taskId, orgKey(org), prId);
}

/** A task's PRs, newest first. Unlinked ones only when asked. */
export async function listTaskPrs(taskId: string, options: { includeHidden?: boolean } = {}): Promise<TaskPr[]> {
    const db = await jarvisDb();
    const rows = db
        .prepare(`SELECT * FROM jarvis_task_prs WHERE task_id = ? ${options.includeHidden ? "" : "AND hidden = 0"} ORDER BY pr_id DESC`)
        .all(taskId) as unknown as TaskPrRow[];
    return rows.map(toTaskPr);
}

/** Every linked PR, for Today's cards. */
export async function listAllTaskPrs(): Promise<TaskPr[]> {
    const db = await jarvisDb();
    return (db.prepare("SELECT * FROM jarvis_task_prs WHERE hidden = 0 ORDER BY pr_id DESC").all() as unknown as TaskPrRow[]).map(toTaskPr);
}

/** Unlink a PR the app or the user linked. It isn't linked again unless the user does it. */
export async function hideTaskPr(taskId: string, org: string, prId: number): Promise<boolean> {
    const db = await jarvisDb();
    return db.prepare("UPDATE jarvis_task_prs SET hidden = 1 WHERE task_id = ? AND org = ? AND pr_id = ?").run(taskId, orgKey(org), prId).changes > 0;
}

export interface WorkerBranch {
    taskId: string;
    sessionId: string;
    org: string;
    project: string;
    repo: string;
    branch: string;
    seenAt: string;
}

/** The branch a worker's folder was on. Returns true the first time it's seen for the task. */
export async function recordWorkerBranch(b: Omit<WorkerBranch, "seenAt">): Promise<boolean> {
    const db = await jarvisDb();
    const res = db
        .prepare(
            `INSERT INTO jarvis_worker_branches (task_id, session_id, org, project, repo, branch, seen_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(task_id, org, project, repo, branch) DO NOTHING`,
        )
        .run(b.taskId, b.sessionId, orgKey(b.org), b.project, b.repo, b.branch, now());
    return res.changes > 0;
}

export async function listTaskBranches(taskId: string): Promise<WorkerBranch[]> {
    const db = await jarvisDb();
    const rows = db.prepare("SELECT * FROM jarvis_worker_branches WHERE task_id = ? ORDER BY seen_at").all(taskId) as Array<{
        task_id: string;
        session_id: string;
        org: string;
        project: string;
        repo: string;
        branch: string;
        seen_at: string;
    }>;
    return rows.map((r) => ({ taskId: r.task_id, sessionId: r.session_id, org: r.org, project: r.project, repo: r.repo, branch: r.branch, seenAt: r.seen_at }));
}

// ---- meta ---------------------------------------------------------------------------

export async function getMeta(key: string): Promise<string | null> {
    const db = await jarvisDb();
    const row = db.prepare("SELECT value FROM jarvis_meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : null;
}

export async function setMeta(key: string, value: string | null): Promise<void> {
    const db = await jarvisDb();
    if (value === null) db.prepare("DELETE FROM jarvis_meta WHERE key = ?").run(key);
    else db.prepare("INSERT INTO jarvis_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
