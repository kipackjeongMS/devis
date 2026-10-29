// The Meetings tab, beside Tasks and Communication: what your Teams meetings said, by day. Today
// first and open, filling in through the day; earlier days fold up under it, two weeks back. Each
// meeting shows its time, title and whether Teams wrote a recap; opened, its action items (yours
// first, each one a To-do away) and its notes.

import { esc } from "./util.js";
import { icon, type IconName } from "./icons.js";
import {
  actionTodo,
  dayLine,
  meetingDays,
  meetingTime,
  orderedActions,
  recapChip,
  type CommsMeeting,
  type MeetingDay,
  type MeetingScanInfo,
} from "./commsModel.js";
import type { Todo } from "./jarvisModel.js";

export interface MeetingsView {
  /** Null until they're read. */
  meetings: CommsMeeting[] | null;
  status: { enabled: boolean; last: MeetingScanInfo | null } | null;
  error: string;
  /** A scan asked for from the tab is under way. */
  scanning: boolean;
}

const svg = (name: IconName): string => icon(name);

/** Meetings opened to their recap. */
const expanded = new Set<string>();
/** Notes whose details are open, as "<meeting id>:<note index>". */
const openNotes = new Set<string>();
/** Days opened or folded by hand; otherwise today is open and the rest folded. */
const dayOpen = new Map<string, boolean>();

export function toggleMeeting(id: string): boolean {
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  return expanded.has(id);
}

export function toggleNote(id: string, index: number): void {
  const key = `${id}:${index}`;
  if (openNotes.has(key)) openNotes.delete(key);
  else openNotes.add(key);
}

export function toggleDay(key: string, today: boolean): void {
  dayOpen.set(key, !(dayOpen.get(key) ?? today));
}

/** Forget what's no longer listed (the page runs for days). */
export function pruneMeetingsState(meetings: CommsMeeting[]): void {
  const ids = new Set(meetings.map((m) => m.id));
  for (const id of [...expanded]) if (!ids.has(id)) expanded.delete(id);
  for (const key of [...openNotes]) if (!ids.has(key.slice(0, key.indexOf(":")))) openNotes.delete(key);
}

/** A cheap signature of what the tab shows, so polling only repaints on change. */
export function meetingsSig(view: MeetingsView, todos: Todo[] | undefined, now: number): string {
  return JSON.stringify([
    view.meetings?.map((m) => [m.id, m.updatedAt, m.state]),
    view.status?.enabled,
    view.status?.last?.at,
    view.error,
    view.scanning,
    [...expanded],
    [...openNotes],
    [...dayOpen],
    (todos || []).filter((t) => t.source?.key.startsWith("meet:")).map((t) => [t.source!.key, t.done]),
    Math.floor(now / 60_000),
  ]);
}

/** The pane's sub line: today's meetings, and when the calendar was last read. */
export function meetingsSub(view: MeetingsView, now: number): string {
  if (view.status && !view.status.enabled) return "Meeting recaps are off";
  const today = view.meetings ? meetingDays(view.meetings, now)[0] : null;
  const parts = [today ? `Today: ${dayLine(today)}` : ""];
  const last = view.status?.last;
  if (view.scanning) parts.push("reading…");
  else if (last) parts.push(`read ${new Date(last.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`);
  return parts.filter(Boolean).join(" · ");
}

