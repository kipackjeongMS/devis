// The Communication tab, beside Tasks and Meetings: your Teams chats and email, by day. Each
// conversation that moved, and each email thread from people, gets a line, written by a small
// model from its messages: what needs you first, then the important, then the rest. Newsletters
// and FYIs that ask nothing of you fold away under the day's email. Opened, a line shows its
// points and who was in it, and the chat in Teams or the email in Outlook. Today first and open,
// filling in as things move; earlier days fold up under it, two weeks back.

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

type Status = { enabled: boolean; last: ChatsInfo | null; readAt: string | null };

export interface CommunicationView {
  /** Null until they're read. */
  chats: CommsChat[] | null;
  status: Status | null;
  mail: CommsMail[] | null;
  mailStatus: Status | null;
  error: string;
  /** A read asked for from the tab is under way. */
  scanning: boolean;
}

const svg = (name: IconName): string => icon(name);

/** Conversations and threads opened, as "<chat id>|<day>" or "mail:<thread id>|<day>". */
const expanded = new Set<string>();
/** Days opened or folded by hand; otherwise today is open and the rest folded. */
const dayOpen = new Map<string, boolean>();
/** Days whose quiet email is shown. */
const quietOpen = new Set<string>();

const keyOf = (c: Pick<CommsChat, "chatId" | "day">): string => `${c.chatId}|${c.day}`;
const mailKey = (m: Pick<CommsMail, "threadId" | "day">): string => `mail:${m.threadId}|${m.day}`;

export function toggleChat(key: string): void {
  if (expanded.has(key)) expanded.delete(key);
  else expanded.add(key);
}

export function toggleChatDay(key: string, today: boolean): void {
  dayOpen.set(key, !(dayOpen.get(key) ?? today));
}

/** Open a chat's or thread's day, and its day, so it shows when the tab is next drawn; returns its key there. */
export function revealConversation(source: "chat" | "mail", id: string, day: string): string {
  const key = source === "mail" ? mailKey({ threadId: id, day }) : keyOf({ chatId: id, day });
  expanded.add(key);
  dayOpen.set(day, true);
  return key;
}

export function toggleQuietMail(day: string): void {
  if (quietOpen.has(day)) quietOpen.delete(day);
  else quietOpen.add(day);
}

export function pruneCommunicationState(chats: CommsChat[] | null, mail: CommsMail[] | null): void {
  const keys = new Set([...(chats || []).map(keyOf), ...(mail || []).map(mailKey)]);
  // A kind not read yet keeps its keys: a thread opened from Needs you stays open while the chats load first.
  for (const k of [...expanded]) if ((k.startsWith("mail:") ? mail : chats) && !keys.has(k)) expanded.delete(k);
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
    view.error,
    view.scanning,
    [...expanded],
    [...dayOpen],
    [...quietOpen],
    Math.floor(now / 60_000),
  ]);
}

const clock = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const time = (iso: string | null | undefined): number => Date.parse(iso || "") || 0;
const allOff = (view: CommunicationView): boolean => !!view.status && !view.status.enabled && !!view.mailStatus && !view.mailStatus.enabled;

/** The pane's sub line: today's chats and email, and when they were last read. */
export function communicationSub(view: CommunicationView, now: number): string {
  if (allOff(view)) return "Chat and email summaries are off";
  const today = view.chats || view.mail ? commDays(view.chats || [], view.mail || [], now)[0] : null;
  const parts = [today ? `Today: ${commDayLine(today)}` : ""];
  const readAt = [view.status?.readAt, view.mailStatus?.readAt].filter((t): t is string => !!t).sort((a, b) => time(b) - time(a))[0];
  if (view.scanning) parts.push("reading…");
  else if (readAt) parts.push(`read ${clock(readAt)}`);
  return parts.filter(Boolean).join(" · ");
}

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
  warn("chat", view.status, "comms-warn");
  warn("email", view.mailStatus, "mail-warn");
  const pending = (view.status?.enabled ? view.status.last?.pending || 0 : 0) + (view.mailStatus?.enabled ? view.mailStatus.last?.pending || 0 : 0);
  if (pending) {
    html.push(`<p class="today-empty comms-pending" data-key="comms-pending"><span class="spinner"></span>${pending} conversation${pending === 1 ? "" : "s"} waiting for a summary</p>`);
  }
  if (!view.chats && !view.mail) {
    html.push(view.error ? "" : `<div class="loading" data-key="comms-loading"><span class="spinner"></span> Loading…</div>`);
    return html.join("");
  }
  for (const day of commDays(view.chats || [], view.mail || [], now)) html.push(dayHtml(day, view));
  return html.join("");
}

