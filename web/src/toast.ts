// Transient bottom-of-panel notification.
import { $ } from "./dom.js";

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(msg: string, kind?: string): void {
  const t = $("#toast") as HTMLElement;
  t.textContent = msg;
  t.className = "toast" + (kind ? " " + kind : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === "err" ? 5000 : 2600);
}
