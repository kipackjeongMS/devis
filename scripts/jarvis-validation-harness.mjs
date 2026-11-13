import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A task's validation chain end to end, against a temporary database, a fake Azure DevOps
// (runner and discovery) and fake workers. Nothing here talks to a real organization.

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
const { repoSignature } = await import("../pipeline-graph.mjs");
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
const setBuild = (definitionId, status, result) => {
    for (const b of builds.values()) if (b.definitionId === definitionId && b.status !== "completed") Object.assign(b, { status, result });
};
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
            return { yaml: definitionId !== 13, projectId: "proj-guid", defaultBranch: "refs/heads/main", name: `P${definitionId}`, path: "\\", projectName: project, queueStatus: "enabled", repository: null };
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

// ---- 1. no validation yet ----------------------------------------------------------------------
assert.equal(await v.validationSummary(task.id), null);
let snap = await today.todaySnapshot();
assert.equal(snap.tasks.find((t) => t.id === task.id).validation, null, "Today says no validation");
const mine = await pipes.saveChain({ name: "My release", graph: { nodes: [{ id: "a", org: "msazure", project: PROJECT, definitionId: 11, name: "AppConfig-CI", path: "\\", branch: "", x: 0, y: 0 }], edges: [] } });
let view = await v.validationView(task.id);
assert.equal(view.chain, null);
assert.deepEqual(view.templates.map((t) => t.id), [mine.id], "the user's own chains can be copied in");
assert.deepEqual(view.prs.map((p) => p.prId), [7]);
assert.equal(view.autoPropose, false, "automatic proposals are off by default");

// ---- 2. attach, copy, remove ----------------------------------------------------------------------
const empty = await v.attachChain(task.id);
assert.equal(empty.ownerTaskId, task.id);
assert.equal(empty.name, "Validation · Ship the cache");
await assert.rejects(v.attachChain(task.id), /already has a validation chain/);
let listed = (await pipes.listChains()).find((c) => c.id === empty.id);
assert.deepEqual(listed.owner, { taskId: task.id, title: "Ship the cache", status: "open" }, "Pipelines knows whose chain it is");
assert.equal((await pipes.listChains()).find((c) => c.id === mine.id).owner, null);
await assert.rejects(v.runValidation(task.id), /Add at least one pipeline/);
await v.removeValidation(task.id);
assert.equal(await pipes.getChain(empty.id), null, "removing deletes the chain");
assert.equal(await v.validationSummary(task.id), null);
const copy = await v.attachChain(task.id, mine.id);
assert.deepEqual(copy.graph.nodes.map((n) => n.definitionId), [11], "a copy of a saved chain");
assert.ok(await pipes.getChain(mine.id), "the original stays");
// A chain removed from the Pipelines tab is forgotten by the task too.
await pipes.deleteChain(copy.id);
assert.equal((await v.validationView(task.id)).chain, null);

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

