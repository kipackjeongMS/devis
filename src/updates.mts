// Devis updating itself from GitHub releases. Actions publishes each release on RELEASES_REPO
// with Devis-Setup-<version>.exe, install.ps1 and latest.json (the version, the file and its
// SHA-512). Every 4 hours, and on Check now, the service lists the releases through the GitHub
// CLI's sign-in (no token is kept here), picks the newest one for the channel, downloads it,
// and keeps it only when its SHA-512 matches. The updater ships use (scripts/devis-updater.ps1,
// with -Release) then waits for the work in flight, runs Setup silently, checks the new service
// reports the version within two minutes, and puts the previous build back when it doesn't.
//
// A build made from a source folder (yours, or a teammate's with their own ships in it) never
// installs a release on its own, since a release would wipe those changes. It offers a task
// that brings the release into the source instead, or Install anyway to go back to releases.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME, RELEASES_REPO } from "./brand.mjs";
import { launchDetached, listShips, type DevisShip, type RunResult } from "./devis-self.mjs";
import { JarvisError, clip, getMeta, jarvisDir, recordEvent, setMeta } from "./jarvis-store.mjs";
import { findGh } from "./machine-tools.mjs";
import { buildCommit, buildIsRelease, buildVersion, type WorkItem } from "./service-files.mjs";

export type UpdateChannel = "stable" | "preview";
/** idle: install on its own once the workers are done. ask: wait for a click. */
export type UpdateInstall = "idle" | "ask";
export type UpdateMode = "idle" | "now";
export type UpdateState = "installing" | "live" | "rolled-back" | "failed";

const CHECK_EVERY_MS = 4 * 60 * 60_000;
const FIRST_CHECK_MS = 2 * 60_000;
const SETTLE_EVERY_MS = 15_000;
/** A new build that has run this long with no word from the updater counts as live. */
const SETTLE_AFTER_MS = 5 * 60_000;
/** An install still under way this long (the idle wait is an hour) has lost its updater. */
const GIVE_UP_MS = 3 * 60 * 60_000;
const LIST_MS = 60_000;
const MANIFEST_MS = 2 * 60_000;
const DOWNLOAD_MS = 30 * 60_000;
const HISTORY_MAX = 20;

const SETTING_CHANNEL = "updatesChannel";
const SETTING_INSTALL = "updatesInstall";

export interface UpdateRelease {
    tag: string;
    version: string;
    prerelease: boolean;
    /** The release's title, when it says more than the tag. */
    name: string | null;
    publishedAt: string | null;
    url: string;
}

export interface UpdateProblem {
    kind: "missing" | "signed-out" | "no-access" | "no-releases" | "error";
    text: string;
}

export interface ReadyUpdate extends UpdateRelease {
    /** The downloaded, verified Setup. */
    file: string;
    sha512: string;
    size: number;
    commit: string | null;
    downloadedAt: string;
}

export interface UpdateRecord {
    version: string;
    tag: string;
    url: string;
    /** The version it replaced. */
    from: string | null;
    state: UpdateState;
    mode: UpdateMode;
    note: string | null;
    log: string | null;
    updaterPid: number | null;
    startedAt: string;
    settledAt: string | null;
    dismissed: boolean;
    /** It didn't install only because Devis stayed busy, so the next check tries it again. */
    retry?: boolean;
}

interface UpdatesFile {
    lastChecked: string | null;
    problem: UpdateProblem | null;
    available: UpdateRelease | null;
    ready: ReadyUpdate | null;
    history: UpdateRecord[];
    /** The version whose "ready" or "paused" banner was dismissed. */
    dismissed: string | null;
}

export interface UpdatesRunning {
    version: string | null;
    commit: string | null;
    /** Built by Actions for a release, not from a source folder. */
    release: boolean;
}

// ---- what reaches GitHub and starts the updater (the harness swaps it) ------------------

export interface UpdatesRuntime {
    /** Run the GitHub CLI. Null when it isn't installed. */
    gh(args: string[], timeoutMs: number): Promise<RunResult | null>;
    /** Start a command line outside this process, so it outlives the service. Resolves with its pid. */
    launch(commandLine: string): Promise<number>;
    alive(pid: number): boolean;
    running(): UpdatesRunning;
    /** The updater shipped with this build, or null when it has none. */
    updaterScript(): string | null;
    /** Where downloads, the updater's logs and its results go. */
    dir(): string;
}

