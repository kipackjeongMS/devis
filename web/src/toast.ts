// Transient bottom-of-panel notification.
import { $ } from "./dom.js";

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** A button in the toast, like Undo. Using it closes the toast. */
export interface ToastAction {
  label: string;
  run: () => void;
}

/** Show a toast. One with an action stays longer, and while the pointer is on it. */
export function toast(msg: string, kind?: string, action?: ToastAction): void {
  const t = $("#toast") as HTMLElement;
  const hide = () => (t.hidden = true);
  const ms = action ? 6000 : kind === "err" || kind === "warn" ? 5000 : 2600;
  t.replaceChildren(document.createTextNode(msg));
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-action";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      clearTimeout(toastTimer);
      hide();
      action.run();
    });
    t.append(button);
  }
  t.className = "toast" + (kind ? " " + kind : "");
  t.hidden = false;
  t.onmouseenter = action ? () => clearTimeout(toastTimer) : null;
  t.onmouseleave = action ? () => (toastTimer = setTimeout(hide, 2600)) : null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hide, ms);
}
