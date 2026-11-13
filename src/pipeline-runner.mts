// Advances pipeline chain runs in the desktop main process. Each tick polls the
// builds a run is waiting on, queues blocks whose upstream pipelines passed,
// and finishes runs once every block is settled. Runs only advance while the
// app is open; on restart they resume from the stored state.

import {
    cancelBuild,
    getBuild,
    getDefinitionInfo,
    getPullRequestById,
    getRunParameters,
    previewPipeline,
    queueBuild,
    runPipeline,
    type DefinitionInfo,
    type PipelinePreview,
    type RunParametersInfo,
} from "./ado.mjs";
import { emitPipelineEvent } from "./pipeline-events.mjs";
import {
    advance,
    applyBuild,
    applyCommand,
    applyGraphEdit,
    checkParams,
    finalYamlResources,
    hasUpstreamBuild,
    normalizeBranch,
    prKey,
    recoverInterrupted,
    resolvePins,
    resolveRepoBranches,
    runOutcome,
    type BuildInfo,
    type AppBuild,
    type ChainGraph,
    type ChainNode,
    type NodeRunState,
    type NodeStates,
    type ResourcePin,
} from "./pipeline-graph.mjs";
import {
    activeRuns,
    appBuilds,
    clearStaleCommands,
    commitCommands,
    finishRun,
    isRunCancelRequested,
    listChains,
    pendingCommands,
    pruneCommands,
    updateRun,
    updateRunIfNoCommands,
    type RunRow,
} from "./pipeline-store.mjs";
import { ensureDb } from "./store.mjs";
import type { WorkItem } from "./service-files.mjs";

export interface PipelineAdo extends RunInfoAdo {
    queueBuild(org: string, project: string, definitionId: number, sourceBranch?: string): Promise<BuildInfo>;
    runPipeline(
        org: string,
        project: string,
        definitionId: number,
        branch: string,
        pins: ResourcePin[],
        params: Record<string, string> | undefined,
        repos?: Record<string, string>,
    ): Promise<BuildInfo>;
    getBuild(org: string, project: string, buildId: number): Promise<BuildInfo>;
    cancelBuild(org: string, project: string, buildId: number): Promise<unknown>;
    getDefinition(org: string, project: string, definitionId: number): Promise<DefinitionInfo>;
    /** The current source branch of a pull request, as refs/heads/…, for blocks that follow one. */
    prSourceBranch(org: string, prId: number): Promise<string>;
}

/** The source branch of a pull request, read now: blocks that follow a PR build what it holds today. */
async function prSourceBranch(org: string, prId: number): Promise<string> {
    const pr = await getPullRequestById(org, prId);
    if (!pr) throw new Error(`Pull request ${prId} wasn't found in ${org}`);
    const ref = String(pr.sourceRefName || "");
    if (!ref) throw new Error(`Pull request ${prId} has no source branch`);
    return ref;
}

interface PipelineRunnerOptions {
    ado: PipelineAdo;
    pollMs: number;
    /** Consecutive failed polls before a block is marked as an error (~5 min by default). */
    maxPollFailures: number;
}

const DEFAULTS: PipelineRunnerOptions = {
    ado: {
        queueBuild,
        runPipeline,
        getBuild,
        cancelBuild,
        getDefinition: getDefinitionInfo,
        getRunParameters,
        previewPipeline,
        prSourceBranch,
    },
    pollMs: 10_000,
    maxPollFailures: 30,
};
const ACTIVE_BUILD = new Set(["queued", "running"]);

let options: PipelineRunnerOptions | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;
let rerun = false;

const now = () => new Date().toISOString();

/** "ADO POST 403: {json}" -> "Azure DevOps 403: <message>". */
export function describeAdoError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const match = /^ADO \S+ (\d+): ([\s\S]*)$/.exec(message);
    if (!match) return message.slice(0, 500);
    const [, status, body] = match;
    const quoted = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body);
    if (quoted) {
        try {
            return `Azure DevOps ${status}: ${JSON.parse(`"${quoted[1]}"`)}`;
        } catch {
            // fall through to the raw body
        }
    }
    return `Azure DevOps ${status}: ${body}`.slice(0, 500);
}

