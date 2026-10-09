// PR-level ADO actions for the detail header: a "Decision" menu (vote) and a
// "Lifecycle" menu (complete / auto-complete / draft / abandon), plus the
// ADO-style completion dialog and a confirmation dialog for Abandon.
import { el } from "./dom.js";
import { icon as lineIcon } from "./icons.js";
import { esc } from "./util.js";
import { postJSON } from "./api.js";
import { toast } from "./toast.js";
import type { PR, Detail } from "./types.js";
import {
  decisionMenuItems,
  defaultMergeMessage,
  lifecycleMenuItems,
  type LifecycleAction,
} from "./prActionModel.js";

interface MenuEntry {
  label: string;
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  run: () => void;
}

const DECISION_ICON = `<svg class="stroke-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="12" cy="12" r="8.5"></circle><path d="m8.4 12.3 2.5 2.5 4.8-5.1"></path></svg>`;
const LIFECYCLE_ICON = `<svg class="stroke-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="7" cy="5.5" r="2"></circle><circle cx="7" cy="18.5" r="2"></circle><circle cx="17" cy="12" r="2"></circle>
  <path d="M7 7.5v9"></path><path d="M7 7.5c0 3 2.5 4.5 8 4.5"></path></svg>`;

const LIFECYCLE_DONE: Record<LifecycleAction, string> = {
  complete: "Pull request completed",
  autoComplete: "Auto-complete set",
  cancelAutoComplete: "Auto-complete cancelled",
  draft: "Marked as draft",
  publish: "Pull request published",
  abandon: "Pull request abandoned",
  reactivate: "Pull request reactivated",
};

const MERGE_TYPES = [
  { value: "noFastForward", label: "Merge (no fast-forward)", hint: "Keep every commit and add a merge commit" },
  { value: "squash", label: "Squash commit", hint: "Combine all commits into one on the target" },
  { value: "rebase", label: "Rebase and fast-forward", hint: "Replay commits onto the target, no merge commit" },
  { value: "rebaseMerge", label: "Semi-linear merge", hint: "Rebase, then add a merge commit" },
];

let closeOpenMenu: (() => void) | null = null;

export function closePrActionMenu(): void {
  closeOpenMenu?.();
}

function menuButton(className: string, label: string, icon: string, entries: () => MenuEntry[]): HTMLElement {
  const wrap = el(`<span class="detail-menu-wrap"></span>`);
  const button = el<HTMLButtonElement>(
    `<button type="button" class="detail-icon-btn ${className}" title="${esc(label)}" aria-label="${esc(label)}"
             aria-haspopup="menu" aria-expanded="false">${icon}</button>`
  );
  wrap.appendChild(button);

  const open = (): void => {
    closePrActionMenu();
    const menu = el(`<div class="detail-menu" role="menu" aria-label="${esc(label)}"></div>`);
    const items: HTMLButtonElement[] = [];
    for (const entry of entries()) {
      const role = entry.checked === undefined ? "menuitem" : "menuitemradio";
      const item = el<HTMLButtonElement>(
        `<button type="button" class="detail-menu-item${entry.danger ? " danger" : ""}" role="${role}">
           <span class="detail-menu-check" aria-hidden="true">${entry.checked ? lineIcon("check") : ""}</span>
           <span class="detail-menu-text">
             <span class="detail-menu-label">${esc(entry.label)}</span>
             ${entry.hint ? `<span class="detail-menu-hint">${esc(entry.hint)}</span>` : ""}
           </span>
         </button>`
      );
      if (entry.checked !== undefined) item.setAttribute("aria-checked", String(entry.checked));
      item.disabled = !!entry.disabled;
      item.addEventListener("click", () => {
        closePrActionMenu();
        button.focus();
        entry.run();
      });
      menu.appendChild(item);
      items.push(item);
    }
    wrap.appendChild(menu);
    if (menu.getBoundingClientRect().right > window.innerWidth - 8) menu.classList.add("align-end");
    button.setAttribute("aria-expanded", "true");
    button.classList.add("on");

    const enabled = (): HTMLButtonElement[] => items.filter((item) => !item.disabled);
    const focusAt = (index: number): void => {
      const list = enabled();
      if (list.length) list[(index + list.length) % list.length].focus();
    };
    const onKey = (event: KeyboardEvent): void => {
      const list = enabled();
      const current = list.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation(); // keep the PR slide-over open
        closePrActionMenu();
        button.focus();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        focusAt(current + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        focusAt(current < 0 ? -1 : current - 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        focusAt(0);
      } else if (event.key === "End") {
        event.preventDefault();
        focusAt(-1);
      } else if (event.key === "Tab") {
        closePrActionMenu();
      }
    };
    const onOutside = (event: MouseEvent): void => {
      if (!wrap.contains(event.target as Node)) closePrActionMenu();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onOutside, true);
    closeOpenMenu = () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onOutside, true);
      menu.remove();
      button.setAttribute("aria-expanded", "false");
      button.classList.remove("on");
      closeOpenMenu = null;
    };
    const checked = items.find((item) => item.getAttribute("aria-checked") === "true" && !item.disabled);
    (checked || enabled()[0])?.focus();
  };

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (button.getAttribute("aria-expanded") === "true") closePrActionMenu();
    else open();
  });
  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && button.getAttribute("aria-expanded") !== "true") {
      event.preventDefault();
      open();
    }
  });
  return wrap;
}

