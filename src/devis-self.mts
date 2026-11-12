// Devis changing itself. The user asks the Lead; a Devis task's worker changes
// Devis' own source in a git worktree of it, on <you>/devis/<slug> off master.
// When the worker says it's ready, the app checks the change itself (both
// TypeScript builds, then every harness; a harness failure only counts when
// master passes it) and the user reviews a "Ready to ship" card. Ship
// fast-forwards master, tags devis/ship-N, and starts a detached updater
// (scripts/devis-updater.ps1, taken from the commit before the ship) that
// redeploys, checks the new build answers within two minutes, and puts the
// previous install back when it doesn't. Settings turns all of this on and
// names the source folder. Nothing is pushed anywhere: the source has no remote.
//
// This module holds the settings, git steps, checks, and the ships record. The
// worker tool that asks for the card lives in jarvis-workers.mts, which calls
// in here; nothing here imports the workers, so the service wires the hooks.

import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { branchOwner } from "./jarvis-codebase.mjs";
import { JarvisError, clip, getMeta, jarvisDir, recordEvent, setMeta, taskSlug } from "./jarvis-store.mjs";
import { buildCommit } from "./service-files.mjs";

/** The branch Devis ships from. */
export const MAIN = "master";

/** Files that run the update or decide what workers may do: a change to one needs an extra tick on the card. */
export const SENSITIVE_FILES: readonly string[] = [
    "scripts/deploy-desktop.ps1",
    "scripts/devis-updater.ps1",
    "scripts/package-desktop.mjs",
    "src/devis-self.mts",
    "src/service-lifecycle.mts",
    "src/service.mts",
    "src/service-files.mts",
    "src/jarvis-workers.mts",
    "src/jarvis-lead.mts",
    "package.json",
    "package-lock.json",
    "build/installer.nsh",
    "build/stop-devis.ps1",
];

const BUILD_MS = 10 * 60_000;
const HARNESS_MS = 5 * 60_000;
const OUTPUT_MAX = 2000;
/** A new build that has run this long with no word from the updater counts as live. */
const SETTLE_AFTER_MS = 5 * 60_000;
/** A ship still "deploying" this long (the idle wait is an hour) has lost its updater. */
const GIVE_UP_MS = 3 * 60 * 60_000;

// ---- what runs programs (the harness swaps it) -------------------------------------------

export interface RunResult {
    /** The exit code, or null when it didn't start or was stopped. */
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

export interface DevisRuntime {
    run(file: string, args: string[], opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<RunResult>;
    /** Start a command line outside this process, so it outlives the service. Resolves with its pid. */
    launch(commandLine: string): Promise<number>;
    /** The commit the running build came from. */
    commit(): string | null;
    alive(pid: number): boolean;
    /** Node for the builds and harnesses. */
    node(): string;
}

function runProcess(file: string, args: string[], opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<RunResult> {
    return new Promise((done) => {
        execFile(
            file,
            args,
            { cwd: opts.cwd, timeout: opts.timeoutMs, windowsHide: true, env: opts.env ?? process.env, maxBuffer: 32 * 1024 * 1024 },
            (error, stdout, stderr) => {
                const e = error as (Error & { code?: unknown; killed?: boolean }) | null;
                done({
                    code: !e ? 0 : typeof e.code === "number" ? e.code : null,
                    stdout: String(stdout ?? ""),
                    stderr: String(stderr ?? "") || (e && typeof e.code !== "number" ? e.message : ""),
                    timedOut: !!e?.killed,
                });
            },
        );
    });
}

/** Start a hidden process through WMI, so it isn't in the app's job and survives the service stopping. */
async function launchDetached(commandLine: string): Promise<number> {
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
        `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replace(/'/g, "''")}'; ProcessStartupInformation = $startup }`,
        "if ($r.ReturnValue -ne 0) { throw \"Win32_Process.Create returned $($r.ReturnValue)\" }",
        "[Console]::Out.Write($r.ProcessId)",
    ].join("\n");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const r = await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
        cwd: devisDir(),
        timeoutMs: 60_000,
    });
    const pid = Number(r.stdout.trim());
    if (r.code !== 0 || !Number.isInteger(pid) || pid <= 0) throw new Error(clip(r.stderr || r.stdout || "PowerShell didn't start the updater.", 400));
    return pid;
}

const appDir = dirname(fileURLToPath(import.meta.url));

const sdkRuntime: DevisRuntime = {
    run: runProcess,
    launch: launchDetached,
    commit: () => buildCommit(appDir),
    alive(pid) {
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            return (error as NodeJS.ErrnoException).code === "EPERM";
        }
    },
    node: () => "node",
};

let runtime: DevisRuntime = sdkRuntime;

