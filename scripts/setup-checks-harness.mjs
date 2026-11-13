// Settings › Setup from outside Devis: every row from stand-in probes, so each branch (ok, warn,
// missing, slow) reads right without touching the machine.
import assert from "node:assert/strict";
import { runSetupChecks, tokenAccount } from "../setup-checks.mjs";

const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const never = () => new Promise(() => {});

const healthy = {
    copilot: async () => ({ via: "agency", version: "1.0.40", signedIn: true, login: "octo", canSignIn: true }),
    azureCli: () => "C:\\az\\az.cmd",
    adoToken: async () => jwt({ upn: "me@contoso.com" }),
    github: async () => ({ gh: "C:\\gh\\gh.exe", login: "octo", access: true }),
    git: () => ({ source: "system", version: "2.50.1", note: null }),
    agency: () => "C:\\agency\\agency.exe",
    ides: () => ["VSCode", "VSCode Insiders"],
};
const run = (over, ms) => runSetupChecks({ ...healthy, ...over }, ms);
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

// ---- tokenAccount ----
assert.equal(tokenAccount(jwt({ upn: "a@b.com" })), "a@b.com");
assert.equal(tokenAccount(jwt({ unique_name: "u@b.com" })), "u@b.com");
assert.equal(tokenAccount(jwt({ preferred_username: "p@b.com" })), "p@b.com");
assert.equal(tokenAccount(jwt({ email: "e@b.com" })), "e@b.com");
assert.equal(tokenAccount(jwt({ oid: "x" })), null);
assert.equal(tokenAccount("not-a-jwt"), null);
assert.equal(tokenAccount(""), null);

// ---- all good: order, statuses, details ----
{
    const rows = await run({});
    assert.deepEqual(rows.map((r) => r.id), ["copilot", "azure", "github", "git", "agency", "vscode"]);
    assert.ok(rows.every((r) => r.status === "ok"), JSON.stringify(rows));
    const r = byId(rows);
    assert.equal(r.copilot.detail, "Through Agency 1.0.40 · octo");
    assert.equal(r.azure.detail, "Signed in through the Azure CLI as me@contoso.com");
    assert.equal(r.git.detail, "Git 2.50.1 on this machine");
    assert.equal(r.vscode.detail, "Found VSCode and VSCode Insiders");
    assert.equal(r.agency.needs, undefined);
    assert.equal(r.github.detail, "Signed in as octo. Updates come from kipackjeongMS/devis.");
    assert.ok(rows.every((row) => row.action === undefined), "nothing to fix, so no buttons");
}

