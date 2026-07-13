// A single slide-over modal: a full-panel overlay that slides in from the right
// over a dimming scrim, leaving the underlying view mounted (so its scroll state
// is preserved). Only one modal exists at a time. Esc, the ✕/backdrop, and a
// programmatic closeModal() all dismiss it; motion is skipped under
// prefers-reduced-motion.
import { el } from "./dom.js";

let overlay: HTMLElement | null = null;
let escHandler: ((e: KeyboardEvent) => void) | null = null;
let onCloseCb: (() => void) | null = null;

const reducedMotion = (): boolean =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Open (or replace) the modal with `content`; `onClose` fires after it closes. */
export function openModal(content: HTMLElement, opts?: { onClose?: () => void }): HTMLElement {
  closeModal(true); // replace any existing modal without firing its onClose
  onCloseCb = opts?.onClose || null;

  overlay = el(`<div class="modal-overlay" role="dialog" aria-modal="true"></div>`);
  const panel = el(`<div class="modal-panel" tabindex="-1"></div>`);
  panel.appendChild(content);
  overlay.appendChild(panel);

  // Clicking the scrim (never the panel) closes — only reachable if the panel is
  // rendered narrower than the overlay.
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeModal();
  });

  document.body.appendChild(overlay);
  document.body.classList.add("modal-open"); // scroll-lock the view behind

  escHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeModal();
  };
  document.addEventListener("keydown", escHandler);

  // Next frame so the enter transition actually runs from the off-screen state.
  requestAnimationFrame(() => overlay && overlay.classList.add("open"));
  panel.focus();
  return panel;
}

/** Close the modal (idempotent). Pass `silent` to skip the onClose callback. */
export function closeModal(silent = false): void {
  if (!overlay) return;
  const dying = overlay;
  overlay = null;
  if (escHandler) {
    document.removeEventListener("keydown", escHandler);
    escHandler = null;
  }
  document.body.classList.remove("modal-open");
  const cb = onCloseCb;
  onCloseCb = null;

  const finish = () => {
    dying.remove();
    if (!silent && cb) cb();
  };

  dying.classList.remove("open");
  if (reducedMotion()) return finish();

  let done = false;
  const onEnd = () => {
    if (done) return;
    done = true;
    dying.removeEventListener("transitionend", onEnd);
    finish();
  };
  dying.addEventListener("transitionend", onEnd);
  setTimeout(onEnd, 320); // fallback if transitionend never fires
}

/** Whether a modal is currently open. */
export function isModalOpen(): boolean {
  return overlay != null;
}
