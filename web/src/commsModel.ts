// The Meetings and Communication tabs' data: Teams meetings and their recaps, and Teams chats'
// summaries (comms.mts), grouped by day.
// Pure, so the harness can test it.

import type { Todo } from "./jarvisModel.js";

export type RecapState = "upcoming" | "pending" | "ready" | "none" | "noaccess";

export interface MeetingNote {
  title: string;
  text: string;
  points: Array<{ title: string; text: string }>;
}

export interface MeetingAction {
  title: string;
  text: string;
  owner: string;
  /** The user owns it. */
  mine: boolean;
}

/** A Teams meeting and, once Teams wrote it, its recap. */
export interface CommsMeeting {
  id: string;
  subject: string;
  start: string;
  end: string;
  organizer: string;
  attendees: number;
  /** The meeting's chat in Teams, where its recap is. */
  chatLink: string | null;
  state: RecapState;
  notes: MeetingNote[];
  actions: MeetingAction[];
  readyAt: string | null;
  updatedAt: string;
}

/** What the Today poll carries of the meetings: when to read them again, and when each recap came in. */
export interface MeetingsDigest {
  version: string;
  ready: string[];
}

export interface MeetingScanInfo {
  at: string;
  ok: boolean;
  calls: number;
  meetings: number;
  recaps: number;
  pending: number;
  throttled: boolean;
  error: string | null;
}

export interface MeetingDay {
  /** The local date, YYYY-MM-DD. */
  key: string;
  label: string;
  /** "Tue, Oct 27". */
  date: string;
  today: boolean;
  /** The latest first. */
  meetings: CommsMeeting[];
}

const time = (iso: string | null | undefined): number => Date.parse(iso || "") || 0;
const pad = (n: number): string => String(n).padStart(2, "0");

/** A time's local date, YYYY-MM-DD. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function keyDate(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** "Today", "Yesterday", or the weekday. */
export function dayLabel(key: string, now: number): string {
  if (key === dayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday.getTime())) return "Yesterday";
  return keyDate(key).toLocaleDateString(undefined, { weekday: "long" });
}

/** The meetings by day, the latest day first; today is always there, even with none. */
export function meetingDays(meetings: CommsMeeting[], now: number): MeetingDay[] {
  return byDay(meetings, (m) => dayKey(time(m.start)), now).map(({ items, ...day }) => ({
    ...day,
    meetings: [...items].sort((a, b) => time(b.start) - time(a.start) || a.id.localeCompare(b.id)),
  }));
}

/** Items grouped by local day, the latest day first; today is always there. */
function byDay<T>(items: T[], keyOf: (item: T) => string, now: number): Array<{ key: string; label: string; date: string; today: boolean; items: T[] }> {
  const groups = new Map<string, T[]>();
  groups.set(dayKey(now), []);
  for (const item of items) {
    const key = keyOf(item);
    const list = groups.get(key) || [];
    list.push(item);
    groups.set(key, list);
  }
  return [...groups]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([key, list]) => ({
      key,
      label: dayLabel(key, now),
      date: keyDate(key).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
      today: key === dayKey(now),
      items: list,
    }));
}

// ---- chats --------------------------------------------------------------------------

export type Importance = "high" | "normal" | "low";

/** A Teams conversation's day, summarized (comms.mts). */
export interface CommsChat {
  chatId: string;
  /** The local day, YYYY-MM-DD. */
  day: string;
  kind: "oneOnOne" | "group" | "meeting";
  title: string;
  summary: string;
  points: string[];
  importance: Importance;
  /** What someone waits on the user for; empty when nobody does. */
  needsYou: string;
  people: string[];
  messages: number;
  lastAt: string;
  /** The chat in Teams. */
  link: string;
  updatedAt: string;
}

export interface ChatsDigest {
  version: string;
  /** When each important or waiting-on-you conversation last moved. */
  flagged: string[];
}

export interface ChatsInfo {
  at: string;
  ok: boolean;
  summarized: number;
  calls: number;
  pending: number;
  error: string | null;
}

export interface ChatDay {
  key: string;
  label: string;
  date: string;
  today: boolean;
  /** What needs the user first, then the important, then the rest; the latest first in each. */
  chats: CommsChat[];
}

const RANK: Record<Importance, number> = { high: 1, normal: 2, low: 3 };
const chatRank = (c: CommsChat): number => (c.needsYou ? 0 : RANK[c.importance] ?? 2);

