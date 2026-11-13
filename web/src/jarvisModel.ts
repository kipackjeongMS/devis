// Pure rules for Jarvis' Today dashboard: which section a task belongs in, the
// PR review queue, the service filter, and the wording of worker states. No
// DOM, so harnesses can import the compiled module directly.
import { feedLane, type ReviewPhase } from "./queueModel.js";
import type { PR } from "./types.js";
import type { ChatImage } from "./chatImages.js";
import type { ChatsDigest, MeetingsDigest } from "./commsModel.js";

export type WorkerState = "working" | "needsInput" | "turnDone" | "idle" | "stopped" | "error";

export interface WorkerRequest {
  id: string;
  /**
   * repos: the worker proposes repositories and the user confirms which it gets worktrees of.
   * ship: a worker on a Devis task asks to ship its change to Devis itself.
   */
  kind: "question" | "permission" | "repos" | "ship";
  title: string;
  detail: string;
  choices: string[];
  allowFreeform: boolean;
  /** For repos: the ones the worker proposed. */
  selected?: string[];
  ship?: ShipRequest;
  at: string;
}

/** A file a Devis change touches; a sensitive one needs the user's tick before it ships. */
export interface ShipFile {
  path: string;
  /** Null for a binary file. */
  added: number | null;
  removed: number | null;
  sensitive: boolean;
}

/** What a worker on a Devis task asks the user to ship (devis-self.mts). */
export interface ShipRequest {
  branch: string;
  files: ShipFile[];
  sensitive: string[];
  checks: { passed: number; total: number; preexisting: string[]; ms: number };
  /** Master moved since the branch left it: it's rebased and checked again when it ships. */
  behind: boolean;
}

export type ShipState = "deploying" | "live" | "rolled-back" | "failed";

/** One change shipped to Devis itself, in Settings' history. */
export interface DevisShip {
  n: number;
  taskId: string;
  sessionId: string;
  worker: string;
  title: string;
  summary: string;
  branch: string;
  before: string;
  commit: string;
  state: ShipState;
  mode: "idle" | "now";
  files: ShipFile[];
  sensitive: string[];
  checks: { passed: number; total: number; preexisting: string[]; ms: number };
  note: string | null;
  log: string | null;
  shippedAt: string;
  settledAt: string | null;
  revertedBy: number | null;
  undoTaskId: string | null;
  dismissed: boolean;
}

/** Settings' "Change Devis itself" card. */
export interface DevisOverview {
  enabled: boolean;
  /** The Devis source folder changes are made in; "" when unset. */
  source: string;
  /** Why the source folder can't be used, if it can't. */
  sourceProblem: string | null;
  /** The commit the running build came from. */
  commit: string | null;
  ships: DevisShip[];
  checking: { label: string; step: string; startedAt: string } | null;
  busy: boolean;
}

/** The ship worth a banner on Today. */
export interface DevisBanner {
  n: number;
  state: ShipState;
  mode: "idle" | "now";
  title: string;
  note: string | null;
  at: string;
}

/** The banner's line for a ship. */
export function devisBannerText(b: DevisBanner): string {
  if (b.state === "deploying") return `Updating Devis to ship ${b.n}: ${b.title}`;
  if (b.state === "live") return `Devis is on ship ${b.n}: ${b.title}`;
  const what = b.state === "rolled-back" ? "rolled back" : "didn't ship";
  return `Ship ${b.n} ${what}: ${b.note || b.title}`;
}

/** A release worth a banner on Today (updates.mts updateBanner). */
export interface UpdateBanner {
  state: "ready" | "paused" | "installing" | "live" | "rolled-back" | "failed";
  version: string;
  /** The release's title, when it says more than its tag. */
  name: string | null;
  url: string;
  note: string | null;
  mode: "idle" | "now" | null;
  install: "idle" | "ask";
  pause: { reason: "source" | "ships"; ships: number } | null;
}

/** The banner's line for a release. */
export function updateBannerText(b: UpdateBanner): string {
  const v = `Devis ${b.version}`;
  switch (b.state) {
    case "installing":
      return b.mode === "now" ? `Installing ${v}. Devis restarts in a moment.` : `${v} installs once the workers are done, then Devis restarts.`;
    case "ready":
      return `${v} is ready${b.name ? `: ${b.name}` : "."}`;
    case "paused":
      return b.pause?.reason === "ships"
        ? `${v} is out. Your ${b.pause.ships === 1 ? "ship pauses" : `${b.pause.ships} ships pause`} updates.`
        : `${v} is out. This Devis is built from your source, so it doesn't install releases.`;
    case "live":
      return `Devis is on ${b.version}.`;
    case "rolled-back":
      return `${v} rolled back: ${b.note || "the new build didn't come up."}`;
    default:
      return `${v} didn't install: ${b.note || "Setup didn't finish."}`;
  }
}

/** One repository a worker works in: a worktree on its own branch. */
export interface WorkerWorktree {
  org: string;
  project: string;
  repo: string;
  path: string;
  branch: string;
  base: string;
}

export interface TodayWorker {
  sessionId: string;
  taskId: string;
  label: string;
  cwd: string;
  model: string | null;
  /** Reasoning effort chosen with `model`; null for its default. */
  effort?: string | null;
  state: WorkerState;
  summary: string;
  autoApprove: boolean;
  createdAt: string;
  updatedAt: string;
  /** When `state` last changed (a failed turn is known by it). */
  stateAt?: string;
  busy: boolean;
  partial: string;
  /** The message id of `partial`: a new id is a new reply. */
  partialId?: string;
  activity: string;
  requests: WorkerRequest[];
  /** Messages sent while a turn ran, waiting their turn. */
  queue?: Array<{ id: string; text: string; at: string; images?: ChatImage[] }>;
  /** A stop or failure holds the queue until the user sends again. */
  queueHeld?: boolean;
  /** Messages sent into the current turn. */
  steered?: Array<{ id: string; text: string; at: string; images?: ChatImage[] }>;
  /** A message sent now goes into the running turn. */
  canSteer?: boolean;
  /** What the attached session runs, when known. */
  currentModel?: string | null;
  currentEffort?: string | null;
  /** Its repositories, on a task with a folder. */
  worktrees?: WorkerWorktree[];
}

/** The fields a live read of one worker's turn (/api/jarvis/workers/live) brings, fresher than Today's. */
export const LIVE_FIELDS = [
  "busy",
  "partial",
  "partialId",
  "activity",
  "requests",
  "queue",
  "queueHeld",
  "steered",
  "canSteer",
  "currentModel",
  "currentEffort",
  "state",
  "summary",
  "updatedAt",
] as const;

export type WorkerLive = Pick<TodayWorker, (typeof LIVE_FIELDS)[number]>;

/** A live read of a worker, and when it arrived. */
export interface LiveRead {
  sessionId: string;
  view: WorkerLive;
  at: number;
}

/**
 * The worker as the chat should show it: Today's read, with the live fields of a live read of
 * the same worker. While the chat follows the worker, its live read always wins: it's at most a
 * moment old, and it carries the turn's messages with its partial, so the two never disagree.
 * Otherwise the newer of the two wins: an older live read never undoes what Today saw after it.
 */
export function withLive(w: TodayWorker, live: LiveRead | null, todayAt: number, following = false): TodayWorker {
  if (!live || live.sessionId !== w.sessionId || (!following && live.at < todayAt)) return w;
  const next = { ...w } as Record<string, unknown>;
  for (const key of LIVE_FIELDS) if (live.view[key] !== undefined) next[key] = live.view[key];
  return next as unknown as TodayWorker;
}

export interface TaskWorkItem {
  id: number;
  type: string;
  state: string;
  url: string;
  parent: { id: number; type: string; title: string } | null;
}

export interface StatusUpdate {
  id: number;
  taskId: string;
  at: string;
  /** A worker's label, "you", or the lead (Devis). */
  author: string;
  sessionId: string | null;
  text: string;
}

export interface TaskUpdates {
  latest: StatusUpdate | null;
  /** Today's updates, newest first. */
  today: StatusUpdate[];
}

export type OverviewPhase = "none" | "fresh" | "updating" | "failed";

export interface OverviewState {
  phase: OverviewPhase;
  text: string | null;
  at: string | null;
  stale: boolean;
  error: string | null;
  model: string | null;
}

export interface RecapState {
  state: "waiting" | "writing" | "failed";
  by: string | null;
  error: string | null;
  at: string;
}

export type PrSource = "workitem" | "user" | "created" | "worker" | "branch";

