// The PR list: a review badge per PR plus the repo-grouped, collapsible card list.
// A card click opens the PR detail in a slide-over modal (see detail.ts); the list
// stays mounted underneath, so it needs no re-render when the modal closes.
import { el, view } from "./dom.js";
import { esc, timeAgo } from "./util.js";
import { state, stopReviewPoll } from "./state.js";
import { openDetail } from "./detail.js";
import { postJSON } from "./api.js";
import { toast } from "./toast.js";
import type { PR } from "./types.js";
import { statusBadge, myActionBadge, reviewerTally } from "./prStatus.js";
import { sendPrsToCopilot } from "./bridge.js";
import { requestNotifyPermission } from "./notifyWatch.js";
import { reviewStateKey } from "./reviewKey.js";

// A small status pill for a PR's background-review state, or "" when none.
export function reviewBadge(pr: PR): string {
  const key = reviewStateKey(pr);
  const active = state.activeReviewJobs[key];
  const provenance = active?.automation_source === "teams"
    ? ` title="Requested in Teams by ${esc(active.automation_requester || "unknown requester")}"`
    : "";
  if (active) {
    if (active.status === "queued" || active.status === "dispatching") {
      return `<span class="rev-badge queued"${provenance}>◷ Queued</span>`;
    }
    return `<span class="rev-badge running"${provenance}>⏳ Reviewing…</span>`;
  }
  const r = state.reviews[key];
  if (!r) return "";
  const storedProvenance = r.automation_source === "teams"
    ? ` title="Requested in Teams by ${esc(r.automation_requester || "unknown requester")}"`
    : "";
  if (r.status === "queued") return `<span class="rev-badge queued"${storedProvenance}>◷ Queued</span>`;
  if (r.status === "running") return `<span class="rev-badge running"${storedProvenance}>⏳ Reviewing…</span>`;
  if (r.status === "done") return `<span class="rev-badge done"${storedProvenance}>✓ Reviewed</span>`;
  if (r.status === "error") return `<span class="rev-badge error"${storedProvenance}>⚠ Review failed</span>`;
  return "";
}

// The filter chain is split in two on purpose:
//   scopeFilter      — org + project only. Applies to EVERYTHING, including My Plate.
//   assignmentFilter — Me / Not me. Applies ONLY to the main list, never My Plate,
//                      so it contains every reviewed or user-marked PR in scope
//                      regardless of who it's assigned to.
export function scopeFilter(prs: PR[]): PR[] {
  let out = state.org === "all" ? prs : prs.filter((p) => p.org === state.org);
  if (state.project !== "all") out = out.filter((p) => p.project === state.project);
  return out;
}

export function assignmentFilter(prs: PR[]): PR[] {
  if (state.assignment === "mine") return prs.filter((p) => p.mine);
  if (state.assignment === "notmine") return prs.filter((p) => !p.mine);
  return prs;
}

// Full main-list filter: scope + assignment. Kept for any external callers.
export function applyFilters(prs: PR[]): PR[] {
  return assignmentFilter(scopeFilter(prs));
}

// My Plate collects both Copilot-reviewed PRs and PRs where the current user left
// a vote or comment. The explicit removal preference applies to either source.
export function isOnPlate(pr: PR): boolean {
  const key = reviewStateKey(pr);
  const r = state.reviews[key];
  const active = !!state.activeReviewJobs[key];
  const reviewed = !!r && (r.status === "queued" || r.status === "running" || r.status === "done");
  const marked = (pr.myVote || 0) !== 0 || !!pr.iCommented;
  return !pr.plateDismissed && (active || reviewed || marked);
}

// One selection model drives both Review All and My Plate removal.
const reviewSel = new Set<string>();

function prKey(pr: PR): string {
  return JSON.stringify([pr.org, pr.project, pr.repoId, String(pr.id)]);
}

function isActiveReview(pr: PR): boolean {
  if (state.activeReviewJobs[reviewStateKey(pr)]) return true;
  const status = state.reviews[reviewStateKey(pr)]?.status;
  return status === "queued" || status === "running";
}

