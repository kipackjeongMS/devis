// A Jarvis task's validation: one pipeline chain the task owns, that proves its change works.
//
// The chain is an ordinary pipeline chain (same canvas, same runner) with an owner. It's
// temporary: removing the task removes it. A worker or the Lead can propose one (see
// jarvis-validation-agent.mts for what the app checks); nothing is created until the
// user accepts, and nothing runs until the user says so. Runs report back here: a History
// event and a status line each, Needs you when one fails, and the task's worker hears what
// failed when the user allows it.

import { getBuildFailures } from "./ado.mjs";
import {
    blockResults,
    chainsOwnedBy,
    deleteChain,
    getChain,
    getRun,
    latestRun,
    listChains,
    orphanedTaskChains,
    registerRunGuard,
    requestRunCancel,
    saveChain,
    startChainRun,
    type ChainRow,
    type RunRow,
} from "./pipeline-store.mjs";
import { onPipelineEvent, type PipelineEvent } from "./pipeline-events.mjs";
import { validateGraph, type ChainGraph, type ChainNode, type NodeStates, type PrRef } from "./pipeline-graph.mjs";
import { wakePipelineRunner } from "./pipeline-runner.mjs";
import { readConfig } from "./config.mjs";
import {
    JarvisError,
    asJarvisId,
    describeTask,
    getMeta,
    getTask,
    jarvisDb,
    listTaskPrs,
    listTasks,
    listWorkers,
    recordEvent,
    setMeta,
    type JarvisTask,
    type TaskPr,
} from "./jarvis-store.mjs";
import { postStatus } from "./jarvis-status.mjs";
import { FORMER_LEAD_NAME, LEAD_NAME } from "./brand.mjs";

// ---- types ----------------------------------------------------------------------------

/** Azure DevOps reads and the task's workers, swappable for tests. */
export interface ValidationRuntime {
    buildFailures: typeof getBuildFailures;
    /** Send a worker a message as a new turn; throws when it can't take one now. */
    messageWorker(sessionId: string, text: string): Promise<unknown>;
    workerBusy(sessionId: string): Promise<boolean>;
}
const ADO_RUNTIME: ValidationRuntime = {
    buildFailures: getBuildFailures,
    messageWorker: async (sessionId, text) => (await import("./jarvis-workers.mjs")).messageWorker(sessionId, text),
    workerBusy: async (sessionId) => (await import("./jarvis-workers.mjs")).workerLiveState(sessionId).busy,
};
let vrt: ValidationRuntime = ADO_RUNTIME;
export function setValidationRuntime(overrides: Partial<ValidationRuntime> | null): void {
    vrt = overrides ? { ...ADO_RUNTIME, ...overrides } : ADO_RUNTIME;
}

/** Why a pipeline is in the chain. `verified` evidence comes from Azure DevOps or this app; the rest is a worker's judgment. */
export interface ValidationEvidence {
    kind: "prCheck" | "consumes" | "history" | "docs" | "agent" | "production";
    label: string;
    detail?: string;
    verified: boolean;
}

export interface ProposedBlock {
    /** org/project/definitionId, lowercased org and project. */
    key: string;
    org: string;
    project: string;
    definitionId: number;
    name: string;
    path: string;
    stage: number;
    /** Keys of the blocks it runs after. */
    after: string[];
    /** A fixed branch ("" for the pipeline's default); ignored when it follows a PR. */
    branch: string;
    branchFrom?: PrRef;
    params?: Record<string, string>;
    /** Branches for its YAML's repository resources, by alias. */
    repoBranches?: Record<string, string>;
    /** The proposer's own reason, in a sentence. */
    reason: string;
    evidence: ValidationEvidence[];
}

export interface ProposalCheck {
    tone: "ok" | "warn";
    text: string;
}

export interface Proposal {
    /** Which proposal this is: accepting or dismissing names it, so a newer one can't slip in. */
    id: string;
    summary: string;
    blocks: ProposedBlock[];
    leftOut: Array<{ key: string; name: string; reason: string; evidence: ValidationEvidence[] }>;
    checks: ProposalCheck[];
    by: string;
    sessionId: string | null;
    at: string;
}

interface ValidationRow {
    taskId: string;
    chainId: string | null;
    proposal: Proposal | null;
    /** Per block key: why it's there, kept from the accepted proposal. */
    evidence: Record<string, { reason: string; evidence: ValidationEvidence[]; by: string }>;
    acceptedAt: string | null;
    acceptedBy: string | null;
    notifyWorker: boolean;
    rerunOnCommit: boolean;
    ackedRunId: string | null;
    /** Per followed PR (org/prId): the source commit the last automatic run saw. */
    commits: Record<string, string>;
    pendingNotice: string | null;
    autoAskedAt: string | null;
}

export interface ValidationRunSummary {
    runId: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    /** Blocks that passed, of the blocks in this run. */
    done: number;
    total: number;
    /** The block running now, if one is. */
    current: string | null;
    /** The first block that failed or errored, if one did. */
    failed: string | null;
}

