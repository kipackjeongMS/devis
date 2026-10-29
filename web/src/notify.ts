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

// PR ids whose review was launched from this session, with when (in-memory only —
// a reload clears it, which is fine: you can no longer be "waiting" on something
// you didn't just start here). A review that never finishes (deleted, lost) is
// dropped after a while, so the watcher behind it stops polling.
const triggered = new Map<string, number>();
export const TRIGGER_TTL_MS = 6 * 60 * 60_000;

export function markTriggered(key: string, at = Date.now()): void {
  triggered.set(key, at);
}
export function unmarkTriggered(key: string): void {
  triggered.delete(key);
}
/** Forget triggers older than the TTL. Returns how many remain. */
export function expireTriggered(now = Date.now()): number {
  for (const [key, at] of triggered) if (now - at > TRIGGER_TTL_MS) triggered.delete(key);
  return triggered.size;
}
export function triggeredCount(): number {
  return triggered.size;
}
export function getTriggered(): Set<string> {
  return new Set(triggered.keys());
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
