// Pure layout rules for the desktop shell — no DOM, so harnesses can import them.

/** At and above this window width the queue and the reading pane sit side by side. */
export const SPLIT_MIN_WIDTH = 1100;

export function isSplitLayout(width: number): boolean {
  return width >= SPLIT_MIN_WIDTH;
}

/**
 * Index of the section the reader is in: the last one whose top has reached the
 * sticky head (`offset` px below the scroller's top). At the end of the scroll
 * the last section wins, even when it is too short to reach the head.
 */
export function activeSectionIndex(tops: number[], scrollTop: number, offset: number, atEnd: boolean): number {
  if (!tops.length) return -1;
  if (atEnd) return tops.length - 1;
  let active = 0;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] - offset <= scrollTop) active = i;
  }
  return active;
}

/** Reading-pane zoom steps for Ctrl +/−, matching the browser's ladder from 50% to 200%. */
export const PANE_ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

/** The next zoom step from `current`, clamped at both ends. */
export function stepPaneZoom(current: number, direction: 1 | -1): number {
  const levels = PANE_ZOOM_LEVELS;
  if (direction > 0) return levels.find((level) => level > current + 1e-3) ?? levels[levels.length - 1];
  return [...levels].reverse().find((level) => level < current - 1e-3) ?? levels[0];
}

export type PaneZoomCommand = "in" | "out" | "reset";

/** Ctrl/⌘ with + or =, − or _, or 0. Alt chords are AltGr characters, so they pass through. */
export function paneZoomCommand(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): PaneZoomCommand | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.key === "+" || e.key === "=") return "in";
  if (e.key === "-" || e.key === "_") return "out";
  if (e.key === "0") return "reset";
  return null;
}

/** A saved zoom level, or 100% when it's missing or not one of the steps. */
export function zoomLevelOf(saved: string | null | undefined): number {
  const level = Number(saved);
  return PANE_ZOOM_LEVELS.find((l) => Math.abs(l - level) < 1e-3) ?? 1;
}

/** The level after a zoom command. */
export function nextZoom(current: number, command: PaneZoomCommand): number {
  return command === "reset" ? 1 : stepPaneZoom(current, command === "in" ? 1 : -1);
}
