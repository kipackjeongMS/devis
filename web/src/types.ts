// Shared data shapes for the ADO DevOps canvas frontend.
// These mirror the JSON returned by the extension's backend API (see src/api.mts).

/** One reviewer's standing on a PR. `vote`: 10 approved · 5 approved w/ suggestions
 *  · 0 no vote · -5 waiting for author · -10 rejected. */
export interface Reviewer {
  id: string;
  name: string;
  vote: number;
  isRequired: boolean;
  isContainer: boolean; // true = group/team entry, not an individual
}

/** A pull request as returned by GET /api/prs (one list item). */
export interface PR {
  id: number;
  mine: boolean;
  authoredByMe?: boolean; // I created this PR
  title: string;
  org: string;
  project: string;
  repo: string;
  repoId: string;
  sourceRef: string;
  targetRef: string;
  author: string;
  created: string;
  isDraft: boolean;
  status?: string; // active | completed | abandoned
  reviewers?: Reviewer[];
  myVote?: number; // current user's own vote (0 when not an individual reviewer)
  iCommented?: boolean; // current user left at least one non-system comment
  plateDismissed?: boolean; // user removed this PR from My Plate
  url: string;
}

/** The commit anchors for a PR's latest iteration. */
export interface Commits {
  source: string;
  base: string;
  iteration?: number;
}

/** One changed file in a PR. `_diff` caches the lazily-fetched diff. */
export interface FileChange {
  path: string;
  changeType: string;
  _diff?: Diff;
}

/** A single comment inside a thread. */
export interface Comment {
  id: number;
  author: string;
  content: string;
  parentCommentId?: number;
  published?: string;
}

/** A comment thread, optionally anchored to a file/line (or range via endLine). */
export interface Thread {
  id: number;
  status: string;
  filePath?: string | null;
  line?: number | null;
  endLine?: number | null;
  side?: string;
  comments: Comment[];
}

/** PR detail as returned by GET /api/pr. */
export interface Detail {
  description?: string;
  files: FileChange[];
  threads: Thread[];
  commits: Commits;
  status?: string; // active | completed | abandoned
  isDraft?: boolean;
  reviewers?: Reviewer[];
  myVote?: number; // current user's own vote (0 when not an individual reviewer)
  iCommented?: boolean; // current user left at least one (non-system) comment
  autoCompleteSetBy?: string; // display name of whoever enabled auto-complete
  completionOptions?: {
    mergeStrategy?: string;
    deleteSourceBranch?: boolean;
    transitionWorkItems?: boolean;
    mergeCommitMessage?: string;
  };
}

/** One line in a computed diff hunk. */
export interface DiffLine {
  t: string; // "add" | "del" | "ctx"
  o?: number | null; // old (left) line number
  nn?: number | null; // new (right) line number
  text: string;
}

/** Diff as returned by GET /api/diff (or an { _error } placeholder from ensureDiff). */
export interface Diff {
  hunks?: DiffLine[][];
  tooLarge?: boolean;
  oldCount?: number;
  newCount?: number;
  _error?: string;
}

/** A structured, line-anchored review finding — staged as an inline comment. */
export interface Finding {
  id: string;
  file?: string | null;
  line?: number | null;
  endLine?: number | null;
  side?: string | null; // "left" | "right"
  severity?: string | null; // "critical" | "high" | "medium" | "low" | "nit"
  title?: string | null;
  comment: string;
  technicalExplanation?: string | null;
  humanizedComment?: string | null;
  posted?: boolean;
}

/** A structured PR-level concern that is not tied to one changed line. */
export interface SemanticFinding {
  id: string;
  category: string;
  severity: string;
  title: string;
  comment: string;
  files?: string[];
  humanizedComment?: string | null;
  posted?: boolean;
}

/** A stored background-review result (GET /api/review-result[s]). */
export interface Review {
  pr_id?: string;
  status: string; // "pending" | "queued" | "running" | "done" | "error"
  summary?: string;
  story?: string;
  findings?: string;
  findingsList?: Finding[];
  semanticFindingsList?: SemanticFinding[];
  error?: string;
  run_id?: string;
  /** Copilot session that performed the review; follow-ups resume into it. */
  reviewer_session_id?: string | null;
  /** Legacy review-row mirror of the My Plate removal preference. */
  dismissed?: number;
  updated_at?: string;
  org?: string;
  project?: string;
  repo?: string;
  repo_id?: string;
  title?: string;
}

export interface ActiveReviewJob {
  pr_id: string;
  org: string;
  project: string;
  repo: string;
  repo_id: string;
  status: string;
}

/** Persisted extension config (GET/POST /api/config). */
export interface Config {
  organizations: string[];
  projects: Record<string, string[]>;
  reviewModel: string;
  reviewsDir: string;
}

/** How the list is filtered by reviewer assignment. */
export type Assignment = "mine" | "notmine" | "all";

/** One persisted inbox notification (mirrors NotificationRow in store.mts). */
export interface Notification {
  id: string;
  kind: string; // "comment" | "reply"
  pr_id: string | null;
  org: string | null;
  project: string | null;
  repo: string | null;
  repo_id: string | null;
  title: string | null;
  actor: string | null;
  summary: string | null;
  snippet: string | null;
  url: string | null;
  unread: number;
  created_at: string | null;
  read_at: string | null;
}

/** The single client-side app state singleton. */
export interface AppState {
  config: Config;
  prs: PR[];
  org: string;
  project: string;
  assignment: Assignment;
  reviews: Record<string, Review>;
  activeReviewJobs: Record<string, ActiveReviewJob>;
  current?: { pr: PR; detail: Detail };
}