export interface PrReviewer {
  name: string;
  vote: number;
  isRequired: boolean;
  isContainer: boolean;
}

export interface PrSnapshot {
  project: string;
  projectId: string;
  repo: string;
  repoId: string;
  title: string;
  status: string;
  isDraft: boolean;
  author: string;
  authorId: string;
  created: string;
  closed: string | null;
  sourceRef: string;
  targetRef: string;
  url: string;
  mergeStatus: string;
  reviewers: PrReviewer[];
}

export interface PrChecksSummary {
  passed: number;
  failed: number;
  running: number;
  total: number;
  failing: string[];
}

/** A pull request linked to a task, as last read from Azure DevOps. */
export interface TaskPr {
  taskId: string;
  org: string;
  prId: number;
  source: PrSource;
  linkedAt: string;
  hidden: boolean;
  snapshot: PrSnapshot | null;
  checks: PrChecksSummary | null;
  unresolved: number | null;
  refreshedAt: string | null;
  error: string | null;
}

export interface TodayTask {
  id: string;
  title: string;
  /** What the task is for. */
  description?: string;
  /** The task's own folder, where each worker gets a folder with its worktrees. Null for older tasks. */
  folder?: string | null;
  /** "devis": a change to Devis itself, shipped through the self-change pipeline. */
  kind?: "devis";
  org: string | null;
  project: string | null;
  workItem: TaskWorkItem | null;
  status: "open" | "done";
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
  workers: TodayWorker[];
  updates: TaskUpdates;
  /** A recap on its way, or why the last one failed. */
  recap?: RecapState | null;
  /** Pull requests linked to the task. */
  prs?: TaskPr[];
  /** The task's validation chain, its last run and any proposal. */
  validation?: ValidationSummary | null;
  /** Review comments on the task's PRs: being reviewed, or waiting on the user. */
  prComments?: PrCommentSummary[];
  /** Failed blocking builds on the task's PRs: being reviewed, fixed, or waiting on the user. */
  prBuilds?: PrBuildSummary[];
}

// ---- a task's validation chain ---------------------------------------------------------

export interface ValidationRunSummary {
  runId: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  done: number;
  total: number;
  current: string | null;
  failed: string | null;
}

export interface ValidationSummary {
  chainId: string | null;
  name: string | null;
  blocks: number;
  run: ValidationRunSummary | null;
  proposal: { by: string; at: string; blocks: number } | null;
  attention: "proposal" | "failed" | null;
}

export interface ValidationEvidence {
  kind: "prCheck" | "consumes" | "history" | "docs" | "agent" | "production";
  label: string;
  detail?: string;
  verified: boolean;
}

export interface ProposedBlock {
  key: string;
  org: string;
  project: string;
  definitionId: number;
  name: string;
  path: string;
  stage: number;
  after: string[];
  branch: string;
  branchFrom?: { org: string; prId: number };
  params?: Record<string, string>;
  /** Branches for the YAML's repository resources, by alias. */
  repoBranches?: Record<string, string>;
  reason: string;
  evidence: ValidationEvidence[];
}

export interface ValidationProposal {
  id: string;
  summary: string;
  blocks: ProposedBlock[];
  leftOut: Array<{ key: string; name: string; reason: string; evidence: ValidationEvidence[] }>;
  checks: Array<{ tone: "ok" | "warn"; text: string }>;
  by: string;
  sessionId: string | null;
  at: string;
}

export interface ValidationNode {
  id: string;
  org: string;
  project: string;
  definitionId: number;
  name: string;
  path?: string;
  branch: string;
  branchFrom?: { org: string; prId: number };
  params?: Record<string, string>;
  repoBranches?: Record<string, string>;
}

export interface ValidationNodeState {
  status: string;
  buildId?: number;
  buildNumber?: string;
  url?: string;
  error?: string;
  branch?: string;
}

export interface ValidationView {
  taskId: string;
  taskStatus: "open" | "done";
  chain: { id: string; name: string; graph: { nodes: ValidationNode[]; edges: Array<{ from: string; to: string }> } } | null;
  run: { runId: string; status: string; createdAt: string; finishedAt: string | null; cancelRequested?: boolean; states: Record<string, ValidationNodeState> } | null;
  runs: Array<{ runId: string; status: string; createdAt: string; finishedAt: string | null; text: string }>;
  proposal: ValidationProposal | null;
  evidence: Record<string, { reason: string; evidence: ValidationEvidence[]; by: string }>;
  acceptedAt: string | null;
  acceptedBy: string | null;
  notifyWorker: boolean;
  rerunOnCommit: boolean;
  ackedRunId: string | null;
  autoPropose: boolean;
  prs: Array<{ org: string; prId: number; title: string; sourceRef: string; status: string }>;
  templates: Array<{ id: string; name: string; nodeCount: number }>;
  summary: ValidationSummary | null;
}

/** Stages, left to right: a block's stage is one more than the latest stage it runs after. */
export function chainStages<T extends { id: string }>(nodes: T[], edges: Array<{ from: string; to: string }>): T[][] {
  const stage = new Map<string, number>();
  const parents = new Map<string, string[]>();
  for (const e of edges) parents.set(e.to, [...(parents.get(e.to) || []), e.from]);
  const visit = (id: string, seen: Set<string>): number => {
    if (stage.has(id)) return stage.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const s = Math.max(-1, ...(parents.get(id) || []).map((p) => visit(p, seen))) + 1;
    stage.set(id, s);
    return s;
  };
  for (const n of nodes) visit(n.id, new Set());
  const out: T[][] = [];
  for (const n of nodes) (out[stage.get(n.id) || 0] ||= []).push(n);
  return out.filter(Boolean);
}

/** The card chip: "Validation · 2 of 4 · Deploy running", "Validation failed · Deploy Dev", "Validation proposed". */
export function validationChip(v: ValidationSummary | null | undefined): { text: string; tone: Tone } | null {
  if (!v) return null;
  if (v.attention === "proposal" && v.proposal) return { text: `Validation proposed · ${v.proposal.blocks} pipelines`, tone: "warn" };
  const r = v.run;
  if (!v.chainId) return null;
  if (!r) return { text: `Validation · ${v.blocks} pipeline${v.blocks === 1 ? "" : "s"} · not run`, tone: "idle" };
  if (r.status === "running") return { text: `Validation · ${r.done} of ${r.total}${r.current ? ` · ${r.current}` : ""}`, tone: "run" };
  if (r.status === "succeeded") return { text: "Validation passed", tone: "ok" };
  if (r.status === "failed") return { text: `Validation failed${r.failed ? ` · ${r.failed}` : ""}`, tone: v.attention === "failed" ? "warn" : "off" };
  if (r.status === "canceled") return { text: "Validation stopped", tone: "off" };
  return { text: `Validation · ${r.status}`, tone: "idle" };
}

/** Why the task's validation needs the user, for Needs you; null when it doesn't. */
export function validationNeed(task: Pick<TodayTask, "status" | "validation">): string | null {
  const v = task.validation;
  if (!v || task.status !== "open") return null;
  if (v.attention === "proposal" && v.proposal) return `${v.proposal.by} proposed a validation chain of ${v.proposal.blocks} pipeline${v.proposal.blocks === 1 ? "" : "s"}`;
  if (v.attention === "failed") return `Validation failed${v.run?.failed ? ` at ${v.run.failed}` : ""}`;
  return null;
}

// ---- review comments on the task's PRs (jarvis-pr-comments.mts) -------------------------

export type PrReviewState = "watching" | "collecting" | "auditing" | "awaiting" | "applying" | "error";
export type PrCommentVerdict = "ready" | "choice" | "unclear" | "nochange";
export type PrConfidence = "high" | "medium" | "low";
export type PrThreadStatus = "fixed" | "wontFix" | "byDesign" | "closed" | "active";

export interface PrProposalItem {
  threadId: number;
  file: string | null;
  line: number | null;
  reviewer: string;
  /** The reviewer's latest comment on the thread. */
  comment: string;
  /** What the reviewer asks for, in the worker's words. */
  ask: string;
  verdict: PrCommentVerdict;
  confidence: PrConfidence;
  reason: string;
  plan: string;
  options?: { id: string; label: string; plan: string }[];
  recommended?: string;
  files: string[];
  reply: string;
  status: PrThreadStatus;
}

export interface PrCommentProposal {
  id: string;
  summary: string;
  items: PrProposalItem[];
  by: string;
  sessionId: string;
  at: string;
  baseCommit: string | null;
  stale: boolean;
}

