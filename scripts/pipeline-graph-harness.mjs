import assert from "node:assert/strict";
import {
    MAX_CHAIN_NODES,
    MAX_NODE_PARAMS,
    MAX_REPO_BRANCHES,
    advance,
    applyBuild,
    applyCommand,
    applyGraphEdit,
    appBuildsFromRuns,
    blockResultsFromRuns,
    checkParams,
    descendants,
    finalYamlResources,
    hasCycle,
    hasUpstreamBuild,
    initialNodeStates,
    lastAppBuild,
    mapRepositoryResources,
    mapRunParameters,
    normalizeBranch,
    parameterLabel,
    pipelineRunBody,
    recoverInterrupted,
    repoSignature,
    resolvePins,
    resolveRepoBranches,
    retainedRunIds,
    runOutcome,
    runToBuild,
    validateGraph,
} from "../pipeline-graph.mjs";

// Pure chain rules: validation, scheduling (AND-join, stop downstream on
// failure), ADO build mapping, outcome, and crash recovery.

const node = (id, definitionId, extra = {}) => ({
    id,
    org: "org",
    project: "proj",
    definitionId,
    name: `Pipeline ${id}`,
    path: "\\Team",
    branch: "",
    x: 0,
    y: 0,
    ...extra,
});

// ---- validation ---------------------------------------------------------------
const ok = validateGraph(
    { nodes: [node("a", 1, { x: 12.4, branch: " main " }), node("b", 2)], edges: [{ from: "a", to: "b" }] },
    ["org"],
);
assert.equal(ok.nodes.length, 2);
assert.equal(ok.nodes[0].x, 12, "positions are rounded");
assert.equal(ok.nodes[0].branch, "main", "branches are trimmed");
assert.deepEqual(ok.edges, [{ from: "a", to: "b" }]);
assert.deepEqual(validateGraph({ nodes: [], edges: [] }), { nodes: [], edges: [] }, "an empty chain is valid");

const bad = (graph, pattern, orgs) => assert.throws(() => validateGraph(graph, orgs), pattern);
bad(null, /graph/i);
bad({ nodes: [node("a", 1)], edges: [{ from: "a", to: "a" }] }, /itself/);
bad({ nodes: [node("a", 1), node("b", 2)], edges: [{ from: "a", to: "b" }, { from: "a", to: "b" }] }, /twice/);
bad(
    { nodes: [node("a", 1), node("b", 2)], edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] },
    /loop/,
);
bad({ nodes: [node("a", 1)], edges: [{ from: "a", to: "zz" }] }, /unknown/);
bad({ nodes: [node("a", 1), node("a", 2)], edges: [] }, /duplicate/i);
bad({ nodes: [node("a", 0)], edges: [] }, /definition/i);
bad({ nodes: [node("a", 1, { project: " " })], edges: [] }, /project/i);
bad({ nodes: [node("a b", 1)], edges: [] }, /id/i);
bad({ nodes: [node("a", 1, { org: "other" })], edges: [] }, /not a configured/, ["org"]);
bad({ nodes: Array.from({ length: MAX_CHAIN_NODES + 1 }, (_, i) => node(`n${i}`, i + 1)), edges: [] }, /at most/);

assert.equal(hasCycle(["a", "b", "c"], [{ from: "a", to: "b" }, { from: "b", to: "c" }]), false);
assert.equal(hasCycle(["a", "b", "c"], [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }]), true);

assert.equal(normalizeBranch(""), "");
assert.equal(normalizeBranch("  "), "");
assert.equal(normalizeBranch("main"), "refs/heads/main");
assert.equal(normalizeBranch("users/me/fix"), "refs/heads/users/me/fix");
assert.equal(normalizeBranch("refs/tags/v1"), "refs/tags/v1");

// ---- scheduling ---------------------------------------------------------------
// a ─┐
//    ├─> c ─> d        e (independent)
// b ─┘
const graph = validateGraph({
    nodes: [node("a", 1), node("b", 2), node("c", 3), node("d", 4), node("e", 5)],
    edges: [
        { from: "a", to: "c" },
        { from: "b", to: "c" },
        { from: "c", to: "d" },
    ],
});
let states = initialNodeStates(graph);
assert.deepEqual(Object.values(states).map((s) => s.status), Array(5).fill("waiting"));

let step = advance(graph, states, false);
assert.deepEqual(step.ready, ["a", "b", "e"], "roots start together");
assert.equal(states.a.status, "waiting", "advance does not mutate its input");

states = { ...step.states, a: { status: "succeeded" }, b: { status: "running", buildId: 7 }, e: { status: "queued" } };
step = advance(graph, states, false);
assert.deepEqual(step.ready, [], "a join waits for every upstream pipeline");

states = { ...step.states, b: { status: "partiallySucceeded" } };
step = advance(graph, states, false);
assert.deepEqual(step.ready, ["c"], "partially succeeded counts as passing, like ADO's succeeded()");

states = { ...step.states, c: { status: "failed" } };
step = advance(graph, states, false);
assert.equal(step.states.d.status, "skipped", "a failure skips everything downstream");
assert.match(step.states.d.error, /upstream/i);
assert.equal(step.states.e.status, "queued", "independent branches keep going");
assert.equal(runOutcome(step.states), null, "the run is still going while e is queued");
step.states.e = { status: "succeeded" };
assert.equal(runOutcome(step.states), "failed");

// Cancellation skips what has not started and starts nothing new.
step = advance(graph, initialNodeStates(graph), true);
assert.deepEqual(step.ready, []);
assert.ok(Object.values(step.states).every((s) => s.status === "skipped"));
assert.equal(runOutcome(step.states), "canceled");

