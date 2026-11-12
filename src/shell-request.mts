// What the page asks of the desktop shell. The page is sandboxed with no bridge, so it asks by
// opening `/?shell-request=<what>` on the service's own origin; the shell's window-open handler
// (main.mts) catches that, does it, and never opens anything. Kept free of Electron so it can be tested.

export type ShellRequest = { kind: "pick-folder"; id: string } | { kind: "login-item" };

/** The page's own random tag for one folder pick, echoed back with the answer. */
const PICK_ID = /^[a-z0-9]{1,32}$/i;

export function shellRequest(url: string, origin: string): ShellRequest | null {
    if (!origin) return null;
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.origin !== origin || parsed.pathname !== "/") return null;
    const what = parsed.searchParams.get("shell-request");
    if (what === "login-item") return { kind: "login-item" };
    if (what === "pick-folder") {
        const id = parsed.searchParams.get("id") || "";
        return PICK_ID.test(id) ? { kind: "pick-folder", id } : null;
    }
    return null;
}

/** The script that hands a picked folder (or null, cancelled) back to the page that asked. */
export function folderPickedScript(id: string, path: string | null): string {
    return `window.dispatchEvent(new CustomEvent("devis:folder-picked", { detail: ${JSON.stringify({ id, path })} }))`;
}

export interface LoginItem {
    openAtLogin: boolean;
    path: string;
    args: string[];
}

/**
 * How Windows starts Devis at sign-in: the installed app with `--background`, which starts the
 * service and no window. Null where it doesn't apply: off Windows, a copy run from source (its
 * folder can go away), or a second data folder (a test run), which must not touch the user's own.
 */
export function loginItem(want: boolean, env: { platform: string; packaged: boolean; execPath: string; userDataOverride?: string }): LoginItem | null {
    if (env.platform !== "win32" || !env.packaged || env.userDataOverride) return null;
    return { openAtLogin: want, path: env.execPath, args: ["--background"] };
}
