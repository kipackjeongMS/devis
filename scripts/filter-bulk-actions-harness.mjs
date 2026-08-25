import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, list, styles] = await Promise.all([
    readFile(new URL("../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../web/src/list.ts", import.meta.url), "utf8"),
    readFile(new URL("../web/style.css", import.meta.url), "utf8"),
]);

assert.match(
    html,
    /<div id="filterbar"[\s\S]*<div id="bulkReviewHost" class="bulk-review-host"><\/div>[\s\S]*<\/div>/,
    "bulk actions should live inside the review scope panel",
);
assert.match(list, /bulkReviewHost\.replaceChildren\(renderBulkReviewBar\(visible\)\)/);
assert.doesNotMatch(list, /view\.appendChild\(renderBulkReviewBar\(visible\)\)/);
assert.match(styles, /\.bulk-review-host\s*\{[\s\S]*grid-column:\s*1\s*\/\s*-1/);
assert.match(styles, /\.bulk-review-host\s+\.bulk-review-bar\s*\{[\s\S]*position:\s*static/);

console.log("Filter bulk actions harness passed");
