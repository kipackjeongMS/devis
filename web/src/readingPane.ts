// The docked reading pane (replaces the old slide-over modal). Wide windows show
// it beside the queue as a non-modal region; narrow windows stack it over the
// queue as a modal dialog. Only one PR is mounted at a time. Esc closes it unless
// something inside already consumed the key or the reader is typing. Ctrl +/−/0
// zoom only the pane's content.
import { el, listPane, readingPane } from "./dom.js";
import { icon } from "./icons.js";
import { paneZoomCommand, SPLIT_MIN_WIDTH, stepPaneZoom, type PaneZoomCommand } from "./shellModel.js";
import { toast } from "./toast.js";

let scroller: HTMLElement | null = null;
let onCloseCb: (() => void) | null = null;
let returnFocus: HTMLElement | null = null;
let paneZoom = 1;
const split = window.matchMedia(`(min-width: ${SPLIT_MIN_WIDTH}px)`);

function renderEmpty(): void {
  readingPane.replaceChildren(
    el(
      `<div class="reading-empty">
         <span class="reading-empty-mark">${icon("pullRequest")}</span>
         <p class="reading-empty-title">Select a pull request</p>
         <p class="reading-empty-body">Its Copilot review, discussion, and changed files open here, beside the queue.</p>
       </div>`
    )
  );
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset"].includes(target.type);
  }
  return false;
}

// CSS zoom on the pane's child re-lays it out at the new size (text stays crisp)
// while the queue and title bar keep theirs. The level lasts for the app session:
// the local server takes a new port each launch, so localStorage would not keep it.
function zoomPane(command: PaneZoomCommand): void {
  paneZoom = command === "reset" ? 1 : stepPaneZoom(paneZoom, command === "in" ? 1 : -1);
  readingPane.style.setProperty("--pane-zoom", String(paneZoom));
  toast(`Reading pane ${Math.round(paneZoom * 100)}%`);
}

// Window-level bubble listener: document listeners (dialogs, the inbox, the
// selection toolbar) run first and preventDefault when they consume Escape;
// capture-phase menus and drawers stop propagation before it gets here.
function onKey(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  // Pipelines zooms its canvas, and the Workspace its own views (viewZoom.ts).
  const feature = document.body.dataset.feature;
  if (feature === "pipelines" || feature === "jarvis") return;
  const zoom = paneZoomCommand(e);
  if (zoom) {
    e.preventDefault();
    zoomPane(zoom);
    return;
  }
  if (e.key !== "Escape" || !scroller) return;
  if (isTextEntry(e.target) || document.querySelector(".ask-overlay")) return;
  e.preventDefault();
  closePane();
}

function syncMode(): void {
  const stacked = !split.matches;
  const modal = stacked && scroller != null;
  readingPane.setAttribute("role", modal ? "dialog" : "region");
  if (modal) readingPane.setAttribute("aria-modal", "true");
  else readingPane.removeAttribute("aria-modal");
  listPane.inert = modal;
  document.body.classList.toggle("layout-stacked", stacked);
}

export function initReadingPane(): void {
  renderEmpty();
  readingPane.setAttribute("aria-label", "Reading pane");
  syncMode();
  split.addEventListener("change", syncMode);
  window.addEventListener("keydown", onKey);
}

/** Mount `content` in the pane (replacing any open PR); `onClose` fires after close. */
export function openPane(content: HTMLElement, opts?: { onClose?: () => void; label?: string }): HTMLElement {
  const active = document.activeElement as HTMLElement | null;
  const focusBack = active && active !== document.body && !readingPane.contains(active) ? active : returnFocus;
  closePane(true);
  onCloseCb = opts?.onClose || null;
  returnFocus = focusBack;
  const scroll = el(`<div class="pane-scroll" tabindex="-1"></div>`);
  scroll.appendChild(content);
  readingPane.replaceChildren(scroll);
  readingPane.setAttribute("aria-label", opts?.label || "Pull request");
  readingPane.classList.add("open");
  document.body.classList.add("pane-open");
  scroller = scroll;
  syncMode();
  scroll.focus({ preventScroll: true });
  return scroll;
}

/** Close the pane (idempotent). Pass `silent` to skip the onClose callback. */
export function closePane(silent = false): void {
  if (!scroller) return;
  const hadFocus = readingPane.contains(document.activeElement);
  scroller = null;
  const cb = onCloseCb;
  onCloseCb = null;
  readingPane.classList.remove("open");
  document.body.classList.remove("pane-open");
  readingPane.setAttribute("aria-label", "Reading pane");
  renderEmpty();
  syncMode();
  if (!silent) {
    if (hadFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
    if (cb) cb();
  }
}

export function isPaneOpen(): boolean {
  return scroller != null;
}
