// The pull request window's pure parts: which window.open URLs ask for it, the URL the shell builds,
// and the controller that keeps it to ONE window. Opening PR B while PR A is up re-targets the same
// window (the latest open wins); closing it lets the next open create a new one.
// main.mts does the Electron side; scripts/pr-window-harness.mjs tests these directly.
import { parsePrCanvasTarget, type PrCanvasTarget } from "./canvas-target.mjs";

export const PR_WINDOW_MIN = { width: 720, height: 520 } as const;
export const PR_WINDOW_SIZE = { width: 1180, height: 860 } as const;

export type PrWindowTarget = PrCanvasTarget;

/** The PR a window.open URL asks for, or null when it isn't the PR page (`/?org&project&repoId&prId`) on the service's own origin. */
export function prWindowTarget(url: string, origin: string): PrWindowTarget | null {
    if (!origin) return null;
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.origin !== origin || parsed.pathname !== "/" || parsed.searchParams.get("focus") === "main") return null;
    try {
        return parsePrCanvasTarget(Object.fromEntries(["org", "project", "repoId", "prId"].map((k) => [k, parsed.searchParams.get(k)])));
    } catch {
        return null;
    }
}

/** Built fresh from the target, never from the page's URL, so nothing else rides along. */
export function prWindowUrl(origin: string, target: PrWindowTarget): string {
    const query = new URLSearchParams({ org: target.org, project: target.project, repoId: target.repoId, prId: target.prId });
    return `${origin}/?${query.toString()}`;
}

export const sameTarget = (a: PrWindowTarget | null, b: PrWindowTarget | null): boolean =>
    !!a && !!b && a.org === b.org && a.project === b.project && a.repoId === b.repoId && a.prId === b.prId;

/** What the controller needs of a window; main.mts adapts a BrowserWindow to it. */
export interface PrWindowHandle {
    isDestroyed(): boolean;
    /** Bring it forward: restore it when minimized, then focus it. */
    reveal(): void;
    /** Show this URL. `current` turns false once a later open replaced it, so a slow load can drop itself. */
    load(url: string, current: () => boolean): Promise<void>;
}

export interface PrWindowController {
    open(target: PrWindowTarget): "created" | "focused" | "navigated";
    /** The window's own "closed" event: the next open creates a new one. */
    closed(handle: PrWindowHandle): void;
    /** The service moved to another port: reload what's showing there. */
    moveTo(origin: string): void;
    readonly target: PrWindowTarget | null;
    readonly alive: boolean;
}

/**
 * One reusable PR window.
 * - First open: `create` makes it (it loads nothing; the controller does).
 * - Same PR again: it comes forward and is left alone.
 * - Another PR: it comes forward and loads that PR; a load still running for the one before drops itself.
 */
export function createPrWindowController(options: {
    origin: () => string;
    create: () => PrWindowHandle;
}): PrWindowController {
    let handle: PrWindowHandle | null = null;
    let showing: PrWindowTarget | null = null;
    let generation = 0;

    const alive = (): boolean => !!handle && !handle.isDestroyed();
    const show = (target: PrWindowTarget, origin: string): void => {
        const mine = ++generation;
        showing = target;
        const win = handle!;
        // A load that rejects or loses the race leaves the window on a later PR, never an error page for this one.
        void win.load(prWindowUrl(origin, target), () => mine === generation && handle === win).catch(() => undefined);
    };

    return {
        open(target) {
            if (alive() && handle) {
                handle.reveal();
                if (sameTarget(showing, target)) return "focused";
                show(target, options.origin());
                return "navigated";
            }
            handle = options.create();
            show(target, options.origin());
            return "created";
        },
        closed(closing) {
            if (handle !== closing) return;
            handle = null;
            showing = null;
            generation++;
        },
        moveTo(origin) {
            if (alive() && showing) show(showing, origin);
        },
        get target() {
            return showing;
        },
        get alive() {
            return alive();
        },
    };
}
