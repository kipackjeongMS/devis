// A Jarvis task's validation: the pipeline chains a task owns that prove its change works.
//
// A task keeps a flat list of chains, each with a purpose (when to use it), shared by all of
// its workers. Each is an ordinary pipeline chain (same canvas, same runner) with an owner,
// and goes when the task does. A worker or the Lead proposes a new chain or a revision of one
// (see jarvis-validation-agent.mts for what the app checks); nothing changes until the user
// accepts. Chains run side by side, and one chain can run more than once at a time: every run
// is labeled with who started it (its trigger) and whose code it builds (its target, for
// blocks that follow whoever runs the chain). A chain that deploys runs one at a time; a run
// asked for while it's busy waits in the chain's queue, and so does one past the task's cap.
// Runs report back here: a History event and a status line each, Needs you when one fails,
// and whoever ran it (or whose code it built) hears what failed when the user allows it.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { branchExists, getBuildFailures, previewPipeline } from "./ado.mjs";
import {
    PipelineStoreError,
    blockResults,
    chainRuns,
    deleteChain,
    getChain,
    getRun,
    listChains,
    orphanedTaskChains,
    registerRunGuard,
    requestRunCancel,
    saveChain,
    startChainRun,
    type ChainRow,
    type RunOptions,
    type RunRow,
} from "./pipeline-store.mjs";
import { onPipelineEvent, type PipelineEvent } from "./pipeline-events.mjs";
import {
    followsRunner,
    normalizeBranch,
    repoBranchOverrides,
    repoSignature,
    runnerKey,
    validateGraph,
    type BlockResult,
    type ChainGraph,
    type ChainNode,
    type NodeStates,
    type PrRef,
    type RunTarget,
    type RunTrigger,
    type RunnerBranch,
} from "./pipeline-graph.mjs";
import { checkRepoBranches, wakePipelineRunner } from "./pipeline-runner.mjs";
import { readConfig } from "./config.mjs";
import {
    JarvisError,
    asJarvisId,
    describeTask,
    getMeta,
    getTask,
    jarvisDb,
    listTaskBranches,
    listTaskPrs,
    listTasks,
    listWorkers,
    recordEvent,
    setMeta,
    type JarvisTask,
    type JarvisWorker,
    type TaskPr,
} from "./jarvis-store.mjs";
import { postStatus } from "./jarvis-status.mjs";
import { FORMER_LEAD_NAME, LEAD_NAME } from "./brand.mjs";

// ---- runtime ---------------------------------------------------------------------------

/** Azure DevOps reads and the task's workers, swappable for tests. */
export interface ValidationRuntime {
    buildFailures: typeof getBuildFailures;
    /** Compiles a pipeline with a block's overrides, to check repository branches before they're saved. */
    previewPipeline: typeof previewPipeline;
    branchExists: typeof branchExists;
    /** Send a worker a message as a new turn; throws when it can't take one now. */
    messageWorker(sessionId: string, text: string): Promise<unknown>;
    workerBusy(sessionId: string): Promise<boolean>;
    /** The branches a worker has checked out, read when a run that builds its code is asked for. */
    workerBranches(sessionId: string, taskId: string): Promise<RunnerBranch[]>;
}
const ADO_RUNTIME: ValidationRuntime = {
    buildFailures: getBuildFailures,
    previewPipeline,
    branchExists,
    messageWorker: async (sessionId, text) => (await import("./jarvis-workers.mjs")).messageWorker(sessionId, text),
    workerBusy: async (sessionId) => (await import("./jarvis-workers.mjs")).workerLiveState(sessionId).busy,
    workerBranches: async (sessionId, taskId) => (await import("./jarvis-prs.mjs")).workerBranches(sessionId, taskId),
};
let vrt: ValidationRuntime = ADO_RUNTIME;
export function setValidationRuntime(overrides: Partial<ValidationRuntime> | null): void {
    vrt = overrides ? { ...ADO_RUNTIME, ...overrides } : ADO_RUNTIME;
}

// ---- types ----------------------------------------------------------------------------

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
    /** A fixed branch ("" for the pipeline's default); ignored when it follows a PR or the runner. */
    branch: string;
    branchFrom?: PrRef;
    /** Build the branch of whoever runs the chain, read at each run. */
    followRunner?: true;
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
    /** The chain it revises; none for a new chain. */
    chainId?: string;
    /** The chain's name: the revised chain's, or the new chain's. */
    name?: string;
    /** When to use the chain, in a sentence or two. */
    purpose?: string;
    summary: string;
    blocks: ProposedBlock[];
    leftOut: Array<{ key: string; name: string; reason: string; evidence: ValidationEvidence[] }>;
    checks: ProposalCheck[];
    by: string;
    sessionId: string | null;
    at: string;
}

/** How many runs of a chain go at once: one when it deploys, else up to the cap ("auto"), or what the user set. */
export type Concurrency = "auto" | "one" | "parallel";

/** A run asked for while its chain (or the task) was busy, waiting its turn. */
export interface QueuedRun {
    id: string;
    trigger: RunTrigger;
    target: RunTarget | null;
    at: string;
}

type Evidence = Record<string, { reason: string; evidence: ValidationEvidence[]; by: string }>;

interface ChainMeta {
    chainId: string;
    taskId: string;
    purpose: string;
    concurrency: Concurrency;
    /** Workers may run it without asking the user (never for a chain that deploys). */
    workersMayRun: boolean;
    notifyWorker: boolean;
    rerunOnCommit: boolean;
    /** Per block key: why it's there, kept from the accepted proposal. */
    evidence: Evidence;
    acceptedAt: string | null;
    acceptedBy: string | null;
    /** Failed runs the user has looked at. */
    acked: string[];
    /** Per watched PR (org/prId): the source commit the last run saw. */
    commits: Record<string, string>;
    queue: QueuedRun[];
    position: number;
    createdAt: string;
}

interface Notice {
    /** The worker it's for; null for whichever worker is free. */
    to: string | null;
    text: string;
}

interface TaskRow {
    taskId: string;
    notices: Notice[];
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
    /** Who started it: "You", a worker, the Lead, "Auto-rerun"; null for runs from before this was recorded. */
    by: string | null;
    /** Whose code it built, when the chain builds the branch of whoever runs it. */
    for: string | null;
}

export type RunnerKind = RunTrigger["kind"] | "pr" | "unknown";

export interface ValidationChainSummary {
    chainId: string;
    name: string;
    purpose: string;
    blocks: number;
    /** The newest running run, else the newest. */
    run: ValidationRunSummary | null;
    running: number;
    queued: number;
    /** Who ran it last. */
    lastUsed: { by: string; kind: RunnerKind; at: string } | null;
    /** Per runner, its newest run when it failed and the user hasn't looked. */
    failures: ValidationRunSummary[];
}

/** What Today, the task card and the Lead show of a task's validation. */
export interface ValidationSummary {
    chains: ValidationChainSummary[];
    /** The run to headline: an unseen failure, else the newest running, else the newest. */
    run: (ValidationRunSummary & { chainId: string; chain: string }) | null;
    running: number;
    queued: number;
    proposals: Array<{ id: string; by: string; at: string; blocks: number; name: string; chainId: string | null }>;
    failures: Array<ValidationRunSummary & { chainId: string; chain: string }>;
    /** Why the task needs the user: proposals to review, or failed runs nobody has looked at. */
    attention: "proposal" | "failed" | null;
    lastUsed: { by: string; kind: RunnerKind; at: string; chain: string } | null;
}

// ---- limits ----------------------------------------------------------------------------

const now = () => new Date().toISOString();
const AUTO_KEY = "validation.autoPropose";
const NAME_PREFIX = "Validation · ";
const MAX_NOTICE = 6000;
/** Runs of one chain at once, when it may run in parallel. */
export const MAX_CHAIN_ACTIVE = 3;
/** Runs of all a task's chains at once; more wait in their chain's queue. */
export const MAX_TASK_ACTIVE = 6;
/** Runs waiting per chain. */
export const MAX_QUEUE = 10;
const MAX_CHAINS = 12;
const MAX_PROPOSALS = 10;
const MAX_ACKED = 50;
const RUNS_SHOWN = 20;
const MAX_PURPOSE = 300;
const YOU: RunTrigger = { kind: "you", label: "You" };
const AUTO: RunTrigger = { kind: "auto", label: "Auto-rerun" };

// ---- storage ---------------------------------------------------------------------------

let schemaReady: Promise<void> | null = null;

async function db(): Promise<DatabaseSync> {
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
            CREATE TABLE IF NOT EXISTS jarvis_validation_chains (
                chain_id        TEXT PRIMARY KEY,
                task_id         TEXT NOT NULL,
                purpose         TEXT NOT NULL DEFAULT '',
                concurrency     TEXT NOT NULL DEFAULT 'auto',
                workers_may_run INTEGER NOT NULL DEFAULT 0,
                notify_worker   INTEGER NOT NULL DEFAULT 1,
                rerun_on_commit INTEGER NOT NULL DEFAULT 0,
                evidence_json   TEXT,
                accepted_at     TEXT,
                accepted_by     TEXT,
                acked_json      TEXT,
                commits_json    TEXT,
                queue_json      TEXT,
                position        REAL NOT NULL DEFAULT 0,
                created_at      TEXT NOT NULL,
                updated_at      TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_validation_chains_task ON jarvis_validation_chains(task_id);
            CREATE TABLE IF NOT EXISTS jarvis_validation_proposals (
                proposal_id     TEXT PRIMARY KEY,
                task_id         TEXT NOT NULL,
                chain_id        TEXT,
                proposal_json   TEXT NOT NULL,
                created_at      TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_validation_proposals_task ON jarvis_validation_proposals(task_id);
        `);
        // The lead was called Jarvis: proposals it made then read as its name now.
        const was = `"by":${JSON.stringify(FORMER_LEAD_NAME)}`;
        const is = `"by":${JSON.stringify(LEAD_NAME)}`;
        d.prepare(
            `UPDATE jarvis_task_validation SET
                accepted_by = CASE WHEN accepted_by = ? THEN ? ELSE accepted_by END,
                proposal_json = replace(proposal_json, ?, ?),
                evidence_json = replace(evidence_json, ?, ?)
             WHERE accepted_by = ? OR instr(proposal_json, ?) > 0 OR instr(evidence_json, ?) > 0`,
        ).run(FORMER_LEAD_NAME, LEAD_NAME, was, is, was, is, FORMER_LEAD_NAME, was, was);
        migrateSingleChain(d);
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
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

// A task used to have one chain and one proposal, kept on its task row. They move to the
// per-chain and per-proposal tables once; the task row keeps only notices and the auto-ask.
function migrateSingleChain(d: DatabaseSync): void {
    const rows = d.prepare("SELECT * FROM jarvis_task_validation WHERE chain_id IS NOT NULL OR proposal_json IS NOT NULL").all() as Raw[];
    if (!rows.length) return;
    d.exec("BEGIN IMMEDIATE");
    try {
        for (const r of rows) {
            const taskId = String(r.task_id);
            const owned = d.prepare("SELECT id FROM pipeline_chains WHERE owner_task_id = ? ORDER BY created_at").all(taskId) as Raw[];
            const chainId = str(owned.find((c) => c.id === r.chain_id)?.id) ?? str(owned[0]?.id);
            const at = str(r.updated_at) ?? now();
            if (chainId) {
                d.prepare(
                    `INSERT OR IGNORE INTO jarvis_validation_chains (chain_id, task_id, notify_worker, rerun_on_commit, evidence_json,
                         accepted_at, accepted_by, acked_json, commits_json, position, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
                ).run(
                    chainId,
                    taskId,
                    Number(r.notify_worker ?? 1) === 1 ? 1 : 0,
                    Number(r.rerun_on_commit ?? 0) === 1 ? 1 : 0,
                    str(r.evidence_json),
                    str(r.accepted_at),
                    str(r.accepted_by),
                    r.acked_run_id ? JSON.stringify([String(r.acked_run_id)]) : null,
                    str(r.commits_json),
                    at,
                    at,
                );
            }
            const proposal = parse<Proposal | null>(r.proposal_json, null);
            if (proposal?.id) {
                d.prepare(
                    "INSERT OR IGNORE INTO jarvis_validation_proposals (proposal_id, task_id, chain_id, proposal_json, created_at) VALUES (?, ?, ?, ?, ?)",
                ).run(proposal.id, taskId, chainId, JSON.stringify(proposal), proposal.at || at);
            }
            d.prepare(
                `UPDATE jarvis_task_validation SET chain_id = NULL, proposal_json = NULL, evidence_json = NULL, accepted_at = NULL,
                     accepted_by = NULL, acked_run_id = NULL, commits_json = NULL WHERE task_id = ?`,
            ).run(taskId);
        }
        d.exec("COMMIT");
    } catch (error) {
        d.exec("ROLLBACK");
        throw error;
    }
}

