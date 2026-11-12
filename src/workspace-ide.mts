import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { JarvisError } from "./jarvis-store.mjs";

const IDES = {
    vscode: { label: "VSCode", folder: "Microsoft VS Code", exe: "Code.exe" },
    "vscode-insiders": { label: "VSCode Insiders", folder: "Microsoft VS Code Insiders", exe: "Code - Insiders.exe" },
} as const;

export type WorkspaceIde = keyof typeof IDES;

/** Where the editor is installed, or null. */
export function findIde(ide: WorkspaceIde): string | null {
    const { folder, exe } = IDES[ide];
    const candidates: string[] = [];
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "Programs", folder, exe));
    for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
        if (root) candidates.push(join(root, folder, exe));
    }
    for (const entry of (process.env.PATH || "").split(delimiter)) {
        const dir = entry.trim().replace(/^"(.*)"$/, "$1");
        if (!isAbsolute(dir)) continue;
        candidates.push(join(dir, exe));
        // VS Code's CLI is usually on PATH through its installation's bin folder.
        if (basename(dir).toLowerCase() === "bin") candidates.push(join(dirname(dir), exe));
    }
    return candidates.find((path) => statSync(path, { throwIfNoEntry: false })?.isFile()) ?? null;
}

/** The editors on this machine, by name. */
export function installedIdes(): string[] {
    return (Object.keys(IDES) as WorkspaceIde[]).filter((ide) => findIde(ide)).map((ide) => IDES[ide].label);
}

function executable(ide: WorkspaceIde): string {
    const found = findIde(ide);
    if (!found) throw new JarvisError(`${IDES[ide].label} was not found. Install it in its standard location or add its installation or bin folder to PATH, then restart the app.`, 409);
    return found;
}

/** Open the folder itself, including all of this worker's repository worktrees. */
export async function openWorkspaceIde(cwd: string, ideValue: unknown): Promise<void> {
    if (ideValue !== "vscode" && ideValue !== "vscode-insiders") throw new JarvisError("Choose VSCode or VSCode Insiders.");
    if (process.platform !== "win32") throw new JarvisError("Opening a worker's IDE is supported on Windows.", 409);
    if (!isAbsolute(cwd) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
        throw new JarvisError(`Worker folder no longer exists: ${cwd}`, 409);
    }
    const command = executable(ideValue);
    const { label } = IDES[ideValue];
    // The service is Electron in Node mode; the editor must start as a desktop app.
    const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !["ELECTRON_RUN_AS_NODE", "VSCODE_IPC_HOOK_CLI"].includes(key.toUpperCase())),
    );
    await new Promise<void>((resolve, reject) => {
        const child = spawn(command, ["--new-window", cwd], { cwd, detached: true, stdio: "ignore", env });
        child.once("error", (error) => reject(new JarvisError(`Could not open ${label}: ${error.message}`, 500)));
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
    });
}
