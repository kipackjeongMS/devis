// The to-dos window's pure parts: which window.open URLs ask for it, the URL the shell builds, and
// the controller that keeps it to ONE window. Opening it again brings that window forward; closing
// it lets the next open create a new one. It's a window of its own, never the code or PR window.
// main.mts does the Electron side; scripts/todos-window-harness.mjs tests these directly.

export const TODOS_WINDOW_MIN = { width: 460, height: 420 } as const;
export const TODOS_WINDOW_SIZE = { width: 760, height: 860 } as const;

/** Whether a window.open URL asks for the to-dos window (`/todos.html` on the service's own origin). */
export function isTodosWindowUrl(url: string, origin: string): boolean {
    if (!origin) return false;
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    return parsed.origin === origin && parsed.pathname === "/todos.html";
}

/** Built fresh, never from the page's URL, so nothing else rides along. */
export function todosWindowUrl(origin: string): string {
    return `${origin}/todos.html`;
}

/** What the controller needs of a window; main.mts adapts a BrowserWindow to it. */
export interface TodosWindowHandle {
    isDestroyed(): boolean;
    /** Bring it forward: restore it when minimized, then focus it. */
    reveal(): void;
    /** Show this URL. `current` turns false once the window closed or moved on, so a slow load can drop itself. */
    load(url: string, current: () => boolean): Promise<void>;
}

export interface TodosWindowController {
    open(): "created" | "focused";
    /** The window's own "closed" event: the next open creates a new one. */
    closed(handle: TodosWindowHandle): void;
    /** The service moved to another port: reload the window there. */
    moveTo(origin: string): void;
    readonly alive: boolean;
}

/**
 * One to-dos window.
 * - First open: `create` makes it (it loads nothing; the controller does).
 * - Open again while it's up: it comes forward, and keeps whatever the user has in it.
 */
export function createTodosWindowController(options: { origin: () => string; create: () => TodosWindowHandle }): TodosWindowController {
    let handle: TodosWindowHandle | null = null;
    let generation = 0;

    const alive = (): boolean => !!handle && !handle.isDestroyed();
    const show = (origin: string): void => {
        const mine = ++generation;
        const win = handle!;
        void win.load(todosWindowUrl(origin), () => mine === generation && handle === win).catch(() => undefined);
    };

    return {
        open() {
            if (alive() && handle) {
                handle.reveal();
                return "focused";
            }
            handle = options.create();
            show(options.origin());
            return "created";
        },
        closed(closing) {
            if (handle !== closing) return;
            handle = null;
            generation++;
        },
        moveTo(origin) {
            if (alive()) show(origin);
        },
        get alive() {
            return alive();
        },
    };
}
