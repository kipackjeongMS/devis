import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
    NODE_H,
    NODE_W,
    activeRemoval,
    autoLayout,
    blockViews,
    canConnect,
    clampZoom,
    descendants,
    edgePath,
    filterPipelines,
    fitTransform,
    formatElapsed,
    groupPipelines,
    isActive,
    isDefaultValue,
    lastAppBuild,
    nodeBranchLabel,
    nextNodeId,
    paramProblem,
    paramSummary,
    placeNewNode,
    repoBranchFor,
    repoSignature,
    repoSummary,
    resourceSources,
    runProgress,
    setParam,
    setRepoBranch,
    stages,
    statusLabel,
    statusTone,
    stopCheck,
    topologySignature,
    triggerScope,
    upstreamCandidates,
    zoomAt,
} from "../web/pipelineModel.js";
import {
    advance,
    appBuildsFromRuns,
    applyCommand,
    blockResultsFromRuns,
    checkParams,
    descendants as serverDescendants,
    repoSignature as serverRepoSignature,
    resolvePins,
    resolveRepoBranches,
} from "../pipeline-graph.mjs";

// Pure helpers behind the Pipelines view: catalog search, chain editing rules,
// canvas geometry, and run presentation.

const p = (id, name, path = "\\", project = "Alpha", extra = {}) => ({
    org: "org",
    project,
    id,
    name,
    path,
    url: `https://dev.azure.com/org/${project}/_build?definitionId=${id}`,
    queueStatus: "enabled",
    ...extra,
});
const catalog = [
    p(1, "Build Service", "\\Service\\CI"),
    p(2, "Deploy Service", "\\Service\\CD"),
    p(3, "Lint", "\\"),
    p(4, "Nightly Perf", "\\Perf", "Beta"),
];

// ---- catalog --------------------------------------------------------------------------
assert.deepEqual(filterPipelines(catalog, "", "").map((x) => x.id), [1, 2, 3, 4]);
assert.deepEqual(filterPipelines(catalog, "service", "").map((x) => x.id), [1, 2]);
assert.deepEqual(filterPipelines(catalog, "  SERVICE   cd ", "").map((x) => x.id), [2], "every token must match");
assert.deepEqual(filterPipelines(catalog, "perf", "").map((x) => x.id), [4], "folder paths are searchable");
assert.deepEqual(filterPipelines(catalog, "beta", "").map((x) => x.id), [4], "project names are searchable");
assert.deepEqual(filterPipelines(catalog, "", "org/Alpha").map((x) => x.id), [1, 2, 3], "scope limits to one project");

const groups = groupPipelines([catalog[3], catalog[2], catalog[0]]);
assert.deepEqual(groups.map((g) => g.project), ["Alpha", "Beta"]);
assert.deepEqual(groups[0].items.map((x) => x.name), ["Build Service", "Lint"], "items sort by name");
assert.equal(groups[0].key, "org/Alpha");

// ---- chain editing rules ------------------------------------------------------------------
const n = (id, x = 0, y = 0, extra = {}) => ({
    id,
    org: "org",
    project: "Alpha",
    definitionId: Number(id.replace(/\D/g, "")) || 1,
    name: id,
    path: "\\",
    branch: "",
    x,
    y,
    ...extra,
});
const graph = { nodes: [n("n1"), n("n2"), n("n3")], edges: [{ from: "n1", to: "n2" }, { from: "n2", to: "n3" }] };
assert.equal(canConnect(graph, "n1", "n3").ok, true);
assert.equal(canConnect(graph, "n1", "n1").ok, false);
assert.match(canConnect(graph, "n1", "n2").reason, /already/i);
assert.match(canConnect(graph, "n3", "n1").reason, /loop/i);
assert.deepEqual(upstreamCandidates(graph, "n2"), [], "n3 would loop and n1 is already upstream");
assert.deepEqual(upstreamCandidates(graph, "n3"), ["n1"]);
assert.equal(nextNodeId(graph.nodes), "n4");
assert.equal(nextNodeId([]), "n1");

assert.deepEqual(stages(graph), [["n1"], ["n2"], ["n3"]]);
assert.deepEqual(
    stages({ nodes: [n("n1"), n("n2"), n("n3")], edges: [{ from: "n1", to: "n3" }, { from: "n2", to: "n3" }] }),
    [["n1", "n2"], ["n3"]],
    "independent roots share a stage",
);

