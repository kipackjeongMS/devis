// The Workspace PR panel's multi-select rules, DOM-free so they unit-test under plain node
// (see scripts/pr-selection-harness.mjs). Ids are PR identities; `order` is the rows as
// listed on screen.

export type CheckState = "none" | "some" | "all";
export type RowClick = "open" | "toggle" | "range";

export interface ClickMods {
  shift?: boolean;
  /** Ctrl, or Cmd on a Mac. */
  toggle?: boolean;
}

/** What a click on a row's title does. Outside select mode a plain click opens the PR. */
export function rowClick(selecting: boolean, mods: ClickMods): RowClick {
  if (mods.shift) return "range";
  if (mods.toggle || selecting) return "toggle";
  return "open";
}

export function toggled(sel: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(sel);
  if (!next.delete(id)) next.add(id);
  return next;
}

/** Everything from the anchor to the target, inclusive, added to the selection. */
export function ranged(sel: ReadonlySet<string>, order: readonly string[], anchor: string | null, id: string): Set<string> {
  const next = new Set(sel);
  const a = anchor === null ? -1 : order.indexOf(anchor);
  const b = order.indexOf(id);
  if (b < 0) return next;
  if (a < 0) return next.add(id), next;
  for (const key of order.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(key);
  return next;
}

/** Only rows still listed stay selected, so the count never includes a PR you can't see. */
export function pruned(sel: ReadonlySet<string>, order: readonly string[]): Set<string> {
  const listed = new Set(order);
  return new Set([...sel].filter((id) => listed.has(id)));
}

export function checkState(sel: ReadonlySet<string>, order: readonly string[]): CheckState {
  const n = order.filter((id) => sel.has(id)).length;
  return n === 0 ? "none" : n === order.length ? "all" : "some";
}

/** The header checkbox: select every listed row unless all are already selected. */
export function toggledAll(sel: ReadonlySet<string>, order: readonly string[]): Set<string> {
  return checkState(sel, order) === "all" ? new Set() : new Set(order);
}

export const selectedInOrder = (sel: ReadonlySet<string>, order: readonly string[]): string[] => order.filter((id) => sel.has(id));

/** Whether a right-click on `id` may offer the selection-wide entries: only when that row is itself part of a multi-selection. */
export function contextIsSelected(sel: ReadonlySet<string>, id: string): boolean {
  return sel.has(id) && sel.size > 1;
}
