// Pure rules for pipeline chains: validation, scheduling, ADO build mapping,
// run outcome, and crash recovery. No I/O so the runner and tests share it.

export const MAX_CHAIN_NODES = 50;
export const MAX_CHAIN_EDGES = 200;

export interface ChainNode {
    id: string;
    org: string;
    project: string;
    definitionId: number;
    name: string;
    path: string;
    branch: string;
    x: number;
    y: number;
    /** Runtime parameter overrides (YAML pipelines); anything not listed uses its default. */
    params?: Record<string, string>;
    /**
     * Branches for the YAML's `resources.repositories`, by alias (YAML pipelines). A repository
     * not listed uses the ref its YAML names. The pipeline's own repository uses `branch`.
     */
    repoBranches?: Record<string, string>;
    /**
     * Build the source branch of this pull request, read when the block queues, so new
     * commits and a renamed branch need no edit. Overrides `branch`.
     */
    branchFrom?: PrRef;
}

export interface PrRef {
    org: string;
    prId: number;
}

export interface ChainEdge {
    from: string;
    to: string;
}

export interface ChainGraph {
    nodes: ChainNode[];
    edges: ChainEdge[];
}

export type NodeStatus =
    | "waiting"
    | "queuing"
    | "queued"
    | "running"
    | "succeeded"
    | "partiallySucceeded"
    | "failed"
    | "canceled"
    | "skipped"
    | "error";

export interface NodeRunState {
    status: NodeStatus;
    buildId?: number;
    buildNumber?: string;
    url?: string;
    queuedAt?: string;
    startedAt?: string;
    finishedAt?: string;
    error?: string;
    cancelSent?: boolean;
    cancelError?: string;
    pollFailures?: number;
    pollError?: string;
    /** Started on its own ("Run from here"): it does not wait for its upstream blocks. */
    manual?: boolean;
    /** The user stopped this block; the runner sends one cancel for its build. */
    stopRequested?: boolean;
    /** Pipeline resources pinned to builds that earlier blocks produced in this app. */
    resources?: ResourcePin[];
    /** Parameter overrides this block was queued with. */
    params?: Record<string, string>;
    /** Repository resources it was queued on, by the YAML's alias (normalized refs). */
    repoBranches?: Record<string, string>;
    /** Branch it was queued on (normalized; "" = the pipeline's default branch). */
    branch?: string;
    /** The PR it followed, as prKey() writes it: its earlier builds only count while it follows that PR. */
    followed?: string;
}

export interface ResourcePin {
    /** The `resources.pipelines` alias in the consuming pipeline's YAML. */
    alias: string;
    /** Build number (run name) of the consumed build. */
    version: string;
    /** The block that produced it. */
    from: string;
    /** The earlier run of the chain that produced it; absent when it came from this run. */
    runId?: string;
}

/** A build a block passed with in a run of its chain, and how the block was set up then. */
export interface AppBuild {
    nodeId: string;
    runId: string;
    org: string;
    project: string;
    definitionId: number;
    /** Normalized branch it was queued on; "" = the pipeline's default branch. */
    branch: string;
    /** The PR it followed then (prKey), if it did. */
    followed?: string;
    /** The repository resource branches it was queued with, as repoSignature() writes them; absent for none. */
    repos?: string;
    buildNumber: string;
    buildId?: number;
    url?: string;
    finishedAt?: string;
}

/** A `resources.pipelines` entry of a YAML pipeline. */
export interface PipelineResource {
    alias: string;
    /** Source pipeline name, optionally with its folder ("\\Release\\Build"). */
    name: string;
    project?: string;
}

/** A `resources.repositories` entry of a YAML pipeline (other than `self`). */
export interface RepositoryResource {
    alias: string;
    /** Repository name. */
    name: string;
    /** "TfsGit" for Azure Repos, "GitHub", … */
    type: string;
    /** Its project, for Azure Repos. */
    project?: string;
    /** Repository id, for Azure Repos. */
    id?: string;
    /** The ref the YAML names (refs/heads/…), or "" for the repository's default branch. */
    ref: string;
}

export type RunParameterKind = "string" | "number" | "boolean" | "object";

/** A runtime parameter of a YAML pipeline. Values travel as text; objects as YAML/JSON. */
export interface RunParameter {
    name: string;
    label: string;
    kind: RunParameterKind;
    default: string;
    values?: string[];
}

export type NodeStates = Record<string, NodeRunState>;
export type RunOutcome = "succeeded" | "failed" | "canceled";
export type RunCommandKind = "trigger" | "stop" | "graph";