const appDir = dirname(fileURLToPath(import.meta.url));

const machineRuntime: UpdatesRuntime = {
    gh(args, timeoutMs) {
        const exe = findGh();
        if (!exe) return Promise.resolve(null);
        return new Promise((done) => {
            execFile(
                exe,
                args,
                { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } },
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
    },
    launch: launchDetached,
    alive(pid) {
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            return (error as NodeJS.ErrnoException).code === "EPERM";
        }
    },
    running: () => ({ version: buildVersion(appDir), commit: buildCommit(appDir), release: buildIsRelease(appDir) }),
    updaterScript() {
        const file = join(appDir, "scripts", "devis-updater.ps1");
        return existsSync(file) ? file : null;
    },
    dir() {
        const dir = join(jarvisDir(), "updates");
        mkdirSync(dir, { recursive: true });
        return dir;
    },
};

let runtime: UpdatesRuntime = machineRuntime;

export function setUpdatesRuntime(next: Partial<UpdatesRuntime> | null): void {
    runtime = next ? { ...machineRuntime, ...next } : machineRuntime;
    checking = null;
    downloading = null;
}

/** Where releases come from. DEVIS_UPDATE_REPO points a test build at a fork. */
export const updatesRepo = (): string => process.env.DEVIS_UPDATE_REPO?.trim() || RELEASES_REPO;

// ---- versions ---------------------------------------------------------------------------

export interface Version {
    major: number;
    minor: number;
    patch: number;
    pre: Array<string | number>;
}

/** A semantic version, with or without a leading v; null when it isn't one. */
export function parseVersion(text: string | null | undefined): Version | null {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec((text || "").trim());
    if (!m) return null;
    const pre = m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

/** Semver order: below 0 when a is older, 0 when equal, above 0 when newer. Unreadable versions sort first. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
    const x = parseVersion(a);
    const y = parseVersion(b);
    if (!x || !y) return x ? 1 : y ? -1 : 0;
    for (const k of ["major", "minor", "patch"] as const) if (x[k] !== y[k]) return x[k] - y[k];
    if (!x.pre.length || !y.pre.length) return x.pre.length ? -1 : y.pre.length ? 1 : 0;
    for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
        const p = x.pre[i];
        const q = y.pre[i];
        if (p === undefined) return -1;
        if (q === undefined) return 1;
        if (p === q) continue;
        if (typeof p === "number" && typeof q === "number") return p - q;
        if (typeof p === "number") return -1;
        if (typeof q === "number") return 1;
        return p < q ? -1 : 1;
    }
    return 0;
}

/** The newest release for the channel that's newer than what runs, or null. */
export function pickRelease(releases: UpdateRelease[], channel: UpdateChannel, running: string | null): UpdateRelease | null {
    return (
        releases
            .filter((r) => channel === "preview" || (!r.prerelease && !parseVersion(r.version)?.pre.length))
            .filter((r) => !running || compareVersions(r.version, running) > 0)
            .sort((a, b) => compareVersions(b.version, a.version))[0] || null
    );
}

// ---- the record -------------------------------------------------------------------------

const stateFile = (): string => join(runtime.dir(), "updates.json");

function readState(): UpdatesFile {
    const empty: UpdatesFile = { lastChecked: null, problem: null, available: null, ready: null, history: [], dismissed: null };
    try {
        const data = JSON.parse(readFileSync(stateFile(), "utf8")) as Partial<UpdatesFile>;
        return { ...empty, ...data, history: Array.isArray(data.history) ? data.history : [] };
    } catch {
        return empty;
    }
}

/** Read, change and write the record in one go: it's all synchronous, so nothing interleaves. */
function editState(change: (s: UpdatesFile) => void): UpdatesFile {
    const s = readState();
    change(s);
    s.history = s.history.slice(-HISTORY_MAX);
    const file = stateFile();
    writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 1));
    renameSync(`${file}.tmp`, file);
    return s;
}

const installing = (s: UpdatesFile = readState()): UpdateRecord | null => s.history.find((r) => r.state === "installing") || null;

/** A version that failed or rolled back here: it isn't installed on its own again. */
const failedHere = (s: UpdatesFile, version: string): boolean =>
    s.history.some((r) => r.version === version && (r.state === "failed" || r.state === "rolled-back") && !r.retry);

