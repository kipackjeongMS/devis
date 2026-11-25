// /api/jarvis/*: the Today dashboard, its tasks and workers, history, and the Lead.

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { BodyTooLargeError, readBody, sendBuffer, sendJson } from "./http.mjs";
import { saveImage, serveImage } from "./chat-images.mjs";
import { readConfig } from "./config.mjs";
import { chatMessagesFromEvents } from "./reviewer-session.mjs";
import {
    ARTIFACT_IMAGE_MAX,
    JarvisError,
    artifactFile,
    artifactImageType,
    artifactsDir,
    asJarvisId,
    deleteArtifact,
    getTask,
    isRemoving,
    listArtifacts,
    listEvents,
    listStatuses,
    listWorkers,
    listWorktrees,
    readArtifact,
    updateTask,
    writeArtifact,
} from "./jarvis-store.mjs";
import { listProjects, listRepositories } from "./ado.mjs";
import { codebaseDir, codebaseStatus, syncCodebase, worktreeChanges, type WorktreeChanges } from "./jarvis-codebase.mjs";
import { createTaskFromInput, previewWorkItem, refreshTaskWorkItems, rememberedPrList, rememberedPrs, startOfToday, startTaskFromTodos, suggestWorkItems, todaySnapshot } from "./jarvis-today.mjs";
import { settlePrTodosNow } from "./todo-prs.mjs";
import {
    confirmRepos,
    decidePermission,
    decideShip,
    listWorkerCommands,
    messageWorker,
    openWorkerIde,
    openWorkerTerminal,
    removeQueuedMessage,
    removeTask,
    removeWorker,
    resumeRemovals,
    runWorkerCommand,
    sendQueuedNow,
    setWorkerModel,
    startDevisTask,
    startWorker,
    stopWorker,
    workerTranscript,
    workerTurnView,
    writeRecap,
} from "./jarvis-workers.mjs";
import {
    getLeadChat,
    openLeadTerminal,
    removeLeadQueued,
    resetLead,
    sendLead,
    listLeadCommands,
    runLeadCommand,
    sendLeadQueuedNow,
    setLeadModel,
    stopLead,
} from "./jarvis-lead.mjs";
import { postStatus } from "./jarvis-status.mjs";
import { listWorkerChanges, workerFileDiff } from "./worker-changes.mjs";
import { ensureOverviewRunner, overviewState, refreshOverview } from "./jarvis-overview.mjs";
import { ensurePrsRunner, linkFromUser, taskPrsView, unlinkPr } from "./jarvis-prs.mjs";
import { addTodo, clearDoneTodos, deleteTodo, getQuickNote, listTodos, moveTodo, saveQuickNote, settleNeedTodos, updateTodo } from "./jarvis-notes.mjs";
import { needKeys } from "./jarvis-needs.mjs";
import { openFolder, revealFile } from "./open-folder.mjs";
import {
    addMeetingTodo,
    chatsDigest,
    commsNeeds,
    commsStatus,
    dismissCommsNeed,
    dismissAsk,
    ensureCommsRunner,
    listCommsChats,
    listCommsMail,
    listCommsMeetings,
    mailDigest,
    meetingsDigest,
    openAsks,
    scanComms,
    setCommsEnabled,
    settleWithPrs,
    type ChatsDigest,
    type CommsAsk,
    type CommsNeed,
    type MeetingsDigest,
} from "./comms.mjs";
import { dismissS360Need, ensureS360Runner, listS360Items, s360Digest, s360Status, s360Today, scanS360, setS360Enabled } from "./s360.mjs";
import {
    YOU_TRIGGER,
    acceptProposal,
    acknowledgeRun,
    askForProposal,
    attachChain,
    cancelQueued,
    dismissProposal,
    removeChain,
    resolveTarget,
    runChains,
    saveAsReusable,
    setAutoPropose,
    setBlockRepoBranches,
    setChainOptions,
    stopRun,
    validationView,
} from "./jarvis-validation.mjs";
import {
    acceptPrComments,
    auditPrCommentsNow,
    dismissPrComments,
    postAppliedAnyway,
    prCommentsView,
    setPrCommentsAuto,
} from "./jarvis-pr-comments.mjs";
import { acceptPrBuilds, auditPrBuildsNow, dismissPrBuilds, prBuildsView } from "./jarvis-pr-builds.mjs";
import { devisBanner, devisOverview, dismissShip, markUndo, saveDevisSettings, undoTask } from "./devis-self.mjs";
import { checkForUpdates, dismissUpdate, installUpdate, releaseTask, saveUpdateSettings, updateBanner, updatesStatus } from "./updates.mjs";

