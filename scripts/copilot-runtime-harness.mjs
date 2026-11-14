// How the app starts Copilot: through Agency when it's installed; without it, the runtime
// built into Devis, else the plain CLI, with a warning; the same for the terminal buttons;
// and every session's MCP servers on and callable.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "copilot-runtime-"));
const agency = join(root, "agency.exe");
const copilot = join(root, "copilot.exe");
writeFileSync(agency, "");
writeFileSync(copilot, "");
process.env.ADO_PR_OPS_WORK_DIR = join(root, "sessions");
process.env.ADO_PR_OPS_COPILOT_PATH = copilot;
const id = "0a1b2c3d-0000-4000-8000-000000000000";

// Each import with its own query is a fresh module, so each reads the environment again.
let fresh = 0;
const load = () => import(`../copilot-runtime.mjs?case=${++fresh}`);

try {
    // ---- with Agency: pointed at the Copilot built into Devis, the version the SDK is built for ----
    process.env.ADO_PR_OPS_AGENCY_PATH = agency;
    let rt = await load();
    const builtIn = rt.bundledRuntimePath();
    assert.deepEqual(await rt.resolveCopilotRuntime(), {
        via: "agency",
        command: agency,
        args: ["copilot"],
        env: { AGENCY_COPILOT_PATH: builtIn },
        builtIn: true,
        warning: null,
    });
    assert.deepEqual(await rt.resumeCommand(id), { command: agency, args: ["copilot", "--resume", id] }, "terminals reopen through Agency too");
    assert.deepEqual(Object.keys(rt.reviewMcpServers("msazure", "Azure AppConfig")).sort(), ["ado", "bluebird"], "PR sessions scope ado and bluebird to the PR");
    // Opting out leaves Agency to its own Copilot.
    process.env.ADO_PR_OPS_AGENCY_OWN_COPILOT = "1";
    rt = await load();
    assert.deepEqual(await rt.resolveCopilotRuntime(), { via: "agency", command: agency, args: ["copilot"], builtIn: false, warning: null });
    delete process.env.ADO_PR_OPS_AGENCY_OWN_COPILOT;

    // ---- versions: older than 1.0.51 lacks session.options.update ----
    assert.equal(rt.olderThan("1.0.50", rt.MIN_COPILOT_VERSION), true);
    assert.equal(rt.olderThan("1.0.51", rt.MIN_COPILOT_VERSION), false);
    assert.equal(rt.olderThan("1.0.112", rt.MIN_COPILOT_VERSION), false);
    assert.equal(rt.olderThan("0.0.419-0", rt.MIN_COPILOT_VERSION), true);
    assert.equal(rt.olderThan("v1.1.0", rt.MIN_COPILOT_VERSION), false);
    assert.equal(rt.olderThan("unknown", rt.MIN_COPILOT_VERSION), false, "an unreadable version isn't called old");
    assert.match(rt.explainCopilotError("Unhandled method session.options.update"), /^Copilot is too old for Devis: it needs 1\.0\.51 or newer\. Run copilot update/);
    assert.equal(rt.explainCopilotError("something else"), "something else");

    // ---- without it: the runtime built into Devis, and a warning that says what's missing ----
    process.env.ADO_PR_OPS_AGENCY_PATH = join(root, "missing", "agency.exe");
    rt = await load();
    const bundledExe = rt.bundledRuntimePath();
    assert.match(bundledExe ?? "", /copilot-sdk-win32-x64[\\/]prebuilds[\\/]win32-x64[\\/]copilot-runtime\.exe$/, "the SDK's runtime ships in node_modules");
    const bundled = await rt.resolveCopilotRuntime();
    assert.deepEqual([bundled.via, bundled.command, bundled.args, bundled.builtIn], ["bundled", bundledExe, [], true]);
    assert.match(bundled.warning, /Agency isn't installed \(looked for .+missing.+agency\.exe\), so Copilot runs on the runtime built into Devis/);
    assert.deepEqual(await rt.resumeCommand(id), { command: copilot, args: ["--resume", id] }, "the built-in runtime has no terminal: the CLI reopens it");
    delete process.env.ADO_PR_OPS_COPILOT_PATH;
    const path = process.env.PATH;
    process.env.PATH = root;
    rt = await load();
    await assert.rejects(rt.resumeCommand(id), /needs Agency or the Copilot CLI/);
    process.env.PATH = path;
    process.env.ADO_PR_OPS_COPILOT_PATH = copilot;

    // ---- nor that: the plain CLI ----
    process.env.ADO_PR_OPS_NO_BUNDLED_COPILOT = "1";
    rt = await load();
    const plain = await rt.resolveCopilotRuntime();
    assert.equal(plain.via, "copilot");
    assert.equal(plain.command, copilot);
    assert.deepEqual(plain.args, []);
    assert.match(plain.warning, /Agency isn't installed \(looked for .+missing.+agency\.exe\), so Copilot runs on the Copilot CLI/);
    assert.deepEqual(await rt.resumeCommand(id), { command: copilot, args: ["--resume", id] });
    assert.deepEqual(rt.reviewMcpServers("msazure", "P"), {}, "no Agency, no Agency MCP servers");

    // ---- every MCP server on in every session, and callable ----
    const options = rt.prSessionOptions("msazure", "P");
    assert.equal("disabledMcpServers" in options, false, "no MCP server is turned off");
    const allow = rt.reviewPermissionHandler;
    assert.deepEqual(allow({ kind: "mcp", serverName: "mail", toolName: "SendEmailWithAttachments", readOnly: false }), { kind: "approve-once" }, "writes included");
    assert.deepEqual(allow({ kind: "mcp", serverName: "ado", toolName: "repo_pull_request", readOnly: true }), { kind: "approve-once" });
    assert.deepEqual(allow({ kind: "read", path: "x" }), { kind: "approve-once" });
    for (const kind of ["shell", "write", "url"]) {
        assert.equal(allow({ kind }).kind, "reject", `PR sessions still refuse ${kind}: they read untrusted PR text`);
    }
    console.log("copilot-runtime harness: ok");
} finally {
    rmSync(root, { recursive: true, force: true });
}
