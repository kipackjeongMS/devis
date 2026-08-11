// The Ev2 "Rollouts" view (a lightweight in-canvas Release Dashboard).
//
// Service group -> rollout -> stage -> region hierarchy. The list of rollouts
// (with status badges) loads up front; each rollout's stage/region grid is
// fetched lazily the first time it is expanded (the heavy 2.8MB embed detail),
// mirroring the PR -> diff lazy pattern elsewhere in this app.
import { el, view } from "./dom.js";
import { esc, timeAgo } from "./util.js";
import { getJSON } from "./api.js";
import { toast } from "./toast.js";
import type { ServiceGroupRollouts, RolloutSummary, RolloutGrid, RegionInfo } from "./types.js";

// Map an Ev2 status to a small set of visual kinds (ported from the dashboard's
// getStatusColor: green / red / blue / gold / neutral).
function statusKind(status: string | null | undefined): string {
  if (!status) return "none";
  if (status === "Succeeded") return "ok";
  if (status === "Failed") return "fail";
  if (status === "Running") return "run";
  if (status.includes("Progress")) return "prog";
  return "none";
}

const shortSg = (name: string): string => name.replace("Microsoft.Azure.AppConfiguration.", "");

function statusBadge(status: string): string {
  return `<span class="st-badge st-${statusKind(status)}">${esc(status)}</span>`;
}

export async function renderRollouts(): Promise<void> {
  view.innerHTML =
    '<div class="loading"><span class="spinner"></span> Loading Ev2 rollouts…</div>';
  let data: { serviceGroups: ServiceGroupRollouts[]; errors: string[] };
  try {
    data = await getJSON("/api/ev2/rollouts");
  } catch (e: any) {
    view.innerHTML =
      `<div class="empty">Failed to load rollouts: ${esc(e.message)}` +
      `<div class="hint">Check that you are logged in with <code>az login</code>.</div></div>`;
    return;
  }
  if (data.errors && data.errors.length) toast(data.errors[0], "err");

  const groups = (data.serviceGroups || []).filter((g) => g.rollouts.length > 0);
  view.innerHTML = "";

  if (!groups.length) {
    view.innerHTML =
      `<div class="empty">No rollouts in the last 21 days.` +
      `<div class="hint">Across ${(data.serviceGroups || []).length} AppConfig service groups.</div></div>`;
    return;
  }

  for (const g of groups) renderGroup(g);
}

function renderGroup(g: ServiceGroupRollouts): void {
  const wrap = el(`<section class="sg-group"></section>`);

  // distinct non-terminal statuses shown on the header (like the dashboard).
  const statuses = [...new Set(g.rollouts.map((r) => r.status).filter((s) => s && s !== "None"))];
  const badges = statuses.map((s) => statusBadge(s)).join("");

  const head = el(
    `<button type="button" class="sg-head" aria-expanded="true">` +
      `<span class="sg-chev">▶</span>` +
      `<span class="sg-name">${esc(shortSg(g.name))}</span>` +
      `<span class="sg-badges">${badges}</span>` +
      `<span class="count">${g.rollouts.length}</span>` +
      `</button>`
  );
  head.addEventListener("click", () => {
    const isCollapsed = wrap.classList.toggle("collapsed");
    head.setAttribute("aria-expanded", String(!isCollapsed));
  });
  wrap.appendChild(head);

  const list = el(`<div class="sg-list"></div>`);
  for (const r of g.rollouts) list.appendChild(renderRolloutCard(r));
  wrap.appendChild(list);
  view.appendChild(wrap);
}

function renderRolloutCard(r: RolloutSummary): HTMLElement {
  const card = el(`<div class="rollout-card"></div>`);
  const head = el(
    `<div class="rollout-head" role="button" tabindex="0" aria-expanded="false">` +
      `<span class="ro-chev">▶</span>` +
      statusBadge(r.status) +
      `<span class="ro-id" title="${esc(r.id)}"><code>${esc(r.id.slice(0, 8))}</code></span>` +
      (r.buildVersion ? `<span class="ro-build">Build ${esc(r.buildVersion)}</span>` : "") +
      (r.startTime ? `<span class="ro-time">Started ${esc(timeAgo(r.startTime))}</span>` : "") +
      `</div>`
  );
  const portal = el(`<button type="button" class="link-btn ro-portal">Ev2 Portal ↗</button>`);
  portal.addEventListener("click", (e) => {
    e.stopPropagation();
    window.open(r.url, "_blank");
  });
  head.appendChild(portal);

  const gridWrap = el(`<div class="rollout-grid"></div>`);
  let loaded = false;
  const toggleRollout = async (): Promise<void> => {
    const open = card.classList.toggle("open");
    head.setAttribute("aria-expanded", String(open));
    if (open && !loaded) {
      loaded = true;
      gridWrap.innerHTML =
        '<div class="grid-loading"><span class="spinner"></span> Loading stages…</div>';
      try {
        const grid: RolloutGrid = await getJSON(
          `/api/ev2/rollout?serviceGroup=${encodeURIComponent(r.serviceGroup)}&id=${encodeURIComponent(r.id)}`
        );
        renderGrid(gridWrap, grid);
      } catch (e: any) {
        loaded = false; // allow retry
        gridWrap.innerHTML = `<div class="grid-note">Failed to load stages: ${esc(e.message)}</div>`;
      }
    }
  };
  head.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".ro-portal")) return;
    void toggleRollout();
  });
  head.addEventListener("keydown", (e) => {
    if (e.target !== head || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    void toggleRollout();
  });

  card.appendChild(head);
  card.appendChild(gridWrap);
  return card;
}

function renderGrid(wrap: HTMLElement, grid: RolloutGrid): void {
  wrap.innerHTML = "";
  for (const st of grid.stages) {
    const stage = el(
      `<div class="stage">` +
        `<div class="stage-name">${esc(st.name)}<span class="stage-count">${st.regions.length}</span></div>` +
        `</div>`
    );
    const rgrid = el(`<div class="region-grid"></div>`);
    for (const region of st.regions) rgrid.appendChild(renderRegion(region));
    stage.appendChild(rgrid);
    wrap.appendChild(stage);
  }
}

function renderRegion(region: RegionInfo): HTMLElement {
  const kind = statusKind(region.status);
  const chip = el(
    `<div class="region-chip st-b-${kind}">` +
      `<span class="rg-name" title="${esc(region.name)}">${esc(region.name)}</span>` +
      `<span class="rg-row">${statusBadge(region.status)}` +
      (region.startTime ? `<span class="rg-time">${esc(timeAgo(region.startTime))}</span>` : "") +
      `</span>` +
      `</div>`
  );
  return chip;
}