export interface RunCommand {
    kind: RunCommandKind;
    nodeId: string;
}

export interface BuildInfo {
    id: number;
    buildNumber?: string;
    status?: string;
    result?: string;
    url?: string;
    startTime?: string;
    finishTime?: string;
}

const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PASSED = new Set<NodeStatus>(["succeeded", "partiallySucceeded"]);
const BLOCKED = new Set<NodeStatus>(["failed", "canceled", "skipped", "error"]);
const TERMINAL = new Set<NodeStatus>([...PASSED, ...BLOCKED]);
const ACTIVE = new Set<NodeStatus>(["queuing", "queued", "running"]);

export const isTerminal = (status: NodeStatus): boolean => TERMINAL.has(status);
export const isPassed = (status: NodeStatus): boolean => PASSED.has(status);

function text(value: unknown, max: number): string {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function coord(value: unknown): number {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) throw new Error("Block positions must be numbers");
    return Math.round(Math.max(-100_000, Math.min(100_000, n)));
}

export const MAX_NODE_PARAMS = 200;
const MAX_PARAM_NAME = 256;
const MAX_PARAM_VALUE = 10_000;

function paramOverrides(value: unknown): Record<string, string> | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("Pipeline parameters must be name/value pairs");
    const entries = Object.entries(value);
    if (entries.length > MAX_NODE_PARAMS) throw new Error(`A pipeline block can set at most ${MAX_NODE_PARAMS} parameters`);
    for (const [name, v] of entries) {
        if (!name || name.length > MAX_PARAM_NAME) throw new Error("Invalid parameter name");
        if (typeof v !== "string") throw new Error(`Parameter "${name}" must be text`);
        if (v.length > MAX_PARAM_VALUE) throw new Error(`Parameter "${name}" is too long`);
    }
    // fromEntries defines own properties, so a "__proto__" key stays plain data.
    return entries.length ? (Object.fromEntries(entries) as Record<string, string>) : undefined;
}

export const MAX_REPO_BRANCHES = 20;
const REPO_ALIAS = /^[A-Za-z0-9_.-]{1,100}$/;

/** A block's repository branches: alias to branch; an empty branch means the YAML's ref and is dropped. */
function repoBranchOverrides(value: unknown): Record<string, string> | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("Repository branches must be alias/branch pairs");
    const entries = Object.entries(value);
    if (entries.length > MAX_REPO_BRANCHES) throw new Error(`A pipeline block can set at most ${MAX_REPO_BRANCHES} repository branches`);
    const seen = new Set<string>();
    const kept: Array<[string, string]> = [];
    for (const [alias, v] of entries) {
        if (!REPO_ALIAS.test(alias)) throw new Error(`Invalid repository alias "${alias.slice(0, 100)}"`);
        if (alias.toLowerCase() === "self") throw new Error("The pipeline's own repository builds the block's Branch; set it there");
        if (seen.has(alias.toLowerCase())) throw new Error(`Repository "${alias}" is listed twice`);
        seen.add(alias.toLowerCase());
        if (typeof v !== "string") throw new Error(`The branch for repository "${alias}" must be text`);
        const branch = v.trim();
        if (branch.length > 256) throw new Error(`The branch for repository "${alias}" is too long`);
        if (branch) kept.push([alias, branch]);
    }
    return kept.length ? (Object.fromEntries(kept) as Record<string, string>) : undefined;
}

/** Repository branches as one comparable string ("" for none): lowercased aliases, normalized refs, sorted. */
export function repoSignature(repos: Record<string, string> | undefined): string {
    return Object.entries(repos ?? {})
        .map(([alias, branch]) => `${alias.toLowerCase()}=${normalizeBranch(branch)}`)
        .filter((entry) => !entry.endsWith("="))
        .sort()
        .join("\n");
}

/**
 * The block's repository branches as the Runs API takes them (the YAML's alias spelling,
 * normalized refs), or why they can't be sent: an alias the pipeline no longer has.
 */
export function resolveRepoBranches(
    repoBranches: Record<string, string> | undefined,
    repos: RepositoryResource[],
): { refs: Record<string, string> | undefined; error: string | null } {
    const byAlias = new Map(repos.map((r) => [r.alias.toLowerCase(), r]));
    const refs: Record<string, string> = {};
    for (const [alias, branch] of Object.entries(repoBranches ?? {})) {
        const ref = normalizeBranch(branch);
        if (!ref) continue;
        const repo = byAlias.get(alias.toLowerCase());
        if (!repo) {
            return {
                refs: undefined,
                error: `Repository "${alias}" is no longer a resource of this pipeline. Remove its branch from the block's repositories.`,
            };
        }
        refs[repo.alias] = ref;
    }
    return { refs: Object.keys(refs).length ? refs : undefined, error: null };
}

