import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { activeSectionIndex, isSplitLayout, SPLIT_MIN_WIDTH } from "../web/shellModel.js";

// ---- pure shell model -------------------------------------------------------
assert.equal(SPLIT_MIN_WIDTH, 1100);
assert.equal(isSplitLayout(1440), true);
assert.equal(isSplitLayout(1100), true);
assert.equal(isSplitLayout(1099), false);

const tops = [0, 400, 900, 1600];
assert.equal(activeSectionIndex(tops, 0, 120, false), 0);
assert.equal(activeSectionIndex(tops, 279, 120, false), 0, "a section activates once it reaches the sticky head");
assert.equal(activeSectionIndex(tops, 280, 120, false), 1);
assert.equal(activeSectionIndex(tops, 1000, 120, false), 2);
assert.equal(activeSectionIndex(tops, 1000, 120, true), 3, "scrolling to the end activates the last section");
assert.equal(activeSectionIndex([], 500, 120, false), -1);

// ---- shell structure --------------------------------------------------------
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [html, css, detail, list, app, pane, nav, icons, main, ask, rephrase, inbox, selection] = await Promise.all([
  read("../web/index.html"),
  read("../web/style.css"),
  read("../web/src/detail.ts"),
  read("../web/src/list.ts"),
  read("../web/src/app.ts"),
  read("../web/src/readingPane.ts"),
  read("../web/src/sectionNav.ts"),
  read("../web/src/icons.ts"),
  read("../src/main.mts"),
  read("../web/src/ask.ts"),
  read("../web/src/rephraseModal.ts"),
  read("../web/src/inboxPanel.ts"),
  read("../web/src/selection.ts"),
]);

assert.ok(!existsSync(new URL("../web/src/modal.ts", import.meta.url)), "the slide-over modal is replaced by the reading pane");
for (const id of ["btnInbox", "btnRefresh", "btnSettings", "filterbar", "orgFilter", "projectFilter", "queueTabs", "queueSearch", "scopeFields", "bulkReviewHost", "view", "toast", "listPane", "readingPane"]) {
  assert.match(html, new RegExp(`id="${id}"`), `index.html keeps #${id}`);
}
assert.match(html, /class="titlebar"/);
assert.match(html, /<section id="listPane" class="list-pane"/);
assert.match(html, /<section id="readingPane" class="reading-pane"/);

// Reading pane: docked, Esc respects inner consumers and text entry.
assert.match(pane, /export function openPane\(/);
assert.match(pane, /export function closePane\(/);
assert.match(pane, /export function isPaneOpen\(/);
assert.match(pane, /window\.addEventListener\("keydown"/);
assert.match(pane, /e\.defaultPrevented/);
assert.match(pane, /isTextEntry\(/);
assert.match(pane, /listPane\.inert/);
assert.match(detail, /from "\.\/readingPane\.js"/);
assert.doesNotMatch(detail, /modal-panel|openModal|closeModal/);
assert.match(detail, /closest<HTMLElement>\("\.pane-scroll"\)/);
assert.match(detail, /mountSectionNav\(/);

// Escape consumers mark the event so the pane stays open underneath them.
for (const [name, src] of [["ask", ask], ["rephraseModal", rephrase], ["inboxPanel", inbox], ["selection", selection]]) {
  assert.match(src, /e\.preventDefault\(\)/, `${name} marks a consumed Escape`);
}

// The queue keeps the open PR's review poll alive while filters re-render.
assert.match(list, /if \(stopPolling && !isPaneOpen\(\)\) stopReviewPoll\(\)/);
assert.match(list, /is-open/);
// Two queue views: My feed lanes and All by repository, with persisted folds and a search.
assert.match(list, /feedLane\(/);
assert.match(list, /adoPrOps\.queueFolds/);
assert.match(list, /aria-pressed/);
assert.match(list, /aria-expanded/);
assert.match(html, /data-view="feed"[^>]*>My feed/);
assert.match(html, /data-view="all"[^>]*>All/);
assert.match(html, /<input id="queueSearch" type="search"/);
assert.doesNotMatch(html, /assignFilter|data-assign/);
assert.match(app, /setPage\("settings"\)/);
assert.match(app, /setQueueView\(/);
assert.match(app, /queueSearch\.focus\(\)/, "Ctrl+F focuses the queue search");
assert.match(css, /\.fold\.collapsed > \.fold-body\s*\{\s*display:\s*none;/);
assert.doesNotMatch(css, /\.plate-(group|head|body)|\.queue-title/);

// Section tabs scroll inside the pane and follow the reader.
assert.match(nav, /scrollTo\(/);
assert.match(nav, /activeSectionIndex\(/);
assert.match(nav, /ResizeObserver/);

// Icons replace emoji glyphs; strokes are scoped so filled-icon rules can't fill them.
assert.match(icons, /export function icon\(/);
assert.match(css, /svg\.ic\s*\{[^}]*fill:\s*none;[^}]*stroke:\s*currentColor;/s);
assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
assert.match(css, /\.reading-pane\b/);
assert.match(css, /prefers-reduced-motion/);
const emoji = /[\u{1F4AC}\u{23F3}\u{25F7}\u{26A0}\u{1F464}\u{2726}\u{29C9}\u{21A9}]/u;
for (const file of ["prStatus", "list", "inboxPanel", "reviewPanel", "diff", "selection", "staleBanner"]) {
  const src = await read(`../web/src/${file}.ts`);
  assert.doesNotMatch(src, emoji, `${file}.ts renders icons instead of emoji`);
}

// Native Windows 11 frame: a Mica backdrop (acrylic only on request) + a title-bar overlay, with a solid fallback.
assert.match(main, /return pick === "acrylic" \|\| pick === "none" \? pick : "mica"/);
assert.match(main, /backgroundMaterial:\s*backdrop/);
assert.match(main, /nativeTheme\.themeSource\s*=\s*"dark"/);
assert.match(main, /titleBarOverlay/);
assert.match(main, /searchParams\.set\("shell",\s*glass \? "glass" : "solid"\)/);
assert.match(css, /html\.glass\s*\{/);
assert.match(css, /prefers-reduced-transparency/);

// Notification previews read as prose, not raw ADO markup.
const { plainSnippet } = await import("../web/util.js");
assert.equal(
  plainSnippet('<span style="font-family:Segoe UI">Gate <b>packaging</b></span> on&nbsp;changes'),
  "Gate packaging on changes"
);
assert.equal(
  plainSnippet("### ![](https://img.shields.io/x.svg) Uses [the flight](https://x/y) and `code` **now**"),
  "Uses the flight and code now"
);
assert.equal(plainSnippet("  plain   text \n here "), "plain text here");
assert.equal(plainSnippet('PR Assistant <span style="height: 24px;'), "PR Assistant", "a tag cut off by truncation is dropped");
assert.equal(plainSnippet(""), "");
assert.match(inbox, /plainSnippet\(n\.snippet\)/);
assert.match(inbox, /snip \? `<span class="inbox-row-snip">\$\{esc\(snip\)\}/);
const diff = await read("../web/src/diff.ts");
assert.match(diff, /class="file-name"/);
assert.match(diff, /class="file-dir"/);

console.log("Fluent shell harness passed");
