// Validation and ADO PATCH-body builders for PR-level actions (vote, thread
// status, lifecycle). Pure: no I/O, so the rules are testable in isolation.

export type Vote = 10 | 5 | 0;
export type ThreadStatus = "active" | "fixed";
export type LifecycleAction =
    | "complete"
    | "autoComplete"
    | "cancelAutoComplete"
    | "draft"
    | "publish"
    | "abandon"
    | "reactivate";
export type MergeStrategy = "noFastForward" | "squash" | "rebase" | "rebaseMerge";

export interface CompletionOptionsInput {
    mergeStrategy?: unknown;
    deleteSourceBranch?: unknown;
    transitionWorkItems?: unknown;
    mergeCommitMessage?: unknown;
}

export interface CompletionOptions {
    mergeStrategy: MergeStrategy;
    deleteSourceBranch: boolean;
    transitionWorkItems: boolean;
    mergeCommitMessage?: string;
    bypassPolicy: false;
}

const VOTES: readonly number[] = [10, 5, 0];
const THREAD_STATUSES: readonly string[] = ["active", "fixed"];
const LIFECYCLE_ACTIONS: readonly string[] = [
    "complete",
    "autoComplete",
    "cancelAutoComplete",
    "draft",
    "publish",
    "abandon",
    "reactivate",
];
const MERGE_STRATEGIES: readonly string[] = ["noFastForward", "squash", "rebase", "rebaseMerge"];
const NO_USER = "00000000-0000-0000-0000-000000000000";

export function parseVote(value: unknown): Vote {
    const vote = Number(value);
    if (!VOTES.includes(vote)) throw new Error("vote must be 10, 5, or 0");
    return vote as Vote;
}

export function parseThreadStatus(value: unknown): ThreadStatus {
    if (typeof value !== "string" || !THREAD_STATUSES.includes(value)) {
        throw new Error("status must be active or fixed");
    }
    return value as ThreadStatus;
}

export function parseLifecycleAction(value: unknown): LifecycleAction {
    if (typeof value !== "string" || !LIFECYCLE_ACTIONS.includes(value)) {
        throw new Error("unsupported lifecycle action");
    }
    return value as LifecycleAction;
}

export function parseCompletionOptions(input: CompletionOptionsInput | undefined): CompletionOptions {
    const strategy = input?.mergeStrategy;
    if (typeof strategy !== "string" || !MERGE_STRATEGIES.includes(strategy)) {
        throw new Error("unsupported merge strategy");
    }
    const options: CompletionOptions = {
        mergeStrategy: strategy as MergeStrategy,
        deleteSourceBranch: input?.deleteSourceBranch === true,
        transitionWorkItems: input?.transitionWorkItems === true,
        bypassPolicy: false,
    };
    const message = typeof input?.mergeCommitMessage === "string" ? input.mergeCommitMessage.trim() : "";
    // A fast-forward rebase creates no merge commit, so ADO ignores any message.
    if (strategy !== "rebase" && message) options.mergeCommitMessage = message;
    return options;
}

export function buildLifecyclePatch(
    action: LifecycleAction,
    ctx: { options?: CompletionOptionsInput; lastMergeSourceCommit?: string; meId: string },
): Record<string, unknown> {
    switch (action) {
        case "complete":
            if (!ctx.lastMergeSourceCommit) throw new Error("PR has no source commit to merge");
            return {
                status: "completed",
                lastMergeSourceCommit: { commitId: ctx.lastMergeSourceCommit },
                completionOptions: parseCompletionOptions(ctx.options),
            };
        case "autoComplete":
            return { autoCompleteSetBy: { id: ctx.meId }, completionOptions: parseCompletionOptions(ctx.options) };
        case "cancelAutoComplete":
            return { autoCompleteSetBy: { id: NO_USER } };
        case "draft":
            return { isDraft: true };
        case "publish":
            return { isDraft: false };
        case "abandon":
            return { status: "abandoned" };
        case "reactivate":
            return { status: "active" };
    }
}
