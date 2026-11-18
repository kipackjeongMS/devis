import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import { JarvisError } from "./jarvis-store.mjs";

/** Open a folder in File Explorer. Callers pass a path the service derived, never one from the page. */
export async function openFolder(dir: string): Promise<void> {
    if (process.platform !== "win32") throw new JarvisError("Opening a folder is supported on Windows.", 409);
    if (!isAbsolute(dir)) throw new JarvisError("That folder path isn't absolute.", 400);
    mkdirSync(dir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
        const child = spawn("explorer.exe", [dir], { detached: true, stdio: "ignore", windowsHide: false });
        child.once("error", (error) => reject(new JarvisError(`Could not open File Explorer: ${error.message}`, 500)));
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
    });
}
