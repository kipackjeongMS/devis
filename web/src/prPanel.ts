// The Workspace's Pull Requests panel. My PRs: yours, drafts too, with what needs you on
// top. Reviews: everyone else's, searchable and filterable, shown 20 at a time and paged
// in from Azure DevOps past the first page as you scroll. The rules are in prPanelModel.ts;
// this keeps the panel's own state and writes its HTML. jarvis.ts owns the events.
import { getJSON } from "./api.js";
import { esc } from "./util.js";
import { icon } from "./icons.js";
import { state } from "./state.js";
import { reviewPhase } from "./prReview.js";
import { reviewStateKey } from "./reviewKey.js";
import { loadPrRecency } from "./prRecency.js";
import { inboxItems } from "./inboxPanel.js";
import { ago, agoPhrase, askFor, askerWhere, askersLine, copilotReviewControl, inService, type CommsAsk } from "./jarvisModel.js";
import {
  PR_FILTERS,
  REVIEW_PAGE,
  attentionKey,
  isPrFilter,
  mineAt,
  myPrs,
  prIdentity,
  reasonText,
  reviewsList,
  type MineRow,
  type PrFilter,
  type ReviewRow,
} from "./prPanelModel.js";
import {
  checkState,
  contextIsSelected,
  pruned,
  ranged,
  rowClick,
  selectedInOrder,
  toggled,
  toggledAll,
  type ClickMods,
  type RowClick,
} from "./prSelectionModel.js";
import type { CappedProject, PR } from "./types.js";

export interface PrPanelContext {
  now: number;
  /** The Workspace's service filter: "all" or "org/project". */
  service: string;
  /** The PR list has answered at least once. */
  loaded: boolean;
  asks: CommsAsk[] | undefined;
  /** PRs whose Copilot review is being queued, by identity. */
  queuing: ReadonlySet<string>;
}

export interface PrPanelView {
  html: string;
  /** PRs listed: yours, plus reviews that pass search and filters. */
  count: number;
  /** Your PRs with comments or replies you haven't read. */
  newCount: number;
  newLabel: string;
}

type Fold = "mine" | "reviews";
const FOLDS_KEY = "adoPrOps.workspace.prsFolds";
/** The first page /api/prs reads per project (ACTIVE_PR_PAGE in src/ado.mts). */
const FIRST_PAGE = 200;
const FLASH_MS = 1400;

const isFold = (v: unknown): v is Fold => v === "mine" || v === "reviews";

function readFolds(): Fold[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(FOLDS_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter(isFold) : [];
  } catch {
    return [];
  }
}

let rerender: () => void = () => undefined;
const folded = new Set<Fold>(readFolds());
let query = "";
const filters = new Set<PrFilter>();
let shown = REVIEW_PAGE;
let lastService = "";
let lastTotal = 0;

interface OlderPages {
  skip: number;
  more: boolean;
  loading: boolean;
  error: string;
}
const older = new Map<string, OlderPages>();
const olderKey = (c: CappedProject): string => `${c.org}/${c.project}`;
function olderOf(c: CappedProject): OlderPages {
  let pages = older.get(olderKey(c));
  if (!pages) older.set(olderKey(c), (pages = { skip: FIRST_PAGE, more: true, loading: false, error: "" }));
  return pages;
}

// New activity on your PRs flashes its row once. Nothing flashes until the inbox has
// answered, or every unread row would flash when it lands.
let inboxReady = false;
window.addEventListener("ado-inbox", () => (inboxReady = true));
let seen: Set<string> | null = null;
const flashing = new Map<string, number>();
let flashTimer = 0;

/** The panel repaints through jarvis.ts, which knows when the Workspace is on screen. */
export function initPrPanel(repaint: () => void): void {
  rerender = repaint;
}

// ---- selection ----------------------------------------------------------------------
// Select mode shows a checkbox on every row and the bulk bar. Selection is by identity and
// only ever holds rows that are listed, so the count matches what's on screen.

let selecting = false;
let selected: ReadonlySet<string> = new Set();
let anchor: string | null = null;
/** The rows on screen, in order, and the PRs behind them. */
let order: string[] = [];
const listed = new Map<string, PR>();
/** The row whose context menu is open. */
let ctxId: string | null = null;