// Every chain a task owns has a row here: one made elsewhere gets one, and a row whose chain
// is gone (or isn't the task's) goes. A proposal revising a gone chain becomes a new one.
function syncChains(d: DatabaseSync, taskId?: string): void {
    const owned = (
        taskId
            ? d.prepare("SELECT id, owner_task_id, created_at FROM pipeline_chains WHERE owner_task_id = ?").all(taskId)
            : d.prepare("SELECT id, owner_task_id, created_at FROM pipeline_chains WHERE owner_task_id IS NOT NULL").all()
    ) as Raw[];
    const insert = d.prepare(
        `INSERT OR IGNORE INTO jarvis_validation_chains (chain_id, task_id, accepted_at, accepted_by, position, created_at, updated_at)
         SELECT ?, ?, ?, 'you', COALESCE(MAX(position), -1) + 1, ?, ? FROM jarvis_validation_chains WHERE task_id = ?`,
    );
    for (const c of owned) {
        const at = String(c.created_at);
        insert.run(String(c.id), String(c.owner_task_id), at, at, now(), String(c.owner_task_id));
    }
    const scope = taskId ? " AND jarvis_validation_chains.task_id = ?" : "";
    d.prepare(
        `DELETE FROM jarvis_validation_chains WHERE NOT EXISTS (
             SELECT 1 FROM pipeline_chains c WHERE c.id = jarvis_validation_chains.chain_id AND c.owner_task_id = jarvis_validation_chains.task_id
         )${scope}`,
    ).run(...(taskId ? [taskId] : []));
    d.prepare(
        `UPDATE jarvis_validation_proposals SET chain_id = NULL WHERE chain_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM jarvis_validation_chains m WHERE m.chain_id = jarvis_validation_proposals.chain_id
         )${taskId ? " AND jarvis_validation_proposals.task_id = ?" : ""}`,
    ).run(...(taskId ? [taskId] : []));
}

async function ready(taskId?: string): Promise<DatabaseSync> {
    const d = await db();
    syncChains(d, taskId);
    return d;
}

const CONCURRENCY = new Set<Concurrency>(["auto", "one", "parallel"]);

function toMeta(r: Raw): ChainMeta {
    const concurrency = String(r.concurrency) as Concurrency;
    return {
        chainId: String(r.chain_id),
        taskId: String(r.task_id),
        purpose: String(r.purpose ?? ""),
        concurrency: CONCURRENCY.has(concurrency) ? concurrency : "auto",
        workersMayRun: Number(r.workers_may_run) === 1,
        notifyWorker: Number(r.notify_worker) === 1,
        rerunOnCommit: Number(r.rerun_on_commit) === 1,
        evidence: parse<Evidence>(r.evidence_json, {}),
        acceptedAt: str(r.accepted_at),
        acceptedBy: str(r.accepted_by),
        acked: parse<string[]>(r.acked_json, []),
        commits: parse<Record<string, string>>(r.commits_json, {}),
        queue: parse<QueuedRun[]>(r.queue_json, []),
        position: Number(r.position ?? 0),
        createdAt: String(r.created_at),
    };
}

function putMeta(d: DatabaseSync, m: ChainMeta): void {
    d.prepare(
        `INSERT INTO jarvis_validation_chains (chain_id, task_id, purpose, concurrency, workers_may_run, notify_worker, rerun_on_commit,
             evidence_json, accepted_at, accepted_by, acked_json, commits_json, queue_json, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chain_id) DO UPDATE SET purpose = excluded.purpose, concurrency = excluded.concurrency,
             workers_may_run = excluded.workers_may_run, notify_worker = excluded.notify_worker, rerun_on_commit = excluded.rerun_on_commit,
             evidence_json = excluded.evidence_json, accepted_at = excluded.accepted_at, accepted_by = excluded.accepted_by,
             acked_json = excluded.acked_json, commits_json = excluded.commits_json, queue_json = excluded.queue_json,
             position = excluded.position, updated_at = excluded.updated_at`,
    ).run(
        m.chainId,
        m.taskId,
        m.purpose,
        m.concurrency,
        m.workersMayRun ? 1 : 0,
        m.notifyWorker ? 1 : 0,
        m.rerunOnCommit ? 1 : 0,
        JSON.stringify(m.evidence),
        m.acceptedAt,
        m.acceptedBy,
        JSON.stringify(m.acked),
        JSON.stringify(m.commits),
        JSON.stringify(m.queue),
        m.position,
        m.createdAt,
        now(),
    );
}

/** A new chain's row, last in the task's list. */
function newMeta(d: DatabaseSync, chainId: string, taskId: string, fields: Partial<ChainMeta> = {}): ChainMeta {
    const last = d.prepare("SELECT MAX(position) AS p FROM jarvis_validation_chains WHERE task_id = ?").get(taskId) as Raw | undefined;
    const at = now();
    const meta: ChainMeta = {
        chainId,
        taskId,
        purpose: "",
        concurrency: "auto",
        workersMayRun: false,
        notifyWorker: true,
        rerunOnCommit: false,
        evidence: {},
        acceptedAt: at,
        acceptedBy: "you",
        acked: [],
        commits: {},
        queue: [],
        position: last?.p == null ? 0 : Number(last.p) + 1,
        createdAt: at,
        ...fields,
    };
    putMeta(d, meta);
    return meta;
}

// Reads, changes and writes with no await in between, so changes don't interleave.
async function updateMeta(chainId: string, change: (meta: ChainMeta) => void): Promise<ChainMeta | null> {
    const d = await db();
    const r = d.prepare("SELECT * FROM jarvis_validation_chains WHERE chain_id = ?").get(chainId) as Raw | undefined;
    if (!r) return null;
    const meta = toMeta(r);
    change(meta);
    putMeta(d, meta);
    return meta;
}

function readNotices(raw: unknown): Notice[] {
    if (typeof raw !== "string" || !raw) return [];
    if (raw.startsWith("[")) {
        const list = parse<unknown>(raw, null);
        if (Array.isArray(list)) {
            return list
                .filter((n): n is Notice => !!n && typeof (n as Notice).text === "string")
                .map((n) => ({ to: typeof n.to === "string" ? n.to : null, text: n.text }));
        }
    }
    // Before notices had an addressee they were one block of text.
    return [{ to: null, text: raw }];
}

/** The newest notices that fit, so a flood can't grow the row without bound. */
function capNotices(list: Notice[]): Notice[] {
    const out: Notice[] = [];
    let size = 0;
    for (const n of [...list].reverse()) {
        if (size + n.text.length > MAX_NOTICE) {
            if (!out.length) out.push({ ...n, text: n.text.slice(-MAX_NOTICE) });
            break;
        }
        out.push(n);
        size += n.text.length;
    }
    return out.reverse();
}

async function readTaskRow(taskId: string): Promise<TaskRow> {
    const r = (await db()).prepare("SELECT pending_notice, auto_asked_at FROM jarvis_task_validation WHERE task_id = ?").get(taskId) as Raw | undefined;
    return { taskId, notices: readNotices(r?.pending_notice), autoAskedAt: str(r?.auto_asked_at) };
}

async function updateTaskRow(taskId: string, change: (row: TaskRow) => void): Promise<void> {
    const d = await db();
    const r = d.prepare("SELECT pending_notice, auto_asked_at FROM jarvis_task_validation WHERE task_id = ?").get(taskId) as Raw | undefined;
    const row: TaskRow = { taskId, notices: readNotices(r?.pending_notice), autoAskedAt: str(r?.auto_asked_at) };
    change(row);
    d.prepare(
        `INSERT INTO jarvis_task_validation (task_id, pending_notice, auto_asked_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET pending_notice = excluded.pending_notice, auto_asked_at = excluded.auto_asked_at,
             updated_at = excluded.updated_at`,
    ).run(taskId, row.notices.length ? JSON.stringify(capNotices(row.notices)) : null, row.autoAskedAt, now());
}

function toProposal(r: Raw): Proposal | null {
    const p = parse<Proposal | null>(r.proposal_json, null);
    if (!p) return null;
    const chainId = str(r.chain_id);
    const { chainId: _was, ...rest } = p;
    return { ...rest, id: String(r.proposal_id), ...(chainId ? { chainId } : {}) };
}

async function listProposals(taskId: string): Promise<Proposal[]> {
    const d = await ready(taskId);
    const rows = d.prepare("SELECT * FROM jarvis_validation_proposals WHERE task_id = ? ORDER BY created_at, rowid").all(taskId) as Raw[];
    return rows.map(toProposal).filter((p): p is Proposal => !!p);
}