export function setDevisRuntime(next: Partial<DevisRuntime> | null): void {
    runtime = next ? { ...sdkRuntime, ...next } : sdkRuntime;
    builtBaseline = null;
    baselineResults.clear();
}

export function devisDir(): string {
    const dir = join(jarvisDir(), "devis");
    mkdirSync(dir, { recursive: true });
    return dir;
}

// ---- settings --------------------------------------------------------------------------

const SETTING_ON = "devisSelfChange";
const SETTING_SOURCE = "devisSource";

/** The folder this build was packaged from (scripts/package-desktop.mjs records it). */
function builtFrom(): string | null {
    try {
        const info = JSON.parse(readFileSync(join(appDir, "build-info.json"), "utf8").replace(/^\uFEFF/, "")) as { source?: unknown };
        return typeof info.source === "string" && info.source ? info.source : null;
    } catch {
        return null;
    }
}

export interface DevisSettings {
    enabled: boolean;
    source: string;
    /** Why the source folder can't be used, or null. */
    sourceProblem: string | null;
}

/** Why `path` isn't Devis' source folder, or null when it is. */
export function validateSource(path: string): string | null {
    if (!path) return "Choose Devis' source folder.";
    if (!isAbsolute(path)) return "Use the source folder's full path.";
    if (!existsSync(join(path, ".git"))) return "That folder isn't a git repository.";
    let name: unknown;
    try {
        name = (JSON.parse(readFileSync(join(path, "package.json"), "utf8").replace(/^\uFEFF/, "")) as { name?: unknown }).name;
    } catch {
        return "That folder has no package.json.";
    }
    if (name !== "devis") return "That folder isn't Devis' source: its package.json isn't named devis.";
    if (!existsSync(join(path, "scripts", "deploy-desktop.ps1"))) return "That folder has no scripts\\deploy-desktop.ps1.";
    if (!existsSync(join(path, "node_modules"))) return "Run npm install in that folder first.";
    return null;
}

export async function devisSettings(): Promise<DevisSettings> {
    const enabled = (await getMeta(SETTING_ON)) === "on";
    const source = (await getMeta(SETTING_SOURCE)) || builtFrom() || "";
    return { enabled, source, sourceProblem: validateSource(source) };
}

export async function saveDevisSettings(input: { enabled?: unknown; source?: unknown }): Promise<DevisSettings> {
    if (typeof input.source === "string") {
        const source = input.source.trim().replace(/^"|"$/g, "").replace(/[\\/]+$/, "");
        if (source) {
            const problem = validateSource(source);
            if (problem) throw new JarvisError(problem);
        }
        await setMeta(SETTING_SOURCE, source ? resolve(source) : null);
    }
    if (typeof input.enabled === "boolean") {
        if (input.enabled) {
            const { sourceProblem } = await devisSettings();
            if (sourceProblem) throw new JarvisError(sourceProblem);
        }
        await setMeta(SETTING_ON, input.enabled ? "on" : null);
    }
    return devisSettings();
}

/** Devis' source folder, or a JarvisError saying why changing Devis is off. */
export async function requireDevis(): Promise<string> {
    const s = await devisSettings();
    if (!s.enabled) throw new JarvisError("Changing Devis itself is off. Turn it on in Settings › Change Devis itself.", 409);
    if (s.sourceProblem) throw new JarvisError(`Devis' source folder: ${s.sourceProblem}`, 409);
    return s.source;
}

// ---- git -------------------------------------------------------------------------------

const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_EDITOR: "true" });

function gitRun(cwd: string, args: string[], timeoutMs = 60_000): Promise<RunResult> {
    return runtime.run("git", ["-c", "core.longpaths=true", ...args], { cwd, timeoutMs, env: gitEnv() });
}

function gitProblem(r: RunResult): string {
    if (r.timedOut) return "git took too long and was stopped.";
    const lines = r.stderr
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !/^(hint|warning):/i.test(l));
    const fatal = lines.find((l) => /^(fatal|error):/i.test(l));
    return (fatal || lines[lines.length - 1] || r.stdout.trim() || `git exited with ${r.code}`).replace(/^(fatal|error):\s*/i, "").slice(0, 400);
}

async function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<string> {
    const r = await gitRun(cwd, args, timeoutMs);
    if (r.code !== 0) throw new Error(gitProblem(r));
    return r.stdout.replace(/\s+$/, "");
}

/** One step at a time on the source: worktrees, the baseline, merges, tags and resets share its refs. */
let sourceQueue: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
    const run = sourceQueue.catch(() => undefined).then(job);
    sourceQueue = run.catch(() => undefined);
    return run;
}

const isLink = (path: string): boolean => {
    try {
        return lstatSync(path).isSymbolicLink();
    } catch {
        return false;
    }
};

