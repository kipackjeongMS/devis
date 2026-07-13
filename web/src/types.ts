// Shared data shapes for the ADO DevOps canvas frontend.
// These mirror the JSON returned by the extension's backend API (see src/api.mts).

/** A pull request as returned by GET /api/prs (one list item). */
export interface PR {
  id: number;
  mine: boolean;
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
  severity?: string | null; // "high" | "medium" | "low" | "nit"
  title?: string | null;
  comment: string;
  posted?: boolean;
}

/** A stored background-review result (GET /api/review-result[s]). */
export interface Review {
  pr_id?: string;
  status: string; // "pending" | "running" | "done" | "error"
  summary?: string;
  story?: string;
  findings?: string;
  findingsList?: Finding[];
  error?: string;
  updated_at?: string;
  org?: string;
  project?: string;
  repo?: string;
  title?: string;
}

/** Persisted extension config (GET/POST /api/config). */
export interface Config {
  organizations: string[];
  projects: Record<string, string[]>;
  reviewModel: string;
}

/** How the list is filtered by reviewer assignment. */
export type Assignment = "mine" | "notmine" | "all";

/** The single client-side app state singleton. */
export interface AppState {
  config: Config;
  prs: PR[];
  org: string;
  project: string;
  assignment: Assignment;
  reviews: Record<string, Review>;
  current?: { pr: PR; detail: Detail };
}

// ---- Ev2 rollouts ("Release Dashboard") ----

/** One rollout summary as returned by GET /api/ev2/rollouts. */
export interface RolloutSummary {
  serviceGroup: string;
  id: string;
  status: string;
  startTime: string | null;
  buildVersion: string | null;
  environment: string | null;
  url: string;
}

/** A service group and its recent rollouts. */
export interface ServiceGroupRollouts {
  name: string;
  rollouts: RolloutSummary[];
}

/** One region's status inside a rollout's stage grid. */
export interface RegionInfo {
  name: string;
  status: string;
  startTime: string | null;
  endTime: string | null;
}

/** One rollout stage (a group of regions). */
export interface StageInfo {
  name: string;
  regions: RegionInfo[];
}

/** The lazily-loaded stage/region grid for a rollout (GET /api/ev2/rollout). */
export interface RolloutGrid {
  id: string;
  status: string;
  buildVersion: string | null;
  environment: string | null;
  url: string;
  stages: StageInfo[];
}
