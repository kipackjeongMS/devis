// What a worker changed in its worktrees, for the code window: the changed files
// per repo and one file's diff, for three comparisons. Reads only. Every git call
// runs with --no-optional-locks, so a refresh never takes index.lock from under the
// worker's own git. The window sends a repo key and a repo-relative path; the
// server resolves and checks every path itself.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { diffLines, type Hunk } from "./ado.mjs";
import { GIT_LIMITS } from "./jarvis-codebase.mjs";
import { JarvisError, asJarvisId, getTask, getWorker, listWorktrees, type JarvisWorker, type Worktree } from "./jarvis-store.mjs";
import { isWorkerBusy } from "./jarvis-workers.mjs";

export type ChangesMode = "branch" | "uncommitted" | "last";
export type ChangeStatus = "A" | "M" | "D" | "R" | "U" | "T";

export interface ChangedFile {
    path: string;
    oldPath?: string;
    status: ChangeStatus;
    added: number | null;
    removed: number | null;
    binary?: boolean;
    size?: number;
    mtimeMs?: number;
}

export interface RepoChanges {
    key: string;
    name: string;
    branch: string;
    base: string;
    /** Short sha of the left side, or null when it's the empty tree. */
    fromRef: string | null;
    /** The worktree's HEAD, so the window can tell a new commit. */
    head: string | null;
    note?: string;
    error?: string;
    truncated?: number;
    files: ChangedFile[];
}

export interface WorkerChanges {
    mode: ChangesMode;
    at: string;
    worker: { name: string; task: string; busy: boolean; state: string; taskId: string };
    repos: RepoChanges[];
}

export interface WorkerFileDiff {
    hunks?: Hunk[];
    tooLarge?: boolean;
    binary?: boolean;
    oldCount?: number;
    newCount?: number;
    oldSize?: number;
    newSize?: number;
    editable: boolean;
    hash?: string;
}

export const CHANGE_LIMITS = {
    filesPerRepo: 2000,
    linesPerSide: 6000,
    readBytes: 2 * 1024 * 1024,
    editBytes: 1024 * 1024,
    binarySniff: 8000,
    /** Bytes read in one list to count the lines of untracked files. */
    untrackedBudget: 32 * 1024 * 1024,
};

const MODES: readonly ChangesMode[] = ["branch", "uncommitted", "last"];
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// ---- git ------------------------------------------------------------------------------

class GitFailed extends Error {}

function git(cwd: string, args: string[]): Promise<Buffer> {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_OPTIONAL_LOCKS: "0" };
    return new Promise((resolvePromise, reject) => {
        execFile(
            "git",
            ["--no-optional-locks", "-c", "core.quotepath=off", "-c", "core.longpaths=true", ...args],
            { cwd, encoding: "buffer", timeout: GIT_LIMITS.quickMs, windowsHide: true, env, maxBuffer: 64 * 1024 * 1024 },
            (error, stdout, stderr) => {
                if (error) reject(new GitFailed(gitMessage(String(stderr || ""), error)));
                else resolvePromise(stdout);
            },
        );
    });
}

function gitMessage(stderr: string, error: Error & { killed?: boolean }): string {
    if (error.killed) return "git took too long and was stopped.";
    const lines = stderr
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !/^(hint|warning):/i.test(l));
    const fatal = lines.find((l) => /^(fatal|error):/i.test(l));
    return (fatal || lines[lines.length - 1] || error.message).replace(/^(fatal|error):\s*/i, "").slice(0, 400);
}

async function gitText(cwd: string, args: string[]): Promise<string> {
    return (await git(cwd, args)).toString("utf8").trim();
}

/** NUL-separated git output, without the trailing empty field. */
function fields(buf: Buffer): string[] {
    const parts = buf.toString("utf8").split("\0");
    if (parts[parts.length - 1] === "") parts.pop();
    return parts;
}

interface RawEntry {
    status: ChangeStatus;
    path: string;
    oldPath?: string;
    srcMode: string;
    dstMode: string;
    srcOid: string;
    dstOid: string;
}