/** The Azure DevOps reads behind readRunInfo and checkRepoBranches, swappable for tests. */
export interface RunInfoAdo {
    getRunParameters(
        org: string,
        project: string,
        projectId: string,
        definitionId: number,
        branch: string,
    ): Promise<RunParametersInfo>;
    previewPipeline(
        org: string,
        project: string,
        definitionId: number,
        branch: string,
        params: Record<string, string> | undefined,
        repos?: Record<string, string>,
    ): Promise<PipelinePreview>;
}

export interface RunInfo extends RunParametersInfo {
    /**
     * Compiled through the Preview API with the block's repository branches: its pipeline and
     * repository resources are known, its parameter definitions aren't, and repositories carry no id.
     */
    previewed?: true;
    /** Why Azure DevOps won't compile the pipeline with the block's repository branches and parameters. */
    rejected?: string;
}

/**
 * Compile the pipeline with these overrides through the Preview API. Azure DevOps ignores a
 * repository branch whose alias is spelled differently from the YAML's, so when a first compile
 * shows the YAML's spelling differs, it compiles again under that spelling. A pipeline that
 * doesn't compile comes back as `rejected`; other failures throw.
 */
export async function previewRunInfo(
    ado: Pick<RunInfoAdo, "previewPipeline">,
    org: string,
    project: string,
    definitionId: number,
    branch: string,
    params: Record<string, string> | undefined,
    repos: Record<string, string> | undefined,
): Promise<RunInfo> {
    const compile = async (sent: Record<string, string> | undefined): Promise<RunInfo> => {
        const preview = await ado.previewPipeline(org, project, definitionId, branch, params, sent);
        if ("rejected" in preview) return { parameters: [], resources: [], repositories: [], errors: [], rejected: preview.rejected };
        const found = finalYamlResources(preview.finalYaml);
        return { parameters: [], resources: found.pipelines, repositories: found.repositories, errors: [], previewed: true };
    };
    const first = await compile(repos);
    if (first.rejected || !repos) return first;
    const resolved = resolveRepoBranches(repos, first.repositories);
    if (resolved.error || !resolved.refs) return first;
    return Object.keys(resolved.refs).some((alias) => !Object.hasOwn(repos, alias)) ? compile(resolved.refs) : first;
}

/**
 * What a run of the pipeline on `branch` takes and consumes. The portal's reader can't be given
 * repository branches, so a pipeline whose YAML only expands with the block's (a template that
 * exists only on the overriding branch) reads as broken there; for a block with repository
 * branches, that case is compiled again through the Preview API with them.
 */
export async function readRunInfo(
    ado: RunInfoAdo,
    org: string,
    project: string,
    projectId: string,
    definitionId: number,
    branch: string,
    overrides: { params?: Record<string, string>; repos?: Record<string, string> } = {},
): Promise<RunInfo> {
    const plain = await ado.getRunParameters(org, project, projectId, definitionId, branch);
    const repos = overrides.repos && Object.keys(overrides.repos).length ? overrides.repos : undefined;
    if (!plain.errors.length || !repos) return plain;
    const params = overrides.params && Object.keys(overrides.params).length ? overrides.params : undefined;
    const compiled = await previewRunInfo(ado, org, project, definitionId, branch, params, repos);
    return compiled.rejected ? { ...plain, rejected: compiled.rejected } : compiled;
}

export interface RepoBranchCheck {
    /** Why the branches can't be used: the pipeline doesn't compile with them, an alias it lacks, a missing branch. */
    error: string | null;
    /** What couldn't be checked. */
    warnings: string[];
    /** The branches under the YAML's alias spelling, as refs, when there's no error. */
    refs?: Record<string, string>;
}

/**
 * Whether a block's repository branches work on `branch`: the pipeline compiles with them (and
 * its parameters), each alias is still a repository resource, and each Azure Repos branch exists.
 * The compile alone doesn't prove the last: Azure DevOps only reads the repositories it takes
 * templates from. Lookups that fail are warnings, not errors.
 */
