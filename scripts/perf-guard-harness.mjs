// Performance guard: pins the fixes that keep the glass UI and the backend light.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [cssRaw, app, notifyWatch, reviewPanel, azauth, ado, main] = await Promise.all([
  read("../web/style.css"),
  read("../web/src/app.ts"),
  read("../web/src/notifyWatch.ts"),
  read("../web/src/reviewPanel.ts"),
  read("../src/azauth.mts"),
  read("../src/ado.mts"),
  read("../src/main.mts"),
]);

// ---- CSS: blur only on small sticky/floating chrome ---------------------------
// A pane-sized backdrop-filter re-blurs the field on every scroll frame
// (measured: 12 fps vs 32 fps on a software rasterizer).
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
const blurred = [];
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const value = /(?:^|;)\s*backdrop-filter:\s*([^;]+)/.exec(m[2]);
  if (value && !/^none\b/.test(value[1].trim())) blurred.push(m[1].trim().replace(/\s+/g, " "));
}
const allowed = new Set([
  ".detail-head",
  ".ask-overlay",
  ".ask-dialog",
  ".sl-pop, .pr-comments-pop, .detail-menu, .sel-toolbar, .inbox-flyout, .toast",
  ".chain-zoom",
]);
for (const selector of blurred) {
  assert.ok(allowed.has(selector), `backdrop-filter is reserved for small chrome; found it on "${selector}"`);
}
for (const heavy of [".list-pane", ".reading-pane", ".chain-pane", ".pipeline-catalog", ".chain-node", ".chain-inspector", ".stale-banner"]) {
  assert.ok(
    !blurred.some((selector) => selector.split(",").some((part) => part.trim().startsWith(heavy))),
    `${heavy} must not use backdrop-filter`
  );
}
assert.doesNotMatch(css, /reticle-scan[^;]*\binfinite\b/, "the idle reticle must not loop forever");

// ---- Electron: Mica by default ---------------------------------------------------
assert.match(main, /return pick === "acrylic" \|\| pick === "none" \? pick : "mica"/, "Mica is the default backdrop");

// ---- Frontend: no per-keystroke or no-op full re-renders --------------------------
assert.match(app, /const SEARCH_DEBOUNCE_MS = \d+;/, "queue search is debounced");
assert.match(
  app,
  /queueSearch\.addEventListener\("input", \(\) => \{[\s\S]*?cancelSearchRender\(\);\s*searchTimer = setTimeout\(/,
  "the search input schedules one render"
);
assert.match(
  app,
  /state\.query = "";\s*cancelSearchRender\(\);\s*renderList\(false\);/,
  "Esc cancels a pending search render and renders at once"
);
assert.match(
  notifyWatch,
  /if \(sig !== lastSig\) \{\s*lastSig = sig;\s*window\.dispatchEvent\(new CustomEvent\("ado-pr-updated"\)\);/,
  "the review watcher re-renders the queue only on change"
);
assert.match(notifyWatch, /prev = \{ \.\.\.state\.reviews \};\s*lastSig = null;/, "each watch starts with a fresh signature");
assert.match(reviewPanel, /if \(panel\.isConnected\) void refreshReviewPanel\(/, "a detached review panel stops polling");

// ---- Backend: bounded az and ADO calls ----------------------------------------------
assert.match(azauth, /const _inflight = new Map<string, Promise<string>>\(\);/, "concurrent token requests share one az call");
assert.match(azauth, /"taskkill", \["\/pid", String\(pid\), "\/T", "\/F"\]/, "a stuck az call is killed with its whole tree");
assert.match(azauth, /TOKEN_TIMEOUT_MS = \d/, "az calls time out");
assert.match(ado, /req\.setTimeout\(REQUEST_TIMEOUT_MS,/, "ADO requests time out");
assert.match(
  ado,
  /!retried && method === "GET" && req\.reusedSocket && err\.code === "ECONNRESET"/,
  "only an idempotent GET on a reused socket is retried"
);

console.log("perf-guard-harness: ok");
