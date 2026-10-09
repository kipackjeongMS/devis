// Pure layout rules for the desktop shell — no DOM, so harnesses can import them.
import type { Assignment } from "./types.js";

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

/** Heading for the queue below My Plate, named after the assignment filter. */
export function queueTitle(assignment: Assignment): string {
  if (assignment === "mine") return "Assigned to me";
  if (assignment === "notmine") return "Assigned to others";
  return "All pull requests";
}
