import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Drives the pipeline chain runner against a temporary database and a fake
// Azure DevOps build client. Nothing here talks to a real ADO organization.

const tempDir = await mkdtemp(join(tmpdir(), "ado-pr-ops-pipeline-runner-"));
process.env.ADO_PR_OPS_DB_PATH = join(tempDir, "reviews.db");

const {
    appBuilds,
    blockResults,
    deleteChain,
    enqueueRunCommand,
    finishRun,
    getChain,
    getRun,
    latestRun,
    listChains,
    pendingCommands,
    requestRunCancel,
    saveChain,
    startChainRun,
    takeCommandResult,
    triggerNode,
    updateRun,
} = await import("../pipeline-store.mjs");
const { startPipelineRunner, stopPipelineRunner, tickPipelineRunner, wakePipelineRunner } = await import(
    "../pipeline-runner.mjs"
);
const { closeDb, ensureDb } = await import("../store.mjs");

const node = (id, definitionId, extra = {}) => ({
    id,
    org: "org",
    project: "proj",
    definitionId,
    name: `Pipeline ${id}`,
    path: "\\",
    branch: "",
    x: 0,
    y: 0,
    ...extra,
});

// ---- fake ADO -------------------------------------------------------------------
const builds = new Map();
const calls = { queue: [], cancel: [], run: [], definition: [], parameters: [] };
const failQueue = new Set();
const failGet = new Set();
const failDefinition = new Set();
const instantSuccess = new Set();
// definitionId -> { yaml, projectId, defaultBranch } / { parameters, resources, errors }
const definitions = new Map();
const runParameters = new Map();
let nextBuildId = 100;
let queueCheck = null;
let definitionCheck = null;

const newBuild = (definitionId) => {
    const id = nextBuildId++;
    const done = instantSuccess.has(definitionId);
    const b = {
        id,
        definitionId,
        buildNumber: `2024.${id}`,
        status: done ? "completed" : "notStarted",
        result: done ? "succeeded" : undefined,
        url: `https://dev.azure.com/org/proj/_build/results?buildId=${id}`,
    };
    builds.set(id, b);
    return { ...b };
};

const fakeAdo = {
    async queueBuild(org, project, definitionId, sourceBranch) {
        calls.queue.push({ org, project, definitionId, sourceBranch });
        if (queueCheck) await queueCheck(definitionId);
        if (failQueue.has(definitionId)) throw new Error("ADO POST 403: Proof of presence is required");
        return newBuild(definitionId);
    },
    async runPipeline(_org, _project, definitionId, branch, pins, params, repos) {
        calls.run.push({ definitionId, branch, pins, params, ...(repos ? { repos } : {}) });
        return newBuild(definitionId);
    },
    async getDefinition(_org, _project, definitionId) {
        calls.definition.push(definitionId);
        if (definitionCheck) await definitionCheck(definitionId);
        if (failDefinition.has(definitionId)) throw new Error('ADO GET 404: {"message":"Pipeline not found"}');
        return definitions.get(definitionId) ?? { yaml: false, projectId: "p", defaultBranch: "refs/heads/main" };
    },
    async getRunParameters(_org, _project, projectId, definitionId, branch) {
        calls.parameters.push({ projectId, definitionId, branch });
        return runParameters.get(definitionId) ?? { parameters: [], resources: [], errors: [] };
    },
    async getBuild(_org, _project, buildId) {
        if (failGet.has(buildId)) throw new Error("ADO GET 500: service down");
        return { ...builds.get(buildId) };
    },
    async cancelBuild(_org, _project, buildId) {
        calls.cancel.push(buildId);
        builds.get(buildId).status = "cancelling";
    },
};
const setBuild = (definitionId, status, result) => {
    for (const b of builds.values()) {
        if (b.definitionId === definitionId) Object.assign(b, { status, result });
    }
};
const queuedDefinitions = () => calls.queue.map((c) => c.definitionId);
const statuses = (run) => Object.fromEntries(Object.entries(run.states).map(([id, s]) => [id, s.status]));

wakePipelineRunner(); // a no-op before the runner starts
await startPipelineRunner({ ado: fakeAdo, pollMs: 60_000, maxPollFailures: 2 });

// ---- 1. ordering and the AND-join ----------------------------------------------------
const joinChain = await saveChain({
    name: "  Release train  ",
    graph: {
        nodes: [node("a", 1), node("b", 2), node("c", 3, { branch: "release/1" })],
        edges: [
            { from: "a", to: "c" },
            { from: "b", to: "c" },
        ],
    },
});
assert.ok(joinChain.id);
assert.equal(joinChain.name, "Release train");
const renamed = await saveChain({ id: joinChain.id, name: "Release", graph: joinChain.graph });
assert.equal(renamed.id, joinChain.id, "saving with an id updates in place");
assert.equal((await getChain(joinChain.id)).name, "Release");

