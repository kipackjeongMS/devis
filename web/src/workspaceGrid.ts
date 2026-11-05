// Puts the Workspace's panels on screen as the layout says (workspaceLayout.ts), and lets the
// user rearrange them.
//   Columns     — side by side; the panels in a column share its height and scroll on their own.
//                 Drag a panel by its grip to another place or column, or a whole column by the
//                 grip on top of it. Drag the gap between two panels or two columns to resize
//                 them; double-click it to even them out again. Alt+arrows on a panel's header
//                 (or a column's grip) move it, and the grip's menu has the same moves.
//   Edit layout — the titlebar button. The grips stay in view, a strip on the right takes a
//                 panel to a new column (four at most), and Done (or Esc) drops columns left empty.
//   Flat        — a window too narrow for the columns: Devis alone, and the sections in one list
//                 in the Overview sheet, ordered on their own.
// The panels are jarvis.ts's. They're moved, never re-rendered, so what's in them stays put.
import { el } from "./dom.js";
import { icon } from "./icons.js";
import { closeContextMenu, openContextMenu, type ContextMenuEntry } from "./contextMenu.js";
import { toast } from "./toast.js";
import {
  MAX_COLUMNS,
  MIN,
  PANEL_NAME,
  addColumn,
  cloneLayout,
  columnMin,
  columnMinHeight,
  defaultLayout,
  findPanel,
  flatOrder,
  isDefault,
  isPanelId,
  isSection,
  minWidth,
  moveColumn,
  movePanel,
  pruneEmpty,
  readLayout,
  saveLayout,
  type Column,
  type Layout,
  type PanelId,
  type Section,
} from "./workspaceLayout.js";

export interface GridHost {
  root: HTMLElement;
  /** The Overview sheet, and the list in it that holds the sections on a narrow window. */
  rail: HTMLElement;
  railScroll: HTMLElement;
  /** The status line, under the sections. */
  footer: HTMLElement;
  /** The drawer's layer: it covers Devis's column. */
  layer: HTMLElement;
  /** Where moves are announced. */
  live: HTMLElement;
  editButton: HTMLButtonElement | null;
  /** A window this narrow is always flat. */
  sheetQuery: MediaQueryList;
  folded: (id: PanelId) => boolean;
  /** The columns gave way to the flat list, or came back. */
  onFlatChange: (flat: boolean) => void;
}

/** How far the pointer goes on a grip before it's a drag rather than a click. */
const DRAG_PX = 4;
/** One arrow key on a gap between panels or columns. */
const KEY_STEP = 24;

let host: GridHost;
let layout: Layout = defaultLayout();
let flat = false;
let editing = false;
let cols: HTMLElement;
let editbar: HTMLElement;
let addcol: HTMLButtonElement;
const colPool: HTMLElement[] = [];
/** Each column's grip strip. It belongs to the column's element, so it goes where the column goes. */
const bars = new WeakMap<HTMLElement, HTMLElement>();
const slotPool: HTMLElement[] = [];
const vsashPool: HTMLElement[] = [];
const hsashPool: HTMLElement[] = [];
/** When a drag last ended: the click that follows it isn't a click on the grip. */
let dragEndedAt = 0;

const panelEl = (id: PanelId): HTMLElement => host.root.querySelector<HTMLElement>(`[data-panel="${id}"]`)!;
const isOpen = (id: PanelId): boolean => id === "devis" || !host.folded(id);
const panelMin = (id: PanelId): number => (id === "devis" ? MIN.devis : MIN.panel);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export const isFlat = (): boolean => flat;
export const isEditing = (): boolean => editing;

export function initGrid(h: GridHost): void {
  host = h;
  layout = readLayout();
  editbar = el(`<div class="jv-editbar" role="toolbar" aria-label="Edit layout" hidden>
      ${icon("layout")}<b>Editing layout</b>
      <span class="muted">${icon("grip")}Drag panels or columns by their grips</span>
      <span class="muted">· Drag the gaps to resize</span>
      <span class="muted">· Alt + arrows</span>
      <span class="jv-editbar-sp"></span>
      <button type="button" class="btn sm ghost" data-act="layout-reset">${icon("reset")}<span>Reset</span></button>
      <button type="button" class="btn sm accent" data-act="layout-done">Done</button>
    </div>`);
  cols = el('<div class="jv-cols"></div>');
  addcol = el<HTMLButtonElement>(
    `<button type="button" class="jv-addcol" data-act="layout-addcol" title="Add a column, or drop a panel here" hidden>${icon("add")}<span>New column</span></button>`
  );
  host.root.prepend(editbar, cols);

  host.root.addEventListener("pointerdown", onPointerDown);
  host.root.addEventListener("click", onClick);
  host.root.addEventListener("contextmenu", onContextMenu);
  cols.addEventListener("pointerdown", onSashDown);
  cols.addEventListener("dblclick", onSashReset);
  cols.addEventListener("keydown", onSashKey);
  cols.addEventListener("keydown", onColKey);
  host.editButton?.addEventListener("click", () => setEditing(!editing));
  host.sheetQuery.addEventListener("change", () => refresh());
  new ResizeObserver(() => refresh()).observe(host.root);
  place();
}

