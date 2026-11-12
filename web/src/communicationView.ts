// Communication: your Teams chats and email, by day. Each conversation that moved, and each email
// thread from people, gets a line, written by a small model from its messages: what needs you
// first, then the important, then the rest. Newsletters and FYIs that ask nothing of you fold away
// under the day's email. In the Workspace's drawer it's a list beside a detail: picking a line
// shows its summary, its points and who was in it, and the chat in Teams or the email in Outlook.
// The Workspace's rail shows today's top few. Today first and open; earlier days fold up under it,
// two weeks back.

import { esc } from "./util.js";
import { icon, type IconName } from "./icons.js";
import {
  chatWho,
  commDayLine,
  commDays,
  isOutlookLink,
  isTeamsLink,
  mailWho,
  type ChatsInfo,
  type CommDay,
  type CommsChat,
  type CommsMail,
} from "./commsModel.js";

type Status = { enabled: boolean; last: ChatsInfo | null; readAt: string | null; agency?: boolean };

export interface CommunicationView {
  /** Null until they're read. */
  chats: CommsChat[] | null;
  status: Status | null;
  mail: CommsMail[] | null;
  mailStatus: Status | null;
  error: string;
  /** A read asked for from the drawer is under way. */
  scanning: boolean;
}

const svg = (name: IconName): string => icon(name);

/** The conversation shown in the detail, as "<chat id>|<day>" or "mail:<thread id>|<day>"; null picks the first. */
let selected: string | null = null;
/** Days opened or folded by hand; otherwise today is open and the rest folded. */
const dayOpen = new Map<string, boolean>();
/** Days whose quiet email is shown. */
const quietOpen = new Set<string>();

const keyOf = (c: Pick<CommsChat, "chatId" | "day">): string => `${c.chatId}|${c.day}`;
const mailKey = (m: Pick<CommsMail, "threadId" | "day">): string => `mail:${m.threadId}|${m.day}`;
const isChat = (x: CommsChat | CommsMail): x is CommsChat => "chatId" in x;
const itemKey = (x: CommsChat | CommsMail): string => (isChat(x) ? keyOf(x) : mailKey(x));

export function selectConversation(key: string): void {
  selected = key;
}

export function toggleChatDay(key: string, today: boolean): void {
  dayOpen.set(key, !(dayOpen.get(key) ?? today));
}

/** Pick a chat or thread and open its day, so it shows when the drawer is next drawn; returns its key. */
export function revealConversation(source: "chat" | "mail", id: string, day: string): string {
  const key = source === "mail" ? mailKey({ threadId: id, day }) : keyOf({ chatId: id, day });
  selected = key;
  dayOpen.set(day, true);
  return key;
}

export function toggleQuietMail(day: string): void {
  if (quietOpen.has(day)) quietOpen.delete(day);
  else quietOpen.add(day);
}

export function pruneCommunicationState(chats: CommsChat[] | null, mail: CommsMail[] | null): void {
  if (!selected) return;
  // A kind not read yet keeps its pick: a thread opened from Needs you stays picked while the chats load first.
  const list = selected.startsWith("mail:") ? mail : chats;
  if (list && !list.some((x) => itemKey(x) === selected)) selected = null;
}

export function communicationSig(view: CommunicationView, now: number): string {
  return JSON.stringify([
    view.chats?.map((c) => [keyOf(c), c.updatedAt]),
    view.mail?.map((m) => [mailKey(m), m.updatedAt]),
    view.status?.enabled,
    view.status?.last?.at,
    view.status?.readAt,
    view.mailStatus?.enabled,
    view.mailStatus?.last?.at,
    view.mailStatus?.readAt,
    view.status?.agency,
    view.mailStatus?.agency,
    view.error,
    view.scanning,
    selected,
    [...dayOpen],
    [...quietOpen],
    Math.floor(now / 60_000),
  ]);
}

const clock = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const time = (iso: string | null | undefined): number => Date.parse(iso || "") || 0;
const allOff = (view: CommunicationView): boolean => !!view.status && !view.status.enabled && !!view.mailStatus && !view.mailStatus.enabled;
const days = (view: CommunicationView, now: number): CommDay[] => (view.chats || view.mail ? commDays(view.chats || [], view.mail || [], now) : []);

/** The drawer's sub line: today's chats and email, and when they were last read. */
export function communicationSub(view: CommunicationView, now: number): string {
  if (allOff(view)) return "Chat and email summaries are off";
  const today = days(view, now)[0];
  const parts = [today ? `Today: ${commDayLine(today)}` : ""];
  const readAt = [view.status?.readAt, view.mailStatus?.readAt].filter((t): t is string => !!t).sort((a, b) => time(b) - time(a))[0];
  if (view.scanning) parts.push("reading…");
  else if (readAt) parts.push(`read ${clock(readAt)}`);
  return parts.filter(Boolean).join(" · ");
}

