// ADO REST client for the ado-pr-ops canvas.
// Auth: local user's credential via `az account get-access-token` (no PAT).
// Dependency-free: node built-ins only.

import https from "node:https";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import { getAzToken } from "./azauth.mjs";
import {
    mapRepositoryResources,
    mapRunParameters,
    pipelineRunBody,
    runToBuild,
    type BuildInfo,
    type PipelineResource,
    type RepositoryResource,
    type ResourcePin,
    type RunParameter,
} from "./pipeline-graph.mjs";
import {
    buildLifecyclePatch,
    type CompletionOptionsInput,
    type LifecycleAction,
    type ThreadStatus,
    type Vote,
} from "./pr-actions.mjs";

const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"; // Azure DevOps app id
const API = "api-version=7.1";

// ---------------------------------------------------------------------------
// Shared data shapes (also mirrored, independently, by the frontend)
// ---------------------------------------------------------------------------
export interface Me {
    id: string;
    name: string;
}

// One reviewer's standing on a PR. `vote` follows ADO's scale:
//   10 approved · 5 approved with suggestions · 0 no vote · -5 waiting · -10 rejected
export interface Reviewer {
    id: string;
    name: string;
    vote: number;
    isRequired: boolean;
    isContainer: boolean; // true = a group/team entry, not an individual
}

export interface Pr {
    org: string;
    id: number;
    mine: boolean;
    authoredByMe: boolean; // I created this PR (a stronger signal than a reviewer match)
    title: string;
    project: string | undefined;
    repo: string | undefined;
    repoId: string | undefined;
    author: string | undefined;
    authorId: string | undefined;
    created: string;
    isDraft: boolean | undefined;
    status: string | undefined; // active | completed | abandoned
    reviewers: Reviewer[];
    myVote: number; // current user's own vote (0 when not an individual reviewer)
    iCommented: boolean; // current user left at least one non-system comment
    plateDismissed?: boolean; // populated by the API from the local preference store
    sourceRef: string;
    targetRef: string;
    url: string;
    headCommit?: string; // the source branch's latest commit, which changes on every push
    pushedAt?: string | null; // last push, filled from the pr-recency cache
    myAt?: string | null; // my last comment or vote, filled from the pr-recency cache
    myKind?: "comment" | "vote" | null;
}

export interface ThreadComment {
    id: number;
    author: string;
    authorId?: string;
    content: string;
    parentCommentId: number;
    published: string | undefined;
}

/** A flattened PR comment carrying the fields the inbox needs to derive events.
 *  `threadId` gives each comment a stable (org, project, repoId, prId, threadId,
 *  id) identity — ADO comment ids are only unique *within* a thread, so the bare
 *  id alone can collide across PRs/threads and must never be used as a
 *  notification key by itself. */
export interface InboxComment {
    id: number;
    threadId: number;
    authorId: string | undefined;
    authorName: string;
    content: string;
    parentCommentId: number;
    published: string | undefined;
    commentType: string | undefined;
}

export interface Thread {
    id: number;
    status: string;
    filePath: string | null;
    line: number | null;
    endLine: number | null;
    side: "right" | "left" | null;
    comments: ThreadComment[];
}

export interface FileEntry {
    path: string;
    changeType: string;
}

export interface Commits {
    source?: string;
    base?: string;
    iteration?: number;
}

export interface PrDetail {
    description: string;
    files: FileEntry[];
    threads: Thread[];
    commits: Commits;
    status: string | undefined; // active | completed | abandoned
    isDraft: boolean | undefined;
    reviewers: Reviewer[];
    myVote: number; // current user's own vote (0 when not an individual reviewer)
    iCommented: boolean; // current user left at least one (non-system) comment
    autoCompleteSetBy?: string; // display name of whoever enabled auto-complete
    completionOptions?: {
        mergeStrategy?: string;
        deleteSourceBranch?: boolean;
        transitionWorkItems?: boolean;
        mergeCommitMessage?: string;
    };
}

export interface DiffOp {
    t: "ctx" | "del" | "add";
    text: string;
    o: number | null;
    nn: number | null;
}

export type Hunk = DiffOp[];

export interface Diff {
    hunks?: Hunk[];
    tooLarge?: boolean;
    oldCount?: number;
    newCount?: number;
}

export interface CreateThreadInput {
    filePath: string;
    line: number | string;
    endLine?: number | string | null;
    side?: string | null;
    content: string;
}

// ---------------------------------------------------------------------------
// Token acquisition — delegated to the shared az-login helper (azauth.mts)
// ---------------------------------------------------------------------------
const getToken = (): Promise<string> => getAzToken(ADO_RESOURCE);

/** An Azure DevOps access token from the az login, for git over HTTPS. */
export const getAdoToken = getToken;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
interface RawResponse {
    status: number;
    headers: IncomingHttpHeaders;
    text: string;
}

interface RawOptions {
    token?: string;
    accept?: string;
    body?: unknown;
}

// Socket-idle limit for one ADO call: a stalled request would otherwise hold its
// caller (and the UI spinner waiting on it) forever.
const REQUEST_TIMEOUT_MS = 120_000;
/** The largest ADO response read into memory; anything bigger is cut off with an error. */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

function rawRequest(method: string, url: string, opts: RawOptions = {}, retried = false): Promise<RawResponse> {
    const { token, accept, body } = opts;
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const payload = body != null ? Buffer.from(JSON.stringify(body)) : null;
        const headers: OutgoingHttpHeaders = {
            Authorization: `Bearer ${token}`,
            Accept: accept || "application/json",
        };
        if (payload) {
            headers["Content-Type"] = "application/json";
            headers["Content-Length"] = payload.length;
        }
        const req = https.request(
            u,
            { method, headers },
            (res) => {
                const chunks: Buffer[] = [];
                let size = 0;
                res.on("data", (c: Buffer) => {
                    size += c.length;
                    if (size > MAX_RESPONSE_BYTES) {
                        chunks.length = 0;
                        req.destroy(new Error(`ADO ${method} response is larger than ${MAX_RESPONSE_BYTES / 1024 / 1024} MB`));
                        return;
                    }
                    chunks.push(c);
                });
                res.on("error", reject);
                res.on("end", () =>
                    resolve({
                        status: res.statusCode || 0,
                        headers: res.headers,
                        text: Buffer.concat(chunks).toString("utf8"),
                    }),
                );
            },
        );
        req.setTimeout(REQUEST_TIMEOUT_MS, () =>
            req.destroy(new Error(`ADO ${method} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`)),
        );
        req.on("error", (err: NodeJS.ErrnoException) => {
            // The server may close an idle keep-alive socket just as we reuse it.
            // A GET is safe to replay once on a fresh socket; writes never are.
            if (!retried && method === "GET" && req.reusedSocket && err.code === "ECONNRESET") {
                rawRequest(method, url, opts, true).then(resolve, reject);
                return;
            }
            reject(err);
        });
        if (payload) req.write(payload);
        req.end();
    });
}

async function adoJson(method: string, url: string, body?: unknown): Promise<any> {
    const token = await getToken();
    const r = await rawRequest(method, url, { token, body });
    if (r.status < 200 || r.status >= 300) {
        throw new Error(`ADO ${method} ${r.status}: ${r.text.slice(0, 500)}`);
    }
    return r.text ? JSON.parse(r.text) : null;
}

