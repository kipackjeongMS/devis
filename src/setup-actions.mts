// The buttons in Settings › Setup and the first-run window: installing the Azure CLI and Agency,
// the sign-ins, and getting Devis' source for developer mode. Each runs as a job the page polls.
//
// One job per action at a time (pressing Install twice joins the first), and the latest job per
// action is kept, so a page that reloads still sees how the last one went. The Azure and Copilot
// sign-ins open a console window, because az and copilot sign in interactively; the job waits for
// that window to close, then checks the sign-in took. GitHub needs no window: gh's device sign-in
// runs hidden, and the page shows its one-time code and opens github.com/login/device. Every
// sign-in checks first and skips the window when you're already signed in. Jobs in flight keep the
// service running.
//
// Everything that touches the machine goes through SetupEnv, so the harness can stand in for it.

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readdirSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { APP_NAME, LEAD_NAME, RELEASES_REPO } from "./brand.mjs";
import type { WorkItem } from "./service-files.mjs";

export const SETUP_ACTIONS = ["azure-install", "azure-signin", "copilot-signin", "github-signin", "agency-install", "devis-source"] as const;
export type SetupActionId = (typeof SETUP_ACTIONS)[number];

export interface SetupJob {
    id: string;
    action: SetupActionId;
    state: "running" | "done" | "failed";
    /** 0 to 1, or null while it can't say. */
    progress: number | null;
    message: string;
    startedAt: string;
    endedAt?: string;
    /** Finished, and it takes a restart of Devis to use (Agency). */
    restart?: boolean;
    /** What came of it, for the page: the source folder, for devis-source. */
    path?: string;
    /** While a sign-in waits on a web page: where it is, and the code to enter there. */
    link?: string;
    code?: string;
}

export interface RunResult {
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

export interface RunOptions {
    cwd?: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    /** Each non-empty line of output, as it comes. */
    onLine?: (line: string) => void;
}

export interface GhAccountView {
    signedIn: boolean;
    login: string | null;
    error: string | null;
}

/** The machine, behind one seam. */
export interface SetupEnv {
    azureCliDir(): string;
    azureZipUrl: string;
    download(url: string, file: string, progress: (done: number, total: number | null) => void): Promise<void>;
    extract(zip: string, dir: string): Promise<void>;
    run(file: string, args: string[], opts: RunOptions): Promise<RunResult>;
    /** A console window running `commandLine` (cmd syntax). Resolves with its exit code once it's closed; rejects past `timeoutMs`. */
    openConsole(title: string, commandLine: string, timeoutMs: number): Promise<number | null>;
    azureCli(): string | null;
    /** Who the Azure CLI is signed in as now, read fresh; throws when it isn't. */
    azureAccount(): Promise<string | null>;
    agencyPath(): string | null;
    agencyInstaller(): { file: string; args: string[] };
    /** Whether Copilot runs on something other than Agency in this service, so using Agency takes a restart. */
    restartForAgency(): Promise<boolean>;
    /** The command that signs in to Copilot, or null when nothing here can. */
    copilotLogin(): Promise<string[] | null>;
    /** Who Copilot is signed in as, or null when it isn't. */
    copilotAccount(): Promise<string | null>;
    gh(): string | null;
    /** The GitHub CLI's github.com sign-in: whether there is one, who, and why GitHub didn't answer. */
    ghAccount(gh: string): Promise<GhAccountView>;
    /**
     * gh's device sign-in, with no console: `onPrompt` gets the one-time code and the page to enter it on
     * as soon as gh prints them. Resolves once gh is done (it stores the sign-in itself), or past `timeoutMs`.
     */
    ghLogin(gh: string, onPrompt: (prompt: { code: string; url: string; copied: boolean }) => void, timeoutMs: number): Promise<RunResult>;
    /** Open a web page in the default browser. */
    openUrl(url: string): void;
    git(): string;
    node(): string;
    npm(): string;
    saveSource(path: string): Promise<void>;
}

const CONSOLE_MS = 15 * 60_000;
const AGENCY_MS = 15 * 60_000;
const CLONE_MS = 10 * 60_000;
const NPM_MS = 20 * 60_000;
const MIN_NODE = 22;
const isWin = process.platform === "win32";

export class SetupError extends Error {
    constructor(
        message: string,
        readonly status = 400,
    ) {
        super(message);
    }
}

// ---- running programs -------------------------------------------------------------------

/** One argument for a cmd.exe command line, quoted when it needs to be. */
function cmdArg(arg: string): string {
    return /[\s&|<>^()"]/.test(arg) || !arg ? `"${arg.replace(/"/g, '""')}"` : arg;
}

export const cmdLine = (parts: string[]): string => parts.map(cmdArg).join(" ");

/** .cmd and .bat files (az, npm) only run through cmd.exe. */
const needsCmd = (file: string): boolean => isWin && (/\.(cmd|bat)$/i.test(file) || file === "npm");

function killTree(pid: number | undefined): void {
    if (!pid) return;
    if (isWin) {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
        return;
    }
    try {
        process.kill(pid, "SIGKILL");
    } catch {
        /* already gone */
    }
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const OUTPUT_MAX = 64 * 1024;

function runProgram(file: string, args: string[], opts: RunOptions): Promise<RunResult> {
    return new Promise((resolve) => {
        const viaCmd = needsCmd(file);
        const child = viaCmd
            ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${cmdLine([file, ...args])}"`], {
                  cwd: opts.cwd,
                  env: opts.env ?? process.env,
                  windowsHide: true,
                  windowsVerbatimArguments: true,
                  stdio: ["ignore", "pipe", "pipe"],
              })
            : spawn(file, args, { cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        const out = { stdout: "", stderr: "" };
        const partial = { stdout: "", stderr: "" };
        const take = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
            const text = chunk.toString("utf8");
            out[stream] = (out[stream] + text).slice(-OUTPUT_MAX);
            if (!opts.onLine) return;
            const lines = (partial[stream] + text).split(/\r?\n|\r/);
            partial[stream] = lines.pop() ?? "";
            for (const line of lines) {
                const clean = line.replace(ANSI, "").trim();
                if (clean) opts.onLine(clean);
            }
        };
        child.stdout?.on("data", take("stdout"));
        child.stderr?.on("data", take("stderr"));
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            killTree(child.pid);
        }, opts.timeoutMs);
        let settled = false;
        const done = (code: number | null, error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code, stdout: out.stdout, stderr: out.stderr || error?.message || "", timedOut });
        };
        child.on("error", (error) => done(null, error));
        child.on("close", (code) => done(timedOut ? null : code));
    });
}

