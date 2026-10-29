// Settings' Teams and email card: whether the app reads your Teams chats for PR review asks and
// summaries, your meetings' recaps, and your email from people; what the last read found of each,
// and Scan now. It applies at once, apart
// from Save: it changes what the background service does, not the config.

import { getJSON, postJSON } from "./api.js";
import { icon } from "./icons.js";
import type { ChatsInfo, MeetingScanInfo } from "./commsModel.js";

type CardFactory = (name: Parameters<typeof icon>[0], title: string, descHtml: string, titleId: string, stacked?: boolean) => HTMLElement;

interface ScanInfo {
  at: string;
  ok: boolean;
  calls: number;
  chats: number;
  messages: number;
  found: number;
  left: number;
  throttled: boolean;
  error: string | null;
}

interface CommsStatus {
  enabled: boolean;
  scanning: boolean;
  last: ScanInfo | null;
  nextAt: string | null;
  meetings?: { enabled: boolean; last: MeetingScanInfo | null };
  chats?: { enabled: boolean; last: ChatsInfo | null };
  mail?: { enabled: boolean; last: MailScanInfo | null; summaries: ChatsInfo | null };
}

interface MailScanInfo {
  at: string;
  ok: boolean;
  calls: number;
  messages: number;
  threads: number;
  found: number;
  left: number;
  throttled: boolean;
  error: string | null;
}

const clock = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** What the last read of Teams chats did, in a line. */
export function scanLine(s: CommsStatus | null, open: number | null): string {
  if (!s) return "Couldn't read what the last scan found.";
  if (!s.enabled) return "Off. Turn it on to see PR review asks from Teams under Needs you.";
  if (s.scanning) return "Reading Teams…";
  const last = s.last;
  const next = s.nextAt ? ` Next scan ${clock(s.nextAt)}.` : "";
  if (!last) return `Not read yet.${next}`;
  const asks = open === null ? "" : ` · ${open ? `${open} open ask${open === 1 ? "" : "s"}` : "no open asks"}`;
  if (last.throttled) return `${clock(last.at)}: Teams asked to slow down, so it waits longer before the next scan.${next}`;
  if (!last.ok && !last.calls) return `${clock(last.at)}: couldn't read Teams. ${last.error || ""}${next}`.trim();
  const read = last.chats ? `read ${last.chats} chat${last.chats === 1 ? "" : "s"}, ${last.found ? `${last.found} new` : "nothing new"}` : "nothing new";
  const warn = !last.ok && last.error ? ` Some chats weren't read: ${last.error}` : "";
  return `Last scan ${clock(last.at)}: ${read}${asks}.${warn}${next}`;
}

/** What the last read of the calendar did, in a line. */
export function meetingsLine(s: CommsStatus | null): string {
  const m = s?.meetings;
  if (!s || !m) return "Couldn't read what the last scan found.";
  if (!m.enabled) return "Off. Turn it on to see your meetings' recaps in the Meetings tab.";
  if (s.scanning) return "Reading the calendar…";
  const last = m.last;
  if (!last) return "Not read yet.";
  if (last.throttled) return `${clock(last.at)}: Teams asked to slow down, so it waits longer before the next scan.`;
  if (!last.ok) return `${clock(last.at)}: couldn't read the calendar. ${last.error || ""}`.trim();
  const recaps = last.recaps ? `${last.recaps} new recap${last.recaps === 1 ? "" : "s"}` : "no new recaps";
  const pending = last.pending ? ` · ${last.pending} waiting for Teams to write one` : "";
  return `Last scan ${clock(last.at)}: ${last.meetings} meeting${last.meetings === 1 ? "" : "s"} yesterday and today, ${recaps}${pending}.`;
}

/** What the last chat summaries did, in a line. */
export function chatsLine(s: CommsStatus | null): string {
  const c = s?.chats;
  if (!s || !c) return "Couldn't read what the last scan found.";
  if (!c.enabled) return "Off. Turn it on to see a line for each Teams chat that moved, in the Communication tab.";
  if (s.scanning) return "Reading Teams…";
  const last = c.last;
  if (!last) return "Nothing summarized yet.";
  const waiting = last.pending ? ` · ${last.pending} waiting` : "";
  if (!last.ok) return `${clock(last.at)}: ${last.error || "the summaries didn't come through"}${waiting}`;
  return `Last summaries ${clock(last.at)}: ${last.summarized} conversation${last.summarized === 1 ? "" : "s"}${waiting}.`;
}

/** What the last read of the inbox did, and its summaries, in a line. */
export function mailLine(s: CommsStatus | null): string {
  const m = s?.mail;
  if (!s || !m) return "Couldn't read what the last scan found.";
  if (!m.enabled) return "Off. Turn it on to see a line for each email thread from people, in the Communication tab.";
  if (s.scanning) return "Reading your email…";
  const last = m.last;
  if (!last) return "Not read yet.";
  if (last.throttled) return `${clock(last.at)}: Outlook asked to slow down, so it waits longer before the next read.`;
  if (!last.ok && !last.calls) return `${clock(last.at)}: couldn't read your email. ${last.error || ""}`.trim();
  const found = last.found ? `${last.found} from people in ${last.threads} thread${last.threads === 1 ? "" : "s"}` : "nothing new from people";
  const waiting = m.summaries?.pending ? ` · ${m.summaries.pending} waiting for a summary` : "";
  const warn = !last.ok && last.error ? ` Some weren't read: ${last.error}` : m.summaries && !m.summaries.ok && m.summaries.error ? ` Summaries: ${m.summaries.error}` : "";
  return `Last read ${clock(last.at)}: ${last.messages} new in the inbox, ${found}${waiting}.${warn}`;
}