/** Share the source's node_modules: a junction needs no admin rights, and dependencies don't change in a ship. */
function linkModules(worktree: string, source: string): void {
    const link = join(worktree, "node_modules");
    if (existsSync(link) || isLink(link)) return;
    symlinkSync(resolve(source, "node_modules"), link, "junction");
}

function unlinkModules(worktree: string): void {
    const link = join(worktree, "node_modules");
    if (!isLink(link)) return;
    try {
        unlinkSync(link);
    } catch {
        rmdirSync(link);
    }
}

// ---- a worker's worktree ---------------------------------------------------------------

export interface DevisWorktree {
    path: string;
    branch: string;
    base: string;
    clonePath: string;
}

/** A worktree of Devis' source in the worker's folder, on a new branch <you>/devis/<task> off master. */
export async function addDevisWorktree(input: { source: string; workerFolder: string; title: string }): Promise<DevisWorktree> {
    const wanted = `${await branchOwner(null)}/devis/${taskSlug(input.title)}`;
    const path = join(input.workerFolder, "devis");
    return serial(async () => {
        let branch = wanted;
        for (let n = 2; (await gitRun(input.source, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0; n++) {
            branch = `${wanted}-${n}`;
        }
        mkdirSync(input.workerFolder, { recursive: true });
        await git(input.source, ["worktree", "add", "--no-track", "-b", branch, path, MAIN], BUILD_MS);
        try {
            linkModules(path, input.source);
        } catch (error) {
            await removeDevisTree(input.source, path, branch);
            throw new JarvisError(`Couldn't share node_modules with the worktree: ${(error as Error).message}`);
        }
        return { path, branch, base: MAIN, clonePath: input.source };
    });
}

async function removeDevisTree(source: string, path: string, branch: string | null): Promise<void> {
    unlinkModules(path);
    await gitRun(source, ["worktree", "remove", "--force", "--force", path]);
    await gitRun(source, ["worktree", "prune"]);
    if (branch) await gitRun(source, ["branch", "-D", branch]);
    if (existsSync(path)) rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
}

// ---- what a branch changes -------------------------------------------------------------

export interface DevisFile {
    path: string;
    /** Lines added and removed; null for a binary file. */
    added: number | null;
    removed: number | null;
    sensitive: boolean;
}

export interface DevisChanges {
    /** Files changed on the branch since it left master. */
    files: DevisFile[];
    sensitive: string[];
    /** Commits on the branch that master doesn't have. */
    ahead: number;
    /** Files changed or added and not committed. */
    uncommitted: string[];
    /** True when master has commits the branch doesn't. */
    behind: boolean;
}

export const isSensitive = (path: string): boolean => SENSITIVE_FILES.includes(path.replace(/\\/g, "/"));

export async function devisChanges(worktree: string): Promise<DevisChanges> {
    const status = await git(worktree, ["status", "--porcelain", "--untracked-files=all"]);
    const uncommitted = status
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => l.slice(3).trim());
    const ahead = Number(await git(worktree, ["rev-list", "--count", `${MAIN}..HEAD`])) || 0;
    const behind = (await gitRun(worktree, ["merge-base", "--is-ancestor", MAIN, "HEAD"])).code !== 0;
    const files = ahead ? await changedFiles(worktree, `${MAIN}...HEAD`) : [];
    return { files, sensitive: files.filter((f) => f.sensitive).map((f) => f.path), ahead, uncommitted, behind };
}

async function changedFiles(dir: string, range: string): Promise<DevisFile[]> {
    const numstat = await git(dir, ["diff", "--numstat", "--no-renames", range]);
    return numstat
        .split("\n")
        .filter(Boolean)
        .map((line): DevisFile => {
            const [a, r, ...rest] = line.split("\t");
            const path = rest.join("\t");
            return { path, added: a === "-" ? null : Number(a), removed: r === "-" ? null : Number(r), sensitive: isSensitive(path) };
        });
}

// ---- checks ----------------------------------------------------------------------------

export interface DevisChecks {
    ok: boolean;
    /** The two TypeScript builds. */
    build: { ok: boolean; output: string };
    harnesses: {
        total: number;
        passed: number;
        /** Failing here and passing on master: these block. */
        failed: string[];
        /** Failing on master too: these don't block. */
        preexisting: string[];
    };
    /** The end of each blocking harness's output. */
    failures: Array<{ name: string; output: string }>;
    ms: number;
    at: string;
}

export interface ChecksProgress {
    label: string;
    step: string;
    startedAt: string;
}

let checksQueue: Promise<unknown> = Promise.resolve();
let progressNow: ChecksProgress | null = null;
let builtBaseline: string | null = null;
const baselineResults = new Map<string, boolean>();

/** What the checks are doing, while they run. */
export const checksProgress = (): ChecksProgress | null => progressNow;

/** Builds and harnesses must not see the running app's data or Electron mode. */
function childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (!/^(ADO_PR_OPS_|DEVIS_|ELECTRON_)/i.test(key)) env[key] = value;
    }
    return env;
}

