import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [panel, jarvis, styles] = await Promise.all([
    readFile(new URL("../web/src/prPanel.ts", import.meta.url), "utf8"),
    readFile(new URL("../web/src/jarvis.ts", import.meta.url), "utf8"),
    readFile(new URL("../web/style.css", import.meta.url), "utf8"),
]);

// The aggregate Pull requests page is gone; its bulk actions live in the Workspace panel.
assert.match(panel, /function bulkBar\(queuing: ReadonlySet<string>\)/);
assert.match(panel, /role="toolbar" aria-label="Selected pull requests"/);
assert.match(panel, /data-act="pr-select-all"/);
assert.match(panel, /data-act="pr-bulk-clear"/);
assert.match(panel, /data-act="pr-bulk-copy"/);
assert.match(panel, /data-act="pr-bulk-review"/);
assert.match(panel, /\(selecting \? bulkBar\(ctx\.queuing\) : ""\)/, "the bar shows only in select mode");
assert.match(jarvis, /case "pr-bulk-review":\s*return void bulkReview\(selectedPrs\(\)\)/);
assert.match(jarvis, /reviewPhase\(p\) !== "active"/, "PRs already being reviewed are skipped");
assert.match(styles, /\.pp-bulk\s*\{[\s\S]*display:\s*flex/);

console.log("Filter bulk actions harness passed");