// Positions, names, and branch spelling do not change what a run executes.
const sigA = topologySignature(graph);
const moved = { ...graph, nodes: graph.nodes.map((x) => ({ ...x, x: x.x + 80, name: "Renamed" })) };
assert.equal(topologySignature(moved), sigA);
assert.equal(
    topologySignature({ ...graph, nodes: graph.nodes.map((x) => (x.id === "n1" ? { ...x, branch: "main" } : x)) }),
    topologySignature({
        ...graph,
        nodes: graph.nodes.map((x) => (x.id === "n1" ? { ...x, branch: "refs/heads/main" } : x)),
    }),
);
assert.notEqual(topologySignature({ ...graph, edges: graph.edges.slice(1) }), sigA);
const following = { ...graph, nodes: graph.nodes.map((x) => (x.id === "n1" ? { ...x, branchFrom: { org: "Org", prId: 7 } } : x)) };
assert.notEqual(topologySignature(following), sigA, "following a PR changes what a run builds");
assert.equal(
    topologySignature(following),
    topologySignature({ ...graph, nodes: graph.nodes.map((x) => (x.id === "n1" ? { ...x, branchFrom: { org: "org", prId: 7 } } : x)) }),
);
assert.equal(nodeBranchLabel({ branch: "" }), "Default branch");
// Repository branches change what a run builds; their spelling doesn't.
const withRepo = (repoBranches) => ({ ...graph, nodes: graph.nodes.map((x) => (x.id === "n1" ? { ...x, repoBranches } : x)) });
assert.notEqual(topologySignature(withRepo({ templates: "fix" })), sigA);
assert.equal(topologySignature(withRepo({ Templates: "refs/heads/fix" })), topologySignature(withRepo({ templates: "fix" })));
assert.equal(topologySignature(withRepo(undefined)), sigA);
assert.equal(nodeBranchLabel({ branch: "refs/heads/release/1" }), "release/1");
assert.equal(nodeBranchLabel({ branch: "", branchFrom: { org: "org", prId: 7 } }), "PR 7's branch");

// ---- canvas geometry ------------------------------------------------------------------------
assert.ok(NODE_W >= 200 && NODE_H >= 72);
assert.equal(NODE_W % 8, 0);
assert.equal(NODE_H % 4, 0);
const path = edgePath({ x: 0, y: 0 }, { x: 400, y: 120 });
assert.ok(path.startsWith(`M ${NODE_W} ${NODE_H / 2} C`), path);
assert.ok(path.endsWith(`400 ${120 + NODE_H / 2}`), path);

assert.equal(clampZoom(10), 2);
assert.equal(clampZoom(0.01), 0.25);
const zoomed = zoomAt({ x: 0, y: 0, zoom: 1 }, 2, 100, 50);
assert.deepEqual(zoomed, { x: -100, y: -50, zoom: 2 }, "the point under the cursor stays put");
assert.deepEqual(zoomAt({ x: 10, y: 10, zoom: 1 }, 5, 0, 0).zoom, 2);

const fit = fitTransform([n("n1", 0, 0), n("n2", 1000, 400)], 800, 600, 48);
const right = (1000 + NODE_W) * fit.zoom + fit.x;
assert.ok(fit.zoom < 1 && fit.zoom >= 0.25);
assert.ok(fit.x >= 47 && right <= 753, "fit keeps every block inside the padding");
assert.equal(fitTransform([n("n1", 0, 0)], 1600, 900, 48).zoom, 1, "fit never enlarges past 100%");
assert.deepEqual(fitTransform([], 800, 600).zoom, 1);

const placed = placeNewNode([n("n1", 0, 0)]);
assert.ok(placed.x >= NODE_W, "new blocks land beside existing ones");
assert.equal(placed.x % 8, 0);
assert.deepEqual(placeNewNode([], { x: 13, y: 21 }), { x: 16, y: 24 }, "drop points snap to the 8px grid");
assert.deepEqual(placeNewNode([]), { x: 0, y: 0 });

