// Entry module: boot sequence, PR loading, org filter, settings screen, and the
// top-level event wiring. This is the only module with module-eval side effects
// (the final boot() call), so import order stays free of runtime cycles.
import { $, view, filterbar, orgFilter, projectFilter, assignFilter, el, renderError, setPage } from "./dom.js";
import { esc } from "./util.js";
import { getJSON, postJSON, bindIdentity } from "./api.js";
import { state, loadReviews } from "./state.js";
import { toast } from "./toast.js";
import { renderList } from "./list.js";
import { openDetail } from "./detail.js";
import { initInbox } from "./inboxPanel.js";
import { startInboxWatch, refreshInbox } from "./inboxWatch.js";
import { initReadingPane, closePane } from "./readingPane.js";
import { icon } from "./icons.js";
import type { Assignment, PR } from "./types.js";

interface CanvasPrTarget {
  org: string;
  project: string;
  repoId: string;
  prId: number;
}

function readCanvasTarget(): CanvasPrTarget | null {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("prId")) return null;
  const org = (params.get("org") || "").trim();
  const project = (params.get("project") || "").trim();
  const repoId = (params.get("repoId") || "").trim();
  const prId = Number(params.get("prId"));
  if (!org || !project || !repoId || !Number.isSafeInteger(prId) || prId < 1) {
    throw new Error("Invalid PR target in the canvas URL");
  }
  return { org, project, repoId, prId };
}

async function resolveCanvasTarget(target: CanvasPrTarget): Promise<PR> {
  const query =
    `org=${encodeURIComponent(target.org)}&project=${encodeURIComponent(target.project)}` +
    `&repoId=${encodeURIComponent(target.repoId)}&prId=${target.prId}`;
  const res = await getJSON(`/api/pr-summary?${query}`);
  return res.pr as PR;
}

// ---------- boot ----------
async function boot(): Promise<void> {
  // The desktop shell overlays the caption buttons (wco) and may paint Mica behind the page.
  const shellKind = new URLSearchParams(window.location.search).get("shell");
  if (shellKind) document.documentElement.classList.add("wco");
  if (shellKind === "mica") document.documentElement.classList.add("mica");
  initReadingPane();
  await bindIdentity();
  let target: CanvasPrTarget | null;
  try {
    target = readCanvasTarget();
  } catch (e) {
    return renderError((e as Error).message);
  }
  try {
    state.config = await getJSON("/api/config");
  } catch (e: any) {
    return renderError("Could not read config: " + e.message);
  }
  initInbox();
  startInboxWatch();
  if (target) {
    // Keep the normal list mounted underneath, but resolve/open the requested PR
    // independently so list filters and activity enrichment cannot block routing.
    const listPromise = loadPRs(false, false);
    try {
      await openDetail(await resolveCanvasTarget(target));
    } catch (e) {
      toast("Could not open target PR: " + (e as Error).message, "err");
    }
    await listPromise;
    return;
  }
  if (!state.config.organizations || state.config.organizations.length === 0) {
    return renderSettings();
  }
  await loadPRs();
}

async function loadPRs(refreshActivity = false, stopPolling = true): Promise<void> {
  setPage("queue");
  view.innerHTML = '<div class="loading"><span class="spinner"></span> Loading pull requests…</div>';
  try {
    const [res] = await Promise.all([
      getJSON(`/api/prs${refreshActivity ? "?refresh=1" : ""}`),
      loadReviews(),
    ]);
    state.prs = res.prs || [];
    if (res.errors && res.errors.length) toast(res.errors[0], "err");
    setupFilters();
    renderList(stopPolling);
    if (res.activityPending > 0) void loadCommentActivity();
  } catch (e: any) {
    renderError("Failed to load PRs: " + e.message);
  }
}

// Phase 2 of the PR list: the server checks uncached "I commented" flags in the
// background; merge the settled result in without blocking the first paint.
async function loadCommentActivity(): Promise<void> {
  try {
    const res = await getJSON("/api/pr-activity");
    const commented = new Set(
      (res.commented || []).map((r: any) => JSON.stringify([r.org, r.project, r.repoId, String(r.prId)]))
    );
    let changed = false;
    for (const pr of state.prs) {
      if (!pr.iCommented && commented.has(JSON.stringify([pr.org, pr.project, pr.repoId, String(pr.id)]))) {
        pr.iCommented = true;
        changed = true;
      }
    }
    if (res.errors && res.errors.length) toast(res.errors[0], "err");
    if (changed && !filterbar.hidden) renderList(false);
  } catch (e) {
    toast("Could not load comment activity: " + (e as Error).message, "err");
  }
}

