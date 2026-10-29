// Pure rules for the PR queue's two views: My feed lanes and the All search.
// No DOM, so harnesses can import the compiled module directly.
import type { PR, QueueView, Reviewer } from "./types.js";

export type { QueueView };

export type FeedLane = "review" | "copilot" | "weighed" | "yours";

/** A PR's Copilot review phase: active (queued or running), done, error, or none. */
export type ReviewPhase = "active" | "done" | "error" | null;

/** What the model needs to know about a PR's Copilot review. */
export interface ReviewInfo {
  phase: ReviewPhase;
  updatedAt?: string;
}

/** Lanes in display order. The most actionable lane leads. */
export const FEED_LANES: ReadonlyArray<{ id: FeedLane; title: string }> = [
  { id: "review", title: "Needs your review" },
  { id: "copilot", title: "Copilot reviewed" },
  { id: "weighed", title: "You've weighed in" },
  { id: "yours", title: "Your pull requests" },
];

type LanePr = Pick<PR, "mine" | "authoredByMe" | "myVote" | "iCommented">;

/**
 * The one lane a PR lands in, or null when it is not in My feed. Rules apply in
 * order: authored, then voted or commented, then assigned, then Copilot-reviewed.
 * Hiding (plateDismissed) is applied by the caller, so hidden PRs keep their lane.
 */
export function feedLane(pr: LanePr, phase: ReviewPhase): FeedLane | null {
  if (pr.authoredByMe) return "yours";
  if ((pr.myVote || 0) !== 0 || pr.iCommented) return "weighed";
  if (pr.mine) return "review";
  if (phase) return "copilot";
  return null;
}

/** True when an individual reviewer is waiting for the author or has rejected. */
export function needsAuthorAction(reviewers: Reviewer[] | undefined): boolean {
  return (reviewers || []).some((r) => !r.isContainer && r.vote <= -5);
}

const time = (iso: string | undefined): number => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : 0;
};

/**
 * Lane order. Every lane sinks drafts below published PRs and keeps newest first.
 * Your lane floats PRs waiting on you; the Copilot lane leads with reviews in
 * progress, then the most recently finished.
 */
export function sortLane(lane: FeedLane, prs: PR[], info: (pr: PR) => ReviewInfo): PR[] {
  const rank = (pr: PR): number[] => {
    const draft = pr.isDraft ? 1 : 0;
    if (lane === "yours") return [needsAuthorAction(pr.reviewers) ? 0 : 1, draft, -time(pr.created)];
    if (lane === "copilot") {
      const r = info(pr);
      return [r.phase === "active" ? 0 : 1, draft, -time(r.updatedAt), -time(pr.created)];
    }
    return [draft, -time(pr.created)];
  };
  return prs
    .map((pr, index) => ({ pr, index, key: rank(pr) }))
    .sort((a, b) => {
      for (let i = 0; i < a.key.length; i++) {
        if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
      }
      return a.index - b.index;
    })
    .map((entry) => entry.pr);
}

/** A short status note for a lane head, or "" when there is nothing to call out. */
export function laneNote(lane: FeedLane, prs: PR[], info: (pr: PR) => ReviewInfo, now: number): string {
  if (!prs.length) return "";
  if (lane === "review") {
    const oldest = Math.min(...prs.map((pr) => time(pr.created) || now));
    const days = Math.floor((now - oldest) / 86_400_000);
    return days >= 1 ? `oldest ${days}d` : "";
  }
  if (lane === "copilot") {
    const active = prs.filter((pr) => info(pr).phase === "active").length;
    const failed = prs.filter((pr) => info(pr).phase === "error").length;
    const parts: string[] = [];
    if (active) parts.push(`${active} in progress`);
    if (failed) parts.push(`${failed} failed`);
    return parts.join(" · ");
  }
  if (lane === "yours") {
    const waiting = prs.filter((pr) => needsAuthorAction(pr.reviewers)).length;
    return waiting ? `${waiting} waiting on you` : "";
  }
  return "";
}

export function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The bulk bar's resting line for My feed: the first two non-empty lanes. */
export function feedSummary(counts: Partial<Record<FeedLane, number>>): string {
  const phrase: Record<FeedLane, (n: number) => string> = {
    review: (n) => `${n} need${n === 1 ? "s" : ""} your review`,
    copilot: (n) => `${n} from Copilot`,
    weighed: (n) => `${n} you've weighed in on`,
    yours: (n) => `${n} of yours`,
  };
  const parts = FEED_LANES.filter(({ id }) => (counts[id] || 0) > 0).map(({ id }) => phrase[id](counts[id]!));
  return parts.length ? parts.slice(0, 2).join(" · ") : "Nothing in your feed";
}

// ---- search -------------------------------------------------------------------------

export type QueryKey = "text" | "is" | "repo" | "author" | "branch";

export interface QueryTerm {
  neg: boolean;
  key: QueryKey;
  value: string;
}

const QUALIFIER = /^(is|repo|author|branch):(.+)$/;

/**
 * Whitespace-separated terms, all of which must match. A leading "-" negates a
 * term. `is:draft|published|reviewed|yours|assigned`, `repo:`, `author:` and
 * `branch:` narrow to one field; anything else matches title, #id, author, repo,
 * project and both branches. Matching is case-insensitive.
 */
export function parseQuery(query: string): QueryTerm[] {
  const terms: QueryTerm[] = [];
  for (const raw of query.toLowerCase().split(/\s+/)) {
    if (!raw) continue;
    const neg = raw.length > 1 && raw.startsWith("-");
    const body = neg ? raw.slice(1) : raw;
    const q = QUALIFIER.exec(body);
    if (q) terms.push({ neg, key: q[1] as QueryKey, value: q[2] });
    else {
      const value = body.length > 1 ? body.replace(/^#/, "") : body;
      terms.push({ neg, key: "text", value });
    }
  }
  return terms;
}

type SearchPr = Pick<
  PR,
  "id" | "title" | "author" | "repo" | "project" | "sourceRef" | "targetRef" | "isDraft" | "mine" | "authoredByMe"
>;

function termHits(pr: SearchPr, term: QueryTerm, phase: ReviewPhase): boolean {
  const has = (field: unknown): boolean => String(field ?? "").toLowerCase().includes(term.value);
  switch (term.key) {
    case "repo":
      return has(pr.repo);
    case "author":
      return has(pr.author);
    case "branch":
      return has(pr.sourceRef) || has(pr.targetRef);
    case "is":
      switch (term.value) {
        case "draft":
          return !!pr.isDraft;
        case "published":
          return !pr.isDraft;
        case "reviewed":
          return phase === "done";
        case "yours":
        case "mine":
          return !!pr.authoredByMe;
        case "assigned":
          return !!pr.mine && !pr.authoredByMe;
        default:
          return false;
      }
    default:
      return [pr.title, pr.id, pr.author, pr.repo, pr.project, pr.sourceRef, pr.targetRef].some(has);
  }
}

export function matchesQuery(pr: SearchPr, terms: QueryTerm[], phase: ReviewPhase): boolean {
  return terms.every((term) => termHits(pr, term, phase) !== term.neg);
}
