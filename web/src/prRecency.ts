// Phase 2 of the PR list for the Workspace's Pull Requests panel: when the author
// last pushed, and when I last commented or voted. The server reads these in the
// background (src/pr-recency.mts); this collects them and merges them into every
// PR list the client holds, then says so with an `ado-pr-recency` event.
import { getJSON } from "./api.js";
import { prIdentity } from "./prPanelModel.js";
import { state } from "./state.js";
import type { PR } from "./types.js";

export { prIdentity };

interface RecencyRow {
  org: string;
  project: string;
  repoId: string;
  prId: string;
  pushedAt: string | null;
  myAt: string | null;
  myKind: "comment" | "vote" | null;
}

/** Each call waits up to 15s on the server, so this is about two minutes at most. */
const MAX_ROUNDS = 8;
let running = false;
let again = false;

const keyOf = (org: string, project: string, repoId: string, prId: string | number): string =>
  prIdentity({ org, project, repoId, id: prId as PR["id"] });

/** Merge settled rows in; true when any PR changed. */
export function mergeRecency(rows: RecencyRow[], lists: PR[][]): boolean {
  const byKey = new Map(rows.map((r) => [keyOf(r.org, r.project, r.repoId, r.prId), r]));
  let changed = false;
  for (const list of lists) {
    for (const pr of list) {
      const row = byKey.get(prIdentity(pr));
      if (!row) continue;
      if (pr.pushedAt !== row.pushedAt || pr.myAt !== row.myAt || pr.myKind !== row.myKind) {
        pr.pushedAt = row.pushedAt;
        pr.myAt = row.myAt;
        pr.myKind = row.myKind;
        changed = true;
      }
    }
  }
  return changed;
}

/** Collect reads in flight until none are left. A call while one runs asks for another pass. */
export function loadPrRecency(): void {
  if (running) {
    again = true;
    return;
  }
  running = true;
  void (async () => {
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        again = false;
        const res = await getJSON("/api/pr-recency");
        if (mergeRecency(res.recency || [], [state.prs, state.authoredPrs, state.olderPrs])) {
          window.dispatchEvent(new CustomEvent("ado-pr-recency"));
        }
        for (const error of res.errors || []) console.warn(`[pr-recency] ${error}`);
        if (!(res.pending > 0) && !again) break;
      }
    } catch (e) {
      // Enrichment only: rows fall back to when the PR was created.
      console.warn(`[pr-recency] ${(e as Error).message}`);
    } finally {
      running = false;
    }
  })();
}