export const contextIsSelectedRow = (id: string): boolean => contextIsSelected(selected, id);
export const isSelecting = (): boolean => selecting;
export const selectionSize = (): number => selected.size;
export const prAt = (id: string): PR | undefined => listed.get(id);
export const isSelected = (id: string): boolean => selected.has(id);
export const setContextRow = (id: string | null): void => void (ctxId = id);

/** The selected PRs, in the order they're listed. */
export const selectedPrs = (): PR[] => selectedInOrder(selected, order).flatMap((id) => listed.get(id) ?? []);

export function setSelecting(on: boolean): void {
  selecting = on;
  if (!on) {
    selected = new Set();
    anchor = null;
  }
}

export const clearSelection = (): void => void (selected = new Set());

export function toggleAll(): void {
  selected = toggledAll(selected, order);
  anchor = null;
}

/** A click on a row's title or checkbox. Returns what it should do: open the PR, or repaint. */
export function clickRow(id: string, mods: ClickMods): RowClick {
  const how = rowClick(selecting, mods);
  if (how === "open") return how;
  selecting = true;
  selected = how === "range" ? ranged(selected, order, anchor, id) : toggled(selected, id);
  anchor = id;
  return how;
}

/** The header checkbox is tri-state, which HTML can't carry; call after each paint. */
export function syncSelectionUi(body: HTMLElement): void {
  const all = body.querySelector<HTMLInputElement>('[data-role="select-all"]');
  if (all) all.indeterminate = checkState(selected, order) === "some";
}

function bulkBar(): string {
  const n = selected.size;
  const state = checkState(selected, order);
  const tail = n ? ` (${n})` : "";
  return `
    <div class="pp-bulk" data-key="bulk" role="toolbar" aria-label="Selected pull requests">
      <label class="pp-all" title="Select every listed pull request"><input type="checkbox" class="pp-check-box" data-act="pr-select-all" data-role="select-all" aria-label="Select all listed pull requests"${
        state === "all" ? " checked" : ""
      }${order.length ? "" : " disabled"}><span class="pp-count" aria-live="polite">${n ? `${n} selected` : "Select pull requests"}</span></label>
      <button type="button" class="btn sm ghost" data-act="pr-bulk-clear"${n ? "" : " disabled"}>Clear</button>
      <span class="pp-bulk-sp"></span>
      <button type="button" class="btn sm ghost" data-act="pr-bulk-copy" title="Copy a link to each selected pull request"${n ? "" : " disabled"}>${icon("copy")}<span>Copy links${tail}</span></button>
      <button type="button" class="btn sm" data-act="pr-bulk-review" title="Queue a Copilot review for each selected pull request"${n ? "" : " disabled"}>${icon("sparkle")}<span>Review${tail}</span></button>
    </div>`;
}

export function toggleFold(which: string | undefined): void {
  if (!isFold(which)) return;
  if (!folded.delete(which)) folded.add(which);
  try {
    localStorage.setItem(FOLDS_KEY, JSON.stringify([...folded]));
  } catch {
    /* private mode: the fold lasts for the page */
  }
}

export function setQuery(value: string): void {
  if (value === query) return;
  query = value;
  shown = REVIEW_PAGE;
}

export function toggleFilter(id: string | undefined): void {
  if (!isPrFilter(id)) return;
  if (!filters.delete(id)) filters.add(id);
  shown = REVIEW_PAGE;
}

export function clearSearch(): void {
  query = "";
  filters.clear();
  shown = REVIEW_PAGE;
}

export function showMore(): void {
  shown += REVIEW_PAGE;
}

const cappedInScope = (service: string): CappedProject[] =>
  state.cappedProjects.filter((c) => inService({ org: c.org, project: c.project }, service));

/** Older pages to read: those with more, not loading, and (unless asked) not failing. */
const olderTargets = (service: string, manual: boolean): CappedProject[] =>
  cappedInScope(service).filter((c) => {
    const pages = olderOf(c);
    return pages.more && !pages.loading && (manual || !pages.error);
  });

