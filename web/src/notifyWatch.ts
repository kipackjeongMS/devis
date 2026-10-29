// The background-review completion watcher. When a review is launched from this
// session, we poll the shared review store and, on completion, notify the user
// exactly once: an OS-level Web Notification when the canvas is unfocused/hidden
// (the walk-away case this exists for), otherwise a quiet in-app toast (you can
// already see the panel update). Only the session that triggered a review
// watches it, so there are no cross-session duplicate pings.
import { state, loadReviews } from "./state.js";
import { toast } from "./toast.js";
import { diffReviews, expireTriggered, getTriggered, unmarkTriggered, triggeredCount } from "./notify.js";
import type { Review } from "./types.js";
import type { PendingNote } from "./notify.js";

const POLL_MS = 7000;
let watchTimer: ReturnType<typeof setInterval> | null = null;
/** A tick still waiting on the store; the next one is skipped rather than stacked. */
let ticking = false;
let prev: Record<string, Review> = {};
// What the queue was last told to render. A tick re-renders the whole queue,
// so it only asks when the loaded reviews or active jobs actually changed.
let lastSig: string | null = null;

// Ask for OS-notification permission. Must be called from a user gesture (the
// "Review PR with Copilot" click) or the host may ignore it. Best-effort: a
// host that sandboxes notifications simply leaves us on the toast fallback.
export function requestNotifyPermission(): void {
  try {
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => {});
    }
  } catch {
    /* Notification API unavailable in this host */
  }
}

export function startNotifyWatch(): void {
  if (watchTimer) return;
  prev = { ...state.reviews };
  lastSig = null;
  watchTimer = setInterval(() => void tick(), POLL_MS);
}

export function stopNotifyWatch(): void {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const before = prev;
    await loadReviews(); // refreshes state.reviews from the shared store
    const after = state.reviews;
    const sig = JSON.stringify([after, state.activeReviewJobs]);
    if (sig !== lastSig) {
      lastSig = sig;
      window.dispatchEvent(new CustomEvent("ado-pr-updated"));
    }
    for (const note of diffReviews(before, after, getTriggered())) {
      fireNote(note);
      unmarkTriggered(note.key);
    }
    prev = { ...after };
  } catch {
    /* the next tick tries again */
  } finally {
    ticking = false;
  }
  if (expireTriggered() === 0 && triggeredCount() === 0) stopNotifyWatch();
}

function fireNote(n: PendingNote): void {
  const focused = document.visibilityState === "visible" && document.hasFocus();
  const label = n.status === "error" ? "⚠ Copilot review failed" : "✓ Copilot review ready";
  const body = "PR #" + n.prId + (n.title ? " · " + n.title : "");

  if (!focused && "Notification" in window && Notification.permission === "granted") {
    try {
      const notif = new Notification(label, { body, tag: "ado-review-" + n.prId });
      notif.onclick = () => {
        try {
          window.focus();
        } catch {
          /* host may block programmatic focus */
        }
        notif.close();
      };
      return;
    } catch {
      /* fall through to the in-app toast */
    }
  }
  toast(label + " — PR #" + n.prId, n.status === "error" ? "err" : "ok");
}
