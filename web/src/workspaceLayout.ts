// The Workspace's layout: which panels sit in which column, in what order, and how much room
// each gets. Pure data, no DOM: workspaceGrid.ts puts it on screen and jarvis.ts owns the panels.
//   Columns  — one to four, side by side. `w` is a column's share of the width (the default sets
//              them, and dragging a border between columns changes them); null leaves the widths
//              to CSS. A column moves as a whole, its panels and width going with it.
//   Panels   — Devis (always there, exactly once) and the seven sections. In a column, open panels
//              share the height by `g` (a flex-grow, 1 when unset).
//   Flat     — a window too narrow for the columns shows Devis alone and the sections in one
//              list behind the Overview button. `flat` is that list's order once the user moves
//              something there; until then it reads the columns left to right, top to bottom.
// Kept per device in localStorage. The first read takes over the rail's order and the
// Devis/rail split that step 1 saved, then drops those keys. A section new since the layout
// was saved goes in under the section before it, so Pull Requests lands under Tasks.
import { savedShare } from "./splitter.js";

export type Section = "needs" | "tasks" | "prs" | "comms" | "meetings" | "todos" | "note";
export type PanelId = "devis" | Section;

export const SECTIONS: readonly Section[] = ["needs", "tasks", "prs", "comms", "meetings", "todos", "note"];
export const PANEL_NAME: Record<PanelId, string> = {
  devis: "Devis",
  needs: "Needs you",
  tasks: "Tasks",
  prs: "Pull Requests",
  comms: "Communication",
  meetings: "Meetings",
  todos: "To-dos",
  note: "Note",
};

export const isSection = (value: unknown): value is Section => SECTIONS.includes(value as Section);
export const isPanelId = (value: unknown): value is PanelId => value === "devis" || isSection(value);

export interface PanelSlot {
  id: PanelId;
  /** Its share of the column's height against the other open panels; 1 when unset. When none of a
   *  column's panels has one (a gap double-clicked), they fit their content instead. */
  g?: number;
}
export interface Column {
  /** Its share of the width (all columns' add up to 1), or null for the CSS default. */
  w: number | null;
  panels: PanelSlot[];
}
export interface Layout {
  columns: Column[];
  /** The sections' order on a narrow window, once the user moves one there. */
  flat?: Section[];
}

export const MAX_COLUMNS = 4;
export const LAYOUT_KEY = "adoPrOps.workspace.layout";
const LEGACY_ORDER_KEY = "adoPrOps.workspace.railOrder";
const LEGACY_SPLIT_KEY = "adoPrOps.split.workspace";

/** The least room things get, in px. A move or resize that would break them is refused. */
export const MIN = {
  /** A column's width, and the width of the one Devis is in. */
  col: 280,
  devisCol: 420,
  /** An open section's height, and Devis's. */
  panel: 120,
  devis: 240,
  /** A folded panel: its header and border. */
  head: 36,
  /** The gap between columns or panels, and the padding around the columns. */
  sash: 8,
  pad: 8,
  /** The strip on top of each column that holds its grip (it takes the top padding's place). */
  bar: 16,
};

const G_MIN = 0.05;
const G_MAX = 20;
const clampG = (g: number): number => Math.min(G_MAX, Math.max(G_MIN, g));

/**
 * Three columns: what's waiting on you (Needs you, To-dos, Note) on the left, Devis in the middle,
 * and the work you watch (Tasks, Pull Requests, Meetings, Communication) on the right.
 */
export function defaultLayout(): Layout {
  return {
    columns: [
      { w: 0.25, panels: [{ id: "needs", g: 1 }, { id: "todos", g: 1 }, { id: "note", g: 1 }] },
      { w: 0.54, panels: [{ id: "devis" }] },
      { w: 0.21, panels: [{ id: "tasks", g: 1.1 }, { id: "prs", g: 0.9 }, { id: "meetings", g: 1 }, { id: "comms", g: 1 }] },
    ],
  };
}

export function cloneLayout(l: Layout): Layout {
  return {
    columns: l.columns.map((c) => ({ w: c.w, panels: c.panels.map((p) => ({ ...p })) })),
    ...(l.flat ? { flat: [...l.flat] } : {}),
  };
}

/** The sections in reading order: columns left to right, each top to bottom. */
export const readingOrder = (l: Layout): Section[] =>
  l.columns.flatMap((c) => c.panels.map((p) => p.id)).filter(isSection);

/** The sections' order on a narrow window. */
export const flatOrder = (l: Layout): Section[] => l.flat ?? readingOrder(l);

export function findPanel(l: Layout, id: PanelId): { col: number; row: number } | null {
  for (let col = 0; col < l.columns.length; col++) {
    const row = l.columns[col]!.panels.findIndex((p) => p.id === id);
    if (row >= 0) return { col, row };
  }
  return null;
}

