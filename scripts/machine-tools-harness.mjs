// Git and the Azure CLI from outside Devis: the machine's Git wins when it's recent, else
// Devis' own MinGit goes on PATH; the Azure CLI comes from PATH, else Devis' own folder,
// else where its Windows installer puts it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "machine-tools-"));
const saved = Object.fromEntries(
    ["PATH", "ADO_PR_OPS_BUNDLED_GIT", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"].map((k) => [k, process.env[k]]),
);
const system32 = join(process.env.SystemRoot || "C:\\Windows", "System32");
const realGit = execFileSync("where.exe", ["git"], { encoding: "utf8" }).split(/\r?\n/).find((p) => /\.exe$/i.test(p.trim()))?.trim();
assert.ok(realGit && /[\\/]cmd[\\/]git\.exe$/i.test(realGit), "this machine has Git for Windows to stand in for MinGit");

let fresh = 0;
const load = () => import(`../machine-tools.mjs?case=${++fresh}`);

try {
    // A stand-in MinGit: Git for Windows has the same cmd\git.exe layout.
    const bundled = join(realGit, "..", "..");
    process.env.ADO_PR_OPS_BUNDLED_GIT = bundled;

    // ---- the machine's recent Git wins, PATH untouched ----
    let tools = await load();
    const before = process.env.PATH;
    const system = tools.prepareGit();
    assert.equal(system.source, "system");
    assert.match(system.version, /^\d+\.\d+\.\d+$/);
    assert.equal(process.env.PATH, before);
    assert.equal(tools.prepareGit(), system, "decided once per service");

    // ---- no Git on the machine: Devis' own goes first on PATH ----
    process.env.PATH = system32;
    tools = await load();
    const own = tools.prepareGit();
    assert.deepEqual([own.source, own.path, own.note], ["bundled", join(bundled, "cmd", "git.exe"), null]);
    assert.equal(own.version, system.version);
    assert.equal(process.env.PATH.split(delimiter)[0], join(bundled, "cmd"));
    assert.match(execFileSync("git", ["--version"], { encoding: "utf8" }), /git version/, "plain `git` now runs Devis' own");

    // ---- neither: nothing found, nothing on PATH ----
    process.env.PATH = system32;
    process.env.ADO_PR_OPS_BUNDLED_GIT = join(root, "missing");
    tools = await load();
    assert.deepEqual(tools.prepareGit(), { source: null, path: null, version: null, note: null });
    assert.equal(process.env.PATH, system32);

    // ---- the Azure CLI ----
    process.env.LOCALAPPDATA = join(root, "local");
    process.env.ProgramFiles = join(root, "pf");
    process.env["ProgramFiles(x86)"] = join(root, "pf86");
    tools = await load();
    assert.deepEqual(tools.findAzureCli(), { source: null, command: null });
    const msi = join(root, "pf", "Microsoft SDKs", "Azure", "CLI2", "wbin", "az.cmd");
    mkdirSync(join(msi, ".."), { recursive: true });
    writeFileSync(msi, "@echo off\r\n");
    assert.deepEqual(tools.findAzureCli(), { source: "installer", command: msi }, "not found isn't remembered: a later install counts");
    tools = await load();
    const local = join(tools.devisAzureCliDir(), "bin", "az.cmd");
    assert.equal(local, join(root, "local", "Devis", "azure-cli", "bin", "az.cmd"));
    mkdirSync(join(local, ".."), { recursive: true });
    writeFileSync(local, "@echo off\r\n");
    assert.deepEqual(tools.findAzureCli(), { source: "devis", command: local }, "Devis' own beats the installer's");
    process.env.PATH = [join(local, ".."), system32].join(delimiter);
    tools = await load();
    assert.deepEqual(tools.findAzureCli(), { source: "path", command: "az.cmd" }, "PATH beats both");
    console.log("machine-tools harness: ok");
} finally {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
}
