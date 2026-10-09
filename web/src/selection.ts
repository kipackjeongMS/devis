// Text-selection actions for the diff: pick a comment anchor from selected rows,
// read the selected code, and drive a small floating toolbar (Ask Copilot / add
// comment). chooseAnchor is kept DOM-free so it unit-tests under plain node; the
// rest is thin DOM glue.
import { icon } from "./icons.js";

export interface AnchorRow {
  side: string; // "left" | "right"
  line: number;
}
export interface Anchor {
  side: string;
  startLine: number;
  endLine: number;
}
export interface DiffSelection {
  anchor: Anchor;
  snippet: string;
}

// Collapse the selected rows to a single ADO-postable anchor. A diff selection
// often mixes added (right) and deleted (left) lines; we prefer the right/new
// side (what reviewers usually comment on) and span its min..max line.
export function chooseAnchor(rows: AnchorRow[]): Anchor | null {
  if (!rows.length) return null;
  const right = rows.filter((r) => r.side === "right");
  const pick = right.length ? right : rows;
  const lines = pick.map((r) => r.line);
  return { side: pick[0]!.side, startLine: Math.min(...lines), endLine: Math.max(...lines) };
}

// Read the current text selection, if it falls inside this diff body, into an
// anchor + the selected code text. Returns null when there's no usable selection.
export function getDiffSelection(tbody: HTMLElement): DiffSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!range.intersectsNode(tbody)) return null;

  const rows: AnchorRow[] = [];
  const codeLines: string[] = [];
  tbody.querySelectorAll("tr[data-line]").forEach((tr) => {
    if (!range.intersectsNode(tr)) return;
    const side = (tr as HTMLElement).dataset.side || "";
    const line = Number((tr as HTMLElement).dataset.line);
    if (!side || !Number.isFinite(line)) return;
    rows.push({ side, line });
    const code = tr.querySelector(".code");
    codeLines.push(code ? code.textContent || "" : "");
  });

  const anchor = chooseAnchor(rows);
  if (!anchor) return null;
  return { anchor, snippet: codeLines.join("\n") };
}

// ── Floating toolbar (a single shared instance) ─────────────────────────────
interface ToolbarOpts {
  onComment: (sel: DiffSelection) => void;
  onAsk: (sel: DiffSelection) => void;
}
let toolbar: HTMLElement | null = null;
let current: { sel: DiffSelection; opts: ToolbarOpts } | null = null;
let trackedTbody: HTMLElement | null = null; // diff body the shown toolbar is anchored within
let rafId = 0; // active tracking-loop handle (0 = not running)
let tbW = 0; // cached toolbar size (content is fixed, so measure once)
let tbH = 0;

function hideToolbar(): void {
  if (toolbar) toolbar.hidden = true;
  current = null;
  trackedTbody = null;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

function ensureToolbar(): HTMLElement {
  if (toolbar) return toolbar;
  const tb = document.createElement("div");
  tb.className = "sel-toolbar";
  tb.hidden = true;
  tb.innerHTML =
    '<button type="button" class="sel-btn sel-ask" title="Ask Copilot about this selection" aria-label="Ask Copilot about this selection">' +
    icon("sparkle") +
    "</button>" +
    '<button type="button" class="sel-btn sel-comment" title="Add a comment on this selection" aria-label="Add a comment on this selection">' +
    icon("chat") +
    "</button>";
  // Keep the text selection alive when the toolbar is clicked.
  tb.addEventListener("mousedown", (e) => e.preventDefault());
  tb.querySelector(".sel-ask")!.addEventListener("click", () => {
    const c = current;
    hideToolbar();
    if (c) c.opts.onAsk(c.sel);
  });
  tb.querySelector(".sel-comment")!.addEventListener("click", () => {
    const c = current;
    hideToolbar();
    if (c) c.opts.onComment(c.sel);
  });
  document.body.appendChild(tb);
  toolbar = tb;

  // Dismiss on outside-mousedown, focus-out, selection loss, or Esc. Scrolling
  // is NOT a dismiss — the tracking loop re-pins the toolbar to the selection.
  document.addEventListener(
    "mousedown",
    (e) => {
      if (toolbar && !toolbar.hidden && !(e.target as HTMLElement).closest(".sel-toolbar")) hideToolbar();
    },
    true
  );
  window.addEventListener("blur", () => hideToolbar());
  document.addEventListener("selectionchange", () => {
    if (!current || !trackedTbody || !toolbar || toolbar.hidden) return;
    const s = window.getSelection();
    if (!s || s.isCollapsed || s.rangeCount === 0 || !s.getRangeAt(0).intersectsNode(trackedTbody)) hideToolbar();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !toolbar || toolbar.hidden) return;
    e.preventDefault(); // consumed: the reading pane must not also close
    hideToolbar();
  });
  return tb;
}