const laid = autoLayout(
    [n("n3", 0, 0), n("n1", 500, 500), n("n2", 40, 40), n("n4", 0, 900)],
    [{ from: "n1", to: "n2" }, { from: "n2", to: "n3" }, { from: "n1", to: "n3" }],
);
const at = Object.fromEntries(laid.map((x) => [x.id, x]));
assert.ok(at.n1.x < at.n2.x && at.n2.x < at.n3.x, "columns follow execution order");
assert.equal(at.n4.x, at.n1.x, "unconnected blocks sit in the first column");
assert.notEqual(at.n4.y, at.n1.y, "blocks in a column do not overlap");
assert.ok(laid.every((x) => x.x % 8 === 0 && x.y % 8 === 0));

// ---- run presentation --------------------------------------------------------------------------
assert.equal(statusLabel("partiallySucceeded"), "Partially succeeded");
assert.equal(statusLabel("queuing"), "Queuing");
assert.equal(statusTone("succeeded"), "ok");
assert.equal(statusTone("partiallySucceeded"), "warn");
assert.equal(statusTone("failed"), "bad");
assert.equal(statusTone("error"), "bad");
assert.equal(statusTone("running"), "run");
assert.equal(statusTone("skipped"), "off");
assert.equal(statusTone("waiting"), "idle");
assert.equal(formatElapsed(800), "<1s");
assert.equal(formatElapsed(45_000), "45s");
assert.equal(formatElapsed(245_000), "4m 05s");
assert.equal(formatElapsed(3_720_000), "1h 02m");
assert.deepEqual(
    runProgress({ a: { status: "succeeded" }, b: { status: "running" }, c: { status: "skipped" } }),
    { done: 2, total: 3 },
);

// ---- per-block run and stop -------------------------------------------------------------------
// The view predicts what the runner will do, so it must agree with the server rules exactly.
// a and b fan in to c; c and e fan in to d.
const fan = {
    nodes: ["a", "b", "c", "d", "e"].map((id) => n(id)),
    edges: [{ from: "a", to: "c" }, { from: "b", to: "c" }, { from: "c", to: "d" }, { from: "e", to: "d" }],
};
for (const id of ["a", "b", "c", "d", "e"]) assert.deepEqual(descendants(fan, id), serverDescendants(fan, id), `descendants(${id})`);
assert.deepEqual(descendants(fan, "a"), ["c", "d"]);
assert.equal(isActive("queued"), true);
assert.equal(isActive("waiting"), false);
assert.equal(isActive(undefined), false);

const idle = triggerScope(fan, null, "c");
assert.deepEqual(idle, { ids: ["c", "d"], waits: [], skips: [], blocked: null }, "an idle chain runs only the scope");

// Compare the prediction with applyCommand + advance on the same live states.
function agrees(live, id, canceled = false) {
    const scope = triggerScope(fan, live, id, canceled);
    const res = applyCommand(fan, live, { kind: "trigger", nodeId: id }, canceled);
    assert.equal(scope.blocked, res.error, `blocked message for ${id}`);
    if (res.error) return scope;
    const after = advance(fan, res.states, canceled).states;
    const skipped = Object.keys(after).filter((x) => after[x].status === "skipped" && res.states[x].status !== "skipped");
    assert.deepEqual(scope.skips.map((s) => s.id).sort(), skipped.sort(), `skips for ${id}`);
    for (const s of scope.skips) assert.match(after[s.id].error, new RegExp(`"${s.because}"`), `skip reason for ${s.id}`);
    return scope;
}

const running = { a: { status: "running", buildId: 1 }, b: { status: "waiting" }, c: { status: "waiting" }, d: { status: "waiting" }, e: { status: "succeeded" } };
assert.match(agrees(running, "b").blocked, /already waiting/);
assert.match(agrees(running, "a").blocked, /already running/);
assert.match(agrees(running, "a", true).blocked, /stopping/i);
const joinE = agrees(running, "e");
assert.deepEqual(joinE.ids, ["e", "d"]);
assert.deepEqual(joinE.waits, [{ id: "d", on: ["c"] }], "fan-in: d still waits for c, which is in the run");
assert.deepEqual(joinE.skips, []);

const busy = { a: { status: "succeeded" }, b: { status: "succeeded" }, c: { status: "running", buildId: 3 }, d: { status: "waiting" }, e: { status: "succeeded" } };
assert.match(agrees(busy, "a").blocked, /while "c" is running/, "can't restart above a running block");
assert.equal(agrees(busy, "e").blocked, null, "a sibling branch can join");

