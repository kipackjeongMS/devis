// Two-phase "I commented" enrichment for the PR list.
//
// Detecting a comment requires fetching every thread of a PR, which for a few
// hundred active PRs takes minutes. So /api/prs answers from the persisted
// cache immediately and checks only unknown/expired PRs in the background;
// the UI then asks /api/pr-activity for the settled result.
//   - commented=true is sticky (comments are rarely deleted).
//   - commented=false is rechecked after COMMENT_ACTIVITY_RECHECK_MS, or on a
//     forced refresh, or immediately when the user comments through this app.

import { getMe, hasCommentedOnPr, type Pr } from "./ado.mjs";
import { listCommentActivity, saveCommentActivity, type CommentActivityRow } from "./store.mjs";

export const COMMENT_ACTIVITY_RECHECK_MS = 15 * 60 * 1000;
const DEFAULT_CONCURRENCY = 6;

export interface ActivityRef {
    org: string;
    project: string;
    repoId: string;
    prId: string;
}

export interface CommentActivityDeps {
    getMeId(org: string): Promise<string>;
    check(pr: Pr, meId: string): Promise<boolean>;
    load(org: string, meId: string): CommentActivityRow[];
    save(row: CommentActivityRow): void;
    now?(): number;
    concurrency?: number;
}

export interface CommentActivity {
    /** Fill pr.iCommented from the cache and start background checks; returns in-flight count. */
    apply(prs: Pr[], force?: boolean): Promise<number>;
    /** Wait for in-flight checks, then report every commented PR for these orgs. */
    settle(orgs: string[]): Promise<{ commented: ActivityRef[]; errors: string[] }>;
    /** Record an authoritative observation (e.g. the user just commented). */
    record(ref: ActivityRef, commented: boolean): Promise<void>;
}

const rowKey = (project: string, repoId: string, prId: string): string =>
    JSON.stringify([project, repoId, prId]);

export function createCommentActivity(deps: CommentActivityDeps): CommentActivity {
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

    function startCheck(pr: Pr, meId: string): void {
        const key = JSON.stringify([pr.org, meId, pr.project, pr.repoId, String(pr.id)]);
        if (inflight.has(key)) return;
        const run = (async () => {
            await acquire();
            const startedAt = now();
            try {
                const commented = await deps.check(pr, meId);
                deps.save({
                    org: pr.org,
                    project: pr.project!,
                    repoId: pr.repoId!,
                    prId: String(pr.id),
                    meId,
                    commented,
                    checkedAt: startedAt,
                });
            } catch (e) {
                errors.push(`PR #${pr.id} comment activity: ${(e as Error).message}`);
            } finally {
                release();
                inflight.delete(key);
            }
        })();
        inflight.set(key, run);
    }

    return {
        async apply(prs, force = false) {
            const byOrg = new Map<string, Pr[]>();
            for (const pr of prs) {
                if (!byOrg.has(pr.org)) byOrg.set(pr.org, []);
                byOrg.get(pr.org)!.push(pr);
            }
            const at = now();
            for (const [org, list] of byOrg) {
                let meId: string;
                try {
                    meId = await deps.getMeId(org);
                } catch (e) {
                    errors.push(`${org} comment activity: ${(e as Error).message}`);
                    continue;
                }
                const rows = new Map(
                    deps.load(org, meId).map((r) => [rowKey(r.project, r.repoId, r.prId), r]),
                );
                for (const pr of list) {
                    if (!pr.project || !pr.repoId) continue;
                    const row = rows.get(rowKey(pr.project, pr.repoId, String(pr.id)));
                    pr.iCommented = !!row?.commented;
                    // A non-zero vote already puts the PR on My Plate.
                    if (pr.myVote !== 0 || row?.commented) continue;
                    if (force || !row || at - row.checkedAt >= COMMENT_ACTIVITY_RECHECK_MS) {
                        startCheck(pr, meId);
                    }
                }
            }
            return inflight.size;
        },

        async settle(orgs) {
            while (inflight.size) await Promise.all([...inflight.values()]);
            const commented: ActivityRef[] = [];
            for (const org of orgs) {
                try {
                    const meId = await deps.getMeId(org);
                    for (const r of deps.load(org, meId)) {
                        if (r.commented) {
                            commented.push({ org: r.org, project: r.project, repoId: r.repoId, prId: r.prId });
                        }
                    }
                } catch (e) {
                    errors.push(`${org} comment activity: ${(e as Error).message}`);
                }
            }
            return { commented, errors: errors.splice(0) };
        },

        async record(ref, commented) {
            const meId = await deps.getMeId(ref.org);
            deps.save({ ...ref, meId, commented, checkedAt: now() });
        },
    };
}

export const commentActivity = createCommentActivity({
    getMeId: async (org) => (await getMe(org)).id,
    check: hasCommentedOnPr,
    load: listCommentActivity,
    save: saveCommentActivity,
});
