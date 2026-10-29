// Jarvis: the pull requests a task's work produced, linked to the task. They are
// found without asking the worker:
//   - the work item's links in ADO (the source of truth for a work item task),
//   - the output of a command that created a PR (az repos pr create, the ADO tools),
//   - the branches the task's workers were on: your PRs from them, opened after
//     the task started.
// A worker can also link one with task_link_pr, and the user from the task. Every
// link is checked against ADO first; workers can only link PRs you opened after
// the task started. A PR the user unlinks stays unlinked.

import { execFile } from "node:child_process";
import {
    countUnresolvedThreads,
    getMe,
    getPrChecks,
    getPullRequestRaw,
    getWorkItemPrLinks,
    listBranchPrs,
    type PrChecks,
    type WorkItemInfo,
    type WorkItemPrLink,
} from "./ado.mjs";
import { readConfig } from "./config.mjs";
import {
    JarvisError,
    clip,
    describeTask,
    dropWorkItemLinks,
    getTask,
    getWorker,
    hideTaskPr,
    listTaskBranches,
    listTaskPrs,
    listTasks,
    listWorkers,
    listWorktrees,
    recordEvent,
    recordWorkerBranch,
    updateTaskPr,
    upsertTaskPr,
    type JarvisTask,
    type PrSnapshot,
    type PrSource,
    type TaskPr,
} from "./jarvis-store.mjs";

// ---- where the data comes from ------------------------------------------------------

/** ADO and git, as the module sees them. The harness swaps in a fake. */
export interface PrsRuntime {
    now(): number;
    me(org: string): Promise<{ id: string; name: string }>;
    getPr(org: string, project: string, repo: string, prId: number): Promise<any | null>;
    workItem(org: string, id: number): Promise<{ item: WorkItemInfo; prs: WorkItemPrLink[] } | null>;
    branchPrs(org: string, project: string, repo: string, branch: string, creatorId: string): Promise<any[]>;
    checks(org: string, projectId: string, prId: number): Promise<PrChecks>;
    unresolved(org: string, project: string, repoId: string, prId: number): Promise<number>;
    /** git's trimmed output, or null when it fails (not a repo, no git). */
    git(cwd: string, args: string[]): Promise<string | null>;
    /** The organizations in Settings, for their spelling. */
    orgs(): Promise<string[]>;
}

const sdkRuntime: PrsRuntime = {
    now: () => Date.now(),
    me: getMe,
    getPr: getPullRequestRaw,
    workItem: getWorkItemPrLinks,
    branchPrs: listBranchPrs,
    checks: getPrChecks,
    unresolved: countUnresolvedThreads,
    git: (cwd, args) =>
        new Promise((resolve) => {
            execFile("git", ["-C", cwd, ...args], { timeout: 5_000, windowsHide: true }, (error, stdout) =>
                resolve(error ? null : String(stdout).trim() || null),
            );
        }),
    orgs: async () => (await readConfig()).organizations || [],
};

let runtime: PrsRuntime = sdkRuntime;

export function setPrsRuntime(next: PrsRuntime | null): void {
    runtime = next || sdkRuntime;
}

export const PRS_LIMITS = {
    /** A tab that's open reads the PRs again at most this often. */
    freshMs: 60_000,
    /** The background pass, for Today's cards. */
    tickMs: 5 * 60_000,
    /** Clocks differ a little between this machine and ADO. */
    clockSlackMs: 5 * 60_000,
    concurrency: 3,
    maxTasksPerTick: 30,
};

// ---- reading PR links ---------------------------------------------------------------

export interface PrRef {
    org: string;
    /** Name or id. */
    project: string;
    /** Name or id. */
    repo: string;
    prId: number;
}

const SEG = String.raw`([^\/\s"'<>()\[\]]+)`;
const PR_LINK_PATTERNS = [
    // https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}
    new RegExp(String.raw`https?:\/\/(?:[^@\/\s]+@)?dev\.azure\.com\/${SEG}\/${SEG}\/_git\/${SEG}\/pullrequest\/(\d+)`, "gi"),
    // https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}/pullrequest/{id}
    new RegExp(String.raw`https?:\/\/([a-z0-9][a-z0-9-]*)\.visualstudio\.com\/(?:DefaultCollection\/)?${SEG}\/_git\/${SEG}\/pullrequest\/(\d+)`, "gi"),
    // The REST API's own links, as az prints them.
    new RegExp(String.raw`https?:\/\/dev\.azure\.com\/${SEG}\/${SEG}\/_apis\/git\/repositories\/${SEG}\/pullRequests\/(\d+)`, "gi"),
    new RegExp(String.raw`https?:\/\/([a-z0-9][a-z0-9-]*)\.visualstudio\.com\/(?:DefaultCollection\/)?${SEG}\/_apis\/git\/repositories\/${SEG}\/pullRequests\/(\d+)`, "gi"),
];

