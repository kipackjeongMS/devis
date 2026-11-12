// The setup buttons, wherever they are: Settings › Setup, the first-run window, the Agency hints,
// the Azure sign-in banner and Get the source. A button is `[data-setup-action]` and its status line
// `[data-setup-status]`; one click handler starts the job, and while any job runs one poll repaints
// every button and status line for it, so two buttons for the same thing always agree.
//
// The desktop shell does what a page can't: pick a folder, and add Devis to Windows' startup.
// The page asks by opening a URL the shell catches (see shell-request.mts).

import { getJSON, postJSON, type ApiError } from "./api.js";
import { esc } from "./util.js";

export type SetupActionId = "azure-install" | "azure-signin" | "copilot-signin" | "github-signin" | "agency-install" | "devis-source";

export interface SetupJob {
  id: string;
  action: SetupActionId;
  state: "running" | "done" | "failed";
  progress: number | null;
  message: string;
  startedAt: string;
  endedAt?: string;
  restart?: boolean;
  path?: string;
}

export interface SetupStateView {
  done: boolean;
  startAtSignIn: boolean;
}

type Listener = (job: SetupJob, before: SetupJob | undefined) => void;

/** A finished job this old no longer shows on its button. */
const SHOWN_MS = 10 * 60_000;
const LOCAL = "local-";

const jobs = new Map<SetupActionId, SetupJob>();
const listeners = new Set<Listener>();
let poll: ReturnType<typeof setTimeout> | null = null;
let ticking = false;

const RUNNING_LABEL: Record<SetupActionId, string> = {
  "azure-install": "Installing…",
  "agency-install": "Installing…",
  "azure-signin": "Signing in…",
  "copilot-signin": "Signing in…",
  "github-signin": "Signing in…",
  "devis-source": "Getting it…",
};

/** The desktop shell (not a browser tab), which can pick folders and restart the service. */
export const inDesktopShell = (): boolean => document.documentElement.classList.contains("wco");

