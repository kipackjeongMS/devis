// How the app starts Copilot: through Agency when it's installed, the plain CLI
// with a warning when it isn't, the same for the terminal buttons; and every
// session's MCP servers on and callable.
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
    // ---- with Agency ----
    process.env.ADO_PR_OPS_AGENCY_PATH = agency;
    let rt = await load();
    assert.deepEqual(await rt.resolveCopilotRuntime(), { via: "agency", command: agency, args: ["copilot"], warning: null });
    assert.deepEqual(await rt.resumeCommand(id), { command: agency, args: ["copilot", "--resume", id] }, "terminals reopen through Agency too");
    assert.deepEqual(Object.keys(rt.reviewMcpServers("msazure", "Azure AppConfig")).sort(), ["ado", "bluebird"], "PR sessions scope ado and bluebird to the PR");

    // ---- without it: the plain CLI, and a warning that says what's missing ----
    process.env.ADO_PR_OPS_AGENCY_PATH = join(root, "missing", "agency.exe");
    rt = await load();
    const plain = await rt.resolveCopilotRuntime();
    assert.equal(plain.via, "copilot");
    assert.equal(plain.command, copilot);
    assert.deepEqual(plain.args, []);
    assert.match(plain.warning, /Agency isn't installed \(looked for .+missing.+agency\.exe\)/);
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