const hasDevis = (c: Column): boolean => c.panels.some((p) => p.id === "devis");

/** Widths are all set and add up to 1, or all left to CSS. */
function fixWidths(columns: Column[]): void {
  const set = columns.every((c) => typeof c.w === "number" && Number.isFinite(c.w) && c.w > 0);
  const sum = set ? columns.reduce((s, c) => s + (c.w as number), 0) : 0;
  for (const c of columns) c.w = set && sum > 0 ? (c.w as number) / sum : null;
}

/**
 * Anything read back made whole: unknown panels dropped, each panel once (the first wins),
 * Devis there, sections that went missing put back, empty columns gone, at most four columns.
 */
export function normalize(raw: unknown): Layout {
  const src = (raw && typeof raw === "object" ? raw : {}) as { columns?: unknown; flat?: unknown };
  const seen = new Set<PanelId>();
  let columns: Column[] = [];
  for (const c of Array.isArray(src.columns) ? src.columns : []) {
    if (!c || typeof c !== "object") continue;
    const { w, panels } = c as { w?: unknown; panels?: unknown };
    const slots: PanelSlot[] = [];
    for (const p of Array.isArray(panels) ? panels : []) {
      const id = typeof p === "string" ? p : (p as { id?: unknown } | null)?.id;
      if (!isPanelId(id) || seen.has(id)) continue;
      seen.add(id);
      const g = typeof p === "object" && p ? Number((p as { g?: unknown }).g) : NaN;
      slots.push(Number.isFinite(g) && g > 0 ? { id, g: clampG(g) } : { id });
    }
    const width = typeof w === "number" && Number.isFinite(w) && w > 0 ? w : null;
    if (slots.length) columns.push({ w: width, panels: slots });
  }
  if (!seen.has("devis")) return defaultLayout();
  if (columns.length > MAX_COLUMNS) {
    const extra = columns.slice(MAX_COLUMNS).flatMap((c) => c.panels);
    columns = columns.slice(0, MAX_COLUMNS);
    columns[MAX_COLUMNS - 1]!.panels.push(...extra);
  }
  const missing = SECTIONS.filter((s) => !seen.has(s));
  // Under the nearest earlier section that's placed; with none, at the end of a column.
  const loose: Section[] = [];
  for (const id of missing) {
    const before = SECTIONS.slice(0, SECTIONS.indexOf(id)).reverse().find((s) => seen.has(s));
    const at = before ? findPanel({ columns }, before) : null;
    if (at) {
      columns[at.col]!.panels.splice(at.row + 1, 0, { id });
      seen.add(id);
    } else loose.push(id);
  }
  if (loose.length) {
    let home = [...columns].reverse().find((c) => !hasDevis(c));
    if (!home && columns.length < MAX_COLUMNS) {
      home = { w: null, panels: [] };
      columns.push(home);
      for (const c of columns) c.w = null;
    }
    (home ?? columns[columns.length - 1]!).panels.push(...loose.map((id) => ({ id })));
  }
  fixWidths(columns);
  const layout: Layout = { columns };
  if (Array.isArray(src.flat)) {
    const flat = [...new Set(src.flat.filter(isSection))];
    for (const id of SECTIONS) {
      if (flat.includes(id)) continue;
      const before = SECTIONS.slice(0, SECTIONS.indexOf(id)).reverse().find((s) => flat.includes(s));
      flat.splice(before ? flat.indexOf(before) + 1 : flat.length, 0, id);
    }
    layout.flat = flat;
  }
  return layout;
}

/** The same layout without its empty columns (an edit leaves them while the user fills them). */
export function pruneEmpty(l: Layout): Layout {
  const next = cloneLayout(l);
  const kept = next.columns.filter((c) => c.panels.length);
  if (kept.length !== next.columns.length) {
    next.columns = kept;
    fixWidths(next.columns);
  }
  return next;
}

/** Sizes as saved (widths to 4 places, heights to 3) count as the same. */
const sameSize = (a: number | null | undefined, b: number | null | undefined): boolean =>
  (a ?? null) === (b ?? null) || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-3);

export function isDefault(l: Layout): boolean {
  const d = defaultLayout();
  const p = pruneEmpty(l);
  return (
    !p.flat &&
    p.columns.length === d.columns.length &&
    p.columns.every(
      (c, i) =>
        sameSize(c.w, d.columns[i]!.w) &&
        c.panels.length === d.columns[i]!.panels.length &&
        c.panels.every((s, j) => s.id === d.columns[i]!.panels[j]!.id && sameSize(s.g, d.columns[i]!.panels[j]!.g))
    )
  );
}

