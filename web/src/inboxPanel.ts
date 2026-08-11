// The notification bell + flyout. Renders the persisted inbox feed, marks items
// read on click, and routes a click to the PR (in-canvas detail when the PR is
// in the current list, else the ADO url in a new tab).
import { postJSON } from "./api.js";
import { state } from "./state.js";
import { openDetail } from "./detail.js";
import { esc, timeAgo } from "./util.js";
import { requestNotifyPermission } from "./notifyWatch.js";
import type { Notification } from "./types.js";

let items: Notification[] = [];
let unread = 0;
let open = false;
let bell: HTMLButtonElement | null = null;
let badge: HTMLElement | null = null;
let flyout: HTMLElement | null = null;

export function initInbox(): void {
  bell = document.getElementById("btnInbox") as HTMLButtonElement | null;
  if (!bell) return;
  badge = bell.querySelector(".inbox-badge");
  bell.addEventListener("click", (e) => {
    e.stopPropagation();
    requestNotifyPermission(); // within a user gesture, so the host honors it
    toggle();
  });
  document.addEventListener("click", (e) => {
    if (!open) return;
    const t = e.target as Node;
    if (flyout && !flyout.contains(t) && bell && !bell.contains(t)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) close(true);
  });
  window.addEventListener("resize", () => {
    if (open) position();
  });
}

/** Replace the feed state (called by inboxWatch after a load/poll). */
export function applyInbox(next: { items: Notification[]; unread: number }): void {
  items = next.items || [];
  unread = Number(next.unread || 0);
  renderBadge();
  if (open) renderList();
}

function renderBadge(): void {
  if (!badge) return;
  if (unread > 0) {
    badge.textContent = unread > 99 ? "99+" : String(unread);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
  bell?.classList.toggle("has-unread", unread > 0);
}

function toggle(): void {
  if (open) close();
  else openPanel();
}

function openPanel(): void {
  if (!bell) return;
  if (!flyout) {
    flyout = document.createElement("div");
    flyout.className = "inbox-flyout";
    flyout.id = "inboxFlyout";
    flyout.setAttribute("role", "region");
    flyout.setAttribute("aria-label", "Notifications");
    document.body.appendChild(flyout);
  }
  open = true;
  renderList();
  position();
  flyout.inert = false;
  flyout.setAttribute("aria-hidden", "false");
  bell.setAttribute("aria-expanded", "true");
  flyout.classList.add("show");
  requestAnimationFrame(() => {
    flyout?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  });
}

function close(restoreFocus = false): void {
  open = false;
  flyout?.classList.remove("show");
  if (flyout) {
    flyout.inert = true;
    flyout.setAttribute("aria-hidden", "true");
  }
  bell?.setAttribute("aria-expanded", "false");
  if (restoreFocus) bell?.focus();
}

function position(): void {
  if (!bell || !flyout) return;
  const r = bell.getBoundingClientRect();
  const topbarBottom = document.querySelector(".topbar")?.getBoundingClientRect().bottom || r.bottom;
  const width = Math.min(380, window.innerWidth - 24);
  const left = Math.min(
    Math.max(12, r.right - width),
    window.innerWidth - width - 12
  );
  flyout.style.top = `${Math.round(Math.max(r.bottom, topbarBottom) + 6)}px`;
  flyout.style.left = `${Math.round(left)}px`;
  flyout.style.right = "auto";
}

function renderList(): void {
  if (!flyout) return;
  const rows = items.length
    ? items.map(rowHtml).join("")
    : `<div class="inbox-empty">You're all caught up.</div>`;
  flyout.innerHTML =
    `<div class="inbox-head"><span>Notifications</span>` +
    `<button type="button" class="inbox-markall"${unread ? "" : " disabled"}>Mark all read</button></div>` +
    `<div class="inbox-list">${rows}</div>`;
  const markall = flyout.querySelector(".inbox-markall") as HTMLButtonElement | null;
  markall?.addEventListener("click", (e) => {
    e.stopPropagation();
    void markAllRead();
  });
  for (const rowEl of Array.from(flyout.querySelectorAll<HTMLElement>(".inbox-row"))) {
    rowEl.addEventListener("click", () => void onRow(rowEl.dataset.id || ""));
  }
}

function rowHtml(n: Notification): string {
  const ico = n.kind === "reply" ? "↩" : "💬";
  const unreadCls = n.unread ? " unread" : "";
  const title = n.title || `PR #${n.pr_id || ""}`;
  return (
    `<button type="button" class="inbox-row${unreadCls}" data-id="${esc(n.id)}">` +
    `<span class="inbox-row-ico">${ico}</span>` +
    `<span class="inbox-row-main">` +
    `<span class="inbox-row-top"><span class="inbox-actor">${esc(n.actor || "")}</span>` +
    `<span class="inbox-time">${esc(timeAgo(n.created_at || undefined))}</span></span>` +
    `<span class="inbox-row-title">${esc(title)}</span>` +
    (n.snippet ? `<span class="inbox-row-snip">${esc(n.snippet)}</span>` : "") +
    `</span>` +
    (n.unread ? `<span class="inbox-dot"></span>` : "") +
    `</button>`
  );
}

async function onRow(id: string): Promise<void> {
  const n = items.find((x) => x.id === id);
  if (!n) return;
  if (n.unread) {
    n.unread = 0;
    unread = Math.max(0, unread - 1);
    renderBadge();
    renderList();
    try {
      await postJSON("/api/inbox/read", { ids: [id] });
    } catch {
      /* non-fatal: local state already reflects the read */
    }
  }
  close();
  route(n);
}

function route(n: Notification): void {
  const pr = state.prs.find((p) => String(p.id) === String(n.pr_id));
  if (pr) {
    void openDetail(pr);
    return;
  }
  if (n.url) window.open(n.url, "_blank", "noopener");
}

async function markAllRead(): Promise<void> {
  for (const n of items) n.unread = 0;
  unread = 0;
  renderBadge();
  renderList();
  try {
    await postJSON("/api/inbox/read", { all: true });
  } catch {
    /* non-fatal */
  }
}