// Skips propagate through several levels in one call.
const chain3 = validateGraph({
    nodes: [node("x", 1), node("y", 2), node("z", 3)],
    edges: [{ from: "x", to: "y" }, { from: "y", to: "z" }],
});
step = advance(chain3, { x: { status: "error", error: "boom" }, y: { status: "waiting" }, z: { status: "waiting" } }, false);
assert.equal(step.states.z.status, "skipped");
assert.equal(step.changed, true);

assert.equal(runOutcome({ a: { status: "succeeded" }, b: { status: "partiallySucceeded" } }), "succeeded");
assert.equal(runOutcome({ a: { status: "canceled" }, b: { status: "skipped" } }), "canceled");
assert.equal(runOutcome({ a: { status: "error" }, b: { status: "canceled" } }), "failed");

// ---- per-block runs: scope, joining a live run, fan-in, stop ------------------------------
assert.deepEqual(descendants(graph, "a"), ["c", "d"]);
assert.deepEqual(descendants(graph, "c"), ["d"]);
assert.deepEqual(descendants(graph, "e"), []);

// Running one block includes only it and what follows it.
states = initialNodeStates(graph, "a");
assert.deepEqual(states, { a: { status: "waiting", manual: true }, c: { status: "waiting" }, d: { status: "waiting" } });
step = advance(graph, states, false);
assert.deepEqual(Object.keys(step.states), ["a", "c", "d"], "blocks outside the run are not added");
assert.deepEqual(step.ready, ["a"]);
step = advance(graph, { ...step.states, a: { status: "succeeded" } }, false);
assert.deepEqual(step.ready, ["c"], "an upstream outside the run is not waited for");
const scopedDone = { a: { status: "succeeded" }, c: { status: "succeeded" }, d: { status: "succeeded" } };
assert.equal(runOutcome(scopedDone), "succeeded", "the outcome covers only blocks in the run");

// b joins while a is running: c now waits for both and becomes ready once.
const cmd = (kind, nodeId) => ({ kind, nodeId });
let live = { ...initialNodeStates(graph, "a"), a: { status: "running", buildId: 1, manual: true } };
let res = applyCommand(graph, live, cmd("trigger", "b"), false);
assert.equal(res.error, null);
assert.deepEqual(res.states.b, { status: "waiting", manual: true });
assert.equal(res.states.c.status, "waiting");
assert.equal(live.b, undefined, "applyCommand does not mutate its input");
step = advance(graph, res.states, false);
assert.deepEqual(step.ready, ["b"], "c waits for a (running) and b (waiting)");
step = advance(graph, { ...step.states, a: { status: "succeeded" }, b: { status: "running", buildId: 2 } }, false);
assert.deepEqual(step.ready, [], "c still waits for b");
live = { ...step.states, b: { status: "succeeded" } };
step = advance(graph, live, false);
assert.deepEqual(step.ready, ["c"], "c starts once every upstream in the run passed");
step = advance(graph, { ...step.states, c: { status: "queuing" } }, false);
assert.deepEqual(step.ready, [], "and is never readied twice");

