// Runs queued PR reviews in headless Copilot SDK sessions. Each review gets its
// own persistent session (so the user can chat with the reviewer or reopen it
// with `copilot --resume`) and publishes through the `publish_review` tool.

import { randomUUID } from "node:crypto";
import { defineTool, type Tool } from "@github/copilot-sdk";
import { explainCopilotError, prSessionOptions, sendAndSettle, withCopilotClient, type SettleSession } from "./copilot-runtime.mjs";
import { publishReview, PUBLISH_REVIEW_SCHEMA } from "./review-publish.mjs";
import {
    acknowledgeReviewJobs,
    claimQueuedReviewJobs,
    claimReviewTask,
    enqueueReviewJobs,
    ensureDb,
    expireStaleReviewJobs,
    failActiveReviewJob,
    getActiveReviewJobBySession,
    isReviewJobActive,
    listActiveReviewJobs,
    requeueOrphanedReviewJobs,
    type ReviewJobInput,
    type ReviewJobRow,
} from "./store.mjs";
import type { WorkItem } from "./service-files.mjs";

const RUNNER_SURFACE = "desktop";
const MAX_QUEUE_BATCH = 50;
const MAX_TASK_PROMPT_LENGTH = 5_000_000;
// The app is single-instance, so every queued job belongs to this runner.
const ADOPT_ALL_QUEUED = "9999-12-31T23:59:59.999Z";

/** Identifies this app process as the owner of the jobs it starts. */
export const RUNNER_ID = `${RUNNER_SURFACE}:${randomUUID()}`;

export const PUBLISH_NUDGE =
    "You have not called the `publish_review` tool yet. Call it now with the identity from the review task: status='done' with summary, story, semanticFindings and findings if the review is complete, or status='error' with an error message if it cannot be completed.";

/** The part of a Copilot session the runner uses (a fake in the harness). */
export interface ReviewSession extends SettleSession {
    readonly sessionId: string;
    abort(): Promise<void>;
    disconnect(): Promise<void>;
}

export interface ReviewRunnerOptions {
    createSession(job: ReviewJobRow, tools: Tool<any>[]): Promise<ReviewSession>;
    maxConcurrent: number;
    pollMs: number;
    turnTimeoutMs: number;
    nudgeTimeoutMs: number;
}

const DEFAULTS: ReviewRunnerOptions = {
    createSession: (job, tools) =>
        withCopilotClient((client) =>
            client.createSession({
                ...prSessionOptions(job.org, job.project),
                model: job.review_model && job.review_model !== "auto" ? job.review_model : undefined,
                // Personal coding instructions (present options, commit, …) do
                // not apply to an unattended review.
                skipCustomInstructions: true,
                tools,
            }),
        ),
    maxConcurrent: 3,
    // Under the store's 2-hour running-job expiry, including the nudge turn.
    pollMs: 2_000,
    turnTimeoutMs: 90 * 60_000,
    nudgeTimeoutMs: 10 * 60_000,
};

let options: ReviewRunnerOptions = DEFAULTS;
let pumpTimer: ReturnType<typeof setInterval> | null = null;
let pumping = false;
let stopping = false;
const inFlight = new Set<Promise<void>>();
const openSessions = new Set<ReviewSession>();
/** Reviews running here, by run id, for the background service's idle check. */
const running = new Map<string, string>();

/** Reviews running here and queued for this runner. */
export async function reviewRunnerActivity(): Promise<WorkItem[]> {
    const items: WorkItem[] = [...running.values()].map((label) => ({ kind: "review", label }));
    if (!pumpTimer) return items;
    await ensureDb();
    for (const job of listActiveReviewJobs()) {
        if (job.status === "queued") items.push({ kind: "review", label: `PR #${job.pr_id} (queued)` });
    }
    return items;
}

function errorMessage(error: unknown): string {
    return explainCopilotError((error as Error)?.message || String(error));
}