async function adoText(url: string): Promise<string | null> {
    const token = await getToken();
    const r = await rawRequest("GET", url, { token, accept: "text/plain" });
    if (r.status === 404) return null; // added/deleted file has no content on one side
    if (r.status < 200 || r.status >= 300) {
        throw new Error(`ADO GET(text) ${r.status}: ${r.text.slice(0, 300)}`);
    }
    // ADO returns JSON metadata if it thinks the client wants it; guard against that.
    const ct = r.headers["content-type"] || "";
    if (ct.includes("application/json") && r.text.startsWith("{")) {
        try {
            const j = JSON.parse(r.text);
            return typeof j.content === "string" ? j.content : r.text;
        } catch {
            return r.text;
        }
    }
    return r.text;
}

const enc = encodeURIComponent;
const orgBase = (org: string): string => `https://dev.azure.com/${enc(org)}`;
const repoBase = (org: string, project: string, repoId: string): string =>
    `${orgBase(org)}/${enc(project)}/_apis/git/repositories/${enc(repoId)}`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
const _meCache = new Map<string, Me>(); // org -> { id, name }

export async function getMe(org: string): Promise<Me> {
    const cached = _meCache.get(org);
    if (cached) return cached;
    const cd = await adoJson(
        "GET",
        `${orgBase(org)}/_apis/connectionData?api-version=7.1-preview`,
    );
    const u = cd.authenticatedUser || {};
    const me: Me = { id: u.id, name: u.providerDisplayName || u.customDisplayName || "me" };
    _meCache.set(org, me);
    const account = u.properties?.Account?.$value;
    _accountCache.set(org, typeof account === "string" && account ? account : null);
    return me;
}

const _accountCache = new Map<string, string | null>(); // org -> sign-in name, like you@contoso.com

/** The signed-in user's account name in the org (usually their email), or null when ADO doesn't say. */
export async function getMyAccount(org: string): Promise<string | null> {
    if (!_accountCache.has(org)) {
        _meCache.delete(org);
        await getMe(org);
    }
    return _accountCache.get(org) || null;
}

/** The org's projects, by name. */
export async function listProjects(org: string): Promise<string[]> {
    const names: string[] = [];
    let skip = 0;
    for (let page = 0; page < 20; page++) {
        const data = await adoJson("GET", `${orgBase(org)}/_apis/projects?$top=500&$skip=${skip}&stateFilter=wellFormed&${API}`);
        const value: any[] = data?.value || [];
        for (const p of value) if (typeof p?.name === "string") names.push(p.name);
        if (value.length < 500) break;
        skip += value.length;
    }
    return names.sort((a, b) => a.localeCompare(b));
}

export interface RepoInfo {
    name: string;
    defaultBranch: string | null;
    size: number;
    disabled: boolean;
}

