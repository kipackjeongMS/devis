// A PR's Copilot review phase: the live job wins over the saved review row.
import { state } from "./state.js";
import { reviewStateKey } from "./reviewKey.js";
import type { PR } from "./types.js";
import type { ReviewPhase } from "./queueModel.js";

export function reviewPhase(pr: PR): ReviewPhase {
  const key = reviewStateKey(pr);
  if (state.activeReviewJobs[key]) return "active";
  const status = state.reviews[key]?.status;
  if (status === "queued" || status === "running") return "active";
  if (status === "done") return "done";
  if (status === "error") return "error";
  return null;
}