function tail(text: string, max = OUTPUT_MAX): string {
    const t = text.replace(/\r\n/g, "\n").trim();
    return t.length > max ? "…" + t.slice(t.length - max + 1) : t;
}

function harnessNames(worktree: string): string[] {
    try {
        return readdirSync(join(worktree, "scripts"))
            .filter((n) => /-harness\.mjs$/.test(n))
            .sort();
    } catch {
        return [];
    }
}

function noNode(r: RunResult): string | null {
    return r.code === null && !r.timedOut && /ENOENT/.test(r.stderr) ? "Node.js isn't on PATH, so the checks can't run." : null;
}

async function build(worktree: string, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string }> {
    for (const config of ["tsconfig.backend.json", "tsconfig.web.json"]) {
        const r = await runtime.run(runtime.node(), [join("node_modules", "typescript", "bin", "tsc"), "-p", config], { cwd: worktree, timeoutMs: BUILD_MS, env });
        if (r.code !== 0) {
            const why = noNode(r) || (r.timedOut ? `tsc -p ${config} took too long.` : tail(`${r.stdout}\n${r.stderr}`));
            return { ok: false, output: `tsc -p ${config}:\n${why}` };
        }
    }
    return { ok: true, output: "" };
}

async function runHarness(worktree: string, name: string, env: NodeJS.ProcessEnv): Promise<RunResult> {
    return runtime.run(runtime.node(), [join("scripts", name)], { cwd: worktree, timeoutMs: HARNESS_MS, env });
}

/** A detached worktree of master, built, for telling a harness the branch broke from one already failing. */
async function baselineAt(source: string, sha: string, env: NodeJS.ProcessEnv): Promise<string | null> {
    const path = join(devisDir(), "baseline");
    const ready = await serial(async () => {
        const moved =
            existsSync(join(path, ".git")) && (await gitRun(path, ["checkout", "-q", "--force", "--detach", sha], BUILD_MS)).code === 0;
        if (!moved) {
            await removeDevisTree(source, path, null);
            if ((await gitRun(source, ["worktree", "add", "--detach", path, sha], BUILD_MS)).code !== 0) return false;
            builtBaseline = null;
        }
        linkModules(path, source);
        return true;
    }).catch(() => false);
    if (!ready) return null;
    if (builtBaseline !== sha) {
        if (!(await build(path, env)).ok) return null;
        builtBaseline = sha;
    }
    return path;
}

/** Run the checks in a worker's worktree. One run at a time, app-wide: they share the baseline and the machine. */
export function runDevisChecks(input: { worktree: string; source: string; label: string }): Promise<DevisChecks> {
    const run = checksQueue.catch(() => undefined).then(() => checksNow(input));
    checksQueue = run.catch(() => undefined);
    return run;
}

async function checksNow(input: { worktree: string; source: string; label: string }): Promise<DevisChecks> {
    const started = Date.now();
    const env = childEnv();
    const step = (s: string) => (progressNow = { label: input.label, step: s, startedAt: new Date(started).toISOString() });
    const finish = (c: Omit<DevisChecks, "ms" | "at">): DevisChecks => ({ ...c, ms: Date.now() - started, at: new Date().toISOString() });
    try {
        step("Building");
        const built = await build(input.worktree, env);
        if (!built.ok) {
            return finish({ ok: false, build: built, harnesses: { total: 0, passed: 0, failed: [], preexisting: [] }, failures: [] });
        }
        const names = harnessNames(input.worktree);
        const failing: Array<{ name: string; output: string }> = [];
        for (const [i, name] of names.entries()) {
            step(`Harness ${i + 1} of ${names.length}: ${name.replace(/-harness\.mjs$/, "")}`);
            const r = await runHarness(input.worktree, name, env);
            if (r.code !== 0) failing.push({ name, output: noNode(r) || (r.timedOut ? "Took longer than 5 minutes." : tail(`${r.stdout}\n${r.stderr}`)) });
        }
        const preexisting: string[] = [];
        if (failing.length) {
            step("Checking the failures on master");
            const sha = await git(input.source, ["rev-parse", MAIN]);
            const baseline = await baselineAt(input.source, sha, env);
            for (const f of failing) {
                if (!baseline || !existsSync(join(baseline, "scripts", f.name))) continue;
                const key = `${sha}:${f.name}`;
                if (!baselineResults.has(key)) baselineResults.set(key, (await runHarness(baseline, f.name, env)).code === 0);
                if (baselineResults.get(key) === false) preexisting.push(f.name);
            }
        }
        const failures = failing.filter((f) => !preexisting.includes(f.name));
        return finish({
            ok: failures.length === 0,
            build: built,
            harnesses: { total: names.length, passed: names.length - failing.length, failed: failures.map((f) => f.name), preexisting },
            failures,
        });
    } finally {
        progressNow = null;
    }
}

