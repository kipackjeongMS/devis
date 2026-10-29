// The code window's pure parts: which window.open URLs open one, and where it goes on screen.
// main.mts does the Electron side; scripts/code-window-harness.mjs tests these directly.

/** Worker session ids are UUIDs (randomUUID in jarvis-workers.mts). */
export const WORKER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CODE_WINDOW_MIN = { width: 480, height: 360 } as const;
/** How far a second code window steps down and right so it doesn't sit exactly on the first. */
export const CASCADE_STEP = 28;

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface SavedPlacement extends Rect {
    maximized?: boolean;
}

/** The worker a window.open URL asks for, or null when it isn't the code window on the service's own origin. */
export function codeWindowWorker(url: string, origin: string): string | null {
    if (!origin) return null;
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.origin !== origin || parsed.pathname !== "/code.html") return null;
    const worker = parsed.searchParams.get("worker") || "";
    return WORKER_ID.test(worker) ? worker : null;
}

/** Built fresh from the id, never from the page's URL, so nothing else rides along. `hash` keeps the open file across reloads. */
export function codeWindowUrl(origin: string, worker: string, hash = ""): string {
    const keep = hash.startsWith("#") && hash.length > 1 ? hash : "";
    return `${origin}/code.html?worker=${encodeURIComponent(worker)}${keep}`;
}

/** Saved bounds read back from disk, or null when they're missing or malformed. */
export function parsePlacement(value: unknown): SavedPlacement | null {
    if (!value || typeof value !== "object") return null;
    const v = value as Record<string, unknown>;
    const nums = [v.x, v.y, v.width, v.height];
    if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    if ((v.width as number) <= 0 || (v.height as number) <= 0) return null;
    return {
        x: Math.round(v.x as number),
        y: Math.round(v.y as number),
        width: Math.round(v.width as number),
        height: Math.round(v.height as number),
        maximized: v.maximized === true,
    };
}

function overlapArea(a: Rect, b: Rect): number {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
}

function clampSize(width: number, height: number, area: Rect): { width: number; height: number } {
    return {
        width: Math.max(Math.min(CODE_WINDOW_MIN.width, area.width), Math.min(width, area.width)),
        height: Math.max(Math.min(CODE_WINDOW_MIN.height, area.height), Math.min(height, area.height)),
    };
}

function keepInside(bounds: Rect, area: Rect): Rect {
    return {
        ...bounds,
        x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - bounds.width),
        y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - bounds.height),
    };
}

/**
 * Where a new code window opens.
 * - Saved bounds mostly (half or more) on a display: there, sized to fit that display.
 * - Saved bounds off screen (a monitor went away): that size, centered on the main window's display.
 * - Nothing saved: the main window's whole work area, the full-width view the window is for.
 * Then it steps down and right past any open code window at the same spot.
 *
 * @param savedArea work area of the display that best matches the saved bounds
 * @param mainArea  work area of the display the main window is on
 * @param open      bounds of the code windows already open
 */
export function placeCodeWindow(
    saved: SavedPlacement | null,
    savedArea: Rect | null,
    mainArea: Rect,
    open: Rect[] = [],
): { bounds: Rect; maximized: boolean; area: Rect } {
    let area = mainArea;
    let bounds: Rect;
    if (saved && savedArea && overlapArea(saved, savedArea) * 2 >= saved.width * saved.height) {
        area = savedArea;
        bounds = keepInside({ x: saved.x, y: saved.y, ...clampSize(saved.width, saved.height, area) }, area);
    } else if (saved) {
        const size = clampSize(saved.width, saved.height, area);
        bounds = {
            x: area.x + Math.round((area.width - size.width) / 2),
            y: area.y + Math.round((area.height - size.height) / 2),
            ...size,
        };
    } else {
        bounds = { ...area };
    }
    for (let step = 0; step < 12 && open.some((o) => o.x === bounds.x && o.y === bounds.y); step++) {
        const x = bounds.x + CASCADE_STEP;
        const y = bounds.y + CASCADE_STEP;
        const width = Math.min(bounds.width, area.x + area.width - x);
        const height = Math.min(bounds.height, area.y + area.height - y);
        if (width < CODE_WINDOW_MIN.width || height < CODE_WINDOW_MIN.height) break;
        bounds = { x, y, width, height };
    }
    return { bounds, maximized: !!saved?.maximized, area };
}
