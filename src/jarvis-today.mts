// The Today dashboard as data: open tasks with their workers' live state, tasks
// done today, PRs waiting for the user's review, and today's review history.
// The API serves it to the page and the Lead reads it through its tools.

import type { Pr } from "./ado.mjs";
import { getWorkItemDescription, getWorkItems } from "./ado.mjs";
import {
    JarvisError,
    cleanDescription,
    cleanFolderRoot,
    createTask,
    latestStatuses,
    listAllTaskPrs,
    listEvents,
    listStatuses,
    listTasks,
    listWorkers,
    listWorktrees,
    recentFolders,
    refreshWorkItems,
    type JarvisEvent,
    type JarvisTask,
    type JarvisWorker,
    type StatusUpdate,
    type TaskPr,
    type Worktree,
} from "./jarvis-store.mjs";
import { recapState, startWorker, workerLiveState, type RecapState, type WorkerLiveState } from "./jarvis-workers.mjs";
import { validationSummaries, type ValidationSummary } from "./jarvis-validation.mjs";

export interface TodayWorker extends JarvisWorker, WorkerLiveState {
    /** The repositories it works in, on a task with a folder. */
    worktrees: Array<Pick<Worktree, "org" | "project" | "repo" | "path" | "branch" | "base">>;
}

export interface TaskUpdates {
    /** The newest status update, from any day. */
    latest: StatusUpdate | null;
    /** Today's status updates, newest first. */
    today: StatusUpdate[];
}

export interface TodayTask extends JarvisTask {
    workers: TodayWorker[];
    updates: TaskUpdates;
    /** A recap on its way, or the reason the last one failed. */
    recap: RecapState | null;
    /** Pull requests linked to the task, as last read from ADO. */
    prs: TaskPr[];
    /** The task's validation chain, its last run and any proposal; null when it has none. */
    validation: ValidationSummary | null;
}

export interface ReviewItem {
    org: string;
    project: string | undefined;
    repo: string | undefined;
    repoId: string | undefined;
    prId: number;
    title: string;
    author: string | undefined;
    created: string;
    isDraft: boolean;
    url: string;
}

export interface TodaySnapshot {
    tasks: TodayTask[];
    /** PR reviews and other review events since the start of the day. */
    reviewed: JarvisEvent[];
    folders: string[];
    /** The tasks' validation couldn't be read this time, so it's missing from them (and from Needs you). */
    validationFailed?: boolean;
}

/** Local midnight, as an ISO timestamp. */
export function startOfToday(at = new Date()): string {
    const d = new Date(at);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
}

export async function todaySnapshot(since = startOfToday()): Promise<TodaySnapshot> {
    const [tasks, workers, reviewed, folders, statuses, prs, worktrees] = await Promise.all([
        listTasks(since),
        listWorkers(),
        listEvents({ since, kinds: ["pr.reviewed"], limit: 100 }),
        recentFolders(),
        listStatuses({ since, limit: 2000 }),
        listAllTaskPrs(),
        listWorktrees(),
    ]);
    const prsByTask = new Map<string, TaskPr[]>();
    for (const pr of prs) {
        const list = prsByTask.get(pr.taskId) || [];
        list.push(pr);
        prsByTask.set(pr.taskId, list);
    }
    const treesBySession = new Map<string, TodayWorker["worktrees"]>();
    for (const w of worktrees) {
        const list = treesBySession.get(w.sessionId) || [];
        list.push({ org: w.org, project: w.project, repo: w.repo, path: w.path, branch: w.branch, base: w.base });
        treesBySession.set(w.sessionId, list);
    }
    const byTask = new Map<string, TodayWorker[]>();
    for (const worker of workers) {
        const list = byTask.get(worker.taskId) || [];
        list.push({ ...worker, ...workerLiveState(worker.sessionId), worktrees: treesBySession.get(worker.sessionId) || [] });
        byTask.set(worker.taskId, list);
    }
    const todayByTask = new Map<string, StatusUpdate[]>();
    for (const status of statuses) {
        const list = todayByTask.get(status.taskId) || [];
        list.push(status);
        todayByTask.set(status.taskId, list);
    }
    // Tasks quiet today still show their last word from an earlier day.
    let validationFailed = false;
    const [older, validation] = await Promise.all([
        latestStatuses(tasks.filter((t) => !todayByTask.has(t.id)).map((t) => t.id)),
        validationSummaries(tasks.map((t) => t.id)).catch((error: Error) => {
            console.warn(`[jarvis] validation summaries: ${error.message}`);
            validationFailed = true;
            return new Map<string, ValidationSummary>();
        }),
    ]);
    return {
        tasks: tasks.map((task) => {
            const today = todayByTask.get(task.id) || [];
            return {
                ...task,
                workers: byTask.get(task.id) || [],
                updates: { latest: today[0] || older.get(task.id) || null, today },
                recap: recapState(task.id),
                prs: prsByTask.get(task.id) || [],
                validation: validation.get(task.id) || null,
            };
        }),
        reviewed,
        folders,
        ...(validationFailed ? { validationFailed } : {}),
    };
}