/** The checks' result, for the worker when they fail. */
export function checksReport(c: DevisChecks): string {
    if (!c.build.ok) return `The build failed, so nothing ships yet. Fix it, commit, and call devis_ready_to_ship again.\n\n${c.build.output}`;
    const lines = [`${c.harnesses.failed.length} harness${c.harnesses.failed.length === 1 ? "" : "es"} failed that pass on master. Fix them, commit, and call devis_ready_to_ship again.`];
    for (const f of c.failures) lines.push("", `${f.name}:`, f.output);
    if (c.harnesses.preexisting.length) lines.push("", `These fail on master too, so they don't block: ${c.harnesses.preexisting.join(", ")}.`);
    return lines.join("\n");
}

// ---- ships -----------------------------------------------------------------------------

export type ShipState = "deploying" | "live" | "rolled-back" | "failed";
export type ShipMode = "idle" | "now";

export interface DevisShip {
    n: number;
    taskId: string;
    sessionId: string;
    worker: string;
    title: string;
    summary: string;
    branch: string;
    /** Master before and after the ship. */
    before: string;
    commit: string;
    state: ShipState;
    mode: ShipMode;
    files: DevisFile[];
    sensitive: string[];
    checks: { passed: number; total: number; preexisting: string[]; ms: number };
    /** Why it didn't go live, in a sentence. */
    note: string | null;
    /** The end of the updater's log, when it didn't go live. */
    log: string | null;
    updaterPid: number | null;
    shippedAt: string;
    settledAt: string | null;
    /** The ship that undid this one. */
    revertedBy: number | null;
    /** The task undoing it, while it's open. */
    undoTaskId: string | null;
    dismissed: boolean;
}

const shipsFile = (): string => join(devisDir(), "ships.json");

export function listShips(): DevisShip[] {
    try {
        const data = JSON.parse(readFileSync(shipsFile(), "utf8")) as { ships?: unknown };
        return Array.isArray(data.ships) ? (data.ships as DevisShip[]) : [];
    } catch {
        return [];
    }
}

/** Read, change and write the ships in one go: it's all synchronous, so nothing interleaves. */
function editShips(change: (ships: DevisShip[]) => void): DevisShip[] {
    const ships = listShips();
    change(ships);
    const file = shipsFile();
    writeFileSync(`${file}.tmp`, JSON.stringify({ ships }, null, 1));
    renameSync(`${file}.tmp`, file);
    return ships;
}

function editShip(n: number, change: (ship: DevisShip) => void): DevisShip | null {
    let found: DevisShip | null = null;
    editShips((ships) => {
        found = ships.find((s) => s.n === n) || null;
        if (found) change(found);
    });
    return found;
}

export const getShip = (n: number): DevisShip | null => listShips().find((s) => s.n === n) || null;

/** The ship whose deploy is still running, if any. */
export const deployingShip = (): DevisShip | null => listShips().find((s) => s.state === "deploying") || null;

let shipping = false;

/** True while a ship is merging or deploying: another one waits. */
export const shipBusy = (): boolean => shipping || !!deployingShip();

/**
 * Whether a ship can go now. Throws a JarvisError the card shows when it can't:
 * the feature is off, another ship is under way, the source folder isn't clean
 * on master, or a sensitive file changed and the user didn't tick the box.
 */
export async function shipGate(input: { sensitive: string[]; ack: boolean }): Promise<string> {
    const source = await requireDevis();
    const busy = deployingShip();
    if (shipping || busy) throw new JarvisError(busy ? `Ship ${busy.n} is still deploying. Ship this once it's done.` : "Another ship is under way. Try again in a minute.", 409);
    const branch = await git(source, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "");
    if (branch !== MAIN) throw new JarvisError(`Devis' source folder is on ${branch || "a detached HEAD"}, not ${MAIN}. Switch it back to ship.`, 409);
    const dirty = await git(source, ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty.trim()) throw new JarvisError(`Devis' source folder has uncommitted changes. Commit or stash them, then ship.`, 409);
    if (input.sensitive.length && !input.ack) {
        throw new JarvisError("This change touches files that run the update itself. Tick the box once you've checked them.");
    }
    return source;
}

/**
 * Bring the branch up to date with master before it ships. Returns whether it
 * rebased (so the checks run again), or the problem when it can't.
 */
