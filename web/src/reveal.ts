// Jumping from a summary row to the real comment in the diff. Changed files are
// collapsed with lazily-loaded diffs, so revealing a finding has to expand its
// file and wait for the diff before the anchored card exists to scroll to.
import type { Finding } from "./types.js";

/** A `.file` box that can expand and lazy-load its diff on demand (see diff.ts). */
export interface RevealableFile extends HTMLElement {
  _ensureOpen?: () => Promise<void>;
}

const reducedMotion = (): boolean =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function flash(target: HTMLElement): void {
  target.classList.remove("reveal-flash");
  void target.offsetWidth; // reflow, so the animation restarts if it is already running
  target.classList.add("reveal-flash");
  setTimeout(() => target.classList.remove("reveal-flash"), 1800);
}

/**
 * Scroll to the staged card for `finding`, expanding (and loading) its file
 * first. Falls back to the anchored diff row when the card is gone — a posted
 * finding has been replaced by a real thread at the same line. Returns false
 * when the file isn't on the page at all.
 */
export async function revealFinding(finding: Finding): Promise<boolean> {
  if (!finding.file) return false;
  const box = document.querySelector<RevealableFile>(
    `.file[data-path="${CSS.escape(finding.file)}"]`
  );
  if (!box) return false;
  if (box._ensureOpen) await box._ensureOpen();
  if (!box.isConnected) return false; // the detail modal closed while the diff loaded

  const anchored =
    (finding.id &&
      box.querySelector<HTMLElement>(`[data-finding-id="${CSS.escape(String(finding.id))}"]`)) ||
    (finding.line != null
      ? box.querySelector<HTMLElement>(
          `tr[data-line="${CSS.escape(String(finding.line))}"]` +
            `[data-side="${CSS.escape(finding.side || "right")}"]`
        )
      : null);

  const target = anchored || box;
  target.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
  flash(target);
  return true;
}