const failed = { a: { status: "failed" }, b: { status: "succeeded" }, c: { status: "skipped" }, d: { status: "skipped" }, e: { status: "succeeded" } };
const retryC = agrees(failed, "c");
assert.deepEqual([retryC.waits, retryC.skips], [[], []], "re-running the skipped block itself ignores its failed upstream");
const retryB = agrees(failed, "b");
assert.deepEqual(retryB.skips, [{ id: "c", because: "a" }, { id: "d", because: "c" }], "a failed upstream still skips c, and the skip cascades");

assert.deepEqual(stopCheck(undefined), { ok: false, reason: "Not part of this run" });
assert.deepEqual(stopCheck({ status: "running", buildId: 5 }), { ok: true });
assert.deepEqual(stopCheck({ status: "queued", buildId: 5 }), { ok: true });
assert.match(stopCheck({ status: "queued" }).reason, /being queued/, "no build to cancel yet");
assert.match(stopCheck({ status: "queuing" }).reason, /being queued/);
assert.equal(stopCheck({ status: "running", buildId: 5, stopRequested: true }).reason, "Stopping…");
assert.equal(stopCheck({ status: "waiting" }).reason, "Hasn't started yet");
assert.equal(stopCheck({ status: "succeeded" }).reason, "Already finished");
for (const s of [{ status: "running", buildId: 5 }, { status: "queued" }, { status: "waiting" }, { status: "failed" }]) {
    const res = applyCommand(fan, { a: s }, { kind: "stop", nodeId: "a" }, false);
    assert.equal(stopCheck(s).ok, res.error === null, `stop agrees with the runner for ${JSON.stringify(s)}`);
}

// ---- live edits ----------------------------------------------------------------------------------
const liveGraph = {
    nodes: [
        { id: "a", org: "org", project: "Alpha", definitionId: 1, name: "Build", path: "\\", branch: "", x: 0, y: 0 },
        { id: "b", org: "org", project: "Alpha", definitionId: 2, name: "Release", path: "\\", branch: "", x: 0, y: 0 },
    ],
    edges: [{ from: "a", to: "b" }],
};
const liveRun = { graph: liveGraph, states: { a: { status: "running", buildId: 7 }, b: { status: "waiting" } } };
assert.equal(activeRemoval(null, { nodes: [], edges: [] }), null, "no run, nothing to protect");
assert.equal(activeRemoval(liveRun, liveGraph), null);
assert.equal(activeRemoval(liveRun, { nodes: [liveGraph.nodes[0]], edges: [] }), null, "a waiting block can go");
assert.equal(activeRemoval(liveRun, { nodes: [liveGraph.nodes[1]], edges: [] }), "Build", "a building block can't");
assert.equal(
    activeRemoval(liveRun, { nodes: [{ ...liveGraph.nodes[0], definitionId: 9 }, liveGraph.nodes[1]], edges: [] }),
    "Build",
    "repointing a building block counts as removing it"
);
assert.equal(
    activeRemoval(liveRun, { nodes: [{ ...liveGraph.nodes[0], x: 400, branch: "dev", params: { p: "1" } }, liveGraph.nodes[1]], edges: [] }),
    null,
    "moving it or editing its branch and parameters is fine"
);
assert.equal(activeRemoval({ ...liveRun, states: { a: { status: "succeeded" } } }, { nodes: [], edges: [] }), null, "finished blocks can go");

// ---- parameters ------------------------------------------------------------------------------------
assert.equal(setParam(undefined, "x", undefined), undefined);
assert.deepEqual(setParam(undefined, "x", "1"), { x: "1" });
assert.deepEqual(Object.keys(setParam({ a: "1", b: "2" }, "a", "3")), ["a", "b"], "order is kept");
assert.deepEqual(setParam({ a: "1", b: "2" }, "a", undefined), { b: "2" });
assert.equal(setParam({ a: "1" }, "a", undefined), undefined, "no overrides left");
const proto = setParam(undefined, "__proto__", "x");
assert.equal(Object.getPrototypeOf(proto), Object.prototype, "a __proto__ name stays plain data");
assert.deepEqual(Object.keys(proto), ["__proto__"]);

