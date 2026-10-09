// Shared presentation helpers for PR lifecycle status and reviewer votes.
// These return plain data (label / css class / icon) — callers build the DOM
// and are responsible for escaping any user-supplied text (e.g. reviewer names).

import type { Reviewer } from "./types.js";
import type { IconName } from "./icons.js";

/** The effective lifecycle label for a PR. Draft wins over the raw status. */
export function statusBadge(p: { status?: string; isDraft?: boolean }): {
  label: string;
  cls: string;
} {
  if (p.isDraft) return { label: "Draft", cls: "st-draft" };
  switch (p.status) {
    case "completed":
      return { label: "Completed", cls: "st-completed" };
    case "abandoned":
      return { label: "Abandoned", cls: "st-abandoned" };
    case "active":
      return { label: "Published", cls: "st-published" };
    default:
      return { label: p.status || "Unknown", cls: "st-unknown" };
  }
}

/** Icon + label + css class for a single reviewer vote value. */
export function voteBadge(vote: number): { icon: IconName; label: string; cls: string } {
  if (vote >= 10) return { icon: "check", label: "Approved", cls: "vote-approved" };
  if (vote === 5) return { icon: "check", label: "Approved with suggestions", cls: "vote-approved" };
  if (vote <= -10) return { icon: "dismiss", label: "Rejected", cls: "vote-rejected" };
  if (vote <= -5) return { icon: "clock", label: "Waiting for author", cls: "vote-waiting" };
  return { icon: "circle", label: "No vote", cls: "vote-none" };
}

/** The current user's own action chip, or null when they haven't voted/commented. */
export function myActionBadge(
  myVote: number,
  iCommented?: boolean,
): { icon: IconName; label: string; cls: string } | null {
  if (myVote >= 5) return { icon: "check", label: "You approved", cls: "vote-approved" };
  if (myVote <= -10) return { icon: "dismiss", label: "You rejected", cls: "vote-rejected" };
  if (myVote <= -5) return { icon: "clock", label: "You're waiting", cls: "vote-waiting" };
  if (iCommented) return { icon: "chat", label: "You commented", cls: "vote-commented" };
  return null;
}

/** Compact counts of individual reviewers by outcome (groups excluded). */
export function reviewerTally(reviewers: Reviewer[]): {
  approved: number;
  rejected: number;
  waiting: number;
} {
  let approved = 0;
  let rejected = 0;
  let waiting = 0;
  for (const r of reviewers) {
    if (r.isContainer) continue;
    if (r.vote >= 5) approved++;
    else if (r.vote <= -10) rejected++;
    else if (r.vote <= -5) waiting++;
  }
  return { approved, rejected, waiting };
}