/** The tool a reviewer session calls once to store its finished review. */
export function publishReviewTool(): Tool<unknown> {
    return defineTool("publish_review", {
        description:
            "Publish the finished review of this pull request to Devis. Call it exactly once when the review is complete (status 'done'), or with status 'error' if the review cannot be completed. If it rejects the input, correct the input and call it again.",
        parameters: PUBLISH_REVIEW_SCHEMA as unknown as Record<string, unknown>,
        skipPermission: true,
        defer: "never",
        isTerminal: true,
        handler: async (args, invocation) => {
            await ensureDb();
            const job = getActiveReviewJobBySession(invocation.sessionId);
            if (!job) throw new Error("This session has no unfinished review to publish.");
            const result = await publishReview(
                args,
                {
                    prId: job.pr_id,
                    org: job.org,
                    project: job.project,
                    repoId: job.repo_id,
                    runId: job.run_id,
                },
                invocation.sessionId,
            );
            return `Published the ${result.status === "done" ? "review" : "review error"} for PR #${result.prId}. Your task is complete.`;
        },
    });
}

async function runReviewJob(job: ReviewJobRow): Promise<void> {
    running.set(job.run_id, `PR #${job.pr_id}: ${job.title}`);
    try {
        await runReviewJobInner(job);
    } finally {
        running.delete(job.run_id);
    }
}

async function runReviewJobInner(job: ReviewJobRow): Promise<void> {
    let session: ReviewSession;
    try {
        session = await options.createSession(job, [publishReviewTool()]);
    } catch (error) {
        acknowledgeReviewJobs(RUNNER_ID, job.batch_id!, [
            {
                runId: job.run_id,
                ok: false,
                error: `Could not start the reviewer session: ${errorMessage(error)}`,
            },
        ]);
        return;
    }
    if (stopping) {
        // Shutting down: leave the job for the next launch to requeue.
        await session.disconnect().catch(() => undefined);
        return;
    }
    openSessions.add(session);
    try {
        acknowledgeReviewJobs(RUNNER_ID, job.batch_id!, [
            { runId: job.run_id, ok: true, appSessionId: session.sessionId },
        ]);
        const task = claimReviewTask(job.run_id, {
            prId: job.pr_id,
            org: job.org,
            project: job.project,
            repoId: job.repo_id,
        });
        const missedIdle = () => console.warn(`[review-runner] PR #${job.pr_id}'s review turn ended without session.idle; picked up from the runtime`);
        await sendAndSettle(
            session,
            { prompt: task.task_prompt, displayPrompt: `Review PR #${job.pr_id}: ${job.title}` },
            options.turnTimeoutMs,
            { onMissedIdle: missedIdle },
        );
        if (isReviewJobActive(job.run_id) && !stopping) {
            await sendAndSettle(session, { prompt: PUBLISH_NUDGE }, options.nudgeTimeoutMs, { onMissedIdle: missedIdle });
        }
        if (!stopping) {
            failActiveReviewJob(job.run_id, "The reviewer finished without publishing a review.");
        }
    } catch (error) {
        await session.abort().catch(() => undefined);
        // On shutdown the job stays active so the next launch requeues it.
        if (!stopping) failActiveReviewJob(job.run_id, `The review failed: ${errorMessage(error)}`);
    } finally {
        openSessions.delete(session);
        await session.disconnect().catch(() => undefined);
    }
}

async function pump(): Promise<void> {
    if (pumping || stopping) return;
    pumping = true;
    try {
        await ensureDb();
        expireStaleReviewJobs();
        const jobs = claimQueuedReviewJobs(
            RUNNER_ID,
            RUNNER_SURFACE,
            randomUUID(),
            options.maxConcurrent,
            ADOPT_ALL_QUEUED,
        );
        for (const job of jobs) {
            const run: Promise<void> = runReviewJob(job)
                .catch((error) => console.error(`[review-runner] ${errorMessage(error)}`))
                .finally(() => {
                    inFlight.delete(run);
                    void pump();
                });
            inFlight.add(run);
        }
    } catch (error) {
        console.error(`[review-runner] ${errorMessage(error)}`);
    } finally {
        pumping = false;
    }
}

