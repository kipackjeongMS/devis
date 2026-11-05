// Devis changing itself, end to end with real git on a throwaway source repo:
// the settings check the source folder, a worker gets a worktree of it on its
// own branch, the branch's changes and sensitive files are found, the checks
// tell a new harness failure from one master already has, the ship gate
// refuses a dirty or off-master source, a ship fast-forwards master, tags it
// and starts the updater (faked here), a failed start puts master back, the
// updater's result settles the ship, and the banner and Undo read the record.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "devis-self-"));
process.env.ADO_PR_OPS_DB_PATH = join(root, "data", "reviews.db");
process.env.ADO_PR_OPS_JARVIS_DIR = join(root, "jarvis");
process.env.ADO_PR_OPS_CONFIG_PATH = join(root, "config.json");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
const write = (dir, path, text) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
};
const commitAll = (dir, message) => {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", message);
    return git(dir, "rev-parse", "HEAD");
};

// ---- a source folder that looks like Devis' own -------------------------------------
const source = join(root, "source");
mkdirSync(source, { recursive: true });
git(source, "init", "-q", "-b", "master");
git(source, "config", "user.email", "harness@contoso.com");
git(source, "config", "user.name", "Harness");
git(source, "config", "core.autocrlf", "false");
write(source, ".gitignore", "node_modules\n");
write(source, "package.json", JSON.stringify({ name: "devis", version: "1.0.0" }, null, 2) + "\n");
write(source, "README.md", "# Devis\n");
write(source, "src/service.mts", "export const port = 1;\n");
write(source, "scripts/deploy-desktop.ps1", "# deploy\n");
write(source, "scripts/devis-updater.ps1", "# updater v1\nparam()\n");
write(source, "scripts/old-harness.mjs", "// fails on master too\n");
write(source, "scripts/new-harness.mjs", "// passes on master\n");
write(source, "node_modules/typescript/package.json", "{}\n");
const first = commitAll(source, "first");

const realRun = (file, args, opts) =>
    new Promise((done) => {
        execFile(file, args, { cwd: opts.cwd, timeout: opts.timeoutMs, windowsHide: true, env: opts.env ?? process.env }, (error, stdout, stderr) => {
            done({ code: !error ? 0 : typeof error.code === "number" ? error.code : null, stdout: String(stdout), stderr: String(stderr), timedOut: !!error?.killed });
        });
    });

const config = await import("../config.mjs");
const store = await import("../jarvis-store.mjs");
const codebase = await import("../jarvis-codebase.mjs");
const devis = await import("../devis-self.mjs");
const { closeDb } = await import("../store.mjs");

codebase.setCodebaseRuntime({
    git: async (args) => (args.includes("user.email") ? "harness.user@contoso.com" : ""),
    token: async () => null,
    cloneUrl: () => "",
    account: async () => null,
});

// Node runs are scripted; git runs for real.
const nodeRuns = [];
let harnessOutcome = () => 0;
let running = null;
const launched = [];
let launchError = null;
const alive = new Set([4242]);
devis.setDevisRuntime({
    run: (file, args, opts) => {
        if (file === "git") return realRun(file, args, opts);
        nodeRuns.push({ args, cwd: opts.cwd, env: opts.env });
        const script = args[0].replace(/\\/g, "/");
        const code = script.startsWith("scripts/") ? harnessOutcome(script.slice(8), opts.cwd) : 0;
        return Promise.resolve({ code, stdout: code ? `boom in ${script}` : "", stderr: "", timedOut: false });
    },
    launch: async (commandLine) => {
        if (launchError) throw new Error(launchError);
        launched.push(commandLine);
        return 4242;
    },
    commit: () => running,
    alive: (pid) => alive.has(pid),
    node: () => "node",
});

