// The comms bridge's email: the mail from people in the user's Focused inbox, read through the
// Mail MCP server (`agency mcp mail`), for the Communication tab's daily summaries. Code picks
// what's worth reading; a small model summarizes each thread's day later (comms-chats.mts).
//
// Graph through the MCP tool caps a response at 51,200 bytes, and automated mail carries huge
// bodies, so the inbox is listed without bodies, oldest first from where the last read stopped,
// and only the threads with mail from people are read for text: one call per thread, each
// message's own part (uniqueBody, without the quoted history), the user's replies included.
// The user's Sent Items are listed too, so a reply in a thread already summarized is read.
// Read-only: nothing is marked read, moved or sent.

import { McpError, type McpClient } from "./mcp-stdio.mjs";
import { isOutlookLink, outlookMessageLink } from "./outlook-link.mjs";

export { isOutlookLink };
import type { TeamsMe } from "./comms-teams.mjs";

export const MAIL_LIMITS = {
    /** Messages a page of the inbox listing (about 1.5 KB each without a body). */
    pageSize: 20,
    /** Pages of the inbox a read; the rest waits for the next. */
    pages: 5,
    /** Sent Items: a page, at most two. */
    sentPageSize: 25,
    sentPages: 2,
    /** Threads read for their text a read; the rest waits for the next. */
    threads: 12,
    /** Messages of one thread a page, and pages; a thread not read through waits for the next read. */
    threadTop: 10,
    threadPages: 3,
    /** One message's text kept for its summary. */
    textChars: 1500,
    subjectChars: 160,
    /** Never further back than this, however long the app was closed. */
    maxBackMs: 2 * 86_400_000,
};

/** How a message reached the user. */
export type MailTo = "you" | "cc" | "list";

/** A message in the inbox listing. */
export interface MailMessage {
    id: string;
    threadId: string;
    subject: string;
    fromAddr: string;
    fromName: string;
    at: string;
    to: MailTo;
    /** Outlook put it in Focused (not Other). */
    focused: boolean;
    /** A meeting invite or reply: the calendar's, not the inbox's. */
    invite: boolean;
    /** The message in Outlook, by its id (Graph's webLink no longer opens). */
    link: string;
}

/** A message kept for its thread's summary. */
export interface MailLine {
    threadId: string;
    messageId: string;
    at: string;
    subject: string;
    fromName: string;
    mine: boolean;
    to: MailTo;
    text: string;
    link: string;
}

export interface MailScan {
    lines: MailLine[];
    /** Where the inbox and Sent Items are read up to now; null where nothing moved them. */
    cursors: { inbox: string | null; sent: string | null };
    calls: number;
    /** Inbox messages listed. */
    messages: number;
    /** Threads read for their text. */
    threads: number;
    /** Threads left for the next read. */
    left: number;
    /** The inbox or Sent Items had more than a read's pages: the rest waits for the next read. */
    more: boolean;
    throttled: boolean;
    errors: string[];
}

const time = (iso: string | null | undefined): number => Date.parse(iso || "") || 0;
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
/** Graph's filter takes a UTC time without fractions. */
const odataTime = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

/** A subject without its Re:/Fw: and [External] prefixes. */
export function cleanSubject(subject: unknown): string {
    const s = (typeof subject === "string" ? subject : "")
        .replace(/\s+/g, " ")
        .replace(/^\s*((re|fw|fwd|aw|wg|sv|vs)\s*:\s*|\[external\]\s*)+/i, "")
        .trim();
    return clip(s, MAIL_LIMITS.subjectChars);
}

/** A message's text for the model: one line, the safety banners and phone signatures gone, clipped. */
export function mailText(content: unknown, max = MAIL_LIMITS.textChars): string {
    const t = (typeof content === "string" ? content : "")
        .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, "")
        .replace(/You don't often get email from [^\n]*?Learn why this is important\.?/gi, "")
        .replace(/^\s*\[external[^\]\n]*\]\s*$/gim, "")
        .replace(/^\s*Sent from (my |Outlook)[^\n]*$/gim, "")
        .replace(/\s+/g, " ")
        .trim();
    return clip(t, max);
}