const safeName = (version: string): string => version.replace(/[^0-9A-Za-z.+-]/g, "_");

function dropDownload(version: string | undefined): void {
    if (!version) return;
    try {
        rmSync(join(runtime.dir(), safeName(version)), { recursive: true, force: true });
    } catch {
        /* a file still open; the next download clears it */
    }
}

// ---- settings ---------------------------------------------------------------------------

export interface UpdateSettings {
    channel: UpdateChannel;
    install: UpdateInstall;
}

export async function updateSettings(): Promise<UpdateSettings> {
    return {
        channel: (await getMeta(SETTING_CHANNEL)) === "preview" ? "preview" : "stable",
        install: (await getMeta(SETTING_INSTALL)) === "ask" ? "ask" : "idle",
    };
}

export async function saveUpdateSettings(input: { channel?: unknown; install?: unknown }): Promise<UpdatesStatus> {
    const before = await updateSettings();
    if (input.channel === "stable" || input.channel === "preview") await setMeta(SETTING_CHANNEL, input.channel === "preview" ? "preview" : null);
    if (input.install === "idle" || input.install === "ask") await setMeta(SETTING_INSTALL, input.install === "ask" ? "ask" : null);
    // Another channel can mean another release: look again.
    if ((await updateSettings()).channel !== before.channel) void checkForUpdates().catch(() => undefined);
    return updatesStatus();
}

// ---- why this build doesn't take releases on its own -------------------------------------

export interface UpdatePause {
    /** source: built from a source folder. ships: and your own ships are in it. */
    reason: "source" | "ships";
    ships: number;
}

/** Ships still in the build: live, not undone, and not themselves an undo. */
function ownShips(ships: DevisShip[] = listShips()): DevisShip[] {
    return ships.filter((s) => s.state === "live" && !s.revertedBy && !ships.some((o) => o.revertedBy === s.n));
}

export function pausedBy(): UpdatePause | null {
    if (runtime.running().release) return null;
    const ships = ownShips().length;
    return { reason: ships ? "ships" : "source", ships };
}

export function pauseText(p: UpdatePause): string {
    return p.reason === "ships"
        ? `Your ${p.ships === 1 ? "ship is" : `${p.ships} ships are`} in this ${APP_NAME}, and a release would undo ${p.ships === 1 ? "it" : "them"}, so updates don't install on their own. Bring the release into your source instead.`
        : `This ${APP_NAME} was built from your source, so releases don't install over it on their own. Bring the release into your source, or install it anyway to go back to releases.`;
}

// ---- GitHub -----------------------------------------------------------------------------

const firstLine = (text: string): string => text.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 200) || "unknown error";

function ghProblem(r: RunResult | null, what: string): UpdateProblem {
    if (!r) return { kind: "missing", text: `The GitHub CLI isn't installed, so ${APP_NAME} can't ${what}. Install it with \`winget install GitHub.cli\`, then sign in.` };
    const out = `${r.stderr}\n${r.stdout}`;
    if (r.timedOut) return { kind: "error", text: `GitHub didn't answer in time, so ${APP_NAME} couldn't ${what}. It tries again later.` };
    if (r.code === 4 || /gh auth login|not logged in|authentication required|HTTP 401|bad credentials/i.test(out)) {
        return { kind: "signed-out", text: `The GitHub CLI isn't signed in, so ${APP_NAME} can't ${what}.` };
    }
    if (/could not resolve to a repository|HTTP 404|not found/i.test(out)) {
        return { kind: "no-access", text: `Your GitHub account can't see ${updatesRepo()} yet, so ${APP_NAME} can't ${what}. Ask for an invite, then check again.` };
    }
    return { kind: "error", text: `${APP_NAME} couldn't ${what}: ${firstLine(out)}` };
}

const isProblem = (x: unknown): x is UpdateProblem => !!x && typeof x === "object" && "kind" in x && "text" in x;