/** A project's git repositories, by name. */
export async function listRepositories(org: string, project: string): Promise<RepoInfo[]> {
    const data = await adoJson("GET", `${orgBase(org)}/${enc(project)}/_apis/git/repositories?${API}`);
    return ((data?.value || []) as any[])
        .filter((r) => typeof r?.name === "string")
        .map((r) => ({
            name: r.name as string,
            defaultBranch: typeof r.defaultBranch === "string" ? r.defaultBranch.replace(/^refs\/heads\//, "") : null,
            size: typeof r.size === "number" ? r.size : 0,
            disabled: !!r.isDisabled,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** The URL `git clone` takes for a repo. */
export function repoCloneUrl(org: string, project: string, repo: string): string {
    return `${orgBase(org)}/${enc(project)}/_git/${enc(repo)}`;
}

// Normalize the reviewer list off a raw ADO PR record.
function mapReviewers(pr: any): Reviewer[] {
    return ((pr.reviewers || []) as any[]).map((r) => ({
        id: r.id,
        name: r.displayName || "unknown",
        vote: typeof r.vote === "number" ? r.vote : 0,
        isRequired: !!r.isRequired,
        isContainer: !!r.isContainer,
    }));
}

// The current user's own vote, matched by id (0 when not an individual reviewer).
function myVoteOf(reviewers: Reviewer[], meId: string | undefined): number {
    if (!meId) return 0;
    const mine = reviewers.find((r) => r.id === meId);
    return mine ? mine.vote : 0;
}

// Shape one raw ADO PR record into our Pr, tagging whether it is assigned to me
// and whether I authored it (folded into `mine` so both count as "Me" in the UI).
function mapPr(org: string, pr: any, mine: boolean, meId: string | undefined): Pr {
    const reviewers = mapReviewers(pr);
    const authoredByMe = !!meId && pr.createdBy?.id === meId;
    return {
        org,
        id: pr.pullRequestId,
        mine: mine || authoredByMe,
        authoredByMe,
        title: pr.title,
        project: pr.repository?.project?.name,
        repo: pr.repository?.name,
        repoId: pr.repository?.id,
        author: pr.createdBy?.displayName,
        authorId: pr.createdBy?.id,
        created: pr.creationDate,
        isDraft: pr.isDraft,
        status: pr.status,
        reviewers,
        myVote: myVoteOf(reviewers, meId),
        iCommented: false,
        sourceRef: (pr.sourceRefName || "").replace("refs/heads/", ""),
        targetRef: (pr.targetRefName || "").replace("refs/heads/", ""),
        url: `${orgBase(org)}/${enc(pr.repository?.project?.name || "")}/_git/${enc(
            pr.repository?.name || "",
        )}/pullrequest/${pr.pullRequestId}`,
        headCommit: typeof pr.lastMergeSourceCommit?.commitId === "string" ? pr.lastMergeSourceCommit.commitId : undefined,
    };
}

/** Whether `meId` authored any non-system comment on the PR (one threads fetch). */
export async function hasCommentedOnPr(pr: Pr, meId: string): Promise<boolean> {
    if (!pr.project || !pr.repoId) return false;
    const base = `${repoBase(pr.org, pr.project, pr.repoId)}/pullRequests/${pr.id}`;
    const data = await adoJson("GET", `${base}/threads?${API}`);
    return ((data.value || []) as any[]).some((t) =>
        ((t.comments || []) as any[]).some(
            (c) => c.commentType !== "system" && c.author?.id === meId,
        ),
    );
}

// All active PRs where the current user is a reviewer OR the author, for one org
// (two parallel calls, merged and deduped — a PR can match both).
export async function listAssignedPRs(org: string): Promise<Pr[]> {
    const me = await getMe(org);
    const base = `${orgBase(org)}/_apis/git/pullrequests`;
    const q = `searchCriteria.status=active&$top=200&${API}`;
    const [reviewerData, authoredData] = await Promise.all([
        adoJson("GET", `${base}?searchCriteria.reviewerId=${me.id}&${q}`),
        adoJson("GET", `${base}?searchCriteria.creatorId=${me.id}&${q}`),
    ]);
    const reviewerIds = new Set(
        ((reviewerData.value || []) as any[]).map((pr) => pr.pullRequestId),
    );
    const byId = new Map<number, any>();
    for (const pr of (reviewerData.value || []) as any[]) byId.set(pr.pullRequestId, pr);
    for (const pr of (authoredData.value || []) as any[]) byId.set(pr.pullRequestId, pr);
    const prs = [...byId.values()].map((pr) =>
        mapPr(org, pr, reviewerIds.has(pr.pullRequestId), me.id),
    );
    return prs;
}

// All active PRs in one (org, project), each tagged `mine` when the current user
// is a reviewer OR the author. Two parallel project-scoped calls: the full active
// set, plus the reviewer=me subset (ADO expands group/team reviewers server-side,
// so a PR assigned to me via a group is still correctly flagged `mine`) — the
// full set already contains PRs I authored, so mapPr folds those in too.
export async function listActivePRs(org: string, project: string): Promise<Pr[]> {
    const me = await getMe(org);
    const base = `${orgBase(org)}/${enc(project)}/_apis/git/pullrequests`;
    const q = `searchCriteria.status=active&$top=${ACTIVE_PR_PAGE}&${API}`;
    const [allData, mineData] = await Promise.all([
        adoJson("GET", `${base}?${q}`),
        adoJson("GET", `${base}?searchCriteria.reviewerId=${me.id}&${q}`),
    ]);
    const mineIds = new Set(((mineData.value || []) as any[]).map((pr) => pr.pullRequestId));
    const prs = ((allData.value || []) as any[]).map((pr) =>
        mapPr(org, pr, mineIds.has(pr.pullRequestId), me.id),
    );
    return prs;
}

/** Resolve one PR directly for a canvas deep-link, independent of list filters. */
export async function getPrSummary(
    org: string,
    project: string,
    repoId: string,
    prId: string | number,
): Promise<Pr> {
    const [me, raw] = await Promise.all([
        getMe(org),
        adoJson("GET", `${repoBase(org, project, repoId)}/pullRequests/${prId}?${API}`),
    ]);
    if (
        !raw ||
        typeof raw.pullRequestId !== "number" ||
        !raw.repository ||
        typeof raw.repository.id !== "string"
    ) {
        throw new Error("ADO returned an invalid PR summary");
    }
    const assignedDirectly = ((raw.reviewers || []) as any[]).some((r) => r.id === me.id);
    return mapPr(org, raw, assignedDirectly, me.id);
}

/** How many active PRs listActivePRs reads per project; a full page means there are older ones. */
export const ACTIVE_PR_PAGE = 200;
const OLDER_PR_PAGE = 100;

/** The next page of a project's active PRs past the first `skip`, for loading older PRs on demand. */
export async function listOlderActivePRs(org: string, project: string, skip: number): Promise<{ prs: Pr[]; more: boolean }> {
    const me = await getMe(org);
    const base = `${orgBase(org)}/${enc(project)}/_apis/git/pullrequests`;
    const data = await adoJson(
        "GET",
        `${base}?searchCriteria.status=active&$top=${OLDER_PR_PAGE}&$skip=${Math.max(0, Math.floor(skip))}&${API}`,
    );
    const value = (data?.value || []) as any[];
    // Without the reviewer=me query, only a direct assignment marks a PR mine.
    const prs = value.map((pr) =>
        mapPr(org, pr, ((pr.reviewers || []) as any[]).some((r) => r.id === me.id), me.id),
    );
    return { prs, more: value.length >= OLDER_PR_PAGE };
}

/** A PR's raw comment threads, system threads included. */
export async function getPrThreadsRaw(pr: Pr): Promise<any[]> {
    if (!pr.project || !pr.repoId) return [];
    const data = await adoJson("GET", `${repoBase(pr.org, pr.project, pr.repoId)}/pullRequests/${pr.id}/threads?${API}`);
    return (data?.value || []) as any[];
}

/** When the PR's latest iteration (push) was created, in epoch ms, or null. */
export async function getPrLastPushAt(pr: Pr): Promise<number | null> {
    if (!pr.project || !pr.repoId) return null;
    const data = await adoJson("GET", `${repoBase(pr.org, pr.project, pr.repoId)}/pullRequests/${pr.id}/iterations?${API}`);
    let latest: number | null = null;
    for (const it of (data?.value || []) as any[]) {
        const at = Date.parse(it?.createdDate);
        if (Number.isFinite(at) && (latest == null || at > latest)) latest = at;
    }
    return latest;
}

// All active PRs the current user AUTHORED, for one org (the set where peer
// comments matter most — used by the notification inbox poll).
export async function listAuthoredPRs(org: string): Promise<Pr[]> {
    const me = await getMe(org);
    const base = `${orgBase(org)}/_apis/git/pullrequests`;
    const q = `searchCriteria.status=active&searchCriteria.creatorId=${me.id}&$top=100&${API}`;
    const data = await adoJson("GET", `${base}?${q}`);
    return ((data.value || []) as any[]).map((pr) => mapPr(org, pr, false, me.id));
}

// Flatten a PR's comment threads into a single comment list carrying author id,
// timestamp, and type — the raw material the inbox diffs against its watermark.
export async function getPrThreads(
    org: string,
    project: string,
    repoId: string,
    prId: string | number,
): Promise<InboxComment[]> {
    const base = `${repoBase(org, project, repoId)}/pullRequests/${prId}`;
    const data = await adoJson("GET", `${base}/threads?${API}`);
    const out: InboxComment[] = [];
    for (const t of (data.value || []) as any[]) {
        for (const c of (t.comments || []) as any[]) {
            out.push({
                id: c.id,
                threadId: t.id,
                authorId: c.author?.id,
                authorName: c.author?.displayName || "unknown",
                content: c.content || "",
                parentCommentId: c.parentCommentId || 0,
                published: c.publishedDate,
                commentType: c.commentType,
            });
        }
    }
    return out;
}

// PR detail: changed files (latest iteration) + threads (comments). Diffs are lazy.
export async function getPrDetail(org: string, project: string, repoId: string, prId: string | number): Promise<PrDetail> {
    const base = `${repoBase(org, project, repoId)}/pullRequests/${prId}`;
    // Identity + PR object (description, status, reviewers) + iterations, in parallel.
    const [me, prObj, iters] = await Promise.all([
        getMe(org),
        adoJson("GET", `${base}?${API}`).catch(() => null),
        adoJson("GET", `${base}/iterations?${API}`),
    ]);
    const description = (prObj && prObj.description) || "";
    const reviewers = prObj ? mapReviewers(prObj) : [];
    const status: string | undefined = prObj?.status;
    const isDraft: boolean | undefined = prObj?.isDraft;
    const myVote = myVoteOf(reviewers, me.id);
    const autoCompleteSetBy: string | undefined = prObj?.autoCompleteSetBy?.displayName || undefined;
    const completionOptions = prObj?.completionOptions
        ? {
              mergeStrategy: prObj.completionOptions.mergeStrategy,
              deleteSourceBranch: prObj.completionOptions.deleteSourceBranch,
              transitionWorkItems: prObj.completionOptions.transitionWorkItems,
              mergeCommitMessage: prObj.completionOptions.mergeCommitMessage,
          }
        : undefined;
    const last = (iters.value || [])[iters.value.length - 1];
    if (!last)
        return {
            description, files: [], threads: [], commits: {},
            status, isDraft, reviewers, myVote, iCommented: false,
            autoCompleteSetBy, completionOptions,
        };
    const src = last.sourceRefCommit?.commitId;
    const mbase = last.commonRefCommit?.commitId;

    const changesData = await adoJson(
        "GET",
        `${base}/iterations/${last.id}/changes?${API}`,
    );
    const files: FileEntry[] = ((changesData.changeEntries || []) as any[])
        .filter((c) => c.item && c.item.path && !c.item.isFolder)
        .map((c) => ({ path: c.item.path, changeType: c.changeType }));

    const threadsData = await adoJson("GET", `${base}/threads?${API}`);
    // "I commented" = the current user authored at least one non-system comment.
    const iCommented = ((threadsData.value || []) as any[]).some((t) =>
        ((t.comments || []) as any[]).some(
            (c) => c.commentType !== "system" && c.author?.id === me.id,
        ),
    );
    const threads: Thread[] = ((threadsData.value || []) as any[])
        .map((t) => normalizeThread(t))
        .filter((t) => t.comments.length > 0);

    return {
        description,
        files,
        threads,
        commits: { source: src, base: mbase, iteration: last.id },
        status,
        isDraft,
        reviewers,
        myVote,
        iCommented,
        autoCompleteSetBy,
        completionOptions,
    };
}

function normalizeThread(t: any): Thread {
    const ctx = t.threadContext || {};
    const comments: ThreadComment[] = ((t.comments || []) as any[])
        .filter((c) => c.commentType !== "system")
        .filter((c) => (c.content || "").trim().length > 0)
        .map((c) => ({
            id: c.id,
            author: c.author?.displayName || "unknown",
            authorId: c.author?.id,
            content: c.content || "",
            parentCommentId: c.parentCommentId || 0,
            published: c.publishedDate,
        }));
    return {
        id: t.id,
        status: t.status || "active",
        filePath: ctx.filePath || null,
        line:
            ctx.rightFileStart?.line ??
            ctx.leftFileStart?.line ??
            null,
        endLine:
            ctx.rightFileEnd?.line ??
            ctx.leftFileEnd?.line ??
            null,
        side: ctx.rightFileStart ? "right" : ctx.leftFileStart ? "left" : null,
        comments,
    };
}

// Lazy per-file diff: fetch both sides and compute a line diff with context folding.
export async function getFileDiff(
    org: string,
    project: string,
    repoId: string,
    path: string,
    srcCommit: string,
    baseCommit: string,
    changeType: string,
): Promise<Diff> {
    const itemUrl = (commit: string): string =>
        `${repoBase(org, project, repoId)}/items?path=${enc(path)}` +
        `&versionDescriptor.version=${commit}` +
        `&versionDescriptor.versionType=commit&${API}`;

    let oldText = "";
    let newText = "";
    const ct = (changeType || "").toLowerCase();
    if (!ct.includes("add") && baseCommit) oldText = (await adoText(itemUrl(baseCommit))) || "";
    if (!ct.includes("delete") && srcCommit) newText = (await adoText(itemUrl(srcCommit))) || "";

    const MAX = 6000; // keep it light; huge files fall back to a notice
    const oldLines = oldText.length ? oldText.split(/\r?\n/) : [];
    const newLines = newText.length ? newText.split(/\r?\n/) : [];
    if (oldLines.length > MAX || newLines.length > MAX) {
        return { tooLarge: true, oldCount: oldLines.length, newCount: newLines.length };
    }
    return { hunks: diffLines(oldLines, newLines) };
}

/** The raw ADO comment JSON returned by a POST /comments call. Field names
 *  mirror ADO's wire shape exactly (the web client already reads them that
 *  way); `author.id` is what lets the inbox attribute the new comment to the
 *  current user without a second round-trip. */
export interface PostedComment {
    id: number;
    author?: { id?: string; displayName?: string };
    publishedDate?: string;
    parentCommentId?: number;
    content?: string;
    commentType?: string;
}

export async function postReply(
    org: string,
    project: string,
    repoId: string,
    prId: string | number,
    threadId: string | number,
    content: string,
    parentCommentId: number,
): Promise<PostedComment> {
    const url =
        `${repoBase(org, project, repoId)}/pullRequests/${prId}` +
        `/threads/${threadId}/comments?${API}`;
    const body = { content, parentCommentId: parentCommentId || 0, commentType: "text" };
    return adoJson("POST", url, body);
}

// Create a new line-anchored thread on a PR (a fresh code comment).
export async function createThread(
    org: string,
    project: string,
    repoId: string,
    prId: string | number,
    { filePath, line, endLine, side, content }: CreateThreadInput,
): Promise<Thread> {
    const url =
        `${repoBase(org, project, repoId)}/pullRequests/${prId}/threads?${API}`;
    const ln = Number(line);
    const lnEnd = endLine != null ? Number(endLine) : ln;
    const start = { line: ln, offset: 1 };
    const end = { line: lnEnd, offset: 1 };
    const threadContext: {
        filePath: string;
        leftFileStart?: { line: number; offset: number };
        leftFileEnd?: { line: number; offset: number };
        rightFileStart?: { line: number; offset: number };
        rightFileEnd?: { line: number; offset: number };
    } = { filePath };
    if (side === "left") {
        threadContext.leftFileStart = start;
        threadContext.leftFileEnd = end;
    } else {
        threadContext.rightFileStart = start;
        threadContext.rightFileEnd = end;
    }
    const body = {
        comments: [{ parentCommentId: 0, content, commentType: "text" }],
        status: "active",
        threadContext,
    };
    const created = await adoJson("POST", url, body);
    return normalizeThread(created);
}

/** Create a PR-level thread without attaching it to a file or diff line. */
export async function createGeneralThread(
    org: string,
    project: string,
    repoId: string,
    prId: string | number,
    content: string,
): Promise<Thread> {
    const url =
        `${repoBase(org, project, repoId)}/pullRequests/${prId}/threads?${API}`;
    const created = await adoJson("POST", url, {
        comments: [{ parentCommentId: 0, content, commentType: "text" }],
        status: "active",
    });
    return normalizeThread(created);
}

/** Resolve or reactivate a comment thread. */
export async function updateThreadStatus(
    org: string,
    project: string,
    repoId: string,
    prId: string | number,
    threadId: string | number,
    status: ThreadStatus | "wontFix" | "byDesign" | "closed",
): Promise<{ id: number; status: string }> {
    const url = `${repoBase(org, project, repoId)}/pullRequests/${enc(String(prId))}/threads/${enc(String(threadId))}?${API}`;
    const updated = await adoJson("PATCH", url, { status });
    return { id: updated?.id ?? Number(threadId), status: updated?.status || status };
}

/** Cast the current user's vote; ADO adds them as a reviewer if needed. */
export async function setMyVote(
    org: string,
    project: string,
    repoId: string,
    prId: string | number,
    vote: Vote,
): Promise<{ vote: number }> {
    const me = await getMe(org);
    const url = `${repoBase(org, project, repoId)}/pullRequests/${enc(String(prId))}/reviewers/${enc(me.id)}?${API}`;
    const updated = await adoJson("PUT", url, { vote });
    return { vote: typeof updated?.vote === "number" ? updated.vote : vote };
}

/** Complete, auto-complete, draft, abandon, or reactivate a PR. */
export async function updatePrLifecycle(
    org: string,
    project: string,
    repoId: string,
    prId: string | number,
    action: LifecycleAction,
    options?: CompletionOptionsInput,
): Promise<{ status?: string; isDraft?: boolean }> {
    const url = `${repoBase(org, project, repoId)}/pullRequests/${enc(String(prId))}?${API}`;
    const me = await getMe(org);
    // Completing must name the exact source commit the user saw, so ADO refuses a stale merge.
    const lastMergeSourceCommit =
        action === "complete" ? (await adoJson("GET", url))?.lastMergeSourceCommit?.commitId : undefined;
    const body = buildLifecyclePatch(action, { options, lastMergeSourceCommit, meId: me.id });
    const updated = await adoJson("PATCH", url, body);
    return { status: updated?.status, isDraft: updated?.isDraft };
}

// ---------------------------------------------------------------------------
// Build pipelines (definitions + builds) for pipeline chains
// ---------------------------------------------------------------------------
export interface PipelineDefinition {
    org: string;
    project: string;
    id: number;
    name: string;
    path: string;
    url: string;
    queueStatus: "enabled" | "paused" | "disabled";
    latest: { status?: string; result?: string; buildNumber?: string; finishTime?: string } | null;
}

const QUEUE_STATUS = ["enabled", "paused", "disabled"] as const;
const MAX_DEFINITION_PAGES = 5;

function mapBuild(b: any): BuildInfo {
    return {
        id: Number(b?.id),
        buildNumber: b?.buildNumber,
        status: b?.status,
        result: b?.result,
        url: b?._links?.web?.href,
        startTime: b?.startTime,
        finishTime: b?.finishTime,
    };
}

function mapDefinition(org: string, project: string, d: any): PipelineDefinition {
    const raw = d.queueStatus;
    const queueStatus = typeof raw === "number" ? (QUEUE_STATUS[raw] ?? "enabled") : QUEUE_STATUS.includes(raw) ? raw : "enabled";
    const latest = d.latestCompletedBuild || d.latestBuild;
    return {
        org,
        project,
        id: Number(d.id),
        name: String(d.name || `Pipeline ${d.id}`),
        path: String(d.path || "\\"),
        url: d._links?.web?.href || `${orgBase(org)}/${enc(project)}/_build?definitionId=${enc(String(d.id))}`,
        queueStatus,
        latest: latest
            ? {
                  status: latest.status,
                  result: latest.result,
                  buildNumber: latest.buildNumber,
                  finishTime: latest.finishTime,
              }
            : null,
    };
}

/** Build definitions in one project, name-sorted, following continuation tokens. */
export async function listBuildDefinitions(org: string, project: string): Promise<PipelineDefinition[]> {
    const token = await getToken();
    const base =
        `${orgBase(org)}/${enc(project)}/_apis/build/definitions?${API}` +
        "&queryOrder=definitionNameAscending&includeLatestBuilds=true&$top=1000";
    const out: PipelineDefinition[] = [];
    let continuation = "";
    for (let page = 0; page < MAX_DEFINITION_PAGES; page++) {
        const url = continuation ? `${base}&continuationToken=${enc(continuation)}` : base;
        const r = await rawRequest("GET", url, { token });
        if (r.status < 200 || r.status >= 300) throw new Error(`ADO GET ${r.status}: ${r.text.slice(0, 500)}`);
        const data = r.text ? JSON.parse(r.text) : {};
        for (const d of (data.value || []) as any[]) out.push(mapDefinition(org, project, d));
        const next = r.headers["x-ms-continuationtoken"];
        continuation = (Array.isArray(next) ? next[0] : next) || "";
        if (!continuation) break;
    }
    return out;
}

const buildsBase = (org: string, project: string): string => `${orgBase(org)}/${enc(project)}/_apis/build/builds`;

/** Queue a build of one definition; a blank branch uses the pipeline's default. */
export async function queueBuild(
    org: string,
    project: string,
    definitionId: number,
    sourceBranch?: string,
): Promise<BuildInfo> {
    const body: Record<string, unknown> = { definition: { id: definitionId } };
    if (sourceBranch) body.sourceBranch = sourceBranch;
    return mapBuild(await adoJson("POST", `${buildsBase(org, project)}?${API}`, body));
}

export async function getBuild(org: string, project: string, buildId: number): Promise<BuildInfo> {
    return mapBuild(await adoJson("GET", `${buildsBase(org, project)}/${enc(String(buildId))}?${API}`));
}

export async function cancelBuild(org: string, project: string, buildId: number): Promise<BuildInfo> {
    const url = `${buildsBase(org, project)}/${enc(String(buildId))}?${API}`;
    return mapBuild(await adoJson("PATCH", url, { status: "cancelling" }));
}

export interface DefinitionInfo {
    /** YAML pipelines take runtime parameters and pipeline resources; classic ones don't. */
    yaml: boolean;
    projectId: string;
    defaultBranch: string;
    name: string;
    path: string;
    projectName: string;
    queueStatus: "enabled" | "paused" | "disabled";
    /** The repository the pipeline builds; `type` is "TfsGit" for Azure Repos. */
    repository: { id: string; name: string; type: string } | null;
}

export async function getDefinitionInfo(org: string, project: string, definitionId: number): Promise<DefinitionInfo> {
    const d = await adoJson("GET", `${orgBase(org)}/${enc(project)}/_apis/build/definitions/${enc(String(definitionId))}?${API}`);
    const raw = d?.queueStatus;
    const queueStatus = typeof raw === "number" ? (QUEUE_STATUS[raw] ?? "enabled") : QUEUE_STATUS.includes(raw) ? raw : "enabled";
    const repo = d?.repository;
    return {
        yaml: Number(d?.process?.type) === 2,
        projectId: String(d?.project?.id || ""),
        defaultBranch: String(repo?.defaultBranch || ""),
        name: String(d?.name || `Pipeline ${definitionId}`),
        path: String(d?.path || "\\"),
        projectName: String(d?.project?.name || project),
        queueStatus,
        repository: repo?.id ? { id: String(repo.id), name: String(repo.name || ""), type: String(repo.type || "") } : null,
    };
}

/** Whether a branch exists in an Azure Repos repository. */
export async function branchExists(org: string, project: string, repoId: string, branch: string): Promise<boolean> {
    const name = branch.replace(/^refs\/heads\//, "");
    const data = await adoJson("GET", `${repoBase(org, project, repoId)}/refs?filter=${enc(`heads/${name}`)}&${API}`);
    return ((data?.value || []) as any[]).some((r) => r?.name === `refs/heads/${name}`);
}

export interface BuildFailure {
    /** The failed step, job or stage, like "Run smoke tests". */
    name: string;
    type: string;
    /** The first error messages ADO recorded for it. */
    errors: string[];
    logUrl: string | null;
    /** The step's log, for getBuildLogTail. */
    logId: number | null;
}

/** What failed in a build: the failed steps first, each with its first errors and log. */
export async function getBuildFailures(org: string, project: string, buildId: number): Promise<BuildFailure[]> {
    const data = await adoJson("GET", `${buildsBase(org, project)}/${enc(String(buildId))}/timeline?${API}`);
    const failed = ((data?.records || []) as any[]).filter((r) => r?.result === "failed" || r?.result === "canceled");
    const rank = (t: string) => (t === "Task" ? 0 : t === "Job" ? 1 : t === "Stage" ? 2 : 3);
    return failed
        .sort((a, b) => rank(String(a.type)) - rank(String(b.type)))
        .slice(0, 5)
        .map((r) => ({
            name: String(r.name || r.type || "A step"),
            type: String(r.type || ""),
            errors: ((r.issues || []) as any[])
                .filter((i) => i?.type === "error" && typeof i.message === "string")
                .map((i) => String(i.message).slice(0, 300))
                .slice(0, 3),
            logUrl: typeof r.log?.url === "string" ? r.log.url : null,
            logId: Number.isSafeInteger(r.log?.id) && r.log.id > 0 ? r.log.id : null,
        }));
}

export interface RunParametersInfo {
    parameters: RunParameter[];
    resources: PipelineResource[];
    /** `resources.repositories` other than the pipeline's own (`self`). */
    repositories: RepositoryResource[];
    /** YAML problems Azure DevOps found on that branch (for example a template that fails to expand). */
    errors: string[];
}

const RUN_PARAMS_PROVIDER = "ms.vss-build-web.pipeline-run-parameters-data-provider";

// Undocumented: the data provider behind the portal's "Run pipeline" panel. It expands
// the pipeline's YAML (templates included) on a branch and returns its runtime
// parameters and `resources.pipelines`; there is no public REST API for either.
export async function getRunParameters(
    org: string,
    project: string,
    projectId: string,
    definitionId: number,
    branch: string,
): Promise<RunParametersInfo> {
    const body = {
        contributionIds: [RUN_PARAMS_PROVIDER],
        dataProviderContext: {
            properties: {
                pipelineId: definitionId,
                sourceBranch: branch,
                sourceVersion: "",
                onlyFetchTemplateParameters: false,
                sourcePage: { routeId: "ms.vss-build-web.pipeline-details-route", routeValues: { project } },
            },
        },
    };
    const url = `${orgBase(org)}/_apis/Contribution/HierarchyQuery/project/${enc(projectId)}?api-version=7.1-preview.1`;
    const data = await adoJson("POST", url, body);
    const p = data?.dataProviders?.[RUN_PARAMS_PROVIDER];
    if (!p) {
        const failure = data?.dataProviderExceptions?.[RUN_PARAMS_PROVIDER]?.message;
        throw new Error(failure ? String(failure).slice(0, 500) : "Azure DevOps did not return this pipeline's parameters");
    }
    const errors = (Array.isArray(p.errors) ? p.errors : [])
        .map((e: any) => (typeof e === "string" ? e : String(e?.message ?? JSON.stringify(e))))
        .filter(Boolean)
        .slice(0, 10);
    const resources: PipelineResource[] = (Array.isArray(p.pipelineResources) ? p.pipelineResources : [])
        .filter((r: any) => typeof r?.alias === "string" && typeof r?.name === "string")
        .map((r: any) => ({ alias: r.alias, name: r.name, ...(typeof r.project === "string" && r.project ? { project: r.project } : {}) }));
    return { parameters: mapRunParameters(p.templateParameters), resources, repositories: mapRepositoryResources(p.repositoryResources), errors };
}

/** Run a YAML pipeline with pinned pipeline resources, parameter overrides and repository branches. */
export async function runPipeline(
    org: string,
    project: string,
    definitionId: number,
    branch: string,
    pins: ResourcePin[],
    params: Record<string, string> | undefined,
    repos?: Record<string, string>,
): Promise<BuildInfo> {
    const url = `${orgBase(org)}/${enc(project)}/_apis/pipelines/${enc(String(definitionId))}/runs?${API}`;
    return runToBuild(await adoJson("POST", url, pipelineRunBody(branch, pins, params, repos)));
}

// ---------------------------------------------------------------------------
// Work items (Jarvis tasks)
// ---------------------------------------------------------------------------
export interface WorkItemInfo {
    org: string;
    project: string;
    id: number;
    title: string;
    type: string;
    state: string;
    url: string;
    parentId: number | null;
}

const WORK_ITEM_FIELDS = ["System.Title", "System.WorkItemType", "System.State", "System.TeamProject", "System.Parent"];

/** Work items by id, in one org. Ids that do not exist (or are not visible) are left out. */
export async function getWorkItems(org: string, ids: number[]): Promise<WorkItemInfo[]> {
    const wanted = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
    const out: WorkItemInfo[] = [];
    for (let i = 0; i < wanted.length; i += 200) {
        const chunk = wanted.slice(i, i + 200);
        const data = await adoJson(
            "GET",
            `${orgBase(org)}/_apis/wit/workitems?ids=${chunk.join(",")}&fields=${enc(WORK_ITEM_FIELDS.join(","))}&errorPolicy=omit&${API}`,
        );
        for (const item of data?.value || []) {
            if (!item || typeof item.id !== "number") continue;
            const f = item.fields || {};
            const project = String(f["System.TeamProject"] || "");
            const parent = Number(f["System.Parent"]);
            out.push({
                org,
                project,
                id: item.id,
                title: String(f["System.Title"] || `Work item ${item.id}`),
                type: String(f["System.WorkItemType"] || "Work item"),
                state: String(f["System.State"] || ""),
                url: `${orgBase(org)}/${enc(project)}/_workitems/edit/${item.id}`,
                parentId: Number.isSafeInteger(parent) && parent > 0 ? parent : null,
            });
        }
    }
    return out;
}

/** HTML from a rich-text work item field as plain text, keeping its line breaks and list items. */
export function htmlToText(html: string): string {
    const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    return html
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<li[^>]*>/gi, "\n- ")
        .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|table|blockquote|pre)>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
            if (code[0] === "#") {
                const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
                return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
            }
            return entities[code.toLowerCase()] ?? whole;
        })
        .replace(/[ \t\u00a0]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

const DESCRIPTION_FIELDS = ["System.Description", "Microsoft.VSTS.TCM.ReproSteps", "Microsoft.VSTS.Common.AcceptanceCriteria"];

/** A work item's description as plain text: its Description, a bug's repro steps, and its acceptance criteria. */
export async function getWorkItemDescription(org: string, id: number): Promise<string> {
    const data = await adoJson(
        "GET",
        `${orgBase(org)}/_apis/wit/workitems?ids=${id}&fields=${enc(DESCRIPTION_FIELDS.join(","))}&errorPolicy=omit&${API}`,
    );
    const f = data?.value?.[0]?.fields || {};
    const parts: string[] = [];
    const description = htmlToText(String(f["System.Description"] || ""));
    const repro = htmlToText(String(f["Microsoft.VSTS.TCM.ReproSteps"] || ""));
    const criteria = htmlToText(String(f["Microsoft.VSTS.Common.AcceptanceCriteria"] || ""));
    if (description) parts.push(description);
    if (repro) parts.push(`Repro steps:\n${repro}`);
    if (criteria) parts.push(`Acceptance criteria:\n${criteria}`);
    return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Jarvis: a task's pull requests
// ---------------------------------------------------------------------------

/** One PR as ADO returns it, or null when it doesn't exist (or isn't visible). */
export async function getPullRequestRaw(org: string, project: string, repo: string, prId: number): Promise<any | null> {
    const token = await getToken();
    const r = await rawRequest("GET", `${repoBase(org, project, repo)}/pullRequests/${prId}?${API}`, { token });
    if (r.status === 404) return null;
    if (r.status < 200 || r.status >= 300) throw new Error(`ADO GET ${r.status}: ${r.text.slice(0, 300)}`);
    const raw = r.text ? JSON.parse(r.text) : null;
    return raw && typeof raw.pullRequestId === "number" ? raw : null;
}

/** A PR by its number alone (numbers are unique in an organization), or null when it isn't there. */
export async function getPullRequestById(org: string, prId: number): Promise<any | null> {
    const token = await getToken();
    const r = await rawRequest("GET", `${orgBase(org)}/_apis/git/pullrequests/${enc(String(prId))}?${API}`, { token });
    if (r.status === 404) return null;
    if (r.status < 200 || r.status >= 300) throw new Error(`ADO GET ${r.status}: ${r.text.slice(0, 300)}`);
    const raw = r.text ? JSON.parse(r.text) : null;
    return raw && typeof raw.pullRequestId === "number" ? raw : null;
}

export interface WorkItemPrLink {
    projectId: string;
    repoId: string;
    prId: number;
}

/** A work item's fields and the pull requests linked to it in ADO. Null when it doesn't exist. */
export async function getWorkItemPrLinks(
    org: string,
    id: number,
): Promise<{ item: WorkItemInfo; prs: WorkItemPrLink[] } | null> {
    const token = await getToken();
    const r = await rawRequest("GET", `${orgBase(org)}/_apis/wit/workitems/${id}?$expand=relations&${API}`, { token });
    if (r.status === 404) return null;
    if (r.status < 200 || r.status >= 300) throw new Error(`ADO GET ${r.status}: ${r.text.slice(0, 300)}`);
    const data = JSON.parse(r.text || "{}");
    const f = data.fields || {};
    const project = String(f["System.TeamProject"] || "");
    const parent = Number(f["System.Parent"]);
    const item: WorkItemInfo = {
        org,
        project,
        id,
        title: String(f["System.Title"] || `Work item ${id}`),
        type: String(f["System.WorkItemType"] || "Work item"),
        state: String(f["System.State"] || ""),
        url: `${orgBase(org)}/${enc(project)}/_workitems/edit/${id}`,
        parentId: Number.isSafeInteger(parent) && parent > 0 ? parent : null,
    };
    const prs: WorkItemPrLink[] = [];
    for (const rel of (data.relations || []) as any[]) {
        const link = parsePrArtifactLink(rel?.url);
        if (rel?.rel === "ArtifactLink" && link) prs.push(link);
    }
    return { item, prs };
}

/** "vstfs:///Git/PullRequestId/{projectId}%2F{repoId}%2F{prId}" → its parts. */
export function parsePrArtifactLink(url: unknown): WorkItemPrLink | null {
    if (typeof url !== "string") return null;
    const m = /^vstfs:\/\/\/Git\/PullRequestId\/(.+)$/i.exec(url.trim());
    if (!m) return null;
    let parts: string[];
    try {
        parts = decodeURIComponent(m[1]).split("/");
    } catch {
        return null;
    }
    const prId = Number(parts[2]);
    if (parts.length !== 3 || !parts[0] || !parts[1] || !Number.isSafeInteger(prId) || prId < 1) return null;
    return { projectId: parts[0], repoId: parts[1], prId };
}

/** PRs from one source branch, opened by one person, any status, newest first. */
export async function listBranchPrs(org: string, project: string, repo: string, branch: string, creatorId: string): Promise<any[]> {
    const q =
        `searchCriteria.sourceRefName=${enc(`refs/heads/${branch}`)}&searchCriteria.creatorId=${enc(creatorId)}` +
        `&searchCriteria.status=all&$top=20&${API}`;
    const data = await adoJson("GET", `${repoBase(org, project, repo)}/pullrequests?${q}`);
    return ((data?.value || []) as any[]).filter((pr) => pr && typeof pr.pullRequestId === "number");
}

export interface PrChecks {
    passed: number;
    failed: number;
    running: number;
    total: number;
    /** Names of the blocking checks that failed, like "Build" or "Minimum number of reviewers". */
    failing: string[];
}

/** The PR's blocking branch policies (builds, reviewers, linked work items…), summed up. */
export async function getPrChecks(org: string, projectId: string, prId: number): Promise<PrChecks> {
    const artifact = `vstfs:///CodeReview/CodeReviewId/${projectId}/${prId}`;
    const data = await adoJson(
        "GET",
        `${orgBase(org)}/${enc(projectId)}/_apis/policy/evaluations?artifactId=${enc(artifact)}&api-version=7.1-preview.1`,
    );
    const out: PrChecks = { passed: 0, failed: 0, running: 0, total: 0, failing: [] };
    for (const e of (data?.value || []) as any[]) {
        const config = e?.configuration || {};
        if (config.isEnabled === false || config.isBlocking === false) continue;
        const status = String(e?.status || "");
        if (status === "notApplicable") continue;
        out.total++;
        if (status === "approved") out.passed++;
        else if (status === "rejected" || status === "broken") {
            out.failed++;
            const name = String(config.settings?.displayName || config.type?.displayName || "A check");
            if (!out.failing.includes(name)) out.failing.push(name);
        } else out.running++;
    }
    return out;
}

export interface PrBuildPolicy {
    definitionId: number;
    /** The policy's display name, or the pipeline's id when it has none. */
    name: string;
    /** A failing build blocks completing the PR. */
    blocking: boolean;
    /** approved · rejected · running · queued · broken … as ADO reports it. */
    status: string;
}

/** The PR's build validation policies: the pipelines that must build it. Blocking ones first. */
export async function getPrBuildPolicies(org: string, projectId: string, prId: number): Promise<PrBuildPolicy[]> {
    const artifact = `vstfs:///CodeReview/CodeReviewId/${projectId}/${prId}`;
    const data = await adoJson(
        "GET",
        `${orgBase(org)}/${enc(projectId)}/_apis/policy/evaluations?artifactId=${enc(artifact)}&api-version=7.1-preview.1`,
    );
    const out = new Map<number, PrBuildPolicy>();
    for (const e of (data?.value || []) as any[]) {
        const config = e?.configuration || {};
        const id = Number(config.settings?.buildDefinitionId);
        if (config.isEnabled === false || !Number.isSafeInteger(id) || id <= 0) continue;
        if (String(e?.status || "") === "notApplicable") continue;
        const policy: PrBuildPolicy = {
            definitionId: id,
            name: String(config.settings?.displayName || `Pipeline ${id}`),
            blocking: config.isBlocking !== false,
            status: String(e?.status || ""),
        };
        const seen = out.get(id);
        if (!seen || (policy.blocking && !seen.blocking)) out.set(id, policy);
    }
    return [...out.values()].sort((a, b) => Number(b.blocking) - Number(a.blocking));
}

export interface PrBuildEvaluation {
    /** The policy evaluation's id; requeuePolicyEvaluation reruns its build. */
    evaluationId: string;
    definitionId: number;
    name: string;
    /** A failing build blocks completing the PR. */
    blocking: boolean;
    /** approved · rejected · running · queued · broken … as ADO reports it. */
    status: string;
    /** The build the evaluation last ran, if any. */
    buildId: number | null;
    /** The source commit that build ran on, when ADO says. */
    sourceCommit: string | null;
    /** The build ran on an older commit or its result expired. */
    expired: boolean;
    /** The policy only builds when someone queues it. */
    manual: boolean;
}

/** The PR's build validation evaluations, one per policy, with the build each last ran. */
export async function getPrBuildEvaluations(org: string, projectId: string, prId: number): Promise<PrBuildEvaluation[]> {
    const artifact = `vstfs:///CodeReview/CodeReviewId/${projectId}/${prId}`;
    const data = await adoJson(
        "GET",
        `${orgBase(org)}/${enc(projectId)}/_apis/policy/evaluations?artifactId=${enc(artifact)}&api-version=7.1-preview.1`,
    );
    const out: PrBuildEvaluation[] = [];
    for (const e of (data?.value || []) as any[]) {
        const config = e?.configuration || {};
        const settings = config.settings || {};
        const id = Number(settings.buildDefinitionId);
        if (config.isEnabled === false || !Number.isSafeInteger(id) || id <= 0) continue;
        const status = String(e?.status || "");
        if (status === "notApplicable" || typeof e?.evaluationId !== "string") continue;
        const context = e?.context || {};
        const buildId = Number(context.buildId);
        const commit = context.lastMergeSourceCommit;
        const sourceCommit = typeof commit === "string" ? commit : typeof commit?.commitId === "string" ? commit.commitId : null;
        out.push({
            evaluationId: e.evaluationId,
            definitionId: id,
            name: String(settings.displayName || `Pipeline ${id}`),
            blocking: config.isBlocking !== false,
            status,
            buildId: Number.isSafeInteger(buildId) && buildId > 0 ? buildId : null,
            sourceCommit: sourceCommit ? sourceCommit.toLowerCase() : null,
            expired: context.isExpired === true || context.buildIsNotCurrent === true,
            manual: settings.manualQueueOnly === true,
        });
    }
    return out;
}

/** Rerun a PR policy evaluation; for a build policy, ADO queues a new build (and cancels a running one). */
export async function requeuePolicyEvaluation(org: string, projectId: string, evaluationId: string): Promise<void> {
    await adoJson(
        "PATCH",
        `${orgBase(org)}/${enc(projectId)}/_apis/policy/evaluations/${enc(evaluationId)}?api-version=7.1-preview.1`,
    );
}

/** The last lines of one build log, timestamps stripped and long lines cut. */
export async function getBuildLogTail(org: string, project: string, buildId: number, logId: number, lines = 60): Promise<string[]> {
    const url = `${buildsBase(org, project)}/${enc(String(buildId))}/logs/${enc(String(logId))}?${API}`;
    const text = (await adoText(url)) || "";
    return text
        .split(/\r?\n/)
        .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, "").trimEnd())
        .filter((l) => l.length > 0)
        .slice(-lines)
        .map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l));
}

/** A PR's comment threads, deleted ones and system notes left out (each thread keeps its human comments). */
export async function listPrThreads(org: string, project: string, repoId: string, prId: number): Promise<Thread[]> {
    const data = await adoJson("GET", `${repoBase(org, project, repoId)}/pullRequests/${prId}/threads?${API}`);
    return ((data?.value || []) as any[])
        .filter((t) => t && !t.isDeleted)
        .map((t) => normalizeThread(t))
        .filter((t) => t.comments.length > 0);
}

/** Comment threads people still need to resolve (active or pending), system notes left out. */
export async function countUnresolvedThreads(org: string, project: string, repoId: string, prId: number): Promise<number> {
    const data = await adoJson("GET", `${repoBase(org, project, repoId)}/pullRequests/${prId}/threads?${API}`);
    return ((data?.value || []) as any[]).filter((t) => {
        if (!t || t.isDeleted) return false;
        if (t.status !== "active" && t.status !== "pending") return false;
        const first = (t.comments || [])[0];
        return !!first && first.commentType !== "system";
    }).length;
}

// ---------------------------------------------------------------------------
// Minimal line diff (Myers) with 3-line context folding (no dependency)
// ---------------------------------------------------------------------------
/** Myers' diff keeps about (D+1)² numbers for D changed lines: past this many, a changed middle shows as replaced. */
export const DIFF_MAX_EDITS = 2_000;

const SAME = 0;
const DEL = 1;
const ADD = 2;

/**
 * Myers' shortest edit script from `a` to `b`: SAME, DEL (a line of `a`) or ADD
 * (a line of `b`) per step, deletions before additions in a change. Time is
 * O((N+M)·D) and memory O(D²), so a small edit in a big file stays cheap.
 * Returns null when more than `maxEdits` lines differ.
 */
function editScript(a: string[], b: string[], maxEdits: number): Uint8Array | null {
    const n = a.length;
    const m = b.length;
    const limit = Math.min(n + m, maxEdits);
    const off = limit + 1;
    const v = new Int32Array(2 * limit + 3);
    // trace[d] holds the furthest x on diagonals -d..d after d edits.
    const trace: Int32Array[] = [];
    let found = -1;
    for (let d = 0; d <= limit && found < 0; d++) {
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            v[off + k] = x;
            if (x >= n && y >= m) {
                found = d;
                break;
            }
        }
        trace.push(v.slice(off - d, off + d + 1));
    }
    if (found < 0) return null;

    const script = new Uint8Array(n + m - (n + m - found) / 2);
    let at = script.length;
    let x = n;
    let y = m;
    for (let d = found; d > 0; d--) {
        const prev = trace[d - 1];
        const k = x - y;
        const down = k === -d || (k !== d && prev[k - 1 + d - 1] < prev[k + 1 + d - 1]);
        const pk = down ? k + 1 : k - 1;
        const px = prev[pk + d - 1];
        const py = px - pk;
        while (x > px && y > py) {
            script[--at] = SAME;
            x--;
            y--;
        }
        if (down) {
            script[--at] = ADD;
            y--;
        } else {
            script[--at] = DEL;
            x--;
        }
    }
    while (x > 0 && y > 0) {
        script[--at] = SAME;
        x--;
        y--;
    }
    return script;
}