function target(pr: PR): Record<string, unknown> {
  return { org: pr.org, project: pr.project, repoId: pr.repoId, prId: pr.id };
}

export function mountDecisionMenu(pr: PR, detail: Detail, onChanged: () => void): HTMLElement {
  return menuButton("pr-decision-btn", "Decision", DECISION_ICON, () =>
    decisionMenuItems(detail).map((item) => ({
      label: item.label,
      checked: item.vote === 0 ? undefined : item.checked,
      disabled: item.disabled,
      run: async () => {
        if (item.checked) return;
        try {
          await postJSON("/api/pr-vote", { ...target(pr), vote: item.vote });
          toast(item.vote === 0 ? "Feedback reset" : `Voted: ${item.label}`, "ok");
          onChanged();
        } catch (e: any) {
          toast("Vote failed: " + e.message, "err");
        }
      },
    }))
  );
}

export function mountLifecycleMenu(pr: PR, detail: Detail, onChanged: () => void): HTMLElement {
  const run = async (action: LifecycleAction, options?: Record<string, unknown>): Promise<void> => {
    await postJSON("/api/pr-lifecycle", { ...target(pr), action, options });
    toast(LIFECYCLE_DONE[action], "ok");
    onChanged();
  };
  return menuButton("pr-lifecycle-btn", "Complete, draft, or abandon", LIFECYCLE_ICON, () =>
    lifecycleMenuItems(detail).map((item) => ({
      label: item.label,
      hint: item.hint,
      disabled: item.disabled,
      danger: item.danger,
      run: () => {
        if (item.action === "complete" || item.action === "autoComplete") {
          openCompletionDialog(pr, detail, item.action, (options) => run(item.action, options));
        } else if (item.action === "abandon") {
          openActionDialog({
            title: "Abandon pull request",
            loc: `#${pr.id}`,
            body: `<p class="pa-note">PR #${pr.id} will be abandoned. You can reactivate it later.</p>`,
            confirmLabel: "Abandon",
            danger: true,
            onConfirm: () => run("abandon"),
          });
        } else {
          run(item.action).catch((e: any) => toast("Action failed: " + e.message, "err"));
        }
      },
    }))
  );
}

interface ActionDialogOptions {
  title: string;
  loc: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: (dialog: HTMLElement) => Promise<void>;
}