/** What Today, the task card and the Lead show of a task's validation. */
export interface ValidationSummary {
    chainId: string | null;
    name: string | null;
    blocks: number;
    run: ValidationRunSummary | null;
    proposal: { by: string; at: string; blocks: number } | null;
    /** Why the task needs the user: a proposal to review, or a run that failed and hasn't been looked at. */
    attention: "proposal" | "failed" | null;
}

// ---- storage ---------------------------------------------------------------------------

const now = () => new Date().toISOString();
const AUTO_KEY = "validation.autoPropose";
const NAME_PREFIX = "Validation · ";
const MAX_NOTICE = 6000;

let schemaReady: Promise<void> | null = null;

async function db() {
    const d = await jarvisDb();
    schemaReady ??= Promise.resolve().then(() => {
        d.exec(`
            CREATE TABLE IF NOT EXISTS jarvis_task_validation (
                task_id         TEXT PRIMARY KEY,
                chain_id        TEXT,
                proposal_json   TEXT,
                evidence_json   TEXT,
                accepted_at     TEXT,
                accepted_by     TEXT,
                notify_worker   INTEGER NOT NULL DEFAULT 1,
                rerun_on_commit INTEGER NOT NULL DEFAULT 0,
                acked_run_id    TEXT,
                commits_json    TEXT,
                pending_notice  TEXT,
                auto_asked_at   TEXT,
                updated_at      TEXT NOT NULL
            );
        `);
        // The lead was called Jarvis: proposals it made then read as its name now.
        const was = `"by":${JSON.stringify(FORMER_LEAD_NAME)}`;
        const now = `"by":${JSON.stringify(LEAD_NAME)}`;
        d.prepare(
            `UPDATE jarvis_task_validation SET
                accepted_by = CASE WHEN accepted_by = ? THEN ? ELSE accepted_by END,
                proposal_json = replace(proposal_json, ?, ?),
                evidence_json = replace(evidence_json, ?, ?)
             WHERE accepted_by = ? OR instr(proposal_json, ?) > 0 OR instr(evidence_json, ?) > 0`,
        ).run(FORMER_LEAD_NAME, LEAD_NAME, was, now, was, now, FORMER_LEAD_NAME, was, was);
    });
    await schemaReady;
    return d;
}

/** For tests that swap the database underneath. */
export function resetValidationSchema(): void {
    schemaReady = null;
}

type Raw = Record<string, unknown>;
const parse = <T,>(value: unknown, fallback: T): T => {
    if (typeof value !== "string" || !value) return fallback;
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
};

function toRow(taskId: string, r: Raw | undefined): ValidationRow {
    return {
        taskId,
        chainId: (r?.chain_id as string | null) ?? null,
        proposal: parse<Proposal | null>(r?.proposal_json, null),
        evidence: parse(r?.evidence_json, {}),
        acceptedAt: (r?.accepted_at as string | null) ?? null,
        acceptedBy: (r?.accepted_by as string | null) ?? null,
        notifyWorker: r ? Number(r.notify_worker) === 1 : true,
        rerunOnCommit: r ? Number(r.rerun_on_commit) === 1 : false,
        ackedRunId: (r?.acked_run_id as string | null) ?? null,
        commits: parse(r?.commits_json, {}),
        pendingNotice: (r?.pending_notice as string | null) ?? null,
        autoAskedAt: (r?.auto_asked_at as string | null) ?? null,
    };
}

async function readRow(taskId: string): Promise<ValidationRow> {
    const r = (await db()).prepare("SELECT * FROM jarvis_task_validation WHERE task_id = ?").get(taskId) as Raw | undefined;
    return toRow(taskId, r);
}

async function writeRow(row: ValidationRow): Promise<void> {
    (await db())
        .prepare(
            `INSERT INTO jarvis_task_validation (task_id, chain_id, proposal_json, evidence_json, accepted_at, accepted_by, notify_worker,
                 rerun_on_commit, acked_run_id, commits_json, pending_notice, auto_asked_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(task_id) DO UPDATE SET chain_id = excluded.chain_id, proposal_json = excluded.proposal_json,
                 evidence_json = excluded.evidence_json, accepted_at = excluded.accepted_at, accepted_by = excluded.accepted_by,
                 notify_worker = excluded.notify_worker, rerun_on_commit = excluded.rerun_on_commit, acked_run_id = excluded.acked_run_id,
                 commits_json = excluded.commits_json, pending_notice = excluded.pending_notice, auto_asked_at = excluded.auto_asked_at,
                 updated_at = excluded.updated_at`,
        )
        .run(
            row.taskId,
            row.chainId,
            row.proposal ? JSON.stringify(row.proposal) : null,
            JSON.stringify(row.evidence),
            row.acceptedAt,
            row.acceptedBy,
            row.notifyWorker ? 1 : 0,
            row.rerunOnCommit ? 1 : 0,
            row.ackedRunId,
            JSON.stringify(row.commits),
            row.pendingNotice,
            row.autoAskedAt,
            now(),
        );
}

