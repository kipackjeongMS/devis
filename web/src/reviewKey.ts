import type { PR, Review } from "./types.js";

export function reviewStateKey(pr: Pick<PR, "org" | "project" | "repoId" | "id">): string {
  return JSON.stringify([pr.org, pr.project, pr.repoId, String(pr.id)]);
}

export function reviewRowKey(review: Review): string {
  return review.org && review.project && review.repo_id && review.pr_id
    ? JSON.stringify([review.org, review.project, review.repo_id, String(review.pr_id)])
    : String(review.pr_id || "");
}

export function activeJobKey(job: {
  org: string;
  project: string;
  repo_id: string;
  pr_id: string;
}): string {
  return JSON.stringify([job.org, job.project, job.repo_id, String(job.pr_id)]);
}