/** The conversations by day, the latest day first; today is always there. */
export function chatDays(chats: CommsChat[], now: number): ChatDay[] {
  return byDay(chats, (c) => c.day, now).map(({ items, ...day }) => ({
    ...day,
    chats: [...items].sort((a, b) => chatRank(a) - chatRank(b) || time(b.lastAt) - time(a.lastAt) || a.chatId.localeCompare(b.chatId)),
  }));
}

/** What a day's chats hold, in a line: "6 chats · 2 need you · 1 important". */
export function chatDayLine(day: Pick<ChatDay, "chats">): string {
  const n = day.chats.length;
  if (!n) return "No chats moved";
  const needs = day.chats.filter((c) => c.needsYou).length;
  const high = day.chats.filter((c) => !c.needsYou && c.importance === "high").length;
  return [`${n} chat${n === 1 ? "" : "s"}`, needs ? `${needs} need${needs === 1 ? "s" : ""} you` : "", high ? `${high} important` : ""].filter(Boolean).join(" · ");
}

/** "1:1" or "Group", and who else wrote. */
export function chatWho(c: Pick<CommsChat, "kind" | "people" | "title">): string {
  if (c.kind === "oneOnOne") return "1:1";
  const others = c.people.filter((p) => p !== c.title);
  if (!others.length) return "Group";
  return others.length <= 3 ? others.join(", ") : `${others.slice(0, 3).join(", ")} and ${others.length - 3} more`;
}

/** Only a link into Teams is followed from a summary. */
export const isTeamsLink = (link: string): boolean => /^https:\/\/teams\.microsoft\.com\/l\/chat\/[\w\-.~%]+\/0$/.test(link);

// ---- email --------------------------------------------------------------------------

/** How an email reached the user: sent to them, cc, or through a list. */
export type MailTo = "you" | "cc" | "list";

/** An email thread's day, summarized (comms.mts). */
export interface CommsMail {
  threadId: string;
  /** The local day, YYYY-MM-DD. */
  day: string;
  /** The closest it came to the user that day. */
  to: MailTo;
  subject: string;
  summary: string;
  points: string[];
  importance: Importance;
  needsYou: string;
  /** Who wrote. */
  people: string[];
  messages: number;
  lastAt: string;
  /** The latest message in Outlook on the web; "" when there's none. */
  link: string;
  updatedAt: string;
}

/** Only a link into Outlook on the web is followed from an email's summary. */
export const isOutlookLink = (link: string): boolean => /^https:\/\/outlook\.(office365|office|live)\.com\/(owa|mail)\//.test(link) && link.length < 2000;

/** An email that asks nothing of the user and changes nothing for them: folded away under the rest. */
export const quietMail = (m: Pick<CommsMail, "needsYou" | "importance">): boolean => !m.needsYou && m.importance === "low";

const mailRank = (m: CommsMail): number => (m.needsYou ? 0 : RANK[m.importance] ?? 2);

/** Who wrote, and how it reached the user when that wasn't directly: "Dana Lee", "Dana Lee, Sam Ortiz · cc", "Lee Park · list". */
export function mailWho(m: Pick<CommsMail, "people" | "to">): string {
  const p = m.people;
  const who = p.length <= 2 ? p.join(", ") : `${p.slice(0, 2).join(", ")} and ${p.length - 2} more`;
  const how = m.to === "cc" ? "cc" : m.to === "list" ? "list" : "";
  return [who, how].filter(Boolean).join(" · ");
}

/** A day of the Communication tab: its chats, its email worth a look, and its quiet email. */
export interface CommDay extends ChatDay {
  /** What needs the user first, then the important, then the rest; the latest first in each. */
  mail: CommsMail[];
  /** Newsletters, FYIs and the like: folded. */
  quiet: CommsMail[];
}

/** Chats and email by day, the latest day first; today is always there. */
export function commDays(chats: CommsChat[], mail: CommsMail[], now: number): CommDay[] {
  const isChat = (x: CommsChat | CommsMail): x is CommsChat => "chatId" in x;
  return byDay<CommsChat | CommsMail>([...chats, ...mail], (x) => x.day, now).map(({ items, ...day }) => {
    const threads = items
      .filter((x): x is CommsMail => !isChat(x))
      .sort((a, b) => mailRank(a) - mailRank(b) || time(b.lastAt) - time(a.lastAt) || a.threadId.localeCompare(b.threadId));
    return {
      ...day,
      chats: items.filter(isChat).sort((a, b) => chatRank(a) - chatRank(b) || time(b.lastAt) - time(a.lastAt) || a.chatId.localeCompare(b.chatId)),
      mail: threads.filter((m) => !quietMail(m)),
      quiet: threads.filter(quietMail),
    };
  });
}