function openActionDialog(opts: ActionDialogOptions): HTMLElement {
  const returnFocus = document.activeElement as HTMLElement | null;
  const overlay = el(`<div class="ask-overlay"></div>`);
  const dialog = el(
    `<div class="ask-dialog pa-dialog" role="dialog" aria-modal="true" aria-labelledby="pa-title" tabindex="-1">
       <div class="ask-head">
         <span class="ask-title" id="pa-title">${esc(opts.title)}</span>
         <span class="ask-loc">${esc(opts.loc)}</span>
         <button type="button" class="ask-close" title="Close (Esc)" aria-label="Close">${lineIcon("dismiss")}</button>
       </div>
       <div class="pa-body">${opts.body}</div>
       <div class="ask-answer err-ans pa-error" role="alert" hidden></div>
       <div class="ask-actions">
         <button type="button" class="btn ghost sm pa-cancel">Cancel</button>
         <button type="button" class="btn sm pa-confirm${opts.danger ? " danger" : ""}">${esc(opts.confirmLabel)}</button>
       </div>
     </div>`
  );
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  const error = dialog.querySelector<HTMLElement>(".pa-error")!;
  const confirm = dialog.querySelector<HTMLButtonElement>(".pa-confirm")!;
  let busy = false;

  const close = (): void => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    returnFocus?.focus();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation(); // keep the PR slide-over open
      if (!busy) close();
    } else if (event.key === "Tab") {
      const focusable = [...dialog.querySelectorAll<HTMLElement>("button, input, textarea")].filter(
        (node) => !(node as HTMLButtonElement).disabled && node.offsetParent !== null
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay && !busy) close();
  });
  dialog.querySelector(".ask-close")!.addEventListener("click", () => !busy && close());
  dialog.querySelector(".pa-cancel")!.addEventListener("click", () => !busy && close());
  confirm.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    confirm.disabled = true;
    const label = confirm.textContent;
    confirm.textContent = "Working…";
    error.hidden = true;
    try {
      await opts.onConfirm(dialog);
      close();
    } catch (e: any) {
      error.textContent = e?.message || "Action failed";
      error.hidden = false;
      confirm.textContent = label;
      confirm.disabled = false;
      busy = false;
    }
  });
  requestAnimationFrame(() => (dialog.querySelector<HTMLElement>("input:checked, textarea") || confirm).focus());
  return dialog;
}

function openCompletionDialog(
  pr: PR,
  detail: Detail,
  action: "complete" | "autoComplete",
  submit: (options: Record<string, unknown>) => Promise<void>
): void {
  const saved = detail.completionOptions || {};
  const strategy = MERGE_TYPES.some((m) => m.value === saved.mergeStrategy) ? saved.mergeStrategy : "noFastForward";
  const source = (pr.sourceRef || "").replace(/^refs\/heads\//, "");
  const message = saved.mergeCommitMessage || defaultMergeMessage(pr.id, pr.title);
  const radios = MERGE_TYPES.map(
    (m) => `<label class="pa-radio">
        <input type="radio" name="pa-merge" value="${m.value}"${m.value === strategy ? " checked" : ""}>
        <span><span class="pa-radio-label">${esc(m.label)}</span><span class="pa-radio-hint">${esc(m.hint)}</span></span>
      </label>`
  ).join("");
  const auto = action === "autoComplete";
  const dialog = openActionDialog({
    title: auto ? "Set auto-complete" : "Complete pull request",
    loc: `#${pr.id}`,
    body:
      (auto ? `<p class="pa-note">The PR completes automatically once all required policies pass.</p>` : "") +
      `<fieldset class="pa-fieldset"><legend class="rp-label">Merge type</legend>${radios}</fieldset>` +
      `<div class="pa-message"><label class="rp-label" for="pa-msg">Merge commit message</label>` +
      `<textarea id="pa-msg" class="ask-q" rows="3">${esc(message)}</textarea></div>` +
      `<label class="pa-check"><input type="checkbox" class="pa-delete"${saved.deleteSourceBranch ? " checked" : ""}>` +
      `<span>Delete <code>${esc(source)}</code> after merging</span></label>` +
      `<label class="pa-check"><input type="checkbox" class="pa-workitems"${saved.transitionWorkItems === false ? "" : " checked"}>` +
      `<span>Complete associated work items after merging</span></label>`,
    confirmLabel: auto ? "Set auto-complete" : "Complete merge",
    onConfirm: async (node) => {
      const chosen = node.querySelector<HTMLInputElement>('input[name="pa-merge"]:checked')?.value || "noFastForward";
      await submit({
        mergeStrategy: chosen,
        mergeCommitMessage: node.querySelector<HTMLTextAreaElement>("#pa-msg")!.value,
        deleteSourceBranch: node.querySelector<HTMLInputElement>(".pa-delete")!.checked,
        transitionWorkItems: node.querySelector<HTMLInputElement>(".pa-workitems")!.checked,
      });
    },
  });
  // A fast-forward rebase creates no merge commit, so hide the message.
  const messageBox = dialog.querySelector<HTMLElement>(".pa-message")!;
  const sync = (): void => {
    const chosen = dialog.querySelector<HTMLInputElement>('input[name="pa-merge"]:checked')?.value;
    messageBox.hidden = chosen === "rebase";
  };
  dialog.querySelectorAll('input[name="pa-merge"]').forEach((radio) => radio.addEventListener("change", sync));
  sync();
}