async function update(taskId: string, change: (row: ValidationRow) => void): Promise<ValidationRow> {
    const row = await readRow(taskId);
    change(row);
    await writeRow(row);
    return row;
}

async function requireTask(value: unknown): Promise<JarvisTask> {
    const id = asJarvisId(value);
    const task = id ? await getTask(id) : null;
    if (!task) throw new JarvisError("Task not found.", 404);
    return task;
}

/** The task's chain, if it still has one. A chain removed from the Pipelines tab is forgotten here too. */
async function taskChain(taskId: string, row?: ValidationRow): Promise<ChainRow | null> {
    const r = row ?? (await readRow(taskId));
    if (r.chainId) {
        const chain = await getChain(r.chainId);
        if (chain && chain.ownerTaskId === taskId) return chain;
    }
    const owned = await chainsOwnedBy(taskId);
    const chain = owned[0] ?? null;
    if ((chain?.id ?? null) !== r.chainId) await update(taskId, (x) => (x.chainId = chain?.id ?? null));
    return chain;
}

const chainName = (task: JarvisTask) => (NAME_PREFIX + task.title).slice(0, 120);
const blockKey = (n: { org: string; project: string; definitionId: number }) =>
    `${n.org.toLowerCase()}/${n.project.toLowerCase()}/${n.definitionId}`;

// ---- summaries --------------------------------------------------------------------------

const PASSED = new Set(["succeeded", "partiallySucceeded"]);
const RUNNING = new Set(["queuing", "queued", "running"]);
const BROKE = new Set(["failed", "error", "canceled"]);

export function summarizeRun(run: RunRow): ValidationRunSummary {
    const names = new Map(run.graph.nodes.map((n) => [n.id, n.name]));
    const entries = Object.entries(run.states as NodeStates).filter(([id]) => names.has(id));
    const order = run.graph.nodes.map((n) => n.id);
    entries.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
    const current = entries.find(([, s]) => RUNNING.has(s.status));
    const failed = entries.find(([, s]) => BROKE.has(s.status));
    return {
        runId: run.runId,
        status: run.status,
        startedAt: run.createdAt,
        finishedAt: run.finishedAt,
        done: entries.filter(([, s]) => PASSED.has(s.status)).length,
        total: entries.length,
        current: current ? names.get(current[0])! : null,
        failed: failed ? names.get(failed[0])! : null,
    };
}

export async function validationSummary(taskId: string): Promise<ValidationSummary | null> {
    const row = await readRow(taskId);
    const chain = await taskChain(taskId, row);
    if (!chain && !row.proposal) return null;
    const run = chain ? await latestRun(chain.id) : null;
    const runSummary = run ? summarizeRun(run) : null;
    const failedUnseen = !!run && run.status === "failed" && row.ackedRunId !== run.runId;
    return {
        chainId: chain?.id ?? null,
        name: chain?.name ?? null,
        blocks: chain?.graph.nodes.length ?? 0,
        run: runSummary,
        proposal: row.proposal ? { by: row.proposal.by, at: row.proposal.at, blocks: row.proposal.blocks.length } : null,
        attention: row.proposal ? "proposal" : failedUnseen ? "failed" : null,
    };
}

/** Summaries for many tasks at once, for Today. */
export async function validationSummaries(taskIds: string[]): Promise<Map<string, ValidationSummary>> {
    const out = new Map<string, ValidationSummary>();
    const d = await db();
    const withRows = new Set(
        (d.prepare("SELECT task_id FROM jarvis_task_validation WHERE chain_id IS NOT NULL OR proposal_json IS NOT NULL").all() as Raw[]).map(
            (r) => String(r.task_id),
        ),
    );
    const owners = new Set((await listChains()).filter((c) => c.owner).map((c) => c.owner!.taskId));
    for (const id of taskIds) {
        if (!withRows.has(id) && !owners.has(id)) continue;
        const summary = await validationSummary(id);
        if (summary) out.set(id, summary);
    }
    return out;
}

/** A sentence for status lines, History and the recap: "passed: Build → Deploy Dev". */
function describeRun(run: RunRow): string {
    const s = summarizeRun(run);
    const path = run.graph.nodes
        .filter((n) => (run.states as NodeStates)[n.id])
        .map((n) => n.name)
        .join(" → ");
    if (run.status === "succeeded") return `Validation passed: ${path}`;
    if (run.status === "canceled") return `Validation stopped${s.done ? ` after ${s.done} of ${s.total}` : ""}`;
    if (run.status === "failed") {
        const failedNode = run.graph.nodes.find((n) => BROKE.has((run.states as NodeStates)[n.id]?.status || ""));
        const st = failedNode ? (run.states as NodeStates)[failedNode.id] : null;
        const why = st?.error ? `: ${st.error}` : st?.buildNumber ? ` (build ${st.buildNumber})` : "";
        return `Validation failed at ${failedNode?.name ?? "a block"}${why}`.slice(0, 300);
    }
    return `Validation running: ${s.done} of ${s.total} passed${s.current ? `, ${s.current} running` : ""}`;
}