// Mail no person wrote: no-reply and notification senders, and services that mail on their own.
const AUTOMATED_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|noreply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|automated|auto-?reply|azuredevops|vsts|msonlineservicesteam|microsoft365|office365|onedrive|sharepoint\w*|yammer|viva\w*|calendar|workflows?|digest|newsletters?|news|marketing|updates?)([._+-]|$)/;
const AUTOMATED_ANYWHERE = /no-?reply|do-?not-?reply|donotreply|(^|[._-])(alerts?|notifications?|notify|automated|bounces?)$/;
const AUTOMATED_DOMAIN = /(^|\.)(engage\.mail\.microsoft|email\.teams\.microsoft\.com|mail\.microsoft|microsoftonline\.com|sharepointonline\.com|bounce\.[a-z.]+)$/;
/** A bulk sender's subdomain ("news.brand.com", "e.brand.com"): people write from the company's own domain. */
const BULK_SUBDOMAIN = /^(news|newsletters?|e|em|email|mail|mailer|mailing|info|marketing|mkt|go|reply|notifications?|updates?|offers?|promo)\.[a-z0-9-]+\.[a-z]{2,}$/;

/** Whether a sender is a system, not a person. */
export function isAutomated(address: string): boolean {
    const a = address.toLowerCase();
    const at = a.lastIndexOf("@");
    if (at < 1) return !a.startsWith("/o="); // an Exchange-internal address is a person
    const local = a.slice(0, at);
    const domain = a.slice(at + 1);
    return AUTOMATED_ANYWHERE.test(local) || AUTOMATED_LOCAL.test(local) || AUTOMATED_DOMAIN.test(domain) || BULK_SUBDOMAIN.test(domain);
}

const sameAddress = (a: unknown, me: TeamsMe): boolean => typeof a === "string" && !!me.mail && a.toLowerCase() === me.mail.toLowerCase();

/** Whether the user sent it: their address, or their name on an Exchange-internal address. */
export function fromMe(address: string, name: string, me: TeamsMe): boolean {
    if (sameAddress(address, me)) return true;
    return !!me.name && name === me.name && !address.includes("@");
}

const recipientsHaveMe = (list: unknown, me: TeamsMe): boolean => Array.isArray(list) && list.some((r) => sameAddress(r?.emailAddress?.address, me));

/** A message from Graph's listing, checked; null when it isn't one. */
export function mailFrom(raw: any): Omit<MailMessage, "to"> & { toRecipients: unknown; ccRecipients: unknown } | null {
    if (typeof raw?.id !== "string" || !raw.id || typeof raw.conversationId !== "string" || !raw.conversationId) return null;
    const at = typeof raw.receivedDateTime === "string" ? raw.receivedDateTime : "";
    if (!time(at)) return null;
    const fromAddr = String(raw.from?.emailAddress?.address || "").trim().toLowerCase();
    return {
        id: raw.id,
        threadId: raw.conversationId,
        subject: cleanSubject(raw.subject),
        fromAddr,
        fromName: String(raw.from?.emailAddress?.name || "").replace(/\s+/g, " ").trim() || fromAddr,
        at,
        focused: raw.inferenceClassification !== "other",
        invite: /eventMessage/i.test(String(raw["@odata.type"] || "")),
        link: outlookMessageLink(raw.id),
        toRecipients: raw.toRecipients,
        ccRecipients: raw.ccRecipients,
    };
}

/** The listing's message for the user: how it reached them. */
export function asMail(raw: any, me: TeamsMe): MailMessage | null {
    const m = mailFrom(raw);
    if (!m) return null;
    const { toRecipients, ccRecipients, ...rest } = m;
    return { ...rest, to: recipientsHaveMe(toRecipients, me) ? "you" : recipientsHaveMe(ccRecipients, me) ? "cc" : "list" };
}