/** Read the next page of active PRs past the first, for each busy project in scope. */
export async function loadOlder(service: string, manual: boolean): Promise<void> {
  const targets = olderTargets(service, manual);
  if (!targets.length) return;
  for (const c of targets) Object.assign(olderOf(c), { loading: true, error: "" });
  rerender();
  let recency = false;
  await Promise.all(
    targets.map(async (c) => {
      const pages = olderOf(c);
      try {
        const res = await getJSON(`/api/prs/older?org=${encodeURIComponent(c.org)}&project=${encodeURIComponent(c.project)}&skip=${pages.skip}`);
        const page: PR[] = res.prs || [];
        pages.skip += page.length;
        pages.more = !!res.more && page.length > 0;
        const have = new Set([state.prs, state.authoredPrs, state.olderPrs].flat().map(prIdentity));
        for (const pr of page) {
          if (have.has(prIdentity(pr))) continue;
          have.add(prIdentity(pr));
          state.olderPrs.push(pr);
        }
        if (res.recencyPending > 0) recency = true;
      } catch (e) {
        pages.error = (e as Error).message;
      } finally {
        pages.loading = false;
      }
    })
  );
  if (recency) loadPrRecency();
  rerender();
}

// ---- scrolling in more --------------------------------------------------------------

let observer: IntersectionObserver | null = null;
let watched: Element | null = null;
let sentinelVisible = false;

/** Near the end of Reviews: show the next 20, or read the next page from ADO. */
function advance(): void {
  if (!sentinelVisible) return;
  if (lastTotal > shown) {
    shown += REVIEW_PAGE;
    rerender();
  } else {
    void loadOlder(lastService, false);
  }
}

/**
 * Watch the end of Reviews after a paint. The observer only reports changes, so when the
 * same marker is still in view after a page lands, look again: the list may still be short.
 * Its root is the viewport, which clips through whichever box scrolls (the panel or the sheet).
 */
export function watchSentinel(body: HTMLElement): void {
  const node = body.querySelector('[data-key="sentinel"]');
  if (node !== watched) {
    if (watched) observer?.unobserve(watched);
    watched = node;
    sentinelVisible = false;
    if (!node) return;
    observer ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.target === watched) sentinelVisible = entry.isIntersecting;
        advance();
      },
      { rootMargin: "0px 0px 120px 0px" }
    );
    observer.observe(node);
    return;
  }
  if (node && sentinelVisible) requestAnimationFrame(advance);
}

// ---- HTML ---------------------------------------------------------------------------

const iso = (t: number): string => (t ? new Date(t).toISOString() : "");

function copilotButton(pr: PR, ctx: PrPanelContext): string {
  const control = copilotReviewControl(reviewPhase(pr));
  const queued = ctx.queuing.has(prIdentity(pr));
  const busy = control.disabled || queued;
  const label = `${queued ? "Queuing" : control.label}: ${pr.title}`;
  return `<button type="button" class="icon-btn copilot-review" data-act="copilot-review" title="${esc(queued ? "Queuing…" : control.title)}" aria-label="${esc(label)}"${
    busy ? " disabled" : ""
  }>${busy ? '<span class="spinner"></span>' : icon("sparkle")}</button>`;
}

function askLink(ask: CommsAsk | undefined): string {
  if (!ask) return "";
  const first = ask.askers[0];
  const title = `${askersLine(ask.askers)} asked ${first ? askerWhere(first) : "in Teams"}. Open the message in Teams.`;
  return `<a class="rr-ask" href="${esc(first?.link || "")}" target="_blank" rel="noopener" data-act="pr-teams" title="${esc(title)}">${icon("chat")}<span class="ell">Asked by ${esc(
    askersLine(ask.askers)
  )}</span></a>`;
}

const chip = (label: string, tone: string): string => `<span class="rr-st tone-${tone}">${esc(label)}</span>`;
const prId = (pr: PR): string => `<span class="pp-id"><span class="pp-num">#${esc(String(pr.id))}</span> · ${esc(pr.repo)}</span>`;

function row(pr: PR, ctx: PrPanelContext, dot: string, at: string, line: string): string {
  const id = prIdentity(pr);
  const flash = (flashing.get(id) || 0) > ctx.now ? " flash" : "";
  const meta = `#${pr.id} · ${pr.repo} · ${pr.author} · opened ${agoPhrase(pr.created, ctx.now) || "a while ago"}${pr.isDraft ? " · Draft" : ""}`;
  const on = selected.has(id);
  const check = selecting
    ? `<input type="checkbox" class="pp-check" data-act="pr-select" aria-label="Select #${pr.id} ${esc(pr.title)}"${on ? " checked" : ""}>`
    : "";
  return `
    <div class="rr pp-row${flash}${on ? " is-selected" : ""}${ctxId === id ? " is-ctx" : ""}${selecting ? " is-selecting" : ""}" data-key="pr:${esc(id)}" data-pr="${esc(JSON.stringify([pr.org, pr.project, pr.repoId, pr.id]))}">
      ${check}<button type="button" class="rr-main" data-act="open-pr" aria-haspopup="menu" aria-keyshortcuts="Shift+F10" title="${esc(meta)}">
        <span class="rdot tone-${dot}"></span><span class="rr-t ell">${esc(pr.title)}</span><span class="rr-tm">${esc(ago(at, ctx.now))}</span>
      </button>
      <span class="rr-ha">${copilotButton(pr, ctx)}</span>
      <div class="rr-p">${line}</div>
    </div>`;
}

