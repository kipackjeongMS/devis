// Entry module: boot sequence, PR loading, org filter, settings screen, and the
// top-level event wiring. This is the only module with module-eval side effects
// (the final boot() call), so import order stays free of runtime cycles.
import {
  $,
  view,
  el,
  renderError,
  setPage,
} from "./dom.js";
import { esc } from "./util.js";
import { getJSON, postJSON, bindIdentity } from "./api.js";
import { state, loadReviews } from "./state.js";
import { toast } from "./toast.js";
import { openDetail } from "./detail.js";
import { initInbox } from "./inboxPanel.js";
import { startInboxWatch, refreshInbox } from "./inboxWatch.js";
import { initReadingPane, closePane, setSoloPane } from "./readingPane.js";
import { initUiZoom } from "./uiZoom.js";
import { showPipelines, hidePipelines, reloadPipelines, showChainById } from "./pipelines.js";
import { showJarvis, hideJarvis, reloadJarvis, resumeNoteDraft, openTaskById } from "./jarvis.js";
import { preferWorker } from "./jarvisTask.js";
import { jarvisSettings } from "./settingsJarvis.js";
import { setupCard } from "./settingsSetup.js";
import { updatesCard } from "./settingsUpdates.js";
import { azureProblem, initSetupActions } from "./setupActions.js";
import { needsFirstRun, showFirstRun } from "./firstRun.js";
import { icon } from "./icons.js";
import { showAgencyBanner, showAzureBanner, hideAzureBanner } from "./staleBanner.js";
import { applyShellClasses } from "./shell.js";
import { loadPrRecency, prIdentity } from "./prRecency.js";
import { announcePrUpdated, onPrUpdatedElsewhere } from "./prWindow.js";
import { addScope, removeScope, scopeChips } from "./prScopes.js";
import type { PR } from "./types.js";

interface CopilotRuntimeInfo {
  via: "agency" | "bundled" | "copilot" | null;
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
  initUiZoom();
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
  if (target) return bootPrWindow(target);
  initSetupActions();
  // A new install sets up before anything else loads; the service decides that once, when it first starts.
  if (await needsFirstRun()) return showFirstRun(state.config);
  initInbox();
  startInboxWatch();
  void checkCopilotRuntime();
  // A quick-note edit the last page didn't get to save goes in now, not only once the Workspace opens.
  resumeNoteDraft();
  if (!state.config.organizations || state.config.organizations.length === 0) {
    return renderSettings();
  }
  showFeature(currentFeature());
  await loadPRs();
}

/**
 * The PR window: one PR's full detail page, alone. The window is re-targeted by loading a new URL
 * (src/pr-window.mts), so each page serves exactly one PR and nothing from the last one can reach this one.
 * The Workspace owns the inbox, the background watchers and the list; this page leaves them to it.
 */
async function bootPrWindow(target: CanvasPrTarget): Promise<void> {
  document.body.dataset.feature = "pr";
  setSoloPane(true);
  window.addEventListener("ado-pr-open", (e) => {
    const pr = (e as CustomEvent<PR | null>).detail;
    if (pr) document.title = `#${pr.id} ${pr.title} · Devis`;
  });
  // Anything done to the PR here (a vote, completing, a comment) refreshes the Workspace's panel.
  window.addEventListener("ado-pr-updated", announcePrUpdated);
  void loadReviews();
  try {
    await openDetail(await resolveCanvasTarget(target));
  } catch (e) {
    renderError("Could not open pull request #" + target.prId + ": " + (e as Error).message);
  }
}

let prsLoad = 0;

/** An Azure sign-in problem in a PR load gets the banner with its fix; a clean load clears it. True when it showed. */
function noteAzure(errors: string[], answered: boolean): boolean {
  const problem = azureProblem(errors);
  if (problem) showAzureBanner(problem === "missing", () => void loadPRs());
  else if (answered && !errors.length) hideAzureBanner();
  return !!problem;
}

