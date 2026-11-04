// The single client-side state singleton plus review-result loading and the
// encapsulated background-review poll timer.
import { getJSON } from "./api.js";
import { activeJobKey, reviewRowKey, reviewStateKey } from "./reviewKey.js";
import type { ActiveReviewJob, AppState, QueueView, Review } from "./types.js";

/** Storage key for the queue view, so the app reopens on the view you left. */
export const QUEUE_VIEW_KEY = "adoPrOps.queueView";

function savedQueueView(): QueueView {
  try {
    return localStorage.getItem(QUEUE_VIEW_KEY) === "all" ? "all" : "feed";
  } catch {
    return "feed";
  }
}

export const state: AppState = {
  config: { organizations: [], projects: {}, reviewModel: "", reviewsDir: "", codebase: [], taskRoot: "" },
  prs: [],
  authoredPrs: [],
  cappedProjects: [],
  olderPrs: [],
  org: "all",
  project: "all",
  queueView: savedQueueView(),
  query: "",
  reviews: {},
  activeReviewJobs: {},
};

// Fetch stored review results keyed by organization, project, repository, and PR.
export async function loadReviews(): Promise<void> {
  try {
    const res = await getJSON("/api/review-results");
    const map: Record<string, Review> = {};
    for (const r of res.reviews || []) {
      map[reviewRowKey(r)] = r;
      if (r.pr_id && r.org && r.project && r.repo) {
        for (const pr of state.prs) {
          if (
            String(pr.id) === String(r.pr_id) &&
            pr.org === r.org &&
            pr.project === r.project &&
            pr.repo === r.repo
          ) {
            map[reviewStateKey(pr)] = r;
          }
        }
      }
    }
    state.reviews = map;
    const active: Record<string, ActiveReviewJob> = {};
    for (const job of res.activeJobs || []) active[activeJobKey(job)] = job;
    state.activeReviewJobs = active;
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