/** Start running queued reviews, first requeueing any a previous launch left unfinished. */
export async function startReviewRunner(overrides: Partial<ReviewRunnerOptions> = {}): Promise<void> {
    options = { ...DEFAULTS, ...overrides };
    stopping = false;
    await ensureDb();
    expireStaleReviewJobs();
    requeueOrphanedReviewJobs(RUNNER_ID);
    if (!pumpTimer) pumpTimer = setInterval(() => void pump(), options.pollMs);
    void pump();
}

/** Stop claiming work. Reviews in progress are abandoned and requeued on the next launch. */
export async function stopReviewRunner(graceMs = 5_000): Promise<void> {
    stopping = true;
    if (pumpTimer) {
        clearInterval(pumpTimer);
        pumpTimer = null;
    }
    for (const session of openSessions) void session.abort().catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise((resolve) => (timer = setTimeout(resolve, graceMs))),
    ]);
    clearTimeout(timer);
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): JsonRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as JsonRecord;
}

function requiredString(record: JsonRecord, key: string, maxLength = 10_000): string {
    const value = record[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
    const trimmed = value.trim();
    if (trimmed.length > maxLength) throw new Error(`${key} is too long`);
    return trimmed;
}

function optionalString(record: JsonRecord, key: string, maxLength = 10_000): string | null {
    const value = record[key];
    if (value == null || value === "") return null;
    if (typeof value !== "string") throw new Error(`${key} must be a string`);
    const trimmed = value.trim();
    if (trimmed.length > maxLength) throw new Error(`${key} is too long`);
    return trimmed || null;
}

interface QueuedJobSummary {
    prId: string;
    org: string;
    project: string;
    repo: string;
    repoId: string;
    runId: string;
    status: string;
}

/** Persist prepared review tasks; an already-active PR is returned as skipped. */
export async function queueReviewJobs(input: unknown): Promise<{
    accepted: QueuedJobSummary[];
    skipped: QueuedJobSummary[];
}> {
    const record = asRecord(input, "review queue input");
    if (!Array.isArray(record.jobs) || !record.jobs.length) {
        throw new Error("jobs must be a non-empty array");
    }
    if (record.jobs.length > MAX_QUEUE_BATCH) {
        throw new Error(`A review batch can contain at most ${MAX_QUEUE_BATCH} PRs`);
    }
    const jobs: ReviewJobInput[] = record.jobs.map((value, index) => {
        const job = asRecord(value, `jobs[${index}]`);
        const rawPrId = job.prId;
        const prId =
            typeof rawPrId === "number" && Number.isSafeInteger(rawPrId) && rawPrId > 0
                ? String(rawPrId)
                : typeof rawPrId === "string" && /^[1-9]\d*$/.test(rawPrId.trim())
                  ? rawPrId.trim()
                  : "";
        if (!prId) throw new Error(`jobs[${index}].prId must be a positive integer`);
        return {
            runId: requiredString(job, "runId", 100),
            prId,
            org: requiredString(job, "org", 300),
            project: requiredString(job, "project", 300),
            repo: requiredString(job, "repo", 300),
            repoId: requiredString(job, "repoId", 300),
            title: requiredString(job, "title", 1_000),
            taskPrompt: requiredString(job, "taskPrompt", MAX_TASK_PROMPT_LENGTH),
            targetCanvasInstanceId: RUNNER_SURFACE,
            dispatcherSessionId: RUNNER_ID,
            dispatcherCanvasInstanceId: RUNNER_SURFACE,
            reviewModel: optionalString(job, "reviewModel", 200),
        };
    });

    await ensureDb();
    expireStaleReviewJobs();
    const result = enqueueReviewJobs(jobs);
    if (result.accepted.length && pumpTimer) void pump();
    const compact = (job: ReviewJobRow): QueuedJobSummary => ({
        prId: job.pr_id,
        org: job.org,
        project: job.project,
        repo: job.repo,
        repoId: job.repo_id,
        runId: job.run_id,
        status: job.status,
    });
    return {
        accepted: result.accepted.map(compact),
        skipped: result.skipped.map(compact),
    };
}