export function hasCycle(ids: string[], edges: ChainEdge[]): boolean {
    const indegree = new Map(ids.map((id) => [id, 0]));
    const out = new Map<string, string[]>(ids.map((id) => [id, []]));
    for (const e of edges) {
        indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
        out.get(e.from)?.push(e.to);
    }
    const queue = ids.filter((id) => indegree.get(id) === 0);
    let seen = 0;
    while (queue.length) {
        const id = queue.shift()!;
        seen++;
        for (const next of out.get(id) ?? []) {
            const left = (indegree.get(next) ?? 0) - 1;
            indegree.set(next, left);
            if (left === 0) queue.push(next);
        }
    }
    return seen !== ids.length;
}

/** A block's "follow this PR's branch" setting, or null when there is none. */
function prRef(raw: unknown, allowedOrgs: Map<string, string> | null): PrRef | null {
    if (raw === undefined || raw === null || raw === "") return null;
    const r = raw as Record<string, unknown>;
    let org = text(r?.org, 128);
    const prId = Number(r?.prId);
    if (!org || !Number.isSafeInteger(prId) || prId <= 0) throw new Error("A block follows a pull request that isn't named right");
    if (allowedOrgs) {
        const canonical = allowedOrgs.get(org.toLowerCase());
        if (!canonical) throw new Error(`"${org}" is not a configured organization`);
        org = canonical;
    }
    return { org, prId };
}

// Throws a user-facing message for anything the runner could not execute.
export function validateGraph(raw: unknown, orgs?: string[]): ChainGraph {
    const graph = raw as { nodes?: unknown; edges?: unknown } | null;
    if (!graph || typeof graph !== "object" || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
        throw new Error("Chain graph is malformed");
    }
    if (graph.nodes.length > MAX_CHAIN_NODES) {
        throw new Error(`A chain can hold at most ${MAX_CHAIN_NODES} pipelines`);
    }
    if (graph.edges.length > MAX_CHAIN_EDGES) {
        throw new Error(`A chain can hold at most ${MAX_CHAIN_EDGES} connections`);
    }
    const allowedOrgs = orgs ? new Map(orgs.map((o) => [o.toLowerCase(), o])) : null;
    const ids = new Set<string>();
    const nodes: ChainNode[] = graph.nodes.map((rawNode) => {
        const n = (rawNode ?? {}) as Record<string, unknown>;
        const id = typeof n.id === "string" ? n.id : "";
        if (!NODE_ID.test(id)) throw new Error("Invalid block id");
        if (ids.has(id)) throw new Error(`Duplicate block id "${id}"`);
        ids.add(id);
        let org = text(n.org, 128);
        if (!org) throw new Error("Each pipeline needs an organization");
        if (allowedOrgs) {
            const canonical = allowedOrgs.get(org.toLowerCase());
            if (!canonical) throw new Error(`"${org}" is not a configured organization`);
            org = canonical;
        }
        const project = text(n.project, 128);
        if (!project) throw new Error("Each pipeline needs a project");
        const definitionId = Number(n.definitionId);
        if (!Number.isInteger(definitionId) || definitionId <= 0) {
            throw new Error("Pipeline definition id must be a positive integer");
        }
        const params = paramOverrides(n.params);
        const repoBranches = repoBranchOverrides(n.repoBranches);
        const branchFrom = prRef(n.branchFrom, allowedOrgs);
        return {
            id,
            org,
            project,
            definitionId,
            name: text(n.name, 256) || `Pipeline ${definitionId}`,
            path: text(n.path, 512) || "\\",
            branch: text(n.branch, 256),
            x: coord(n.x ?? 0),
            y: coord(n.y ?? 0),
            ...(params ? { params } : {}),
            ...(repoBranches ? { repoBranches } : {}),
            ...(branchFrom ? { branchFrom } : {}),
        };
    });
    const pairs = new Set<string>();
    const edges: ChainEdge[] = graph.edges.map((rawEdge) => {
        const e = (rawEdge ?? {}) as Record<string, unknown>;
        const from = typeof e.from === "string" ? e.from : "";
        const to = typeof e.to === "string" ? e.to : "";
        if (!ids.has(from) || !ids.has(to)) throw new Error("A connection points to an unknown pipeline block");
        if (from === to) throw new Error("A pipeline cannot run after itself");
        const key = `${from}\u0000${to}`;
        if (pairs.has(key)) throw new Error("The same connection is listed twice");
        pairs.add(key);
        return { from, to };
    });
    if (hasCycle([...ids], edges)) throw new Error("Connections form a loop; a chain must run in one direction");
    return { nodes, edges };
}

