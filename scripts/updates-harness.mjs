// Devis updating itself from GitHub releases (updates.mts), against a fake GitHub CLI: versions
// and channels, a signed-out, missing or uninvited gh, the download and its SHA-512, installing on
// its own once ready (or waiting to be asked), the updater's results settling the install, a
// failed version not installing again on its own (unless it only met a busy Devis), a build from
// source or with your ships in it pausing releases, the banner, and the bring-it-in task.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "devis-updates-"));
process.env.ADO_PR_OPS_DB_PATH = join(root, "data", "reviews.db");
process.env.ADO_PR_OPS_JARVIS_DIR = join(root, "jarvis");
process.env.ADO_PR_OPS_CONFIG_PATH = join(root, "config.json");
delete process.env.DEVIS_UPDATE_REPO;

const updates = await import("../updates.mjs");
const { closeDb } = await import("../store.mjs");
const { JarvisError } = await import("../jarvis-store.mjs");

// ---- versions ------------------------------------------------------------------------
const { compareVersions: cmp, parseVersion, pickRelease } = updates;
assert.ok(cmp("1.2.0", "1.10.0") < 0, "numbers, not text");
assert.ok(cmp("1.0.0-preview.2", "1.0.0-preview.10") < 0, "pre-release numbers too");
assert.ok(cmp("1.0.0-preview.9", "1.0.0") < 0, "a pre-release comes before its release");
assert.ok(cmp("v1.0.1", "1.0.0") > 0, "a leading v is fine");
assert.equal(cmp("1.0.0", "1.0.0"), 0);
assert.ok(cmp("1.0.0-alpha", "1.0.0-alpha.1") < 0);
assert.ok(cmp("1.0.0-1", "1.0.0-alpha") < 0, "numeric identifiers sort before text");
assert.equal(parseVersion("latest"), null);
assert.deepEqual(parseVersion("2.3.4-preview.5"), { major: 2, minor: 3, patch: 4, pre: ["preview", 5] });

const rel = (version, prerelease = false) => ({ tag: `v${version}`, version, prerelease, name: null, publishedAt: null, url: `https://example/${version}` });
const list = [rel("1.0.0"), rel("1.1.0"), rel("1.2.0-preview.3", true), rel("0.9.0")];
assert.equal(pickRelease(list, "stable", "1.0.0")?.version, "1.1.0", "stable skips pre-releases");
assert.equal(pickRelease(list, "preview", "1.0.0")?.version, "1.2.0-preview.3", "preview takes the newest of all");
assert.equal(pickRelease(list, "stable", "1.1.0"), null, "nothing newer");
assert.equal(pickRelease(list, "stable", null)?.version, "1.1.0", "an unknown running version takes the newest");

// ---- a fake GitHub ---------------------------------------------------------------------
const repo = "kipackjeongMS/devis";
assert.equal(updates.updatesRepo(), repo);

/** tag -> { isPrerelease, files: { name: Buffer } } */
const published = new Map();
function publish(version, { prerelease = false, badHash = false, manifest } = {}) {
    const file = `Devis-Setup-${version}.exe`;
    const setup = Buffer.from(`setup for ${version}`);
    const sha512 = createHash("sha512").update(badHash ? "something else" : setup).digest("hex");
    published.set(`v${version}`, {
        isPrerelease: prerelease,
        files: {
            [file]: setup,
            "latest.json": Buffer.from(JSON.stringify(manifest ?? { version, channel: prerelease ? "preview" : "stable", file, size: setup.length, sha512, commit: "c0ffee" })),
        },
    });
}

let gh = "ok"; // ok | missing | signed-out | no-access | down
const ghCalls = [];
const downloads = () => ghCalls.filter((a) => a[1] === "download");

