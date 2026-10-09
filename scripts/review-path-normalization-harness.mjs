import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { canonicalReviewFilePath as canonicalBackendPath } from "../review-path.mjs";
import { canonicalReviewFilePath as canonicalFrontendPath } from "../web/reviewPath.js";

const cases = [
    ["/AppConfigPortalExtension/test.ts", "/AppConfigPortalExtension/test.ts"],
    ["AppConfigPortalExtension/test.ts", "/AppConfigPortalExtension/test.ts"],
    ["./AppConfigPortalExtension/test.ts", "/AppConfigPortalExtension/test.ts"],
    ["\\AppConfigPortalExtension\\test.ts", "/AppConfigPortalExtension/test.ts"],
    ["  AppConfigPortalExtension/test.ts  ", "/AppConfigPortalExtension/test.ts"],
];

for (const [input, expected] of cases) {
    assert.equal(canonicalBackendPath(input), expected);
    assert.equal(canonicalFrontendPath(input), expected);
}

assert.equal(
    canonicalFrontendPath("AppConfigPortalExtension/test.ts"),
    canonicalFrontendPath("/AppConfigPortalExtension/test.ts"),
    "historical findings must match current ADO paths",
);
assert.equal(
    canonicalFrontendPath("/AppConfigPortalExtension/Test.ts"),
    "/AppConfigPortalExtension/Test.ts",
    "repository path casing must be preserved",
);

const [store, diff, reveal] = await Promise.all([
    readFile(new URL("../src/store.mts", import.meta.url), "utf8"),
    readFile(new URL("../web/src/diff.ts", import.meta.url), "utf8"),
    readFile(new URL("../web/src/reveal.ts", import.meta.url), "utf8"),
]);

assert.match(store, /file:\s*canonicalReviewFilePath\(/);
assert.match(diff, /canonicalReviewFilePath\(f\.file\).*canonicalReviewFilePath\(filePath\)/s);
assert.match(reveal, /canonicalReviewFilePath\(candidate\.dataset\.path\)/);

console.log("Review path normalization harness passed");