export interface PrApplyState {
  proposalId: string;
  sessionId: string;
  items: { threadId: number; file: string | null; ask: string; plan: string; files: string[]; reply: string; status: PrThreadStatus; note?: string }[];
  sentAt: string | null;
  commit: string | null;
  posted: Record<string, number>;
}

/** One PR's comment review, as Today, Needs you and the task card show it. */
export interface PrCommentSummary {
  org: string;
  prId: number;
  title: string;
  state: PrReviewState;
  worker: string | null;
  items: number;
  ready: number;
  choice: number;
  unclear: number;
  nochange: number;
  at: string;
  note: string | null;
  attention: "proposal" | "error" | null;
}

export interface PrCommentsPr {
  org: string;
  prId: number;
  title: string;
  url: string;
  repo: string;
  branch: string;
  state: PrReviewState;
  worker: string | null;
  note: string | null;
  proposal: PrCommentProposal | null;
  apply: PrApplyState | null;
}

/** The comment side of the task's Pull requests tab. */
export interface PrCommentsView {
  auto: boolean;
  prs: PrCommentsPr[];
}

export type PrDecisionAction = "apply" | "reply" | "decline" | "defer";
export interface PrDecision {
  threadId: number;
  action: PrDecisionAction;
  reply?: string;
  choice?: string;
  note?: string;
}

/** The Needs you key the server gives a PR's review (jarvis-needs prNeedKey): a new proposal is a new ask. */
export function prNeedKey(taskId: string, s: Pick<PrCommentSummary, "org" | "prId" | "at">): string {
  return `need:pr:${taskId}:${s.org.toLowerCase()}:${s.prId}:${s.at}`;
}