/** Whether these errors from Azure DevOps mean the Azure CLI is signed out, or isn't there at all (src/azauth.mts). */
export function azureProblem(errors: string[]): "missing" | "signin" | null {
  const text = errors.join("\n");
  if (/Azure CLI isn't installed/i.test(text)) return "missing";
  if (/az token (failed|timed out)|AADSTS\d+|run [`'"]?az login/i.test(text)) return "signin";
  return null;
}

/** The latest job for `action`, unless it finished a while ago. */
export function setupJob(action: SetupActionId): SetupJob | null {
  const job = jobs.get(action);
  if (!job) return null;
  if (job.state !== "running" && job.endedAt && Date.now() - Date.parse(job.endedAt) > SHOWN_MS) return null;
  return job;
}

/** Hear about every change to a job. Returns the unsubscribe. */
export function onSetupJob(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function store(job: SetupJob): void {
  const before = jobs.get(job.action);
  jobs.set(job.action, job);
  const same = before && before.id === job.id && before.state === job.state && before.message === job.message && before.progress === job.progress;
  if (same) return;
  for (const fn of [...listeners]) {
    try {
      fn(job, before);
    } catch (e) {
      console.warn("[setup] listener failed", e);
    }
  }
}

const anyRunning = (): boolean => [...jobs.values()].some((j) => j.state === "running");

function schedule(ms: number): void {
  if (poll || ticking) return;
  poll = setTimeout(() => void tick(), ms);
}

async function tick(): Promise<void> {
  poll = null;
  ticking = true;
  let res: { jobs: SetupJob[] } | null = null;
  try {
    res = await getJSON("/api/setup/jobs");
  } catch {
    // The service may be restarting; keep trying while something runs.
  } finally {
    ticking = false;
  }
  if (res) {
    const actions = new Set(res.jobs.map((j) => j.action));
    for (const j of res.jobs) {
      // A job just asked for: the service's earlier, finished one for the same thing isn't news.
      if (jobs.get(j.action)?.id.startsWith(LOCAL) && j.state !== "running") continue;
      store(j);
    }
    // A job the service no longer knows about went with the service that ran it.
    for (const j of [...jobs.values()]) {
      if (j.state === "running" && !j.id.startsWith(LOCAL) && !actions.has(j.action)) {
        store({ ...j, state: "failed", progress: null, message: "Devis restarted before it finished. Try again.", endedAt: new Date().toISOString() });
      }
    }
    paintSetupActions();
  }
  if (anyRunning()) schedule(res ? 1000 : 3000);
}

/** What the service has run since it started, so a reloaded page still shows how it went. */
export async function loadSetupJobs(): Promise<void> {
  try {
    const res: { jobs: SetupJob[] } = await getJSON("/api/setup/jobs");
    for (const j of res.jobs) store(j);
  } catch {
    return;
  }
  paintSetupActions();
  if (anyRunning()) schedule(1000);
}

/** Start `action` (or join the one running) and follow it until it ends. */
export async function runSetupAction(action: SetupActionId, input: { folder?: string } = {}): Promise<void> {
  const current = jobs.get(action);
  if (current?.state === "running") return;
  const placeholder: SetupJob = { id: `${LOCAL}${action}`, action, state: "running", progress: null, message: "Starting…", startedAt: new Date().toISOString() };
  store(placeholder);
  paintSetupActions();
  try {
    store(await postJSON(`/api/setup/actions/${action}`, input, { timeoutMs: 30_000 }));
  } catch (e) {
    store({ ...placeholder, state: "failed", message: (e as Error).message || String(e), endedAt: new Date().toISOString() });
  }
  paintSetupActions();
  if (anyRunning()) schedule(1000);
}

/** Ask the service to stop once it's idle; the desktop shell starts a fresh one and reloads. Returns why it can't, or null. */
export async function restartDevis(): Promise<string | null> {
  try {
    await postJSON("/api/service/stop", { whenIdle: true }, { timeoutMs: 15_000 });
  } catch (e) {
    const err = e as ApiError;
    if (err.status === 409) {
      const work = ((err.data?.work || []) as { label?: string }[]).map((w) => w.label).filter(Boolean);
      return work.length ? `Devis is busy with ${work.join(", ")}. Restart it once that's done.` : "Devis is busy. Restart it once that's done.";
    }
    return err.message || String(e);
  }
  return inDesktopShell() ? null : "Devis stopped. Open it again from the Start menu.";
}

// ---- the desktop shell's part -----------------------------------------------------------

/** Ask the shell to bring Windows' startup in line with setup.json. A browser tab can't, and doesn't need to. */
export function syncLoginItem(): void {
  if (inDesktopShell()) window.open("/?shell-request=login-item", "_blank");
}

/** The shell's folder picker. Null when it's cancelled, or outside the shell. */
export function pickFolder(): Promise<string | null> {
  if (!inDesktopShell()) return Promise.resolve(null);
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const done = (e: Event): void => {
      const detail = (e as CustomEvent<{ id: string; path: string | null }>).detail;
      if (detail?.id !== id) return;
      window.removeEventListener("devis:folder-picked", done);
      resolve(detail.path || null);
    };
    window.addEventListener("devis:folder-picked", done);
    window.open(`/?shell-request=pick-folder&id=${encodeURIComponent(id)}`, "_blank");
  });
}

export async function readSetupState(): Promise<SetupStateView> {
  return getJSON("/api/setup/state");
}

export async function saveSetupState(patch: Partial<SetupStateView>): Promise<SetupStateView> {
  const next: SetupStateView = await postJSON("/api/setup/state", patch);
  syncLoginItem();
  return next;
}

// ---- buttons and status lines ----------------------------------------------------------

interface ActionView {
  label: string;
  disabled: boolean;
  hidden: boolean;
  restart: boolean;
  message: string;
  tone: "" | "ok" | "err";
  progress: number | null | undefined;
}