// The status pill + my-action chip + compact reviewer tally shown in a card's meta
// row. Fields are optional so older cached payloads degrade gracefully.
function metaBadges(p: PR): string {
  const parts: string[] = [];
  if (p.authoredByMe) parts.push(`<span class="authored-badge">👤 Author</span>`);
  const st = statusBadge(p);
  if (st.cls !== "st-unknown") parts.push(`<span class="st-badge ${st.cls}">${st.label}</span>`);
  const my = myActionBadge(p.myVote || 0, p.iCommented);
  if (my) parts.push(`<span class="my-act ${my.cls}">${my.icon} ${my.label}</span>`);
  const t = reviewerTally(p.reviewers || []);
  const tallies: string[] = [];
  if (t.approved) tallies.push(`<span class="tally vote-approved">✓${t.approved}</span>`);
  if (t.rejected) tallies.push(`<span class="tally vote-rejected">✗${t.rejected}</span>`);
  if (t.waiting) tallies.push(`<span class="tally vote-waiting">⏳${t.waiting}</span>`);
  if (tallies.length) parts.push(`<span class="rev-tally">${tallies.join("")}</span>`);
  return parts.join("");
}

// One clickable, selectable PR card shared by My Plate and the main repo list.
function prCard(p: PR): HTMLElement {
  const id = prKey(p);
  const active = isActiveReview(p);
  const card = el(
    `<div class="pr-card selectable${reviewSel.has(id) ? " selected" : ""}">` +
      `<input type="checkbox" class="pr-sel" aria-label="${
        active ? `PR ${p.id} is already queued or being reviewed` : `Select PR ${p.id} for bulk review`
      }"${active ? " disabled" : ""}>` +
      `<button type="button" class="pr-open" aria-label="Open pull request ${p.id}: ${esc(p.title)}">
       <span class="pr-title"><span class="pr-number">#${p.id}</span>${esc(p.title)}</span>
       <span class="pr-meta">
         ${metaBadges(p)}
         ${reviewBadge(p)}
         <span class="branch"><code>${esc(p.sourceRef)}</code>→<code>${esc(p.targetRef)}</code></span>
         <span>by ${esc(p.author)}</span>
         <span>${esc(timeAgo(p.created))}</span>
       </span>
       </button></div>`
  );
  card.querySelector<HTMLButtonElement>(".pr-open")!.addEventListener("click", () => openDetail(p));
  const cb = card.querySelector<HTMLInputElement>(".pr-sel")!;
  cb.checked = reviewSel.has(id);
  cb.addEventListener("click", (e) => e.stopPropagation());
  cb.addEventListener("change", () => {
    if (cb.checked) {
      reviewSel.add(id);
      card.classList.add("selected");
    } else {
      reviewSel.delete(id);
      card.classList.remove("selected");
    }
    syncBulkBar();
    syncPlateBar();
  });
  return card;
}

// Group PRs by org/project/repo and append a collapsible repo group per repo
// into `container`. `collapsed` sets the initial fold state of each group.
function renderRepoGroups(prs: PR[], container: HTMLElement, collapsed: boolean, kind: "plate" | "queue"): void {
  const groups = new Map<string, { repo: string; project: string; list: PR[] }>();
  for (const p of prs) {
    const key = p.org + " / " + p.project + " / " + p.repo;
    if (!groups.has(key)) groups.set(key, { repo: p.repo, project: p.project, list: [] });
    groups.get(key)!.list.push(p);
  }
  const sorted = [...groups.values()].sort((a, b) => a.repo.localeCompare(b.repo));
  sorted.forEach((g, index) => {
    const listId = `repo-list-${kind}-${index}`;
    const wrap = el(`<section class="repo-group${collapsed ? " collapsed" : ""}"></section>`);
    const head = el(
      `<button type="button" class="repo-head" aria-expanded="${String(!collapsed)}" aria-controls="${listId}">` +
        `<span class="repo-chev">▶</span>` +
        `<span class="repo-name">${esc(g.repo)}</span>` +
        `<span class="count">${g.list.length}</span>` +
        `<span class="proj">${esc(g.project)}</span></button>`
    );
    head.addEventListener("click", () => {
      const isCollapsed = wrap.classList.toggle("collapsed");
      head.setAttribute("aria-expanded", String(!isCollapsed));
    });
    wrap.appendChild(head);
    const listWrap = el(`<div class="repo-list" id="${listId}"></div>`);
    for (const p of g.list) listWrap.appendChild(prCard(p));
    wrap.appendChild(listWrap);
    container.appendChild(wrap);
  });
}