export function normalizeBranch(branch: string | undefined | null): string {
    const value = (branch ?? "").trim();
    if (!value) return "";
    return value.startsWith("refs/") ? value : `refs/heads/${value}`;
}

/** Every block reachable after `id`, in graph order (excluding `id`). */
export function descendants(graph: ChainGraph, id: string): string[] {
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length) {
        const from = stack.pop()!;
        for (const e of graph.edges) {
            if (e.from === from && !seen.has(e.to)) {
                seen.add(e.to);
                stack.push(e.to);
            }
        }
    }
    seen.delete(id);
    return graph.nodes.filter((n) => seen.has(n.id)).map((n) => n.id);
}

/** The whole chain, or (with a root) only that block and everything after it. */
export function initialNodeStates(graph: ChainGraph, rootId?: string): NodeStates {
    if (!rootId) return Object.fromEntries(graph.nodes.map((n) => [n.id, { status: "waiting" as NodeStatus }]));
    const states: NodeStates = { [rootId]: { status: "waiting", manual: true } };
    for (const id of descendants(graph, rootId)) states[id] = { status: "waiting" };
    return states;
}

// Only blocks in the run (keys of `states`) take part. A block waits for its
// upstream blocks that are in the run; a manual block waits for none. Skips
// what can no longer run and returns waiting blocks that may start now.
export function advance(
    graph: ChainGraph,
    states: NodeStates,
    canceled: boolean,
): { states: NodeStates; ready: string[]; changed: boolean } {
    const inRun = graph.nodes.filter((n) => states[n.id]);
    const names = new Map(graph.nodes.map((n) => [n.id, n.name]));
    const next: NodeStates = {};
    for (const n of inRun) next[n.id] = { ...states[n.id] };
    const upstream = new Map<string, string[]>(inRun.map((n) => [n.id, []]));
    for (const e of graph.edges) {
        if (next[e.from] && next[e.to] && !next[e.to].manual) upstream.get(e.to)!.push(e.from);
    }
    let changed = false;
    let again = true;
    while (again) {
        again = false;
        for (const n of inRun) {
            const state = next[n.id];
            if (state.status !== "waiting") continue;
            const blocker = upstream.get(n.id)!.find((id) => BLOCKED.has(next[id].status));
            if (canceled) {
                next[n.id] = { ...state, status: "skipped", error: "Run canceled" };
            } else if (blocker) {
                next[n.id] = {
                    ...state,
                    status: "skipped",
                    error: `Skipped because upstream "${names.get(blocker)}" did not pass`,
                };
            } else {
                continue;
            }
            changed = true;
            again = true;
        }
    }
    const ready = inRun
        .filter((n) => next[n.id].status === "waiting" && upstream.get(n.id)!.every((id) => PASSED.has(next[id].status)))
        .map((n) => n.id);
    return { states: next, ready, changed };
}

// Applies a user command to a live run. Rejections leave `states` untouched and
// explain why; the runner is the only caller, so commands never race a tick.
export function applyCommand(
    graph: ChainGraph,
    states: NodeStates,
    command: RunCommand,
    canceled: boolean,
): { states: NodeStates; error: string | null } {
    const reject = (error: string) => ({ states, error });
    const node = graph.nodes.find((n) => n.id === command.nodeId);
    const name = `"${node?.name ?? command.nodeId}"`;
    if (command.kind === "trigger") {
        if (!node) return reject("That pipeline block is not part of this run");
        if (canceled) return reject("This chain is stopping. Wait for it to finish, then run the block again.");
        const own = states[node.id]?.status;
        if (own && ACTIVE.has(own)) return reject(`${name} is already running.`);
        if (own === "waiting") return reject(`${name} is already waiting to start in this run.`);
        const after = descendants(graph, node.id);
        const busy = after.find((id) => states[id] && ACTIVE.has(states[id].status));
        if (busy) {
            const busyName = graph.nodes.find((n) => n.id === busy)!.name;
            return reject(`Can't start ${name} while "${busyName}" is running. Stop it or wait for it to finish.`);
        }
        const next: NodeStates = { ...states, [node.id]: { status: "waiting", manual: true } };
        for (const id of after) next[id] = { status: "waiting" };
        return { states: next, error: null };
    }
    const state = node ? states[node.id] : undefined;
    if (!node || !state) return reject(`${name} is not part of this run`);
    if (state.stopRequested) return { states, error: null };
    if (state.status === "queuing" || (ACTIVE.has(state.status) && !state.buildId)) {
        return reject(`${name} is still being queued. Try again in a moment.`);
    }
    if (ACTIVE.has(state.status)) return { states: { ...states, [node.id]: { ...state, stopRequested: true } }, error: null };
    if (state.status === "waiting") return reject(`${name} isn't running yet`);
    return reject(`${name} has already finished`);
}

