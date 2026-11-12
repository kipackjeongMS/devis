// Settings' Setup card: what Devis needs from this machine (Copilot, the Azure CLI's sign-in,
// Git, Agency, VS Code), each row with what waits for it when it's missing. Checked when Settings
// opens, and again on Check again. A gap never stops Devis; this is where it's all in one place.

import { getJSON } from "./api.js";
import { icon, type IconName } from "./icons.js";
import { esc } from "./util.js";

type CardFactory = (name: Parameters<typeof icon>[0], title: string, descHtml: string, titleId: string, stacked?: boolean) => HTMLElement;

type SetupStatus = "ok" | "warn" | "missing";

export interface SetupCheck {
  id: string;
  label: string;
  status: SetupStatus;
  detail: string;
  needs?: string[];
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
      return `
        <li class="setup-row tone-${esc(c.status)}" data-check="${esc(c.id)}">
          <span class="setup-ico" aria-hidden="true">${icon(tone.icon)}</span>
          <div class="setup-m">
            <div class="setup-name">${esc(c.label)}<span class="visually-hidden">: ${tone.said}</span></div>
            <p class="setup-detail">${detailHtml(c.detail)}</p>${needs}
          </div>
        </li>`;
    })
    .join("");
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
    </div>`;
  const list = control.querySelector<HTMLElement>(".setup-list")!;
  const again = control.querySelector<HTMLButtonElement>("[data-setup='check']")!;
  const label = again.querySelector("span")!;
  const at = control.querySelector<HTMLElement>(".setup-at")!;

  const check = async (): Promise<void> => {
    again.disabled = true;
    again.setAttribute("aria-busy", "true");
    list.setAttribute("aria-busy", "true");
    label.textContent = "Checking…";
    at.textContent = "";
    try {
      const res: { at: string; checks: SetupCheck[] } = await getJSON("/api/setup/checks");
      list.innerHTML = setupRowsHtml(res.checks);
      const gaps = res.checks.filter((c) => c.status !== "ok").length;
      at.textContent = `Checked ${clock(res.at)}${gaps ? ` · ${gaps} to look at` : " · all set"}`;
    } catch (e) {
      list.innerHTML = `<li class="setup-wait err">Couldn't check this machine: ${esc((e as Error).message)}</li>`;
    } finally {
      again.disabled = false;
      again.setAttribute("aria-busy", "false");
      list.setAttribute("aria-busy", "false");
      label.textContent = "Check again";
    }
  };
  again.addEventListener("click", () => void check());
  void check();
  return node;
}
