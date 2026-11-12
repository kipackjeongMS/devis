// Meetings: what your Teams meetings said, by day. In the Workspace's drawer it's a list beside a
// detail: each meeting shows its time, title and whether Teams wrote a recap; picked, its action
// items (yours first, each one a To-do away) and its notes. The Workspace's rail shows today's.
// Today first and open, filling in through the day; earlier days fold up under it, two weeks back.

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
  status: { enabled: boolean; last: MeetingScanInfo | null; agency?: boolean } | null;
  error: string;
  /** A scan asked for from the drawer is under way. */
  scanning: boolean;
}

const svg = (name: IconName): string => icon(name);

/** The meeting shown in the detail; null picks the latest with a recap. */
let selected: string | null = null;
/** Notes whose details are open, as "<meeting id>:<note index>". */
const openNotes = new Set<string>();
/** Days opened or folded by hand; otherwise today is open and the rest folded. */
const dayOpen = new Map<string, boolean>();

export function selectMeeting(id: string, day?: string): void {
  selected = id;
  if (day) dayOpen.set(day, true);
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
  if (selected && !ids.has(selected)) selected = null;
  for (const key of [...openNotes]) if (!ids.has(key.slice(0, key.indexOf(":")))) openNotes.delete(key);
}

/** A cheap signature of what the drawer shows, so polling only repaints on change. */
export function meetingsSig(view: MeetingsView, todos: Todo[] | undefined, now: number): string {
  return JSON.stringify([
    view.meetings?.map((m) => [m.id, m.updatedAt, m.state]),
    view.status?.enabled,
    view.status?.last?.at,
    view.status?.agency,
    view.error,
    view.scanning,
    selected,
    [...openNotes],
    [...dayOpen],
    (todos || []).filter((t) => t.source?.key.startsWith("meet:")).map((t) => [t.source!.key, t.done]),
    Math.floor(now / 60_000),
  ]);
}

/** The drawer's sub line: today's meetings, and when the calendar was last read. */
export function meetingsSub(view: MeetingsView, now: number): string {
  if (view.status && !view.status.enabled) return "Meeting recaps are off";
  const today = view.meetings ? meetingDays(view.meetings, now)[0] : null;
  const parts = [today ? `Today: ${dayLine(today)}` : ""];
  const last = view.status?.last;
  if (view.scanning) parts.push("reading…");
  else if (last) parts.push(`read ${new Date(last.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`);
  return parts.filter(Boolean).join(" · ");
}

/** The picked meeting, or the latest one with a recap, else the latest that started. */
function current(view: MeetingsView, now: number): CommsMeeting | null {
  const all = view.meetings || [];
  const picked = selected ? all.find((m) => m.id === selected) : undefined;
  if (picked) return picked;
  const started = all.filter((m) => (Date.parse(m.start) || 0) <= now).sort((a, b) => (Date.parse(b.start) || 0) - (Date.parse(a.start) || 0));
  return started.find((m) => m.state === "ready") || started[0] || all[0] || null;
}

/** The list half of the drawer: each day and its meetings. */
export function meetingsHtml(view: MeetingsView, _todos: Todo[] | undefined, now: number): string {
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
  } else if (view.status?.agency === false) {
    html.push(`<div class="today-note warn" data-key="meetings-agency">Meeting recaps are waiting on Agency, which isn't installed. Install it and the next scan picks up.</div>`);
  } else if (last && !last.ok && last.error) {
    html.push(`<div class="today-note warn" data-key="meetings-warn">${esc(last.throttled ? "Teams asked to slow down; the next read waits a little longer." : `The last read didn't finish: ${last.error}`)}</div>`);
  }
  if (!view.meetings) {
    html.push(view.error ? "" : `<div class="loading" data-key="meetings-loading"><span class="spinner"></span> Loading meetings…</div>`);
    return html.join("");
  }
  const pick = current(view, now)?.id || "";
  for (const day of meetingDays(view.meetings, now)) html.push(dayHtml(day, pick, now));
  if (view.meetings.length === 0 && view.status?.enabled !== false) {
    html.push(`<p class="today-empty" data-key="meetings-none">${last ? "No Teams meetings yesterday or today." : "The calendar hasn't been read yet."}</p>`);
  }
  return html.join("");
}

