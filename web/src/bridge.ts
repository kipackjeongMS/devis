// Durable PR-review queue. Both the detail-page button and list-page Review All
// prepare the same self-contained tasks, then enqueue them for bounded dispatch
// into independent app-managed sessions.
import { getJSON, postJSON } from "./api.js";
import { toast } from "./toast.js";
import { state } from "./state.js";
import { refreshReviewPanel } from "./reviewPanel.js";
import { markTriggered } from "./notify.js";
import { startNotifyWatch } from "./notifyWatch.js";
import { buildPrContext, buildReviewTask } from "./reviewPrompt.js";
import { activeJobKey, reviewStateKey } from "./reviewKey.js";
import type { PR, Detail } from "./types.js";

interface PreparedReview {
  pr: PR;
  runId: string;
  taskPrompt: string;
  targetCanvasInstanceId: string;
}

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

function currentCanvasInstanceId(): string {
  const id = new URLSearchParams(window.location.search).get("canvasInstanceId")?.trim();
  if (!id) throw new Error("This canvas instance cannot dispatch reviews. Reopen the canvas and try again.");
  return id;
}

function targetCanvasInstanceId(pr: PR): string {
  return `ado-pr-review-${pr.org}-${pr.repoId}-${pr.id}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .slice(0, 120);
}

async function fetchDetailForReview(pr: PR): Promise<Detail> {
  return getJSON(
    `/api/pr?org=${encodeURIComponent(pr.org)}&project=${encodeURIComponent(pr.project)}` +
      `&repoId=${encodeURIComponent(pr.repoId)}&id=${pr.id}`
  );
}

async function prepareReview(pr: PR, detail?: Detail): Promise<PreparedReview> {
  const resolvedDetail = detail || (await fetchDetailForReview(pr));
  const runId = crypto.randomUUID();
  const canvasInstanceId = targetCanvasInstanceId(pr);
  const taskPrompt = buildReviewTask({
    prId: pr.id,
    prContext: await buildPrContext(pr, resolvedDetail),
    canvasInstanceId,
    org: pr.org,
    project: pr.project,
    repo: pr.repo,
    repoId: pr.repoId,
    title: pr.title,
    runId,
  });
  return { pr, runId, taskPrompt, targetCanvasInstanceId: canvasInstanceId };
}

async function prepareReviews(
  prs: PR[],
  onProgress?: (done: number, total: number, pr: PR) => void
): Promise<{ prepared: PreparedReview[]; failed: BulkReviewResult["failed"] }> {
  const prepared: PreparedReview[] = [];
  const failed: BulkReviewResult["failed"] = [];
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < prs.length) {
      const pr = prs[next++];
      try {
        prepared.push(await prepareReview(pr));
      } catch (e) {
        failed.push({ prId: String(pr.id), error: (e as Error).message });
      } finally {
        done++;
        onProgress?.(done, prs.length, pr);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, prs.length) }, () => worker()));
  return { prepared, failed };
}

async function enqueuePrepared(
  prepared: PreparedReview[],
  failed: BulkReviewResult["failed"] = []
): Promise<BulkReviewResult> {
  if (!prepared.length) return { accepted: [], skipped: [], failed };
  const canvasInstanceId = currentCanvasInstanceId();
  const accepted: string[] = [];
  const skipped: string[] = [];
  const allFailed = [...failed];

  for (let offset = 0; offset < prepared.length; offset += QUEUE_BATCH_SIZE) {
    const chunk = prepared.slice(offset, offset + QUEUE_BATCH_SIZE);
    let res: any;
    try {
      res = await postJSON("/api/review/queue", {
        canvasInstanceId,
        jobs: chunk.map(({ pr, runId, taskPrompt, targetCanvasInstanceId: targetId }) => ({
          prId: String(pr.id),
          runId,
          org: pr.org,
          project: pr.project,
          repo: pr.repo,
          repoId: pr.repoId,
          title: pr.title,
          taskPrompt,
          targetCanvasInstanceId: targetId,
          reviewModel: state.config.reviewModel || "",
        })),
      });
    } catch (e) {
      const error = (e as Error).message;
      allFailed.push(...chunk.map(({ pr }) => ({ prId: String(pr.id), error })));
      continue;
    }

    accepted.push(...(res.accepted || []).map(responseKey));
    skipped.push(...(res.skipped || []).map(responseKey));
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
  }
  if (accepted.length || skipped.length) startNotifyWatch();
  return { accepted, skipped, failed: allFailed };
}

export async function sendPrToCopilot(pr: PR, detail: Detail): Promise<void> {
  try {
    const result = await enqueuePrepared([await prepareReview(pr, detail)]);
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
  const { prepared, failed } = await prepareReviews(prs, onProgress);
  return enqueuePrepared(prepared, failed);
}
