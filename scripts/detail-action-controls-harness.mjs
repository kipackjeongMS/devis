import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [detail, style] = await Promise.all([
    readFile(new URL("../web/src/detail.ts", import.meta.url), "utf8"),
    readFile(new URL("../web/style.css", import.meta.url), "utf8"),
]);

assert.doesNotMatch(detail, /modal-close/);
assert.doesNotMatch(detail, /Review PR with Copilot<\/button>/);
assert.doesNotMatch(detail, /pr-refresh-label/);
assert.match(detail, /class="detail-icon-btn copilot-review-btn"/);
assert.match(detail, /class="detail-icon-btn pr-refresh"/);
assert.equal((detail.match(/class="[^"]*stroke-icon[^"]*"/g) || []).length, 2);

const actionGroup = detail.slice(
    detail.indexOf('const actions = el(`<span class="detail-sub-actions">'),
    detail.indexOf("sub.appendChild(actions);"),
);
assert.ok(actionGroup.indexOf("actions.appendChild(sendAll)") < actionGroup.indexOf("actions.appendChild(adoLink)"));
assert.ok(actionGroup.indexOf("actions.appendChild(refreshBtn)") < actionGroup.indexOf("actions.appendChild(adoLink)"));
assert.match(style, /\.detail-icon-btn:disabled/);
assert.match(style, /\.detail-icon-btn svg\.stroke-icon\s*\{[^}]*fill:\s*none;[^}]*stroke:\s*currentColor;/s);

console.log("Detail action controls harness passed");