// Applies a saved edit to a live run. A block that isn't in the run joins it when it
// now runs after a block that is waiting or running. An edit never starts a pipeline:
// a block the edit alone would make ready leaves the run instead. A block still
// building in Azure DevOps is never dropped; if it was removed from the chain it stays
// in the run graph, unconnected, until it finishes (saves normally refuse that).
export function applyGraphEdit(
    prev: ChainGraph,
    edited: ChainGraph,
    states: NodeStates,
    canceled: boolean,
): { graph: ChainGraph; states: NodeStates } {
    const kept = new Set(edited.nodes.map((n) => n.id));
    const orphans = prev.nodes.filter((n) => !kept.has(n.id) && states[n.id] && ACTIVE.has(states[n.id].status));
    const graph: ChainGraph = { nodes: [...edited.nodes, ...orphans], edges: edited.edges };
    const next: NodeStates = {};
    for (const n of graph.nodes) if (states[n.id]) next[n.id] = states[n.id];
    let again = !canceled;
    while (again) {
        again = false;
        for (const n of graph.nodes) {
            if (next[n.id]) continue;
            const follows = graph.edges.some(
                (e) => e.to === n.id && next[e.from] && (next[e.from].status === "waiting" || ACTIVE.has(next[e.from].status)),
            );
            if (!follows) continue;
            next[n.id] = { status: "waiting" };
            again = true;
        }
    }
    const before = new Set(advance(prev, states, canceled).ready);
    for (;;) {
        const started = advance(graph, next, canceled).ready.filter((id) => !before.has(id));
        if (!started.length) break;
        for (const id of started) delete next[id];
    }
    return { graph, states: next };
}

// The newest passed build of each block, per pipeline and branch, across a chain's runs
// (given newest run first). It lets a later run consume what an earlier one built.
export function appBuildsFromRuns(runs: Array<{ runId: string; graph: ChainGraph; states: NodeStates }>): AppBuild[] {
    const seen = new Set<string>();
    const out: AppBuild[] = [];
    for (const run of runs) {
        for (const n of run.graph.nodes) {
            const s = run.states[n.id];
            if (!s || !PASSED.has(s.status) || !s.buildNumber) continue;
            // The branch it was queued on; runs from before that was recorded fall back to the block's.
            const branch = normalizeBranch(s.branch ?? n.branch);
            const repos = repoSignature(s.repoBranches);
            const key = [n.id, n.org.toLowerCase(), n.project.toLowerCase(), n.definitionId, branch, s.followed ?? "", repos].join("\u0000");
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                nodeId: n.id,
                runId: run.runId,
                org: n.org,
                project: n.project,
                definitionId: n.definitionId,
                branch,
                ...(s.followed ? { followed: s.followed } : {}),
                ...(repos ? { repos } : {}),
                buildNumber: s.buildNumber,
                ...(s.buildId ? { buildId: s.buildId } : {}),
                ...(s.url ? { url: s.url } : {}),
                ...(s.finishedAt ? { finishedAt: s.finishedAt } : {}),
            });
        }
    }
    return out;
}

/** What a block last did in a run of its chain, and which pipeline it was then. */
export interface BlockResult {
    nodeId: string;
    runId: string;
    org: string;
    project: string;
    definitionId: number;
    state: NodeRunState;
}

// Statuses of a block that never got as far as being queued in that run.
const NEVER_STARTED = new Set<NodeStatus>(["waiting", "skipped"]);

interface RunSnapshot {
    runId: string;
    graph: ChainGraph;
    states: NodeStates;
}

// The newest run in which each block actually ran, per pipeline (runs given newest run
// first). A later run that left a block out, skipped it or never reached it doesn't hide
// that, so running one block never wipes what the others last did.
export function blockResultsFromRuns(runs: RunSnapshot[]): BlockResult[] {
    const seen = new Set<string>();
    const out: BlockResult[] = [];
    for (const run of runs) {
        for (const n of run.graph.nodes) {
            const s = run.states[n.id];
            if (!s || NEVER_STARTED.has(s.status)) continue;
            const key = [n.id, n.org.toLowerCase(), n.project.toLowerCase(), n.definitionId].join("\u0000");
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ nodeId: n.id, runId: run.runId, org: n.org, project: n.project, definitionId: n.definitionId, state: s });
        }
    }
    return out;
}

