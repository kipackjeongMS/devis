// Settings' Jarvis workspace section: the folder new tasks get their own folder
// in, and the codebase, the repositories Jarvis workers can work in. Repos are
// picked from Azure DevOps live (organization, then project, then its repos);
// the app clones each once under the Jarvis folder, and each worker gets its
// own git worktree of the ones its task needs.

import { getJSON, postJSON } from "./api.js";
import { el } from "./dom.js";
import { esc } from "./util.js";
import { icon } from "./icons.js";
import { teamsCard } from "./settingsTeams.js";
import type { CodebaseRepo, Config } from "./types.js";

type CardFactory = (name: Parameters<typeof icon>[0], title: string, descHtml: string, titleId: string, stacked?: boolean) => HTMLElement;

interface CodebaseEntry extends CodebaseRepo {
  key: string;
  path: string;
  state: "ready" | "cloning" | "missing" | "error";
  error: string | null;
}

interface RepoInfo {
  name: string;
  defaultBranch: string | null;
  size: number;
  disabled: boolean;
}

export interface JarvisSettings {
  section: HTMLElement;
  /** What Save writes to the config. */
  values(): { codebase: CodebaseRepo[]; taskRoot: string };
  /** After Save: clone what's new, and show it cloning. */
  saved(): Promise<void>;
}

const keyOf = (r: CodebaseRepo): string => `${r.org}/${r.project}/${r.repo}`;
const same = (a: CodebaseRepo, b: CodebaseRepo): boolean => keyOf(a).toLowerCase() === keyOf(b).toLowerCase();

const STATE_TEXT: Record<CodebaseEntry["state"], string> = {
  ready: "Cloned",
  cloning: "Cloning…",
  missing: "Not cloned yet",
  error: "Clone failed",
};

