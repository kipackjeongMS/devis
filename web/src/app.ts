// Entry module: boot sequence, PR loading, org filter, settings screen, and the
// top-level event wiring. This is the only module with module-eval side effects
// (the final boot() call), so import order stays free of runtime cycles.
import {
  $,
  view,
  filterbar,
  orgFilter,
  projectFilter,
  queueTabs,
  queueSearch,
  scopeFields,
  listPane,
  el,
  renderError,
  setPage,
} from "./dom.js";
import { esc, timeAgo } from "./util.js";
import { getJSON, postJSON, bindIdentity } from "./api.js";
import { state, loadReviews } from "./state.js";
import { toast } from "./toast.js";
import { renderList, setQueueView } from "./list.js";
import { openDetail } from "./detail.js";
import { initInbox } from "./inboxPanel.js";
import { startInboxWatch, refreshInbox } from "./inboxWatch.js";
import { initReadingPane, closePane } from "./readingPane.js";
import { showPipelines, hidePipelines, reloadPipelines, showChainById } from "./pipelines.js";
import { showJarvis, hideJarvis, reloadJarvis, resumeNoteDraft, openTaskById } from "./jarvis.js";
import { preferWorker } from "./jarvisTask.js";
import { jarvisSettings } from "./settingsJarvis.js";
import { icon } from "./icons.js";
import { showAgencyBanner } from "./staleBanner.js";
import { applyShellClasses } from "./shell.js";
import { loadPrRecency, prIdentity } from "./prRecency.js";
import type { PR } from "./types.js";

interface CopilotRuntimeInfo {
  via: "agency" | "copilot" | null;
  command: string | null;
  warning: string | null;
}

/** How Copilot runs, read once per page. */
let runtimeInfo: Promise<CopilotRuntimeInfo | null> | null = null;
function copilotRuntime(): Promise<CopilotRuntimeInfo | null> {
  runtimeInfo ??= getJSON("/api/copilot/runtime").catch(() => {
    runtimeInfo = null;
    return null;
  });
  return runtimeInfo;
}

/** Copilot running without Agency is worth a notice that stays until dismissed. */
async function checkCopilotRuntime(): Promise<void> {
  const info = await copilotRuntime();
  if (info?.warning) showAgencyBanner(info.warning);
}

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
  applyShellClasses(new URLSearchParams(window.location.search));
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
  void checkCopilotRuntime();
  // A quick-note edit the last page didn't get to save goes in now, not only once the Workspace opens.
  resumeNoteDraft();
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

let prsLoad = 0;
/** When the list on screen was current: the last live load, or the snapshot's time. */
let listAsOf: number | null = null;
const listNotice = $("#listNotice");

/** Say plainly when the list on screen couldn't be refreshed, with a retry; null clears it. */
function noteStaleList(error: string | null): void {
  if (error === null || listAsOf === null) {
    listNotice.hidden = true;
    listNotice.replaceChildren();
    return;
  }
  const text = el(
    `<span class="list-notice-text">Couldn't reach Azure DevOps, so this list is from ${esc(timeAgo(new Date(listAsOf).toISOString()))}. ${esc(error)}</span>`
  );
  const retry = el(`<button type="button" class="btn sm ghost">Retry</button>`);
  retry.addEventListener("click", () => void loadPRs(true));
  listNotice.replaceChildren(text, retry);
  listNotice.hidden = false;
}