// ---- the full view ------------------------------------------------------------------------

export interface ValidationView {
    taskId: string;
    taskStatus: string;
    chain: ChainRow | null;
    run: RunRow | null;
    runs: Array<{ runId: string; status: string; createdAt: string; finishedAt: string | null; text: string }>;
    results: Awaited<ReturnType<typeof blockResults>>;
    proposal: Proposal | null;
    evidence: ValidationRow["evidence"];
    acceptedAt: string | null;
    acceptedBy: string | null;
    notifyWorker: boolean;
    rerunOnCommit: boolean;
    ackedRunId: string | null;
    autoPropose: boolean;
    /** The task's PRs a block can follow. */
    prs: Array<{ org: string; prId: number; title: string; sourceRef: string; status: string }>;
    /** Saved chains (not owned by a task) that can be copied in. */
    templates: Array<{ id: string; name: string; nodeCount: number }>;
    summary: ValidationSummary | null;
}

export async function validationView(taskIdValue: unknown): Promise<ValidationView> {
    const task = await requireTask(taskIdValue);
    const row = await readRow(task.id);
    const chain = await taskChain(task.id, row);
    const [run, results, prs, chains] = await Promise.all([
        chain ? latestRun(chain.id) : null,
        chain ? blockResults(chain.id) : [],
        listTaskPrs(task.id),
        listChains(),
    ]);
    const runs = chain ? await recentRuns(chain.id) : [];
    return {
        taskId: task.id,
        taskStatus: task.status,
        chain,
        run,
        runs,
        results,
        proposal: row.proposal,
        evidence: row.evidence,
        acceptedAt: row.acceptedAt,
        acceptedBy: row.acceptedBy,
        notifyWorker: row.notifyWorker,
        rerunOnCommit: row.rerunOnCommit,
        ackedRunId: row.ackedRunId,
        autoPropose: await autoProposeOn(),
        prs: followablePrs(prs),
        templates: chains.filter((c) => !c.owner && c.nodeCount).map((c) => ({ id: c.id, name: c.name, nodeCount: c.nodeCount })),
        summary: await validationSummary(task.id),
    };
}

function followablePrs(prs: TaskPr[]) {
    return prs
        .filter((p) => p.snapshot && !p.hidden)
        .map((p) => ({ org: p.org, prId: p.prId, title: p.snapshot!.title, sourceRef: p.snapshot!.sourceRef, status: p.snapshot!.status }));
}