/** The task's PR reviews waiting on the user: a plan to look at, or one that went wrong. */
export function prCommentsNeeds(task: Pick<TodayTask, "status" | "prComments">): PrCommentSummary[] {
  return task.status === "open" ? (task.prComments || []).filter((s) => s.attention) : [];
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "PR 1234 got 4 review comments. Worker 2 has a plan: 3 fixes ready, 1 needs your call." */
export function prCommentsNeedText(s: PrCommentSummary): string {
  const who = s.worker || "The worker";
  if (s.attention === "error") return `PR ${s.prId}: ${s.note || `${who} couldn't handle the review comments.`}`;
  if (!s.items) return `PR ${s.prId}: ${who} has a plan for the review comments.`;
  const parts = [
    s.ready ? count(s.ready, "fix ready", "fixes ready") : "",
    s.choice ? count(s.choice, "needs your call", "need your call") : "",
    s.unclear ? count(s.unclear, "needs a question back", "need a question back") : "",
    s.nochange ? count(s.nochange, "just needs a reply", "just need a reply") : "",
  ].filter(Boolean);
  return `PR ${s.prId} got ${count(s.items, "review comment", "review comments")}. ${who} has a plan: ${parts.join(", ")}.`;
}

const REVIEW_RANK: Record<PrReviewState, number> = { error: 0, awaiting: 1, applying: 2, auditing: 3, collecting: 4, watching: 5 };

/** The card chip and Pull requests tab dot: the PR review that matters most right now. */
export function prCommentsChip(list: PrCommentSummary[] | null | undefined): { text: string; tone: Tone } | null {
  const top = (list || []).slice().sort((a, b) => REVIEW_RANK[a.state] - REVIEW_RANK[b.state])[0];
  if (!top) return null;
  const pr = `PR ${top.prId}`;
  if (top.attention === "error") return { text: `Comments · ${pr} · went wrong`, tone: "warn" };
  if (top.attention === "proposal") return { text: `Comments · ${pr} · plan ready`, tone: "warn" };
  if (top.state === "applying") return { text: `Comments · ${pr} · applying fixes`, tone: "run" };
  if (top.state === "auditing") return { text: `Comments · ${pr} · reviewing`, tone: "run" };
  if (top.state === "collecting") return { text: `Comments · ${pr} · new comments`, tone: "idle" };
  return null;
}

// ---- failed builds on the task's PRs (jarvis-pr-builds.mts) ------------------------------

export type BuildVerdict = "fix" | "rerun" | "unclear";
/** failed: every blocking build finished and one failed, and no review is under way. */
export type BuildReviewState = "watching" | "failed" | "auditing" | "awaiting" | "applying" | "error";

export interface FailedBuild {
  evaluationId: string;
  definitionId: number;
  name: string;
  buildId: number;
  status: string;
  url: string;
  /** Its policy only builds when someone queues it, so a push doesn't rerun it. */
  manual: boolean;
}

export interface BuildProposalItem {
  evaluationId: string;
  buildId: number;
  name: string;
  verdict: BuildVerdict;
  confidence: PrConfidence;
  /** What failed and why, in the worker's words. */
  cause: string;
  reason: string;
  plan: string;
  options?: { id: string; label: string; plan: string }[];
  recommended?: string;
  files: string[];
}

export interface BuildProposal {
  id: string;
  summary: string;
  items: BuildProposalItem[];
  by: string;
  sessionId: string;
  at: string;
  baseCommit: string | null;
  fingerprint: string;
}

export interface BuildApplyState {
  proposalId: string;
  sessionId: string;
  items: { evaluationId: string; buildId: number; name: string; cause: string; plan: string; files: string[]; note?: string }[];
  requeue: { evaluationId: string; name: string; manual: boolean }[];
  baseCommit: string | null;
  sentAt: string | null;
  commit: string | null;
  requeued: string[];
}

/** One PR's failed-build review, as Today, Needs you and the task card show it. */
export interface PrBuildSummary {
  org: string;
  prId: number;
  title: string;
  state: BuildReviewState;
  worker: string | null;
  items: number;
  fix: number;
  rerun: number;
  unclear: number;
  failed: number;
  at: string;
  note: string | null;
  attention: "proposal" | "error" | null;
}

export interface PrBuildsPr {
  org: string;
  prId: number;
  title: string;
  url: string;
  repo: string;
  branch: string;
  state: BuildReviewState;
  worker: string | null;
  note: string | null;
  commit: string | null;
  failures: FailedBuild[];
  /** Blocking builds still running or queued. */
  pending: string[];
  /** The user already dismissed or acted on exactly these failures. */
  handled: boolean;
  reviews: number;
  proposal: BuildProposal | null;
  apply: BuildApplyState | null;
}

/** The build side of the task's Pull requests tab. */
export interface PrBuildsView {
  auto: boolean;
  prs: PrBuildsPr[];
}

export type BuildDecisionAction = "fix" | "rerun" | "skip";
export interface BuildDecision {
  evaluationId: string;
  action: BuildDecisionAction;
  choice?: string;
  note?: string;
}

/** The Needs you key the server gives a PR's build review (jarvis-needs prBuildNeedKey). */
export function prBuildNeedKey(taskId: string, s: Pick<PrBuildSummary, "org" | "prId" | "at">): string {
  return `need:ci:${taskId}:${s.org.toLowerCase()}:${s.prId}:${s.at}`;
}

/** The task's build reviews waiting on the user: a plan to look at, or one that went wrong. */
export function prBuildsNeeds(task: Pick<TodayTask, "status" | "prBuilds">): PrBuildSummary[] {
  return task.status === "open" ? (task.prBuilds || []).filter((s) => s.attention) : [];
}

/** "PR 1234: 2 blocking builds failed. Worker 2 has a plan: 1 fix ready, 1 to rerun." */
export function prBuildsNeedText(s: PrBuildSummary): string {
  const who = s.worker || "The worker";
  if (s.attention === "error") return `PR ${s.prId}: ${s.note || "the build review needs you."}`;
  const n = s.items || s.failed;
  const failed = n ? `${count(n, "blocking build", "blocking builds")} failed` : "a blocking build failed";
  if (s.items && s.rerun === s.items) return `PR ${s.prId}: ${failed}. ${who} thinks ${s.items === 1 ? "it's" : "they're"} flaky. Rerun?`;
  if (s.items && s.fix === s.items) return `PR ${s.prId}: ${failed}. ${who} has ${s.fix === 1 ? "a fix" : `${s.fix} fixes`} to review.`;
  const parts = [
    s.fix ? count(s.fix, "fix ready", "fixes ready") : "",
    s.rerun ? `${s.rerun} to rerun` : "",
    s.unclear ? count(s.unclear, "needs your call", "need your call") : "",
  ].filter(Boolean);
  return parts.length ? `PR ${s.prId}: ${failed}. ${who} has a plan: ${parts.join(", ")}.` : `PR ${s.prId}: ${failed}. ${who} has a plan.`;
}

const BUILD_RANK: Record<BuildReviewState, number> = { error: 0, awaiting: 1, applying: 2, auditing: 3, failed: 4, watching: 5 };

/** The card chip and the tab badge's build side: the build review that matters most right now. */
export function prBuildsChip(list: PrBuildSummary[] | null | undefined): { text: string; tone: Tone } | null {
  const top = (list || []).slice().sort((a, b) => BUILD_RANK[a.state] - BUILD_RANK[b.state])[0];
  if (!top) return null;
  const pr = `PR ${top.prId}`;
  if (top.attention === "error") return { text: `Builds · ${pr} · needs you`, tone: "warn" };
  if (top.attention === "proposal") return { text: `Builds · ${pr} · ${top.rerun === top.items ? "rerun?" : "fix ready"}`, tone: "warn" };
  if (top.state === "applying") return { text: `Builds · ${pr} · fixing`, tone: "run" };
  if (top.state === "auditing") return { text: `Builds · ${pr} · reviewing`, tone: "run" };
  if (top.state === "failed") return { text: `Builds · ${pr} · failed`, tone: "idle" };
  return null;
}

export interface JarvisEvent {
  id: number;
  at: string;
  kind: string;
  taskId: string | null;
  sessionId: string | null;
  ref: Record<string, unknown> | null;
  text: string;
}

/** One of the user's own to-dos: not tied to a day or a task. */
export interface Todo {
  id: number;
  text: string;
  done: boolean;
  /** "you", the lead (Devis), or the worker that added it. */
  author: string;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
  /** The Needs you item it came from, if it did. */
  source?: TodoSource | null;
  /** Why it was checked off when it ticked itself. */
  doneNote?: string | null;
}

/** A Needs you item a to-do was made from: the ask's key, and enough to show and open it. */
export interface TodoSource {
  key: string;
  /** The task it's about; empty for a Teams ask. */
  taskId: string;
  /** The task's title, or the PR's for a Teams ask. */
  taskTitle: string;
  who: string;
  /** The message in Teams, for a Teams ask. */
  link?: string;
}

/** The quick note. Today's poll carries only its version; the text is read when that changes. */
export interface QuickNote {
  text: string;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
  /** The id of the user's last save; appends keep it. */
  lastSaveId?: string | null;
}

export interface TodayData {
  tasks: TodayTask[];
  reviewed: JarvisEvent[];
  folders: string[];
  organizations: string[];
  overview?: OverviewState;
  todos?: Todo[];
  note?: Omit<QuickNote, "text">;
  /**
   * PR reviews asked for in Teams (`failed` when they couldn't be read this time); chats and email
   * threads waiting on the user (`needsFailed` likewise); the meetings', chats' and email's digests.
   */
  comms?: { asks: CommsAsk[]; failed?: boolean; meetings?: MeetingsDigest; chats?: ChatsDigest; mail?: ChatsDigest; needs?: CommsNeed[]; needsFailed?: boolean };
  /** A Devis ship deploying, just live, or not live: the Workspace banner. */
  devis?: DevisBanner | null;
  /** A release ready, installing, just live, failed, or paused by your source: the other banner. */
  update?: UpdateBanner | null;
}

/** A chat or email thread someone waits on the user in: its latest day that says so (comms.mts commsNeeds). */
export interface CommsNeed {
  /** need:chat:<hash> or need:mail:<hash>: the same while the conversation waits on the user. */
  key: string;
  source: "chat" | "mail";
  id: string;
  day: string;
  /** A group's topic, the other person of a 1:1, or the email's subject. */
  title: string;
  /** A chat's kind (oneOnOne, group), or how an email reached the user (you, cc, list). */
  kind: string;
  people: string[];
  needsYou: string;
  summary: string;
  lastAt: string;
  /** The chat in Teams, or the email in Outlook on the web; "" when there's none. */
  link: string;
}

/** Who waits, in a few words: "Dana Lee", "Dana and Lee", "Dana and 2 others". */
export function commsNeedWho(n: Pick<CommsNeed, "source" | "kind" | "people" | "title">): string {
  const p = n.people;
  if (!p.length) return n.source === "chat" && n.kind === "oneOnOne" ? n.title : "Someone";
  if (p.length === 1) return p[0];
  if (p.length === 2) return `${p[0]} and ${p[1]}`;
  return `${p[0]} and ${p.length - 1} others`;
}

/** Where they asked: "in a 1:1 chat", "in Release crew", "by email", "by email (cc)", "by email to a list". */
export function commsNeedWhere(n: Pick<CommsNeed, "source" | "kind" | "title">): string {
  if (n.source === "mail") return n.kind === "you" ? "by email" : n.kind === "cc" ? "by email (cc)" : "by email to a list";
  if (n.kind === "oneOnOne") return "in a 1:1 chat";
  const t = n.title.replace(/\s+/g, " ").trim();
  return t ? `in ${t.length > 60 ? `${t.slice(0, 59).trimEnd()}…` : t}` : "in a group chat";
}

/** What Needs you calls a chat or thread: a 1:1 by who it's with, a group by its topic, an email by its subject. */
export const commsNeedTitle = (n: Pick<CommsNeed, "source" | "kind" | "title">): string =>
  n.source === "chat" && n.kind === "oneOnOne" ? `Chat with ${n.title}` : n.title || (n.source === "mail" ? "(no subject)" : "Group chat");

/** Someone asking for a PR review in Teams. */
export interface CommsAsker {
  name: string;
  chatKind: "oneOnOne" | "group" | "meeting";
  chatTopic: string;
  messageId: string;
  at: string;
  snippet: string;
  /** The message in Teams. */
  link: string;
  /** Direct: in a 1:1 chat, or to the user by name. Broad: to the chat. */
  audience: "direct" | "broad";
}

/** A PR someone asked the user to review in Teams, while it's open (comms.mts). */
export interface CommsAsk {
  id: number;
  org: string;
  prId: number;
  project: string;
  repo: string;
  repoId: string;
  title: string;
  author: string;
  created: string;
  isDraft: boolean;
  url: string;
  audience: "direct" | "broad";
  openedAt: string;
  updatedAt: string;
  /** Newest first. */
  askers: CommsAsker[];
}

/** Where an asker asked, in a few words: "in a 1:1 chat", "in Release crew". */
export function askerWhere(a: Pick<CommsAsker, "chatKind" | "chatTopic">): string {
  if (a.chatKind === "oneOnOne") return "in a 1:1 chat";
  const topic = a.chatTopic.replace(/\s+/g, " ").trim();
  if (topic) return `in ${topic.length > 60 ? `${topic.slice(0, 59).trimEnd()}…` : topic}`;
  return a.chatKind === "meeting" ? "in a meeting chat" : "in a group chat";
}

/** Who asked, in a few words: "Dana", "Dana and Lee", "Dana and 2 others". */
export function askersLine(askers: CommsAsker[]): string {
  const names = [...new Set(askers.map((a) => a.name))];
  if (names.length <= 1) return names[0] || "Someone";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

/** The Teams ask for a PR, if there's one open. */
export function askFor(asks: CommsAsk[] | undefined, pr: Pick<PR, "org" | "id">): CommsAsk | undefined {
  const org = pr.org.toLowerCase();
  return asks?.find((a) => a.prId === pr.id && a.org === org);
}

/** A PR to open from a Teams ask, from the user's PR list when it's there, else from what the ask knows. Null before the ask knows enough. */
export function askPr(ask: CommsAsk, prs: PR[]): PR | null {
  const listed = prs.find((p) => p.id === ask.prId && p.org.toLowerCase() === ask.org);
  if (listed) return listed;
  if (!ask.repoId || !ask.project) return null;
  return {
    id: ask.prId,
    mine: false,
    title: ask.title || `Pull request ${ask.prId}`,
    org: ask.org,
    project: ask.project,
    repo: ask.repo,
    repoId: ask.repoId,
    sourceRef: "",
    targetRef: "",
    author: ask.author,
    created: ask.created,
    isDraft: ask.isDraft,
    url: ask.url || `https://dev.azure.com/${encodeURIComponent(ask.org)}/${encodeURIComponent(ask.project)}/_git/${encodeURIComponent(ask.repo)}/pullrequest/${ask.prId}`,
  };
}

/**
 * Fold an edit made against `base` into the note as it is now. Agents only ever
 * add to the end, so when the saved note still starts with what the edit started
 * from, the added part goes below the user's text and nothing is lost. Returns
 * null when the note was changed some other way, for the user to choose.
 */
export function mergeQuickNote(base: string, mine: string, saved: string): string | null {
  const start = base.replace(/\s+$/, "");
  if (!saved.startsWith(start)) return null;
  const rest = saved.slice(start.length);
  // An append starts on a new paragraph; text run onto the last line is an edit made elsewhere.
  if (start && rest && !/^\s/.test(rest)) return null;
  const added = rest.replace(/^\s+/, "");
  if (!added) return mine;
  const own = mine.replace(/\s+$/, "");
  return own ? `${own}\n\n${added}` : added;
}

export type NoteReconcile =
  /** Everything in the edit is already saved: drop the draft. */
  | { kind: "landed" }
  /** Changed some other way: the user chooses. */
  | { kind: "conflict" }
  /** Keep editing from `text`; `added` when something was folded in below the user's text. */
  | { kind: "draft"; text: string; added: boolean };

/**
 * Reconcile an unsaved edit with the note as saved now. `ownSave` is the text of the
 * user's own save that the saved note was built on (its `lastSaveId` is one of the
 * page's), when known: everything past it was appended, so the merge starts there
 * rather than at `baseText`, and the user's saved words never count as an addition.
 */
export function reconcileNote(baseText: string, draft: string, saved: string, ownSave?: string): NoteReconcile {
  const merged = mergeQuickNote(ownSave ?? baseText, draft, saved);
  if (merged === null) return { kind: "conflict" };
  if (merged === saved) return { kind: "landed" };
  return { kind: "draft", text: merged, added: merged !== draft };
}

export type SectionId = "needs" | "running" | "idle" | "done";

// Needs you leads. Pull requests have their own Workspace panel, so Tasks holds only tasks.
export const SECTIONS: ReadonlyArray<{ id: SectionId; title: string; tone: string; empty: string }> = [
  { id: "needs", title: "Needs you", tone: "warn", empty: "Nothing is waiting on you." },
  { id: "running", title: "Running", tone: "run", empty: "No workers are running." },
  { id: "idle", title: "Open tasks", tone: "idle", empty: "" },
  { id: "done", title: "Done today", tone: "ok", empty: "" },
];

const time = (iso: string | null | undefined): number => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : 0;
};

/** What a worker is doing now. Live data wins over the saved state. */
export function workerState(w: Pick<TodayWorker, "state" | "busy" | "requests">): WorkerState {
  if (w.requests.length) return "needsInput";
  if (w.busy) return "working";
  return w.state === "needsInput" ? "working" : w.state;
}

export const WORKER_LABEL: Record<WorkerState, string> = {
  working: "Working",
  needsInput: "Needs you",
  turnDone: "Turn done",
  idle: "Idle",
  stopped: "Stopped",
  error: "Failed",
};

export const WORKER_TONE: Record<WorkerState, string> = {
  working: "run",
  needsInput: "warn",
  turnDone: "ok",
  idle: "idle",
  stopped: "off",
  error: "bad",
};

/**
 * What a task is on Today: needs the user, running, open or done today (null once it was
 * finished before `dayStart`). The overview reads tasks this way, and the server's write-up
 * agrees with it (jarvis-overview sectionOf). Where its card sits is cardSection.
 */
export function taskSection(task: TodayTask, dayStart: number): SectionId | null {
  const states = task.workers.map(workerState);
  // A worker still waiting on the user, or still running, outranks the task's status:
  // marking a task done must never hide an open approval.
  if (states.includes("needsInput")) return "needs";
  if (task.status === "done") return states.includes("working") ? "running" : time(task.doneAt) >= dayStart ? "done" : null;
  if (states.includes("error")) return "needs";
  if (validationNeed(task) || prCommentsNeeds(task).length || prBuildsNeeds(task).length) return "needs";
  if (states.includes("working")) return "running";
  return "idle";
}

const oldestRequest = (task: TodayTask): number =>
  Math.min(...task.workers.flatMap((w) => w.requests.map((r) => time(r.at))), Number.MAX_SAFE_INTEGER);
const lastActivity = (task: TodayTask): number =>
  Math.max(time(task.updatedAt), ...task.workers.map((w) => time(w.updatedAt)));

export type BoardSection = Exclude<SectionId, "needs">;

/**
 * Where a task's card sits on the board, or null once it was finished before `dayStart`.
 * Needing the user never moves a card: the ask is listed under Needs you, and the card stays
 * put with a warning (needsYou). A worker waiting on the user is mid-turn, so its task stays
 * under Running, even a task marked done.
 */
export function cardSection(task: TodayTask, dayStart: number): BoardSection | null {
  const states = task.workers.map(workerState);
  const moving = states.includes("working") || states.includes("needsInput");
  if (task.status === "done") return moving ? "running" : time(task.doneAt) >= dayStart ? "done" : null;
  return moving ? "running" : "idle";
}

/** The task has something waiting on the user: a question or approval, a failed worker, or its validation. */
export function needsYou(task: TodayTask, dayStart: number): boolean {
  return taskSection(task, dayStart) === "needs";
}

/**
 * Tasks per board section, each in its own order, and `needs`: the tasks waiting on the user
 * (the longest wait first). A task in `needs` is also on the board.
 */
export function groupTasks(tasks: TodayTask[], dayStart: number): Record<SectionId, TodayTask[]> {
  const out: Record<SectionId, TodayTask[]> = { needs: [], running: [], idle: [], done: [] };
  for (const task of tasks) {
    if (needsYou(task, dayStart)) out.needs.push(task);
    const section = cardSection(task, dayStart);
    if (section) out[section].push(task);
  }
  out.needs.sort((a, b) => oldestRequest(a) - oldestRequest(b) || lastActivity(b) - lastActivity(a));
  out.running.sort((a, b) => lastActivity(b) - lastActivity(a));
  // Idle: tasks whose workers have something to show first, then untouched tasks, newest first.
  const shown = (t: TodayTask): number => (t.workers.length ? 0 : 1);
  out.idle.sort((a, b) => shown(a) - shown(b) || lastActivity(b) - lastActivity(a));
  out.done.sort((a, b) => time(b.doneAt) - time(a.doneAt));
  return out;
}

/**
 * One thing waiting on the user, as Needs you lists it: the task, who asks, and the ask itself.
 * `source` names this exact ask (a worker's next question is a new one); a to-do made from the item
 * carries it, and the server ticks that to-do once the ask is gone (jarvis-needs.mts gives the same keys).
 */
export type NeedItem =
  /** A worker's questions or approvals (repositories to confirm, too). */
  | { kind: "request"; key: string; source: string; task: TodayTask; worker: TodayWorker; at: number }
  /** A worker whose turn failed: a message to it tries again. */
  | { kind: "failed"; key: string; source: string; task: TodayTask; worker: TodayWorker; at: number }
  /** The task's validation: a chain proposed for review, or a run that failed. */
  | { kind: "validation"; key: string; source: string; task: TodayTask; who: string; text: string; at: number }
  /** Review comments on one of the task's PRs: the worker's plan to look at, or a review that went wrong. */
  | { kind: "prComments"; key: string; source: string; task: TodayTask; pr: PrCommentSummary; who: string; text: string; at: number }
  /** Failed builds on one of the task's PRs: the worker's fix or rerun to look at, or a review that went wrong. */
  | { kind: "prBuilds"; key: string; source: string; task: TodayTask; pr: PrBuildSummary; who: string; text: string; at: number }
  /** A PR someone asked the user to review in Teams. No task: the PR is what it's about. */
  | { kind: "teams"; key: string; source: string; ask: CommsAsk; at: number }
  /** A chat or email thread someone waits on the user in. No task either. */
  | { kind: "comms"; key: string; source: string; need: CommsNeed; at: number };

/** Needs you items that belong to a task. */
export type TaskNeedItem = Exclude<NeedItem, { kind: "teams" | "comms" }>;

/** One ask in a line, for the warning on its task's card. */
export function needLine(n: NeedItem): string {
  if (n.kind === "teams") return `${askersLine(n.ask.askers)} asked you to review PR ${n.ask.prId}`;
  if (n.kind === "comms") return `${commsNeedWho(n.need)}: ${n.need.needsYou}`;
  if (n.kind === "validation" || n.kind === "prComments" || n.kind === "prBuilds") return n.text;
  if (n.kind === "failed") return `${n.worker.label} failed`;
  const r = n.worker.requests[0];
  const what = r.kind === "repos" ? "confirm its repositories" : r.kind === "ship" ? `ready to ship: ${r.title}` : r.title;
  const extra = n.worker.requests.length > 1 ? ` (+${n.worker.requests.length - 1} more)` : "";
  return `${n.worker.label}: ${what}${extra}`;
}

/**
 * Everything waiting on the user, the longest wait first. Exactly the asks that make a task
 * needsYou, the Teams PR asks, and the chats and email threads someone waits on the user in.
 */
export function needsItems(tasks: TodayTask[], asks: CommsAsk[] = [], needs: CommsNeed[] = []): NeedItem[] {
  const items: NeedItem[] = taskNeeds(tasks);
  for (const ask of asks) items.push({ kind: "teams", key: `teams:${ask.id}`, source: `need:teams:${ask.id}`, ask, at: time(ask.openedAt) });
  for (const need of needs) items.push({ kind: "comms", key: `comms:${need.key}`, source: need.key, need, at: time(need.lastAt) });
  return items.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

/** The asks of these tasks, the longest wait first. */
export function taskNeeds(tasks: TodayTask[]): TaskNeedItem[] {
  const items: TaskNeedItem[] = [];
  for (const task of tasks) {
    for (const worker of task.workers) {
      if (worker.requests.length) {
        const oldest = firstRequest(worker.requests);
        items.push({ kind: "request", key: `req:${worker.sessionId}`, source: `need:req:${worker.sessionId}:${oldest.id}`, task, worker, at: time(oldest.at) });
      } else if (task.status === "open" && workerState(worker) === "error") {
        const source = `need:fail:${worker.sessionId}:${worker.stateAt || worker.updatedAt}`;
        items.push({ kind: "failed", key: `fail:${worker.sessionId}`, source, task, worker, at: time(worker.updatedAt) });
      }
    }
    const v = validationNeed(task);
    if (v) {
      const proposal = task.validation?.attention === "proposal" ? task.validation.proposal : null;
      const at = proposal ? time(proposal.at) : time(task.validation?.run?.finishedAt) || time(task.updatedAt);
      const source = proposal ? `need:val:${task.id}:proposal:${proposal.at}` : `need:val:${task.id}:failed:${task.validation?.run?.runId ?? "run"}`;
      items.push({ kind: "validation", key: `val:${task.id}`, source, task, who: proposal?.by || "Validation", text: v, at });
    }
    for (const pr of prCommentsNeeds(task)) {
      const key = `pr:${task.id}:${pr.org.toLowerCase()}:${pr.prId}`;
      items.push({ kind: "prComments", key, source: prNeedKey(task.id, pr), task, pr, who: pr.worker || "The worker", text: prCommentsNeedText(pr), at: time(pr.at) });
    }
    for (const pr of prBuildsNeeds(task)) {
      const key = `ci:${task.id}:${pr.org.toLowerCase()}:${pr.prId}`;
      items.push({ kind: "prBuilds", key, source: prBuildNeedKey(task.id, pr), task, pr, who: pr.worker || "The worker", text: prBuildsNeedText(pr), at: time(pr.at) });
    }
  }
  return items.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

/** The oldest of a worker's open requests: the one its Needs you item stands for. */
function firstRequest(requests: WorkerRequest[]): WorkerRequest {
  return requests.reduce((a, b) => (time(b.at) < time(a.at) ? b : a));
}

/** Needs you, less what the user moved to their to-dos: an open to-do made from an ask hides it. */
export function visibleNeeds<T extends NeedItem>(items: T[], todos: Todo[] | undefined): T[] {
  const taken = new Set((todos || []).filter((t) => !t.done && t.source).map((t) => t.source!.key));
  return taken.size ? items.filter((n) => !taken.has(n.source)) : items;
}

const oneLine = (text: string, max = 200): string => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** The to-do a Needs you item becomes: what to do, in a line, and where it came from. */
export function needTodo(n: NeedItem): { text: string; source: TodoSource } {
  if (n.kind === "comms") {
    const c = n.need;
    const ask = oneLine(c.needsYou, 300);
    const who = commsNeedWho(c);
    const via = c.source === "mail" ? "by email" : "in Teams";
    return {
      text: `${ask.charAt(0).toUpperCase()}${ask.slice(1)} (${who} ${via})`,
      source: { key: n.source, taskId: "", taskTitle: oneLine(commsNeedTitle(c), 140), who: `${who} ${via}`, ...(c.link ? { link: c.link } : {}) },
    };
  }
  if (n.kind === "teams") {
    const a = n.ask;
    const asker = a.askers[0];
    const pr = `PR ${a.prId}${a.title ? `: ${oneLine(a.title, 140)}` : ""}`;
    const who = `${askersLine(a.askers)} in Teams`;
    return {
      text: `Review ${pr} (${askersLine(a.askers)} asked)`,
      source: { key: n.source, taskId: "", taskTitle: pr, who, ...(asker?.link ? { link: asker.link } : {}) },
    };
  }
  const who = n.kind === "validation" || n.kind === "prComments" || n.kind === "prBuilds" ? n.who : n.worker.label;
  const source: TodoSource = { key: n.source, taskId: n.task.id, taskTitle: n.task.title, who };
  if (n.kind === "prBuilds") {
    const text = n.pr.attention === "proposal" ? `Review ${who}'s plan for the failed builds on PR ${n.pr.prId}` : `See what went wrong with the builds on PR ${n.pr.prId}`;
    return { text, source };
  }
  if (n.kind === "prComments") {
    const text = n.pr.attention === "proposal" ? `Review ${who}'s plan for the comments on PR ${n.pr.prId}` : `See what went wrong with the comments on PR ${n.pr.prId}`;
    return { text, source };
  }
  if (n.kind === "validation") {
    const text = n.task.validation?.attention === "proposal" ? `Review the validation chain ${who} proposed` : "Look at the failed validation run";
    return { text, source };
  }
  if (n.kind === "failed") return { text: `See why ${who}'s turn failed`, source };
  const r = firstRequest(n.worker.requests);
  const text =
    r.kind === "repos"
      ? `Confirm ${who}'s repositories`
      : r.kind === "ship"
        ? `Review and ship ${who}'s change to Devis: ${oneLine(r.title, 160)}`
        : r.kind === "permission"
          ? `Allow or deny ${who}: ${oneLine(r.title, 160)}`
          : `Answer ${who}: ${oneLine(r.title, 160)}`;
  return { text, source };
}

/** PRs in the PR feed's "Needs your review" lane: published first, newest first, like the feed. */
export function reviewQueue(prs: PR[], phaseOf: (pr: PR) => ReviewPhase): PR[] {
  return prs
    .filter((pr) => !pr.plateDismissed && feedLane(pr, phaseOf(pr)) === "review")
    .sort((a, b) => Number(!!a.isDraft) - Number(!!b.isDraft) || time(b.created) - time(a.created));
}

/** How many review rows Today shows before "Show more". */
export const REVIEW_PREVIEW = 6;

export interface CopilotReviewControl {
  label: string;
  title: string;
  disabled: boolean;
  /** A status chip beside the button, or null. */
  chip: { label: string; tone: string } | null;
}

/** The Copilot review button on a Today PR row, from the PR's review phase. */
export function copilotReviewControl(phase: ReviewPhase): CopilotReviewControl {
  if (phase === "active") {
    return { label: "Reviewing…", title: "A Copilot review is queued or running.", disabled: true, chip: null };
  }
  if (phase === "done") {
    return {
      label: "Copilot review",
      title: "Run a new Copilot review of this PR.",
      disabled: false,
      chip: { label: "Copilot reviewed", tone: "ok" },
    };
  }
  if (phase === "error") {
    return {
      label: "Copilot review",
      title: "Try the Copilot review again.",
      disabled: false,
      chip: { label: "Copilot review failed", tone: "bad" },
    };
  }
  return { label: "Copilot review", title: "Queue a Copilot review of this PR.", disabled: false, chip: null };
}

// ---- service filter ----------------------------------------------------------------

export const ALL_SERVICES = "all";

export function serviceKey(org: string | null | undefined, project: string | null | undefined): string {
  return org && project ? `${org}/${project}` : "";
}

/** "org/project" choices present on Today, sorted. */
export function serviceOptions(tasks: TodayTask[], prs: PR[]): string[] {
  const keys = new Set<string>();
  for (const t of tasks) if (serviceKey(t.org, t.project)) keys.add(serviceKey(t.org, t.project));
  for (const p of prs) if (serviceKey(p.org, p.project)) keys.add(serviceKey(p.org, p.project));
  return [...keys].sort((a, b) => a.localeCompare(b));
}

export function inService(item: { org: string | null; project: string | null | undefined }, service: string): boolean {
  return service === ALL_SERVICES || serviceKey(item.org, item.project ?? null) === service;
}

// ---- task folders -------------------------------------------------------------------

const RESERVED_FOLDER = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;

/**
 * The task folder's name, as the server makes it (taskSlug in jarvis-store.mts): the
 * title in lowercase with spaces as dashes, minus what a folder or git branch can't hold.
 */
export function taskSlug(title: string): string {
  let slug = title
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}._-]+/gu, "")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60)
    .replace(/[-.]+$/g, "")
    .replace(/\.lock$/, "-lock");
  if (!slug) slug = "task";
  if (RESERVED_FOLDER.test(slug)) slug += "-task";
  return slug;
}