// ---- the source folder ---------------------------------------------------------------
assert.equal(devis.validateSource(""), "Choose Devis' source folder.");
assert.equal(devis.validateSource("relative\\path"), "Use the source folder's full path.");
assert.equal(devis.validateSource(root), "That folder isn't a git repository.");
const fake = join(root, "fake");
mkdirSync(join(fake, ".git"), { recursive: true });
assert.equal(devis.validateSource(fake), "That folder has no package.json.");
writeFileSync(join(fake, "package.json"), JSON.stringify({ name: "other" }));
assert.match(devis.validateSource(fake), /isn't named devis/);
writeFileSync(join(fake, "package.json"), "\uFEFF" + JSON.stringify({ name: "devis" }));
assert.match(devis.validateSource(fake), /deploy-desktop\.ps1/);
mkdirSync(join(fake, "scripts"));
writeFileSync(join(fake, "scripts", "deploy-desktop.ps1"), "");
assert.equal(devis.validateSource(fake), "Run npm install in that folder first.");
assert.equal(devis.validateSource(source), null);

// ---- settings ------------------------------------------------------------------------
const off = await devis.devisSettings();
assert.equal(off.enabled, false);
await assert.rejects(devis.requireDevis(), /Changing Devis itself is off/);
await assert.rejects(devis.saveDevisSettings({ source: fake }), (e) => e instanceof store.JarvisError && /npm install/.test(e.message));
if (off.sourceProblem) await assert.rejects(devis.saveDevisSettings({ enabled: true }), store.JarvisError);
let s = await devis.saveDevisSettings({ source: `"${source}\\"` });
assert.equal(s.source, source, "quotes and the trailing slash go");
assert.equal(s.sourceProblem, null);
assert.equal(s.enabled, false);
s = await devis.saveDevisSettings({ enabled: true });
assert.equal(s.enabled, true);
assert.equal(await devis.requireDevis(), source);

// ---- a worker's worktree -------------------------------------------------------------
const workerFolder = join(root, "tasks", "fix-the-banner", "w1");
const wt = await devis.addDevisWorktree({ source, workerFolder, title: "Fix the banner" });
assert.equal(wt.path, join(workerFolder, "devis"));
assert.equal(wt.branch, "harness.user/devis/fix-the-banner");
assert.equal(wt.base, "master");
assert.equal(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD"), wt.branch);
assert.ok(lstatSync(join(wt.path, "node_modules")).isSymbolicLink(), "node_modules is a junction to the source's");
assert.ok(existsSync(join(wt.path, "node_modules", "typescript", "package.json")));
const wt2 = await devis.addDevisWorktree({ source, workerFolder: join(root, "tasks", "again", "w1"), title: "Fix the banner" });
assert.equal(wt2.branch, "harness.user/devis/fix-the-banner-2", "a taken branch name gets a number");

// ---- what the branch changes ---------------------------------------------------------
let changes = await devis.devisChanges(wt.path);
assert.deepEqual(changes, { files: [], sensitive: [], ahead: 0, uncommitted: [], behind: false });
write(wt.path, "README.md", "# Devis\n\nNow with a better banner.\n");
write(wt.path, "src/service.mts", "export const port = 2;\n");
write(wt.path, "package.json", JSON.stringify({ name: "devis", version: "1.0.1" }, null, 2) + "\n");
commitAll(wt.path, "better banner");
write(wt.path, "notes.txt", "scratch\n");
changes = await devis.devisChanges(wt.path);
assert.equal(changes.ahead, 1);
assert.deepEqual(changes.files.map((f) => f.path).sort(), ["README.md", "package.json", "src/service.mts"]);
assert.deepEqual(changes.sensitive.sort(), ["package.json", "src/service.mts"]);
assert.deepEqual(changes.uncommitted, ["notes.txt"]);
assert.equal(changes.behind, false);
assert.equal(changes.files.find((f) => f.path === "README.md").added, 2);
rmSync(join(wt.path, "notes.txt"));
assert.ok(devis.isSensitive("scripts\\devis-updater.ps1"));
assert.ok(!devis.isSensitive("web/src/jarvis.ts"));

// ---- the checks ----------------------------------------------------------------------
// old-harness fails here and on master; new-harness fails only here.
harnessOutcome = (name, cwd) => (name === "old-harness.mjs" ? 1 : name === "new-harness.mjs" && cwd === wt.path ? 1 : 0);
process.env.ADO_PR_OPS_SECRET = "hidden";
const checks = await devis.runDevisChecks({ worktree: wt.path, source, label: "Fix the banner" });
assert.equal(checks.ok, false);
assert.equal(checks.build.ok, true);
assert.equal(checks.harnesses.total, 2);
assert.equal(checks.harnesses.passed, 0);
assert.deepEqual(checks.harnesses.failed, ["new-harness.mjs"]);
assert.deepEqual(checks.harnesses.preexisting, ["old-harness.mjs"]);
assert.match(checks.failures[0].output, /boom in scripts\/new-harness\.mjs/);
assert.ok(nodeRuns.every((r) => !("ADO_PR_OPS_SECRET" in r.env) && !("ADO_PR_OPS_DB_PATH" in r.env)), "the checks don't see the app's data");
const tscRuns = nodeRuns.filter((r) => r.args.includes("-p"));
assert.deepEqual(
    tscRuns.slice(0, 2).map((r) => r.args.at(-1)),
    ["tsconfig.backend.json", "tsconfig.web.json"],
);
assert.ok(tscRuns.some((r) => r.cwd === join(devis.devisDir(), "baseline")), "master is built to compare against");
const report = devis.checksReport(checks);
assert.match(report, /1 harness failed that pass on master/);
assert.match(report, /fail on master too, so they don't block: old-harness\.mjs/);
assert.equal(devis.checksProgress(), null);

harnessOutcome = (name) => (name === "old-harness.mjs" ? 1 : 0);
const before = nodeRuns.length;
const passing = await devis.runDevisChecks({ worktree: wt.path, source, label: "Fix the banner" });
assert.equal(passing.ok, true);
assert.deepEqual(passing.harnesses.preexisting, ["old-harness.mjs"]);
assert.ok(!nodeRuns.slice(before).some((r) => r.cwd.endsWith("baseline") && r.args.includes("-p")), "the built baseline is reused");

// ---- the ship gate -------------------------------------------------------------------
await assert.rejects(devis.shipGate({ sensitive: changes.sensitive, ack: false }), /Tick the box/);
assert.equal(await devis.shipGate({ sensitive: changes.sensitive, ack: true }), source);
write(source, "README.md", "# Devis (edited by hand)\n");
await assert.rejects(devis.shipGate({ sensitive: [], ack: false }), /uncommitted changes/);
git(source, "checkout", "-q", "--", "README.md");
git(source, "checkout", "-q", "-b", "side");
await assert.rejects(devis.shipGate({ sensitive: [], ack: false }), /on side, not master/);
git(source, "checkout", "-q", "master");
git(source, "branch", "-q", "-D", "side");

// ---- catching up with master ---------------------------------------------------------
write(source, "docs/other.md", "someone else's change\n");
write(source, "scripts/deploy-desktop.ps1", "# deploy v2\n");
commitAll(source, "other change");
assert.equal((await devis.devisChanges(wt.path)).behind, true);
let caught = await devis.catchUpWithMaster(wt.path);
assert.deepEqual(caught, { rebased: true, problem: null });
assert.ok(existsSync(join(wt.path, "docs", "other.md")));
assert.deepEqual(await devis.catchUpWithMaster(wt.path), { rebased: false, problem: null });

write(wt2.path, "scripts/deploy-desktop.ps1", "# deploy, their way\n");
commitAll(wt2.path, "their deploy");
caught = await devis.catchUpWithMaster(wt2.path);
assert.equal(caught.rebased, false);
assert.match(caught.problem, /doesn't rebase onto it cleanly/);
assert.equal(git(wt2.path, "status", "--porcelain"), "", "the failed rebase is aborted");

// ---- shipping ------------------------------------------------------------------------
const masterBefore = git(source, "rev-parse", "master");
const shipInput = {
    source,
    worktree: wt.path,
    branch: wt.branch,
    taskId: "task-1",
    sessionId: "session-1",
    worker: "w1",
    title: "Fix the banner",
    summary: "The banner reads better.",
    mode: "idle",
    checks: passing,
};
const ship1 = await devis.withShipLock(() => devis.completeShip(shipInput));
assert.equal(ship1.n, 1);
assert.equal(ship1.state, "deploying");
assert.equal(ship1.before, masterBefore);
assert.equal(ship1.commit, git(wt.path, "rev-parse", "HEAD"));
assert.equal(git(source, "rev-parse", "master"), ship1.commit, "master fast-forwarded");
assert.equal(git(source, "rev-parse", "devis/ship-1^{commit}"), ship1.commit);
assert.deepEqual(ship1.sensitive.sort(), ["package.json", "src/service.mts"]);
assert.deepEqual(ship1.checks, { passed: 1, total: 2, preexisting: ["old-harness.mjs"], ms: passing.ms });
assert.equal(ship1.updaterPid, 4242);
assert.equal(launched.length, 1);
const line = launched[0];
for (const part of [`-Ship 1`, `-Commit ${ship1.commit}`, `-Before ${masterBefore}`, `-Mode idle`, `-Source "${source}"`, "-NpmInstall"]) {
    assert.ok(line.includes(part), `the updater gets ${part}`);
}
const updater = readFileSync(join(devis.devisDir(), "updater-1.ps1"), "utf8");
assert.ok(updater.startsWith("\uFEFF# updater v1\r\nparam()"), "the updater from the commit before the ship, with a BOM and CRLF");
assert.equal(devis.getShip(1).state, "deploying");
assert.equal(devis.shipBusy(), true);
await assert.rejects(devis.shipGate({ sensitive: [], ack: false }), /Ship 1 is still deploying/);
assert.deepEqual(devis.devisBanner(), { n: 1, state: "deploying", mode: "idle", title: "Fix the banner", note: null, at: ship1.shippedAt });
await assert.rejects(
    devis.withShipLock(() => devis.withShipLock(async () => 0)),
    /Another ship is under way/,
);

// ---- settling ------------------------------------------------------------------------
const told = [];
const hooks = { notGoneLive: (ship, message) => told.push({ n: ship.n, message }) };
assert.deepEqual(await devis.settleShips(hooks), [], "no result yet, and the updater is still going");
writeFileSync(
    join(devis.devisDir(), "ship-1.result.json"),
    "\uFEFF" + JSON.stringify({ state: "rolled-back", logTail: "health check failed\nrolled back", note: "The new build didn't answer in 90 seconds." }),
);
git(source, "reset", "-q", "--keep", masterBefore);
let settled = await devis.settleShips(hooks);
assert.equal(settled.length, 1);
assert.equal(settled[0].state, "rolled-back");
assert.equal(settled[0].note, "The new build didn't answer in 90 seconds.");
assert.match(settled[0].log, /health check failed/);
assert.equal(told.length, 1);
assert.match(told[0].message, /Ship 1 didn't go live\. The new build didn't answer in 90 seconds\./);
assert.match(told[0].message, /Master is back at/);
assert.match(told[0].message, /call devis_ready_to_ship again/);
assert.equal(devis.shipBusy(), false);
let banner = devis.devisBanner();
assert.equal(banner.state, "rolled-back");
assert.equal(devis.devisBanner(Date.now() + 8 * 86_400_000), null, "an old failure drops off");
devis.dismissShip(1);
assert.equal(devis.devisBanner(), null);
assert.throws(() => devis.undoTask(1), /isn't live/);
assert.throws(() => devis.dismissShip(99), /There's no ship 99/);
const events = await store.listEvents({ kinds: ["devisShip"] });
assert.ok(events.some((e) => /Ship 1 \(Fix the banner\) is deploying once the workers are done/.test(e.text)));
assert.ok(events.some((e) => /was rolled back/.test(e.text)));

// Ship it again, and this time it goes live.
const ship2 = await devis.withShipLock(() => devis.completeShip({ ...shipInput, mode: "now" }));
assert.equal(ship2.n, 2);
assert.equal(ship2.state, "deploying");
assert.ok(launched[1].includes("-Mode now"));
running = ship2.commit;
assert.deepEqual(await devis.settleShips(hooks), [], "the new build is up, but give the updater time to say so");
settled = await devis.settleShips(hooks, Date.now() - 6 * 60_000);
assert.equal(settled[0].state, "live", "the new build has run five minutes without a word");
assert.equal(settled[0].note, null);
banner = devis.devisBanner();
assert.equal(banner.n, 2);
assert.equal(banner.state, "live");
assert.equal(devis.devisBanner(Date.now() + 31 * 60_000), null, "the live banner goes after half an hour");
const overview = await devis.devisOverview();
assert.equal(overview.commit, ship2.commit);
assert.deepEqual(overview.ships.map((x) => x.n), [2, 1]);
assert.equal(overview.busy, false);
assert.equal(overview.enabled, true);

// ---- undo ----------------------------------------------------------------------------
const undo = devis.undoTask(2);
assert.equal(undo.title, "Undo ship 2: Fix the banner");
assert.ok(undo.description.includes(`git revert --no-edit ${ship2.before}..${ship2.commit}`));
devis.markUndo(2, "task-undo");
assert.equal(devis.getShip(2).undoTaskId, "task-undo");
const wt3 = await devis.addDevisWorktree({ source, workerFolder: join(root, "tasks", "undo", "w1"), title: "Undo ship 2" });
git(wt3.path, "revert", "--no-edit", `${ship2.before}..${ship2.commit}`);
const ship3 = await devis.withShipLock(() =>
    devis.completeShip({ ...shipInput, worktree: wt3.path, branch: wt3.branch, taskId: "task-undo", title: "Undo ship 2" }),
);
assert.equal(ship3.n, 3);
assert.equal(devis.getShip(2).revertedBy, 3, "shipping the undo task marks the ship undone");
assert.throws(() => devis.undoTask(2), /already undone by ship 3/);

// The updater quits without a result: not the running build, so it failed.
alive.delete(4242);
settled = await devis.settleShips(hooks);
assert.equal(settled[0].n, 3);
assert.equal(settled[0].state, "failed");
assert.match(settled[0].note, /stopped without saying how it went/);

// ---- an updater that doesn't start ---------------------------------------------------
const wt4 = await devis.addDevisWorktree({ source, workerFolder: join(root, "tasks", "four", "w1"), title: "Small tweak" });
write(wt4.path, "docs/tweak.md", "tweak\n");
commitAll(wt4.path, "tweak");
const masterNow = git(source, "rev-parse", "master");
launchError = "Access is denied.";
const ship4 = await devis.withShipLock(() =>
    devis.completeShip({ ...shipInput, worktree: wt4.path, branch: wt4.branch, taskId: "task-4", title: "Small tweak" }),
);
assert.equal(ship4.state, "failed");
assert.match(ship4.note, /The updater didn't start: Access is denied\. Master is back at/);
assert.equal(git(source, "rev-parse", "master"), masterNow, "master is reset");
assert.equal(devis.getShip(4).state, "failed");
assert.ok(!launched.some((l) => l.includes("-Ship 4")));
launchError = null;

// ---- turning it off ------------------------------------------------------------------
s = await devis.saveDevisSettings({ enabled: false });
assert.equal(s.enabled, false);
await assert.rejects(devis.shipGate({ sensitive: [], ack: false }), /Changing Devis itself is off/);
assert.equal(first.length, 40);

// ---- cleanup -------------------------------------------------------------------------
devis.setDevisRuntime(null);
codebase.setCodebaseRuntime(null);
closeDb();
for (const tree of [wt, wt2, wt3, wt4, { path: join(devis.devisDir(), "baseline") }]) {
    const link = join(tree.path, "node_modules");
    try {
        if (lstatSync(link).isSymbolicLink()) {
            try {
                unlinkSync(link);
            } catch {
                rmdirSync(link);
            }
        }
    } catch {
        // not there
    }
}
void config;
rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
console.log("devis-self harness: ok");