// ---------- filters ----------
function setupFilters(): void {
  filterbar.hidden = false;
  populateOrgFilter();
  populateProjectFilter();
  updateAssignment();
}

function populateOrgFilter(): void {
  const orgs = state.config.organizations;
  orgFilter.innerHTML =
    `<option value="all">All orgs (${state.prs.length})</option>` +
    orgs
      .map(
        (o) =>
          `<option value="${esc(o)}">${esc(o)} (${state.prs.filter((p) => p.org === o).length})</option>`
      )
      .join("");
  orgFilter.value = state.org;
}

// Project options are the distinct projects present in the current org scope —
// covers both configured-project orgs and reviewer-fallback orgs.
function populateProjectFilter(): void {
  const scoped = state.org === "all" ? state.prs : state.prs.filter((p) => p.org === state.org);
  const projects = [...new Set(scoped.map((p) => p.project).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
  if (state.project !== "all" && !projects.includes(state.project)) state.project = "all";
  projectFilter.innerHTML =
    `<option value="all">All projects (${scoped.length})</option>` +
    projects
      .map(
        (pr) =>
          `<option value="${esc(pr)}">${esc(pr)} (${scoped.filter((p) => p.project === pr).length})</option>`
      )
      .join("");
  projectFilter.value = state.project;
  projectFilter.disabled = projects.length === 0;
}

// Refresh the Me / Not me / All queue switch counts + pressed state within the
// current org+project scope.
function updateAssignment(): void {
  let scoped = state.org === "all" ? state.prs : state.prs.filter((p) => p.org === state.org);
  if (state.project !== "all") scoped = scoped.filter((p) => p.project === state.project);
  const mine = scoped.filter((p) => p.mine).length;
  const counts: Record<Assignment, number> = { mine, notmine: scoped.length - mine, all: scoped.length };
  for (const btn of assignFilter.querySelectorAll<HTMLButtonElement>(".seg-btn")) {
    const key = (btn.dataset.assign as Assignment) || "all";
    const label = key === "mine" ? "Me" : key === "notmine" ? "Not me" : "All";
    btn.innerHTML = `${label}<span class="seg-n">${counts[key]}</span>`;
    btn.classList.toggle("active", state.assignment === key);
    btn.setAttribute("aria-pressed", String(state.assignment === key));
  }
}

// Return from settings to the queue (only meaningful once an org is configured).
function showQueue(): void {
  if (!(state.config.organizations || []).length) return;
  setPage("queue");
  filterbar.hidden = false;
  renderList();
}

// ---------- settings ----------
function renderSettings(): void {
  closePane();
  setPage("settings");
  filterbar.hidden = true;
  view.innerHTML = "";
  const wrap = el(`<div class="settings"></div>`);
  wrap.appendChild(
    el(
      `<header class="settings-heading">
         <h1>Settings</h1>
         <p>Azure DevOps scopes and review defaults for this machine.</p>
       </header>`
    )
  );
  const scopes = el(`<section class="settings-group" aria-labelledby="settingsScopes"></section>`);
  scopes.appendChild(el(`<h2 id="settingsScopes">Organizations &amp; projects</h2>`));
  scopes.appendChild(
    el(
      `<div class="desc">Add <b>projects</b> under an org to load <b>all active PRs</b> in those projects; leave projects empty to load only PRs where you're a reviewer. Auth uses your local <code>az</code> login.</div>`
    )
  );

  const orgs = [...(state.config.organizations || [])];
  const projects: Record<string, string[]> = {};
  for (const o of orgs) projects[o] = [...((state.config.projects && state.config.projects[o]) || [])];

  const listEl = el(`<div class="org-list"></div>`);

  function paint(): void {
    listEl.innerHTML = "";
    if (!orgs.length) listEl.appendChild(el(`<div class="empty">No organizations yet.</div>`));
    orgs.forEach((o, i) => {
      const card = el(`<div class="org-card"></div>`);
      const head = el(`<div class="org-row"><span class="name">${esc(o)}</span></div>`);
      const rm = el(
        `<button type="button" class="remove-btn" title="Remove organization" aria-label="Remove organization ${esc(o)}">${icon("dismiss")}</button>`
      );
      rm.addEventListener("click", () => {
        orgs.splice(i, 1);
        delete projects[o];
        paint();
      });
      head.appendChild(rm);
      card.appendChild(head);

      const projWrap = el(`<div class="proj-wrap"></div>`);
      const chips = el(`<div class="proj-chips"></div>`);
      const list = projects[o] || (projects[o] = []);
      if (!list.length) chips.appendChild(el(`<span class="proj-empty">Assigned-to-me only</span>`));
      list.forEach((proj, j) => {
        const chip = el(`<span class="proj-chip">${esc(proj)}</span>`);
        const x = el(
          `<button type="button" class="chip-x" title="Remove project" aria-label="Remove project ${esc(proj)}">${icon("dismiss")}</button>`
        );
        x.addEventListener("click", () => {
          list.splice(j, 1);
          paint();
        });
        chip.appendChild(x);
        chips.appendChild(chip);
      });
      projWrap.appendChild(chips);

      const addRow = el(
        `<div class="proj-add"><input type="text" placeholder="Add project (e.g. Azure AppConfig)" aria-label="Add project to ${esc(o)}" /><button type="button" class="btn sm">Add</button></div>`
      );
      const pin = addRow.querySelector("input") as HTMLInputElement;
      const pbtn = addRow.querySelector("button") as HTMLButtonElement;
      const addProj = () => {
        const v = pin.value.trim();
        if (v && !list.includes(v)) {
          list.push(v);
          paint();
        }
        pin.value = "";
        pin.focus();
      };
      pbtn.addEventListener("click", addProj);
      pin.addEventListener("keydown", (e) => {
        if (e.key === "Enter") addProj();
      });
      projWrap.appendChild(addRow);
      card.appendChild(projWrap);
      listEl.appendChild(card);
    });
  }
  paint();
  scopes.appendChild(listEl);

  const add = el(
    `<div class="org-add">
       <input type="text" placeholder="Add organization (e.g. msazure)" aria-label="Add organization" />
       <button type="button" class="btn">Add org</button>
     </div>`
  );
  const input = add.querySelector("input") as HTMLInputElement;
  const addBtn = add.querySelector("button") as HTMLButtonElement;
  const doAdd = () => {
    const v = input.value.trim();
    if (v && !orgs.includes(v)) {
      orgs.push(v);
      projects[v] = [];
      paint();
    }
    input.value = "";
    input.focus();
  };
  addBtn.addEventListener("click", doAdd);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doAdd();
  });
  scopes.appendChild(add);
  wrap.appendChild(scopes);

  const review = el(`<section class="settings-group" aria-labelledby="settingsReview"></section>`);
  review.appendChild(el(`<h2 id="settingsReview">Copilot review</h2>`));
  wrap.appendChild(review);

  // ---- PR review model selector ----
  let selectedModel = state.config.reviewModel || "";
  const modelCard = settingsCard(
    "sparkle",
    "PR review model",
    "Used for background PR reviews. Auto lets Copilot pick. Discovered live from the Copilot CLI.",
    "settingsModel"
  );
  const modelRow = modelCard.querySelector<HTMLElement>(".settings-card-control")!;
  const modelSelect = el(
    `<select class="filter-select settings-model-select" aria-labelledby="settingsModel"></select>`
  ) as HTMLSelectElement;
  modelSelect.innerHTML = `<option value="">Loading available Copilot models…</option>`;
  modelSelect.disabled = true;
  modelRow.appendChild(modelSelect);
  const refreshModels = el(
    `<button type="button" class="icon-btn" title="Refresh models from Copilot" aria-label="Refresh available Copilot models">${icon("sync")}</button>`
  ) as HTMLButtonElement;
  modelRow.appendChild(refreshModels);
  review.appendChild(modelCard);
  const modelStatus = el(`<div class="settings-model-status" role="status" hidden></div>`);
  review.appendChild(modelStatus);

  // Populate from the same live SDK catalog that backs Copilot's model picker.
  const loadModels = async (refresh = false): Promise<void> => {
    modelSelect.disabled = true;
    refreshModels.disabled = true;
    refreshModels.setAttribute("aria-busy", "true");
    modelStatus.hidden = true;
    try {
      const { models } = await getJSON(`/api/models${refresh ? "?refresh=1" : ""}`);
      if (!Array.isArray(models) || !models.length) throw new Error("Copilot returned no available models");
      const unavailableSelection = selectedModel && !models.includes(selectedModel);
      if (unavailableSelection) selectedModel = "";
      const opts = `<option value="">Auto (let Copilot pick)</option>` +
        (models as string[]).map((m: string) => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
      modelSelect.innerHTML = opts;
      modelSelect.value = selectedModel;
      if (unavailableSelection) {
        modelStatus.textContent = "The previously selected model is no longer available. Auto will be used.";
        modelStatus.classList.add("warn");
        modelStatus.hidden = false;
      }
    } catch (error) {
      selectedModel = "";
      modelSelect.innerHTML = `<option value="">Auto (model catalog unavailable)</option>`;
      modelSelect.value = "";
      modelStatus.textContent = `Could not load Copilot models: ${(error as Error).message}`;
      modelStatus.classList.add("warn");
      modelStatus.hidden = false;
    } finally {
      modelSelect.disabled = false;
      refreshModels.disabled = false;
      refreshModels.removeAttribute("aria-busy");
    }
  };
  void loadModels();
  modelSelect.addEventListener("change", () => { selectedModel = modelSelect.value; });
  refreshModels.addEventListener("click", () => { void loadModels(true); });

  // ---- Reviews markdown folder ----
  let reviewsDir = state.config.reviewsDir || "";
  const dirCard = settingsCard(
    "folder",
    "Reviews folder",
    "Optional. Completed reviews are also saved as Markdown at <code>&lt;folder&gt;/&lt;RepoName&gt;/&lt;prId&gt;-&lt;title&gt;.md</code>, handy for an Obsidian vault. Leave empty to disable; the app's SQLite store stays the source of truth.",
    "settingsFolder",
    true
  );
  const dirInput = el(
    `<input type="text" class="settings-folder-input" aria-labelledby="settingsFolder" placeholder="e.g. C:\\Users\\you\\OneDrive\\PRReviews" />`
  ) as HTMLInputElement;
  dirInput.value = reviewsDir;
  dirInput.addEventListener("input", () => {
    reviewsDir = dirInput.value;
  });
  dirCard.querySelector<HTMLElement>(".settings-card-control")!.appendChild(dirInput);
  review.appendChild(dirCard);

  const actions = el(`<div class="settings-actions"></div>`);
  const save = el(`<button type="button" class="btn accent">Save</button>`) as HTMLButtonElement;
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      state.config = await postJSON("/api/config", { organizations: orgs, projects, reviewModel: selectedModel, reviewsDir: reviewsDir.trim() });
      state.org = "all";
      state.project = "all";
      toast("Saved", "ok");
      await loadPRs();
    } catch (e: any) {
      toast("Save failed: " + e.message, "err");
      save.disabled = false;
    }
  });
  const cancel = el(`<button type="button" class="btn ghost">Cancel</button>`) as HTMLButtonElement;
  cancel.disabled = !(state.config.organizations || []).length;
  cancel.addEventListener("click", showQueue);
  actions.appendChild(cancel);
  actions.appendChild(save);
  wrap.appendChild(actions);

  view.appendChild(wrap);
  view.scrollTop = 0;
}