async function requireTask(value: unknown): Promise<JarvisTask> {
    const id = asJarvisId(value);
    const task = id ? await getTask(id) : null;
    if (!task) throw new JarvisError("Task not found.", 404);
    return task;
}

function requireOpen(task: JarvisTask): void {
    if (task.status === "done") throw new JarvisError("The task is done. Reopen it to change its validation.", 409);
}

/** The first chain is "Validation · <task>"; later ones are numbered. */
const chainName = (task: JarvisTask, count = 0) => `${NAME_PREFIX}${task.title}`.slice(0, 110) + (count ? ` (${count + 1})` : "");
const blockKey = (n: { org: string; project: string; definitionId: number }) =>
    `${n.org.toLowerCase()}/${n.project.toLowerCase()}/${n.definitionId}`;
const cleanText = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

function storeError(error: unknown): JarvisError {
    if (error instanceof JarvisError) return error;
    const e = error as Error & { status?: number };
    return new JarvisError(e.message, e instanceof PipelineStoreError ? e.status : (e.status ?? 400));
}

// ---- loading ---------------------------------------------------------------------------

interface Loaded {
    chain: ChainRow;
    meta: ChainMeta;
    /** Newest first. */
    runs: RunRow[];
}

/** The task's chains in the user's order, each with its newest runs. */
async function loadChains(taskId: string, runs = RUNS_SHOWN): Promise<Loaded[]> {
    const d = await ready(taskId);
    const metas = (d.prepare("SELECT * FROM jarvis_validation_chains WHERE task_id = ? ORDER BY position, created_at").all(taskId) as Raw[]).map(toMeta);
    const out: Loaded[] = [];
    for (const meta of metas) {
        const chain = await getChain(meta.chainId);
        if (!chain || chain.ownerTaskId !== taskId) continue;
        out.push({ chain, meta, runs: runs ? await chainRuns(chain.id, runs) : [] });
    }
    return out;
}

async function loadChain(taskId: string, chainIdValue: unknown, runs = RUNS_SHOWN): Promise<Loaded> {
    const chainId = typeof chainIdValue === "string" ? chainIdValue : "";
    const found = (await loadChains(taskId, 0)).find((l) => l.chain.id === chainId);
    if (!found) throw new JarvisError("That validation chain isn't on this task anymore.", 404);
    if (runs) found.runs = await chainRuns(chainId, runs);
    return found;
}

async function liveRuns(chainId: string): Promise<RunRow[]> {
    const ids = (await db())
        .prepare("SELECT run_id FROM pipeline_runs WHERE chain_id = ? AND status = 'running' ORDER BY created_at DESC, rowid DESC")
        .all(chainId) as Raw[];
    return (await Promise.all(ids.map((r) => getRun(String(r.run_id))))).filter((r): r is RunRow => !!r);
}

async function taskActiveCount(taskId: string): Promise<number> {
    const r = (await db())
        .prepare(
            `SELECT COUNT(*) AS n FROM pipeline_runs r JOIN pipeline_chains c ON c.id = r.chain_id
             WHERE c.owner_task_id = ? AND r.status = 'running'`,
        )
        .get(taskId) as Raw;
    return Number(r.n);
}

// ---- concurrency -------------------------------------------------------------------------

const DEPLOYS = [/deploy|release|rollout|provision/i, /(^|[^a-z])ev2/i, /(^|[^a-z])cd([^a-z]|$)/i];

/** The first block whose name or path reads like a deployment, if one does. */
export function deployHint(graph: ChainGraph): string | null {
    const n = graph.nodes.find((x) => DEPLOYS.some((re) => re.test(x.name) || re.test(x.path)));
    return n ? n.name : null;
}

function runMode(meta: Pick<ChainMeta, "concurrency">, graph: ChainGraph): "one" | "parallel" {
    if (meta.concurrency !== "auto") return meta.concurrency;
    return deployHint(graph) ? "one" : "parallel";
}

const maxActiveFor = (mode: "one" | "parallel") => (mode === "one" ? 1 : MAX_CHAIN_ACTIVE);

/** Workers may start it without asking: the user allowed it and it doesn't deploy. */
const mayRunUnasked = (meta: ChainMeta, graph: ChainGraph) => meta.workersMayRun && !deployHint(graph);

// ---- runners and summaries -------------------------------------------------------------------

interface Runner {
    key: string;
    label: string;
    kind: RunnerKind;
}

/** Whose run it is, for "latest per runner": whose code it built, else who started it. */
function runnerOf(run: Pick<RunRow, "trigger" | "target">): Runner {
    const t = run.target;
    if (t) {
        if (t.sessionId) return { key: `w:${t.sessionId}`, label: t.label, kind: "worker" };
        return { key: runnerKey(t) ?? `t:${t.label}`, label: t.label, kind: t.pr ? "pr" : "unknown" };
    }
    const g = run.trigger;
    if (g) return { key: g.sessionId ? `w:${g.sessionId}` : `${g.kind}:${g.label}`, label: g.label, kind: g.kind };
    return { key: "unknown", label: "Not recorded", kind: "unknown" };
}

/** One string per request, so asking again while it runs or waits doesn't start a second one. */
function requestKey(trigger: RunTrigger | null, target: RunTarget | null): string {
    const who = trigger ? (trigger.sessionId ?? `${trigger.kind}:${trigger.label}`) : "unknown";
    return `${who}|${target ? (runnerKey(target) ?? target.label) : ""}`;
}

/** Each runner's newest run, newest first. */
function latestPerRunner(runs: RunRow[]): Array<{ runner: Runner; run: RunRow }> {
    const seen = new Map<string, { runner: Runner; run: RunRow }>();
    for (const run of runs) {
        const runner = runnerOf(run);
        if (!seen.has(runner.key)) seen.set(runner.key, { runner, run });
    }
    return [...seen.values()];
}

function unseenFailures(meta: ChainMeta, runs: RunRow[]): RunRow[] {
    return latestPerRunner(runs)
        .map((x) => x.run)
        .filter((run) => run.status === "failed" && !meta.acked.includes(run.runId));
}

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
        by: run.trigger?.label ?? null,
        for: run.target?.label ?? null,
    };
}

function lastUsedOf(runs: RunRow[]): ValidationChainSummary["lastUsed"] {
    const run = runs[0];
    if (!run) return null;
    return { by: run.trigger?.label ?? "Not recorded", kind: run.trigger?.kind ?? "unknown", at: run.createdAt };
}

function chainSummary({ chain, meta, runs }: Loaded): ValidationChainSummary {
    const running = runs.filter((r) => r.status === "running");
    const shown = running[0] ?? runs[0];
    return {
        chainId: chain.id,
        name: chain.name,
        purpose: meta.purpose,
        blocks: chain.graph.nodes.length,
        run: shown ? summarizeRun(shown) : null,
        running: running.length,
        queued: meta.queue.length,
        lastUsed: lastUsedOf(runs),
        failures: unseenFailures(meta, runs).map(summarizeRun),
    };
}

/** The name a proposal shows: its own, the chain it revises, or what a new chain would be called. */
function proposalName(p: Proposal, loaded: Loaded[]): string {
    const revised = p.chainId ? loaded.find((l) => l.chain.id === p.chainId) : undefined;
    return revised?.chain.name ?? p.name ?? "New validation chain";
}

function summarize(loaded: Loaded[], proposals: Proposal[]): ValidationSummary | null {
    if (!loaded.length && !proposals.length) return null;
    const chains = loaded.map(chainSummary);
    const tag = (c: ValidationChainSummary, r: ValidationRunSummary) => ({ ...r, chainId: c.chainId, chain: c.name });
    const newestFirst = (a: ValidationRunSummary, b: ValidationRunSummary) =>
        (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt);
    const failures = chains.flatMap((c) => c.failures.map((f) => tag(c, f))).sort(newestFirst);
    const withRuns = chains.filter((c) => c.run).map((c) => tag(c, c.run!));
    const running = withRuns.filter((r) => r.status === "running").sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const newest = [...withRuns].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const used = chains.filter((c) => c.lastUsed).sort((a, b) => b.lastUsed!.at.localeCompare(a.lastUsed!.at))[0];
    return {
        chains,
        run: failures[0] ?? running[0] ?? newest[0] ?? null,
        running: chains.reduce((n, c) => n + c.running, 0),
        queued: chains.reduce((n, c) => n + c.queued, 0),
        proposals: proposals.map((p) => ({
            id: p.id,
            by: p.by,
            at: p.at,
            blocks: p.blocks.length,
            name: proposalName(p, loaded),
            chainId: p.chainId ?? null,
        })),
        failures,
        attention: proposals.length ? "proposal" : failures.length ? "failed" : null,
        lastUsed: used ? { ...used.lastUsed!, chain: used.name } : null,
    };
}

export async function validationSummary(taskId: string): Promise<ValidationSummary | null> {
    const loaded = await loadChains(taskId);
    return summarize(loaded, await listProposals(taskId));
}

/** Summaries for many tasks at once, for Today. */
export async function validationSummaries(taskIds: string[]): Promise<Map<string, ValidationSummary>> {
    const out = new Map<string, ValidationSummary>();
    const d = await ready();
    const withAny = new Set(
        (
            d
                .prepare("SELECT task_id FROM jarvis_validation_chains UNION SELECT task_id FROM jarvis_validation_proposals")
                .all() as Raw[]
        ).map((r) => String(r.task_id)),
    );
    for (const id of taskIds) {
        if (!withAny.has(id)) continue;
        const summary = await validationSummary(id);
        if (summary) out.set(id, summary);
    }
    return out;
}

/** What a run did, for status lines, History and the recap: "passed: Build → Deploy Dev". */
function runText(run: RunRow): string {
    const s = summarizeRun(run);
    const states = run.states as NodeStates;
    const path = run.graph.nodes
        .filter((n) => states[n.id])
        .map((n) => n.name)
        .join(" → ");
    if (run.status === "succeeded") return `passed: ${path}`;
    if (run.status === "canceled") return `stopped${s.done ? ` after ${s.done} of ${s.total}` : ""}`;
    if (run.status === "failed") {
        const failedNode = run.graph.nodes.find((n) => BROKE.has(states[n.id]?.status || ""));
        const st = failedNode ? states[failedNode.id] : null;
        const why = st?.error ? `: ${st.error}` : st?.buildNumber ? ` (build ${st.buildNumber})` : "";
        return `failed at ${failedNode?.name ?? "a block"}${why}`;
    }
    return `running: ${s.done} of ${s.total} passed${s.current ? `, ${s.current} running` : ""}`;
}