/** The same pipeline in the same organization and project. */
export function sameDefinition(
    a: { org: string; project: string; definitionId: number },
    b: { org: string; project: string; definitionId: number },
): boolean {
    return (
        a.definitionId === b.definitionId &&
        a.org.toLowerCase() === b.org.toLowerCase() &&
        a.project.toLowerCase() === b.project.toLowerCase()
    );
}

// Which finished runs (newest first) to keep: the newest `recent`, plus any older run that
// holds a current block's last result or last build. Scoped runs are one per "Run from
// here", so without this a busy chain would push a block's last result and the builds
// later blocks consume out of history.
export function retainedRunIds(runs: RunSnapshot[], graph: ChainGraph, recent: number): Set<string> {
    const keep = new Set(runs.slice(0, recent).map((r) => r.runId));
    const current = new Map(graph.nodes.map((n) => [n.id, n]));
    const isCurrent = (r: { nodeId: string; org: string; project: string; definitionId: number }) => {
        const n = current.get(r.nodeId);
        return !!n && sameDefinition(n, r);
    };
    for (const r of blockResultsFromRuns(runs)) if (isCurrent(r)) keep.add(r.runId);
    for (const b of appBuildsFromRuns(runs)) if (isCurrent(b)) keep.add(b.runId);
    return keep;
}

/** A followed PR as one string: lowercased org and the PR's id. */
export const prKey = (ref: PrRef): string => `${ref.org.toLowerCase()}/${ref.prId}`;

/** The block's newest build from this app, if it was the same pipeline on the same branches (or following the same PR). */
export function lastAppBuild(node: ChainNode, builds: AppBuild[]): AppBuild | undefined {
    const branch = normalizeBranch(node.branch);
    const followed = node.branchFrom ? prKey(node.branchFrom) : null;
    const repos = repoSignature(node.repoBranches);
    return builds.find(
        (b) =>
            b.nodeId === node.id &&
            b.definitionId === node.definitionId &&
            // A block that follows a PR counts only builds of that PR, whatever its branch is called.
            (followed ? b.followed === followed : b.branch === branch) &&
            // Built against other branches of its repository resources, it's a different build.
            (b.repos ?? "") === repos &&
            b.org.toLowerCase() === node.org.toLowerCase() &&
            b.project.toLowerCase() === node.project.toLowerCase(),
    );
}

interface UpstreamBuild {
    /** 1 = a direct parent. */
    distance: number;
    buildNumber: string;
    /** Set when the build came from an earlier run. */
    runId?: string;
}

// Earlier blocks (through any arrows) with a build to give: the build a block passed
// with in this run, or else its newest build from an earlier run of the chain (`past`).
function upstreamBuilds(graph: ChainGraph, states: NodeStates, id: string, past: AppBuild[]): Map<string, UpstreamBuild> {
    const distance = new Map<string, number>();
    let frontier = [id];
    for (let d = 1; frontier.length; d++) {
        const next: string[] = [];
        for (const to of frontier) {
            for (const e of graph.edges) {
                if (e.to !== to || e.from === id || distance.has(e.from)) continue;
                distance.set(e.from, d);
                next.push(e.from);
            }
        }
        frontier = next;
    }
    const out = new Map<string, UpstreamBuild>();
    for (const [from, d] of distance) {
        const s = states[from];
        if (s && PASSED.has(s.status) && s.buildNumber) {
            out.set(from, { distance: d, buildNumber: s.buildNumber });
            continue;
        }
        const node = graph.nodes.find((n) => n.id === from);
        const earlier = node && lastAppBuild(node, past);
        if (earlier) out.set(from, { distance: d, buildNumber: earlier.buildNumber, runId: earlier.runId });
    }
    return out;
}

export const hasUpstreamBuild = (graph: ChainGraph, states: NodeStates, id: string, past: AppBuild[] = []): boolean =>
    upstreamBuilds(graph, states, id, past).size > 0;