// A Windows Settings-style card: icon, title + description, and a control slot
// (beside the text, or below it when `stacked` for wide inputs).
function settingsCard(
  name: Parameters<typeof icon>[0],
  title: string,
  descHtml: string,
  titleId: string,
  stacked = false
): HTMLElement {
  return el(
    `<div class="settings-card${stacked ? " stacked" : ""}">` +
      `<span class="settings-card-icon" aria-hidden="true">${icon(name)}</span>` +
      `<div class="settings-card-text"><h3 id="${titleId}">${esc(title)}</h3><p>${descHtml}</p></div>` +
      `<div class="settings-card-control"></div>` +
      `</div>`
  );
}

// ---------- events ----------
$("#btnSettings").addEventListener("click", renderSettings);
$("#btnRefresh").addEventListener("click", () => {
  void refreshInbox();
  if ((state.config.organizations || []).length) loadPRs(true);
  else boot();
});
orgFilter.addEventListener("change", () => {
  state.org = orgFilter.value;
  state.project = "all";
  populateProjectFilter();
  updateAssignment();
  renderList();
});
projectFilter.addEventListener("change", () => {
  state.project = projectFilter.value;
  updateAssignment();
  renderList();
});
assignFilter.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".seg-btn") as HTMLElement | null;
  if (!btn) return;
  state.assignment = (btn.dataset.assign as Assignment) || "all";
  updateAssignment();
  renderList();
});
window.addEventListener("ado-pr-updated", () => {
  if (document.body.dataset.page !== "settings") renderList(false);
});
// Opening a PR (e.g. from the inbox) while on settings returns to the queue.
window.addEventListener("ado-pr-open", (e) => {
  if ((e as CustomEvent).detail && document.body.dataset.page === "settings") showQueue();
});

boot();
