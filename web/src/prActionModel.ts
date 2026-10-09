// Pure state rules for PR-level actions and thread status (no DOM, no I/O).

const RESOLVED = new Set(["fixed", "wontFix", "closed", "byDesign"]);
const LABELS: Record<string, string> = {
  active: "Active",
  pending: "Pending",
  fixed: "Resolved",
  wontFix: "Won't fix",
  closed: "Closed",
  byDesign: "By design",
};

export function isThreadResolved(status: string | undefined): boolean {
  return RESOLVED.has(status || "");
}

export function nextThreadStatus(status: string | undefined): "active" | "fixed" {
  return isThreadResolved(status) ? "active" : "fixed";
}

export function threadStatusLabel(status: string | undefined): string {
  return LABELS[status || ""] || status || "Unknown";
}

export interface DecisionItem {
  vote: 10 | 5 | 0;
  label: string;
  checked: boolean;
  disabled: boolean;
}

export function decisionMenuItems(pr: { status?: string; myVote?: number }): DecisionItem[] {
  const closed = pr.status !== "active";
  const myVote = pr.myVote || 0;
  return [
    { vote: 10, label: "Approve", checked: myVote === 10, disabled: closed },
    { vote: 5, label: "Approve with suggestions", checked: myVote === 5, disabled: closed },
    { vote: 0, label: "Reset feedback", checked: false, disabled: closed || myVote === 0 },
  ];
}

export type LifecycleAction =
  | "complete"
  | "autoComplete"
  | "cancelAutoComplete"
  | "draft"
  | "publish"
  | "abandon"
  | "reactivate";

export interface LifecycleItem {
  action: LifecycleAction;
  label: string;
  disabled: boolean;
  hint?: string;
  danger?: boolean;
}

export function lifecycleMenuItems(pr: {
  status?: string;
  isDraft?: boolean;
  autoCompleteSetBy?: string;
}): LifecycleItem[] {
  if (pr.status === "abandoned") return [{ action: "reactivate", label: "Reactivate", disabled: false }];
  const done = pr.status !== "active";
  const draftHint = pr.isDraft ? "Publish the draft first" : undefined;
  return [
    { action: "complete", label: "Complete…", disabled: done || !!pr.isDraft, hint: draftHint },
    pr.autoCompleteSetBy
      ? {
          action: "cancelAutoComplete",
          label: "Cancel auto-complete",
          disabled: done,
          hint: `Set by ${pr.autoCompleteSetBy}`,
        }
      : { action: "autoComplete", label: "Set auto-complete…", disabled: done || !!pr.isDraft, hint: draftHint },
    pr.isDraft
      ? { action: "publish", label: "Publish", disabled: done }
      : { action: "draft", label: "Mark as draft", disabled: done },
    { action: "abandon", label: "Abandon…", disabled: done, danger: true },
  ];
}

export function defaultMergeMessage(prId: number | string, title: string): string {
  return `Merged PR ${prId}: ${title}`;
}