/** --raw -z: ":srcMode dstMode srcOid dstOid STATUS" then the path, or old and new paths for R and C. */
function parseRaw(parts: string[]): RawEntry[] {
    const out: RawEntry[] = [];
    for (let i = 0; i < parts.length; ) {
        const [srcMode = "", dstMode = "", srcOid = "", dstOid = "", score = ""] = parts[i++].replace(/^:/, "").split(" ");
        const letter = score.charAt(0);
        const facts = { srcMode, dstMode, srcOid, dstOid };
        if (letter === "R" || letter === "C") {
            const oldPath = parts[i++];
            const path = parts[i++];
            out.push(letter === "R" ? { status: "R", path, oldPath, ...facts } : { status: "A", path, ...facts });
            continue;
        }
        const path = parts[i++];
        const status: ChangeStatus = letter === "A" || letter === "D" || letter === "T" ? letter : "M";
        out.push({ status, path, ...facts });
    }
    return out;
}

/** numstat -z: "a\tr\tpath" or, for a rename, "a\tr\t" then old and new paths. Keyed by the new path. */
function parseNumstat(parts: string[]): Map<string, { added: number | null; removed: number | null }> {
    const out = new Map<string, { added: number | null; removed: number | null }>();
    for (let i = 0; i < parts.length; ) {
        const rec = parts[i++];
        const t1 = rec.indexOf("\t");
        const t2 = rec.indexOf("\t", t1 + 1);
        if (t1 < 0 || t2 < 0) continue;
        const a = rec.slice(0, t1);
        const r = rec.slice(t1 + 1, t2);
        let path = rec.slice(t2 + 1);
        if (!path) {
            i++;
            path = parts[i++];
        }
        out.set(path, { added: a === "-" ? null : Number(a), removed: r === "-" ? null : Number(r) });
    }
    return out;
}

// ---- the worker and its worktrees -------------------------------------------------------

function asMode(value: unknown): ChangesMode {
    if (value == null || value === "") return "branch";
    if (typeof value === "string" && (MODES as readonly string[]).includes(value)) return value as ChangesMode;
    throw new JarvisError("Unknown comparison.", 400);
}

async function requireWorker(sessionId: unknown): Promise<JarvisWorker> {
    const id = asJarvisId(sessionId);
    const worker = id ? await getWorker(id) : null;
    if (!worker) throw new JarvisError("Worker not found.", 404);
    return worker;
}

export function worktreeKey(w: Pick<Worktree, "org" | "project" | "repo">): string {
    return `${w.org}/${w.project}/${w.repo}`;
}

async function requireWorktree(worker: JarvisWorker, repoKey: unknown): Promise<Worktree> {
    const key = typeof repoKey === "string" ? repoKey : "";
    const tree = key ? (await listWorktrees({ sessionId: worker.sessionId })).find((t) => worktreeKey(t) === key) : undefined;
    if (!tree) throw new JarvisError(`${worker.label} has no repository ${key || "by that name"}.`, 404);
    return tree;
}

function isGitSegment(segment: string): boolean {
    // Windows drops trailing dots and spaces, so ".git." and ".git " are .git there.
    return segment.replace(/[. ]+$/, "").toLowerCase() === ".git";
}

function badPath(): JarvisError {
    return new JarvisError("That's not a file in the worktree.", 400);
}

/** A repo-relative path as given, checked by its text alone. Uses "/" between folders. */
export function cleanRelPath(value: unknown): string {
    if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0")) throw badPath();
    const rel = value.replace(/\\/g, "/");
    if (rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) throw badPath();
    if (process.platform === "win32" && rel.includes(":")) throw badPath();
    for (const segment of rel.split("/")) {
        if (!segment || /^[. ]+$/.test(segment) || isGitSegment(segment)) throw badPath();
    }
    return rel;
}

function inside(root: string, target: string): boolean {
    const rel = relative(root, target);
    return !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function exists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch {
        return false;
    }
}

export interface ResolvedPath {
    worktree: Worktree;
    root: string;
    abs: string;
    rel: string;
}