let run = await startChainRun(joinChain.id);
assert.equal(run.status, "running");
assert.deepEqual(statuses(run), { a: "waiting", b: "waiting", c: "waiting" });
await assert.rejects(startChainRun(joinChain.id), /already running/i, "one active run per chain");
await assert.rejects(deleteChain(joinChain.id), /running/i, "a running chain cannot be deleted");

// A node is persisted as "queuing" before the POST, so a crash never queues twice.
queueCheck = async (definitionId) => {
    const live = await getRun(run.runId);
    const target = joinChain.graph.nodes.find((n) => n.definitionId === definitionId);
    assert.equal(live.states[target.id].status, "queuing");
};
await tickPipelineRunner();
queueCheck = null;
assert.deepEqual(queuedDefinitions(), [1, 2], "both roots queue in the first tick");
assert.equal(calls.queue[0].sourceBranch, undefined, "a blank branch uses the pipeline default");
run = await getRun(run.runId);
assert.deepEqual(statuses(run), { a: "queued", b: "queued", c: "waiting" });
assert.ok(run.states.a.buildId && run.states.a.url && run.states.a.buildNumber);

setBuild(1, "completed", "succeeded");
setBuild(2, "inProgress");
await tickPipelineRunner();
run = await getRun(run.runId);
assert.deepEqual(statuses(run), { a: "succeeded", b: "running", c: "waiting" }, "the join waits for b");
assert.deepEqual(queuedDefinitions(), [1, 2]);

setBuild(2, "completed", "partiallySucceeded");
await tickPipelineRunner();
run = await getRun(run.runId);
assert.equal(run.states.c.status, "queued");
assert.deepEqual(queuedDefinitions(), [1, 2, 3]);
assert.equal(calls.queue[2].sourceBranch, "refs/heads/release/1");

setBuild(3, "completed", "succeeded");
await tickPipelineRunner();
run = await getRun(run.runId);
assert.equal(run.status, "succeeded");
assert.ok(run.finishedAt);
const summary = (await listChains()).find((c) => c.id === joinChain.id);
assert.equal(summary.nodeCount, 3);
assert.equal(summary.lastRun.status, "succeeded");
assert.equal((await latestRun(joinChain.id)).runId, run.runId);

// ---- 2. failures stop downstream work ----------------------------------------------------
calls.queue.length = 0;
failQueue.add(99);
const failing = await saveChain({
    name: "Failing",
    graph: {
        nodes: [node("x", 10), node("y", 11), node("z", 99), node("w", 12)],
        edges: [
            { from: "x", to: "y" },
            { from: "z", to: "w" },
        ],
    },
});
run = await startChainRun(failing.id);
await tickPipelineRunner();
run = await getRun(run.runId);
assert.equal(run.states.z.status, "error");
assert.match(run.states.z.error, /Proof of presence/, "the ADO error is kept on the block");
assert.equal(run.states.w.status, "skipped");
assert.equal(run.states.x.status, "queued");
assert.equal(run.status, "running", "x is still going");
setBuild(10, "completed", "failed");
await tickPipelineRunner();
run = await getRun(run.runId);
assert.equal(run.states.y.status, "skipped");
assert.equal(run.status, "failed");
assert.deepEqual(queuedDefinitions(), [10, 99], "nothing downstream of a failure is queued");

// ---- 3. cancellation ---------------------------------------------------------------------
calls.queue.length = 0;
const cancelChain = await saveChain({
    name: "Cancel me",
    graph: { nodes: [node("p", 20), node("q", 21)], edges: [{ from: "p", to: "q" }] },
});
run = await startChainRun(cancelChain.id);
await tickPipelineRunner();
setBuild(20, "inProgress");
assert.equal(await requestRunCancel(run.runId), true);
await tickPipelineRunner();
run = await getRun(run.runId);
assert.equal(calls.cancel.length, 1, "a cancel PATCH is sent for the running build");
assert.equal(run.states.q.status, "skipped");
assert.equal(run.status, "running", "the run waits for ADO to finish cancelling");
await tickPipelineRunner();
assert.equal(calls.cancel.length, 1, "cancel is sent only once");
setBuild(20, "completed", "canceled");
await tickPipelineRunner();
run = await getRun(run.runId);
assert.equal(run.status, "canceled");
assert.equal(await requestRunCancel(run.runId), false, "finished runs cannot be canceled");
assert.deepEqual(queuedDefinitions(), [20]);