// ---- PRs waiting for the user's review ----------------------------------------------

let lastPrs: { prs: Pr[]; at: number } | null = null;

/** The PR list the page last loaded; the Lead's view of the review queue. */
export function rememberPrs(prs: Pr[]): void {
    lastPrs = { prs, at: Date.now() };
}

export interface PrRef {
    org?: string | null;
    project?: string | null;
    repoId?: string | null;
    prId: string | number;
}

/**
 * Keep the remembered PR list in step with what the user did since it loaded:
 * comments, votes and hiding change which PRs still need their review, so the
 * overview and the Lead count the same queue the page shows.
 */
export function notePrActivity(refs: PrRef[], change: { commented?: boolean; vote?: number; hidden?: boolean }): void {
    if (!lastPrs) return;
    for (const ref of refs) {
        for (const pr of lastPrs.prs) {
            if (String(pr.id) !== String(ref.prId)) continue;
            if (ref.org && pr.org !== ref.org) continue;
            if (ref.project && pr.project !== ref.project) continue;
            if (ref.repoId && pr.repoId !== ref.repoId) continue;
            if (change.commented !== undefined) pr.iCommented = change.commented;
            if (change.vote !== undefined) pr.myVote = change.vote;
            if (change.hidden !== undefined) pr.plateDismissed = change.hidden;
        }
    }
}

/** Same rule as the PR feed's "Needs your review" lane, minus Copilot review state. */
export function reviewQueue(prs: Pr[] = lastPrs?.prs || []): ReviewItem[] {
    return prs
        .filter((pr) => pr.mine && !pr.authoredByMe && !pr.myVote && !pr.iCommented && !pr.plateDismissed)
        .filter((pr) => !pr.status || pr.status === "active")
        .map((pr) => ({
            org: pr.org,
            project: pr.project,
            repo: pr.repo,
            repoId: pr.repoId,
            prId: pr.id,
            title: pr.title,
            author: pr.author,
            created: pr.created,
            isDraft: !!pr.isDraft,
            url: pr.url,
        }));
}

export function reviewQueueAge(): number | null {
    return lastPrs ? Date.now() - lastPrs.at : null;
}

/** The PR list the page last loaded, if it did: Teams asks close from it (comms.mts). */
export function rememberedPrs(): Pr[] | null {
    return lastPrs?.prs ?? null;
}

// ---- tasks from work items ----------------------------------------------------------

/** "#123", "123" or a work item URL: the id, and the org when the URL names one. */
export function parseWorkItemRef(input: string): { org: string | null; id: number } | null {
    const text = input.trim();
    const url = /^https?:\/\/(?:dev\.azure\.com\/([^/]+)|([^./]+)\.visualstudio\.com)\/.*?_workitems\/edit\/(\d+)/i.exec(text);
    if (url) return { org: decodeURIComponent(url[1] || url[2]), id: Number(url[3]) };
    const bare = /^#?(\d{1,10})$/.exec(text);
    return bare ? { org: null, id: Number(bare[1]) } : null;
}

async function workItemWithParent(org: string, id: number) {
    const [item] = await getWorkItems(org, [id]);
    if (!item) throw new JarvisError(`Work item #${id} was not found in ${org}.`, 404);
    let parent: { id: number; type: string; title: string } | null = null;
    if (item.parentId) {
        const [p] = await getWorkItems(org, [item.parentId]).catch(() => []);
        if (p) parent = { id: p.id, type: p.type, title: p.title };
    }
    return { ...item, parent };
}

export interface TaskInput {
    title?: unknown;
    description?: unknown;
    workItem?: unknown;
    org?: unknown;
    project?: unknown;
    /** Where the task's own folder goes; Settings' task folder when left out. */
    folderRoot?: unknown;
}

export interface WorkItemPreview {
    org: string;
    id: number;
    title: string;
    type: string;
    state: string;
    project: string;
    description: string;
}

function workItemOrg(ref: { org: string | null }, named: unknown, organizations: string[]): string {
    const given = typeof named === "string" && named.trim() ? named.trim() : null;
    const org = ref.org || given || (organizations.length === 1 ? organizations[0] : null);
    if (!org) throw new JarvisError("Choose the organization the work item is in.");
    return org;
}