/** Where a new task's folder goes: the root, then the title's folder name. Empty without a root. */
export function taskFolderPreview(root: string, title: string): string {
  const base = root.trim().replace(/^"(.*)"$/, "$1").replace(/[\\/]+$/, "");
  if (!base) return "";
  const sep = base.includes("/") && !base.includes("\\") ? "/" : "\\";
  return `${base}${sep}${taskSlug(title)}`;
}

// ---- wording ----------------------------------------------------------------------

/** "now", "5m", "3h", "2d". */
export function ago(iso: string | null | undefined, now: number): string {
  const t = time(iso);
  if (!t) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

/** "just now", "5m ago". */
export function agoPhrase(iso: string | null | undefined, now: number): string {
  const a = ago(iso, now);
  return a === "now" ? "just now" : a ? `${a} ago` : "";
}

/** The line under a task's title: service, work item and its parent. */
export function taskMeta(task: TodayTask): string {
  const parts: string[] = [];
  if (task.project) parts.push(task.project);
  if (task.workItem) {
    parts.push(`#${task.workItem.id} · ${task.workItem.type}${task.workItem.state ? ` · ${task.workItem.state}` : ""}`);
    if (task.workItem.parent) {
      parts.push(`under ${task.workItem.parent.type} #${task.workItem.parent.id} ${task.workItem.parent.title}`);
    }
  } else {
    parts.push("custom task");
  }
  return parts.join(" · ");
}

/** Section counts and a one-line summary for the Tasks status bar. */
export function todaySummary(counts: Partial<Record<SectionId, number>>): string {
  const phrase: Record<SectionId, (n: number) => string> = {
    needs: (n) => `${n} need${n === 1 ? "s" : ""} you`,
    running: (n) => `${n} running`,
    idle: (n) => `${n} open`,
    done: (n) => `${n} done today`,
  };
  const parts = SECTIONS.filter(({ id }) => (counts[id] || 0) > 0).map(({ id }) => phrase[id](counts[id]!));
  return parts.length ? parts.join(" · ") : "Nothing in Tasks yet";
}

/** Local midnight for `now`, in ms. */
export function dayStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A cheap signature of what Today renders, so polling only repaints on change. */
export function todayFingerprint(data: TodayData | null, extra: string): string {
  if (!data) return "none|" + extra;
  const o = data.overview;
  return JSON.stringify([
    data.tasks.map((t) => [
      t.id,
      t.title,
      t.status,
      t.doneAt,
      t.workItem?.state,
      t.updates?.latest?.id,
      t.updates?.today.length,
      t.workers.map((w) => [w.sessionId, w.state, w.busy, w.summary, w.partial.length, w.activity, w.requests.map((r) => r.id)]),
      t.validation ? [t.validation.chainId, t.validation.blocks, t.validation.attention, t.validation.proposal?.at, t.validation.run && [t.validation.run.runId, t.validation.run.status, t.validation.run.done, t.validation.run.current]] : null,
      (t.prComments || []).map((p) => [p.org, p.prId, p.state, p.at, p.attention, p.items, p.worker]),
      (t.prBuilds || []).map((p) => [p.org, p.prId, p.state, p.at, p.attention, p.items, p.failed, p.worker]),
    ]),
    data.reviewed.map((e) => e.id),
    o ? [o.phase, o.text, o.at, o.stale, o.error] : null,
    data.comms?.asks.map((a) => [a.id, a.updatedAt, a.title, a.repoId]),
    data.comms?.needs?.map((n) => [n.key, n.day, n.needsYou, n.lastAt]),
    extra,
  ]);
}

// ---- the overview ------------------------------------------------------------------

/** Whether Today has anything to write about: a task it shows. */
export function todayHasTasks(tasks: TodayTask[], dayStartMs: number): boolean {
  return tasks.some((task) => taskSection(task, dayStartMs) !== null);
}

/** The collapsed overview's one line: "1 needs you · 2 moving · 1 done". A task waiting on you counts there only. */
export function overviewSummary(tasks: TodayTask[], dayStartMs: number): string {
  const groups = groupTasks(tasks, dayStartMs);
  const needs = new Set(groups.needs);
  const others = (list: TodayTask[]): number => list.filter((t) => !needs.has(t)).length;
  const parts: string[] = [];
  if (groups.needs.length) parts.push(`${groups.needs.length} need${groups.needs.length === 1 ? "s" : ""} you`);
  if (others(groups.running)) parts.push(`${others(groups.running)} moving`);
  if (others(groups.idle)) parts.push(`${others(groups.idle)} open`);
  if (others(groups.done)) parts.push(`${others(groups.done)} done`);
  return parts.join(" · ") || "Nothing on Today yet";
}

export interface NarrativePart {
  text: string;
  /** This part was a [[Title]] mention. */
  mention?: boolean;
  /** The task it names, when that task is on Today. */
  taskId?: string;
}

/**
 * Split a narrative into text and task mentions. The server spells every
 * mention as [[Exact title]]; known titles are matched whole, so
 * "[[[AppConfig] Fix export]]" works, and any other [[…]] still reads as a name.
 */
export function narrativeParts(text: string, tasks: Pick<TodayTask, "id" | "title">[]): NarrativePart[] {
  const byTitle = new Map(tasks.map((t) => [t.title.trim().toLowerCase(), t.id]));
  const known = [...new Set(tasks.map((t) => t.title.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`\\[\\[\\s*(?:${known.length ? `(${known.join("|")})` : "(?!)()"}|(.{1,200}?))\\s*\\]\\](?!\\])`, "gi");
  const parts: NarrativePart[] = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index! > last) parts.push({ text: text.slice(last, m.index) });
    const title = (m[1] ?? m[2]).trim();
    parts.push({ text: title, mention: true, taskId: byTitle.get(title.toLowerCase()) });
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts.filter((p) => p.text);
}

/**
 * The narrative as points, each a list of parts. The server writes one
 * "- point" per line; an older write-up in prose is shown a sentence per
 * point. Mentions are never split, so "v1.2" in a title stays whole.
 */
export function narrativeLines(text: string, tasks: Pick<TodayTask, "id" | "title">[]): NarrativePart[][] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.some((l) => l.startsWith("- "))) {
    return lines.map((l) => tidyLine(narrativeParts(l.replace(/^-\s+/, ""), tasks))).filter((l) => l.length);
  }
  const out: NarrativePart[][] = [];
  let line: NarrativePart[] = [];
  for (const part of narrativeParts(lines.join(" "), tasks)) {
    if (part.mention) {
      line.push(part);
      continue;
    }
    part.text.split(/(?<=[.!?])\s+/).forEach((piece, i) => {
      if (i > 0) {
        out.push(line);
        line = [];
      }
      if (piece) line.push({ text: piece });
    });
  }
  out.push(line);
  return out.map(tidyLine).filter((l) => l.length);
}

