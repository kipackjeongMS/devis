// First run: three steps the first time Devis opens on a machine, before anything else loads.
//   1. Sign in & tools: the machine's checks, each gap with its Install or Sign in button.
//      Continue unlocks once Azure DevOps answers, since pull requests and reviews need it.
//   2. Azure DevOps: the organizations your profile belongs to, and projects to narrow each one.
//   3. Your Workspace: the task folder, starting with Windows, and the Teams catch-up.
// Open Devis saves it all, marks setup done (setup.json) and reloads into the app, restarting
// first when Agency was installed so Copilot switches to it. "Set up later" skips to the app;
// the same checks stay in Settings › Setup. Installs that predate this never see it.

import { getJSON, postJSON } from "./api.js";
import { esc } from "./util.js";
import { icon } from "./icons.js";
import { setupChecker, type SetupCheck } from "./settingsSetup.js";
import { inDesktopShell, pickFolder, restartDevis, saveSetupState, setupJob } from "./setupActions.js";
import type { Config } from "./types.js";

const STEP_KEY = "devis.firstRun.step";
const PILLS_SHOWN = 12;

const STEPS = [
  { title: "Sign in and check the tools", lead: "Devis brings Copilot and Git with it, installs what's missing, and needs you to sign in." },
  { title: "Which pull requests should Devis watch?", lead: "These are the organizations your Azure DevOps profile belongs to. Pick projects to see all of their active PRs, or leave them empty for only the PRs that name you." },
  { title: "Set up your Workspace", lead: "Where tasks keep their files, and how Devis runs. Repos for workers can wait until a task needs them." },
] as const;
const RAIL = ["Sign in & tools", "Azure DevOps", "Your Workspace"];

interface OrgPick {
  org: string;
  on: boolean;
  projects: Set<string>;
  /** Its projects once read; null until asked for. */
  all: string[] | null;
  read: "idle" | "reading" | "ready" | "failed";
  readError: string;
  expanded: boolean;
  filter: string;
}

export async function needsFirstRun(): Promise<boolean> {
  try {
    const s: { done: boolean } = await getJSON("/api/setup/state");
    return s.done === false;
  } catch {
    return false;
  }
}