/** "Validation · AKS RBAC for aks-rbac-worker-1 passed: Build → Deploy Dev". */
function describeRun(name: string, run: RunRow): string {
    const label = /validation/i.test(name) ? name : `Validation "${name}"`;
    const whose = run.target ? ` for ${run.target.label}` : "";
    return `${label}${whose} ${runText(run)}`.slice(0, 300);
}

const possessive = (label: string) => (label === "You" ? "your" : label.endsWith("s") ? `${label}'` : `${label}'s`);

function waitingFor(position: number, active: RunRow[], taskFull: boolean): string {
    if (position > 1) return `Behind ${position - 1} earlier ${position === 2 ? "request" : "requests"}`;
    if (active.length) return `Waiting for ${active[0].trigger ? possessive(active[0].trigger.label) : "the current"} run to finish`;
    if (taskFull) return `Waiting: the task has ${MAX_TASK_ACTIVE} runs going`;
    return "Starting next";
}

// ---- the full view ------------------------------------------------------------------------

export interface RunBlockView {
    id: string;
    name: string;
    status: string;
    buildNumber?: string;
    url?: string;
    error?: string;
    branch?: string;
}

export interface RunView extends ValidationRunSummary {
    trigger: RunTrigger | null;
    target: RunTarget | null;
    /** The blocks this run took in, in chain order, with how each went. */
    blocks: RunBlockView[];
    cancelRequested: boolean;
    /** A failed run the user has looked at. */
    acked: boolean;
    text: string;
    error: string | null;
}

export interface QueueView {
    id: string;
    trigger: RunTrigger;
    target: RunTarget | null;
    at: string;
    position: number;
    waitingFor: string;
}

export interface ValidationChainView {
    chain: ChainRow;
    purpose: string;
    concurrency: Concurrency;
    /** What `concurrency` comes to now. */
    mode: "one" | "parallel";
    maxActive: number;
    /** The block that reads like a deployment, which keeps the chain one-at-a-time and asking. */
    deploys: string | null;
    workersMayRun: boolean;
    /** Workers may run it without asking right now (the setting, and it doesn't deploy). */
    workersMayRunNow: boolean;
    notifyWorker: boolean;
    rerunOnCommit: boolean;
    /** Some block builds the branch of whoever runs it: a run needs a target. */
    followsRunner: boolean;
    acceptedAt: string | null;
    acceptedBy: string | null;
    evidence: Evidence;
    /** Newest first. */
    runs: RunView[];
    queue: QueueView[];
    /** Each runner's newest run. */
    latest: Array<{ key: string; label: string; kind: RunnerKind; runId: string; status: string; at: string }>;
    results: BlockResult[];
    summary: ValidationChainSummary;
}

/** Whose code a run can build: a worker's checked-out branches, or a PR's source branch. */
export interface TargetChoice {
    id: string;
    kind: "worker" | "pr";
    label: string;
    detail: string;
    /** It has a branch to build: a worker with none seen yet can't be picked. */
    ready: boolean;
    sessionId?: string;
}

export interface ValidationView {
    taskId: string;
    taskStatus: string;
    chains: ValidationChainView[];
    proposals: Array<Omit<Proposal, "name" | "chainId"> & { name: string; chainId: string | null }>;
    autoPropose: boolean;
    /** The task's PRs a block can follow. */
    prs: Array<{ org: string; prId: number; title: string; sourceRef: string; status: string }>;
    /** Saved chains (not owned by a task) that can be copied in. */
    templates: Array<{ id: string; name: string; nodeCount: number }>;
    targets: TargetChoice[];
    limits: { perChain: number; perTask: number; queue: number; chains: number };
    running: number;
    summary: ValidationSummary | null;
}

function runView(run: RunRow, meta: ChainMeta): RunView {
    const states = run.states as NodeStates;
    return {
        ...summarizeRun(run),
        trigger: run.trigger,
        target: run.target,
        blocks: run.graph.nodes
            .filter((n) => states[n.id])
            .map((n) => {
                const s = states[n.id];
                return {
                    id: n.id,
                    name: n.name,
                    status: s.status,
                    ...(s.buildNumber ? { buildNumber: s.buildNumber } : {}),
                    ...(s.url ? { url: s.url } : {}),
                    ...(s.error ? { error: s.error } : {}),
                    ...(s.branch ? { branch: s.branch } : {}),
                };
            }),
        cancelRequested: run.cancelRequested,
        acked: meta.acked.includes(run.runId),
        text: runText(run),
        error: run.error,
    };
}

export async function validationView(taskIdValue: unknown): Promise<ValidationView> {
    const task = await requireTask(taskIdValue);
    const [loaded, proposals, prs, all, workers, branches] = await Promise.all([
        loadChains(task.id),
        listProposals(task.id),
        listTaskPrs(task.id),
        listChains(),
        listWorkers(task.id),
        listTaskBranches(task.id),
    ]);
    const taskActive = await taskActiveCount(task.id);
    const chains: ValidationChainView[] = [];
    for (const l of loaded) {
        const { chain, meta, runs } = l;
        const mode = runMode(meta, chain.graph);
        const active = runs.filter((r) => r.status === "running");
        const deploys = deployHint(chain.graph);
        chains.push({
            chain,
            purpose: meta.purpose,
            concurrency: meta.concurrency,
            mode,
            maxActive: maxActiveFor(mode),
            deploys,
            workersMayRun: meta.workersMayRun,
            workersMayRunNow: mayRunUnasked(meta, chain.graph),
            notifyWorker: meta.notifyWorker,
            rerunOnCommit: meta.rerunOnCommit,
            followsRunner: followsRunner(chain.graph),
            acceptedAt: meta.acceptedAt,
            acceptedBy: meta.acceptedBy,
            evidence: meta.evidence,
            runs: runs.map((r) => runView(r, meta)),
            queue: meta.queue.map((q, i) => ({ ...q, position: i + 1, waitingFor: waitingFor(i + 1, active, taskActive >= MAX_TASK_ACTIVE) })),
            latest: latestPerRunner(runs).map(({ runner, run }) => ({
                key: runner.key,
                label: runner.label,
                kind: runner.kind,
                runId: run.runId,
                status: run.status,
                at: run.createdAt,
            })),
            results: await blockResults(chain.id),
            summary: chainSummary(l),
        });
    }
    return {
        taskId: task.id,
        taskStatus: task.status,
        chains,
        proposals: proposals.map((p) => ({ ...p, name: proposalName(p, loaded), chainId: p.chainId ?? null })),
        autoPropose: await autoProposeOn(),
        prs: followablePrs(prs),
        templates: all.filter((c) => !c.owner && c.nodeCount).map((c) => ({ id: c.id, name: c.name, nodeCount: c.nodeCount })),
        targets: targetChoices(workers, branches, prs),
        limits: { perChain: MAX_CHAIN_ACTIVE, perTask: MAX_TASK_ACTIVE, queue: MAX_QUEUE, chains: MAX_CHAINS },
        running: taskActive,
        summary: summarize(loaded, proposals),
    };
}

function followablePrs(prs: TaskPr[]) {
    return prs
        .filter((p) => p.snapshot && !p.hidden)
        .map((p) => ({ org: p.org, prId: p.prId, title: p.snapshot!.title, sourceRef: p.snapshot!.sourceRef, status: p.snapshot!.status }));
}

const shortRef = (ref: string) => ref.replace(/^refs\/heads\//, "");

function targetChoices(workers: JarvisWorker[], branches: Awaited<ReturnType<typeof listTaskBranches>>, prs: TaskPr[]): TargetChoice[] {
    const out: TargetChoice[] = [];
    for (const w of [...workers].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
        const newest = new Map<string, string>();
        for (const b of branches.filter((x) => x.sessionId === w.sessionId)) newest.set(b.repo.toLowerCase(), `${b.repo}@${shortRef(b.branch)}`);
        out.push({
            id: `worker:${w.sessionId}`,
            kind: "worker",
            label: w.label,
            detail: newest.size ? [...newest.values()].join(", ") : "No branch seen yet",
            ready: newest.size > 0,
            sessionId: w.sessionId,
        });
    }
    for (const p of prs) {
        if (!p.snapshot || p.hidden || p.snapshot.status !== "active") continue;
        out.push({
            id: `pr:${p.org}/${p.prId}`,
            kind: "pr",
            label: `PR ${p.prId}`,
            detail: `${p.snapshot.title} (${p.snapshot.repo}, ${shortRef(p.snapshot.sourceRef)})`,
            ready: true,
        });
    }
    return out;
}

/**
 * Whose code a run builds, from a choice in targets: "worker:<sessionId>" reads the worker's
 * checked-out branches now; "pr:<org>/<prId>" builds the PR's source branch when each block
 * queues. Empty means none (fine for a chain that doesn't follow its runner).
 */
export async function resolveTarget(taskIdValue: unknown, spec: unknown): Promise<RunTarget | null> {
    const task = await requireTask(taskIdValue);
    if (spec === undefined || spec === null || spec === "") return null;
    if (typeof spec === "string" && spec.startsWith("worker:")) {
        const sessionId = spec.slice("worker:".length);
        const worker = (await listWorkers(task.id)).find((w) => w.sessionId === sessionId);
        if (!worker) throw new JarvisError("That worker isn't on this task anymore.", 404);
        return { label: worker.label, sessionId: worker.sessionId, branches: await vrt.workerBranches(worker.sessionId, task.id) };
    }
    const m = typeof spec === "string" ? /^pr:([^/]+)\/(\d+)$/.exec(spec) : null;
    if (m) {
        const pr = (await listTaskPrs(task.id, { includeHidden: true })).find(
            (p) => p.org.toLowerCase() === m[1].toLowerCase() && p.prId === Number(m[2]),
        );
        if (!pr) throw new JarvisError(`PR ${m[2]} isn't linked to this task.`, 404);
        return { label: `PR ${pr.prId}`, branches: [], pr: { org: pr.org, prId: pr.prId, ...(pr.snapshot?.repo ? { repo: pr.snapshot.repo } : {}) } };
    }
    throw new JarvisError("Pick whose code the run builds: a worker or a PR.", 400);
}

/** A worker's own code, for its "run my code". */
export function workerTarget(taskId: string, sessionId: string): Promise<RunTarget | null> {
    return resolveTarget(taskId, `worker:${sessionId}`);
}

// ---- running ------------------------------------------------------------------------------

/** How one chain of a run request went. */
export interface RunOutcome {
    chainId: string;
    name: string;
    status: "started" | "queued" | "already" | "refused";
    runId?: string;
    queueId?: string;
    position?: number;
    waitingFor?: string;
    message: string;
}

export interface RunRequest {
    trigger: RunTrigger;
    /** Whose code blocks that follow the runner build; ignored for a chain with none. */
    target?: RunTarget | null;
}

// Starting and queuing for one task happen one at a time, so two requests can't both see
// room for one more run.
const locks = new Map<string, Promise<unknown>>();
function withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(taskId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined);
    locks.set(taskId, tail);
    void tail.then(() => {
        if (locks.get(taskId) === tail) locks.delete(taskId);
    });
    return next;
}