// ---- 4. repeated poll failures end in an error -----------------------------------------
const flaky = await saveChain({ name: "Flaky", graph: { nodes: [node("s", 30)], edges: [] } });
run = await startChainRun(flaky.id);
await tickPipelineRunner();
run = await getRun(run.runId);
failGet.add(run.states.s.buildId);
await tickPipelineRunner();
run = await getRun(run.runId);
assert.equal(run.states.s.status, "queued", "one failed poll is tolerated");
assert.match(run.states.s.pollError, /service down/);
await tickPipelineRunner();
run = await getRun(run.runId);
assert.equal(run.states.s.status, "error");
assert.equal(run.status, "failed");

// ---- 5. restart recovery never re-queues an unconfirmed build -----------------------------
calls.queue.length = 0;
const resumable = await saveChain({
    name: "Resume",
    graph: { nodes: [node("r", 40), node("t", 41)], edges: [{ from: "r", to: "t" }] },
});
run = await startChainRun(resumable.id);
await updateRun(run.runId, { states: { r: { status: "queuing" }, t: { status: "waiting" } } });
await stopPipelineRunner();
await startPipelineRunner({ ado: fakeAdo, pollMs: 60_000, maxPollFailures: 2 });
await tickPipelineRunner();
run = await getRun(run.runId);
assert.equal(run.states.r.status, "error");
assert.match(run.states.r.error, /Azure DevOps/);
assert.equal(run.states.t.status, "skipped");
assert.equal(run.status, "failed");
assert.deepEqual(queuedDefinitions(), [], "the interrupted build is not queued again");

// ---- 6. empty chains, history pruning, deletion ----------------------------------------
const empty = await saveChain({ name: "Empty", graph: { nodes: [], edges: [] } });
await assert.rejects(startChainRun(empty.id), /at least one/i);
await assert.rejects(startChainRun("missing"), /not found/i);

instantSuccess.add(50);
const quick = await saveChain({ name: "Quick", graph: { nodes: [node("u", 50)], edges: [] } });
for (let i = 0; i < 22; i++) {
    const r = await startChainRun(quick.id);
    await tickPipelineRunner();
    assert.equal((await getRun(r.runId)).status, "succeeded");
}
const db = await ensureDb();
const { n: kept } = db.prepare("SELECT COUNT(*) AS n FROM pipeline_runs WHERE chain_id = ?").get(quick.id);
assert.equal(kept, 20, "run history is capped per chain");

assert.equal(await deleteChain(quick.id), true);
assert.equal(await getChain(quick.id), null);
const { n: orphans } = db.prepare("SELECT COUNT(*) AS n FROM pipeline_runs WHERE chain_id = ?").get(quick.id);
assert.equal(orphans, 0, "deleting a chain removes its runs");
assert.equal(await deleteChain("missing"), false);

// ---- 7. per-block trigger and stop; a shared block waits for every upstream in the run ----
// fa ─┐
//     ├─> fc        fd (independent)
// fb ─┘
calls.queue.length = 0;
calls.cancel.length = 0;
const fan = await saveChain({
    name: "Fan-in",
    graph: {
        nodes: [node("fa", 60), node("fb", 61), node("fc", 62), node("fd", 63)],
        edges: [
            { from: "fa", to: "fc" },
            { from: "fb", to: "fc" },
        ],
    },
});
await assert.rejects(triggerNode(fan.id, "zz"), /not part of this chain/i);
await assert.rejects(triggerNode("missing", "fa"), /not found/i);
let t = await triggerNode(fan.id, "fa");
assert.equal(t.commandId, null, "with no live run, a trigger starts a new run");
run = t.run;
assert.equal(run.status, "running");
assert.deepEqual(statuses(run), { fa: "waiting", fc: "waiting" }, "only the block and what follows it");
assert.equal(run.states.fa.manual, true);
await assert.rejects(startChainRun(fan.id), /already running/i, "still one live run per chain");
await tickPipelineRunner();
assert.deepEqual(queuedDefinitions(), [60]);

