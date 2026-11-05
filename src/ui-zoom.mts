// One size for the whole interface. Ctrl +/−/0 step every window through the browser's
// zoom ladder (50% to 200%), and the level is saved so the app opens at it. Today's
// look is 100%. These are the pure rules; main.mts applies them, and
// scripts/ui-zoom-harness.mjs tests them.

export const UI_ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

export type ZoomCommand = "in" | "out" | "reset";

/** The parts of Electron's before-input-event `Input` the keys need. */
export interface KeyInput {
    type: string;
    key: string;
    control: boolean;
    meta: boolean;
    alt: boolean;
}

/** Ctrl/⌘ with + or =, − or _, or 0 (the number pad gives the same keys). Alt chords are AltGr characters, so they pass through. */
export function zoomCommand(input: KeyInput): ZoomCommand | null {
    if (input.type !== "keyDown" || !(input.control || input.meta) || input.alt) return null;
    if (input.key === "+" || input.key === "=") return "in";
    if (input.key === "-" || input.key === "_") return "out";
    if (input.key === "0") return "reset";
    return null;
}

/** The next step from `current`, clamped at both ends; an off-ladder level snaps to its neighbour. */
export function nextZoom(current: number, command: ZoomCommand): number {
    if (command === "reset") return 1;
    if (command === "in") return UI_ZOOM_LEVELS.find((level) => level > current + 1e-3) ?? UI_ZOOM_LEVELS[UI_ZOOM_LEVELS.length - 1];
    return [...UI_ZOOM_LEVELS].reverse().find((level) => level < current - 1e-3) ?? UI_ZOOM_LEVELS[0];
}

/** A saved level, or 100% when it's missing or not one of the steps. */
export function zoomLevelOf(saved: unknown): number {
    const level = typeof saved === "number" ? saved : typeof saved === "string" && saved.trim() ? Number(saved) : NaN;
    return UI_ZOOM_LEVELS.find((l) => Math.abs(l - level) < 1e-3) ?? 1;
}

/** The page's title bar is 40px (--titlebar-h); the caption buttons' strip grows with it. */
export const TITLEBAR_HEIGHT = 40;

export function titleBarHeight(level: number): number {
    return Math.round(TITLEBAR_HEIGHT * level);
}