export async function catchUpWithMaster(worktree: string): Promise<{ rebased: boolean; problem: string | null }> {
    if ((await gitRun(worktree, ["merge-base", "--is-ancestor", MAIN, "HEAD"])).code === 0) return { rebased: false, problem: null };
    const r = await gitRun(worktree, ["rebase", MAIN], BUILD_MS);
    if (r.code === 0) return { rebased: true, problem: null };
    await gitRun(worktree, ["rebase", "--abort"]);
    return {
        rebased: false,
        problem: `Master moved and your branch doesn't rebase onto it cleanly (${gitProblem(r)}). Run \`git rebase ${MAIN}\` in your worktree, resolve the conflicts, and call devis_ready_to_ship again.`,
    };
}

export interface ShipInput {
    source: string;
    worktree: string;
    branch: string;
    taskId: string;
    sessionId: string;
    worker: string;
    title: string;
    summary: string;
    mode: ShipMode;
    checks: DevisChecks;
}

/** Hold the ship lock while `job` merges and starts the updater. */
export async function withShipLock<T>(job: () => Promise<T>): Promise<T> {
    if (shipping) throw new JarvisError("Another ship is under way. Try again in a minute.", 409);
    shipping = true;
    try {
        return await job();
    } finally {
        shipping = false;
    }
}

/** The updater to run: the one from the commit before the ship, which is known to work, else the ship's own. */
async function updaterScript(source: string, before: string, commit: string, n: number): Promise<string> {
    let text = await git(source, ["show", `${before}:scripts/devis-updater.ps1`]).catch(() => "");
    if (!text) text = await git(source, ["show", `${commit}:scripts/devis-updater.ps1`]).catch(() => "");
    if (!text) throw new Error("There's no scripts/devis-updater.ps1 to run.");
    const file = join(devisDir(), `updater-${n}.ps1`);
    // Windows PowerShell reads a file without a BOM as ANSI.
    writeFileSync(file, "\uFEFF" + text.replace(/\r?\n/g, "\r\n") + "\r\n");
    return file;
}

/** Put master back where it was, when it's still on the ship and nothing else is in the way. */
async function resetMaster(source: string, ship: { commit: string; before: string }): Promise<boolean> {
    return serial(async () => {
        const head = await git(source, ["rev-parse", "HEAD"]).catch(() => "");
        const branch = await git(source, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "");
        if (head !== ship.commit || branch !== MAIN) return false;
        return (await gitRun(source, ["reset", "-q", "--keep", ship.before])).code === 0;
    });
}

/**
 * Fast-forward master to the branch, tag it devis/ship-N, record the ship, and
 * start the updater. Run it inside withShipLock, after shipGate and
 * catchUpWithMaster. Throws when master can't fast-forward.
 */
export async function completeShip(input: ShipInput): Promise<DevisShip> {
    const merged = await serial(async () => {
        // The gate ran before the lock: check again that the merge lands on a clean master.
        const on = await git(input.source, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "");
        if (on !== MAIN) throw new JarvisError(`Devis' source folder is on ${on || "a detached HEAD"}, not ${MAIN}. Switch it back to ship.`, 409);
        if ((await git(input.source, ["status", "--porcelain", "--untracked-files=no"])).trim()) {
            throw new JarvisError("Devis' source folder has uncommitted changes. Commit or stash them, then ship.", 409);
        }
        const before = await git(input.source, ["rev-parse", MAIN]);
        await git(input.source, ["merge", "--ff-only", "--quiet", input.branch], BUILD_MS);
        const commit = await git(input.source, ["rev-parse", "HEAD"]);
        const n = Math.max(0, ...listShips().map((s) => s.n)) + 1;
        await git(input.source, ["tag", "-f", `devis/ship-${n}`, commit]);
        const npm = await git(input.source, ["diff", "--name-only", before, commit, "--", "package.json", "package-lock.json"]).catch(() => "");
        const files = await changedFiles(input.source, `${before}..${commit}`).catch(() => []);
        return { before, commit, n, npm: !!npm.trim(), files };
    });
    const at = new Date().toISOString();
    const ship: DevisShip = {
        n: merged.n,
        taskId: input.taskId,
        sessionId: input.sessionId,
        worker: input.worker,
        title: clip(input.title, 200),
        summary: clip(input.summary, 2000),
        branch: input.branch,
        before: merged.before,
        commit: merged.commit,
        state: "deploying",
        mode: input.mode,
        files: merged.files,
        sensitive: merged.files.filter((f) => f.sensitive).map((f) => f.path),
        checks: {
            passed: input.checks.harnesses.passed,
            total: input.checks.harnesses.total,
            preexisting: input.checks.harnesses.preexisting,
            ms: input.checks.ms,
        },
        note: null,
        log: null,
        updaterPid: null,
        shippedAt: at,
        settledAt: null,
        revertedBy: null,
        undoTaskId: null,
        dismissed: false,
    };
    editShips((ships) => {
        ships.push(ship);
        const undone = ships.find((s) => s.undoTaskId === input.taskId && s.revertedBy === null);
        if (undone) undone.revertedBy = ship.n;
    });
    try {
        const script = await updaterScript(input.source, merged.before, merged.commit, ship.n);
        const args = [
            "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden",
            `-File "${script}"`,
            `-Source "${input.source}"`,
            `-Ship ${ship.n}`,
            `-Commit ${merged.commit}`,
            `-Before ${merged.before}`,
            `-Mode ${input.mode}`,
            `-StateDir "${devisDir()}"`,
            merged.npm ? "-NpmInstall" : "",
        ];
        const pid = await runtime.launch(args.filter(Boolean).join(" "));
        editShip(ship.n, (s) => (s.updaterPid = pid));
        ship.updaterPid = pid;
    } catch (error) {
        const reset = await resetMaster(input.source, ship);
        const note = `The updater didn't start: ${(error as Error).message}${reset ? ` Master is back at ${merged.before.slice(0, 8)}.` : ""}`;
        editShip(ship.n, (s) => {
            s.state = "failed";
            s.note = note;
            s.settledAt = new Date().toISOString();
        });
        await recordEvent("devisShip", `Ship ${ship.n} (${ship.title}) failed: ${note}`, { taskId: ship.taskId, sessionId: ship.sessionId, ref: { ship: ship.n } });
        return { ...ship, state: "failed", note };
    }
    await recordEvent(
        "devisShip",
        `Ship ${ship.n} (${ship.title}) is deploying${input.mode === "idle" ? " once the workers are done" : ""}.`,
        { taskId: ship.taskId, sessionId: ship.sessionId, ref: { ship: ship.n } },
    );
    return ship;
}

