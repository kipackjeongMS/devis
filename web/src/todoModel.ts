// The to-dos' rules that don't touch the page, so they unit-test under plain node
// (scripts/todo-model-harness.mjs): the tree, due dates, filters, how a start splits
// to-dos across workers, and where a move puts a to-do before the server answers.
//
// The server lists to-dos depth first: open top-level ones by priority (highest first),
// then each one's subtasks in their order, then the done top-level ones, newest first.
// Everything here keeps that order.
import type { Todo } from "./jarvisModel.js";

/** As many workers as one start may ask for (the server's TODO_START_MAX_WORKERS). */
export const MAX_WORKERS = 8;

export const PRIORITIES = [
  { value: 3, label: "High" },
  { value: 2, label: "Medium" },
  { value: 1, label: "Low" },
] as const;

export const priorityName = (p: number): string => PRIORITIES.find((x) => x.value === p)?.label ?? "";

// ---- the tree -----------------------------------------------------------------------

/** Each to-do's subtasks, in order; top-level ones under `null`. */
export function childrenOf(todos: readonly Todo[]): Map<number | null, Todo[]> {
  const ids = new Set(todos.map((t) => t.id));
  const map = new Map<number | null, Todo[]>();
  for (const t of todos) {
    // A subtask whose parent isn't listed shows at the top rather than vanishing.
    const parent = t.parentId !== null && ids.has(t.parentId) ? t.parentId : null;
    const list = map.get(parent);
    if (list) list.push(t);
    else map.set(parent, [t]);
  }
  return map;
}

/** How deep each to-do sits: 0 at the top. */
export function depths(todos: readonly Todo[]): Map<number, number> {
  const byId = new Map(todos.map((t) => [t.id, t]));
  const out = new Map<number, number>();
  const depthOf = (t: Todo, seen: Set<number>): number => {
    const known = out.get(t.id);
    if (known !== undefined) return known;
    const parent = t.parentId === null ? undefined : byId.get(t.parentId);
    const d = parent && !seen.has(parent.id) ? depthOf(parent, seen.add(t.id)) + 1 : 0;
    out.set(t.id, d);
    return d;
  };
  for (const t of todos) depthOf(t, new Set());
  return out;
}

/** The ids above a to-do, nearest first. */
export function ancestors(todos: readonly Todo[], id: number): number[] {
  const byId = new Map(todos.map((t) => [t.id, t]));
  const out: number[] = [];
  let parent = byId.get(id)?.parentId ?? null;
  while (parent !== null && byId.has(parent) && parent !== id && !out.includes(parent)) {
    out.push(parent);
    parent = byId.get(parent)!.parentId;
  }
  return out;
}

/** Every to-do under one, at any depth, in list order. */
export function descendants(todos: readonly Todo[], id: number): Todo[] {
  const kids = childrenOf(todos);
  const out: Todo[] = [];
  const walk = (parent: number): void => {
    for (const k of kids.get(parent) ?? []) {
      out.push(k);
      walk(k.id);
    }
  };
  walk(id);
  return out;
}

/** How many of a to-do's subtasks (at any depth) are done; null when it has none. */
export function progress(todos: readonly Todo[], id: number): { done: number; total: number } | null {
  const under = descendants(todos, id);
  return under.length ? { done: under.filter((t) => t.done).length, total: under.length } : null;
}

/** The selected to-dos without the ones already inside another selected one, in list order. */
export function topPicks(todos: readonly Todo[], picked: ReadonlySet<number>): Todo[] {
  return todos.filter((t) => picked.has(t.id) && !ancestors(todos, t.id).some((a) => picked.has(a)));
}

// ---- due dates ----------------------------------------------------------------------
// A due date is a day in the user's own calendar, YYYY-MM-DD, never a moment.

const pad = (n: number): string => String(n).padStart(2, "0");

export function todayKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export const isDayKey = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** The day as a local date at noon, so a daylight-saving shift can't move it across midnight. */
function dayDate(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, m! - 1, d!, 12);
}

export function addDays(key: string, n: number): string {
  const d = dayDate(key);
  d.setDate(d.getDate() + n);
  return todayKey(d);
}

/** The Monday after this day (a week on, when it is a Monday). */
export function nextMonday(key: string): string {
  const day = dayDate(key).getDay();
  return addDays(key, ((8 - day) % 7) || 7);
}