/** Load the PR list into state for the Workspace's panel, which paints from it on `ado-prs-loaded`. */
async function loadPRs(refreshActivity = false): Promise<void> {
  const load = ++prsLoad;
  const refreshBtn = $("#btnRefresh");
  refreshBtn.setAttribute("aria-busy", "true");
  const reviews = loadReviews();
  const live = getJSON(`/api/prs${refreshActivity ? "?refresh=1" : ""}`);
  let settled = false;
  if (!state.prs.length) {
    // First paint: the list from the last time ADO answered, until the live one lands.
    void Promise.all([getJSON("/api/prs?cached=1"), reviews])
      .then(([snapshot]) => {
        if (settled || load !== prsLoad || !snapshot?.prs?.length) return;
        state.prs = snapshot.prs;
        window.dispatchEvent(new CustomEvent("ado-prs-loaded"));
      })
      .catch(() => undefined);
  }
  try {
    const [res] = await Promise.all([live, reviews]);
    settled = true;
    if (load !== prsLoad) return;
    const azure = noteAzure(res.errors || [], true);
    if (!res.prs?.length && res.errors?.length) {
      throw new Error(res.errors.join("\n"));
    }
    state.prs = res.prs || [];
    state.authoredPrs = res.authored || [];
    state.cappedProjects = res.capped || [];
    // Older pages stay loaded across a refresh, minus any that moved onto the first page.
    const listed = new Set(state.prs.map((pr) => prIdentity(pr)));
    state.olderPrs = state.olderPrs.filter((pr) => !listed.has(prIdentity(pr)));
    if (res.errors && res.errors.length && !azure) toast(res.errors[0], "err");
    window.dispatchEvent(new CustomEvent("ado-prs-loaded"));
    if (res.activityPending > 0) void loadCommentActivity();
    // Last push and my last comment or vote, read in the background (/api/pr-recency).
    if (res.recencyPending > 0) loadPrRecency();
  } catch (e: any) {
    settled = true;
    if (load !== prsLoad) return;
    // The panel keeps what it has and says so itself; a first load with nothing yet shows the error there.
    if (!noteAzure([e.message], false)) toast("Failed to load PRs: " + e.message, "err");
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
    if (changed) window.dispatchEvent(new CustomEvent("ado-prs-loaded"));
  } catch (e) {
    toast("Could not load comment activity: " + (e as Error).message, "err");
  }
}

// Return from settings to the page that was under it (only meaningful once an org is configured).
function leaveSettings(): void {
  if (!(state.config.organizations || []).length) return;
  setPage("queue");
  showFeature(currentFeature());
}

// ---------- features ----------
type Feature = "pipelines" | "jarvis";
const asFeature = (value: string | undefined): Feature => (value === "pipelines" ? "pipelines" : "jarvis");
const currentFeature = (): Feature => asFeature(document.body.dataset.feature);
const FEATURE_TEXT: Record<Feature, { skip: string; skipLabel: string; refresh: string }> = {
  pipelines: { skip: "#pipelinesView", skipLabel: "Skip to pipelines", refresh: "Refresh pipelines" },
  jarvis: { skip: "#jarvisView", skipLabel: "Skip to the Workspace", refresh: "Refresh the Workspace" },
};

function setFeature(feature: Feature): void {
  const was = currentFeature();
  if (was === "pipelines" && feature !== "pipelines") hidePipelines();
  if (was === "jarvis" && feature !== "jarvis") hideJarvis();
  showFeature(feature);
}

/** Put a feature on screen: its tab, its labels, its view. Settings gives way to it. */
function showFeature(feature: Feature): void {
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
  if (document.body.dataset.page === "settings") setPage("queue");
  if (feature === "pipelines") showPipelines({ openSettings: renderSettings });
  else showJarvis({ openSettings: renderSettings });
}