// --- Bulk review selection ---------------------------------------------------

function syncBulkBar(): void {
  const actions = view.querySelector<HTMLElement>(".bulk-review-bar");
  if (!actions) return;
  const n = reviewSel.size;
  const selectable = view.querySelectorAll<HTMLInputElement>(".pr-sel:not(:disabled)");
  const selectedVisible = [...selectable].filter((checkbox) => checkbox.checked).length;
  const all = actions.querySelector<HTMLInputElement>(".bulk-select-all")!;
  const clear = actions.querySelector<HTMLButtonElement>(".bulk-clear")!;
  const review = actions.querySelector<HTMLButtonElement>(".bulk-review")!;
  const count = actions.querySelector<HTMLElement>(".bulk-count")!;
  all.checked = selectable.length > 0 && selectedVisible === selectable.length;
  all.indeterminate = selectedVisible > 0 && selectedVisible < selectable.length;
  count.textContent = n ? `${n} selected` : "Select pull requests";
  clear.hidden = n === 0;
  review.disabled = n === 0;
  review.textContent = n ? `Review All (${n})` : "Review All";
}

function clearSelection(): void {
  reviewSel.clear();
  view.querySelectorAll(".pr-card.selected").forEach((card) => card.classList.remove("selected"));
  view.querySelectorAll<HTMLInputElement>(".pr-sel").forEach((checkbox) => (checkbox.checked = false));
  syncBulkBar();
  syncPlateBar();
}