const defs = [
    { name: "flag", label: "Flag", kind: "boolean", default: "False" },
    { name: "count", label: "Count", kind: "number", default: "3" },
    { name: "region", label: "Region", kind: "string", default: "eastus", values: ["eastus", "westus"] },
    { name: "note", label: "Note", kind: "string", default: "" },
    { name: "cfg", label: "Config", kind: "object", default: "{}" },
];
assert.ok(isDefaultValue(defs[0], "false"), "booleans ignore case");
assert.ok(!isDefaultValue(defs[0], "true"));
assert.ok(isDefaultValue(defs[1], "3"));
assert.ok(!isDefaultValue(defs[1], "3.0"), "other kinds compare exactly");
for (const [def, value, problem] of [
    [defs[0], "TRUE", null],
    [defs[0], "yes", "Must be true or false"],
    [defs[1], "2.5", null],
    [defs[1], " ", "Must be a number"],
    [defs[1], "abc", "Must be a number"],
    [defs[2], "westus", null],
    [defs[2], "WestUS", "Not one of the allowed values"],
    [defs[3], "", null],
    [defs[4], '{"a":1}', null],
]) {
    assert.equal(paramProblem(def, value), problem, `${def.name}=${JSON.stringify(value)}`);
    assert.equal(checkParams({ [def.name]: value }, defs) === null, problem === null, `client and runner agree on ${def.name}=${JSON.stringify(value)}`);
}
assert.deepEqual(paramSummary(defs, undefined), { total: 5, changed: 0, invalid: 0, stale: [] });
assert.deepEqual(paramSummary(defs, { count: "x", region: "westus", gone: "1" }), { total: 5, changed: 2, invalid: 1, stale: ["gone"] });
assert.match(checkParams({ gone: "1" }, defs), /no longer exists/, "the runner refuses stale overrides too");

// ---- repository resources ---------------------------------------------------------------------------
{
    const repos = [
        { alias: "templates", name: "GovernedTemplates", type: "TfsGit", ref: "refs/heads/main" },
        { alias: "tools", name: "org/tools", type: "GitHub", ref: "" },
    ];
    assert.deepEqual(repoSummary(repos, undefined), { total: 2, changed: 0, stale: [] });
    assert.deepEqual(repoSummary(repos, { Templates: "fix", gone: "x", blank: " " }), { total: 2, changed: 1, stale: ["gone"] });
    // The client and the runner agree on which aliases are stale.
    for (const [overrides, stale] of [
        [{ TEMPLATES: "fix" }, false],
        [{ gone: "fix" }, true],
    ]) {
        assert.equal(repoSummary(repos, overrides).stale.length > 0, stale);
        assert.equal(resolveRepoBranches(overrides, repos).error !== null, stale, `client and runner agree on ${JSON.stringify(overrides)}`);
    }
    assert.equal(repoBranchFor({ Templates: "fix" }, "templates"), "fix", "matched case-insensitively");
    assert.equal(repoBranchFor(undefined, "templates"), "");
    assert.deepEqual(setRepoBranch(undefined, "templates", "fix"), { templates: "fix" });
    assert.deepEqual(setRepoBranch({ Templates: "old", tools: "x" }, "templates", "new"), { tools: "x", templates: "new" }, "the YAML's spelling replaces another");
    assert.deepEqual(setRepoBranch({ templates: "fix", tools: "x" }, "templates", "  "), { tools: "x" }, "a blank branch clears it");
    assert.equal(setRepoBranch({ templates: "fix" }, "Templates", ""), undefined, "undefined once none remain");
    // An earlier build only counts on the same repository branches, as the runner decides.
    const repoNode = { id: "r", org: "org", project: "Alpha", definitionId: 9, name: "Svc", path: "\\", branch: "", x: 0, y: 0, repoBranches: { Templates: "fix" } };
    const repoRuns = [
        { runId: "q2", graph: { nodes: [repoNode], edges: [] }, states: { r: { status: "succeeded", buildNumber: "2", branch: "", repoBranches: { templates: "refs/heads/fix" } } } },
        { runId: "q1", graph: { nodes: [repoNode], edges: [] }, states: { r: { status: "succeeded", buildNumber: "1", branch: "" } } },
    ];
    const repoPast = appBuildsFromRuns(repoRuns);
    assert.equal(lastAppBuild(repoNode, repoPast).buildNumber, "2");
    assert.equal(lastAppBuild({ ...repoNode, repoBranches: undefined }, repoPast).buildNumber, "1");
    assert.equal(lastAppBuild({ ...repoNode, repoBranches: { templates: "other" } }, repoPast), undefined);
    assert.equal(repoSignature({ Templates: "fix" }), serverRepoSignature({ Templates: "fix" }), "one signature on both sides");
}