/** Mail worth a summary: from a person who isn't the user, in Focused, and not a meeting invite. */
export function isCandidate(m: MailMessage, me: TeamsMe): boolean {
    return m.focused && !m.invite && !!m.fromAddr && !fromMe(m.fromAddr, m.fromName, me) && !isAutomated(m.fromAddr);
}

/** Graph's conversation ids are URL-safe base64; anything else isn't put in a filter. */
const SAFE_ID = /^[A-Za-z0-9=_-]{8,512}$/;

const TOO_BIG = /exceeds the maximum allowed size|response size/i;
const isTooBig = (e: unknown): boolean => e instanceof McpError && !e.throttled && TOO_BIG.test(e.message);

/** A page of a search's messages. */
async function search(client: McpClient, query: string): Promise<any[]> {
    const res = await client.call("SearchMessagesQueryParameters", { queryParameters: query, preferTextBody: true });
    let raw = res.json?.rawResponse ?? res.json;
    if (typeof raw === "string") {
        try {
            raw = JSON.parse(raw);
        } catch {
            raw = null;
        }
    }
    const value = raw?.value ?? res.json?.value;
    if (!Array.isArray(value)) throw new McpError("SearchMessagesQueryParameters: the answer had no messages list");
    return value;
}

const LIST_SELECT = "id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,inferenceClassification";
const LIST_SELECT_LEAN = "id,conversationId,subject,from,receivedDateTime,inferenceClassification";

/**
 * Messages from a time on, oldest first, `where` they are (a folder; a thread up to a time): a
 * page at a time from the last one read (the same time read again, its messages skipped),
 * smaller pages when one is too big for the tool, then the lean select. The time goes first in
 * the filter: Graph sorts by it only then. `more` when the pages ran out first.
 */
export async function listSince(
    client: McpClient,
    where: string,
    sinceMs: number,
    opts: { select: string; leanSelect?: string; pageSize: number; pages: number },
    count: () => void,
): Promise<{ messages: any[]; more: boolean }> {
    const out: any[] = [];
    const seen = new Set<string>();
    // Each page goes on from the last one's time, so the time is always read.
    const withTime = (s: string) => (s.split(",").includes("receivedDateTime") ? s : `${s},receivedDateTime`);
    let since = sinceMs;
    let top = opts.pageSize;
    let select = withTime(opts.select);
    const lean = opts.leanSelect ? withTime(opts.leanSelect) : null;
    let strict = false;
    for (let page = 0; page < opts.pages; ) {
        const query = `?$filter=receivedDateTime ${strict ? "gt" : "ge"} ${odataTime(since)} and ${where}&$orderby=receivedDateTime asc&$select=${select}&$top=${top}`;
        let value: any[];
        try {
            count();
            value = await search(client, query);
        } catch (error) {
            if (!isTooBig(error)) throw error;
            if (top > 1) top = Math.max(1, Math.floor(top / 2));
            else if (lean && select !== lean) select = lean;
            else throw error;
            continue;
        }
        page++;
        const fresh = value.filter((m) => typeof m?.id === "string" && !seen.has(m.id));
        for (const m of fresh) seen.add(m.id);
        out.push(...fresh);
        if (value.length < top) return { messages: out, more: false };
        const last = time(value[value.length - 1]?.receivedDateTime);
        // A whole page at one time: step past it rather than read it forever.
        strict = !fresh.length || last === time(value[0]?.receivedDateTime);
        since = last || since;
    }
    return { messages: out, more: true };
}

export const folderIs = (folder: "inbox" | "sentitems"): string => `parentFolderId eq '${folder}'`;

/**
 * One thread's messages between two times, oldest first, each with its own text; a body too big
 * is read as its preview. `more` when its pages ran out before the end. An id that isn't
 * Graph's is never put in a filter: nothing is read.
 */
