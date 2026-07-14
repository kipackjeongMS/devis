// Text-selection actions for the diff: pick a comment anchor from selected rows,
// read the selected code, and drive a small floating toolbar (? = ask Copilot,
// 💬 = add comment). chooseAnchor is kept dependency-free so it unit-tests under
// plain node; the rest is thin DOM glue.

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

function hideToolbar(): void {
  if (toolbar) toolbar.hidden = true;
  current = null;
}

function ensureToolbar(): HTMLElement {
  if (toolbar) return toolbar;
  const tb = document.createElement("div");
  tb.className = "sel-toolbar";
  tb.hidden = true;
  tb.innerHTML =
    '<button class="sel-btn sel-ask" title="Ask Copilot about this selection">?</button>' +
    '<button class="sel-btn sel-comment" title="Add a comment on this selection">💬</button>';
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

  // Dismiss on outside-mousedown, scroll (capture — scroll doesn't bubble), Esc.
  document.addEventListener(
    "mousedown",
    (e) => {
      if (toolbar && !toolbar.hidden && !(e.target as HTMLElement).closest(".sel-toolbar")) hideToolbar();
    },
    true
  );
  document.addEventListener("scroll", () => hideToolbar(), true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideToolbar();
  });
  return tb;
}

function positionToolbar(rect: DOMRect): void {
  const tb = ensureToolbar();
  tb.hidden = false; // must be laid out before measuring
  const gap = 8;
  const w = tb.offsetWidth;
  const h = tb.offsetHeight;
  let top = rect.top - h - gap;
  if (top < 4) top = rect.bottom + gap; // flip below if no room above
  let left = rect.left + rect.width / 2 - w / 2;
  left = Math.max(4, Math.min(left, window.innerWidth - w - 4));
  tb.style.top = top + "px";
  tb.style.left = left + "px";
}

// Show the toolbar whenever the user finishes a selection inside `tbody`.
export function installSelectionToolbar(tbody: HTMLElement, opts: ToolbarOpts): void {
  tbody.addEventListener("mouseup", () => {
    // Defer so the browser has finalized the selection.
    setTimeout(() => {
      const sel = getDiffSelection(tbody);
      if (!sel) return hideToolbar();
      const range = window.getSelection()!.getRangeAt(0);
      current = { sel, opts };
      positionToolbar(range.getBoundingClientRect());
    }, 0);
  });
}