// ---- placing ------------------------------------------------------------------------

function computeFlat(): boolean {
  if (host.sheetQuery.matches) return true;
  const width = host.root.clientWidth;
  return width ? width < minWidth(layout) : flat;
}

/** The window changed size: switch between the columns and the flat list when it must. */
function refresh(): void {
  if (computeFlat() !== flat) place();
}

/** A section folded or unfolded: the gaps around it may stop (or start) resizing. */
export function afterFold(): void {
  if (!flat) paintSashes();
}

/** The status line goes under the rightmost column that holds a section. */
function footerColumn(l: Layout): number {
  for (let i = l.columns.length - 1; i >= 0; i--) if (l.columns[i]!.panels.some((p) => isSection(p.id))) return i;
  return l.columns.length - 1;
}

type MovableParent = HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };

/** Move `node` before `ref` in `parent`, keeping its focus and state where the browser can. */
function put(parent: HTMLElement, node: HTMLElement, ref: Element | null): void {
  const p = parent as MovableParent;
  if (typeof p.moveBefore === "function" && node.isConnected && parent.isConnected) {
    try {
      p.moveBefore(node, ref);
      return;
    } catch {
      /* not movable this way: insert it */
    }
  }
  parent.insertBefore(node, ref);
}

/** Put `want` first in `parent`, in order, moving only what's out of place. */
function order(parent: HTMLElement, want: HTMLElement[]): void {
  let prev: Element | null = null;
  for (const node of want) {
    const at: Element | null = prev ? prev.nextElementSibling : parent.firstElementChild;
    if (at !== node) put(parent, node, at);
    prev = node;
  }
}

/** Drop what `parent` holds beyond `want` (old gaps, slots and columns). */
function prune(parent: HTMLElement, want: HTMLElement[]): void {
  const keep = new Set<Element>(want);
  for (const child of [...parent.children]) if (!keep.has(child)) child.remove();
}

/** Focus and scroll positions, so a move doesn't lose the user's place. */
function keepView(): () => void {
  const active = document.activeElement instanceof HTMLElement && host.root.contains(document.activeElement) ? document.activeElement : null;
  const scrolled = [...host.root.querySelectorAll<HTMLElement>(".rs-b, .chat-log, .jv-rscroll, .jv-dbody")]
    .filter((e) => e.scrollTop > 0)
    .map((e) => [e, e.scrollTop] as const);
  return () => {
    for (const [e, top] of scrolled) if (e.scrollTop !== top) e.scrollTop = top;
    if (active?.isConnected && document.activeElement !== active) active.focus({ preventScroll: true });
  };
}

function vsash(i: number): HTMLElement {
  const sash = (vsashPool[i] ??= el(
    '<div class="jv-vsash" role="separator" aria-orientation="vertical" tabindex="0" title="Drag to resize · double-click to even out"></div>'
  ));
  sash.dataset.sash = String(i);
  sash.setAttribute("aria-label", `Resize columns ${i + 1} and ${i + 2}`);
  return sash;
}

function hsash(n: number, col: number, row: number): HTMLElement {
  const sash = (hsashPool[n] ??= el(
    '<div class="jv-hsash" role="separator" aria-orientation="horizontal" tabindex="0" title="Drag to resize · double-click to even out"></div>'
  ));
  sash.dataset.col = String(col);
  sash.dataset.row = String(row);
  return sash;
}

/** What a column is called: by Devis when it's there, else by its first panel. */
function columnName(c: Column, i: number): string {
  if (c.panels.some((p) => p.id === "devis")) return "Devis's column";
  const [first, ...rest] = c.panels;
  if (!first) return `column ${i + 1}`;
  return `the column with ${PANEL_NAME[first.id]}${rest.length ? ` and ${rest.length} more` : ""}`;
}

/** The strip on top of column `col`, with the grip that moves the whole column. */
function colbar(col: HTMLElement, i: number, c: Column): HTMLElement {
  let bar = bars.get(col);
  if (!bar) {
    bar = el(
      `<div class="jv-colbar"><button type="button" class="jv-colgrip" data-act="col-move" aria-haspopup="menu" title="Drag to move this column · Alt+arrows">${icon("grip")}</button></div>`
    );
    bars.set(col, bar);
  }
  const grip = bar.firstElementChild as HTMLButtonElement;
  grip.dataset.col = String(i);
  grip.hidden = layout.columns.length < 2;
  grip.setAttribute("aria-label", `Move ${columnName(c, i)}`);
  return bar;
}

/**
 * Lay the panels out as `layout` says, or flat when the window is too narrow for it.
 * Columns, gaps and slots come from pools; the panels move into place.
 */
