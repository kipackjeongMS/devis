// How an agent finds and proposes a task's validation chain, and what the app checks.
//
// The agent brings judgment; the app brings facts and does every write. `candidates`
// gathers what Azure DevOps and this app know: the pipelines the task's PRs must pass
// (build policies), the pipelines that consume those builds (YAML resources.pipelines,
// from an index kept per project), and the chains the user ran with them before.
// `propose` checks every claim it can: each pipeline exists and can be queued, branches
// exist, followed PRs belong to the task, parameters fit the YAML, there are no cycles,
// and a pipeline that uses a build runs after the one that makes it. A proposal that
// fails a check is refused with what to fix; one that passes waits for the user.

import { randomUUID } from "node:crypto";
import { defineTool, type Tool } from "@github/copilot-sdk";
import {
    branchExists,
    getDefinitionInfo,
    getPrBuildPolicies,
    getRunParameters,
    listBuildDefinitions,
    type DefinitionInfo,
    type PipelineDefinition,
    type PrBuildPolicy,
    type RunParametersInfo,
} from "./ado.mjs";
import {
    checkParams,
    normalizeBranch,
    pipelineKey,
    resolveRepoBranches,
    validateGraph,
    MAX_CHAIN_NODES,
    MAX_REPO_BRANCHES,
    type PipelineResource,
    type PrRef,
} from "./pipeline-graph.mjs";
import { describeAdoError } from "./pipeline-runner.mjs";
import { ensureDb } from "./store.mjs";
import { readConfig } from "./config.mjs";
import { JarvisError, asJarvisId, getTask, getWorker, listTaskPrs, type JarvisTask, type TaskPr } from "./jarvis-store.mjs";
import { LEAD_NAME } from "./brand.mjs";
import {
    blockKey,
    proposalGraph,
    runValidation,
    storeProposal,
    validationChain,
    validationView,
    type Proposal,
    type ProposalCheck,
    type ProposedBlock,
    type ValidationEvidence,
} from "./jarvis-validation.mjs";

// ---- Azure DevOps, swappable for tests -----------------------------------------------------

export interface DiscoveryRuntime {
    listDefinitions(org: string, project: string): Promise<PipelineDefinition[]>;
    definitionInfo(org: string, project: string, definitionId: number): Promise<DefinitionInfo>;
    runParameters(org: string, project: string, projectId: string, definitionId: number, branch: string): Promise<RunParametersInfo>;
    prBuildPolicies(org: string, projectId: string, prId: number): Promise<PrBuildPolicy[]>;
    branchExists(org: string, project: string, repoId: string, branch: string): Promise<boolean>;
}

const ADO: DiscoveryRuntime = {
    listDefinitions: listBuildDefinitions,
    definitionInfo: getDefinitionInfo,
    runParameters: getRunParameters,
    prBuildPolicies: getPrBuildPolicies,
    branchExists,
};
let runtime: DiscoveryRuntime = ADO;

export function setDiscoveryRuntime(overrides: Partial<DiscoveryRuntime> | null): void {
    runtime = overrides ? { ...ADO, ...overrides } : ADO;
}

export const DISCOVERY_LIMITS = {
    /** How long candidates waits on the index before answering with what it has. */
    indexBudgetMs: 40_000,
    indexConcurrency: 4,
    /** An indexed pipeline is read again after this. */
    indexTtlMs: 24 * 60 * 60_000,
    maxIndexedPerProject: 1500,
    maxCandidates: 30,
};

/** A name that reads like a production deployment. A hint, not a fact: it's only the name. */
const PRODUCTION = /(^|[^a-z])(prod|production|ring[ _-]?[1-9]|public|sovereign|fairfax|mooncake|gcc)([^a-z]|$)/i;
export const looksLikeProduction = (name: string, path = ""): boolean => PRODUCTION.test(name) || PRODUCTION.test(path);

// ---- the resource index: which pipelines consume which builds ------------------------------------

interface IndexedPipeline {
    org: string;
    project: string;
    definitionId: number;
    name: string;
    path: string;
    yaml: boolean;
    queueStatus: string;
    resources: PipelineResource[];
}

