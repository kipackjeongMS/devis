// DOM element helpers plus the two long-lived root nodes the app renders into.
import { esc } from "./util.js";

/** querySelector shorthand. Callers assume the element exists (guaranteed by index.html). */
export const $ = <T extends Element = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as unknown as T;

/** Build a detached element from an HTML string (returns the first child). */
export function el<T extends HTMLElement = HTMLElement>(html: string): T {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
}

/** The main content area plus the filter-bar controls (present in index.html). */
export const view = $("#view") as HTMLElement;
export const filterbar = $("#filterbar") as HTMLElement;
export const bulkReviewHost = $("#bulkReviewHost") as HTMLElement;
export const orgFilter = $("#orgFilter") as HTMLSelectElement;
export const projectFilter = $("#projectFilter") as HTMLSelectElement;
export const assignFilter = $("#assignFilter") as HTMLElement;

/** Replace the view with a full-panel error/empty state. */
export function renderError(msg: string): void {
  filterbar.hidden = true;
  view.innerHTML =
    `<div class="empty">${esc(msg)}<div class="hint">Check that you are logged in with <code>az login</code>.</div></div>`;
}
