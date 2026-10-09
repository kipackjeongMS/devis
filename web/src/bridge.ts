// Durable PR-review queue. Both the detail-page button and list-page Review All
// prepare the same self-contained tasks, then enqueue them for the app's
// bounded background reviewer sessions.
import { postJSON } from "./api.js";
import { toast } from "./toast.js";
import { state } from "./state.js";
import { refreshReviewPanel } from "./reviewPanel.js";
import { markTriggered } from "./notify.js";
import { startNotifyWatch } from "./notifyWatch.js";
import { activeJobKey, reviewStateKey } from "./reviewKey.js";
import type { PR, Detail } from "./types.js";

const QUEUE_BATCH_SIZE = 50;

export interface BulkReviewResult {
  /** Canonical [org, project, repoId, prId] keys, not bare PR numbers. */
  accepted: string[];
  skipped: string[];
  failed: Array<{ prId: string; error: string }>;
}

function responseKey(item: any): string {
  return JSON.stringify([String(item.org), String(item.project), String(item.repoId), String(item.prId)]);
}

async function enqueueTargets(
  prs: PR[],
  onProgress?: (done: number, total: number, pr: PR) => void
): Promise<BulkReviewResult> {
  if (!prs.length) return { accepted: [], skipped: [], failed: [] };
  const accepted: string[] = [];
  const skipped: string[] = [];
  const failed: BulkReviewResult["failed"] = [];
  let done = 0;

  for (let offset = 0; offset < prs.length; offset += QUEUE_BATCH_SIZE) {
    const chunk = prs.slice(offset, offset + QUEUE_BATCH_SIZE);
    let res: any;
    try {
      res = await postJSON("/api/review/queue-targets", {
        reviewModel: state.config.reviewModel || "",
        targets: chunk.map((pr) => ({
          org: pr.org,
          project: pr.project,
          repoId: pr.repoId,
          prId: String(pr.id),
        })),
      });
    } catch (e) {
      const error = (e as Error).message;
      failed.push(...chunk.map((pr) => ({ prId: String(pr.id), error })));
      for (const pr of chunk) onProgress?.(++done, prs.length, pr);
      continue;
    }

    accepted.push(...(res.accepted || []).map(responseKey));
    skipped.push(...(res.skipped || []).map(responseKey));
    failed.push(
      ...(res.failed || []).map((item: any) => ({
        prId: String(item.prId),
        error: String(item.error || "Could not prepare review"),
      }))
    );
    for (const item of [...(res.accepted || []), ...(res.skipped || [])]) {
      const key = responseKey(item);
      const prId = String(item.prId);
      const pr = state.prs.find(
        (candidate) =>
          candidate.org === item.org &&
          candidate.project === item.project &&
          candidate.repoId === item.repoId &&
          String(candidate.id) === prId
      );
      const activeJob = {
        pr_id: prId,
        org: String(item.org),
        project: String(item.project),
        repo: String(item.repo),
        repo_id: String(item.repoId),
        status: String(item.status),
      };
      state.activeReviewJobs[activeJobKey(activeJob)] = activeJob;
      markTriggered(key);
      if (pr) {
        state.reviews[reviewStateKey(pr)] = {
          ...state.reviews[reviewStateKey(pr)],
          pr_id: prId,
          org: pr.org,
          project: pr.project,
          repo: pr.repo,
          repo_id: pr.repoId,
          run_id: String(item.runId),
          status: item.status === "queued" || item.status === "dispatching" ? "queued" : "running",
        };
        if ((res.accepted || []).some((acceptedItem: any) => responseKey(acceptedItem) === key)) {
          pr.plateDismissed = false;
        }
      }
    }
    for (const pr of chunk) onProgress?.(++done, prs.length, pr);
  }
  if (accepted.length || skipped.length) startNotifyWatch();
  return { accepted, skipped, failed };
}

export async function sendPrToCopilot(pr: PR, detail: Detail): Promise<void> {
  void detail;
  try {
    const result = await enqueueTargets([pr]);
    if (result.accepted.length) {
      toast(`Queued PR #${pr.id} for independent review`, "ok");
    } else if (result.failed.length) {
      throw new Error(result.failed[0].error);
    } else {
      toast(`PR #${pr.id} is already queued or being reviewed`, "ok");
    }
  } catch (e) {
    toast("Could not queue review: " + (e as Error).message, "err");
  } finally {
    const panel = document.querySelector(".rev-panel") as HTMLElement | null;
    if (panel && state.current && String(state.current.pr.id) === String(pr.id)) {
      void refreshReviewPanel(pr, panel);
    }
  }
}

export async function sendPrsToCopilot(
  prs: PR[],
  onProgress?: (done: number, total: number, pr: PR) => void
): Promise<BulkReviewResult> {
  return enqueueTargets(prs, onProgress);
}