async function listReleases(): Promise<UpdateRelease[] | UpdateProblem> {
    const repo = updatesRepo();
    const r = await runtime.gh(["release", "list", "-R", repo, "--limit", "50", "--json", "tagName,name,isPrerelease,isDraft,publishedAt"], LIST_MS);
    if (!r || r.code !== 0) return ghProblem(r, "check for updates");
    let rows: unknown;
    try {
        rows = JSON.parse(r.stdout.trim() || "[]");
    } catch {
        return { kind: "error", text: "GitHub's list of releases wasn't readable. It tries again later." };
    }
    if (!Array.isArray(rows)) return { kind: "error", text: "GitHub's list of releases wasn't readable. It tries again later." };
    const releases: UpdateRelease[] = [];
    for (const row of rows as Array<Record<string, unknown>>) {
        const tag = typeof row.tagName === "string" ? row.tagName : "";
        const version = tag.replace(/^v/, "");
        if (row.isDraft === true || !parseVersion(version)) continue;
        const name = typeof row.name === "string" && row.name.trim() && row.name.trim() !== tag ? row.name.trim() : null;
        releases.push({
            tag,
            version,
            prerelease: row.isPrerelease === true,
            name,
            publishedAt: typeof row.publishedAt === "string" ? row.publishedAt : null,
            url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
        });
    }
    return releases;
}

function sha512Of(file: string): Promise<string> {
    return new Promise((done, fail) => {
        const hash = createHash("sha512");
        createReadStream(file)
            .on("error", fail)
            .on("data", (chunk) => hash.update(chunk))
            .on("end", () => done(hash.digest("hex")));
    });
}

let downloading: string | null = null;

/** Download a release's latest.json and Setup, and keep them only when the Setup matches its SHA-512. */
async function download(rel: UpdateRelease): Promise<ReadyUpdate | UpdateProblem> {
    const repo = updatesRepo();
    const dir = join(runtime.dir(), safeName(rel.version));
    dropDownload(rel.version);
    mkdirSync(dir, { recursive: true });
    downloading = rel.version;
    try {
        let r = await runtime.gh(["release", "download", rel.tag, "-R", repo, "-p", "latest.json", "-D", dir, "--clobber"], MANIFEST_MS);
        if (!r || r.code !== 0) return ghProblem(r, `download ${rel.version}`);
        let manifest: Record<string, unknown>;
        try {
            manifest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
        } catch {
            return { kind: "error", text: `${rel.version}'s latest.json wasn't readable, so it wasn't downloaded.` };
        }
        const file = typeof manifest.file === "string" ? manifest.file : "";
        const sha512 = typeof manifest.sha512 === "string" ? manifest.sha512.toLowerCase() : "";
        const size = typeof manifest.size === "number" ? manifest.size : -1;
        if (manifest.version !== rel.version || !/^[\w.+-]+\.exe$/.test(file) || !/^[0-9a-f]{128}$/.test(sha512) || size <= 0) {
            return { kind: "error", text: `${rel.version}'s latest.json doesn't describe its Setup, so it wasn't downloaded.` };
        }
        r = await runtime.gh(["release", "download", rel.tag, "-R", repo, "-p", file, "-D", dir, "--clobber"], DOWNLOAD_MS);
        if (!r || r.code !== 0) return ghProblem(r, `download ${rel.version}`);
        const path = join(dir, file);
        const ok = existsSync(path) && statSync(path).size === size && (await sha512Of(path)) === sha512;
        if (!ok) {
            dropDownload(rel.version);
            return { kind: "error", text: `${rel.version}'s download didn't match its SHA-512, so it was thrown away. ${APP_NAME} tries again later.` };
        }
        return {
            ...rel,
            file: path,
            sha512,
            size,
            commit: typeof manifest.commit === "string" ? manifest.commit : null,
            downloadedAt: new Date().toISOString(),
        };
    } finally {
        downloading = null;
    }
}

// ---- checking ---------------------------------------------------------------------------

let checking: Promise<UpdatesStatus> | null = null;

/** Look for a newer release now; one check at a time (a second call joins the first). */
export function checkForUpdates(): Promise<UpdatesStatus> {
    if (!checking) checking = checkNow().finally(() => (checking = null));
    return checking;
}