async function recentRuns(chainId: string, limit = 8) {
    const d = await db();
    const rows = d
        .prepare("SELECT run_id FROM pipeline_runs WHERE chain_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
        .all(chainId, limit) as Raw[];
    const out: ValidationView["runs"] = [];
    for (const r of rows) {
        const run = await getRun(String(r.run_id));
        if (run) out.push({ runId: run.runId, status: run.status, createdAt: run.createdAt, finishedAt: run.finishedAt, text: describeRun(run) });
    }
    return out;
}

// ---- lifecycle ------------------------------------------------------------------------------

/** Give the task a validation chain: a copy of a saved chain, or an empty one to build in Pipelines. */
export async function attachChain(taskIdValue: unknown, fromChainId?: unknown): Promise<ChainRow> {
    const task = await requireTask(taskIdValue);
    if (await taskChain(task.id)) throw new JarvisError("This task already has a validation chain.", 409);
    let graph: ChainGraph = { nodes: [], edges: [] };
    if (typeof fromChainId === "string" && fromChainId) {
        const source = await getChain(fromChainId);
        if (!source) throw new JarvisError("That chain is gone.", 404);
        graph = JSON.parse(JSON.stringify(source.graph)) as ChainGraph;
    }
    const chain = await saveChain({ name: chainName(task), graph, ownerTaskId: task.id });
    await update(task.id, (r) => {
        r.chainId = chain.id;
        r.acceptedAt = now();
        r.acceptedBy = "you";
    });
    await recordEvent("task.validation", `Validation chain added to ${describeTask(task)}`, { taskId: task.id, ref: { chainId: chain.id } });
    return chain;
}

/** Remove the task's chain (it must not be running) and any proposal. */
export async function removeValidation(taskIdValue: unknown): Promise<void> {
    const task = await requireTask(taskIdValue);
    const chain = await taskChain(task.id);
    if (chain) {
        const run = await latestRun(chain.id);
        if (run?.status === "running") throw new JarvisError("Stop the validation run before removing it.", 409);
        await deleteChain(chain.id);
    }
    (await db()).prepare("DELETE FROM jarvis_task_validation WHERE task_id = ?").run(task.id);
    await recordEvent("task.validation", `Validation removed from ${describeTask(task)}`, { taskId: task.id });
}

/** Copy the task's chain into the user's own chains. Blocks that follow a PR build the pipeline's default branch there. */
export async function saveAsReusable(taskIdValue: unknown): Promise<ChainRow> {
    const task = await requireTask(taskIdValue);
    const chain = await taskChain(task.id);
    if (!chain) throw new JarvisError("This task has no validation chain.", 404);
    const graph: ChainGraph = {
        nodes: chain.graph.nodes.map(({ branchFrom, ...n }) => (branchFrom ? { ...n, branch: "" } : n)),
        edges: chain.graph.edges.map((e) => ({ ...e })),
    };
    const name = chain.name.startsWith(NAME_PREFIX) ? `${chain.name.slice(NAME_PREFIX.length)} validation` : `${chain.name} (copy)`;
    return saveChain({ name, graph });
}

export async function runValidation(taskIdValue: unknown): Promise<RunRow> {
    const task = await requireTask(taskIdValue);
    const chain = await taskChain(task.id);
    if (!chain) throw new JarvisError("This task has no validation chain.", 404);
    const run = await startChainRun(chain.id).catch((error: Error & { status?: number }) => {
        throw new JarvisError(error.message, error.status ?? 409);
    });
    wakePipelineRunner();
    return run;
}

export async function stopValidation(taskIdValue: unknown): Promise<boolean> {
    const task = await requireTask(taskIdValue);
    const chain = await taskChain(task.id);
    const run = chain ? await latestRun(chain.id) : null;
    if (!run || run.status !== "running") return false;
    await requestRunCancel(run.runId);
    wakePipelineRunner();
    return true;
}

export async function setValidationOptions(taskIdValue: unknown, options: { notifyWorker?: unknown; rerunOnCommit?: unknown }): Promise<void> {
    const task = await requireTask(taskIdValue);
    const commits = typeof options.rerunOnCommit === "boolean" && options.rerunOnCommit ? await followedCommits(task.id) : null;
    await update(task.id, (r) => {
        if (typeof options.notifyWorker === "boolean") r.notifyWorker = options.notifyWorker;
        if (typeof options.rerunOnCommit === "boolean") {
            r.rerunOnCommit = options.rerunOnCommit;
            // Turning it on watches for commits from now on; it doesn't run for the current one.
            if (commits) r.commits = commits;
        }
    });
}

/** The user has seen this failed run: the task leaves Needs you. Only the latest run, and only once it failed. */
export async function acknowledgeRun(taskIdValue: unknown, runId?: unknown): Promise<void> {
    const task = await requireTask(taskIdValue);
    const chain = await taskChain(task.id);
    const run = chain ? await latestRun(chain.id) : null;
    if (!run || run.status !== "failed") return;
    if (typeof runId === "string" && runId !== run.runId) return;
    await update(task.id, (r) => (r.ackedRunId = run.runId));
}

/**
 * Before a task is removed: stop its run, delete its chain (or leave it for the sweep while
 * the run stops), forget the record, and say what it was for task.json.
 */
export async function retireValidation(taskId: string): Promise<Record<string, unknown> | null> {
    const row = await readRow(taskId);
    const chain = await taskChain(taskId, row);
    let record: Record<string, unknown> | null = null;
    if (chain) {
        const run = await latestRun(chain.id);
        record = {
            chain: chain.name,
            pipelines: chain.graph.nodes.map((n) => ({ name: n.name, project: n.project, definitionId: n.definitionId })),
            lastRun: run ? { status: run.status, text: describeRun(run), finishedAt: run.finishedAt } : null,
        };
        if (run?.status === "running") {
            await requestRunCancel(run.runId);
            wakePipelineRunner();
        } else {
            await deleteChain(chain.id).catch(() => undefined);
        }
    }
    (await db()).prepare("DELETE FROM jarvis_task_validation WHERE task_id = ?").run(taskId);
    return record;
}

// ---- proposals -------------------------------------------------------------------------------

/** Store a checked proposal (see the discovery module) for the user to review. */
export async function storeProposal(taskId: string, proposal: Proposal): Promise<void> {
    const task = await requireTask(taskId);
    await update(task.id, (r) => (r.proposal = proposal));
    await recordEvent(
        "task.validation",
        `${proposal.by} proposed validation for ${describeTask(task)}: ${proposal.blocks.map((b) => b.name).join(" → ")}`,
        { taskId: task.id, sessionId: proposal.sessionId ?? undefined },
    );
}

/** Lay the proposal out in stages, left to right, like Tidy. */
export function proposalGraph(proposal: Proposal): ChainGraph {
    const ids = new Map(proposal.blocks.map((b, i) => [b.key, `v${i + 1}`]));
    const perStage = new Map<number, number>();
    const nodes: ChainNode[] = proposal.blocks.map((b) => {
        const row = perStage.get(b.stage) ?? 0;
        perStage.set(b.stage, row + 1);
        return {
            id: ids.get(b.key)!,
            org: b.org,
            project: b.project,
            definitionId: b.definitionId,
            name: b.name,
            path: b.path,
            branch: b.branchFrom ? "" : b.branch,
            x: 40 + b.stage * 320,
            y: 40 + row * 140,
            ...(b.params && Object.keys(b.params).length ? { params: b.params } : {}),
            ...(b.repoBranches && Object.keys(b.repoBranches).length ? { repoBranches: b.repoBranches } : {}),
            ...(b.branchFrom ? { branchFrom: b.branchFrom } : {}),
        };
    });
    const edges = proposal.blocks.flatMap((b) => b.after.filter((k) => ids.has(k)).map((k) => ({ from: ids.get(k)!, to: ids.get(b.key)! })));
    return { nodes, edges };
}

/** The proposal the user reviewed must be the one stored now; a worker may have replaced it since. */
function sameProposal(row: ValidationRow, id: unknown): Proposal {
    if (!row.proposal) throw new JarvisError("There's no proposal to act on.", 404);
    if (typeof id === "string" && id !== row.proposal.id) {
        throw new JarvisError("The proposal changed since you opened it. Review the new one.", 409);
    }
    return row.proposal;
}

/** Accept the proposal: it becomes the task's chain (replacing one that isn't running). */
export async function acceptProposal(taskIdValue: unknown, options: { run?: boolean; id?: unknown } = {}): Promise<ChainRow> {
    const task = await requireTask(taskIdValue);
    const row = await readRow(task.id);
    const proposal = sameProposal(row, options.id);
    const cfg = await readConfig();
    const graph = validateGraph(proposalGraph(proposal), cfg.organizations);
    const existing = await taskChain(task.id, row);
    if (existing && (await latestRun(existing.id))?.status === "running") {
        throw new JarvisError("Stop the validation run before replacing its chain.", 409);
    }
    const chain = existing
        ? await saveChain({ id: existing.id, name: existing.name, graph })
        : await saveChain({ name: chainName(task), graph, ownerTaskId: task.id });
    await update(task.id, (r) => {
        r.chainId = chain.id;
        r.proposal = null;
        r.acceptedAt = now();
        r.acceptedBy = proposal.by;
        r.evidence = Object.fromEntries(proposal.blocks.map((b) => [b.key, { reason: b.reason, evidence: b.evidence, by: proposal.by }]));
    });
    await recordEvent("task.validation", `Validation accepted for ${describeTask(task)}: ${proposal.blocks.map((b) => b.name).join(" → ")}`, {
        taskId: task.id,
        ref: { chainId: chain.id },
    });
    if (options.run) await runValidation(task.id);
    return chain;
}

/** Turn the proposal down; the proposer hears why. */
export async function dismissProposal(taskIdValue: unknown, reasonValue: unknown, id?: unknown): Promise<void> {
    const task = await requireTask(taskIdValue);
    const row = await readRow(task.id);
    if (!row.proposal) return;
    const proposal = sameProposal(row, id);
    const reason = typeof reasonValue === "string" ? reasonValue.trim().slice(0, 1000) : "";
    await update(task.id, (r) => (r.proposal = null));
    await recordEvent("task.validation", `Validation proposal dismissed for ${describeTask(task)}${reason ? `: ${reason}` : ""}`, { taskId: task.id });
    await deliverNotice(
        task.id,
        `The user dismissed your validation proposal for this task${reason ? `, saying: "${reason}"` : " without a reason"}. ` +
            "Don't propose again unless they ask, or the reason tells you what to change.",
        proposal.sessionId,
    );
}

/** Ask the task's worker to find and propose a validation chain. */
export async function askForProposal(taskIdValue: unknown): Promise<string> {
    const task = await requireTask(taskIdValue);
    const workers = await listWorkers(task.id);
    if (!workers.length) throw new JarvisError("Start a worker on this task first; it finds the pipelines.", 409);
    return deliverNotice(task.id, PROPOSE_ASK);
}

const PROPOSE_ASK =
    "Find the pipelines that validate this task's change and propose a validation chain. Use the task_validation tool: " +
    "action candidates lists what the app found (PR checks, pipelines that use those builds, past chains), then action propose " +
    "sends your picks with a reason for each. Read the repo's pipeline YAML and docs if candidates aren't enough. Leave out " +
    "anything that deploys to production, and say what you left out and why.";

// ---- notices to the task's worker ---------------------------------------------------------------

/**
 * Tell the task's worker something (a failed run, a dismissed proposal). It goes to the given
 * session when it's one of the task's workers, else the most recently active one. A busy worker
 * gets it when its turn ends.
 */
export async function deliverNotice(taskId: string, text: string, preferSession?: string | null): Promise<string> {
    // A done task's workers take no new turns; a notice parked now would fire whenever it's reopened.
    if ((await getTask(taskId))?.status !== "open") return "The task isn't open, so its workers weren't told.";
    const workers = await listWorkers(taskId);
    if (!workers.length) return "No worker to tell.";
    const target = workers.find((w) => w.sessionId === preferSession) ?? [...workers].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!(await vrt.workerBusy(target.sessionId))) {
        try {
            await vrt.messageWorker(target.sessionId, text);
            return `Told ${target.label}.`;
        } catch {
            /* busy after all: keep it for later */
        }
    }
    await update(taskId, (r) => (r.pendingNotice = `${r.pendingNotice ? `${r.pendingNotice}\n\n` : ""}${text}`.slice(-MAX_NOTICE)));
    return `${target.label} is busy; it hears this when its turn ends.`;
}

