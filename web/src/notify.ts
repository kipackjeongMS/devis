// Pure notification bookkeeping: which PRs *this* browser session triggered a
// review for, plus a dependency-free diff that decides which of them just
// finished. Kept import-type-only so it can be unit-tested under plain node.
import type { Review } from "./types.js";

export interface PendingNote {
  key: string;
  prId: string;
  title: string;
  status: "done" | "error";
}

const TERMINAL = new Set(["done", "error"]);

// PR ids whose review was launched from this session (in-memory only — a reload
// clears it, which is fine: you can no longer be "waiting" on something you
// didn't just start here).
const triggered = new Set<string>();

export function markTriggered(key: string): void {
  triggered.add(key);
}
export function unmarkTriggered(key: string): void {
  triggered.delete(key);
}
export function triggeredCount(): number {
  return triggered.size;
}
export function getTriggered(): Set<string> {
  return triggered;
}

// For each triggered PR that moved from a non-terminal state (running/pending/
// absent) to a terminal one (done/error) between `prev` and `next`, emit one
// note. PRs that were already terminal in `prev` are treated as already
// notified and skipped.
export function diffReviews(
  prev: Record<string, Review>,
  next: Record<string, Review>,
  trig: Set<string>
): PendingNote[] {
  const out: PendingNote[] = [];
  for (const key of trig) {
    const n = next[key];
    if (!n || !TERMINAL.has(n.status)) continue;
    const p = prev[key];
    if (p && TERMINAL.has(p.status)) continue; // already terminal before → already notified
    out.push({
      key,
      prId: String(n.pr_id || ""),
      title: n.title || "",
      status: n.status === "error" ? "error" : "done",
    });
  }
  return out;
}
