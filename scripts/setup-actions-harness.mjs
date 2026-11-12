// First run and the setup buttons from outside Devis: what the page may ask of the shell, the
// login item, setup.json, and every setup action against a stand-in machine (nothing installs,
// nothing opens a window, nothing signs in).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSetupEnv, setupActivity, setupJobs, startSetupAction, SetupError, cmdLine } from "../setup-actions.mjs";
import { initSetupState, readSetupState, setupStatePath, writeSetupState } from "../setup-state.mjs";
import { folderPickedScript, loginItem, shellRequest } from "../shell-request.mjs";
import { ServiceLifecycle } from "../service-lifecycle.mjs";

const root = mkdtempSync(join(tmpdir(), "devis-setup-"));
const until = async (test, ms = 3000) => {
    const end = Date.now() + ms;
    while (!test()) {
        if (Date.now() > end) throw new Error("timed out waiting");
        await new Promise((r) => setTimeout(r, 5));
    }
};
const finished = (job) => until(() => job.state !== "running");
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
    return { promise, resolve, reject };
};
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", timedOut: false });
const fail = (stderr) => ({ code: 1, stdout: "", stderr, timedOut: false });
const quiet = { log: console.log, warn: console.warn };
console.log = console.warn = () => {};

try {
    // ---- shellRequest: only the service's own origin, at /, with a well-formed id ----
    const origin = "http://127.0.0.1:4317";
    assert.deepEqual(shellRequest(`${origin}/?shell-request=pick-folder&id=ab12`, origin), { kind: "pick-folder", id: "ab12" });
    assert.deepEqual(shellRequest(`${origin}/?shell-request=login-item`, origin), { kind: "login-item" });
    assert.equal(shellRequest(`http://127.0.0.1:9999/?shell-request=login-item`, origin), null);
    assert.equal(shellRequest(`https://evil.example/?shell-request=login-item`, origin), null);
    assert.equal(shellRequest(`${origin}/other?shell-request=login-item`, origin), null);
    assert.equal(shellRequest(`${origin}/?shell-request=pick-folder`, origin), null);
    assert.equal(shellRequest(`${origin}/?shell-request=pick-folder&id=a-b`, origin), null);
    assert.equal(shellRequest(`${origin}/?shell-request=pick-folder&id=${"a".repeat(33)}`, origin), null);
    assert.equal(shellRequest(`${origin}/?shell-request=format-disk`, origin), null);
    assert.equal(shellRequest(`${origin}/`, origin), null);
    assert.equal(shellRequest("not a url", origin), null);
    assert.equal(shellRequest(`${origin}/?shell-request=login-item`, ""), null);

    // ---- folderPickedScript: a path with quotes and backslashes arrives intact ----
    {
        const seen = [];
        const run = (script) => new Function("window", "CustomEvent", script)({ dispatchEvent: (e) => seen.push(e) }, class { constructor(type, init) { this.type = type; this.detail = init.detail; } });
        const path = 'C:\\Users\\a "b"\\src\'); alert(1); //';
        run(folderPickedScript("x1", path));
        run(folderPickedScript("x2", null));
        assert.deepEqual(seen.map((e) => [e.type, e.detail]), [
            ["devis:folder-picked", { id: "x1", path }],
            ["devis:folder-picked", { id: "x2", path: null }],
        ]);
    }

    // ---- loginItem: packaged Windows with the user's own data folder only ----
    const win = { platform: "win32", packaged: true, execPath: "C:\\Apps\\Devis\\Devis.exe" };
    assert.deepEqual(loginItem(true, win), { openAtLogin: true, path: win.execPath, args: ["--background"] });
    assert.deepEqual(loginItem(false, win), { openAtLogin: false, path: win.execPath, args: ["--background"] });
    assert.equal(loginItem(true, { ...win, platform: "darwin" }), null);
    assert.equal(loginItem(true, { ...win, packaged: false }), null);
    assert.equal(loginItem(true, { ...win, userDataOverride: "C:\\temp\\test-data" }), null);

    // ---- setup.json ----
    {
        const dir = join(root, "state-new");
        const config = join(dir, "config.json");
        assert.equal(setupStatePath(config), join(dir, "setup.json"));
        // No config yet: a new install, which goes through setup.
        assert.deepEqual(initSetupState(config), { done: false, startAtSignIn: false });
        // The config the wizard then saves doesn't flip it; only finishing does.
        writeFileSync(config, "{}");
        assert.equal(initSetupState(config).done, false);
        const finishedAt = writeSetupState({ done: true }, setupStatePath(config));
        assert.equal(finishedAt.done, true);
        assert.ok(!Number.isNaN(Date.parse(finishedAt.doneAt)));
        // doneAt sticks, other fields merge, and junk is ignored.
        const later = writeSetupState({ startAtSignIn: true, done: "yes", extra: 1 }, setupStatePath(config));
        assert.deepEqual(later, { done: true, startAtSignIn: true, doneAt: finishedAt.doneAt });
        assert.deepEqual(readSetupState(setupStatePath(config)), later);
        assert.ok(!readFileSync(setupStatePath(config), "utf8").includes("extra"));

        // An install from before setup existed: already set up.
        const old = join(root, "state-old");
        mkdirSync(old, { recursive: true });
        writeFileSync(join(old, "config.json"), "{}");
        const migrated = initSetupState(join(old, "config.json"));
        assert.equal(migrated.done, true);
        assert.equal(migrated.startAtSignIn, false);

        // A missing or broken file never traps anyone in setup.
        assert.deepEqual(readSetupState(join(root, "nowhere", "setup.json")), { done: true, startAtSignIn: false });
        const bad = join(root, "bad-setup.json");
        writeFileSync(bad, "{ not json");
        assert.deepEqual(readSetupState(bad), { done: true, startAtSignIn: false });
        writeFileSync(bad, JSON.stringify({ done: false, startAtSignIn: "true" }));
        assert.deepEqual(readSetupState(bad), { done: false, startAtSignIn: false });
    }

    // ---- start at sign-in keeps the service up even with nothing attached ----
    {
        let keep = true;
        let t = 0;
        const life = new ServiceLifecycle({ idleExitMs: 10, checkMs: 1000, onIdle: () => {}, now: () => t, keepAlive: () => keep });
        t = 100;
        assert.equal(await life.check(), false);
        keep = false;
        assert.equal(await life.check(), false); // idle starts counting now
        t = 200;
        assert.equal(await life.check(), true);
        const throwing = new ServiceLifecycle({ idleExitMs: 0, checkMs: 1000, onIdle: () => {}, now: () => 0, keepAlive: () => { throw new Error("bad file"); } });
        assert.equal(await throwing.check(), true);
    }

    // ---- jobs ----
    assert.throws(() => startSetupAction("rm-rf"), (e) => e instanceof SetupError && e.status === 404);

    // One at a time per action: pressing it again joins the running job, and it keeps the service up.
    {
        const window = deferred();
        let opened = 0;
        setSetupEnv({
            azureCli: () => "C:\\az\\bin\\az.cmd",
            openConsole: (title, line) => {
                opened++;
                assert.equal(title, "Azure sign-in");
                assert.equal(line, "C:\\az\\bin\\az.cmd login --allow-no-subscriptions");
                return window.promise;
            },
            azureAccount: async () => "me@contoso.com",
        });
        const a = startSetupAction("azure-signin");
        const b = startSetupAction("azure-signin");
        assert.equal(a, b);
        await until(() => a.message === "Finish signing in in the window that opened.");
        assert.equal(opened, 1);
        assert.deepEqual(setupActivity(), [{ kind: "other", label: "Setup: signing in to Azure" }]);
        window.resolve(0);
        await finished(a);
        assert.equal(a.state, "done");
        assert.equal(a.message, "Signed in as me@contoso.com.");
        assert.equal(a.progress, 1);
        assert.ok(a.endedAt);
        assert.deepEqual(setupActivity(), []);
        // The finished job stays, for a page that reloads; pressing again starts a new one.
        assert.deepEqual(setupJobs(), [a]);
        const again = startSetupAction("azure-signin");
        assert.notEqual(again.id, a.id);
        await finished(again);
        assert.equal(setupJobs().length, 1);
    }

    // Sign-ins that don't take, and ones that can't start.
    {
        setSetupEnv({ azureCli: () => null });
        const noAz = startSetupAction("azure-signin");
        await finished(noAz);
        assert.equal(noAz.state, "failed");
        assert.equal(noAz.message, "Install the Azure CLI first.");

        setSetupEnv({ azureCli: () => "az.cmd", openConsole: async () => 1, azureAccount: async () => { throw new Error("AADSTS"); } });
        const notSigned = startSetupAction("azure-signin");
        await finished(notSigned);
        assert.match(notSigned.message, /^Still not signed in\./);

        setSetupEnv({ copilotLogin: async () => null });
        const noAgency = startSetupAction("copilot-signin");
        await finished(noAgency);
        assert.match(noAgency.message, /needs Agency/);

        setSetupEnv({ copilotLogin: async () => ["C:\\agency\\agency.exe", "copilot", "login"], openConsole: async (_t, line) => (assert.equal(line, "C:\\agency\\agency.exe copilot login"), 0), copilotAccount: async () => "octo" });
        const copilot = startSetupAction("copilot-signin");
        await finished(copilot);
        assert.equal(copilot.message, "Signed in as octo.");

        setSetupEnv({ gh: () => null });
        const noGh = startSetupAction("github-signin");
        await finished(noGh);
        assert.match(noGh.message, /winget install GitHub\.cli/);

        setSetupEnv({ gh: () => "gh.exe", openConsole: async () => 0, ghAccount: async () => null });
        const ghNot = startSetupAction("github-signin");
        await finished(ghNot);
        assert.match(ghNot.message, /^Still not signed in to GitHub/);
    }

    // cmd quoting for console windows.
    assert.equal(cmdLine(["C:\\Program Files\\az.cmd", "login", 'a"b', ""]), '"C:\\Program Files\\az.cmd" login "a""b" ""');

    // ---- azure-install ----
    {
        const azDir = join(root, "tools", "azure-cli");
        const progress = [];
        setSetupEnv({
            azureCli: () => null,
            azureCliDir: () => azDir,
            download: async (_url, file, report) => {
                writeFileSync(file, "zip");
                report(50 * 1024 * 1024, 100 * 1024 * 1024);
                report(100 * 1024 * 1024, 100 * 1024 * 1024);
            },
            extract: async (_zip, dir) => {
                mkdirSync(join(dir, "bin"), { recursive: true });
                writeFileSync(join(dir, "bin", "az.cmd"), "@echo off");
            },
            run: async (file, args) => {
                assert.equal(file, join(azDir, "bin", "az.cmd"));
                assert.deepEqual(args, ["version", "--output", "json"]);
                return ok(JSON.stringify({ "azure-cli": "2.75.0" }));
            },
        });
        const job = startSetupAction("azure-install");
        const seen = setInterval(() => progress.push(job.progress), 1);
        await finished(job);
        clearInterval(seen);
        assert.equal(job.state, "done", job.message);
        assert.equal(job.message, "Azure CLI 2.75.0 installed. Sign in next.");
        assert.ok(existsSync(join(azDir, "bin", "az.cmd")));
        assert.ok(!existsSync(`${azDir}.new`) && !existsSync(`${azDir}.old`) && !existsSync(join(root, "tools", "azure-cli.zip.part")));
        assert.ok(progress.every((p) => p === null || (p >= 0 && p <= 1)));

        // A download without the CLI in it fails, and leaves the copy that's there alone.
        setSetupEnv({ azureCli: () => null, azureCliDir: () => azDir, download: async (_u, file) => writeFileSync(file, "zip"), extract: async () => {} });
        const empty = startSetupAction("azure-install");
        await finished(empty);
        assert.equal(empty.state, "failed");
        assert.equal(empty.message, "The download didn't have the Azure CLI in it.");
        assert.ok(existsSync(join(azDir, "bin", "az.cmd")));
        assert.ok(!existsSync(`${azDir}.new`));

        // Already there: nothing to do.
        setSetupEnv({ azureCli: () => "C:\\az\\az.cmd" });
        const already = startSetupAction("azure-install");
        await finished(already);
        assert.equal(already.message, "The Azure CLI is already installed.");
    }

    // ---- agency-install ----
    {
        let installed = false;
        const lines = [];
        setSetupEnv({
            agencyPath: () => (installed ? "C:\\agency\\agency.exe" : null),
            agencyInstaller: () => ({ file: "installer.exe", args: ["agency"] }),
            run: async (file, args, opts) => {
                assert.equal(file, "installer.exe");
                opts.onLine("Downloading agency 1.2.3");
                lines.push("ran");
                installed = true;
                return ok();
            },
            restartForAgency: async () => true,
        });
        const job = startSetupAction("agency-install");
        await finished(job);
        assert.equal(job.state, "done", job.message);
        assert.equal(job.restart, true);
        assert.match(job.message, /^Agency installed\. Restart /);

        setSetupEnv({ agencyPath: () => null, agencyInstaller: () => ({ file: "x", args: [] }), run: async () => ({ ...fail("policy blocked"), timedOut: false }) });
        const blocked = startSetupAction("agency-install");
        await finished(blocked);
        assert.equal(blocked.message, "Agency didn't install: policy blocked");

        setSetupEnv({ agencyPath: () => null, agencyInstaller: () => ({ file: "x", args: [] }), run: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }) });
        const slow = startSetupAction("agency-install");
        await finished(slow);
        assert.match(slow.message, /more than 15 minutes/);

        setSetupEnv({ agencyPath: () => "C:\\agency\\agency.exe", restartForAgency: async () => false });
        const there = startSetupAction("agency-install");
        await finished(there);
        assert.equal(there.message, "Agency is already installed.");
        assert.equal(there.restart, undefined);
    }

    // ---- devis-source ----
    {
        const src = (over) =>
            setSetupEnv({
                gh: () => null,
                git: () => "git",
                node: () => "node",
                npm: () => "npm",
                saveSource: async () => {},
                ...over,
            });
        const runFor = (input) => {
            const job = startSetupAction("devis-source", input);
            return finished(job).then(() => job);
        };

        src({});
        assert.equal((await runFor({ folder: "relative\\path" })).message, "Choose a folder by its full path.");
        assert.equal((await runFor({})).message, "Choose a folder by its full path.");

        // Clone fails: the half-made folder goes.
        const cloneFails = join(root, "src-a");
        src({ run: async (file, args) => (file === "git" && args[0] === "clone" ? (mkdirSync(args[2], { recursive: true }), fail("Repository not found.")) : ok()) });
        const failed = await runFor({ folder: cloneFails });
        assert.equal(failed.message, "Couldn't get the source: Repository not found.");
        assert.ok(!existsSync(join(cloneFails, "devis")));

        // Cloned, but nothing published yet.
        const unpublished = join(root, "src-b");
        src({ run: async (file, args) => (args[0] === "clone" ? (mkdirSync(join(args[2], ".git"), { recursive: true }), ok()) : ok()) });
        assert.match((await runFor({ folder: unpublished })).message, /^There's no source in .+ yet\./);
        assert.ok(!existsSync(join(unpublished, "devis")));

        // A folder that's in the way.
        const taken = join(root, "src-c");
        mkdirSync(join(taken, "devis"), { recursive: true });
        writeFileSync(join(taken, "devis", "notes.txt"), "mine");
        assert.match((await runFor({ folder: `"${taken}\\"` })).message, /already exists and isn't a clone/);
        assert.ok(existsSync(join(taken, "devis", "notes.txt")));

        // Node too old.
        const oldNode = join(root, "src-d");
        const cloneWithSource = (args) => {
            mkdirSync(join(args[args.length - 1], ".git"), { recursive: true });
            writeFileSync(join(args[args.length - 1], "package.json"), "{}");
            return ok();
        };
        src({ run: async (file, args) => (args.includes("clone") ? cloneWithSource(args) : file === "node" ? ok("v20.11.0\n") : ok()) });
        assert.match((await runFor({ folder: oldNode })).message, /needs Node\.js 22 or newer \(this machine has v20\.11\.0\)/);

        // All the way, through gh when it's there; an existing clone is reused.
        const good = join(root, "src-e");
        const calls = [];
        let saved = null;
        src({
            gh: () => "gh.exe",
            run: async (file, args, opts) => {
                calls.push([file, args[0], opts.cwd ?? null]);
                if (file === "gh.exe") return cloneWithSource(args);
                if (file === "node") return ok("v22.14.0");
                opts.onLine?.("added 512 packages");
                return ok();
            },
            saveSource: async (path) => void (saved = path),
        });
        const done = await runFor({ folder: good });
        assert.equal(done.state, "done", done.message);
        assert.equal(done.path, join(good, "devis"));
        assert.equal(saved, join(good, "devis"));
        assert.deepEqual(calls, [["gh.exe", "repo", null], ["node", "--version", null], ["npm", "ci", join(good, "devis")]]);
        calls.length = 0;
        const reused = await runFor({ folder: good });
        assert.equal(reused.state, "done", reused.message);
        assert.deepEqual(calls.map((c) => c[0]), ["node", "npm"]);

        // npm ci fails.
        src({ run: async (file, args) => (args.includes("clone") ? cloneWithSource(args) : file === "node" ? ok("v24.1.0") : fail("npm ERR! code E401")) });
        assert.equal((await runFor({ folder: join(root, "src-f") })).message, "npm ci failed: npm ERR! code E401");
    }

    setSetupEnv(null);
    assert.deepEqual(setupJobs(), []);
} finally {
    console.log = quiet.log;
    console.warn = quiet.warn;
    rmSync(root, { recursive: true, force: true });
}

console.log("setup-actions harness: ok");