// Conflicts are rejected and leave the states untouched.
const reject = (s, command, canceled, pattern) => {
    const r = applyCommand(graph, s, command, canceled);
    assert.match(r.error ?? "", pattern);
    assert.equal(r.states, s);
};
live = { a: { status: "running", buildId: 1, manual: true }, c: { status: "waiting" }, d: { status: "waiting" } };
reject(live, cmd("trigger", "zz"), false, /not part of this run/i);
reject(live, cmd("trigger", "b"), true, /stopping/i);
reject(live, cmd("trigger", "a"), false, /"Pipeline a" is already running/);
reject(live, cmd("trigger", "c"), false, /already waiting/i);
live = { a: { status: "succeeded" }, c: { status: "running", buildId: 3 }, d: { status: "waiting" } };
reject(live, cmd("trigger", "a"), false, /Can't start "Pipeline a" while "Pipeline c" is running/);
reject({ ...live, c: { status: "queuing" } }, cmd("trigger", "a"), false, /while "Pipeline c" is running/);

// Re-running a finished block resets what follows it, not its siblings.
live = { a: { status: "succeeded" }, b: { status: "succeeded" }, c: { status: "failed" }, d: { status: "skipped" }, e: { status: "succeeded" } };
res = applyCommand(graph, live, cmd("trigger", "a"), false);
assert.equal(res.error, null);
assert.deepEqual(res.states.a, { status: "waiting", manual: true });
assert.deepEqual(res.states.c, { status: "waiting" });
assert.deepEqual(res.states.d, { status: "waiting" });
assert.equal(res.states.b.status, "succeeded");
assert.equal(res.states.e.status, "succeeded");
step = advance(graph, { ...res.states, a: { status: "succeeded" } }, false);
assert.deepEqual(step.ready, ["c"]);

// A manual block ignores its own upstream: re-running c alone does not wait for a or b.
res = applyCommand(graph, { a: { status: "failed" }, b: { status: "succeeded" }, c: { status: "skipped" }, d: { status: "skipped" } }, cmd("trigger", "c"), false);
assert.equal(res.error, null);
step = advance(graph, res.states, false);
assert.deepEqual(step.ready, ["c"], "a manual start ignores failed upstream blocks");

// A failed upstream in the run skips the shared block and names the blocker.
live = {
    a: { status: "failed", manual: true },
    b: { status: "running", buildId: 2, manual: true },
    c: { status: "waiting" },
    d: { status: "waiting" },
};
step = advance(graph, live, false);
assert.equal(step.states.c.status, "skipped");
assert.match(step.states.c.error, /upstream "Pipeline a"/);
assert.match(step.states.d.error, /upstream "Pipeline c"/);
assert.equal(step.states.b.status, "running");

// Stop one block.
live = { a: { status: "running", buildId: 1 }, b: { status: "queuing" }, c: { status: "waiting" }, d: { status: "waiting" }, e: { status: "succeeded" } };
reject(live, cmd("stop", "zz"), false, /not part of this run/i);
reject({ a: live.a }, cmd("stop", "c"), false, /not part of this run/i);
reject(live, cmd("stop", "b"), false, /being queued/i);
reject(live, cmd("stop", "c"), false, /isn't running/i);
reject(live, cmd("stop", "e"), false, /already finished/i);
res = applyCommand(graph, live, cmd("stop", "a"), false);
assert.equal(res.error, null);
assert.equal(res.states.a.stopRequested, true);
assert.equal(res.states.a.status, "running");
const again = applyCommand(graph, res.states, cmd("stop", "a"), false);
assert.equal(again.error, null, "stopping twice is a no-op");
assert.equal(again.states, res.states);
// Once the stopped build is canceled, only what follows it is skipped.
step = advance(graph, { ...res.states, a: { status: "canceled", stopRequested: true }, b: { status: "running", buildId: 2 } }, false);
assert.equal(step.states.c.status, "skipped");
assert.equal(step.states.d.status, "skipped");
assert.equal(step.states.b.status, "running", "independent blocks keep running");

// ---- ADO build mapping ----------------------------------------------------------
const build = (status, result, extra = {}) => ({
    id: 42,
    buildNumber: "20240301.4",
    status,
    result,
    url: "https://dev.azure.com/org/proj/_build/results?buildId=42",
    startTime: "2024-03-01T10:00:00Z",
    finishTime: status === "completed" ? "2024-03-01T10:05:00Z" : undefined,
    ...extra,
});
assert.equal(applyBuild({ status: "queuing" }, build("notStarted")).status, "queued");
assert.equal(applyBuild({ status: "queued" }, build("postponed")).status, "queued");
assert.equal(applyBuild({ status: "queued" }, build("inProgress")).status, "running");
assert.equal(applyBuild({ status: "running" }, build("cancelling")).status, "running");
const done = applyBuild({ status: "running", pollFailures: 3, pollError: "x", cancelSent: true }, build("completed", "succeeded"));
assert.equal(done.status, "succeeded");
assert.equal(done.buildId, 42);
assert.equal(done.buildNumber, "20240301.4");
assert.equal(done.finishedAt, "2024-03-01T10:05:00Z");
assert.equal(done.pollFailures, undefined, "a successful poll clears transient poll errors");
assert.equal(done.pollError, undefined);
assert.equal(done.cancelSent, true, "the cancel marker survives so cancel is sent once");
assert.equal(applyBuild({ status: "running" }, build("completed", "partiallySucceeded")).status, "partiallySucceeded");
assert.equal(applyBuild({ status: "running" }, build("completed", "canceled")).status, "canceled");
assert.equal(applyBuild({ status: "running" }, build("completed", "failed")).status, "failed");
assert.equal(applyBuild({ status: "running" }, build("completed", "none")).status, "failed");

// ---- crash recovery -----------------------------------------------------------------
// A node left "queuing" may or may not exist in ADO; never queue it twice.
const recovered = recoverInterrupted({ a: { status: "queuing" }, b: { status: "running", buildId: 1 }, c: { status: "waiting" } });
assert.equal(recovered.changed, true);
assert.equal(recovered.states.a.status, "error");
assert.match(recovered.states.a.error, /Azure DevOps/);
assert.equal(recovered.states.b.status, "running", "builds with an id resume polling");
assert.equal(recoverInterrupted({ a: { status: "waiting" } }).changed, false);

// ---- parameter overrides ----------------------------------------------------------------
const paramsOf = (params) => validateGraph({ nodes: [node("a", 1, { params })], edges: [] }).nodes[0];
const tricky = paramsOf(JSON.parse('{"Region":"westus","__proto__":"x"}')).params;
assert.deepEqual(Object.keys(tricky), ["Region", "__proto__"], "a __proto__ name is kept as data");
assert.equal(Object.getPrototypeOf(tricky), Object.prototype);
assert.equal("params" in paramsOf({}), false, "no overrides, no key");
assert.equal("params" in paramsOf(undefined), false);
bad({ nodes: [node("a", 1, { params: { X: 1 } })], edges: [] }, /must be text/);
bad({ nodes: [node("a", 1, { params: ["x"] })], edges: [] }, /name\/value/);
bad({ nodes: [node("a", 1, { params: { X: "y".repeat(10_001) } })], edges: [] }, /too long/);
bad({ nodes: [node("a", 1, { params: { "": "x" } })], edges: [] }, /parameter name/i);
bad({ nodes: [node("a", 1, { params: { ["k".repeat(257)]: "" } })], edges: [] }, /parameter name/i);
bad(
    { nodes: [node("a", 1, { params: Object.fromEntries(Array.from({ length: MAX_NODE_PARAMS + 1 }, (_, i) => [`p${i}`, ""])) })], edges: [] },
    /at most/,
);

// ---- live edits -------------------------------------------------------------------------
const chain = (ids, pairs) => ({
    nodes: ids.map((id) => node(id, id.charCodeAt(0))),
    edges: pairs.map(([from, to]) => ({ from, to })),
});
const busy = { status: "running", buildId: 1 };
const idle = { status: "waiting" };
// A block added after a block still in flight joins the run, and so does what follows it.
let edit = applyGraphEdit(chain(["a", "b"], [["a", "b"]]), chain(["a", "b", "c", "d"], [["a", "b"], ["b", "c"], ["c", "d"]]), { a: busy, b: idle }, false);
assert.deepEqual(Object.keys(edit.states).sort(), ["a", "b", "c", "d"]);
assert.equal(edit.states.c.status, "waiting");
assert.equal(edit.states.d.status, "waiting");
assert.equal(edit.states.a, busy, "running blocks are untouched");
edit = applyGraphEdit(chain(["a"], []), chain(["a", "c"], [["a", "c"]]), { a: busy }, false);
assert.deepEqual(edit.states.c, { status: "waiting" }, "a block after a running one joins");
// Nothing joins after a finished block, an out-of-run block, or while the run stops.
edit = applyGraphEdit(chain(["a", "b"], []), chain(["a", "b", "c", "x"], [["a", "c"], ["x", "b"]]), { a: { status: "succeeded" }, b: idle }, false);
assert.equal(edit.states.c, undefined, "an edit never starts a pipeline after a finished block");
assert.equal(edit.states.x, undefined, "a new block before a waiting one does not run");
assert.deepEqual(edit.states.b, idle);
edit = applyGraphEdit(chain(["a", "b"], [["a", "b"]]), chain(["a", "b", "c"], [["a", "b"], ["b", "c"]]), { a: busy, b: idle }, true);
assert.equal(edit.states.c, undefined, "no joins while the run is stopping");
// Never-start: a waiting block that the edit alone would make ready leaves the run, with its followers.
edit = applyGraphEdit(chain(["a", "b", "c"], [["a", "b"], ["b", "c"]]), chain(["a", "b", "c"], [["b", "c"]]), { a: busy, b: idle, c: idle }, false);
assert.deepEqual(Object.keys(edit.states), ["a"]);
// ...but a block that was already ready (about to be queued) stays.
edit = applyGraphEdit(chain(["a", "b"], [["a", "b"]]), chain(["a", "b", "z"], [["a", "b"]]), { a: { status: "succeeded" }, b: idle }, false);
assert.deepEqual(edit.states.b, idle);
assert.equal(edit.states.z, undefined);
const manualWait = { status: "waiting", manual: true };
edit = applyGraphEdit(chain(["a", "b"], [["a", "b"]]), chain(["a", "b"], []), { a: busy, b: manualWait }, false);
assert.equal(edit.states.b, manualWait, "a block started on its own was ready already");
// Removed blocks drop their state; a block still building is kept, unconnected.
edit = applyGraphEdit(chain(["a", "b", "c"], [["a", "b"]]), chain(["c"], []), { a: busy, b: idle, c: { status: "failed" } }, false);
assert.deepEqual(edit.graph.nodes.map((n) => n.id), ["c", "a"]);
assert.deepEqual(edit.graph.edges, []);
assert.deepEqual(Object.keys(edit.states).sort(), ["a", "c"]);
// Parameter and branch edits flow into the run graph.
edit = applyGraphEdit(chain(["a"], []), { nodes: [node("a", 97, { branch: "dev", params: { X: "1" } })], edges: [] }, { a: idle }, false);
assert.equal(edit.graph.nodes[0].branch, "dev");
assert.deepEqual(edit.graph.nodes[0].params, { X: "1" });

// ---- consuming an upstream build -------------------------------------------------------------
const official = (id, extra = {}) => node(id, 10, { name: "Svc-Official", path: "\\OneBranch\\Svc", ...extra });
const release = node("rel", 20, { name: "Release" });
const passed = (buildNumber, status = "succeeded") => ({ status, buildNumber });
const resource = (name, project) => ({ alias: "svc", name, ...(project ? { project } : {}) });
let pg = { nodes: [official("bld"), release], edges: [{ from: "bld", to: "rel" }] };
let ps = { bld: passed("1.0.1"), rel: idle };
assert.deepEqual(resolvePins(pg, ps, "rel", [resource("Svc-Official", "proj")]), {
    pins: [{ alias: "svc", version: "1.0.1", from: "bld" }],
    error: null,
});
assert.equal(hasUpstreamBuild(pg, ps, "rel"), true);
assert.equal(hasUpstreamBuild(pg, ps, "bld"), false);
const pinCount = (graph, states, resources) => resolvePins(graph, states, "rel", resources).pins.length;
assert.equal(pinCount(pg, ps, [resource("svc-official", "PROJ")]), 1, "names and projects match case-insensitively");
assert.equal(pinCount(pg, ps, [resource("svc-official")]), 1, "no project means the consumer's project");
assert.equal(pinCount(pg, ps, [resource("\\OneBranch\\Svc\\Svc-Official")]), 1, "a source with a folder matches the full path");
assert.equal(pinCount(pg, ps, [resource("\\Other\\Svc-Official")]), 0);
assert.equal(pinCount(pg, ps, [resource("Svc-Official", "other")]), 0);
assert.equal(pinCount(pg, ps, [resource("Unrelated")]), 0, "a resource no block built keeps the default");
assert.equal(pinCount({ ...pg, nodes: [official("bld", { org: "org2" }), release] }, ps, [resource("Svc-Official")]), 0);
assert.equal(pinCount(pg, { bld: passed("1.0.1", "partiallySucceeded"), rel: idle }, [resource("Svc-Official")]), 1);
assert.equal(pinCount(pg, { bld: { status: "failed", buildNumber: "1.0.1" }, rel: idle }, [resource("Svc-Official")]), 0);
assert.equal(pinCount(pg, { bld: { status: "succeeded" }, rel: idle }, [resource("Svc-Official")]), 0);
assert.equal(pinCount(pg, { rel: idle }, [resource("Svc-Official")]), 0, "a block outside this run has no build to give");
assert.equal(pinCount({ ...pg, edges: [] }, ps, [resource("Svc-Official")]), 0, "only blocks before it count");
// Through other blocks, the nearest build of that pipeline wins; a tie is an error.
pg = {
    nodes: [official("b1"), official("b2"), node("t", 30, { name: "Tests" }), release],
    edges: [{ from: "b1", to: "t" }, { from: "t", to: "rel" }, { from: "b2", to: "rel" }],
};
ps = { b1: passed("1.0.1"), b2: passed("1.0.2"), t: passed("7"), rel: idle };
assert.deepEqual(resolvePins(pg, ps, "rel", [resource("Svc-Official")]).pins, [{ alias: "svc", version: "1.0.2", from: "b2" }]);
assert.deepEqual(
    resolvePins({ ...pg, edges: pg.edges.slice(0, 2) }, ps, "rel", [resource("Svc-Official")]).pins,
    [{ alias: "svc", version: "1.0.1", from: "b1" }],
    "a transitive upstream build is consumed",
);
const tie = resolvePins({ ...pg, edges: [{ from: "b1", to: "rel" }, { from: "b2", to: "rel" }] }, ps, "rel", [resource("Svc-Official")]);
assert.deepEqual(tie.pins, []);
assert.match(tie.error, /2 blocks equally close before it have a build of that pipeline/);

// ---- consuming a build from an earlier run of the chain ----------------------------------------
const histGraph = (bldExtra = {}) => ({ nodes: [official("bld", bldExtra), release], edges: [{ from: "bld", to: "rel" }] });
let past = appBuildsFromRuns([
    { runId: "r3", graph: histGraph(), states: { bld: { status: "failed", buildNumber: "1.0.3" } } },
    { runId: "r2", graph: histGraph(), states: { bld: { ...passed("1.0.2"), buildId: 22, url: "https://x/22", finishedAt: "2024-01-02T00:00:00Z", branch: "" } } },
    { runId: "r1", graph: histGraph(), states: { bld: passed("1.0.1"), rel: passed("9") } },
    { runId: "r0", graph: histGraph({ branch: "dev" }), states: { bld: passed("0.9.0") } },
]);
assert.deepEqual(
    past.map((b) => [b.nodeId, b.runId, b.branch, b.buildNumber]),
    [
        ["bld", "r2", "", "1.0.2"],
        ["rel", "r1", "", "9"],
        ["bld", "r0", "refs/heads/dev", "0.9.0"],
    ],
    "newest passed build per block, pipeline, and branch; a failed newer build is skipped",
);
assert.deepEqual(past[0], {
    nodeId: "bld",
    runId: "r2",
    org: "org",
    project: "proj",
    definitionId: 10,
    branch: "",
    buildNumber: "1.0.2",
    buildId: 22,
    url: "https://x/22",
    finishedAt: "2024-01-02T00:00:00Z",
});
// The branch it was queued on wins over the block's branch at the time.
assert.equal(appBuildsFromRuns([{ runId: "r", graph: histGraph({ branch: "dev" }), states: { bld: { ...passed("1"), branch: "refs/heads/main" } } }])[0].branch, "refs/heads/main");
assert.equal(lastAppBuild(official("bld"), past).buildNumber, "1.0.2");
assert.equal(lastAppBuild(official("bld", { branch: "dev" }), past).buildNumber, "0.9.0", "branches normalize");
assert.equal(lastAppBuild(official("bld", { branch: "main" }), past), undefined, "another branch has no build yet");
assert.equal(lastAppBuild(official("bld", { definitionId: 11 }), past), undefined, "another pipeline has no build yet");
assert.equal(lastAppBuild(official("bld", { project: "PROJ", org: "ORG" }), past).buildNumber, "1.0.2");
// A block that follows a PR takes only builds it made following that PR, whatever the branch was called.
{
    const prPast = appBuildsFromRuns([
        { runId: "p2", graph: histGraph({ branch: "" }), states: { bld: { ...passed("2.0.0"), branch: "refs/heads/feature", followed: "org/7" } } },
        { runId: "p1", graph: histGraph({ branch: "" }), states: { bld: { ...passed("1.9.0"), branch: "refs/heads/main" } } },
    ]);
    assert.equal(prPast.length, 2, "builds that followed a PR are kept apart from fixed-branch ones");
    assert.equal(lastAppBuild(official("bld", { branchFrom: { org: "Org", prId: 7 } }), prPast).buildNumber, "2.0.0");
    assert.equal(lastAppBuild(official("bld", { branchFrom: { org: "org", prId: 8 } }), prPast), undefined, "not another PR's build");
    assert.equal(lastAppBuild(official("bld", { branch: "main" }), prPast).buildNumber, "1.9.0", "a fixed branch ignores PR builds' tags");
    assert.equal(lastAppBuild(official("bld", { branchFrom: { org: "org", prId: 7 } }), [prPast[1]]), undefined, "not a build made on a fixed branch");
}
assert.equal(lastAppBuild(official("other"), past), undefined, "matched by block, not pipeline");
// Built against other branches of its repository resources, it's another build.
{
    const repoPast = appBuildsFromRuns([
        { runId: "q2", graph: histGraph(), states: { bld: { ...passed("3.0.1"), branch: "", repoBranches: { templates: "refs/heads/fix" } } } },
        { runId: "q1", graph: histGraph(), states: { bld: { ...passed("3.0.0"), branch: "" } } },
    ]);
    assert.equal(repoPast.length, 2, "kept apart by their repository branches");
    assert.equal(repoPast[0].repos, "templates=refs/heads/fix");
    assert.equal("repos" in repoPast[1], false);
    assert.equal(lastAppBuild(official("bld"), repoPast).buildNumber, "3.0.0", "a block on the YAML's refs takes the build made on them");
    assert.equal(lastAppBuild(official("bld", { repoBranches: { Templates: "fix" } }), repoPast).buildNumber, "3.0.1");
    assert.equal(lastAppBuild(official("bld", { repoBranches: { templates: "other" } }), repoPast), undefined);
}
// A block started on its own, or after its upstream failed, consumes the earlier build.
pg = histGraph();
assert.deepEqual(resolvePins(pg, { rel: idle }, "rel", [resource("Svc-Official")], past), {
    pins: [{ alias: "svc", version: "1.0.2", from: "bld", runId: "r2" }],
    error: null,
});
assert.equal(hasUpstreamBuild(pg, { rel: idle }, "rel", past), true);
assert.equal(hasUpstreamBuild(pg, { rel: idle }, "rel"), false);
assert.equal(resolvePins(pg, { bld: { status: "failed", buildNumber: "1.0.4" }, rel: idle }, "rel", [resource("Svc-Official")], past).pins[0].version, "1.0.2");
assert.deepEqual(resolvePins(pg, { bld: passed("1.0.5"), rel: idle }, "rel", [resource("Svc-Official")], past).pins, [
    { alias: "svc", version: "1.0.5", from: "bld" },
], "this run's build beats an earlier one");
assert.equal(resolvePins(histGraph({ branch: "main" }), { rel: idle }, "rel", [resource("Svc-Official")], past).pins.length, 0, "a changed branch keeps the default");
// Equally close: this run's build beats an earlier run's; two earlier builds still tie.
pg = { nodes: [official("b1"), official("b2"), release], edges: [{ from: "b1", to: "rel" }, { from: "b2", to: "rel" }] };
const pastTwo = appBuildsFromRuns([{ runId: "r1", graph: pg, states: { b1: passed("1.0.1"), b2: passed("1.0.2") } }]);
assert.deepEqual(resolvePins(pg, { b2: passed("2.0.0"), rel: idle }, "rel", [resource("Svc-Official")], pastTwo).pins, [
    { alias: "svc", version: "2.0.0", from: "b2" },
]);
assert.match(resolvePins(pg, { rel: idle }, "rel", [resource("Svc-Official")], pastTwo).error, /Remove one of the arrows/);
// A build from this run beats any from an earlier run, however near; among earlier ones the nearest wins.
pg = {
    nodes: [official("b1"), official("b2"), node("t", 30, { name: "Tests" }), release],
    edges: [{ from: "b1", to: "t" }, { from: "t", to: "rel" }, { from: "b2", to: "rel" }],
};
assert.deepEqual(
    resolvePins(pg, { b1: passed("3.0.0"), t: passed("7"), rel: idle }, "rel", [resource("Svc-Official")], pastTwo).pins,
    [{ alias: "svc", version: "3.0.0", from: "b1" }],
);
assert.deepEqual(resolvePins(pg, { rel: idle }, "rel", [resource("Svc-Official")], pastTwo).pins, [
    { alias: "svc", version: "1.0.2", from: "b2", runId: "r1" },
]);

// ---- each block's last result, across runs -----------------------------------------------------
const rg = { nodes: [node("pa", 11), node("pb", 12), node("pc", 13)], edges: [{ from: "pa", to: "pc" }, { from: "pb", to: "pc" }] };
const lastRuns = [
    { runId: "r5", graph: rg, states: { pa: { status: "failed", buildNumber: "a3" }, pc: { status: "skipped" } } },
    { runId: "r4", graph: rg, states: { pc: { status: "failed", buildNumber: "c2" } } },
    { runId: "r3", graph: rg, states: { pb: passed("b2"), pc: { status: "waiting" } } },
    { runId: "r2", graph: rg, states: { pa: passed("a2"), pc: { status: "skipped" } } },
    { runId: "r1", graph: rg, states: { pa: passed("a1"), pb: passed("b1"), pc: passed("c1") } },
];
assert.deepEqual(
    blockResultsFromRuns(lastRuns).map((r) => [r.nodeId, r.runId, r.state.buildNumber]),
    [
        ["pa", "r5", "a3"],
        ["pc", "r4", "c2"],
        ["pb", "r3", "b2"],
    ],
    "the newest run where each block ran (failed counts); skipped and waiting entries never hide an earlier result",
);
assert.deepEqual(blockResultsFromRuns(lastRuns)[0], { nodeId: "pa", runId: "r5", org: "org", project: "proj", definitionId: 11, state: lastRuns[0].states.pa });
assert.deepEqual(blockResultsFromRuns([]), []);
assert.deepEqual(
    blockResultsFromRuns([{ runId: "s", graph: { nodes: [node("pa", 99)], edges: [] }, states: { pa: passed("x") } }, ...lastRuns])
        .filter((r) => r.nodeId === "pa")
        .map((r) => [r.runId, r.definitionId]),
    [["s", 99], ["r5", 11]],
    "a block pointed at another pipeline keeps a result for each",
);

// Busy chains: the runs holding a block's last result or last build outlive the recent-run cap.
const manyRuns = [
    ...[6, 5, 4, 3, 2, 1].map((i) => ({ runId: `p${i}`, graph: rg, states: { pc: passed(`c${i}`) } })),
    { runId: "r1", graph: rg, states: { pa: passed("a1"), pb: passed("b1"), pc: passed("c0") } },
];
assert.deepEqual([...retainedRunIds(manyRuns, rg, 3)].sort(), ["p4", "p5", "p6", "r1"]);
assert.deepEqual([...retainedRunIds(manyRuns, rg, 99)].sort(), ["p1", "p2", "p3", "p4", "p5", "p6", "r1"], "nothing is dropped under the cap");
const onlyPa = [{ runId: "o2", graph: rg, states: { pc: passed("c") } }, { runId: "o1", graph: rg, states: { pa: passed("a") } }];
assert.deepEqual([...retainedRunIds(onlyPa, rg, 1)].sort(), ["o1", "o2"]);
assert.deepEqual([...retainedRunIds(onlyPa, { nodes: [node("pb", 12), node("pc", 13)], edges: [] }, 1)], ["o2"], "a removed block pins no run");
assert.deepEqual([...retainedRunIds(onlyPa, { nodes: [node("pa", 99), node("pc", 13)], edges: [] }, 1)], ["o2"], "nor does one pointed at another pipeline");
assert.deepEqual([...retainedRunIds(onlyPa, { nodes: [node("pa", 11, { org: "ORG", project: "PROJ" })], edges: [] }, 0)], ["o1"], "organization and project match without case");

assert.equal(parameterLabel("Why?\n_____\nDescribe it", "n"), "Why? — Describe it");
assert.equal(parameterLabel("___", "n"), "n");
assert.equal(parameterLabel(undefined, "n"), "n");
assert.deepEqual(mapRunParameters("nope"), []);
const defs = mapRunParameters([
    { name: "Description", displayName: "Why\n____\nDescribe", type: 4, default: "x", values: ["x", "y"] },
    { name: "UseLease", type: 3, default: "true" },
    { name: "Count", type: 2, default: "3" },
    { name: "Regions", type: 1, default: "- westus" },
    { name: "Plain", type: 0 },
    { name: "Mystery", type: 99, default: { a: 1 } },
    { name: "MysteryList", type: 99, default: "a", values: ["a", "b"] },
    { name: "Flag", type: 3, default: true, values: [true, false] },
    { name: "" },
    null,
]);
assert.deepEqual(defs, [
    { name: "Description", label: "Why — Describe", kind: "string", default: "x", values: ["x", "y"] },
    { name: "UseLease", label: "UseLease", kind: "boolean", default: "true" },
    { name: "Count", label: "Count", kind: "number", default: "3" },
    { name: "Regions", label: "Regions", kind: "object", default: "- westus" },
    { name: "Plain", label: "Plain", kind: "string", default: "" },
    { name: "Mystery", label: "Mystery", kind: "object", default: '{"a":1}' },
    { name: "MysteryList", label: "MysteryList", kind: "string", default: "a", values: ["a", "b"] },
    { name: "Flag", label: "Flag", kind: "boolean", default: "true" },
]);
assert.equal(checkParams(undefined, defs), null);
assert.equal(checkParams({ Description: "y", UseLease: "False", Count: "2.5", Regions: "- eastus" }, defs), null);
assert.match(checkParams({ Gone: "1" }, defs), /no longer exists/);
assert.match(checkParams({ UseLease: "yes" }, defs), /true or false/);
assert.match(checkParams({ Count: "abc" }, defs), /must be a number/);
assert.match(checkParams({ Count: " " }, defs), /must be a number/);
assert.match(checkParams({ Description: "z" }, defs), /must be one of: x, y/);

// ---- Runs API ---------------------------------------------------------------------------------
assert.deepEqual(pipelineRunBody("main", [], undefined), { resources: { repositories: { self: { refName: "refs/heads/main" } } } });
assert.deepEqual(pipelineRunBody("", [{ alias: "svc", version: "1.0.1", from: "bld" }], { A: "1" }), {
    resources: { pipelines: { svc: { version: "1.0.1" } } },
    templateParameters: { A: "1" },
});
assert.deepEqual(pipelineRunBody("", [], {}), { resources: {} });
// Repository resources: their branches beside the pipeline's own, as refs; `self` never comes from them.
assert.deepEqual(pipelineRunBody("dev", [], undefined, { templates: "users/me/fix", tags: "refs/tags/v1" }), {
    resources: {
        repositories: {
            self: { refName: "refs/heads/dev" },
            templates: { refName: "refs/heads/users/me/fix" },
            tags: { refName: "refs/tags/v1" },
        },
    },
});
assert.deepEqual(pipelineRunBody("", [], undefined, { templates: "main", self: "x", blank: " " }), {
    resources: { repositories: { templates: { refName: "refs/heads/main" } } },
});

// ---- repository resources -----------------------------------------------------------------------
// The shape the run-parameters data provider returns (trimmed from a real response).
assert.deepEqual(
    mapRepositoryResources([
        {
            alias: "templates",
            name: "GovernedTemplates",
            id: "567accef",
            type: "TfsGit",
            refName: "refs/heads/main",
            version: "8faab0c",
            projectName: "OneBranch.Pipelines",
            projectId: "11ddb27a",
        },
        { alias: "self", name: "Svc", type: "TfsGit", refName: "refs/heads/dev" },
        { alias: "Templates", name: "dupe", type: "TfsGit" },
        { alias: "gh", name: "org/tools", type: "GitHub", refName: "release" },
        { name: "no alias" },
        null,
    ]),
    [
        { alias: "templates", name: "GovernedTemplates", type: "TfsGit", project: "OneBranch.Pipelines", id: "567accef", ref: "refs/heads/main" },
        { alias: "gh", name: "org/tools", type: "GitHub", ref: "refs/heads/release" },
    ],
);
assert.deepEqual(mapRepositoryResources(undefined), []);
const yamlRepos = mapRepositoryResources([{ alias: "templates", name: "GovernedTemplates", type: "TfsGit", refName: "refs/heads/main" }]);
assert.deepEqual(resolveRepoBranches({ Templates: "users/me/fix" }, yamlRepos), { refs: { templates: "refs/heads/users/me/fix" }, error: null }, "the YAML's spelling");
assert.deepEqual(resolveRepoBranches(undefined, yamlRepos), { refs: undefined, error: null });
assert.deepEqual(resolveRepoBranches({ templates: "  " }, yamlRepos), { refs: undefined, error: null });
assert.match(resolveRepoBranches({ gone: "x" }, yamlRepos).error, /Repository "gone" is no longer a resource of this pipeline/);
assert.equal(repoSignature({ Templates: "fix", a: "refs/tags/v1" }), "a=refs/tags/v1\ntemplates=refs/heads/fix");
assert.equal(repoSignature({ templates: "refs/heads/fix" }), repoSignature({ TEMPLATES: "fix" }), "aliases and refs normalize");
assert.equal(repoSignature(undefined), "");

// The Preview API's finalYaml, in the layout Azure DevOps writes it.
const finalYaml = [
    "parameters:",
    "- name: resources",
    "  type: object",
    "  default:",
    "    repositories:",
    "    - repository: notThis",
    "resources:",
    "  repositories:",
    "  - repository: self",
    "    type: git",
    "    ref: refs/heads/dev",
    "  - repository: Templates",
    "    type: git",
    "    name: OneBranch.Pipelines/GovernedTemplates",
    "    ref: 'refs/heads/users/me/it''s'",
    "    trigger:",
    "      branches:",
    "        include:",
    "        - main",
    "  - repository: gh",
    "    type: github",
    '    name: "org/tools"',
    "    endpoint: gh-conn # a comment",
    "  - repository: templates",
    "    name: dupe",
    "  - repository: plain",
    "  pipelines:",
    "  - pipeline: build",
    "    source: My Build",
    "    project: Other",
    "  - pipeline: nosource",
    "variables:",
    "- name: x",
    "  value: y",
].join("\n");
assert.deepEqual(finalYamlResources(finalYaml), {
    repositories: [
        { alias: "Templates", name: "GovernedTemplates", type: "TfsGit", project: "OneBranch.Pipelines", ref: "refs/heads/users/me/it's" },
        { alias: "gh", name: "org/tools", type: "GitHub", ref: "" },
        { alias: "plain", name: "plain", type: "TfsGit", ref: "" },
    ],
    pipelines: [{ alias: "build", name: "My Build", project: "Other" }],
});
assert.deepEqual(finalYamlResources("steps:\n- script: echo hi\n"), { repositories: [], pipelines: [] });
assert.deepEqual(
    finalYamlResources("resources:\r\n  repositories:\r\n    - repository: deep\r\n      ref: main\r\n"),
    { repositories: [{ alias: "deep", name: "deep", type: "TfsGit", ref: "refs/heads/main" }], pipelines: [] },
    "items indented under their key, and CRLF",
);

const withRepos = validateGraph({ nodes: [node("a", 1, { repoBranches: { templates: " users/me/fix ", empty: "  " } })], edges: [] });
assert.deepEqual(withRepos.nodes[0].repoBranches, { templates: "users/me/fix" }, "trimmed; an empty branch means the YAML's ref");
assert.equal(validateGraph({ nodes: [node("a", 1, { repoBranches: { t: "" } })], edges: [] }).nodes[0].repoBranches, undefined);
assert.equal("repoBranches" in validateGraph({ nodes: [node("a", 1)], edges: [] }).nodes[0], false);
bad({ nodes: [node("a", 1, { repoBranches: { self: "main" } })], edges: [] }, /own repository builds the block's Branch/);
bad({ nodes: [node("a", 1, { repoBranches: { "bad alias": "main" } })], edges: [] }, /Invalid repository alias/);
bad({ nodes: [node("a", 1, { repoBranches: { t: "a", T: "b" } })], edges: [] }, /listed twice/);
bad({ nodes: [node("a", 1, { repoBranches: { t: 5 } })], edges: [] }, /must be text/);
bad({ nodes: [node("a", 1, { repoBranches: { t: "x".repeat(257) } })], edges: [] }, /too long/);
bad({ nodes: [node("a", 1, { repoBranches: ["main"] })], edges: [] }, /alias\/branch pairs/);
bad(
    { nodes: [node("a", 1, { repoBranches: Object.fromEntries(Array.from({ length: MAX_REPO_BRANCHES + 1 }, (_, i) => [`r${i}`, "x"])) })], edges: [] },
    /at most 20 repository branches/,
);
const runInfo = runToBuild({ id: 7, name: "1.0.2", state: "inProgress", _links: { web: { href: "https://x/7" } } });
assert.deepEqual(runInfo, { id: 7, buildNumber: "1.0.2", status: "inProgress", result: undefined, url: "https://x/7", finishTime: undefined });
assert.equal(applyBuild({ status: "queuing" }, runInfo).status, "running");
assert.equal(applyBuild({ status: "queuing" }, runToBuild({ id: 7, state: "unknown" })).status, "queued");
assert.equal(applyBuild({ status: "running" }, runToBuild({ id: 7, state: "canceling" })).status, "running");
assert.equal(applyBuild({ status: "running" }, runToBuild({ id: 7, state: "completed", result: "succeeded" })).status, "succeeded");

console.log("Pipeline graph harness passed");