export function showFirstRun(config: Config): void {
  document.body.classList.add("first-run-on");
  const root = document.createElement("div");
  root.className = "first-run";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "frTitle");
  root.innerHTML = `
    <nav class="fr-rail" aria-label="Setup steps">
      <div class="fr-brand"><span class="fr-core" aria-hidden="true"></span>Devis</div>
      <ol class="fr-steps">${RAIL.map((r, i) => `<li class="fr-step" data-step="${i}"><b>${i + 1}</b><span>${esc(r)}</span></li>`).join("")}</ol>
      <p class="fr-tiny">You can change all of this later in Settings.</p>
    </nav>
    <section class="fr-main">
      <h1 id="frTitle"></h1>
      <p class="fr-lead"></p>
      <div class="fr-body"></div>
      <p class="fr-problem" role="alert" hidden></p>
      <footer class="fr-foot">
        <button type="button" class="btn ghost" data-fr="back">Back</button>
        <button type="button" class="btn ghost fr-later" data-fr="later">Set up later</button>
        <span class="fr-hint" role="status"></span>
        <button type="button" class="btn accent" data-fr="next">Continue</button>
      </footer>
    </section>`;
  document.body.appendChild(root);

  const title = root.querySelector<HTMLElement>("#frTitle")!;
  const lead = root.querySelector<HTMLElement>(".fr-lead")!;
  const body = root.querySelector<HTMLElement>(".fr-body")!;
  const problem = root.querySelector<HTMLElement>(".fr-problem")!;
  const back = root.querySelector<HTMLButtonElement>("[data-fr='back']")!;
  const later = root.querySelector<HTMLButtonElement>("[data-fr='later']")!;
  const next = root.querySelector<HTMLButtonElement>("[data-fr='next']")!;
  const hint = root.querySelector<HTMLElement>(".fr-hint")!;

  // ---- what the steps collect ----
  const picks = new Map<string, OrgPick>();
  const newPick = (org: string, on: boolean, projects: string[] = []): OrgPick => ({
    org,
    on,
    projects: new Set(projects),
    all: null,
    read: "idle",
    readError: "",
    expanded: false,
    filter: "",
  });
  for (const org of config.organizations || []) picks.set(org.toLowerCase(), newPick(org, true, config.projects?.[org]));
  let orgsRead: Promise<void> | null = null;
  let orgsError = "";
  let taskRoot = config.taskRoot || "";
  let startAtSignIn = true;
  let catchUp = true;
  let azureReady = false;

  let step = Math.min(Math.max(Number(localStorage.getItem(STEP_KEY)) || 0, 0), STEPS.length - 1);

  const say = (msg: string): void => {
    problem.textContent = msg;
    problem.hidden = !msg;
  };

  function go(to: number): void {
    step = to;
    localStorage.setItem(STEP_KEY, String(step));
    say("");
    for (const li of root.querySelectorAll<HTMLElement>(".fr-step")) {
      const i = Number(li.dataset.step);
      li.classList.toggle("on", i === step);
      li.classList.toggle("done", i < step);
      if (i === step) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
      li.querySelector("b")!.innerHTML = i < step ? icon("check") : String(i + 1);
    }
    title.textContent = STEPS[step].title;
    lead.textContent = STEPS[step].lead;
    back.hidden = step === 0;
    later.hidden = step !== 0;
    next.textContent = step === STEPS.length - 1 ? "Open Devis" : "Continue";
    body.innerHTML = "";
    if (step === 0) toolsStep();
    else if (step === 1) orgsStep();
    else workspaceStep();
    body.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true });
  }

  // ---- 1. sign in & tools ----
  function toolsStep(): void {
    body.innerHTML = `
      <ul class="setup-list fr-checks" aria-label="This machine"><li class="setup-wait"><span class="spinner"></span>Checking this machine…</li></ul>
      <button type="button" class="btn sm ghost fr-recheck">${icon("sync")}<span>Check again</span></button>`;
    const list = body.querySelector<HTMLElement>(".fr-checks")!;
    const recheck = body.querySelector<HTMLButtonElement>(".fr-recheck")!;
    const paintGate = (): void => {
      next.disabled = !azureReady;
      hint.textContent = azureReady ? "" : "Continue unlocks once you're signed in to Azure DevOps.";
    };
    const check = setupChecker(list, (checks: SetupCheck[] | null) => {
      if (step !== 0) return;
      azureReady = !!checks?.some((c) => c.id === "azure" && c.status === "ok");
      paintGate();
    });
    recheck.addEventListener("click", async () => {
      recheck.disabled = true;
      await check();
      recheck.disabled = false;
    });
    paintGate();
    void check();
  }

  // ---- 2. azure devops ----
  function readOrgs(): Promise<void> {
    orgsRead ??= (async () => {
      try {
        const res: { orgs: string[]; error?: string } = await getJSON("/api/setup/orgs");
        orgsError = res.error || "";
        for (const org of res.orgs) if (!picks.has(org.toLowerCase())) picks.set(org.toLowerCase(), newPick(org, false));
      } catch (e) {
        orgsError = (e as Error).message;
      }
    })();
    return orgsRead;
  }

  function readProjects(p: OrgPick, repaint: () => void): void {
    if (p.read === "reading" || p.read === "ready") return;
    p.read = "reading";
    void getJSON(`/api/jarvis/ado/projects?org=${encodeURIComponent(p.org)}`)
      .then((res: { projects: string[] }) => {
        p.all = res.projects || [];
        p.read = "ready";
      })
      .catch((e: Error) => {
        p.readError = e.message || "Couldn't read its projects.";
        p.read = "failed";
      })
      .finally(repaint);
  }

  function orgsStep(): void {
    body.innerHTML = `<div class="fr-orgs" aria-busy="true"><p class="setup-wait"><span class="spinner"></span>Reading your organizations…</p></div>
      <div class="fr-add"><input type="text" class="settings-folder-input" id="frAddOrg" placeholder="Another organization, e.g. contoso" aria-label="Add an organization by name" /><button type="button" class="btn sm" data-fr="add-org">${icon("add")}<span>Add</span></button></div>`;
    const wrap = body.querySelector<HTMLElement>(".fr-orgs")!;
    const addInput = body.querySelector<HTMLInputElement>("#frAddOrg")!;
    const addBtn = body.querySelector<HTMLButtonElement>("[data-fr='add-org']")!;

    const paintGate = (): void => {
      const any = [...picks.values()].some((p) => p.on);
      next.disabled = !any;
      hint.textContent = any ? "" : "Pick at least one organization.";
    };

    const pillsHtml = (p: OrgPick): string => {
      if (!p.on) return "";
      if (p.read === "reading" && !p.projects.size) return `<p class="fr-pj-note"><span class="spinner"></span>Reading its projects…</p>`;
      if (p.read === "failed" && !p.projects.size) return `<p class="fr-pj-note err">Couldn't read its projects: ${esc(p.readError)}</p>`;
      const names = [...new Set([...p.projects, ...(p.all || [])])];
      if (!names.length) return p.read === "ready" ? `<p class="fr-pj-note">No projects you can see here.</p>` : "";
      const q = p.filter.trim().toLowerCase();
      const matching = q ? names.filter((n) => n.toLowerCase().includes(q)) : names;
      // Picked ones first, so they never hide behind "more".
      matching.sort((a, b) => Number(p.projects.has(b)) - Number(p.projects.has(a)));
      const shown = p.expanded ? matching : matching.slice(0, PILLS_SHOWN);
      const more = matching.length - shown.length;
      const filter = p.expanded && names.length > PILLS_SHOWN ? `<input type="search" class="settings-folder-input fr-pj-filter" data-org="${esc(p.org)}" placeholder="Filter projects" aria-label="Filter ${esc(p.org)}'s projects" value="${esc(p.filter)}" />` : "";
      return `${filter}<div class="fr-pills" role="group" aria-label="${esc(p.org)}'s projects">${shown
        .map((n) => `<button type="button" class="fr-pill${p.projects.has(n) ? " on" : ""}" aria-pressed="${p.projects.has(n)}" data-org="${esc(p.org)}" data-project="${esc(n)}">${esc(n)}</button>`)
        .join("")}${more > 0 ? `<button type="button" class="fr-pill more" data-org="${esc(p.org)}" data-more>+ ${more} more</button>` : ""}</div>`;
    };

    const scopeLabel = (p: OrgPick): string => {
      if (!p.on) return "";
      const n = p.projects.size;
      if (!n) return "PRs that name you";
      return p.all?.length ? `${n} of ${p.all.length} projects` : `${n} project${n === 1 ? "" : "s"}`;
    };

    const paint = (): void => {
      if (step !== 1) return;
      const focused = document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains("fr-pj-filter") ? document.activeElement.dataset.org : null;
      const list = [...picks.values()].sort((a, b) => Number(b.on) - Number(a.on) || a.org.localeCompare(b.org, undefined, { sensitivity: "base" }));
      wrap.removeAttribute("aria-busy");
      wrap.innerHTML =
        (orgsError ? `<p class="fr-pj-note err">Couldn't list your organizations: ${esc(orgsError)} Add one by name below.</p>` : "") +
        (list.length
          ? list
              .map(
                (p) => `<div class="fr-org${p.on ? " on" : ""}">
                  <label class="fr-org-h"><input type="checkbox" data-org="${esc(p.org)}"${p.on ? " checked" : ""} /><b>${esc(p.org)}</b><span class="fr-scope">${esc(scopeLabel(p))}</span></label>
                  ${pillsHtml(p)}
                </div>`
              )
              .join("")
          : `<p class="fr-pj-note">Your profile doesn't list any organizations. Add one by name below.</p>`);
      if (focused) {
        const input = wrap.querySelector<HTMLInputElement>(`.fr-pj-filter[data-org="${CSS.escape(focused)}"]`);
        if (input) {
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }
      }
      paintGate();
    };

    wrap.addEventListener("change", (e) => {
      const box = e.target as HTMLInputElement;
      if (box.type !== "checkbox") return;
      const p = picks.get((box.dataset.org || "").toLowerCase());
      if (!p) return;
      p.on = box.checked;
      if (p.on) readProjects(p, paint);
      paint();
    });
    wrap.addEventListener("click", (e) => {
      const pill = (e.target as HTMLElement).closest<HTMLButtonElement>(".fr-pill");
      if (!pill) return;
      const p = picks.get((pill.dataset.org || "").toLowerCase());
      if (!p) return;
      if (pill.hasAttribute("data-more")) p.expanded = true;
      else {
        const name = pill.dataset.project!;
        if (p.projects.has(name)) p.projects.delete(name);
        else p.projects.add(name);
      }
      paint();
    });
    wrap.addEventListener("input", (e) => {
      const input = e.target as HTMLInputElement;
      if (!input.classList.contains("fr-pj-filter")) return;
      const p = picks.get((input.dataset.org || "").toLowerCase());
      if (!p) return;
      p.filter = input.value;
      paint();
    });
    const add = (): void => {
      // "https://dev.azure.com/contoso/..." or "contoso.visualstudio.com" pasted whole reads as the org.
      const raw = addInput.value.trim();
      const org = (/dev\.azure\.com\/([^/\s]+)/i.exec(raw)?.[1] || /^([^./\s]+)\.visualstudio\.com/i.exec(raw)?.[1] || raw).trim();
      if (!org || /[\s/\\]/.test(org)) return say("Type the organization's name, like contoso.");
      say("");
      const key = org.toLowerCase();
      const p = picks.get(key) || newPick(org, true);
      p.on = true;
      picks.set(key, p);
      addInput.value = "";
      readProjects(p, paint);
      paint();
    };
    addBtn.addEventListener("click", add);
    addInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") add();
    });

    paintGate();
    void readOrgs().then(() => {
      for (const p of picks.values()) if (p.on) readProjects(p, paint);
      paint();
    });
  }

  // ---- 3. your workspace ----
  function workspaceStep(): void {
    const browse = inDesktopShell() ? `<button type="button" class="btn sm ghost" data-fr="browse">${icon("folder")}<span>Browse</span></button>` : "";
    body.innerHTML = `
      <div class="fr-field">
        <label for="frTaskRoot">Task folder</label>
        <div class="fr-input-row"><input type="text" id="frTaskRoot" class="settings-folder-input" placeholder="e.g. C:\\work\\tasks" />${browse}</div>
        <p class="fr-note">Each task gets a folder in here. Leave it empty to pick one for each task.</p>
      </div>
      <label class="fr-toggle"><input type="checkbox" role="switch" class="param-switch" data-fr="startup" /><span><b>Start Devis when I sign in to Windows</b><span>Its background service runs without a window, so scheduled catch-ups are done before you open Devis.</span></span></label>
      <label class="fr-toggle"><input type="checkbox" role="switch" class="param-switch" data-fr="catchup" /><span><b>Catch me up on Teams</b><span>Chat summaries, meeting recaps and PR review asks since the last scan.${agencyNote()}</span></span></label>`;
    const root = body.querySelector<HTMLInputElement>("#frTaskRoot")!;
    const startup = body.querySelector<HTMLInputElement>("[data-fr='startup']")!;
    const teams = body.querySelector<HTMLInputElement>("[data-fr='catchup']")!;
    root.value = taskRoot;
    startup.checked = startAtSignIn;
    teams.checked = catchUp;
    root.addEventListener("input", () => (taskRoot = root.value));
    startup.addEventListener("change", () => (startAtSignIn = startup.checked));
    teams.addEventListener("change", () => (catchUp = teams.checked));
    body.querySelector<HTMLButtonElement>("[data-fr='browse']")?.addEventListener("click", async () => {
      const picked = await pickFolder();
      if (picked) {
        root.value = taskRoot = picked;
        root.focus();
      }
    });
    next.disabled = false;
    hint.textContent = "";
  }

  function agencyNote(): string {
    const job = setupJob("agency-install");
    if (job?.state === "done") return "";
    return job?.state === "running" ? " It starts once Agency finishes installing." : " Needs Agency, from step 1.";
  }

  // ---- finishing ----
  async function finish(): Promise<void> {
    next.disabled = back.disabled = true;
    next.textContent = "Opening…";
    say("");
    try {
      const organizations = [...picks.values()].filter((p) => p.on).map((p) => p.org);
      const projects: Record<string, string[]> = {};
      for (const p of picks.values()) if (p.on && p.projects.size) projects[p.org] = [...p.projects];
      // writeConfig resets what a save leaves out, so the rest of the config goes back as it was.
      await postJSON("/api/config", { ...config, organizations, projects, taskRoot: taskRoot.trim() });
      if (catchUp) {
        for (const source of ["teams", "chats", "meetings"]) {
          await postJSON("/api/jarvis/comms/enabled", { enabled: true, source }).catch((e: Error) => console.warn(`[setup] catch-up ${source}: ${e.message}`));
        }
      }
      await saveSetupState({ done: true, startAtSignIn });
    } catch (e) {
      say(`Couldn't save that: ${(e as Error).message}`);
      next.disabled = back.disabled = false;
      next.textContent = "Open Devis";
      return;
    }
    localStorage.removeItem(STEP_KEY);
    // Copilot switches to a freshly installed Agency when the service starts again; the shell reloads onto the new one.
    // A browser tab has no shell to start it again, so it reloads and Settings says to restart.
    const agency = setupJob("agency-install");
    if (agency?.state === "done" && agency.restart && inDesktopShell() && !(await restartDevis())) return;
    location.reload();
  }

  async function skip(): Promise<void> {
    later.disabled = true;
    try {
      await saveSetupState({ done: true });
    } catch (e) {
      later.disabled = false;
      return say(`Couldn't skip setup: ${(e as Error).message}`);
    }
    localStorage.removeItem(STEP_KEY);
    location.reload();
  }

  next.addEventListener("click", () => {
    if (next.disabled) return;
    if (step < STEPS.length - 1) go(step + 1);
    else void finish();
  });
  back.addEventListener("click", () => step > 0 && go(step - 1));
  later.addEventListener("click", () => void skip());

  go(step);
}
