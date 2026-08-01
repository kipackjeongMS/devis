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

// A small status pill for a PR's background-review state, or "" when none.
export function reviewBadge(prId: number | string): string {
  const r = state.reviews[String(prId)];
  if (!r) return "";
  if (r.status === "running") return '<span class="rev-badge running">⏳ Reviewing…</span>';
  if (r.status === "done") return '<span class="rev-badge done">✓ Reviewed</span>';
  if (r.status === "error") return '<span class="rev-badge error">⚠ Review failed</span>';
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
  const r = state.reviews[String(pr.id)];
  const reviewed = !!r && (r.status === "running" || r.status === "done");
  const marked = (pr.myVote || 0) !== 0 || !!pr.iCommented;
  return !pr.plateDismissed && (reviewed || marked);
}

// PRs currently checked on My Plate (by string PR id). Cleared on every render.
const plateSel = new Set<string>();

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

// One clickable PR card. Shared by My Plate and the main repo list.
// When `selectable` (My Plate only), a checkbox lets the user multi-select cards;
// clicking the checkbox must not open the detail modal.
function prCard(p: PR, selectable = false): HTMLElement {
  const id = String(p.id);
  const card = el(
    `<div class="pr-card${selectable ? " selectable" : ""}${selectable && plateSel.has(id) ? " selected" : ""}">
       ${selectable ? `<input type="checkbox" class="plate-sel" aria-label="Select PR ${p.id}">` : ""}
       <div class="pr-title">${esc(p.title)}</div>
       <div class="pr-meta">
         <span class="id">#${p.id}</span>
         ${metaBadges(p)}
         ${reviewBadge(p.id)}
         <span class="branch"><code>${esc(p.sourceRef)}</code>→<code>${esc(p.targetRef)}</code></span>
         <span>by ${esc(p.author)}</span>
         <span>${esc(timeAgo(p.created))}</span>
       </div>
     </div>`
  );
  card.addEventListener("click", () => openDetail(p));
  if (selectable) {
    const cb = card.querySelector<HTMLInputElement>(".plate-sel")!;
    cb.checked = plateSel.has(id);
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      if (cb.checked) {
        plateSel.add(id);
        card.classList.add("selected");
      } else {
        plateSel.delete(id);
        card.classList.remove("selected");
      }
      syncPlateBar();
    });
  }
  return card;
}

// Group PRs by org/project/repo and append a collapsible repo group per repo
// into `container`. `collapsed` sets the initial fold state of each group.
function renderRepoGroups(prs: PR[], container: HTMLElement, collapsed: boolean, selectable = false): void {
  const groups = new Map<string, { repo: string; project: string; list: PR[] }>();
  for (const p of prs) {
    const key = p.org + " / " + p.project + " / " + p.repo;
    if (!groups.has(key)) groups.set(key, { repo: p.repo, project: p.project, list: [] });
    groups.get(key)!.list.push(p);
  }
  const sorted = [...groups.values()].sort((a, b) => a.repo.localeCompare(b.repo));
  for (const g of sorted) {
    const wrap = el(`<section class="repo-group${collapsed ? " collapsed" : ""}"></section>`);
    const head = el(
      `<div class="repo-head"><span class="repo-chev">▶</span>` +
        `<span class="repo-name">${esc(g.repo)}</span>` +
        `<span class="count">${g.list.length}</span>` +
        `<span class="proj">${esc(g.project)}</span></div>`
    );
    head.addEventListener("click", () => wrap.classList.toggle("collapsed"));
    wrap.appendChild(head);
    const listWrap = el(`<div class="repo-list"></div>`);
    for (const p of g.list) listWrap.appendChild(prCard(p, selectable));
    wrap.appendChild(listWrap);
    container.appendChild(wrap);
  }
}

// --- My Plate action bar (multi-select removal) -----------------------------

// Reflect the current selection count into the My Plate action bar.
function syncPlateBar(): void {
  const actions = view.querySelector<HTMLElement>(".plate-actions");
  if (!actions) return;
  const n = plateSel.size;
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
  const ids = [...plateSel];
  if (!ids.length) return;
  try {
    await postJSON("/api/review/dismiss", { prIds: ids, dismissed: true });
    for (const p of state.prs) {
      if (ids.includes(String(p.id))) p.plateDismissed = true;
    }
    plateSel.clear();
    toast(`Removed ${ids.length} PR${ids.length > 1 ? "s" : ""} from My Plate`, "ok");
    renderList();
  } catch {
    toast("Couldn't update My Plate — please try again.", "err");
  }
}

// Clear the current selection without removing anything.
function clearSelection(): void {
  plateSel.clear();
  view.querySelectorAll(".pr-card.selected").forEach((c) => c.classList.remove("selected"));
  view.querySelectorAll<HTMLInputElement>(".plate-sel").forEach((c) => (c.checked = false));
  syncPlateBar();
}

export function renderList(stopPolling = true): void {
  if (stopPolling) stopReviewPoll();
  plateSel.clear();

  // My Plate obeys scope only (org/project); the main list also obeys assignment.
  const scoped = scopeFilter(state.prs);
  const plate = scoped.filter(isOnPlate);
  const rest = assignmentFilter(scoped).filter((p) => !isOnPlate(p));

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

  if (plate.length) {
    const sec = el(`<section class="plate-group"></section>`);
    const head = el(
      `<div class="plate-head"><span class="repo-chev">▶</span>` +
        `<span class="plate-name">🍽 My Plate</span>` +
        `<span class="count">${plate.length}</span></div>`
    );
    head.addEventListener("click", () => sec.classList.toggle("collapsed"));
    sec.appendChild(head);

    const body = el(`<div class="plate-body"></div>`);
    // Action bar first, so multi-select removal is discoverable above the cards.
    const actions = el(
      `<div class="plate-actions">` +
        `<span class="plate-hint">Select PRs to remove them from My Plate.</span>` +
        `<button class="btn ghost sm plate-clear" hidden>Clear</button>` +
        `<button class="btn sm plate-remove" disabled>Remove from My Plate</button>` +
        `</div>`
    );
    actions.querySelector<HTMLButtonElement>(".plate-remove")!.addEventListener("click", removeSelected);
    actions.querySelector<HTMLButtonElement>(".plate-clear")!.addEventListener("click", clearSelection);
    body.appendChild(actions);

    renderRepoGroups(plate, body, false, true);
    sec.appendChild(body);
    view.appendChild(sec);
  }

  renderRepoGroups(rest, view, true, false);
}
