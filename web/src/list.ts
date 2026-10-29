// The PR queue, in two views. My feed sorts the PRs that involve you into lanes
// (queueModel.ts owns the rules); All lists every PR in scope, grouped by repo.
// The search field narrows both. A row click opens the PR in the docked reading
// pane (see detail.ts); the queue stays mounted beside it and marks the open row.
import { bulkReviewHost, el, queueSearch, queueTabs, view } from "./dom.js";
import { esc, timeAgo } from "./util.js";
import { QUEUE_VIEW_KEY, state, stopReviewPoll } from "./state.js";
import { openDetail } from "./detail.js";
import { postJSON } from "./api.js";
import { toast } from "./toast.js";
import type { PR, QueueView } from "./types.js";
import { statusBadge, myActionBadge, reviewerTally } from "./prStatus.js";
import { sendPrsToCopilot } from "./bridge.js";
import { requestNotifyPermission } from "./notifyWatch.js";
import { reviewStateKey } from "./reviewKey.js";
import { isPaneOpen } from "./readingPane.js";
import { icon } from "./icons.js";
import { copyText } from "./clipboard.js";
import { openContextMenu } from "./contextMenu.js";
import { linkMenuEntries } from "./prLinks.js";
import {
  FEED_LANES,
  feedLane,
  feedSummary,
  laneNote,
  matchesQuery,
  parseQuery,
  plural,
  sortLane,
  type FeedLane,
  type ReviewInfo,
  type ReviewPhase,
} from "./queueModel.js";

// A small status pill for a PR's background-review state, or "" when none.
export function reviewBadge(pr: PR): string {
  const key = reviewStateKey(pr);
  const active = state.activeReviewJobs[key];
  if (active) {
    if (active.status === "queued" || active.status === "dispatching") return QUEUED;
    return RUNNING;
  }
  const r = state.reviews[key];
  if (!r) return "";
  if (r.status === "queued") return QUEUED;
  if (r.status === "running") return RUNNING;
  if (r.status === "done") return `<span class="rev-badge done">${icon("sparkle")}Reviewed</span>`;
  if (r.status === "error") return `<span class="rev-badge error">${icon("warning")}Review failed</span>`;
  return "";
}

const QUEUED = `<span class="rev-badge queued">${icon("clock")}Queued</span>`;
const RUNNING = `<span class="rev-badge running"><span class="rev-pulse" aria-hidden="true"></span>Reviewing…</span>`;

// Org + project scope. Applies to both views and to the tab counts.
export function scopeFilter(prs: PR[]): PR[] {
  let out = state.org === "all" ? prs : prs.filter((p) => p.org === state.org);
  if (state.project !== "all") out = out.filter((p) => p.project === state.project);
  return out;
}

// A PR's Copilot review phase: the live job wins over the saved review row.
export function reviewPhase(pr: PR): ReviewPhase {
  const key = reviewStateKey(pr);
  if (state.activeReviewJobs[key]) return "active";
  const status = state.reviews[key]?.status;
  if (status === "queued" || status === "running") return "active";
  if (status === "done") return "done";
  if (status === "error") return "error";
  return null;
}

function reviewInfo(pr: PR): ReviewInfo {
  return { phase: reviewPhase(pr), updatedAt: state.reviews[reviewStateKey(pr)]?.updated_at };
}

function isActiveReview(pr: PR): boolean {
  return reviewPhase(pr) === "active";
}

// One selection model drives Review All, Hide and Restore.
const reviewSel = new Set<string>();

function prKey(pr: PR): string {
  return JSON.stringify([pr.org, pr.project, pr.repoId, String(pr.id)]);
}

// Rendered feed rows split by whether they are hidden, so the bulk bar offers
// Hide for the first and Restore for the second.
const feedKeys = new Set<string>();
const hiddenKeys = new Set<string>();
// The bulk bar's resting line when nothing is selected.
let summaryText = "";
// Session-only: whether My feed lists the PRs you hid from it.
let showHidden = false;

// ---- folds ----------------------------------------------------------------------------

const FOLDS_KEY = "adoPrOps.queueFolds";
const folds: Record<string, boolean> = readFolds();