/** The picked conversation, or the first that needs you, else the latest day's first. */
function current(view: CommunicationView, now: number): CommsChat | CommsMail | null {
  const all = days(view, now).flatMap((d) => [...d.chats, ...d.mail, ...d.quiet]);
  const picked = selected ? all.find((x) => itemKey(x) === selected) : undefined;
  if (picked) return picked;
  const first = days(view, now).find((d) => d.chats.length || d.mail.length);
  if (!first) return null;
  const top = [...first.chats, ...first.mail];
  return top.find((x) => x.needsYou) || top[0] || null;
}

/** The list half of the drawer: each day, its chats and email. */
export function communicationHtml(view: CommunicationView, now: number): string {
  const html: string[] = [];
  if (view.error) html.push(`<div class="today-note err" data-key="comms-err">Couldn't read the summaries. ${esc(view.error)}</div>`);
  if (allOff(view)) {
    html.push(`
      <div class="today-start" data-key="comms-off">
        <p class="today-start-title">Chat and email summaries are off</p>
        <p>Turn them on to see a line for each Teams chat that moved and each email from people, what needs you first. A small model writes them from the messages, with no tools.</p>
        <button type="button" class="btn sm accent" data-act="comms-settings">${svg("settings")}<span>Settings</span></button>
      </div>`);
    return html.join("");
  }
  const warn = (what: string, s: Status | null, key: string) => {
    const last = s?.last;
    if (s?.enabled && last && !last.ok && last.error) html.push(`<div class="today-note warn" data-key="${key}">${esc(`The last ${what} summaries didn't all come through: ${last.error}`)}</div>`);
  };
  const noAgency = [view.status, view.mailStatus].some((s) => s?.enabled && s.agency === false);
  if (noAgency) {
    html.push(`<div class="today-note warn" data-key="comms-agency">Teams catch-up and email summaries are waiting on Agency, which isn't installed. Install it and the next scan picks up.</div>`);
  } else {
    warn("chat", view.status, "comms-warn");
    warn("email", view.mailStatus, "mail-warn");
  }
  const pending = (view.status?.enabled ? view.status.last?.pending || 0 : 0) + (view.mailStatus?.enabled ? view.mailStatus.last?.pending || 0 : 0);
  if (pending) {
    html.push(`<p class="today-empty comms-pending" data-key="comms-pending"><span class="spinner"></span>${pending} conversation${pending === 1 ? "" : "s"} waiting for a summary</p>`);
  }
  if (!view.chats && !view.mail) {
    html.push(view.error ? "" : `<div class="loading" data-key="comms-loading"><span class="spinner"></span> Loading…</div>`);
    return html.join("");
  }
  const pick = current(view, now);
  const pickKey = pick ? itemKey(pick) : "";
  for (const day of days(view, now)) html.push(dayHtml(day, view, pickKey));
  return html.join("");
}

function dayHtml(day: CommDay, view: CommunicationView, pickKey: string): string {
  const open = dayOpen.get(day.key) ?? day.today;
  const head = `
    <button type="button" class="ld-day" data-key="head" data-act="chat-day" data-day="${esc(day.key)}" data-today="${day.today ? 1 : 0}" aria-expanded="${open}">
      ${svg("chevron")}<span class="ld-day-t">${esc(day.label)}</span><span class="ld-day-d">${esc(day.date)}</span><span class="ld-day-n">${esc(commDayLine(day))}</span>
    </button>`;
  if (!open) return `<section class="ld-group" data-key="day:${esc(day.key)}">${head}</section>`;
  const body: string[] = [];
  const chatsOn = view.status?.enabled !== false;
  const mailOn = view.mailStatus?.enabled !== false;
  const row = (x: CommsChat | CommsMail) => itemHtml(x, pickKey);
  if (day.chats.length) body.push(`<h3 class="ld-kind" data-key="kind:chats">Chats</h3>${day.chats.map(row).join("")}`);
  if (day.mail.length || day.quiet.length) {
    body.push(`<h3 class="ld-kind" data-key="kind:mail">Email</h3>${day.mail.map(row).join("")}`);
    if (day.quiet.length) {
      const shown = quietOpen.has(day.key);
      const n = day.quiet.length;
      body.push(
        `<button type="button" class="ld-quiet" data-key="quiet" data-act="mail-quiet" data-day="${esc(day.key)}" aria-expanded="${shown}">${svg("chevron")}<span>${n} ${day.mail.length ? "more " : ""}email${n === 1 ? "" : "s"} with nothing for you</span></button>`,
      );
      if (shown) body.push(`<div class="ld-quiet-list" data-key="quiet-list">${day.quiet.map(row).join("")}</div>`);
    }
  }
  if (!body.length) {
    const what = chatsOn && mailOn ? "No Teams chats moved and no email from people came" : chatsOn ? "No Teams chats moved" : "No email from people came";
    body.push(`<p class="today-empty" data-key="empty">${what}${day.today ? " yet" : ""}.</p>`);
  }
  return `<section class="ld-group open" data-key="day:${esc(day.key)}">${head}${body.join("")}</section>`;
}

function chipHtml(c: { needsYou: string; importance: string }): string {
  return c.needsYou
    ? `<span class="tchip tone-warn cs-chip">Needs you</span>`
    : c.importance === "high"
      ? `<span class="tchip tone-run cs-chip">Important</span>`
      : "";
}

function itemHtml(x: CommsChat | CommsMail, pickKey: string): string {
  const key = itemKey(x);
  const sel = key === pickKey;
  const title = isChat(x) ? x.title : x.subject;
  return `
    <button type="button" class="ld-item imp-${x.importance}${x.needsYou ? " needs" : ""}${sel ? " sel" : ""}" data-key="item:${esc(key)}" data-chat="${esc(key)}" data-act="chat-select"${sel ? ' aria-current="true"' : ""}>
      <span class="ld-item-h"><b class="ell">${esc(title)}</b><span class="ld-tm">${esc(clock(x.lastAt))}</span></span>
      <span class="ld-item-p">${chipHtml(x)}<span class="ell">${esc(x.summary)}</span></span>
    </button>`;
}

/** The detail half of the drawer: the picked conversation's summary, points and link. */
export function communicationDetailHtml(view: CommunicationView, now: number): string {
  if (allOff(view) || (!view.chats && !view.mail)) return "";
  const x = current(view, now);
  if (!x) return `<p class="today-empty ld-none" data-key="none">Nothing to show yet. A line comes in for each chat that moves and each email from people.</p>`;
  const chat = isChat(x);
  const link = chat
    ? isTeamsLink(x.link)
      ? `<a class="btn sm" href="${esc(x.link)}" target="_blank" rel="noopener" data-act="chat-teams">${svg("chat")}<span>Open in Teams</span></a>`
      : ""
    : isOutlookLink(x.link)
      ? `<a class="btn sm" href="${esc(x.link)}" target="_blank" rel="noopener" data-act="mail-outlook">${svg("mail")}<span>Open in Outlook</span></a>`
      : "";
  const noun = chat ? "message" : "email";
  const who = chat ? chatWho(x) : mailWho(x);
  return `<article class="ld-doc" data-key="doc:${esc(itemKey(x))}">
      <button type="button" class="btn sm ghost ld-back" data-act="ld-back">${svg("back")}<span>All conversations</span></button>
      <h4 class="ld-h">${esc(chat ? x.title : x.subject)}</h4>
      <p class="ld-meta">${chipHtml(x)}<span>${esc([who, `${x.messages} ${noun}${x.messages === 1 ? "" : "s"}`, `last ${clock(x.lastAt)}`].filter(Boolean).join(" · "))}</span></p>
      ${x.needsYou ? `<p class="ld-needs"><span class="rdot tone-warn"></span><span>${esc(x.needsYou)}</span></p>` : ""}
      <p class="ld-sum">${esc(x.summary)}</p>
      ${x.points.length ? `<h5 class="ld-sh">Points</h5><ul class="ld-pts">${x.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
      ${link ? `<div class="ld-acts">${link}</div>` : ""}
      <p class="ld-foot">Written from ${x.messages} ${noun}${x.messages === 1 ? "" : "s"} by a small model.</p>
    </article>`;
}

/** Today's top few for the rail: what needs you first, then the important. */
export function communicationRail(view: CommunicationView, now: number): { html: string; flagged: number } {
  if (allOff(view)) return { html: `<p class="rs-empty">Summaries are off.</p>`, flagged: 0 };
  if (!view.chats && !view.mail) return { html: view.error ? `<p class="rs-empty">Couldn't read them.</p>` : `<p class="rs-empty"><span class="spinner"></span> Loading…</p>`, flagged: 0 };
  const today = days(view, now)[0];
  const items = today ? [...today.chats, ...today.mail].sort((a, b) => rank(a) - rank(b) || time(b.lastAt) - time(a.lastAt)) : [];
  const flagged = items.filter((x) => x.needsYou || x.importance === "high").length;
  if (!items.length) return { html: `<p class="rs-empty">Nothing moved yet today.</p>`, flagged };
  const top = items.slice(0, 3);
  const rows = top
    .map((x) => {
      const key = itemKey(x);
      const name = isChat(x) ? x.title : x.subject;
      const line = x.needsYou || x.summary;
      return `<button type="button" class="rr2" data-key="c:${esc(key)}" data-chat="${esc(key)}" data-act="comms-open">
        <span class="rr-h"><b class="ell">${esc(name)}</b><span class="rr-tm">${esc(clock(x.lastAt))}</span></span>
        <span class="rr-p">${x.needsYou ? `<span class="tchip tone-warn cs-chip">Needs you</span>` : ""}<span class="ell">${esc(line)}</span></span>
      </button>`;
    })
    .join("");
  const more = items.length - top.length;
  return { html: rows + `<button type="button" class="rs-more" data-key="more" data-act="comms-open">${more ? `See all ${items.length}` : "Open"}</button>`, flagged };
}

const rank = (x: CommsChat | CommsMail): number => (x.needsYou ? 0 : x.importance === "high" ? 1 : 2);