export function meetingsHtml(view: MeetingsView, todos: Todo[] | undefined, now: number): string {
  const html: string[] = [];
  const last = view.status?.last;
  if (view.error) html.push(`<div class="today-note err" data-key="meetings-err">Couldn't read the meetings. ${esc(view.error)}</div>`);
  if (view.status && !view.status.enabled) {
    html.push(`
      <div class="today-start" data-key="meetings-off">
        <p class="today-start-title">Meeting recaps are off</p>
        <p>Turn them on to see what each Teams meeting covered, from the recap Teams writes, and its action items.</p>
        <button type="button" class="btn sm accent" data-act="meetings-settings">${svg("settings")}<span>Settings</span></button>
      </div>`);
  } else if (last && !last.ok && last.error) {
    html.push(`<div class="today-note warn" data-key="meetings-warn">${esc(last.throttled ? "Teams asked to slow down; the next read waits a little longer." : `The last read didn't finish: ${last.error}`)}</div>`);
  }
  if (!view.meetings) {
    html.push(view.error ? "" : `<div class="loading" data-key="meetings-loading"><span class="spinner"></span> Loading meetings…</div>`);
    return html.join("");
  }
  for (const day of meetingDays(view.meetings, now)) html.push(dayHtml(day, todos, now));
  if (view.meetings.length === 0 && view.status?.enabled !== false) {
    html.push(`<p class="today-empty comms-foot" data-key="meetings-none">${last ? "No Teams meetings yesterday or today." : "The calendar hasn't been read yet."}</p>`);
  }
  return html.join("");
}

function dayHtml(day: MeetingDay, todos: Todo[] | undefined, now: number): string {
  const open = dayOpen.get(day.key) ?? day.today;
  const head = `
    <button type="button" class="comms-day-head" data-key="head" data-act="meet-day" data-day="${esc(day.key)}" data-today="${day.today ? 1 : 0}" aria-expanded="${open}">
      ${svg("chevron")}<span class="comms-day-title">${esc(day.label)}</span><span class="comms-day-date">${esc(day.date)}</span><span class="comms-day-line">${esc(dayLine(day))}</span>
    </button>`;
  const body = !open
    ? ""
    : day.meetings.length
      ? `<h3 class="comms-kind" data-key="kind:meetings">${svg("calendar")}<span>Meetings</span></h3>${day.meetings.map((m) => meetingHtml(m, todos, now)).join("")}`
      : `<p class="today-empty" data-key="empty">No Teams meetings.</p>`;
  return `<section class="comms-day${open ? " open" : ""}" data-key="day:${esc(day.key)}">${head}${body}</section>`;
}

function meetingHtml(m: CommsMeeting, todos: Todo[] | undefined, now: number): string {
  const open = expanded.has(m.id);
  const chip = recapChip(m, now);
  const mine = m.actions.filter((a) => a.mine).length;
  const forYou = mine ? `<span class="tchip tone-warn meet-mine">${svg("person")}${mine} for you</span>` : "";
  const who = [m.organizer, m.attendees ? `${m.attendees} ${m.attendees === 1 ? "person" : "people"}` : ""].filter(Boolean).join(" · ");
  return `
    <article class="meet tone-${chip.tone}${open ? " open" : ""}" data-key="meet:${esc(m.id)}" data-meet="${esc(m.id)}">
      <button type="button" class="meet-head" data-key="head" data-act="meet-toggle" aria-expanded="${open}" title="${esc(chip.title)}">
        <span class="meet-time">${esc(meetingTime(m))}</span>
        <span class="meet-title">${esc(m.subject)}</span>
        <span class="meet-chips">${forYou}<span class="tchip tone-${chip.tone} meet-state">${esc(chip.text)}</span></span>
      </button>
      ${who ? `<p class="meet-who" data-key="who">${esc(who)}</p>` : ""}
      ${open ? `<div class="meet-body" data-key="body">${meetingBody(m, todos, now)}</div>` : ""}
    </article>`;
}

function meetingBody(m: CommsMeeting, todos: Todo[] | undefined, now: number): string {
  const teams = m.chatLink
    ? `<a class="btn sm ghost" href="${esc(m.chatLink)}" target="_blank" rel="noopener" data-act="meet-teams">${svg("chat")}<span>Open in Teams</span></a>`
    : "";
  if (m.state !== "ready") return `<p class="meet-empty">${esc(recapChip(m, now).title)}</p>${teams ? `<div class="meet-actions-row">${teams}</div>` : ""}`;
  // Each note in a line or two; its details fold under it.
  const notes = m.notes.length
    ? `<h4 class="meet-h">Notes</h4><ul class="meet-notes">${m.notes
        .map((n, i) => {
          const open = openNotes.has(`${m.id}:${i}`);
          const more = n.points.length
            ? `<button type="button" class="meet-more" data-act="note-toggle" data-index="${i}" aria-expanded="${open}">${svg("chevron")}<span>${n.points.length} detail${n.points.length === 1 ? "" : "s"}</span></button>${
                open ? `<ul class="meet-points">${n.points.map((p) => `<li>${p.title ? `<b>${esc(p.title)}:</b> ` : ""}${esc(p.text)}</li>`).join("")}</ul>` : ""
              }`
            : "";
          return `<li data-key="n:${i}">${n.title ? `<span class="meet-note-title">${esc(n.title)}</span>` : ""}${n.text ? `<span class="meet-note-text">${esc(n.text)}</span>` : ""}${more}</li>`;
        })
        .join("")}</ul>`
    : "";
  const actions = m.actions.length
    ? `<h4 class="meet-h">Action items</h4><ul class="meet-items">${orderedActions(m)
        .map((a) => {
          const made = actionTodo(todos, m.id, a.index);
          const what = a.title || a.text;
          const control = made
            ? `<span class="meet-made">${svg("check")}${made.done ? "Done" : "In your to-dos"}</span>`
            : `<button type="button" class="need-todo" data-act="meet-todo" data-index="${a.index}" title="Add it to your to-dos" aria-label="Add to your to-dos: ${esc(what)}">${svg("checklist")}<span>To-do</span></button>`;
          return `<li class="${a.mine ? "mine" : ""}" data-key="a:${a.index}">
              <span class="meet-owner">${esc(a.mine ? "You" : a.owner || "Someone")}</span>
              <span class="meet-item">${a.title ? `<span class="meet-item-title">${esc(a.title)}</span>` : ""}${a.text && a.text !== a.title ? `<span class="meet-item-text">${esc(a.text)}</span>` : ""}</span>
              ${control}
            </li>`;
        })
        .join("")}</ul>`
    : "";
  // What to do comes first: action items, yours at the top; then the notes.
  return `${actions}${notes}${teams ? `<div class="meet-actions-row">${teams}</div>` : ""}`;
}