// fb joins the live run; the request is a command the runner applies on its next tick.
await assert.rejects(triggerNode(fan.id, "zz"), /not part of this chain/i);
t = await triggerNode(fan.id, "fb");
assert.equal(t.run.runId, run.runId, "joins the live run");
const joinCmd = t.commandId;
assert.ok(Number.isInteger(joinCmd));
const dupCmd = (await triggerNode(fan.id, "fb")).commandId;
assert.equal((await pendingCommands(run.runId)).length, 2);
assert.equal((await getRun(run.runId)).states.fb, undefined, "the API never writes run state");
assert.equal((await takeCommandResult(joinCmd)).status, "pending");
await tickPipelineRunner();
assert.deepEqual(await takeCommandResult(joinCmd), { status: "done", error: null });
assert.equal(await takeCommandResult(joinCmd), null, "a resolved result is read once");
const dup = await takeCommandResult(dupCmd);
assert.equal(dup.status, "rejected");
assert.match(dup.error, /already waiting|already running/i);
assert.deepEqual(queuedDefinitions(), [60, 61], "fb is queued exactly once");
run = await getRun(run.runId);
assert.deepEqual(statuses(run), { fa: "queued", fb: "queued", fc: "waiting" });

setBuild(60, "completed", "succeeded");
await tickPipelineRunner();
assert.equal((await getRun(run.runId)).states.fc.status, "waiting", "fc waits for fb too");
setBuild(61, "completed", "succeeded");
await tickPipelineRunner();
await tickPipelineRunner();
assert.deepEqual(queuedDefinitions(), [60, 61, 62], "fc is queued once after both pass");

