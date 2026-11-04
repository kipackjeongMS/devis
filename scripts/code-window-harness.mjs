// Tests the code window's pure parts (src/code-window.mts): which window.open URLs open one,
// the URL the shell builds, reading saved bounds back, and where a new window goes.
// Run after `npm run build:backend`: node scripts/code-window-harness.mjs
import assert from "node:assert/strict";
import { CASCADE_STEP, CODE_WINDOW_MIN, codeWindowUrl, codeWindowWorker, isFocusMainUrl, parsePlacement, placeCodeWindow } from "../code-window.mjs";

const origin = "http://127.0.0.1:4317";
const id = "3f2b8c1e-9a4d-4e6b-8f21-0c5d7e9a1b23";

// ---- which URLs open a code window ----
assert.equal(codeWindowWorker(`${origin}/code.html?worker=${id}`, origin), id);
assert.equal(codeWindowWorker(`${origin}/code.html?worker=${id.toUpperCase()}#mode=branch`, origin), id.toUpperCase());
assert.equal(codeWindowWorker(`${origin}/code.html?worker=${id}&shell=glass`, origin), id, "extra params are ignored, not trusted");
assert.equal(codeWindowWorker(`http://127.0.0.1:9999/code.html?worker=${id}`, origin), null, "another port");
assert.equal(codeWindowWorker(`https://evil.example/code.html?worker=${id}`, origin), null, "another host");
assert.equal(codeWindowWorker(`${origin}/index.html?worker=${id}`, origin), null, "another page");
assert.equal(codeWindowWorker(`${origin}/sub/code.html?worker=${id}`, origin), null, "another path");
assert.equal(codeWindowWorker(`${origin}/code.html`, origin), null, "no worker");
assert.equal(codeWindowWorker(`${origin}/code.html?worker=../../etc`, origin), null, "not a UUID");
assert.equal(codeWindowWorker(`${origin}/code.html?worker=${id}x`, origin), null, "UUID plus junk");
assert.equal(codeWindowWorker(`${origin}/code.html?worker=${id}`, ""), null, "no origin yet");
assert.equal(codeWindowWorker("not a url", origin), null);
assert.equal(codeWindowWorker(`file:///C:/code.html?worker=${id}`, origin), null);

// ---- the URL the shell builds ----
assert.equal(codeWindowUrl(origin, id), `${origin}/code.html?worker=${id}`);
assert.equal(codeWindowUrl(origin, id, "#mode=last&repo=a&path=src%2Fx.ts"), `${origin}/code.html?worker=${id}#mode=last&repo=a&path=src%2Fx.ts`);
assert.equal(codeWindowUrl(origin, id, "#"), `${origin}/code.html?worker=${id}`, "an empty hash is dropped");
assert.equal(codeWindowUrl(origin, id, "mode=x"), `${origin}/code.html?worker=${id}`, "only a real hash rides along");

// ---- the "back to the main window" URL ----
assert.equal(isFocusMainUrl(`${origin}/?focus=main`, origin), true);
assert.equal(isFocusMainUrl(`${origin}/?focus=other`, origin), false);
assert.equal(isFocusMainUrl(`${origin}/code.html?focus=main`, origin), false, "only the main page");
assert.equal(isFocusMainUrl("https://evil.example/?focus=main", origin), false, "only the service's origin");
assert.equal(isFocusMainUrl(`${origin}/?focus=main`, ""), false, "no origin yet");
assert.equal(isFocusMainUrl("not a url", origin), false);

// ---- saved bounds ----
assert.deepEqual(parsePlacement({ x: 10.4, y: 20, width: 800, height: 600, maximized: true }), { x: 10, y: 20, width: 800, height: 600, maximized: true });
assert.deepEqual(parsePlacement({ x: -1920, y: 0, width: 800, height: 600 }), { x: -1920, y: 0, width: 800, height: 600, maximized: false });
for (const bad of [null, 1, "x", [], {}, { x: 0, y: 0, width: 0, height: 600 }, { x: 0, y: 0, width: 800, height: "600" }, { x: NaN, y: 0, width: 800, height: 600 }]) {
    assert.equal(parsePlacement(bad), null, JSON.stringify(bad));
}

