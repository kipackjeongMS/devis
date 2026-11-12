// Settings' Setup card: what Devis needs from this machine (Copilot, the Azure CLI's sign-in,
// GitHub, Git, Agency, VS Code), each row with what waits for it when it's missing and, where
// Devis can fix it, a button that does (Install, Sign in). Checked when Settings opens, again on
// Check again, and again when one of those buttons finishes. A gap never stops Devis; this is
// where it's all in one place. Also here: whether Devis starts when you sign in to Windows.

import { getJSON } from "./api.js";
import { icon, type IconName } from "./icons.js";
import { esc } from "./util.js";
import { onSetupJob, paintSetupActions, readSetupState, saveSetupState, setupActionHtml, setupStatusHtml, type SetupActionId } from "./setupActions.js";
import { toast } from "./toast.js";

type CardFactory = (name: Parameters<typeof icon>[0], title: string, descHtml: string, titleId: string, stacked?: boolean) => HTMLElement;

type SetupStatus = "ok" | "warn" | "missing";

export interface SetupCheck {
  id: string;
  label: string;
  status: SetupStatus;
  detail: string;
  needs?: string[];
  /** What fixes it from here: Install, Sign in. */
  action?: { id: SetupActionId; label: string };
}

const TONE: Record<SetupStatus, { icon: IconName; said: string }> = {
  ok: { icon: "check", said: "Ready" },
  warn: { icon: "warning", said: "Needs attention" },
  missing: { icon: "dismiss", said: "Missing" },
};

const clock = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** The detail's `commands` as code, the rest as text. */
const detailHtml = (s: string): string => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

export function setupRowsHtml(checks: SetupCheck[]): string {
  return checks
    .map((c) => {
      const tone = TONE[c.status] || TONE.warn;
      const needs = c.status !== "ok" && c.needs?.length ? `<div class="setup-needs"><span class="visually-hidden">Waits for it: </span>${c.needs.map((n) => `<span class="dv-chip">${esc(n)}</span>`).join("")}</div>` : "";
      const fix = c.action ? setupStatusHtml(c.action.id) : "";
      const button = c.action ? `<div class="setup-fix">${setupActionHtml(c.action.id, c.action.label, { tone: c.status === "missing" ? "accent" : undefined })}</div>` : "";
      return `
        <li class="setup-row tone-${esc(c.status)}" data-check="${esc(c.id)}">
          <span class="setup-ico" aria-hidden="true">${icon(tone.icon)}</span>
          <div class="setup-m">
            <div class="setup-name">${esc(c.label)}<span class="visually-hidden">: ${tone.said}</span></div>
            <p class="setup-detail">${detailHtml(c.detail)}</p>${needs}${fix}
          </div>${button}
        </li>`;
    })
    .join("");
}

/** The machine's checks, painted into `list`; `onDone` hears the gap count. Returns a function that runs them again. */
export function setupChecker(list: HTMLElement, onDone?: (checks: SetupCheck[] | null, at?: string) => void): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let again = false;
  const run = async (): Promise<void> => {
    list.setAttribute("aria-busy", "true");
    try {
      const res: { at: string; checks: SetupCheck[] } = await getJSON("/api/setup/checks");
      list.innerHTML = setupRowsHtml(res.checks);
      paintSetupActions(list);
      onDone?.(res.checks, res.at);
    } catch (e) {
      list.innerHTML = `<li class="setup-wait err">Couldn't check this machine: ${esc((e as Error).message)}</li>`;
      onDone?.(null);
    } finally {
      list.setAttribute("aria-busy", "false");
    }
  };
  const check = async (): Promise<void> => {
    // A check asked for while one runs goes once that one's done, so it sees what just changed.
    if (inFlight) {
      again = true;
      return inFlight;
    }
    inFlight = run();
    await inFlight;
    inFlight = null;
    if (again) {
      again = false;
      await check();
    }
  };
  // A button finishing changes what the checks find. Stops listening once the list leaves the page.
  const off = onSetupJob((job, before) => {
    if (!list.isConnected) return void off();
    if (job.state === "done" && before?.state === "running" && job.action !== "devis-source") void check();
  });
  return check;
}

export function setupCard(card: CardFactory): HTMLElement {
  const node = card(
    "checklist",
    "This machine",
    "What Devis needs here, checked each time you open Settings. A gap never stops Devis: each row says what waits for it.",
    "settingsSetup",
    true
  );
  const control = node.querySelector<HTMLElement>(".settings-card-control")!;
  control.classList.add("setup-control");
  control.innerHTML = `
    <ul class="setup-list" aria-labelledby="settingsSetup"><li class="setup-wait"><span class="spinner"></span>Checking this machine…</li></ul>
    <div class="setup-foot">
      <button type="button" class="btn sm" data-setup="check" disabled>${icon("sync")}<span>Check again</span></button>
      <span class="setup-at" role="status"></span>
    </div>
    <label class="teams-switch setup-startup"><input type="checkbox" role="switch" class="param-switch" data-setup="startup" disabled><span>Start Devis when I sign in to Windows</span></label>
    <p class="teams-line">Its background service then runs from sign-in, without a window, so scheduled catch-ups are done before you open Devis.</p>`;
  const list = control.querySelector<HTMLElement>(".setup-list")!;
  const again = control.querySelector<HTMLButtonElement>("[data-setup='check']")!;
  const label = again.querySelector("span")!;
  const at = control.querySelector<HTMLElement>(".setup-at")!;
  const startup = control.querySelector<HTMLInputElement>("[data-setup='startup']")!;

  const runChecks = setupChecker(list, (checks, when) => {
    if (!checks) return;
    const gaps = checks.filter((c) => c.status !== "ok").length;
    at.textContent = `Checked ${clock(when!)}${gaps ? ` · ${gaps} to look at` : " · all set"}`;
  });
  const check = async (): Promise<void> => {
    again.disabled = true;
    again.setAttribute("aria-busy", "true");
    label.textContent = "Checking…";
    at.textContent = "";
    try {
      await runChecks();
    } finally {
      again.disabled = false;
      again.setAttribute("aria-busy", "false");
      label.textContent = "Check again";
    }
  };
  again.addEventListener("click", () => void check());

  void readSetupState()
    .then((s) => {
      startup.checked = s.startAtSignIn;
      startup.disabled = false;
    })
    .catch(() => undefined);
  startup.addEventListener("change", async () => {
    const want = startup.checked;
    startup.disabled = true;
    try {
      startup.checked = (await saveSetupState({ startAtSignIn: want })).startAtSignIn;
    } catch (e) {
      startup.checked = !want;
      toast(`Couldn't change that: ${(e as Error).message}`, "err");
    } finally {
      startup.disabled = false;
    }
  });

  void check();
  return node;
}
