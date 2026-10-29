// The comms bridge's Teams side: which chats moved since the last scan, their new messages,
// and which of those ask the user to review a pull request. Read-only, and no AI: rules
// over the messages the Teams MCP server returns (ListChats, ListChatMessages).
//
// An ask is a message from someone else with an Azure DevOps PR link that is
//   - direct: in a 1:1 chat, or @mentions the user, or names them; or
//   - broad: in a group or meeting chat, asks for a review in so many words, and
//     isn't addressed to someone else (an @mention of another person, not a group).

import { parsePrRefs, type PrRef } from "./jarvis-prs.mjs";
import { McpError, type McpClient } from "./mcp-stdio.mjs";

export interface TeamsMe {
    /** The Entra object id; Teams messages carry the sender's. */
    id: string;
    name: string;
    given: string;
    mail: string;
}

export type ChatKind = "oneOnOne" | "group" | "meeting";

export interface TeamsChat {
    id: string;
    topic: string;
    kind: ChatKind;
    /** When its last message was sent, as Teams says. */
    lastAt: string;
}

export interface TeamsMessage {
    id: string;
    at: string;
    fromId: string;
    fromName: string;
    html: string;
}

export type AskAudience = "direct" | "broad";

/** A message asking the user to review a PR: one per PR it links. */
export interface SeenAsk {
    ref: PrRef;
    chatId: string;
    chatKind: ChatKind;
    chatTopic: string;
    messageId: string;
    at: string;
    fromId: string;
    fromName: string;
    snippet: string;
    link: string;
    audience: AskAudience;
}

export const TEAMS_LIMITS = {
    /** Chats read in one scan; the rest wait for the next (sooner, when some were left). */
    maxChats: 15,
    pageSize: 20,
    /** Pages read from one chat in one scan. */
    maxPages: 3,
    /** How far back a chat seen for the first time is read. */
    firstLookbackMs: 2 * 86_400_000,
    /** However long the app was closed, nothing older than this is read. */
    floorMs: 7 * 86_400_000,
    snippetChars: 280,
    /** A message's text, as its chat's summary reads it. */
    lineChars: 500,
};

const time = (iso: string | null | undefined): number => Date.parse(iso || "") || 0;

/** A chat's kind, from its id: 1:1 chats end in @unq.gbl.spaces, meetings start 19:meeting_. */
export function chatKind(id: string): ChatKind {
    if (/@unq\.gbl\.spaces$/i.test(id)) return "oneOnOne";
    if (/^19:meeting_/i.test(id)) return "meeting";
    return "group";
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
        if (name[0] === "#") {
            const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
        }
        return ENTITIES[name.toLowerCase()] ?? whole;
    });
}

/** A message's HTML as plain text on one line. */
export function htmlToText(html: string): string {
    const text = String(html || "")
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
        .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, " ")
        .replace(/<[^>]*>/g, "");
    return decodeEntities(text).replace(/\s+/g, " ").trim();
}

/** The names a message @mentions, as written in it. */
export function mentionNames(html: string): string[] {
    return [...String(html || "").matchAll(/<at\b[^>]*>([\s\S]*?)<\/at>/gi)].map((m) => htmlToText(m[1])).filter(Boolean);
}

