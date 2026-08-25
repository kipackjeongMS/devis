// ADO REST client for the ado-pr-ops canvas.
// Auth: local user's credential via `az account get-access-token` (no PAT).
// Dependency-free: node built-ins only.

import https from "node:https";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import { getAzToken } from "./azauth.mjs";

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
    activityError?: string; // surfaced by /api/prs without hiding the core PR list
    sourceRef: string;
    targetRef: string;
    url: string;
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

function rawRequest(method: string, url: string, { token, accept, body }: RawOptions = {}): Promise<RawResponse> {
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
                res.on("data", (c: Buffer) => chunks.push(c));
                res.on("end", () =>
                    resolve({
                        status: res.statusCode || 0,
                        headers: res.headers,
                        text: Buffer.concat(chunks).toString("utf8"),
                    }),
                );
            },
        );
        req.on("error", reject);
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
const COMMENT_ACTIVITY_TTL_MS = 60 * 1000;
const _commentActivityCache = new Map<string, { value: boolean; expiresAt: number }>();

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
    return me;
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
    };
}

async function hasCommentedOnPr(pr: Pr, meId: string, refresh: boolean): Promise<boolean> {
    if (!pr.project || !pr.repoId) return false;
    const key = `${pr.org}\n${pr.project}\n${pr.repoId}\n${pr.id}\n${meId}`;
    const cached = _commentActivityCache.get(key);
    if (!refresh && cached && cached.expiresAt > Date.now()) return cached.value;

    const base = `${repoBase(pr.org, pr.project, pr.repoId)}/pullRequests/${pr.id}`;
    const data = await adoJson("GET", `${base}/threads?${API}`);
    const value = ((data.value || []) as any[]).some((t) =>
        ((t.comments || []) as any[]).some(
            (c) => c.commentType !== "system" && c.author?.id === meId,
        ),
    );
    _commentActivityCache.set(key, { value, expiresAt: Date.now() + COMMENT_ACTIVITY_TTL_MS });
    return value;
}

async function addCommentActivity(prs: Pr[], meId: string, refresh: boolean): Promise<void> {
    // A non-zero vote already qualifies the PR for My Plate, so only scan the
    // remaining PRs. Keep the ADO fan-out bounded for large configured projects.
    const pending = prs.filter((pr) => pr.myVote === 0);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < pending.length) {
            const pr = pending[next++];
            try {
                pr.iCommented = await hasCommentedOnPr(pr, meId, refresh);
            } catch (e) {
                pr.activityError = `PR #${pr.id} comment activity: ${(e as Error).message}`;
            }
        }
    };
    const workerCount = Math.min(6, pending.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

// All active PRs where the current user is a reviewer OR the author, for one org
// (two parallel calls, merged and deduped — a PR can match both).
export async function listAssignedPRs(org: string, refreshActivity = false): Promise<Pr[]> {
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
    await addCommentActivity(prs, me.id, refreshActivity);
    return prs;
}

// All active PRs in one (org, project), each tagged `mine` when the current user
// is a reviewer OR the author. Two parallel project-scoped calls: the full active
// set, plus the reviewer=me subset (ADO expands group/team reviewers server-side,
// so a PR assigned to me via a group is still correctly flagged `mine`) — the
// full set already contains PRs I authored, so mapPr folds those in too.
export async function listActivePRs(org: string, project: string, refreshActivity = false): Promise<Pr[]> {
    const me = await getMe(org);
    const base = `${orgBase(org)}/${enc(project)}/_apis/git/pullrequests`;
    const q = `searchCriteria.status=active&$top=200&${API}`;
    const [allData, mineData] = await Promise.all([
        adoJson("GET", `${base}?${q}`),
        adoJson("GET", `${base}?searchCriteria.reviewerId=${me.id}&${q}`),
    ]);
    const mineIds = new Set(((mineData.value || []) as any[]).map((pr) => pr.pullRequestId));
    const prs = ((allData.value || []) as any[]).map((pr) =>
        mapPr(org, pr, mineIds.has(pr.pullRequestId), me.id),
    );
    await addCommentActivity(prs, me.id, refreshActivity);
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
    const last = (iters.value || [])[iters.value.length - 1];
    if (!last)
        return {
            description, files: [], threads: [], commits: {},
            status, isDraft, reviewers, myVote, iCommented: false,
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

// ---------------------------------------------------------------------------
// Minimal LCS line diff with 3-line context folding (no dependency)
// ---------------------------------------------------------------------------
function diffLines(a: string[], b: string[]): Hunk[] {
    const n = a.length;
    const m = b.length;
    // LCS length table (rolling not used; n,m capped by MAX above).
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j]
                ? dp[i + 1][j + 1] + 1
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const ops: DiffOp[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            ops.push({ t: "ctx", text: a[i], o: i + 1, nn: j + 1 });
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            ops.push({ t: "del", text: a[i], o: i + 1, nn: null });
            i++;
        } else {
            ops.push({ t: "add", text: b[j], o: null, nn: j + 1 });
            j++;
        }
    }
    while (i < n) ops.push({ t: "del", text: a[i], o: ++i, nn: null });
    while (j < m) ops.push({ t: "add", text: b[j], o: null, nn: ++j });

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