let indexReady: Promise<void> | null = null;
async function indexDb() {
    const db = await ensureDb();
    indexReady ??= Promise.resolve().then(() => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS pipeline_resource_index (
                org_key        TEXT NOT NULL,
                project_key    TEXT NOT NULL,
                definition_id  INTEGER NOT NULL,
                org            TEXT NOT NULL,
                project        TEXT NOT NULL,
                name           TEXT NOT NULL,
                path           TEXT NOT NULL,
                yaml           INTEGER NOT NULL,
                queue_status   TEXT NOT NULL,
                resources_json TEXT,
                error          TEXT,
                indexed_at     TEXT NOT NULL,
                PRIMARY KEY (org_key, project_key, definition_id)
            );
        `);
    });
    await indexReady;
    return db;
}

/** For tests that swap the database underneath. */
export function resetDiscoverySchema(): void {
    indexReady = null;
    indexing.clear();
}

const indexing = new Map<string, Promise<void>>();

async function indexOne(org: string, project: string, d: PipelineDefinition): Promise<void> {
    const db = await indexDb();
    let yaml = false;
    let resources: PipelineResource[] = [];
    let error: string | null = null;
    if (d.queueStatus !== "disabled") {
        try {
            const info = await runtime.definitionInfo(org, project, d.id);
            yaml = info.yaml;
            if (yaml) resources = (await runtime.runParameters(org, project, info.projectId, d.id, info.defaultBranch)).resources;
        } catch (e) {
            error = describeAdoError(e).slice(0, 300);
        }
    }
    db.prepare(
        `INSERT INTO pipeline_resource_index (org_key, project_key, definition_id, org, project, name, path, yaml, queue_status, resources_json, error, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_key, project_key, definition_id) DO UPDATE SET org = excluded.org, project = excluded.project, name = excluded.name,
             path = excluded.path, yaml = excluded.yaml, queue_status = excluded.queue_status, resources_json = excluded.resources_json,
             error = excluded.error, indexed_at = excluded.indexed_at`,
    ).run(org.toLowerCase(), project.toLowerCase(), d.id, org, project, d.name, d.path, yaml ? 1 : 0, d.queueStatus, JSON.stringify(resources), error, new Date().toISOString());
}

/**
 * Read the YAML resources of a project's pipelines into the index, the stale ones only.
 * Returns once done or at `deadline`; past it, indexing goes on in the background.
 */
export async function indexProject(org: string, project: string, deadline: number): Promise<{ total: number; fresh: number }> {
    const key = `${org.toLowerCase()}/${project.toLowerCase()}`;
    const defs = (await runtime.listDefinitions(org, project)).slice(0, DISCOVERY_LIMITS.maxIndexedPerProject);
    const db = await indexDb();
    const cutoff = new Date(Date.now() - DISCOVERY_LIMITS.indexTtlMs).toISOString();
    const freshIds = new Set(
        (db
            .prepare("SELECT definition_id FROM pipeline_resource_index WHERE org_key = ? AND project_key = ? AND indexed_at >= ?")
            .all(org.toLowerCase(), project.toLowerCase(), cutoff) as Array<{ definition_id: number }>).map((r) => Number(r.definition_id)),
    );
    const todo = defs.filter((d) => !freshIds.has(d.id));
    if (todo.length && !indexing.has(key)) {
        const queue = [...todo];
        const work = (async () => {
            await Promise.all(
                Array.from({ length: DISCOVERY_LIMITS.indexConcurrency }, async () => {
                    for (let d = queue.shift(); d; d = queue.shift()) await indexOne(org, project, d);
                }),
            );
        })().finally(() => indexing.delete(key));
        indexing.set(key, work);
    }
    const pending = indexing.get(key);
    if (pending) await Promise.race([pending, new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
    const indexed = (db
        .prepare("SELECT COUNT(*) AS n FROM pipeline_resource_index WHERE org_key = ? AND project_key = ? AND indexed_at >= ?")
        .get(org.toLowerCase(), project.toLowerCase(), cutoff) as { n: number }).n;
    return { total: defs.length, fresh: Number(indexed) };
}

async function indexed(org: string, project: string): Promise<IndexedPipeline[]> {
    const db = await indexDb();
    return (db.prepare("SELECT * FROM pipeline_resource_index WHERE org_key = ? AND project_key = ?").all(org.toLowerCase(), project.toLowerCase()) as Array<Record<string, unknown>>).map(
        (r) => ({
            org: String(r.org),
            project: String(r.project),
            definitionId: Number(r.definition_id),
            name: String(r.name),
            path: String(r.path),
            yaml: Number(r.yaml) === 1,
            queueStatus: String(r.queue_status),
            resources: JSON.parse(String(r.resources_json || "[]")) as PipelineResource[],
        }),
    );
}

/** Does `resource` (declared in a pipeline of `consumerProject`) name `producer`? A name with a folder must match the folder too, as the runner pins it. */
function consumes(resource: PipelineResource, consumerProject: string, producer: { name: string; path?: string; project: string }): boolean {
    const want = pipelineKey(resource.name);
    const have = want.includes("\\") ? pipelineKey(`${producer.path || ""}\\${producer.name}`) : producer.name.toLowerCase();
    if (have !== want) return false;
    return (resource.project || consumerProject).toLowerCase() === producer.project.toLowerCase();
}

// ---- candidates ----------------------------------------------------------------------------------

export interface Candidate {
    /** org/project/definitionId: how propose names it. */
    pipeline: string;
    org: string;
    project: string;
    definitionId: number;
    name: string;
    path: string;
    /** Follow this PR's branch, or build `branch` ("" for the pipeline's default). */
    suggested: { followPr?: number; branch: string };
    /** Candidates whose output this one uses (YAML resources.pipelines). */
    uses: string[];
    evidence: ValidationEvidence[];
}

const refOf = (c: { org: string; project: string; definitionId: number }) => `${c.org}/${c.project}/${c.definitionId}`;

async function chainHistory(): Promise<Array<{ id: string; name: string; owner: string | null; runs: number; defs: string[] }>> {
    const db = await ensureDb();
    const rows = db
        .prepare(
            `SELECT c.id, c.name, c.owner_task_id, c.graph_json, (SELECT COUNT(*) FROM pipeline_runs r WHERE r.chain_id = c.id AND r.status <> 'running') AS runs
             FROM pipeline_chains c`,
        )
        .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        owner: (r.owner_task_id as string | null) ?? null,
        runs: Number(r.runs),
        defs: (JSON.parse(String(r.graph_json)).nodes as Array<{ org: string; project: string; definitionId: number }>).map((n) => blockKey(n)),
    }));
}

function activePrs(prs: TaskPr[]): TaskPr[] {
    return prs.filter((p) => !p.hidden && p.snapshot && p.snapshot.projectId);
}

/** What the app can find for the task's validation, with the evidence for each. */
export async function findCandidates(taskId: string): Promise<{ candidates: Candidate[]; notes: string[] }> {
    const task = await getTask(taskId);
    if (!task) throw new JarvisError("Task not found.", 404);
    const prs = activePrs(await listTaskPrs(task.id));
    const notes: string[] = [];
    const out = new Map<string, Candidate>();
    const add = (c: Omit<Candidate, "pipeline" | "uses" | "evidence">, evidence: ValidationEvidence): Candidate => {
        const key = blockKey(c);
        let entry = out.get(key);
        if (!entry) {
            entry = { ...c, pipeline: refOf(c), uses: [], evidence: [] };
            out.set(key, entry);
        }
        if (!entry.evidence.some((e) => e.kind === evidence.kind && e.label === evidence.label)) entry.evidence.push(evidence);
        return entry;
    };

    // 1. The builds each PR's branch policies require.
    if (!prs.length) notes.push("The task has no linked pull requests, so there are no PR checks to start from.");
    for (const pr of prs) {
        const snap = pr.snapshot!;
        let policies: PrBuildPolicy[] = [];
        try {
            policies = await runtime.prBuildPolicies(pr.org, snap.projectId, pr.prId);
        } catch (e) {
            notes.push(`Couldn't read PR ${pr.prId}'s checks: ${describeAdoError(e)}`);
        }
        if (!policies.length) notes.push(`PR ${pr.prId} has no build validation policy.`);
        for (const p of policies) {
            try {
                const info = await runtime.definitionInfo(pr.org, snap.projectId, p.definitionId);
                const sameRepo = info.repository?.id === snap.repoId;
                add(
                    { org: pr.org, project: info.projectName, definitionId: p.definitionId, name: info.name, path: info.path, suggested: sameRepo ? { followPr: pr.prId, branch: "" } : { branch: "" } },
                    { kind: "prCheck", label: p.blocking ? "PR check · required" : "PR check · optional", detail: `${p.name} on PR ${pr.prId}`, verified: true },
                );
            } catch (e) {
                notes.push(`PR ${pr.prId}'s check "${p.name}" points at pipeline ${p.definitionId}, which couldn't be read: ${describeAdoError(e)}`);
            }
        }
    }

    // 2. Pipelines whose YAML consumes those builds, and what consumes them in turn.
    const projects = new Map<string, { org: string; project: string }>();
    for (const c of out.values()) projects.set(`${c.org.toLowerCase()}/${c.project.toLowerCase()}`, { org: c.org, project: c.project });
    if (task.org && task.project) projects.set(`${task.org.toLowerCase()}/${task.project.toLowerCase()}`, { org: task.org, project: task.project });
    const deadline = Date.now() + DISCOVERY_LIMITS.indexBudgetMs;
    const pool: IndexedPipeline[] = [];
    for (const { org, project } of projects.values()) {
        try {
            const progress = await indexProject(org, project, deadline);
            if (progress.fresh < progress.total) {
                notes.push(`Read ${progress.fresh} of ${progress.total} pipelines in ${project} so far; the rest are being read. Ask for candidates again in a minute for a fuller list.`);
            }
            pool.push(...(await indexed(org, project)));
        } catch (e) {
            notes.push(`Couldn't list the pipelines in ${project}: ${describeAdoError(e)}`);
        }
    }
    let frontier = [...out.values()];
    for (let hop = 0; hop < 2 && frontier.length; hop++) {
        const next: Candidate[] = [];
        for (const consumer of pool) {
            if (consumer.queueStatus === "disabled" || !consumer.yaml) continue;
            for (const producer of frontier) {
                const r = consumer.resources.find((res) => consumes(res, consumer.project, producer));
                if (!r || blockKey(consumer) === blockKey(producer)) continue;
                const before = out.has(blockKey(consumer));
                const c = add(
                    { org: consumer.org, project: consumer.project, definitionId: consumer.definitionId, name: consumer.name, path: consumer.path, suggested: { branch: "" } },
                    { kind: "consumes", label: `Uses ${producer.name}'s output`, detail: `resources.pipelines: ${r.alias}`, verified: true },
                );
                if (!c.uses.includes(producer.pipeline)) c.uses.push(producer.pipeline);
                if (!before) next.push(c);
            }
        }
        frontier = next;
    }

    // 3. Chains the user ran with these pipelines.
    const history = await chainHistory();
    const found = new Set(out.keys());
    for (const chain of history) {
        if (chain.owner === task.id || !chain.defs.some((d) => found.has(d))) continue;
        for (const key of chain.defs) {
            const c = out.get(key);
            if (c) c.evidence.push({ kind: "history", label: chain.runs ? `Ran ${chain.runs}× in "${chain.name}"` : `In "${chain.name}"`, verified: true });
        }
    }

    // 4. Names that read like production.
    for (const c of out.values()) {
        if (looksLikeProduction(c.name, c.path)) c.evidence.push({ kind: "production", label: "Name suggests production", verified: true });
    }
    const candidates = [...out.values()].slice(0, DISCOVERY_LIMITS.maxCandidates);
    if (out.size > candidates.length) notes.push(`Showing ${candidates.length} of ${out.size} candidates.`);
    return { candidates, notes };
}

