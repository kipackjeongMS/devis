// Pure notification → PR matching, extracted from inboxPanel.ts so it can be
// unit-tested without any DOM. A notification's `pr_id` alone is NOT enough to
// find "the" PR — the same bare PR number can exist in more than one
// org/project/repo, so a click must be scoped by org/project/repoId first and
// only fall back to opening the raw ADO url when no in-canvas match exists
// (e.g. the PR isn't in the currently loaded list, or scope fields are absent
// on an old/legacy notification row).
import type { PR, Notification } from "./types.js";

export function matchNotificationPr(prs: readonly PR[], n: Notification): PR | undefined {
  if (n.pr_id == null) return undefined;
  return prs.find((p) => {
    if (String(p.id) !== String(n.pr_id)) return false;
    if (n.org && p.org !== n.org) return false;
    if (n.project && p.project !== n.project) return false;
    if (n.repo_id && p.repoId !== n.repo_id) return false;
    return true;
  });
}