export function place(): void {
  if (!host) return;
  const nextFlat = computeFlat();
  if (nextFlat !== flat) {
    flat = nextFlat;
    if (flat && editing) applyEditing(false);
    host.root.classList.toggle("flat", flat);
    if (host.editButton) host.editButton.hidden = flat;
    host.onFlatChange(flat);
  }
  const restore = keepView();
  const shown = flat ? [{ w: null, panels: [{ id: "devis" as PanelId }] }] : layout.columns;
  const measured = !flat && shown.every((c) => c.w !== null);
  cols.classList.toggle("measured", measured);

  const top: HTMLElement[] = [];
  shown.forEach((_, i) => {
    if (i) top.push(vsash(i - 1));
    top.push((colPool[i] ??= el('<div class="jv-col"></div>')));
  });
  if (!flat) top.push(addcol);
  order(cols, top);

  const footCol = flat ? -1 : footerColumn(layout);
  const inCols: Array<[HTMLElement, HTMLElement[]]> = [];
  let n = 0;
  shown.forEach((c, i) => {
    const col = colPool[i]!;
    col.dataset.col = String(i);
    if (measured) col.style.setProperty("--w", String(c.w));
    else col.style.removeProperty("--w");
    const devis = c.panels.some((p) => p.id === "devis");
    col.classList.toggle("has-devis", devis);
    col.classList.toggle("sized", c.panels.some((p) => p.g !== undefined));
    const kids: HTMLElement[] = flat ? [] : [colbar(col, i, c)];
    c.panels.forEach((p, j) => {
      if (j) kids.push(hsash(n++, i, j));
      const pe = panelEl(p.id);
      if (p.g === undefined) pe.style.removeProperty("--g");
      else pe.style.setProperty("--g", String(p.g));
      kids.push(pe);
    });
    if (!c.panels.length) kids.push((slotPool[i] ??= el('<div class="jv-slot">Drag a panel here</div>')));
    if (devis) kids.push(host.layer);
    if (i === footCol) kids.push(host.footer);
    order(col, kids);
    inCols.push([col, kids]);
  });
  const sheet = flat ? flatOrder(layout).map(panelEl) : [];
  order(host.railScroll, sheet);
  if (flat && host.footer.parentElement !== host.rail) host.rail.append(host.footer);

  // Everything is where it goes; what's left over is old gaps, slots and columns.
  prune(cols, top);
  for (const [col, kids] of inCols) prune(col, kids);
  prune(host.railScroll, sheet);

  addcol.hidden = !(editing && layout.columns.length < MAX_COLUMNS);
  paintSashes();
  restore();
}

/** Gaps with no open panel on one side have nothing to resize. */
function paintSashes(): void {
  layout.columns.forEach((c, ci) => {
    c.panels.forEach((p, row) => {
      if (!row) return;
      const sash = cols.querySelector<HTMLElement>(`.jv-hsash[data-col="${ci}"][data-row="${row}"]`);
      if (!sash) return;
      const above = c.panels.slice(0, row).reverse().find((s) => isOpen(s.id));
      const below = c.panels.slice(row).find((s) => isOpen(s.id));
      const inert = !above || !below;
      sash.classList.toggle("inert", inert);
      sash.tabIndex = inert ? -1 : 0;
      sash.setAttribute("aria-label", `Resize ${PANEL_NAME[c.panels[row - 1]!.id]} and ${PANEL_NAME[p.id]}`);
    });
  });
}

/** Paint the widths and heights in `layout` without moving anything (a resize in progress). */
function paintSizes(): void {
  const measured = layout.columns.every((c) => c.w !== null);
  cols.classList.toggle("measured", measured);
  layout.columns.forEach((c, i) => {
    const col = colPool[i];
    if (!col) return;
    if (measured) col.style.setProperty("--w", String(c.w));
    else col.style.removeProperty("--w");
    col.classList.toggle("sized", c.panels.some((p) => p.g !== undefined));
    for (const p of c.panels) {
      const pe = panelEl(p.id);
      if (p.g === undefined) pe.style.removeProperty("--g");
      else pe.style.setProperty("--g", String(p.g));
    }
  });
}

// ---- moving -------------------------------------------------------------------------

function announce(text: string): void {
  host.live.textContent = "";
  host.live.textContent = text;
}

function announceMove(id: PanelId): void {
  if (flat && isSection(id)) {
    const list = flatOrder(layout);
    return announce(`${PANEL_NAME[id]} moved to ${list.indexOf(id) + 1} of ${list.length}.`);
  }
  const at = findPanel(layout, id);
  if (!at) return;
  const n = layout.columns[at.col]!.panels.length;
  announce(`${PANEL_NAME[id]} moved to column ${at.col + 1}, position ${at.row + 1} of ${n}.`);
}

function refuse(id: PanelId): void {
  const text = `No room for ${PANEL_NAME[id]} there.`;
  toast(text, "err");
  announce(text);
}

/** The space the columns get for their panels, under the grip strips and over the bottom padding. */
const columnsHeight = (): number => cols.clientHeight - MIN.pad - MIN.bar;

/**
 * Whether `next` fits the window: every column at its narrowest side by side, and, when a
 * panel joins another column, that column's panels at their least height.
 */
function fits(next: Layout, id: PanelId, crossing: boolean): boolean {
  if (minWidth(next) > host.root.clientWidth) return false;
  if (!crossing) return true;
  const at = findPanel(next, id);
  if (!at) return false;
  const foot = footerColumn(next) === at.col ? host.footer.offsetHeight : 0;
  return columnMinHeight(next.columns[at.col]!, host.folded) + foot <= columnsHeight();
}

function commit(next: Layout, id?: PanelId): void {
  layout = next;
  saveLayout(layout);
  place();
  if (id) announceMove(id);
}