/**
 * A path in one of the worker's worktrees. Rejects anything outside it, through
 * text, junctions or symlinks, and anything in .git.
 */
export async function resolveWorkerPath(sessionId: unknown, repoKey: unknown, relPath: unknown): Promise<ResolvedPath> {
    const worker = await requireWorker(sessionId);
    const worktree = await requireWorktree(worker, repoKey);
    return resolveIn(worktree, relPath);
}

async function resolveIn(worktree: Worktree, relPath: unknown): Promise<ResolvedPath> {
    const rel = cleanRelPath(relPath);
    const root = resolve(worktree.path);
    const abs = resolve(root, rel);
    if (abs === root || !inside(root, abs)) throw badPath();
    const realRoot = await realpath(root).catch(() => null);
    if (!realRoot) throw new JarvisError(`The worktree folder is gone: ${worktree.path}`, 409);
    // The file may be deleted: check the nearest part of the path that's still there.
    let probe = abs;
    while (probe !== root && !(await exists(probe))) probe = dirname(probe);
    const realProbe = await realpath(probe).catch(() => null);
    if (!realProbe || !inside(realRoot, realProbe)) throw new JarvisError("That path points outside the worktree.", 400);
    if (relative(realRoot, realProbe).split(sep).some(isGitSegment)) throw badPath();
    return { worktree, root, abs, rel };
}

// ---- comparisons ----------------------------------------------------------------------

interface Sides {
    /** A commit, or the empty tree. */
    left: string;
    /** "HEAD" for Last commit; null for the working tree. */
    right: "HEAD" | null;
    head: string;
    note?: string;
}