// ---- checking a proposal ---------------------------------------------------------------------------

export interface ProposalInput {
    summary?: unknown;
    blocks?: unknown;
    leftOut?: unknown;
}

interface BlockInput {
    pipeline?: unknown;
    after?: unknown;
    branch?: unknown;
    followPr?: unknown;
    params?: unknown;
    repoBranches?: unknown;
    reason?: unknown;
}

const clip = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** "org/project/123", "project/123" or "123" (or a number), against the task's defaults. */
function parseRef(value: unknown, defaults: { org: string | null; project: string | null }): { org: string; project: string; definitionId: number } | null {
    const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
    const parts = raw.split("/").map((p) => p.trim()).filter(Boolean);
    const id = Number(parts.pop());
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const project = parts.pop() || defaults.project;
    const org = parts.pop() || defaults.org;
    return org && project ? { org, project, definitionId: id } : null;
}

/** Check a proposal and turn it into what the user reviews. Throws a JarvisError listing every problem. */
export async function checkProposal(task: JarvisTask, input: ProposalInput, by: string, sessionId: string | null): Promise<Proposal> {
    const cfg = await readConfig();
    const prs = activePrs(await listTaskPrs(task.id));
    const defaults = { org: task.org ?? prs[0]?.org ?? cfg.organizations[0] ?? null, project: task.project ?? prs[0]?.snapshot?.project ?? null };
    const errors: string[] = [];
    const warnings: string[] = [];
    const summary = clip(input.summary, 600);
    if (!summary) errors.push("Add a summary: one or two sentences on what the chain proves and what you left out.");
    const rawBlocks = Array.isArray(input.blocks) ? (input.blocks as BlockInput[]) : [];
    if (!rawBlocks.length) errors.push("List at least one pipeline in blocks.");
    if (rawBlocks.length > MAX_CHAIN_NODES) errors.push(`A chain holds at most ${MAX_CHAIN_NODES} pipelines.`);

    interface Resolved extends ProposedBlock {
        info: DefinitionInfo | null;
        resources: PipelineResource[];
        afterRefs: unknown[];
    }
    const blocks: Resolved[] = [];
    const seen = new Set<string>();
    let branchesChecked = 0;
    let branchesUnchecked = 0;
    const orgs = new Map(cfg.organizations.map((o) => [o.toLowerCase(), o]));
    for (const [i, b] of rawBlocks.slice(0, MAX_CHAIN_NODES).entries()) {
        const ref = parseRef(b?.pipeline, defaults);
        if (!ref) {
            errors.push(`Block ${i + 1}: name the pipeline as org/project/definitionId (from candidates).`);
            continue;
        }
        const org = orgs.get(ref.org.toLowerCase());
        if (!org) {
            errors.push(`Block ${i + 1}: "${ref.org}" isn't one of the user's organizations.`);
            continue;
        }
        const key = blockKey({ ...ref, org });
        if (seen.has(key)) {
            errors.push(`Pipeline ${ref.definitionId} is listed twice.`);
            continue;
        }
        seen.add(key);
        let info: DefinitionInfo | null = null;
        try {
            info = await runtime.definitionInfo(org, ref.project, ref.definitionId);
        } catch (e) {
            errors.push(`Pipeline ${ref.project}/${ref.definitionId} couldn't be read: ${describeAdoError(e)}`);
        }
        const name = info?.name ?? `Pipeline ${ref.definitionId}`;
        if (info && info.queueStatus !== "enabled") errors.push(`${name} is ${info.queueStatus}, so it can't be queued.`);
        const reason = clip(b?.reason, 400);
        if (!reason) errors.push(`${name}: add a reason, one sentence on why it belongs.`);

        let branchFrom: PrRef | undefined;
        let branch = clip(b?.branch, 256).replace(/^refs\/heads\//, "");
        let effective = "";
        if (b?.followPr !== undefined && b.followPr !== null && b.followPr !== "") {
            const prId = Number(b.followPr);
            const pr = prs.find((p) => p.prId === prId && p.org.toLowerCase() === org.toLowerCase());
            if (!pr) errors.push(`${name} follows PR ${b.followPr}, which isn't linked to this task.`);
            else if (info && (!info.repository || info.repository.type.toLowerCase() !== "tfsgit" || info.repository.id !== pr.snapshot!.repoId)) {
                // The runner queues the pipeline on the PR's branch name: in another repository that's a different branch, or none.
                errors.push(
                    `${name} builds ${info.repository ? `the ${info.repository.name} repository` : "another repository"}, but PR ${prId} is in ${pr.snapshot!.repo}, so it can't follow that PR. Give it a branch instead.`,
                );
            } else {
                branchFrom = { org: pr.org, prId };
                branch = "";
                effective = normalizeBranch(pr.snapshot!.sourceRef);
                if (pr.snapshot!.status !== "active") warnings.push(`PR ${prId} is ${pr.snapshot!.status}; its branch may be gone.`);
            }
        } else if (branch && info?.repository && info.repository.type.toLowerCase() === "tfsgit") {
            try {
                if (!(await runtime.branchExists(org, info.projectName, info.repository.id, branch))) {
                    errors.push(`${name}: branch ${branch} doesn't exist in ${info.repository.name}.`);
                } else branchesChecked++;
            } catch (e) {
                branchesUnchecked++;
                warnings.push(`Couldn't check that branch ${branch} exists: ${describeAdoError(e)}`);
            }
        } else if (branch && info) {
            branchesUnchecked++;
            warnings.push(`${name}'s code isn't in Azure Repos, so the app couldn't check that branch ${branch} exists.`);
        }
        effective ||= normalizeBranch(branch) || info?.defaultBranch || "";

        let params: Record<string, string> | undefined;
        if (b?.params && typeof b.params === "object" && !Array.isArray(b.params)) {
            params = Object.fromEntries(
                Object.entries(b.params as Record<string, unknown>)
                    .filter(([k, v]) => k && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
                    .map(([k, v]) => [k.slice(0, 128), String(v).slice(0, 4000)]),
            );
            if (!Object.keys(params).length) params = undefined;
        }
        let repoBranches: Record<string, string> | undefined;
        if (b?.repoBranches && typeof b.repoBranches === "object" && !Array.isArray(b.repoBranches)) {
            repoBranches = Object.fromEntries(
                Object.entries(b.repoBranches as Record<string, unknown>)
                    .filter(([k, v]) => k && typeof v === "string" && v.trim())
                    .slice(0, MAX_REPO_BRANCHES)
                    .map(([k, v]) => [k.slice(0, 100), (v as string).trim().replace(/^refs\/heads\//, "").slice(0, 256)]),
            );
            if (!Object.keys(repoBranches).length) repoBranches = undefined;
        }
        let resources: PipelineResource[] = [];
        if (info?.yaml) {
            try {
                const yaml = await runtime.runParameters(org, info.projectName, info.projectId, ref.definitionId, effective);
                resources = yaml.resources;
                const problem = checkParams(params, yaml.parameters);
                if (problem) errors.push(`${name}: ${problem}`);
                if (repoBranches) {
                    const repos = yaml.repositories ?? [];
                    const resolved = resolveRepoBranches(repoBranches, repos);
                    if (resolved.error) {
                        const known = repos.map((r) => r.alias).join(", ");
                        errors.push(`${name}: ${resolved.error.replace(/ Remove .*$/, "")} Its repository resources: ${known || "none"}.`);
                    } else {
                        for (const [alias, refName] of Object.entries(resolved.refs ?? {})) {
                            const repo = repos.find((r) => r.alias === alias)!;
                            const short = refName.replace(/^refs\/heads\//, "");
                            if (repo.type.toLowerCase() !== "tfsgit" || !repo.id || !refName.startsWith("refs/heads/")) {
                                branchesUnchecked++;
                                warnings.push(`Couldn't check that ${short} exists in ${repo.name} (${alias}).`);
                                continue;
                            }
                            try {
                                if (!(await runtime.branchExists(org, repo.project || info.projectName, repo.id, short))) {
                                    errors.push(`${name}: branch ${short} doesn't exist in ${repo.name} (repository resource ${alias}).`);
                                } else branchesChecked++;
                            } catch (e) {
                                branchesUnchecked++;
                                warnings.push(`Couldn't check that branch ${short} exists in ${repo.name}: ${describeAdoError(e)}`);
                            }
                        }
                    }
                }
                if (yaml.errors.length) warnings.push(`${name}'s YAML on ${effective.replace(/^refs\/heads\//, "")}: ${yaml.errors[0]}`);
            } catch (e) {
                warnings.push(`Couldn't read ${name}'s YAML: ${describeAdoError(e)}`);
            }
        } else if (info && params) errors.push(`${name} is a classic pipeline, which takes no parameters.`);
        else if (info && repoBranches) errors.push(`${name} is a classic pipeline, which has no repository resources.`);

        blocks.push({
            key,
            org,
            project: info?.projectName ?? ref.project,
            definitionId: ref.definitionId,
            name,
            path: info?.path ?? "\\",
            stage: 0,
            after: [],
            branch,
            ...(branchFrom ? { branchFrom } : {}),
            ...(params ? { params } : {}),
            ...(repoBranches ? { repoBranches } : {}),
            reason,
            evidence: [],
            info,
            resources,
            afterRefs: Array.isArray(b?.after) ? (b.after as unknown[]) : [],
        });
    }

    // Arrows: each "after" names another block in the proposal.
    const byKey = new Map(blocks.map((b) => [b.key, b]));
    for (const b of blocks) {
        for (const a of b.afterRefs) {
            const ref = parseRef(a, defaults);
            const key = ref && orgs.get(ref.org.toLowerCase()) ? blockKey({ ...ref, org: orgs.get(ref.org.toLowerCase())! }) : null;
            const target = key ? byKey.get(key) : undefined;
            if (!target) errors.push(`${b.name} runs after ${String(a)}, which isn't in the proposal.`);
            else if (!b.after.includes(target.key)) b.after.push(target.key);
        }
    }
    const ancestors = (key: string): Map<string, number> => {
        const dist = new Map<string, number>();
        let frontier = [key];
        for (let d = 1; frontier.length && d <= blocks.length; d++) {
            const next: string[] = [];
            for (const k of frontier) for (const p of byKey.get(k)?.after ?? []) if (!dist.has(p)) dist.set(p, d), next.push(p);
            frontier = next;
        }
        return dist;
    };

    // A pipeline that uses a build must run after the block that makes it.
    let consumerLinks = 0;
    for (const b of blocks) {
        const up = ancestors(b.key);
        for (const r of b.resources) {
            const producers = blocks.filter((p) => p !== b && consumes(r, b.project, p));
            if (!producers.length) continue;
            const upstream = producers.filter((p) => up.has(p.key));
            if (!upstream.length) {
                errors.push(`${b.name} uses ${producers[0].name}'s output (${r.alias}), so it has to run after it: add it to ${b.name}'s after list.`);
                continue;
            }
            const nearest = Math.min(...upstream.map((p) => up.get(p.key)!));
            const tied = upstream.filter((p) => up.get(p.key) === nearest);
            if (tied.length > 1) errors.push(`${b.name} uses ${r.alias}, which ${tied.map((p) => p.name).join(" and ")} both build at the same distance; keep one.`);
            else {
                consumerLinks++;
                b.evidence.push({ kind: "consumes", label: `Uses ${tied[0].name}'s output`, detail: `resources.pipelines: ${r.alias}`, verified: true });
            }
        }
    }

    // Stages, cycles and the 50-block limit, by the same rules as any chain.
    const stage = (key: string, path = new Set<string>()): number => {
        if (path.has(key)) return 0;
        const b = byKey.get(key);
        if (!b?.after.length) return 0;
        path.add(key);
        const s = 1 + Math.max(...b.after.map((a) => stage(a, path)));
        path.delete(key);
        return s;
    };
    for (const b of blocks) b.stage = stage(b.key);
    const draft: Proposal = { id: randomUUID(), summary, blocks: blocks.map(stripResolved), leftOut: [], checks: [], by, sessionId, at: new Date().toISOString() };
    if (blocks.length) {
        try {
            validateGraph(proposalGraph(draft), cfg.organizations);
        } catch (e) {
            errors.push((e as Error).message);
        }
    }

    // Evidence the app can vouch for: PR checks, past chains, production-sounding names.
    const policies = new Set<string>();
    for (const pr of prs) {
        try {
            for (const p of await runtime.prBuildPolicies(pr.org, pr.snapshot!.projectId, pr.prId)) policies.add(`${pr.org.toLowerCase()}/${p.definitionId}/${pr.prId}`);
        } catch {
            /* no PR evidence then */
        }
    }
    const history = await chainHistory();
    for (const b of blocks) {
        const checksFrom = prs.filter((pr) => policies.has(`${b.org.toLowerCase()}/${b.definitionId}/${pr.prId}`)).map((pr) => pr.prId);
        if (checksFrom.length) b.evidence.unshift({ kind: "prCheck", label: "PR check", detail: `Required on PR ${checksFrom.join(", ")}`, verified: true });
        const past = history.filter((c) => c.owner !== task.id && c.defs.includes(b.key));
        const runs = past.reduce((n, c) => n + c.runs, 0);
        if (past.length) b.evidence.push({ kind: "history", label: runs ? `Ran ${runs}× before` : `In ${past.length} of your chains`, verified: true });
        if (looksLikeProduction(b.name, b.path)) {
            b.evidence.push({ kind: "production", label: "Name suggests production", verified: true });
            warnings.push(`${b.name} looks like a production deploy (by its name). Make sure that's intended.`);
        }
    }

    const leftOut = (Array.isArray(input.leftOut) ? (input.leftOut as BlockInput[]) : []).slice(0, 20).flatMap((l) => {
        const ref = parseRef(l?.pipeline, defaults);
        if (!ref) return [];
        const org = orgs.get(ref.org.toLowerCase()) ?? ref.org;
        const evidence: ValidationEvidence[] = [];
        return [{ key: blockKey({ ...ref, org }), name: clip((l as { name?: unknown })?.name, 256) || `Pipeline ${ref.definitionId}`, reason: clip(l?.reason, 300), evidence }];
    });
    for (const l of leftOut) {
        try {
            const [org, project, id] = l.key.split("/");
            const info = await runtime.definitionInfo(orgs.get(org) ?? org, project, Number(id));
            l.name = info.name;
            if (looksLikeProduction(info.name, info.path)) l.evidence.push({ kind: "production", label: "Name suggests production", verified: true });
        } catch {
            /* keep what the agent said */
        }
    }

    if (errors.length) throw new JarvisError(`Not proposed. Fix these and propose again:\n- ${[...new Set(errors)].join("\n- ")}`, 400);
    const checks: ProposalCheck[] = [
        { tone: "ok", text: `All ${blocks.length} pipelines exist and are enabled` },
        ...(branchesChecked && !branchesUnchecked ? [{ tone: "ok" as const, text: "Every fixed branch exists" }] : []),
        ...(blocks.some((b) => b.branchFrom)
            ? [{ tone: "ok" as const, text: `Blocks that follow a PR build its current branch (${[...new Set(blocks.filter((b) => b.branchFrom).map((b) => `PR ${b.branchFrom!.prId}`))].join(", ")})` }]
            : []),
        ...(consumerLinks ? [{ tone: "ok" as const, text: "Each pipeline that uses a build comes after the one that makes it" }] : []),
        { tone: "ok", text: `No cycles · ${blocks.length} of ${MAX_CHAIN_NODES} blocks` },
        ...blocks
            .filter((b) => b.params)
            .map((b) => ({ tone: "warn" as const, text: `${Object.keys(b.params!).length} parameter${Object.keys(b.params!).length === 1 ? "" : "s"} changed on ${b.name}` })),
        ...blocks
            .filter((b) => b.repoBranches)
            .map((b) => ({
                tone: "warn" as const,
                text: `${b.name} uses ${Object.entries(b.repoBranches!).map(([alias, br]) => `${br} of ${alias}`).join(", ")} instead of the YAML's ref`,
            })),
        ...warnings.map((text) => ({ tone: "warn" as const, text })),
    ];
    return { ...draft, blocks: blocks.map(stripResolved), leftOut, checks };
}

function stripResolved<T extends ProposedBlock & { info?: unknown; resources?: unknown; afterRefs?: unknown }>(b: T): ProposedBlock {
    const { info: _i, resources: _r, afterRefs: _a, ...rest } = b;
    return { ...rest, after: [...rest.after], evidence: [...rest.evidence] };
}

/** Check a proposal and, when it passes, store it for the user. Returns what to tell the proposer. */
export async function propose(taskIdValue: unknown, input: ProposalInput, by: string, sessionId: string | null): Promise<string> {
    const id = asJarvisId(taskIdValue);
    const task = id ? await getTask(id) : null;
    if (!task) throw new JarvisError("Task not found.", 404);
    if (task.status !== "open") throw new JarvisError("The task is done; reopen it to propose validation.", 409);
    const proposal = await checkProposal(task, input, by, sessionId);
    await storeProposal(task.id, proposal);
    const warn = proposal.checks.filter((c) => c.tone === "warn").map((c) => c.text);
    return `Proposed: ${proposal.blocks.map((b) => b.name).join(" → ")}. It waits for the user under Needs you; nothing runs until they accept and run it.${warn.length ? `\nNoted for them: ${warn.join("; ")}` : ""}`;
}

// ---- status, for the tools --------------------------------------------------------------------------

export async function validationStatusText(taskId: string): Promise<string> {
    const view = await validationView(taskId);
    const lines: string[] = [];
    if (view.chain) {
        lines.push(`Validation chain "${view.chain.name}", ${view.chain.graph.nodes.length} pipeline${view.chain.graph.nodes.length === 1 ? "" : "s"}:`);
        for (const n of view.chain.graph.nodes) {
            const after = view.chain.graph.edges.filter((e) => e.to === n.id).map((e) => view.chain!.graph.nodes.find((x) => x.id === e.from)?.name).filter(Boolean);
            const branch = n.branchFrom ? `follows PR ${n.branchFrom.prId}` : n.branch || "default branch";
            const repos = Object.entries(n.repoBranches ?? {}).map(([alias, br]) => `${alias} on ${br}`);
            lines.push(
                `- ${n.name} (${n.org}/${n.project}/${n.definitionId}), ${branch}${repos.length ? ` (repositories: ${repos.join(", ")})` : ""}${after.length ? `, after ${after.join(", ")}` : ""}`,
            );
        }
        lines.push(view.runs.length ? `Runs, newest first:\n${view.runs.slice(0, 5).map((r) => `- ${r.createdAt}: ${r.text}`).join("\n")}` : "It hasn't run yet.");
    } else lines.push("No validation chain yet.");
    if (view.proposal) lines.push(`A proposal by ${view.proposal.by} waits for the user: ${view.proposal.blocks.map((b) => b.name).join(" → ")}.`);
    if (view.taskStatus === "done") lines.push("The task is done, so its validation can't run until it's reopened.");
    return lines.join("\n");
}

async function candidatesText(taskId: string): Promise<string> {
    const { candidates, notes } = await findCandidates(taskId);
    const list = candidates.map((c) => ({
        pipeline: c.pipeline,
        name: c.name,
        path: c.path,
        suggested: c.suggested.followPr ? { followPr: c.suggested.followPr } : { branch: c.suggested.branch || "(default)" },
        uses: c.uses,
        evidence: c.evidence.map((e) => e.label + (e.detail ? ` (${e.detail})` : "")),
    }));
    return JSON.stringify({ candidates: list, notes }, null, 1);
}

// ---- the tools ----------------------------------------------------------------------------------------

const BLOCK_SCHEMA = {
    type: "object",
    properties: {
        pipeline: { type: "string", description: "org/project/definitionId, as candidates lists it." },
        after: { type: "array", items: { type: "string" }, description: "The pipelines (org/project/definitionId) it runs after. A pipeline that uses another's build must run after it." },
        followPr: { type: "number", description: "Build this linked PR's source branch (usually for the builds the PR's checks require)." },
        branch: { type: "string", description: "A fixed branch instead; leave empty for the pipeline's default (usually right for deploys and tests, which use the earlier build)." },
        params: { type: "object", description: "Runtime parameters to change from their defaults, by name. Only what must change." },
        repoBranches: {
            type: "object",
            description:
                "Branches for the pipeline's YAML repository resources (resources.repositories, like a templates repo), by alias: {\"templates\": \"users/me/fix\"}. Only what must change; the rest use the ref in the YAML. The pipeline's own repo uses branch or followPr.",
        },
        reason: { type: "string", description: "One sentence: why this pipeline belongs in the chain." },
    },
    required: ["pipeline", "reason"],
} as const;

const PROPOSE_HELP =
    "action candidates: what the app found, with evidence: the builds the task's PRs must pass, pipelines that use those builds, and chains the user ran with them. " +
    "action propose: send your chain: summary (what it proves and what you left out), blocks (pipeline, after, followPr or branch, params, repoBranches, reason), leftOut (pipeline, reason). " +
    "The app checks it (pipelines exist and can be queued, branches exist, parameters and repository aliases fit, no cycles, builds before what uses them) and the user reviews it; nothing is created or run until they accept. " +
    "Leave out anything that deploys to production. action status: the current chain, its runs and any proposal.";

/** The worker's tool. The task is the worker's own, from the invoking session. */
export function taskValidationTool(): Tool<unknown> {
    return defineTool("task_validation", {
        description:
            "This task's validation chain: the Azure DevOps pipelines that prove its change works, run in order. " + PROPOSE_HELP +
            " action run: ask the user to run the accepted chain now; it waits for their approval.",
        parameters: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["status", "candidates", "propose", "run"] },
                summary: { type: "string" },
                blocks: { type: "array", items: BLOCK_SCHEMA },
                leftOut: { type: "array", items: { type: "object", properties: { pipeline: { type: "string" }, reason: { type: "string" } }, required: ["pipeline", "reason"] } },
            },
            required: ["action"],
        },
        skipPermission: true,
        defer: "never",
        handler: async (args, invocation) => {
            const worker = await getWorker(invocation.sessionId);
            if (!worker) return "This session is not one of the Workspace's workers.";
            const a = (args || {}) as ProposalInput & { action?: unknown };
            try {
                switch (a.action) {
                    case "status":
                        return await validationStatusText(worker.taskId);
                    case "candidates":
                        return await candidatesText(worker.taskId);
                    case "propose":
                        return await propose(worker.taskId, a, worker.label, worker.sessionId);
                    case "run":
                        return await requestRun(worker.taskId, worker.sessionId);
                    default:
                        return "Use action status, candidates, propose or run.";
                }
            } catch (error) {
                return error instanceof JarvisError ? error.message : `Not done: ${(error as Error).message}`;
            }
        },
    });
}

async function requestRun(taskId: string, sessionId: string): Promise<string> {
    const chain = await validationChain(taskId);
    if (!chain) return "This task has no accepted validation chain yet. Propose one first.";
    const stages = chain.graph.nodes.map((n) => n.name).join(" → ");
    const { askWorkerApproval } = await import("./jarvis-workers.mjs");
    const allowed = await askWorkerApproval(sessionId, `Run the validation chain: ${chain.graph.nodes.length} pipelines`, stages);
    if (!allowed) return "The user declined. Don't run it; continue without it, or ask what they want.";
    await runValidation(taskId);
    return "Started. If it fails, you'll get the failed builds and steps.";
}

/** The Lead's tool: any task, by id. */
export function leadValidationTool(): Tool<unknown> {
    return defineTool("devis_task_validation", {
        description:
            "A task's validation chain: the Azure DevOps pipelines that prove its change works, run in order. Pass taskId (from jarvis_today). " + PROPOSE_HELP +
            " Propose only when the user asks. You can't run it; the user runs it from the task.",
        parameters: {
            type: "object",
            properties: {
                taskId: { type: "string" },
                action: { type: "string", enum: ["status", "candidates", "propose"] },
                summary: { type: "string" },
                blocks: { type: "array", items: BLOCK_SCHEMA },
                leftOut: { type: "array", items: { type: "object", properties: { pipeline: { type: "string" }, reason: { type: "string" } }, required: ["pipeline", "reason"] } },
            },
            required: ["taskId", "action"],
        },
        skipPermission: true,
        defer: "never",
        handler: async (args) => {
            const a = (args || {}) as ProposalInput & { action?: unknown; taskId?: unknown };
            const taskId = asJarvisId(a.taskId);
            if (!taskId || !(await getTask(taskId))) return "Failed: Unknown taskId. Read it from jarvis_today.";
            try {
                switch (a.action) {
                    case "status":
                        return await validationStatusText(taskId);
                    case "candidates":
                        return await candidatesText(taskId);
                    case "propose":
                        return await propose(taskId, a, LEAD_NAME, null);
                    default:
                        return "Use action status, candidates or propose.";
                }
            } catch (error) {
                return error instanceof JarvisError ? error.message : `Failed: ${(error as Error).message}`;
            }
        },
    });
}
