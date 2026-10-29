import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { linkMenuEntries } from "../web/prLinks.js";

const pr = (id) => ({ id, url: `https://dev.azure.com/org/proj/_git/repo/pullrequest/${id}` });

// ---- an unchecked row only offers its own link ----
let entries = linkMenuEntries(pr(1), [pr(2), pr(3)], false);
assert.deepEqual(entries.map((e) => e.kind), ["one"]);
assert.equal(entries[0].label, "Copy link to PR");
assert.equal(entries[0].text, pr(1).url);
assert.equal(entries[0].count, 1);

// ---- a checked row alone has nothing extra to bulk-copy ----
entries = linkMenuEntries(pr(1), [pr(1)], true);
assert.deepEqual(entries.map((e) => e.kind), ["one"]);

// ---- a checked row with other checked PRs adds the bulk entry, in the order given ----
entries = linkMenuEntries(pr(2), [pr(1), pr(2), pr(3)], true);
assert.deepEqual(entries.map((e) => e.kind), ["one", "checked"]);
assert.equal(entries[0].text, pr(2).url, "single copy is the clicked PR, not the whole selection");
assert.equal(entries[1].label, "Copy links to all checked PRs (3)");
assert.equal(entries[1].text, [pr(1), pr(2), pr(3)].map((p) => p.url).join("\n"));
assert.equal(entries[1].count, 3);

// ---- missing urls are skipped, never copied as blanks ----
entries = linkMenuEntries({ id: 9 }, [pr(1), { id: 9 }, pr(2)], true);
assert.deepEqual(entries.map((e) => e.kind), ["checked"]);
assert.equal(entries[0].text, `${pr(1).url}\n${pr(2).url}`);
assert.equal(entries[0].count, 2);

// ---- wiring: the queue listens for right-clicks on PR rows and uses the checked set ----
const list = await readFile(new URL("../web/src/list.ts", import.meta.url), "utf8");
assert.match(list, /view\.addEventListener\("contextmenu"/);
assert.match(list, /closest<HTMLElement>\("\.pr-card"\)/);
assert.match(list, /linkMenuEntries\(pr, checkedPrs\(\), reviewSel\.has\(key\)\)/);

console.log("PR link copy harness passed");