function clearPlateSelection(): void {
  const plateIds = new Set(scopeFilter(state.prs).filter(isOnPlate).map(prKey));
  for (const id of plateIds) reviewSel.delete(id);
  view.querySelectorAll<HTMLElement>(".plate-body .pr-card.selected").forEach((card) =>
    card.classList.remove("selected")
  );
  view.querySelectorAll<HTMLInputElement>(".plate-body .pr-sel").forEach(
    (checkbox) => (checkbox.checked = false)
  );
  syncBulkBar();
  syncPlateBar();
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

function renderBulkReviewBar(prs: PR[]): HTMLElement {
  const eligible = prs.filter((pr) => !isActiveReview(pr));
  const bar = el(
    `<div class="bulk-review-bar" role="region" aria-label="Bulk PR review">` +
      `<label class="bulk-select-label">` +
      `<input type="checkbox" class="bulk-select-all"${eligible.length ? "" : " disabled"}>` +
      `<span>Select all visible</span></label>` +
      `<span class="bulk-count" role="status">Select pull requests</span>` +
      `<button type="button" class="btn ghost sm bulk-clear" hidden>Clear</button>` +
      `<button type="button" class="btn sm bulk-review" disabled>Review All</button>` +
      `</div>`
  );
  const all = bar.querySelector<HTMLInputElement>(".bulk-select-all")!;
  all.addEventListener("change", () => {
    for (const pr of eligible) {
      const id = prKey(pr);
      if (all.checked) reviewSel.add(id);
      else reviewSel.delete(id);
    }
    view.querySelectorAll<HTMLInputElement>(".pr-sel:not(:disabled)").forEach((checkbox) => {
      checkbox.checked = all.checked;
      checkbox.closest(".pr-card")?.classList.toggle("selected", all.checked);
    });
    syncBulkBar();
    syncPlateBar();
  });
  bar.querySelector<HTMLButtonElement>(".bulk-clear")!.addEventListener("click", clearSelection);
  const review = bar.querySelector<HTMLButtonElement>(".bulk-review")!;
  review.addEventListener("click", () => void reviewSelected(review));
  return bar;
}

// --- My Plate action bar (selected-item removal) -----------------------------

// Reflect the current selection count into the My Plate action bar.
function syncPlateBar(): void {
  const actions = view.querySelector<HTMLElement>(".plate-actions");
  if (!actions) return;
  const plateIds = new Set(scopeFilter(state.prs).filter(isOnPlate).map(prKey));
  const n = [...reviewSel].filter((id) => plateIds.has(id)).length;
  const remove = actions.querySelector<HTMLButtonElement>(".plate-remove")!;
  const clear = actions.querySelector<HTMLButtonElement>(".plate-clear")!;
  const hint = actions.querySelector<HTMLElement>(".plate-hint")!;
  remove.disabled = n === 0;
  remove.textContent = n ? `Remove from My Plate (${n})` : "Remove from My Plate";
  clear.hidden = n === 0;
  hint.hidden = n > 0;
}

// Persist the removal server-side, mark the reviews dismissed locally, re-render.
async function removeSelected(): Promise<void> {
  const plateIds = new Set(scopeFilter(state.prs).filter(isOnPlate).map(prKey));
  const ids = [...reviewSel].filter((id) => plateIds.has(id));
  if (!ids.length) return;
  const selected = state.prs.filter((pr) => ids.includes(prKey(pr)));
  try {
    await postJSON("/api/review/dismiss", {
      prs: selected.map((pr) => ({
        prId: pr.id,
        org: pr.org,
        project: pr.project,
        repoId: pr.repoId,
      })),
      dismissed: true,
    });
    for (const pr of selected) pr.plateDismissed = true;
    for (const id of ids) reviewSel.delete(id);
    toast(`Removed ${ids.length} PR${ids.length > 1 ? "s" : ""} from My Plate`, "ok");
    renderList();
  } catch {
    toast("Couldn't update My Plate — please try again.", "err");
  }
}

export function renderList(stopPolling = true): void {
  if (stopPolling) stopReviewPoll();

  // My Plate obeys scope only (org/project); the main list also obeys assignment.
  const scoped = scopeFilter(state.prs);
  const plate = scoped.filter(isOnPlate);
  const rest = assignmentFilter(scoped).filter((p) => !isOnPlate(p));
  const visible = [...plate, ...rest];
  const visibleIds = new Set(visible.map(prKey));
  for (const id of reviewSel) {
    if (!visibleIds.has(id) || isActiveReview(state.prs.find((pr) => prKey(pr) === id)!)) {
      reviewSel.delete(id);
    }
  }

  if (!plate.length && !rest.length) {
    const msg =
      state.assignment === "mine"
        ? "No pull requests assigned to you."
        : "No pull requests match these filters.";
    const scope: string[] = [
      state.org === "all" ? state.config.organizations.join(", ") : state.org,
    ];
    if (state.project !== "all") scope.push(state.project);
    view.innerHTML =
      `<div class="empty">${esc(msg)}<div class="hint">Scope: ${esc(scope.join(" / "))}</div></div>`;
    return;
  }

  view.innerHTML = "";
  view.appendChild(renderBulkReviewBar(visible));

  if (plate.length) {
    const sec = el(`<section class="plate-group"></section>`);
    const head = el(
      `<button type="button" class="plate-head" aria-expanded="true" aria-controls="plateBody">` +
        `<span class="repo-chev">▶</span>` +
        `<span class="plate-name">My Plate</span>` +
        `<span class="count">${plate.length}</span></button>`
    );
    head.addEventListener("click", () => {
      const isCollapsed = sec.classList.toggle("collapsed");
      head.setAttribute("aria-expanded", String(!isCollapsed));
    });
    sec.appendChild(head);

    const body = el(`<div class="plate-body" id="plateBody"></div>`);
    // Action bar first, so multi-select removal is discoverable above the cards.
    const actions = el(
      `<div class="plate-actions">` +
        `<span class="plate-hint">Selected My Plate PRs can also be removed here.</span>` +
        `<button type="button" class="btn ghost sm plate-clear" hidden>Clear</button>` +
        `<button type="button" class="btn sm plate-remove" disabled>Remove from My Plate</button>` +
        `</div>`
    );
    actions.querySelector<HTMLButtonElement>(".plate-remove")!.addEventListener("click", removeSelected);
    actions.querySelector<HTMLButtonElement>(".plate-clear")!.addEventListener("click", clearPlateSelection);
    body.appendChild(actions);

    renderRepoGroups(plate, body, false, "plate");
    sec.appendChild(body);
    view.appendChild(sec);
  }

  renderRepoGroups(rest, view, true, "queue");
  syncBulkBar();
  syncPlateBar();
}