/**
 * Move a panel to column `col`, `row`th from the top (counted without the panel itself).
 * `col` one past the last column makes a new column there, as wide as the others on average.
 * Its height share stays with it unless it lands in a different column.
 */
export function movePanel(l: Layout, id: PanelId, col: number, row: number): Layout {
  const next = cloneLayout(l);
  const at = findPanel(next, id);
  if (!at) return next;
  const [slot] = next.columns[at.col]!.panels.splice(at.row, 1);
  if (col >= next.columns.length) {
    if (next.columns.length >= MAX_COLUMNS) return cloneLayout(l);
    const widths = next.columns.map((c) => c.w);
    const mean = widths.every((w) => w !== null) ? (widths as number[]).reduce((s, w) => s + w, 0) / widths.length : null;
    next.columns.push({ w: mean, panels: [] });
    col = next.columns.length - 1;
    fixWidths(next.columns);
  }
  const target = next.columns[Math.max(0, col)]!.panels;
  const moved: PanelSlot = col === at.col ? slot! : { id: slot!.id };
  target.splice(Math.max(0, Math.min(target.length, row)), 0, moved);
  return next;
}

/**
 * Move column `from` so it ends up `to`th from the left (counted without it), taking its panels
 * and width along. Nothing else changes size, so it always fits.
 */
export function moveColumn(l: Layout, from: number, to: number): Layout {
  const next = cloneLayout(l);
  if (from < 0 || from >= next.columns.length) return next;
  const [column] = next.columns.splice(from, 1);
  next.columns.splice(Math.max(0, Math.min(next.columns.length, to)), 0, column!);
  return next;
}

/** An empty column on the right, for the user to drag panels into. */
export function addColumn(l: Layout): Layout {
  const next = cloneLayout(l);
  if (next.columns.length >= MAX_COLUMNS) return next;
  const widths = next.columns.map((c) => c.w);
  const mean = widths.every((w) => w !== null) ? (widths as number[]).reduce((s, w) => s + w, 0) / widths.length : null;
  next.columns.push({ w: mean, panels: [] });
  fixWidths(next.columns);
  return next;
}

/** The narrowest a column can be. */
export const columnMin = (c: Column): number => (hasDevis(c) ? MIN.devisCol : MIN.col);

/** The narrowest the columns can be together, borders and padding included. */
export const minWidth = (l: Layout): number =>
  l.columns.reduce((s, c) => s + columnMin(c), 0) + MIN.sash * Math.max(0, l.columns.length - 1) + MIN.pad * 2;

/** The least height a column's panels need: open ones their minimum, folded ones their header. */
export function columnMinHeight(c: Column, folded: (id: PanelId) => boolean): number {
  const each = c.panels.map((p) => (p.id === "devis" ? MIN.devis : folded(p.id) ? MIN.head : MIN.panel));
  return each.reduce((s, h) => s + h, 0) + MIN.sash * Math.max(0, each.length - 1);
}

function forget(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* private mode */
  }
}

/** The layout as the user left it on this device. */
export function readLayout(): Layout {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(LAYOUT_KEY);
  } catch {
    /* private mode: the default */
  }
  if (saved !== null) {
    try {
      return normalize(JSON.parse(saved));
    } catch {
      return defaultLayout();
    }
  }
  // First read: take the rail's order and the Devis/rail split from before columns, when there are any.
  let order: unknown = null;
  let hadOrder = false;
  try {
    const raw = localStorage.getItem(LEGACY_ORDER_KEY);
    hadOrder = raw !== null;
    order = JSON.parse(raw || "null");
  } catch {
    /* unreadable: the default order */
  }
  const share = savedShare("workspace");
  if (!hadOrder && share === null) return defaultLayout();
  const sections = Array.isArray(order) ? order.filter(isSection) : [];
  const layout = normalize({
    columns: [
      { w: share, panels: [{ id: "devis" }] },
      { w: share === null ? null : 1 - share, panels: sections.map((id) => ({ id })) },
    ],
  });
  saveLayout(layout);
  return layout;
}

export function saveLayout(l: Layout): void {
  const kept = pruneEmpty(l);
  forget(LEGACY_ORDER_KEY);
  forget(LEGACY_SPLIT_KEY);
  if (isDefault(kept)) return forget(LAYOUT_KEY);
  const plain: Layout = {
    columns: kept.columns.map((c) => ({
      w: c.w === null ? null : Number(c.w.toFixed(4)),
      panels: c.panels.map((p) => (p.g === undefined ? { id: p.id } : { id: p.id, g: Number(p.g.toFixed(3)) })),
    })),
    ...(kept.flat ? { flat: kept.flat } : {}),
  };
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(plain));
  } catch {
    /* applied, just not kept */
  }
}
