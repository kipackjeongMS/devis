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

export interface Pr {
    org: string;
    id: number;
    mine: boolean;
    title: string;
    project: string | undefined;
    repo: string | undefined;
    repoId: string | undefined;
    author: string | undefined;
    authorId: string | undefined;
    created: string;
    isDraft: boolean | undefined;
    sourceRef: string;
    targetRef: string;
    url: string;
}

export interface ThreadComment {
    id: number;
    author: string;
    content: string;
    parentCommentId: number;
    published: string | undefined;
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
    `${orgBase(org)}/${enc(project)}/_apis/git/repositories/${repoId}`;

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
    return me;
}

// Shape one raw ADO PR record into our Pr, tagging whether it is assigned to me.
function mapPr(org: string, pr: any, mine: boolean): Pr {
    return {
        org,
        id: pr.pullRequestId,
        mine,
        title: pr.title,
        project: pr.repository?.project?.name,
        repo: pr.repository?.name,
        repoId: pr.repository?.id,
        author: pr.createdBy?.displayName,
        authorId: pr.createdBy?.id,
        created: pr.creationDate,
        isDraft: pr.isDraft,
        sourceRef: (pr.sourceRefName || "").replace("refs/heads/", ""),
        targetRef: (pr.targetRefName || "").replace("refs/heads/", ""),
        url: `${orgBase(org)}/${enc(pr.repository?.project?.name || "")}/_git/${enc(
            pr.repository?.name || "",
        )}/pullrequest/${pr.pullRequestId}`,
    };
}

// All active PRs where the current user is a reviewer, for one org (single call).
// Every result is `mine` by construction.
export async function listAssignedPRs(org: string): Promise<Pr[]> {
    const me = await getMe(org);
    const url =
        `${orgBase(org)}/_apis/git/pullrequests` +
        `?searchCriteria.reviewerId=${me.id}` +
        `&searchCriteria.status=active&$top=200&${API}`;
    const data = await adoJson("GET", url);
    return ((data.value || []) as any[]).map((pr) => mapPr(org, pr, true));
}

// All active PRs in one (org, project), each tagged `mine` when the current user
// is a reviewer. Two parallel project-scoped calls: the full active set, plus the
// reviewer=me subset (ADO expands group/team reviewers server-side, so a PR
// assigned to me via a group is still correctly flagged `mine`).
export async function listActivePRs(org: string, project: string): Promise<Pr[]> {
    const me = await getMe(org);
    const base = `${orgBase(org)}/${enc(project)}/_apis/git/pullrequests`;
    const q = `searchCriteria.status=active&$top=200&${API}`;
    const [allData, mineData] = await Promise.all([
        adoJson("GET", `${base}?${q}`),
        adoJson("GET", `${base}?searchCriteria.reviewerId=${me.id}&${q}`),
    ]);
    const mineIds = new Set(((mineData.value || []) as any[]).map((pr) => pr.pullRequestId));
    return ((allData.value || []) as any[]).map((pr) =>
        mapPr(org, pr, mineIds.has(pr.pullRequestId)),
    );
}

// PR detail: changed files (latest iteration) + threads (comments). Diffs are lazy.
export async function getPrDetail(org: string, project: string, repoId: string, prId: string | number): Promise<PrDetail> {
    const base = `${repoBase(org, project, repoId)}/pullRequests/${prId}`;
    // PR object (for the description) fetched in parallel with iterations.
    const [prObj, iters] = await Promise.all([
        adoJson("GET", `${base}?${API}`).catch(() => null),
        adoJson("GET", `${base}/iterations?${API}`),
    ]);
    const description = (prObj && prObj.description) || "";
    const last = (iters.value || [])[iters.value.length - 1];
    if (!last) return { description, files: [], threads: [], commits: {} };
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
    const threads: Thread[] = ((threadsData.value || []) as any[])
        .map((t) => normalizeThread(t))
        .filter((t) => t.comments.length > 0);

    return {
        description,
        files,
        threads,
        commits: { source: src, base: mbase, iteration: last.id },
    };
}

function normalizeThread(t: any): Thread {
    const ctx = t.threadContext || {};
    const comments: ThreadComment[] = ((t.comments || []) as any[])
        .filter((c) => c.commentType !== "system")
        .map((c) => ({
            id: c.id,
            author: c.author?.displayName || "unknown",
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

export async function postReply(
    org: string,
    project: string,
    repoId: string,
    prId: string | number,
    threadId: string | number,
    content: string,
    parentCommentId: number,
): Promise<any> {
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