function dayHtml(day: MeetingDay, pick: string, now: number): string {
  const open = dayOpen.get(day.key) ?? day.today;
  const head = `
    <button type="button" class="ld-day" data-key="head" data-act="meet-day" data-day="${esc(day.key)}" data-today="${day.today ? 1 : 0}" aria-expanded="${open}">
      ${svg("chevron")}<span class="ld-day-t">${esc(day.label)}</span><span class="ld-day-d">${esc(day.date)}</span><span class="ld-day-n">${esc(dayLine(day))}</span>
    </button>`;
  const body = !open
    ? ""
    : day.meetings.length
      ? day.meetings.map((m) => itemHtml(m, pick, now)).join("")
      : `<p class="today-empty" data-key="empty">No Teams meetings.</p>`;
  return `<section class="ld-group${open ? " open" : ""}" data-key="day:${esc(day.key)}">${head}${body}</section>`;
}

const mineCount = (m: CommsMeeting): number => m.actions.filter((a) => a.mine).length;

function itemHtml(m: CommsMeeting, pick: string, now: number): string {
  const chip = recapChip(m, now);
  const sel = m.id === pick;
  const mine = mineCount(m);
  return `
    <button type="button" class="ld-item tone-${chip.tone}${sel ? " sel" : ""}" data-key="meet:${esc(m.id)}" data-meet="${esc(m.id)}" data-act="meet-select" title="${esc(chip.title)}"${sel ? ' aria-current="true"' : ""}>
      <span class="ld-item-h"><b class="ell">${esc(m.subject)}</b><span class="ld-tm">${esc(meetingTime(m))}</span></span>
      <span class="ld-item-p"><span class="rdot tone-${chip.tone}"></span><span class="ell">${esc(chip.text)}${mine ? ` · ${mine} for you` : ""}</span></span>
    </button>`;
}