const MINE_DOT: Record<string, string> = { activity: "run", rejected: "bad", waiting: "warn" };
const ATTENTION_TONE: Record<string, string> = { accent: "run", bad: "bad", warn: "warn" };

function mineRowHtml(r: MineRow, ctx: PrPanelContext): string {
  const control = copilotReviewControl(reviewPhase(r.pr));
  const parts = [
    r.attention ? chip(r.label, ATTENTION_TONE[r.tone] || "idle") : r.pr.isDraft ? chip("Draft", "off") : "",
    control.chip ? chip(control.chip.label, control.chip.tone) : "",
    prId(r.pr),
  ];
  const dot = r.attention ? MINE_DOT[r.attention] : r.pr.isDraft ? "off" : "idle";
  return row(r.pr, ctx, dot, iso(mineAt(r)), parts.join(""));
}

const REASON_TONE: Partial<Record<ReviewRow["reason"]["kind"], string>> = { copilot: "ok", "copilot-active": "run", "copilot-error": "bad" };

function reviewRowHtml(r: ReviewRow, ctx: PrPanelContext): string {
  const tone = REASON_TONE[r.reason.kind];
  const control = copilotReviewControl(r.phase);
  // The Copilot chip says the same as a Copilot reason, so one of them is enough.
  const status = tone ? chip(reasonText(r.reason.kind, ""), tone) : `${control.chip ? chip(control.chip.label, control.chip.tone) : ""}<span>${esc(reasonText(r.reason.kind, ""))}</span>`;
  const parts = [askLink(askFor(ctx.asks, r.pr)), status, r.pr.isDraft ? chip("Draft", "off") : "", prId(r.pr)];
  return row(r.pr, ctx, r.asked ? "run" : "idle", r.reason.at, parts.join(""));
}

function subSection(key: Fold, title: string, count: number, body: string): string {
  const open = !folded.has(key);
  return `
    <div class="pp-sec" data-key="${key}">
      <h4 class="pp-h"><button type="button" class="pp-t" data-act="prs-fold" data-fold="${key}" data-role="fold-${key}" aria-expanded="${open}" aria-controls="pp-b-${key}">${icon(
        "chevron"
      )}<span class="pp-name">${esc(title)}</span><span class="pp-n">${count || ""}</span></button></h4>
      <div class="pp-b" id="pp-b-${key}"${open ? "" : " hidden"}>${open ? body : ""}</div>
    </div>`;
}

const loadingLine = '<p class="rs-empty" data-key="loading"><span class="spinner"></span> Loading pull requests…</p>';

function reviewsTools(): string {
  const chips = PR_FILTERS.map(
    (f) =>
      `<button type="button" class="pp-chip" data-act="pr-filter" data-filter="${f.id}" data-role="filter-${f.id}" aria-pressed="${filters.has(f.id)}" title="${esc(f.title)}">${esc(
        f.label
      )}</button>`
  ).join("");
  return `
    <div class="pp-tools" data-key="tools">
      <label class="queue-search pp-search">${icon("search")}<input type="search" data-role="pr-search" value="${esc(
        query
      )}" placeholder="Search reviews" aria-label="Search reviews" spellcheck="false" autocomplete="off"></label>
      <div class="pp-chips" role="group" aria-label="Show only">${chips}</div>
    </div>`;
}

