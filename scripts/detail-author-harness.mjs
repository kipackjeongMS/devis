import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initials, prAuthorMarkup } from "../web/prAuthor.js";

const [detail, style] = await Promise.all([
    readFile(new URL("../web/src/detail.ts", import.meta.url), "utf8"),
    readFile(new URL("../web/style.css", import.meta.url), "utf8"),
]);

assert.equal(initials("Ada Lovelace"), "AL");
assert.equal(initials("Grace Brewster Hopper"), "GH");
assert.equal(initials("[msazure]\\Platform Team"), "PT");
assert.equal(initials("   "), "?");

const created = new Date(Date.now() - 3 * 86400 * 1000).toISOString();
const chip = prAuthorMarkup("Ada Lovelace", created);
assert.match(chip, /^<span class="detail-author" title="Opened by Ada Lovelace on [^"]+">/);
assert.match(chip, /<span class="persona" aria-hidden="true">AL<\/span>/);
assert.match(chip, /<span class="detail-author-name">Ada Lovelace<\/span>/);
assert.match(chip, /<span class="detail-author-when">opened 3d ago<\/span>/);
assert.doesNotMatch(chip, /visually-hidden/);

const undated = prAuthorMarkup("Ada Lovelace", undefined);
assert.match(undated, /title="Opened by Ada Lovelace"/);
assert.doesNotMatch(undated, /detail-author-when/);
assert.match(undated, /<span class="visually-hidden">, author<\/span>/);
assert.doesNotMatch(prAuthorMarkup("Ada Lovelace", "not a date"), /detail-author-when|NaN/);

const hostile = prAuthorMarkup('<img src=x onerror="x">', created);
assert.doesNotMatch(hostile, /<img/);
assert.match(hostile, /&lt;img src=x onerror=&quot;x&quot;&gt;/);

assert.equal(prAuthorMarkup(undefined, created), "");
assert.equal(prAuthorMarkup("  ", created), "");

const metaBlock = detail.slice(
    detail.indexOf('const meta = el(`<div class="detail-sub"></div>`);'),
    detail.indexOf("head.appendChild(meta);"),
);
const authorAt = metaBlock.indexOf("prAuthorMarkup(pr.author, pr.created)");
assert.ok(authorAt > metaBlock.indexOf("meta.appendChild(identity)"), "author follows the ID group");
assert.ok(authorAt < metaBlock.indexOf('class="detail-repo"'), "author precedes the repo");
assert.doesNotMatch(detail, /function initials\(/, "initials lives in prAuthor.ts");

assert.match(style, /\.detail-author\s*\{[^}]*display:\s*inline-flex;/s);
assert.match(style, /\.detail-author \.persona\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;/s);
assert.match(style, /\.detail-author-name\s*\{[^}]*text-overflow:\s*ellipsis;/s);

console.log("Detail author harness passed");
