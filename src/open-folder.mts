import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import { JarvisError } from "./jarvis-store.mjs";

/** Open a folder in File Explorer. Callers pass a path the service derived, never one from the page. */
export async function openFolder(dir: string): Promise<void> {
    if (process.platform !== "win32") throw new JarvisError("Opening a folder is supported on Windows.", 409);
    if (!isAbsolute(dir)) throw new JarvisError("That folder path isn't absolute.", 400);
    mkdirSync(dir, { recursive: true });
    await explorer([dir], false);
}

/**
 * Open File Explorer on a file's folder with the file selected. The file itself is never opened, so
 * a worker's script or program can't run from here. Callers pass a path the service derived.
 */
export async function revealFile(path: string): Promise<void> {
    if (process.platform !== "win32") throw new JarvisError("Showing a file in its folder is supported on Windows.", 409);
    if (!isAbsolute(path) || path.includes('"')) throw new JarvisError("That file path isn't absolute.", 400);
    // Explorer reads `/select,"<path>"` as one argument; Node's own quoting would wrap the comma too.
    await explorer([`/select,"${path}"`], true);
}

function explorer(args: string[], verbatim: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const child = spawn("explorer.exe", args, { detached: true, stdio: "ignore", windowsHide: false, windowsVerbatimArguments: verbatim });
        child.once("error", (error) => reject(new JarvisError(`Could not open File Explorer: ${error.message}`, 500)));
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
    });
}