export async function checkRepoBranches(
    ado: Pick<RunInfoAdo, "previewPipeline"> & {
        branchExists(org: string, project: string, repoIdOrName: string, branch: string): Promise<boolean>;
    },
    org: string,
    project: string,
    definitionId: number,
    branch: string,
    params: Record<string, string> | undefined,
    repoBranches: Record<string, string>,
): Promise<RepoBranchCheck> {
    const warnings: string[] = [];
    let info: RunInfo;
    try {
        info = await previewRunInfo(ado, org, project, definitionId, branch, params, repoBranches);
    } catch (e) {
        return { error: null, warnings: [`Couldn't compile the pipeline to check its repository branches: ${describeAdoError(e)}`] };
    }
    if (info.rejected) return { error: `Azure DevOps can't compile the pipeline with these branches: ${info.rejected}`, warnings };
    const resolved = resolveRepoBranches(repoBranches, info.repositories);
    if (resolved.error) {
        const known = info.repositories.map((r) => r.alias).join(", ");
        return { error: `${resolved.error.replace(/ Remove .*$/, "")} Its repository resources: ${known || "none"}.`, warnings };
    }
    for (const [alias, ref] of Object.entries(resolved.refs ?? {})) {
        const repo = info.repositories.find((r) => r.alias === alias)!;
        const short = ref.replace(/^refs\/heads\//, "");
        if (repo.type.toLowerCase() !== "tfsgit" || !ref.startsWith("refs/heads/")) {
            warnings.push(`Couldn't check that ${short} exists in ${repo.name} (${alias}).`);
            continue;
        }
        try {
            if (!(await ado.branchExists(org, repo.project || project, repo.id || repo.name, short))) {
                return { error: `Branch ${short} doesn't exist in ${repo.name} (repository resource ${alias}).`, warnings };
            }
        } catch (e) {
            warnings.push(`Couldn't check that branch ${short} exists in ${repo.name}: ${describeAdoError(e)}`);
        }
    }
    return { error: null, warnings, ...(resolved.refs ? { refs: resolved.refs } : {}) };
}

interface QueuePlan {
    pins: ResourcePin[];
    params?: Record<string, string>;
    /** Repository resource branches, by the YAML's alias. */
    repos?: Record<string, string>;
    error: string | null;
}

// How a ready block is queued: the builds its YAML `resources.pipelines` consume (from
// this run, or the chain's earlier runs in `past`), and whether its parameter overrides
// and repository branches still fit the pipeline on that branch. Blocks with none of
// those and no upstream build skip the lookups entirely. `branch` is where it builds
// ("" for the default).
async function planQueue(
    ado: PipelineAdo,
    graph: ChainGraph,
    states: NodeStates,
    n: ChainNode,
    past: AppBuild[],
    branch: string,
): Promise<QueuePlan> {
    const params = n.params && Object.keys(n.params).length ? n.params : undefined;
    const repoBranches = n.repoBranches && Object.keys(n.repoBranches).length ? n.repoBranches : undefined;
    if (!params && !repoBranches && !hasUpstreamBuild(graph, states, n.id, past)) return { pins: [], error: null };
    try {
        const definition = await ado.getDefinition(n.org, n.project, n.definitionId);
        if (!definition.yaml) {
            const error = params
                ? `"${n.name}" is a classic pipeline, which has no runtime parameters. Clear its parameters.`
                : repoBranches
                  ? `"${n.name}" is a classic pipeline, which has no repository resources. Clear its repository branches.`
                  : null;
            return { pins: [], error };
        }
        const info = await readRunInfo(ado, n.org, n.project, definition.projectId, n.definitionId, branch || definition.defaultBranch, {
            params,
            repos: repoBranches,
        });
        if (info.rejected) {
            const on = (branch || definition.defaultBranch).replace(/^refs\/heads\//, "");
            return {
                pins: [],
                error: `Azure DevOps can't compile "${n.name}" on ${on || "its default branch"} with its repository branches${params ? " and parameters" : ""}: ${info.rejected}`,
            };
        }
        // A previewed read compiled with the parameters, so Azure DevOps already accepted them.
        const paramError = info.previewed ? null : checkParams(params, info.parameters);
        if (paramError) return { pins: [], error: info.errors.length ? `${paramError} (${info.errors[0]})` : paramError };
        const repos = resolveRepoBranches(repoBranches, info.repositories ?? []);
        if (repos.error) return { pins: [], error: repos.error };
        const resolved = resolvePins(graph, states, n.id, info.resources, past);
        return { pins: resolved.pins, params, ...(repos.refs ? { repos: repos.refs } : {}), error: resolved.error };
    } catch (e) {
        return { pins: [], error: `Couldn't check what "${n.name}" consumes: ${describeAdoError(e)}` };
    }
}

async function processRun(run: RunRow, opts: PipelineRunnerOptions): Promise<void> {
    const { ado, maxPollFailures } = opts;
    const { runId } = run;
    let graph = run.graph;
    let states: NodeStates = { ...run.states };
    let canceled = run.cancelRequested;

    // User commands (edit the chain, run a block, stop a block) are applied here and
    // only here, in the order they were made, so they never race the scheduling below.
    const commands = await pendingCommands(runId);
    if (commands.length) {
        canceled = await isRunCancelRequested(runId);
        const resolutions: Array<{ id: number; error: string | null }> = [];
        let edited = false;
        for (const command of commands) {
            if (command.kind === "graph") {
                if (command.graph) {
                    const result = applyGraphEdit(graph, command.graph, states, canceled);
                    graph = result.graph;
                    states = result.states;
                    edited = true;
                }
                resolutions.push({ id: command.id, error: command.graph ? null : "The edit was empty" });
                continue;
            }
            const result = applyCommand(graph, states, command, canceled);
            states = result.states;
            resolutions.push({ id: command.id, error: result.error });
        }
        await commitCommands(runId, states, resolutions, edited ? graph : undefined);
    }
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));

    for (const n of graph.nodes) {
        let state = states[n.id];
        if (!state?.buildId || !ACTIVE_BUILD.has(state.status)) continue;
        const buildId = state.buildId;
        if ((canceled || state.stopRequested) && !state.cancelSent) {
            try {
                await ado.cancelBuild(n.org, n.project, buildId);
                state = { ...state, cancelSent: true, cancelError: undefined };
            } catch (e) {
                state = { ...state, cancelError: `Cancel failed: ${describeAdoError(e)}` };
            }
            states[n.id] = state;
        }
        try {
            states[n.id] = applyBuild(state, await ado.getBuild(n.org, n.project, buildId));
        } catch (e) {
            const failures = (state.pollFailures ?? 0) + 1;
            const error = describeAdoError(e);
            states[n.id] =
                failures >= maxPollFailures
                    ? {
                          ...state,
                          status: "error",
                          error: `Lost track of build ${state.buildNumber ?? buildId}: ${error}`,
                          finishedAt: now(),
                          pollFailures: failures,
                          pollError: undefined,
                      }
                    : { ...state, pollFailures: failures, pollError: error };
        }
    }

    let step = advance(graph, states, canceled);
    states = step.states;
    // What earlier runs of the chain built, loaded once a block is ready to queue.
    let past: AppBuild[] | undefined;
    for (const id of step.ready) {
        if (!options) break; // shutting down: leave the rest waiting for the next launch
        const n = nodes.get(id)!;
        past ??= (await appBuilds(run.chainId)).filter((b) => b.runId !== runId);
        // A block that follows a PR builds the PR's source branch as it is now.
        let branch = normalizeBranch(n.branch);
        let branchError: string | null = null;
        if (n.branchFrom) {
            try {
                branch = normalizeBranch(await ado.prSourceBranch(n.branchFrom.org, n.branchFrom.prId));
            } catch (e) {
                branchError = `Couldn't read the branch of PR ${n.branchFrom.prId}: ${describeAdoError(e)}`;
            }
        }
        const plan = branchError ? { pins: [], error: branchError } : await planQueue(ado, graph, states, n, past, branch);
        if (!options) break;
        if (await isRunCancelRequested(runId)) {
            canceled = true;
            break;
        }
        // Each write below is skipped while an edit or request waits, so the runner
        // never queues from a graph or state that has since changed; the next pass
        // applies the commands first and plans again.
        if (plan.error) {
            const failed: NodeStates = { ...states, [id]: { ...states[id], status: "error", error: plan.error, finishedAt: now() } };
            if (!(await updateRunIfNoCommands(runId, failed))) {
                rerun = true;
                break;
            }
            states = failed;
            continue;
        }
        // Persist before the POST so a crash mid-request is recovered, not re-queued.
        const queuing: NodeRunState = {
            status: "queuing",
            queuedAt: now(),
            branch,
            ...(n.branchFrom ? { followed: prKey(n.branchFrom) } : {}),
            ...(states[id].manual ? { manual: true } : {}),
            ...(plan.pins.length ? { resources: plan.pins } : {}),
            ...(plan.params ? { params: plan.params } : {}),
            ...(plan.repos ? { repoBranches: plan.repos } : {}),
        };
        const next: NodeStates = { ...states, [id]: queuing };
        if (!(await updateRunIfNoCommands(runId, next))) {
            rerun = true;
            break;
        }
        states = next;
        try {
            // The Runs API pins resources, sets parameters and repository branches; the Build
            // API covers the rest, including classic pipelines, which the Runs API can't queue.
            const build =
                plan.pins.length || plan.params || plan.repos
                    ? await ado.runPipeline(n.org, n.project, n.definitionId, branch, plan.pins, plan.params, plan.repos)
                    : await ado.queueBuild(n.org, n.project, n.definitionId, branch || undefined);
            states[id] = applyBuild(states[id], build);
        } catch (e) {
            states[id] = { ...states[id], status: "error", error: describeAdoError(e), finishedAt: now() };
        }
        await updateRun(runId, { states });
    }

    step = advance(graph, states, canceled);
    states = step.states;
    const outcome = runOutcome(states);
    // A command that arrived during this tick keeps the run open for the next one.
    if (outcome && (await finishRun(runId, states, outcome, now()))) {
        emitPipelineEvent({ type: "runFinished", chainId: run.chainId, runId, status: outcome });
        return;
    }
    await updateRun(runId, { states });
}