const isBusyError = (error: unknown) => error instanceof PipelineStoreError && error.status === 409 && /already/i.test(error.message);

/**
 * Run some of a task's chains: each starts now when there's room (its own limit, the task's,
 * and nobody waiting ahead), else waits in its queue. Asking again for a run that's going or
 * waiting doesn't add another. Throws only when every chain was refused.
 */
export async function runChains(taskIdValue: unknown, chainIdsValue: unknown, request: RunRequest): Promise<RunOutcome[]> {
    const task = await requireTask(taskIdValue);
    if (task.status !== "open") throw new JarvisError("The task is done. Reopen it to run its validation.", 409);
    const ids = Array.isArray(chainIdsValue)
        ? [...new Set(chainIdsValue.filter((x): x is string => typeof x === "string" && !!x))]
        : typeof chainIdsValue === "string" && chainIdsValue
          ? [chainIdsValue]
          : [];
    if (!ids.length) throw new JarvisError("Pick a validation chain to run.", 400);
    const outcomes = await withTaskLock(task.id, async () => {
        const loaded = await loadChains(task.id, 0);
        const out: RunOutcome[] = [];
        for (const id of ids) {
            const l = loaded.find((x) => x.chain.id === id);
            if (!l) out.push({ chainId: id, name: "", status: "refused", message: "That validation chain isn't on this task anymore." });
            else out.push(await runOne(task, l, request));
        }
        return out;
    });
    if (outcomes.some((o) => o.status === "started")) wakePipelineRunner();
    if (outcomes.every((o) => o.status === "refused")) throw new JarvisError(outcomes.map((o) => o.message).join(" "), 409);
    return outcomes;
}

async function runOne(task: JarvisTask, l: Loaded, request: RunRequest): Promise<RunOutcome> {
    const { chain, meta } = l;
    const base = { chainId: chain.id, name: chain.name };
    const refuse = (message: string): RunOutcome => ({ ...base, status: "refused", message });
    if (!chain.graph.nodes.length) return refuse(`"${chain.name}" has no pipelines yet. Add some in Pipelines first.`);
    const follows = followsRunner(chain.graph);
    const target = follows ? (request.target ?? null) : null;
    if (follows && !target) return refuse(`"${chain.name}" builds the branch of whoever runs it. Pick whose code to build: a worker or a PR.`);
    if (target && !target.pr && !target.branches.length) {
        return refuse(`${target.label} has no branch checked out that the app can see, so "${chain.name}" has nothing to build. Pick a PR instead.`);
    }
    const whose = target ? ` for ${target.label}` : "";
    const key = requestKey(request.trigger, target);
    const live = await liveRuns(chain.id);
    const dup = live.find((r) => requestKey(r.trigger, r.target) === key);
    // Same requester and same code: it can only be the asker's own earlier run.
    if (dup) return { ...base, status: "already", runId: dup.runId, message: `"${chain.name}" is already running${whose}, from your earlier request.` };
    const waiting = meta.queue.findIndex((q) => requestKey(q.trigger, q.target) === key);
    if (waiting >= 0) {
        const q = meta.queue[waiting];
        return { ...base, status: "already", queueId: q.id, position: waiting + 1, message: `"${chain.name}" is already waiting to run${whose}.` };
    }
    const max = maxActiveFor(runMode(meta, chain.graph));
    const taskActive = await taskActiveCount(task.id);
    if (live.length < max && taskActive < MAX_TASK_ACTIVE && !meta.queue.length) {
        try {
            const run = await startChainRun(chain.id, { maxActive: max, trigger: request.trigger, ...(target ? { target } : {}) });
            return { ...base, status: "started", runId: run.runId, message: `"${chain.name}" started${whose}.` };
        } catch (error) {
            if (!isBusyError(error)) return refuse((error as Error).message);
        }
    }
    if (meta.queue.length >= MAX_QUEUE) return refuse(`"${chain.name}" already has ${MAX_QUEUE} runs waiting. Try again once some have started.`);
    const entry: QueuedRun = { id: randomUUID(), trigger: request.trigger, target, at: now() };
    const saved = await updateMeta(chain.id, (m) => m.queue.push(entry));
    if (!saved) return refuse("That validation chain isn't on this task anymore.");
    const position = saved.queue.findIndex((q) => q.id === entry.id) + 1;
    const why = waitingFor(position, await liveRuns(chain.id), (await taskActiveCount(task.id)) >= MAX_TASK_ACTIVE);
    await recordEvent("task.validation", `${request.trigger.label} queued "${chain.name}"${whose} (${describeTask(task)}): ${why.toLowerCase()}`, {
        taskId: task.id,
        sessionId: request.trigger.sessionId,
        ref: { chainId: chain.id },
    });
    return { ...base, status: "queued", queueId: entry.id, position, waitingFor: why, message: `"${chain.name}" is queued${whose}: ${why.toLowerCase()}.` };
}

/** Start what's waiting, oldest first, while there's room. A done task's queues are dropped. */
export async function drainQueues(taskId: string): Promise<void> {
    const started = await withTaskLock(taskId, async () => {
        const loaded = (await loadChains(taskId, 0)).filter((l) => l.meta.queue.length);
        if (!loaded.length) return 0;
        if ((await getTask(taskId))?.status !== "open") {
            for (const l of loaded) await updateMeta(l.chain.id, (m) => (m.queue = []));
            return 0;
        }
        let taskActive = await taskActiveCount(taskId);
        const entries = loaded.flatMap((l) => l.meta.queue.map((q) => ({ l, q }))).sort((a, b) => a.q.at.localeCompare(b.q.at));
        const blocked = new Set<string>();
        let count = 0;
        for (const { l, q } of entries) {
            if (taskActive >= MAX_TASK_ACTIVE) break;
            if (blocked.has(l.chain.id)) continue;
            const chain = await getChain(l.chain.id);
            if (!chain) continue;
            const max = maxActiveFor(runMode(l.meta, chain.graph));
            if ((await liveRuns(chain.id)).length >= max) {
                blocked.add(chain.id);
                continue;
            }
            const taken = await updateMeta(chain.id, (m) => (m.queue = m.queue.filter((x) => x.id !== q.id)));
            if (!taken) continue;
            try {
                await startChainRun(chain.id, { maxActive: max, trigger: q.trigger, ...(q.target ? { target: q.target } : {}) });
                taskActive++;
                count++;
            } catch (error) {
                if (isBusyError(error)) {
                    await updateMeta(chain.id, (m) => {
                        m.queue.push(q);
                        m.queue.sort((a, b) => a.at.localeCompare(b.at));
                    });
                    blocked.add(chain.id);
                    continue;
                }
                const message = (error as Error).message;
                await recordEvent("task.validation", `The queued run of "${chain.name}" for ${q.trigger.label} couldn't start: ${message}`, {
                    taskId,
                    ref: { chainId: chain.id },
                });
                const to = q.trigger.sessionId ?? q.target?.sessionId ?? null;
                if (to) await deliverNotice(taskId, `Your queued run of validation chain "${chain.name}" (chainId ${chain.id}) couldn't start: ${message}`, to);
            }
        }
        return count;
    });
    if (started) wakePipelineRunner();
}

/** Stop one run of one of the task's chains. */
export async function stopRun(taskIdValue: unknown, runIdValue: unknown): Promise<boolean> {
    const task = await requireTask(taskIdValue);
    const run = typeof runIdValue === "string" ? await getRun(runIdValue) : null;
    if (!run) throw new JarvisError("That run is gone.", 404);
    const chain = await getChain(run.chainId);
    if (chain?.ownerTaskId !== task.id) throw new JarvisError("That run isn't one of this task's.", 404);
    if (run.status !== "running") return false;
    await requestRunCancel(run.runId);
    wakePipelineRunner();
    return true;
}

/** Take a waiting run out of its chain's queue. */
export async function cancelQueued(taskIdValue: unknown, chainIdValue: unknown, queueIdValue: unknown): Promise<boolean> {
    const task = await requireTask(taskIdValue);
    return withTaskLock(task.id, async () => {
        const { chain } = await loadChain(task.id, chainIdValue, 0);
        let removed: QueuedRun | undefined;
        await updateMeta(chain.id, (m) => {
            removed = m.queue.find((q) => q.id === queueIdValue);
            m.queue = m.queue.filter((q) => q.id !== queueIdValue);
        });
        if (!removed) return false;
        await recordEvent("task.validation", `The queued run of "${chain.name}" for ${removed.trigger.label} was canceled (${describeTask(task)})`, {
            taskId: task.id,
            ref: { chainId: chain.id },
        });
        return true;
    });
}

/**
 * How a run started from the Pipelines canvas goes: a user's own chain as before; a task's
 * chain under its limits, labeled as yours. Runs waiting for it come first.
 */
export async function pipelineRunOptions(chainId: string): Promise<RunOptions> {
    const chain = await getChain(chainId);
    if (!chain?.ownerTaskId) return {};
    const d = await ready(chain.ownerTaskId);
    const r = d.prepare("SELECT * FROM jarvis_validation_chains WHERE chain_id = ?").get(chainId) as Raw | undefined;
    const meta = r ? toMeta(r) : null;
    if (meta?.queue.length) {
        throw new PipelineStoreError(`${meta.queue.length === 1 ? "A run is" : `${meta.queue.length} runs are`} waiting for this chain. Run it from its task's Validation tab.`, 409);
    }
    // Pipelines can't say whose code to build; the task's Validation tab asks.
    if (followsRunner(chain.graph)) {
        throw new PipelineStoreError("This chain builds the branch of whoever runs it. Run it from its task's Validation tab, which asks whose code to build.", 409);
    }
    if ((await taskActiveCount(chain.ownerTaskId)) >= MAX_TASK_ACTIVE) {
        throw new PipelineStoreError(`This task already has ${MAX_TASK_ACTIVE} validation runs going. Wait for one to finish.`, 409);
    }
    return { maxActive: maxActiveFor(runMode(meta ?? { concurrency: "auto" }, chain.graph)), trigger: YOU };
}

// ---- lifecycle ------------------------------------------------------------------------------

