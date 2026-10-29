// Housekeeping for a desktop app that runs for days: rows that only matter for a
// while are pruned when the app starts and every few hours after, so the database
// and every poll that reads it stay the same size over months.

import { ensureDb, pruneNotifications, pruneReviewJobs } from "./store.mjs";
import { pruneStaleInboxWatches } from "./inbox.mjs";
import { EVENT_RETENTION_DAYS, pruneEvents } from "./jarvis-store.mjs";
import { pruneImages } from "./chat-images.mjs";
import { pruneComms } from "./comms.mjs";

const DAY_MS = 86_400_000;

export const RETENTION = {
    /** Inbox events; the inbox shows the latest 50. */
    notificationsDays: 90,
    /** PR watches with no activity for this long before the org's last complete poll. Matches the inbox's 30-day backfill. */
    inboxWatchDays: 30,
    /** Finished review jobs; their results stay with the PR. */
    reviewJobsDays: 30,
    jarvisEventsDays: EVENT_RETENTION_DAYS,
    everyMs: 6 * 60 * 60_000,
};

/** Prune everything past its retention. Returns rows removed per table; a failing step is logged and skipped. */
export async function runMaintenance(now = Date.now()): Promise<Record<string, number>> {
    await ensureDb();
    const removed: Record<string, number> = {};
    const step = async (name: string, prune: () => number | Promise<number>) => {
        try {
            removed[name] = await prune();
        } catch (error) {
            console.warn(`[maintenance] ${name}: ${(error as Error).message}`);
        }
    };
    await step("notifications", () => pruneNotifications(now - RETENTION.notificationsDays * DAY_MS));
    await step("inboxWatches", () => pruneStaleInboxWatches(RETENTION.inboxWatchDays * DAY_MS));
    await step("reviewJobs", () => pruneReviewJobs(now - RETENTION.reviewJobsDays * DAY_MS));
    await step("jarvisEvents", () => pruneEvents(now - RETENTION.jarvisEventsDays * DAY_MS));
    await step("chatImages", () => pruneImages(now));
    await step("comms", () => pruneComms(now));
    const total = Object.values(removed).reduce((a, b) => a + b, 0);
    if (total) console.log(`[maintenance] pruned ${JSON.stringify(removed)}`);
    return removed;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running: Promise<unknown> | null = null;

function tick(): void {
    if (running) return;
    running = runMaintenance()
        .catch((error: Error) => console.warn(`[maintenance] ${error.message}`))
        .finally(() => {
            running = null;
        });
}

export function startMaintenance(): void {
    if (timer) return;
    tick();
    timer = setInterval(tick, RETENTION.everyMs);
    timer.unref?.();
}

export async function stopMaintenance(): Promise<void> {
    if (timer) clearInterval(timer);
    timer = null;
    await running;
}
