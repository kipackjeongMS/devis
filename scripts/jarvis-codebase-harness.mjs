// Jarvis task folders and the codebase, end to end with real git: a task gets
// its own folder named after its title, its first worker starts there, proposes
// repositories, gets a worktree of each one the user confirms (on its own branch
// off origin's default branch), and removing the worker or the task wipes the
// folders, worktrees and branches while the Artifacts stay.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "jarvis-codebase-"));
process.env.ADO_PR_OPS_DB_PATH = join(root, "data", "reviews.db");
process.env.ADO_PR_OPS_JARVIS_DIR = join(root, "jarvis");
process.env.ADO_PR_OPS_CONFIG_PATH = join(root, "config.json");
const taskRoot = join(root, "tasks");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

// ---- two "remote" repositories, as bare repos with a main branch ------------------------
const remotes = join(root, "remotes");
function makeRemote(name, branch = "main") {
    const work = join(remotes, `${name}-work`);
    mkdirSync(work, { recursive: true });
    git(work, "init", "-q", "-b", branch);
    git(work, "config", "user.email", "harness@contoso.com");
    git(work, "config", "user.name", "Harness");
    git(work, "config", "core.autocrlf", "false");
    writeFileSync(join(work, "README.md"), `# ${name}\n`);
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "first");
    const bare = join(remotes, `${name}.git`);
    git(remotes, "clone", "-q", "--bare", work, bare);
    return bare;
}
const remoteOf = { alpha: makeRemote("alpha"), beta: makeRemote("beta", "master") };

const config = await import("../config.mjs");
const store = await import("../jarvis-store.mjs");
const codebase = await import("../jarvis-codebase.mjs");
const workers = await import("../jarvis-workers.mjs");
const today = await import("../jarvis-today.mjs");
const prsModule = await import("../jarvis-prs.mjs");
const { closeDb } = await import("../store.mjs");