async function flushNotices(): Promise<void> {
    const rows = (await db()).prepare("SELECT task_id FROM jarvis_task_validation WHERE pending_notice IS NOT NULL").all() as Raw[];
    for (const r of rows) {
        const taskId = String(r.task_id);
        const row = await readRow(taskId);
        if (!row.pendingNotice) continue;
        const workers = await listWorkers(taskId);
        if (!workers.length || (await getTask(taskId))?.status !== "open") {
            await update(taskId, (x) => (x.pendingNotice = null));
            continue;
        }
        let idle: (typeof workers)[number] | undefined;
        for (const w of [...workers].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
            if (!(await vrt.workerBusy(w.sessionId))) {
                idle = w;
                break;
            }
        }
        if (!idle) continue;
        const sent = row.pendingNotice;
        try {
            await vrt.messageWorker(idle.sessionId, sent);
            // A notice that came in while this one was on its way stays for the next tick.
            await update(taskId, (x) => {
                const left = x.pendingNotice && x.pendingNotice.startsWith(sent) ? x.pendingNotice.slice(sent.length).replace(/^\n+/, "") : x.pendingNotice;
                x.pendingNotice = left || null;
            });
        } catch {
            /* try again next tick */
        }
    }
}

// ---- reacting to runs ------------------------------------------------------------------------------