// Re-running fa while fc runs would race fc; it is refused.
setBuild(62, "inProgress");
const blocked = (await triggerNode(fan.id, "fa")).commandId;
await tickPipelineRunner();
assert.match((await takeCommandResult(blocked)).error, /Can't start "Pipeline fa" while "Pipeline fc" is running/);

// Stop one block: one cancel, only for that build.
await assert.rejects(enqueueRunCommand(run.runId, "stop", "zz"), /not found/i);
const outCmd = await enqueueRunCommand(run.runId, "stop", "fd");
const stopCmd = await enqueueRunCommand(run.runId, "stop", "fc");
await tickPipelineRunner();
assert.deepEqual(await takeCommandResult(stopCmd), { status: "done", error: null });
const fcBuild = (await getRun(run.runId)).states.fc.buildId;
assert.deepEqual(calls.cancel, [fcBuild]);
run = await getRun(run.runId);
assert.equal(run.states.fc.stopRequested, true);
assert.equal(run.states.fc.cancelSent, true);
await tickPipelineRunner();
assert.deepEqual(calls.cancel, [fcBuild], "cancel is sent once");
setBuild(62, "completed", "canceled");
await tickPipelineRunner();
run = await getRun(run.runId);
assert.equal(run.status, "canceled");
await assert.rejects(enqueueRunCommand(run.runId, "stop", "fc"), /already finished/i);

// A command that lands while the last build finishes keeps the run open (no lost trigger).
instantSuccess.add(63);
calls.queue.length = 0;
t = await triggerNode(fan.id, "fd");
assert.equal(t.commandId, null, "a finished run is never joined");
run = t.run;
assert.deepEqual(statuses(run), { fd: "waiting" });
let raceCmd = null;
queueCheck = async (definitionId) => {
    if (definitionId === 63 && raceCmd === null) raceCmd = (await triggerNode(fan.id, "fd")).commandId;
};
await tickPipelineRunner();
queueCheck = null;
run = await getRun(run.runId);
assert.equal(run.states.fd.status, "succeeded");
assert.equal(run.status, "running", "a pending command keeps the run open");
assert.equal(await finishRun(run.runId, run.states, "succeeded", new Date().toISOString()), false);
await tickPipelineRunner();
assert.deepEqual(await takeCommandResult(raceCmd), { status: "done", error: null });
assert.deepEqual(queuedDefinitions(), [63, 63], "the late trigger ran fd again");
run = await getRun(run.runId);
assert.equal(run.status, "succeeded");

const fanRuns = db.prepare("SELECT run_id FROM pipeline_runs WHERE chain_id = ?").all(fan.id).map((r) => r.run_id);
const commandCount = () =>
    db.prepare(`SELECT COUNT(*) AS n FROM pipeline_run_commands WHERE run_id IN (${fanRuns.map(() => "?").join(",")})`).get(...fanRuns).n;
assert.ok(commandCount() > 0, "an unread result is still stored");
assert.ok(outCmd);
assert.equal(await deleteChain(fan.id), true);
assert.equal(commandCount(), 0, "deleting a chain removes its run commands");

// ---- 8. editing a running chain ---------------------------------------------------------------
// la ─> lb, then lc is added after lb and ld on its own.
calls.queue.length = 0;
const liveChain = await saveChain({
    name: "Live",
    graph: { nodes: [node("la", 70), node("lb", 71)], edges: [{ from: "la", to: "lb" }] },
});
run = await startChainRun(liveChain.id);
await tickPipelineRunner();
assert.deepEqual(queuedDefinitions(), [70]);
const grown = {
    nodes: [...liveChain.graph.nodes, node("lc", 72), node("ld", 73)],
    edges: [...liveChain.graph.edges, { from: "lb", to: "lc" }],
};
await saveChain({ id: liveChain.id, name: "Live", graph: grown });
const pending = await pendingCommands(run.runId);
assert.deepEqual(pending.map((c) => c.kind), ["graph"], "a save during a run is a command for the runner");
assert.equal(pending[0].graph.nodes.length, 4);
assert.equal((await getRun(run.runId)).graph.nodes.length, 2, "the API never writes the run graph");
await tickPipelineRunner();
run = await getRun(run.runId);
assert.equal(run.graph.nodes.length, 4);
assert.deepEqual(statuses(run), { la: "queued", lb: "waiting", lc: "waiting" }, "lc joins after lb; ld is not started");
assert.equal((await pendingCommands(run.runId)).length, 0);

// A block building in ADO keeps its place and its pipeline.
const refused = (graph) =>
    assert.rejects(saveChain({ id: liveChain.id, name: "Live", graph }), (e) => {
        assert.equal(e.status, 409);
        assert.match(e.message, /Stop "Pipeline la" before removing it/);
        return true;
    });
await refused({ nodes: grown.nodes.filter((n) => n.id !== "la"), edges: grown.edges.filter((e) => e.from !== "la") });
await refused({ ...grown, nodes: grown.nodes.map((n) => (n.id === "la" ? { ...n, definitionId: 700 } : n)) });
await refused({ ...grown, nodes: grown.nodes.map((n) => (n.id === "la" ? { ...n, project: "other" } : n)) });
assert.equal((await getChain(liveChain.id)).graph.nodes.length, 4, "a refused edit changes nothing");
assert.equal((await pendingCommands(run.runId)).length, 0);

// Removing the only link into a waiting block would start it; it leaves the run instead.
const cut = { nodes: grown.nodes, edges: [{ from: "lb", to: "lc" }] };
await saveChain({ id: liveChain.id, name: "Live", graph: cut });
await tickPipelineRunner();
run = await getRun(run.runId);
assert.deepEqual(statuses(run), { la: "queued" }, "an edit never starts a pipeline");
assert.deepEqual(queuedDefinitions(), [70]);

// A block saved during the run can be run right away: the edit is applied before the trigger.
const withLe = { nodes: [...cut.nodes, node("le", 74)], edges: cut.edges };
await saveChain({ id: liveChain.id, name: "Live", graph: withLe });
const leCmd = (await triggerNode(liveChain.id, "le")).commandId;
await assert.rejects(triggerNode(liveChain.id, "unsaved"), /Save the chain/);
await tickPipelineRunner();
assert.deepEqual(await takeCommandResult(leCmd), { status: "done", error: null });
assert.deepEqual(queuedDefinitions(), [70, 74]);

// After a restart, old run/stop requests are dropped but a saved edit still reaches the run.
const old = "2000-01-01T00:00:00.000Z";
const relinked = { nodes: withLe.nodes, edges: [...withLe.edges, { from: "la", to: "lb" }] };
const insertOld = db.prepare(
    "INSERT INTO pipeline_run_commands (run_id, kind, node_id, payload, created_at) VALUES (?, ?, ?, ?, ?)",
);
insertOld.run(run.runId, "trigger", "ld", null, old);
insertOld.run(run.runId, "graph", "", JSON.stringify(relinked), old);
await stopPipelineRunner();
await startPipelineRunner({ ado: fakeAdo, pollMs: 60_000, maxPollFailures: 2 });
await tickPipelineRunner();
run = await getRun(run.runId);
assert.deepEqual(statuses(run), { la: "queued", le: "queued", lb: "waiting", lc: "waiting" }, "the old edit was applied");
assert.deepEqual(queuedDefinitions(), [70, 74], "the dropped trigger never ran ld");

instantSuccess.add(71);
instantSuccess.add(72);
setBuild(70, "completed", "succeeded");
setBuild(74, "completed", "succeeded");
await tickPipelineRunner();
await tickPipelineRunner();
run = await getRun(run.runId);
assert.equal(run.status, "succeeded");
assert.deepEqual(queuedDefinitions(), [70, 74, 71, 72]);

// ---- 9. an edit that lands while a block is being planned wins ----------------------------------
calls.queue.length = 0;
calls.run.length = 0;
definitions.set(80, { yaml: true, projectId: "pid", defaultBranch: "refs/heads/main" });
runParameters.set(80, { parameters: [{ name: "X", label: "X", kind: "string", default: "" }], resources: [], errors: [] });
const raceChain = await saveChain({
    name: "Race",
    graph: { nodes: [node("ra", 80, { params: { X: "1" } }), node("rb", 81)], edges: [] },
});
run = await startChainRun(raceChain.id);
definitionCheck = async (definitionId) => {
    if (definitionId !== 80) return;
    definitionCheck = null;
    await saveChain({ id: raceChain.id, name: "Race", graph: { nodes: [node("rb", 81)], edges: [] } });
};
await tickPipelineRunner();
assert.equal(definitionCheck, null, "the edit landed mid-plan");
run = await getRun(run.runId);
assert.deepEqual(statuses(run), { rb: "queued" });
assert.deepEqual(queuedDefinitions(), [81]);
assert.deepEqual(calls.run, [], "the removed block was never queued");

// ---- 10. a release consumes the build its chain just made, with its parameters ----------------
calls.queue.length = 0;
calls.run.length = 0;
calls.definition.length = 0;
calls.parameters.length = 0;
definitions.set(91, { yaml: true, projectId: "proj-id", defaultBranch: "refs/heads/main" });
runParameters.set(91, {
    parameters: [{ name: "UseLease", label: "UseLease", kind: "boolean", default: "true" }],
    resources: [{ alias: "svc", name: "Svc-Official", project: "proj" }],
    errors: [],
});
const train = await saveChain({
    name: "Train",
    graph: {
        nodes: [node("bld", 90, { name: "Svc-Official" }), node("rel", 91, { name: "Release", params: { UseLease: "false" } })],
        edges: [{ from: "bld", to: "rel" }],
    },
});
assert.deepEqual(train.graph.nodes[1].params, { UseLease: "false" }, "parameters are saved with the block");
run = await startChainRun(train.id);
await tickPipelineRunner();
assert.deepEqual(queuedDefinitions(), [90]);
assert.deepEqual(calls.definition, [], "a block with no parameters or upstream build skips the lookups");
const bldNumber = (await getRun(run.runId)).states.bld.buildNumber;
setBuild(90, "completed", "succeeded");
await tickPipelineRunner();
const pin = { alias: "svc", version: bldNumber, from: "bld" };
assert.deepEqual(calls.parameters, [{ projectId: "proj-id", definitionId: 91, branch: "refs/heads/main" }], "a blank branch checks the default branch");
assert.deepEqual(calls.run, [{ definitionId: 91, branch: "", pins: [pin], params: { UseLease: "false" } }]);
assert.deepEqual(queuedDefinitions(), [90], "the Runs API queued the release");
run = await getRun(run.runId);
assert.equal(run.states.rel.status, "queued");
assert.deepEqual(run.states.rel.resources, [pin], "the run records which build it consumed");
assert.deepEqual(run.states.rel.params, { UseLease: "false" });
setBuild(91, "completed", "succeeded");
await tickPipelineRunner();
assert.equal((await getRun(run.runId)).status, "succeeded");

// ---- 10b. run on its own later, the release consumes the build this app made, not ADO's latest ----
const trainRunId = run.runId;
const earlierPin = { ...pin, runId: trainRunId };
calls.run.length = 0;
let solo = (await triggerNode(train.id, "rel")).run;
await tickPipelineRunner();
assert.deepEqual(calls.run, [{ definitionId: 91, branch: "", pins: [earlierPin], params: { UseLease: "false" } }]);
solo = await getRun(solo.runId);
assert.deepEqual(statuses(solo), { rel: "queued" });
assert.deepEqual(solo.states.rel.resources, [earlierPin], "the run records the earlier run it consumed from");
assert.equal(solo.states.rel.branch, "", "the run records the branch it queued on");
setBuild(91, "completed", "succeeded");
await tickPipelineRunner();
// A later failed build of it doesn't replace the last good one.
run = await startChainRun(train.id);
await tickPipelineRunner();
setBuild(90, "completed", "failed");
await tickPipelineRunner();
assert.equal((await getRun(run.runId)).status, "failed");
calls.run.length = 0;
solo = (await triggerNode(train.id, "rel")).run;
await tickPipelineRunner();
assert.deepEqual(calls.run.map((c) => c.pins), [[earlierPin]]);
setBuild(91, "completed", "succeeded");
await tickPipelineRunner();
// On a branch this app hasn't built it on, Azure DevOps picks the build.
const [trainBld, trainRel] = (await getChain(train.id)).graph.nodes;
await saveChain({ id: train.id, name: "Train", graph: { nodes: [{ ...trainBld, branch: "dev" }, trainRel], edges: [{ from: "bld", to: "rel" }] } });
calls.run.length = 0;
solo = (await triggerNode(train.id, "rel")).run;
await tickPipelineRunner();
assert.deepEqual(calls.run.map((c) => c.pins), [[]]);
setBuild(91, "completed", "succeeded");
await tickPipelineRunner();
assert.equal((await getRun(solo.runId)).status, "succeeded");

// ---- 11. a block that can't be queued as configured fails before anything is queued -----------
calls.queue.length = 0;
calls.run.length = 0;
definitions.set(92, { yaml: true, projectId: "pid", defaultBranch: "refs/heads/main" });
runParameters.set(92, {
    parameters: [{ name: "UseLease", label: "UseLease", kind: "boolean", default: "true" }],
    resources: [],
    errors: ["Unexpected value 'x'"],
});
failDefinition.add(94);
const broken = await saveChain({
    name: "Broken",
    graph: {
        nodes: [
            node("bp", 92, { params: { UseLease: "maybe" } }),
            node("cp", 93, { params: { A: "1" } }),
            node("fx", 94, { name: "Lookup", params: { A: "1" } }),
            node("after", 95),
        ],
        edges: [{ from: "bp", to: "after" }],
    },
});
run = await startChainRun(broken.id);
await tickPipelineRunner();
run = await getRun(run.runId);
assert.equal(run.states.bp.error, `Parameter "UseLease" must be true or false (Unexpected value 'x')`);
assert.match(run.states.cp.error, /classic pipeline, which has no runtime parameters/);
assert.equal(run.states.fx.error, `Couldn't check what "Lookup" consumes: Azure DevOps 404: Pipeline not found`);
assert.equal(run.states.after.status, "skipped");
assert.equal(run.status, "failed");
assert.deepEqual(queuedDefinitions(), []);
assert.deepEqual(calls.run, []);

// ---- 11b. repository resources build the branch the block names, through the Runs API ---------
calls.queue.length = 0;
calls.run.length = 0;
const templates = { alias: "templates", name: "GovernedTemplates", type: "TfsGit", project: "OneBranch.Pipelines", id: "repo-1", ref: "refs/heads/main" };
definitions.set(96, { yaml: true, projectId: "pid", defaultBranch: "refs/heads/main" });
runParameters.set(96, { parameters: [], resources: [], repositories: [templates], errors: [] });
definitions.set(97, { yaml: true, projectId: "pid", defaultBranch: "refs/heads/main" });
runParameters.set(97, { parameters: [], resources: [], repositories: [], errors: [] });
const repoChain = await saveChain({
    name: "Repos",
    graph: {
        nodes: [
            node("rp", 96, { branch: "dev", repoBranches: { Templates: "users/me/fix" } }),
            node("gone", 97, { name: "Gone", repoBranches: { templates: "users/me/fix" } }),
            node("classic", 98, { name: "Classic", repoBranches: { templates: "main" } }),
        ],
        edges: [],
    },
});
assert.deepEqual(repoChain.graph.nodes[0].repoBranches, { Templates: "users/me/fix" }, "repository branches are saved with the block");
run = await startChainRun(repoChain.id);
await tickPipelineRunner();
assert.deepEqual(
    calls.run,
    [{ definitionId: 96, branch: "refs/heads/dev", pins: [], params: undefined, repos: { templates: "refs/heads/users/me/fix" } }],
    "the YAML's alias, the branch as a ref, and its own branch as usual",
);
assert.deepEqual(queuedDefinitions(), [], "the Build API can't set them, so it isn't used");
run = await getRun(run.runId);
assert.equal(run.states.rp.status, "queued");
assert.deepEqual(run.states.rp.repoBranches, { templates: "refs/heads/users/me/fix" }, "the run records what it built against");
assert.equal(run.states.gone.error, `Repository "templates" is no longer a resource of this pipeline. Remove its branch from the block's repositories.`);
assert.equal(run.states.classic.error, `"Classic" is a classic pipeline, which has no repository resources. Clear its repository branches.`);
setBuild(96, "completed", "succeeded");
await tickPipelineRunner();
assert.equal((await getRun(run.runId)).status, "failed");
// An earlier build only counts for the same repository branches.
const repoBuilds = await appBuilds(repoChain.id);
assert.equal(repoBuilds.length, 1);
assert.equal(repoBuilds[0].repos, "templates=refs/heads/users/me/fix");

// ---- 12. every block keeps its own last result, however busy the chain gets --------------------
// ra ─┐
//     ├─> rc
// rb ─┘
for (const id of [70, 71, 72]) instantSuccess.add(id);
const parents = await saveChain({
    name: "Parents",
    graph: {
        nodes: [node("ra", 70), node("rb", 71), node("rc", 72)],
        edges: [
            { from: "ra", to: "rc" },
            { from: "rb", to: "rc" },
        ],
    },
});
const runAlone = async (nodeId) => {
    const { run: started } = await triggerNode(parents.id, nodeId);
    let done = started;
    for (let i = 0; i < 5 && done.status === "running"; i++) {
        await tickPipelineRunner();
        done = await getRun(started.runId);
    }
    assert.equal(done.status, "succeeded", `${nodeId} finished`);
    return done;
};
const runA = await runAlone("ra");
const runB = await runAlone("rb");
const runC = await runAlone("rc");
assert.deepEqual(Object.keys(runC.states), ["rc"], "running the release alone runs only the release");

const byNode = (list) => Object.fromEntries(list.map((r) => [r.nodeId, r]));
let results = byNode(await blockResults(parents.id));
assert.deepEqual(Object.keys(results).sort(), ["ra", "rb", "rc"]);
assert.equal(results.ra.runId, runA.runId, "the first parent still has its own run after the others ran");
assert.equal(results.rb.runId, runB.runId, "and so does the second");
assert.equal(results.rc.runId, runC.runId);
assert.equal(results.ra.state.status, "succeeded");
assert.equal(results.ra.state.buildNumber, runA.states.ra.buildNumber);
assert.deepEqual([results.ra.org, results.ra.project, results.ra.definitionId], ["org", "proj", 70]);

for (let i = 0; i < 25; i++) await runAlone("rc");
const { n: held } = db.prepare("SELECT COUNT(*) AS n FROM pipeline_runs WHERE chain_id = ?").get(parents.id);
assert.ok(held >= 20 && held <= 22, `history stays bounded (${held} runs)`);
results = byNode(await blockResults(parents.id));
assert.equal(results.ra.runId, runA.runId, "many later runs of other blocks never prune a block's last result");
assert.equal(results.rb.runId, runB.runId);
assert.notEqual(results.rc.runId, runC.runId, "the release's own result is its newest");
assert.ok(await getRun(runA.runId) && (await getRun(runB.runId)));

// Pointing a block at another pipeline drops its old result along with its pin on history.
await saveChain({
    id: parents.id,
    name: "Parents",
    graph: { nodes: [node("ra", 70), node("rb", 79), node("rc", 72)], edges: [{ from: "ra", to: "rc" }, { from: "rb", to: "rc" }] },
});
results = byNode(await blockResults(parents.id));
assert.equal(results.rb.definitionId, 71, "the stored result still names the pipeline it came from");
await runAlone("rc");
assert.equal(await getRun(runB.runId), null, "a run that only held a replaced pipeline's result is pruned");
assert.ok(await getRun(runA.runId), "while the untouched parent's run stays");
assert.equal(byNode(await blockResults(parents.id)).ra.runId, runA.runId);
assert.deepEqual(await blockResults("missing"), []);
closeDb();
await rm(tempDir, { recursive: true, force: true });

// ---- wiring --------------------------------------------------------------------------------
const source = (path) => readFile(new URL(path, import.meta.url), "utf8");
const main = await source("../src/service.mts");
assert.match(main, /startPipelineRunner\(/, "the background service starts the pipeline runner");
assert.match(main, /stopPipelineRunner\(/, "and stops it on shutdown");
const api = await source("../src/api.mts");
for (const route of [
    "/api/pipelines",
    "/api/pipeline-chains",
    "/api/pipeline-chain",
    "/api/pipeline-chain-builds",
    "/api/pipeline-chain-results",
    "/api/pipeline-run",
    "/api/pipeline-chains/save",
    "/api/pipeline-chains/delete",
    "/api/pipeline-chains/run",
    "/api/pipeline-runs/cancel",
    "/api/pipeline-chains/trigger",
    "/api/pipeline-runs/stop-node",
    "/api/pipeline-definition-info",
]) {
    assert.ok(api.includes(`"${route}"`), `api route ${route}`);
}
assert.match(api, /validateGraph\(/, "saved chains are validated server-side");
assert.match(api, /wakePipelineRunner\(/);

console.log("Pipeline runner harness passed");
