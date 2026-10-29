// Persistence for pipeline chains (the saved canvas graph) and their runs.
// Each run snapshots the graph; edits saved while it runs reach it as "graph" commands.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ensureDb } from "./store.mjs";
import { emitPipelineEvent } from "./pipeline-events.mjs";
import {
    appBuildsFromRuns,
    blockResultsFromRuns,
    initialNodeStates,
    retainedRunIds,
    type AppBuild,
    type BlockResult,
    type ChainGraph,
    type NodeStates,
    type RunCommandKind,
} from "./pipeline-graph.mjs";

const ACTIVE_STATUS = new Set(["queuing", "queued", "running"]);

export class PipelineStoreError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

export type RunStatus = "running" | "succeeded" | "failed" | "canceled";

export interface ChainRow {
    id: string;
    name: string;
    graph: ChainGraph;
    createdAt: string;
    updatedAt: string;
    /** Set for a Jarvis task's validation chain, which goes with its task. */
    ownerTaskId: string | null;
}

export interface ChainSummary {
    id: string;
    name: string;
    nodeCount: number;
    updatedAt: string;
    lastRun: { runId: string; status: RunStatus; createdAt: string; finishedAt: string | null } | null;
    /** The Jarvis task that owns the chain, when one does. */
    owner: { taskId: string; title: string; status: string } | null;
}

export interface RunRow {
    runId: string;
    chainId: string;
    status: RunStatus;
    graph: ChainGraph;
    states: NodeStates;
    cancelRequested: boolean;
    error: string | null;
    createdAt: string;
    updatedAt: string;
    finishedAt: string | null;
}

export interface PendingCommand {
    id: number;
    kind: RunCommandKind;
    nodeId: string;
    /** The edited chain graph, for "graph" commands. */
    graph?: ChainGraph;
}

export type CommandStatus = "pending" | "done" | "rejected";

const MAX_RUNS_PER_CHAIN = 20;
const MAX_NAME = 120;
const COMMAND_RESULT_TTL_MS = 10 * 60_000;

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();
// Run/stop commands from an earlier app session are dropped on start (see clearStaleCommands).
const PROCESS_STARTED = now();

function toChain(row: Row): ChainRow {
    return {
        id: String(row.id),
        name: String(row.name),
        graph: JSON.parse(String(row.graph_json)) as ChainGraph,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        ownerTaskId: (row.owner_task_id as string | null) ?? null,
    };
}

function toRun(row: Row): RunRow {
    return {
        runId: String(row.run_id),
        chainId: String(row.chain_id),
        status: row.status as RunStatus,
        graph: JSON.parse(String(row.graph_json)) as ChainGraph,
        states: JSON.parse(String(row.state_json)) as NodeStates,
        cancelRequested: Number(row.cancel_requested) === 1,
        error: (row.error as string | null) ?? null,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        finishedAt: (row.finished_at as string | null) ?? null,
    };
}

function cleanName(name: unknown): string {
    const value = typeof name === "string" ? name.trim().slice(0, MAX_NAME) : "";
    return value || "Untitled chain";
}

function inTransaction<T>(db: DatabaseSync, work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
        const result = work();
        db.exec("COMMIT");
        return result;
    } catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
}

/** Jarvis keeps its tasks in this database once it has run; until then no chain has an owner to name. */
function hasTaskTable(db: DatabaseSync): boolean {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'jarvis_tasks'").get();
}

