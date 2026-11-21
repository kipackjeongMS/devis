import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A task's validation chains end to end, against a temporary database, a fake Azure DevOps
// (runner and discovery) and fake workers: many chains per task, shared by its workers, runs
// labeled with who ran them and whose code they built, and queues when a chain is busy.
// Nothing here talks to a real organization.

const root = mkdtempSync(join(tmpdir(), "jarvis-validation-"));
mkdirSync(join(root, "data"), { recursive: true });
process.env.ADO_PR_OPS_DB_PATH = join(root, "data", "reviews.db");
process.env.ADO_PR_OPS_JARVIS_DIR = join(root, "jarvis");
process.env.ADO_PR_OPS_CONFIG_PATH = join(root, "config.json");
writeFileSync(process.env.ADO_PR_OPS_CONFIG_PATH, JSON.stringify({ organizations: ["msazure"], projects: {}, reviewModel: "", reviewsDir: "" }));

const store = await import("../jarvis-store.mjs");
const v = await import("../jarvis-validation.mjs");
const agent = await import("../jarvis-validation-agent.mjs");
const pipes = await import("../pipeline-store.mjs");
const runner = await import("../pipeline-runner.mjs");
const { repoSignature, runnerKey } = await import("../pipeline-graph.mjs");
const today = await import("../jarvis-today.mjs");
const workers = await import("../jarvis-workers.mjs");
const { closeDb } = await import("../store.mjs");

// Marking a task done writes its recap through a worker session: none may reach Copilot here.
const sessionCalls = [];
workers.setWorkerRuntime({
    create: async () => {
        sessionCalls.push("create");
        throw new Error("no Copilot in this harness");
    },
    resume: async (sessionId) => {
        sessionCalls.push(`resume ${sessionId}`);
        throw new Error("no Copilot in this harness");
    },
    remove: async () => undefined,
    models: async () => [],
});

const until = async (check, what, ms = 4000) => {
    const end = Date.now() + ms;
    for (;;) {
        if (await check()) return;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 20));
    }
};

// ---- fake workers, and the checks behind a block's repository branches ---------------------------
const told = [];
const busy = new Set();
let onMessage = null;
// The branches each worker has checked out, as the app last saw them.
const workerBranchMap = new Map();
// Every YAML takes templates from GovernedTemplates (alias `templates`). A branch named "broken"
// doesn't compile; looking up "flaky" fails; only release/1 and flaky exist.
const previewCalls = [];
const repoLookups = [];
const templatesYaml = [
    "resources:",
    "  repositories:",
    "  - repository: templates",
    "    type: git",
    "    name: OneBranch.Pipelines/GovernedTemplates",
    "    ref: refs/heads/main",
    "steps:",
    "- script: echo hi",
].join("\n");
v.setValidationRuntime({
    previewPipeline: async (org, project, definitionId, branch, params, repos) => {
        previewCalls.push({ definitionId, branch, params, repos });
        if (Object.values(repos ?? {}).includes("broken")) return { rejected: "Could not find template build.yml@templates" };
        return { finalYaml: templatesYaml };
    },
    branchExists: async (org, project, repo, branch) => {
        repoLookups.push([project, repo, branch]);
        if (branch === "flaky") throw new Error('ADO GET 503: {"message":"unavailable"}');
        return branch === "release/1";
    },
    buildFailures: async (org, project, buildId) => [
        { name: "Run smoke tests", type: "Task", errors: [`boom in build ${buildId}`], logUrl: `https://log/${buildId}` },
    ],
    workerBusy: async (sessionId) => busy.has(sessionId),
    workerBranches: async (sessionId) => workerBranchMap.get(sessionId) ?? [],
    messageWorker: async (sessionId, text) => {
        if (busy.has(sessionId)) throw Object.assign(new Error("busy"), { status: 409 });
        told.push({ sessionId, text });
        if (onMessage) await onMessage(sessionId, text);
    },
});

// ---- fake ADO: the runner -----------------------------------------------------------------
const builds = new Map();
const queued = [];
let nextBuild = 500;
const prBranches = new Map([[7, "refs/heads/kjeong/feature"]]);
const newBuild = (definitionId) => {
    const id = nextBuild++;
    const b = { id, definitionId, buildNumber: `B${id}`, status: "notStarted", url: `https://dev.azure.com/msazure/p/_build/results?buildId=${id}` };
    builds.set(id, b);
    return { ...b };
};
// Completes every unfinished build of a pipeline: only for when one run is going.
const setBuild = (definitionId, status, result) => {
    for (const b of builds.values()) if (b.definitionId === definitionId && b.status !== "completed") Object.assign(b, { status, result });
};
// One build, for runs going side by side.
const finishBuild = (id, result) => Object.assign(builds.get(id), { status: "completed", result });
await runner.startPipelineRunner({
    pollMs: 60_000,
    maxPollFailures: 3,
    ado: {
        async queueBuild(org, project, definitionId, sourceBranch) {
            queued.push({ definitionId, branch: sourceBranch ?? "" });
            return newBuild(definitionId);
        },
        async runPipeline(org, project, definitionId, branch, pins, params) {
            queued.push({ definitionId, branch, params });
            return newBuild(definitionId);
        },
        async getBuild(org, project, buildId) {
            return { ...builds.get(buildId) };
        },
        async cancelBuild(org, project, buildId) {
            builds.get(buildId).status = "cancelling";
        },
        async getDefinition(org, project, definitionId) {
            // `defs` (below) is read only once runs go: a block that builds its runner's code needs the repository.
            return { yaml: definitionId !== 13, projectId: "proj-guid", defaultBranch: "refs/heads/main", name: `P${definitionId}`, path: "\\", projectName: project, queueStatus: "enabled", repository: defs[definitionId]?.repository ?? null };
        },
        async getRunParameters() {
            return { parameters: [{ name: "env", label: "env", kind: "string", default: "dev", values: ["dev", "test"] }], resources: [], errors: [] };
        },
        async prSourceBranch(org, prId) {
            const ref = prBranches.get(prId);
            if (!ref) throw new Error(`ADO GET 404: {"message":"PR ${prId} not found"}`);
            return ref;
        },
    },
});
const tick = () => runner.tickPipelineRunner();
const buildOf = async (runId, node = "v1") => (await pipes.getRun(runId)).states[node]?.buildId;
// Builds the runner asked to cancel finish as canceled.
const settleCancels = async () => {
    await tick();
    for (const b of builds.values()) if (b.status === "cancelling") Object.assign(b, { status: "completed", result: "canceled" });
    await tick();
};
const stopAndWait = async (runId) => {
    await pipes.requestRunCancel(runId);
    await settleCancels();
    await until(async () => (await pipes.getRun(runId)).status !== "running", `run ${runId} stopping`);
};
/** Stop every run of a task's chains that's still going. */
const stopAll = async (taskId) => {
    const live = (await v.validationView(taskId)).chains.flatMap((c) => c.runs.filter((r) => r.status === "running").map((r) => r.runId));
    for (const id of live) await pipes.requestRunCancel(id);
    await settleCancels();
    await until(async () => (await v.validationView(taskId)).running === 0, "every run stopping");
};

// ---- fake ADO: discovery ----------------------------------------------------------------------
const PROJECT = "Azure AppConfig";
const defs = {
    11: { name: "AppConfig-CI", path: "\\CI", yaml: true, queueStatus: "enabled", repository: { id: "repo-guid", name: "AppConfig", type: "TfsGit" } },
    12: { name: "Deploy-Test", path: "\\CD", yaml: true, queueStatus: "enabled", repository: { id: "repo-guid", name: "AppConfig", type: "TfsGit" } },
    13: { name: "Deploy-Prod", path: "\\CD", yaml: true, queueStatus: "enabled", repository: { id: "repo-guid", name: "AppConfig", type: "TfsGit" } },
    14: { name: "Old-Thing", path: "\\", yaml: true, queueStatus: "disabled", repository: null },
    15: { name: "Classic-Release", path: "\\", yaml: false, queueStatus: "enabled", repository: null },
    17: { name: "Other-Repo-CI", path: "\\CI", yaml: true, queueStatus: "enabled", repository: { id: "other-guid", name: "Other", type: "TfsGit" } },
    18: { name: "Deploy-Folder", path: "\\CD", yaml: true, queueStatus: "enabled", repository: { id: "repo-guid", name: "AppConfig", type: "TfsGit" } },
};
const discoveryCalls = { policies: 0, branch: [], repos: [] };
agent.setDiscoveryRuntime({
    listDefinitions: async (org, project) =>
        Object.entries(defs).map(([id, d]) => ({ org, project, id: Number(id), name: d.name, path: d.path, url: "", queueStatus: d.queueStatus, latest: null })),
    definitionInfo: async (org, project, id) => {
        const d = defs[id];
        if (!d) throw new Error(`ADO GET 404: {"message":"Pipeline ${id} not found"}`);
        return { yaml: d.yaml, projectId: "proj-guid", defaultBranch: "refs/heads/main", name: d.name, path: d.path, projectName: PROJECT, queueStatus: d.queueStatus, repository: d.repository };
    },
    runParameters: async (org, project, projectId, id) => {
        if (Number(id) === 12)
            return {
                parameters: [{ name: "env", label: "env", kind: "string", default: "dev", values: ["dev", "test"] }],
                resources: [{ alias: "build", name: "AppConfig-CI" }],
                repositories: [{ alias: "templates", name: "GovernedTemplates", type: "TfsGit", project: "OneBranch.Pipelines", id: "tmpl-guid", ref: "refs/heads/main" }],
                errors: [],
            };
        if (Number(id) === 13) return { parameters: [], resources: [{ alias: "build", name: "AppConfig-CI" }], errors: [] };
        if (Number(id) === 18) return { parameters: [], resources: [{ alias: "ci", name: "\\CI\\AppConfig-CI" }, { alias: "elsewhere", name: "\\Other\\AppConfig-CI" }], errors: [] };
        return { parameters: [], resources: [], errors: [] };
    },
    prBuildPolicies: async () => {
        discoveryCalls.policies++;
        return [{ definitionId: 11, name: "CI", blocking: true, status: "approved" }];
    },
    branchExists: async (org, project, repoId, branch) => {
        discoveryCalls.branch.push(branch);
        discoveryCalls.repos.push([project, repoId, branch]);
        return branch === "release/1";
    },
});