/** Add a chain to the task: a copy of a saved chain, or an empty one to build in Pipelines. */
export async function attachChain(
    taskIdValue: unknown,
    options: { from?: unknown; name?: unknown; purpose?: unknown } = {},
): Promise<ChainRow> {
    const task = await requireTask(taskIdValue);
    requireOpen(task);
    const existing = await loadChains(task.id, 0);
    if (existing.length >= MAX_CHAINS) throw new JarvisError(`A task can have up to ${MAX_CHAINS} validation chains.`, 409);
    let graph: ChainGraph = { nodes: [], edges: [] };
    let fromName = "";
    if (typeof options.from === "string" && options.from) {
        const source = await getChain(options.from);
        if (!source) throw new JarvisError("That chain is gone.", 404);
        graph = JSON.parse(JSON.stringify(source.graph)) as ChainGraph;
        fromName = source.name;
    }
    const name = cleanText(options.name, 120) || fromName || chainName(task, existing.length);
    const chain = await saveChain({ name, graph, ownerTaskId: task.id }).catch((e) => {
        throw storeError(e);
    });
    newMeta(await db(), chain.id, task.id, { purpose: cleanText(options.purpose, MAX_PURPOSE) });
    await recordEvent("task.validation", `Validation chain "${chain.name}" added to ${describeTask(task)}`, { taskId: task.id, ref: { chainId: chain.id } });
    return chain;
}

/** Remove one of the task's chains (none of its runs may be going). Proposals to revise it become new chains. */
export async function removeChain(taskIdValue: unknown, chainIdValue: unknown): Promise<void> {
    const task = await requireTask(taskIdValue);
    const { chain } = await loadChain(task.id, chainIdValue, 0);
    if ((await liveRuns(chain.id)).length) throw new JarvisError(`Stop the runs of "${chain.name}" before removing it.`, 409);
    await deleteChain(chain.id).catch((e) => {
        throw storeError(e);
    });
    const d = await db();
    d.prepare("DELETE FROM jarvis_validation_chains WHERE chain_id = ?").run(chain.id);
    d.prepare("UPDATE jarvis_validation_proposals SET chain_id = NULL WHERE chain_id = ?").run(chain.id);
    await recordEvent("task.validation", `Validation chain "${chain.name}" removed from ${describeTask(task)}`, { taskId: task.id });
}

/** Copy a chain into the user's own chains. Blocks that follow a PR or the runner build the pipeline's default branch there. */
export async function saveAsReusable(taskIdValue: unknown, chainIdValue: unknown): Promise<ChainRow> {
    const task = await requireTask(taskIdValue);
    const { chain } = await loadChain(task.id, chainIdValue, 0);
    const graph: ChainGraph = {
        nodes: chain.graph.nodes.map(({ branchFrom, followRunner, ...n }) => (branchFrom || followRunner ? { ...n, branch: "" } : n)),
        edges: chain.graph.edges.map((e) => ({ ...e })),
    };
    const name = chain.name.startsWith(NAME_PREFIX) ? `${chain.name.slice(NAME_PREFIX.length)} validation` : `${chain.name} (copy)`;
    return saveChain({ name, graph }).catch((e) => {
        throw storeError(e);
    });
}

export interface ChainOptions {
    name?: unknown;
    purpose?: unknown;
    concurrency?: unknown;
    workersMayRun?: unknown;
    notifyWorker?: unknown;
    rerunOnCommit?: unknown;
}

export async function setChainOptions(taskIdValue: unknown, chainIdValue: unknown, options: ChainOptions): Promise<void> {
    const task = await requireTask(taskIdValue);
    const l = await loadChain(task.id, chainIdValue);
    const { chain } = l;
    if (options.concurrency !== undefined && !CONCURRENCY.has(options.concurrency as Concurrency)) {
        throw new JarvisError("Concurrency is auto, one or parallel.", 400);
    }
    const deploys = deployHint(chain.graph);
    if (options.workersMayRun === true && deploys) {
        throw new JarvisError(`Workers always ask before running "${chain.name}": "${deploys}" reads like a deployment.`, 400);
    }
    if (typeof options.name === "string") {
        const name = cleanText(options.name, 120);
        if (!name) throw new JarvisError("Give the chain a name.", 400);
        if (name !== chain.name) {
            await saveChain({ id: chain.id, name, graph: chain.graph, expectedUpdatedAt: chain.updatedAt }).catch((e) => {
                throw storeError(e);
            });
        }
    }
    // Turning reruns on watches for commits from now on; it doesn't run for the current ones.
    const commits = options.rerunOnCommit === true ? await watchedCommits(task.id, l) : null;
    await updateMeta(chain.id, (m) => {
        if (typeof options.purpose === "string") m.purpose = cleanText(options.purpose, MAX_PURPOSE);
        if (options.concurrency !== undefined) m.concurrency = options.concurrency as Concurrency;
        if (typeof options.workersMayRun === "boolean") m.workersMayRun = options.workersMayRun;
        if (typeof options.notifyWorker === "boolean") m.notifyWorker = options.notifyWorker;
        if (typeof options.rerunOnCommit === "boolean") {
            m.rerunOnCommit = options.rerunOnCommit;
            if (commits) m.commits = commits;
        }
    });
    if (options.concurrency !== undefined) void drainQueues(task.id).catch((e: Error) => console.warn(`[validation] drain: ${e.message}`));
}

/**
 * Set one block's repository branches from the task's card. `was` is the block's branches as
 * the user opened them (repoSignature): a block changed since is refused, and so is a chain
 * saved elsewhere while the check ran. Before anything is saved, the pipeline is compiled with
 * the new branches on the branch the block builds, and each Azure Repos branch is looked up;
 * what couldn't be checked comes back as warnings. Clearing every branch needs no check.
 */
export async function setBlockRepoBranches(
    taskIdValue: unknown,
    chainIdValue: unknown,
    nodeId: unknown,
    value: unknown,
    was?: unknown,
): Promise<{ chain: ChainRow; warnings: string[] }> {
    const task = await requireTask(taskIdValue);
    requireOpen(task);
    const { chain } = await loadChain(task.id, chainIdValue, 0);
    const node = chain.graph.nodes.find((n) => n.id === nodeId);
    if (!node) throw new JarvisError("That block isn't in the chain anymore.", 404);
    if (typeof was === "string" && was !== repoSignature(node.repoBranches)) {
        throw new JarvisError("The block's repository branches changed since you opened them. Open them again.", 409);
    }
    let repos: Record<string, string> | undefined;
    try {
        repos = repoBranchOverrides(value);
    } catch (e) {
        throw new JarvisError((e as Error).message, 400);
    }
    const warnings: string[] = [];
    if (repos) {
        const branch = await blockBranch(task.id, node);
        if (branch === null) {
            warnings.push(
                node.followRunner
                    ? `${node.name} builds the branch of whoever runs the chain, so these weren't checked. Each run checks them.`
                    : `The branch of PR ${node.branchFrom!.prId} isn't known yet, so these weren't checked. The run checks them.`,
            );
        } else {
            const check = await checkRepoBranches(vrt, node.org, node.project, node.definitionId, branch, node.params, repos);
            if (check.error) throw new JarvisError(check.error, 400);
            warnings.push(...check.warnings);
            // Keep the branches as typed, under the YAML's alias spelling: Azure DevOps reads aliases case-sensitively.
            const spelling = new Map(Object.keys(check.refs ?? {}).map((alias) => [alias.toLowerCase(), alias]));
            repos = Object.fromEntries(Object.entries(repos).map(([alias, b]) => [spelling.get(alias.toLowerCase()) ?? alias, b]));
        }
    }
    const { repoBranches: _replaced, ...rest } = node;
    const edited: ChainNode = repos ? { ...rest, repoBranches: repos } : rest;
    const cfg = await readConfig();
    let saved: ChainRow;
    try {
        const graph = validateGraph({ ...chain.graph, nodes: chain.graph.nodes.map((n) => (n.id === node.id ? edited : n)) }, cfg.organizations);
        saved = await saveChain({ id: chain.id, name: chain.name, graph, expectedUpdatedAt: chain.updatedAt });
    } catch (e) {
        throw storeError(e);
    }
    // A save during a run queued a "graph" command; apply it now, not on the next poll.
    wakePipelineRunner();
    const count = Object.keys(repos ?? {}).length;
    await recordEvent(
        "task.validation",
        `${count ? `${count === 1 ? "A repository branch" : `${count} repository branches`} set` : "Repository branches cleared"} on ${node.name} in "${chain.name}" for ${describeTask(task)}`,
        { taskId: task.id, ref: { chainId: chain.id } },
    );
    return { chain: saved, warnings };
}

/** The branch a block builds: its PR's source branch when it follows one, else its own ("" for the default); null when not known now. */
async function blockBranch(taskId: string, node: ChainNode): Promise<string | null> {
    if (node.followRunner) return null;
    if (!node.branchFrom) return normalizeBranch(node.branch);
    const want = `${node.branchFrom.org.toLowerCase()}/${node.branchFrom.prId}`;
    const pr = (await listTaskPrs(taskId, { includeHidden: true })).find((p) => `${p.org.toLowerCase()}/${p.prId}` === want);
    return pr?.snapshot?.sourceRef ? normalizeBranch(pr.snapshot.sourceRef) : null;
}

/**
 * The user has seen a failed run: it leaves Needs you. With no run named, every failed run
 * the task shows goes.
 */
export async function acknowledgeRun(taskIdValue: unknown, runIdValue?: unknown): Promise<void> {
    const task = await requireTask(taskIdValue);
    if (typeof runIdValue === "string") {
        const run = await getRun(runIdValue);
        if (!run || run.status !== "failed") return;
        const chain = await getChain(run.chainId);
        if (chain?.ownerTaskId !== task.id) return;
        await updateMeta(chain.id, (m) => {
            if (!m.acked.includes(run.runId)) m.acked = [...m.acked, run.runId].slice(-MAX_ACKED);
        });
        return;
    }
    for (const l of await loadChains(task.id)) {
        const failed = unseenFailures(l.meta, l.runs).map((r) => r.runId);
        if (failed.length) await updateMeta(l.chain.id, (m) => (m.acked = [...new Set([...m.acked, ...failed])].slice(-MAX_ACKED)));
    }
}

/**
 * Before a task is removed: stop its runs, delete its chains (one still stopping is left for
 * the sweep), forget the records, and say what they were for task.json.
 */
export async function retireValidation(taskId: string): Promise<Record<string, unknown> | null> {
    const loaded = await loadChains(taskId, 1);
    const records: Array<Record<string, unknown>> = [];
    for (const { chain, meta, runs } of loaded) {
        const run = runs[0];
        records.push({
            chain: chain.name,
            purpose: meta.purpose,
            pipelines: chain.graph.nodes.map((n) => ({ name: n.name, project: n.project, definitionId: n.definitionId })),
            lastRun: run ? { status: run.status, text: runText(run), by: run.trigger?.label ?? null, finishedAt: run.finishedAt } : null,
        });
        const live = await liveRuns(chain.id);
        if (live.length) {
            for (const r of live) await requestRunCancel(r.runId);
            wakePipelineRunner();
        } else {
            await deleteChain(chain.id).catch(() => undefined);
        }
    }
    const d = await db();
    d.prepare("DELETE FROM jarvis_validation_chains WHERE task_id = ?").run(taskId);
    d.prepare("DELETE FROM jarvis_validation_proposals WHERE task_id = ?").run(taskId);
    d.prepare("DELETE FROM jarvis_task_validation WHERE task_id = ?").run(taskId);
    return records.length ? { chains: records } : null;
}

