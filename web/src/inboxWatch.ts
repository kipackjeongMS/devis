// Drives the inbox: an initial load, then a slow poll that scans ADO for new
// peer comments and fires an OS notification when the canvas is unfocused (the
// walk-away case). The persistent bell badge covers the focused case.
import { getJSON, postJSON } from "./api.js";
import { applyInbox } from "./inboxPanel.js";

const POLL_MS = 60000;
let timer: ReturnType<typeof setInterval> | null = null;

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
    /* non-fatal: the bell just stays empty */
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
  } catch {
    /* non-fatal */
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
