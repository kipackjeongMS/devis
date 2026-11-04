// When each PR's code last changed and when I last commented or voted on it,
// for ordering the Workspace Pull Requests panel.
//
// One threads fetch per PR gives both: every push leaves a system "ref update"
// thread, and my comments and votes carry my author id. The result is cached by
// the PR's head commit, so a PR is read again only after a new push. Comments
// and votes made through this app are recorded straight away. Comments made on
// the ADO website show up after the PR's next push.
//
// /api/prs answers from the cache and starts reads in the background; the
// client collects them from /api/pr-recency.

import { getMe, getPrLastPushAt, getPrThreadsRaw, type Pr } from "./ado.mjs";
import { listPrRecency, savePrRecency, type MyKind, type PrRecencyRow } from "./store.mjs";

const DEFAULT_CONCURRENCY = 4;
// A PR with no head commit still gets one read, cached under this marker.
const NO_HEAD = "none";

export interface ThreadSummary {
    pushedAt: number | null;
    myAt: number | null;
    myKind: MyKind | null;
}

export interface RecencyRef {
    org: string;
    project: string;
    repoId: string;
    prId: string;
}

export interface RecencyEntry extends RecencyRef {
    pushedAt: string | null;
    myAt: string | null;
    myKind: MyKind | null;
}

const REF_UPDATE_TEXT = /^The reference .+ was updated\.?$/i;
const VOTE_TEXT = /\bvoted -?\d+\.?$/i;

function threadType(thread: any): string {
    const v = thread?.properties?.CodeReviewThreadType;
    if (typeof v === "string") return v;
    return typeof v?.$value === "string" ? v.$value : "";
}

function ms(value: unknown): number | null {
    if (typeof value !== "string") return null;
    const at = Date.parse(value);
    return Number.isFinite(at) ? at : null;
}

/** The last push and my last comment or vote, from a PR's raw threads. */
export function summarizeThreads(threads: any[], meId: string): ThreadSummary {
    let pushedAt: number | null = null;
    let myAt: number | null = null;
    let myKind: MyKind | null = null;
    const mine = (at: number, kind: MyKind): void => {
        if (myAt == null || at > myAt) {
            myAt = at;
            myKind = kind;
        }
    };
    for (const thread of threads || []) {
        const type = threadType(thread);
        for (const c of (thread?.comments || []) as any[]) {
            const at = ms(c?.publishedDate) ?? ms(thread?.publishedDate);
            if (at == null) continue;
            const text = String(c?.content || "").trim();
            if (c?.commentType === "system") {
                if (type === "RefUpdate" || REF_UPDATE_TEXT.test(text)) {
                    if (pushedAt == null || at > pushedAt) pushedAt = at;
                } else if (c?.author?.id === meId && (type === "VoteUpdate" || VOTE_TEXT.test(text))) {
                    mine(at, "vote");
                }
                continue;
            }
            if (c?.author?.id !== meId || c?.isDeleted) continue;
            const edited = ms(c?.lastContentUpdatedDate);
            mine(edited != null && edited > at ? edited : at, "comment");
        }
    }
    return { pushedAt, myAt, myKind };
}

export interface PrRecencyDeps {
    getMeId(org: string): Promise<string>;
    read(pr: Pr, meId: string): Promise<ThreadSummary>;
    load(org: string, meId: string): PrRecencyRow[];
    save(row: PrRecencyRow): void;
    now?(): number;
    concurrency?: number;
}

export interface PrRecency {
    /** Fill pr.pushedAt/myAt from the cache and start reads for new heads; returns the in-flight count. */
    apply(prs: Pr[]): Promise<number>;
    /** Wait up to `waitMs` for in-flight reads, then report every cached PR for these orgs. */
    settle(orgs: string[], waitMs: number): Promise<{ recency: RecencyEntry[]; pending: number; errors: string[] }>;
    /** Record that I just commented or voted through this app. */
    record(ref: RecencyRef, kind: MyKind): Promise<void>;
}

const rowKey = (project: string, repoId: string, prId: string): string => JSON.stringify([project, repoId, prId]);
const iso = (at: number | null): string | null => (at == null ? null : new Date(at).toISOString());