v.startValidationRunner();

// ---- a task with a PR and a worker ------------------------------------------------------------
const snapshot = (prId, over = {}) => ({
    project: PROJECT,
    projectId: "proj-guid",
    repo: "AppConfig",
    repoId: "repo-guid",
    title: `PR ${prId}`,
    status: "active",
    isDraft: false,
    author: "Me",
    authorId: "me",
    created: new Date().toISOString(),
    closed: null,
    sourceRef: "kjeong/feature",
    targetRef: "main",
    sourceCommit: "aaa1111",
    url: `https://dev.azure.com/msazure/p/_git/r/pullrequest/${prId}`,
    mergeStatus: "succeeded",
    reviewers: [],
    ...over,
});
const { task } = await store.createTask({ title: "Ship the cache" });
await store.upsertTaskPr(task.id, "msazure", 7, "user", snapshot(7));
await store.insertWorker({ sessionId: "w1-session", taskId: task.id, label: "W1", cwd: root, model: null, state: "idle", summary: "" });


const YOU = v.YOU_TRIGGER;
const W1T = { kind: "worker", label: "W1", sessionId: "w1-session" };
const W3T = { kind: "worker", label: "W3", sessionId: "w3-session" };
const LEAD = { kind: "lead", label: "Devis" };
const chainOf = async (taskId, chainId) => (await v.validationView(taskId)).chains.find((c) => c.chain.id === chainId);
const taskEvents = async (taskId) => (await store.listEvents({ taskId, limit: 200 })).map((e) => e.text);
const rejectsWith = (promise, status, pattern, message) => assert.rejects(promise, (e) => e.status === status && pattern.test(e.message), message);

// ---- 1. no validation yet ----------------------------------------------------------------------
assert.equal(await v.validationSummary(task.id), null);
let snap = await today.todaySnapshot();
assert.equal(snap.tasks.find((t) => t.id === task.id).validation, null, "Today says no validation");
const mine = await pipes.saveChain({ name: "My release", graph: { nodes: [{ id: "a", org: "msazure", project: PROJECT, definitionId: 11, name: "AppConfig-CI", path: "\\", branch: "", x: 0, y: 0 }], edges: [] } });
let view = await v.validationView(task.id);
assert.deepEqual([view.chains, view.proposals], [[], []]);
assert.deepEqual(view.templates.map((t) => t.id), [mine.id], "the user's own chains can be copied in");
assert.deepEqual(view.prs.map((p) => p.prId), [7]);
assert.equal(view.autoPropose, false, "automatic proposals are off by default");
assert.deepEqual(view.limits, { perChain: 3, perTask: 6, queue: 10, chains: 12 });
assert.equal(view.running, 0);
{
    const w1 = view.targets.find((t) => t.id === "worker:w1-session");
    assert.deepEqual([w1.kind, w1.label, w1.ready, w1.detail], ["worker", "W1", false, "No branch seen yet"], "a worker with no branch can't be picked yet");
    const pr7 = view.targets.find((t) => t.id === "pr:msazure/7");
    assert.deepEqual([pr7.kind, pr7.label, pr7.ready, pr7.detail], ["pr", "PR 7", true, "PR 7 (AppConfig, kjeong/feature)"]);
}