/** A work item's title and description, for the New task form to fill in before the task is made. */
export async function previewWorkItem(input: { workItem?: unknown; org?: unknown }, organizations: string[]): Promise<WorkItemPreview> {
    const ref = typeof input.workItem === "string" ? parseWorkItemRef(input.workItem) : null;
    if (!ref) throw new JarvisError("Enter a work item number, like 2841124, or paste its link.");
    const org = workItemOrg(ref, input.org, organizations);
    const [item] = await getWorkItems(org, [ref.id]);
    if (!item) throw new JarvisError(`Work item #${ref.id} was not found in ${org}.`, 404);
    const description = await getWorkItemDescription(org, ref.id).catch(() => "");
    return { org, id: item.id, title: item.title, type: item.type, state: item.state, project: item.project, description };
}

export interface CreatedTask {
    task: JarvisTask;
    created: boolean;
    /** The worker started to set the task up, on a new task with a folder. */
    worker: JarvisWorker | null;
    /** Why that worker didn't start. */
    workerError: string | null;
}

/**
 * Create a task from a work item reference (`workItem`) or a plain title. A new
 * task gets its own folder (named after its title) under `folderRoot`, or
 * Settings' task folder, and a worker starts at once to set it up: it proposes
 * the repositories, gets worktrees of the ones the user confirms, settles the
 * goal with the user, and starts.
 */
export async function createTaskFromInput(
    input: TaskInput,
    organizations: string[],
    options: { taskRoot?: string; requireFolder?: boolean } = {},
): Promise<CreatedTask> {
    const ref = typeof input.workItem === "string" && input.workItem.trim() ? parseWorkItemRef(input.workItem) : null;
    if (typeof input.workItem === "string" && input.workItem.trim() && !ref) {
        throw new JarvisError("Enter a work item number, like 2841124, or paste its link.");
    }
    const named = typeof input.folderRoot === "string" && input.folderRoot.trim() ? input.folderRoot.trim() : "";
    const folderRoot = named || options.taskRoot?.trim() || null;
    if (!folderRoot && options.requireFolder) {
        throw new JarvisError("Choose where the task's folder goes, or set the task folder in Settings.");
    }
    // Check the folder before anything is made, so a bad path doesn't leave a task behind.
    if (folderRoot) cleanFolderRoot(folderRoot);
    const description = cleanDescription(input.description);
    let result: { task: JarvisTask; created: boolean };
    if (ref) {
        const org = workItemOrg(ref, input.org, organizations);
        const item = await workItemWithParent(org, ref.id);
        const fromItem = description ? "" : await getWorkItemDescription(org, ref.id).catch(() => "");
        result = await createTask({ org, workItem: item, description: description || fromItem, folderRoot });
    } else {
        result = await createTask({
            title: typeof input.title === "string" ? input.title : "",
            description,
            org: typeof input.org === "string" ? input.org : null,
            project: typeof input.project === "string" ? input.project : null,
            folderRoot,
        });
    }
    if (!result.created || !result.task.folder) return { ...result, worker: null, workerError: null };
    try {
        const worker = await startWorker({ taskId: result.task.id });
        return { ...result, worker, workerError: null };
    } catch (error) {
        return { ...result, worker: null, workerError: (error as Error).message };
    }
}

/** Re-read every open work item task from ADO. Returns per-org errors. */
export async function refreshTaskWorkItems(): Promise<string[]> {
    const open = (await listTasks()).filter((task) => task.workItem && task.org && task.status === "open");
    const byOrg = new Map<string, number[]>();
    for (const task of open) {
        const list = byOrg.get(task.org!.toLowerCase()) || [];
        list.push(task.workItem!.id);
        byOrg.set(task.org!.toLowerCase(), list);
    }
    const errors: string[] = [];
    await Promise.all(
        [...byOrg].map(async ([org, ids]) => {
            try {
                const items = await getWorkItems(org, ids);
                const parentIds = [...new Set(items.map((i) => i.parentId).filter((id): id is number => !!id))];
                const parents = new Map((await getWorkItems(org, parentIds).catch(() => [])).map((p) => [p.id, p]));
                await refreshWorkItems(
                    org,
                    items.map((item) => {
                        const p = item.parentId ? parents.get(item.parentId) : undefined;
                        return { ...item, parent: p ? { id: p.id, type: p.type, title: p.title } : null };
                    }),
                );
            } catch (error) {
                errors.push(`${org}: ${(error as Error).message}`);
            }
        }),
    );
    return errors;
}