/** Move a panel to column `col`, `row`th from the top, if there's room for it. */
function tryMove(id: PanelId, col: number, row: number): boolean {
  const from = findPanel(layout, id);
  if (!from) return false;
  let next = movePanel(layout, id, col, row);
  if (!editing) next = pruneEmpty(next);
  if (!fits(next, id, col !== from.col)) {
    refuse(id);
    return false;
  }
  commit(next, id);
  return true;
}

/** Move a section in the flat list so it ends up `to`th from the top. */
function moveFlat(id: Section, to: number): void {
  const list = flatOrder(layout);
  const rest = list.filter((s) => s !== id);
  const at = clamp(to, 0, rest.length);
  if (at === list.indexOf(id)) return;
  rest.splice(at, 0, id);
  commit({ ...cloneLayout(layout), flat: rest }, id);
  panelEl(id).scrollIntoView({ block: "nearest" });
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Move column `from` so it's `to`th from the left, its panels and width with it. Its element
 * goes too (the pools shuffle the same way), so nothing in it is re-placed and its grip keeps focus.
 */
function shiftColumn(from: number, to: number): boolean {
  const count = layout.columns.length;
  const at = clamp(to, 0, count - 1);
  if (from === at || from < 0 || from >= count) return false;
  const name = columnName(layout.columns[from]!, from);
  const next = moveColumn(layout, from, at);
  const foot = footerColumn(next);
  if (foot !== footerColumn(layout) && columnMinHeight(next.columns[foot]!, host.folded) + host.footer.offsetHeight > columnsHeight()) {
    const text = "No room for the status line under that column.";
    toast(text, "err");
    announce(text);
    return false;
  }
  const [col] = colPool.splice(from, 1);
  colPool.splice(at, 0, col!);
  commit(next);
  announce(`${capital(name)} moved to position ${at + 1} of ${count}.`);
  return true;
}

/** Alt+Left and Alt+Right on a column's grip. */
function onColKey(e: KeyboardEvent): void {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
  const grip = (e.target as HTMLElement).closest<HTMLElement>(".jv-colgrip");
  if (!grip || flat) return;
  e.preventDefault();
  const i = Number(grip.dataset.col);
  shiftColumn(i, i + (e.key === "ArrowLeft" ? -1 : 1));
}

/** A column grip's menu: the moves a drag makes. */
function columnMenu(i: number, x: number, y: number, anchor: HTMLElement): void {
  const count = layout.columns.length;
  const c = layout.columns[i];
  if (!c || flat) return;
  const entries: ContextMenuEntry[] = [];
  if (i > 0) entries.push({ label: "Move left", icon: "left", run: () => void shiftColumn(i, i - 1) });
  if (i < count - 1) entries.push({ label: "Move right", icon: "right", run: () => void shiftColumn(i, i + 1) });
  if (i > 1) entries.push({ label: "Move to the far left", run: () => void shiftColumn(i, 0) });
  if (i < count - 2) entries.push({ label: "Move to the far right", run: () => void shiftColumn(i, count - 1) });
  if (!editing) entries.push({ label: "Edit layout", icon: "layout", run: () => setEditing(true) });
  if (!isDefault(layout)) entries.push({ label: "Reset layout", icon: "reset", run: resetLayout });
  openContextMenu(x, y, `Move ${columnName(c, i)}`, entries, () => anchor.isConnected && anchor.focus({ preventScroll: true }));
}

/**
 * Alt+arrows on a panel's header: up and down within its column (or the flat list), left and
 * right to the next column, at the same height. True when the key was the grid's.
 */
export function keyMove(id: PanelId, key: string): boolean {
  if (flat) {
    if (!isSection(id) || (key !== "ArrowUp" && key !== "ArrowDown")) return false;
    moveFlat(id, flatOrder(layout).indexOf(id) + (key === "ArrowUp" ? -1 : 1));
    return true;
  }
  const at = findPanel(layout, id);
  if (!at) return false;
  const count = layout.columns.length;
  const len = layout.columns[at.col]!.panels.length;
  switch (key) {
    case "ArrowUp":
      if (at.row > 0) tryMove(id, at.col, at.row - 1);
      return true;
    case "ArrowDown":
      if (at.row < len - 1) tryMove(id, at.col, at.row + 1);
      return true;
    case "ArrowLeft":
    case "ArrowRight": {
      const to = at.col + (key === "ArrowLeft" ? -1 : 1);
      if (to >= 0 && to < count) tryMove(id, to, Math.min(at.row, layout.columns[to]!.panels.length));
      return true;
    }
  }
  return false;
}

/** The grip's menu: the moves a drag makes, for the keyboard, touch and anyone who'd rather not drag. */
export function panelMenu(id: PanelId, x: number, y: number, anchor: HTMLElement): void {
  const entries: ContextMenuEntry[] = [];
  if (flat) {
    if (!isSection(id)) return;
    const list = flatOrder(layout);
    const at = list.indexOf(id);
    const last = list.length - 1;
    if (at > 0) entries.push({ label: "Move up", icon: "up", run: () => moveFlat(id, at - 1) });
    if (at < last) entries.push({ label: "Move down", icon: "down", run: () => moveFlat(id, at + 1) });
    if (at > 1) entries.push({ label: "Move to the top", run: () => moveFlat(id, 0) });
    if (at < last - 1) entries.push({ label: "Move to the bottom", run: () => moveFlat(id, last) });
    if (layout.flat) {
      entries.push({
        label: "Reset the order",
        icon: "reset",
        run: () => {
          const next = cloneLayout(layout);
          delete next.flat;
          commit(next, id);
        },
      });
    }
  } else {
    const at = findPanel(layout, id);
    if (!at) return;
    const len = layout.columns[at.col]!.panels.length;
    if (at.row > 0) entries.push({ label: "Move up", icon: "up", run: () => void tryMove(id, at.col, at.row - 1) });
    if (at.row < len - 1) entries.push({ label: "Move down", icon: "down", run: () => void tryMove(id, at.col, at.row + 1) });
    layout.columns.forEach((c, i) => {
      if (i !== at.col) entries.push({ label: `Move to column ${i + 1}`, icon: "col", run: () => void tryMove(id, i, c.panels.length) });
    });
    if (editing && layout.columns.length < MAX_COLUMNS && len > 1) {
      entries.push({ label: "Move to a new column", icon: "add", run: () => void tryMove(id, layout.columns.length, 0) });
    }
    if (!editing) entries.push({ label: "Edit layout", icon: "layout", run: () => setEditing(true) });
    if (!isDefault(layout)) entries.push({ label: "Reset layout", icon: "reset", run: resetLayout });
  }
  openContextMenu(x, y, `Move ${PANEL_NAME[id]}`, entries, () => anchor.isConnected && anchor.focus({ preventScroll: true }));
}

export function resetLayout(): void {
  commit(defaultLayout());
  announce("Layout reset.");
}

/** The Workspace closed: leave edit mode, keeping what was done. */
export function hideGrid(): void {
  if (host && editing) {
    applyEditing(false);
    place();
  }
}

// ---- edit mode ----------------------------------------------------------------------

function onEditKey(e: KeyboardEvent): void {
  if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
  const t = e.target as HTMLElement | null;
  const typing = (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && !!t.value;
  if (typing || t?.isContentEditable || t?.closest(".ask-overlay, .ctx-menu")) return;
  e.preventDefault();
  setEditing(false);
}

function applyEditing(on: boolean): void {
  editing = on;
  host.root.classList.toggle("editing", on);
  editbar.hidden = !on;
  host.editButton?.setAttribute("aria-pressed", String(on));
  host.editButton?.classList.toggle("on", on);
  if (on) document.addEventListener("keydown", onEditKey);
  else {
    document.removeEventListener("keydown", onEditKey);
    layout = pruneEmpty(layout);
    saveLayout(layout);
  }
}

/** Edit layout: the grips stay in view and the strip on the right makes new columns. */
export function setEditing(on: boolean): void {
  if (!host || on === editing || (on && flat)) return;
  applyEditing(on);
  place();
  if (on) editbar.querySelector<HTMLElement>('[data-act="layout-done"]')?.focus({ preventScroll: true });
  announce(on ? "Editing the layout. Drag panels by their grips. Escape or Done when finished." : "Layout saved.");
}

function addEmptyColumn(): void {
  const next = addColumn(layout);
  if (next.columns.length === layout.columns.length) return;
  if (minWidth(next) > host.root.clientWidth) {
    toast("No room for another column at this window size.", "err");
    return announce("No room for another column.");
  }
  commit(next);
  announce(`Column ${next.columns.length} added. Drag a panel into it.`);
}

// ---- pointer and keyboard -----------------------------------------------------------

function onClick(e: MouseEvent): void {
  const node = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
  switch (node?.dataset.act) {
    case "layout-done":
      return setEditing(false);
    case "layout-reset":
      return resetLayout();
    case "layout-addcol":
      return addEmptyColumn();
    case "pn-move": {
      const id = node.closest<HTMLElement>("[data-panel]")?.dataset.panel;
      if (!isPanelId(id) || performance.now() - dragEndedAt < 400) return;
      const r = node.getBoundingClientRect();
      return panelMenu(id, r.left, r.bottom + 4, node);
    }
    case "col-move": {
      if (flat || performance.now() - dragEndedAt < 400) return;
      const r = node.getBoundingClientRect();
      return columnMenu(Number(node.dataset.col), r.left, r.bottom + 4, node);
    }
  }
}

/** A right-click on a section's header (or a grip) opens the grip's menu. */
function onContextMenu(e: MouseEvent): void {
  const t = e.target as HTMLElement;
  const bar = t.closest<HTMLElement>(".jv-colbar");
  if (bar) {
    const grip = bar.querySelector<HTMLElement>(".jv-colgrip");
    if (flat || !grip || grip.hidden) return;
    e.preventDefault();
    return columnMenu(Number(grip.dataset.col), e.clientX, e.clientY, grip);
  }
  const head = t.closest<HTMLElement>(".rs-h, .pn-grip");
  const box = head?.closest<HTMLElement>("[data-panel]");
  const id = box?.dataset.panel;
  if (!head || !box || !isPanelId(id) || t.closest("select")) return;
  e.preventDefault();
  panelMenu(id, e.clientX, e.clientY, box.querySelector<HTMLElement>(".pn-grip") ?? head);
}

function onPointerDown(e: PointerEvent): void {
  const colGrip = (e.target as HTMLElement).closest<HTMLElement>(".jv-colgrip");
  if (colGrip) {
    if (!flat && e.button === 0) dragColumn(e, colGrip, Number(colGrip.dataset.col));
    return;
  }
  const grip = (e.target as HTMLElement).closest<HTMLElement>(".pn-grip");
  const box = grip?.closest<HTMLElement>("[data-panel]");
  const id = box?.dataset.panel;
  if (!grip || !box || !isPanelId(id) || e.button !== 0) return;
  if (flat) {
    if (isSection(id)) dragFlat(e, grip, box, id);
  } else dragColumns(e, grip, box, id);
}

/** Follow a grip's pointer until it lets go; Esc cancels. `start` runs once it's a drag. */
function track(
  e: PointerEvent,
  grip: HTMLElement,
  hooks: { start: () => void; move: (x: number, y: number) => void; end: (commit: boolean) => void }
): void {
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  const sx = e.clientX;
  const sy = e.clientY;
  let dragging = false;
  const move = (ev: PointerEvent): void => {
    if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) >= DRAG_PX) {
      dragging = true;
      closeContextMenu();
      hooks.start();
    }
    if (dragging) hooks.move(ev.clientX, ev.clientY);
  };
  const finish = (commit: boolean): void => {
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", up);
    grip.removeEventListener("pointercancel", cancel);
    document.removeEventListener("keydown", onKey, true);
    if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
    if (!dragging) return;
    dragEndedAt = performance.now();
    hooks.end(commit);
  };
  const up = (): void => finish(true);
  const cancel = (): void => finish(false);
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== "Escape" || !dragging) return;
    ev.preventDefault();
    ev.stopPropagation();
    finish(false);
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
  grip.addEventListener("pointercancel", cancel);
  document.addEventListener("keydown", onKey, true);
}