/** Trim the outer whitespace of a point and drop parts left empty. */
function tidyLine(line: NarrativePart[]): NarrativePart[] {
  const out = line.map((p) => ({ ...p }));
  if (out.length && !out[0].mention) out[0].text = out[0].text.trimStart();
  const last = out[out.length - 1];
  if (last && !last.mention) last.text = last.text.trimEnd();
  return out.filter((p) => p.text);
}

/** "Updated 4m ago", "Updating…", or why there is no narrative. */
export function overviewFreshness(o: OverviewState | undefined, now: number): string {
  if (!o || o.phase === "none") return "";
  if (o.phase === "updating") return "Updating…";
  if (o.phase === "failed") return "Write-up unavailable";
  const phrase = agoPhrase(o.at, now);
  return phrase ? `Updated ${phrase}` : "Updated";
}

// ---- a task's status timeline -------------------------------------------------------

export interface StatusDay {
  key: string;
  label: string;
  items: StatusUpdate[];
}

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * A task's updates over its life, newest first, grouped by local day:
 * "Today", "Yesterday", then "Mon, Oct 13" (with the year when it isn't this year).
 */
export function statusDays(items: StatusUpdate[], now: number): StatusDay[] {
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const out: StatusDay[] = [];
  for (const s of items) {
    const d = new Date(s.at);
    const key = localDayKey(d);
    let day = out[out.length - 1];
    if (!day || day.key !== key) {
      const label =
        key === localDayKey(today)
          ? "Today"
          : key === localDayKey(yesterday)
            ? "Yesterday"
            : d.toLocaleDateString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
                ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" as const } : {}),
              });
      day = { key, label, items: [] };
      out.push(day);
    }
    day.items.push(s);
  }
  return out;
}

