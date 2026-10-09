import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [modal, threads, reviewPanel, ask, publishSchema] = await Promise.all([
    readFile(new URL("../web/src/rephraseModal.ts", import.meta.url), "utf8"),
    readFile(new URL("../web/src/threads.ts", import.meta.url), "utf8"),
    readFile(new URL("../web/src/reviewPanel.ts", import.meta.url), "utf8"),
    readFile(new URL("../web/src/ask.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/review-publish.mts", import.meta.url), "utf8"),
]);

assert.match(modal, /Review &amp; post/);
assert.match(modal, />Rephrase<\/button>/);
assert.match(modal, /ta\.value = opts\.initialText\?\.trim\(\) \? opts\.initialText : opts\.comment/);
assert.doesNotMatch(modal, /void generate\(\);/);
assert.match(modal, /comment: ta\.value/);

assert.match(threads, /initialText: finding\.humanizedComment \?\? finding\.comment/);
assert.match(reviewPanel, /initialText: finding\.humanizedComment \?\? finding\.comment/);
assert.match(ask, /finding\.technicalExplanation \|\| finding\.comment/);
assert.match(publishSchema, /"comment",\s+"technicalExplanation"/);

console.log("Review comment UX harness passed");
