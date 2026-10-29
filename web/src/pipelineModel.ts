// Pure helpers behind the Pipelines view: catalog search, chain editing rules,
// canvas geometry, and run presentation. No DOM access, so the harness can load it.

export const NODE_W = 248;
export const NODE_H = 88;
export const GRID = 8;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
const COL_GAP = 96;
const ROW_GAP = 40;

export type QueueStatus = "enabled" | "paused" | "disabled";

export interface CatalogPipeline {
  org: string;
  project: string;
  id: number;
  name: string;
  path: string;
  url: string;
  queueStatus: QueueStatus;
  latest?: { status?: string; result?: string; buildNumber?: string; finishTime?: string } | null;
}

export interface CatalogGroup {
  key: string;
  org: string;
  project: string;
  items: CatalogPipeline[];
}

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
  /** Runtime parameter overrides by name. Absent when every parameter keeps its default. */
  params?: Record<string, string>;
  /** Branches for the YAML's repository resources, by alias. Absent when each uses the ref in the YAML. */
  repoBranches?: Record<string, string>;
  /** Build this PR's source branch, read when the block queues (a task's validation chain). */
  branchFrom?: PrRef;
}

export interface PrRef {
  org: string;
  prId: number;
}

/** What a block builds, for labels: the PR it follows, its branch, or the default. */
export function nodeBranchLabel(n: Pick<ChainNode, "branch" | "branchFrom">): string {
  if (n.branchFrom) return `PR ${n.branchFrom.prId}'s branch`;
  return (n.branch || "").trim().replace(/^refs\/heads\//, "") || "Default branch";
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
  /** Started on its own ("Run from here"): it doesn't wait for the blocks before it. */
  manual?: boolean;
  stopRequested?: boolean;
  /** Pipeline resources pinned to builds earlier blocks produced in this app. */
  resources?: ResourcePin[];
  /** Parameter overrides this block was queued with. */
  params?: Record<string, string>;
  /** Repository resources it was queued on, by the YAML's alias (refs/heads/…). */
  repoBranches?: Record<string, string>;
  /** Branch it was queued on ("" = the pipeline's default branch). */
  branch?: string;
}

export interface ResourcePin {
  /** The `resources.pipelines` alias in the consuming pipeline's YAML. */
  alias: string;
  /** Build number of the consumed build. */
  version: string;
  /** The block that built it. */
  from: string;
  /** The earlier run that built it; absent when it was built in this run. */
  runId?: string;
}

/** A block's newest passed build in this app, for one pipeline and branch. */
export interface AppBuild {
  nodeId: string;
  runId: string;
  org: string;
  project: string;
  definitionId: number;
  branch: string;
  /** The PR it followed then ("org/prId", lowercased org), if it did. */
  followed?: string;
  /** Repository resource branches it was queued with (repoSignature); absent for none. */
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
  name: string;
  /** "TfsGit" for Azure Repos, "GitHub", … */
  type: string;
  project?: string;
  id?: string;
  /** The ref the YAML names (refs/heads/…), or "" for the repository's default branch. */
  ref: string;
}

export type RunParameterKind = "string" | "number" | "boolean" | "object";

/** A runtime parameter of a YAML pipeline. Values travel as text; objects as YAML or JSON. */
export interface RunParameter {
  name: string;
  label: string;
  kind: RunParameterKind;
  default: string;
  values?: string[];
}

/** What /api/pipeline-definition-info returns for a block's pipeline and branch. */
export interface DefinitionInfo {
  yaml: boolean;
  defaultBranch: string;
  parameters: RunParameter[];
  resources: PipelineResource[];
  /** Absent from an older background service. */
  repositories?: RepositoryResource[];
  errors: string[];
}

export type RunStatus = "running" | "succeeded" | "failed" | "canceled";

export interface ChainRun {
  runId: string;
  chainId: string;
  status: RunStatus;
  graph: ChainGraph;
  states: Record<string, NodeRunState>;
  cancelRequested: boolean;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string | null;
}

export interface ChainSummary {
  id: string;
  name: string;
  nodeCount: number;
  updatedAt: string;
  lastRun: { runId: string; status: RunStatus; createdAt: string; finishedAt?: string | null } | null;
  /** The Jarvis task whose validation this chain is; null for the user's own chains. */
  owner?: { taskId: string; title: string; status: string } | null;
}

export interface View {
  x: number;
  y: number;
  zoom: number;
}

export type Tone = "ok" | "warn" | "bad" | "run" | "off" | "idle";

// ---- catalog -------------------------------------------------------------------------

export const scopeKey = (p: { org: string; project: string }): string => `${p.org}/${p.project}`;

/** Every whitespace-separated token must appear in the name, folder path, or project. */
export function filterPipelines(list: CatalogPipeline[], query: string, scope: string): CatalogPipeline[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((p) => {
    if (scope && scopeKey(p) !== scope) return false;
    if (!tokens.length) return true;
    const hay = `${p.name}\n${p.path}\n${p.project}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}

const byText = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

export function groupPipelines(list: CatalogPipeline[]): CatalogGroup[] {
  const groups = new Map<string, CatalogGroup>();
  for (const p of list) {
    const key = scopeKey(p);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { key, org: p.org, project: p.project, items: [] }));
    group.items.push(p);
  }
  const out = [...groups.values()].sort((a, b) => byText(a.org, b.org) || byText(a.project, b.project));
  for (const g of out) g.items.sort((a, b) => byText(a.name, b.name) || a.id - b.id);
  return out;
}

/** Tone of a definition's latest completed build, for the catalog dot. */
export function latestTone(latest: CatalogPipeline["latest"]): Tone {
  if (!latest) return "idle";
  if (latest.status && latest.status !== "completed") return "run";
  switch (latest.result) {
    case "succeeded":
      return "ok";
    case "partiallySucceeded":
      return "warn";
    case "failed":
      return "bad";
    case "canceled":
      return "off";
    default:
      return "idle";
  }
}

// ---- chain editing rules ------------------------------------------------------------------

function reaches(edges: ChainEdge[], from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of edges) if (e.from === id) stack.push(e.to);
  }
  return false;
}

/** Whether an arrow from → to (to runs after from) is allowed, with the reason if not. */
export function canConnect(graph: ChainGraph, from: string, to: string): { ok: boolean; reason?: string } {
  if (from === to) return { ok: false, reason: "A pipeline cannot run after itself" };
  const ids = new Set(graph.nodes.map((n) => n.id));
  if (!ids.has(from) || !ids.has(to)) return { ok: false, reason: "Unknown pipeline block" };
  if (graph.edges.some((e) => e.from === from && e.to === to)) return { ok: false, reason: "These blocks are already connected" };
  if (reaches(graph.edges, to, from)) return { ok: false, reason: "That arrow would create a loop" };
  return { ok: true };
}

/** Blocks that could be added as a direct upstream of `id`. */
export function upstreamCandidates(graph: ChainGraph, id: string): string[] {
  return graph.nodes.map((n) => n.id).filter((other) => canConnect(graph, other, id).ok);
}

export function nextNodeId(nodes: { id: string }[]): string {
  let max = 0;
  for (const n of nodes) {
    const m = /^n(\d+)$/.exec(n.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `n${max + 1}`;
}

/** Longest-path depth of every node (roots are 0); nodes caught in a loop are omitted. */
function depths(nodes: { id: string }[], edges: ChainEdge[]): Map<string, number> {
  const ids = new Set(nodes.map((n) => n.id));
  const live = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of live) indegree.set(e.to, (indegree.get(e.to) || 0) + 1);
  const depth = new Map<string, number>();
  const queue = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  for (const id of queue) depth.set(id, 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of live) {
      if (e.from !== id) continue;
      depth.set(e.to, Math.max(depth.get(e.to) ?? 0, depth.get(id)! + 1));
      const left = indegree.get(e.to)! - 1;
      indegree.set(e.to, left);
      if (left === 0) queue.push(e.to);
    }
  }
  for (const id of [...depth.keys()]) if (indegree.get(id)! > 0) depth.delete(id);
  return depth;
}

/** Execution stages: each stage starts once every pipeline before it has passed. */
export function stages(graph: ChainGraph): string[][] {
  const depth = depths(graph.nodes, graph.edges);
  const out: string[][] = [];
  for (const n of graph.nodes) {
    const d = depth.get(n.id);
    if (d === undefined) continue;
    (out[d] ||= []).push(n.id);
  }
  return out.filter(Boolean);
}

/** Every block reachable after `id`, in graph order (excluding `id`). Mirrors the runner. */
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

const ACTIVE_STATES = new Set(["queuing", "queued", "running"]);
const PASSED_STATES = new Set(["succeeded", "partiallySucceeded"]);
const BLOCKED_STATES = new Set(["failed", "canceled", "skipped", "error"]);
export const isActive = (status: string | undefined): boolean => !!status && ACTIVE_STATES.has(status);

export interface TriggerScope {
  /** The block and everything after it, in graph order. */
  ids: string[];
  /** Blocks after it that also wait for pipelines already in the live run (fan-in). */
  waits: { id: string; on: string[] }[];
  /** Blocks after it that will be skipped because a pipeline in the live run didn't pass. */
  skips: { id: string; because: string }[];
  /** Why the runner would refuse it, or null. */
  blocked: string | null;
}

// "Run from here": what starting `id` would do, using the runner's rules. `live` is the
// states of the chain's running run (null when idle, which starts a new run of just this scope).
export function triggerScope(
  graph: ChainGraph,
  live: Record<string, NodeRunState> | null,
  id: string,
  canceled = false
): TriggerScope {
  const name = (x: string): string => `"${graph.nodes.find((n) => n.id === x)?.name ?? x}"`;
  const after = descendants(graph, id);
  const ids = [id, ...after];
  const out: TriggerScope = { ids, waits: [], skips: [], blocked: null };
  if (!live) return out;
  const own = live[id]?.status;
  const busy = after.find((x) => isActive(live[x]?.status));
  if (canceled) out.blocked = "This chain is stopping. Wait for it to finish, then run the block again.";
  else if (isActive(own)) out.blocked = `${name(id)} is already running.`;
  else if (own === "waiting") out.blocked = `${name(id)} is already waiting to start in this run.`;
  else if (busy) out.blocked = `Can't start ${name(id)} while ${name(busy)} is running. Stop it or wait for it to finish.`;
  if (out.blocked) return out;
  const scope = new Set(ids);
  const status = new Map<string, string>();
  for (const [x, s] of Object.entries(live)) status.set(x, s.status);
  for (const x of ids) status.set(x, "waiting");
  const skipped = new Set<string>();
  let again = true;
  while (again) {
    again = false;
    for (const x of after) {
      if (skipped.has(x)) continue;
      const blocker = graph.edges.find(
        (e) => e.to === x && status.has(e.from) && (skipped.has(e.from) || (!scope.has(e.from) && BLOCKED_STATES.has(status.get(e.from)!)))
      );
      if (!blocker) continue;
      skipped.add(x);
      out.skips.push({ id: x, because: blocker.from });
      again = true;
    }
  }
  for (const x of after) {
    if (skipped.has(x)) continue;
    const on = graph.edges
      .filter((e) => e.to === x && !scope.has(e.from) && status.has(e.from) && !PASSED_STATES.has(status.get(e.from)!))
      .map((e) => e.from);
    if (on.length) out.waits.push({ id: x, on });
  }
  return out;
}

/** Whether a block of a live run can be stopped right now, with the reason if not. */
export function stopCheck(state: NodeRunState | undefined): { ok: boolean; reason?: string } {
  if (!state) return { ok: false, reason: "Not part of this run" };
  if (state.stopRequested) return { ok: false, reason: "Stopping…" };
  if (state.status === "queuing" || (isActive(state.status) && !state.buildId)) return { ok: false, reason: "Still being queued. Try again in a moment." };
  if (isActive(state.status)) return { ok: true };
  return { ok: false, reason: state.status === "waiting" ? "Hasn't started yet" : "Already finished" };
}

export function normalizeBranch(branch: string): string {
  const b = (branch || "").trim();
  if (!b) return "";
  return b.startsWith("refs/") ? b : `refs/heads/${b}`;
}

/** Repository branches as one comparable string ("" for none). Mirrors the server's. */
export function repoSignature(repos: Record<string, string> | undefined): string {
  return Object.entries(repos ?? {})
    .map(([alias, branch]) => `${alias.toLowerCase()}=${normalizeBranch(branch)}`)
    .filter((entry) => !entry.endsWith("="))
    .sort()
    .join("\n");
}

/** The block's newest build from this app, if it was the same pipeline on the same branches (or following the same PR). */
export function lastAppBuild(node: ChainNode, builds: AppBuild[]): AppBuild | undefined {
  const branch = normalizeBranch(node.branch);
  const followed = node.branchFrom ? `${node.branchFrom.org.toLowerCase()}/${node.branchFrom.prId}` : null;
  const repos = repoSignature(node.repoBranches);
  return builds.find(
    (b) =>
      b.nodeId === node.id &&
      b.definitionId === node.definitionId &&
      (followed ? b.followed === followed : b.branch === branch) &&
      (b.repos ?? "") === repos &&
      b.org.toLowerCase() === node.org.toLowerCase() &&
      b.project.toLowerCase() === node.project.toLowerCase(),
  );
}

/** What a run executes: blocks, their pipelines and branches, and arrows (not layout or names). */
export function topologySignature(graph: ChainGraph): string {
  const nodes = graph.nodes
    .map((n) => [
      n.id,
      n.org.toLowerCase(),
      n.project.toLowerCase(),
      n.definitionId,
      n.branchFrom ? `pr:${n.branchFrom.org.toLowerCase()}/${n.branchFrom.prId}` : normalizeBranch(n.branch),
      repoSignature(n.repoBranches),
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const edges = graph.edges.map((e) => `${e.from}>${e.to}`).sort();
  return JSON.stringify([nodes, edges]);
}

// ---- per-block results -----------------------------------------------------------------------

/** What a block last did in a run of its chain, and which pipeline it was then. */
export interface BlockResult {
  nodeId: string;
  runId: string;
  org: string;
  project: string;
  definitionId: number;
  state: NodeRunState;
}

/** What to show for one block, and where it comes from. */
export interface BlockView {
  state: NodeRunState;
  runId: string;
  /** From the run in progress, so it keeps changing. */
  live: boolean;
  /** From a run before the newest one. */
  earlier: boolean;
}

const sameDefinition = (
  a: { org: string; project: string; definitionId: number },
  b: { org: string; project: string; definitionId: number }
): boolean =>
  a.definitionId === b.definitionId && a.org.toLowerCase() === b.org.toLowerCase() && a.project.toLowerCase() === b.project.toLowerCase();

/**
 * What each block shows: its state in the newest run if that run has it, otherwise what it last
 * did in an earlier run. Running one block (a run scoped to it and what follows) therefore
 * never hides what the blocks before it last did. A block shows nothing for a pipeline it
 * wasn't running when it ran, so swapping a block's pipeline drops its old result. Branches
 * and arrows don't count: editing them keeps the result.
 */
export function blockViews(graph: ChainGraph, run: ChainRun | null, results: BlockResult[]): Record<string, BlockView> {
  const out: Record<string, BlockView> = {};
  for (const node of graph.nodes) {
    const own = run?.states[node.id];
    if (run && own) {
      const ran = run.graph.nodes.find((n) => n.id === node.id);
      if (run.status === "running") {
        out[node.id] = { state: own, runId: run.runId, live: true, earlier: false };
        continue;
      }
      if (ran && sameDefinition(ran, node) && own.status !== "waiting") {
        out[node.id] = { state: own, runId: run.runId, live: false, earlier: false };
        continue;
      }
    }
    const last = results.find((r) => r.nodeId === node.id && sameDefinition(r, node));
    if (last) out[node.id] = { state: last.state, runId: last.runId, live: false, earlier: last.runId !== run?.runId };
  }
  return out;
}

// ---- live edits, parameters, and consumed builds ---------------------------------------------

/**
 * The block an edit would take out of a live run while it builds in Azure DevOps (removed, or
 * pointed at another pipeline), or null. Mirrors the server's save rule.
 */
export function activeRemoval(
  live: { graph: ChainGraph; states: Record<string, NodeRunState> } | null,
  next: ChainGraph
): string | null {
  if (!live) return null;
  const kept = new Map(next.nodes.map((n) => [n.id, n]));
  for (const [id, s] of Object.entries(live.states)) {
    if (!isActive(s.status)) continue;
    const was = live.graph.nodes.find((n) => n.id === id);
    const now = kept.get(id);
    if (!now || !was || now.org !== was.org || now.project !== was.project || now.definitionId !== was.definitionId) return was?.name ?? id;
  }
  return null;
}

/** Sets (or, when `value` is undefined, clears) one override in place. Undefined once none remain. */
export function setParam(
  params: Record<string, string> | undefined,
  name: string,
  value: string | undefined
): Record<string, string> | undefined {
  const entries = Object.entries(params ?? {});
  const i = entries.findIndex(([k]) => k === name);
  if (value === undefined) {
    if (i >= 0) entries.splice(i, 1);
  } else if (i >= 0) entries[i] = [name, value];
  else entries.push([name, value]);
  // fromEntries defines own properties, so a "__proto__" name stays plain data.
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Whether `value` is just the parameter's default (booleans compare case-insensitively). */
export function isDefaultValue(def: RunParameter, value: string): boolean {
  return def.kind === "boolean" ? value.toLowerCase() === def.default.toLowerCase() : value === def.default;
}

/** Why `value` can't be sent for `def`, or null. Mirrors the runner's check at queue time. */
export function paramProblem(def: RunParameter, value: string): string | null {
  if (def.kind === "boolean" && !/^(true|false)$/i.test(value)) return "Must be true or false";
  if (def.kind === "number" && (!value.trim() || !Number.isFinite(Number(value)))) return "Must be a number";
  if (def.values && !def.values.includes(value)) return "Not one of the allowed values";
  return null;
}

export interface ParamSummary {
  total: number;
  /** Overrides of parameters the pipeline still has. */
  changed: number;
  /** Overrides the runner would refuse because of their value. */
  invalid: number;
  /** Overrides of parameters the pipeline no longer has (the runner refuses these too). */
  stale: string[];
}

export function paramSummary(defs: RunParameter[], params: Record<string, string> | undefined): ParamSummary {
  const byName = new Map(defs.map((d) => [d.name, d]));
  const out: ParamSummary = { total: defs.length, changed: 0, invalid: 0, stale: [] };
  for (const [name, value] of Object.entries(params ?? {})) {
    const def = byName.get(name);
    if (!def) {
      out.stale.push(name);
      continue;
    }
    out.changed++;
    if (paramProblem(def, value)) out.invalid++;
  }
  return out;
}

export interface ResourceSource {
  alias: string;
  name: string;
  /** The block whose build it uses when both run in the same chain run, or null. */
  from: string | null;
  /** Equally near blocks that build it: the runner refuses to guess between them. */
  tied: string[];
}

export interface RepoSummary {
  /** Repositories the YAML lists (besides its own). */
  total: number;
  /** Branches set for repositories the YAML still lists. */
  changed: number;
  /** Aliases with a branch set that the YAML no longer lists (the runner refuses these). */
  stale: string[];
}

/** How a block's repository branches stand against the YAML. Mirrors the runner's check (aliases match case-insensitively). */
export function repoSummary(repos: RepositoryResource[], repoBranches: Record<string, string> | undefined): RepoSummary {
  const known = new Set(repos.map((r) => r.alias.toLowerCase()));
  const out: RepoSummary = { total: repos.length, changed: 0, stale: [] };
  for (const [alias, branch] of Object.entries(repoBranches ?? {})) {
    if (!branch.trim()) continue;
    if (known.has(alias.toLowerCase())) out.changed++;
    else out.stale.push(alias);
  }
  return out;
}

/** The branch set for a repository resource, matching its alias case-insensitively; "" when none. */
export function repoBranchFor(repoBranches: Record<string, string> | undefined, alias: string): string {
  const want = alias.toLowerCase();
  for (const [k, v] of Object.entries(repoBranches ?? {})) if (k.toLowerCase() === want) return v;
  return "";
}

/** Sets (or, for a blank branch, clears) one repository's branch, under the YAML's alias spelling. Undefined once none remain. */
export function setRepoBranch(
  repoBranches: Record<string, string> | undefined,
  alias: string,
  branch: string
): Record<string, string> | undefined {
  const want = alias.toLowerCase();
  const entries = Object.entries(repoBranches ?? {}).filter(([k]) => k.toLowerCase() !== want);
  if (branch.trim()) entries.push([alias, branch]);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

const resourceKey = (value: string): string => value.replace(/\//g, "\\").replace(/^\\+|\\+$/g, "").toLowerCase();

/**
 * Which earlier block's build each pipeline resource of block `id` uses, by the runner's rule:
 * the nearest block (through any arrows) that builds that pipeline. The runner pins it only
 * when that block passed earlier in the same run; otherwise Azure DevOps picks its default.
 */
export function resourceSources(graph: ChainGraph, id: string, resources: PipelineResource[]): ResourceSource[] {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return [];
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
  const org = node.org.toLowerCase();
  return resources.map((r) => {
    const want = resourceKey(r.name);
    const withPath = want.includes("\\");
    const project = (r.project || node.project).toLowerCase();
    const matches = graph.nodes.filter(
      (n) =>
        distance.has(n.id) &&
        n.org.toLowerCase() === org &&
        n.project.toLowerCase() === project &&
        (withPath ? resourceKey(`${n.path}\\${n.name}`) : n.name.toLowerCase()) === want
    );
    const nearest = Math.min(...matches.map((n) => distance.get(n.id)!));
    const best = matches.filter((n) => distance.get(n.id) === nearest);
    return { alias: r.alias, name: r.name, from: best.length === 1 ? best[0].id : null, tied: best.length > 1 ? best.map((n) => n.id) : [] };
  });
}

// ---- canvas geometry ------------------------------------------------------------------------

export const snap = (v: number): number => Math.round(v / GRID) * GRID;

/** Cubic edge from a block's right port to the next block's left port, in world space. */
export function edgePath(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const sx = from.x + NODE_W;
  const sy = from.y + NODE_H / 2;
  const tx = to.x;
  const ty = to.y + NODE_H / 2;
  const dx = Math.max(48, Math.abs(tx - sx) / 2);
  return `M ${sx} ${sy} C ${sx + dx} ${sy} ${tx - dx} ${ty} ${tx} ${ty}`;
}

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** Zoom to `nextZoom` keeping the screen point (cx, cy) over the same world point. */
export function zoomAt(view: View, nextZoom: number, cx: number, cy: number): View {
  const zoom = clampZoom(nextZoom);
  const wx = (cx - view.x) / view.zoom;
  const wy = (cy - view.y) / view.zoom;
  return { x: cx - wx * zoom, y: cy - wy * zoom, zoom };
}

export function bounds(nodes: { x: number; y: number }[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + NODE_W);
    maxY = Math.max(maxY, n.y + NODE_H);
  }
  return { minX, minY, maxX, maxY };
}

/** Center every block in a W×H viewport, shrinking (never enlarging past 100%) to fit. */
export function fitTransform(nodes: { x: number; y: number }[], width: number, height: number, pad = 48): View {
  if (!nodes.length) return { x: pad, y: pad, zoom: 1 };
  const b = bounds(nodes);
  const bw = b.maxX - b.minX;
  const bh = b.maxY - b.minY;
  const fitZoom = Math.min(1, Math.max(1, width - pad * 2) / bw, Math.max(1, height - pad * 2) / bh);
  const zoom = clampZoom(Math.floor(fitZoom * 100) / 100);
  return {
    x: Math.round((width - bw * zoom) / 2 - b.minX * zoom),
    y: Math.round((height - bh * zoom) / 2 - b.minY * zoom),
    zoom,
  };
}

function overlaps(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.abs(a.x - b.x) < NODE_W + 16 && Math.abs(a.y - b.y) < NODE_H + 16;
}

/** Where a new block goes: the drop point (snapped), or beside the right-most block. */
export function placeNewNode(nodes: { x: number; y: number }[], drop?: { x: number; y: number }): { x: number; y: number } {
  let pos: { x: number; y: number };
  if (drop) pos = { x: snap(drop.x), y: snap(drop.y) };
  else if (!nodes.length) return { x: 0, y: 0 };
  else {
    const last = nodes.reduce((a, b) => (b.x > a.x || (b.x === a.x && b.y > a.y) ? b : a));
    pos = { x: snap(last.x + NODE_W + COL_GAP), y: snap(last.y) };
  }
  for (let i = 0; i < 200 && nodes.some((n) => overlaps(n, pos)); i++) pos = { x: pos.x, y: pos.y + NODE_H + ROW_GAP };
  return pos;
}

/** Left-to-right layout: columns by longest path, rows ordered to keep arrows short. */
export function autoLayout<T extends ChainNode>(nodes: T[], edges: ChainEdge[]): T[] {
  const depth = depths(nodes, edges);
  const maxDepth = Math.max(0, ...depth.values());
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, maxDepth + 1);
  const columns: T[][] = [];
  for (const n of nodes) (columns[depth.get(n.id)!] ||= []).push(n);
  const row = new Map<string, number>();
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const placed = columns.filter(Boolean).map((col, ci) => {
    const key = (n: T): number => {
      if (ci === 0) return (linked.has(n.id) ? 0 : 1e9) + n.y;
      const ups = edges.filter((e) => e.to === n.id && row.has(e.from)).map((e) => row.get(e.from)!);
      return ups.length ? ups.reduce((a, b) => a + b, 0) / ups.length : 1e9 + n.y;
    };
    const sorted = [...col].sort((a, b) => key(a) - key(b) || a.y - b.y);
    sorted.forEach((n, i) => row.set(n.id, i));
    return sorted;
  });
  const tallest = Math.max(...placed.map((c) => c.length));
  const pos = new Map<string, { x: number; y: number }>();
  placed.forEach((col, ci) => {
    const offset = ((tallest - col.length) * (NODE_H + ROW_GAP)) / 2;
    col.forEach((n, i) => pos.set(n.id, { x: snap(ci * (NODE_W + COL_GAP)), y: snap(offset + i * (NODE_H + ROW_GAP)) }));
  });
  return nodes.map((n) => ({ ...n, ...pos.get(n.id)! }));
}

// ---- run presentation --------------------------------------------------------------------------

const LABELS: Record<string, string> = {
  waiting: "Waiting",
  queuing: "Queuing",
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  partiallySucceeded: "Partially succeeded",
  failed: "Failed",
  canceled: "Canceled",
  skipped: "Skipped",
  error: "Error",
};

export const statusLabel = (status: string): string => LABELS[status] || status;

export function statusTone(status: string): Tone {
  switch (status) {
    case "succeeded":
      return "ok";
    case "partiallySucceeded":
      return "warn";
    case "failed":
    case "error":
      return "bad";
    case "running":
    case "queued":
    case "queuing":
      return "run";
    case "skipped":
    case "canceled":
      return "off";
    default:
      return "idle";
  }
}

const TERMINAL = new Set(["succeeded", "partiallySucceeded", "failed", "canceled", "skipped", "error"]);
export const isTerminal = (status: string): boolean => TERMINAL.has(status);

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "<1s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function runProgress(states: Record<string, { status: string }>): { done: number; total: number } {
  const all = Object.values(states);
  return { done: all.filter((s) => isTerminal(s.status)).length, total: all.length };
}

/** Elapsed time for a block: queue → finish, or queue → now while it is active. */
export function nodeElapsed(state: NodeRunState | undefined, now: number): number | null {
  const start = state?.startedAt || state?.queuedAt;
  if (!start) return null;
  const end = state?.finishedAt ? Date.parse(state.finishedAt) : now;
  const ms = end - Date.parse(start);
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

/** Short relative time ("just now", "5m ago", "3h ago", "2d ago"). */
export function timeAgo(iso: string | null | undefined, now: number): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return "";
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Pipelines page in Azure DevOps for a block. */
export function definitionUrl(n: { org: string; project: string; definitionId: number }): string {
  return `https://dev.azure.com/${encodeURIComponent(n.org)}/${encodeURIComponent(n.project)}/_build?definitionId=${n.definitionId}`;
}