async function loadPRs(refreshActivity = false, stopPolling = true): Promise<void> {
  const load = ++prsLoad;
  // A refresh keeps the queue on screen (scroll, focus, open row) and swaps the rows in place when ADO answers.
  const keepList = document.body.dataset.page === "queue" && !filterbar.hidden && state.prs.length > 0;
  setPage("queue");
  const refreshBtn = $("#btnRefresh");
  refreshBtn.setAttribute("aria-busy", "true");
  if (!keepList) {
    noteStaleList(null);
    view.innerHTML = '<div class="loading"><span class="spinner"></span> Loading pull requests…</div>';
  }
  const reviews = loadReviews();
  const live = getJSON(`/api/prs${refreshActivity ? "?refresh=1" : ""}`);
  let settled = false;
  let showingSnapshot = false;
  if (!keepList && !state.prs.length) {
    // First paint: the list from the last time ADO answered, until the live one lands.
    void Promise.all([getJSON("/api/prs?cached=1"), reviews])
      .then(([snapshot]) => {
        if (settled || load !== prsLoad || !snapshot?.prs?.length) return;
        showingSnapshot = true;
        listAsOf = Date.parse(snapshot.at) || null;
        state.prs = snapshot.prs;
        setupFilters();
        renderList(stopPolling);
        window.dispatchEvent(new CustomEvent("ado-prs-loaded"));
      })
      .catch(() => undefined);
  }
  try {
    const [res] = await Promise.all([live, reviews]);
    settled = true;
    if (load !== prsLoad) return;
    if (!res.prs?.length && res.errors?.length) {
      throw new Error(res.errors.join("\n"));
    }
    state.prs = res.prs || [];
    state.authoredPrs = res.authored || [];
    state.cappedProjects = res.capped || [];
    // Older pages stay loaded across a refresh, minus any that moved onto the first page.
    const listed = new Set(state.prs.map((pr) => prIdentity(pr)));
    state.olderPrs = state.olderPrs.filter((pr) => !listed.has(prIdentity(pr)));
    listAsOf = Date.now();
    noteStaleList(null);
    if (res.errors && res.errors.length) toast(res.errors[0], "err");
    setupFilters();
    renderList(stopPolling);
    window.dispatchEvent(new CustomEvent("ado-prs-loaded"));
    if (res.activityPending > 0) void loadCommentActivity();
    // Last push and my last comment or vote, read in the background (/api/pr-recency).
    if (res.recencyPending > 0) loadPrRecency();
  } catch (e: any) {
    settled = true;
    if (load !== prsLoad) return;
    if (keepList || showingSnapshot) noteStaleList(e.message);
    else renderError("Failed to load PRs: " + e.message);
    window.dispatchEvent(new CustomEvent("ado-prs-loaded"));
  } finally {
    if (load === prsLoad) refreshBtn.removeAttribute("aria-busy");
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
}

// A scope picker with a single choice is noise: hide it, and the row when both are.
// Narrow windows fold the pickers behind #scopeToggle; its dot marks a narrowed scope.
function syncScopeFields(): void {
  const fields = [orgFilter, projectFilter].map((select) => select.closest<HTMLElement>(".filter-field")!);
  scopeFields.hidden = fields.every((field) => field.hidden);
  const toggle = $<HTMLButtonElement>("#scopeToggle");
  toggle.hidden = scopeFields.hidden;
  toggle.classList.toggle("is-scoped", state.org !== "all" || state.project !== "all");
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
  orgFilter.closest<HTMLElement>(".filter-field")!.hidden = orgs.length <= 1 && state.org === "all";
  syncScopeFields();
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
  projectFilter.closest<HTMLElement>(".filter-field")!.hidden = projects.length <= 1 && state.project === "all";
  syncScopeFields();
}

// Return from settings to the queue (only meaningful once an org is configured).
function showQueue(): void {
  if (!(state.config.organizations || []).length) return;
  setPage("queue");
  filterbar.hidden = false;
  view.scrollTop = 0;
  renderList();
}

// ---------- features ----------
type Feature = "prs" | "pipelines" | "jarvis";
const asFeature = (value: string | undefined): Feature =>
  value === "pipelines" || value === "jarvis" ? value : "prs";
const currentFeature = (): Feature => asFeature(document.body.dataset.feature);
const FEATURE_TEXT: Record<Feature, { skip: string; skipLabel: string; refresh: string }> = {
  prs: { skip: "#view", skipLabel: "Skip to pull requests", refresh: "Refresh pull requests" },
  pipelines: { skip: "#pipelinesView", skipLabel: "Skip to pipelines", refresh: "Refresh pipelines" },
  jarvis: { skip: "#jarvisView", skipLabel: "Skip to the Workspace", refresh: "Refresh the Workspace" },
};

function setFeature(feature: Feature): void {
  const was = currentFeature();
  document.body.dataset.feature = feature;
  for (const tab of document.querySelectorAll<HTMLElement>(".feature-tab")) {
    const on = tab.dataset.feature === feature;
    tab.classList.toggle("active", on);
    if (on) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  const text = FEATURE_TEXT[feature];
  const skip = $<HTMLAnchorElement>("#skipLink");
  skip.href = text.skip;
  skip.textContent = text.skipLabel;
  const refresh = $("#btnRefresh");
  refresh.title = text.refresh;
  refresh.setAttribute("aria-label", text.refresh);
  const onSettings = document.body.dataset.page === "settings";
  const hasOrgs = (state.config.organizations || []).length > 0;
  if (was === "pipelines" && feature !== "pipelines") hidePipelines();
  if (was === "jarvis" && feature !== "jarvis") hideJarvis();
  if (feature === "pipelines" || feature === "jarvis") {
    if (onSettings) {
      if (hasOrgs) showQueue();
      else setPage("queue");
    }
    if (feature === "pipelines") showPipelines({ openSettings: renderSettings });
    else showJarvis({ openSettings: renderSettings });
  } else {
    if (onSettings || !hasOrgs) {
      if (hasOrgs) showQueue();
      else renderSettings();
    }
  }
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
         <p>Azure DevOps scopes, review defaults and the Workspace for this machine.</p>
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

  // ---- how Copilot runs ----
  const runtimeCard = settingsCard("terminal", "Copilot runtime", "Checking…", "settingsRuntime");
  const runtimeText = runtimeCard.querySelector<HTMLElement>(".settings-card-text p")!;
  review.appendChild(runtimeCard);
  void copilotRuntime().then((info) => {
    if (!info) runtimeText.textContent = "Couldn't tell how Copilot runs.";
    else if (info.warning) runtimeText.textContent = info.warning;
    else
      runtimeText.innerHTML = `Every Copilot session runs through Agency, with all of its MCP servers on: <code>${esc(info.command || "")} copilot</code>`;
  });

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

  // ---- Jarvis: task folders and the codebase ----
  const jarvis = jarvisSettings(state.config, () => [...orgs], settingsCard);
  wrap.appendChild(jarvis.section);

  const actions = el(`<div class="settings-actions"></div>`);
  const save = el(`<button type="button" class="btn accent">Save</button>`) as HTMLButtonElement;
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      state.config = await postJSON("/api/config", {
        organizations: orgs,
        projects,
        reviewModel: selectedModel,
        reviewsDir: reviewsDir.trim(),
        ...jarvis.values(),
      });
      void jarvis.saved();
      state.org = "all";
      state.project = "all";
      toast("Saved", "ok");
      await loadPRs();
      void reloadPipelines();
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
// The Workspace's Pull Requests panel asks for a fresh list without leaving the Workspace.
window.addEventListener("ado-prs-refresh", () => {
  if ((state.config.organizations || []).length) void loadPRs(true);
  else window.dispatchEvent(new CustomEvent("ado-prs-loaded"));
});
$("#btnSettings").addEventListener("click", renderSettings);
$("#btnRefresh").addEventListener("click", () => {
  void refreshInbox();
  const onSettings = document.body.dataset.page === "settings";
  if (currentFeature() === "pipelines" && !onSettings) void reloadPipelines(true);
  else if (currentFeature() === "jarvis" && !onSettings) {
    // Today's review section reads the PR list, so refresh both.
    void reloadJarvis();
    if ((state.config.organizations || []).length) void loadPRs(true);
  } else if ((state.config.organizations || []).length) loadPRs(true);
  else boot();
});
$(".feature-nav").addEventListener("click", (e) => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>(".feature-tab");
  if (!tab) return;
  const feature = asFeature(tab.dataset.feature);
  if (feature !== currentFeature() || document.body.dataset.page === "settings") setFeature(feature);
});
orgFilter.addEventListener("change", () => {
  state.org = orgFilter.value;
  state.project = "all";
  populateProjectFilter();
  renderList();
});
projectFilter.addEventListener("change", () => {
  state.project = projectFilter.value;
  syncScopeFields();
  renderList();
});
$("#scopeToggle").addEventListener("click", () => {
  const open = filterbar.classList.toggle("scope-open");
  $("#scopeToggle").setAttribute("aria-expanded", String(open));
});
// Phone-width bottom tab bar: each button forwards to the title bar control it mirrors,
// so feature switching stays in one place. aria-current follows the body's page/feature.
function initTabbar(): void {
  const bar = $("nav.tabbar");
  bar.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".tabbar-btn");
    if (!btn) return;
    if (btn.dataset.action === "settings") $<HTMLButtonElement>("#btnSettings").click();
    else $<HTMLButtonElement>(`.feature-tab[data-feature="${asFeature(btn.dataset.feature)}"]`).click();
  });
  const sync = (): void => {
    const onSettings = document.body.dataset.page === "settings";
    const feature = currentFeature();
    for (const btn of bar.querySelectorAll<HTMLElement>(".tabbar-btn")) {
      const on = btn.dataset.action === "settings" ? onSettings : !onSettings && btn.dataset.feature === feature;
      if (on) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    }
  };
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ["data-feature", "data-page"] });
  sync();
}
initTabbar();
queueTabs.addEventListener("click", (e) => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>("[data-view]");
  if (tab) setQueueView(tab.dataset.view === "all" ? "all" : "feed");
});
// Rebuilding the queue costs tens of ms with a few hundred rows, so typing waits
// for a short pause instead of re-rendering on every keystroke.
const SEARCH_DEBOUNCE_MS = 120;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
function cancelSearchRender(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = null;
}
queueSearch.addEventListener("input", () => {
  state.query = queueSearch.value;
  cancelSearchRender();
  searchTimer = setTimeout(() => {
    searchTimer = null;
    renderList(false);
  }, SEARCH_DEBOUNCE_MS);
});
// Esc clears the search, then a second Esc leaves the field. Consuming the event
// keeps the reading pane open underneath.
queueSearch.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  e.preventDefault();
  if (!queueSearch.value) {
    queueSearch.blur();
    return;
  }
  queueSearch.value = "";
  state.query = "";
  cancelSearchRender();
  renderList(false);
});
// Ctrl+F finds in the queue, matching the pipeline catalog's search shortcut.
window.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  if (e.key.toLowerCase() !== "f" || currentFeature() !== "prs") return;
  if (document.body.dataset.page === "settings" || filterbar.hidden || listPane.inert) return;
  if (document.querySelector(".ask-overlay")) return;
  e.preventDefault();
  queueSearch.focus();
  queueSearch.select();
});
window.addEventListener("ado-pr-updated", () => {
  if (document.body.dataset.page !== "settings" && !filterbar.hidden) renderList(false);
});
// Opening a PR (e.g. from the inbox or Jarvis) returns to the Pull requests feature and its queue.
window.addEventListener("ado-pr-open", (e) => {
  if (!(e as CustomEvent).detail) return;
  if (currentFeature() !== "prs") setFeature("prs");
  else if (document.body.dataset.page === "settings") showQueue();
});
// A task's validation chain, opened from the task: Pipelines shows it once its chains load.
window.addEventListener("ado-open-chain", (e) => {
  const id = (e as CustomEvent).detail?.chainId;
  if (typeof id !== "string" || !id) return;
  showChainById(id);
  setFeature("pipelines");
});
// …and back: a task chain's banner opens its task in the Workspace.
window.addEventListener("ado-open-task", (e) => {
  const detail = (e as CustomEvent).detail;
  if (typeof detail?.taskId !== "string") return;
  setFeature("jarvis");
  openTaskById(detail.taskId, detail.tab);
});
// A worker's code window asks to continue in that worker's chat ("Open in chat" on a sent batch).
if (typeof BroadcastChannel === "function") {
  new BroadcastChannel("devis-code").addEventListener("message", (e: MessageEvent) => {
    const d = e.data;
    if (d?.type !== "open-worker" || typeof d.taskId !== "string" || typeof d.sessionId !== "string") return;
    preferWorker(d.taskId, d.sessionId);
    setFeature("jarvis");
    openTaskById(d.taskId);
    window.focus();
  });
}

boot();
