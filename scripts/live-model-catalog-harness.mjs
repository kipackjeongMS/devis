import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [models, runtime, settings] = await Promise.all([
    readFile(new URL("../src/models.mts", import.meta.url), "utf8"),
    readFile(new URL("../src/copilot-runtime.mts", import.meta.url), "utf8"),
    readFile(new URL("../web/src/app.ts", import.meta.url), "utf8"),
]);

assert.match(models, /withCopilotClient/);
assert.match(runtime, /@github\/copilot-sdk/);
assert.match(runtime, /resolveCopilotCliPath/);
assert.match(runtime, /process\.platform === "win32" \? "where\.exe" : "which"/);
assert.match(runtime, /RuntimeConnection\.forStdio\(\{\s*path:\s*await resolveCopilotCliPath\(\)\s*\}\)/);
assert.match(models, /client\.listModels\(\)/);
assert.doesNotMatch(models, /FALLBACK|comma-separated list|copilot -p/);
assert.match(models, /throw new Error\("Copilot returned no available models"\)/);

assert.match(settings, /Loading available Copilot models/);
assert.match(settings, /selectedModel && !models\.includes\(selectedModel\)/);
assert.match(settings, /selectedModel = ""/);
assert.doesNotMatch(settings, /leave auto-only if probe fails/);

console.log("Live model catalog harness passed");
