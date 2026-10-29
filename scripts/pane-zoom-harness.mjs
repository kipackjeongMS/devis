import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PANE_ZOOM_LEVELS, nextZoom, paneZoomCommand, stepPaneZoom, zoomLevelOf } from "../web/shellModel.js";

// ---- pure zoom model ----------------------------------------------------------
assert.deepEqual(PANE_ZOOM_LEVELS, [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]);
assert.equal(stepPaneZoom(1, 1), 1.1);
assert.equal(stepPaneZoom(1.1, 1), 1.25);
assert.equal(stepPaneZoom(1, -1), 0.9);
assert.equal(stepPaneZoom(0.67, -1), 0.5);
assert.equal(stepPaneZoom(2, 1), 2, "zooming in stops at 200%");
assert.equal(stepPaneZoom(0.5, -1), 0.5, "zooming out stops at 50%");
assert.equal(stepPaneZoom(1.05, 1), 1.1, "an off-grid level snaps to the next step up");
assert.equal(stepPaneZoom(1.05, -1), 1, "an off-grid level snaps to the next step down");

const key = (k, mods = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });
const ctrl = { ctrlKey: true };
for (const k of ["=", "+"]) assert.equal(paneZoomCommand(key(k, ctrl)), "in", `Ctrl+${k} zooms in`);
for (const k of ["-", "_"]) assert.equal(paneZoomCommand(key(k, ctrl)), "out", `Ctrl+${k} zooms out`);
assert.equal(paneZoomCommand(key("0", ctrl)), "reset");
assert.equal(paneZoomCommand(key("=", { metaKey: true })), "in", "⌘ works like Ctrl");
assert.equal(paneZoomCommand(key("=")), null, "a bare = types or zooms a focused diagram, not the pane");
assert.equal(paneZoomCommand(key("+", { ctrlKey: true, altKey: true })), null, "AltGr chords type characters");
assert.equal(paneZoomCommand(key("a", ctrl)), null);

// A saved level comes back only if it's one of the steps; anything else is 100%.
assert.equal(zoomLevelOf("1.25"), 1.25);
assert.equal(zoomLevelOf("0.67"), 0.67);
assert.equal(zoomLevelOf(null), 1);
assert.equal(zoomLevelOf(""), 1);
assert.equal(zoomLevelOf("3"), 1, "out of range");
assert.equal(zoomLevelOf("1.3"), 1, "not a step");
assert.equal(zoomLevelOf("abc"), 1);
assert.equal(nextZoom(1, "in"), 1.1);
assert.equal(nextZoom(1.1, "out"), 1);
assert.equal(nextZoom(1.75, "reset"), 1);

// ---- wiring -------------------------------------------------------------------
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [pane, css, main, nav, mermaid, lights, design, viewZoom, jarvis, task] = await Promise.all([
  read("../web/src/readingPane.ts"),
  read("../web/style.css"),
  read("../src/main.mts"),
  read("../web/src/sectionNav.ts"),
  read("../web/src/mermaid.ts"),
  read("../web/src/severityLights.ts"),
  read("../DESIGN.md"),
  read("../web/src/viewZoom.ts"),
  read("../web/src/jarvis.ts"),
  read("../web/src/jarvisTask.ts"),
]);

assert.match(pane, /paneZoomCommand\(e\)/, "the reading pane handles the zoom keys");
assert.match(pane, /stepPaneZoom\(/);
assert.match(pane, /setProperty\("--pane-zoom"/);
assert.match(pane, /toast\(`Reading pane \$\{/, "each zoom step is announced");
assert.match(css, /\.reading-pane > \*\s*\{[^}]*zoom:\s*var\(--pane-zoom,\s*1\)/, "only the pane's content zooms");

assert.match(main, /Menu\.setApplicationMenu\(\s*Menu\.buildFromTemplate\(/);
assert.doesNotMatch(main, /zoomIn|zoomOut|resetZoom/, "window-wide zoom accelerators would steal Ctrl +/−");

// Client rects are visual px inside a zoomed subtree; layout and scroll offsets stay local px.
assert.match(nav, /scroller\.currentCSSZoom/, "section offsets convert rects to scroll space");
assert.match(mermaid, /currentCSSZoom/, "diagram pan and wheel anchors convert client px");
assert.match(lights, /host\.currentCSSZoom/, "the severity drawer converts its light's offset");

assert.match(design, /Ctrl\+=/, "DESIGN.md documents the pane zoom keys");

// ---- the Workspace: each view type zooms on its own, and keeps its level --------------
assert.match(pane, /if \(feature === "pipelines" \|\| feature === "jarvis"\) return;/, "the hidden reading pane doesn't take the Workspace's zoom keys");
assert.match(viewZoom, /document\.body\.dataset\.feature !== "jarvis"/, "the Workspace handler only runs on the Workspace");
assert.match(viewZoom, /localStorage\.setItem\(KEY \+ view, String\(level\)\)/, "levels are saved per view type");
assert.match(viewZoom, /document\.querySelectorAll<HTMLElement>\(`\[data-zoom-view="\$\{view\}"\]`\)/, "every open instance follows");
assert.match(viewZoom, /if \(top\) return top\.querySelector<HTMLElement>\("\[data-zoom-view\]"\);/, "a dialog on top decides: a view, or nothing");
assert.match(jarvis, /for \(const pane of PANES\) zoomable\(/, "each pane is a view");
assert.match(jarvis, /zoomable\(history, "history"\)/);
assert.match(task, /zoomable\(m\.dialog, "task"\)/, "every task sheet is the same view type");
assert.match(css, /\[data-zoom-view\] > \*\s*\{\s*zoom:\s*calc\(var\(--view-base, 1\) \* var\(--view-zoom, 1\)\);/, "a view's content zooms, not its frame");
assert.match(css, /\.tm \{ --view-base: 1\.125; \}/, "the task sheet reads larger by default");

console.log("Pane zoom harness passed");