// ---- placement ----
const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const left = { x: -2560, y: 0, width: 2560, height: 1400 };

// Nothing saved: the main window's whole work area.
let p = placeCodeWindow(null, null, primary);
assert.deepEqual(p.bounds, primary);
assert.equal(p.maximized, false);

// Saved and on screen: there.
p = placeCodeWindow({ x: -2400, y: 100, width: 1600, height: 900, maximized: true }, left, primary);
assert.deepEqual(p.bounds, { x: -2400, y: 100, width: 1600, height: 900 });
assert.equal(p.maximized, true);
assert.deepEqual(p.area, left);

// Saved, bigger than any display now: shrunk to fit.
p = placeCodeWindow({ x: 100, y: 50, width: 3000, height: 2000 }, primary, primary);
assert.deepEqual(p.bounds, { x: 0, y: 0, width: 1920, height: 1040 });

// Saved, hanging off the edge but mostly on: pulled back inside.
p = placeCodeWindow({ x: 1300, y: 500, width: 800, height: 600 }, primary, primary);
assert.deepEqual(p.bounds, { x: 1120, y: 440, width: 800, height: 600 });

// Saved on a monitor that's gone (less than half on any display): that size, centered on the main window's display.
p = placeCodeWindow({ x: 3000, y: 100, width: 1200, height: 800, maximized: false }, primary, primary);
assert.deepEqual(p.bounds, { x: 360, y: 120, width: 1200, height: 800 });

// Saved below the minimum (hand-edited file): raised to the minimum.
p = placeCodeWindow({ x: 10, y: 10, width: 100, height: 100 }, primary, primary);
assert.equal(p.bounds.width, CODE_WINDOW_MIN.width);
assert.equal(p.bounds.height, CODE_WINDOW_MIN.height);

// A display smaller than the minimum: the window fits the display.
const tiny = { x: 0, y: 0, width: 400, height: 300 };
p = placeCodeWindow(null, null, tiny);
assert.deepEqual(p.bounds, tiny);

// A second window steps down and right past the first, shrinking to stay on the display.
p = placeCodeWindow(null, null, primary, [primary]);
assert.deepEqual(p.bounds, { x: CASCADE_STEP, y: CASCADE_STEP, width: 1920 - CASCADE_STEP, height: 1040 - CASCADE_STEP });
const third = placeCodeWindow(null, null, primary, [primary, p.bounds]);
assert.deepEqual(third.bounds, { x: 2 * CASCADE_STEP, y: 2 * CASCADE_STEP, width: 1920 - 2 * CASCADE_STEP, height: 1040 - 2 * CASCADE_STEP });

// Windows elsewhere don't push it.
p = placeCodeWindow(null, null, primary, [{ x: 500, y: 500, width: 800, height: 600 }]);
assert.deepEqual(p.bounds, primary);

// The cascade stops before the window would drop under the minimum.
const cramped = { x: 0, y: 0, width: CODE_WINDOW_MIN.width + 30, height: CODE_WINDOW_MIN.height + 30 };
const open = [cramped, { x: CASCADE_STEP, y: CASCADE_STEP, width: CODE_WINDOW_MIN.width + 2, height: CODE_WINDOW_MIN.height + 2 }];
p = placeCodeWindow(null, null, cramped, open);
assert.ok(p.bounds.width >= CODE_WINDOW_MIN.width && p.bounds.height >= CODE_WINDOW_MIN.height);
assert.ok(p.bounds.x + p.bounds.width <= cramped.width && p.bounds.y + p.bounds.height <= cramped.height);

console.log("code-window-harness: ok");