/** A repo's size from Azure DevOps, which reports bytes. */
function sizeText(bytes: number): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : mb >= 1 ? `${Math.round(mb)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The section, wired up. `orgs` reads the organizations as edited on the page. */
export function jarvisSettings(config: Config, orgs: () => string[], card: CardFactory): JarvisSettings {
  const section = el(`<section class="settings-group" aria-labelledby="settingsJarvis"></section>`);
  section.appendChild(el(`<h2 id="settingsJarvis">Workspace</h2>`));

  // ---- task folders ----
  let taskRoot = config.taskRoot || "";
  const rootCard = card(
    "folder",
    "Task folders",
    "Each new task gets its own folder here, named after its title in lowercase with dashes for spaces, like <code>some-work-needed</code>. Each of its workers works in a folder inside it, with a git worktree of every repository it needs. You can pick another folder when you add a task.",
    "settingsTaskRoot",
    true
  );
  const rootInput = el(
    `<input type="text" class="settings-folder-input" aria-labelledby="settingsTaskRoot" placeholder="e.g. C:\\work\\tasks" />`
  ) as HTMLInputElement;
  rootInput.value = taskRoot;
  rootInput.addEventListener("input", () => (taskRoot = rootInput.value));
  rootCard.querySelector<HTMLElement>(".settings-card-control")!.appendChild(rootInput);
  section.appendChild(rootCard);

  // ---- the codebase ----
  const codebase: CodebaseRepo[] = (config.codebase || []).map((r) => ({ ...r }));
  const status = new Map<string, CodebaseEntry>();
  let cloneDir = "";
  const cbCard = card(
    "branch",
    "Codebase",
    "Repositories your workers can work in. Pick an organization and a project to list its repositories. On Save the app clones each new one once, in the app's data folder; workers never clone, they get worktrees of these.",
    "settingsCodebase",
    true
  );
  const control = cbCard.querySelector<HTMLElement>(".settings-card-control")!;
  control.classList.add("cb");
  control.innerHTML = `
    <div class="cb-pick">
      <select class="filter-select cb-org" aria-label="Organization"></select>
      <select class="filter-select cb-project" aria-label="Project" disabled><option value="">Project</option></select>
      <button type="button" class="icon-btn cb-reload" title="Read the list again from Azure DevOps" aria-label="Reload repositories" disabled>${icon("sync")}</button>
    </div>
    <div class="cb-browse" hidden>
      <input type="search" class="settings-folder-input cb-filter" placeholder="Filter repositories" aria-label="Filter repositories" />
      <div class="cb-repos" role="group" aria-label="Repositories in the project"></div>
      <div class="cb-browse-actions">
        <span class="cb-picked"></span>
        <button type="button" class="btn sm cb-add" disabled>Add to codebase</button>
      </div>
    </div>
    <p class="cb-msg" role="status" hidden></p>
    <ul class="cb-list" aria-label="Codebase repositories"></ul>
    <p class="cb-where"></p>`;
  section.appendChild(cbCard);

  const q = <T extends HTMLElement>(sel: string): T => control.querySelector<T>(sel)!;
  const orgSelect = q<HTMLSelectElement>(".cb-org");
  const projectSelect = q<HTMLSelectElement>(".cb-project");
  const reload = q<HTMLButtonElement>(".cb-reload");
  const browse = q<HTMLElement>(".cb-browse");
  const filter = q<HTMLInputElement>(".cb-filter");
  const repoBox = q<HTMLElement>(".cb-repos");
  const picked = q<HTMLElement>(".cb-picked");
  const add = q<HTMLButtonElement>(".cb-add");
  const msg = q<HTMLElement>(".cb-msg");
  const list = q<HTMLUListElement>(".cb-list");
  const where = q<HTMLElement>(".cb-where");

  let listed: RepoInfo[] = [];
  /** Repos checked in the list, kept while the filter hides some. */
  const selection = new Set<string>();
  let token = 0;

  const say = (text: string, warn = false): void => {
    msg.textContent = text;
    msg.classList.toggle("warn", warn);
    msg.hidden = !text;
  };

  const fillOrgs = (): void => {
    const current = orgSelect.value;
    const names = orgs();
    orgSelect.innerHTML =
      `<option value="">Organization</option>` + names.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("");
    if (names.includes(current)) orgSelect.value = current;
  };
  fillOrgs();
  // Organizations added above since the page opened show up too.
  orgSelect.addEventListener("focus", fillOrgs);
  orgSelect.addEventListener("mousedown", fillOrgs);

  const loadProjects = async (): Promise<void> => {
    const org = orgSelect.value;
    const mine = ++token;
    browse.hidden = true;
    reload.disabled = true;
    projectSelect.disabled = true;
    projectSelect.innerHTML = `<option value="">${org ? "Loading projects…" : "Project"}</option>`;
    say("");
    if (!org) return;
    try {
      const { projects } = await getJSON(`/api/jarvis/ado/projects?org=${encodeURIComponent(org)}`);
      if (mine !== token) return;
      projectSelect.innerHTML =
        `<option value="">Project</option>` + (projects as string[]).map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
      projectSelect.disabled = false;
      // The project from Settings' scopes, when there's exactly one, is the likely pick.
      const scoped = (config.projects?.[org] || []).filter((p) => (projects as string[]).includes(p));
      if (scoped.length === 1) {
        projectSelect.value = scoped[0];
        void loadRepos();
      }
    } catch (e) {
      if (mine !== token) return;
      projectSelect.innerHTML = `<option value="">Project</option>`;
      projectSelect.disabled = false;
      say(`Couldn't read ${org}'s projects: ${(e as Error).message}`, true);
    }
  };

  const loadRepos = async (): Promise<void> => {
    const org = orgSelect.value;
    const project = projectSelect.value;
    const mine = ++token;
    browse.hidden = true;
    reload.disabled = !project;
    say("");
    if (!org || !project) return;
    say("Loading repositories…");
    try {
      const { repos } = await getJSON(`/api/jarvis/ado/repos?org=${encodeURIComponent(org)}&project=${encodeURIComponent(project)}`);
      if (mine !== token) return;
      listed = (repos as RepoInfo[]).filter((r) => !r.disabled);
      say(listed.length ? "" : `${project} has no repositories you can see.`);
      filter.value = "";
      selection.clear();
      paintRepos();
      browse.hidden = !listed.length;
    } catch (e) {
      if (mine !== token) return;
      say(`Couldn't read ${project}'s repositories: ${(e as Error).message}`, true);
    }
  };

  const paintRepos = (): void => {
    const org = orgSelect.value;
    const project = projectSelect.value;
    const term = filter.value.trim().toLowerCase();
    repoBox.innerHTML = listed
      .filter((r) => !term || r.name.toLowerCase().includes(term))
      .map((r) => {
        const have = codebase.some((c) => same(c, { org, project, repo: r.name }));
        const meta = [r.defaultBranch, sizeText(r.size)].filter(Boolean).join(" · ");
        return `<label class="cb-repo${have ? " have" : ""}"><input type="checkbox" value="${esc(r.name)}"${have || selection.has(r.name) ? " checked" : ""}${
          have ? " disabled" : ""
        }><span class="cb-repo-name">${esc(r.name)}</span><span class="cb-repo-meta">${esc(have ? "In the codebase" : meta)}</span></label>`;
      })
      .join("") || `<p class="cb-none">No repository matches.</p>`;
    countPicked();
  };

  const countPicked = (): void => {
    const n = selection.size;
    picked.textContent = n ? `${n} selected` : "";
    add.disabled = !n;
  };

  const paintList = (): void => {
    if (!codebase.length) {
      list.innerHTML = `<li class="cb-empty">No repositories yet. Workers can't get worktrees until you add some.</li>`;
    } else {
      list.innerHTML = codebase
        .map((r, i) => {
          const entry = status.get(keyOf(r).toLowerCase());
          const state = entry ? entry.state : null;
          const text = state ? STATE_TEXT[state] : "Clones on Save";
          const title = entry?.error || entry?.path || "";
          return `<li class="cb-item">
            <span class="cb-item-name">${esc(r.repo)}</span>
            <span class="cb-item-where">${esc(`${r.org} / ${r.project}`)}</span>
            <span class="cb-state${state ? ` is-${state}` : ""}" title="${esc(title)}">${state === "cloning" ? '<span class="spinner"></span>' : ""}${esc(text)}</span>
            <button type="button" class="remove-btn" data-cb-remove="${i}" title="Remove from the codebase" aria-label="Remove ${esc(r.repo)}">${icon("dismiss")}</button>
          </li>`;
        })
        .join("");
    }
    where.innerHTML = cloneDir ? `Clones go in <code>${esc(cloneDir)}</code>. Removing a repository here leaves its clone on disk.` : "";
  };

  let poll: ReturnType<typeof setTimeout> | null = null;
  const loadStatus = async (): Promise<void> => {
    try {
      const res: { repos: CodebaseEntry[]; dir: string } = await getJSON("/api/jarvis/codebase");
      status.clear();
      for (const e of res.repos) status.set(e.key.toLowerCase(), e);
      cloneDir = res.dir;
    } catch {
      /* the list still shows the repos */
    }
    if (!section.isConnected) return;
    paintList();
    if (poll) clearTimeout(poll);
    // Keep watching while a clone is under way.
    if ([...status.values()].some((e) => e.state === "cloning")) poll = setTimeout(() => void loadStatus(), 3_000);
  };

  orgSelect.addEventListener("change", () => void loadProjects());
  projectSelect.addEventListener("change", () => void loadRepos());
  reload.addEventListener("click", () => void loadRepos());
  filter.addEventListener("input", paintRepos);
  repoBox.addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    if (input.type !== "checkbox" || input.disabled) return;
    if (input.checked) selection.add(input.value);
    else selection.delete(input.value);
    countPicked();
  });
  add.addEventListener("click", () => {
    const org = orgSelect.value;
    const project = projectSelect.value;
    for (const name of selection) {
      const repo = { org, project, repo: name };
      if (!codebase.some((c) => same(c, repo))) codebase.push(repo);
    }
    selection.clear();
    codebase.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
    paintRepos();
    paintList();
  });
  list.addEventListener("click", (e) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>("[data-cb-remove]");
    if (!button) return;
    codebase.splice(Number(button.dataset.cbRemove), 1);
    paintList();
    if (!browse.hidden) paintRepos();
  });

  paintList();
  void loadStatus();
  section.appendChild(teamsCard(card));

  return {
    section,
    values: () => ({ codebase: codebase.map((r) => ({ ...r })), taskRoot: taskRoot.trim() }),
    saved: async () => {
      try {
        const res: { repos: CodebaseEntry[]; dir: string } = await postJSON("/api/jarvis/codebase/sync", {});
        status.clear();
        for (const e of res.repos) status.set(e.key.toLowerCase(), e);
        cloneDir = res.dir;
      } catch {
        /* status says what's cloned on the next look */
      }
      await loadStatus();
    },
  };
}