async function runTick(): Promise<void> {
    const opts = options;
    if (!opts) return;
    await pruneCommands();
    for (const run of await activeRuns()) {
        try {
            await processRun(run, opts);
        } catch (e) {
            console.error(`[pipelines] run ${run.runId}: ${(e as Error).message}`);
        }
    }
}

/** Run one tick now. A call during a tick schedules another full tick after it. */
export function tickPipelineRunner(): Promise<void> {
    if (!options) return Promise.resolve();
    if (inFlight) {
        rerun = true;
        return inFlight;
    }
    inFlight = (async () => {
        try {
            do {
                rerun = false;
                try {
                    await runTick();
                } catch (e) {
                    console.error(`[pipelines] tick failed: ${(e as Error).message}`);
                }
            } while (rerun && options);
        } finally {
            inFlight = null;
        }
    })();
    return inFlight;
}

/** Nudge the runner after a run starts or is canceled. No-op when not started. */
export function wakePipelineRunner(): void {
    if (options) void tickPipelineRunner();
}

/** Chain runs this runner is advancing, for the background service's idle check. */
export async function pipelineActivity(): Promise<WorkItem[]> {
    if (!options) return [];
    const runs = await activeRuns();
    if (!runs.length) return [];
    const names = new Map((await listChains()).map((c) => [c.id, c.name]));
    return runs.map((run) => ({ kind: "pipeline", label: `Pipeline chain ${names.get(run.chainId) || run.chainId}` }));
}

export async function startPipelineRunner(overrides: Partial<PipelineRunnerOptions> = {}): Promise<void> {
    options = { ...DEFAULTS, ...overrides };
    await ensureDb();
    await clearStaleCommands();
    for (const run of await activeRuns()) {
        const recovered = recoverInterrupted(run.states);
        if (recovered.changed) await updateRun(run.runId, { states: recovered.states });
    }
    if (!timer) {
        timer = setInterval(() => void tickPipelineRunner(), options.pollMs);
        timer.unref?.();
    }
    void tickPipelineRunner();
}

/** Stop advancing runs. Builds already queued keep running in Azure DevOps. */
export async function stopPipelineRunner(graceMs = 5_000): Promise<void> {
    options = null;
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    if (!inFlight) return;
    let wait: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([inFlight, new Promise((resolve) => (wait = setTimeout(resolve, graceMs)))]);
    clearTimeout(wait);
}