// ---------- settings ----------
function renderSettings(): void {
  closePane();
  setPage("settings");
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
  const setup = el(`<section class="settings-group" aria-labelledby="settingsSetupGroup"></section>`);
  setup.appendChild(el(`<h2 id="settingsSetupGroup">Setup</h2>`));
  setup.appendChild(setupCard(settingsCard));
  wrap.appendChild(setup);
  const updatesGroup = el(`<section class="settings-group" aria-labelledby="settingsUpdatesGroup"></section>`);
  updatesGroup.appendChild(el(`<h2 id="settingsUpdatesGroup">Updates</h2>`));
  updatesGroup.appendChild(updatesCard(settingsCard));
  wrap.appendChild(updatesGroup);
  const scopes = el(`<section class="settings-group" aria-labelledby="settingsScopes"></section>`);
  scopes.appendChild(el(`<h2 id="settingsScopes">Organizations &amp; projects</h2>`));
  scopes.appendChild(
    el(
      `<div class="desc">Add <b>projects</b> under an org to       load <b>all active PRs</b> in those projects; leave projects empty to load only PRs where you're a reviewer. For a busy project, add <code>Project/Repo</code> to load only that repo's PRs. Auth uses your local <code>az</code> login.</div>`
    )
  );

  const orgs = [...(state.config.organizations || [])];
  const projects: Record<string, string[]> = {};
        const repos: Record<string, Record<string, string[]>> = {};
        for (const o of orgs) {
          projects[o] = [...((state.config.projects && state.config.projects[o]) || [])];
          repos[o] = {};
          for (const [p, list] of Object.entries(state.config.repos?.[o] || {})) repos[o][p] = [...list];
        }

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
        delete repos[o];
        paint();
      });
      head.appendChild(rm);
      card.appendChild(head);

      const projWrap = el(`<div class="proj-wrap"></div>`);
      const chips = el(`<div class="proj-chips"></div>`);
      const list = projects[o] || (projects[o] = []);
      const picked = repos[o] || (repos[o] = {});
      if (!list.length) chips.appendChild(el(`<span class="proj-empty">Assigned-to-me only</span>`));
      scopeChips(list, picked).forEach((c) => {
        const label = c.repo ? `${c.project} / ${c.repo}` : c.project;
        const what = c.repo ? "repo" : "project";
        const chip = el(
          `<span class="proj-chip" title="${c.repo ? "Only this repo's PRs" : "All PRs in this project"}">${esc(label)}</span>`
        );
        const x = el(
          `<button type="button" class="chip-x" title="Remove ${what}" aria-label="Remove ${what} ${esc(label)}">${icon("dismiss")}</button>`
        );
        x.addEventListener("click", () => {
          removeScope(list, picked, c);
          paint();
        });
        chip.appendChild(x);
        chips.appendChild(chip);
      });
      projWrap.appendChild(chips);

      const addRow = el(
        `<div class="proj-add"><input type="text" placeholder="Add project or Project/Repo" aria-label="Add project or Project/Repo to ${esc(o)}" /><button type="button" class="btn sm">Add</button></div>`
      );
      const pin = addRow.querySelector("input") as HTMLInputElement;
      const pbtn = addRow.querySelector("button") as HTMLButtonElement;
      const addProj = () => {
        const changed = addScope(list, picked, pin.value);
        pin.value = "";
        if (changed) {
          paint();
          (listEl.querySelectorAll(".proj-add input")[i] as HTMLInputElement | undefined)?.focus();
        } else pin.focus();
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
      repos[v] = {};
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
        repos,
        reviewModel: selectedModel,
        reviewsDir: reviewsDir.trim(),
        ...jarvis.values(),
      });
      void jarvis.saved();
      state.org = "all";
      state.project = "all";
      toast("Saved", "ok");
      leaveSettings();
      await loadPRs();
      void reloadPipelines();
    } catch (e: any) {
      toast("Save failed: " + e.message, "err");
      save.disabled = false;
    }
  });
  const cancel = el(`<button type="button" class="btn ghost">Cancel</button>`) as HTMLButtonElement;
  cancel.disabled = !(state.config.organizations || []).length;
  cancel.addEventListener("click", leaveSettings);
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
  else if (!onSettings) {
    // The Workspace's Pull Requests panel reads the PR list, so refresh both.
    void reloadJarvis();
    if ((state.config.organizations || []).length) void loadPRs(true);
  } else if ((state.config.organizations || []).length) void loadPRs(true);
  else boot();
});
$(".feature-nav").addEventListener("click", (e) => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>(".feature-tab");
  if (!tab) return;
  const feature = asFeature(tab.dataset.feature);
  if (feature !== currentFeature() || document.body.dataset.page === "settings") setFeature(feature);
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
// A PR changed in the PR window: the panel's list follows. The PR window hears its own broadcasts
// and has no list, so it ignores them; a burst of changes (a vote, then a refresh) reads the list once.
let prUpdatedTimer: ReturnType<typeof setTimeout> | undefined;
onPrUpdatedElsewhere(() => {
  if (document.body.dataset.feature === "pr") return;
  clearTimeout(prUpdatedTimer);
  prUpdatedTimer = setTimeout(() => {
    if ((state.config.organizations || []).length) void loadPRs(false);
  }, 250);
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
