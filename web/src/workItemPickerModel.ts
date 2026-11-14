// The New task dialog's work item picker, its DOM-free rules, so they unit-test under plain node
// (see scripts/workitem-picker-harness.mjs). workItemPicker.ts draws and wires it.

/** A work item the picker lists, as GET /api/jarvis/workitems returns it. */
export interface WorkItemOption {
  org: string;
  project: string;
  id: number;
  title: string;
  type: string;
  state: string;
  url: string;
}

export interface WorkItemSuggestions {
  /** "assigned": your open items, for an empty box; "search": what matches what's typed. */
  scope: "assigned" | "search";
  items: WorkItemOption[];
  /** Orgs whose lookup failed; the others' items still came back. */
  errors: Array<{ org: string; message: string }>;
  /** No project is opted in under Settings, so there's nothing to look in. */
  noProjects: boolean;
}

/**
 * What's in the box: nothing (list what's assigned to you), a number or link (looked up as it is,
 * no list), too little to search for yet, or words to search titles for.
 */
export type QueryKind = "empty" | "ref" | "short" | "text";

/** Search needs this many letters or digits; one matches too much to be worth a request. */
export const MIN_SEARCH_CHARS = 2;

export function classifyQuery(value: string): QueryKind {
  const text = value.trim();
  if (!text) return "empty";
  if (/^#?\d*$/.test(text) || /^https?:\/\//i.test(text)) return "ref";
  const chars = text.match(/[\p{L}\p{N}]/gu)?.length || 0;
  return chars < MIN_SEARCH_CHARS ? "short" : "text";
}

/**
 * What to send as `q`: runs of space folded to one and the start trimmed. A trailing space stays,
 * since it tells the search the last word is whole rather than the start of one.
 */
export function searchQuery(value: string): string {
  return value.replace(/\s+/g, " ").replace(/^ /, "").slice(0, 200);
}

/** The next active row, wrapping at either end; -1 when there are none. From none, down is the first and up the last. */
export function moveIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (index < 0) return delta > 0 ? 0 : count - 1;
  return (((index + delta) % count) + count) % count;
}

/** The line under a row's title: "User Story #2841124 · Active · Project", and the org when there are several. */
export function optionMeta(item: WorkItemOption, multiOrg: boolean): string {
  const parts = [`${item.type || "Work item"} #${item.id}`];
  if (item.state) parts.push(item.state);
  if (item.project) parts.push(item.project);
  if (multiOrg && item.org) parts.push(item.org);
  return parts.join(" · ");
}

/** What a screen reader hears for the active row. */
export function optionAnnouncement(item: WorkItemOption, index: number, count: number, multiOrg: boolean): string {
  return `${item.title}, ${optionMeta(item, multiOrg)}. ${index + 1} of ${count}.`;
}

/** The heading over the rows, and what's announced when they arrive. */
export function listHeading(scope: WorkItemSuggestions["scope"]): string {
  return scope === "assigned" ? "Assigned to you" : "Best matches";
}

export function countAnnouncement(scope: WorkItemSuggestions["scope"], count: number): string {
  if (scope === "assigned") return `${count} open work item${count === 1 ? "" : "s"} assigned to you.`;
  return `${count} match${count === 1 ? "" : "es"}.`;
}

/** The orgs a failure names, for "Couldn't search One or Two". */
function orgList(errors: WorkItemSuggestions["errors"]): string {
  const orgs = [...new Set(errors.map((e) => e.org))];
  return orgs.length > 1 ? `${orgs.slice(0, -1).join(", ")} or ${orgs[orgs.length - 1]}` : orgs[0] || "";
}

/**
 * The line the list shows instead of, or under, its rows, with the full error for its tooltip.
 * Null when the rows say it all.
 */
export function suggestionsNote(data: WorkItemSuggestions): { text: string; detail: string; error: boolean } | null {
  const detail = data.errors.map((e) => `${e.org}: ${e.message}`).join("\n");
  if (data.noProjects) {
    return { text: "Opt in to projects under Settings to search their work items. A number or link still works.", detail: "", error: false };
  }
  if (data.errors.length && !data.items.length) {
    return { text: `Couldn't search ${orgList(data.errors)}. Enter the work item's number or link instead.`, detail, error: true };
  }
  if (data.errors.length) return { text: `Couldn't search ${orgList(data.errors)}; these are from the rest.`, detail, error: true };
  if (data.items.length) return null;
  if (data.scope === "assigned") {
    return { text: "Nothing open is assigned to you. Type to search titles, or enter a number or link.", detail: "", error: false };
  }
  return { text: "No open work items match. Try other words, or enter a number or link.", detail: "", error: false };
}

/**
 * The title cut into plain and matched runs, for marking what matched: a title word matches when
 * it starts with any word typed (the search matches word starts too), the longest such word winning.
 */
export function highlightParts(title: string, query: string): Array<{ text: string; hit: boolean }> {
  const words = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).filter((w) => w.length >= MIN_SEARCH_CHARS))].sort(
    (a, b) => b.length - a.length
  );
  const parts: Array<{ text: string; hit: boolean }> = [];
  const push = (text: string, hit: boolean): void => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.text += text;
    else parts.push({ text, hit });
  };
  let at = 0;
  if (words.length) {
    for (const m of title.matchAll(/[\p{L}\p{N}_]+/gu)) {
      const word = m[0];
      const lower = word.toLowerCase();
      // Some letters change length when lowercased; leave those words unmarked rather than mark the wrong span.
      if (lower.length !== word.length) continue;
      const typed = words.find((w) => lower.startsWith(w));
      if (!typed) continue;
      push(title.slice(at, m.index), false);
      push(title.slice(m.index, m.index! + typed.length), true);
      at = m.index! + typed.length;
    }
  }
  push(title.slice(at), false);
  return parts;
}