export async function listChains(): Promise<ChainSummary[]> {
    const db = await ensureDb();
    const owners = hasTaskTable(db);
    const rows = db
        .prepare(
            `SELECT c.id, c.name, c.graph_json, c.updated_at, c.owner_task_id,
                    ${owners ? "t.title AS owner_title, t.status AS owner_status," : "NULL AS owner_title, NULL AS owner_status,"}
                    r.run_id, r.status AS run_status, r.created_at AS run_created, r.finished_at AS run_finished
             FROM pipeline_chains c
             ${owners ? "LEFT JOIN jarvis_tasks t ON t.id = c.owner_task_id" : ""}
             LEFT JOIN pipeline_runs r ON r.run_id = (
                 SELECT run_id FROM pipeline_runs WHERE chain_id = c.id
                 ORDER BY created_at DESC, rowid DESC LIMIT 1
             )
             ORDER BY c.name COLLATE NOCASE, c.created_at`,
        )
        .all() as Row[];
    return rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        nodeCount: (JSON.parse(String(row.graph_json)) as ChainGraph).nodes.length,
        updatedAt: String(row.updated_at),
        lastRun: row.run_id
            ? {
                  runId: String(row.run_id),
                  status: row.run_status as RunStatus,
                  createdAt: String(row.run_created),
                  finishedAt: (row.run_finished as string | null) ?? null,
              }
            : null,
        owner: row.owner_task_id
            ? {
                  taskId: String(row.owner_task_id),
                  title: String(row.owner_title ?? "A removed task"),
                  status: String(row.owner_status ?? "removed"),
              }
            : null,
    }));
}

/** The chains a task owns (normally one). */
export async function chainsOwnedBy(taskId: string): Promise<ChainRow[]> {
    const db = await ensureDb();
    return (db.prepare("SELECT * FROM pipeline_chains WHERE owner_task_id = ? ORDER BY created_at").all(taskId) as Row[]).map(toChain);
}

/** Owned chains whose task is gone: what a removal left behind (it was running, or the app stopped). */
export async function orphanedTaskChains(): Promise<ChainRow[]> {
    const db = await ensureDb();
    if (!hasTaskTable(db)) return [];
    return (
        db
            .prepare(
                "SELECT c.* FROM pipeline_chains c WHERE c.owner_task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jarvis_tasks t WHERE t.id = c.owner_task_id)",
            )
            .all() as Row[]
    ).map(toChain);
}

/** Checks that can refuse a new run, like a Jarvis task that's done. Each returns why, or null. */
type RunGuard = (chain: ChainRow) => string | null | Promise<string | null>;
const runGuards = new Set<RunGuard>();

export function registerRunGuard(guard: RunGuard): () => void {
    runGuards.add(guard);
    return () => runGuards.delete(guard);
}

async function checkRunGuards(chain: ChainRow): Promise<void> {
    for (const guard of runGuards) {
        const reason = await guard(chain);
        if (reason) throw new PipelineStoreError(reason, 409);
    }
}

export async function getChain(id: string): Promise<ChainRow | null> {
    const db = await ensureDb();
    const row = db.prepare("SELECT * FROM pipeline_chains WHERE id = ?").get(id) as Row | undefined;
    return row ? toChain(row) : null;
}