export function teamsCard(card: CardFactory): HTMLElement {
  const node = card(
    "chat",
    "Teams and email",
    "Finds pull requests people ask you to review in your Teams chats (1:1s, and group chats that ask the room) and shows them under Needs you. Sums up each Teams chat that moved, and each email thread people sent you (from Focused; not notifications or newsletters), in the Communication tab: a small model with no tools writes the line. Shows your Teams meetings in the Meetings tab, each with the recap Teams' Copilot wrote. Reads only what's new, every 30 minutes while the app runs. It never sends anything or marks anything read.",
    "settingsTeams",
    true
  );
  const control = node.querySelector<HTMLElement>(".settings-card-control")!;
  control.classList.add("teams-control");
  control.innerHTML = `
    <div class="teams-row">
      <label class="teams-switch"><input type="checkbox" role="switch" class="param-switch" data-source="teams" disabled><span>PR review asks from chats</span></label>
      <p class="teams-line" data-line="teams" role="status">Checking…</p>
    </div>
    <div class="teams-row">
      <label class="teams-switch"><input type="checkbox" role="switch" class="param-switch" data-source="chats" disabled><span>Chat summaries</span></label>
      <p class="teams-line" data-line="chats" role="status">Checking…</p>
    </div>
    <div class="teams-row">
      <label class="teams-switch"><input type="checkbox" role="switch" class="param-switch" data-source="meetings" disabled><span>Meeting recaps</span></label>
      <p class="teams-line" data-line="meetings" role="status">Checking…</p>
    </div>
    <div class="teams-row">
      <label class="teams-switch"><input type="checkbox" role="switch" class="param-switch" data-source="mail" disabled><span>Email summaries</span></label>
      <p class="teams-line" data-line="mail" role="status">Checking…</p>
    </div>
    <button type="button" class="btn sm" data-teams="scan" disabled>${icon("sync")}<span>Scan now</span></button>`;
  const toggles = [...control.querySelectorAll<HTMLInputElement>("input[data-source]")];
  const scan = control.querySelector<HTMLButtonElement>("[data-teams='scan']")!;
  const lines = {
    teams: control.querySelector<HTMLElement>("[data-line='teams']")!,
    meetings: control.querySelector<HTMLElement>("[data-line='meetings']")!,
    chats: control.querySelector<HTMLElement>("[data-line='chats']")!,
    mail: control.querySelector<HTMLElement>("[data-line='mail']")!,
  };
  let open: number | null = null;

  const paint = (s: CommsStatus | null): void => {
    for (const t of toggles) {
      t.disabled = !s;
      const src = t.dataset.source;
      t.checked = src === "meetings" ? !!s?.meetings?.enabled : src === "chats" ? !!s?.chats?.enabled : src === "mail" ? !!s?.mail?.enabled : !!s?.enabled;
    }
    scan.disabled = !s || (!s.enabled && !s.meetings?.enabled && !s.chats?.enabled && !s.mail?.enabled) || s.scanning;
    scan.setAttribute("aria-busy", String(!!s?.scanning));
    lines.teams.textContent = scanLine(s, open);
    lines.meetings.textContent = meetingsLine(s);
    lines.chats.textContent = chatsLine(s);
    lines.mail.textContent = mailLine(s);
  };
  const load = async (): Promise<void> => {
    try {
      const res: { status: CommsStatus; asks: unknown[] } = await getJSON("/api/jarvis/comms");
      open = res.asks.length;
      paint(res.status);
    } catch {
      paint(null);
    }
  };

  for (const toggle of toggles) {
    toggle.addEventListener("change", async () => {
      const on = toggle.checked;
      toggle.disabled = true;
      try {
        const res: { status: CommsStatus } = await postJSON("/api/jarvis/comms/enabled", { enabled: on, source: toggle.dataset.source });
        paint(res.status);
      } catch {
        toggle.checked = !on;
        toggle.disabled = false;
      }
      void load();
    });
  }
  scan.addEventListener("click", async () => {
    scan.disabled = true;
    lines.teams.textContent = "Reading Teams…";
    lines.meetings.textContent = "Reading the calendar…";
    lines.chats.textContent = "Reading Teams…";
    lines.mail.textContent = "Reading your email…";
    try {
      const res: { status: CommsStatus; asks: unknown[] } = await postJSON("/api/jarvis/comms/scan", {});
      open = res.asks.length;
      paint(res.status);
    } catch (e) {
      lines.teams.textContent = `Couldn't scan: ${(e as Error).message}`;
      scan.disabled = false;
    }
  });

  void load();
  return node;
}
