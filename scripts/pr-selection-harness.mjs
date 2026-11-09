import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { checkState, contextIsSelected, pruned, ranged, rowClick, selectedInOrder, toggled, toggledAll } from "../web/prSelectionModel.js";

const order = ["a", "b", "c", "d", "e"];

// ---- what a click does ----
assert.equal(rowClick(false, {}), "open", "a plain click opens the PR window");
assert.equal(rowClick(false, { toggle: true }), "toggle", "Ctrl/Cmd+click starts selecting");
assert.equal(rowClick(false, { shift: true }), "range", "Shift+click starts a range");
assert.equal(rowClick(true, {}), "toggle", "while selecting, a plain click toggles");
assert.equal(rowClick(true, { shift: true }), "range");

// ---- toggle and range ----
let sel = toggled(new Set(), "b");
assert.deepEqual([...sel], ["b"]);
assert.deepEqual([...toggled(sel, "b")], [], "toggling again deselects");
assert.deepEqual([...ranged(new Set(), order, "b", "d")].sort(), ["b", "c", "d"]);
assert.deepEqual([...ranged(new Set(), order, "d", "b")].sort(), ["b", "c", "d"], "backwards ranges work");
assert.deepEqual([...ranged(new Set(["a"]), order, "c", "e")].sort(), ["a", "c", "d", "e"], "a range adds to the selection");
assert.deepEqual([...ranged(new Set(), order, null, "c")], ["c"], "no anchor: just the row");
assert.deepEqual([...ranged(new Set(["a"]), order, "a", "zzz")], ["a"], "an unlisted target changes nothing");

// ---- tri-state and select-all ----
assert.equal(checkState(new Set(), order), "none");
assert.equal(checkState(new Set(["a"]), order), "some");
assert.equal(checkState(new Set(order), order), "all");
assert.deepEqual([...toggledAll(new Set(["a"]), order)], order, "select-all from partial selects everything listed");
assert.deepEqual([...toggledAll(new Set(order), order)], [], "select-all again clears");

// ---- the selection only holds listed rows, in listed order ----
assert.deepEqual([...pruned(new Set(["a", "x", "c"]), order)].sort(), ["a", "c"], "rows that leave the list leave the selection");
assert.deepEqual(selectedInOrder(new Set(["d", "a", "c"]), order), ["a", "c", "d"], "bulk actions run in on-screen order");

// ---- a right-click targets its own row ----
assert.equal(contextIsSelected(new Set(["a", "b"]), "a"), true, "a selected row among several offers the bulk copy");
assert.equal(contextIsSelected(new Set(["a", "b"]), "c"), false, "an unselected row never does");
assert.equal(contextIsSelected(new Set(["a"]), "a"), false, "one selected row has nothing to bulk");
const before = new Set(["a", "b"]);
contextIsSelected(before, "c");
assert.deepEqual([...before], ["a", "b"], "right-clicking doesn't touch the selection");

// ---- wiring ----
const [panel, jarvis, menu, css] = await Promise.all([
  readFile(new URL("../web/src/prPanel.ts", import.meta.url), "utf8"),
  readFile(new URL("../web/src/jarvis.ts", import.meta.url), "utf8"),
  readFile(new URL("../web/src/contextMenu.ts", import.meta.url), "utf8"),
  readFile(new URL("../web/style.css", import.meta.url), "utf8"),
]);

// PR menu: ADO link, the shared PR window, copy links; it never changes the selection.
const prMenu = jarvis.match(/function prMenu\([\s\S]*?\r?\n}\r?\n/)[0];
assert.match(prMenu, /label: "Open in Azure DevOps", icon: "azureDevOps"/);
assert.match(prMenu, /label: "Open in separate window"[^\n]*openPrWindow\(pr\)/);
assert.match(prMenu, /window\.open\(pr\.url, "_blank", "noopener"\)/);
assert.doesNotMatch(prMenu, /clickRow|toggleAll|clearSelection|setSelecting/, "the menu targets its row and leaves the selection alone");
assert.match(prMenu, /setContextRow\(null\)/, "the row's highlight clears when the menu closes");
assert.match(prMenu, /if \(contextRow\(\) !== id\) return;/, "a menu replaced by the next one doesn't clear the next row's highlight");
assert.ok(prMenu.indexOf("openContextMenu(") < prMenu.lastIndexOf("setContextRow(id)"), "the row is marked after the previous menu has closed");
assert.match(jarvis, /function refocusRow\(/, "focus returns to the row even when a repaint replaced it");

// Bulk review: no double send, and a failed send says so.
const bulk = jarvis.match(/async function bulkReview\([\s\S]*?\r?\n}\r?\n/)[0];
assert.match(bulk, /!queuing\.has\(prIdentity\(p\)\)/, "PRs still being queued are skipped");
assert.match(bulk, /catch \(e\)[\s\S]*toast\(/, "a failed send becomes a toast");
assert.match(panel, /const sending = n > 0 && \[\.\.\.selected\]\.every\(\(id\) => queuing\.has\(id\)\)/, "Review is disabled while its PRs are being queued");
assert.match(panel, /export function clearSelection\(\): void \{\s*selected = new Set\(\);\s*anchor = null;/, "Clear also drops the range anchor");

// The PR window hears its own broadcasts; only the Workspace reloads its list.
const app = await readFile(new URL("../web/src/app.ts", import.meta.url), "utf8");
assert.match(app, /onPrUpdatedElsewhere\(\(\) => \{\s*if \(document\.body\.dataset\.feature === "pr"\) return;/);

// Task cards: no visible ⋯; the menu opens from right-click or the keyboard, with every entry kept.
assert.doesNotMatch(jarvis, /task-more|rr-more/, "the ⋯ button is gone");
assert.match(jarvis, /aria-haspopup="menu" aria-keyshortcuts="Shift\+F10" title="\$\{esc\(tip\)\}"/, "task rows advertise the keyboard path");
const taskMenu = jarvis.match(/function taskMenu\([\s\S]*?\r?\n}\r?\n/)[0];
for (const label of ["Show what it needs", "Open", "Artifacts", "Status updates", "Pull requests", "Validation", "Reopen", "Start a worker", "Mark done", "Open in Azure DevOps", "Remove"]) {
  assert.ok(taskMenu.includes(`label: "${label}"`), `the task menu keeps "${label}"`);
}
assert.match(taskMenu, /if \(taskNeeds\(\[task\]\)\.length\)/);
assert.match(taskMenu, /const url = task\.workItem\?\.url;\s*if \(url\)/, "Open in Azure DevOps only with a work item URL");

// Keyboard: Shift+F10 / the Menu key fire `contextmenu` on the focused row; the menu anchors to it.
assert.match(menu, /export function menuPoint\(/);
assert.match(menu, /aria-disabled="true"/, "disabled entries stay in the menu");
assert.match(menu, /if \(entry\.disabled\) return;/, "…and don't run");
assert.match(jarvis, /menuPoint\(e, anchor\)/);

// Panel: checkboxes only in select mode, a labelled bulk bar, Escape leaves, the head button is a toggle.
assert.match(panel, /const check = selecting\s*\?/);
assert.match(panel, /aria-label="Select #\$\{pr\.id\}/);
assert.match(jarvis, /data-act="prs-select" aria-pressed="false"/);
assert.match(jarvis, /e\.key === "Escape" && isSelecting\(\)/);
assert.match(css, /\.pp-row\.is-selected\s*\{/);
assert.match(css, /\.pp-row\.is-ctx\s*\{/);

console.log("PR selection harness passed");