function viewOf(action: SetupActionId, label: string): ActionView {
  const job = setupJob(action);
  if (!job) return { label, disabled: false, hidden: false, restart: false, message: "", tone: "", progress: undefined };
  if (job.state === "running") return { label: RUNNING_LABEL[action], disabled: true, hidden: false, restart: false, message: job.message, tone: "", progress: job.progress };
  if (job.state === "failed") return { label: "Try again", disabled: false, hidden: false, restart: false, message: job.message, tone: "err", progress: undefined };
  if (job.restart) return { label: "Restart Devis", disabled: false, hidden: false, restart: true, message: job.message, tone: "ok", progress: undefined };
  return { label, disabled: false, hidden: true, restart: false, message: job.message, tone: "ok", progress: undefined };
}

/** A button that runs `action`. `inputId` names an input whose value goes along as the folder. */
export function setupActionHtml(action: SetupActionId, label: string, opts: { tone?: "accent" | "ghost"; inputId?: string } = {}): string {
  const v = viewOf(action, label);
  const tone = opts.tone ? ` ${opts.tone}` : "";
  const input = opts.inputId ? ` data-setup-input="${esc(opts.inputId)}"` : "";
  return `<button type="button" class="btn sm${tone} setup-act" data-setup-action="${action}" data-label="${esc(label)}"${input}${v.restart ? " data-setup-restart" : ""}${v.disabled ? " disabled" : ""}${v.hidden ? " hidden" : ""}>${esc(v.label)}</button>`;
}

/** The line under it: what the job is doing, how far along, or how it ended. */
export function setupStatusHtml(action: SetupActionId): string {
  return `<div class="setup-act-status" data-setup-status="${action}" role="status" aria-live="polite">${statusInner(viewOf(action, ""))}</div>`;
}

function statusInner(v: ActionView): string {
  if (!v.message) return "";
  const bar =
    v.progress === undefined
      ? ""
      : `<span class="setup-bar${v.progress === null ? " indeterminate" : ""}" aria-hidden="true"><i style="width:${Math.round((v.progress ?? 0) * 100)}%"></i></span>`;
  return `<span class="setup-act-msg${v.tone ? ` tone-${v.tone}` : ""}">${esc(v.message)}</span>${bar}`;
}

/** Bring every setup button and status line under `root` up to date. */
export function paintSetupActions(root: ParentNode = document): void {
  for (const b of root.querySelectorAll<HTMLButtonElement>("button[data-setup-action]")) {
    const v = viewOf(b.dataset.setupAction as SetupActionId, b.dataset.label || b.textContent || "");
    if (b.textContent !== v.label) b.textContent = v.label;
    b.disabled = v.disabled;
    b.hidden = v.hidden;
    b.toggleAttribute("data-setup-restart", v.restart);
    b.setAttribute("aria-busy", String(v.disabled));
  }
  for (const s of root.querySelectorAll<HTMLElement>("[data-setup-status]")) {
    const html = statusInner(viewOf(s.dataset.setupStatus as SetupActionId, ""));
    if (s.innerHTML !== html) s.innerHTML = html;
  }
}

let wired = false;

/** One click handler for every setup button in the page, and the jobs the service already has. */
export function initSetupActions(): void {
  if (wired) return;
  wired = true;
  document.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-setup-action]");
    if (!b || b.disabled) return;
    e.preventDefault();
    const action = b.dataset.setupAction as SetupActionId;
    if (b.hasAttribute("data-setup-restart")) {
      b.disabled = true;
      void restartDevis().then((why) => {
        if (why) {
          b.disabled = false;
          const status = document.querySelector<HTMLElement>(`[data-setup-status="${action}"]`);
          if (status) status.innerHTML = `<span class="setup-act-msg tone-err">${esc(why)}</span>`;
        }
      });
      return;
    }
    const inputId = b.dataset.setupInput;
    const folder = inputId ? document.getElementById(inputId) : null;
    void runSetupAction(action, folder instanceof HTMLInputElement ? { folder: folder.value } : {});
  });
  void loadSetupJobs();
}
