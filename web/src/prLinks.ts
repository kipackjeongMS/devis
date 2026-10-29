// What the queue's right-click menu offers for copying PR links. DOM-free so it
// unit-tests under plain node (see scripts/pr-link-copy-harness.mjs).

export interface LinkPr {
  url?: string;
}

export interface CopyLinkEntry {
  kind: "one" | "checked";
  label: string;
  /** Clipboard text: one URL, or one URL per line for the checked set. */
  text: string;
  /** How many links `text` holds. */
  count: number;
}

const urlOf = (pr: LinkPr): string => (pr.url || "").trim();

/**
 * Menu entries for a right-click on `target`. "Copy link to PR" is always there;
 * the bulk entry only appears when the clicked row is itself checked and more than
 * one PR is checked, so the menu never offers a bulk copy for a row outside the
 * selection. `checked` should already be in on-screen order.
 */
export function linkMenuEntries(target: LinkPr, checked: LinkPr[], targetIsChecked: boolean): CopyLinkEntry[] {
  const entries: CopyLinkEntry[] = [];
  const one = urlOf(target);
  if (one) entries.push({ kind: "one", label: "Copy link to PR", text: one, count: 1 });
  if (targetIsChecked) {
    const urls = checked.map(urlOf).filter(Boolean);
    if (urls.length > 1) {
      entries.push({
        kind: "checked",
        label: `Copy links to all checked PRs (${urls.length})`,
        text: urls.join("\n"),
        count: urls.length,
      });
    }
  }
  return entries;
}