async function checkNow(): Promise<UpdatesStatus> {
    const settings = await updateSettings();
    const running = runtime.running();
    const listed = await listReleases();
    const at = new Date().toISOString();
    if (isProblem(listed)) {
        editState((s) => {
            s.lastChecked = at;
            s.problem = listed;
        });
        return updatesStatus();
    }
    const pick = pickRelease(listed, settings.channel, running.version);
    const s = editState((s) => {
        s.lastChecked = at;
        s.problem = listed.length ? null : { kind: "no-releases", text: `${updatesRepo()} has no releases yet.` };
        s.available = pick;
        if (s.ready && s.ready.version !== pick?.version) {
            dropDownload(s.ready.version);
            s.ready = null;
        }
    });
    // A build from source downloads nothing ahead: it doesn't install releases on its own.
    if (!pick || pausedBy() || installing(s)) return updatesStatus();
    if (s.ready?.version !== pick.version) {
        const got = await download(pick);
        editState((s) => {
            if (isProblem(got)) s.problem = got;
            else s.ready = got;
        });
        if (isProblem(got)) return updatesStatus();
    }
    const now = readState();
    if (settings.install === "idle" && now.ready && !failedHere(now, now.ready.version)) {
        await startInstall("idle", false).catch((error: Error) => console.warn(`[updates] ${error.message}`));
    }
    return updatesStatus();
}

// ---- installing -------------------------------------------------------------------------

/** Install the available release: download it when it isn't yet, then start the updater. */
export async function installUpdate(input: { mode?: unknown; force?: unknown }): Promise<UpdatesStatus> {
    await startInstall(input.mode === "now" ? "now" : "idle", input.force === true);
    return updatesStatus();
}

async function startInstall(mode: UpdateMode, force: boolean): Promise<UpdateRecord> {
    let s = readState();
    const busy = installing(s);
    if (busy) throw new JarvisError(`${APP_NAME} ${busy.version} is already installing.`, 409);
    const paused = pausedBy();
    if (paused && !force) throw new JarvisError(pauseText(paused), 409);
    const rel = s.available;
    if (!rel) throw new JarvisError("There's no update to install. Check for updates first.", 409);
    if (s.ready?.version !== rel.version || !existsSync(s.ready.file)) {
        const got = await download(rel);
        if (isProblem(got)) throw new JarvisError(got.text, 502);
        s = editState((s) => (s.ready = got));
    }
    const ready = s.ready!;
    const source = runtime.updaterScript();
    if (!source) throw new JarvisError(`This build has no updater to run. Install ${rel.version} with its Setup instead: ${rel.url}`, 409);
    const dir = runtime.dir();
    const script = join(dir, `updater-${safeName(rel.version)}.ps1`);
    // Windows PowerShell reads a file without a BOM as ANSI.
    writeFileSync(script, "\uFEFF" + readFileSync(source, "utf8").replace(/^\uFEFF/, "").replace(/\r?\n/g, "\r\n"));
    rmSync(join(dir, `release-${safeName(rel.version)}.result.json`), { force: true });
    const record: UpdateRecord = {
        version: rel.version,
        tag: rel.tag,
        url: rel.url,
        from: runtime.running().version,
        state: "installing",
        mode,
        note: null,
        log: null,
        updaterPid: null,
        startedAt: new Date().toISOString(),
        settledAt: null,
        dismissed: false,
    };
    editState((s) => {
        s.history.push(record);
        s.dismissed = null;
    });
    const editRecord = (change: (r: UpdateRecord) => void) =>
        editState((s) => {
            const r = s.history.find((r) => r.startedAt === record.startedAt && r.version === record.version);
            if (r) change(r);
        });
    try {
        const pid = await runtime.launch(
            [
                "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden",
                `-File "${script}"`,
                `-Release ${rel.version}`,
                `-Installer "${ready.file}"`,
                `-Mode ${mode}`,
                `-StateDir "${dir}"`,
            ].join(" "),
        );
        editRecord((r) => (r.updaterPid = pid));
        record.updaterPid = pid;
    } catch (error) {
        const note = `The updater didn't start: ${(error as Error).message}`;
        editRecord((r) => {
            r.state = "failed";
            r.note = note;
            r.settledAt = new Date().toISOString();
        });
        await recordEvent("devisUpdate", `${APP_NAME} ${rel.version} didn't install: ${note}`).catch(() => undefined);
        throw new JarvisError(note, 500);
    }
    await recordEvent("devisUpdate", `Installing ${APP_NAME} ${rel.version}${mode === "idle" ? " once the workers are done" : ""}.`).catch(() => undefined);
    return record;
}

// ---- after the install ------------------------------------------------------------------

interface UpdaterResult {
    state: Exclude<UpdateState, "installing">;
    note: string;
    logTail: string;
    retry: boolean;
}