codebase.setCodebaseRuntime({
    git: (args, opts) =>
        new Promise((resolve, reject) => {
            try {
                resolve(execFileSync("git", args, { cwd: opts.cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim());
            } catch (error) {
                reject(new Error(String(error.stderr || error.message).trim()));
            }
        }),
    token: async () => null,
    cloneUrl: (r) => remoteOf[r.repo],
    account: async () => "Harness.User@contoso.com",
});

prsModule.setPrsRuntime({
    now: () => Date.now(),
    me: async () => ({ id: "me-1", name: "Me" }),
    getPr: async () => null,
    workItem: async () => null,
    branchPrs: async () => [],
    checks: async () => ({ passed: 0, failed: 0, running: 0, total: 0, failing: [] }),
    unresolved: async () => 0,
    git: async () => null,
    orgs: async () => ["contoso"],
});

// ---- a fake Copilot runtime whose first turn sets the workspace up ----------------------
const sessions = [];
const removed = [];
/** What the next session's first turn does; it gets the session and the prompt. */
let firstTurn = null;
class FakeSession {
    constructor(sessionId, config) {
        this.sessionId = sessionId;
        this.config = config;
        this.sent = [];
        this.displayed = [];
        this.turn = firstTurn;
        this.rpc = { commands: { list: async () => ({ commands: [] }) }, model: { getCurrent: async () => ({ modelId: "x" }) } };
    }
    on() {
        return () => undefined;
    }
    async sendAndWait({ prompt, displayPrompt }) {
        this.sent.push(prompt);
        this.displayed.push(displayPrompt ?? null);
        const turn = this.turn;
        this.turn = null;
        return { data: { content: turn ? await turn(this, prompt) : "Done." } };
    }
    async abort() {}
    async disconnect() {}
    async getEvents() {
        return [];
    }
    tool(name) {
        const tool = this.config.tools.find((t) => t.name === name);
        return tool ? (args) => tool.handler(args, { sessionId: this.sessionId }) : null;
    }
}
workers.setWorkerRuntime({
    async create(config) {
        const s = new FakeSession(config.sessionId, config);
        sessions.push(s);
        return s;
    },
    async resume(sessionId, config) {
        const s = new FakeSession(sessionId, config);
        sessions.push(s);
        return s;
    },
    async remove(sessionId) {
        removed.push(sessionId);
    },
    async models() {
        return [];
    },
});

async function until(check, label, ms = 30_000) {
    const end = Date.now() + ms;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

try {
    // ---- folder names ----
    assert.equal(store.taskSlug("some work needed"), "some-work-needed");
    assert.equal(store.taskSlug("  Fix: AppConfig (v2) / Retry  "), "fix-appconfig-v2-retry");
    assert.equal(store.taskSlug("CON"), "con-task", "a name Windows reserves");
    assert.equal(store.taskSlug("..."), "task");
    assert.equal(store.taskSlug("Tidy up.lock"), "tidy-up-lock", "a name git refuses in branches");
    assert.equal(store.taskSlug("x".repeat(80)).length, 60);

    // ---- Settings: a save that leaves out the Jarvis fields keeps them ----
    await config.writeConfig({
        organizations: ["contoso"],
        projects: {},
        codebase: [
            { org: "contoso", project: "Proj", repo: "alpha" },
            { org: "contoso", project: "Proj", repo: "beta" },
            { org: "contoso", project: "Proj", repo: "alpha" },
            { org: "", project: "Proj", repo: "bad" },
        ],
        taskRoot,
    });
    let cfg = await config.writeConfig({ organizations: ["contoso"], projects: {}, reviewModel: "", reviewsDir: "" });
    assert.deepEqual(cfg.codebase.map(config.codebaseKey), ["contoso/Proj/alpha", "contoso/Proj/beta"], "deduped, and kept across a save without them");
    assert.equal(cfg.taskRoot, taskRoot);

    // ---- cloning, once ----
    assert.deepEqual((await codebase.codebaseStatus()).map((e) => e.state), ["missing", "missing"]);
    const [p1, p2] = await Promise.all([codebase.ensureClone(cfg.codebase[0]), codebase.ensureClone(cfg.codebase[0])]);
    assert.equal(p1, p2);
    assert.equal(p1, join(root, "jarvis", "codebase", "contoso", "Proj", "alpha"));
    assert.ok(existsSync(join(p1, ".git")));
    assert.ok(!existsSync(join(p1, "README.md")), "the clone keeps no checkout");
    await codebase.syncCodebase();
    await until(async () => (await codebase.codebaseStatus()).every((e) => e.state === "ready"), "both clones");

    // ---- a new task: its folder, and a worker that sets it up ----
    firstTurn = async (session) => {
        session.repos = await session.tool("task_workspace")({ action: "repos" });
        session.result = await session.tool("task_workspace")({ action: "propose", repos: ["alpha", "nope"], reason: "The API lives in alpha." });
        return "Set up.";
    };
    const made = await today.createTaskFromInput(
        { title: "Some Work Needed", description: "Make the API retry.\n\nDone when tests pass." },
        ["contoso"],
        { taskRoot: cfg.taskRoot, requireFolder: true },
    );
    assert.equal(made.created, true);
    assert.equal(made.workerError, null);
    const task = made.task;
    assert.equal(task.folder, join(taskRoot, "some-work-needed"));
    assert.equal(task.description, "Make the API retry.\n\nDone when tests pass.");
    assert.ok(existsSync(task.folder));
    const worker = made.worker;
    assert.equal(worker.label, "atlas");
    assert.equal(worker.cwd, join(task.folder, "atlas"));
    assert.ok(existsSync(worker.cwd));
    const session = sessions.at(-1);
    assert.match(session.config.systemMessage.content, /The task's description:\nMake the API retry\.\n\nDone when tests pass\./);
    assert.match(session.config.systemMessage.content, /your own folder inside the task's folder/);
    assert.ok(session.config.tools.some((t) => t.name === "task_workspace"));
    await until(() => session.displayed.length, "the setup turn");
    assert.equal(session.displayed[0], "Set up your workspace and start on this task.");

    // The worker proposes; the user sees a repos request with alpha checked.
    const request = await until(() => workers.workerLiveState(worker.sessionId).requests[0], "the repos request");
    assert.match(session.repos, /contoso\/Proj\/alpha\n- contoso\/Proj\/beta/);
    assert.equal(request.kind, "repos");
    assert.deepEqual(request.choices, ["contoso/Proj/alpha", "contoso/Proj/beta"]);
    assert.deepEqual(request.selected, ["contoso/Proj/alpha"]);
    assert.match(request.detail, /left out: nope/);
    assert.equal((await store.getWorker(worker.sessionId)).state, "needsInput");
    await assert.rejects(workers.messageWorker(worker.sessionId, "yes", request.id), /confirm the repositories/);
    // The user keeps alpha and adds beta.
    assert.deepEqual(await workers.confirmRepos(worker.sessionId, request.id, ["contoso/Proj/alpha", "CONTOSO/Proj/beta", "evil/x/y"]), [
        "contoso/Proj/alpha",
        "contoso/Proj/beta",
    ]);
    await until(() => session.result, "the worktrees");
    assert.match(session.result, /^The user confirmed\. Your worktrees:/);
    const trees = await store.listWorktrees({ sessionId: worker.sessionId });
    assert.deepEqual(trees.map((t) => [t.repo, basename(t.path), t.branch, t.base]), [
        ["alpha", "alpha", "harness.user/some-work-needed/atlas", "origin/main"],
        ["beta", "beta", "harness.user/some-work-needed/atlas", "origin/master"],
    ]);
    const alphaTree = trees[0];
    assert.equal(alphaTree.path, join(worker.cwd, "alpha"));
    assert.match(readFileSync(join(alphaTree.path, "README.md"), "utf8"), /^# alpha\r?\n$/);
    assert.equal(git(alphaTree.path, "rev-parse", "--abbrev-ref", "HEAD"), "harness.user/some-work-needed/atlas");
    assert.throws(() => git(alphaTree.path, "config", "--get", "branch.harness.user/some-work-needed/atlas.merge"), undefined, "no upstream: a plain push can't land on main");
    await until(async () => (await store.getWorker(worker.sessionId)).state === "turnDone", "the setup turn to end");

    // A resumed session's brief lists its worktrees, and its skills come from them.
    mkdirSync(join(alphaTree.path, ".github", "skills"), { recursive: true });
    firstTurn = null;
    await workers.closeAllWorkers();
    const before = sessions.length;
    await workers.messageWorker(worker.sessionId, "keep going");
    const resumed = await until(() => sessions[before], "the resumed session");
    assert.match(resumed.config.systemMessage.content, /- contoso\/Proj\/alpha: .*alpha \(branch harness\.user\/some-work-needed\/atlas, from origin\/main\)/);
    assert.equal(resumed.config.skillDirectories[0], join(alphaTree.path, ".github", "skills"));
    await until(async () => (await store.getWorker(worker.sessionId)).state === "turnDone", "the second turn");

    // Today shows the worker's worktrees.
    const snap = await today.todaySnapshot();
    const todayWorker = snap.tasks.find((t) => t.id === task.id).workers[0];
    assert.deepEqual(todayWorker.worktrees.map((w) => w.repo), ["alpha", "beta"]);

    // ---- another worker on the same task: a folder beside the first, the same setup ----
    firstTurn = async (s) => {
        s.result = await s.tool("task_workspace")({ action: "propose", repos: ["contoso/Proj/alpha"] });
        return "Set up.";
    };
    const second = await workers.startWorker({ taskId: task.id, prompt: "Take the docs." });
    assert.equal(second.label, "birch");
    assert.equal(second.cwd, join(task.folder, "birch"));
    const secondSession = sessions.at(-1);
    await until(() => secondSession.sent.length, "the second worker's first turn");
    assert.match(secondSession.sent[0], /The user's instructions:\nTake the docs\./);
    assert.equal(secondSession.displayed[0], "Take the docs.");
    const req2 = await until(() => workers.workerLiveState(second.sessionId).requests[0], "the second repos request");
    await workers.confirmRepos(second.sessionId, req2.id, ["contoso/Proj/alpha"]);
    await until(() => secondSession.result, "the second worktree");
    const birchTree = (await store.listWorktrees({ sessionId: second.sessionId }))[0];
    assert.equal(birchTree.branch, "harness.user/some-work-needed/birch");

    // Changes that removing would lose.
    writeFileSync(join(birchTree.path, "notes.txt"), "draft\n");
    assert.deepEqual(await codebase.worktreeChanges(birchTree), { path: birchTree.path, repo: "alpha", uncommitted: 1, unpushed: 0 });
    git(birchTree.path, "-c", "user.email=h@c.com", "-c", "user.name=H", "add", ".");
    git(birchTree.path, "-c", "user.email=h@c.com", "-c", "user.name=H", "commit", "-q", "-m", "wip");
    assert.deepEqual(await codebase.worktreeChanges(birchTree), { path: birchTree.path, repo: "alpha", uncommitted: 0, unpushed: 1 });

    // Removing a worker wipes its folder, worktree and branch, and leaves the other worker's alone.
    await workers.removeWorker(second.sessionId);
    const alphaClone = codebase.clonePath({ org: "contoso", project: "Proj", repo: "alpha" });
    assert.ok(!existsSync(second.cwd));
    assert.equal(git(alphaClone, "branch", "--list", "harness.user/some-work-needed/birch"), "");
    assert.ok(existsSync(alphaTree.path));
    assert.deepEqual(await store.listWorktrees({ sessionId: second.sessionId }), []);

    // A second task with the same title gets a numbered folder.
    firstTurn = null;
    const twin = await today.createTaskFromInput({ title: "some work needed" }, ["contoso"], { taskRoot: cfg.taskRoot, requireFolder: true });
    assert.equal(twin.task.folder, join(taskRoot, "some-work-needed-2"));
    assert.equal(twin.worker.label, "birch", "a removed worker's name is free again");

    // A branch already on origin isn't reused: the new one gets a number.
    const pushedFrom = join(root, "pushed");
    git(root, "clone", "-q", remoteOf.alpha, pushedFrom);
    git(pushedFrom, "push", "-q", "origin", "HEAD:refs/heads/harness.user/some-work-needed-2/birch");
    const reused = await codebase.addWorktree({
        repo: { org: "contoso", project: "Proj", repo: "alpha" },
        workerFolder: twin.worker.cwd,
        taskName: "some-work-needed-2",
        workerName: "birch",
    });
    assert.equal(reused.branch, "harness.user/some-work-needed-2/birch-2");
    await codebase.removeWorktree(reused);

    // No folder anywhere: the page asks for one; the Lead's path makes a task without one.
    await assert.rejects(today.createTaskFromInput({ title: "Loose" }, ["contoso"], { taskRoot: "", requireFolder: true }), /Choose where the task's folder goes/);
    await assert.rejects(today.createTaskFromInput({ title: "Relative" }, ["contoso"], { taskRoot: "tasks" }), /full path/);
    const loose = await today.createTaskFromInput({ title: "Loose" }, ["contoso"], { taskRoot: "" });
    assert.equal(loose.task.folder, null);
    assert.equal(loose.worker, null);

    // ---- removing the task wipes its folder, worktrees and branches; Artifacts stay ----
    await workers.removeTask(task.id);
    await workers.removalsIdle();
    assert.equal(await store.getTask(task.id), null);
    assert.ok(!existsSync(task.folder), "the task's folder is gone");
    assert.equal(git(alphaClone, "branch", "--list", "harness.user/*"), "", "its branches are gone");
    assert.ok(!git(alphaClone, "worktree", "list").includes("some-work-needed"), "git forgot the worktrees");
    assert.deepEqual(await store.listWorktrees({ taskId: task.id }), []);
    assert.ok(removed.includes(worker.sessionId), "its Copilot session was deleted");
    const record = JSON.parse(readFileSync(join(store.taskDir(task.id), "task.json"), "utf8"));
    assert.equal(record.folder, task.folder);
    assert.deepEqual(record.worktrees.map((w) => w.repo), ["contoso/Proj/alpha", "contoso/Proj/beta"]);
    assert.ok(existsSync(join(store.artifactsDir(task.id), "note.md")), "the Artifacts stay");
    assert.ok(existsSync(twin.task.folder), "the other task's folder is untouched");

    // ---- an older task without a folder: a worker in the user's own folder, never deleted ----
    const legacyFolder = join(root, "repos", "mine");
    mkdirSync(legacyFolder, { recursive: true });
    const legacy = await store.createTask({ title: "Old style" });
    assert.equal(legacy.task.folder, null);
    const old = await workers.startWorker({ taskId: legacy.task.id, cwd: legacyFolder, prompt: "Look around." });
    assert.equal(old.cwd, legacyFolder);
    assert.ok(!sessions.at(-1).config.tools.some((t) => t.name === "task_workspace"), "no repositories to set up");
    await until(async () => (await store.getWorker(old.sessionId)).state === "turnDone", "the legacy turn");
    await workers.removeWorker(old.sessionId);
    assert.ok(existsSync(legacyFolder), "the user's own folder stays");
    await assert.rejects(workers.startWorker({ taskId: legacy.task.id, prompt: "x" }), /full path/);

    // A folder outside the task's folder is never deleted, whatever a row says.
    assert.equal(codebase.removeFolder("C:\\"), "Left C:\\ alone: it's not a folder the app made.");
    assert.ok(codebase.isInside(join(taskRoot, "a", "b"), taskRoot));
    assert.ok(!codebase.isInside(taskRoot, taskRoot));
    assert.ok(!codebase.isInside(join(root, "elsewhere"), taskRoot));

    console.log("jarvis-codebase harness: ok");
} finally {
    await workers.closeAllWorkers().catch(() => undefined);
    await workers.removalsIdle().catch(() => undefined);
    closeDb();
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