export async function readThread(
    client: McpClient,
    threadId: string,
    sinceMs: number,
    untilMs: number,
    limits = MAIL_LIMITS,
    count: () => void = () => undefined,
): Promise<{ texts: Map<string, { fromAddr: string; fromName: string; at: string; text: string }>; more: boolean }> {
    const texts = new Map<string, { fromAddr: string; fromName: string; at: string; text: string }>();
    if (!SAFE_ID.test(threadId)) return { texts, more: false };
    const { messages, more } = await listSince(
        client,
        `receivedDateTime le ${odataTime(untilMs)} and conversationId eq '${threadId}'`,
        sinceMs,
        { select: "id,from,receivedDateTime,uniqueBody", leanSelect: "id,from,receivedDateTime,bodyPreview", pageSize: limits.threadTop, pages: limits.threadPages },
        count,
    );
    for (const m of messages) {
        texts.set(m.id, {
            fromAddr: String(m.from?.emailAddress?.address || "").toLowerCase(),
            fromName: String(m.from?.emailAddress?.name || "").trim(),
            at: String(m.receivedDateTime || ""),
            text: mailText(m.uniqueBody?.content ?? m.bodyPreview ?? "", limits.textChars),
        });
    }
    return { texts, more };
}

/** Where a folder is read from: its cursor, or the start of yesterday the first time; never more than two days back. */
export function readFrom(cursor: string | null, now: number, limits = MAIL_LIMITS): number {
    const floor = now - limits.maxBackMs;
    if (cursor && time(cursor)) return Math.max(time(cursor), floor);
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 1);
    return Math.max(d.getTime(), floor);
}

/**
 * Read the mail that came since the last read: the inbox's mail from people, each thread's new
 * messages with their text, and the user's replies in those threads and in the threads already
 * summarized (`known`). A message already kept (`kept`) is skipped. A thread whose new messages
 * weren't all read (more of it than a read's pages) waits for the next read; one that couldn't be
 * read is kept with its subjects only; throttling stops the read, and the rest waits. The cursors
 * are held at the first message of a thread that waits, so it's listed again.
 */