/** Whole days from `from` to `to`: 1 for tomorrow, -1 for yesterday. */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayDate(to).getTime() - dayDate(from).getTime()) / 86_400_000);
}

export type DueTone = "over" | "today" | "soon" | "later" | "done";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "May 21", with the year when it isn't this year's. */
export function shortDay(key: string, today: string): string {
  const d = dayDate(key);
  const year = d.getFullYear() === dayDate(today).getFullYear() ? "" : `, ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year}`;
}

/**
 * How a due date reads on its chip: near days by name (Today, Tomorrow, Friday, 3 days ago),
 * the rest as a date. The tone says how pressing it is; a done to-do's date is just a record.
 */
export function dueInfo(due: string, today: string, done = false): { label: string; tone: DueTone; title: string } {
  const diff = daysBetween(today, due);
  const label =
    diff === 0 ? "Today"
    : diff === 1 ? "Tomorrow"
    : diff === -1 ? "Yesterday"
    : diff < 0 && diff > -7 ? `${-diff} days ago`
    : diff > 1 && diff < 7 ? WEEKDAYS[dayDate(due).getDay()]!
    : shortDay(due, today);
  const tone: DueTone = done ? "done" : diff < 0 ? "over" : diff === 0 ? "today" : diff < 7 ? "soon" : "later";
  const full = `${WEEKDAYS[dayDate(due).getDay()]}, ${shortDay(due, today)}`;
  const title = done ? `Was due ${full}` : diff < 0 ? `Overdue: was due ${full}` : `Due ${full}`;
  return { label, tone, title };
}

// ---- filters ------------------------------------------------------------------------

export type TodoFilter = "all" | "today" | "overdue" | "upcoming" | "done";
export const TODO_FILTERS: ReadonlyArray<{ id: TodoFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "today", label: "Today" },
  { id: "overdue", label: "Overdue" },
  { id: "upcoming", label: "Upcoming" },
  { id: "done", label: "Done" },
];
export const isTodoFilter = (v: unknown): v is TodoFilter => TODO_FILTERS.some((f) => f.id === v);

/** Whether a to-do itself belongs under a filter. "All" is every open one. */
export function inFilter(t: Todo, filter: TodoFilter, today: string): boolean {
  if (filter === "done") return t.done;
  if (t.done) return false;
  if (filter === "all") return true;
  if (!t.due) return false;
  const diff = daysBetween(today, t.due);
  return filter === "today" ? diff === 0 : filter === "overdue" ? diff < 0 : diff > 0;
}

export function filterCounts(todos: readonly Todo[], today: string): Record<TodoFilter, number> {
  const out = { all: 0, today: 0, overdue: 0, upcoming: 0, done: 0 } as Record<TodoFilter, number>;
  for (const t of todos) for (const f of TODO_FILTERS) if (inFilter(t, f.id, today)) out[f.id]++;
  return out;
}

export interface TodoRow {
  todo: Todo;
  depth: number;
  /** Shown only so a match reads in place: an ancestor of one, not a match itself. */
  context: boolean;
  /** It has subtasks (shown or folded away). */
  parent: boolean;
  folded: boolean;
}

export interface RowsView {
  filter: TodoFilter;
  query: string;
  /** Folded to-dos: their subtasks are hidden. Ignored while searching or filtering, so matches show. */
  folded: ReadonlySet<number>;
  today: string;
}

/**
 * The rows to show, in order. Unfiltered, it's the open tree (folds applied) and the done
 * top-level to-dos with theirs. Filtered or searched, it's every match with its ancestors
 * as context rows, so a subtask is never shown without what it belongs to.
 */
