// Resolve/Reactivate toggle for an ADO comment thread. The same thread can be
// rendered in several places (discussion, diff, comments drawer); every copy of
// its status label and toggle is kept in sync after a change.
import { el } from "./dom.js";
import { postJSON } from "./api.js";
import { toast } from "./toast.js";
import type { PR, Thread } from "./types.js";
import { isThreadResolved, nextThreadStatus, threadStatusLabel } from "./prActionModel.js";

function toggleLabel(status: string): string {
  return isThreadResolved(status) ? "Reactivate" : "Resolve";
}

function syncThreadStatus(thread: Thread): void {
  const id = String(thread.id);
  for (const label of document.querySelectorAll<HTMLElement>(`[data-thread-status-for="${id}"]`)) {
    label.textContent = threadStatusLabel(thread.status);
    label.classList.toggle("resolved", isThreadResolved(thread.status));
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>(`[data-thread-toggle-for="${id}"]`)) {
    button.textContent = toggleLabel(thread.status);
    button.setAttribute("aria-label", `${toggleLabel(thread.status)} this comment thread`);
  }
}

/** A status label that follows later toggles of the same thread. */
export function threadStatusBadge(thread: Thread, className: string): HTMLElement {
  const badge = el(`<span class="${className}"></span>`);
  badge.dataset.threadStatusFor = String(thread.id);
  badge.textContent = threadStatusLabel(thread.status);
  badge.classList.toggle("resolved", isThreadResolved(thread.status));
  return badge;
}

export function threadStatusToggle(pr: PR, thread: Thread, className = "btn ghost sm"): HTMLButtonElement {
  const button = el<HTMLButtonElement>(`<button type="button" class="${className} thread-status-toggle"></button>`);
  button.dataset.threadToggleFor = String(thread.id);
  button.textContent = toggleLabel(thread.status);
  button.setAttribute("aria-label", `${toggleLabel(thread.status)} this comment thread`);
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (button.disabled) return;
    const status = nextThreadStatus(thread.status);
    button.disabled = true;
    try {
      const updated = await postJSON("/api/thread-status", {
        org: pr.org,
        project: pr.project,
        repoId: pr.repoId,
        prId: pr.id,
        threadId: thread.id,
        status,
      });
      thread.status = updated?.status || status;
      syncThreadStatus(thread);
      toast(isThreadResolved(thread.status) ? "Thread resolved" : "Thread reactivated", "ok");
    } catch (e: any) {
      toast("Status change failed: " + e.message, "err");
    } finally {
      button.disabled = false;
    }
  });
  return button;
}