// ---- 4. proposals: refused with every problem, then accepted ---------------------------------------------
const ref = (id) => `msazure/${PROJECT}/${id}`;
await assert.rejects(
    agent.propose(task.id, {
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
assert.equal((await v.validationRow(task.id)).proposal, null, "a refused proposal isn't stored");
await assert.rejects(
    agent.propose(task.id, { summary: "s", blocks: [{ pipeline: ref(11), reason: "a", after: [ref(12)] }, { pipeline: ref(12), reason: "b", after: [ref(11)] }] }, "W1", null),
    /cycle|loop/i,
    "cycles are refused",
);

const proposed = await agent.propose(
    task.id,
    {
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
assert.match(proposed, /^Proposed: AppConfig-CI → Deploy-Test\./);
let row = await v.validationRow(task.id);
const p = row.proposal;
assert.equal(p.by, "W1");
assert.deepEqual(p.blocks.map((b) => [b.definitionId, b.stage]), [[11, 0], [12, 1]]);
assert.deepEqual(p.blocks[0].branchFrom, { org: "msazure", prId: 7 });
assert.equal(p.blocks[0].branch, "");
assert.ok(p.blocks[0].evidence.some((e) => e.kind === "prCheck"), "evidence the app checked");
assert.ok(p.blocks[1].evidence.some((e) => e.kind === "consumes"));
assert.deepEqual(p.leftOut.map((l) => [l.name, l.evidence.map((e) => e.kind)]), [["Deploy-Prod", ["production"]]]);
assert.ok(p.checks.some((c) => c.text === "All 2 pipelines exist and are enabled"));
assert.ok(!p.checks.some((c) => c.text === "Every fixed branch exists"), "no fixed branch was checked, so it isn't claimed");
assert.ok(p.checks.some((c) => /PR 7/.test(c.text)));
let summary = await v.validationSummary(task.id);
assert.equal(summary.attention, "proposal", "a proposal waits for the user");
snap = await today.todaySnapshot();
assert.equal(snap.tasks.find((t) => t.id === task.id).validation.attention, "proposal", "Today shows it under Needs you");

// A fixed branch is checked, and only then claimed.
await agent.propose(task.id, { summary: "s", blocks: [{ pipeline: ref(11), branch: "release/1", reason: "r" }] }, "W1", null);
assert.ok((await v.validationRow(task.id)).proposal.checks.some((c) => c.text === "Every fixed branch exists"));
assert.ok(discoveryCalls.branch.includes("release/1"));

// Branches for a pipeline's repository resources: the alias must be one its YAML has, and the branch must exist there.
await assert.rejects(
    agent.propose(task.id, {
        summary: "s",
        blocks: [
            { pipeline: ref(12), repoBranches: { gone: "release/1" }, reason: "a" },
            { pipeline: ref(15), repoBranches: { templates: "release/1" }, reason: "classic" },
        ],
    }, "W1", null),
    (error) => {
        assert.match(error.message, /Deploy-Test: Repository "gone" is no longer a resource of this pipeline\. Its repository resources: templates\./);
        assert.match(error.message, /Classic-Release is a classic pipeline, which has no repository resources/);
        return true;
    },
);
await assert.rejects(
    agent.propose(task.id, { summary: "s", blocks: [{ pipeline: ref(12), repoBranches: { templates: "users/me/fix" }, reason: "a" }] }, "W1", null),
    /Deploy-Test: branch users\/me\/fix doesn't exist in GovernedTemplates \(repository resource templates\)/,
);
await assert.rejects(
    agent.propose(task.id, { summary: "s", blocks: [{ pipeline: ref(12), repoBranches: { self: "release/1" }, reason: "a" }] }, "W1", null),
    /own repository builds the block's Branch/,
);
discoveryCalls.repos.length = 0;
await agent.propose(task.id, { summary: "s", blocks: [{ pipeline: ref(12), repoBranches: { Templates: "refs/heads/release/1" }, reason: "a" }] }, "W1", null);
{
    const rp = (await v.validationRow(task.id)).proposal;
    assert.deepEqual(rp.blocks[0].repoBranches, { Templates: "release/1" });
    assert.deepEqual(discoveryCalls.repos, [["OneBranch.Pipelines", "tmpl-guid", "release/1"]], "checked in the repository's own project");
    assert.ok(rp.checks.some((c) => c.text === "Every fixed branch exists"));
    assert.ok(rp.checks.some((c) => c.tone === "warn" && c.text === "Deploy-Test uses release/1 of Templates instead of the YAML's ref"));
    assert.deepEqual(v.proposalGraph(rp).nodes[0].repoBranches, { Templates: "release/1" }, "accepting carries them into the chain");
}

// Dismissed: the proposer hears why. Only the proposal the user reviewed can be dismissed.
await assert.rejects(v.dismissProposal(task.id, "no", "an-older-proposal"), /The proposal changed since you opened it/);
assert.ok((await v.validationRow(task.id)).proposal, "a stale dismiss leaves the newer proposal");
await v.dismissProposal(task.id, "Use the Test ring only", (await v.validationRow(task.id)).proposal.id);
assert.equal((await v.validationRow(task.id)).proposal, null);
assert.equal(told.length, 1);
assert.equal(told[0].sessionId, "w1-session");
assert.match(told[0].text, /dismissed your validation proposal.*"Use the Test ring only"/);

// Accepted: it becomes the task's chain, laid out in stages. Accepting names the proposal reviewed.
await agent.propose(task.id, { summary: "Build then Test.", blocks: [{ pipeline: ref(11), followPr: 7, reason: "CI" }, { pipeline: ref(12), after: [ref(11)], params: { env: "test" }, reason: "Test" }] }, "W1", "w1-session");
const reviewed = (await v.validationRow(task.id)).proposal;
assert.match(reviewed.id, /^[0-9a-f-]{36}$/);
await assert.rejects(v.acceptProposal(task.id, { id: "an-older-proposal", run: true }), /The proposal changed since you opened it/, "a newer proposal can't slip in");
assert.equal((await v.validationView(task.id)).chain, null, "nothing was created");
const chain = await v.acceptProposal(task.id, { id: reviewed.id });
assert.equal(chain.ownerTaskId, task.id);
assert.deepEqual(chain.graph.nodes.map((n) => [n.id, n.definitionId, n.branch, n.branchFrom, n.x, n.y]), [
    ["v1", 11, "", { org: "msazure", prId: 7 }, 40, 40],
    ["v2", 12, "", undefined, 360, 40],
]);
assert.deepEqual(chain.graph.nodes[1].params, { env: "test" });
assert.deepEqual(chain.graph.edges, [{ from: "v1", to: "v2" }]);
row = await v.validationRow(task.id);
assert.equal(row.proposal, null);
assert.equal(row.acceptedBy, "W1");
assert.equal(row.evidence["msazure/azure appconfig/11"].reason, "CI", "why each pipeline is there is kept");
assert.equal((await v.validationSummary(task.id)).attention, null);
const events = await store.listEvents({ taskId: task.id, limit: 50 });
assert.ok(events.some((e) => /W1 proposed validation/.test(e.text)));
assert.ok(events.some((e) => /Validation accepted/.test(e.text)));

// ---- 5. a run: the PR's branch, History, a status line, and what failed for the worker --------------------
told.length = 0;
const run1 = await v.runValidation(task.id);
await tick();
assert.deepEqual(queued.at(-1), { definitionId: 11, branch: "refs/heads/kjeong/feature" }, "the block builds the PR's branch, read when it queues");
assert.equal((await pipes.latestRun(chain.id)).states.v1.followed, "msazure/7", "the run records which PR the block followed");
setBuild(11, "completed", "succeeded");
await tick();
await tick();
assert.equal(queued.at(-1).definitionId, 12);
assert.equal(queued.at(-1).branch, "", "a block without a branch builds the pipeline's default");
assert.deepEqual(queued.at(-1).params, { env: "test" });
summary = await v.validationSummary(task.id);
assert.equal(summary.run.status, "running");
assert.equal(summary.run.done, 1);
assert.equal(summary.run.current, "Deploy-Test");
setBuild(12, "completed", "failed");
await tick();
await until(async () => told.length > 0, "the worker hearing what failed");
assert.match(told[0].text, /validation chain failed\. Validation failed at Deploy-Test \(build B\d+\)/);
assert.match(told[0].text, /Run smoke tests" failed: boom in build \d+/);
assert.match(told[0].text, /Log: https:\/\/log\/\d+/);
assert.match(told[0].text, /Ask the user before running validation again/);
await until(async () => (await store.listStatuses({ taskId: task.id, limit: 10 })).some((s) => s.author === "Validation"), "a status line");
const status = (await store.listStatuses({ taskId: task.id, limit: 10 })).find((s) => s.author === "Validation");
assert.match(status.text, /^Validation failed at Deploy-Test/);
const history = await store.listEvents({ taskId: task.id, limit: 50 });
assert.ok(history.some((e) => /^Validation started for/.test(e.text)));
assert.ok(history.some((e) => /^Validation failed at Deploy-Test/.test(e.text)));
summary = await v.validationSummary(task.id);
assert.equal(summary.attention, "failed", "a failed run needs the user");
assert.equal(summary.run.failed, "Deploy-Test");
view = await v.validationView(task.id);
assert.equal(view.runs[0].runId, run1.runId);
assert.match(view.runs[0].text, /Validation failed at Deploy-Test/);
await v.acknowledgeRun(task.id, "some-other-run");
assert.equal((await v.validationSummary(task.id)).attention, "failed", "acknowledging another run changes nothing");
await v.acknowledgeRun(task.id, run1.runId);
assert.equal((await v.validationSummary(task.id)).attention, null, "seen: it leaves Needs you");

// The user can turn the worker report off.
await v.setValidationOptions(task.id, { notifyWorker: false });
told.length = 0;
await v.runValidation(task.id);
await tick();
setBuild(11, "completed", "failed");
await tick();
await until(async () => (await pipes.latestRun(chain.id)).status === "failed", "the second run failing");
await new Promise((r) => setTimeout(r, 100));
assert.equal(told.length, 0, "no report when the user turned it off");
await v.setValidationOptions(task.id, { notifyWorker: true });

// ---- 6. a done task's chain doesn't run ------------------------------------------------------------------
await store.updateTask(task.id, { status: "done" });
await assert.rejects(v.runValidation(task.id), /The task is done\. Reopen it to run its validation\./);
await assert.rejects(pipes.startChainRun(chain.id), /The task is done/, "the Pipelines tab is guarded too");
await assert.rejects(pipes.triggerNode(chain.id, "v2"), /The task is done/, "…and running one block");
assert.equal((await v.validationView(task.id)).taskStatus, "done");
await assert.rejects(agent.propose(task.id, { summary: "s", blocks: [{ pipeline: ref(11), reason: "r" }] }, "W1", null), /The task is done/);
await assert.rejects(
    v.setBlockRepoBranches(task.id, "v2", { templates: "release/1" }),
    (e) => e.status === 409 && /^The task is done\. Reopen it to change its validation\.$/.test(e.message),
    "…and its blocks' repository branches",
);
await store.updateTask(task.id, { status: "open" });
assert.equal(await pipes.getChain(mine.id).then((c) => !!c), true);
await pipes.startChainRun(mine.id).then((r) => pipes.requestRunCancel(r.runId));
await tick();
await until(async () => (await pipes.latestRun(mine.id)).status !== "running", "the user's own chain stopping");

// ---- 6b. a block's repository branches, set from the task: compiled and looked up before they're saved ------
{
    const v2Of = (c) => c.graph.nodes.find((n) => n.id === "v2");
    const rejectsWith = (promise, status, pattern, message) =>
        assert.rejects(promise, (e) => e.status === status && pattern.test(e.message), message);
    const lastEvent = async () => (await store.listEvents({ taskId: task.id, limit: 1 }))[0].text;
    previewCalls.length = 0;
    repoLookups.length = 0;

    let set = await v.setBlockRepoBranches(task.id, "v2", { TEMPLATES: "release/1" }, "");
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
    assert.equal(await lastEvent(), "A repository branch set on Deploy-Test for Ship the cache");

    // What the user opened must still be what's there; a chain saved elsewhere meanwhile is refused too.
    const opened = repoSignature(v2Of(set.chain).repoBranches);
    await rejectsWith(v.setBlockRepoBranches(task.id, "v2", { templates: "flaky" }, ""), 409, /changed since you opened them/, "a stale edit");
    await rejectsWith(v.setBlockRepoBranches(task.id, "gone", { templates: "release/1" }), 404, /isn't in the task's chain anymore/);

    // Nothing is saved when a branch can't be used.
    previewCalls.length = 0;
    repoLookups.length = 0;
    await rejectsWith(v.setBlockRepoBranches(task.id, "v2", { self: "release/1" }, opened), 400, /own repository builds the block's Branch/);
    await rejectsWith(v.setBlockRepoBranches(task.id, "v2", ["release/1"], opened), 400, /must be alias\/branch pairs/);
    assert.equal(previewCalls.length, 0, "bad input isn't sent to Azure DevOps");
    await rejectsWith(
        v.setBlockRepoBranches(task.id, "v2", { templates: "users/me/gone" }, opened),
        400,
        /^Branch users\/me\/gone doesn't exist in GovernedTemplates \(repository resource templates\)\.$/,
    );
    await rejectsWith(
        v.setBlockRepoBranches(task.id, "v2", { templates: "broken" }, opened),
        400,
        /^Azure DevOps can't compile the pipeline with these branches: Could not find template build\.yml@templates$/,
    );
    await rejectsWith(
        v.setBlockRepoBranches(task.id, "v2", { gone: "release/1" }, opened),
        400,
        /^Repository "gone" is no longer a resource of this pipeline\. Its repository resources: templates\.$/,
    );
    assert.deepEqual(repoLookups.map((l) => l[2]), ["users/me/gone"], "a branch is only looked up once the pipeline compiles with it");
    assert.deepEqual(v2Of(await pipes.getChain(chain.id)).repoBranches, { templates: "release/1" }, "nothing was saved");

    // A lookup that fails is a warning: the branches are saved, and the run checks them.
    set = await v.setBlockRepoBranches(task.id, "v2", { templates: "flaky" }, opened);
    assert.equal(set.warnings.length, 1);
    assert.match(set.warnings[0], /^Couldn't check that branch flaky exists in GovernedTemplates: /);
    assert.deepEqual(v2Of(set.chain).repoBranches, { templates: "flaky" });

    // A block that follows a PR is compiled on the PR's branch; while that isn't known, nothing is checked.
    previewCalls.length = 0;
    set = await v.setBlockRepoBranches(task.id, "v1", { templates: "release/1" }, "");
    assert.deepEqual(set.warnings, []);
    assert.deepEqual(previewCalls.map((c) => [c.definitionId, c.branch]), [[11, "refs/heads/kjeong/feature"]]);
    await store.updateTaskPr(task.id, "msazure", 7, { snapshot: snapshot(7, { sourceRef: "" }) });
    previewCalls.length = 0;
    set = await v.setBlockRepoBranches(task.id, "v1", { templates: "users/me/gone" }, repoSignature({ templates: "release/1" }));
    assert.deepEqual(set.warnings, ["The branch of PR 7 isn't known yet, so these weren't checked. The run checks them."]);
    assert.equal(previewCalls.length, 0);
    assert.deepEqual(set.chain.graph.nodes.find((n) => n.id === "v1").repoBranches, { templates: "users/me/gone" });
    await store.updateTaskPr(task.id, "msazure", 7, { snapshot: snapshot(7) });

    // Clearing needs no check.
    set = await v.setBlockRepoBranches(task.id, "v1", null);
    assert.equal(set.chain.graph.nodes.find((n) => n.id === "v1").repoBranches, undefined);
    set = await v.setBlockRepoBranches(task.id, "v2", { templates: "  " }, repoSignature({ templates: "flaky" }));
    assert.equal(v2Of(set.chain).repoBranches, undefined, "a blank branch clears it");
    assert.equal(previewCalls.length, 0);
    assert.equal(await lastEvent(), "Repository branches cleared on Deploy-Test for Ship the cache");

    const { task: chainless } = await store.createTask({ title: "No chain" });
    await rejectsWith(v.setBlockRepoBranches(chainless.id, "v1", { templates: "release/1" }), 404, /^This task has no validation chain\.$/);
    await store.deleteTask(chainless.id);
}

// A block that follows a PR the app can't read errors with why, instead of building some other branch.
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

// ---- 7. a busy worker hears it when its turn ends; nothing is lost on the way -----------------------------
busy.add("w1-session");
told.length = 0;
assert.match(await v.deliverNotice(task.id, "first"), /W1 is busy; it hears this when its turn ends\./);
assert.equal((await v.validationRow(task.id)).pendingNotice, "first");
await v.validationTick();
assert.equal(told.length, 0, "still busy");
busy.delete("w1-session");
onMessage = async () => {
    onMessage = null;
    busy.add("w1-session");
    await v.deliverNotice(task.id, "second");
};
await v.validationTick();
assert.deepEqual(told.map((t) => t.text), ["first"]);
assert.equal((await v.validationRow(task.id)).pendingNotice, "second", "a notice that came in while sending is kept");
busy.delete("w1-session");
await v.validationTick();
assert.deepEqual(told.map((t) => t.text), ["first", "second"]);
assert.equal((await v.validationRow(task.id)).pendingNotice, null);

// A task that's done takes no notices: none are parked to fire when it's reopened.
busy.add("w1-session");
await v.deliverNotice(task.id, "parked");
assert.equal((await v.validationRow(task.id)).pendingNotice, "parked");
await store.updateTask(task.id, { status: "done" });
await v.validationTick();
assert.equal((await v.validationRow(task.id)).pendingNotice, null, "marking it done drops what was parked");
assert.equal(await v.deliverNotice(task.id, "late"), "The task isn't open, so its workers weren't told.");
assert.equal((await v.validationRow(task.id)).pendingNotice, null);
busy.delete("w1-session");
await store.updateTask(task.id, { status: "open" });
await v.validationTick();
assert.deepEqual(told.map((t) => t.text), ["first", "second"], "reopening it doesn't replay old notices");

// ---- 8. automatic proposals: asked once, only with a PR and a worker -----------------------------------------
const { task: other } = await store.createTask({ title: "Second task" });
await store.insertWorker({ sessionId: "w2-session", taskId: other.id, label: "W2", cwd: root, model: null, state: "idle", summary: "" });
told.length = 0;
await v.validationTick();
assert.equal(told.length, 0, "off by default");
await v.setAutoPropose(true);
assert.equal(await v.autoProposeOn(), true);
await v.validationTick();
assert.equal(told.length, 0, "no PR yet");
await store.upsertTaskPr(other.id, "msazure", 8, "worker", snapshot(8));
await v.validationTick();
assert.equal(told.length, 1);
assert.equal(told[0].sessionId, "w2-session");
assert.match(told[0].text, /A pull request is linked to this task\. Find the pipelines that validate/);
await v.validationTick();
assert.equal(told.length, 1, "asked once");
assert.equal(told.some((t) => t.sessionId === "w1-session"), false, "a task with a chain isn't asked");
await v.setAutoPropose(false);

// ---- 9. run again on a new commit, when the user allows it ---------------------------------------------------
const before = (await pipes.latestRun(chain.id)).runId;
await v.setValidationOptions(task.id, { rerunOnCommit: true });
assert.deepEqual((await v.validationRow(task.id)).commits, { "msazure/7": "aaa1111" }, "turning it on watches from the current commit");
await v.validationTick();
assert.equal((await pipes.latestRun(chain.id)).runId, before, "no run for the commit it already saw");
// A PR the chain starts following later is watched from its current commit, not run for it.
await store.upsertTaskPr(task.id, "msazure", 9, "user", snapshot(9, { sourceCommit: "ddd4444" }));
const following9 = { ...chain.graph, nodes: chain.graph.nodes.map((n) => (n.id === "v2" ? { ...n, branchFrom: { org: "msazure", prId: 9 } } : n)) };
await pipes.saveChain({ id: chain.id, name: chain.name, graph: following9 });
await v.validationTick();
assert.equal((await pipes.latestRun(chain.id)).runId, before, "no run for a newly followed PR's current commit");
assert.deepEqual((await v.validationRow(task.id)).commits, { "msazure/7": "aaa1111", "msazure/9": "ddd4444" });
await pipes.saveChain({ id: chain.id, name: chain.name, graph: chain.graph });
await store.updateTaskPr(task.id, "msazure", 7, { snapshot: snapshot(7, { sourceCommit: "bbb2222" }) });
await v.validationTick();
const rerun = await pipes.latestRun(chain.id);
assert.notEqual(rerun.runId, before, "a new commit starts a run");
assert.equal(rerun.status, "running");
assert.ok((await store.listEvents({ taskId: task.id, limit: 50 })).some((e) => /new commit bbb2222/.test(e.text)));
await store.updateTaskPr(task.id, "msazure", 7, { snapshot: snapshot(7, { sourceCommit: "ccc3333" }) });
await v.validationTick();
assert.equal((await pipes.latestRun(chain.id)).runId, rerun.runId, "a run in progress isn't restarted…");
assert.deepEqual((await v.validationRow(task.id)).commits, { "msazure/7": "bbb2222" }, "…and the newer commit waits for it");

// A run started any other way builds the current commit too: no second run for it afterwards.
const stopLatest = async () => {
    await pipes.requestRunCancel((await pipes.latestRun(chain.id)).runId);
    await tick();
    for (const b of builds.values()) if (b.status === "cancelling") Object.assign(b, { status: "completed", result: "canceled" });
    await tick();
    await until(async () => (await pipes.latestRun(chain.id)).status !== "running", "the run stopping");
};
await stopLatest();
const manual = await v.runValidation(task.id);
await until(async () => (await v.validationRow(task.id)).commits["msazure/7"] === "ccc3333", "the manual run's commit being recorded");
await stopLatest();
await v.validationTick();
assert.equal((await pipes.latestRun(chain.id)).runId, manual.runId, "no rerun for the commit the manual run built");
await v.runValidation(task.id);

// ---- 10. a reusable copy drops the task's PRs ---------------------------------------------------------------
const reusable = await v.saveAsReusable(task.id);
assert.equal(reusable.ownerTaskId, null);
assert.equal(reusable.name, "Ship the cache validation");
assert.deepEqual(reusable.graph.nodes.map((n) => [n.branch, n.branchFrom]), [["", undefined], ["", undefined]]);
assert.deepEqual(reusable.graph.nodes[1].params, { env: "test" });

// ---- 11. removing the task: the run stops, then the chain goes -----------------------------------------------
const record = await v.retireValidation(task.id);
assert.equal(record.chain, "Validation · Ship the cache");
assert.deepEqual(record.pipelines.map((p) => p.definitionId), [11, 12]);
assert.equal(record.lastRun.status, "running");
assert.ok(await pipes.getChain(chain.id), "a running chain stays until its run stops");
assert.equal((await pipes.latestRun(chain.id)).cancelRequested, true);
await store.deleteTask(task.id, { validation: record });
const json = JSON.parse(readFileSync(join(process.env.ADO_PR_OPS_JARVIS_DIR, "tasks", task.id, "task.json"), "utf8"));
assert.equal(json.validation.chain, "Validation · Ship the cache", "task.json says what its validation was");
assert.deepEqual((await pipes.orphanedTaskChains()).map((c) => c.id), [chain.id]);
assert.equal((await pipes.listChains()).find((c) => c.id === chain.id).owner.status, "removed");
await assert.rejects(pipes.startChainRun(chain.id), /task was removed/, "an orphan can't start again");
await tick();
for (const b of builds.values()) if (b.status === "cancelling") Object.assign(b, { status: "completed", result: "canceled" });
await tick();
await until(async () => (await pipes.latestRun(chain.id)).status !== "running", "the orphan's run stopping");
await v.validationTick();
assert.equal(await pipes.getChain(chain.id), null, "the sweep deletes it");
assert.ok(await pipes.getChain(reusable.id), "the reusable copy is the user's");
assert.equal(await v.retireValidation(other.id), null, "nothing to retire");

// ---- 12. the tools ----------------------------------------------------------------------------------------
const workerTool = agent.taskValidationTool();
const call = (args, sessionId = "w2-session") => workerTool.handler(args, { sessionId });
assert.equal(await call({ action: "status" }), "No validation chain yet.");
assert.match(await call({ action: "candidates" }), /"pipeline": "msazure\/Azure AppConfig\/11"/);
assert.match(await call({ action: "propose", summary: "s", blocks: [{ pipeline: ref(11), followPr: 8, reason: "CI" }] }), /^Proposed: AppConfig-CI/);
assert.match(await call({ action: "status" }), /A proposal by W2 waits for the user: AppConfig-CI\./);
assert.match(await call({ action: "propose", blocks: [] }), /^Not proposed/);
assert.equal(await call({ action: "status" }, "nobody"), "This session is not one of the Workspace's workers.");
const leadTool = agent.leadValidationTool();
assert.match(await leadTool.handler({ taskId: "nope", action: "status" }, { sessionId: "lead" }), /Unknown taskId/);
assert.match(await leadTool.handler({ taskId: other.id, action: "status" }, { sessionId: "lead" }), /A proposal by W2/);
assert.equal(await leadTool.handler({ taskId: other.id, action: "run" }, { sessionId: "lead" }), "Use action status, candidates or propose.", "the Lead can't run it");

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

// The lead was called Jarvis: a proposal it made then reads as Devis once the schema opens again.
{
    const renamed = (await store.createTask({ title: "Rename proposal" })).task;
    const jdb = await store.jarvisDb();
    jdb.prepare(
        "INSERT INTO jarvis_task_validation (task_id, proposal_json, evidence_json, accepted_by, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(renamed.id, JSON.stringify({ by: "Jarvis", at: new Date().toISOString(), blocks: [] }), JSON.stringify({ k: { reason: "r", evidence: [], by: "Jarvis" } }), "Jarvis", new Date().toISOString());
    v.resetValidationSchema();
    assert.equal((await v.validationSummary(renamed.id))?.proposal?.by, "Devis");
    const row = jdb.prepare("SELECT accepted_by, evidence_json FROM jarvis_task_validation WHERE task_id = ?").get(renamed.id);
    assert.deepEqual([row.accepted_by, JSON.parse(row.evidence_json).k.by], ["Devis", "Devis"]);
}
v.stopValidationRunner();
await runner.stopPipelineRunner();
closeDb();
rmSync(root, { recursive: true, force: true });
console.log("jarvis-validation harness: ok");
