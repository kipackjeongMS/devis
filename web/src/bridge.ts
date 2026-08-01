// The Copilot bridge: turns a PR + its diffs + comments into a background-review
// prompt and sends it into the CLI session via POST /api/bridge.
//
// The prompt itself is built in ./reviewPrompt.ts (buildPrContext = dynamic PR
// data, buildReviewInstructions = review instructions). This file owns the
// orchestration: kick off the optimistic "running" badge/notify side-effects,
// stitch the two prompt halves, and hand the result to the transport.
import { postJSON } from "./api.js";
import { toast } from "./toast.js";
import { state } from "./state.js";
import { refreshReviewPanel } from "./reviewPanel.js";
import { markTriggered } from "./notify.js";
import { startNotifyWatch } from "./notifyWatch.js";
import { buildPrContext, buildReviewInstructions } from "./reviewPrompt.js";
import type { PR, Detail } from "./types.js";

export async function sendPrToCopilot(pr: PR, detail: Detail): Promise<void> {
  // PART 1 — dynamic PR context (may fetch diffs the user hasn't opened yet).
  const context = await buildPrContext(pr, detail);
  const runId = crypto.randomUUID();

  // Persist the run before dispatch so a child completion can be correlated and
  // an older child can never overwrite a newer review.
  try {
    await postJSON("/api/review-result", {
      prId: String(pr.id),
      runId,
      org: pr.org,
      project: pr.project,
      repo: pr.repo,
      title: pr.title,
      status: "running",
    });
  } catch (e) {
    toast("Could not start review: " + (e as Error).message, "err");
    return;
  }
  if (state.reviews) {
    state.reviews[String(pr.id)] = { pr_id: String(pr.id), run_id: runId, status: "running" };
  }
  pr.plateDismissed = false;
  // If this PR's detail modal is on screen, show the running state right away.
  const panelEl = document.querySelector(".rev-panel") as HTMLElement | null;
  if (panelEl && state.current && state.current.pr && String(state.current.pr.id) === String(pr.id)) {
    refreshReviewPanel(pr, panelEl);
  }

  // PART 2 — build one self-contained fork_session dispatch payload. The child
  // opens its own target-specific canvas and publishes through that canvas, so
  // completion no longer depends on inherited chat context or this loopback port.
  const canvasInstanceId =
    `ado-pr-review-${pr.org}-${pr.repoId}-${pr.id}`
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .slice(0, 120);
  const instructions = buildReviewInstructions({
    prId: pr.id,
    reviewModel: state.config.reviewModel || "",
    prContext: context,
    canvasInstanceId,
    org: pr.org,
    project: pr.project,
    repo: pr.repo,
    repoId: pr.repoId,
    title: pr.title,
    runId,
  });

  const sent = await bridge(instructions, `PR #${pr.id} sent to Copilot (background)`);
  if (!sent) {
    const error = "Could not dispatch the review to the Copilot session.";
    try {
      await postJSON("/api/review-result", {
        prId: String(pr.id),
        runId,
        status: "error",
        error,
      });
    } catch {
      // The bridge toast already surfaced the transport failure.
    }
    if (state.reviews) {
      state.reviews[String(pr.id)] = { pr_id: String(pr.id), run_id: runId, status: "error", error };
    }
    if (panelEl) refreshReviewPanel(pr, panelEl);
    return;
  }

  // Only a successfully dispatched review should trigger completion notifications.
  markTriggered(String(pr.id));
  startNotifyWatch();
}

export async function bridge(prompt: string, okMsg?: string): Promise<boolean> {
  try {
    await postJSON("/api/bridge", { prompt });
    toast(okMsg || "Sent to Copilot", "ok");
    return true;
  } catch (e: any) {
    toast("Bridge failed: " + e.message, "err");
    return false;
  }
}