export async function scanMail(
    client: McpClient,
    me: TeamsMe,
    cursors: { inbox: string | null; sent: string | null },
    known: (threadId: string) => boolean,
    kept: (messageId: string) => boolean,
    now: number,
    limits = MAIL_LIMITS,
): Promise<MailScan> {
    const out: MailScan = { lines: [], cursors: { inbox: null, sent: null }, calls: 0, messages: 0, threads: 0, left: 0, more: false, throttled: false, errors: [] };
    const count = () => void out.calls++;
    let inbox: { messages: any[]; more: boolean };
    let sent: { messages: any[]; more: boolean };
    try {
        inbox = await listSince(client, folderIs("inbox"), readFrom(cursors.inbox, now, limits), { select: LIST_SELECT, leanSelect: LIST_SELECT_LEAN, pageSize: limits.pageSize, pages: limits.pages }, count);
        sent = await listSince(client, folderIs("sentitems"), readFrom(cursors.sent, now, limits), { select: "id,conversationId,receivedDateTime,subject", pageSize: limits.sentPageSize, pages: limits.sentPages }, count);
    } catch (error) {
        if (error instanceof McpError && error.throttled) {
            out.throttled = true;
            return out;
        }
        throw error;
    }
    const listed = inbox.messages.map((r) => asMail(r, me)).filter((m): m is MailMessage => !!m);
    out.messages = listed.length;
    out.more = inbox.more || sent.more;
    const lastInbox = listed.reduce<string | null>((a, m) => (!a || time(m.at) > time(a) ? m.at : a), null);
    const sentRows = sent.messages.filter((r) => typeof r?.id === "string" && typeof r.conversationId === "string" && time(r.receivedDateTime));
    const lastSent = sentRows.reduce<string | null>((a, r) => (!a || time(r.receivedDateTime) > time(a) ? r.receivedDateTime : a), null);

    interface Thread {
        id: string;
        mail: MailMessage[];
        sent: Array<{ id: string; at: string; subject: string }>;
        /** The thread is read between these: its first and last new message. */
        since: number;
        until: number;
    }
    const threads = new Map<string, Thread>();
    const thread = (id: string, at: string): Thread => {
        let t = threads.get(id);
        if (!t) threads.set(id, (t = { id, mail: [], sent: [], since: Infinity, until: 0 }));
        t.since = Math.min(t.since, time(at));
        t.until = Math.max(t.until, time(at));
        return t;
    };
    for (const m of listed) {
        if (!isCandidate(m, me) || kept(m.id)) continue;
        thread(m.threadId, m.at).mail.push(m);
    }
    for (const r of sentRows) {
        if (kept(r.id) || !(threads.has(r.conversationId) || known(r.conversationId))) continue;
        thread(r.conversationId, r.receivedDateTime).sent.push({ id: r.id, at: r.receivedDateTime, subject: cleanSubject(r.subject) });
    }
    const order = [...threads.values()].sort((a, b) => a.since - b.since);
    const now_ = order.slice(0, limits.threads);
    const left = order.slice(limits.threads);

    for (const [i, t] of now_.entries()) {
        let texts: Awaited<ReturnType<typeof readThread>>["texts"];
        let more = false;
        try {
            const read = await readThread(client, t.id, t.since - 1000, t.until + 1000, limits, count);
            texts = read.texts;
            more = read.more;
            out.threads++;
        } catch (error) {
            if (error instanceof McpError && error.throttled) {
                out.throttled = true;
                left.unshift(...now_.slice(i));
                break;
            }
            out.errors.push(`${t.mail[0]?.subject || t.sent[0]?.subject || "a thread"}: ${(error as Error).message}`.slice(0, 300));
            texts = new Map();
        }
        const subject = t.mail[0]?.subject || t.sent.find((x) => x.subject)?.subject || "";
        // Not read through (oldest first): what wasn't reached waits for the next read, the cursor held
        // at it, rather than lose its text; what was read is kept, so each read gets further.
        const waiting = new Set(more ? [...t.mail, ...t.sent].filter((m) => !texts.has(m.id)).map((m) => m.id) : []);
        if (waiting.size) left.push({ ...t, mail: t.mail.filter((m) => waiting.has(m.id)), sent: t.sent.filter((m) => waiting.has(m.id)) });
        for (const m of t.mail) {
            if (waiting.has(m.id)) continue;
            out.lines.push({ threadId: t.id, messageId: m.id, at: m.at, subject: m.subject, fromName: m.fromName, mine: false, to: m.to, text: texts.get(m.id)?.text || "", link: m.link });
        }
        // The user's own messages in the thread: those listed in Sent Items, and any the thread read shows.
        const mine = new Map(t.sent.filter((x) => !waiting.has(x.id)).map((x) => [x.id, x.at]));
        for (const [id, m] of texts) if (fromMe(m.fromAddr, m.fromName, me) && !kept(id)) mine.set(id, m.at || mine.get(id) || "");
        for (const [id, at] of mine) {
            if (!time(at) || out.lines.some((l) => l.messageId === id)) continue;
            out.lines.push({ threadId: t.id, messageId: id, at, subject, fromName: me.name, mine: true, to: "you", text: texts.get(id)?.text || "", link: "" });
        }
    }
    out.left = left.length;
    // The cursors stop at the first message of a thread left, so it's listed again next time.
    const firstLeft = (pick: (t: Thread) => Array<{ at: string }>) =>
        left.flatMap(pick).reduce<string | null>((a, x) => (!a || time(x.at) < time(a) ? x.at : a), null);
    const hold = (last: string | null, first: string | null) => (first && (!last || time(first) <= time(last)) ? first : last);
    out.cursors.inbox = hold(lastInbox, firstLeft((t) => t.mail));
    out.cursors.sent = hold(lastSent, firstLeft((t) => t.sent));
    return out;
}