export function visibleRows(todos: readonly Todo[], view: RowsView): { open: TodoRow[]; done: TodoRow[] } {
  const kids = childrenOf(todos);
  const depth = depths(todos);
  const q = view.query.trim().toLowerCase();
  const narrowed = view.filter !== "all" || !!q;
  // A search under "All" looks through the done ones too.
  const inView = (t: Todo): boolean => (q && view.filter === "all") || inFilter(t, view.filter, view.today);
  const matches = (t: Todo): boolean => inView(t) && (!q || t.text.toLowerCase().includes(q));
  const shown = new Set<number>();
  const hits = new Set<number>();
  if (narrowed) {
    for (const t of todos) {
      if (!matches(t)) continue;
      hits.add(t.id);
      shown.add(t.id);
      for (const a of ancestors(todos, t.id)) shown.add(a);
    }
  }
  const open: TodoRow[] = [];
  const done: TodoRow[] = [];
  const walk = (t: Todo, into: TodoRow[]): void => {
    if (narrowed && !shown.has(t.id)) return;
    const under = kids.get(t.id) ?? [];
    const folded = !narrowed && under.length > 0 && view.folded.has(t.id);
    into.push({ todo: t, depth: depth.get(t.id) ?? 0, context: narrowed && !hits.has(t.id), parent: under.length > 0, folded });
    if (!folded) for (const k of under) walk(k, into);
  };
  for (const t of kids.get(null) ?? []) walk(t, t.done ? done : open);
  return { open, done };
}

// ---- starting a task ----------------------------------------------------------------

/** How the picked to-dos split across workers. */
export type SplitMode = "one" | "each" | "chunk" | "workers";

/**
 * The picked to-dos (ids, in list order) as worker groups: all to one worker, one each,
 * `n` to a worker, or shared round-robin across `n` workers.
 */
export function splitGroups(ids: readonly number[], mode: SplitMode, n = 2): number[][] {
  if (!ids.length) return [];
  const size = Math.max(1, Math.floor(n) || 1);
  if (mode === "one") return [[...ids]];
  if (mode === "each") return ids.map((id) => [id]);
  if (mode === "chunk") {
    const out: number[][] = [];
    for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
    return out;
  }
  const workers = Math.min(size, ids.length);
  const out: number[][] = Array.from({ length: workers }, () => []);
  ids.forEach((id, i) => out[i % workers]!.push(id));
  return out;
}

/** Whether a split is offered for this many to-dos, and why not when it isn't. */
export function splitBlocked(mode: SplitMode, count: number, n: number): string {
  const groups = splitGroups(Array.from({ length: count }, (_, i) => i), mode, n).length;
  return groups > MAX_WORKERS ? `That's ${groups} workers; a start can ask for ${MAX_WORKERS} at most.` : "";
}

// ---- moving -------------------------------------------------------------------------

/**
 * What a to-do moves among: an open top-level one among the open top-level ones of its
 * priority, a subtask among its parent's subtasks. Done top-level ones keep their place.
 */
export function movePeers(todos: readonly Todo[], todo: Todo): Todo[] {
  const ids = new Set(todos.map((t) => t.id));
  if (todo.parentId !== null && ids.has(todo.parentId)) return todos.filter((t) => t.parentId === todo.parentId);
  if (todo.done) return [];
  return todos.filter((t) => (t.parentId === null || !ids.has(t.parentId)) && !t.done && t.priority === todo.priority);
}

export function canMove(todos: readonly Todo[], todo: Todo, direction: "up" | "down"): boolean {
  const peers = movePeers(todos, todo);
  const at = peers.findIndex((t) => t.id === todo.id);
  return at >= 0 && (direction === "up" ? at > 0 : at < peers.length - 1);
}

/** The list with a to-do (and its subtasks) swapped with its neighbour, as the server will order it. */
export function movedTodos(todos: readonly Todo[], id: number, direction: "up" | "down"): Todo[] {
  const todo = todos.find((t) => t.id === id);
  if (!todo || !canMove(todos, todo, direction)) return [...todos];
  const peers = movePeers(todos, todo);
  const at = peers.indexOf(todo);
  const other = peers[direction === "up" ? at - 1 : at + 1]!;
  const kids = childrenOf(todos);
  const swap = (list: Todo[]): Todo[] =>
    list.map((t) => (t.id === todo.id ? other : t.id === other.id ? todo : t));
  const parentKey = todo.parentId !== null && kids.has(todo.parentId) ? todo.parentId : null;
  kids.set(parentKey, swap(kids.get(parentKey) ?? []));
  const out: Todo[] = [];
  const walk = (t: Todo): void => {
    out.push(t);
    for (const k of kids.get(t.id) ?? []) walk(k);
  };
  for (const t of kids.get(null) ?? []) walk(t);
  return out;
}