interface Target {
  next: Layout;
  ok: boolean;
  noop: boolean;
}

/**
 * Drag a panel among the columns. A line shows where it lands (amber where there's no room),
 * and, while editing, the strip on the right takes it to a new column.
 */
function dragColumns(e: PointerEvent, grip: HTMLElement, box: HTMLElement, id: PanelId): void {
  let ghost: HTMLElement | null = null;
  let line: HTMLElement | null = null;
  let target: Target | null = null;
  let hot: HTMLElement | null = null;
  const setHot = (node: HTMLElement | null): void => {
    if (hot === node) return;
    hot?.classList.remove("hot");
    hot = node;
    hot?.classList.add("hot");
  };

  const aim = (x: number, y: number): void => {
    ghost!.style.transform = `translate(${x + 12}px, ${y - 14}px) rotate(-1.2deg)`;
    const from = findPanel(layout, id)!;
    const count = layout.columns.length;
    let col = -1;
    if (!addcol.hidden) {
      const r = addcol.getBoundingClientRect();
      if (x >= r.left - MIN.sash && y >= r.top && y <= r.bottom) col = count;
    }
    const colEls = colPool.slice(0, count);
    if (col < 0) {
      let best = Infinity;
      colEls.forEach((c, i) => {
        const r = c.getBoundingClientRect();
        const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
        if (d < best) [best, col] = [d, i];
      });
    }
    const crossing = col !== from.col;
    let row = 0;
    const box2 = cols.getBoundingClientRect();
    if (col < count) {
      const others = layout.columns[col]!.panels.filter((p) => p.id !== id).map((p) => panelEl(p.id).getBoundingClientRect());
      const i = others.findIndex((r) => y < r.top + r.height / 2);
      row = i < 0 ? others.length : i;
      const cr = colEls[col]!.getBoundingClientRect();
      if (others.length) {
        const gap = row < others.length ? others[row]!.top - MIN.sash / 2 : others[others.length - 1]!.bottom + MIN.sash / 2;
        line!.style.top = `${gap - box2.top}px`;
        line!.style.left = `${cr.left - box2.left}px`;
        line!.style.width = `${cr.width}px`;
        setHot(null);
      } else setHot(slotPool[col] ?? null);
      line!.hidden = !others.length || (!crossing && row === from.row);
    } else {
      setHot(addcol);
      line!.hidden = true;
    }
    const noop = !crossing && row === from.row;
    let next = movePanel(layout, id, col, row);
    if (!editing) next = pruneEmpty(next);
    const ok = noop || fits(next, id, crossing);
    line!.classList.toggle("no", !ok);
    hot?.classList.toggle("no", !ok);
    target = { next, ok, noop };
  };

  track(e, grip, {
    start: () => {
      box.classList.add("pn-lifted");
      host.root.classList.add("pn-sorting");
      ghost = el(`<div class="pn-ghost" aria-hidden="true">${icon("grip")}<span>${PANEL_NAME[id]}</span></div>`);
      document.body.append(ghost);
      line = el('<div class="jv-drop" aria-hidden="true" hidden></div>');
      cols.append(line);
    },
    move: aim,
    end: (commit) => {
      ghost?.remove();
      line?.remove();
      hot?.classList.remove("hot", "no");
      box.classList.remove("pn-lifted");
      host.root.classList.remove("pn-sorting");
      if (!commit || !target || target.noop) return;
      if (!target.ok) return refuse(id);
      layout = target.next;
      saveLayout(layout);
      place();
      announceMove(id);
    },
  });
}