async function ownerOf(chainId: string): Promise<{ task: JarvisTask; chain: ChainRow } | null> {
    const chain = await getChain(chainId);
    if (!chain?.ownerTaskId) return null;
    const task = await getTask(chain.ownerTaskId);
    return task ? { task, chain } : null;
}

/** What failed in a run, for the worker: blocks, builds, failed steps, first errors and log links. */
async function failureReport(run: RunRow): Promise<string> {
    const lines: string[] = [];
    for (const n of run.graph.nodes) {
        const s = (run.states as NodeStates)[n.id];
        if (!s || !BROKE.has(s.status) || s.status === "canceled") continue;
        lines.push(`- ${n.name} (${n.project}, pipeline ${n.definitionId})${s.buildNumber ? `, build ${s.buildNumber}` : ""}: ${s.status}${s.error ? `, ${s.error}` : ""}`);
        if (s.url) lines.push(`  Build: ${s.url}`);
        if (s.buildId) {
            try {
                for (const f of await vrt.buildFailures(n.org, n.project, s.buildId)) {
                    lines.push(`  ${f.type || "Step"} "${f.name}" failed${f.errors.length ? `: ${f.errors.join(" | ")}` : ""}`);
                    if (f.logUrl) lines.push(`  Log: ${f.logUrl}`);
                }
            } catch (error) {
                lines.push(`  (Couldn't read the build's timeline: ${(error as Error).message.slice(0, 200)})`);
            }
        }
    }
    return lines.join("\n");
}

export async function onRunEvent(event: PipelineEvent): Promise<void> {
    const owned = await ownerOf(event.chainId);
    if (!owned) return;
    const { task } = owned;
    const run = await getRun(event.runId);
    if (!run) return;
    if (event.type === "runStarted") {
        await recordEvent("task.validation", `Validation started for ${describeTask(task)}`, { taskId: task.id, ref: { chainId: run.chainId, runId: run.runId } });
        // Whatever started it, this run builds the followed PRs' current commits: don't rerun for them.
        const row = await readRow(task.id);
        if (row.rerunOnCommit) {
            const commits = await followedCommits(task.id, owned.chain);
            await update(task.id, (r) => (r.commits = { ...r.commits, ...commits }));
        }
        return;
    }
    const text = describeRun(run);
    await recordEvent("task.validation", `${text} (${describeTask(task)})`, { taskId: task.id, ref: { chainId: run.chainId, runId: run.runId } });
    await postStatus({ taskId: task.id, text: text.slice(0, 160), author: "Validation" }).catch(() => undefined);
    const row = await readRow(task.id);
    if (run.status === "failed" && row.notifyWorker) {
        const report = await failureReport(run);
        await deliverNotice(
            task.id,
            `The task's validation chain failed. ${text}.\n${report}\n\nFind out why from the build logs (the Azure DevOps MCP tools can read them), fix it if the change caused it, and say what you found. ` +
                "Ask the user before running validation again (task_validation action run).",
            null,
        );
    }
}

