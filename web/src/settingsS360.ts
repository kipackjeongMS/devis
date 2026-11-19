// Settings' S360 card: whether the app reads your S360 action items once a day (the ones assigned to
// you, and the ones you own), what the last read found, and Read now. It applies at once, apart from
// Save: it changes what the background service does, not the config.

import { getJSON, postJSON } from "./api.js";
import { icon } from "./icons.js";
import { AGENCY_WAIT } from "./settingsTeams.js";
import type { S360Status } from "./s360Model.js";

type CardFactory = (name: Parameters<typeof icon>[0], title: string, descHtml: string, titleId: string, stacked?: boolean) => HTMLElement;

const sameDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString();

/** A time, with its day unless it's today. */
function when(iso: string, now: number): string {
  const at = new Date(iso);
  const clock = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay(at.getTime(), now) ? clock : `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${clock}`;
}

/** What the last read of S360 did, and when the next one is, in a line. */
export function s360Line(s: S360Status | null, now = Date.now()): string {
  if (!s) return "Couldn't read what the last read found.";
  if (!s.enabled) return "Off. Turn it on to see your S360 action items in the S360 tab, and the ones near or past their SLA under Needs you.";
  if (s.agency === false) return AGENCY_WAIT;
  if (s.scanning) return "Reading S360…";
  const last = s.last;
  const readToday = !!s.readAt && sameDay(new Date(s.readAt).getTime(), now);
  const next = readToday ? " Reads again tomorrow." : s.nextAt ? ` Next read ${when(s.nextAt, now)}.` : "";
  if (!last) return `Not read yet.${next}`;
  if (last.throttled && !last.ok && !last.items) return `${when(last.at, now)}: S360 asked to slow down, so it waits longer before the next read.${next}`;
  if (!last.ok && !last.items) return `${when(last.at, now)}: couldn't read S360. ${last.error || ""}${next}`.replace(/\s+$/, "");
  const who = s.alias ? ` for ${s.alias}` : "";
  const items = `${last.items} open item${last.items === 1 ? "" : "s"}${who}`;
  const changed = [last.found ? `${last.found} new` : "", last.resolved ? `${last.resolved} closed` : ""].filter(Boolean).join(", ") || "nothing new";
  const warn = last.error ? ` ${last.error}` : "";
  return `Last read ${when(last.at, now)}: ${items}, ${changed}.${warn}${next}`;
}

export function s360Card(card: CardFactory): HTMLElement {
  const node = card(
    "shield",
    "S360",
    "Reads your S360 action items once a day, soon after midnight: the ones assigned to you, and the ones you own. Shows them all in the S360 tab. Under Needs you go the new ones, and the ones near or past their SLA; a dismissed one comes back only if it gets closer to its SLA or past it. The first read takes in what's there and shows only the ones near or past their SLA. It reads S360 through Agency and never changes anything there.",
    "settingsS360",
    true
  );
  const control = node.querySelector<HTMLElement>(".settings-card-control")!;
  control.classList.add("teams-control");
  control.innerHTML = `
    <div class="teams-row">
      <label class="teams-switch"><input type="checkbox" role="switch" class="param-switch" data-s360="enabled" disabled><span>Read S360 every day</span></label>
      <p class="teams-line" data-line="s360" role="status">Checking…</p>
    </div>
    <button type="button" class="btn sm" data-s360="scan" disabled>${icon("sync")}<span>Read now</span></button>`;
  const toggle = control.querySelector<HTMLInputElement>("[data-s360='enabled']")!;
  const scan = control.querySelector<HTMLButtonElement>("[data-s360='scan']")!;
  const line = control.querySelector<HTMLElement>("[data-line='s360']")!;

  let follow: ReturnType<typeof setTimeout> | null = null;
  const paint = (s: S360Status | null): void => {
    toggle.disabled = !s;
    toggle.checked = !!s?.enabled;
    scan.disabled = !s || !s.enabled || s.scanning;
    scan.setAttribute("aria-busy", String(!!s?.scanning));
    line.textContent = s360Line(s);
    // Turning it on reads in the background: look again until that read is done, while Settings shows.
    if (follow) clearTimeout(follow);
    follow = s?.scanning ? setTimeout(() => (node.isConnected ? void load() : undefined), 3000) : null;
  };
  const load = async (): Promise<void> => {
    try {
      const res: { status: S360Status } = await getJSON("/api/jarvis/s360");
      paint(res.status);
    } catch {
      paint(null);
    }
  };

  toggle.addEventListener("change", async () => {
    const on = toggle.checked;
    toggle.disabled = true;
    try {
      const res: { status: S360Status } = await postJSON("/api/jarvis/s360/enabled", { enabled: on });
      paint(res.status);
    } catch {
      toggle.checked = !on;
      toggle.disabled = false;
    }
    void load();
  });
  scan.addEventListener("click", async () => {
    scan.disabled = true;
    scan.setAttribute("aria-busy", "true");
    line.textContent = "Reading S360…";
    try {
      const res: { status: S360Status } = await postJSON("/api/jarvis/s360/scan", {});
      paint(res.status);
    } catch (e) {
      line.textContent = `Couldn't read S360: ${(e as Error).message}`;
      scan.disabled = false;
      scan.setAttribute("aria-busy", "false");
    }
  });

  void load();
  return node;
}