/** What the ghost says while a column is dragged: Devis, or its first panels. */
function columnLabel(c: Column): string {
  if (c.panels.some((p) => p.id === "devis")) return "Devis's column";
  if (!c.panels.length) return "Empty column";
  const names = c.panels.slice(0, 2).map((p) => PANEL_NAME[p.id]);
  return names.join(", ") + (c.panels.length > 2 ? ` +${c.panels.length - 2}` : "");
}

/** Drag a whole column sideways. A line between the other columns shows where it lands. */
function dragColumn(e: PointerEvent, grip: HTMLElement, from: number): void {
  const colEl = colPool[from];
  const c = layout.columns[from];
  if (!colEl || !c || layout.columns.length < 2) return;
  let ghost: HTMLElement | null = null;
  let line: HTMLElement | null = null;
  let to = from;
  track(e, grip, {
    start: () => {
      colEl.classList.add("col-lifted");
      host.root.classList.add("pn-sorting");
      ghost = el(`<div class="pn-ghost" aria-hidden="true">${icon("col")}<span></span></div>`);
      ghost.querySelector("span")!.textContent = columnLabel(c);
      document.body.append(ghost);
      line = el('<div class="jv-drop v" aria-hidden="true" hidden></div>');
      cols.append(line);
    },
    move: (x, y) => {
      ghost!.style.transform = `translate(${x + 12}px, ${y - 14}px) rotate(-1.2deg)`;
      const others = colPool
        .slice(0, layout.columns.length)
        .filter((_, i) => i !== from)
        .map((node) => node.getBoundingClientRect());
      const i = others.findIndex((r) => x < r.left + r.width / 2);
      to = i < 0 ? others.length : i;
      const box = cols.getBoundingClientRect();
      const self = colEl.getBoundingClientRect();
      const gap = to < others.length ? others[to]!.left - MIN.sash / 2 : others[others.length - 1]!.right + MIN.sash / 2;
      line!.style.left = `${gap - box.left}px`;
      line!.style.top = `${self.top - box.top}px`;
      line!.style.height = `${self.height}px`;
      line!.hidden = to === from;
    },
    end: (commit) => {
      ghost?.remove();
      line?.remove();
      colEl.classList.remove("col-lifted");
      host.root.classList.remove("pn-sorting");
      if (commit && to !== from) shiftColumn(from, to);
    },
  });
}