// ---- 2. many chains: attach, copy, name, remove --------------------------------------------------------
const first = await v.attachChain(task.id);
assert.equal(first.ownerTaskId, task.id);
assert.equal(first.name, "Validation · Ship the cache", "the first chain is named for the task");
const second = await v.attachChain(task.id, { name: "  Smoke   only ", purpose: "  Quick check " });
assert.equal(second.name, "Smoke only", "a given name is tidied");
const third = await v.attachChain(task.id);
assert.equal(third.name, "Validation · Ship the cache (3)", "later default names are numbered");
view = await v.validationView(task.id);
assert.deepEqual(view.chains.map((c) => c.chain.id), [first.id, second.id, third.id], "in the order they were added");
assert.equal(view.chains[1].purpose, "Quick check");
assert.equal(view.chains[0].acceptedBy, "you");
assert.deepEqual([view.chains[0].concurrency, view.chains[0].mode, view.chains[0].workersMayRun, view.chains[0].notifyWorker], ["auto", "parallel", false, true]);
let listed = (await pipes.listChains()).find((c) => c.id === first.id);
assert.deepEqual(listed.owner, { taskId: task.id, title: "Ship the cache", status: "open" }, "Pipelines knows whose chain it is");
assert.equal((await pipes.listChains()).find((c) => c.id === mine.id).owner, null);
await rejectsWith(
    v.runChains(task.id, first.id, { trigger: YOU }),
    409,
    /^"Validation · Ship the cache" has no pipelines yet\. Add some in Pipelines first\.$/,
    "an empty chain is refused, and so is the request when nothing could run",
);
await rejectsWith(v.runChains(task.id, [], { trigger: YOU }), 400, /^Pick a validation chain to run\.$/);
{
    const copyOfFirst = await v.saveAsReusable(task.id, first.id);
    assert.equal(copyOfFirst.name, "Ship the cache validation", "a default-named chain's reusable copy reads naturally");
    assert.equal(copyOfFirst.ownerTaskId, null);
    await pipes.deleteChain(copyOfFirst.id);
}
await v.removeChain(task.id, third.id);
assert.equal(await pipes.getChain(third.id), null, "removing deletes the chain");
await rejectsWith(v.removeChain(task.id, third.id), 404, /isn't on this task anymore/);
const copy = await v.attachChain(task.id, { from: mine.id });
assert.equal(copy.name, "My release", "a copy keeps the saved chain's name");
assert.deepEqual(copy.graph.nodes.map((n) => n.definitionId), [11], "a copy of a saved chain");
assert.ok(await pipes.getChain(mine.id), "the original stays");
await rejectsWith(v.attachChain(task.id, { from: "no-such-chain" }), 404, /^That chain is gone\.$/);
// A chain removed from the Pipelines tab is forgotten by the task too.
await pipes.deleteChain(copy.id);
assert.deepEqual((await v.validationView(task.id)).chains.map((c) => c.chain.id), [first.id, second.id]);
{
    const extras = [];
    while ((await v.validationView(task.id)).chains.length < 12) extras.push(await v.attachChain(task.id));
    await rejectsWith(v.attachChain(task.id), 409, /^A task can have up to 12 validation chains\.$/);
    for (const x of extras) await v.removeChain(task.id, x.id);
}
await v.setChainOptions(task.id, second.id, { name: "Smoke", purpose: "Fast check of the PR's build." });
await rejectsWith(v.setChainOptions(task.id, second.id, { concurrency: "many" }), 400, /^Concurrency is auto, one or parallel\.$/);
await rejectsWith(v.setChainOptions(task.id, second.id, { name: "   " }), 400, /^Give the chain a name\.$/);
await rejectsWith(v.setChainOptions(task.id, "no-such-chain", { purpose: "x" }), 404, /isn't on this task anymore/);
await v.removeChain(task.id, first.id);
view = await v.validationView(task.id);
assert.deepEqual(view.chains.map((c) => [c.chain.name, c.purpose]), [["Smoke", "Fast check of the PR's build."]]);
{
    const events = await taskEvents(task.id);
    assert.ok(events.includes('Validation chain "Smoke only" added to Ship the cache'));
    assert.ok(events.includes('Validation chain "Validation · Ship the cache" removed from Ship the cache'));
}

// ---- 3. candidates: what the app can vouch for --------------------------------------------------------
const { candidates, notes } = await agent.findCandidates(task.id);
const byId = new Map(candidates.map((c) => [c.definitionId, c]));
assert.ok(byId.get(11).evidence.some((e) => e.kind === "prCheck" && e.verified), "the PR's required build");
assert.equal(byId.get(11).suggested.followPr, 7, "a PR check builds the PR's branch");
assert.ok(byId.get(12).evidence.some((e) => e.kind === "consumes"), "a pipeline that uses the build");
assert.deepEqual(byId.get(12).uses, ["msazure/Azure AppConfig/11"]);
assert.ok(byId.get(13).evidence.some((e) => e.kind === "production"), "a production-sounding name is flagged");
assert.ok(byId.get(11).evidence.some((e) => e.kind === "history"), "chains the user ran with it");
assert.ok(!byId.has(14) && !byId.has(15), "disabled and unrelated pipelines aren't candidates");
assert.ok(Array.isArray(notes));

// ---- 4. proposals: a new chain or a change to one, refused with every problem, then accepted ---------------------
const ref = (id) => `msazure/${PROJECT}/${id}`;
await assert.rejects(
    agent.propose(task.id, { summary: "s", blocks: [{ pipeline: ref(11), reason: "r" }] }, "W1", "w1-session"),
    /Not proposed: this task already has validation chains\. To change one, pass its chainId/,
    "with chains on the task, a new one needs a purpose that says when to use it",
);
await assert.rejects(
    agent.propose(task.id, { chainId: "nope", summary: "s", blocks: [{ pipeline: ref(11), reason: "r" }] }, "W1", null),
    /Not proposed: chain nope isn't on this task\./,
);
await assert.rejects(
    agent.propose(task.id, {
        purpose: "Full check",
        blocks: [
            { pipeline: ref(11), followPr: 99, reason: "CI" },
            { pipeline: ref(12), params: { env: "prod" }, reason: "" },
            { pipeline: "contoso/X/1", reason: "x" },
            { pipeline: ref(14), reason: "old" },
            { pipeline: ref(15), params: { a: "1" }, reason: "classic" },
            { pipeline: ref(11), reason: "twice" },
            { pipeline: ref(13), branch: "nope", after: [ref(11)], reason: "prod" },
            { pipeline: ref(17), followPr: 7, reason: "another repo" },
            { pipeline: ref(18), reason: "uses CI by its folder path" },
        ],
    }, "W1", "w1-session"),
    (error) => {
        const m = error.message;
        assert.match(m, /^Not proposed\. Fix these/);
        assert.match(m, /Other-Repo-CI builds the Other repository, but PR 7 is in AppConfig, so it can't follow that PR/);
        assert.match(m, /Deploy-Folder uses AppConfig-CI's output \(ci\), so it has to run after it/, "a folder-qualified resource is matched by its folder");
        assert.doesNotMatch(m, /\(elsewhere\)/, "a resource in another folder isn't this pipeline");
        assert.match(m, /Add a summary/);
        assert.match(m, /follows PR 99, which isn't linked to this task/);
        assert.match(m, /Deploy-Test: add a reason/);
        assert.match(m, /Deploy-Test: .*env/, "a parameter value outside its allowed values");
        assert.match(m, /Deploy-Test uses AppConfig-CI's output \(build\), so it has to run after it/);
        assert.match(m, /"contoso" isn't one of the user's organizations/);
        assert.match(m, /Old-Thing is disabled/);
        assert.match(m, /Classic-Release is a classic pipeline/);
        assert.match(m, /Pipeline 11 is listed twice/);
        assert.match(m, /branch nope doesn't exist in AppConfig/);
        return true;
    },
);
assert.deepEqual((await v.validationView(task.id)).proposals, [], "a refused proposal isn't stored");
await assert.rejects(
    agent.propose(task.id, { purpose: "p", summary: "s", blocks: [{ pipeline: ref(11), reason: "a", after: [ref(12)] }, { pipeline: ref(12), reason: "b", after: [ref(11)] }] }, "W1", null),
    /cycle|loop/i,
    "cycles are refused",
);

const proposed = await agent.propose(
    task.id,
    {
        name: "Build and test",
        purpose: "Before merging: builds the PR, then deploys it to Test.",
        summary: "Builds the PR, then deploys it to Test.",
        blocks: [
            { pipeline: ref(11), followPr: 7, reason: "The PR's required CI build." },
            { pipeline: ref(12), after: [ref(11)], params: { env: "test" }, reason: "Deploys that build to Test." },
        ],
        leftOut: [{ pipeline: ref(13), reason: "Production." }],
    },
    "W1",
    "w1-session",
);
assert.match(proposed, /^Proposed\. A new chain: AppConfig-CI → Deploy-Test\. It waits for the user under Needs you; nothing changes or runs until they accept\./);
view = await v.validationView(task.id);
const buildProposal = view.proposals.find((x) => x.name === "Build and test");
assert.equal(buildProposal.chainId, null, "a new chain, not a change");
assert.equal(buildProposal.by, "W1");
assert.equal(buildProposal.purpose, "Before merging: builds the PR, then deploys it to Test.");
assert.deepEqual(buildProposal.blocks.map((b) => [b.definitionId, b.stage]), [[11, 0], [12, 1]]);
assert.deepEqual(buildProposal.blocks[0].branchFrom, { org: "msazure", prId: 7 });
assert.equal(buildProposal.blocks[0].branch, "");
assert.ok(buildProposal.blocks[0].evidence.some((e) => e.kind === "prCheck"), "evidence the app checked");
assert.ok(buildProposal.blocks[1].evidence.some((e) => e.kind === "consumes"));
assert.deepEqual(buildProposal.leftOut.map((l) => [l.name, l.evidence.map((e) => e.kind)]), [["Deploy-Prod", ["production"]]]);
assert.ok(buildProposal.checks.some((c) => c.text === "All 2 pipelines exist and are enabled"));
assert.ok(!buildProposal.checks.some((c) => c.text === "Every fixed branch exists"), "no fixed branch was checked, so it isn't claimed");
assert.ok(buildProposal.checks.some((c) => /PR 7/.test(c.text)));
let summary = await v.validationSummary(task.id);
assert.equal(summary.attention, "proposal", "a proposal waits for the user");
assert.deepEqual(summary.proposals.map((x) => [x.name, x.by, x.blocks, x.chainId]), [["Build and test", "W1", 2, null]]);
snap = await today.todaySnapshot();
assert.equal(snap.tasks.find((t) => t.id === task.id).validation.attention, "proposal", "Today shows it under Needs you");

// A fixed branch is checked, and only then claimed. A proposer's newer proposal for the same new chain replaces its older one.
const scratch = (extra) => ({ name: "Scratch", purpose: "p", summary: "s", ...extra });
await agent.propose(task.id, scratch({ blocks: [{ pipeline: ref(11), branch: "release/1", reason: "r" }] }), "W1", null);
const scratchOf = async () => (await v.validationView(task.id)).proposals.filter((x) => x.name === "Scratch");
assert.ok((await scratchOf())[0].checks.some((c) => c.text === "Every fixed branch exists"));
assert.ok(discoveryCalls.branch.includes("release/1"));

// Branches for a pipeline's repository resources: the alias must be one its YAML has, and the branch must exist there.
await assert.rejects(
    agent.propose(task.id, scratch({
        blocks: [
            { pipeline: ref(12), repoBranches: { gone: "release/1" }, reason: "a" },
            { pipeline: ref(15), repoBranches: { templates: "release/1" }, reason: "classic" },
        ],
    }), "W1", null),
    (error) => {
        assert.match(error.message, /Deploy-Test: Repository "gone" is no longer a resource of this pipeline\. Its repository resources: templates\./);
        assert.match(error.message, /Classic-Release is a classic pipeline, which has no repository resources/);
        return true;
    },
);
await assert.rejects(
    agent.propose(task.id, scratch({ blocks: [{ pipeline: ref(12), repoBranches: { templates: "users/me/fix" }, reason: "a" }] }), "W1", null),
    /Deploy-Test: branch users\/me\/fix doesn't exist in GovernedTemplates \(repository resource templates\)/,
);
await assert.rejects(
    agent.propose(task.id, scratch({ blocks: [{ pipeline: ref(12), repoBranches: { self: "release/1" }, reason: "a" }] }), "W1", null),
    /own repository builds the block's Branch/,
);
discoveryCalls.repos.length = 0;
await agent.propose(task.id, scratch({ blocks: [{ pipeline: ref(12), repoBranches: { Templates: "refs/heads/release/1" }, reason: "a" }] }), "W1", null);
{
    const list = await scratchOf();
    assert.equal(list.length, 1, "the newer Scratch replaced the older one");
    const rp = list[0];
    assert.deepEqual(rp.blocks[0].repoBranches, { Templates: "release/1" });
    assert.deepEqual(discoveryCalls.repos, [["OneBranch.Pipelines", "tmpl-guid", "release/1"]], "checked in the repository's own project");
    assert.ok(rp.checks.some((c) => c.text === "Every fixed branch exists"));
    assert.ok(rp.checks.some((c) => c.tone === "warn" && c.text === "Deploy-Test uses release/1 of Templates instead of the YAML's ref"));
    assert.deepEqual(v.proposalGraph(rp).nodes[0].repoBranches, { Templates: "release/1" }, "accepting carries them into the chain");
}

// A change to an existing chain names it.
const changeMsg = await agent.propose(
    task.id,
    { chainId: second.id, summary: "CI only, on the PR.", blocks: [{ pipeline: ref(11), followPr: 7, reason: "The PR's CI." }] },
    "W1",
    "w1-session",
);
assert.match(changeMsg, /^Proposed\. A change to "Smoke": AppConfig-CI\./);
view = await v.validationView(task.id);
assert.deepEqual(view.proposals.map((x) => [x.name, x.chainId]), [["Build and test", null], ["Scratch", null], ["Smoke", second.id]], "every proposal waits, oldest first");
assert.match(await agent.validationStatusText(task.id), /Proposal by W1 waits for the user: a change to "Smoke": AppConfig-CI\./);

// Dismissed: the proposer hears why. Only a proposal that's still there can be dismissed.
await rejectsWith(v.dismissProposal(task.id, "no", "an-older-proposal"), 409, /^That proposal changed or is gone\. Review the current ones\.$/);
told.length = 0;
await v.dismissProposal(task.id, "Use the Test ring only", (await scratchOf())[0].id);
assert.deepEqual(await scratchOf(), []);
assert.equal(told.length, 1);
assert.equal(told[0].sessionId, "w1-session", "a proposal with no session goes to the newest worker");
assert.match(told[0].text, /^The user dismissed your proposed validation chain "Scratch" for this task, saying: "Use the Test ring only"\./);

// Accepted: a new chain laid out in stages, or a change to the chain it names.
await rejectsWith(v.acceptProposal(task.id, {}), 400, /^Say which proposal you reviewed\.$/);
await rejectsWith(v.acceptProposal(task.id, { id: "an-older-proposal", run: true }), 409, /changed or is gone/, "a newer proposal can't slip in");
assert.equal((await v.validationView(task.id)).chains.length, 1, "nothing was created");
const { chain, runs: noRuns } = await v.acceptProposal(task.id, { id: buildProposal.id });
assert.equal(noRuns, undefined);
assert.equal(chain.ownerTaskId, task.id);
assert.equal(chain.name, "Build and test", "the proposal's name");
assert.deepEqual(chain.graph.nodes.map((n) => [n.id, n.definitionId, n.branch, n.branchFrom, n.x, n.y]), [
    ["v1", 11, "", { org: "msazure", prId: 7 }, 40, 40],
    ["v2", 12, "", undefined, 360, 40],
]);
assert.deepEqual(chain.graph.nodes[1].params, { env: "test" });
assert.deepEqual(chain.graph.edges, [{ from: "v1", to: "v2" }]);
{
    const c = await chainOf(task.id, chain.id);
    assert.equal(c.purpose, "Before merging: builds the PR, then deploys it to Test.");
    assert.equal(c.acceptedBy, "W1");
    assert.equal(c.evidence["msazure/azure appconfig/11"].reason, "The PR's required CI build.", "why each pipeline is there is kept");
}
const smokeChange = view.proposals.find((x) => x.chainId === second.id);
const changed = await v.acceptProposal(task.id, { id: smokeChange.id });
assert.equal(changed.chain.id, second.id, "a change keeps the chain");
assert.equal(changed.chain.name, "Smoke");
assert.deepEqual(changed.chain.graph.nodes.map((n) => [n.definitionId, n.branchFrom]), [[11, { org: "msazure", prId: 7 }]]);
{
    const c = await chainOf(task.id, second.id);
    assert.equal(c.purpose, "Fast check of the PR's build.", "a change without a purpose keeps the chain's");
    assert.equal(c.acceptedBy, "W1");
}
view = await v.validationView(task.id);
assert.deepEqual(view.chains.map((c) => c.chain.name), ["Smoke", "Build and test"]);
assert.deepEqual(view.proposals, []);
assert.equal((await v.validationSummary(task.id)).attention, null);
{
    const events = await taskEvents(task.id);
    assert.ok(events.some((e) => /^W1 proposed a validation chain "Build and test" for Ship the cache: AppConfig-CI → Deploy-Test$/.test(e)));
    assert.ok(events.some((e) => /^W1 proposed a change to "Smoke" for Ship the cache: AppConfig-CI$/.test(e)));
    assert.ok(events.some((e) => /^Validation chain "Build and test" accepted for Ship the cache: AppConfig-CI → Deploy-Test$/.test(e)));
    assert.ok(events.some((e) => /^Change to "Smoke" accepted for Ship the cache: AppConfig-CI$/.test(e)));
    assert.ok(events.some((e) => /^Proposed validation chain "Scratch" dismissed for Ship the cache: Use the Test ring only$/.test(e)));
}

// ---- 5. a run: the PR's branch, who ran it, History, a status line, and what failed for the worker ---------------
told.length = 0;
let outcomes = await v.runChains(task.id, chain.id, { trigger: YOU });
assert.deepEqual(outcomes.map((o) => [o.status, o.message]), [["started", '"Build and test" started.']]);
const run1 = outcomes[0].runId;
await tick();
assert.deepEqual(queued.at(-1), { definitionId: 11, branch: "refs/heads/kjeong/feature" }, "the block builds the PR's branch, read when it queues");
assert.equal((await pipes.getRun(run1)).states.v1.followed, "msazure/7", "the run records which PR the block followed");
setBuild(11, "completed", "succeeded");
await tick();
await tick();
assert.equal(queued.at(-1).definitionId, 12);
assert.equal(queued.at(-1).branch, "", "a block without a branch builds the pipeline's default");
assert.deepEqual(queued.at(-1).params, { env: "test" });
summary = await v.validationSummary(task.id);
assert.equal(summary.running, 1);
assert.deepEqual(
    [summary.run.chain, summary.run.by, summary.run.status, summary.run.done, summary.run.current],
    ["Build and test", "You", "running", 1, "Deploy-Test"],
);
setBuild(12, "completed", "failed");
await tick();
await until(async () => told.length > 0, "the worker hearing what failed");
assert.equal(told[0].sessionId, "w1-session", "the user's run reports to the newest worker");
assert.match(told[0].text, /^Validation chain "Build and test" \(chainId [^)]+\) failed, run by the user: failed at Deploy-Test \(build B\d+\)\./);
assert.match(told[0].text, /Run smoke tests" failed: boom in build \d+/);
assert.match(told[0].text, /Log: https:\/\/log\/\d+/);
assert.match(told[0].text, /Running it again \(task_validation action run\) asks the user first\.$/, "a chain that deploys always asks");
await until(async () => (await store.listStatuses({ taskId: task.id, limit: 10 })).some((s) => s.author === "Validation"), "a status line");
const status = (await store.listStatuses({ taskId: task.id, limit: 10 })).find((s) => s.author === "Validation");
assert.match(status.text, /^Validation "Build and test" failed at Deploy-Test/);
{
    const events = await taskEvents(task.id);
    assert.ok(events.includes('You started "Build and test" (Ship the cache)'));
    assert.ok(events.some((e) => /^Validation "Build and test" failed at Deploy-Test \(build B\d+\) \(Ship the cache\)$/.test(e)));
}
summary = await v.validationSummary(task.id);
assert.equal(summary.attention, "failed", "a failed run needs the user");
assert.deepEqual(summary.failures.map((f) => [f.chain, f.failed, f.by]), [["Build and test", "Deploy-Test", "You"]]);
assert.deepEqual([summary.lastUsed.by, summary.lastUsed.kind, summary.lastUsed.chain], ["You", "you", "Build and test"], "who used validation last");
{
    const c = await chainOf(task.id, chain.id);
    assert.equal(c.runs[0].runId, run1);
    assert.deepEqual([c.runs[0].by, c.runs[0].trigger, c.runs[0].for], ["You", YOU, null]);
    assert.deepEqual(c.runs[0].blocks.map((b) => [b.name, b.status]), [["AppConfig-CI", "succeeded"], ["Deploy-Test", "failed"]]);
    assert.equal(c.runs[0].blocks[0].branch, "refs/heads/kjeong/feature", "each block shows the branch it built");
    assert.match(c.runs[0].text, /^failed at Deploy-Test \(build B\d+\)$/);
    assert.deepEqual(c.latest.map((l) => [l.label, l.kind, l.status]), [["You", "you", "failed"]]);
    assert.deepEqual([c.summary.lastUsed.by, c.summary.failures.length], ["You", 1]);
}
await v.acknowledgeRun(task.id, "some-other-run");
assert.equal((await v.validationSummary(task.id)).attention, "failed", "acknowledging another run changes nothing");
await v.acknowledgeRun(task.id, run1);
assert.equal((await v.validationSummary(task.id)).attention, null, "seen: it leaves Needs you");
assert.equal((await chainOf(task.id, chain.id)).runs[0].acked, true);
assert.match((await v.validationHistory(task.id))[0], /Validation "Build and test" failed at Deploy-Test \(build B\d+\) \(run by You\)$/);

// The user can turn the worker report off, per chain.
await v.setChainOptions(task.id, chain.id, { notifyWorker: false });
told.length = 0;
const run2 = (await v.runChains(task.id, chain.id, { trigger: YOU }))[0].runId;
await tick();
setBuild(11, "completed", "failed");
await tick();
await until(async () => (await pipes.getRun(run2)).status === "failed", "the second run failing");
await new Promise((r) => setTimeout(r, 100));
assert.equal(told.length, 0, "no report when the user turned it off");
await v.setChainOptions(task.id, chain.id, { notifyWorker: true });
assert.equal((await v.validationSummary(task.id)).attention, "failed");
await v.acknowledgeRun(task.id);
assert.equal((await v.validationSummary(task.id)).attention, null, "with no run named, every failure shown is seen");

// ---- 6. one chain, many runners: one at a time when it deploys, side by side otherwise, the rest queued ---------
{
    const c = await chainOf(task.id, chain.id);
    assert.deepEqual([c.concurrency, c.mode, c.deploys, c.maxActive, c.workersMayRunNow], ["auto", "one", "Deploy-Test", 1, false]);
}
await rejectsWith(
    v.setChainOptions(task.id, chain.id, { workersMayRun: true }),
    400,
    /^Workers always ask before running "Build and test": "Deploy-Test" reads like a deployment\.$/,
);
const youRun = (await v.runChains(task.id, chain.id, { trigger: YOU }))[0];
assert.equal(youRun.status, "started");
await tick();
const w1Queued = (await v.runChains(task.id, chain.id, { trigger: W1T }))[0];
assert.deepEqual(
    [w1Queued.status, w1Queued.position, w1Queued.waitingFor, w1Queued.message],
    ["queued", 1, "Waiting for your run to finish", '"Build and test" is queued: waiting for your run to finish.'],
);
assert.deepEqual(
    (await v.runChains(task.id, chain.id, { trigger: YOU })).map((o) => [o.status, o.runId, o.message]),
    [["already", youRun.runId, '"Build and test" is already running, from your earlier request.']],
    "asking again while it runs doesn't start another",
);
assert.deepEqual(
    (await v.runChains(task.id, chain.id, { trigger: W1T })).map((o) => [o.status, o.position, o.message]),
    [["already", 1, '"Build and test" is already waiting to run.']],
);
const leadQueued = (await v.runChains(task.id, chain.id, { trigger: LEAD }))[0];
assert.deepEqual([leadQueued.status, leadQueued.position, leadQueued.waitingFor], ["queued", 2, "Behind 1 earlier request"]);
{
    const c = await chainOf(task.id, chain.id);
    assert.deepEqual(c.queue.map((q) => [q.position, q.trigger.label, q.waitingFor]), [
        [1, "W1", "Waiting for your run to finish"],
        [2, "Devis", "Behind 1 earlier request"],
    ]);
    assert.equal((await v.validationSummary(task.id)).queued, 2);
}
await rejectsWith(
    v.pipelineRunOptions(chain.id),
    409,
    /^2 runs are waiting for this chain\. Run it from its task's Validation tab\.$/,
    "Pipelines can't jump the queue",
);
assert.deepEqual(await v.pipelineRunOptions(mine.id), {}, "the user's own chains run as before");
assert.equal(await v.cancelQueued(task.id, chain.id, leadQueued.queueId), true);
assert.equal(await v.cancelQueued(task.id, chain.id, leadQueued.queueId), false);
assert.ok((await taskEvents(task.id)).includes('The queued run of "Build and test" for Devis was canceled (Ship the cache)'));
assert.ok((await taskEvents(task.id)).includes('W1 queued "Build and test" (Ship the cache): waiting for your run to finish'));

// When the running one finishes, the next in line starts, labeled with who asked.
finishBuild(await buildOf(youRun.runId), "failed");
await tick();
await until(async () => (await chainOf(task.id, chain.id)).runs.some((r) => r.by === "W1" && r.status === "running"), "W1's queued run starting");
{
    const c = await chainOf(task.id, chain.id);
    assert.deepEqual(c.queue, []);
    const w1Run = c.runs.find((r) => r.by === "W1" && r.status === "running");
    assert.deepEqual(w1Run.trigger, W1T);
    assert.ok((await taskEvents(task.id)).includes('W1 started "Build and test" (Ship the cache)'));
    assert.equal(await v.stopRun(task.id, w1Run.runId), true);
    await settleCancels();
    await until(async () => (await pipes.getRun(w1Run.runId)).status !== "running", "W1's run stopping");
    assert.equal(await v.stopRun(task.id, w1Run.runId), false, "a finished run can't be stopped");
}
await rejectsWith(v.stopRun(task.id, "no-such-run"), 404, /^That run is gone\.$/);
{
    const mineRun = await pipes.startChainRun(mine.id);
    await rejectsWith(v.stopRun(task.id, mineRun.runId), 404, /^That run isn't one of this task's\.$/);
    await stopAndWait(mineRun.runId);
}
await v.acknowledgeRun(task.id);

// A chain that doesn't deploy runs side by side, up to its limit; workers may run it without asking when the user allows.
{
    const c = await chainOf(task.id, second.id);
    assert.deepEqual([c.mode, c.maxActive, c.deploys, c.workersMayRunNow], ["parallel", 3, null, false]);
}
await v.setChainOptions(task.id, second.id, { workersMayRun: true });
assert.equal((await chainOf(task.id, second.id)).workersMayRunNow, true);
outcomes = await v.runChains(task.id, [second.id, chain.id], { trigger: YOU });
assert.deepEqual(outcomes.map((o) => [o.name, o.status]), [["Smoke", "started"], ["Build and test", "started"]], "one request runs several chains");
const youSmoke = outcomes[0].runId;
const w1Smoke = (await v.runChains(task.id, second.id, { trigger: W1T }))[0];
const leadSmoke = (await v.runChains(task.id, second.id, { trigger: LEAD }))[0];
assert.deepEqual([w1Smoke.status, leadSmoke.status], ["started", "started"], "the same chain runs for several runners at once");
const w3Smoke = (await v.runChains(task.id, second.id, { trigger: W3T }))[0];
assert.deepEqual([w3Smoke.status, w3Smoke.position, w3Smoke.waitingFor], ["queued", 1, "Waiting for Devis' run to finish"], "past its limit, the next waits");
await tick();
{
    const ids = [youSmoke, w1Smoke.runId, leadSmoke.runId];
    const smokeBuilds = await Promise.all(ids.map((id) => buildOf(id)));
    assert.equal(new Set(smokeBuilds).size, 3, "each run queues its own build");
    const c = await chainOf(task.id, second.id);
    assert.deepEqual(c.runs.filter((r) => r.status === "running").map((r) => r.by), ["Devis", "W1", "You"], "every run says who started it");
    assert.equal((await v.validationView(task.id)).running, 4);
}
finishBuild(await buildOf(youSmoke), "succeeded");
await tick();
await until(async () => (await chainOf(task.id, second.id)).runs.some((r) => r.by === "W3" && r.status === "running"), "W3's queued run starting");
told.length = 0;
finishBuild(await buildOf(w1Smoke.runId), "failed");
await tick();
await until(async () => told.some((t) => /"Smoke"/.test(t.text)), "W1 hearing its run failed");
{
    const notice = told.find((t) => /"Smoke"/.test(t.text));
    assert.equal(notice.sessionId, "w1-session", "a worker's failed run reports to that worker");
    assert.match(notice.text, /^Validation chain "Smoke" \(chainId [^)]+\) failed, run by W1: failed at AppConfig-CI \(build B\d+\)\./);
    assert.match(notice.text, /You can run it again \(task_validation action run\) once you've fixed it\.$/, "a chain it may run without asking");
}
summary = await v.validationSummary(task.id);
assert.deepEqual(summary.failures.map((f) => [f.chain, f.by]), [["Smoke", "W1"]]);
// W1 runs it again and it passes: its own failure is no longer the news. Others' runs aren't touched.
const w1Again = (await v.runChains(task.id, second.id, { trigger: W1T }))[0];
assert.equal(w1Again.status, "started");
await tick();
finishBuild(await buildOf(w1Again.runId), "succeeded");
await tick();
await until(async () => (await pipes.getRun(w1Again.runId)).status === "succeeded", "W1's rerun passing");
summary = await v.validationSummary(task.id);
assert.deepEqual(summary.chains.find((c) => c.chainId === second.id).failures, []);
assert.equal(summary.attention, null);
assert.deepEqual([summary.lastUsed.by, summary.lastUsed.kind, summary.lastUsed.chain], ["W1", "worker", "Smoke"]);
{
    const c = await chainOf(task.id, second.id);
    assert.deepEqual(c.latest.map((l) => [l.label, l.status]), [["W1", "succeeded"], ["W3", "running"], ["Devis", "running"], ["You", "succeeded"]], "each runner's newest run");
    assert.deepEqual([c.summary.lastUsed.by, c.summary.running], ["W1", 2]);
}
await stopAll(task.id);
await v.acknowledgeRun(task.id);
assert.equal((await v.validationSummary(task.id)).attention, null);

// ---- 7. a chain that builds whoever runs it: each worker's own branch, or a PR's, side by side --------------------
const { task: shared } = await store.createTask({ title: "Share the chain" });
prBranches.set(21, "refs/heads/kjeong/pr21");
await store.upsertTaskPr(shared.id, "msazure", 21, "user", snapshot(21, { sourceRef: "kjeong/pr21", sourceCommit: "fff0001" }));
await store.insertWorker({ sessionId: "a-session", taskId: shared.id, label: "A", cwd: root, model: null, state: "idle", summary: "" });
await store.insertWorker({ sessionId: "b-session", taskId: shared.id, label: "B", cwd: root, model: null, state: "idle", summary: "" });
const aBranch = { org: "msazure", project: PROJECT, repo: "AppConfig", branch: "users/a/fix" };
workerBranchMap.set("a-session", [aBranch]);
await store.recordWorkerBranch({ taskId: shared.id, sessionId: "a-session", ...aBranch });
const AT = { kind: "worker", label: "A", sessionId: "a-session" };
const BT = { kind: "worker", label: "B", sessionId: "b-session" };
let perRunner = await v.attachChain(shared.id, { name: "Per runner", purpose: "Build the change of whoever runs it" });
perRunner = await pipes.saveChain({
    id: perRunner.id,
    name: perRunner.name,
    graph: { nodes: [{ id: "v1", org: "msazure", project: PROJECT, definitionId: 11, name: "AppConfig-CI", path: "\\CI", branch: "", followRunner: true, x: 0, y: 0 }], edges: [] },
    expectedUpdatedAt: perRunner.updatedAt,
});
{
    const c = await chainOf(shared.id, perRunner.id);
    assert.deepEqual([c.followsRunner, c.mode, c.maxActive, c.purpose], [true, "parallel", 3, "Build the change of whoever runs it"]);
    const targets = (await v.validationView(shared.id)).targets.map((t) => [t.id, t.label, t.detail, t.ready]).sort();
    assert.deepEqual(
        targets,
        [
            ["pr:msazure/21", "PR 21", "PR 21 (AppConfig, kjeong/pr21)", true],
            ["worker:a-session", "A", "AppConfig@users/a/fix", true],
            ["worker:b-session", "B", "No branch seen yet", false],
        ],
        "whose code a run can build: each worker's checked-out branch, or a PR",
    );
}
await rejectsWith(
    v.runChains(shared.id, perRunner.id, { trigger: YOU }),
    409,
    /^"Per runner" builds the branch of whoever runs it\. Pick whose code to build: a worker or a PR\.$/,
    "it has to know whose code to build",
);
const forB = await v.resolveTarget(shared.id, "worker:b-session");
await rejectsWith(
    v.runChains(shared.id, perRunner.id, { trigger: BT, target: forB }),
    409,
    /^B has no branch checked out that the app can see, so "Per runner" has nothing to build\. Pick a PR instead\.$/,
);
await rejectsWith(v.resolveTarget(shared.id, "worker:nobody"), 404, /^That worker isn't on this task anymore\.$/);
await rejectsWith(v.resolveTarget(shared.id, "pr:msazure/99"), 404, /^PR 99 isn't linked to this task\.$/);
await rejectsWith(v.resolveTarget(shared.id, "main"), 400, /^Pick whose code the run builds: a worker or a PR\.$/);
assert.equal(await v.resolveTarget(shared.id, ""), null);
await rejectsWith(
    v.pipelineRunOptions(perRunner.id),
    409,
    /^This chain builds the branch of whoever runs it\. Run it from its task's Validation tab, which asks whose code to build\.$/,
);
await rejectsWith(
    pipes.startChainRun(perRunner.id),
    409,
    /^"AppConfig-CI" builds the branch of whoever runs the chain\. Run it from its task's Validation tab\.$/,
    "nothing starts it without a runner",
);
const forA = await v.resolveTarget(shared.id, "worker:a-session");
assert.deepEqual(forA, { label: "A", sessionId: "a-session", branches: [aBranch] });
const forPr = await v.resolveTarget(shared.id, "pr:msazure/21");
assert.deepEqual(forPr, { label: "PR 21", branches: [], pr: { org: "msazure", prId: 21, repo: "AppConfig" } });

const aRun = (await v.runChains(shared.id, perRunner.id, { trigger: AT, target: forA }))[0];
const prRun = (await v.runChains(shared.id, perRunner.id, { trigger: YOU, target: forPr }))[0];
const leadForA = (await v.runChains(shared.id, perRunner.id, { trigger: LEAD, target: forA }))[0];
assert.deepEqual(
    [aRun.message, prRun.message, leadForA.message],
    ['"Per runner" started for A.', '"Per runner" started for PR 21.', '"Per runner" started for A.'],
    "the same chain runs for several runners, and for the same code by different people",
);
assert.deepEqual(
    (await v.runChains(shared.id, perRunner.id, { trigger: YOU, target: forPr })).map((o) => [o.status, o.runId, o.message]),
    [["already", prRun.runId, '"Per runner" is already running for PR 21, from your earlier request.']],
);
await tick();
{
    const stateOf = async (runId) => (await pipes.getRun(runId)).states.v1;
    const [sa, spr, slead] = [await stateOf(aRun.runId), await stateOf(prRun.runId), await stateOf(leadForA.runId)];
    assert.deepEqual([sa.branch, sa.followed], ["refs/heads/users/a/fix", runnerKey(forA)], "A's run builds A's checked-out branch");
    assert.deepEqual([spr.branch, spr.followed], ["refs/heads/kjeong/pr21", "runner:pr:msazure/21"], "a run for a PR builds the PR's branch");
    assert.equal(slead.branch, "refs/heads/users/a/fix", "the Lead's run of A's code builds A's branch");
    assert.equal(new Set([sa.buildId, spr.buildId, slead.buildId]).size, 3, "each run queues its own build");
    const c = await chainOf(shared.id, perRunner.id);
    assert.deepEqual(
        c.runs.map((r) => [r.by, r.for]).sort(),
        [["A", "A"], ["Devis", "A"], ["You", "PR 21"]],
        "each run says who ran it and whose code it built",
    );
    assert.deepEqual(c.latest.map((l) => [l.label, l.kind]).sort(), [["A", "worker"], ["PR 21", "pr"]], "the latest run per runner is keyed by whose code it built");
    assert.match(await agent.validationStatusText(shared.id, "a-session"), /Running: run \S+ by A \(yours\) for A, /);

    told.length = 0;
    finishBuild(sa.buildId, "failed");
    finishBuild(slead.buildId, "failed");
    finishBuild(spr.buildId, "succeeded");
    await tick();
    await until(async () => told.length >= 2, "A hearing about both failed runs of its code");
    assert.deepEqual(told.map((t) => t.sessionId), ["a-session", "a-session"], "a failure goes to whoever ran it, else to whose code it built");
    assert.ok(told.some((t) => /^Validation chain "Per runner" \(chainId [^)]+\) failed for A, run by A: failed at AppConfig-CI \(build B\d+\)\./.test(t.text)));
    assert.ok(told.some((t) => /^Validation chain "Per runner" \(chainId [^)]+\) failed for A, run by Devis: /.test(t.text)));
    assert.ok(told.every((t) => /Running it again \(task_validation action run\) asks the user first\.$/.test(t.text)));
}
summary = await v.validationSummary(shared.id);
assert.deepEqual(summary.failures.map((f) => [f.for, f.by]), [["A", "Devis"]], "A's code is failing as of its newest run; PR 21 passed");
assert.equal(summary.attention, "failed");
await v.acknowledgeRun(shared.id);
assert.equal((await v.validationSummary(shared.id)).attention, null);

// ---- 8. a done task runs nothing, and drops what waits; a block's repository branches -------------------------
{
    const holding = (await v.runChains(task.id, chain.id, { trigger: YOU }))[0];
    const waiting = (await v.runChains(task.id, chain.id, { trigger: W1T }))[0];
    assert.deepEqual([holding.status, waiting.status], ["started", "queued"]);
    await store.updateTask(task.id, { status: "done" });
    await rejectsWith(v.runChains(task.id, chain.id, { trigger: YOU }), 409, /^The task is done\. Reopen it to run its validation\.$/);
    await assert.rejects(pipes.startChainRun(second.id), /The task is done\. Reopen it to run its validation\./, "Pipelines can't run it either");
    await rejectsWith(
        agent.propose(task.id, { chainId: second.id, summary: "s", blocks: [{ pipeline: ref(11), reason: "r" }] }, "W1", null),
        409,
        /^The task is done; reopen it to propose validation\.$/,
    );
    await rejectsWith(v.setBlockRepoBranches(task.id, chain.id, "v2", null), 409, /^The task is done\. Reopen it to change its validation\.$/);
    await stopAndWait(holding.runId);
    await until(async () => (await chainOf(task.id, chain.id)).queue.length === 0, "the done task's queue being dropped");
    assert.equal((await chainOf(task.id, chain.id)).runs.filter((r) => r.status === "running").length, 0, "what waited didn't start");
    assert.match(await agent.validationStatusText(task.id), /The task is done, so its validation can't run until it's reopened\.$/);
    await store.updateTask(task.id, { status: "open" });
    await v.acknowledgeRun(task.id);
}
{
    const v2Of = (c) => c.graph.nodes.find((n) => n.id === "v2");
    const lastEvent = async () => (await store.listEvents({ taskId: task.id, limit: 1 }))[0].text;
    previewCalls.length = 0;
    repoLookups.length = 0;

    let set = await v.setBlockRepoBranches(task.id, chain.id, "v2", { TEMPLATES: "release/1" }, "");
    assert.deepEqual(set.warnings, []);
    assert.deepEqual(v2Of(set.chain).repoBranches, { templates: "release/1" }, "kept as typed, under the YAML's alias spelling");
    assert.deepEqual(v2Of(await pipes.getChain(chain.id)).repoBranches, { templates: "release/1" }, "saved");
    assert.deepEqual(v2Of(set.chain).params, { env: "test" }, "the rest of the block is kept");
    assert.deepEqual(
        previewCalls.map((c) => [c.definitionId, c.branch, c.params, c.repos]),
        [
            [12, "", { env: "test" }, { TEMPLATES: "release/1" }],
            [12, "", { env: "test" }, { templates: "refs/heads/release/1" }],
        ],
        "compiled on the block's branch with its parameters, then again under the YAML's spelling",
    );
    assert.deepEqual(repoLookups, [["OneBranch.Pipelines", "GovernedTemplates", "release/1"]], "looked up in the repository's own project");
    assert.equal(await lastEvent(), 'A repository branch set on Deploy-Test in "Build and test" for Ship the cache');

    // What the user opened must still be what's there.
    const opened = repoSignature(v2Of(set.chain).repoBranches);
    await rejectsWith(v.setBlockRepoBranches(task.id, chain.id, "v2", { templates: "flaky" }, ""), 409, /changed since you opened them/, "a stale edit");
    await rejectsWith(v.setBlockRepoBranches(task.id, chain.id, "gone", { templates: "release/1" }), 404, /^That block isn't in the chain anymore\.$/);
    await rejectsWith(v.setBlockRepoBranches(task.id, "no-such-chain", "v2", { templates: "release/1" }), 404, /^That validation chain isn't on this task anymore\.$/);

    // Nothing is saved when a branch can't be used.
    previewCalls.length = 0;
    repoLookups.length = 0;
    await rejectsWith(v.setBlockRepoBranches(task.id, chain.id, "v2", { self: "release/1" }, opened), 400, /own repository builds the block's Branch/);
    await rejectsWith(v.setBlockRepoBranches(task.id, chain.id, "v2", ["release/1"], opened), 400, /must be alias\/branch pairs/);
    assert.equal(previewCalls.length, 0, "bad input isn't sent to Azure DevOps");
    await rejectsWith(
        v.setBlockRepoBranches(task.id, chain.id, "v2", { templates: "users/me/gone" }, opened),
        400,
        /^Branch users\/me\/gone doesn't exist in GovernedTemplates \(repository resource templates\)\.$/,
    );
    await rejectsWith(
        v.setBlockRepoBranches(task.id, chain.id, "v2", { templates: "broken" }, opened),
        400,
        /^Azure DevOps can't compile the pipeline with these branches: Could not find template build\.yml@templates$/,
    );
    await rejectsWith(
        v.setBlockRepoBranches(task.id, chain.id, "v2", { gone: "release/1" }, opened),
        400,
        /^Repository "gone" is no longer a resource of this pipeline\. Its repository resources: templates\.$/,
    );
    assert.deepEqual(repoLookups.map((l) => l[2]), ["users/me/gone"], "a branch is only looked up once the pipeline compiles with it");
    assert.deepEqual(v2Of(await pipes.getChain(chain.id)).repoBranches, { templates: "release/1" }, "nothing was saved");

    // A lookup that fails is a warning: the branches are saved, and the run checks them.
    set = await v.setBlockRepoBranches(task.id, chain.id, "v2", { templates: "flaky" }, opened);
    assert.equal(set.warnings.length, 1);
    assert.match(set.warnings[0], /^Couldn't check that branch flaky exists in GovernedTemplates: /);
    assert.deepEqual(v2Of(set.chain).repoBranches, { templates: "flaky" });

    // A block that follows a PR is compiled on the PR's branch; while that isn't known, nothing is checked.
    previewCalls.length = 0;
    set = await v.setBlockRepoBranches(task.id, chain.id, "v1", { templates: "release/1" }, "");
    assert.deepEqual(set.warnings, []);
    assert.deepEqual(previewCalls.map((c) => [c.definitionId, c.branch]), [[11, "refs/heads/kjeong/feature"]]);
    await store.updateTaskPr(task.id, "msazure", 7, { snapshot: snapshot(7, { sourceRef: "" }) });
    previewCalls.length = 0;
    set = await v.setBlockRepoBranches(task.id, chain.id, "v1", { templates: "users/me/gone" }, repoSignature({ templates: "release/1" }));
    assert.deepEqual(set.warnings, ["The branch of PR 7 isn't known yet, so these weren't checked. The run checks them."]);
    assert.equal(previewCalls.length, 0);
    assert.deepEqual(set.chain.graph.nodes.find((n) => n.id === "v1").repoBranches, { templates: "users/me/gone" });
    await store.updateTaskPr(task.id, "msazure", 7, { snapshot: snapshot(7) });

    // A block that builds its runner's branch can't be compiled ahead: each run checks.
    set = await v.setBlockRepoBranches(shared.id, perRunner.id, "v1", { templates: "release/1" }, "");
    assert.deepEqual(set.warnings, ["AppConfig-CI builds the branch of whoever runs the chain, so these weren't checked. Each run checks them."]);
    assert.equal(previewCalls.length, 0);
    await v.setBlockRepoBranches(shared.id, perRunner.id, "v1", null);

    // Clearing needs no check.
    set = await v.setBlockRepoBranches(task.id, chain.id, "v1", null);
    assert.equal(set.chain.graph.nodes.find((n) => n.id === "v1").repoBranches, undefined);
    set = await v.setBlockRepoBranches(task.id, chain.id, "v2", { templates: "  " }, repoSignature({ templates: "flaky" }));
    assert.equal(v2Of(set.chain).repoBranches, undefined, "a blank branch clears it");
    assert.equal(previewCalls.length, 0);
    assert.equal(await lastEvent(), 'Repository branches cleared on Deploy-Test in "Build and test" for Ship the cache');
}

// A block that follows a PR the app can't read errors with why, instead of building some other branch.
{
    const lost = await pipes.saveChain({
        name: "Lost PR",
        graph: { nodes: [{ id: "x", org: "msazure", project: PROJECT, definitionId: 11, name: "AppConfig-CI", path: "\\", branch: "", branchFrom: { org: "msazure", prId: 404 }, x: 0, y: 0 }], edges: [] },
    });
    const queuedBefore = queued.length;
    await pipes.startChainRun(lost.id);
    await tick();
    const lostRun = await pipes.latestRun(lost.id);
    assert.equal(lostRun.status, "failed");
    assert.equal(lostRun.states.x.status, "error");
    assert.match(lostRun.states.x.error, /^Couldn't read the branch of PR 404: /);
    assert.equal(queued.length, queuedBefore, "nothing was queued");
    await pipes.deleteChain(lost.id);
}

// ---- 9. a busy worker hears it when its turn ends; nothing is lost on the way --------------------------------
const pending = async (taskId) => {
    const row = (await store.jarvisDb()).prepare("SELECT pending_notice FROM jarvis_task_validation WHERE task_id = ?").get(taskId);
    return row?.pending_notice ? JSON.parse(row.pending_notice) : [];
};
busy.add("w1-session");
told.length = 0;
assert.equal(await v.deliverNotice(task.id, "first"), "W1 is busy; it hears this when its turn ends.");
assert.equal(await v.deliverNotice(task.id, "for W1", "w1-session"), "W1 is busy; it hears this when its turn ends.");
assert.deepEqual(await pending(task.id), [{ to: null, text: "first" }, { to: "w1-session", text: "for W1" }], "a notice meant for a worker stays its");
await v.validationTick();
assert.equal(told.length, 0, "still busy");
busy.delete("w1-session");
onMessage = async () => {
    onMessage = null;
    busy.add("w1-session");
    await v.deliverNotice(task.id, "second");
};
await v.validationTick();
assert.deepEqual(told.map((t) => t.text), ["first\n\nfor W1"], "what waited goes in one message");
assert.deepEqual(await pending(task.id), [{ to: null, text: "second" }], "a notice that came in while sending is kept");
busy.delete("w1-session");
await v.validationTick();
assert.deepEqual(told.map((t) => t.text), ["first\n\nfor W1", "second"]);
assert.deepEqual(await pending(task.id), []);

// A task that's done takes no notices: none are parked to fire when it's reopened.
busy.add("w1-session");
await v.deliverNotice(task.id, "parked");
assert.equal((await pending(task.id)).length, 1);
await store.updateTask(task.id, { status: "done" });
await v.validationTick();
assert.deepEqual(await pending(task.id), [], "marking it done drops what was parked");
assert.equal(await v.deliverNotice(task.id, "late"), "The task isn't open, so its workers weren't told.");
assert.deepEqual(await pending(task.id), []);
busy.delete("w1-session");
await store.updateTask(task.id, { status: "open" });
await v.validationTick();
assert.deepEqual(told.map((t) => t.text), ["first\n\nfor W1", "second"], "reopening it doesn't replay old notices");

// ---- 10. automatic proposals: asked once, only with a PR and a worker, never with a chain ----------------------
const { task: other } = await store.createTask({ title: "Second task" });
await store.insertWorker({ sessionId: "w2-session", taskId: other.id, label: "W2", cwd: root, model: null, state: "idle", summary: "" });
told.length = 0;
await v.validationTick();
assert.equal(told.length, 0, "off by default");
await v.setAutoPropose(true);
assert.equal(await v.autoProposeOn(), true);
assert.equal((await v.validationView(other.id)).autoPropose, true);
await v.validationTick();
assert.equal(told.length, 0, "no PR yet");
prBranches.set(8, "refs/heads/kjeong/pr8");
await store.upsertTaskPr(other.id, "msazure", 8, "worker", snapshot(8, { sourceRef: "kjeong/pr8" }));
await v.validationTick();
assert.equal(told.length, 1);
assert.equal(told[0].sessionId, "w2-session");
assert.match(told[0].text, /^A pull request is linked to this task\. Find the pipelines that validate this task's change and propose a validation chain\./);
assert.match(told[0].text, /a purpose that says when to use the chain/, "the ask says a chain needs a purpose");
await v.validationTick();
assert.equal(told.length, 1, "asked once");
assert.equal(told.some((t) => t.sessionId !== "w2-session"), false, "tasks with chains aren't asked");
await v.setAutoPropose(false);

// ---- 11. run again on a new commit, when the user allows it: once per runner -----------------------------------
const jdb = await store.jarvisDb();
const commitsOf = (chainId) => {
    const row = jdb.prepare("SELECT commits_json FROM jarvis_validation_chains WHERE chain_id = ?").get(chainId);
    return row?.commits_json ? JSON.parse(row.commits_json) : {};
};
{
    const before = (await pipes.latestRun(chain.id)).runId;
    await v.setChainOptions(task.id, chain.id, { rerunOnCommit: true });
    assert.deepEqual(commitsOf(chain.id), { "msazure/7": "aaa1111" }, "turning it on watches from the current commit");
    await v.validationTick();
    assert.equal((await pipes.latestRun(chain.id)).runId, before, "no run for the commit it already saw");

    // A PR the chain starts following later is watched from its current commit, not run for it.
    await store.upsertTaskPr(task.id, "msazure", 9, "user", snapshot(9, { sourceCommit: "ddd4444" }));
    const current = await pipes.getChain(chain.id);
    const following9 = { ...current.graph, nodes: current.graph.nodes.map((n) => (n.id === "v2" ? { ...n, branchFrom: { org: "msazure", prId: 9 } } : n)) };
    await pipes.saveChain({ id: chain.id, name: chain.name, graph: following9 });
    await v.validationTick();
    assert.equal((await pipes.latestRun(chain.id)).runId, before, "no run for a newly followed PR's current commit");
    assert.deepEqual(commitsOf(chain.id), { "msazure/7": "aaa1111", "msazure/9": "ddd4444" });
    await pipes.saveChain({ id: chain.id, name: chain.name, graph: current.graph });

    await store.updateTaskPr(task.id, "msazure", 7, { snapshot: snapshot(7, { sourceCommit: "bbb2222" }) });
    await v.validationTick();
    const rerun = await pipes.latestRun(chain.id);
    assert.notEqual(rerun.runId, before, "a new commit starts a run");
    assert.equal(rerun.status, "running");
    assert.deepEqual([rerun.trigger.kind, rerun.trigger.label], ["auto", "Auto-rerun"], "the run says it was the automatic rerun");
    assert.ok((await taskEvents(task.id)).includes('"Build and test" asked to run for new commit bbb2222 (Ship the cache)'));
    await store.updateTaskPr(task.id, "msazure", 7, { snapshot: snapshot(7, { sourceCommit: "ccc3333" }) });
    await v.validationTick();
    assert.equal((await pipes.latestRun(chain.id)).runId, rerun.runId, "a run in progress isn't restarted…");
    assert.equal(commitsOf(chain.id)["msazure/7"], "bbb2222", "…and the newer commit waits for it");

    // A run started any other way builds the current commit too: no second run for it afterwards.
    await stopAndWait(rerun.runId);
    const manual = (await v.runChains(task.id, chain.id, { trigger: YOU }))[0];
    assert.equal(manual.status, "started");
    await until(async () => commitsOf(chain.id)["msazure/7"] === "ccc3333", "the manual run's commit being recorded");
    await stopAndWait(manual.runId);
    await v.validationTick();
    assert.equal((await pipes.latestRun(chain.id)).runId, manual.runId, "no rerun for the commit the manual run built");
}
{
    // A chain that builds its runner's code watches each runner's PR: a worker's branch maps to
    // the PR it's the source of. A new commit reruns for that runner only.
    prBranches.set(22, "refs/heads/users/a/fix");
    await store.upsertTaskPr(shared.id, "msazure", 22, "user", snapshot(22, { sourceRef: "users/a/fix", sourceCommit: "abc0001" }));
    await v.setChainOptions(shared.id, perRunner.id, { rerunOnCommit: true });
    const aKey = `msazure/22#${runnerKey(forA)}`;
    assert.deepEqual(commitsOf(perRunner.id), { "msazure/21#runner:pr:msazure/21": "fff0001", [aKey]: "abc0001" }, "one watch per runner, on the PR its code is in");
    await v.validationTick();
    assert.equal((await chainOf(shared.id, perRunner.id)).runs.filter((r) => r.status === "running").length, 0);

    await store.updateTaskPr(shared.id, "msazure", 22, { snapshot: snapshot(22, { sourceRef: "users/a/fix", sourceCommit: "abc0002" }) });
    await v.validationTick();
    let going = (await chainOf(shared.id, perRunner.id)).runs.filter((r) => r.status === "running");
    assert.deepEqual(going.map((r) => [r.by, r.for]), [["Auto-rerun", "A"]], "A's new commit reruns A's code, not PR 21's");
    assert.equal((await pipes.getRun(going[0].runId)).states.v1?.branch ?? "refs/heads/users/a/fix", "refs/heads/users/a/fix");
    assert.ok((await taskEvents(shared.id)).includes('"Per runner" asked to run for A for new commit abc0002 (Share the chain)'));
    await stopAll(shared.id);

    await store.updateTaskPr(shared.id, "msazure", 21, { snapshot: snapshot(21, { sourceRef: "kjeong/pr21", sourceCommit: "fff0002" }) });
    await v.validationTick();
    going = (await chainOf(shared.id, perRunner.id)).runs.filter((r) => r.status === "running");
    assert.deepEqual(going.map((r) => [r.by, r.for]), [["Auto-rerun", "PR 21"]]);
    assert.ok((await taskEvents(shared.id)).includes('"Per runner" asked to run for PR 21 for new commit fff0002 (Share the chain)'));
    await stopAll(shared.id);
    await v.validationTick();
    assert.equal((await chainOf(shared.id, perRunner.id)).runs.filter((r) => r.status === "running").length, 0, "each commit runs once");
    await v.setChainOptions(shared.id, perRunner.id, { rerunOnCommit: false });
}
// A run for the task's removal below.
const going = (await v.runChains(task.id, chain.id, { trigger: YOU }))[0];
assert.equal(going.status, "started");

// ---- 12. a reusable copy drops the task's branches; removing the task stops its runs, then its chains go ----
const reusable = await v.saveAsReusable(task.id, chain.id);
assert.equal(reusable.ownerTaskId, null);
assert.equal(reusable.name, "Build and test (copy)");
assert.deepEqual(reusable.graph.nodes.map((n) => [n.branch, n.branchFrom]), [["", undefined], ["", undefined]]);
assert.deepEqual(reusable.graph.nodes[1].params, { env: "test" });
{
    const copied = await v.saveAsReusable(shared.id, perRunner.id);
    assert.deepEqual([copied.name, copied.graph.nodes[0].followRunner, copied.graph.nodes[0].branch], ["Per runner (copy)", undefined, ""], "a copy builds the default branch, not a runner's");
    const named = await v.attachChain(other.id);
    const named2 = await v.saveAsReusable(other.id, named.id);
    assert.equal(named2.name, "Second task validation", "a task-named chain is saved under the task's name");
    await v.removeChain(other.id, named.id);
    await pipes.deleteChain(copied.id);
    await pipes.deleteChain(named2.id);
    await rejectsWith(v.saveAsReusable(task.id, "no-such-chain"), 404, /isn't on this task anymore/);
}

const record = await v.retireValidation(task.id);
assert.deepEqual(record.chains.map((c) => c.chain), ["Smoke", "Build and test"], "a record of every chain");
{
    const bt = record.chains.find((c) => c.chain === "Build and test");
    assert.equal(bt.purpose, "Before merging: builds the PR, then deploys it to Test.");
    assert.deepEqual(bt.pipelines.map((p) => p.definitionId), [11, 12]);
    assert.deepEqual([bt.lastRun.status, bt.lastRun.by], ["running", "You"]);
}
assert.ok(await pipes.getChain(chain.id), "a running chain stays until its run stops");
assert.equal(await pipes.getChain(second.id), null, "an idle chain goes at once");
assert.equal((await pipes.getRun(going.runId)).cancelRequested, true);
await store.deleteTask(task.id, { validation: record });
{
    const json = JSON.parse(readFileSync(join(process.env.ADO_PR_OPS_JARVIS_DIR, "tasks", task.id, "task.json"), "utf8"));
    assert.deepEqual(json.validation.chains.map((c) => c.chain), ["Smoke", "Build and test"], "task.json says what its validation was");
}
assert.deepEqual((await pipes.orphanedTaskChains()).map((c) => c.id), [chain.id]);
assert.equal((await pipes.listChains()).find((c) => c.id === chain.id).owner.status, "removed");
await assert.rejects(pipes.startChainRun(chain.id), /task was removed/, "an orphan can't start again");
await settleCancels();
await until(async () => (await pipes.getRun(going.runId)).status !== "running", "the orphan's run stopping");
await v.validationTick();
assert.equal(await pipes.getChain(chain.id), null, "the sweep deletes it");
assert.ok(await pipes.getChain(reusable.id), "the reusable copy is the user's");
assert.equal(jdb.prepare("SELECT COUNT(*) AS n FROM jarvis_validation_chains WHERE task_id = ?").get(task.id).n, 0, "its records are gone");
assert.equal(await v.retireValidation(other.id), null, "nothing to retire");

// ---- 13. the tools: a worker's, on its own task; the Lead's, on any ---------------------------------------
const workerTool = agent.taskValidationTool();
const call = (args, sessionId = "w2-session") => workerTool.handler(args, { sessionId });
assert.equal(await call({ action: "status" }), "No validation chains yet.");
assert.equal(await call({ action: "run" }), "This task has no validation chains yet. Propose one first.");
assert.equal(await call({ action: "runs" }), "This task has no validation chains yet. Propose one first.");
assert.match(await call({ action: "candidates" }), /"pipeline": "msazure\/Azure AppConfig\/11"/);
assert.match(
    await call({ action: "propose", summary: "s", blocks: [{ pipeline: ref(11), followPr: 8, reason: "CI" }] }),
    /^Proposed\. A new chain: AppConfig-CI\. It waits for the user .+; nothing changes or runs until they accept\./,
);
assert.match(await call({ action: "status" }), /^No validation chains yet\.\n\nProposal by W2 waits for the user: new chain "[^"]+": AppConfig-CI\.$/);
assert.match(await call({ action: "propose", blocks: [] }), /^Not proposed/);
assert.equal(await call({ action: "nope" }), "Use action status, candidates, propose, run or runs.");
assert.equal(await call({ action: "status" }, "nobody"), "This session is not one of the Workspace's workers.");

// A worker runs a chain it may run unasked: its own code by default, or a PR's.
await v.setChainOptions(shared.id, perRunner.id, { workersMayRun: true });
assert.match(
    await call({ action: "run" }, "a-session"),
    /^- "Per runner" started for A\. \(run \S+\)\nIf a run fails, you'll get the failed builds and steps\.$/,
    "a worker's run builds its own code by default",
);
assert.equal(await call({ action: "run" }, "b-session"), 'B has no branch checked out that the app can see, so "Per runner" has nothing to build. Pick a PR instead.');
assert.match(await call({ action: "run", target: "21" }, "b-session"), /^- "Per runner" started for PR 21\. \(run \S+\)/);
{
    const forA2 = await call({ action: "status" }, "a-session");
    assert.match(forA2, /^1 validation chain, shared by the task's workers\. 2 runs going on the task \(limit 6\)\./);
    assert.match(forA2, /\n {2}up to 3 runs at once; workers may run it without asking; builds the code of whoever runs it: a run needs a target\.\n/);
    assert.match(forA2, /\n {2}Running: run \S+ by A \(yours\) for A, /);
    assert.match(forA2, /\n {2}Running: run \S+ by B for PR 21, /, "another worker's run isn't marked as yours");
    assert.match(await call({ action: "runs" }, "b-session"), /\n- run \S+ by B \(yours\) for PR 21, /);
}
await stopAll(shared.id);

const leadTool = agent.leadValidationTool();
const lead = (args) => leadTool.handler(args, { sessionId: "lead" });
assert.equal(await lead({ taskId: "nope", action: "status" }), "Failed: Unknown taskId. Read it from jarvis_today.");
assert.match(await lead({ taskId: other.id, action: "status" }), /Proposal by W2 waits for the user/);
assert.equal(await lead({ taskId: shared.id, action: "run" }), "These chains build the code of whoever runs them: pass target, a worker's name or a linked PR's number.");
assert.equal(await lead({ taskId: shared.id, action: "run", target: "99" }), "PR 99 isn't linked to this task.");
assert.match(await lead({ taskId: shared.id, action: "run", target: "Z" }), /^No worker "Z" on this task\. Its workers: /);
assert.match(await lead({ taskId: shared.id, action: "run", target: "a" }), /^- "Per runner" started for A\. \(run \S+\)$/, "the Lead names whose code to build");
assert.match(await lead({ taskId: shared.id, action: "runs" }), /^Runs of "Per runner", newest first:\n- run \S+ by Devis for A, /);
{
    const extra = await v.attachChain(shared.id);
    assert.equal(await lead({ taskId: shared.id, action: "run" }), `Say which chain: ${perRunner.id} ("Per runner"), ${extra.id} ("${extra.name}").`);
    assert.equal(await lead({ taskId: shared.id, action: "run", chainIds: ["nope"] }), "Chain nope isn't on this task. Use action status for the chains and their ids.");
    assert.equal(await lead({ taskId: shared.id, action: "runs", chainId: extra.id }), `"${extra.name}" hasn't run yet.`);
    await v.removeChain(shared.id, extra.id);
}
assert.equal(await lead({ taskId: shared.id, action: "nope" }), "Use action status, candidates, propose, run or runs.");
await stopAll(shared.id);

// ---- done ---------------------------------------------------------------------------------------------------
assert.ok(sessionCalls.length >= 1 && sessionCalls.every((c) => c === "resume w1-session"), "only the done task's recaps tried a session, and got none");

// A save made on an older version of a chain is refused: it was changed elsewhere (say, a task accepted a proposal into it).
const versioned = await pipes.saveChain({ name: "Versioned", graph: { nodes: [], edges: [] } });
const resaved = await pipes.saveChain({ id: versioned.id, name: "Versioned 2", graph: { nodes: [], edges: [] }, expectedUpdatedAt: versioned.updatedAt });
assert.equal(resaved.name, "Versioned 2");
await assert.rejects(
    pipes.saveChain({ id: versioned.id, name: "Stale", graph: { nodes: [], edges: [] }, expectedUpdatedAt: "2000-01-01T00:00:00.000Z" }),
    /changed elsewhere since it was opened/,
);
assert.equal((await pipes.getChain(versioned.id)).name, "Versioned 2");

// A task used to keep its one chain and one proposal on its task row, and the lead was called
// Jarvis: when the schema opens again, they move to their own rows, by the lead's name now.
{
    const renamed = (await store.createTask({ title: "Rename proposal" })).task;
    const old = await pipes.saveChain({ name: "Old chain", ownerTaskId: renamed.id, graph: { nodes: [], edges: [] } });
    jdb.prepare("DELETE FROM jarvis_validation_chains WHERE chain_id = ?").run(old.id);
    const at = new Date().toISOString();
    jdb.prepare(
        `INSERT INTO jarvis_task_validation (task_id, chain_id, proposal_json, evidence_json, accepted_at, accepted_by, rerun_on_commit, acked_run_id, commits_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(
        renamed.id,
        old.id,
        JSON.stringify({ id: "p-old", by: "Jarvis", at, blocks: [] }),
        JSON.stringify({ k: { reason: "r", evidence: [], by: "Jarvis" } }),
        at,
        "Jarvis",
        "run-old",
        JSON.stringify({ "msazure/7": "aaa1111" }),
        at,
    );
    v.resetValidationSchema();
    const s = await v.validationSummary(renamed.id);
    assert.deepEqual(s.chains.map((c) => c.chainId), [old.id], "the task's chain moved to its own row");
    assert.deepEqual(s.proposals.map((p) => [p.id, p.by, p.chainId]), [["p-old", "Devis", old.id]], "its proposal too, by the lead's name now");
    const c = await chainOf(renamed.id, old.id);
    assert.deepEqual([c.acceptedBy, c.evidence.k.by], ["Devis", "Devis"]);
    const meta = jdb.prepare("SELECT rerun_on_commit, acked_json, commits_json FROM jarvis_validation_chains WHERE chain_id = ?").get(old.id);
    assert.deepEqual([meta.rerun_on_commit, JSON.parse(meta.acked_json), JSON.parse(meta.commits_json)], [1, ["run-old"], { "msazure/7": "aaa1111" }]);
    const row = jdb.prepare("SELECT chain_id, proposal_json, accepted_by, commits_json FROM jarvis_task_validation WHERE task_id = ?").get(renamed.id);
    assert.deepEqual([row.chain_id, row.proposal_json, row.accepted_by, row.commits_json], [null, null, null, null], "the task row keeps only notices and the auto-ask");
    v.resetValidationSchema();
    assert.equal((await v.validationSummary(renamed.id)).proposals.length, 1, "moving them again does nothing");
}
v.stopValidationRunner();
await runner.stopPipelineRunner();
closeDb();
rmSync(root, { recursive: true, force: true });
console.log("jarvis-validation harness: ok");
