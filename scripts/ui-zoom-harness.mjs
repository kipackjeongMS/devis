import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { TITLEBAR_HEIGHT, UI_ZOOM_LEVELS, nextZoom, titleBarHeight, zoomCommand, zoomLevelOf } from "../ui-zoom.mjs";

// ---- pure rules ---------------------------------------------------------------------
assert.deepEqual([...UI_ZOOM_LEVELS], [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]);
assert.equal(nextZoom(1, "in"), 1.1);
assert.equal(nextZoom(1.1, "in"), 1.25);
assert.equal(nextZoom(1, "out"), 0.9);
assert.equal(nextZoom(0.67, "out"), 0.5);
assert.equal(nextZoom(2, "in"), 2, "growing stops at 200%");
assert.equal(nextZoom(0.5, "out"), 0.5, "shrinking stops at 50%");
assert.equal(nextZoom(1.05, "in"), 1.1, "an off-ladder level snaps to the next step up");
assert.equal(nextZoom(1.05, "out"), 1, "an off-ladder level snaps to the next step down");
assert.equal(nextZoom(1.75, "reset"), 1);

// Electron's before-input-event input.
const key = (k, mods = {}) => ({ type: "keyDown", key: k, control: false, meta: false, alt: false, shift: false, ...mods });
const ctrl = { control: true };
for (const k of ["=", "+"]) assert.equal(zoomCommand(key(k, ctrl)), "in", `Ctrl+${k} grows the interface`);
for (const k of ["-", "_"]) assert.equal(zoomCommand(key(k, ctrl)), "out", `Ctrl+${k} shrinks it`);
assert.equal(zoomCommand(key("0", ctrl)), "reset");
assert.equal(zoomCommand(key("=", { meta: true })), "in", "⌘ works like Ctrl");
assert.equal(zoomCommand(key("=")), null, "a bare = types, or zooms a focused diagram");
assert.equal(zoomCommand(key("+", { control: true, alt: true })), null, "AltGr chords type characters");
assert.equal(zoomCommand(key("a", ctrl)), null);
assert.equal(zoomCommand(key("=", { ...ctrl, type: "keyUp" })), null, "only the key press steps");

// A saved level comes back only if it's one of the steps; anything else is 100%.
assert.equal(zoomLevelOf(1.25), 1.25);
assert.equal(zoomLevelOf("0.67"), 0.67);
assert.equal(zoomLevelOf(undefined), 1);
assert.equal(zoomLevelOf(null), 1);
assert.equal(zoomLevelOf(""), 1);
assert.equal(zoomLevelOf(3), 1, "out of range");
assert.equal(zoomLevelOf(1.3), 1, "not a step");
assert.equal(zoomLevelOf("abc"), 1);
assert.equal(zoomLevelOf({ level: 1.1 }), 1);

// The caption buttons' strip grows with the 40px title bar.
assert.equal(TITLEBAR_HEIGHT, 40);
assert.equal(titleBarHeight(1), 40);
assert.equal(titleBarHeight(1.25), 50);
assert.equal(titleBarHeight(0.67), 27);
assert.equal(titleBarHeight(2), 80);

// ---- wiring -------------------------------------------------------------------------
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [main, page, app, pane, css, nav, mermaid, lights, design, jarvis, task, pipelines] = await Promise.all([
  read("../src/main.mts"),
  read("../web/src/uiZoom.ts"),
  read("../web/src/app.ts"),
  read("../web/src/readingPane.ts"),
  read("../web/style.css"),
  read("../web/src/sectionNav.ts"),
  read("../web/src/mermaid.ts"),
  read("../web/src/severityLights.ts"),
  read("../DESIGN.md"),
  read("../web/src/jarvis.ts"),
  read("../web/src/jarvisTask.ts"),
  read("../web/src/pipelines.ts"),
]);

// The shell owns the keys, for every window, and the size lasts.
assert.match(main, /contents\.on\("before-input-event"/, "the shell takes the keys before the page");
assert.match(main, /event\.preventDefault\(\);\s*setUiZoom\(nextZoom\(uiZoom, command\), contents\)/);
assert.match(main, /for \(const window of BrowserWindow\.getAllWindows\(\)\) sizeWindow\(window\)/, "every window follows");
assert.match(main, /setZoomFactor\(uiZoom\)/);
assert.match(main, /setTitleBarOverlay\(\{ height: titleBarHeight\(uiZoom\) \}\)/, "the caption strip grows with the title bar");
assert.match(main, /zoomFactor: uiZoom/, "a new window opens at the size");
assert.match(main, /"ui-zoom\.json"/, "the size is saved in the data folder");
assert.match(main, /contents\.on\("did-navigate", \(\) => sizeWindow\(window\)\)/, "a reload onto a new port keeps the size");
assert.equal(main.match(/followUiZoom\(window\);/g)?.length, 4, "the main window, code windows, the PR window and the To-dos window all follow");
assert.match(main, /devis:ui-zoom/);
assert.match(main, /Menu\.setApplicationMenu\(\s*Menu\.buildFromTemplate\(/);
assert.doesNotMatch(main, /zoomIn|zoomOut|resetZoom/, "Electron's zoom roles would size one window on their own");

assert.match(page, /addEventListener\("devis:ui-zoom"/);
assert.match(page, /toast\(`Interface \$\{/, "each step is announced");
assert.match(page, /"adoPrOps\.zoom\."/, "the old per-view sizes are tidied away");
assert.match(app, /initUiZoom\(\);/);

// No part of the page zooms itself any more.
assert.equal(existsSync(new URL("../web/src/viewZoom.ts", import.meta.url)), false, "the per-view zoom is gone");
for (const [name, text] of [["readingPane", pane], ["jarvis", jarvis], ["jarvisTask", task], ["pipelines", pipelines]]) {
  assert.doesNotMatch(text, /zoomable\(|paneZoomCommand|viewZoom/, `${name} has no zoom keys of its own`);
}
assert.doesNotMatch(css, /--pane-zoom|data-zoom-view|--view-zoom|--view-base/);
assert.match(css, /\.tm:not\(\.is-embedded\) > \* \{ zoom: 1\.125; \}/, "the task sheet reads a step larger");
assert.match(pane, /if \(solo \|\| feature === "pipelines" \|\| feature === "jarvis"\) return;/, "the hidden reading pane leaves Escape to Pipelines and the Workspace");

// Client rects are visual px inside a CSS-zoomed subtree (the task sheet); layout and scroll offsets stay local px.
assert.match(nav, /scroller\.currentCSSZoom/, "section offsets convert rects to scroll space");
assert.match(mermaid, /currentCSSZoom/, "diagram pan and wheel anchors convert client px");
assert.match(lights, /host\.currentCSSZoom/, "the severity drawer converts its light's offset");

assert.match(design, /\*\*Interface size:\*\*/, "DESIGN.md documents the interface size");
assert.doesNotMatch(design, /Pane zoom|Workspace zoom/);

console.log("Interface size harness passed");