function readFolds(): Record<string, boolean> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(FOLDS_KEY) || "{}");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? (saved as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

const searching = (): boolean => state.query.trim() !== "";

// While searching, every fold opens so no match hides, and toggles stay in the
// DOM so a search never rewrites the saved layout.
function isOpen(key: string, fallback: boolean): boolean {
  if (searching()) return true;
  return folds[key] ?? fallback;
}

function setOpen(key: string, open: boolean): void {
  if (searching()) return;
  folds[key] = open;
  try {
    localStorage.setItem(FOLDS_KEY, JSON.stringify(folds));
  } catch {
    // Storage blocked or full: the fold still works for this session.
  }
}

interface FoldClasses {
  root: string;
  head: string;
  body: string;
}

interface Fold {
  root: HTMLElement;
  body: HTMLElement;
}

let foldSeq = 0;

// A collapsible section: a chevron head button over a body. `heading` wraps the
// head in an h2 so lanes form the queue's outline for screen readers.
function makeFold(key: string, fallback: boolean, cls: FoldClasses, headHtml: string, heading: string | null): Fold {
  const open = isOpen(key, fallback);
  const bodyId = `queue-fold-${++foldSeq}`;
  const root = el(`<section class="fold ${cls.root}${open ? "" : " collapsed"}"></section>`);
  const head = el<HTMLButtonElement>(
    `<button type="button" class="fold-head ${cls.head}" aria-expanded="${open}" aria-controls="${bodyId}">` +
      `<span class="repo-chev" aria-hidden="true">${icon("chevron")}</span>${headHtml}</button>`
  );
  head.dataset.fold = key;
  head.dataset.focus = `fold:${key}`;
  head.addEventListener("click", () => {
    const nowOpen = !root.classList.toggle("collapsed");
    head.setAttribute("aria-expanded", String(nowOpen));
    setOpen(key, nowOpen);
    syncFoldAll();
    syncBulkBar();
  });
  if (heading) {
    const h = el(`<h2 class="${heading}"></h2>`);
    h.appendChild(head);
    root.appendChild(h);
  } else {
    root.appendChild(head);
  }
  const body = el(`<div class="fold-body ${cls.body}" id="${bodyId}"></div>`);
  root.appendChild(body);
  return { root, body };
}

function foldHead(fold: Element): HTMLElement | null {
  return fold.querySelector<HTMLElement>(":scope > .fold-head, :scope > h2 > .fold-head");
}

// ---- rows -----------------------------------------------------------------------------

interface RowOpts {
  /** Name the repo in the meta line (lanes mix repos; repo groups don't). */
  showRepo?: boolean;
  /** Drop the author and the Author badge (every row in the lane is yours). */
  hideAuthor?: boolean;
}

// The status pill + my-action chip + compact reviewer tally shown on a row's badge
// line. "Published" is the default state, so the queue only calls out exceptions.
// Fields are optional so older cached payloads degrade gracefully.
function metaBadges(p: PR, opts: RowOpts): string {
  const parts: string[] = [];
  if (p.authoredByMe && !opts.hideAuthor) parts.push(`<span class="authored-badge">${icon("person")}Author</span>`);
  const st = statusBadge(p);
  if (st.cls !== "st-unknown" && st.cls !== "st-published") {
    parts.push(`<span class="st-badge ${st.cls}">${st.label}</span>`);
  }
  const my = myActionBadge(p.myVote || 0, p.iCommented);
  if (my) parts.push(`<span class="my-act ${my.cls}">${icon(my.icon)}${my.label}</span>`);
  const t = reviewerTally(p.reviewers || []);
  const tallies: string[] = [];
  if (t.approved) tallies.push(tally("vote-approved", "check", t.approved, "approved"));
  if (t.rejected) tallies.push(tally("vote-rejected", "dismiss", t.rejected, "rejected"));
  if (t.waiting) tallies.push(tally("vote-waiting", "clock", t.waiting, "waiting for author"));
  if (tallies.length) parts.push(`<span class="rev-tally">${tallies.join("")}</span>`);
  return parts.join("");
}

function tally(cls: string, name: "check" | "dismiss" | "clock", n: number, label: string): string {
  return `<span class="tally ${cls}" title="${n} ${label}">${icon(name)}${n}<span class="visually-hidden"> ${label}</span></span>`;
}

// One clickable, selectable PR row, shared by every lane and repo group.
function prCard(p: PR, opts: RowOpts = {}): HTMLElement {
  const id = prKey(p);
  const active = isActiveReview(p);
  const card = el(
    `<div class="pr-card selectable${reviewSel.has(id) ? " selected" : ""}${openKey === id ? " is-open" : ""}" data-pr-key="${esc(id)}">` +
      `<input type="checkbox" class="pr-sel" aria-label="${
        active ? `PR ${p.id} is already queued or being reviewed` : `Select PR ${p.id}`
      }"${active ? " disabled" : ""}>` +
      `<button type="button" class="pr-open" aria-label="Open pull request ${p.id}: ${esc(p.title)}"${
        openKey === id ? ` aria-current="true"` : ""
      }>` +
      `<span class="pr-title">${esc(p.title)}</span>` +
      `<span class="pr-meta"><span class="pr-meta-main">` +
      `<span class="pr-number">#${p.id}</span>` +
      (opts.showRepo ? `<span class="pr-repo" title="${esc(p.project)} / ${esc(p.repo)}">${esc(p.repo)}</span>` : "") +
      (opts.hideAuthor ? "" : `<span class="pr-author">${esc(p.author)}</span>`) +
      `<span class="pr-age">${esc(timeAgo(p.created))}</span></span>` +
      `<span class="branch" title="${esc(p.sourceRef)} into ${esc(p.targetRef)}"><code>${esc(p.sourceRef)}</code></span>` +
      `</span>` +
      `<span class="pr-badges">${metaBadges(p, opts)}${reviewBadge(p)}</span>` +
      `</button></div>`
  );
  const open = card.querySelector<HTMLButtonElement>(".pr-open")!;
  open.dataset.focus = `open:${id}`;
  open.addEventListener("click", () => openDetail(p));
  const cb = card.querySelector<HTMLInputElement>(".pr-sel")!;
  cb.dataset.focus = `sel:${id}`;
  cb.checked = reviewSel.has(id);
  cb.addEventListener("click", (e) => e.stopPropagation());
  cb.addEventListener("change", () => {
    if (cb.checked) reviewSel.add(id);
    else reviewSel.delete(id);
    card.classList.toggle("selected", cb.checked);
    syncBulkBar();
  });
  return card;
}

// ---- My feed --------------------------------------------------------------------------

interface FeedModel {
  lanes: Map<FeedLane, PR[]>;
  hidden: PR[];
  count: number;
}

function feedModel(prs: PR[]): FeedModel {
  const lanes = new Map<FeedLane, PR[]>();
  const hidden: PR[] = [];
  let count = 0;
  for (const pr of prs) {
    const lane = feedLane(pr, reviewPhase(pr));
    if (!lane) continue;
    if (pr.plateDismissed) {
      hidden.push(pr);
      continue;
    }
    count++;
    const list = lanes.get(lane);
    if (list) list.push(pr);
    else lanes.set(lane, [pr]);
  }
  return { lanes, hidden, count };
}

const LANE_CLASSES: FoldClasses = { root: "lane", head: "lane-head", body: "lane-list" };
const DRAFT_CLASSES: FoldClasses = { root: "lane-drafts", head: "drafts-head", body: "drafts-list" };

function laneSection(key: string, title: string, prs: PR[], note: string, opts: RowOpts): HTMLElement {
  const fold = makeFold(
    `lane:${key}`,
    true,
    LANE_CLASSES,
    `<span class="lane-name">${esc(title)}</span><span class="count">${prs.length}</span>` +
      (note ? `<span class="lane-note">${esc(note)}</span>` : ""),
    "lane-title"
  );
  // Your own drafts are parked work: they fold away under the published ones.
  const drafts = key === "yours" ? prs.filter((p) => p.isDraft) : [];
  for (const p of prs) if (!drafts.includes(p)) fold.body.appendChild(prCard(p, opts));
  if (drafts.length) {
    const sub = makeFold(
      "lane:yours:drafts",
      false,
      DRAFT_CLASSES,
      `<span class="drafts-name">${plural(drafts.length, "draft")}</span>`,
      null
    );
    for (const p of drafts) sub.body.appendChild(prCard(p, opts));
    fold.body.appendChild(sub.root);
  }
  return fold.root;
}

function renderFeed(feed: FeedModel, matchedCount: number, into: DocumentFragment): PR[] {
  const visible: PR[] = [];
  const counts: Partial<Record<FeedLane, number>> = {};
  const now = Date.now();
  for (const { id, title } of FEED_LANES) {
    const prs = feed.lanes.get(id);
    if (!prs?.length) continue;
    counts[id] = prs.length;
    const sorted = sortLane(id, prs, reviewInfo);
    const opts: RowOpts = { showRepo: true, hideAuthor: id === "yours" };
    into.appendChild(laneSection(id, title, sorted, laneNote(id, sorted, reviewInfo, now), opts));
    for (const pr of sorted) {
      visible.push(pr);
      feedKeys.add(prKey(pr));
    }
  }
  summaryText = feedSummary(counts);
  if (!feed.count) into.appendChild(emptyFeed(matchedCount));
  if (feed.hidden.length) {
    if (showHidden) {
      // Hidden rows keep the default lane order: published first, newest first.
      const sorted = sortLane("review", feed.hidden, reviewInfo);
      into.appendChild(laneSection("hidden", "Hidden from your feed", sorted, "", { showRepo: true }));
      for (const pr of sorted) {
        visible.push(pr);
        hiddenKeys.add(prKey(pr));
      }
    }
    into.appendChild(feedFoot(feed.hidden.length));
  }
  return visible;
}

function feedFoot(n: number): HTMLElement {
  const foot = el(
    `<div class="feed-foot"><span>${plural(n, "pull request")} hidden from your feed</span>` +
      `<button type="button" class="btn ghost sm">${showHidden ? "Stop showing" : "Show"}</button></div>`
  );
  const toggle = foot.querySelector<HTMLButtonElement>(".btn")!;
  toggle.dataset.focus = "hidden-toggle";
  toggle.addEventListener("click", () => {
    showHidden = !showHidden;
    renderList(false);
  });
  return foot;
}

// ---- All ------------------------------------------------------------------------------

const REPO_CLASSES: FoldClasses = { root: "repo-group", head: "repo-head", body: "repo-list" };

function renderAll(prs: PR[], into: DocumentFragment): PR[] {
  const groups = new Map<string, { key: string; repo: string; project: string; list: PR[] }>();
  for (const pr of prs) {
    const key = `${pr.org}/${pr.project}/${pr.repo}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { key, repo: pr.repo, project: pr.project, list: [] }));
    group.list.push(pr);
  }
  const sorted = [...groups.values()].sort(
    (a, b) => a.repo.localeCompare(b.repo) || a.project.localeCompare(b.project)
  );
  const head = el(
    `<div class="all-head"><span class="all-sum">${plural(sorted.length, "repository", "repositories")}</span>` +
      `<button type="button" class="btn ghost sm all-fold"></button></div>`
  );
  const foldAll = head.querySelector<HTMLButtonElement>(".all-fold")!;
  foldAll.dataset.focus = "all-fold";
  foldAll.hidden = searching();
  foldAll.addEventListener("click", () => {
    const open = foldAll.dataset.next === "open";
    view.querySelectorAll<HTMLElement>(".repo-head").forEach((h) => setOpen(h.dataset.fold!, open));
    renderList(false);
  });
  into.appendChild(head);
  for (const g of sorted) {
    const fold = makeFold(
      `repo:${g.key}`,
      false,
      REPO_CLASSES,
      `<span class="repo-name">${esc(g.repo)}</span><span class="count">${g.list.length}</span>` +
        `<span class="proj">${esc(g.project)}</span>`,
      null
    );
    for (const p of g.list) fold.body.appendChild(prCard(p));
    into.appendChild(fold.root);
  }
  summaryText = searching() ? plural(prs.length, "match", "matches") : plural(prs.length, "pull request");
  return prs;
}

// "Expand all" while any repo is folded, otherwise "Collapse all".
function syncFoldAll(): void {
  const button = view.querySelector<HTMLButtonElement>(".all-fold");
  if (!button) return;
  const anyClosed = !!view.querySelector(".repo-group.collapsed");
  button.dataset.next = anyClosed ? "open" : "closed";
  button.textContent = anyClosed ? "Expand all" : "Collapse all";
}

// ---- empty states ---------------------------------------------------------------------

function emptyState(title: string, hint: string, action?: { label: string; run: () => void }): HTMLElement {
  const box = el(
    `<div class="empty"><p class="empty-title">${esc(title)}</p>` +
      (hint ? `<p class="hint">${esc(hint)}</p>` : "") +
      `</div>`
  );
  if (action) {
    const button = el<HTMLButtonElement>(`<button type="button" class="btn sm">${esc(action.label)}</button>`);
    button.dataset.focus = "empty-action";
    button.addEventListener("click", action.run);
    box.appendChild(button);
  }
  return box;
}

function emptyFeed(matchedCount: number): HTMLElement {
  if (searching()) {
    return emptyState(`Nothing in your feed matches “${state.query.trim()}”`, "", {
      label: `Search all pull requests (${matchedCount})`,
      run: () => setQueueView("all"),
    });
  }
  return emptyState(
    "You're all caught up",
    "PRs assigned to you, PRs Copilot reviewed, PRs you voted or commented on, and your own PRs land here.",
    { label: `Browse all ${plural(matchedCount, "pull request")}`, run: () => setQueueView("all") }
  );
}

function clearSearch(): void {
  queueSearch.value = "";
  state.query = "";
  renderList(false);
  queueSearch.focus();
}

// ---- tabs -----------------------------------------------------------------------------

function paintTabs(feedCount: number, allCount: number): void {
  queueTabs.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((btn) => {
    const tab = btn.dataset.view === "all" ? "all" : "feed";
    const on = tab === state.queueView;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", String(on));
    const n = btn.querySelector<HTMLElement>(".seg-n");
    if (n) n.textContent = String(tab === "feed" ? feedCount : allCount);
  });
}

/** Switch the queue between My feed and All, remembered across launches. */
export function setQueueView(next: QueueView): void {
  state.queueView = next;
  try {
    localStorage.setItem(QUEUE_VIEW_KEY, next);
  } catch {
    // Storage blocked: the view still switches for this session.
  }
  view.scrollTop = 0;
  renderList(false);
}

// ---- bulk actions ---------------------------------------------------------------------

// Enabled row checkboxes the reader can see (not inside a folded section).
function openBoxes(): HTMLInputElement[] {
  return [...view.querySelectorAll<HTMLInputElement>(".pr-sel:not(:disabled)")].filter(
    (box) => !box.closest(".fold.collapsed")
  );
}

function syncBulkBar(): void {
  const bar = bulkReviewHost.querySelector<HTMLElement>(".bulk-review-bar");
  if (!bar) return;
  const n = reviewSel.size;
  const boxes = openBoxes();
  const checked = boxes.filter((box) => box.checked).length;
  const all = bar.querySelector<HTMLInputElement>(".bulk-select-all")!;
  all.disabled = boxes.length === 0;
  all.checked = boxes.length > 0 && checked === boxes.length;
  all.indeterminate = checked > 0 && checked < boxes.length;
  bar.querySelector<HTMLElement>(".bulk-count")!.textContent = n ? `${n} selected` : summaryText;
  bar.querySelector<HTMLButtonElement>(".bulk-clear")!.hidden = n === 0;
  const toHide = [...reviewSel].filter((id) => feedKeys.has(id)).length;
  const toRestore = [...reviewSel].filter((id) => hiddenKeys.has(id)).length;
  const hide = bar.querySelector<HTMLButtonElement>(".feed-hide")!;
  const restore = bar.querySelector<HTMLButtonElement>(".feed-restore")!;
  if (!hide.hasAttribute("aria-busy")) {
    hide.hidden = toHide === 0;
    hide.textContent = `Hide (${toHide})`;
  }
  if (!restore.hasAttribute("aria-busy")) {
    restore.hidden = toRestore === 0;
    restore.textContent = `Restore (${toRestore})`;
  }
  const review = bar.querySelector<HTMLButtonElement>(".bulk-review")!;
  if (!review.hasAttribute("aria-busy")) {
    review.disabled = n === 0;
    review.textContent = n ? `Review All (${n})` : "Review All";
  }
}

function clearSelection(): void {
  reviewSel.clear();
  view.querySelectorAll(".pr-card.selected").forEach((card) => card.classList.remove("selected"));
  view.querySelectorAll<HTMLInputElement>(".pr-sel").forEach((checkbox) => (checkbox.checked = false));
  syncBulkBar();
}

async function reviewSelected(button: HTMLButtonElement): Promise<void> {
  const prs = state.prs.filter((pr) => reviewSel.has(prKey(pr)) && !isActiveReview(pr));
  if (!prs.length) return;
  requestNotifyPermission();
  const original = button.textContent || "Review All";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const result = await sendPrsToCopilot(prs, (done, total) => {
      button.textContent = `Preparing ${done}/${total}…`;
    });
    for (const prId of [...result.accepted, ...result.skipped]) reviewSel.delete(prId);
    if (result.accepted.length) {
      toast(
        `Queued ${result.accepted.length} PR${result.accepted.length === 1 ? "" : "s"} for independent review`,
        "ok"
      );
    }
    if (result.skipped.length) {
      toast(
        `${result.skipped.length} selected PR${result.skipped.length === 1 ? " is" : "s are"} already queued or running`,
        "ok"
      );
    }
    if (result.failed.length) {
      toast(
        `Could not prepare ${result.failed.length} PR${result.failed.length === 1 ? "" : "s"}: ${result.failed[0].error}`,
        "err"
      );
    }
    renderList(false);
  } catch (e) {
    toast("Could not queue reviews: " + (e as Error).message, "err");
  } finally {
    if (button.isConnected) {
      button.disabled = reviewSel.size === 0;
      button.removeAttribute("aria-busy");
      button.textContent = original;
      syncBulkBar();
    }
  }
}

// Hide the selected feed rows from My feed, or restore selected hidden rows.
// The preference is stored server-side, so it survives refreshes and restarts.
async function setHidden(hide: boolean, button: HTMLButtonElement): Promise<void> {
  const keys = hide ? feedKeys : hiddenKeys;
  const prs = state.prs.filter((pr) => reviewSel.has(prKey(pr)) && keys.has(prKey(pr)));
  if (!prs.length) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    await postJSON("/api/review/dismiss", {
      prs: prs.map((pr) => ({ prId: pr.id, org: pr.org, project: pr.project, repoId: pr.repoId })),
      dismissed: hide,
    });
    for (const pr of prs) {
      pr.plateDismissed = hide;
      reviewSel.delete(prKey(pr));
    }
    toast(
      hide
        ? `Hid ${plural(prs.length, "pull request")} from My feed`
        : `Restored ${plural(prs.length, "pull request")} to My feed`,
      "ok"
    );
    renderList();
  } catch {
    toast("Couldn't update My feed. Try again.", "err");
    if (button.isConnected) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      syncBulkBar();
    }
  }
}

function renderBulkReviewBar(prs: PR[]): HTMLElement {
  const bar = el(
    `<div class="bulk-review-bar" role="region" aria-label="Bulk actions">` +
      `<label class="bulk-select-label" title="Select all visible">` +
      `<input type="checkbox" class="bulk-select-all"${prs.some((pr) => !isActiveReview(pr)) ? "" : " disabled"}>` +
      `<span class="visually-hidden">Select all visible pull requests</span></label>` +
      `<span class="bulk-count" role="status"></span>` +
      `<button type="button" class="btn ghost sm bulk-clear" aria-label="Clear selection" title="Clear selection" hidden>${icon("dismiss")}</button>` +
      `<button type="button" class="btn ghost sm feed-hide" title="Hide the selected pull requests from My feed" hidden>Hide</button>` +
      `<button type="button" class="btn ghost sm feed-restore" title="Return the selected pull requests to My feed" hidden>Restore</button>` +
      `<button type="button" class="btn sm bulk-review" title="Queue a Copilot review for each selected pull request" disabled>Review All</button>` +
      `</div>`
  );
  const all = bar.querySelector<HTMLInputElement>(".bulk-select-all")!;
  all.dataset.focus = "bulk-all";
  all.addEventListener("change", () => {
    for (const box of openBoxes()) {
      box.checked = all.checked;
      const card = box.closest<HTMLElement>(".pr-card")!;
      card.classList.toggle("selected", all.checked);
      if (all.checked) reviewSel.add(card.dataset.prKey!);
      else reviewSel.delete(card.dataset.prKey!);
    }
    syncBulkBar();
  });
  const clear = bar.querySelector<HTMLButtonElement>(".bulk-clear")!;
  clear.dataset.focus = "bulk-clear";
  clear.addEventListener("click", clearSelection);
  const hide = bar.querySelector<HTMLButtonElement>(".feed-hide")!;
  hide.dataset.focus = "bulk-hide";
  hide.addEventListener("click", () => void setHidden(true, hide));
  const restore = bar.querySelector<HTMLButtonElement>(".feed-restore")!;
  restore.dataset.focus = "bulk-restore";
  restore.addEventListener("click", () => void setHidden(false, restore));
  const review = bar.querySelector<HTMLButtonElement>(".bulk-review")!;
  review.dataset.focus = "bulk-review";
  review.addEventListener("click", () => void reviewSelected(review));
  return bar;
}

// ---- right-click: copy links ----------------------------------------------------------

// Checked PRs in on-screen order, so pasted links read top to bottom like the queue.
function checkedPrs(): PR[] {
  const byKey = new Map(state.prs.map((pr) => [prKey(pr), pr]));
  const out: PR[] = [];
  view.querySelectorAll<HTMLElement>(".pr-card").forEach((card) => {
    const key = card.dataset.prKey!;
    const pr = reviewSel.has(key) ? byKey.get(key) : undefined;
    if (pr) out.push(pr);
  });
  return out;
}

async function copyLinks(text: string, count: number): Promise<void> {
  const ok = await copyText(text);
  if (ok) toast(count === 1 ? "Copied link to PR" : `Copied ${count} PR links`, "ok");
  else toast("Couldn't copy to the clipboard. Try again.", "err");
}

view.addEventListener("contextmenu", (e) => {
  const card = (e.target as HTMLElement).closest<HTMLElement>(".pr-card");
  if (!card) return;
  const key = card.dataset.prKey!;
  const pr = state.prs.find((p) => prKey(p) === key);
  if (!pr) return;
  e.preventDefault();
  const entries = linkMenuEntries(pr, checkedPrs(), reviewSel.has(key));
  // A keyboard-opened menu reports (0, 0): anchor it to the row instead.
  const rect = card.getBoundingClientRect();
  const keyboard = e.clientX === 0 && e.clientY === 0;
  openContextMenu(
    keyboard ? rect.left + 24 : e.clientX,
    keyboard ? rect.top + rect.height / 2 : e.clientY,
    `Pull request ${pr.id}`,
    entries.map((entry) => ({ label: entry.label, icon: "copy", run: () => void copyLinks(entry.text, entry.count) })),
    () => findFocusTarget(`open:${key}`)?.focus({ preventScroll: true })
  );
});

// ---- open row -------------------------------------------------------------------------

// The row whose PR is open in the reading pane (prKey), tracked across re-renders.
let openKey: string | null = null;

function markOpenRow(): void {
  view.querySelectorAll<HTMLElement>(".pr-card").forEach((card) => {
    const open = card.dataset.prKey === openKey;
    card.classList.toggle("is-open", open);
    const btn = card.querySelector<HTMLButtonElement>(".pr-open");
    if (open) btn?.setAttribute("aria-current", "true");
    else btn?.removeAttribute("aria-current");
  });
}

window.addEventListener("ado-pr-open", (e) => {
  const pr = (e as CustomEvent<PR | null>).detail;
  openKey = pr ? prKey(pr) : null;
  markOpenRow();
});

// ---- focus + keyboard -----------------------------------------------------------------

function findFocusTarget(token: string): HTMLElement | null {
  for (const root of [view, bulkReviewHost]) {
    for (const node of root.querySelectorAll<HTMLElement>("[data-focus]")) {
      if (node.dataset.focus === token) return node;
    }
  }
  return null;
}

const focusable = (node: HTMLElement | null): node is HTMLElement =>
  !!node && !(node as HTMLButtonElement).disabled && node.getClientRects().length > 0;

// Re-renders replace every node, so remember what had focus by its data-focus
// token and hand focus back to its replacement (or the nearest sensible stand-in).
function captureFocus(): (() => void) | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === view) return null;
  const inBar = bulkReviewHost.contains(active);
  if (!inBar && !view.contains(active)) return null;
  const token = active.closest<HTMLElement>("[data-focus]")?.dataset.focus;
  return () => {
    const match = token ? findFocusTarget(token) : null;
    const fallback = inBar ? findFocusTarget("bulk-all") : null;
    const target = focusable(match) ? match : focusable(fallback) ? fallback : view;
    target.focus({ preventScroll: true });
  };
}

// Arrow keys walk rows and section heads; Left/Right fold and unfold like a tree.
view.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const target = e.target as HTMLElement;
  if (!target.matches(".pr-open, .fold-head")) return;
  const isHead = target.matches(".fold-head");
  const expanded = target.getAttribute("aria-expanded") === "true";
  let next: HTMLElement | null | undefined;
  if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
    const items = [...view.querySelectorAll<HTMLElement>(".pr-open, .fold-head")].filter(
      (node) => node.getClientRects().length > 0
    );
    const i = items.indexOf(target);
    if (e.key === "ArrowDown") next = items[i + 1];
    else if (e.key === "ArrowUp") next = items[i - 1];
    else if (e.key === "Home") next = items[0];
    else next = items[items.length - 1];
  } else if (e.key === "ArrowRight" && isHead && !expanded) {
    e.preventDefault();
    target.click();
    return;
  } else if (e.key === "ArrowLeft") {
    if (isHead && expanded) {
      e.preventDefault();
      target.click();
      return;
    }
    const own = target.closest(".fold");
    const parent = isHead ? own?.parentElement?.closest(".fold") : own;
    next = parent ? foldHead(parent) : null;
  } else {
    return;
  }
  if (!next) return;
  e.preventDefault();
  next.focus();
  next.scrollIntoView({ block: "nearest" });
});

// ---- render ---------------------------------------------------------------------------

/**
 * Each row's last laid-out height, by PR. Rows off screen skip layout
 * (content-visibility in style.css) and stand in at a placeholder height; a
 * rebuilt row gets the height its predecessor had, so the rows above the fold
 * keep their size and the scroll position lands on the same row.
 */
const rowHeights = new Map<string, number>();

function rememberRowHeights(): void {
  const rows = view.querySelectorAll<HTMLElement>(".pr-card > .pr-open");
  if (!rows.length) return;
  // contain-intrinsic-size sizes the content box, so padding and borders come off the measured height.
  const style = getComputedStyle(rows[0]);
  const frame = ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"].reduce(
    (sum, prop) => sum + (parseFloat(style[prop as keyof CSSStyleDeclaration] as string) || 0),
    0
  );
  for (const open of rows) {
    const key = (open.parentElement as HTMLElement).dataset.prKey;
    const height = open.offsetHeight - frame;
    if (key && height > 0) rowHeights.set(key, height);
  }
}

function applyRowHeights(): void {
  const shown = new Set<string>();
  for (const open of view.querySelectorAll<HTMLElement>(".pr-card > .pr-open")) {
    const key = (open.parentElement as HTMLElement).dataset.prKey;
    if (!key) continue;
    shown.add(key);
    const height = rowHeights.get(key);
    if (height) open.style.containIntrinsicSize = `auto ${height}px`;
  }
  // Only rows still in the list are worth remembering.
  for (const key of [...rowHeights.keys()]) if (!shown.has(key)) rowHeights.delete(key);
}

export function renderList(stopPolling = true): void {
  // The open PR's review poll keeps running while the queue re-renders beside it.
  if (stopPolling && !isPaneOpen()) stopReviewPoll();

  const restoreFocus = captureFocus();
  const scrollTop = view.scrollTop;
  rememberRowHeights();

  const scoped = scopeFilter(state.prs);
  const terms = parseQuery(state.query);
  const matched = terms.length ? scoped.filter((pr) => matchesQuery(pr, terms, reviewPhase(pr))) : scoped;
  const feed = feedModel(matched);
  paintTabs(feed.count, matched.length);

  feedKeys.clear();
  hiddenKeys.clear();
  summaryText = "";
  const frag = document.createDocumentFragment();
  let visible: PR[] = [];
  if (!scoped.length) {
    const scope = [state.org === "all" ? state.config.organizations.join(", ") : state.org];
    if (state.project !== "all") scope.push(state.project);
    frag.appendChild(emptyState("No open pull requests", `Scope: ${scope.join(" / ")}`));
  } else if (!matched.length) {
    frag.appendChild(
      emptyState(
        `No pull requests match “${state.query.trim()}”`,
        "Search covers title, #id, author, repo and branch. Narrow with is:draft, -is:draft, is:reviewed, repo:, author: or branch:.",
        { label: "Clear search", run: clearSearch }
      )
    );
  } else if (state.queueView === "all") {
    visible = renderAll(matched, frag);
  } else {
    visible = renderFeed(feed, matched.length, frag);
  }

  // Keep the selection to rows still on screen that can take a new review.
  const selectable = new Set(visible.filter((pr) => !isActiveReview(pr)).map(prKey));
  for (const id of reviewSel) if (!selectable.has(id)) reviewSel.delete(id);

  view.replaceChildren(frag);
  applyRowHeights();
  if (visible.length) bulkReviewHost.replaceChildren(renderBulkReviewBar(visible));
  else bulkReviewHost.replaceChildren();
  syncFoldAll();
  syncBulkBar();
  view.scrollTop = scrollTop;
  restoreFocus?.();
}
