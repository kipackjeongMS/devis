// Entry module: boot sequence, PR loading, org filter, settings screen, and the
// top-level event wiring. This is the only module with module-eval side effects
// (the final boot() call), so import order stays free of runtime cycles.
import { $, view, filterbar, orgFilter, projectFilter, assignFilter, el, renderError } from "./dom.js";
import { esc } from "./util.js";
import { getJSON, postJSON } from "./api.js";
import { state, loadReviews } from "./state.js";
import { toast } from "./toast.js";
import { renderList } from "./list.js";
import { renderRollouts } from "./rollouts.js";
import type { Assignment } from "./types.js";

// ---------- boot ----------
async function boot(): Promise<void> {
  try {
    state.config = await getJSON("/api/config");
  } catch (e: any) {
    return renderError("Could not read config: " + e.message);
  }
  if (!state.config.organizations || state.config.organizations.length === 0) {
    return renderSettings();
  }
  await loadPRs();
}

async function loadPRs(): Promise<void> {
  view.innerHTML = '<div class="loading"><span class="spinner"></span> Loading pull requests…</div>';
  try {
    const [res] = await Promise.all([getJSON("/api/prs"), loadReviews()]);
    state.prs = res.prs || [];
    if (res.errors && res.errors.length) toast(res.errors[0], "err");
    setupFilters();
    renderList();
  } catch (e: any) {
    renderError("Failed to load PRs: " + e.message);
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

// Refresh the Me / Not me / All segmented control counts + active state within
// the current org+project scope.
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
  }
}

// ---------- settings ----------
function renderSettings(): void {
  filterbar.hidden = true;
  view.innerHTML = "";
  const wrap = el(`<div class="settings"></div>`);
  wrap.appendChild(el(`<h2>Organizations &amp; projects</h2>`));
  wrap.appendChild(
    el(
      `<div class="desc">Azure DevOps organizations to pull PRs from. Add <b>projects</b> under an org to load <b>all active PRs</b> in those projects; leave projects empty to load only PRs where you're a reviewer. Auth uses your local <code>az</code> login.</div>`
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
      const rm = el(`<button class="remove-btn" title="Remove org">✕</button>`);
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
        const x = el(`<button class="chip-x" title="Remove project">✕</button>`);
        x.addEventListener("click", () => {
          list.splice(j, 1);
          paint();
        });
        chip.appendChild(x);
        chips.appendChild(chip);
      });
      projWrap.appendChild(chips);

      const addRow = el(
        `<div class="proj-add"><input type="text" placeholder="Add project (e.g. Azure AppConfig)" /><button class="btn sm">Add</button></div>`
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
  wrap.appendChild(listEl);

  const add = el(
    `<div class="org-add">
       <input type="text" placeholder="Add organization (e.g. msazure)" />
       <button class="btn">Add org</button>
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
  wrap.appendChild(add);

  const actions = el(`<div class="org-add" style="justify-content:flex-end"></div>`);
  const save = el(`<button class="btn">Save</button>`) as HTMLButtonElement;
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      state.config = await postJSON("/api/config", { organizations: orgs, projects });
      state.org = "all";
      state.project = "all";
      toast("Saved", "ok");
      await loadPRs();
    } catch (e: any) {
      toast("Save failed: " + e.message, "err");
      save.disabled = false;
    }
  });
  const cancel = el(`<button class="btn ghost">Cancel</button>`);
  cancel.addEventListener("click", () => {
    if ((state.config.organizations || []).length) {
      filterbar.hidden = false;
      renderList();
    }
  });
  actions.appendChild(cancel);
  actions.appendChild(save);
  wrap.appendChild(actions);

  view.appendChild(wrap);
}

// ---------- top-level view switch (Pull requests <-> Rollouts) ----------
type ViewName = "prs" | "rollouts";
let currentView: ViewName = "prs";

function setView(v: ViewName): void {
  currentView = v;
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".nav-btn")) {
    btn.classList.toggle("active", btn.dataset.view === v);
  }
  const settingsBtn = $("#btnSettings") as HTMLButtonElement;
  if (v === "rollouts") {
    filterbar.hidden = true;
    settingsBtn.style.display = "none";
    renderRollouts();
  } else {
    settingsBtn.style.display = "";
    if ((state.config.organizations || []).length) {
      filterbar.hidden = false;
      renderList();
    } else {
      renderSettings();
    }
  }
}

// ---------- events ----------
$("#btnSettings").addEventListener("click", renderSettings);
$("#btnRefresh").addEventListener("click", () => {
  if (currentView === "rollouts") return void renderRollouts();
  if ((state.config.organizations || []).length) loadPRs();
  else boot();
});
for (const btn of document.querySelectorAll<HTMLButtonElement>(".nav-btn")) {
  btn.addEventListener("click", () => setView((btn.dataset.view as ViewName) || "prs"));
}
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

boot();