// The graph must already be validated (see validateGraph). While the chain runs, the
// edit also goes to the runner as a "graph" command in the same transaction, so the
// runner sees edits in order and never schedules from a graph that is out of date.
// `ownerTaskId` only applies to a new chain: a chain's owner never changes. With
// `expectedUpdatedAt`, an update made on an older version is refused (it was changed elsewhere).
export async function saveChain(input: { id?: string; name: unknown; graph: ChainGraph; ownerTaskId?: string; expectedUpdatedAt?: string }): Promise<ChainRow> {
    const db = await ensureDb();
    const name = cleanName(input.name);
    const graphJson = JSON.stringify(input.graph);
    const at = now();
    if (input.id) {
        const id = input.id;
        inTransaction(db, () => {
            if (input.expectedUpdatedAt) {
                const current = db.prepare("SELECT updated_at FROM pipeline_chains WHERE id = ?").get(id) as Row | undefined;
                if (current && String(current.updated_at) !== input.expectedUpdatedAt) {
                    throw new PipelineStoreError("This chain was changed elsewhere since it was opened. Reload it.", 409);
                }
            }
            const live = db
                .prepare("SELECT * FROM pipeline_runs WHERE chain_id = ? AND status = 'running'")
                .get(id) as Row | undefined;
            if (live) {
                const run = toRun(live);
                // An active block must keep its pipeline: the runner polls its build there.
                const kept = new Map(input.graph.nodes.map((n) => [n.id, n]));
                const building = Object.entries(run.states).find(([nodeId, s]) => {
                    if (!ACTIVE_STATUS.has(s.status)) return false;
                    const edited = kept.get(nodeId);
                    const was = run.graph.nodes.find((n) => n.id === nodeId);
                    return (
                        !edited ||
                        !was ||
                        edited.org !== was.org ||
                        edited.project !== was.project ||
                        edited.definitionId !== was.definitionId
                    );
                });
                if (building) {
                    const label = run.graph.nodes.find((n) => n.id === building[0])?.name ?? building[0];
                    throw new PipelineStoreError(`Stop "${label}" before removing it. It is running in Azure DevOps.`, 409);
                }
            }
            const result = db
                .prepare("UPDATE pipeline_chains SET name = ?, graph_json = ?, updated_at = ? WHERE id = ?")
                .run(name, graphJson, at, id);
            if (Number(result.changes) === 0) throw new PipelineStoreError("Chain not found", 404);
            if (live) insertCommand(db, String(live.run_id), "graph", "", graphJson);
        });
        return (await getChain(id))!;
    }
    const id = randomUUID();
    db.prepare(
        "INSERT INTO pipeline_chains (id, name, graph_json, created_at, updated_at, owner_task_id) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, name, graphJson, at, at, input.ownerTaskId ?? null);
    return (await getChain(id))!;
}

export async function deleteChain(id: string): Promise<boolean> {
    const db = await ensureDb();
    return inTransaction(db, () => {
        const active = db.prepare("SELECT 1 FROM pipeline_runs WHERE chain_id = ? AND status = 'running'").get(id);
        if (active) throw new PipelineStoreError("Cancel the running chain before deleting it", 409);
        db.prepare(
            "DELETE FROM pipeline_run_commands WHERE run_id IN (SELECT run_id FROM pipeline_runs WHERE chain_id = ?)",
        ).run(id);
        db.prepare("DELETE FROM pipeline_runs WHERE chain_id = ?").run(id);
        return Number(db.prepare("DELETE FROM pipeline_chains WHERE id = ?").run(id).changes) > 0;
    });
}

function snapshot(row: Row) {
    return {
        runId: String(row.run_id),
        graph: JSON.parse(String(row.graph_json)) as ChainGraph,
        states: JSON.parse(String(row.state_json)) as NodeStates,
    };
}

// Keeps the newest finished runs, plus older ones holding a block's last result or build
// (see retainedRunIds), so a block's history survives other blocks being run many times.
function pruneRuns(db: DatabaseSync, chainId: string, graph: ChainGraph): void {
    const rows = db
        .prepare(
            `SELECT run_id, graph_json, state_json FROM pipeline_runs
             WHERE chain_id = ? AND status <> 'running' ORDER BY created_at DESC, rowid DESC`,
        )
        .all(chainId) as Row[];
    if (rows.length < MAX_RUNS_PER_CHAIN) return;
    const keep = retainedRunIds(rows.map(snapshot), graph, MAX_RUNS_PER_CHAIN - 1);
    const drop = db.prepare("DELETE FROM pipeline_runs WHERE run_id = ? AND status <> 'running'");
    for (const row of rows) if (!keep.has(String(row.run_id))) drop.run(String(row.run_id));
}

// Caller holds a transaction and has checked that the chain has no live run.
function insertRun(db: DatabaseSync, chainId: string, runId: string, graph: ChainGraph, states: NodeStates): void {
    pruneRuns(db, chainId, graph);
    const at = now();
    db.prepare(
        `INSERT INTO pipeline_runs (run_id, chain_id, status, graph_json, state_json, created_at, updated_at)
         VALUES (?, ?, 'running', ?, ?, ?, ?)`,
    ).run(runId, chainId, JSON.stringify(graph), JSON.stringify(states), at, at);
}

function insertCommand(db: DatabaseSync, runId: string, kind: RunCommandKind, nodeId: string, payload?: string): number {
    const result = db
        .prepare("INSERT INTO pipeline_run_commands (run_id, kind, node_id, payload, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(runId, kind, nodeId, payload ?? null, now());
    return Number(result.lastInsertRowid);
}

export async function startChainRun(chainId: string): Promise<RunRow> {
    const chain = await getChain(chainId);
    if (!chain) throw new PipelineStoreError("Chain not found", 404);
    if (!chain.graph.nodes.length) throw new PipelineStoreError("Add at least one pipeline before running", 400);
    await checkRunGuards(chain);
    const db = await ensureDb();
    const runId = randomUUID();
    inTransaction(db, () => {
        const active = db
            .prepare("SELECT 1 FROM pipeline_runs WHERE chain_id = ? AND status = 'running'")
            .get(chainId);
        if (active) throw new PipelineStoreError("This chain is already running", 409);
        insertRun(db, chainId, runId, chain.graph, initialNodeStates(chain.graph));
    });
    emitPipelineEvent({ type: "runStarted", chainId, runId });
    return (await getRun(runId))!;
}

// Runs one block and everything after it. With no live run this starts a new
// run scoped to those blocks; otherwise it asks the runner to add them to the
// live run (commandId), so the runner stays the only writer of run state.
export async function triggerNode(chainId: string, nodeId: string): Promise<{ run: RunRow; commandId: number | null }> {
    const db = await ensureDb();
    const chainNow = await getChain(chainId);
    const idle = !db.prepare("SELECT 1 FROM pipeline_runs WHERE chain_id = ? AND status = 'running'").get(chainId);
    if (chainNow && idle) await checkRunGuards(chainNow);
    const { runId, commandId } = inTransaction(db, () => {
        const live = db
            .prepare("SELECT * FROM pipeline_runs WHERE chain_id = ? AND status = 'running'")
            .get(chainId) as Row | undefined;
        if (live) {
            const run = toRun(live);
            if (run.cancelRequested) {
                throw new PipelineStoreError("This chain is stopping. Wait for it to finish, then run the block again.", 409);
            }
            // The chain graph is the newest: blocks added during the run reach the
            // runner's graph through a "graph" command queued ahead of this one.
            const chain = db.prepare("SELECT graph_json FROM pipeline_chains WHERE id = ?").get(chainId) as Row | undefined;
            const latest = chain ? (JSON.parse(String(chain.graph_json)) as ChainGraph) : run.graph;
            if (!latest.nodes.some((n) => n.id === nodeId)) {
                throw new PipelineStoreError("That block is not part of this chain. Save the chain, then try again.", 404);
            }
            return { runId: run.runId, commandId: insertCommand(db, run.runId, "trigger", nodeId) };
        }
        const row = db.prepare("SELECT * FROM pipeline_chains WHERE id = ?").get(chainId) as Row | undefined;
        if (!row) throw new PipelineStoreError("Chain not found", 404);
        const chain = toChain(row);
        if (!chain.graph.nodes.some((n) => n.id === nodeId)) {
            throw new PipelineStoreError("That block is not part of this chain. Save the chain, then try again.", 404);
        }
        const newRunId = randomUUID();
        insertRun(db, chainId, newRunId, chain.graph, initialNodeStates(chain.graph, nodeId));
        return { runId: newRunId, commandId: null };
    });
    if (commandId === null) emitPipelineEvent({ type: "runStarted", chainId, runId });
    return { run: (await getRun(runId))!, commandId };
}

export async function enqueueRunCommand(runId: string, kind: RunCommandKind, nodeId: string): Promise<number> {
    const db = await ensureDb();
    return inTransaction(db, () => {
        const row = db.prepare("SELECT * FROM pipeline_runs WHERE run_id = ?").get(runId) as Row | undefined;
        if (!row) throw new PipelineStoreError("Run not found", 404);
        const run = toRun(row);
        if (run.status !== "running") throw new PipelineStoreError("This run has already finished", 409);
        if (!run.graph.nodes.some((n) => n.id === nodeId)) throw new PipelineStoreError("Pipeline block not found", 404);
        return insertCommand(db, runId, kind, nodeId);
    });
}

export async function pendingCommands(runId: string): Promise<PendingCommand[]> {
    const db = await ensureDb();
    const rows = db
        .prepare(
            "SELECT id, kind, node_id, payload FROM pipeline_run_commands WHERE run_id = ? AND status = 'pending' ORDER BY id",
        )
        .all(runId) as Row[];
    return rows.map((row) => ({
        id: Number(row.id),
        kind: row.kind as RunCommandKind,
        nodeId: String(row.node_id),
        ...(row.kind === "graph" && row.payload ? { graph: JSON.parse(String(row.payload)) as ChainGraph } : {}),
    }));
}

/** Saves the states (and edited graph) the commands produced and resolves the commands, atomically. */
export async function commitCommands(
    runId: string,
    states: NodeStates,
    resolutions: Array<{ id: number; error: string | null }>,
    graph?: ChainGraph,
): Promise<void> {
    const db = await ensureDb();
    inTransaction(db, () => {
        if (graph) {
            db.prepare("UPDATE pipeline_runs SET state_json = ?, graph_json = ?, updated_at = ? WHERE run_id = ?").run(
                JSON.stringify(states),
                JSON.stringify(graph),
                now(),
                runId,
            );
        } else {
            db.prepare("UPDATE pipeline_runs SET state_json = ?, updated_at = ? WHERE run_id = ?").run(
                JSON.stringify(states),
                now(),
                runId,
            );
        }
        const mark = db.prepare("UPDATE pipeline_run_commands SET status = ?, error = ? WHERE id = ? AND status = 'pending'");
        for (const r of resolutions) mark.run(r.error ? "rejected" : "done", r.error, r.id);
    });
}

/**
 * Saves states only while no command is waiting. The runner calls this before it acts
 * on a schedule (queuing a block), so it never acts on a graph or state a newer edit or
 * request has already changed; false means "apply the commands first".
 */
export async function updateRunIfNoCommands(runId: string, states: NodeStates): Promise<boolean> {
    const db = await ensureDb();
    const result = db
        .prepare(
            `UPDATE pipeline_runs SET state_json = ?, updated_at = ?
             WHERE run_id = ? AND status = 'running'
               AND NOT EXISTS (SELECT 1 FROM pipeline_run_commands WHERE run_id = ? AND status = 'pending')`,
        )
        .run(JSON.stringify(states), now(), runId, runId);
    return Number(result.changes) > 0;
}

/** A command's result; a resolved result is deleted as it is read. */
export async function takeCommandResult(id: number): Promise<{ status: CommandStatus; error: string | null } | null> {
    const db = await ensureDb();
    const row = db.prepare("SELECT status, error FROM pipeline_run_commands WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    const status = row.status as CommandStatus;
    if (status !== "pending") db.prepare("DELETE FROM pipeline_run_commands WHERE id = ?").run(id);
    return { status, error: (row.error as string | null) ?? null };
}

/** Finishes a run unless a command arrived since the runner last looked; false keeps it open. */
export async function finishRun(runId: string, states: NodeStates, status: RunStatus, finishedAt: string): Promise<boolean> {
    const db = await ensureDb();
    const result = db
        .prepare(
            `UPDATE pipeline_runs SET state_json = ?, status = ?, finished_at = ?, updated_at = ?
             WHERE run_id = ? AND status = 'running'
               AND NOT EXISTS (SELECT 1 FROM pipeline_run_commands WHERE run_id = ? AND status = 'pending')`,
        )
        .run(JSON.stringify(states), status, finishedAt, now(), runId, runId);
    return Number(result.changes) > 0;
}

/** Drops results nobody read and commands whose run was pruned. */
export async function pruneCommands(): Promise<void> {
    const db = await ensureDb();
    const cutoff = new Date(Date.now() - COMMAND_RESULT_TTL_MS).toISOString();
    db.prepare("DELETE FROM pipeline_run_commands WHERE status <> 'pending' AND created_at < ?").run(cutoff);
    db.prepare("DELETE FROM pipeline_run_commands WHERE run_id NOT IN (SELECT run_id FROM pipeline_runs)").run();
}

// Run/stop requests from an earlier session are dropped; nobody is waiting for them.
// Pending edits are kept: they are whole graphs, safe to apply late.
export async function clearStaleCommands(): Promise<void> {
    const db = await ensureDb();
    db.prepare("DELETE FROM pipeline_run_commands WHERE created_at < ? AND NOT (kind = 'graph' AND status = 'pending')").run(
        PROCESS_STARTED,
    );
}

export async function getRun(runId: string): Promise<RunRow | null> {
    const db = await ensureDb();
    const row = db.prepare("SELECT * FROM pipeline_runs WHERE run_id = ?").get(runId) as Row | undefined;
    return row ? toRun(row) : null;
}

export async function latestRun(chainId: string): Promise<RunRow | null> {
    const db = await ensureDb();
    const row = db
        .prepare("SELECT * FROM pipeline_runs WHERE chain_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get(chainId) as Row | undefined;
    return row ? toRun(row) : null;
}

/** The newest build each block of the chain passed with (per pipeline and branch), across its kept runs. */
export async function appBuilds(chainId: string): Promise<AppBuild[]> {
    const db = await ensureDb();
    const rows = db
        .prepare("SELECT run_id, graph_json, state_json FROM pipeline_runs WHERE chain_id = ? ORDER BY created_at DESC, rowid DESC")
        .all(chainId) as Row[];
    return appBuildsFromRuns(rows.map(snapshot));
}

/** What each block of the chain last did in any of its kept runs, one entry per block and pipeline. */
export async function blockResults(chainId: string): Promise<BlockResult[]> {
    const db = await ensureDb();
    const rows = db
        .prepare("SELECT run_id, graph_json, state_json FROM pipeline_runs WHERE chain_id = ? ORDER BY created_at DESC, rowid DESC")
        .all(chainId) as Row[];
    return blockResultsFromRuns(rows.map(snapshot));
}

export async function activeRuns(): Promise<RunRow[]> {
    const db = await ensureDb();
    const rows = db
        .prepare("SELECT * FROM pipeline_runs WHERE status = 'running' ORDER BY created_at, rowid")
        .all() as Row[];
    return rows.map(toRun);
}

export async function updateRun(
    runId: string,
    patch: { states?: NodeStates; status?: RunStatus; error?: string | null; finishedAt?: string | null },
): Promise<void> {
    const db = await ensureDb();
    const sets = ["updated_at = ?"];
    const values: Array<string | null> = [now()];
    if (patch.states) {
        sets.push("state_json = ?");
        values.push(JSON.stringify(patch.states));
    }
    if (patch.status) {
        sets.push("status = ?");
        values.push(patch.status);
    }
    if (patch.error !== undefined) {
        sets.push("error = ?");
        values.push(patch.error);
    }
    if (patch.finishedAt !== undefined) {
        sets.push("finished_at = ?");
        values.push(patch.finishedAt);
    }
    db.prepare(`UPDATE pipeline_runs SET ${sets.join(", ")} WHERE run_id = ?`).run(...values, runId);
}

export async function requestRunCancel(runId: string): Promise<boolean> {
    const db = await ensureDb();
    const result = db
        .prepare(
            "UPDATE pipeline_runs SET cancel_requested = 1, updated_at = ? WHERE run_id = ? AND status = 'running'",
        )
        .run(now(), runId);
    return Number(result.changes) > 0;
}

export async function isRunCancelRequested(runId: string): Promise<boolean> {
    const db = await ensureDb();
    const row = db.prepare("SELECT cancel_requested FROM pipeline_runs WHERE run_id = ?").get(runId) as Row | undefined;
    return Number(row?.cancel_requested) === 1;
}
