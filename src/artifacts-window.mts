// The Artifacts window's pure parts: which window.open URLs ask for one, the URL the shell builds,
// where it goes on screen, and the controller that keeps it to ONE window per task. Opening a task's
// Artifacts again brings that task's window forward and points it at the file asked for (the page
// switches unless an edit is open); closing it lets the next open create a new one.
// main.mts does the Electron side; scripts/artifacts-window-harness.mjs tests these directly.
import { CASCADE_STEP, type Rect } from "./code-window.mjs";

export const ARTIFACTS_WINDOW_MIN = { width: 560, height: 400 } as const;
export const ARTIFACTS_WINDOW_SIZE = { width: 1080, height: 820 } as const;

/** Task ids are UUIDs, stored lower case (asJarvisId in jarvis-store.mts). */
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The same names jarvis-store.mts accepts (artifactName); the harness checks the two agree.
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,78}\.(?:md|markdown|txt|json|ya?ml|csv|log|mmd)$/i;
const RESERVED_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;

export interface ArtifactsWindowTarget {
    /** The task, lower case. */
    task: string;
    /** The file to show, or null for the window's own choice (the file it has open, or note.md). */
    file: string | null;
    /** Open the file in the editor (a note just made from the task's Artifacts tab). */
    edit: boolean;
}

export function isArtifactFileName(name: unknown): name is string {
    return typeof name === "string" && FILE_NAME.test(name) && !name.includes("..") && !RESERVED_NAME.test(name);
}

function taskOf(value: string | null): string | null {
    const id = (value || "").trim().toLowerCase();
    return TASK_ID.test(id) ? id : null;
}

/** The file part of a hash (`#file=design.md&edit=1`); anything else in it is dropped. */
export function parseArtifactsHash(hash: string): { file: string | null; edit: boolean } {
    const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
    const file = params.get("file");
    if (!isArtifactFileName(file)) return { file: null, edit: false };
    return { file, edit: params.get("edit") === "1" };
}

/** `#file=…` (and `&edit=1`), or "" without a file. */
export function artifactsWindowHash(target: { file: string | null; edit?: boolean }): string {
    if (!isArtifactFileName(target.file)) return "";
    const params = new URLSearchParams({ file: target.file });
    if (target.edit) params.set("edit", "1");
    return `#${params.toString()}`;
}

/** What a window.open URL asks for, or null when it isn't a task's Artifacts window on the service's own origin. */
export function artifactsWindowTarget(url: string, origin: string): ArtifactsWindowTarget | null {
    if (!origin) return null;
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.origin !== origin || parsed.pathname !== "/artifacts.html") return null;
    const task = taskOf(parsed.searchParams.get("task"));
    if (!task) return null;
    return { task, ...parseArtifactsHash(parsed.hash) };
}

/** Built fresh from the task and a checked hash, never from the page's URL, so nothing else rides along. */
export function artifactsWindowUrl(origin: string, task: string, hash = ""): string {
    return `${origin}/artifacts.html?task=${encodeURIComponent(task)}${artifactsWindowHash(parseArtifactsHash(hash))}`;
}

/**
 * Where a new Artifacts window opens: its default size (smaller on a small screen), centred on the main
 * window's display, then stepped down and right past any Artifacts window already at that spot.
 */
export function placeArtifactsWindow(area: Rect, open: Rect[] = []): Rect {
    const width = Math.min(ARTIFACTS_WINDOW_SIZE.width, area.width);
    const height = Math.min(ARTIFACTS_WINDOW_SIZE.height, area.height);
    let bounds: Rect = {
        x: area.x + Math.round((area.width - width) / 2),
        y: area.y + Math.round((area.height - height) / 2),
        width,
        height,
    };
    for (let step = 0; step < 12 && open.some((o) => o.x === bounds.x && o.y === bounds.y); step++) {
        const x = bounds.x + CASCADE_STEP;
        const y = bounds.y + CASCADE_STEP;
        if (x + width > area.x + area.width || y + height > area.y + area.height) break;
        bounds = { x, y, width, height };
    }
    return bounds;
}

/** What the controller needs of a window; main.mts adapts a BrowserWindow to it. */
export interface ArtifactsWindowHandle {
    isDestroyed(): boolean;
    /** Bring it forward: restore it when minimized, then focus it. */
    reveal(): void;
    /** Show this URL. `current` turns false once the window closed or moved on, so a slow load can drop itself. */
    load(url: string, current: () => boolean): Promise<void>;
    /** Point the page that's up at a file: set its hash (`#file=…`). The page switches unless an edit is open. */
    select(hash: string): void;
    /** The page's hash now (the file it has open), kept when the service moves. */
    hash(): string;
}

export interface ArtifactsWindowController {
    open(target: ArtifactsWindowTarget): "created" | "focused";
    /** A window's own "closed" event: the next open for its task creates a new one. */
    closed(task: string, handle: ArtifactsWindowHandle): void;
    /** The service moved to another port: reload every window there, on the file each has open. */
    moveTo(origin: string): void;
    isOpen(task: string): boolean;
    /** How many are up. */
    readonly count: number;
}

/**
 * One Artifacts window per task.
 * - First open for a task: `create` makes it (it loads nothing; the controller does), on the file asked for.
 * - Open again while it's up: it comes forward; with a file, the page is pointed at it, keeping anything else.
 */
export function createArtifactsWindowController(options: {
    origin: () => string;
    create: (task: string) => ArtifactsWindowHandle;
}): ArtifactsWindowController {
    interface Entry {
        handle: ArtifactsWindowHandle;
        generation: number;
    }
    const windows = new Map<string, Entry>();

    const live = (task: string): Entry | null => {
        const entry = windows.get(task);
        return entry && !entry.handle.isDestroyed() ? entry : null;
    };
    const show = (task: string, entry: Entry, origin: string, hash: string): void => {
        const mine = ++entry.generation;
        const current = () => windows.get(task) === entry && entry.generation === mine && !entry.handle.isDestroyed();
        void entry.handle.load(artifactsWindowUrl(origin, task, hash), current).catch(() => undefined);
    };

    return {
        open(target) {
            const entry = live(target.task);
            const hash = artifactsWindowHash(target);
            if (entry) {
                entry.handle.reveal();
                if (hash) entry.handle.select(hash);
                return "focused";
            }
            const created: Entry = { handle: options.create(target.task), generation: 0 };
            windows.set(target.task, created);
            show(target.task, created, options.origin(), hash);
            return "created";
        },
        closed(task, handle) {
            const entry = windows.get(task);
            if (!entry || entry.handle !== handle) return;
            windows.delete(task);
            entry.generation++;
        },
        moveTo(origin) {
            for (const [task, entry] of windows) {
                if (!entry.handle.isDestroyed()) show(task, entry, origin, entry.handle.hash());
            }
        },
        isOpen(task) {
            return !!live(task);
        },
        get count() {
            return [...windows.keys()].filter((task) => live(task)).length;
        },
    };
}