/** Lines for the task's recap: its chains' recent runs, newest first. */
export async function validationHistory(taskId: string, limit = 12): Promise<string[]> {
    const loaded = await loadChains(taskId, limit);
    return loaded
        .flatMap(({ chain, runs }) => runs.map((run) => ({ at: run.createdAt, line: `${run.createdAt}: ${describeRun(chain.name, run)}${run.trigger ? ` (run by ${run.trigger.label})` : ""}` })))
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, limit)
        .map((x) => x.line);
}

// ---- proposals -------------------------------------------------------------------------------

/**
 * Store a checked proposal (see the agent module) for the user to review. A proposer's newer
 * proposal for the same chain (or the same new chain's name) replaces its older one.
 */
export async function storeProposal(taskId: string, proposal: Proposal): Promise<void> {
    const task = await requireTask(taskId);
    requireOpen(task);
    const loaded = await loadChains(task.id, 0);
    const revised = proposal.chainId ? loaded.find((l) => l.chain.id === proposal.chainId) : undefined;
    if (proposal.chainId && !revised) throw new JarvisError("That validation chain isn't on this task anymore.", 404);
    const name = revised?.chain.name ?? (cleanText(proposal.name, 120) || chainName(task, loaded.length));
    const stored: Proposal = { ...proposal, name, ...(proposal.purpose ? { purpose: cleanText(proposal.purpose, MAX_PURPOSE) } : {}) };
    const proposer = (p: Proposal) => p.sessionId ?? p.by;
    const same = (p: Proposal) =>
        proposer(p) === proposer(stored) && (stored.chainId ? p.chainId === stored.chainId : !p.chainId && (p.name ?? "").toLowerCase() === name.toLowerCase());
    const d = await ready(task.id);
    const existing = (d.prepare("SELECT * FROM jarvis_validation_proposals WHERE task_id = ? ORDER BY created_at, rowid").all(task.id) as Raw[])
        .map(toProposal)
        .filter((p): p is Proposal => !!p);
    const drop = existing.filter(same).map((p) => p.id);
    const kept = existing.filter((p) => !drop.includes(p.id));
    // The oldest go first when a task collects too many.
    const over = kept.slice(0, Math.max(0, kept.length + 1 - MAX_PROPOSALS)).map((p) => p.id);
    const del = d.prepare("DELETE FROM jarvis_validation_proposals WHERE proposal_id = ?");
    for (const id of [...drop, ...over]) del.run(id);
    d.prepare("INSERT INTO jarvis_validation_proposals (proposal_id, task_id, chain_id, proposal_json, created_at) VALUES (?, ?, ?, ?, ?)").run(
        stored.id,
        task.id,
        stored.chainId ?? null,
        JSON.stringify(stored),
        stored.at || now(),
    );
    await recordEvent(
        "task.validation",
        `${stored.by} proposed ${revised ? `a change to "${name}"` : `a validation chain "${name}"`} for ${describeTask(task)}: ${stored.blocks.map((b) => b.name).join(" → ")}`,
        { taskId: task.id, sessionId: stored.sessionId ?? undefined },
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
            branch: b.branchFrom || b.followRunner ? "" : b.branch,
            x: 40 + b.stage * 320,
            y: 40 + row * 140,
            ...(b.params && Object.keys(b.params).length ? { params: b.params } : {}),
            ...(b.repoBranches && Object.keys(b.repoBranches).length ? { repoBranches: b.repoBranches } : {}),
            ...(b.branchFrom ? { branchFrom: b.branchFrom } : {}),
            ...(b.followRunner ? { followRunner: true as const } : {}),
        };
    });
    const edges = proposal.blocks.flatMap((b) => b.after.filter((k) => ids.has(k)).map((k) => ({ from: ids.get(k)!, to: ids.get(b.key)! })));
    return { nodes, edges };
}

/** The proposal the user reviewed must still be there; its proposer may have replaced it since. */
async function findProposal(taskId: string, id: unknown): Promise<Proposal> {
    if (typeof id !== "string" || !id) throw new JarvisError("Say which proposal you reviewed.", 400);
    const p = (await listProposals(taskId)).find((x) => x.id === id);
    if (!p) throw new JarvisError("That proposal changed or is gone. Review the current ones.", 409);
    return p;
}

/**
 * Accept a proposal: it revises its chain (none of whose runs may be going) or becomes a new
 * one. With `run`, the chain runs right away as yours, building `target`'s code when it needs one.
 */
export async function acceptProposal(
    taskIdValue: unknown,
    options: { id?: unknown; run?: boolean; target?: unknown } = {},
): Promise<{ chain: ChainRow; runs?: RunOutcome[] }> {
    const task = await requireTask(taskIdValue);
    requireOpen(task);
    const proposal = await findProposal(task.id, options.id);
    const cfg = await readConfig();
    let graph: ChainGraph;
    try {
        graph = validateGraph(proposalGraph(proposal), cfg.organizations);
    } catch (e) {
        throw new JarvisError((e as Error).message, 400);
    }
    const evidence: Evidence = Object.fromEntries(proposal.blocks.map((b) => [b.key, { reason: b.reason, evidence: b.evidence, by: proposal.by }]));
    const loaded = await loadChains(task.id, 0);
    const revised = proposal.chainId ? loaded.find((l) => l.chain.id === proposal.chainId) : undefined;
    let chain: ChainRow;
    if (revised) {
        if ((await liveRuns(revised.chain.id)).length) throw new JarvisError(`Stop the runs of "${revised.chain.name}" before changing it.`, 409);
        chain = await saveChain({ id: revised.chain.id, name: revised.chain.name, graph }).catch((e) => {
            throw storeError(e);
        });
        await updateMeta(chain.id, (m) => {
            m.acceptedAt = now();
            m.acceptedBy = proposal.by;
            m.evidence = evidence;
            if (proposal.purpose) m.purpose = cleanText(proposal.purpose, MAX_PURPOSE);
        });
    } else {
        if (loaded.length >= MAX_CHAINS) throw new JarvisError(`A task can have up to ${MAX_CHAINS} validation chains. Remove one first.`, 409);
        const name = cleanText(proposal.name, 120) || chainName(task, loaded.length);
        chain = await saveChain({ name, graph, ownerTaskId: task.id }).catch((e) => {
            throw storeError(e);
        });
        newMeta(await db(), chain.id, task.id, {
            purpose: cleanText(proposal.purpose || proposal.summary, MAX_PURPOSE),
            acceptedBy: proposal.by,
            evidence,
        });
    }
    (await db()).prepare("DELETE FROM jarvis_validation_proposals WHERE proposal_id = ?").run(proposal.id);
    await recordEvent(
        "task.validation",
        `${revised ? `Change to "${chain.name}"` : `Validation chain "${chain.name}"`} accepted for ${describeTask(task)}: ${proposal.blocks.map((b) => b.name).join(" → ")}`,
        { taskId: task.id, ref: { chainId: chain.id } },
    );
    if (!options.run) return { chain };
    const target = await resolveTarget(task.id, options.target);
    return { chain, runs: await runChains(task.id, [chain.id], { trigger: YOU, target }) };
}

/** Turn a proposal down; the proposer hears why. */
export async function dismissProposal(taskIdValue: unknown, reasonValue: unknown, id?: unknown): Promise<void> {
    const task = await requireTask(taskIdValue);
    const proposal = await findProposal(task.id, id);
    const reason = typeof reasonValue === "string" ? reasonValue.trim().slice(0, 1000) : "";
    (await db()).prepare("DELETE FROM jarvis_validation_proposals WHERE proposal_id = ?").run(proposal.id);
    const what = proposal.chainId ? `change to the validation chain "${proposal.name}"` : `validation chain "${proposal.name}"`;
    await recordEvent("task.validation", `Proposed ${what} dismissed for ${describeTask(task)}${reason ? `: ${reason}` : ""}`, { taskId: task.id });
    await deliverNotice(
        task.id,
        `The user dismissed your proposed ${what} for this task${reason ? `, saying: "${reason}"` : " without a reason"}. ` +
            "Don't propose it again unless they ask, or the reason tells you what to change.",
        proposal.sessionId,
    );
}

/** Ask the task's worker to find and propose validation. */
export async function askForProposal(taskIdValue: unknown): Promise<string> {
    const task = await requireTask(taskIdValue);
    const workers = await listWorkers(task.id);
    if (!workers.length) throw new JarvisError("Start a worker on this task first; it finds the pipelines.", 409);
    const loaded = await loadChains(task.id, 0);
    const have = loaded.length
        ? `\n\nThe task already has these chains; propose a change to one (pass its chainId) or a new chain for something they don't cover:\n${loaded
              .map((l) => `- ${l.chain.id}: "${l.chain.name}"${l.meta.purpose ? `, ${l.meta.purpose}` : ""}`)
              .join("\n")}`
        : "";
    return deliverNotice(task.id, PROPOSE_ASK + have);
}

const PROPOSE_ASK =
    "Find the pipelines that validate this task's change and propose a validation chain. Use the task_validation tool: " +
    "action candidates lists what the app found (PR checks, pipelines that use those builds, past chains), then action propose " +
    "sends your picks with a reason for each, a name, and a purpose that says when to use the chain. Read the repo's pipeline YAML " +
    "and docs if candidates aren't enough. Leave out anything that deploys to production, and say what you left out and why.";

// ---- notices to the task's workers ---------------------------------------------------------------

const newestFirst = (workers: JarvisWorker[]) => [...workers].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

/**
 * Tell a worker something (a failed run, a dismissed proposal). It goes to the given session
 * when that's one of the task's workers, else the most recently active one. A busy worker gets
 * it when its turn ends; one meant for a particular worker waits for that worker.
 */
export async function deliverNotice(taskId: string, text: string, preferSession?: string | null): Promise<string> {
    // A done task's workers take no new turns; a notice parked now would fire whenever it's reopened.
    if ((await getTask(taskId))?.status !== "open") return "The task isn't open, so its workers weren't told.";
    const workers = await listWorkers(taskId);
    if (!workers.length) return "No worker to tell.";
    const target = workers.find((w) => w.sessionId === preferSession) ?? newestFirst(workers)[0];
    if (!(await vrt.workerBusy(target.sessionId))) {
        try {
            await vrt.messageWorker(target.sessionId, text);
            return `Told ${target.label}.`;
        } catch {
            /* busy after all: keep it for later */
        }
    }
    const addressed = !!preferSession && target.sessionId === preferSession;
    await updateTaskRow(taskId, (r) => r.notices.push({ to: addressed ? target.sessionId : null, text }));
    return `${target.label} is busy; it hears this when its turn ends.`;
}