/** Drag a section up or down the flat list. The list scrolls when the pointer nears its edge. */
function dragFlat(e: PointerEvent, grip: HTMLElement, box: HTMLElement, id: Section): void {
  const scroll = host.railScroll;
  let y = e.clientY;
  let to = -1;
  let frame = 0;
  let line: HTMLElement | null = null;
  const aim = (): void => {
    const others = [...scroll.querySelectorAll<HTMLElement>(":scope > .pn")].filter((b) => b !== box);
    const rects = others.map((b) => b.getBoundingClientRect());
    const i = rects.findIndex((r) => y < r.top + r.height / 2);
    to = i < 0 ? others.length : i;
    if (!rects.length) return;
    const gap = to < rects.length ? rects[to]!.top - MIN.sash / 2 : rects[rects.length - 1]!.bottom + MIN.sash / 2;
    line!.style.top = `${gap - scroll.getBoundingClientRect().top + scroll.scrollTop - 1}px`;
    line!.hidden = to === flatOrder(layout).indexOf(id);
  };
  const edgeScroll = (): void => {
    const r = scroll.getBoundingClientRect();
    const edge = 40;
    const over = y < r.top + edge ? y - (r.top + edge) : y > r.bottom - edge ? y - (r.bottom - edge) : 0;
    if (over) {
      scroll.scrollTop += clamp(over / 2, -18, 18);
      aim();
    }
    frame = requestAnimationFrame(edgeScroll);
  };
  track(e, grip, {
    start: () => {
      box.classList.add("pn-lifted");
      scroll.classList.add("pn-sorting");
      line = el('<div class="rs-drop" aria-hidden="true"></div>');
      scroll.appendChild(line);
      frame = requestAnimationFrame(edgeScroll);
    },
    move: (_x, py) => {
      y = py;
      aim();
    },
    end: (commit) => {
      cancelAnimationFrame(frame);
      line?.remove();
      box.classList.remove("pn-lifted");
      scroll.classList.remove("pn-sorting");
      if (commit && to >= 0) moveFlat(id, to);
    },
  });
}

// ---- resizing -----------------------------------------------------------------------

