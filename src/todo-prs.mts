// To-dos made from PRs (the PR list's "Add to to-dos", source key pr:<org>:<id>) tick themselves
// when the PR is completed or abandoned. A PR in the list the page loaded was open then, which counts
// as asking Azure DevOps at that moment; once that's 15 minutes old it's asked again like any other,
// since the page can go days without loading its list. Each PR is asked about at most every 15
// minutes and a few per pass. A PR that can't be read (gone, no access, ADO down) leaves its to-do
// alone. Checked off or reopened by hand, a PR's to-do is the user's: it never ticks itself after
// (source_settled).

import { getPullRequestById } from "./ado.mjs";
import { openPrTodos, prTodoKey, settlePrTodos } from "./jarvis-notes.mjs";

export const TODO_PR_LIMITS = {
    /** How long a PR that ADO said is open goes before it's asked about again. */
    checkMs: 15 * 60_000,
    /** PRs asked about in one pass. */
    perPass: 10,
};

/** ADO and the clock, as the module sees them. The harness swaps in a fake. */
export interface TodoPrRuntime {
    now(): number;
    /** A PR by its number, as ADO returns it; null when it isn't there. */
    pr(org: string, prId: number): Promise<{ status?: string } | null>;
}

const adoRuntime: TodoPrRuntime = { now: () => Date.now(), pr: getPullRequestById };
let runtime: TodoPrRuntime = adoRuntime;
/** When each PR's to-do last asked ADO, by key. */
const checked = new Map<string, number>();
let running: Promise<number> | null = null;

export function setTodoPrRuntime(next: TodoPrRuntime | null): void {
    runtime = next || adoRuntime;
    checked.clear();
}

/** Why a PR in this state ticks its to-do, or null while it's open. */
function closedNote(status: unknown): string | null {
    const s = String(status || "").toLowerCase();
    return s === "completed" || s === "abandoned" ? `the PR was ${s}` : null;
}

/** The PR list the page loaded, and when (runtime.now() time). */
export interface ListedPrs {
    prs: ReadonlyArray<{ org: string; id: number; status?: string }>;
    at: number;
}

/**
 * Tick the open PR to-dos whose PR closed. `listed` is the PR list the page last loaded (null when
 * it hasn't). One pass at a time: a call while one runs gets that pass. Returns how many ticked.
 */
export function settlePrTodosNow(listed: ListedPrs | null): Promise<number> {
    running ??= pass(listed).finally(() => {
        running = null;
    });
    return running;
}

async function pass(listed: ListedPrs | null): Promise<number> {
    const open = await openPrTodos();
    const keys = new Set(open.map((o) => o.key));
    for (const key of [...checked.keys()]) if (!keys.has(key)) checked.delete(key);
    if (!open.length) return 0;
    const inList = new Map((listed?.prs || []).map((p) => [prTodoKey(String(p.org || ""), Number(p.id)), p]));
    const closed = new Map<string, string>();
    const at = runtime.now();
    /** When each PR was last known open: asked of ADO, or in the list as it loaded. 0: never. */
    const known = new Map<string, number>();
    const due: typeof open = [];
    for (const o of open) {
        const pr = inList.get(o.key);
        const note = pr ? closedNote(pr.status) : null;
        if (note) {
            closed.set(o.key, note);
            continue;
        }
        const last = Math.max(checked.get(o.key) ?? 0, pr ? listed!.at : 0);
        known.set(o.key, last);
        if (last === 0 || at - last >= TODO_PR_LIMITS.checkMs) due.push(o);
    }
    // The longest unchecked first, so a long list gets round to every PR.
    due.sort((a, b) => known.get(a.key)! - known.get(b.key)!);
    for (const o of due.slice(0, TODO_PR_LIMITS.perPass)) {
        checked.set(o.key, runtime.now());
        try {
            const raw = await runtime.pr(o.pr.org, o.pr.id);
            const note = raw ? closedNote(raw.status) : null;
            if (note) closed.set(o.key, note);
        } catch {
            // Unreadable for now: asked again next time it's due.
        }
    }
    return settlePrTodos(closed);
}
