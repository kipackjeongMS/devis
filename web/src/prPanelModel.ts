// Pure rules for the Workspace's Pull Requests panel: My PRs and Reviews.
// No DOM and no app state, so harnesses can import the compiled module directly.
import { matchNotificationPr } from "./inboxRoute.js";
import { matchesQuery, needsAuthorAction, parseQuery, plural, type ReviewPhase } from "./queueModel.js";
import type { Notification, PR } from "./types.js";

/** One PR's identity across every list: org, project, repository and id. */
export const prIdentity = (pr: Pick<PR, "org" | "project" | "repoId" | "id">): string =>
  JSON.stringify([pr.org, pr.project, pr.repoId, String(pr.id)]);

const time = (iso: string | null | undefined): number => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : 0;
};

/** Every PR in the lists once; the first copy wins. */
export function uniquePrs(lists: ReadonlyArray<readonly PR[]>): PR[] {
  const seen = new Set<string>();
  const out: PR[] = [];
  for (const list of lists) {
    for (const pr of list) {
      const id = prIdentity(pr);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(pr);
    }
  }
  return out;
}

/** When the author last pushed: only a push after the PR opened counts. */
function pushedAfterOpen(pr: Pick<PR, "pushedAt" | "created">): number {
  const pushed = time(pr.pushedAt);
  return pushed > time(pr.created) ? pushed : 0;
}

/** "Dana", "Dana and Lee", "Dana and 2 others". */
export function namesLine(names: readonly string[]): string {
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length <= 1) return unique[0] || "Someone";
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  return `${unique[0]} and ${unique.length - 1} others`;
}

// ---- My PRs -------------------------------------------------------------------------

export type MineAttention = "activity" | "rejected" | "waiting" | null;

export interface MineRow {
  pr: PR;
  /** Unread inbox items on this PR, newest first. */
  unread: Notification[];
  attention: MineAttention;
  /** The line under the title when the PR needs you, or "". */
  label: string;
  tone: "accent" | "bad" | "warn" | "";
}

const MINE_RANK: Record<Exclude<MineAttention, null>, number> = { activity: 0, rejected: 1, waiting: 1 };

/** What happened since you last looked: "2 new comments · Dana and Lee". */
export function activityLabel(unread: readonly Notification[]): string {
  const replies = unread.every((n) => n.kind === "reply");
  const what = replies ? plural(unread.length, "new reply", "new replies") : plural(unread.length, "new comment");
  return `${what} · ${namesLine(unread.map((n) => n.actor || ""))}`;
}

function mineRow(pr: PR, unread: Notification[]): MineRow {
  if (unread.length) return { pr, unread, attention: "activity", label: activityLabel(unread), tone: "accent" };
  if (needsAuthorAction(pr.reviewers)) {
    const people = (pr.reviewers || []).filter((r) => !r.isContainer);
    const rejected = people.filter((r) => r.vote <= -10);
    if (rejected.length) return { pr, unread, attention: "rejected", label: `Rejected by ${namesLine(rejected.map((r) => r.name))}`, tone: "bad" };
    const waiting = people.filter((r) => r.vote <= -5);
    return { pr, unread, attention: "waiting", label: `Waiting on you · ${namesLine(waiting.map((r) => r.name))}`, tone: "warn" };
  }
  return { pr, unread, attention: null, label: "", tone: "" };
}

/** When a My PRs row last moved, for its order and its time. */
export function mineAt(row: Pick<MineRow, "pr" | "unread">): number {
  const latest = Math.max(0, ...row.unread.map((n) => time(n.created_at)));
  return Math.max(latest, pushedAfterOpen(row.pr), time(row.pr.created));
}

/**
 * PRs you opened, drafts included. New comments or replies lead, then PRs a reviewer
 * sent back, then published PRs by their last push, then drafts.
 */
export function myPrs(prs: readonly PR[], authored: readonly PR[], inbox: readonly Notification[]): MineRow[] {
  const mine = uniquePrs([prs.filter((p) => p.authoredByMe), authored]);
  const unreadBy = new Map<string, Notification[]>();
  for (const n of inbox) {
    if (!n.unread) continue;
    const pr = matchNotificationPr(mine, n);
    if (!pr) continue;
    const id = prIdentity(pr);
    unreadBy.set(id, [...(unreadBy.get(id) || []), n]);
  }
  const rank = (row: MineRow): number => (row.attention ? MINE_RANK[row.attention] : row.pr.isDraft ? 3 : 2);
  return mine
    .map((pr) => mineRow(pr, (unreadBy.get(prIdentity(pr)) || []).sort((a, b) => time(b.created_at) - time(a.created_at))))
    .map((row) => ({ row, rank: rank(row), at: mineAt(row) }))
    .sort((a, b) => a.rank - b.rank || b.at - a.at)
    .map(({ row }) => row);
}

/** A key that changes when a row starts needing you, or new activity lands on it. */
export function attentionKey(row: MineRow): string | null {
  if (!row.attention) return null;
  return `${prIdentity(row.pr)}#${row.unread[0]?.id ?? row.attention}`;
}