/** Start resizing the two columns either side of gap `i`; the result moves the gap by dx px. */
function beginWidth(i: number): (dx: number) => void {
  const count = layout.columns.length;
  const widths = colPool.slice(0, count).map((c) => c.getBoundingClientRect().width);
  const total = widths.reduce((s, w) => s + w, 0);
  const a = widths[i]!;
  const b = widths[i + 1]!;
  const minA = columnMin(layout.columns[i]!);
  const minB = columnMin(layout.columns[i + 1]!);
  return (dx) => {
    if (!(total > 0)) return;
    const na = clamp(a + dx, minA, Math.max(minA, a + b - minB));
    const next = [...widths];
    next[i] = na;
    next[i + 1] = a + b - na;
    layout.columns.forEach((c, k) => (c.w = next[k]! / total));
    paintSizes();
  };
}

/** Start resizing the open panels either side of a gap in a column; the result moves it by dy px. */
function beginHeight(ci: number, row: number): ((dy: number) => void) | null {
  const panels = layout.columns[ci]?.panels;
  if (!panels) return null;
  let ai = -1;
  for (let k = row - 1; k >= 0 && ai < 0; k--) if (isOpen(panels[k]!.id)) ai = k;
  const bi = panels.findIndex((p, k) => k >= row && isOpen(p.id));
  if (ai < 0 || bi < 0) return null;
  // The column's panels fit their content until now: keep each one's height as its share.
  const open = panels.filter((p) => isOpen(p.id));
  if (open.some((p) => p.g === undefined)) {
    const hs = open.map((p) => panelEl(p.id).getBoundingClientRect().height);
    const mean = hs.reduce((s, h) => s + h, 0) / hs.length;
    if (mean > 0) open.forEach((p, k) => (p.g = hs[k]! / mean));
  }
  const A = panels[ai]!;
  const B = panels[bi]!;
  const ha = panelEl(A.id).getBoundingClientRect().height;
  const hb = panelEl(B.id).getBoundingClientRect().height;
  const sum = (A.g ?? 1) + (B.g ?? 1);
  // On a short window the two may already be under their minimums; scale those down to fit.
  const fit = Math.min(1, (ha + hb) / (panelMin(A.id) + panelMin(B.id)));
  const minA = panelMin(A.id) * fit;
  const minB = panelMin(B.id) * fit;
  return (dy) => {
    if (!(ha + hb > 0)) return;
    const na = clamp(ha + dy, minA, ha + hb - minB);
    A.g = (sum * na) / (ha + hb);
    B.g = sum - A.g;
    paintSizes();
  };
}

function onSashDown(e: PointerEvent): void {
  const sash = (e.target as HTMLElement).closest<HTMLElement>(".jv-vsash, .jv-hsash");
  if (!sash || e.button !== 0 || sash.classList.contains("inert")) return;
  const vertical = sash.classList.contains("jv-vsash");
  const apply = vertical ? beginWidth(Number(sash.dataset.sash)) : beginHeight(Number(sash.dataset.col), Number(sash.dataset.row));
  if (!apply) return;
  e.preventDefault();
  sash.setPointerCapture(e.pointerId);
  sash.classList.add("hot");
  host.root.classList.add(vertical ? "sizing-x" : "sizing-y");
  const sx = e.clientX;
  const sy = e.clientY;
  const move = (ev: PointerEvent): void => apply(vertical ? ev.clientX - sx : ev.clientY - sy);
  const up = (): void => {
    sash.removeEventListener("pointermove", move);
    sash.removeEventListener("pointerup", up);
    sash.removeEventListener("pointercancel", up);
    sash.classList.remove("hot");
    host.root.classList.remove("sizing-x", "sizing-y");
    saveLayout(layout);
  };
  sash.addEventListener("pointermove", move);
  sash.addEventListener("pointerup", up);
  sash.addEventListener("pointercancel", up);
}

/** Double-click a gap: the columns share alike again, or the panels in that column fit their content. */
function onSashReset(e: MouseEvent): void {
  const sash = (e.target as HTMLElement).closest<HTMLElement>(".jv-vsash, .jv-hsash");
  if (!sash || sash.classList.contains("inert")) return;
  if (sash.classList.contains("jv-vsash")) {
    for (const c of layout.columns) c.w = null;
    announce("Column widths reset.");
  } else {
    const c = layout.columns[Number(sash.dataset.col)];
    if (!c) return;
    for (const p of c.panels) delete p.g;
    announce("Panel heights in this column reset.");
  }
  paintSizes();
  saveLayout(layout);
}

function onSashKey(e: KeyboardEvent): void {
  const sash = (e.target as HTMLElement).closest<HTMLElement>(".jv-vsash, .jv-hsash");
  if (!sash) return;
  if (e.key === "Enter") {
    e.preventDefault();
    return onSashReset(e as unknown as MouseEvent);
  }
  const vertical = sash.classList.contains("jv-vsash");
  const step = vertical
    ? e.key === "ArrowLeft" ? -KEY_STEP : e.key === "ArrowRight" ? KEY_STEP : 0
    : e.key === "ArrowUp" ? -KEY_STEP : e.key === "ArrowDown" ? KEY_STEP : 0;
  if (!step) return;
  e.preventDefault();
  e.stopPropagation();
  const apply = vertical ? beginWidth(Number(sash.dataset.sash)) : beginHeight(Number(sash.dataset.col), Number(sash.dataset.row));
  apply?.(step);
  saveLayout(layout);
}