function decode(part: string): string {
    try {
        return decodeURIComponent(part);
    } catch {
        return part;
    }
}

/** Every Azure DevOps PR link in a text, each once, in order. */
export function parsePrRefs(text: unknown): PrRef[] {
    const source = String(text ?? "").slice(0, 400_000);
    const found: Array<PrRef & { at: number }> = [];
    for (const pattern of PR_LINK_PATTERNS) {
        pattern.lastIndex = 0;
        for (const m of source.matchAll(pattern)) {
            const prId = Number(m[4]);
            if (!Number.isSafeInteger(prId) || prId < 1) continue;
            found.push({ org: decode(m[1]).toLowerCase(), project: decode(m[2]), repo: decode(m[3]), prId, at: m.index ?? 0 });
        }
    }
    const seen = new Set<string>();
    return found
        .sort((a, b) => a.at - b.at)
        .filter((r) => {
            const key = `${r.org}|${r.prId}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .map(({ at: _at, ...ref }) => ref);
}

export interface RepoRef {
    org: string;
    project: string;
    repo: string;
}

/** An Azure DevOps git remote, over https or ssh. Null for anything else. */
export function parseRemote(url: unknown): RepoRef | null {
    const u = String(url ?? "")
        .trim()
        .replace(/\.git$/i, "")
        .replace(/\/+$/, "");
    const patterns = [
        /^https?:\/\/(?:[^@\/]+@)?dev\.azure\.com\/([^\/]+)\/([^\/]+)\/_git\/([^\/]+)$/i,
        /^https?:\/\/(?:[^@\/]+@)?([a-z0-9][a-z0-9-]*)\.visualstudio\.com\/(?:DefaultCollection\/)?([^\/]+)\/_git\/([^\/]+)$/i,
        /^(?:ssh:\/\/)?[^@\s]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com):v3\/([^\/]+)\/([^\/]+)\/([^\/]+)$/i,
    ];
    for (const p of patterns) {
        const m = p.exec(u);
        if (m) return { org: decode(m[1]).toLowerCase(), project: decode(m[2]), repo: decode(m[3]) };
    }
    return null;
}

/** A PR number written on its own: "17553390", "#17553390" or "!17553390". */
function bareNumber(text: string): number | null {
    const m = /^\s*[#!]?(\d{1,10})\s*$/.exec(text);
    const n = m ? Number(m[1]) : NaN;
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export interface ToolCall {
    toolName?: string;
    mcpToolName?: string;
    arguments?: unknown;
}

/** Whether a tool call creates a pull request: az repos pr create, a REST POST, or an ADO tool's create. */
export function isPrCreateCall(call: ToolCall): boolean {
    const name = String(call.mcpToolName || call.toolName || "");
    const args = (call.arguments && typeof call.arguments === "object" ? call.arguments : {}) as Record<string, unknown>;
    if (/pull_?requests?/i.test(name)) {
        // Threads, comments, reviewers and votes live under a PR; creating one doesn't create the PR.
        if (/thread|comment|reviewer|vote|label|status|iteration|attachment/i.test(name)) return false;
        if (/create/i.test(name)) return true;
        return String(args.action ?? args.operation ?? "").toLowerCase() === "create";
    }
    const command = typeof args.command === "string" ? args.command : "";
    if (!command) return false;
    if (/\baz(?:\.cmd)?\s+repos\s+pr\s+create\b/i.test(command)) return true;
    if (/\baz(?:\.cmd)?\s+devops\s+invoke\b/i.test(command) && /--resource\s+pullrequests\b/i.test(command) && /--http-method\s+post\b/i.test(command)) {
        return true;
    }
    // A POST to the pullrequests collection itself, not to a PR's threads or reviewers.
    return (
        /_apis\/git\/repositories\/[^\s'"\/]+\/pullrequests(?=$|[?'"\s`])/i.test(command) &&
        /(-Method\s+['"]?Post\b|--request\s+POST\b|-X\s*POST\b|\s--data\b|\s-d\s)/i.test(command)
    );
}

/** Where a create call says it worked: its org, project and repo arguments, when it has them. */
export function callRepo(call: ToolCall): Partial<RepoRef> {
    const args = (call.arguments && typeof call.arguments === "object" ? call.arguments : {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const org = str(args.orgName) || str(args.organization) || str(args.org);
    return {
        org: org ? (parseRemote(org)?.org ?? org.replace(/^https?:\/\/dev\.azure\.com\//i, "").replace(/\/+$/, "")).toLowerCase() : undefined,
        project: str(args.project),
        repo: str(args.repositoryId) || str(args.repository) || str(args.repo),
    };
}

/** The PRs a create call's output names: links first, else its pullRequestId in the call's or folder's repo. */
export function refsFromCreateOutput(output: unknown, where: Partial<RepoRef>): PrRef[] {
    const text = String(output ?? "");
    const refs = parsePrRefs(text);
    if (refs.length) return refs;
    const m = /"pullRequestId"\s*:\s*(\d+)/.exec(text);
    const prId = m ? Number(m[1]) : NaN;
    if (!Number.isSafeInteger(prId) || prId < 1 || !where.org || !where.project || !where.repo) return [];
    return [{ org: where.org, project: where.project, repo: where.repo, prId }];
}

// ---- snapshots ----------------------------------------------------------------------

let orgSpelling: Map<string, string> | null = null;

async function spelled(org: string): Promise<string> {
    if (!orgSpelling) {
        orgSpelling = new Map();
        for (const o of await runtime.orgs().catch(() => [] as string[])) orgSpelling.set(o.toLowerCase(), o);
    }
    return orgSpelling.get(org.toLowerCase()) || org;
}

/** What the page shows of a PR, from ADO's record. */
export function snapshotOf(org: string, raw: any): PrSnapshot {
    const repo = raw?.repository || {};
    const project = repo.project || {};
    const strip = (ref: unknown) => String(ref || "").replace(/^refs\/heads\//, "");
    const enc = encodeURIComponent;
    // ADO writes "0001-01-01T00:00:00" for a date that never happened.
    const date = (value: unknown) => (typeof value === "string" && value && !value.startsWith("0001-") ? value : null);
    return {
        project: String(project.name || ""),
        projectId: String(project.id || ""),
        repo: String(repo.name || ""),
        repoId: String(repo.id || ""),
        title: clip(String(raw?.title || `Pull request ${raw?.pullRequestId}`), 300),
        status: String(raw?.status || "active").toLowerCase(),
        isDraft: !!raw?.isDraft,
        author: String(raw?.createdBy?.displayName || ""),
        authorId: String(raw?.createdBy?.id || ""),
        created: date(raw?.creationDate) || "",
        closed: date(raw?.closedDate),
        sourceRef: strip(raw?.sourceRefName),
        targetRef: strip(raw?.targetRefName),
        ...(typeof raw?.lastMergeSourceCommit?.commitId === "string" ? { sourceCommit: String(raw.lastMergeSourceCommit.commitId) } : {}),
        url: `https://dev.azure.com/${enc(org)}/${enc(String(project.name || ""))}/_git/${enc(String(repo.name || ""))}/pullrequest/${raw?.pullRequestId}`,
        mergeStatus: String(raw?.mergeStatus || "").toLowerCase(),
        reviewers: ((raw?.reviewers || []) as any[]).slice(0, 40).map((r) => ({
            name: String(r?.displayName || "Reviewer"),
            vote: typeof r?.vote === "number" ? r.vote : 0,
            isRequired: !!r?.isRequired,
            isContainer: !!r?.isContainer,
        })),
    };
}

// ---- linking ------------------------------------------------------------------------

interface Rules {
    /** Only PRs the signed-in user opened. */
    mine?: boolean;
    /** Only PRs opened after this time (minus a little clock slack). */
    notBefore?: string;
}

function createdTooEarly(raw: any, notBefore: string | undefined): boolean {
    if (!notBefore) return false;
    const created = Date.parse(String(raw?.creationDate || ""));
    return Number.isFinite(created) && created < Date.parse(notBefore) - PRS_LIMITS.clockSlackMs;
}

async function checkRules(org: string, raw: any, rules: Rules): Promise<void> {
    if (rules.mine) {
        const me = await runtime.me(org);
        if (raw?.createdBy?.id !== me.id) {
            throw new JarvisError(`Pull request ${raw.pullRequestId} was opened by ${raw?.createdBy?.displayName || "someone else"}, not you.`, 403);
        }
    }
    if (createdTooEarly(raw, rules.notBefore)) {
        throw new JarvisError(`Pull request ${raw.pullRequestId} was opened before this task started.`, 409);
    }
}

/** Read the PR from ADO, check it, and link it to the task. */
async function linkRef(task: JarvisTask, ref: PrRef, source: PrSource, rules: Rules): Promise<{ pr: TaskPr; created: boolean }> {
    const org = await spelled(ref.org);
    const raw = await runtime.getPr(org, ref.project, ref.repo, ref.prId);
    if (!raw) throw new JarvisError(`Pull request ${ref.prId} wasn't found in ${org}/${ref.project}/${ref.repo}.`, 404);
    await checkRules(org, raw, rules);
    return saveLink(task, org, raw, source);
}

async function saveLink(task: JarvisTask, org: string, raw: any, source: PrSource): Promise<{ pr: TaskPr; created: boolean }> {
    const result = await upsertTaskPr(task.id, org, raw.pullRequestId, source, snapshotOf(org, raw));
    if (result.created) {
        await recordEvent("task.pr", `PR ${raw.pullRequestId} linked to ${describeTask(task)}: ${clip(String(raw.title || ""), 200)}`, {
            taskId: task.id,
            ref: { org, prId: raw.pullRequestId, source },
        });
    }
    return result;
}

async function requireTask(taskId: unknown): Promise<JarvisTask> {
    const task = typeof taskId === "string" ? await getTask(taskId) : null;
    if (!task) throw new JarvisError("Task not found.", 404);
    return task;
}

/** The repo a worker's folder belongs to, from its git remote. */
async function workerRepo(cwd: string): Promise<RepoRef | null> {
    return parseRemote(await runtime.git(cwd, ["remote", "get-url", "origin"]));
}

/**
 * The git folders a worker works in and their repos: its worktrees on a task
 * with a folder, else its own folder.
 */
async function workerRepos(worker: { sessionId: string; cwd: string }): Promise<Array<{ path: string; repo: RepoRef | null }>> {
    const worktrees = await listWorktrees({ sessionId: worker.sessionId });
    if (worktrees.length) return worktrees.map((w) => ({ path: w.path, repo: { org: w.org, project: w.project, repo: w.repo } }));
    return [{ path: worker.cwd, repo: await workerRepo(worker.cwd) }];
}

/** The worker's one repo, when it works in exactly one. */
async function soleRepo(worker: { sessionId: string; cwd: string }): Promise<RepoRef | null> {
    const repos = await workerRepos(worker);
    return repos.length === 1 ? repos[0].repo : null;
}

/** A PR link the user pasted. Any PR they can see, opened by anyone, any time. */
export async function linkFromUser(taskId: unknown, input: unknown): Promise<TaskPr> {
    const task = await requireTask(taskId);
    const [ref] = parsePrRefs(input);
    if (!ref) throw new JarvisError("Paste the pull request's link from Azure DevOps.");
    return (await linkRef(task, ref, "user", {})).pr;
}

/**
 * task_link_pr: a worker links a PR it opened. Its link, or its number in the
 * worker folder's repo. Only your PRs, opened after the task started.
 */
export async function linkFromWorker(sessionId: string, input: unknown): Promise<string> {
    const worker = await getWorker(sessionId);
    if (!worker) return "This session is not one of the Workspace's workers.";
    try {
        const task = await requireTask(worker.taskId);
        const text = String(input ?? "");
        let refs = parsePrRefs(text);
        if (!refs.length) {
            const n = bareNumber(text);
            const repos = n ? await workerRepos(worker) : [];
            const repo = repos.length === 1 ? repos[0].repo : null;
            if (n && !repo) {
                return repos.length > 1
                    ? "Pass the PR's full link: you work in several repositories, so the number alone doesn't say which."
                    : `Pass the PR's full link: ${worker.cwd} isn't an Azure DevOps git repository.`;
            }
            if (n && repo) refs = [{ ...repo, prId: n }];
        }
        if (!refs.length) return "Pass the pull request's link, or its number.";
        const lines: string[] = [];
        for (const ref of refs.slice(0, 5)) {
            try {
                const { created } = await linkRef(task, ref, "worker", { mine: true, notBefore: task.createdAt });
                lines.push(created ? `Linked PR ${ref.prId} to the task.` : `PR ${ref.prId} is already linked to the task.`);
            } catch (error) {
                lines.push(`PR ${ref.prId} not linked: ${(error as Error).message}`);
            }
        }
        return lines.join("\n");
    } catch (error) {
        return `Not linked: ${(error as Error).message}`;
    }
}

/** A PR-creating call just finished: link what it created. Never throws. */
export async function notePrCreated(sessionId: string, output: unknown, call: ToolCall): Promise<void> {
    try {
        const worker = await getWorker(sessionId);
        if (!worker) return;
        const task = await getTask(worker.taskId);
        if (!task) return;
        const fromCall = callRepo(call);
        const folder = await soleRepo(worker);
        const where = fromCall.org && fromCall.project && fromCall.repo ? fromCall : { ...(folder || {}), ...stripEmpty(fromCall) };
        for (const ref of refsFromCreateOutput(output, where).slice(0, 5)) {
            await linkRef(task, ref, "created", { mine: true, notBefore: task.createdAt }).catch((error: Error) =>
                console.warn(`[jarvis] PR ${ref.prId} from ${worker.label} not linked: ${error.message}`),
            );
        }
    } catch (error) {
        console.warn(`[jarvis] reading a created PR failed: ${(error as Error).message}`);
    }
}

function stripEmpty(r: Partial<RepoRef>): Partial<RepoRef> {
    return Object.fromEntries(Object.entries(r).filter(([, v]) => !!v)) as Partial<RepoRef>;
}

/** Branches every PR comes from, never a task's own. */
const SHARED_BRANCH = /^(?:main|master|dev|develop|development|trunk|HEAD)$/i;

const turnNotes = new Map<string, Promise<void>>();

/**
 * A worker's turn ended: note the branch its folder is on, and link your PRs
 * from that branch opened since the task started. Never throws.
 */
export function noteWorkerTurn(sessionId: string): Promise<void> {
    const running = turnNotes.get(sessionId);
    if (running) return running;
    const job = (async () => {
        try {
            const worker = await getWorker(sessionId);
            if (!worker) return;
            for (const b of await recordBranches(worker)) await linkBranchPrs(worker.taskId, b);
        } catch (error) {
            console.warn(`[jarvis] branch check after a turn failed: ${(error as Error).message}`);
        }
    })().finally(() => turnNotes.delete(sessionId));
    turnNotes.set(sessionId, job);
    return job;
}

/** The task's branches the worker's folders are on now, noted. A shared branch or a folder with no ADO repo is left out. */
async function recordBranches(worker: { sessionId: string; taskId: string; cwd: string }): Promise<Array<RepoRef & { branch: string }>> {
    const out: Array<RepoRef & { branch: string }> = [];
    for (const { path, repo } of await workerRepos(worker)) {
        const branch = await runtime.git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
        if (!branch || SHARED_BRANCH.test(branch) || /\s/.test(branch) || !repo) continue;
        await recordWorkerBranch({ taskId: worker.taskId, sessionId: worker.sessionId, ...repo, branch });
        out.push({ ...repo, branch });
    }
    return out;
}

async function linkBranchPrs(taskId: string, b: RepoRef & { branch: string }): Promise<void> {
    const task = await getTask(taskId);
    if (!task) return;
    const org = await spelled(b.org);
    const me = await runtime.me(org);
    for (const raw of await runtime.branchPrs(org, b.project, b.repo, b.branch, me.id)) {
        if (raw?.createdBy?.id !== me.id || createdTooEarly(raw, task.createdAt)) continue;
        await saveLink(task, org, raw, "branch");
    }
}

/** Unlink a PR the app or the user linked. One linked in ADO stays: it's ADO's link. */
export async function unlinkPr(taskId: unknown, org: unknown, prId: unknown): Promise<void> {
    const task = await requireTask(taskId);
    const id = Number(prId);
    const row = (await listTaskPrs(task.id, { includeHidden: true })).find(
        (p) => p.org === String(org ?? "").toLowerCase() && p.prId === id,
    );
    if (!row) throw new JarvisError("That pull request isn't linked to this task.", 404);
    if (row.source === "workitem") {
        throw new JarvisError("This pull request is linked to the work item in Azure DevOps. Remove the link there to take it off the task.", 409);
    }
    await hideTaskPr(task.id, row.org, row.prId);
    await recordEvent("task.pr", `PR ${row.prId} unlinked from ${describeTask(task)}.`, { taskId: task.id, ref: { org: row.org, prId: row.prId } });
}

// ---- keeping them current -----------------------------------------------------------

interface SyncState {
    running: Promise<void> | null;
    /** When the last pass ended, and the last one that read checks and comments. */
    syncedAt: number;
    detailAt: number;
    error: string | null;
}

const syncs = new Map<string, SyncState>();

function syncState(taskId: string): SyncState {
    let s = syncs.get(taskId);
    if (!s) {
        s = { running: null, syncedAt: 0, detailAt: 0, error: null };
        syncs.set(taskId, s);
    }
    return s;
}

async function mapLimit<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) await run(items[next++]);
    });
    await Promise.all(lanes);
}

/**
 * Find the task's PRs again and read them from ADO. With `detail`, also their
 * checks and open comments. One pass per task at a time: a second call joins it.
 */
export function syncTaskPrs(taskId: string, options: { detail?: boolean } = {}): Promise<void> {
    const s = syncState(taskId);
    if (s.running) return s.running;
    const job = runSync(taskId, !!options.detail, s).finally(() => {
        s.running = null;
    });
    s.running = job;
    return job;
}

async function runSync(taskId: string, detail: boolean, s: SyncState): Promise<void> {
    const task = await getTask(taskId);
    if (!task) {
        syncs.delete(taskId);
        return;
    }
    const problems: string[] = [];
    const read = new Set<string>();
    const key = (org: string, prId: number) => `${org.toLowerCase()}|${prId}`;

    // The work item's own links in ADO.
    if (task.workItem && task.org) {
        try {
            const org = await spelled(task.org);
            const wi = await runtime.workItem(org, task.workItem.id);
            const linked = new Set((await listTaskPrs(task.id, { includeHidden: true })).map((p) => key(p.org, p.prId)));
            for (const link of wi?.prs || []) {
                if (linked.has(key(org, link.prId))) {
                    await upsertTaskPr(task.id, org, link.prId, "workitem");
                    continue;
                }
                const raw = await runtime.getPr(org, link.projectId, link.repoId, link.prId).catch(() => null);
                if (!raw) continue;
                await saveLink(task, org, raw, "workitem");
                read.add(key(org, link.prId));
            }
            // Links removed in ADO come off the task too, unless the app also found the PR another way.
            for (const gone of await dropWorkItemLinks(task.id, (wi?.prs || []).map((l) => ({ org, prId: l.prId })))) {
                await recordEvent("task.pr", `PR ${gone.prId} is no longer linked to ${describeTask(task)}'s work item, so it was unlinked.`, {
                    taskId: task.id,
                    ref: { org: gone.org, prId: gone.prId },
                });
            }
        } catch (error) {
            problems.push(`Couldn't read the work item's links: ${(error as Error).message}`);
        }
    }

    // Your PRs from the branches the task's workers were on, and the ones they're on now.
    for (const w of await listWorkers(task.id)) {
        await recordBranches(w).catch(() => null);
    }
    for (const b of await listTaskBranches(task.id)) {
        try {
            await linkBranchPrs(task.id, b);
        } catch (error) {
            problems.push(`Couldn't read PRs from ${b.branch}: ${(error as Error).message}`);
        }
    }

    // Everything linked, read again.
    const prs = (await listTaskPrs(task.id)).filter((p) => p.snapshot);
    await mapLimit(prs, PRS_LIMITS.concurrency, async (p) => {
        const snap = p.snapshot!;
        try {
            let current = snap;
            if (!read.has(key(p.org, p.prId))) {
                const org = await spelled(p.org);
                const raw = await runtime.getPr(org, snap.projectId || snap.project, snap.repoId || snap.repo, p.prId);
                if (!raw) {
                    await updateTaskPr(task.id, p.org, p.prId, { error: "Not found in Azure DevOps anymore." });
                    return;
                }
                current = snapshotOf(org, raw);
                await updateTaskPr(task.id, p.org, p.prId, { snapshot: current, error: null });
            }
            if (detail && current.status === "active") {
                const org = await spelled(p.org);
                const [checks, unresolved] = await Promise.all([
                    runtime.checks(org, current.projectId, p.prId).catch(() => null),
                    runtime.unresolved(org, current.projectId || current.project, current.repoId, p.prId).catch(() => null),
                ]);
                await updateTaskPr(task.id, p.org, p.prId, {
                    ...(checks ? { checks } : {}),
                    ...(unresolved !== null ? { unresolved } : {}),
                });
            }
        } catch (error) {
            await updateTaskPr(task.id, p.org, p.prId, { error: (error as Error).message });
        }
    });

    const at = runtime.now();
    s.syncedAt = at;
    if (detail) s.detailAt = at;
    s.error = problems.length ? clip(problems.join(" "), 400) : null;
}

export interface TaskPrsView {
    prs: TaskPr[];
    syncing: boolean;
    syncedAt: string | null;
    error: string | null;
}

/** The task's linked PRs as stored, starting a pass when they're due (or when asked). */
export async function taskPrsView(taskId: unknown, options: { refresh?: boolean } = {}): Promise<TaskPrsView> {
    const task = await requireTask(taskId);
    const s = syncState(task.id);
    const due = runtime.now() - s.detailAt > PRS_LIMITS.freshMs;
    if (!s.running && (options.refresh || due)) {
        void syncTaskPrs(task.id, { detail: true }).catch((error: Error) => {
            s.error = error.message;
        });
    }
    return {
        prs: await listTaskPrs(task.id),
        syncing: !!s.running,
        syncedAt: s.syncedAt ? new Date(s.syncedAt).toISOString() : null,
        error: s.error,
    };
}

/** Resolves once no pass is running (the harness). */
export async function prsIdle(): Promise<void> {
    await Promise.all([...syncs.values()].map((s) => s.running?.catch(() => undefined)));
    await Promise.all([...turnNotes.values()]);
}

// ---- the background pass ------------------------------------------------------------

const runner: { timer: ReturnType<typeof setInterval> | null; stopped: boolean; ticking: Promise<void> | null } = {
    timer: null,
    stopped: false,
    ticking: null,
};

/** One pass over the tasks on Today that can have PRs, so their cards stay current. */
export async function prsTick(): Promise<void> {
    if (runner.ticking) return runner.ticking;
    runner.ticking = (async () => {
        const since = new Date(runtime.now());
        since.setHours(0, 0, 0, 0);
        const listed = await listTasks(since.toISOString());
        // Tasks that left Today don't need their sync bookkeeping; opening one starts afresh.
        const onToday = new Set(listed.map((t) => t.id));
        for (const [id, s] of [...syncs]) if (!s.running && !onToday.has(id)) syncs.delete(id);
        const tasks = listed.slice(0, PRS_LIMITS.maxTasksPerTick);
        const due: string[] = [];
        for (const task of tasks) {
            if (runner.stopped) return;
            const s = syncState(task.id);
            if (s.running || runtime.now() - s.syncedAt < PRS_LIMITS.tickMs - 10_000) continue;
            const can =
                !!task.workItem ||
                (await listWorkers(task.id)).length > 0 ||
                (await listTaskBranches(task.id)).length > 0 ||
                (await listTaskPrs(task.id)).length > 0;
            if (can) due.push(task.id);
        }
        await mapLimit(due, 2, async (id) => {
            if (!runner.stopped) await syncTaskPrs(id).catch(() => undefined);
        });
    })().finally(() => {
        runner.ticking = null;
    });
    return runner.ticking;
}

const logTick = (error: Error) => console.warn(`[jarvis] PR pass failed: ${error.message}`);

export function startPrsRunner(): void {
    if (runner.timer) return;
    runner.stopped = false;
    runner.timer = setInterval(() => void prsTick().catch(logTick), PRS_LIMITS.tickMs);
    runner.timer.unref?.();
    void prsTick().catch(logTick);
}

/** Start the runner if the app didn't (dev server). Never restarts a stopped one. */
export function ensurePrsRunner(): void {
    if (!runner.timer && !runner.stopped) startPrsRunner();
}

export async function stopPrsRunner(): Promise<void> {
    runner.stopped = true;
    if (runner.timer) clearInterval(runner.timer);
    runner.timer = null;
    await runner.ticking?.catch(() => undefined);
    await prsIdle();
}

/** Back to a clean slate (the harness). */
export function resetPrs(): void {
    if (runner.timer) clearInterval(runner.timer);
    runner.timer = null;
    runner.stopped = false;
    syncs.clear();
    turnNotes.clear();
    orgSpelling = null;
}