export function diffLines(a: string[], b: string[]): Hunk[] {
    // Unchanged lines at both ends need no search; most edits leave most of a file alone.
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const midA = a.slice(head, a.length - tail);
    const midB = b.slice(head, b.length - tail);
    const n = midA.length;
    const m = midB.length;
    const ops: DiffOp[] = [];
    for (let k = 0; k < head; k++) ops.push({ t: "ctx", text: a[k], o: k + 1, nn: k + 1 });
    const script = n > 0 && m > 0 ? editScript(midA, midB, DIFF_MAX_EDITS) : null;
    if (!script) {
        // One side is empty, or too much changed to align line by line within the budget.
        for (let k = 0; k < n; k++) ops.push({ t: "del", text: midA[k], o: head + k + 1, nn: null });
        for (let k = 0; k < m; k++) ops.push({ t: "add", text: midB[k], o: null, nn: head + k + 1 });
    } else {
        let i = 0;
        let j = 0;
        for (const step of script) {
            if (step === SAME) {
                ops.push({ t: "ctx", text: midA[i], o: head + i + 1, nn: head + j + 1 });
                i++;
                j++;
            } else if (step === DEL) {
                ops.push({ t: "del", text: midA[i], o: head + i + 1, nn: null });
                i++;
            } else {
                ops.push({ t: "add", text: midB[j], o: null, nn: head + j + 1 });
                j++;
            }
        }
    }
    for (let k = 0; k < tail; k++) {
        ops.push({ t: "ctx", text: a[a.length - tail + k], o: a.length - tail + k + 1, nn: b.length - tail + k + 1 });
    }

    // Fold long unchanged runs, keeping 3 lines of context around changes.
    const CTX = 3;
    const keep = new Array(ops.length).fill(false);
    for (let k = 0; k < ops.length; k++) {
        if (ops[k].t !== "ctx") {
            for (let d = -CTX; d <= CTX; d++) {
                const idx = k + d;
                if (idx >= 0 && idx < ops.length) keep[idx] = true;
            }
        }
    }
    const hunks: Hunk[] = [];
    let cur: DiffOp[] | null = null;
    for (let k = 0; k < ops.length; k++) {
        if (keep[k]) {
            if (!cur) {
                cur = [];
                hunks.push(cur);
            }
            cur.push(ops[k]);
        } else {
            cur = null;
        }
    }
    return hunks;
}