/** Runs of a task's chain stop when the task is done: reopening it runs them again. */
async function runGuard(chain: ChainRow): Promise<string | null> {
    if (!chain.ownerTaskId) return null;
    const task = await getTask(chain.ownerTaskId);
    if (!task) return "This chain's task was removed.";
    if (task.status === "done") return "The task is done. Reopen it to run its validation.";
    return null;
}

// ---- automatic: proposals and reruns ----------------------------------------------------------------

export async function autoProposeOn(): Promise<boolean> {
    return (await getMeta(AUTO_KEY)) === "1";
}

export async function setAutoPropose(on: unknown): Promise<void> {
    await setMeta(AUTO_KEY, on === true ? "1" : "0");
}

/** The source commit of each PR a block of the chain follows, by org/prId. */
async function followedCommits(taskId: string, chain?: ChainRow | null): Promise<Record<string, string>> {
    const c = chain ?? (await taskChain(taskId));
    if (!c) return {};
    const followed = new Set(c.graph.nodes.filter((n) => n.branchFrom).map((n) => `${n.branchFrom!.org.toLowerCase()}/${n.branchFrom!.prId}`));
    const out: Record<string, string> = {};
    for (const pr of await listTaskPrs(taskId, { includeHidden: true })) {
        const key = `${pr.org.toLowerCase()}/${pr.prId}`;
        if (followed.has(key) && pr.snapshot?.sourceCommit) out[key] = pr.snapshot.sourceCommit;
    }
    return out;
}

async function autoTick(): Promise<void> {
    const auto = await autoProposeOn();
    for (const task of await listTasks()) {
        if (task.status !== "open") continue;
        const row = await readRow(task.id);
        const chain = await taskChain(task.id, row);
        // Ask a worker once, when the task has a PR and no validation yet.
        if (auto && !chain && !row.proposal && !row.autoAskedAt) {
            const prs = await listTaskPrs(task.id);
            const workers = prs.length ? await listWorkers(task.id) : [];
            if (prs.length && workers.length) {
                await update(task.id, (r) => (r.autoAskedAt = now()));
                await deliverNotice(task.id, `A pull request is linked to this task. ${PROPOSE_ASK}`);
            }
        }
        // Run again when a followed PR has a new commit, if the user allowed it.
        if (row.rerunOnCommit && chain) {
            const commits = await followedCommits(task.id, chain);
            const changed = Object.entries(commits).filter(([key, sha]) => row.commits[key] && row.commits[key] !== sha);
            const fresh = Object.entries(commits).some(([key]) => !row.commits[key]);
            if (!changed.length) {
                if (fresh) await update(task.id, (r) => (r.commits = { ...commits, ...r.commits }));
                continue;
            }
            const live = await latestRun(chain.id);
            if (live?.status === "running") continue;
            await update(task.id, (r) => (r.commits = commits));
            try {
                await runValidation(task.id);
                await recordEvent("task.validation", `Validation started for new commit ${changed[0][1].slice(0, 7)} (${describeTask(task)})`, { taskId: task.id });
            } catch (error) {
                console.warn(`[validation] rerun for ${task.id} not started: ${(error as Error).message}`);
            }
        }
    }
}

/** Chains whose task is gone: stop their run, then delete them. */
async function sweepOrphans(): Promise<void> {
    for (const chain of await orphanedTaskChains()) {
        const run = await latestRun(chain.id);
        if (run?.status === "running") {
            if (!run.cancelRequested) {
                await requestRunCancel(run.runId);
                wakePipelineRunner();
            }
            continue;
        }
        await deleteChain(chain.id).catch(() => undefined);
    }
}

// ---- the runner ------------------------------------------------------------------------------------

const TICK_MS = 30_000;
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
let offEvents: (() => void) | null = null;
let offGuard: (() => void) | null = null;

export async function validationTick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
        await sweepOrphans().catch((e: Error) => console.warn(`[validation] sweep: ${e.message}`));
        await flushNotices().catch((e: Error) => console.warn(`[validation] notices: ${e.message}`));
        await autoTick().catch((e: Error) => console.warn(`[validation] auto: ${e.message}`));
    } finally {
        ticking = false;
    }
}

export function startValidationRunner(): void {
    offEvents ??= onPipelineEvent((event) => onRunEvent(event));
    offGuard ??= registerRunGuard(runGuard);
    if (timer) return;
    timer = setInterval(() => void validationTick(), TICK_MS);
    timer.unref?.();
    void validationTick();
}

export function stopValidationRunner(): void {
    if (timer) clearInterval(timer);
    timer = null;
    offEvents?.();
    offEvents = null;
    offGuard?.();
    offGuard = null;
}

// ---- used by the worker and Lead tools ----------------------------------------------------------------

export { blockKey, readRow as validationRow, taskChain as validationChain };
