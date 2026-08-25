// Drives the inbox: an initial load, then a slow poll that scans ADO for new
// peer comments and fires an OS notification when the canvas is unfocused (the
// walk-away case). The persistent bell badge covers the focused case.
import { getJSON, postJSON } from "./api.js";
import { applyInbox, setInboxError } from "./inboxPanel.js";
import { toast } from "./toast.js";

const POLL_MS = 60000;
// Restrained on purpose: the poll runs every minute, but a repeated-failure
// toast would be spam at that cadence. Show it once when a failing streak
// starts, then at most this often while it continues; the bell's persistent
// "has-error" state (see inboxPanel.setInboxError) covers everything between.
const ERROR_TOAST_COOLDOWN_MS = 10 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;
let consecutiveFailures = 0;
let lastErrorToastAt = 0;

export function startInboxWatch(): void {
  if (timer) return;
  void load();
  timer = setInterval(() => void poll(), POLL_MS);
}

export function stopInboxWatch(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function load(): Promise<void> {
  try {
    const res = await getJSON("/api/inbox");
    applyInbox({ items: res.items || [], unread: res.unread || 0 });
  } catch {
    /* non-fatal: the bell just stays empty until the first successful poll */
  }
}

/** Force an immediate scan (bell click / global refresh). */
export async function refreshInbox(): Promise<void> {
  await poll();
}

async function poll(): Promise<void> {
  try {
    const res = await postJSON("/api/inbox/poll", {});
    applyInbox({ items: res.items || [], unread: res.unread || 0 });
    if (res.inserted > 0) osNotify(res.inserted);
    if (consecutiveFailures > 0) setInboxError(false);
    consecutiveFailures = 0;
  } catch {
    consecutiveFailures++;
    setInboxError(true);
    const now = Date.now();
    if (consecutiveFailures === 1 || now - lastErrorToastAt > ERROR_TOAST_COOLDOWN_MS) {
      lastErrorToastAt = now;
      toast("Notifications couldn't refresh — check your connection.", "err");
    }
  }
}

function osNotify(count: number): void {
  const focused = document.visibilityState === "visible" && document.hasFocus();
  if (focused) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification("🔔 New PR activity", {
      body: `${count} new comment${count > 1 ? "s" : ""} on your PRs`,
      tag: "ado-inbox",
    });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        /* host may block programmatic focus */
      }
      n.close();
    };
  } catch {
    /* fall back to the in-app badge */
  }
}