/** What a day holds, in a line: "6 chats · 3 emails · 2 need you · 1 important". */
export function commDayLine(day: Pick<CommDay, "chats" | "mail" | "quiet">): string {
  const chats = day.chats.length;
  const emails = day.mail.length + day.quiet.length;
  if (!chats && !emails) return "Nothing yet";
  const all: Array<{ needsYou: string; importance: Importance }> = [...day.chats, ...day.mail];
  const needs = all.filter((c) => c.needsYou).length;
  const high = all.filter((c) => !c.needsYou && c.importance === "high").length;
  return [
    chats ? `${chats} chat${chats === 1 ? "" : "s"}` : "",
    emails ? `${emails} email${emails === 1 ? "" : "s"}` : "",
    needs ? `${needs} need${needs === 1 ? "s" : ""} you` : "",
    high ? `${high} important` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

const clock = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** "9:30 AM – 10:00 AM". */
export function meetingTime(m: Pick<CommsMeeting, "start" | "end">): string {
  return `${clock(time(m.start))} – ${clock(time(m.end))}`;
}

/** What a meeting's chip says of its recap, in a word or two, with more in its tooltip. */
export function recapChip(m: Pick<CommsMeeting, "state" | "start" | "notes" | "actions">, now: number): { text: string; tone: string; title: string } {
  switch (m.state) {
    case "ready":
      return { text: "Recap", tone: "ok", title: `${m.notes.length} note${m.notes.length === 1 ? "" : "s"}, ${m.actions.length} action item${m.actions.length === 1 ? "" : "s"}` };
    case "pending":
      return { text: "Recap pending", tone: "run", title: "Teams writes the recap a few minutes after the meeting ends. It shows here when it does." };
    case "noaccess":
      return { text: "No access", tone: "idle", title: "Teams doesn't let you read this meeting's recap." };
    case "none":
      return { text: "No recap", tone: "idle", title: "Teams wrote no recap: the meeting wasn't transcribed, or Copilot didn't summarize it." };
    default:
      return time(m.start) > now
        ? { text: "Upcoming", tone: "idle", title: `Starts at ${clock(time(m.start))}.` }
        : { text: "In progress", tone: "run", title: "The recap comes after it ends." };
  }
}

/** What a day holds, in a line: "4 meetings · 3 recaps · 2 for you". */
export function dayLine(day: Pick<MeetingDay, "meetings">): string {
  const n = day.meetings.length;
  if (!n) return "No Teams meetings";
  const recaps = day.meetings.filter((m) => m.state === "ready").length;
  const mine = day.meetings.reduce((sum, m) => sum + m.actions.filter((a) => a.mine).length, 0);
  return [`${n} meeting${n === 1 ? "" : "s"}`, recaps ? `${recaps} recap${recaps === 1 ? "" : "s"}` : "", mine ? `${mine} for you` : ""].filter(Boolean).join(" · ");
}

/** Recaps that came in after the user last looked at the tab. */
export function unseenRecaps(ready: string[] | undefined, seen: number): number {
  return (ready || []).filter((at) => time(at) > seen).length;
}

/** The key a to-do made from a meeting's action item carries (comms.mts addMeetingTodo). */
export const actionKey = (meetingId: string, index: number): string => `meet:${meetingId}:${index}`;

/** The to-do made from an action item, open ones first. */
export function actionTodo(todos: Todo[] | undefined, meetingId: string, index: number): Todo | undefined {
  const key = actionKey(meetingId, index);
  const made = (todos || []).filter((t) => t.source?.key === key);
  return made.find((t) => !t.done) || made[0];
}

/** The action items in the order the card lists them: the user's first, each with its index in the recap. */
export function orderedActions(m: Pick<CommsMeeting, "actions">): Array<MeetingAction & { index: number }> {
  return m.actions.map((a, index) => ({ ...a, index })).sort((a, b) => Number(b.mine) - Number(a.mine) || a.index - b.index);
}