// ---- Copilot ----
{
    let r = byId(await run({ copilot: async () => ({ via: "bundled", version: "1.0.18", signedIn: true, login: null }) }));
    assert.equal(r.copilot.detail, "Built-in runtime 1.0.18");
    r = byId(await run({ copilot: async () => ({ via: "copilot", version: "1.0.40", signedIn: false, login: null, canSignIn: true }) }));
    assert.equal(r.copilot.status, "warn");
    assert.match(r.copilot.detail, /^Copilot CLI 1\.0\.40\. Not signed in/);
    assert.deepEqual(r.copilot.action, { id: "copilot-signin", label: "Sign in" });
    r = byId(await run({ copilot: async () => ({ via: "bundled", version: "1.0.18", signedIn: false, login: null, canSignIn: false }) }));
    assert.equal(r.copilot.action, undefined, "the built-in runtime can't open a sign-in");
    assert.match(r.copilot.detail, /Install Agency to sign in, or run `copilot login`/);
    r = byId(await run({ copilot: async () => { throw new Error("spawn ENOENT\nstack line"); } }));
    assert.equal(r.copilot.status, "missing");
    assert.match(r.copilot.detail, /: spawn ENOENT$/);
    const t0 = Date.now();
    r = byId(await run({ copilot: never }, 50));
    assert.equal(r.copilot.status, "warn");
    assert.match(r.copilot.detail, /didn't answer in 0 s/);
    assert.ok(Date.now() - t0 < 2000, "gives up on time");
}

// ---- Azure DevOps ----
{
    let r = byId(await run({ azureCli: () => null }));
    assert.equal(r.azure.status, "missing");
    assert.match(r.azure.detail, /Azure CLI isn't installed/);
    assert.deepEqual(r.azure.action, { id: "azure-install", label: "Install" });
    r = byId(await run({ adoToken: async () => jwt({ oid: "x" }) }));
    assert.deepEqual([r.azure.status, r.azure.detail], ["ok", "Signed in through the Azure CLI"]);
    r = byId(await run({ adoToken: async () => { throw new Error("AADSTS70043: expired"); } }));
    assert.equal(r.azure.status, "warn");
    assert.match(r.azure.detail, /paused\.$/);
    assert.deepEqual(r.azure.action, { id: "azure-signin", label: "Sign in" });
    r = byId(await run({ adoToken: never }, 50));
    assert.equal(r.azure.status, "warn");
    assert.match(r.azure.detail, /didn't answer/);
}

// ---- GitHub ----
{
    let r = byId(await run({ github: async () => ({ gh: null, login: null, access: false }) }));
    assert.equal(r.github.status, "warn");
    assert.match(r.github.detail, /winget install GitHub\.cli/);
    assert.equal(r.github.action, undefined);
    r = byId(await run({ github: async () => ({ gh: "gh.exe", login: null, access: false }) }));
    assert.deepEqual(r.github.action, { id: "github-signin", label: "Sign in" });
    assert.deepEqual(r.github.needs, ["Updates"]);
    // Signed in, but GitHub didn't answer: say why, and offer no sign-in that wouldn't help.
    r = byId(await run({ github: async () => ({ gh: "gh.exe", login: null, access: false, signedIn: true, error: "error connecting to api.github.com" }) }));
    assert.equal(r.github.status, "warn");
    assert.match(r.github.detail, /^The GitHub CLI is signed in, but GitHub didn't answer it: error connecting to api\.github\.com\./);
    assert.equal(r.github.action, undefined);
    r = byId(await run({ github: async () => ({ gh: "gh.exe", login: "octo", access: false, signedIn: true, error: "HTTP 502: Bad Gateway" }) }));
    assert.match(r.github.detail, /^Signed in as octo, but GitHub didn't say whether you can see kipackjeongMS\/devis: HTTP 502/);
    r = byId(await run({ github: async () => ({ gh: "gh.exe", login: "octo", access: false }) }));
    assert.equal(r.github.status, "warn");
    assert.match(r.github.detail, /octo, who can't see kipackjeongMS\/devis yet.*invite/);
    r = byId(await run({ github: never }, 50));
    assert.match(r.github.detail, /didn't answer/);
}

// ---- the slow checks run side by side ----
{
    const t0 = Date.now();
    await run({ copilot: never, adoToken: never, github: never }, 300);
    assert.ok(Date.now() - t0 < 550, "Copilot, the Azure CLI and GitHub wait together, not one after the other");
}

// ---- Git ----
{
    let r = byId(await run({ git: () => ({ source: "bundled", version: "2.56.1", note: null }) }));
    assert.deepEqual([r.git.status, r.git.detail], ["ok", "Built-in 2.56.1"]);
    r = byId(await run({ git: () => ({ source: "bundled", version: "2.56.1", note: "git 2.30.0 on this machine is older than 2.35" }) }));
    assert.deepEqual([r.git.status, r.git.detail], ["ok", "Built-in 2.56.1. Git 2.30.0 on this machine is older than 2.35"]);
    r = byId(await run({ git: () => ({ source: "system", version: "2.30.0", note: "git 2.30.0 on this machine is older than 2.35" }) }));
    assert.equal(r.git.status, "warn");
    assert.match(r.git.detail, /^Git 2\.30\.0 on this machine is older than 2\.35, and this build has none/);
    r = byId(await run({ git: () => ({ source: null, version: null, note: null }) }));
    assert.equal(r.git.status, "missing");
}

// ---- Agency ----
{
    const r = byId(await run({ agency: () => null }));
    assert.equal(r.agency.status, "warn");
    assert.deepEqual(r.agency.needs, ["Teams catch-up", "Meeting recaps", "Email summaries", "Code search"]);
    assert.deepEqual(r.agency.action, { id: "agency-install", label: "Install" });
}

// ---- VS Code ----
{
    const r = byId(await run({ ides: () => [] }));
    assert.equal(r.vscode.status, "warn");
    assert.match(r.vscode.detail, /Open in VSCode/);
}

console.log("setup-checks harness: ok");
