// The programs Devis runs that come from outside it: Git and the Azure CLI.
//
// Git also ships inside Devis (MinGit, in resources\git next to the app). The service puts
// that one on PATH at start, so every git it runs, and every worker shell, gets it, but only
// when the machine has no Git or one older than 2.40; the machine's own Git wins otherwise.
//
// The Azure CLI is found on PATH, else where Devis' setup unpacks it
// (%LOCALAPPDATA%\Devis\azure-cli), else where its Windows installer puts it, for a service
// started before PATH picked that up.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME } from "./brand.mjs";

const appDir = dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === "win32";
const MIN_GIT = { major: 2, minor: 40 };

export interface GitInfo {
    /** The machine's Git, the one built into Devis, or none. */
    source: "system" | "bundled" | null;
    path: string | null;
    version: string | null;
    /** Why Devis doesn't use the machine's Git, when it has one. */
    note: string | null;
}

export interface AzureCliInfo {
    source: "path" | "devis" | "installer" | null;
    /** What to run: `az.cmd` from PATH, or the full path of the one found elsewhere. */
    command: string | null;
}

function run(command: string, args: string[]): string | null {
    const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 15_000 });
    return result.status === 0 ? result.stdout.trim() : null;
}

/** Every match for `name` on PATH, in PATH order. */
function onPath(name: string): string[] {
    const out = run(isWin ? "where.exe" : "which", [name]);
    return out ? out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
}

function gitVersion(exe: string): string | null {
    return /git version (\d+\.\d+\.\d+)/.exec(run(exe, ["--version"]) || "")?.[1] ?? null;
}

function recentEnough(version: string): boolean {
    const [major, minor] = version.split(".").map(Number);
    return major > MIN_GIT.major || (major === MIN_GIT.major && minor >= MIN_GIT.minor);
}

/** The MinGit folder that ships with Devis, or null (a dev build from source has none). */
export function bundledGitDir(): string | null {
    const dir = process.env.ADO_PR_OPS_BUNDLED_GIT?.trim() || join(appDir, "..", "git");
    return existsSync(join(dir, "cmd", "git.exe")) ? dir : null;
}

let git: GitInfo | null = null;

/** Pick the Git everything runs, once per service: put Devis' own on PATH when the machine's won't do. */
export function prepareGit(): GitInfo {
    if (git) return git;
    const systemPath = onPath("git").find((p) => !isWin || /\.exe$/i.test(p)) ?? null;
    const systemVersion = systemPath ? gitVersion(systemPath) : null;
    if (systemPath && systemVersion && recentEnough(systemVersion)) {
        git = { source: "system", path: systemPath, version: systemVersion, note: null };
        return git;
    }
    const note = systemVersion
        ? `Git ${systemVersion} on this machine is older than ${MIN_GIT.major}.${MIN_GIT.minor}`
        : systemPath
          ? "the Git on this machine doesn't run"
          : null;
    const bundled = bundledGitDir();
    if (bundled) {
        const cmd = join(bundled, "cmd");
        process.env.PATH = [cmd, process.env.PATH].filter(Boolean).join(delimiter);
        const exe = join(cmd, "git.exe");
        git = { source: "bundled", path: exe, version: gitVersion(exe), note: note && `${note}, so ${APP_NAME} uses its own` };
        console.log(`[tools] git: the one built into ${APP_NAME} (${exe}${git.note ? `; ${git.note}` : ""})`);
        return git;
    }
    git = { source: systemPath ? "system" : null, path: systemPath, version: systemVersion, note };
    if (note || !systemPath) console.warn(`[tools] git: ${note || "not installed"}, and this build has none of its own`);
    return git;
}

/** Where Devis' setup unpacks the Azure CLI's ZIP package. */
export function devisAzureCliDir(): string {
    return join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || "", "AppData", "Local"), APP_NAME, "azure-cli");
}

let azureCli: AzureCliInfo | null = null;

/** The Azure CLI to run. Only a found one is remembered, so installing it later works without a restart. */
export function findAzureCli(): AzureCliInfo {
    if (azureCli) return azureCli;
    if (!isWin) {
        const found = onPath("az").length > 0;
        if (found) azureCli = { source: "path", command: "az" };
        return azureCli ?? { source: null, command: null };
    }
    if (onPath("az.cmd").length > 0) {
        azureCli = { source: "path", command: "az.cmd" };
        return azureCli;
    }
    const local = join(devisAzureCliDir(), "bin", "az.cmd");
    if (existsSync(local)) {
        azureCli = { source: "devis", command: local };
        return azureCli;
    }
    for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
        const msi = root && join(root, "Microsoft SDKs", "Azure", "CLI2", "wbin", "az.cmd");
        if (msi && existsSync(msi)) {
            azureCli = { source: "installer", command: msi };
            return azureCli;
        }
    }
    return { source: null, command: null };
}

/** The GitHub CLI, for updates and the source: on PATH, else where its installer puts it. Not remembered, so installing it later works. */
export function findGh(): string | null {
    if (!isWin) return onPath("gh")[0] ?? null;
    const found = onPath("gh.exe")[0];
    if (found) return found;
    for (const root of [process.env.ProgramFiles, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs")]) {
        const exe = root && join(root, "GitHub CLI", "gh.exe");
        if (exe && existsSync(exe)) return exe;
    }
    return null;
}