export const pipelineKey = (value: string): string =>
    value.replace(/\//g, "\\").replace(/^\\+|\\+$/g, "").toLowerCase();

// Pins each pipeline resource of block `id` to the build an earlier block made in this
// app, so a release consumes what its chain built instead of ADO's default (the latest
// successful run). Builds from this run come first; only when there are none does an
// earlier run of the chain (`past`) count, since a build this run made is always newer.
// Within that, the nearest block wins; a tie is an error, never a guess. A resource
// with no such block keeps the default.
export function resolvePins(
    graph: ChainGraph,
    states: NodeStates,
    id: string,
    resources: PipelineResource[],
    past: AppBuild[] = [],
): { pins: ResourcePin[]; error: string | null } {
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) return { pins: [], error: null };
    const builds = upstreamBuilds(graph, states, id, past);
    const org = node.org.toLowerCase();
    const pins: ResourcePin[] = [];
    for (const r of resources) {
        const want = pipelineKey(r.name);
        const withPath = want.includes("\\");
        const project = (r.project || node.project).toLowerCase();
        const matches = graph.nodes.filter(
            (n) =>
                builds.has(n.id) &&
                n.org.toLowerCase() === org &&
                n.project.toLowerCase() === project &&
                (withPath ? pipelineKey(`${n.path}\\${n.name}`) : n.name.toLowerCase()) === want,
        );
        if (!matches.length) continue;
        const fresh = matches.filter((n) => !builds.get(n.id)!.runId);
        const pool = fresh.length ? fresh : matches;
        const nearest = Math.min(...pool.map((n) => builds.get(n.id)!.distance));
        const best = pool.filter((n) => builds.get(n.id)!.distance === nearest);
        if (best.length > 1) {
            return {
                pins: [],
                error: `"${node.name}" consumes "${r.name}", but ${best.length} blocks equally close before it have a build of that pipeline. Remove one of the arrows so it knows which build to use.`,
            };
        }
        const build = builds.get(best[0].id)!;
        pins.push({ alias: r.alias, version: build.buildNumber, from: best[0].id, ...(build.runId ? { runId: build.runId } : {}) });
    }
    return { pins, error: null };
}

// The run-parameters data provider's `type` is a numeric code; unknown codes fall back
// to the shape of the default.
const PARAM_KINDS: Record<number, RunParameterKind> = { 0: "string", 1: "object", 2: "number", 3: "boolean", 4: "string" };
const KIND_NAMES = new Set<string>(["string", "number", "boolean", "object"]);

function paramText(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** "Deploy\n_____\nRegion" -> "Deploy — Region": pipeline authors use underscore lines as dividers. */
export function parameterLabel(displayName: unknown, name: string): string {
    if (typeof displayName !== "string") return name;
    const parts = displayName
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !/^_+$/.test(line));
    return parts.join(" — ").slice(0, 300) || name;
}

export function mapRunParameters(raw: unknown): RunParameter[] {
    if (!Array.isArray(raw)) return [];
    const out: RunParameter[] = [];
    for (const item of raw) {
        const p = (item ?? {}) as Record<string, unknown>;
        const name = typeof p.name === "string" ? p.name : "";
        if (!name) continue;
        const values = Array.isArray(p.values) && p.values.length ? p.values.map(paramText) : undefined;
        let kind: RunParameterKind | undefined =
            typeof p.type === "number" ? PARAM_KINDS[p.type] : KIND_NAMES.has(String(p.type)) ? (p.type as RunParameterKind) : undefined;
        if (!kind) {
            const d = p.default;
            if (values || d === undefined || d === null || typeof d === "string") kind = "string";
            else if (typeof d === "boolean") kind = "boolean";
            else if (typeof d === "number") kind = "number";
            else kind = "object";
        }
        out.push({
            name,
            label: parameterLabel(p.displayName, name),
            kind,
            default: paramText(p.default),
            ...(values && kind !== "boolean" ? { values } : {}),
        });
    }
    return out;
}

/** The run-parameters data provider's `repositoryResources`, without the pipeline's own (`self`). */
export function mapRepositoryResources(raw: unknown): RepositoryResource[] {
    if (!Array.isArray(raw)) return [];
    const out: RepositoryResource[] = [];
    const seen = new Set<string>();
    for (const r of raw as Array<Record<string, unknown>>) {
        const alias = typeof r?.alias === "string" ? r.alias.trim() : "";
        if (!alias || alias.toLowerCase() === "self" || seen.has(alias.toLowerCase())) continue;
        seen.add(alias.toLowerCase());
        const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : alias;
        const project = typeof r.projectName === "string" ? r.projectName.trim() : "";
        const id = typeof r.id === "string" ? r.id.trim() : "";
        out.push({
            alias,
            name,
            type: typeof r.type === "string" ? r.type : "",
            ...(project ? { project } : {}),
            ...(id ? { id } : {}),
            ref: typeof r.refName === "string" ? normalizeBranch(r.refName) : "",
        });
    }
    return out;
}

