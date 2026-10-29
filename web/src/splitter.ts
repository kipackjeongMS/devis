// A drag handle between two side-by-side panels, like the task sheet's task and chat. It sets
// the left panel's share of the width; each panel keeps a minimum, also as the window resizes
// (the host's CSS clamps the share). The share is saved per kind of view, so every task sheet
// opens split the way the last one was left. The arrow keys move it too, Home and End take it
// to either limit, and a double-click (or Enter) puts it back to the default.

const KEY = "adoPrOps.split.";

/** How far one arrow press moves the split, as a share of the width (Shift: further). */
export const SPLIT_STEP = 0.02;
export const SPLIT_STEP_LARGE = 0.1;

/** The left panel's share, within the limits that keep both panels at their minimum widths. */
export function clampShare(share: number, total: number, minLeft: number, minRight: number): number {
  if (!(total > 0)) return Math.min(1, Math.max(0, share));
  const lo = Math.min(1, minLeft / total);
  const hi = Math.max(lo, 1 - minRight / total);
  return Math.min(hi, Math.max(lo, share));
}

/** The share a key moves the split to (before clamping), or null when the key doesn't move it. */
export function shareForKey(share: number, key: string, shift: boolean): number | null {
  const step = shift ? SPLIT_STEP_LARGE : SPLIT_STEP;
  if (key === "ArrowLeft") return share - step;
  if (key === "ArrowRight") return share + step;
  if (key === "Home") return 0;
  if (key === "End") return 1;
  return null;
}

/** A saved share, if it is one. */
export function parseShare(value: string | null): number | null {
  const n = Number(value);
  return value !== null && value !== "" && Number.isFinite(n) && n > 0 && n < 1 ? n : null;
}

export function savedShare(view: string): number | null {
  try {
    return parseShare(localStorage.getItem(KEY + view));
  } catch {
    return null;
  }
}

function saveShare(view: string, share: number | null): void {
  try {
    if (share === null) localStorage.removeItem(KEY + view);
    else localStorage.setItem(KEY + view, share.toFixed(4));
  } catch {
    /* applied, just not kept */
  }
}

export interface SplitterOptions {
  /** The element holding both panels; the share is of its width. */
  container: HTMLElement;
  /** The handle (role="separator"), on the border between the panels. */
  handle: HTMLElement;
  /** The left panel, whose width is measured when nothing was set yet. */
  left: HTMLElement;
  /** Which saved split this is. */
  view: string;
  minLeft: number;
  minRight: number;
  /** Lay the panels out at `share`, or at the default when null. */
  apply(share: number | null): void;
}

/** Wire the handle. The saved share applies at once. */
export function attachSplitter(o: SplitterOptions): void {
  let share = savedShare(o.view);
  const total = (): number => o.container.clientWidth;
  // Before any drag the split is the default layout's: read it from the panel.
  const current = (): number => share ?? (total() > 0 ? o.left.getBoundingClientRect().width / o.container.getBoundingClientRect().width : 0.5);
  const set = (next: number | null, save: boolean): void => {
    share = next === null ? null : clampShare(next, total(), o.minLeft, o.minRight);
    o.apply(share);
    o.handle.setAttribute("aria-valuenow", String(Math.round(current() * 100)));
    if (save) saveShare(o.view, share);
  };
  o.handle.setAttribute("aria-valuemin", "0");
  o.handle.setAttribute("aria-valuemax", "100");
  set(share, false);

  o.handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    o.handle.setPointerCapture(e.pointerId);
    o.container.classList.add("splitting");
    // Client px are what the pointer moves in; a ratio of them is the same in any zoom.
    const box = o.container.getBoundingClientRect();
    const move = (ev: PointerEvent): void => set((ev.clientX - box.left) / box.width, false);
    const end = (): void => {
      o.handle.removeEventListener("pointermove", move);
      o.handle.removeEventListener("pointerup", end);
      o.handle.removeEventListener("pointercancel", end);
      o.container.classList.remove("splitting");
      saveShare(o.view, share);
    };
    o.handle.addEventListener("pointermove", move);
    o.handle.addEventListener("pointerup", end);
    o.handle.addEventListener("pointercancel", end);
  });
  o.handle.addEventListener("dblclick", () => set(null, true));
  o.handle.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      return set(null, true);
    }
    const next = shareForKey(current(), e.key, e.shiftKey);
    if (next === null) return;
    e.preventDefault();
    set(next, true);
  });
  o.handle.addEventListener("focus", () => o.handle.setAttribute("aria-valuenow", String(Math.round(current() * 100))));
}
