// Ctrl +/−/0 in the Workspace zoom the view you're in: Devis's chat, the overview
// rail, a Communication or Meetings drawer, a task, or History. Each view type keeps
// its own level, saved, so every task opens at the level last set on one, and the
// rest keep theirs across launches (the service's port is stable, so localStorage lasts).
//
// Which view: the topmost dialog when one is open (only if it's a zoomable view),
// else the view holding keyboard focus, else the one the pointer was last over,
// else Devis's chat. CSS zooms each view's children (see [data-zoom-view] in
// style.css), so the panes keep their place in the layout.

import { nextZoom, paneZoomCommand, zoomLevelOf, type PaneZoomCommand } from "./shellModel.js";
import { toast } from "./toast.js";

export type ZoomView = "lead" | "today" | "drawer" | "task" | "history";

const NAME: Record<ZoomView, string> = { lead: "Devis", today: "Overview", drawer: "Drawer", task: "Task view", history: "History" };
const KEY = "adoPrOps.zoom.";

export function viewZoom(view: ZoomView): number {
  try {
    return zoomLevelOf(localStorage.getItem(KEY + view));
  } catch {
    return 1;
  }
}

/** Make `el` an instance of `view`: its content takes the view's saved zoom, and later changes. */
export function zoomable(el: HTMLElement, view: ZoomView): void {
  el.dataset.zoomView = view;
  el.style.setProperty("--view-zoom", String(viewZoom(view)));
}

function apply(view: ZoomView, level: number): void {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-zoom-view="${view}"]`)) el.style.setProperty("--view-zoom", String(level));
}

/** Zoom every instance of `view` and remember it. */
export function zoomView(view: ZoomView, command: PaneZoomCommand): number {
  const level = nextZoom(viewZoom(view), command);
  try {
    if (level === 1) localStorage.removeItem(KEY + view);
    else localStorage.setItem(KEY + view, String(level));
  } catch {
    /* not saved, but still applied */
  }
  apply(view, level);
  toast(`${NAME[view]} ${Math.round(level * 100)}%`);
  return level;
}

const shown = (el: Element): boolean => el.isConnected && el.getClientRects().length > 0;
let pointed: HTMLElement | null = null;

/** The view a zoom key applies to now, or null (a dialog that isn't a view is on top). */
export function zoomTarget(): HTMLElement | null {
  const overlays = document.querySelectorAll(".ask-overlay");
  const top = overlays[overlays.length - 1];
  if (top) return top.querySelector<HTMLElement>("[data-zoom-view]");
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-zoom-view]");
  if (focused && shown(focused)) return focused;
  if (pointed && shown(pointed)) return pointed;
  const views = [...document.querySelectorAll<HTMLElement>("#jarvisView [data-zoom-view]")].filter(shown);
  return views.find((v) => v.dataset.zoomView === "lead") ?? views[0] ?? null;
}

let started = false;

/** Listen for the zoom keys while the Workspace is showing. */
export function initViewZoom(): void {
  if (started) return;
  started = true;
  document.addEventListener(
    "pointerover",
    (e) => {
      const view = (e.target as Element | null)?.closest?.<HTMLElement>("[data-zoom-view]");
      if (view) pointed = view;
    },
    { passive: true }
  );
  window.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    if (document.body.dataset.feature !== "jarvis" || document.body.dataset.page === "settings") return;
    const command = paneZoomCommand(e);
    if (!command) return;
    e.preventDefault();
    const target = zoomTarget();
    if (target) zoomView(target.dataset.zoomView as ZoomView, command);
  });
  // Another window changed a level: follow it.
  window.addEventListener("storage", (e) => {
    if (!e.key?.startsWith(KEY)) return;
    const view = e.key.slice(KEY.length) as ZoomView;
    if (view in NAME) apply(view, zoomLevelOf(e.newValue));
  });
}