export function createPrRecency(deps: PrRecencyDeps): PrRecency {
    const now = deps.now || Date.now;
    const limit = Math.max(1, deps.concurrency || DEFAULT_CONCURRENCY);
    const inflight = new Map<string, Promise<void>>();
    const errors: string[] = [];
    const waiting: Array<() => void> = [];
    let active = 0;

    const acquire = (): Promise<void> => {
        if (active < limit) {
            active++;
            return Promise.resolve();
        }
        return new Promise((resolve) => waiting.push(resolve));
    };
    const release = (): void => {
        const next = waiting.shift();
        if (next) next();
        else active--;
    };

    function startRead(pr: Pr, meId: string, head: string): void {
        const key = JSON.stringify([pr.org, meId, pr.project, pr.repoId, String(pr.id), head]);
        if (inflight.has(key)) return;
        const run = (async () => {
            await acquire();
            const startedAt = now();
            try {
                const summary = await deps.read(pr, meId);
                deps.save({
                    org: pr.org,
                    project: pr.project!,
                    repoId: pr.repoId!,
                    prId: String(pr.id),
                    meId,
                    head,
                    pushedAt: summary.pushedAt,
                    myAt: summary.myAt,
                    myKind: summary.myKind,
                    checkedAt: startedAt,
                });
            } catch (e) {
                errors.push(`PR #${pr.id} recency: ${(e as Error).message}`);
            } finally {
                release();
                inflight.delete(key);
            }
        })();
        inflight.set(key, run);
    }

    return {
        async apply(prs) {
            const byOrg = new Map<string, Pr[]>();
            for (const pr of prs) {
                if (!byOrg.has(pr.org)) byOrg.set(pr.org, []);
                byOrg.get(pr.org)!.push(pr);
            }
            for (const [org, list] of byOrg) {
                let meId: string;
                try {
                    meId = await deps.getMeId(org);
                } catch (e) {
                    errors.push(`${org} recency: ${(e as Error).message}`);
                    continue;
                }
                const rows = new Map(deps.load(org, meId).map((r) => [rowKey(r.project, r.repoId, r.prId), r]));
                for (const pr of list) {
                    if (!pr.project || !pr.repoId) continue;
                    const row = rows.get(rowKey(pr.project, pr.repoId, String(pr.id)));
                    pr.pushedAt = iso(row?.pushedAt ?? null);
                    pr.myAt = iso(row?.myAt ?? null);
                    pr.myKind = row?.myKind ?? null;
                    const head = pr.headCommit || NO_HEAD;
                    if (!row || row.head !== head) startRead(pr, meId, head);
                }
            }
            return inflight.size;
        },

        async settle(orgs, waitMs) {
            if (inflight.size) {
                let timer: ReturnType<typeof setTimeout> | undefined;
                const timeout = new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, Math.max(0, waitMs));
                });
                const drained = (async () => {
                    while (inflight.size) await Promise.all([...inflight.values()]);
                })();
                await Promise.race([drained, timeout]);
                clearTimeout(timer);
            }
            const recency: RecencyEntry[] = [];
            for (const org of orgs) {
                try {
                    const meId = await deps.getMeId(org);
                    for (const r of deps.load(org, meId)) {
                        if (r.pushedAt == null && r.myAt == null) continue;
                        recency.push({
                            org: r.org,
                            project: r.project,
                            repoId: r.repoId,
                            prId: r.prId,
                            pushedAt: iso(r.pushedAt),
                            myAt: iso(r.myAt),
                            myKind: r.myKind,
                        });
                    }
                } catch (e) {
                    errors.push(`${org} recency: ${(e as Error).message}`);
                }
            }
            return { recency, pending: inflight.size, errors: errors.splice(0) };
        },

        async record(ref, kind) {
            const meId = await deps.getMeId(ref.org);
            // head "" and checkedAt 0 never win over a real read. With no row yet, the next apply reads the PR.
            deps.save({ ...ref, meId, head: "", pushedAt: null, myAt: now(), myKind: kind, checkedAt: 0 });
        },
    };
}

/** Threads first; when no push shows up there, the iterations list says when the code last changed. */
async function readRecency(pr: Pr, meId: string): Promise<ThreadSummary> {
    const summary = summarizeThreads(await getPrThreadsRaw(pr), meId);
    if (summary.pushedAt == null) summary.pushedAt = await getPrLastPushAt(pr);
    return summary;
}

export const prRecency = createPrRecency({
    getMeId: async (org) => (await getMe(org)).id,
    read: readRecency,
    load: listPrRecency,
    save: savePrRecency,
});