async function sidesFor(root: string, tree: Worktree, mode: ChangesMode, name: string): Promise<Sides> {
    const head = await gitText(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (mode === "uncommitted") return { left: head, right: null, head };
    if (mode === "branch") {
        const base = await gitText(root, ["merge-base", tree.base, "HEAD"]).catch((error: Error) => {
            throw new GitFailed(`Can't find where ${tree.branch} left ${tree.base}: ${error.message}`);
        });
        return { left: base, right: null, head };
    }
    const base = await gitText(root, ["merge-base", tree.base, "HEAD"]).catch(() => "");
    const parent = await gitText(root, ["rev-parse", "--verify", "-q", "HEAD~1^{commit}"]).catch(() => "");
    const sides: Sides = { left: parent || EMPTY_TREE, right: "HEAD", head };
    if (base && base === head) sides.note = `${name} hasn't committed yet`;
    return sides;
}

function short(sha: string): string | null {
    return sha === EMPTY_TREE ? null : sha.slice(0, 7);
}

function countLines(buf: Buffer): number {
    if (!buf.length) return 0;
    let n = 0;
    for (const byte of buf) if (byte === 10) n++;
    return buf[buf.length - 1] === 10 ? n : n + 1;
}

function isBinary(buf: Buffer): boolean {
    return buf.subarray(0, CHANGE_LIMITS.binarySniff).includes(0);
}

async function repoChanges(tree: Worktree, mode: ChangesMode, name: string): Promise<RepoChanges> {
    const root = resolve(tree.path);
    const out: RepoChanges = {
        key: worktreeKey(tree),
        name: tree.repo,
        branch: tree.branch,
        base: tree.base,
        fromRef: null,
        head: null,
        files: [],
    };
    try {
        if (!(await stat(root).then((s) => s.isDirectory()).catch(() => false))) {
            throw new GitFailed(`The worktree folder is gone: ${tree.path}`);
        }
        const sides = await sidesFor(root, tree, mode, name);
        out.fromRef = short(sides.left);
        out.head = sides.head;
        if (sides.note) {
            out.note = sides.note;
            return out;
        }
        // Plumbing only. Porcelain `git diff` rewrites the index when stat data is stale, even
        // with --no-optional-locks, and that lock can break the worker's own git commands.
        const diff = sides.right ? ["diff-tree", "-r", "-M", "-z", sides.left, sides.right] : ["diff-index", "-M", "-z", sides.left];
        const [raw, counts, untracked] = await Promise.all([
            git(root, [...diff, "--raw", "--"]),
            git(root, [...diff, "--numstat", "--"]),
            sides.right ? Promise.resolve(null) : git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
        ]);
        const numstat = parseNumstat(fields(counts));
        let entries = parseRaw(fields(raw));
        if (!sides.right) entries = await dropStatOnly(root, entries, numstat);
        let files: ChangedFile[] = entries.map((f) => {
            const n = numstat.get(f.path);
            const file: ChangedFile = { path: f.path, status: f.status, added: n ? n.added : null, removed: n ? n.removed : null };
            if (f.oldPath) file.oldPath = f.oldPath;
            if (n && n.added === null) file.binary = true;
            return file;
        });
        const seen = new Set(files.map((f) => f.path));
        for (const path of untracked ? fields(untracked) : []) {
            if (!seen.has(path)) files.push({ path, status: "U", added: null, removed: 0 });
        }
        files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        if (files.length > CHANGE_LIMITS.filesPerRepo) {
            out.truncated = files.length - CHANGE_LIMITS.filesPerRepo;
            files = files.slice(0, CHANGE_LIMITS.filesPerRepo);
        }
        if (!sides.right) await addDiskFacts(root, files);
        out.files = files;
    } catch (error) {
        if (!(error instanceof GitFailed)) throw error;
        out.error = error.message;
    }
    return out;
}

/**
 * diff-index can't tell a touched file from an edited one: both come back as M with a null
 * working oid. A text file with no numstat line has the same content; a binary one is hashed.
 */
async function dropStatOnly(root: string, entries: RawEntry[], numstat: Map<string, { added: number | null }>): Promise<RawEntry[]> {
    const same = new Set<RawEntry>();
    const binary: RawEntry[] = [];
    for (const e of entries) {
        if (e.status !== "M" || e.srcMode !== e.dstMode || !/^0+$/.test(e.dstOid)) continue;
        const n = numstat.get(e.path);
        if (!n) same.add(e);
        else if (n.added === null) binary.push(e);
    }
    for (let i = 0; i < binary.length; i += 100) {
        const chunk = binary.slice(i, i + 100);
        const oids = (await gitText(root, ["hash-object", "--", ...chunk.map((e) => e.path)]).catch(() => "")).split(/\r?\n/);
        chunk.forEach((e, j) => {
            if (oids[j] === e.srcOid) same.add(e);
        });
    }
    return same.size ? entries.filter((e) => !same.has(e)) : entries;
}

/** Working-side size and time for each file, and line counts for untracked ones. */
async function addDiskFacts(root: string, files: ChangedFile[]): Promise<void> {
    let budget = CHANGE_LIMITS.untrackedBudget;
    const realRoot = await realpath(root).catch(() => root);
    for (let i = 0; i < files.length; i += 64) {
        await Promise.all(
            files.slice(i, i + 64).map(async (file) => {
                if (file.status === "D") return;
                const abs = resolve(root, file.path);
                const info = await lstat(abs).catch(() => null);
                if (!info || !info.isFile()) return;
                file.size = info.size;
                file.mtimeMs = Math.floor(info.mtimeMs);
                if (file.status !== "U" || info.size > CHANGE_LIMITS.readBytes || info.size > budget) return;
                // Only count lines of files really in the worktree, not behind a junction.
                const real = await realpath(abs).catch(() => null);
                if (!real || !inside(realRoot, real)) return;
                budget -= info.size;
                const buf = await readFile(abs).catch(() => null);
                if (!buf) return;
                if (isBinary(buf)) {
                    file.binary = true;
                    file.removed = null;
                } else {
                    file.added = countLines(buf);
                }
            }),
        );
    }
}

/** The files the worker changed in each of its worktrees. A worker with no worktrees has none. */
export async function listWorkerChanges(sessionId: unknown, modeValue: unknown): Promise<WorkerChanges> {
    const mode = asMode(modeValue);
    const worker = await requireWorker(sessionId);
    const [task, trees] = await Promise.all([getTask(worker.taskId), listWorktrees({ sessionId: worker.sessionId })]);
    const repos = await Promise.all(trees.map((t) => repoChanges(t, mode, worker.label)));
    return {
        mode,
        at: new Date().toISOString(),
        worker: { name: worker.label, task: task?.title || "", busy: isWorkerBusy(worker.sessionId), state: worker.state, taskId: worker.taskId },
        repos,
    };
}

// ---- one file's diff ------------------------------------------------------------------

interface Side {
    buf: Buffer | null;
    size: number;
    tooLarge: boolean;
}

const MISSING: Side = { buf: null, size: 0, tooLarge: false };

async function blobSide(root: string, ref: string, path: string): Promise<Side> {
    if (ref === EMPTY_TREE) return MISSING;
    const spec = `${ref}:${path}`;
    // A path the commit doesn't have (an added file) fails here: that side is empty.
    const said = await gitText(root, ["cat-file", "-s", spec]).catch(() => "");
    const size = said ? Number(said) : NaN;
    if (!Number.isFinite(size)) return MISSING;
    if (size === 0) return { buf: Buffer.alloc(0), size: 0, tooLarge: false };
    if (size > CHANGE_LIMITS.readBytes) return { buf: null, size, tooLarge: true };
    return { buf: await git(root, ["cat-file", "blob", spec]), size, tooLarge: false };
}

async function diskSide(abs: string): Promise<Side> {
    const info = await lstat(abs).catch(() => null);
    if (!info) return MISSING;
    if (!info.isFile()) throw new JarvisError("That's not a file in the worktree.", 400);
    if (info.size > CHANGE_LIMITS.readBytes) return { buf: null, size: info.size, tooLarge: true };
    const buf = await readFile(abs);
    return { buf, size: buf.length, tooLarge: false };
}

function toLines(buf: Buffer | null): string[] {
    if (!buf || !buf.length) return [];
    const text = buf.toString("utf8").replace(/^\uFEFF/, "");
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
}

function isUtf8(buf: Buffer): boolean {
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(buf);
        return true;
    } catch {
        return false;
    }
}