// ---- after the deploy ------------------------------------------------------------------

interface UpdaterResult {
    state: ShipState;
    logTail: string;
    note: string;
}

function readResult(n: number): UpdaterResult | null {
    try {
        const data = JSON.parse(readFileSync(join(devisDir(), `ship-${n}.result.json`), "utf8").replace(/^\uFEFF/, "")) as {
            state?: unknown;
            logTail?: unknown;
            note?: unknown;
        };
        const state = data.state === "live" || data.state === "rolled-back" || data.state === "failed" ? data.state : null;
        if (!state) return null;
        return {
            state,
            logTail: typeof data.logTail === "string" ? data.logTail : "",
            note: typeof data.note === "string" ? data.note.trim() : "",
        };
    } catch {
        return null;
    }
}

export interface ShipHooks {
    /** A ship that didn't go live: tell its worker. */
    notGoneLive?(ship: DevisShip, message: string): Promise<void> | void;
}

/** Settle ships whose deploy finished. `since` is when this service started. */
export async function settleShips(hooks: ShipHooks = {}, since = Date.now()): Promise<DevisShip[]> {
    const settled: DevisShip[] = [];
    for (const ship of listShips().filter((s) => s.state === "deploying")) {
        const result = readResult(ship.n);
        const mine = runtime.commit() === ship.commit;
        let outcome: { state: ShipState; log: string | null; note: string | null } | null = null;
        if (result) {
            outcome = {
                state: result.state,
                log: result.state === "live" ? null : tail(result.logTail, 4000) || null,
                note:
                    result.state === "live"
                        ? null
                        : result.note ||
                          (result.state === "rolled-back"
                              ? "The new build didn't come up, so the previous one is back."
                              : "The deploy didn't finish, so the running build stayed."),
            };
        } else if (mine && Date.now() - since > SETTLE_AFTER_MS) {
            outcome = { state: "live", log: null, note: null };
        } else if ((ship.updaterPid && !runtime.alive(ship.updaterPid)) || Date.now() - Date.parse(ship.shippedAt) > GIVE_UP_MS) {
            outcome = mine
                ? { state: "live", log: null, note: null }
                : { state: "failed", log: null, note: `The updater stopped without saying how it went. See ship-${ship.n}.log in ${devisDir()}.` };
        }
        if (!outcome) continue;
        const o = outcome;
        const done = editShip(ship.n, (s) => {
            s.state = o.state;
            s.log = o.log;
            s.note = o.note;
            s.settledAt = new Date().toISOString();
        });
        if (!done) continue;
        settled.push(done);
        const text =
            done.state === "live"
                ? `Ship ${done.n} (${done.title}) is live.`
                : `Ship ${done.n} (${done.title}) ${done.state === "rolled-back" ? "was rolled back" : "failed"}: ${done.note}`;
        await recordEvent("devisShip", text, { taskId: done.taskId, sessionId: done.sessionId, ref: { ship: done.n } }).catch(() => undefined);
        if (done.state !== "live" && hooks.notGoneLive) {
            await Promise.resolve(hooks.notGoneLive(done, await notLiveMessage(done))).catch(() => undefined);
        }
    }
    return settled;
}