/** Why these overrides can't be sent to the pipeline, or null. */
export function checkParams(params: Record<string, string> | undefined, defs: RunParameter[]): string | null {
    const byName = new Map(defs.map((d) => [d.name, d]));
    for (const [name, value] of Object.entries(params ?? {})) {
        const def = byName.get(name);
        if (!def) return `Parameter "${name}" no longer exists in this pipeline. Remove it from the block's parameters.`;
        if (def.kind === "boolean" && !/^(true|false)$/i.test(value)) return `Parameter "${def.label}" must be true or false`;
        if (def.kind === "number" && (!value.trim() || !Number.isFinite(Number(value)))) {
            return `Parameter "${def.label}" must be a number`;
        }
        if (def.values && !def.values.includes(value)) {
            const list = def.values.slice(0, 10).join(", ") + (def.values.length > 10 ? ", …" : "");
            return `Parameter "${def.label}" must be one of: ${list}`;
        }
    }
    return null;
}

/** Body for the Pipelines Run (and Preview) API. */
export function pipelineRunBody(
    branch: string,
    pins: ResourcePin[],
    params: Record<string, string> | undefined,
    repos?: Record<string, string>,
): Record<string, unknown> {
    const resources: Record<string, unknown> = {};
    const ref = normalizeBranch(branch);
    const repositories: Record<string, { refName: string }> = {};
    if (ref) repositories.self = { refName: ref };
    for (const [alias, branchName] of Object.entries(repos ?? {})) {
        const refName = normalizeBranch(branchName);
        if (refName && alias.toLowerCase() !== "self") repositories[alias] = { refName };
    }
    if (Object.keys(repositories).length) resources.repositories = repositories;
    if (pins.length) resources.pipelines = Object.fromEntries(pins.map((p) => [p.alias, { version: p.version }]));
    return { resources, ...(params && Object.keys(params).length ? { templateParameters: params } : {}) };
}

// A Pipelines Run shares its id with the build; its state maps onto build statuses.
export function runToBuild(raw: unknown): BuildInfo {
    const run = (raw ?? {}) as Record<string, any>;
    const status =
        run.state === "completed"
            ? "completed"
            : run.state === "inProgress"
              ? "inProgress"
              : run.state === "canceling"
                ? "cancelling"
                : "notStarted";
    return {
        id: Number(run.id),
        buildNumber: typeof run.name === "string" ? run.name : undefined,
        status,
        result: run.result,
        url: run._links?.web?.href,
        finishTime: run.finishedDate,
    };
}

export function runOutcome(states: NodeStates): RunOutcome | null {
    const all = Object.values(states);
    if (all.some((s) => !TERMINAL.has(s.status))) return null;
    if (all.some((s) => s.status === "failed" || s.status === "error")) return "failed";
    if (all.some((s) => s.status === "canceled" || s.status === "skipped")) return "canceled";
    return "succeeded";
}

export function buildStatus(build: BuildInfo): NodeStatus {
    switch (build.status) {
        case "completed":
            if (build.result === "succeeded") return "succeeded";
            if (build.result === "partiallySucceeded") return "partiallySucceeded";
            if (build.result === "canceled") return "canceled";
            return "failed";
        case "inProgress":
        case "cancelling":
            return "running";
        default:
            return "queued";
    }
}

export function applyBuild(prev: NodeRunState, build: BuildInfo): NodeRunState {
    const { pollFailures: _failures, pollError: _pollError, ...rest } = prev;
    return {
        ...rest,
        status: buildStatus(build),
        buildId: build.id,
        buildNumber: build.buildNumber ?? prev.buildNumber,
        url: build.url ?? prev.url,
        startedAt: build.startTime ?? prev.startedAt,
        finishedAt: build.finishTime ?? prev.finishedAt,
    };
}

// A block left "queuing" may or may not exist in ADO (the app stopped mid-POST),
// so it is surfaced as an error instead of being queued a second time.
export function recoverInterrupted(states: NodeStates): { states: NodeStates; changed: boolean } {
    let changed = false;
    const next: NodeStates = {};
    for (const [id, state] of Object.entries(states)) {
        if (state.status === "queuing" && !state.buildId) {
            changed = true;
            next[id] = {
                ...state,
                status: "error",
                error: "Interrupted while queuing. Check Azure DevOps before running this chain again.",
                finishedAt: new Date().toISOString(),
            };
        } else {
            next[id] = state;
        }
    }
    return { states: next, changed };
}
