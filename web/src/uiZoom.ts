// Ctrl +/−/0 size the whole interface, in every window. The shell (main.mts) takes the
// keys before the page sees them and tells the page they came from, so it can say so.
// In a plain browser, the browser's own zoom does the same.

import { toast } from "./toast.js";

/** Per-view sizes from before the interface had one size. */
const OLD_KEYS = "adoPrOps.zoom.";

export function initUiZoom(): void {
  window.addEventListener("devis:ui-zoom", (e) => {
    const level = Number((e as CustomEvent<unknown>).detail);
    if (Number.isFinite(level) && level > 0) toast(`Interface ${Math.round(level * 100)}%`);
  });
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(OLD_KEYS)) localStorage.removeItem(key);
  } catch {
    // Storage is off; nothing to tidy.
  }
}
