// The single client-side state singleton plus review-result loading and the
// encapsulated background-review poll timer.
import { getJSON } from "./api.js";
import type { AppState, Review } from "./types.js";

export const state: AppState = {
  config: { organizations: [], projects: {} },
  prs: [],
  org: "all",
  project: "all",
  assignment: "mine",
  reviews: {},
};

// Fetch the map of stored review results (pr_id -> {status, summary, updated_at}).
export async function loadReviews(): Promise<void> {
  try {
    const res = await getJSON("/api/review-results");
    const map: Record<string, Review> = {};
    for (const r of res.reviews || []) map[r.pr_id] = r;
    state.reviews = map;
  } catch {
    /* non-fatal: badges just won't show */
  }
}

// Single in-flight poll for a running review; cleared on navigation.
let reviewPollTimer: ReturnType<typeof setTimeout> | null = null;

export function stopReviewPoll(): void {
  if (reviewPollTimer) {
    clearTimeout(reviewPollTimer);
    reviewPollTimer = null;
  }
}

/** Replace any in-flight poll with a fresh one (used by the review panel). */
export function scheduleReviewPoll(fn: () => void, ms: number): void {
  stopReviewPoll();
  reviewPollTimer = setTimeout(fn, ms);
}
