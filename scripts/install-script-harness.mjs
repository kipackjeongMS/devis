// install.ps1, the one-line install, run the way the one-liner runs it (its text through iex) in
// Windows PowerShell, against a fake GitHub CLI: it picks the stable, preview or named release,
// checks the Setup against latest.json before running it, refuses one that doesn't match, says
// how to sign in when gh isn't, and waits for Setup and reads its exit code.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
    console.log("install-script-harness: skipped (Windows only)");
    process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "install.ps1");
const root = mkdtempSync(join(tmpdir(), "devis-install-"));
const bin = join(root, "bin");
const assets = join(root, "assets");
mkdirSync(bin, { recursive: true });

// A Setup that exits at once: whoami.exe exits 0, and 1 for an argument it doesn't know (/S).
const whoami = join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe");
function publish(version, { badHash = false } = {}) {
    const dir = join(assets, `v${version}`);
    mkdirSync(dir, { recursive: true });
    const file = `Devis-Setup-${version}.exe`;
    copyFileSync(whoami, join(dir, file));
    const bytes = readFileSync(join(dir, file));
    const sha512 = createHash("sha512").update(badHash ? Buffer.from("not it") : bytes).digest("hex");
    writeFileSync(join(dir, "latest.json"), JSON.stringify({ version, file, size: bytes.length, sha512 }));
}
publish("1.1.0");
publish("1.2.0");
publish("1.3.0-preview.2");
publish("0.9.0", { badHash: true });

// The fake gh: a .cmd on PATH that hands its arguments to this Node script.
const fake = join(bin, "fake-gh.mjs");
writeFileSync(
    fake,
    `import { copyFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
const a = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, "calls.log"))}, a.join(" ") + "\\n");
const opt = (n) => a[a.indexOf(n) + 1];
if (a[0] === "auth" && a[1] === "status") process.exit(process.env.FAKE_GH_SIGNED_OUT === "1" ? 1 : 0);
if (opt("-R") !== "contoso/devis") { console.error("HTTP 404: Not Found"); process.exit(1); }
if (a[0] === "release" && a[1] === "view") { console.log("v1.2.0"); process.exit(0); }
if (a[0] === "release" && a[1] === "list") { console.log("v1.3.0-preview.2"); process.exit(0); }
if (a[0] === "release" && a[1] === "download") {
    const from = join(${JSON.stringify(assets)}, a[2], opt("-p"));
    if (!existsSync(from)) { console.error("release not found"); process.exit(1); }
    copyFileSync(from, join(opt("-D"), opt("-p")));
    process.exit(0);
}
console.error("unexpected: " + a.join(" "));
process.exit(1);
`,
);
writeFileSync(join(bin, "gh.cmd"), `@"${process.execPath}" "${fake}" %*\r\n`);

function install(env = {}) {
    rmSync(join(root, "calls.log"), { force: true });
    // Windows PowerShell's own module path, as in a fresh window: a pwsh parent's would hide its modules.
    const { PSModulePath, ...base } = process.env;
    const r = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `Get-Content -Raw -LiteralPath '${script}' | Out-String | iex`],
        {
            encoding: "utf8",
            windowsHide: true,
            timeout: 120_000,
            env: { ...base, PATH: `${bin};${process.env.PATH}`, DEVIS_REPO: "contoso/devis", DEVIS_INSTALL_DRY_RUN: "1", ...env },
        },
    );
    let calls = [];
    try {
        calls = readFileSync(join(root, "calls.log"), "utf8").trim().split(/\r?\n/);
    } catch {
        /* gh never ran */
    }
    return { code: r.status, out: `${r.stdout}\n${r.stderr}`, calls };
}

let r = install();
assert.equal(r.code, 0, r.out);
assert.match(r.out, />> Devis 1\.2\.0 from contoso\/devis/);
assert.match(r.out, /Setup checks out: Devis-Setup-1\.2\.0\.exe \(dry run, not installed\)/);
assert.deepEqual(
    r.calls.map((c) => c.split(" ").slice(0, 2).join(" ")),
    ["auth status", "release view", "release download", "release download"],
    "signed in, the newest stable release, then its latest.json and Setup",
);
assert.match(r.calls[2], /-p latest\.json/);
assert.match(r.calls[3], /-p Devis-Setup-1\.2\.0\.exe/);

r = install({ DEVIS_CHANNEL: "preview" });
assert.equal(r.code, 0, r.out);
assert.match(r.out, /Devis 1\.3\.0-preview\.2 from/);
assert.match(r.calls[1], /^release list .*--exclude-drafts/);

r = install({ DEVIS_VERSION: "v1.1.0" });
assert.equal(r.code, 0, r.out);
assert.match(r.out, /Setup checks out: Devis-Setup-1\.1\.0\.exe/);
assert.ok(!r.calls.some((c) => /release (view|list)/.test(c)), "a named version needs no lookup");

r = install({ DEVIS_VERSION: "0.9.0" });
assert.notEqual(r.code, 0);
assert.match(r.out, /doesn't match its SHA-512 in latest\.json, so it wasn't run/);

r = install({ DEVIS_VERSION: "4.0.0" });
assert.notEqual(r.code, 0);
assert.match(r.out, /gh release download failed: release not found/);

r = install({ FAKE_GH_SIGNED_OUT: "1" });
assert.notEqual(r.code, 0);
assert.match(r.out, /The GitHub CLI isn't signed in\. Run "gh auth login" with the account that was invited to contoso\/devis/);
assert.equal(r.calls.length, 1, "nothing else is tried signed out");

// For real: Setup runs, and its exit code counts.
r = install({ DEVIS_INSTALL_DRY_RUN: "" });
assert.equal(r.code, 0, r.out);
assert.match(r.out, /Running Devis-Setup-1\.2\.0\.exe\.\.\./);
assert.match(r.out, /Devis 1\.2\.0 is installed/);
r = install({ DEVIS_INSTALL_DRY_RUN: "", DEVIS_SILENT: "1" });
assert.notEqual(r.code, 0, "whoami /S exits 1, which is a failed Setup");
assert.match(r.out, /Running Devis-Setup-1\.2\.0\.exe silently/);
assert.match(r.out, /Setup exited 1\./);

rmSync(root, { recursive: true, force: true });
console.log("install-script-harness: ok");
