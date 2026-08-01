// Notification inbox: derive persisted, deduped events from ADO. ADO has no push
// to a local process (service hooks need a public webhook), so this is the same
// shape notify.ts uses for reviews: poll -> diff against a watermark -> INSERT OR
// IGNORE. v1 surfaces peer comments/replies on PRs the current user authored.

import { readConfig } from "./config.mjs";
import { getMe, listAuthoredPRs, getPrThreads, type Pr, type InboxComment } from "./ado.mjs";
import { insertNotifications, getMeta, setMeta, type NotificationInput } from "./store.mjs";

const MAX_PRS = 25; // cap thread fetches per org per poll
const SNIPPET_LEN = 200;
const WATERMARK_KEY = "inbox_last_poll";

/**
 * Pure: turn one PR's comments into notification inputs for PEER comments newer
 * than the watermark. The first run seeds the watermark and emits nothing, so a
 * fresh install never floods the inbox with the entire comment history.
 */
export function commentEvents(
    pr: Pr,
    comments: InboxComment[],
    meId: string,
    lastPoll: string | null,
    firstRun: boolean,
): NotificationInput[] {
    if (firstRun) return [];
    const out: NotificationInput[] = [];
    for (const c of comments) {
        if (c.commentType === "system") continue;
        if (!c.content || !c.content.trim()) continue;
        if (!c.published) continue;
        if (c.authorId && meId && c.authorId === meId) continue; // skip my own comments
        if (lastPoll && c.published <= lastPoll) continue; // already seen
        const isReply = c.parentCommentId > 0;
        out.push({
            id: `comment:${c.id}`,
            kind: isReply ? "reply" : "comment",
            prId: pr.id,
            org: pr.org,
            project: pr.project,
            repo: pr.repo,
            repoId: pr.repoId,
            title: pr.title,
            actor: c.authorName,
            summary: `${c.authorName} ${isReply ? "replied" : "commented"} on PR #${pr.id}`,
            snippet: c.content.replace(/\s+/g, " ").trim().slice(0, SNIPPET_LEN),
            url: pr.url,
            createdAt: c.published,
        });
    }
    return out;
}

/**
 * One poll pass: scan every configured org's authored PRs, derive new peer
 * comment events, persist them (deduped), and advance the watermark.
 */
export async function scanInbox(): Promise<{ inserted: number }> {
    const cfg = await readConfig();
    const lastPoll = getMeta(WATERMARK_KEY);
    const firstRun = !lastPoll;
    const now = new Date().toISOString();
    const events: NotificationInput[] = [];

    for (const org of cfg.organizations) {
        let me;
        let prs: Pr[];
        try {
            me = await getMe(org);
            prs = await listAuthoredPRs(org);
        } catch (e) {
            console.error(`[inbox] scan ${org} failed: ${(e as Error).message}`);
            continue;
        }
        const scoped = prs.slice(0, MAX_PRS);
        const perPr = await Promise.all(
            scoped.map(async (pr) => {
                try {
                    const comments = await getPrThreads(org, pr.project!, pr.repoId!, pr.id);
                    return commentEvents(pr, comments, me!.id, lastPoll, firstRun);
                } catch {
                    return [] as NotificationInput[];
                }
            }),
        );
        for (const list of perPr) events.push(...list);
    }

    const inserted = events.length ? insertNotifications(events) : 0;
    setMeta(WATERMARK_KEY, now);
    return { inserted };
}
