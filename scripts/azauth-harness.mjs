import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const originalExecFile = childProcess.execFile;
const originalExtensionDir = process.env.AZURE_EXTENSION_DIR;
const originalConfigDir = process.env.AZURE_CONFIG_DIR;
const extensionDir = fileURLToPath(new URL("../az-core-extensions", import.meta.url));
const calls = [];
let failNext = false;

try {
    process.env.AZURE_EXTENSION_DIR = "broken-user-extensions";
    process.env.AZURE_CONFIG_DIR = "existing-login-cache";
    childProcess.execFile = (command, args, options, callback) => {
        assert.equal(command, process.platform === "win32" ? "az.cmd" : "az");
        assert.equal(options.env?.AZURE_EXTENSION_DIR, extensionDir,
            "built-in token acquisition must not load the user's broken CLI extensions");
        assert.equal(options.env.AZURE_CONFIG_DIR, "existing-login-cache",
            "extension isolation must preserve the user's existing login");
        assert.equal(options.env.PATH, process.env.PATH);
        assert.deepEqual(args.slice(0, 3), ["account", "get-access-token", "--resource"]);
        const resource = args[3];
        calls.push(resource);
        const failed = failNext;
        failNext = false;
        queueMicrotask(() => callback(
            failed ? new Error("CLI failed") : null,
            failed ? "" : JSON.stringify({
                accessToken: `fixture-${resource}`,
                expires_on: Math.floor(Date.now() / 1000) + 3600,
            }),
            failed ? "Sign-in required" : "",
        ));
        return { pid: 123 };
    };
    syncBuiltinESMExports();
    const { getAzToken } = await import("../azauth.mjs");

    const results = await Promise.all([
        getAzToken("ado-resource"),
        getAzToken("ado-resource"),
        getAzToken("ado-resource"),
    ]);
    assert.deepEqual(results, Array(3).fill("fixture-ado-resource"));
    assert.equal(calls.length, 1, "concurrent callers share token acquisition");
    assert.equal(await getAzToken("ado-resource"), "fixture-ado-resource");
    assert.equal(calls.length, 1, "a valid cached token avoids another CLI call");
    assert.equal(await getAzToken("another-resource"), "fixture-another-resource");
    assert.equal(calls.length, 2, "different audiences have independent tokens");

    failNext = true;
    await assert.rejects(getAzToken("retry-resource"), /Sign-in required/);
    assert.equal(await getAzToken("retry-resource"), "fixture-retry-resource",
        "failed acquisition does not poison the cache or the in-flight promise");
    assert.equal(calls.length, 4);
    assert.equal(process.env.AZURE_EXTENSION_DIR, "broken-user-extensions",
        "the isolation applies only to the app's child process");
    console.log("azauth-harness: ok");
} finally {
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
    for (const [key, value] of [
        ["AZURE_EXTENSION_DIR", originalExtensionDir],
        ["AZURE_CONFIG_DIR", originalConfigDir],
    ]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}
