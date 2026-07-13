// The PR list: a review badge per PR plus the repo-grouped, collapsible card list.
//
// NOTE: list <-> detail form an intentional runtime cycle (a card click calls
// openDetail; renderDetail's back button calls renderList). References are only
// invoked from event handlers, never at module-eval time, so the ES module cycle
// resolves safely.
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
  // group by repo (org/project/repo)
  const groups = new Map<string, { repo: string; project: string; list: typeof prs }>();
  for (const p of prs) {
    const key = p.org + " / " + p.project + " / " + p.repo;
    if (!groups.has(key)) groups.set(key, { repo: p.repo, project: p.project, list: [] });
    groups.get(key)!.list.push(p);
  }
  const sorted = [...groups.values()].sort((a, b) => a.repo.localeCompare(b.repo));

  view.innerHTML = "";
  for (const g of sorted) {
    const wrap = el(`<section class="repo-group collapsed"></section>`);
    const head = el(
      `<div class="repo-head"><span class="repo-chev">▶</span>` +
        `<span class="repo-name">${esc(g.repo)}</span>` +
        `<span class="count">${g.list.length}</span>` +
        `<span class="proj">${esc(g.project)}</span></div>`
    );
    head.addEventListener("click", () => wrap.classList.toggle("collapsed"));
    wrap.appendChild(head);
    const listWrap = el(`<div class="repo-list"></div>`);
    for (const p of g.list) {
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
      listWrap.appendChild(card);
    }
    wrap.appendChild(listWrap);
    view.appendChild(wrap);
  }
}
