// What Needs you holds, as keys: one per ask waiting on the user. A to-do made from a Needs you
// item carries its key, and ticks itself once the key is gone (jarvis-notes settleNeedTodos).
// Mirrors needsItems in web/src/jarvisModel.ts, which gives each item the same key. A failed turn is
// known by when the worker's state last changed, so switching its model doesn't make it a new ask.
// A PR review asked for in Teams (comms.mts) is need:teams:<the ask's id>; a chat or email thread
// someone waits on the user in is need:chat|mail:<a hash of the conversation> (comms.mts commsNeeds).

import type { TodayTask } from "./jarvis-today.mjs";

/** A key Needs you gives an ask: need:req|fail|val|teams|chat|mail:<what identifies it>. */
export const NEED_KEY = /^need:(req|fail|val|teams|chat|mail):[\w:.\-]{1,200}$/;

/** The kinds of keys, as settleNeedTodos can be told to leave one alone. */
export type NeedKind = "req" | "fail" | "val" | "teams" | "chat" | "mail";

type Worker = TodayTask["workers"][number];

const time = (iso: string | null | undefined): number => Date.parse(iso || "") || 0;

/** The oldest of a worker's open requests: the one its Needs you item stands for. */
function oldestRequest(worker: Pick<Worker, "requests">): Worker["requests"][number] | null {
    let oldest: Worker["requests"][number] | null = null;
    for (const r of worker.requests) if (!oldest || time(r.at) < time(oldest.at)) oldest = r;
    return oldest;
}

/** What a worker is doing now. Live data wins over the saved state (workerState in jarvisModel.ts). */
function liveState(w: Pick<Worker, "state" | "busy" | "requests">): string {
    if (w.requests.length) return "needsInput";
    if (w.busy) return "working";
    return w.state === "needsInput" ? "working" : w.state;
}

/** The keys of everything Needs you shows for these tasks, Teams asks, and chats and email threads. */
export function needKeys(
    tasks: ReadonlyArray<Pick<TodayTask, "id" | "status" | "workers" | "validation">>,
    asks: ReadonlyArray<{ id: number }> = [],
    comms: ReadonlyArray<{ key: string }> = [],
): Set<string> {
    const keys = new Set<string>();
    for (const ask of asks) keys.add(`need:teams:${ask.id}`);
    for (const need of comms) keys.add(need.key);
    for (const task of tasks) {
        for (const worker of task.workers) {
            const request = oldestRequest(worker);
            if (request) keys.add(`need:req:${worker.sessionId}:${request.id}`);
            else if (task.status === "open" && liveState(worker) === "error") keys.add(`need:fail:${worker.sessionId}:${worker.stateAt || worker.updatedAt}`);
        }
        const v = task.validation;
        if (!v || task.status !== "open") continue;
        if (v.attention === "proposal" && v.proposal) keys.add(`need:val:${task.id}:proposal:${v.proposal.at}`);
        else if (v.attention === "failed") keys.add(`need:val:${task.id}:failed:${v.run?.runId ?? "run"}`);
    }
    return keys;
}