function reviewsFoot(total: number, service: string): string {
  const capped = cappedInScope(service).map(olderOf);
  const loading = capped.some((p) => p.loading);
  const failed = capped.find((p) => p.error && p.more);
  const olderLeft = capped.some((p) => p.more);
  const parts: string[] = [];
  if (total > shown) parts.push(`<span class="pp-showing">${shown} of ${total}</span>`);
  if (total > shown) parts.push(`<button type="button" class="rs-more" data-act="prs-more">Show ${Math.min(REVIEW_PAGE, total - shown)} more</button>`);
  else if (loading) parts.push(`<span class="rs-empty"><span class="spinner"></span> Loading older pull requests…</span>`);
  else if (failed) parts.push(`<span class="pp-err">Couldn't load older pull requests. ${esc(failed.error)}</span><button type="button" class="rs-more" data-act="prs-older">Try again</button>`);
  else if (olderLeft) parts.push(`<button type="button" class="rs-more" data-act="prs-older">Load older pull requests</button>`);
  if (!parts.length) return "";
  const sentinel = total > shown || (olderLeft && !loading && !failed) ? '<div class="pp-sentinel" data-key="sentinel" aria-hidden="true"></div>' : "";
  return `<div class="pp-foot" data-key="foot">${parts.join("")}</div>${sentinel}`;
}

/** The panel's HTML and counts. Equal HTML means nothing on screen changed. */
export function prPanelHtml(ctx: PrPanelContext): PrPanelView {
  if (ctx.service !== lastService) {
    lastService = ctx.service;
    shown = REVIEW_PAGE;
  }
  const mine = myPrs(state.prs, state.authoredPrs, inboxItems()).filter((r) => inService(r.pr, ctx.service));
  const reviews = reviewsList(state.prs, state.olderPrs, {
    query,
    filters,
    phaseOf: reviewPhase,
    copilotAt: (pr) => state.reviews[reviewStateKey(pr)]?.updated_at,
    asked: (pr) => !!askFor(ctx.asks, pr),
    inScope: (pr) => inService(pr, ctx.service),
  });
  lastTotal = reviews.length;

  // What's listed now, in order. A folded section lists nothing.
  const shownReviews = reviews.slice(0, shown);
  const rows = [...(folded.has("mine") ? [] : mine.map((r) => r.pr)), ...(folded.has("reviews") ? [] : shownReviews.map((r) => r.pr))];
  order = rows.map(prIdentity);
  listed.clear();
  for (const pr of rows) listed.set(prIdentity(pr), pr);
  selected = pruned(selected, order);
  if (anchor !== null && !listed.has(anchor)) anchor = null;
  if (ctxId !== null && !listed.has(ctxId)) ctxId = null;

  // Rows that start needing you, or get new activity, flash once.
  if (ctx.loaded && inboxReady) {
    const keys = new Set<string>();
    for (const r of mine) {
      const key = attentionKey(r);
      if (!key) continue;
      keys.add(key);
      if (seen && !seen.has(key)) flashing.set(prIdentity(r.pr), ctx.now + FLASH_MS);
    }
    seen = keys;
  }
  for (const [id, until] of flashing) if (until <= ctx.now) flashing.delete(id);
  if (flashing.size && !flashTimer) {
    flashTimer = window.setTimeout(() => {
      flashTimer = 0;
      rerender();
    }, FLASH_MS + 50);
  }

  const searching = !!query.trim() || filters.size > 0;
  const mineBody = !ctx.loaded && !mine.length ? loadingLine : mine.length ? mine.map((r) => mineRowHtml(r, ctx)).join("") : '<p class="rs-empty" data-key="empty">You have no open pull requests.</p>';
  let list: string;
  if (!ctx.loaded && !reviews.length) list = loadingLine;
  else if (!reviews.length && searching)
    list = `<p class="rs-empty" data-key="empty">No pull requests match.</p><button type="button" class="rs-more" data-key="clear" data-act="pr-clear">Clear search and filters</button>`;
  else if (!reviews.length) list = '<p class="rs-empty" data-key="empty">No pull requests to review.</p>';
  else list = shownReviews.map((r) => reviewRowHtml(r, ctx)).join("");
  const busy = cappedInScope(ctx.service).some((c) => olderOf(c).loading);
  const reviewsBody = `${reviewsTools()}<div class="pp-list" data-key="list"${busy ? ' aria-busy="true"' : ""}>${list}</div>${ctx.loaded ? reviewsFoot(reviews.length, ctx.service) : ""}`;

  const newCount = mine.filter((r) => r.attention === "activity").length;
  return {
    html: (selecting ? bulkBar() : "") + subSection("mine", "My PRs", mine.length, mineBody) + subSection("reviews", "Reviews", reviews.length, reviewsBody),
    count: mine.length + reviews.length,
    newCount,
    newLabel: `${newCount} with new comments`,
  };
}