// ---- consumed builds -------------------------------------------------------------------------------
const node = (id, name, extra = {}) => ({ id, org: "org", project: "Alpha", definitionId: id.charCodeAt(0), name, path: "\\", branch: "", x: 0, y: 0, ...extra });
const resGraph = {
    nodes: [
        node("a", "Service-Official", { path: "\\Service" }),
        node("b", "Lint"),
        node("c", "Release"),
        node("d", "Service-Official", { project: "Beta" }),
        node("e", "Service-Official", { path: "\\Other" }),
    ],
    edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "d", to: "c" },
    ],
};
const res = (alias, name, project) => ({ alias, name, ...(project ? { project } : {}) });
assert.deepEqual(resourceSources(resGraph, "c", [res("svc", "service-official")]), [{ alias: "svc", name: "service-official", from: "a", tied: [] }], "through any arrows, by name, in the block's project");
assert.equal(resourceSources(resGraph, "c", [res("svc", "Service-Official", "beta")])[0].from, "d", "a resource can name another project");
assert.equal(resourceSources(resGraph, "c", [res("svc", "Service/Service-Official")])[0].from, "a", "a full path picks the folder");
assert.equal(resourceSources(resGraph, "c", [res("svc", "\\Other\\Service-Official")])[0].from, null, "e builds it but isn't upstream");
assert.equal(resourceSources(resGraph, "a", [res("svc", "Service-Official")])[0].from, null, "a block doesn't consume itself");
assert.deepEqual(resourceSources(resGraph, "zz", [res("svc", "x")]), []);
const tieGraph = {
    nodes: [node("a", "Svc"), node("b", "Svc", { definitionId: 99 }), node("c", "Release")],
    edges: [{ from: "a", to: "c" }, { from: "b", to: "c" }],
};
assert.deepEqual(resourceSources(tieGraph, "c", [res("svc", "Svc")])[0], { alias: "svc", name: "Svc", from: null, tied: ["a", "b"] });
const nearGraph = {
    nodes: [node("a", "Svc"), node("b", "Svc", { definitionId: 99 }), node("c", "Release")],
    edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
};
assert.equal(resourceSources(nearGraph, "c", [res("svc", "Svc")])[0].from, "b", "the nearest wins");
// With every upstream block passed in this run, the runner pins exactly what the view shows.
for (const [graph, id, resources] of [
    [resGraph, "c", [res("svc", "service-official"), res("other", "Service-Official", "Beta"), res("none", "Nope")]],
    [nearGraph, "c", [res("svc", "Svc")]],
    [tieGraph, "c", [res("svc", "Svc")]],
]) {
    const passed = Object.fromEntries(graph.nodes.map((n) => [n.id, n.id === id ? { status: "waiting" } : { status: "succeeded", buildId: 1, buildNumber: `v-${n.id}` }]));
    const pins = resolvePins(graph, passed, id, resources);
    const view = resourceSources(graph, id, resources);
    if (view.some((v) => v.tied.length)) {
        assert.match(pins.error, /Remove one of the arrows/, "a tie is refused, not guessed");
        continue;
    }
    assert.equal(pins.error, null);
    assert.deepEqual(
        pins.pins.map((p) => [p.alias, p.from]),
        view.filter((v) => v.from).map((v) => [v.alias, v.from]),
        "client and runner pick the same build"
    );
}