function since(value: string | null): string {
    const t = Date.parse(value || "");
    return Number.isFinite(t) ? new Date(t).toISOString() : startOfToday();
}

/** The open Teams asks, less those the PR list the page loaded already answers; null when they couldn't be read. */
async function todayAsks(): Promise<CommsAsk[] | null> {
    try {
        await settleWithPrs(rememberedPrs());
        return await openAsks();
    } catch (error) {
        console.warn(`[comms] asks: ${(error as Error).message}`);
        return null;
    }
}

function requireId(value: unknown, what = "task"): string {
    const id = asJarvisId(value);
    if (!id) throw new JarvisError(`Unknown ${what}.`, 404);
    return id;
}

let clonesResumed = false;

/** Clone the repos in Settings that aren't cloned yet, say because the app closed mid-clone. Once per start. */
function resumeClones(): void {
    if (clonesResumed) return;
    clonesResumed = true;
    void syncCodebase().catch((error: Error) => console.warn(`[jarvis] codebase not synced: ${error.message}`));
}

export async function handleJarvisApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const p = url.pathname;
    const q = url.searchParams;
    const get = req.method === "GET";
    const post = req.method === "POST";
    // The page polls Today and the Lead; only log what changes something.
    if (!get) console.log(`[api] ${req.method} ${p}`);
    try {
        if (p === "/api/jarvis/today" && get) {
            ensureOverviewRunner();
            ensurePrsRunner();
            ensureCommsRunner();
            ensureS360Runner();
            resumeRemovals();
            resumeClones();
            const cfg = await readConfig();
            const [snapshot, overview, note, comms, meetings, chats, mail, s360] = await Promise.all([
                todaySnapshot(since(q.get("since"))),
                overviewState(),
                getQuickNote(),
                todayAsks(),
                meetingsDigest().catch((error: Error): MeetingsDigest | null => {
                    console.warn(`[comms] meetings: ${error.message}`);
                    return null;
                }),
                chatsDigest().catch((error: Error): ChatsDigest | null => {
                    console.warn(`[comms] chats: ${error.message}`);
                    return null;
                }),
                mailDigest().catch((error: Error): ChatsDigest | null => {
                    console.warn(`[comms] mail: ${error.message}`);
                    return null;
                }),
                s360Today().catch((error: Error) => {
                    console.warn(`[s360] today: ${error.message}`);
                    return null;
                }),
            ]);
            // Chats and email threads waiting on the user; a chat with an open PR ask is left to the ask.
            const needs = await commsNeeds(comms || []).catch((error: Error): CommsNeed[] | null => {
                console.warn(`[comms] needs: ${error.message}`);
                return null;
            });
            // To-dos made from Needs you items tick themselves once the ask is gone. An S360 item's
            // to-do waits for S360 to close the item, and is left alone while the watcher is off.
            const skip = [
                ...(snapshot.validationFailed ? (["val"] as const) : []),
                ...(snapshot.prCommentsFailed ? (["pr"] as const) : []),
                ...(snapshot.prBuildsFailed ? (["ci"] as const) : []),
                ...(comms ? [] : (["teams"] as const)),
                ...(needs ? [] : (["chat", "mail"] as const)),
                ...(s360?.digest.enabled ? [] : (["s360"] as const)),
            ];
            const s360Open = (s360?.open || []).map((key) => ({ key }));
            await settleNeedTodos(needKeys(snapshot.tasks, comms || [], needs || [], s360Open), skip);
            // A PR's to-do ticks itself once the PR closes; ADO may be asked, so the next poll shows it.
            void settlePrTodosNow(rememberedPrList()).catch((error: Error) => console.warn(`[jarvis] PR to-dos not settled: ${error.message}`));
            const todos = await listTodos();
            // The to-dos ride along with every poll; the quick note only says when it changed.
            return sendJson(res, 200, {
                ...snapshot,
                overview,
                organizations: cfg.organizations,
                todos,
                note: { version: note.version, updatedAt: note.updatedAt, updatedBy: note.updatedBy },
                comms: { asks: comms || [], ...(comms ? {} : { failed: true }), ...(meetings ? { meetings } : {}), ...(chats ? { chats } : {}), ...(mail ? { mail } : {}), needs: needs || [], ...(needs ? {} : { needsFailed: true }) },
                s360: s360 ? { ...s360.digest, needs: s360.needs } : { failed: true, needs: [] },
                devis: devisBanner(),
                update: await updateBanner().catch(() => null),
            });
        }

        // ---- Teams and email: PR review asks, meeting recaps, chat and email summaries (comms.mts) ----
        if (p === "/api/jarvis/comms" && get) {
            return sendJson(res, 200, { status: await commsStatus(), asks: await openAsks() });
        }
        if (p === "/api/jarvis/comms/scan" && post) {
            const last = await scanComms();
            return sendJson(res, 200, { status: await commsStatus(), asks: await openAsks(), last });
        }
        if (p === "/api/jarvis/comms/enabled" && post) {
            const b = await readBody(req);
            return sendJson(res, 200, { status: await setCommsEnabled(b?.enabled, b?.source ?? "teams") });
        }
        if (p === "/api/jarvis/comms/meetings" && get) {
            const status = await commsStatus();
            return sendJson(res, 200, { meetings: await listCommsMeetings(), digest: await meetingsDigest(), status: { ...status.meetings, agency: status.agency } });
        }
        if (p === "/api/jarvis/comms/chats" && get) {
            const status = await commsStatus();
            return sendJson(res, 200, { chats: await listCommsChats(), digest: await chatsDigest(), status: { ...status.chats, readAt: status.last?.at ?? null, agency: status.agency } });
        }
        if (p === "/api/jarvis/comms/mail" && get) {
            const status = await commsStatus();
            return sendJson(res, 200, { mail: await listCommsMail(), digest: await mailDigest(), status: { enabled: status.mail.enabled, last: status.mail.summaries, readAt: status.mail.last?.at ?? null, agency: status.agency } });
        }
        if (p === "/api/jarvis/comms/needs/dismiss" && post) {
            const b = await readBody(req);
            return sendJson(res, 200, { needs: await dismissCommsNeed(b?.key, await openAsks()) });
        }
        if (p === "/api/jarvis/comms/meetings/todo" && post) {
            const b = await readBody(req);
            const todo = await addMeetingTodo(b?.id, b?.index);
            return sendJson(res, 200, { todo, todos: await listTodos() });
        }
        if (p === "/api/jarvis/comms/dismiss" && post) {
            const b = await readBody(req);
            await dismissAsk(b?.id);
            return sendJson(res, 200, { asks: await openAsks() });
        }

        // ---- S360: the user's action items, read once a day (s360.mts) ----
        if (p === "/api/jarvis/s360" && get) {
            return sendJson(res, 200, { items: await listS360Items(), digest: await s360Digest(), status: await s360Status() });
        }
        if (p === "/api/jarvis/s360/scan" && post) {
            const last = await scanS360("now");
            return sendJson(res, 200, { items: await listS360Items(), digest: await s360Digest(), status: await s360Status(), last });
        }
        if (p === "/api/jarvis/s360/enabled" && post) {
            const b = await readBody(req);
            return sendJson(res, 200, { status: await setS360Enabled(b?.enabled), digest: await s360Digest() });
        }
        if (p === "/api/jarvis/s360/needs/dismiss" && post) {
            const b = await readBody(req);
            return sendJson(res, 200, { needs: await dismissS360Need(b?.key), digest: await s360Digest() });
        }

        // ---- the user's notes: to-dos and the quick note ----
        // With the tasks started from them, so the to-dos window can name each one without Today's poll.
        if (p === "/api/jarvis/todos" && get) {
            const todos = await listTodos();
            const ids = [...new Set(todos.flatMap((t) => (t.taskId ? [t.taskId] : [])))];
            const tasks = (await Promise.all(ids.map((id) => getTask(id)))).flatMap((t) => (t ? [{ id: t.id, title: t.title, status: t.status }] : []));
            return sendJson(res, 200, { todos, tasks });
        }
        if (p === "/api/jarvis/todos" && post) {
            const b = await readBody(req);
            const todo = await addTodo(b?.text, "you", b?.source, { parentId: b?.parentId, due: b?.due });
            return sendJson(res, 200, { todo, todos: await listTodos() });
        }
        if (p === "/api/jarvis/todos/update" && post) {
            const b = await readBody(req);
            await updateTodo(b?.id, { text: b?.text, done: b?.done, due: b?.due, priority: b?.priority });
            return sendJson(res, 200, { todos: await listTodos() });
        }
        // Start one task from to-dos, with a worker for each group of them.
        if (p === "/api/jarvis/todos/start" && post) {
            const b = await readBody(req);
            const cfg = await readConfig();
            return sendJson(res, 200, await startTaskFromTodos(b || {}, cfg.organizations, { taskRoot: cfg.taskRoot }));
        }
        if (p === "/api/jarvis/todos/delete" && post) {
            const b = await readBody(req);
            await deleteTodo(b?.id);
            return sendJson(res, 200, { todos: await listTodos() });
        }
        if (p === "/api/jarvis/todos/move" && post) {
            const b = await readBody(req);
            await moveTodo(b?.id, b?.direction);
            return sendJson(res, 200, { todos: await listTodos() });
        }
        if (p === "/api/jarvis/todos/clear-done" && post) {
            await clearDoneTodos();
            return sendJson(res, 200, { todos: await listTodos() });
        }
        if (p === "/api/jarvis/note" && get) {
            return sendJson(res, 200, { note: await getQuickNote() });
        }
        if (p === "/api/jarvis/note" && post) {
            const b = await readBody(req);
            try {
                return sendJson(res, 200, { note: await saveQuickNote(b?.text, b?.base, b?.saveId) });
            } catch (error) {
                // The note changed meanwhile: hand back the current one so the page can merge.
                if (error instanceof JarvisError && error.status === 409) {
                    return sendJson(res, 409, { error: error.message, note: await getQuickNote() });
                }
                throw error;
            }
        }
        if (p === "/api/jarvis/status" && post) {
            const b = await readBody(req);
            return sendJson(res, 200, await postStatus({ taskId: b?.taskId, text: b?.text, author: "you" }));
        }
        // A task's whole timeline, newest first, a page at a time.
        if (p === "/api/jarvis/statuses" && get) {
            const id = requireId(q.get("id"));
            if (!(await getTask(id))) throw new JarvisError("Task not found.", 404);
            const limit = Math.max(1, Math.min(Math.floor(Number(q.get("limit")) || 200), 500));
            const before = Math.floor(Number(q.get("before"))) || undefined;
            const page = await listStatuses({ taskId: id, before, limit: limit + 1 });
            return sendJson(res, 200, { statuses: page.slice(0, limit), hasMore: page.length > limit });
        }
        if (p === "/api/jarvis/overview/refresh" && post) {
            return sendJson(res, 200, { overview: await refreshOverview() });
        }
        if (p === "/api/jarvis/refresh" && post) {
            return sendJson(res, 200, { errors: await refreshTaskWorkItems() });
        }
        if (p === "/api/jarvis/history" && get) {
            const days = Math.max(1, Math.min(Math.floor(Number(q.get("days")) || 7), 90));
            const from = new Date(startOfToday());
            from.setDate(from.getDate() - (days - 1));
            return sendJson(res, 200, { events: await listEvents({ since: from.toISOString(), limit: 1000 }) });
        }

        // ---- tasks ----
        if (p === "/api/jarvis/tasks" && post) {
            const b = await readBody(req);
            const cfg = await readConfig();
            return sendJson(res, 200, await createTaskFromInput(b || {}, cfg.organizations, { taskRoot: cfg.taskRoot, requireFolder: true }));
        }
        if (p === "/api/jarvis/workitem" && get) {
            const cfg = await readConfig();
            return sendJson(res, 200, { item: await previewWorkItem({ workItem: q.get("ref") || "", org: q.get("org") || "" }, cfg.organizations) });
        }
        if (p === "/api/jarvis/workitems" && get) {
            return sendJson(res, 200, await suggestWorkItems(q.get("q") || "", await readConfig()));
        }
        if (p === "/api/jarvis/tasks/update" && post) {
            const b = await readBody(req);
            const status = b?.status === "done" || b?.status === "open" ? b.status : undefined;
            const title = typeof b?.title === "string" ? b.title : undefined;
            const description = typeof b?.description === "string" ? b.description : undefined;
            return sendJson(res, 200, { task: await updateTask(requireId(b?.id), { status, title, description }) });
        }
        // What removing a task or worker would lose: uncommitted changes and unpushed commits in its worktrees.
        if (p === "/api/jarvis/tasks/changes" && get) {
            const sessionId = asJarvisId(q.get("sessionId"));
            const worktrees = sessionId ? await listWorktrees({ sessionId }) : await listWorktrees({ taskId: requireId(q.get("id")) });
            const changes = await Promise.all(worktrees.map((w) => worktreeChanges(w).catch(() => null)));
            return sendJson(res, 200, {
                worktrees: worktrees.length,
                changes: changes.filter((c): c is WorktreeChanges => !!c && (c.uncommitted > 0 || c.unpushed > 0)),
            });
        }
        if (p === "/api/jarvis/tasks/delete" && post) {
            const b = await readBody(req);
            return sendJson(res, 200, { ok: true, ...(await removeTask(b?.id)) });
        }

        // ---- a task's pull requests ----
        if (p === "/api/jarvis/task-prs" && get) {
            return sendJson(res, 200, await taskPrsView(requireId(q.get("id")), { refresh: q.get("refresh") === "1" }));
        }
        if (p === "/api/jarvis/task-prs/link" && post) {
            const b = await readBody(req);
            const id = requireId(b?.id);
            const pr = await linkFromUser(id, b?.pr);
            // Read the new PR's checks and comments now, not at the next minute.
            return sendJson(res, 200, { pr, ...(await taskPrsView(id, { refresh: true })) });
        }
        if (p === "/api/jarvis/task-prs/unlink" && post) {
            const b = await readBody(req);
            await unlinkPr(requireId(b?.id), b?.org, b?.prId);
            return sendJson(res, 200, { ok: true });
        }

        // ---- a task's validation chains ----
        if (p === "/api/jarvis/validation" && get) {
            return sendJson(res, 200, await validationView(requireId(q.get("id"))));
        }
        if (p.startsWith("/api/jarvis/validation/") && post) {
            const b = await readBody(req);
            const action = p.slice("/api/jarvis/validation/".length);
            if (action === "auto") {
                await setAutoPropose(b?.on === true);
                return sendJson(res, 200, { ok: true, autoPropose: b?.on === true });
            }
            const id = requireId(b?.id);
            switch (action) {
                case "attach":
                    return sendJson(res, 200, { chain: await attachChain(id, { from: b?.from, name: b?.name, purpose: b?.purpose }) });
                case "remove":
                    await removeChain(id, b?.chainId);
                    return sendJson(res, 200, { ok: true });
                case "run":
                    // Runs you start from the task: `target` picks whose code chains that follow the runner build.
                    return sendJson(res, 200, {
                        runs: await runChains(id, b?.chainIds ?? b?.chainId, { trigger: YOU_TRIGGER, target: await resolveTarget(id, b?.target) }),
                    });
                case "stop":
                    if (typeof b?.queueId === "string") return sendJson(res, 200, { stopped: await cancelQueued(id, b?.chainId, b.queueId) });
                    return sendJson(res, 200, { stopped: await stopRun(id, b?.runId) });
                case "options":
                    await setChainOptions(id, b?.chainId, {
                        name: b?.name,
                        purpose: b?.purpose,
                        concurrency: b?.concurrency,
                        workersMayRun: b?.workersMayRun,
                        notifyWorker: b?.notifyWorker,
                        rerunOnCommit: b?.rerunOnCommit,
                    });
                    return sendJson(res, 200, { ok: true });
                case "repos":
                    return sendJson(res, 200, await setBlockRepoBranches(id, b?.chainId, b?.nodeId, b?.repoBranches, b?.was));
                case "ack":
                    // Without a run, every failed run the user hasn't looked at.
                    await acknowledgeRun(id, typeof b?.runId === "string" ? b.runId : undefined);
                    return sendJson(res, 200, { ok: true });
                case "reusable":
                    return sendJson(res, 200, { chain: await saveAsReusable(id, b?.chainId) });
                case "accept":
                    if (typeof b?.proposalId !== "string") throw new JarvisError("Say which proposal you reviewed.", 400);
                    return sendJson(res, 200, await acceptProposal(id, { run: b?.run === true, id: b.proposalId, target: b?.target }));
                case "dismiss":
                    if (typeof b?.proposalId !== "string") throw new JarvisError("Say which proposal you reviewed.", 400);
                    await dismissProposal(id, b?.reason, b.proposalId);
                    return sendJson(res, 200, { ok: true });
                case "ask":
                    return sendJson(res, 200, { message: await askForProposal(id) });
            }
        }

        // ---- review comments on a task's PRs ----
        if (p === "/api/jarvis/pr-comments" && get) {
            return sendJson(res, 200, await prCommentsView(requireId(q.get("id"))));
        }
        if (p.startsWith("/api/jarvis/pr-comments/") && post) {
            const b = await readBody(req);
            const action = p.slice("/api/jarvis/pr-comments/".length);
            if (action === "auto") {
                await setPrCommentsAuto(b?.on === true);
                return sendJson(res, 200, { ok: true, auto: b?.on === true });
            }
            const pr = { id: requireId(b?.id), org: b?.org, prId: b?.prId };
            switch (action) {
                case "accept":
                    if (typeof b?.proposalId !== "string") throw new JarvisError("Say which proposal you reviewed.", 400);
                    return sendJson(res, 200, await acceptPrComments({ ...pr, proposalId: b.proposalId, decisions: b?.decisions }));
                case "dismiss":
                    await dismissPrComments({ ...pr, proposalId: b?.proposalId });
                    return sendJson(res, 200, { ok: true });
                case "audit":
                    await auditPrCommentsNow(pr);
                    return sendJson(res, 200, { ok: true });
                case "post":
                    return sendJson(res, 200, { posted: await postAppliedAnyway(pr) });
            }
        }

        // ---- failed builds on a task's PRs ----
        if (p === "/api/jarvis/pr-builds" && get) {
            return sendJson(res, 200, await prBuildsView(requireId(q.get("id"))));
        }
        if (p.startsWith("/api/jarvis/pr-builds/") && post) {
            const b = await readBody(req);
            const pr = { id: requireId(b?.id), org: b?.org, prId: b?.prId };
            switch (p.slice("/api/jarvis/pr-builds/".length)) {
                case "accept":
                    if (typeof b?.proposalId !== "string") throw new JarvisError("Say which proposal you reviewed.", 400);
                    return sendJson(res, 200, await acceptPrBuilds({ ...pr, proposalId: b.proposalId, decisions: b?.decisions }));
                case "dismiss":
                    await dismissPrBuilds({ ...pr, proposalId: b?.proposalId });
                    return sendJson(res, 200, { ok: true });
                case "audit":
                    await auditPrBuildsNow(pr);
                    return sendJson(res, 200, { ok: true });
            }
        }

        // ---- artifacts ----
        if (p === "/api/jarvis/artifacts" && get) {
            const id = requireId(q.get("id"));
            const artifacts = await listArtifacts(id);
            // The Artifacts window names its task in the title bar.
            const title = (await getTask(id))?.title ?? "";
            return sendJson(res, 200, { artifacts, dir: artifactsDir(id), title });
        }
        if (p === "/api/jarvis/artifacts/open-folder" && post) {
            const b = await readBody(req);
            const id = requireId(b?.id);
            if (!(await getTask(id))) throw new JarvisError("Task not found.", 404);
            await openFolder(artifactsDir(id));
            return sendJson(res, 200, { ok: true });
        }
        if (p === "/api/jarvis/artifact" && get) {
            return sendJson(res, 200, { artifact: await readArtifact(requireId(q.get("id")), q.get("name") || "") });
        }
        // An image artifact's bytes, for the Artifacts window's preview. Nothing else is served raw, and
        // the sandbox keeps an SVG opened on its own from running script.
        if (p === "/api/jarvis/artifact/raw" && get) {
            const file = await artifactFile(requireId(q.get("id")), q.get("name") || "");
            const type = artifactImageType(file.name);
            if (!type) throw new JarvisError(`${file.name} isn't an image.`, 415);
            if (file.size > ARTIFACT_IMAGE_MAX) throw new JarvisError(`${file.name} is too large to show.`, 413);
            let bytes: Buffer;
            try {
                bytes = await readFile(file.path);
            } catch {
                throw new JarvisError(`There is no artifact named ${file.name}.`, 404);
            }
            // The page names the version it wants (?v=<modified time and size>), so a cached copy is never stale.
            return sendBuffer(res, 200, bytes, type, {
                "Cache-Control": "private, max-age=31536000, immutable",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
            });
        }
        if (p === "/api/jarvis/artifact/reveal" && post) {
            const b = await readBody(req);
            const file = await artifactFile(requireId(b?.id), b?.name);
            await revealFile(file.path);
            return sendJson(res, 200, { ok: true });
        }
        if (p === "/api/jarvis/artifact" && post) {
            const b = await readBody(req);
            const artifact = await writeArtifact(requireId(b?.id), b?.name, b?.content, {
                base: typeof b?.base === "string" ? b.base : undefined,
                create: b?.create === true,
            });
            return sendJson(res, 200, { artifact });
        }
        if (p === "/api/jarvis/artifact/delete" && post) {
            const b = await readBody(req);
            await deleteArtifact(requireId(b?.id), b?.name);
            return sendJson(res, 200, { ok: true });
        }
        if (p === "/api/jarvis/recap" && post) {
            const b = await readBody(req);
            const id = requireId(b?.id);
            if (await isRemoving(id)) throw new JarvisError("That task is being removed.", 409);
            if (!(await listWorkers(id)).length) throw new JarvisError("Start a worker first: a worker writes the recap.", 409);
            void writeRecap(id, "requested");
            return sendJson(res, 200, { ok: true });
        }

        // ---- changing Devis itself (devis-self.mts) ----
        if (p === "/api/jarvis/devis" && get) {
            return sendJson(res, 200, await devisOverview());
        }
        if (p === "/api/jarvis/devis/settings" && post) {
            const b = await readBody(req);
            await saveDevisSettings({ enabled: b?.enabled, source: b?.source });
            return sendJson(res, 200, await devisOverview());
        }
        if (p === "/api/jarvis/devis/undo" && post) {
            const b = await readBody(req);
            const n = Number(b?.n);
            const { task, worker, workerError } = await startDevisTask(undoTask(n));
            markUndo(n, task.id);
            return sendJson(res, 200, { task, worker, workerError, devis: await devisOverview() });
        }
        if (p === "/api/jarvis/devis/dismiss" && post) {
            const b = await readBody(req);
            dismissShip(Number(b?.n));
            return sendJson(res, 200, await devisOverview());
        }

        // ---- updates from GitHub releases (updates.mts) ----
        if (p === "/api/jarvis/updates" && get) {
            return sendJson(res, 200, await updatesStatus());
        }
        if (p === "/api/jarvis/updates/check" && post) {
            return sendJson(res, 200, await checkForUpdates());
        }
        if (p === "/api/jarvis/updates/settings" && post) {
            const b = await readBody(req);
            return sendJson(res, 200, await saveUpdateSettings({ channel: b?.channel, install: b?.install }));
        }
        if (p === "/api/jarvis/updates/install" && post) {
            const b = await readBody(req);
            return sendJson(res, 200, await installUpdate({ mode: b?.mode, force: b?.force }));
        }
        if (p === "/api/jarvis/updates/dismiss" && post) {
            const b = await readBody(req);
            return sendJson(res, 200, await dismissUpdate(b?.version));
        }
        if (p === "/api/jarvis/updates/bring-in" && post) {
            const b = await readBody(req);
            const { task, worker, workerError } = await startDevisTask(releaseTask(b?.version));
            return sendJson(res, 200, { task, worker, workerError, updates: await updatesStatus() });
        }

        // ---- workers ----
        if (p === "/api/jarvis/workers/start" && post) {
            const b = await readBody(req);
            return sendJson(res, 200, { worker: await startWorker({ taskId: b?.taskId, cwd: b?.cwd, prompt: b?.prompt, model: b?.model, effort: b?.effort }) });
        }
        if (p === "/api/jarvis/workers/ship" && post) {
            const b = await readBody(req);
            await decideShip(b?.sessionId, b?.requestId, b?.decision, b?.note, b?.ack === true);
            return sendJson(res, 200, { ok: true });
        }
        if (p === "/api/jarvis/workers/repos" && post) {
            const b = await readBody(req);
            return sendJson(res, 200, { repos: await confirmRepos(b?.sessionId, b?.requestId, b?.repos) });
        }
        if (p === "/api/jarvis/workers/message" && post) {
            const b = await readBody(req);
            return sendJson(res, 200, { result: await messageWorker(b?.sessionId, b?.text, b?.requestId, b?.mode, b?.images) });
        }
        if (p === "/api/jarvis/workers/queue/remove" && post) {
            const b = await readBody(req);
            await removeQueuedMessage(b?.sessionId, b?.id);
            return sendJson(res, 200, { ok: true });
        }
        if (p === "/api/jarvis/workers/queue/send" && post) {
            const b = await readBody(req);
            return sendJson(res, 200, { result: await sendQueuedNow(b?.sessionId, b?.id) });
        }
        if (p === "/api/jarvis/workers/model" && post) {
            const b = await readBody(req);
            return sendJson(res, 200, await setWorkerModel(b?.sessionId, b?.model, b?.effort));
        }
        if (p === "/api/jarvis/workers/decide" && post) {
            const b = await readBody(req);
            await decidePermission(b?.sessionId, b?.requestId, b?.decision);
            return sendJson(res, 200, { ok: true });
        }
        if (p === "/api/jarvis/workers/stop" && post) {
            const b = await readBody(req);
            await stopWorker(b?.sessionId);
            return sendJson(res, 200, { ok: true });
        }
        if (p === "/api/jarvis/workers/remove" && post) {
            const b = await readBody(req);
            await removeWorker(b?.sessionId);
            return sendJson(res, 200, { ok: true });
        }
        if (p === "/api/jarvis/workers/ide" && post) {
            const b = await readBody(req);
            await openWorkerIde(b?.sessionId, b?.ide);
            return sendJson(res, 200, { ok: true });
        }
        if (p === "/api/jarvis/workers/terminal" && post) {
            const b = await readBody(req);
            await openWorkerTerminal(b?.sessionId);
            return sendJson(res, 200, { ok: true });
        }
        // The code window: what a worker changed, read straight from its worktrees.
        if (p === "/api/jarvis/workers/changes" && get) {
            return sendJson(res, 200, await listWorkerChanges(q.get("sessionId"), q.get("mode")));
        }
        if (p === "/api/jarvis/workers/diff" && get) {
            return sendJson(res, 200, await workerFileDiff(q.get("sessionId"), q.get("repo"), q.get("path"), q.get("mode"), q.get("oldPath")));
        }
        if (p === "/api/jarvis/workers/log" && get) {
            const { events } = await workerTranscript(q.get("sessionId"));
            return sendJson(res, 200, { messages: chatMessagesFromEvents(events as never) });
        }
        if (p === "/api/jarvis/workers/live" && get) {
            return sendJson(res, 200, { live: await workerTurnView(q.get("sessionId")) });
        }
        if (p === "/api/jarvis/workers/commands" && get) {
            return sendJson(res, 200, { commands: await listWorkerCommands(q.get("sessionId")) });
        }
        if (p === "/api/jarvis/workers/command" && post) {
            const b = await readBody(req);
            return sendJson(res, 200, { outcome: await runWorkerCommand(b?.sessionId, b?.text) });
        }

        // ---- the codebase: repos workers get worktrees of, cloned under the Jarvis folder ----
        if (p === "/api/jarvis/codebase" && get) {
            return sendJson(res, 200, { repos: await codebaseStatus(), dir: codebaseDir() });
        }
        if (p === "/api/jarvis/codebase/sync" && post) {
            return sendJson(res, 200, { repos: await syncCodebase(), dir: codebaseDir() });
        }
        // Live from Azure DevOps, for Settings' repo picker.
        if (p === "/api/jarvis/ado/projects" && get) {
            const org = (q.get("org") || "").trim();
            if (!org) throw new JarvisError("Choose an organization.");
            return sendJson(res, 200, { projects: await listProjects(org) });
        }
        if (p === "/api/jarvis/ado/repos" && get) {
            const org = (q.get("org") || "").trim();
            const project = (q.get("project") || "").trim();
            if (!org || !project) throw new JarvisError("Choose an organization and a project.");
            return sendJson(res, 200, { repos: await listRepositories(org, project) });
        }

        // ---- images pasted into a chat ----
        if (p === "/api/jarvis/images" && post) {
            const b = await readBody(req);
            return sendJson(res, 200, { image: await saveImage(b) });
        }
        if (p.startsWith("/api/jarvis/images/") && get) {
            return await serveImage(res, decodeURIComponent(p.slice("/api/jarvis/images/".length)));
        }

        // ---- the Lead ----
        if (p === "/api/jarvis/lead" && get) {
            return sendJson(res, 200, await getLeadChat());
        }
        if (p === "/api/jarvis/lead" && post) {
            const b = await readBody(req);
            return sendJson(res, 200, await sendLead(b?.text, b?.mode, b?.images));
        }
        if (p === "/api/jarvis/lead/stop" && post) {
            await stopLead();
            return sendJson(res, 200, { ok: true });
        }
        if (p === "/api/jarvis/lead/queue/remove" && post) {
            const b = await readBody(req);
            removeLeadQueued(b?.id);
            return sendJson(res, 200, { ok: true });
        }
        if (p === "/api/jarvis/lead/queue/send" && post) {
            const b = await readBody(req);
            return sendJson(res, 200, await sendLeadQueuedNow(b?.id));
        }
        if (p === "/api/jarvis/lead/terminal" && post) {
            await openLeadTerminal();
            return sendJson(res, 200, { ok: true });
        }
        if (p === "/api/jarvis/lead/new" && post) {
            await resetLead();
            return sendJson(res, 200, { ok: true });
        }
        if (p === "/api/jarvis/lead/model" && post) {
            const b = await readBody(req);
            return sendJson(res, 200, await setLeadModel(b?.model, b?.effort));
        }

        if (p === "/api/jarvis/lead/commands" && get) {
            return sendJson(res, 200, { commands: await listLeadCommands() });
        }
        if (p === "/api/jarvis/lead/command" && post) {
            const b = await readBody(req);
            return sendJson(res, 200, { outcome: await runLeadCommand(b?.text) });
        }

        return sendJson(res, 404, { error: "no such endpoint" });
    } catch (e) {
        if (e instanceof JarvisError) return sendJson(res, e.status, { error: e.message });
        if (e instanceof BodyTooLargeError) return sendJson(res, e.status, { error: e.message });
        return sendJson(res, 500, { error: (e as Error).message || String(e) });
    }
}