// ---- Reviews ------------------------------------------------------------------------

export type PrFilter = "assigned" | "copilot" | "weighed" | "drafts";

export const PR_FILTERS: ReadonlyArray<{ id: PrFilter; label: string; title: string }> = [
  { id: "assigned", label: "Assigned", title: "PRs you're a reviewer on" },
  { id: "copilot", label: "Copilot reviewed", title: "PRs Copilot has reviewed" },
  { id: "weighed", label: "Weighed in", title: "PRs you voted or commented on" },
  { id: "drafts", label: "Drafts", title: "Draft PRs" },
];

export const isPrFilter = (v: unknown): v is PrFilter => PR_FILTERS.some((f) => f.id === v);

export function passesFilter(pr: PR, filter: PrFilter, phase: ReviewPhase): boolean {
  switch (filter) {
    case "assigned":
      return !!pr.mine && !pr.authoredByMe;
    case "copilot":
      return phase === "done";
    case "weighed":
      return (pr.myVote || 0) !== 0 || !!pr.iCommented || !!pr.myAt;
    case "drafts":
      return !!pr.isDraft;
  }
}

export type ReasonKind = "copilot" | "copilot-active" | "copilot-error" | "commented" | "voted" | "pushed" | "opened";

export interface ReviewRow {
  pr: PR;
  phase: ReviewPhase;
  /** Someone asked for this review in Teams. */
  asked: boolean;
  /** Why it sits where it does: the latest of these. */
  reason: { kind: ReasonKind; at: string };
}

/** The latest thing that happened on a PR: a Copilot review, your comment or vote, a push, or opening it. */
export function recencyReason(pr: PR, phase: ReviewPhase, copilotAt: string | undefined): ReviewRow["reason"] {
  const options: Array<{ kind: ReasonKind; at: string; t: number }> = [];
  if (phase && copilotAt) {
    const kind: ReasonKind = phase === "active" ? "copilot-active" : phase === "error" ? "copilot-error" : "copilot";
    options.push({ kind, at: copilotAt, t: time(copilotAt) });
  }
  if (pr.myAt) options.push({ kind: pr.myKind === "vote" ? "voted" : "commented", at: pr.myAt, t: time(pr.myAt) });
  const pushed = pushedAfterOpen(pr);
  if (pushed) options.push({ kind: "pushed", at: pr.pushedAt!, t: pushed });
  options.push({ kind: "opened", at: pr.created, t: time(pr.created) });
  // Earlier options win ties: a review or your reply says more than the push it followed.
  const best = options.reduce((a, b) => (b.t > a.t ? b : a));
  return { kind: best.kind, at: best.at };
}

const REASON_TEXT: Record<ReasonKind, string> = {
  copilot: "Copilot reviewed",
  "copilot-active": "Copilot review asked for",
  "copilot-error": "Copilot review failed",
  commented: "You commented",
  voted: "You voted",
  pushed: "Pushed",
  opened: "Opened",
};

/** "Copilot reviewed 2h ago", from a reason and how long ago it was. */
export const reasonText = (kind: ReasonKind, ago: string): string => `${REASON_TEXT[kind]}${ago ? ` ${ago}` : ""}`;

export interface ReviewsOptions {
  query: string;
  filters: ReadonlySet<PrFilter>;
  phaseOf: (pr: PR) => ReviewPhase;
  /** When Copilot last reviewed the PR, if it has. */
  copilotAt: (pr: PR) => string | undefined;
  asked: (pr: PR) => boolean;
  inScope: (pr: PR) => boolean;
}

/** Other people's PRs in scope, before search and filters. */
export function reviewPool(prs: readonly PR[], older: readonly PR[], inScope: (pr: PR) => boolean): PR[] {
  return uniquePrs([prs, older]).filter((pr) => !pr.authoredByMe && !pr.plateDismissed && inScope(pr));
}

/**
 * Other people's PRs, filtered and searched. Teams asks lead; the rest go newest first
 * by the latest Copilot review, your comment or vote, the author's push, or when it opened.
 */
export function reviewsList(prs: readonly PR[], older: readonly PR[], opts: ReviewsOptions): ReviewRow[] {
  const terms = parseQuery(opts.query);
  const rows: Array<{ row: ReviewRow; t: number }> = [];
  for (const pr of reviewPool(prs, older, opts.inScope)) {
    const phase = opts.phaseOf(pr);
    if (![...opts.filters].every((f) => passesFilter(pr, f, phase))) continue;
    if (terms.length && !matchesQuery(pr, terms, phase)) continue;
    const reason = recencyReason(pr, phase, opts.copilotAt(pr));
    rows.push({ row: { pr, phase, asked: opts.asked(pr), reason }, t: time(reason.at) });
  }
  return rows.sort((a, b) => Number(b.row.asked) - Number(a.row.asked) || b.t - a.t).map(({ row }) => row);
}

/** How many review rows show at first, and how many more each step adds. */
export const REVIEW_PAGE = 20;