/** The detail half of the drawer: the picked meeting's action items and notes. */
export function meetingDetailHtml(view: MeetingsView, todos: Todo[] | undefined, now: number): string {
  if ((view.status && !view.status.enabled) || !view.meetings) return "";
  const m = current(view, now);
  if (!m) return `<p class="today-empty ld-none" data-key="none">No meetings to show yet.</p>`;
  const chip = recapChip(m, now);
  const mine = mineCount(m);
  const who = [meetingTime(m), m.organizer, m.attendees ? `${m.attendees} ${m.attendees === 1 ? "person" : "people"}` : ""].filter(Boolean).join(" · ");
  const teams = m.chatLink
    ? `<a class="btn sm" href="${esc(m.chatLink)}" target="_blank" rel="noopener" data-act="meet-teams">${svg("chat")}<span>Open in Teams</span></a>`
    : "";
  const head = `
      <button type="button" class="btn sm ghost ld-back" data-act="ld-back">${svg("back")}<span>All meetings</span></button>
      <h4 class="ld-h">${esc(m.subject)}</h4>
      <p class="ld-meta"><span class="tchip tone-${chip.tone}" title="${esc(chip.title)}">${esc(chip.text)}</span>${mine ? `<span class="tchip tone-warn">${mine} for you</span>` : ""}<span>${esc(who)}</span></p>`;
  if (m.state !== "ready") {
    return `<article class="ld-doc" data-key="doc:${esc(m.id)}" data-meet="${esc(m.id)}">${head}<p class="ld-sum">${esc(chip.title)}</p>${teams ? `<div class="ld-acts">${teams}</div>` : ""}</article>`;
  }
  const actions = m.actions.length
    ? `<h5 class="ld-sh">Action items</h5><div class="ld-airs">${orderedActions(m)
        .map((a) => {
          const made = actionTodo(todos, m.id, a.index);
          const what = a.title || a.text;
          const control = made
            ? `<span class="ld-made">${svg("check")}${made.done ? "Done" : "In your to-dos"}</span>`
            : `<button type="button" class="btn sm ghost" data-act="meet-todo" data-index="${a.index}" title="Add it to your to-dos" aria-label="Add to your to-dos: ${esc(what)}">${svg("checklist")}<span>To-do</span></button>`;
          return `<div class="ld-air${a.mine ? " mine" : ""}" data-key="a:${a.index}">
              <span class="ld-air-who">${esc(a.mine ? "You" : a.owner || "Someone")}</span>
              <span class="ld-air-what">${a.title ? `<b>${esc(a.title)}</b>` : ""}${a.text && a.text !== a.title ? `<span>${esc(a.text)}</span>` : ""}</span>
              <span class="ld-air-ctl">${control}</span>
            </div>`;
        })
        .join("")}</div>`
    : "";
  // Each note in a line or two; its details fold under it.
  const notes = m.notes.length
    ? `<h5 class="ld-sh">Notes</h5>${m.notes
        .map((n, i) => {
          const open = openNotes.has(`${m.id}:${i}`);
          const more = n.points.length
            ? `<button type="button" class="ld-more" data-act="note-toggle" data-index="${i}" aria-expanded="${open}">${svg("chevron")}<span>${n.points.length} detail${n.points.length === 1 ? "" : "s"}</span></button>${
                open ? `<ul class="ld-pts">${n.points.map((p) => `<li>${p.title ? `<b>${esc(p.title)}:</b> ` : ""}${esc(p.text)}</li>`).join("")}</ul>` : ""
              }`
            : "";
          return `<div class="ld-nt" data-key="n:${i}">${n.title ? `<b>${esc(n.title)}</b> ` : ""}${n.text ? `<span>${esc(n.text)}</span>` : ""}${more}</div>`;
        })
        .join("")}`
    : "";
  // What to do comes first: action items, yours at the top; then the notes.
  return `<article class="ld-doc" data-key="doc:${esc(m.id)}" data-meet="${esc(m.id)}">${head}${actions}${notes}${teams ? `<div class="ld-acts">${teams}</div>` : ""}<p class="ld-foot">From the recap Teams wrote.</p></article>`;
}

/** Today's meetings for the rail, each with whether its recap came. */
export function meetingsRail(view: MeetingsView, now: number): string {
  if (view.status && !view.status.enabled) return `<p class="rs-empty">Recaps are off.</p>`;
  if (!view.meetings) return view.error ? `<p class="rs-empty">Couldn't read them.</p>` : `<p class="rs-empty"><span class="spinner"></span> Loading…</p>`;
  const today = meetingDays(view.meetings, now)[0];
  if (!today?.meetings.length) return `<p class="rs-empty">No meetings today.</p><button type="button" class="rs-more" data-key="more" data-act="meet-open">Earlier days</button>`;
  return (
    today.meetings
      .map((m) => {
        const chip = recapChip(m, now);
        const mine = mineCount(m);
        return `<button type="button" class="rr2" data-key="m:${esc(m.id)}" data-meet="${esc(m.id)}" data-act="meet-open" title="${esc(chip.title)}">
          <span class="rr-h"><b class="ell">${esc(m.subject)}</b><span class="rr-tm">${esc(meetingTime(m).split(/\s*[–-]\s*/)[0])}</span></span>
          <span class="rr-p"><span class="rdot tone-${chip.tone}"></span><span class="ell">${esc(chip.text)}${mine ? ` · ${mine} for you` : ""}</span></span>
        </button>`;
      })
      .join("") + `<button type="button" class="rs-more" data-key="more" data-act="meet-open">Open</button>`
  );
}
