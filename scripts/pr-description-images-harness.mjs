import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const {
    validatePrDescriptionImageUrl,
    isAllowedPrImageRedirect,
    normalizePrImageContentType,
} = await import("../pr-description-image.mjs");

assert.equal(
    validatePrDescriptionImageUrl(
        "msazure",
        "https://dev.azure.com/msazure/Project/_apis/wit/attachments/id?fileName=screen.PNG",
    ).expectedContentType,
    "image/png",
);
assert.equal(
    validatePrDescriptionImageUrl(
        "msazure",
        "https://msazure.visualstudio.com/Project/_apis/git/repositories/repo/items?path=/docs/view.jpg",
    ).expectedContentType,
    "image/jpeg",
);
assert.throws(
    () =>
        validatePrDescriptionImageUrl(
            "msazure",
            "https://dev.azure.com/other/Project/_apis/wit/attachments/id?fileName=screen.png",
        ),
    /organization/i,
);
assert.throws(
    () => validatePrDescriptionImageUrl("msazure", "https://example.com/screen.png"),
    /Azure DevOps/i,
);
assert.throws(
    () => validatePrDescriptionImageUrl("msazure", "https://dev.azure.com/msazure/Project/file.gif"),
    /PNG or JPEG/i,
);
assert.throws(
    () => validatePrDescriptionImageUrl("msazure", "http://dev.azure.com/msazure/Project/file.png"),
    /HTTPS/i,
);

assert.equal(
    isAllowedPrImageRedirect(
        "msazure",
        new URL("https://dev.azure.com/msazure/Project/file.png"),
    ),
    true,
);
assert.equal(
    isAllowedPrImageRedirect(
        "msazure",
        new URL("https://assets.example.vsassets.io/content/image"),
    ),
    true,
);
assert.equal(
    isAllowedPrImageRedirect("msazure", new URL("https://example.com/image.png")),
    false,
);
assert.equal(normalizePrImageContentType("image/jpg; charset=binary"), "image/jpeg");
assert.equal(normalizePrImageContentType("text/html"), null);

const [api, detail, images, styles] = await Promise.all([
    readFile(new URL("../src/api.mts", import.meta.url), "utf8"),
    readFile(new URL("../web/src/detail.ts", import.meta.url), "utf8"),
    readFile(new URL("../web/src/prDescriptionImages.ts", import.meta.url), "utf8"),
    readFile(new URL("../web/style.css", import.meta.url), "utf8"),
]);

assert.match(api, /\/api\/pr-description-image/);
assert.match(detail, /hydratePrDescriptionImages\(desc,\s*pr\.org\)/);
assert.match(images, /loading = "lazy"/);
assert.match(images, /Open image in Azure DevOps/);
assert.match(styles, /\.pr-desc\.has-images/);
assert.match(styles, /\.pr-desc img/);

console.log("PR description images harness passed");