/** What the ship's worker hears when it didn't go live. */
async function notLiveMessage(ship: DevisShip): Promise<string> {
    const source = (await devisSettings()).source;
    const master = source ? await git(source, ["rev-parse", MAIN]).catch(() => "") : "";
    const where =
        master === ship.before
            ? `Master is back at ${ship.before.slice(0, 8)}, so your branch is ahead of it again.`
            : master === ship.commit
              ? "Master still has the ship (something kept it from being reset): leave it, and say so in your reply."
              : `Master moved on to ${master.slice(0, 8) || "something else"} since.`;
    return [
        `Ship ${ship.n} didn't go live. ${ship.note || ""}`.trim(),
        where,
        ship.log ? `The updater's log ends with:\n\`\`\`\n${ship.log}\n\`\`\`` : "",
        "Find the cause, fix it on your branch, commit, and call devis_ready_to_ship again. Don't deploy it yourself.",
    ]
        .filter(Boolean)
        .join("\n\n");
}

/** Check deploying ships now and every `everyMs`. Returns a stop function. */
export function watchShips(hooks: ShipHooks, everyMs = 10_000): () => void {
    const since = Date.now();
    let busy = false;
    const tick = async () => {
        if (busy) return;
        busy = true;
        try {
            await settleShips(hooks, since);
        } catch {
            // A bad ships file or git hiccup: try again next tick.
        } finally {
            busy = false;
        }
    };
    void tick();
    const timer = setInterval(() => void tick(), everyMs);
    timer.unref?.();
    return () => clearInterval(timer);
}

export function dismissShip(n: number): DevisShip {
    const ship = editShip(n, (s) => (s.dismissed = true));
    if (!ship) throw new JarvisError(`There's no ship ${n}.`, 404);
    return ship;
}

/** The task that undoes a ship: a new worker reverts it on a branch, and it ships like any other change. */
export function undoTask(n: number): { title: string; description: string } {
    const ship = getShip(n);
    if (!ship) throw new JarvisError(`There's no ship ${n}.`, 404);
    if (ship.state !== "live") throw new JarvisError(`Ship ${n} isn't live, so there's nothing to undo.`, 409);
    if (ship.revertedBy) throw new JarvisError(`Ship ${n} was already undone by ship ${ship.revertedBy}.`, 409);
    return {
        title: clip(`Undo ship ${n}: ${ship.title}`, 200),
        description: [
            `Undo ship ${n} (${ship.title}). Its commits are ${ship.before.slice(0, 8)}..${ship.commit.slice(0, 8)} on ${MAIN}.`,
            `In your worktree, run \`git revert --no-edit ${ship.before}..${ship.commit}\`. If it conflicts with later changes, keep the later changes and take out only what ship ${n} added; ask me when that's unclear.`,
            `Then call devis_ready_to_ship with the title "Undo ship ${n}".`,
        ].join("\n\n"),
    };
}

export function markUndo(n: number, taskId: string): void {
    editShip(n, (s) => (s.undoTaskId = taskId));
}

// ---- for the UI ------------------------------------------------------------------------

export interface DevisOverview extends DevisSettings {
    /** The commit the running build came from. */
    commit: string | null;
    ships: DevisShip[];
    checking: ChecksProgress | null;
    busy: boolean;
}

export async function devisOverview(): Promise<DevisOverview> {
    const ships = listShips()
        .sort((a, b) => b.n - a.n)
        .slice(0, 30);
    return { ...(await devisSettings()), commit: runtime.commit(), ships, checking: progressNow, busy: shipBusy() };
}

export interface DevisBanner {
    n: number;
    state: ShipState;
    mode: ShipMode;
    title: string;
    note: string | null;
    at: string;
}

/** The ship worth a banner on Today: one deploying, one that just went live, or one that didn't go live. */
export function devisBanner(nowMs = Date.now()): DevisBanner | null {
    const ships = listShips().sort((a, b) => b.n - a.n);
    const pick =
        ships.find((s) => s.state === "deploying") ||
        ships.find(
            (s) =>
                !s.dismissed &&
                s.settledAt &&
                (s.state === "live" ? nowMs - Date.parse(s.settledAt) < 30 * 60_000 : nowMs - Date.parse(s.settledAt) < 7 * 86_400_000),
        );
    if (!pick) return null;
    return { n: pick.n, state: pick.state, mode: pick.mode, title: pick.title, note: pick.note, at: pick.settledAt || pick.shippedAt };
}