function readResult(version: string): UpdaterResult | null {
    try {
        const data = JSON.parse(readFileSync(join(runtime.dir(), `release-${safeName(version)}.result.json`), "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
        const state = data.state === "live" || data.state === "rolled-back" || data.state === "failed" ? data.state : null;
        if (!state) return null;
        return {
            state,
            note: typeof data.note === "string" ? data.note.trim() : "",
            logTail: typeof data.logTail === "string" ? data.logTail : "",
            retry: data.retry === true,
        };
    } catch {
        return null;
    }
}

/** Settle an install whose updater finished. `since` is when this service started. */
export async function settleUpdates(since: number, nowMs = Date.now()): Promise<UpdateRecord | null> {
    const rec = installing();
    if (!rec) return null;
    const result = readResult(rec.version);
    const mine = runtime.running().version === rec.version;
    let outcome: { state: Exclude<UpdateState, "installing">; note: string | null; log: string | null; retry?: boolean } | null = null;
    if (result) {
        outcome = {
            state: result.state,
            note:
                result.state === "live"
                    ? null
                    : result.note || (result.state === "rolled-back" ? "The new build didn't come up, so the previous one is back." : "Setup didn't finish, so the running build stayed."),
            log: result.state === "live" ? null : clip(result.logTail, 4000) || null,
            retry: result.retry,
        };
    } else if (mine && nowMs - since > SETTLE_AFTER_MS) {
        outcome = { state: "live", note: null, log: null };
    } else if ((rec.updaterPid && !runtime.alive(rec.updaterPid)) || nowMs - Date.parse(rec.startedAt) > GIVE_UP_MS) {
        outcome = mine
            ? { state: "live", note: null, log: null }
            : { state: "failed", note: `The updater stopped without saying how it went. See release-${safeName(rec.version)}.log in ${runtime.dir()}.`, log: null };
    }
    if (!outcome) return null;
    const o = outcome;
    let done: UpdateRecord | null = null;
    editState((s) => {
        const r = s.history.find((r) => r.startedAt === rec.startedAt && r.version === rec.version);
        if (!r) return;
        r.state = o.state;
        r.note = o.note;
        r.log = o.log;
        if (o.retry) r.retry = true;
        r.settledAt = new Date(nowMs).toISOString();
        done = { ...r };
        if (o.state === "live") {
            if (s.ready && compareVersions(s.ready.version, rec.version) <= 0) {
                dropDownload(s.ready.version);
                s.ready = null;
            }
            if (s.available && compareVersions(s.available.version, rec.version) <= 0) s.available = null;
        }
    });
    if (!done) return null;
    const d = done as UpdateRecord;
    const text =
        d.state === "live"
            ? `${APP_NAME} ${d.version} is live.`
            : `${APP_NAME} ${d.version} ${d.state === "rolled-back" ? "was rolled back" : "didn't install"}: ${d.note}`;
    await recordEvent("devisUpdate", text).catch(() => undefined);
    return d;
}

// ---- the task that brings a release into your source -------------------------------------

/** A Devis task: its worker merges the release tag into the source, and it ships like any change. */
export function releaseTask(version: unknown): { title: string; description: string } {
    const rel = readState().available;
    if (!rel) throw new JarvisError("There's no release to bring in. Check for updates first.", 409);
    if (typeof version === "string" && version && version !== rel.version) throw new JarvisError(`${version} isn't the newest release any more: ${rel.version} is.`, 409);
    const repo = updatesRepo();
    return {
        title: clip(`Bring ${APP_NAME} ${rel.version} into your source`, 200),
        description: [
            `${APP_NAME} ${rel.version} is out (${rel.url}). This ${APP_NAME} is built from its source folder, so releases don't install over it; bring ${rel.version} into the source instead, keeping our own changes.`,
            `1. Fetch the release tag into your worktree: \`git fetch <remote> refs/tags/${rel.tag}:refs/tags/${rel.tag}\`, with the remote for ${repo} (\`git remote -v\`), or \`https://github.com/${repo}.git\` when there's none. If Git asks for credentials, run \`gh auth setup-git\` first.`,
            `2. Merge it into your branch: \`git merge --no-ff ${rel.tag} -m "Bring in ${APP_NAME} ${rel.version}"\`. Where it conflicts, keep both the release's change and ours; ask me when it's unclear which should win.`,
            `3. Commit, then call devis_ready_to_ship with the title "Bring in ${APP_NAME} ${rel.version}".`,
        ].join("\n\n"),
    };
}

// ---- for the UI -------------------------------------------------------------------------

export interface UpdatesStatus {
    repo: string;
    running: UpdatesRunning;
    channel: UpdateChannel;
    install: UpdateInstall;
    lastChecked: string | null;
    checking: boolean;
    /** The version downloading now. */
    downloading: string | null;
    problem: UpdateProblem | null;
    available: UpdateRelease | null;
    /** Downloaded and verified, ready to install. */
    ready: string | null;
    paused: UpdatePause | null;
    installing: UpdateRecord | null;
    /** Newest first. */
    history: UpdateRecord[];
}

export async function updatesStatus(): Promise<UpdatesStatus> {
    const s = readState();
    const settings = await updateSettings();
    return {
        repo: updatesRepo(),
        running: runtime.running(),
        ...settings,
        lastChecked: s.lastChecked,
        checking: !!checking,
        downloading,
        problem: s.problem,
        available: s.available,
        ready: s.ready?.version ?? null,
        paused: pausedBy(),
        installing: installing(s),
        history: [...s.history].reverse(),
    };
}

export interface UpdateBanner {
    state: "ready" | "paused" | "installing" | "live" | "rolled-back" | "failed";
    version: string;
    name: string | null;
    url: string;
    note: string | null;
    mode: UpdateMode | null;
    install: UpdateInstall;
    pause: UpdatePause | null;
}

/** The update worth a banner on Today: installing, just live, failed, ready, or paused by your source. */
export async function updateBanner(nowMs = Date.now()): Promise<UpdateBanner | null> {
    const s = readState();
    const { install } = await updateSettings();
    const base = { name: null, note: null, mode: null, install, pause: null };
    const busy = installing(s);
    if (busy) return { ...base, state: "installing", version: busy.version, url: busy.url, mode: busy.mode };
    const last = s.history[s.history.length - 1];
    if (last && !last.dismissed && last.settledAt) {
        const age = nowMs - Date.parse(last.settledAt);
        if (last.state === "live" && age < 30 * 60_000) return { ...base, state: "live", version: last.version, url: last.url };
        if (last.state !== "live" && !last.retry && age < 7 * 86_400_000) return { ...base, state: last.state, version: last.version, url: last.url, note: last.note };
    }
    const rel = s.available;
    if (!rel || s.dismissed === rel.version || compareVersions(rel.version, runtime.running().version) <= 0) return null;
    const pause = pausedBy();
    if (pause) return { ...base, state: "paused", version: rel.version, name: rel.name, url: rel.url, pause };
    if (s.ready?.version === rel.version && !failedHere(s, rel.version)) return { ...base, state: "ready", version: rel.version, name: rel.name, url: rel.url };
    return null;
}

/** Hide the banner for a version: a settled install's, or a ready or paused release's. */
export async function dismissUpdate(version: unknown): Promise<UpdatesStatus> {
    if (typeof version !== "string" || !version) throw new JarvisError("Say which version.", 400);
    editState((s) => {
        const last = [...s.history].reverse().find((r) => r.version === version && r.state !== "installing");
        if (last) last.dismissed = true;
        if (s.available?.version === version) s.dismissed = version;
    });
    return updatesStatus();
}

/** A download in flight keeps the service up. */
export function updatesActivity(): WorkItem[] {
    return downloading ? [{ kind: "other", label: `Downloading ${APP_NAME} ${downloading}` }] : [];
}

// ---- the runner -------------------------------------------------------------------------

let timers: Array<ReturnType<typeof setTimeout>> = [];

/** Settle an install now and every 15 seconds; check for a release after 2 minutes, then every 4 hours. */
export function startUpdates(): void {
    stopUpdates();
    const since = Date.now();
    const settle = () => void settleUpdates(since).catch((error: Error) => console.warn(`[updates] settle: ${error.message}`));
    const check = () => void checkForUpdates().catch((error: Error) => console.warn(`[updates] check: ${error.message}`));
    settle();
    timers = [setInterval(settle, SETTLE_EVERY_MS), setTimeout(check, FIRST_CHECK_MS), setInterval(check, CHECK_EVERY_MS)];
    for (const t of timers) t.unref?.();
}

export function stopUpdates(): void {
    for (const t of timers) clearTimeout(t);
    timers = [];
}