function dayHtml(day: CommDay, view: CommunicationView): string {
  const open = dayOpen.get(day.key) ?? day.today;
  const head = `
    <button type="button" class="comms-day-head" data-key="head" data-act="chat-day" data-day="${esc(day.key)}" data-today="${day.today ? 1 : 0}" aria-expanded="${open}">
      ${svg("chevron")}<span class="comms-day-title">${esc(day.label)}</span><span class="comms-day-date">${esc(day.date)}</span><span class="comms-day-line">${esc(commDayLine(day))}</span>
    </button>`;
  if (!open) return `<section class="comms-day" data-key="day:${esc(day.key)}">${head}</section>`;
  const body: string[] = [];
  const chatsOn = view.status?.enabled !== false;
  const mailOn = view.mailStatus?.enabled !== false;
  if (day.chats.length) body.push(`<h3 class="comms-kind" data-key="kind:chats">${svg("chat")}<span>Chats</span></h3>${day.chats.map(chatHtml).join("")}`);
  if (day.mail.length || day.quiet.length) {
    body.push(`<h3 class="comms-kind" data-key="kind:mail">${svg("mail")}<span>Email</span></h3>${day.mail.map(mailHtml).join("")}`);
    if (day.quiet.length) {
      const shown = quietOpen.has(day.key);
      const n = day.quiet.length;
      body.push(
        `<button type="button" class="comms-quiet" data-key="quiet" data-act="mail-quiet" data-day="${esc(day.key)}" aria-expanded="${shown}">${svg("chevron")}<span>${n} ${day.mail.length ? "more " : ""}email${n === 1 ? "" : "s"} with nothing for you</span></button>`,
      );
      if (shown) body.push(`<div class="comms-quiet-list" data-key="quiet-list">${day.quiet.map(mailHtml).join("")}</div>`);
    }
  }
  if (!body.length) {
    const what = chatsOn && mailOn ? "No Teams chats moved and no email from people came" : chatsOn ? "No Teams chats moved" : "No email from people came";
    body.push(`<p class="today-empty" data-key="empty">${what}${day.today ? " yet" : ""}.</p>`);
  }
  return `<section class="comms-day open" data-key="day:${esc(day.key)}">${head}${body.join("")}</section>`;
}

function chipHtml(c: { needsYou: string; importance: string }): string {
  return c.needsYou
    ? `<span class="tchip tone-warn cs-chip">${svg("warning")}Needs you</span>`
    : c.importance === "high"
      ? `<span class="tchip tone-run cs-chip">Important</span>`
      : "";
}

function bodyHtml(c: { needsYou: string; points: string[]; messages: number; lastAt: string }, noun: string, action: string): string {
  return `<div class="cs-body" data-key="body">
        ${c.needsYou ? `<p class="cs-needs">${svg("warning")}<span>${esc(c.needsYou)}</span></p>` : ""}
        ${c.points.length ? `<ul class="cs-points">${c.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
        <p class="cs-meta">${esc(`${c.messages} ${noun}${c.messages === 1 ? "" : "s"} read · last ${clock(c.lastAt)}`)}</p>
        ${action ? `<div class="meet-actions-row">${action}</div>` : ""}
      </div>`;
}

function chatHtml(c: CommsChat): string {
  const key = keyOf(c);
  const open = expanded.has(key);
  const teams = isTeamsLink(c.link)
    ? `<a class="btn sm ghost" href="${esc(c.link)}" target="_blank" rel="noopener" data-act="chat-teams">${svg("chat")}<span>Open in Teams</span></a>`
    : "";
  return `
    <article class="cs-sum imp-${c.importance}${c.needsYou ? " needs" : ""}${open ? " open" : ""}" data-key="chat:${esc(key)}" data-chat="${esc(key)}">
      <button type="button" class="cs-head" data-key="head" data-act="chat-toggle" aria-expanded="${open}">
        <span class="cs-name">${esc(c.title)}</span>
        <span class="cs-who">${esc(chatWho(c))}</span>
        <span class="cs-end">${chipHtml(c)}<span class="cs-time">${esc(clock(c.lastAt))}</span></span>
      </button>
      <p class="cs-summary" data-key="summary">${esc(c.summary)}</p>
      ${open ? bodyHtml(c, "message", teams) : ""}
    </article>`;
}

function mailHtml(m: CommsMail): string {
  const key = mailKey(m);
  const open = expanded.has(key);
  const outlook = isOutlookLink(m.link)
    ? `<a class="btn sm ghost" href="${esc(m.link)}" target="_blank" rel="noopener" data-act="mail-outlook">${svg("mail")}<span>Open in Outlook</span></a>`
    : "";
  return `
    <article class="cs-sum mail imp-${m.importance}${m.needsYou ? " needs" : ""}${open ? " open" : ""}" data-key="mail:${esc(key)}" data-chat="${esc(key)}">
      <button type="button" class="cs-head" data-key="head" data-act="chat-toggle" aria-expanded="${open}">
        <span class="cs-name">${esc(m.subject)}</span>
        <span class="cs-who">${esc(mailWho(m))}</span>
        <span class="cs-end">${chipHtml(m)}<span class="cs-time">${esc(clock(m.lastAt))}</span></span>
      </button>
      <p class="cs-summary" data-key="summary">${esc(m.summary)}</p>
      ${open ? bodyHtml(m, "email", outlook) : ""}
    </article>`;
}