/** One file's diff in a comparison. `oldPath` is the left-side path of a rename. */
export async function workerFileDiff(
    sessionId: unknown,
    repoKey: unknown,
    pathValue: unknown,
    modeValue: unknown,
    oldPathValue?: unknown,
): Promise<WorkerFileDiff> {
    const mode = asMode(modeValue);
    const worker = await requireWorker(sessionId);
    const worktree = await requireWorktree(worker, repoKey);
    const target = await resolveIn(worktree, pathValue);
    const oldRel = oldPathValue == null || oldPathValue === "" ? target.rel : (await resolveIn(worktree, oldPathValue)).rel;
    let sides: Sides;
    try {
        sides = await sidesFor(target.root, worktree, mode, worker.label);
    } catch (error) {
        if (error instanceof GitFailed) throw new JarvisError(error.message, 409);
        throw error;
    }
    const [left, right] = await Promise.all([
        blobSide(target.root, sides.left, oldRel),
        sides.right ? blobSide(target.root, sides.right, target.rel) : diskSide(target.abs),
    ]);
    const out: WorkerFileDiff = { editable: false, oldSize: left.size, newSize: right.size };
    const working = !sides.right && right.buf !== null;
    if (working && right.buf!.length <= CHANGE_LIMITS.editBytes && !isBinary(right.buf!) && isUtf8(right.buf!)) {
        out.editable = true;
        out.hash = createHash("sha256").update(right.buf!).digest("hex");
    }
    if (left.tooLarge || right.tooLarge) return { ...out, tooLarge: true };
    if ((left.buf && isBinary(left.buf)) || (right.buf && isBinary(right.buf))) return { ...out, binary: true };
    const oldLines = toLines(left.buf);
    const newLines = toLines(right.buf);
    out.oldCount = oldLines.length;
    out.newCount = newLines.length;
    if (oldLines.length > CHANGE_LIMITS.linesPerSide || newLines.length > CHANGE_LIMITS.linesPerSide) return { ...out, tooLarge: true };
    out.hunks = diffLines(oldLines, newLines);
    return out;
}
