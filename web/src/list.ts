// The PR list: a review badge per PR plus the repo-grouped, collapsible card list.
// A card click opens the PR detail in a slide-over modal (see detail.ts); the list
// stays mounted underneath, so it needs no re-render when the modal closes.
import { el, view } from "./dom.js";
import { esc, timeAgo } from "./util.js";
import { state, stopReviewPoll } from "./state.js";
import { openDetail } from "./detail.js";
import type { PR } from "./types.js";

// A small status pill for a PR's background-review state, or "" when none.
export function reviewBadge(prId: number | string): string {
  const r = state.reviews[String(prId)];
  if (!r) return "";
  if (r.status === "running") return '<span class="rev-badge running">⏳ Reviewing…</span>';
  if (r.status === "done") return '<span class="rev-badge done">✓ Reviewed</span>';
  if (r.status === "error") return '<span class="rev-badge error">⚠ Review failed</span>';
  return "";
}

// Client-side filter chain: org -> project -> assignment. Kept separate from
// renderList so the app module can reuse it for counts if needed.
export function applyFilters(prs: PR[]): PR[] {
  let out = state.org === "all" ? prs : prs.filter((p) => p.org === state.org);
  if (state.project !== "all") out = out.filter((p) => p.project === state.project);
  if (state.assignment === "mine") out = out.filter((p) => p.mine);
  else if (state.assignment === "notmine") out = out.filter((p) => !p.mine);
  return out;
}

// A PR is "on Copilot's Plate" when it has a background review that is
// currently running (in-review) or already done (reviewed).
function isOnPlate(pr: PR): boolean {
  const r = state.reviews[String(pr.id)];
  return !!r && (r.status === "running" || r.status === "done");
}

// One clickable PR card. Shared by the Plate section and the main repo list.
function prCard(p: PR): HTMLElement {
  const card = el(
    `<div class="pr-card">
       <div class="pr-title">${esc(p.title)}</div>
       <div class="pr-meta">
         <span class="id">#${p.id}</span>
         ${p.isDraft ? '<span class="badge-draft">Draft</span>' : ""}
         ${reviewBadge(p.id)}
         <span class="branch"><code>${esc(p.sourceRef)}</code>→<code>${esc(p.targetRef)}</code></span>
         <span>by ${esc(p.author)}</span>
         <span>${esc(timeAgo(p.created))}</span>
       </div>
     </div>`
  );
  card.addEventListener("click", () => openDetail(p));
  return card;
}

// Group PRs by org/project/repo and append a collapsible repo group per repo
// into `container`. `collapsed` sets the initial fold state of each group.
function renderRepoGroups(prs: PR[], container: HTMLElement, collapsed: boolean): void {
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
    for (const p of g.list) listWrap.appendChild(prCard(p));
    wrap.appendChild(listWrap);
    container.appendChild(wrap);
  }
}

export function renderList(): void {
  stopReviewPoll();
  const prs = applyFilters(state.prs);
  if (!prs.length) {
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

  // Copilot's Plate (reviewed / in-review) is pulled out of the main list so a
  // PR shows in exactly one place.
  const plate = prs.filter(isOnPlate);
  const rest = prs.filter((p) => !isOnPlate(p));

  view.innerHTML = "";

  if (plate.length) {
    const sec = el(`<section class="plate-group"></section>`);
    const head = el(
      `<div class="plate-head"><span class="repo-chev">▶</span>` +
        `<span class="plate-name">🍽 Copilot's Plate</span>` +
        `<span class="count">${plate.length}</span></div>`
    );
    head.addEventListener("click", () => sec.classList.toggle("collapsed"));
    sec.appendChild(head);
    const body = el(`<div class="plate-body"></div>`);
    renderRepoGroups(plate, body, false);
    sec.appendChild(body);
    view.appendChild(sec);
  }

  renderRepoGroups(rest, view, true);
}