/** Pages of updates joined, newest first, each once. */
export function mergeStatuses(a: StatusUpdate[], b: StatusUpdate[]): StatusUpdate[] {
  const byId = new Map<number, StatusUpdate>();
  for (const s of [...a, ...b]) byId.set(s.id, s);
  return [...byId.values()].sort((x, y) => y.id - x.id);
}

/** "Using view…" for a tool; an activity that is already a phrase ("Writing the recap") reads as is. */
export function activityLine(activity: string): string {
  if (!activity) return "Thinking…";
  return /\s/.test(activity.trim()) ? `${activity.trim()}…` : `Using ${activity}…`;
}

// ---- a task's pull requests ---------------------------------------------------------

export type Tone = "run" | "ok" | "warn" | "idle" | "off";

/** Draft, Active, Completed or Abandoned, with its tone. */
export function prState(p: Pick<TaskPr, "snapshot">): { label: string; tone: Tone } {
  const s = p.snapshot;
  if (!s) return { label: "Unknown", tone: "off" };
  if (s.status === "completed") return { label: "Completed", tone: "ok" };
  if (s.status === "abandoned") return { label: "Abandoned", tone: "off" };
  if (s.isDraft) return { label: "Draft", tone: "idle" };
  return { label: "Active", tone: "run" };
}