/**
 * A console window of its own, through Start-Process: the service has no console, and a child
 * Node starts detached gets none either. Waits on that process only, not anything it leaves behind.
 */
async function openConsoleWindow(title: string, commandLine: string, timeoutMs: number): Promise<number | null> {
    const line = `title ${APP_NAME} - ${title} & ${commandLine} || pause`;
    const script = [
        "$ErrorActionPreference = 'Stop'",
        `$p = Start-Process -FilePath $env:ComSpec -ArgumentList '/d /s /c "${line.replace(/'/g, "''")}"' -PassThru`,
        "$p.WaitForExit()",
        "[Console]::Out.Write($p.ExitCode)",
    ].join("\n");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const r = await runProgram("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { timeoutMs });
    if (r.timedOut) throw new Error(`The ${title.toLowerCase()} window was open more than ${Math.round(timeoutMs / 60_000)} minutes, so ${APP_NAME} stopped waiting. Close it and try again.`);
    const code = Number(r.stdout.trim());
    if (r.code !== 0) throw new Error(`${APP_NAME} couldn't open the ${title.toLowerCase()} window: ${lastLine(r.stderr || r.stdout)}`);
    return Number.isInteger(code) ? code : null;
}

async function downloadFile(url: string, file: string, progress: (done: number, total: number | null) => void): Promise<void> {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`The download failed: ${res.status} ${res.statusText}`.trim());
    const total = Number(res.headers.get("content-length")) || null;
    let done = 0;
    let last = 0;
    const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
    body.on("data", (chunk: Buffer) => {
        done += chunk.length;
        const now = Date.now();
        if (now - last >= 250) {
            last = now;
            progress(done, total);
        }
    });
    await pipeline(body, createWriteStream(file));
    progress(done, total);
}

async function extractZip(zip: string, dir: string): Promise<void> {
    // Windows' own tar (bsdtar) reads ZIPs, and unpacks the Azure CLI's 13,000 files in about 20 s.
    const tar = isWin ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
    const r = await runProgram(tar, ["-xf", zip, "-C", dir], { timeoutMs: 10 * 60_000 });
    if (r.code !== 0) throw new Error(r.timedOut ? "Unpacking took more than 10 minutes and was stopped." : `Unpacking failed: ${lastLine(r.stderr || r.stdout)}`);
}

