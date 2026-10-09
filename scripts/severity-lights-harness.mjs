import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [lights, reviewPanel] = await Promise.all([
    readFile(new URL("../web/src/severityLights.ts", import.meta.url), "utf8"),
    readFile(new URL("../web/src/reviewPanel.ts", import.meta.url), "utf8"),
]);

assert.match(lights, /SemanticFinding/);
assert.match(lights, /semanticFindingsList/);
assert.match(lights, /kind:\s*"semantic"/);
assert.match(lights, /revealSemanticFinding/);
assert.match(reviewPanel, /data-semantic-finding-id/);
assert.match(reviewPanel, /refreshSeverityLights\(\)/);

console.log("Severity lights harness passed");
