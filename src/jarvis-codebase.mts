// Jarvis' codebase: the repos chosen in Settings, each cloned once under the
// Jarvis folder (codebase/<org>/<project>/<repo>), and the git worktrees that
// workers get of them. A worker on a task with a folder works in
// <task folder>/<worker>/<repo>, one worktree per repo, on its own branch
// (<you>/<task>/<worker>) off the repo's default branch, fetched fresh.
// Every git step here is deterministic and run by the app, never by an agent.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { codebaseKey, readConfig, type CodebaseRepo } from "./config.mjs";
import { getAdoToken, getMyAccount, repoCloneUrl } from "./ado.mjs";
import { JarvisError, jarvisDir } from "./jarvis-store.mjs";

/** What runs git and reads the user's identity. The harness swaps in local remotes. */
export interface CodebaseRuntime {
    git(args: string[], opts: { cwd?: string; timeoutMs: number; token?: string | null }): Promise<string>;
    /** An Azure DevOps token for git over HTTPS, or null to use git's own credentials. */
    token(): Promise<string | null>;
    cloneUrl(repo: CodebaseRepo): string;
    /** The signed-in user's account name (an email), or null. */
    account(org: string): Promise<string | null>;
}

function runGit(args: string[], opts: { cwd?: string; timeoutMs: number; token?: string | null }): Promise<string> {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
    // The token rides in the environment, so it's neither on the command line nor saved in the clone's config.
    if (opts.token) {
        env.GIT_CONFIG_COUNT = "1";
        env.GIT_CONFIG_KEY_0 = "http.extraHeader";
        env.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${opts.token}`;
    }
    return new Promise((resolvePromise, reject) => {
        execFile(
            "git",
            ["-c", "core.longpaths=true", ...args],
            { cwd: opts.cwd, timeout: opts.timeoutMs, windowsHide: true, env, maxBuffer: 16 * 1024 * 1024 },
            (error, stdout, stderr) => {
                if (error) reject(new Error(gitError(String(stderr || ""), error)));
                else resolvePromise(String(stdout).trim());
            },
        );
    });
}

function gitError(stderr: string, error: Error & { killed?: boolean }): string {
    if (error.killed) return "git took too long and was stopped.";
    const lines = stderr
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !/^(hint|warning):/i.test(l));
    const fatal = lines.find((l) => /^(fatal|error):/i.test(l));
    return (fatal || lines[lines.length - 1] || error.message).replace(/^(fatal|error):\s*/i, "").slice(0, 400);
}

const sdkRuntime: CodebaseRuntime = {
    git: runGit,
    token: () => getAdoToken().catch(() => null),
    cloneUrl: (r) => repoCloneUrl(r.org, r.project, r.repo),
    account: (org) => getMyAccount(org).catch(() => null),
};

let runtime: CodebaseRuntime = sdkRuntime;

export function setCodebaseRuntime(next: CodebaseRuntime | null): void {
    runtime = next || sdkRuntime;
    ownerCache = null;
}

export const GIT_LIMITS = {
    cloneMs: 60 * 60_000,
    fetchMs: 10 * 60_000,
    worktreeMs: 10 * 60_000,
    quickMs: 30_000,
};

/** A network git command: with the az token first, then with git's own credentials if that's refused. */
async function remoteGit(args: string[], cwd: string | undefined, timeoutMs: number): Promise<string> {
    const token = await runtime.token();
    try {
        return await runtime.git(args, { cwd, timeoutMs, token });
    } catch (error) {
        if (!token) throw error;
        return runtime.git(args, { cwd, timeoutMs, token: null });
    }
}

// ---- where things go ----------------------------------------------------------------

export function codebaseDir(): string {
    return join(jarvisDir(), "codebase");
}

/** A name as a single folder name on Windows. */
export function folderSegment(name: string): string {
    const s = name
        .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
        .replace(/[. ]+$/, "")
        .trim();
    return s || "_";
}

export function clonePath(r: CodebaseRepo): string {
    return join(codebaseDir(), folderSegment(r.org), folderSegment(r.project), folderSegment(r.repo));
}

/** True when `child` is strictly inside `parent`. */
export function isInside(child: string, parent: string): boolean {
    const rel = relative(resolve(parent), resolve(child));
    return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

/** A folder the app made and may delete: a full path, below a drive's top level. */
function deletable(path: string | null | undefined): path is string {
    if (!path || !isAbsolute(path)) return false;
    const full = resolve(path);
    return full !== parse(full).root && dirname(full) !== parse(full).root;
}

function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

// ---- one git operation at a time per clone ------------------------------------------

const queues = new Map<string, Promise<unknown>>();

function serial<T>(clone: string, job: () => Promise<T>): Promise<T> {
    const key = resolve(clone).toLowerCase();
    const before = queues.get(key) || Promise.resolve();
    const run = before.catch(() => undefined).then(job);
    const tail = run.catch(() => undefined);
    queues.set(key, tail);
    void tail.then(() => {
        if (queues.get(key) === tail) queues.delete(key);
    });
    return run;
}

// ---- clones -------------------------------------------------------------------------

export type CloneState = "ready" | "cloning" | "missing" | "error";

export interface CodebaseEntry extends CodebaseRepo {
    key: string;
    path: string;
    state: CloneState;
    error: string | null;
}

const cloning = new Map<string, Promise<string>>();
const cloneErrors = new Map<string, string>();

function isCloned(path: string): boolean {
    return existsSync(join(path, ".git"));
}

function entryOf(r: CodebaseRepo): CodebaseEntry {
    const key = codebaseKey(r);
    const path = clonePath(r);
    const id = key.toLowerCase();
    const state: CloneState = cloning.has(id) ? "cloning" : isCloned(path) ? "ready" : cloneErrors.has(id) ? "error" : "missing";
    return { ...r, key, path, state, error: state === "error" ? cloneErrors.get(id) || null : null };
}

/** The repos in Settings and whether each is cloned yet. */
export async function codebaseStatus(): Promise<CodebaseEntry[]> {
    return (await readConfig()).codebase.map(entryOf);
}

/** Start cloning every repo in Settings that isn't cloned yet. */
export async function syncCodebase(): Promise<CodebaseEntry[]> {
    const repos = (await readConfig()).codebase;
    for (const r of repos) {
        const entry = entryOf(r);
        if (entry.state === "missing" || entry.state === "error") void ensureClone(r).catch(() => undefined);
    }
    return repos.map(entryOf);
}

/** Clones in flight, for what keeps the background service up. */
export function clonesInFlight(): string[] {
    return [...cloning.keys()];
}

/** The repo's clone, made first if it isn't there. Clones once even when asked twice. */
export function ensureClone(r: CodebaseRepo): Promise<string> {
    const path = clonePath(r);
    if (isCloned(path)) return Promise.resolve(path);
    const id = codebaseKey(r).toLowerCase();
    let job = cloning.get(id);
    if (!job) {
        job = (async () => {
            mkdirSync(dirname(path), { recursive: true });
            // Clone beside it, then move it in: a clone that fails or is cut short leaves nothing half-made.
            const partial = `${path}.partial-${randomUUID().slice(0, 8)}`;
            try {
                // The clone itself keeps no checkout: workers work in worktrees of it.
                await remoteGit(["clone", "--no-checkout", runtime.cloneUrl(r), partial], undefined, GIT_LIMITS.cloneMs);
                await moveInto(partial, path);
            } catch (error) {
                rmSync(partial, { recursive: true, force: true, maxRetries: 3 });
                throw error;
            }
            cloneErrors.delete(id);
            return path;
        })();
        cloning.set(id, job);
        job.then(
            () => cloning.delete(id),
            (error: Error) => {
                cloning.delete(id);
                cloneErrors.set(id, error.message);
                console.warn(`[jarvis] cloning ${codebaseKey(r)} failed: ${error.message}`);
            },
        );
    }
    return job;
}

async function moveInto(from: string, to: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try {
            renameSync(from, to);
            return;
        } catch (error) {
            // A virus scanner can hold the new clone's files for a moment.
            if (attempt >= 10) throw error;
            await new Promise((r) => setTimeout(r, 500));
        }
    }
}

/** The branch new work starts from: origin's default branch, like origin/main. */
async function defaultBase(clone: string): Promise<string> {
    const read = () => runtime.git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: clone, timeoutMs: GIT_LIMITS.quickMs }).catch(() => "");
    let ref = await read();
    if (!ref) {
        await remoteGit(["remote", "set-head", "origin", "--auto"], clone, GIT_LIMITS.fetchMs).catch(() => "");
        ref = await read();
    }
    if (ref) return ref;
    for (const candidate of ["origin/main", "origin/master", "origin/dev"]) {
        if (await refExists(clone, `refs/remotes/${candidate}`)) return candidate;
    }
    throw new JarvisError("Couldn't tell the repository's default branch.", 502);
}

async function refExists(clone: string, ref: string): Promise<boolean> {
    return runtime.git(["show-ref", "--verify", "--quiet", ref], { cwd: clone, timeoutMs: GIT_LIMITS.quickMs }).then(
        () => true,
        () => false,
    );
}

// ---- branches -----------------------------------------------------------------------

let ownerCache: string | null = null;

/** Who branches are named for: the user's alias from their ADO account, else their git email, else their Windows name. */
export async function branchOwner(org: string | null): Promise<string> {
    if (ownerCache) return ownerCache;
    const fromAccount = org ? await runtime.account(org) : null;
    const fromGit = fromAccount
        ? null
        : await runtime.git(["config", "--global", "user.email"], { timeoutMs: GIT_LIMITS.quickMs }).catch(() => "");
    let name = (fromAccount || fromGit || "").split("@")[0];
    if (!name) {
        try {
            name = userInfo().username;
        } catch {
            name = "";
        }
    }
    const clean = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
    ownerCache = clean || "jarvis";
    return ownerCache;
}

/** A branch name git accepts, from slash-separated parts. */
async function validBranch(parts: string[]): Promise<string> {
    const name = parts.filter(Boolean).join("/");
    const ok = await runtime.git(["check-ref-format", "--branch", name], { timeoutMs: GIT_LIMITS.quickMs }).then(
        () => true,
        () => false,
    );
    if (ok) return name;
    return parts
        .map((p) => p.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "x")
        .join("/");
}

// ---- worktrees ----------------------------------------------------------------------

export interface NewWorktree {
    repo: CodebaseRepo;
    /** The worker's folder; the worktree goes in a folder named after the repo. */
    workerFolder: string;
    /** The task folder's name, for the branch. */
    taskName: string;
    workerName: string;
    /** Repo folder names already used in the worker's folder. */
    taken?: string[];
}

export interface MadeWorktree {
    path: string;
    branch: string;
    base: string;
    clonePath: string;
}

/**
 * A worktree of the repo in the worker's folder, on a new branch
 * <you>/<task>/<worker> off origin's default branch, fetched first.
 */
export async function addWorktree(input: NewWorktree): Promise<MadeWorktree> {
    const clone = await ensureClone(input.repo);
    const taken = new Set((input.taken || []).map((t) => t.toLowerCase()));
    const folder = folderSegment(input.repo.repo);
    let name = folder;
    for (let n = 2; taken.has(name.toLowerCase()) || existsSync(join(input.workerFolder, name)); n++) name = `${folder}-${n}`;
    const path = join(input.workerFolder, name);
    const wanted = await validBranch([await branchOwner(input.repo.org), input.taskName, input.workerName]);
    return serial(clone, async () => {
        await remoteGit(["fetch", "origin", "--prune", "--quiet"], clone, GIT_LIMITS.fetchMs);
        const base = await defaultBase(clone);
        let branch = wanted;
        // A name taken here or on origin (an earlier worker's pushed branch) gets a number.
        const taken = async (name: string) => (await refExists(clone, `refs/heads/${name}`)) || (await refExists(clone, `refs/remotes/origin/${name}`));
        for (let n = 2; await taken(branch); n++) branch = `${wanted}-${n}`;
        mkdirSync(input.workerFolder, { recursive: true });
        await runtime.git(["worktree", "add", "--no-track", "-b", branch, path, base], { cwd: clone, timeoutMs: GIT_LIMITS.worktreeMs });
        return { path, branch, base, clonePath: clone };
    });
}

export interface WorktreeRef {
    path: string;
    branch: string;
    clonePath: string;
    /** The branch it came from. A repo with no remote (Devis' own source) counts unpushed work from here. */
    base?: string | null;
}

/** A node_modules that links elsewhere (a Devis worktree shares its source's): unlink it so nothing below it is deleted. */
function unlinkSharedModules(path: string): void {
    const modules = join(path, "node_modules");
    try {
        if (!lstatSync(modules).isSymbolicLink()) return;
    } catch {
        return;
    }
    try {
        unlinkSync(modules);
    } catch {
        rmdirSync(modules);
    }
}

/** Remove a worktree and its local branch. Returns what couldn't be removed, or null. */
export async function removeWorktree(w: WorktreeRef): Promise<string | null> {
    try {
        unlinkSharedModules(w.path);
    } catch (error) {
        return `Left ${w.path} alone: its node_modules link couldn't be removed (${(error as Error).message}).`;
    }
    if (isCloned(w.clonePath)) {
        await serial(w.clonePath, async () => {
            await runtime.git(["worktree", "remove", "--force", "--force", w.path], { cwd: w.clonePath, timeoutMs: GIT_LIMITS.worktreeMs }).catch(() => "");
            await runtime.git(["worktree", "prune"], { cwd: w.clonePath, timeoutMs: GIT_LIMITS.quickMs }).catch(() => "");
            await runtime.git(["branch", "-D", w.branch], { cwd: w.clonePath, timeoutMs: GIT_LIMITS.quickMs }).catch(() => "");
        });
    }
    return removeFolder(w.path);
}

