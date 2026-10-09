import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
    clampView,
    diagramFrameHeight,
    fitView,
    nextZoomLevel,
    PAN_DRAG_THRESHOLD,
    panView,
    zoomViewAt,
} from "../web/mermaid.js";

const close = (actual, expected, message) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);

// Zoom scales the diagram inside the frame, keeping the point under the anchor fixed.
assert.deepEqual(
    zoomViewAt({ x: 100, y: 50, scale: 1 }, { x: 300, y: 250 }, 2),
    { x: -100, y: -150, scale: 2 },
    "zoom in should keep the diagram point under the anchor",
);
assert.deepEqual(
    zoomViewAt({ x: -100, y: -150, scale: 2 }, { x: 300, y: 250 }, 1),
    { x: 100, y: 50, scale: 1 },
    "zoom out should be the exact inverse of zoom in",
);

// Panning moves the diagram with the pointer, independent of any scroll range.
assert.deepEqual(
    panView({ x: 10, y: 20, scale: 1.5 }, { x: 300, y: 200 }, { x: 250, y: 260 }),
    { x: -40, y: 80, scale: 1.5 },
    "the diagram should follow the pointer",
);

const content = { width: 400, height: 300 };
const frame = { width: 800, height: 600 };
assert.deepEqual(
    clampView({ x: -100, y: 500, scale: 1 }, content, frame),
    { x: -100, y: 500, scale: 1 },
    "a diagram smaller than the frame should still pan freely",
);
assert.deepEqual(
    clampView({ x: -1000, y: 2000, scale: 1 }, content, frame),
    { x: -352, y: 552, scale: 1 },
    "panning should keep part of the diagram in view",
);
assert.deepEqual(
    clampView({ x: -50, y: -50, scale: 1 }, { width: 20, height: 10 }, frame),
    { x: 0, y: 0, scale: 1 },
    "a tiny diagram should stay entirely in view",
);

// Fit centres the whole diagram and never enlarges it.
assert.deepEqual(fitView(content, frame, 12), { scale: 1, x: 200, y: 150 }, "small diagrams fit at 100%, centred");
const fitted = fitView({ width: 1576, height: 1176 }, frame, 12);
close(fitted.scale, 576 / 1176, "tall diagrams fit the frame height");
close(fitted.x, (800 - 1576 * fitted.scale) / 2, "fitted diagrams are centred horizontally");
close(fitted.y, 12, "fitted diagrams keep the frame padding");

// Zoom steps land on familiar levels, including 100% from a fitted scale.
assert.equal(nextZoomLevel(0.73, 1), 1, "zoom in from a fitted scale should reach 100%");
assert.equal(nextZoomLevel(1, 1), 1.25);
assert.equal(nextZoomLevel(0.73, -1), 0.5);
assert.equal(nextZoomLevel(4, 1), 4, "zoom in should stop at the maximum");
assert.equal(nextZoomLevel(0.1, -1), 0.1, "zoom out should stop at the minimum");
assert.equal(nextZoomLevel(0.05, 1), 0.1, "zoom in from a very small fit should reach the first level");

// The frame height is chosen once from the fitted width, then stays fixed while zooming.
assert.equal(diagramFrameHeight(content, 800, 12, 200, 640), 324);
assert.equal(diagramFrameHeight({ width: 1600, height: 300 }, 824, 12, 200, 640), 200);
assert.equal(diagramFrameHeight({ width: 400, height: 3000 }, 800, 12, 200, 640), 640);
assert.equal(diagramFrameHeight(content, 0, 12, 200, 640), 324, "an unmeasured frame should use the natural height");

assert.ok(PAN_DRAG_THRESHOLD > 0 && PAN_DRAG_THRESHOLD <= 5, "a small drag threshold keeps clicks working");

const [source, style] = await Promise.all([
    readFile(new URL("../web/src/mermaid.ts", import.meta.url), "utf8"),
    readFile(new URL("../web/style.css", import.meta.url), "utf8"),
]);
assert.match(source, /addEventListener\("pointerdown"/);
assert.match(source, /setPointerCapture/);
assert.match(source, /addEventListener\("pointercancel"/);
assert.match(source, /addEventListener\("keydown"/);
assert.match(source, /addEventListener\(\s*"wheel"[\s\S]*?passive: false/, "Ctrl+wheel zoom needs a non-passive listener");
assert.match(source, /new ResizeObserver/, "the frame should refit when it is first laid out or resized");
assert.match(source, /translate\(\$\{[^}]+\}px, \$\{[^}]+\}px\) scale\(/, "the stage should be positioned with a transform");
assert.match(source, /viewport\.tabIndex = 0/);
assert.doesNotMatch(source, /scrollLeft|scrollTop/, "panning should not depend on a scroll range");

const viewportRule = style.match(/\.mmd-viewport\s*\{[^}]*\}/s)?.[0] ?? "";
assert.match(viewportRule, /cursor:\s*grab;/);
assert.match(viewportRule, /overflow:\s*hidden;/, "the frame should clip the diagram instead of scrolling");
assert.doesNotMatch(viewportRule, /max-height/, "the frame height should not follow the diagram size");
assert.match(style, /\.mmd-stage\s*\{[^}]*position:\s*absolute;[^}]*transform-origin:\s*0 0;/s);
assert.match(style, /\.mmd-viewport\.panning\s*\{[^}]*cursor:\s*grabbing;[^}]*user-select:\s*none;/s);

console.log("Mermaid pan harness passed");