// The inspector names the same earlier build the runner falls back to.
{
    const graph = { nodes: [node("a", "Svc"), node("c", "Release")], edges: [{ from: "a", to: "c" }] };
    const past = appBuildsFromRuns([
        { runId: "r2", graph, states: { a: { status: "failed", buildNumber: "v2" } } },
        { runId: "r1", graph, states: { a: { status: "succeeded", buildNumber: "v1", finishedAt: "2024-01-01T00:00:00Z" } } },
    ]);
    assert.equal(lastAppBuild(graph.nodes[0], past).buildNumber, "v1");
    assert.deepEqual(resolvePins(graph, { c: { status: "waiting" } }, "c", [res("svc", "Svc")], past).pins, [{ alias: "svc", version: "v1", from: "a", runId: "r1" }]);
    assert.equal(lastAppBuild({ ...graph.nodes[0], branch: "dev" }, past), undefined, "a block on another branch has no earlier build");
    assert.equal(lastAppBuild({ ...graph.nodes[0], branch: "dev", branchFrom: { org: "org", prId: 7 } }, past), undefined, "a block that follows a PR doesn't take a build it made on a fixed branch");
    assert.equal(
      lastAppBuild({ ...graph.nodes[0], branchFrom: { org: "Org", prId: 7 } }, [{ ...lastAppBuild(graph.nodes[0], past), branch: "refs/heads/feature", followed: "org/7" }]).buildNumber,
      "v1",
      "…only one it made following that PR, whatever the branch",
    );
    assert.equal(lastAppBuild({ ...graph.nodes[0], branchFrom: { org: "org", prId: 8 } }, [{ ...lastAppBuild(graph.nodes[0], past), followed: "org/7" }]), undefined, "…not another PR");
    assert.equal(lastAppBuild({ ...graph.nodes[0], definitionId: 1 }, past), undefined, "nor does another pipeline");
    assert.equal(lastAppBuild(graph.nodes[1], past), undefined);
}

// ---- each block keeps its own last result ---------------------------------------------------------
{
    const graph = {
        nodes: [node("a", "Build A"), node("b", "Build B"), node("c", "Release")],
        edges: [{ from: "a", to: "c" }, { from: "b", to: "c" }],
    };
    const ok = (buildNumber) => ({ status: "succeeded", buildId: 1, buildNumber, finishedAt: "2024-01-01T00:00:00Z" });
    const mk = (runId, status, states, g = graph) => ({
        runId,
        chainId: "ch",
        status,
        graph: g,
        states,
        cancelRequested: false,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
    });
    // Run A, run B, then run only the release: the user's scenario.
    const r1 = mk("r1", "succeeded", { a: ok("a1"), c: { status: "skipped" } });
    const r2 = mk("r2", "succeeded", { b: ok("b1"), c: { status: "skipped" } });
    const r3 = mk("r3", "succeeded", { c: ok("c1") });
    const results = blockResultsFromRuns([r3, r2, r1]);

    let views = blockViews(graph, r3, results);
    assert.equal(views.a.state.buildNumber, "a1", "the parent still shows its result after the child ran alone");
    assert.equal(views.b.state.buildNumber, "b1");
    assert.deepEqual([views.a.live, views.a.earlier, views.a.runId], [false, true, "r1"]);
    assert.deepEqual([views.c.live, views.c.earlier, views.c.runId], [false, false, "r3"], "the child shows its own newest run");

    const live = mk("r4", "running", { c: { status: "running", buildId: 2, buildNumber: "c2" } });
    views = blockViews(graph, live, results);
    assert.deepEqual([views.c.live, views.c.state.status], [true, "running"], "a block in the live run shows the live state");
    assert.deepEqual([views.a.live, views.a.state.status], [false, "succeeded"], "a block outside the live run keeps its last result");

    const waiting = mk("r5", "running", { a: { status: "waiting" }, c: { status: "waiting" } });
    views = blockViews(graph, waiting, results);
    assert.deepEqual([views.a.live, views.a.state.status], [true, "waiting"], "a block waiting in the live run says so");
    assert.equal(views.b.state.buildNumber, "b1", "an untouched sibling keeps its result");

    const cascaded = mk("r6", "failed", { a: { status: "failed", buildNumber: "a2" }, c: { status: "skipped" } });
    views = blockViews(graph, cascaded, blockResultsFromRuns([cascaded, r3, r2, r1]));
    assert.equal(views.a.state.status, "failed", "the newest run's outcome wins");
    assert.equal(views.c.state.status, "skipped", "a skipped release in the newest run reads as skipped");
    assert.equal(views.b.state.buildNumber, "b1");

    const unfinished = mk("r7", "canceled", { a: { status: "waiting" } });
    views = blockViews(graph, unfinished, blockResultsFromRuns([unfinished, r3, r2, r1]));
    assert.equal(views.a.state.buildNumber, "a1", "a finished run's waiting entry never hides a real result");

    assert.deepEqual(Object.keys(blockViews(graph, null, [])), [], "nothing has run yet");
    assert.equal(blockViews(graph, null, results).b.state.buildNumber, "b1", "results show without any run loaded");
    assert.equal(blockViews(graph, null, results).b.earlier, true);

    // Editing arrows or branches keeps results; pointing a block at another pipeline drops its own.
    const edited = {
        nodes: [node("a", "Build A", { branch: "dev" }), node("b", "Build B"), node("c", "Release")],
        edges: [{ from: "b", to: "c" }],
    };
    views = blockViews(edited, r3, results);
    assert.equal(views.a.state.buildNumber, "a1", "a branch edit keeps the result");
    assert.equal(views.c.state.buildNumber, "c1", "removing an arrow keeps the result");
    const swapped = {
        nodes: [node("a", "Other", { definitionId: 77 }), node("b", "Build B"), node("c", "Release")],
        edges: graph.edges,
    };
    views = blockViews(swapped, r3, results);
    assert.equal(views.a, undefined, "a different pipeline shows no earlier result");
    assert.equal(views.b.state.buildNumber, "b1");
    assert.equal(blockViews(swapped, mk("r8", "running", { a: { status: "waiting" } }, swapped), results).a.live, true, "but it shows its place in the live run");
    const swappedRun = mk("r9", "succeeded", { a: ok("x1") }, graph);
    assert.equal(blockViews(swapped, swappedRun, results).a, undefined, "a finished run of the old pipeline isn't shown for the new one");

    // Results are per chain: the same block ids in another chain never leak in.
    const other = { nodes: [node("a", "Elsewhere", { definitionId: 5 })], edges: [] };
    assert.equal(blockViews(other, null, results).a, undefined);
}