/** Votes from people (groups count only when required). */
export function prVotes(reviewers: PrReviewer[]): { approved: number; required: number; requiredApproved: number; rejected: number; waiting: number } {
  const out = { approved: 0, required: 0, requiredApproved: 0, rejected: 0, waiting: 0 };
  for (const r of reviewers) {
    if (r.isRequired) {
      out.required++;
      if (r.vote >= 5) out.requiredApproved++;
    }
    if (r.isContainer && !r.isRequired) continue;
    if (r.vote >= 5) out.approved++;
    else if (r.vote === -10) out.rejected++;
    else if (r.vote === -5) out.waiting++;
  }
  return out;
}

export interface PrSignal {
  text: string;
  tone: Tone;
}

/** What an open PR needs, most pressing first: rejections, failing checks, conflicts, votes, comments. */
export function prSignals(p: Pick<TaskPr, "snapshot" | "checks" | "unresolved">): PrSignal[] {
  const s = p.snapshot;
  if (!s || s.status !== "active") return [];
  const out: PrSignal[] = [];
  const v = prVotes(s.reviewers);
  if (v.rejected) out.push({ text: `Rejected by ${v.rejected}`, tone: "warn" });
  if (v.waiting) out.push({ text: "Waiting for author", tone: "warn" });
  const c = p.checks;
  if (c?.failed) out.push({ text: `${c.failing[0] || "A check"} failed${c.failed > 1 ? ` (+${c.failed - 1})` : ""}`, tone: "warn" });
  if (s.mergeStatus === "conflicts") out.push({ text: "Merge conflicts", tone: "warn" });
  if (!s.isDraft) {
    if (v.required) out.push({ text: `${v.requiredApproved} of ${v.required} required approvals`, tone: v.requiredApproved >= v.required ? "ok" : "idle" });
    else out.push({ text: v.approved ? `${v.approved} approval${v.approved === 1 ? "" : "s"}` : "No approvals yet", tone: v.approved ? "ok" : "idle" });
  }
  if (c && !c.failed && c.running) out.push({ text: "Checks running", tone: "run" });
  else if (c && !c.failed && c.total && c.passed === c.total) out.push({ text: "Checks passed", tone: "ok" });
  if (p.unresolved) out.push({ text: `${p.unresolved} open comment${p.unresolved === 1 ? "" : "s"}`, tone: "idle" });
  return out;
}

/** An open PR that needs someone to act: rejected, waiting, failing or in conflict. */
export function prNeedsAttention(p: Pick<TaskPr, "snapshot" | "checks" | "unresolved">): boolean {
  return prSignals(p).some((sig) => sig.tone === "warn");
}

/** Open PRs (needing attention first, then newest) and finished ones (latest closed first). */
export function groupTaskPrs(prs: TaskPr[]): { open: TaskPr[]; finished: TaskPr[] } {
  const finished = prs.filter((p) => p.snapshot && p.snapshot.status !== "active");
  const open = prs.filter((p) => !finished.includes(p));
  open.sort((a, b) => Number(prNeedsAttention(b)) - Number(prNeedsAttention(a)) || b.prId - a.prId);
  finished.sort((a, b) => (b.snapshot?.closed || "").localeCompare(a.snapshot?.closed || "") || b.prId - a.prId);
  return { open, finished };
}

const SOURCE_TEXT: Record<PrSource, string> = {
  workitem: "Linked to the work item in Azure DevOps",
  user: "Linked by you",
  created: "Created by a worker",
  worker: "Linked by a worker",
  branch: "From a worker's branch",
};

export function prSourceText(source: PrSource): string {
  return SOURCE_TEXT[source] || "Linked";
}

/** The card's PR chips: open PRs first, at most two, then "+N". */
export function cardPrs(prs: TaskPr[] | undefined): { shown: TaskPr[]; more: number } {
  const { open, finished } = groupTaskPrs(prs || []);
  const ordered = [...open, ...finished];
  const shown = ordered.slice(0, 2);
  return { shown, more: ordered.length - shown.length };
}

/** "PR 123 · Active · 1 of 2 required approvals", short enough for a chip. */
export function prChipText(p: TaskPr): { text: string; tone: Tone } {
  const state = prState(p);
  const signals = prSignals(p);
  const warn = signals.find((sig) => sig.tone === "warn");
  const lead = warn || signals[0];
  const parts = [`PR ${p.prId}`, state.label];
  if (lead && state.label === "Active") parts.push(lead.text);
  return { text: parts.join(" · "), tone: warn ? "warn" : state.tone };
}

// ---- a task's artifacts -------------------------------------------------------------

export interface ArtifactInfo {
  name: string;
  size: number;
  modifiedAt: string;
}

export interface Artifact extends ArtifactInfo {
  content: string;
  path: string;
}

export const NOTE_NAME = "note.md";
export const RECAP_NAME = "recap.md";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

export function isMarkdownName(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}

/** What the special artifacts are for. */
export function artifactRole(name: string): string {
  const n = name.toLowerCase();
  if (n === NOTE_NAME) return "Shared note";
  if (n === RECAP_NAME) return "Recap";
  return "";
}

/** notes.md, or notes-2.md, notes-3.md… when that is taken. */
export function nextArtifactName(names: string[], base = "notes"): string {
  const taken = new Set(names.map((n) => n.toLowerCase()));
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${base}.md` : `${base}-${i}.md`;
    if (!taken.has(name)) return name;
  }
}

/** Starter text for a new artifact: a heading from its name for Markdown, nothing otherwise. */
export function newArtifactText(name: string): string {
  if (!isMarkdownName(name)) return "";
  const title = name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return `# ${title ? title[0].toUpperCase() + title.slice(1) : "Notes"}\n\n`;
}

export interface RecapLine {
  text: string;
  tone: "run" | "warn" | "idle";
  busy: boolean;
  /** A button to write (or retry) the recap. */
  action: string | null;
}

/** The recap's state above the Artifacts list, or null when there is nothing to say. */
export function recapLine(task: Pick<TodayTask, "status" | "workers" | "recap">, hasRecap: boolean): RecapLine | null {
  const r = task.recap;
  if (r?.state === "waiting") return { text: "The recap waits for a worker to finish its turn.", tone: "run", busy: true, action: null };
  if (r?.state === "writing") return { text: `${r.by || "A worker"} is writing the recap…`, tone: "run", busy: true, action: null };
  if (r?.state === "failed") {
    return { text: `Recap not written: ${r.error || "something went wrong."}`, tone: "warn", busy: false, action: task.workers.length ? "Try again" : null };
  }
  if (task.status === "done" && !hasRecap && task.workers.length) {
    return { text: "No recap yet.", tone: "idle", busy: false, action: "Write recap" };
  }
  return null;
}