// The viewport rect of the end of the current selection, if it still falls
// inside `tbody`. Uses the last client rect (end of the highlight) so the
// toolbar lands where the user finished selecting; null when there's nothing
// usable to anchor to.
function selectionRect(tbody: HTMLElement): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!range.intersectsNode(tbody)) return null;
  const rects = range.getClientRects();
  if (rects.length) return rects[rects.length - 1]!;
  const box = range.getBoundingClientRect();
  return box.width || box.height ? box : null;
}

// True once the anchor has scrolled fully outside the viewport.
function outOfView(rect: DOMRect): boolean {
  return rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth;
}

// Anchor the toolbar just below-right of the selection's end, flipping above /
// clamping to the viewport when there's no room.
function positionToolbar(rect: DOMRect): void {
  const tb = ensureToolbar();
  tb.hidden = false; // must be visible before measuring
  if (!tbW) {
    tbW = tb.offsetWidth;
    tbH = tb.offsetHeight;
  }
  const gap = 8;
  let left = rect.right + gap;
  let top = rect.bottom + gap;
  if (top + tbH + 4 > window.innerHeight) top = rect.top - tbH - gap; // flip above if no room below
  left = Math.max(4, Math.min(left, window.innerWidth - tbW - 4));
  top = Math.max(4, top);
  tb.style.top = top + "px";
  tb.style.left = left + "px";
}

// Re-pin the toolbar to the live selection each frame so it stays glued to the
// highlight through any scroll (inner container, window, or host). Self-cancels
// when the selection is gone or scrolled out of view. rAF is scroll-source
// agnostic, so it works no matter which element actually scrolled.
function startTracking(): void {
  if (rafId) cancelAnimationFrame(rafId);
  const loop = (): void => {
    if (!current || !trackedTbody || !toolbar || toolbar.hidden) {
      rafId = 0;
      return;
    }
    // Ground-truth focus-out: dismiss the moment the webview loses focus (host
    // chrome, another canvas, another window, devtools) — catches the cases the
    // window `blur` event misses in this embed.
    if (!document.hasFocus()) {
      hideToolbar();
      return;
    }
    const rect = selectionRect(trackedTbody);
    if (!rect || outOfView(rect)) {
      hideToolbar();
      return;
    }
    positionToolbar(rect);
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

// Show the toolbar whenever the user finishes a selection inside `tbody`, then
// keep it glued to the highlight via the tracking loop.
export function installSelectionToolbar(tbody: HTMLElement, opts: ToolbarOpts): void {
  tbody.addEventListener("mouseup", () => {
    // Defer so the browser has finalized the selection.
    setTimeout(() => {
      const sel = getDiffSelection(tbody);
      if (!sel) return hideToolbar();
      const rect = selectionRect(tbody);
      if (!rect) return hideToolbar();
      current = { sel, opts };
      trackedTbody = tbody;
      positionToolbar(rect);
      startTracking();
    }, 0);
  });
}