function fakeGh(args) {
    ghCalls.push(args);
    if (gh === "missing") return null;
    if (gh === "signed-out") return { code: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login", timedOut: false };
    if (gh === "no-access") return { code: 1, stdout: "", stderr: "HTTP 404: Not Found (https://api.github.com/repos/kipackjeongMS/devis/releases)", timedOut: false };
    if (gh === "down") return { code: 1, stdout: "", stderr: "error connecting to api.github.com", timedOut: false };
    assert.equal(args[args.indexOf("-R") + 1], repo, "every call names the repository");
    if (args[0] === "release" && args[1] === "list") {
        const rows = [...published].map(([tagName, r]) => ({ tagName, name: tagName, isPrerelease: r.isPrerelease, isDraft: false, publishedAt: "2026-11-01T00:00:00Z" }));
        rows.push({ tagName: "v9.9.9", name: "draft", isPrerelease: false, isDraft: true, publishedAt: null });
        rows.push({ tagName: "nightly", name: "not a version", isPrerelease: true, isDraft: false, publishedAt: null });
        return { code: 0, stdout: JSON.stringify(rows), stderr: "", timedOut: false };
    }
    if (args[0] === "release" && args[1] === "download") {
        const r = published.get(args[2]);
        const name = args[args.indexOf("-p") + 1];
        const dir = args[args.indexOf("-D") + 1];
        if (!r || !r.files[name]) return { code: 1, stdout: "", stderr: "no assets match the file pattern", timedOut: false };
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, name), r.files[name]);
        return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}`, timedOut: false };
}

const dir = join(root, "updates");
const updaterSource = join(root, "devis-updater.ps1");
writeFileSync(updaterSource, "# the updater\nparam()\n");
let running = { version: "1.0.0", commit: "aaaa", release: true };
const launched = [];
let launchError = null;
const alive = new Set();
let nextPid = 900;
updates.setUpdatesRuntime({
    gh: async (args) => fakeGh(args),
    launch: async (cmd) => {
        if (launchError) throw launchError;
        launched.push(cmd);
        const pid = ++nextPid;
        alive.add(pid);
        return pid;
    },
    alive: (pid) => alive.has(pid),
    running: () => running,
    updaterScript: () => updaterSource,
    dir: () => {
        mkdirSync(dir, { recursive: true });
        return dir;
    },
});

const ships = join(root, "jarvis", "devis", "ships.json");
const setShips = (list) => {
    mkdirSync(join(root, "jarvis", "devis"), { recursive: true });
    writeFileSync(ships, JSON.stringify({ ships: list }));
};
const ship = (n, state, revertedBy = null) => ({ n, state, revertedBy, title: `ship ${n}` });
const reset = async () => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(ships, { force: true });
    published.clear();
    ghCalls.length = 0;
    launched.length = 0;
    alive.clear();
    launchError = null;
    gh = "ok";
    running = { version: "1.0.0", commit: "aaaa", release: true };
    await updates.saveUpdateSettings({ channel: "stable", install: "idle" });
    await new Promise((r) => setTimeout(r, 0));
    await updates.checkForUpdates().catch(() => undefined); // let a check the channel change started finish
    rmSync(dir, { recursive: true, force: true });
    ghCalls.length = 0;
};
const writeResult = (version, result) => writeFileSync(join(dir, `release-${version}.result.json`), "\uFEFF" + JSON.stringify(result));
const rejects = async (work, status, pattern) => {
    await assert.rejects(work, (e) => e instanceof JarvisError && e.status === status && pattern.test(e.message));
};

// ---- the GitHub CLI can't answer ---------------------------------------------------------
await reset();
for (const [kind, pattern] of [
    ["missing", /isn't installed.*winget install GitHub\.cli/],
    ["signed-out", /isn't signed in/],
    ["no-access", /can't see kipackjeongMS\/devis yet.*invite/],
    ["down", /couldn't check for updates: error connecting/],
]) {
    gh = kind;
    const s = await updates.checkForUpdates();
    assert.equal(s.problem?.kind, kind === "down" ? "error" : kind, kind);
    assert.match(s.problem.text, pattern, kind);
    assert.ok(s.lastChecked, "the check still counts as made");
    assert.equal(s.available, null);
}
gh = "ok";
let s = await updates.checkForUpdates();
assert.equal(s.problem?.kind, "no-releases", "a repository with nothing published says so");
assert.equal(await updates.updateBanner(), null);

// ---- a release: downloaded, checked, and installed once the workers are done -----------
await reset();
publish("1.0.0");
publish("1.1.0");
publish("1.2.0-preview.3", { prerelease: true });
s = await updates.checkForUpdates();
assert.equal(s.problem, null);
assert.equal(s.available?.version, "1.1.0");
assert.equal(s.available?.url, "https://github.com/kipackjeongMS/devis/releases/tag/v1.1.0");
assert.deepEqual(downloads().map((a) => a[a.indexOf("-p") + 1]), ["latest.json", "Devis-Setup-1.1.0.exe"], "the manifest first, then the Setup it names");
assert.equal(s.ready, "1.1.0");
assert.equal(launched.length, 1, "it installs on its own when the workers are done");
assert.match(launched[0], /-File ".*updater-1\.1\.0\.ps1"/);
assert.match(launched[0], /-Release 1\.1\.0 /);
assert.match(launched[0], /-Installer ".*[\\/]1\.1\.0[\\/]Devis-Setup-1\.1\.0\.exe"/);
assert.match(launched[0], /-Mode idle /);
assert.match(launched[0], /-StateDir ".*updates"/);
const copied = readFileSync(join(dir, "updater-1.1.0.ps1"), "utf8");
assert.ok(copied.startsWith("\uFEFF") && copied.includes("\r\n"), "the updater copy has a BOM and CRLFs for Windows PowerShell");
assert.equal(s.installing?.version, "1.1.0");
assert.equal(s.installing?.from, "1.0.0");
assert.deepEqual(updates.updatesActivity(), [], "nothing downloading now");
let b = await updates.updateBanner();
assert.equal(b?.state, "installing");
assert.equal(b?.mode, "idle");
await rejects(updates.installUpdate({ mode: "now" }), 409, /already installing/);
assert.equal(await updates.settleUpdates(Date.now()), null, "no result yet, the updater still runs");

// It rolled back: never again on its own, and the banner says why.
writeResult("1.1.0", { state: "rolled-back", version: "1.1.0", note: "The new build didn't come up within 120 seconds.", logTail: "Setup exited 0.", retry: false });
let settled = await updates.settleUpdates(Date.now());
assert.equal(settled?.state, "rolled-back");
s = await updates.updatesStatus();
assert.equal(s.installing, null);
assert.equal(s.history[0].state, "rolled-back");
assert.equal(s.history[0].note, "The new build didn't come up within 120 seconds.");
assert.equal(s.history[0].log, "Setup exited 0.");
b = await updates.updateBanner();
assert.equal(b?.state, "rolled-back");
assert.equal(b?.note, "The new build didn't come up within 120 seconds.");
await updates.checkForUpdates();
assert.equal(launched.length, 1, "a rolled-back version doesn't install on its own again");
await updates.dismissUpdate("1.1.0");
assert.equal(await updates.updateBanner(), null, "dismissed, and the version that rolled back isn't offered as ready");

// Install it by hand anyway, now.
s = await updates.installUpdate({ mode: "now" });
assert.equal(launched.length, 2);
assert.match(launched[1], /-Mode now /);
// It went live: the new service runs 1.1.0.
writeResult("1.1.0", { state: "live", version: "1.1.0", note: "", logTail: "", retry: false });
running = { version: "1.1.0", commit: "bbbb", release: true };
settled = await updates.settleUpdates(Date.now());
assert.equal(settled?.state, "live");
s = await updates.updatesStatus();
assert.equal(s.available, null, "nothing newer now");
assert.equal(s.ready, null);
assert.ok(!existsSync(join(dir, "1.1.0")), "the download is cleared once it's live");
b = await updates.updateBanner();
assert.equal(b?.state, "live");
assert.equal(await updates.updateBanner(Date.now() + 31 * 60_000), null, "the live banner goes after half an hour");

// ---- the Preview channel ------------------------------------------------------------------
await updates.saveUpdateSettings({ channel: "preview" });
s = await updates.checkForUpdates();
assert.equal(s.channel, "preview");
assert.equal(s.available?.version, "1.2.0-preview.3");
assert.equal(launched.length, 3);
assert.match(launched[2], /-Release 1\.2\.0-preview\.3 /);

// ---- a busy Devis: it tries again at the next check ---------------------------------------
writeResult("1.2.0-preview.3", { state: "failed", version: "1.2.0-preview.3", note: "Devis was still busy after 60 minutes, so Setup didn't replace anything.", logTail: "", retry: true });
settled = await updates.settleUpdates(Date.now());
assert.equal(settled?.state, "failed");
assert.equal(settled?.retry, true);
assert.equal((await updates.updateBanner())?.state, "ready", "a busy retry isn't a failure banner: it's still ready");
await updates.checkForUpdates();
assert.equal(launched.length, 4, "a version that only met a busy Devis installs again on its own");

// ---- settling without a result --------------------------------------------------------------
await reset();
publish("1.1.0");
await updates.checkForUpdates();
assert.equal(launched.length, 1);
const pid = nextPid;
alive.delete(pid);
settled = await updates.settleUpdates(Date.now());
assert.equal(settled?.state, "failed", "an updater that ended without a result failed");
assert.match(settled.note, /release-1\.1\.0\.log/);
await reset();
publish("1.1.0");
await updates.checkForUpdates();
running = { version: "1.1.0", commit: "bbbb", release: true };
assert.equal(await updates.settleUpdates(Date.now()), null, "the new build, just started, waits for the updater");
settled = await updates.settleUpdates(Date.now() - 6 * 60_000);
assert.equal(settled?.state, "live", "the new build running 5 minutes with no word counts as live");

// ---- a download that doesn't match, or a manifest that doesn't describe it ------------------
await reset();
publish("1.1.0", { badHash: true });
s = await updates.checkForUpdates();
assert.match(s.problem?.text || "", /didn't match its SHA-512, so it was thrown away/);
assert.equal(s.ready, null);
assert.equal(launched.length, 0, "nothing unverified runs");
assert.ok(!existsSync(join(dir, "1.1.0", "Devis-Setup-1.1.0.exe")), "the bad download is deleted");
await reset();
publish("1.1.0", { manifest: { version: "1.1.0", file: "..\\evil.exe", size: 5, sha512: "0".repeat(128) } });
s = await updates.checkForUpdates();
assert.match(s.problem?.text || "", /doesn't describe its Setup/);
assert.equal(downloads().length, 1, "only the manifest was fetched");
await reset();
publish("1.1.0");
launchError = new Error("WMI said no");
s = await updates.checkForUpdates();
assert.equal(s.history[0].state, "failed");
assert.match(s.history[0].note, /The updater didn't start: WMI said no/);

// ---- Ask me: ready, and waiting for a click -----------------------------------------------
await reset();
await updates.saveUpdateSettings({ install: "ask" });
publish("1.1.0");
s = await updates.checkForUpdates();
assert.equal(s.install, "ask");
assert.equal(s.ready, "1.1.0");
assert.equal(launched.length, 0);
b = await updates.updateBanner();
assert.equal(b?.state, "ready");
assert.equal(b?.install, "ask");
await updates.dismissUpdate("1.1.0");
assert.equal(await updates.updateBanner(), null, "a dismissed release stays quiet");
s = await updates.installUpdate({ mode: "idle" });
assert.equal(launched.length, 1);

// ---- built from source, or with your ships in it: releases pause ---------------------------
await reset();
running = { version: "1.0.0", commit: "aaaa", release: false };
publish("1.1.0");
s = await updates.checkForUpdates();
assert.deepEqual(s.paused, { reason: "source", ships: 0 });
assert.equal(s.available?.version, "1.1.0");
assert.equal(downloads().length, 0, "a build from source downloads nothing ahead");
assert.equal(launched.length, 0);
b = await updates.updateBanner();
assert.equal(b?.state, "paused");
assert.deepEqual(b?.pause, { reason: "source", ships: 0 });
await rejects(updates.installUpdate({ mode: "idle" }), 409, /built from your source/);
setShips([ship(1, "live"), ship(2, "failed")]);
assert.deepEqual(updates.pausedBy(), { reason: "ships", ships: 1 });
assert.match(updates.pauseText(updates.pausedBy()), /Your ship is in this Devis, and a release would undo it/);
setShips([ship(1, "live", 3), ship(2, "live"), ship(3, "live")]);
assert.deepEqual(updates.pausedBy(), { reason: "ships", ships: 1 }, "an undone ship and its undo don't count");
await rejects(updates.installUpdate({ mode: "idle" }), 409, /Your ship is in this Devis/);
s = await updates.installUpdate({ mode: "idle", force: true });
assert.equal(launched.length, 1, "Install anyway goes back to releases");
assert.deepEqual(downloads().map((a) => a[a.indexOf("-p") + 1]), ["latest.json", "Devis-Setup-1.1.0.exe"], "downloaded when asked");

// ---- bring the release into your source ---------------------------------------------------
const task = updates.releaseTask("1.1.0");
assert.equal(task.title, "Bring Devis 1.1.0 into your source");
assert.match(task.description, /git fetch <remote> refs\/tags\/v1\.1\.0:refs\/tags\/v1\.1\.0/);
assert.match(task.description, /git merge --no-ff v1\.1\.0/);
assert.match(task.description, /devis_ready_to_ship/);
assert.throws(() => updates.releaseTask("1.0.5"), /isn't the newest release any more: 1\.1\.0 is/);
await reset();
assert.throws(() => updates.releaseTask("1.1.0"), /There's no release to bring in/);

// ---- settings ----------------------------------------------------------------------------
s = await updates.saveUpdateSettings({ channel: "nonsense", install: "whenever" });
assert.equal(s.channel, "stable");
assert.equal(s.install, "idle");

updates.setUpdatesRuntime(null);
closeDb();
rmSync(root, { recursive: true, force: true });
console.log("updates-harness: ok");