const realEnv: SetupEnv = {
    azureCliDir: () => {
        throw new Error("not loaded");
    },
    azureZipUrl: "https://aka.ms/installazurecliwindowszipx64",
    download: downloadFile,
    extract: extractZip,
    run: runProgram,
    openConsole: openConsoleWindow,
    azureCli: () => null,
    async azureAccount() {
        const [{ clearAzTokenCache, getAzToken }, { ADO_RESOURCE }, { tokenAccount }] = await Promise.all([import("./azauth.mjs"), import("./ado.mjs"), import("./setup-checks.mjs")]);
        clearAzTokenCache();
        return tokenAccount(await getAzToken(ADO_RESOURCE));
    },
    agencyPath: () => null,
    agencyInstaller: () => {
        const script = 'iex "& { $(irm https://aka.ms/InstallTool.ps1) } agency"';
        return {
            file: "powershell.exe",
            args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        };
    },
    async restartForAgency() {
        const { resolveCopilotRuntime } = await import("./copilot-runtime.mjs");
        const runtime = await resolveCopilotRuntime().catch(() => null);
        return runtime?.via !== "agency";
    },
    async copilotLogin() {
        const { agencyExePath, resolveCopilotCliPath } = await import("./copilot-runtime.mjs");
        const agency = agencyExePath();
        if (agency) return [agency, "copilot", "login"];
        const cli = await resolveCopilotCliPath().catch(() => null);
        return cli ? [cli, "login"] : null;
    },
    async copilotAccount() {
        const { withCopilotClient, stopCopilotClient } = await import("./copilot-runtime.mjs");
        const read = () => withCopilotClient((client) => client.getAuthStatus());
        let auth = await read();
        // A runtime that started signed out may not notice the new sign-in. Nothing runs on it while
        // it's signed out, so starting it again costs nothing.
        if (!auth.isAuthenticated) {
            await stopCopilotClient();
            auth = await read();
        }
        return auth.isAuthenticated ? auth.login || "your GitHub account" : null;
    },
    gh: () => null,
    async ghAccount(gh) {
        const { readGhAccount } = await import("./setup-checks.mjs");
        return readGhAccount(gh, 30_000);
    },
    ghLogin(gh, onPrompt, timeoutMs) {
        // A token in the environment wins over a stored sign-in, and gh refuses to sign in over one.
        const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
        for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[key];
        let said = "";
        let told = false;
        return runProgram(gh, ["auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https"], {
            timeoutMs,
            env,
            onLine(line) {
                said += line + "\n";
                const code = /\bcode\b[^\n]*?\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/i.exec(said)?.[1];
                if (told || !code) return;
                told = true;
                const url = /https:\/\/\S+\/login\/device\b/i.exec(said)?.[0] || "https://github.com/login/device";
                onPrompt({ code: code.toUpperCase(), url, copied: /copied to (the )?clipboard/i.test(said) });
            },
        });
    },
    openUrl(url) {
        if (!isWin) return;
        spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" })
            .on("error", () => undefined)
            .unref();
    },
    git: () => "git",
    node: () => "node",
    npm: () => "npm",
    async saveSource(path) {
        const { saveDevisSettings } = await import("./devis-self.mjs");
        await saveDevisSettings({ source: path });
    },
};

let env: SetupEnv = realEnv;
let machineLoaded = false;

/** The machine lookups load lazily, so the harness can run this module without them. */
async function machine(): Promise<SetupEnv> {
    if (env !== realEnv || machineLoaded) return env;
    const [tools, { agencyExePath }] = await Promise.all([import("./machine-tools.mjs"), import("./copilot-runtime.mjs")]);
    realEnv.azureCliDir = tools.devisAzureCliDir;
    realEnv.azureCli = () => tools.findAzureCli().command;
    realEnv.agencyPath = agencyExePath;
    realEnv.gh = tools.findGh;
    machineLoaded = true;
    return env;
}

/** The harness stands in for the machine; null puts the real one back. Forgets past jobs either way. */
export function setSetupEnv(next: Partial<SetupEnv> | null): void {
    env = next ? { ...realEnv, ...next } : realEnv;
    latest.clear();
}

// ---- the actions --------------------------------------------------------------------------

interface Outcome {
    message: string;
    restart?: boolean;
    path?: string;
}