/** Delete a folder the app made. Returns why it couldn't, or null. */
export function removeFolder(path: string | null | undefined): string | null {
    if (!path || !existsSync(path)) return null;
    if (!deletable(path)) return `Left ${path} alone: it's not a folder the app made.`;
    try {
        rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
        return null;
    } catch (error) {
        return `Couldn't delete ${path}: ${(error as Error).message}`;
    }
}

export interface WorktreeChanges {
    path: string;
    repo: string;
    /** Files changed and not committed. */
    uncommitted: number;
    /** Commits on its branch that no remote has. */
    unpushed: number;
}

/** What deleting the worktree would lose. Null when it's gone or git can't tell. */
export async function worktreeChanges(w: WorktreeRef & { repo: string }): Promise<WorktreeChanges | null> {
    if (!isDirectory(w.path)) return null;
    const status = await runtime.git(["status", "--porcelain"], { cwd: w.path, timeoutMs: GIT_LIMITS.quickMs }).catch(() => null);
    if (status === null) return null;
    const count = (not: string[]) =>
        runtime.git(["rev-list", "--count", "HEAD", "--not", "--remotes", ...not], { cwd: w.path, timeoutMs: GIT_LIMITS.quickMs });
    const ahead = await (w.base ? count([w.base]).catch(() => count([])) : count([])).catch(() => "0");
    return { path: w.path, repo: w.repo, uncommitted: status.split("\n").filter(Boolean).length, unpushed: Number(ahead) || 0 };
}

/** A repo from Settings by "org/project/repo", "project/repo" or its name when that's unique. */
export function findRepo(repos: CodebaseRepo[], name: string): CodebaseRepo | null {
    const want = name.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
    if (!want) return null;
    const exact = repos.find((r) => codebaseKey(r).toLowerCase() === want);
    if (exact) return exact;
    const tail = repos.filter((r) => `${r.project}/${r.repo}`.toLowerCase() === want || r.repo.toLowerCase() === want);
    return tail.length === 1 ? tail[0] : null;
}