// ---- wiring --------------------------------------------------------------------------------------
const source = (file) => readFile(new URL(file, import.meta.url), "utf8");
const html = await source("../web/index.html");
assert.match(html, /<nav[^>]+class="feature-nav"[^>]+aria-label="Features"/);
assert.match(html, /data-feature="prs"/);
assert.match(html, /data-feature="pipelines"/);
assert.match(html, /id="pipelinesView"/);
const css = await source("../web/style.css");
assert.match(css, /body\[data-feature="pipelines"\]/);
assert.match(css, /\.chain-node\b/);
assert.match(css, /\.pipeline-catalog\b/);
assert.match(css, /\.chain-block-action\b/);
assert.match(css, /\.run-confirm-notes\b/);
const view = await source("../web/src/pipelines.ts");
assert.match(view, /\/api\/pipeline-chains\/trigger/);
assert.match(view, /\/api\/pipeline-runs\/stop-node/);
assert.match(view, /data-block-action="run"/);
assert.match(view, /data-block-action="stop"/);
assert.match(view, /\/api\/pipeline-definition-info/);
assert.match(view, /\/api\/pipeline-chain-builds/);
assert.match(view, /\/api\/pipeline-chain-results/);
assert.match(view, /blockViews\(/, "each block paints its own last result");
assert.match(view, /forgetOtherChain/, "history never carries over between chains");
assert.match(view, /data-param=/);
assert.match(view, /data-repo=/, "each repository resource has a branch field");
assert.match(view, /reposHtml\(n\)/);
assert.doesNotMatch(view, /setLocked/, "editing stays open while a chain runs");
const canvasSource = await source("../web/src/chainCanvas.ts");
assert.match(canvasSource, /onBlockAction/);
assert.match(canvasSource, /repoCount/, "blocks show how many repository branches they set");
assert.match(canvasSource, /not part of this run/, "blocks outside a live run say so to screen readers");
const reading = await source("../web/src/readingPane.ts");
assert.match(reading, /if \(feature === "pipelines" \|\| feature === "jarvis"\) return;/, "pane zoom keys belong to the canvas in Pipelines");
const app = await source("../web/src/app.ts");
assert.match(app, /from "\.\/pipelines\.js"/);
assert.match(app, /setFeature\(/);
const design = await source("../DESIGN.md");
assert.match(design, /## Pipelines/);
assert.match(design, /Run from here/);

console.log("Pipeline model harness passed");