type Update = (patch: Partial<Pick<SetupJob, "progress" | "message" | "code" | "link">>) => void;

function lastLine(text: string): string {
    const lines = text
        .replace(ANSI, "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    return (lines[lines.length - 1] || "no output").slice(0, 300);
}

const mb = (bytes: number): string => String(Math.round(bytes / (1024 * 1024)));

async function azureInstall(e: SetupEnv, update: Update): Promise<Outcome> {
    if (e.azureCli()) return { message: "The Azure CLI is already installed." };
    if (!isWin) throw new SetupError("Install the Azure CLI from https://aka.ms/installazurecli, then check again.");
    const dir = e.azureCliDir();
    const parent = dirname(dir);
    const zip = join(parent, "azure-cli.zip.part");
    const staging = `${dir}.new`;
    const old = `${dir}.old`;
    await mkdir(parent, { recursive: true });
    try {
        update({ progress: 0, message: "Downloading the Azure CLI…" });
        await e.download(e.azureZipUrl, zip, (done, total) =>
            update(
                total
                    ? { progress: (0.8 * done) / total, message: `Downloading the Azure CLI (${mb(done)} of ${mb(total)} MB)` }
                    : { progress: null, message: `Downloading the Azure CLI (${mb(done)} MB)` },
            ),
        );
        update({ progress: 0.82, message: "Unpacking it. This takes about half a minute." });
        await rm(staging, { recursive: true, force: true });
        await mkdir(staging, { recursive: true });
        await e.extract(zip, staging);
        if (!existsSync(join(staging, "bin", "az.cmd"))) throw new Error("The download didn't have the Azure CLI in it.");
        // A broken earlier copy (one that runs would have been found) moves aside first.
        await rm(old, { recursive: true, force: true });
        if (existsSync(dir)) await rename(dir, old);
        await rename(staging, dir);
        await rm(old, { recursive: true, force: true }).catch(() => undefined);
        update({ progress: 0.95, message: "Checking that it runs…" });
        const r = await e.run(join(dir, "bin", "az.cmd"), ["version", "--output", "json"], { timeoutMs: 3 * 60_000 });
        if (r.code !== 0) throw new Error(`It was unpacked but doesn't run: ${lastLine(r.stderr || r.stdout)}`);
        let version = "";
        try {
            version = String(JSON.parse(r.stdout)["azure-cli"] || "");
        } catch {
            /* the version is only to show */
        }
        return { message: `Azure CLI ${version} installed. Sign in next.`.replace("  ", " ") };
    } finally {
        await rm(zip, { force: true }).catch(() => undefined);
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
}

async function azureSignIn(e: SetupEnv, update: Update): Promise<Outcome> {
    const az = e.azureCli();
    if (!az) throw new SetupError("Install the Azure CLI first.");
    update({ message: "Checking the Azure CLI…" });
    const already = await e.azureAccount().then(
        (who) => ({ who }),
        () => null,
    );
    if (already) return { message: already.who ? `Already signed in as ${already.who}.` : "Already signed in." };
    update({ message: "Finish signing in in the window that opened." });
    // No subscriptions is fine: Devis only needs Azure DevOps.
    await e.openConsole("Azure sign-in", cmdLine([az, "login", "--allow-no-subscriptions"]), CONSOLE_MS);
    update({ message: "Checking the sign-in…" });
    let who: string | null;
    try {
        who = await e.azureAccount();
    } catch (error) {
        const why = lastLine((error as Error)?.message || "");
        throw new SetupError(`Still not signed in${why === "no output" ? "" : ` (${why})`}. Try again, and finish signing in in the window that opens.`);
    }
    return { message: who ? `Signed in as ${who}.` : "Signed in." };
}

async function copilotSignIn(e: SetupEnv, update: Update): Promise<Outcome> {
    const login = await e.copilotLogin();
    if (!login) throw new SetupError("Signing in to Copilot needs Agency. Install Agency first, then sign in.");
    update({ message: "Checking Copilot…" });
    const already = await e.copilotAccount().catch(() => null);
    if (already) return { message: `Already signed in as ${already}.` };
    update({ message: "Finish signing in in the window that opened." });
    await e.openConsole("Copilot sign-in", cmdLine(login), CONSOLE_MS);
    update({ message: "Checking the sign-in…" });
    const who = await e.copilotAccount().catch(() => null);
    if (!who) throw new SetupError("Still not signed in to Copilot. Try again, and finish signing in in the window that opens.");
    return { message: `Signed in as ${who}.` };
}

async function githubSignIn(e: SetupEnv, update: Update): Promise<Outcome> {
    const gh = e.gh();
    if (!gh) throw new SetupError("Install the GitHub CLI first: run winget install GitHub.cli, then check again.");
    update({ message: "Checking the GitHub CLI…" });
    const before = await e.ghAccount(gh).catch(() => null);
    if (before?.login) return { message: `Already signed in to GitHub as ${before.login}.` };
    // Signing in again wouldn't help: say what GitHub said instead.
    if (before?.signedIn) {
        throw new SetupError(`The GitHub CLI is signed in, but GitHub didn't answer it: ${before.error || "no reason given"}. Check the network or proxy, then try again.`);
    }
    update({ message: "Starting the GitHub sign-in…" });
    const login = await e.ghLogin(
        gh,
        ({ code, url, copied }) => {
            e.openUrl(url);
            update({ message: `Enter this code on the GitHub page${copied ? " (it's on your clipboard)" : ""}, then approve the GitHub CLI:`, code, link: url });
        },
        CONSOLE_MS,
    );
    if (login.timedOut) throw new SetupError(`GitHub waited 15 minutes for the code, so ${APP_NAME} stopped the sign-in. Try again.`);
    update({ message: "Checking the sign-in…", code: undefined, link: undefined });
    const after = await e.ghAccount(gh).catch(() => null);
    if (after?.login) return { message: `Signed in to GitHub as ${after.login}.` };
    if (after?.signedIn) throw new SetupError(`Signed in, but GitHub didn't answer the GitHub CLI: ${after.error || "no reason given"}. Check the network or proxy, then try again.`);
    if (login.code !== 0) throw new SetupError(`The GitHub sign-in stopped: ${lastLine(login.stderr || login.stdout)}`);
    throw new SetupError("Still not signed in to GitHub. Try again, and approve the GitHub CLI on the page that opens.");
}

async function agencyInstall(e: SetupEnv, update: Update): Promise<Outcome> {
    if (e.agencyPath()) {
        const restart = await e.restartForAgency();
        return { message: restart ? `Agency is installed. Restart ${APP_NAME} to switch Copilot to it.` : "Agency is already installed.", restart };
    }
    const { file, args } = e.agencyInstaller();
    update({ progress: null, message: "Installing Agency. This takes a minute or two." });
    const r = await e.run(file, args, { timeoutMs: AGENCY_MS, onLine: (line) => update({ message: line.slice(0, 160) }) });
    if (!e.agencyPath()) {
        if (r.timedOut) throw new Error(`The Agency installer ran more than ${AGENCY_MS / 60_000} minutes and was stopped.`);
        throw new Error(`Agency didn't install: ${lastLine(r.stderr || r.stdout)}`);
    }
    const restart = await e.restartForAgency();
    return { message: restart ? `Agency installed. Restart ${APP_NAME} to switch Copilot to it.` : "Agency installed.", restart };
}

async function devisSource(e: SetupEnv, update: Update, input: { folder?: unknown }): Promise<Outcome> {
    const folder = typeof input.folder === "string" ? input.folder.trim().replace(/^"|"$/g, "").replace(/[\\/]+$/, "") : "";
    if (!folder || !isAbsolute(folder)) throw new SetupError("Choose a folder by its full path.");
    await mkdir(folder, { recursive: true });
    const target = join(folder, "devis");
    const fresh = !existsSync(target);
    const empty = fresh || readdirSync(target).length === 0;
    if (!empty && !existsSync(join(target, ".git"))) throw new SetupError(`${target} already exists and isn't a clone of the source. Pick another folder.`);
    if (empty) {
        update({ progress: null, message: `Getting the source from ${RELEASES_REPO}…` });
        const gh = e.gh();
        const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
        const r = gh
            ? await e.run(gh, ["repo", "clone", RELEASES_REPO, target], { timeoutMs: CLONE_MS, env: gitEnv })
            : await e.run(e.git(), ["clone", `https://github.com/${RELEASES_REPO}.git`, target], { timeoutMs: CLONE_MS, env: gitEnv });
        if (r.code !== 0) {
            if (fresh) await rm(target, { recursive: true, force: true }).catch(() => undefined);
            throw new Error(`Couldn't get the source: ${lastLine(r.stderr || r.stdout)}`);
        }
    }
    if (!existsSync(join(target, "package.json"))) {
        if (fresh) await rm(target, { recursive: true, force: true }).catch(() => undefined);
        throw new SetupError(`There's no source in ${RELEASES_REPO} yet. It's published with the first release.`);
    }
    const nodeVersion = await e.run(e.node(), ["--version"], { timeoutMs: 30_000 });
    const major = Number(/v?(\d+)\./.exec(nodeVersion.stdout)?.[1] || 0);
    if (nodeVersion.code !== 0 || major < MIN_NODE) {
        throw new SetupError(`Building ${APP_NAME} needs Node.js ${MIN_NODE} or newer${major ? ` (this machine has ${nodeVersion.stdout.trim()})` : ""}. Install it, then try again.`);
    }
    update({ progress: null, message: "Installing its packages (npm ci). This takes a few minutes." });
    const npm = await e.run(e.npm(), ["ci", "--no-audit", "--no-fund"], { cwd: target, timeoutMs: NPM_MS, onLine: (line) => update({ message: line.slice(0, 160) }) });
    if (npm.code !== 0) throw new Error(npm.timedOut ? "npm ci ran more than 20 minutes and was stopped." : `npm ci failed: ${lastLine(npm.stderr || npm.stdout)}`);
    await e.saveSource(target);
    return { message: `The source is in ${target}. Turn on changing ${APP_NAME} and ${LEAD_NAME} works from there.`, path: target };
}

const RUNNERS: Record<SetupActionId, (e: SetupEnv, update: Update, input: { folder?: unknown }) => Promise<Outcome>> = {
    "azure-install": azureInstall,
    "azure-signin": azureSignIn,
    "copilot-signin": copilotSignIn,
    "github-signin": githubSignIn,
    "agency-install": agencyInstall,
    "devis-source": devisSource,
};

const LABELS: Record<SetupActionId, string> = {
    "azure-install": "installing the Azure CLI",
    "azure-signin": "signing in to Azure",
    "copilot-signin": "signing in to Copilot",
    "github-signin": "signing in to GitHub",
    "agency-install": "installing Agency",
    "devis-source": `getting ${APP_NAME}' source`,
};

// ---- jobs ---------------------------------------------------------------------------------

const latest = new Map<SetupActionId, SetupJob>();
let seq = 0;

export const isSetupAction = (action: string): action is SetupActionId => (SETUP_ACTIONS as readonly string[]).includes(action);

/** Start `action`, or join the one already running. */
export function startSetupAction(action: string, input: { folder?: unknown } = {}): SetupJob {
    if (!isSetupAction(action)) throw new SetupError(`There's no setup action called ${action}.`, 404);
    const running = latest.get(action);
    if (running?.state === "running") return running;
    const job: SetupJob = { id: `${action}-${Date.now().toString(36)}-${++seq}`, action, state: "running", progress: null, message: "Starting…", startedAt: new Date().toISOString() };
    latest.set(action, job);
    const update: Update = (patch) => {
        if (job.state !== "running") return;
        if ("progress" in patch) job.progress = patch.progress === null || patch.progress === undefined ? null : Math.max(0, Math.min(1, patch.progress));
        if (patch.message) job.message = patch.message;
        if ("code" in patch) job.code = patch.code;
        if ("link" in patch) job.link = patch.link;
    };
    void machine()
        .then((e) => RUNNERS[action](e, update, input))
        .then(
            (outcome) => {
                delete job.code;
                delete job.link;
                Object.assign(job, { state: "done", progress: 1, message: outcome.message, endedAt: new Date().toISOString() });
                if (outcome.restart) job.restart = true;
                if (outcome.path) job.path = outcome.path;
                console.log(`[setup] ${LABELS[action]}: ${outcome.message}`);
            },
            (error: Error) => {
                delete job.code;
                delete job.link;
                Object.assign(job, { state: "failed", message: error?.message || String(error), endedAt: new Date().toISOString() });
                console.warn(`[setup] ${LABELS[action]} failed: ${job.message}`);
            },
        );
    return job;
}

/** The latest job for each action that has run in this service. */
export function setupJobs(): SetupJob[] {
    return [...latest.values()];
}

/** Installs and sign-ins in flight keep the service up. */
export function setupActivity(): WorkItem[] {
    return [...latest.values()].filter((j) => j.state === "running").map((j) => ({ kind: "other" as const, label: `Setup: ${LABELS[j.action]}` }));
}