async function flushNotices(): Promise<void> {
    const rows = (await db()).prepare("SELECT task_id FROM jarvis_task_validation WHERE pending_notice IS NOT NULL").all() as Raw[];
    for (const r of rows) {
        const taskId = String(r.task_id);
        const row = await readTaskRow(taskId);
        if (!row.notices.length) continue;
        const workers = await listWorkers(taskId);
        if (!workers.length || (await getTask(taskId))?.status !== "open") {
            await updateTaskRow(taskId, (x) => (x.notices = []));
            continue;
        }
        const idle = new Map<string, boolean>();
        const isIdle = async (sessionId: string) => {
            if (!idle.has(sessionId)) idle.set(sessionId, !(await vrt.workerBusy(sessionId)));
            return idle.get(sessionId)!;
        };
        const batches = new Map<string, Notice[]>();
        for (const n of row.notices) {
            let to = n.to && workers.some((w) => w.sessionId === n.to) ? n.to : null;
            if (!to) {
                for (const w of newestFirst(workers)) {
                    if (await isIdle(w.sessionId)) {
                        to = w.sessionId;
                        break;
                    }
                }
            }
            if (!to || !(await isIdle(to))) continue;
            batches.set(to, [...(batches.get(to) ?? []), n]);
        }
        for (const [to, sent] of batches) {
            try {
                await vrt.messageWorker(to, sent.map((n) => n.text).join("\n\n"));
            } catch {
                continue; // try again next tick
            }
            // A notice that came in while these were on their way stays for the next tick.
            await updateTaskRow(taskId, (x) => {
                const left = [...x.notices];
                for (const n of sent) {
                    const i = left.findIndex((y) => y.text === n.text && y.to === n.to);
                    if (i >= 0) left.splice(i, 1);
                }
                x.notices = left;
            });
        }
    }
}

// ---- reacting to runs ------------------------------------------------------------------------------

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

const whoRan = (trigger: RunTrigger) => (trigger.kind === "you" ? "the user" : trigger.label);

export async function onRunEvent(event: PipelineEvent): Promise<void> {
    const chain = await getChain(event.chainId);
    if (!chain?.ownerTaskId) return;
    const task = await getTask(chain.ownerTaskId);
    if (!task) return;
    const run = await getRun(event.runId);
    if (!run) return;
    const d = await ready(task.id);
    const raw = d.prepare("SELECT * FROM jarvis_validation_chains WHERE chain_id = ?").get(chain.id) as Raw | undefined;
    const meta = raw ? toMeta(raw) : null;
    const whose = run.target ? ` for ${run.target.label}` : "";
    const links = { taskId: task.id, sessionId: run.trigger?.sessionId, ref: { chainId: chain.id, runId: run.runId } };
    if (event.type === "runStarted") {
        await recordEvent("task.validation", `${run.trigger ? `${run.trigger.label} started` : "Started"} "${chain.name}"${whose} (${describeTask(task)})`, links);
        // Whatever started it, this run builds the watched PRs' current commits: don't rerun for them.
        if (meta?.rerunOnCommit) {
            const seen = await watched(task.id, { chain, runs: [run] }, run.target);
            if (seen.length) await updateMeta(chain.id, (m) => seen.forEach((w) => (m.commits[w.key] = w.sha)));
        }
        return;
    }
    const text = describeRun(chain.name, run);
    await recordEvent("task.validation", `${text} (${describeTask(task)})`, links);
    await postStatus({ taskId: task.id, text: text.slice(0, 160), author: "Validation" }).catch(() => undefined);
    if (run.status === "failed" && (meta?.notifyWorker ?? true)) {
        const report = await failureReport(run);
        const again =
            meta && mayRunUnasked(meta, chain.graph)
                ? "You can run it again (task_validation action run) once you've fixed it."
                : "Running it again (task_validation action run) asks the user first.";
        await deliverNotice(
            task.id,
            `Validation chain "${chain.name}" (chainId ${chain.id}) failed${whose}${run.trigger ? `, run by ${whoRan(run.trigger)}` : ""}: ${runText(run)}.\n${report}\n\n` +
                `Find out why from the build logs (the Azure DevOps MCP tools can read them), fix it if the change caused it, and say what you found. ${again}`,
            run.trigger?.sessionId ?? run.target?.sessionId ?? null,
        );
    }
    await drainQueues(task.id).catch((e: Error) => console.warn(`[validation] drain: ${e.message}`));
}

/** Runs of a task's chains stop when the task is done: reopening it runs them again. */
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

interface Watched {
    key: string;
    sha: string;
    target: RunTarget | null;
}

/**
 * The PR commits a chain's runs build: PRs its blocks follow, and for a chain that builds its
 * runner's code, the PR each recent runner's branch is in. Keyed per PR and runner, so a new
 * commit reruns for that runner only. `only` limits it to one run's target.
 */
async function watched(taskId: string, l: Pick<Loaded, "chain" | "runs">, only?: RunTarget | null): Promise<Watched[]> {
    const prs = (await listTaskPrs(taskId, { includeHidden: true })).filter((p) => p.snapshot?.sourceCommit);
    const find = (org: string, prId: number) => prs.find((p) => p.org.toLowerCase() === org.toLowerCase() && p.prId === prId);
    const follows = followsRunner(l.chain.graph);
    const targets: Array<RunTarget | null> =
        only !== undefined ? [only] : follows ? latestPerRunner(l.runs).flatMap((x) => (x.run.target ? [x.run.target] : [])) : [null];
    const out = new Map<string, Watched>();
    const add = (pr: TaskPr, target: RunTarget | null) => {
        const key = `${pr.org.toLowerCase()}/${pr.prId}${target ? `#${runnerKey(target) ?? target.label}` : ""}`;
        out.set(key, { key, sha: pr.snapshot!.sourceCommit!, target });
    };
    for (const target of targets) {
        for (const n of l.chain.graph.nodes) {
            const pr = n.branchFrom ? find(n.branchFrom.org, n.branchFrom.prId) : undefined;
            if (pr) add(pr, target);
        }
        if (!follows || !target) continue;
        if (target.pr) {
            const pr = find(target.pr.org, target.pr.prId);
            if (pr) add(pr, target);
            continue;
        }
        for (const b of target.branches) {
            const pr = prs.find(
                (p) =>
                    p.snapshot!.status === "active" &&
                    p.org.toLowerCase() === b.org.toLowerCase() &&
                    p.snapshot!.repo.toLowerCase() === b.repo.toLowerCase() &&
                    normalizeBranch(p.snapshot!.sourceRef) === normalizeBranch(b.branch),
            );
            if (pr) add(pr, target);
        }
    }
    return [...out.values()];
}

async function watchedCommits(taskId: string, l: Loaded): Promise<Record<string, string>> {
    return Object.fromEntries((await watched(taskId, l)).map((w) => [w.key, w.sha]));
}

async function autoTick(): Promise<void> {
    const auto = await autoProposeOn();
    for (const task of await listTasks()) {
        if (task.status !== "open") continue;
        const loaded = await loadChains(task.id);
        // Ask a worker once, when the task has a PR and no validation yet.
        if (auto && !loaded.length && !(await readTaskRow(task.id)).autoAskedAt && !(await listProposals(task.id)).length) {
            const prs = await listTaskPrs(task.id);
            const workers = prs.length ? await listWorkers(task.id) : [];
            if (prs.length && workers.length) {
                await updateTaskRow(task.id, (r) => (r.autoAskedAt = now()));
                await deliverNotice(task.id, `A pull request is linked to this task. ${PROPOSE_ASK}`);
            }
        }
        // Run again when a watched PR has a new commit, if the user allowed it, once per runner.
        for (const l of loaded) {
            if (!l.meta.rerunOnCommit) continue;
            const seen = await watched(task.id, l);
            const changed = seen.filter((w) => l.meta.commits[w.key] && l.meta.commits[w.key] !== w.sha);
            const fresh = seen.filter((w) => !l.meta.commits[w.key]);
            if (!changed.length) {
                if (fresh.length) await updateMeta(l.chain.id, (m) => fresh.forEach((w) => (m.commits[w.key] ??= w.sha)));
                continue;
            }
            if (l.runs.some((r) => r.status === "running") || l.meta.queue.length) continue;
            await updateMeta(l.chain.id, (m) => seen.forEach((w) => (m.commits[w.key] = w.sha)));
            const targets = new Map<string, { target: RunTarget | null; sha: string }>();
            for (const w of changed) targets.set(w.target ? (runnerKey(w.target) ?? w.target.label) : "", { target: w.target, sha: w.sha });
            for (const { target, sha } of targets.values()) {
                // A worker's branches may have moved on since its last run.
                const current = target?.sessionId
                    ? { ...target, branches: await vrt.workerBranches(target.sessionId, task.id).catch(() => target.branches) }
                    : target;
                try {
                    await runChains(task.id, [l.chain.id], { trigger: AUTO, target: current });
                    await recordEvent(
                        "task.validation",
                        `"${l.chain.name}" asked to run${current ? ` for ${current.label}` : ""} for new commit ${sha.slice(0, 7)} (${describeTask(task)})`,
                        { taskId: task.id, ref: { chainId: l.chain.id } },
                    );
                } catch (error) {
                    console.warn(`[validation] rerun of ${l.chain.id} not started: ${(error as Error).message}`);
                }
            }
        }
    }
}

/** Chains whose task is gone: stop their runs, then delete them once stopped. */
async function sweepOrphans(): Promise<void> {
    for (const chain of await orphanedTaskChains()) {
        const live = await liveRuns(chain.id);
        if (live.length) {
            const stop = live.filter((r) => !r.cancelRequested);
            for (const r of stop) await requestRunCancel(r.runId);
            if (stop.length) wakePipelineRunner();
            continue;
        }
        await deleteChain(chain.id).catch(() => undefined);
    }
}

/** Start what's waiting in every task's queues, in case a finish was missed. */
async function drainAll(): Promise<void> {
    const rows = (await db())
        .prepare("SELECT DISTINCT task_id FROM jarvis_validation_chains WHERE queue_json IS NOT NULL AND queue_json <> '[]'")
        .all() as Raw[];
    for (const r of rows) await drainQueues(String(r.task_id));
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
        await drainAll().catch((e: Error) => console.warn(`[validation] drain: ${e.message}`));
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

export { blockKey, mayRunUnasked as chainMayRunUnasked, YOU as YOU_TRIGGER };