const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** An @mention of the user: their display name or given name, or the start of either. */
export function isMe(name: string, me: TeamsMe): boolean {
    const n = norm(name);
    if (!n) return false;
    const full = norm(me.name);
    const given = norm(me.given || me.name.split(" ")[0] || "");
    return n === full || n === given || (!!full && full.startsWith(`${n} `) && n.length >= 3) || (!!given && n.startsWith(`${given} `));
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The text names the user (their given name or full name, as a word). */
export function namesMe(text: string, me: TeamsMe): boolean {
    const names = [me.name, me.given].map((s) => (s || "").trim()).filter((s) => s.length >= 3);
    return names.some((name) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(name)}($|[^\\p{L}\\p{N}])`, "iu").test(text));
}

const ASK = /\b(review|reviews|reviewing|reviewer|approve|approval|approvals|sign[- ]?off|stamp|take a look|have a look|look at|ptal|eyes on)\b/i;
const GROUP_WORDS = /\b(folks|team|anyone|someone|everyone|all|y'?all|guys|people|reviewers)\b/i;

/** Whether a message asks the user to review its PRs, and how directly. Null when it doesn't. */
export function classifyAsk(message: TeamsMessage, chat: Pick<TeamsChat, "kind">, me: TeamsMe): AskAudience | null {
    if (!message.fromId || message.fromId === me.id) return null;
    const mentions = mentionNames(message.html);
    if (mentions.some((m) => isMe(m, me))) return "direct";
    if (chat.kind === "oneOnOne") return "direct";
    const text = htmlToText(message.html);
    if (namesMe(text, me)) return "direct";
    if (!ASK.test(text)) return null;
    // "@Dana can you review" is for Dana; "@AppConfig folks, reviews please" is for everyone.
    if (mentions.length && !GROUP_WORDS.test(text)) return null;
    return "broad";
}

/** The link that opens a chat message in Teams. */
export function teamsMessageLink(chatId: string, messageId: string): string {
    const context = encodeURIComponent(JSON.stringify({ contextType: "chat" }));
    return `https://teams.microsoft.com/l/message/${encodeURIComponent(chatId)}/${encodeURIComponent(messageId)}?context=${context}`;
}

function clipText(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The asks in one message: one per PR it links, none when it isn't an ask. */
export function asksIn(message: TeamsMessage, chat: TeamsChat, me: TeamsMe): SeenAsk[] {
    const refs = parsePrRefs(message.html);
    if (!refs.length) return [];
    const audience = classifyAsk(message, chat, me);
    if (!audience) return [];
    const snippet = clipText(htmlToText(message.html), TEAMS_LIMITS.snippetChars);
    const link = teamsMessageLink(chat.id, message.id);
    return refs.map((ref) => ({
        ref,
        chatId: chat.id,
        chatKind: chat.kind,
        chatTopic: chat.topic,
        messageId: message.id,
        at: message.at,
        fromId: message.fromId,
        fromName: message.fromName,
        snippet,
        link,
        audience,
    }));
}

// ---- reading Teams ------------------------------------------------------------------

function asChat(raw: any): TeamsChat | null {
    const id = typeof raw?.id === "string" ? raw.id : "";
    const lastAt = String(raw?.lastMessagePreview?.createdDateTime || "");
    if (!id || !time(lastAt)) return null;
    return { id, topic: String(raw?.topic || "").trim(), kind: chatKind(id), lastAt };
}

function asMessage(raw: any): TeamsMessage | null {
    const id = raw?.id != null ? String(raw.id) : "";
    const at = String(raw?.createdDateTime || "");
    if (!id || !time(at)) return null;
    const from = raw?.from?.user ?? raw?.from;
    return {
        id,
        at,
        fromId: typeof from?.id === "string" ? from.id : "",
        fromName: String(from?.displayName || "").trim(),
        html: typeof raw?.body?.content === "string" ? raw.body.content : "",
    };
}

/** The user, from the m365-user server's GetMyDetails. */
export function meFrom(json: any): TeamsMe | null {
    const u = json?.user ?? json;
    if (typeof u?.id !== "string" || !u.id) return null;
    const name = String(u.displayName || "").trim();
    return { id: u.id, name, given: String(u.givenName || "").trim() || name.split(" ")[0] || "", mail: String(u.mail || u.userPrincipalName || "").trim() };
}

export interface TeamsScan {
    asks: SeenAsk[];
    /** When the user last wrote in each chat read. */
    mine: Map<string, string>;
    /** Where each chat read is now read up to. */
    cursors: Map<string, string>;
    calls: number;
    chats: number;
    messages: number;
    /** Chats that moved but wait for the next scan. */
    left: number;
    /** Teams said to slow down; the scan stopped there. */
    throttled: boolean;
    /** Chats that couldn't be read this time, other than throttling. */
    errors: string[];
    /** The new messages of the chats read, as text, for their summaries; meeting chats and system messages aside. */
    lines: ChatLine[];
}

/** A message of a chat that moved, as its day's summary reads it. */
export interface ChatLine {
    chatId: string;
    chatKind: ChatKind;
    chatTopic: string;
    messageId: string;
    at: string;
    fromName: string;
    /** The user wrote it. */
    mine: boolean;
    text: string;
}

const KIND_ORDER: Record<ChatKind, number> = { oneOnOne: 0, group: 1, meeting: 2 };

/**
 * Read what's new in Teams: the chats that moved since their cursors (1:1 chats first, at most
 * maxChats a scan), up to maxPages of each one's newest messages. A chat's cursor moves only
 * when it was read, so throttling or an error loses nothing.
 */
export async function scanTeams(
    client: McpClient,
    me: TeamsMe,
    cursorOf: (chatId: string) => string | null,
    now: number,
    limits = TEAMS_LIMITS,
): Promise<TeamsScan> {
    const out: TeamsScan = { asks: [], mine: new Map(), cursors: new Map(), calls: 0, chats: 0, messages: 0, left: 0, throttled: false, errors: [], lines: [] };
    out.calls++;
    const listed = await client.call("ListChats", {});
    const chats = ((listed.json?.chats ?? []) as unknown[]).map(asChat).filter((c): c is TeamsChat => !!c);
    const sinceOf = (chat: TeamsChat): number => {
        const cursor = time(cursorOf(chat.id));
        return Math.max(cursor || now - limits.firstLookbackMs, now - limits.floorMs);
    };
    const moved = chats
        .filter((c) => time(c.lastAt) > sinceOf(c))
        .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || time(b.lastAt) - time(a.lastAt));
    const now_ = moved.slice(0, limits.maxChats);
    out.left = moved.length - now_.length;

    for (const chat of now_) {
        const since = sinceOf(chat);
        // Kept only once the chat is read through, as its cursor is: a failed read is read again, whole.
        const lines: ChatLine[] = [];
        const line = (m: TeamsMessage, mine: boolean) => {
            if (chat.kind === "meeting" || !m.fromId) return;
            const text = clipText(htmlToText(m.html), limits.lineChars);
            if (text) lines.push({ chatId: chat.id, chatKind: chat.kind, chatTopic: chat.topic, messageId: m.id, at: m.at, fromName: m.fromName, mine, text });
        };
        try {
            let nextLink: string | null = null;
            for (let page = 0; page < limits.maxPages; page++) {
                out.calls++;
                const res = await client.call(
                    "ListChatMessages",
                    nextLink ? { chatId: chat.id, nextLink } : { chatId: chat.id, top: limits.pageSize },
                );
                const raw = (res.json?.messages ?? []) as unknown[];
                const messages = raw.map(asMessage).filter((m): m is TeamsMessage => !!m);
                let older = false;
                for (const m of messages) {
                    if (time(m.at) <= since) {
                        older = true;
                        continue;
                    }
                    out.messages++;
                    if (m.fromId && m.fromId === me.id) {
                        if (time(m.at) > time(out.mine.get(chat.id))) out.mine.set(chat.id, m.at);
                        line(m, true);
                        continue;
                    }
                    line(m, false);
                    out.asks.push(...asksIn(m, chat, me));
                }
                nextLink = typeof res.json?.nextLink === "string" && res.json?.hasMoreResults !== false ? res.json.nextLink : null;
                if (older || !nextLink || !messages.length) break;
            }
            out.chats++;
            out.cursors.set(chat.id, chat.lastAt);
            out.lines.push(...lines);
        } catch (error) {
            if (error instanceof McpError && error.throttled) {
                out.throttled = true;
                out.left += now_.length - now_.indexOf(chat);
                break;
            }
            out.errors.push(`${chat.topic || chat.kind}: ${(error as Error).message}`.slice(0, 300));
        }
    }
    return out;
}
