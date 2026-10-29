// The comms bridge: what Teams asks of the user, and what their meetings said, kept and
// shown in the Workspace. A scan (every 30 minutes while the service runs, once soon after
// it starts, and on Scan now) reads the Teams chats that moved through the Teams MCP
// server, finds the messages asking the user to review a pull request (comms-teams.mts),
// and keeps one open ask per PR with who asked. Needs you shows the open asks. The same
// scan reads yesterday's and today's Teams meetings from the calendar (Calendar MCP) and
// each ended one's recap, as Teams' Copilot wrote it (comms-meetings.mts); the
// Meetings tab shows them by day. Chats that moved, and the inbox's mail from people
// (Mail MCP, comms-mail.mts), are summarized per conversation and day by a small model
// with no tools (comms-chats.mts) for the Communication tab.
//
// An ask closes by itself when the user voted or commented on the PR, the PR closed,
// the user answered in that 1:1 chat, or a week went by; or when the user dismisses it.
// Read-only: the bridge never sends, reacts or marks anything read. It keeps who asked,
// a short snippet and the links; never whole messages. Meetings keep their recap's notes
// and action items for two weeks.

import { createHash } from "node:crypto";
import { getMe, getPrThreads, getPullRequestById, type Pr } from "./ado.mjs";
import { readConfig } from "./config.mjs";
import { jarvisDb, JarvisError } from "./jarvis-store.mjs";
import { snapshotOf } from "./jarvis-prs.mjs";
import { addTodo, type Todo } from "./jarvis-notes.mjs";
import { McpError, openMcp, type McpClient } from "./mcp-stdio.mjs";
import { meFrom, scanTeams, TEAMS_LIMITS, type AskAudience, type ChatKind, type ChatLine, type SeenAsk, type TeamsMe, type TeamsScan } from "./comms-teams.mjs";
import { CHAT_BRIEF, CHAT_LIMITS, MAIL_BRIEF, chatPrompt, mailPrompt, packInputs, parseSummaries, summarizeWithCopilot, type ChatInput, type ChatSummary, type Importance } from "./comms-chats.mjs";
import { MAIL_LIMITS, scanMail, type MailLine, type MailScan, type MailTo } from "./comms-mail.mjs";
import { openableOutlookLink } from "./outlook-link.mjs";
import {
    MEETING_LIMITS,
    listMeetings,
    readRecap,
    type CalendarMeeting,
    type MeetingAction,
    type MeetingNote,
    type Recap,
    type RecapState,
} from "./comms-meetings.mjs";

export const COMMS_LIMITS = {
    everyMs: 30 * 60_000,
    /** The first scan after the service starts, once Copilot is up. */
    firstMs: 20_000,
    /** When chats were left for the next scan. */
    soonMs: 2 * 60_000,
    /** While a meeting that ended waits for its recap. */
    recapSoonMs: 10 * 60_000,
    /** A meeting's recap is looked for this long after it ends (a scan lands then). */
    afterMeetingMs: 5 * 60_000,
    /** After throttling: doubles each time, up to the max. */
    backoffMs: 60 * 60_000,
    maxBackoffMs: 2 * 60 * 60_000,
    /** An open ask nobody touched closes after this. */
    expireMs: 7 * 86_400_000,
    /** Closed asks are kept this long, so a re-read message doesn't open them again. */
    keepClosedMs: 14 * 86_400_000,
    /** Meetings, with their recaps, are kept this long. */
    keepMeetingsMs: 14 * 86_400_000,
    /** A chat message's row is kept this long after it's summarized, so it's never summarized twice. */
    chatLinesKeepMs: 3 * 86_400_000,
    /** A chat message that couldn't be summarized in this long is let go. */
    chatPendingMaxMs: 2 * 86_400_000,
    /** Each scan reads the calendar from this many days before today. */
    meetingDaysBack: 1,
    /** ADO is asked about an open ask's PR at most this often. */
    checkPrMs: 25 * 60_000,
    prChecksPerScan: 10,
    /** Who asked, newest first, per ask. */
    askers: 6,
    /** Who the user is, read again after this. */
    meMs: 7 * 86_400_000,
    /** A chat or email thread that waits on the user shows under Needs you while its ask is this many days old or newer. */
    needDays: 7,
};

export interface CommsAsker {
    name: string;
    chatKind: ChatKind;
    chatTopic: string;
    messageId: string;
    at: string;
    snippet: string;
    link: string;
    audience: AskAudience;
}

/** One PR someone asked the user to review in Teams, while it's open. */
export interface CommsAsk {
    id: number;
    org: string;
    prId: number;
    project: string;
    repo: string;
    repoId: string;
    title: string;
    author: string;
    created: string;
    isDraft: boolean;
    url: string;
    /** Direct when anyone asked the user personally. */
    audience: AskAudience;
    openedAt: string;
    updatedAt: string;
    /** Newest first. */
    askers: CommsAsker[];
}

export interface CommsScanInfo {
    at: string;
    ok: boolean;
    calls: number;
    chats: number;
    messages: number;
    /** New asks and new askers on open ones. */
    found: number;
    /** Chats left for the next scan. */
    left: number;
    throttled: boolean;
    error: string | null;
}

export interface CommsStatus {
    enabled: boolean;
    scanning: boolean;
    last: CommsScanInfo | null;
    nextAt: string | null;
    meetings: { enabled: boolean; last: MeetingScanInfo | null };
    chats: { enabled: boolean; last: ChatsInfo | null };
    mail: { enabled: boolean; last: MailScanInfo | null; summaries: ChatsInfo | null };
}

/** What the last read of the inbox did. */
export interface MailScanInfo {
    at: string;
    ok: boolean;
    calls: number;
    /** Inbox messages listed. */
    messages: number;
    /** Threads with mail from people read for their text. */
    threads: number;
    /** Messages kept for a summary. */
    found: number;
    /** Threads left for the next read. */
    left: number;
    /** More of the inbox than a read's pages: the next read comes soon. */
    more?: boolean;
    throttled: boolean;
    error: string | null;
}

/** An email thread's day, as the Communication tab shows it. */
export interface CommsMail {
    threadId: string;
    /** The local day, YYYY-MM-DD. */
    day: string;
    /** The closest it came to the user that day: sent to them, cc, or through a list. */
    to: MailTo;
    subject: string;
    summary: string;
    points: string[];
    importance: Importance;
    needsYou: string;
    /** Who wrote, as far as was read. */
    people: string[];
    messages: number;
    lastAt: string;
    /** The latest message in Outlook on the web; "" when there's none. */
    link: string;
    updatedAt: string;
}

/** What the last round of chat summaries did. */
export interface ChatsInfo {
    at: string;
    ok: boolean;
    /** Conversations summarized. */
    summarized: number;
    /** Model calls made. */
    calls: number;
    /** Conversations still waiting for a summary. */
    pending: number;
    error: string | null;
}

/** A Teams conversation's day, as the Communication tab shows it. */
export interface CommsChat {
    chatId: string;
    /** The local day, YYYY-MM-DD. */
    day: string;
    kind: ChatKind;
    title: string;
    summary: string;
    points: string[];
    importance: Importance;
    needsYou: string;
    /** Who else wrote, as far as was read. */
    people: string[];
    messages: number;
    lastAt: string;
    /** The chat in Teams. */
    link: string;
    updatedAt: string;
}

/** What the Today poll carries of the chats: when to read them again, and when flagged ones last moved (the tab's badge). */
export interface ChatsDigest {
    version: string;
    flagged: string[];
}

export interface MeetingScanInfo {
    at: string;
    ok: boolean;
    calls: number;
    /** Teams meetings on the calendar yesterday and today. */
    meetings: number;
    /** Recaps that came in this scan. */
    recaps: number;
    /** Meetings that ended and still wait for a recap. */
    pending: number;
    /** How long until the next of today's meetings ends (a scan then finds its recap sooner); null when none is left. */
    nextEndMs: number | null;
    throttled: boolean;
    error: string | null;
}

/** A Teams meeting, as the Meetings tab shows it. */
export interface CommsMeeting {
    id: string;
    subject: string;
    start: string;
    end: string;
    organizer: string;
    attendees: number;
    chatLink: string | null;
    state: RecapState;
    notes: MeetingNote[];
    actions: MeetingAction[];
    readyAt: string | null;
    updatedAt: string;
}

/** What the Today poll carries of the meetings: enough to know when to read them again, and for the tab's badge. */
export interface MeetingsDigest {
    version: string;
    /** When each recap of the last two weeks came in. */
    ready: string[];
}

// ---- where the data comes from ------------------------------------------------------

/** Teams, ADO and the clock, as the module sees them. The harness swaps in a fake. */
export interface CommsRuntime {
    now(): number;
    open(server: "teams" | "m365-user" | "calendar" | "mail"): Promise<McpClient>;
    /** A PR by its number, as ADO returns it; null when it isn't there. */
    pr(org: string, prId: number): Promise<any | null>;
    /** Every comment on a PR, system ones (votes) included: who wrote it and when. */
    threads(org: string, projectId: string, repoId: string, prId: number): Promise<Array<{ authorId?: string; published?: string }>>;
    /** The user's ADO identity in an org. */
    adoMe(org: string): Promise<{ id: string }>;
    orgs(): Promise<string[]>;
    /** A small model's answer to a prompt, under a brief, in a session with no tools. */
    summarize(prompt: string, brief: string): Promise<string>;
}

const sdkRuntime: CommsRuntime = {
    now: () => Date.now(),
    open: (server) => openMcp(server),
    pr: getPullRequestById,
    threads: getPrThreads,
    adoMe: getMe,
    orgs: async () => (await readConfig()).organizations || [],
    summarize: summarizeWithCopilot,
};

let runtime: CommsRuntime = sdkRuntime;

export function setCommsRuntime(next: CommsRuntime | null): void {
    runtime = next || sdkRuntime;
}

const iso = (ms = runtime.now()): string => new Date(ms).toISOString();
const time = (value: string | null | undefined): number => Date.parse(value || "") || 0;

// ---- storage ------------------------------------------------------------------------

let schemaReady: Promise<void> | null = null;

async function db() {
    const d = await jarvisDb();
    schemaReady ??= Promise.resolve().then(() => {
        d.exec(`
            CREATE TABLE IF NOT EXISTS comms_asks (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                org         TEXT NOT NULL,
                pr_id       INTEGER NOT NULL,
                project     TEXT NOT NULL DEFAULT '',
                repo        TEXT NOT NULL DEFAULT '',
                repo_id     TEXT NOT NULL DEFAULT '',
                title       TEXT NOT NULL DEFAULT '',
                author      TEXT NOT NULL DEFAULT '',
                created     TEXT NOT NULL DEFAULT '',
                is_draft    INTEGER NOT NULL DEFAULT 0,
                url         TEXT NOT NULL DEFAULT '',
                checked_at  TEXT,
                state       TEXT NOT NULL DEFAULT 'open',
                note        TEXT,
                opened_at   TEXT NOT NULL,
                updated_at  TEXT NOT NULL,
                closed_at   TEXT,
                askers_json TEXT NOT NULL DEFAULT '[]'
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_comms_asks_open ON comms_asks(org, pr_id) WHERE state = 'open';
            CREATE TABLE IF NOT EXISTS comms_cursors (key TEXT PRIMARY KEY, at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS comms_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS comms_meetings (
                id           TEXT PRIMARY KEY,
                subject      TEXT NOT NULL DEFAULT '',
                start_at     TEXT NOT NULL,
                end_at       TEXT NOT NULL,
                organizer    TEXT NOT NULL DEFAULT '',
                attendees    INTEGER NOT NULL DEFAULT 0,
                join_url     TEXT NOT NULL DEFAULT '',
                chat_link    TEXT,
                state        TEXT NOT NULL DEFAULT 'upcoming',
                insight_id   TEXT,
                notes_json   TEXT NOT NULL DEFAULT '[]',
                actions_json TEXT NOT NULL DEFAULT '[]',
                checked_at   TEXT,
                tries        INTEGER NOT NULL DEFAULT 0,
                ready_at     TEXT,
                listed_at    TEXT,
                updated_at   TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_comms_meetings_start ON comms_meetings(start_at);
            -- A chat message read for its day's summary. Its text is kept only until it's summarized;
            -- the row stays a few days after, so a message read again isn't summarized twice.
            CREATE TABLE IF NOT EXISTS comms_chat_lines (
                chat_id    TEXT NOT NULL,
                message_id TEXT NOT NULL,
                day        TEXT NOT NULL,
                at         TEXT NOT NULL,
                chat_kind  TEXT NOT NULL,
                chat_topic TEXT NOT NULL DEFAULT '',
                from_name  TEXT NOT NULL DEFAULT '',
                mine       INTEGER NOT NULL DEFAULT 0,
                text       TEXT NOT NULL DEFAULT '',
                state      TEXT NOT NULL DEFAULT 'pending',
                queued_at  TEXT NOT NULL,
                tries      INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (chat_id, message_id)
            );
            CREATE INDEX IF NOT EXISTS idx_comms_chat_lines_state ON comms_chat_lines(state, at);
            CREATE TABLE IF NOT EXISTS comms_chat_days (
                chat_id     TEXT NOT NULL,
                day         TEXT NOT NULL,
                kind        TEXT NOT NULL,
                title       TEXT NOT NULL,
                summary     TEXT NOT NULL,
                points_json TEXT NOT NULL DEFAULT '[]',
                importance  TEXT NOT NULL DEFAULT 'normal',
                needs_you   TEXT NOT NULL DEFAULT '',
                people_json TEXT NOT NULL DEFAULT '[]',
                messages    INTEGER NOT NULL DEFAULT 0,
                last_at     TEXT NOT NULL,
                link        TEXT NOT NULL,
                updated_at  TEXT NOT NULL,
                PRIMARY KEY (chat_id, day)
            );
            -- Email threads, kept like chats (the same columns, so one summarizer serves both):
            -- chat_id is the thread, chat_kind how a message reached the user (you, cc, list),
            -- chat_topic its subject, link the message in Outlook on the web.
            CREATE TABLE IF NOT EXISTS comms_mail_lines (
                chat_id    TEXT NOT NULL,
                message_id TEXT NOT NULL,
                day        TEXT NOT NULL,
                at         TEXT NOT NULL,
                chat_kind  TEXT NOT NULL,
                chat_topic TEXT NOT NULL DEFAULT '',
                from_name  TEXT NOT NULL DEFAULT '',
                mine       INTEGER NOT NULL DEFAULT 0,
                text       TEXT NOT NULL DEFAULT '',
                link       TEXT NOT NULL DEFAULT '',
                state      TEXT NOT NULL DEFAULT 'pending',
                queued_at  TEXT NOT NULL,
                tries      INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (chat_id, message_id)
            );
            CREATE INDEX IF NOT EXISTS idx_comms_mail_lines_state ON comms_mail_lines(state, at);
            CREATE INDEX IF NOT EXISTS idx_comms_mail_lines_message ON comms_mail_lines(message_id);
            CREATE TABLE IF NOT EXISTS comms_mail_days (
                chat_id     TEXT NOT NULL,
                day         TEXT NOT NULL,
                kind        TEXT NOT NULL,
                title       TEXT NOT NULL,
                summary     TEXT NOT NULL,
                points_json TEXT NOT NULL DEFAULT '[]',
                importance  TEXT NOT NULL DEFAULT 'normal',
                needs_you   TEXT NOT NULL DEFAULT '',
                people_json TEXT NOT NULL DEFAULT '[]',
                messages    INTEGER NOT NULL DEFAULT 0,
                last_at     TEXT NOT NULL,
                link        TEXT NOT NULL,
                updated_at  TEXT NOT NULL,
                PRIMARY KEY (chat_id, day)
            );
        `);
        const lineCols = d.prepare("PRAGMA table_info(comms_chat_lines)").all() as Array<{ name: string }>;
        if (!lineCols.some((c) => c.name === "tries")) d.exec("ALTER TABLE comms_chat_lines ADD COLUMN tries INTEGER NOT NULL DEFAULT 0");
    });
    await schemaReady;
    return d;
}

/** For tests that swap the database underneath. */
export function resetCommsSchema(): void {
    schemaReady = null;
}

async function readState<T>(key: string, fallback: T): Promise<T> {
    const row = (await db()).prepare("SELECT value FROM comms_state WHERE key = ?").get(key) as { value: string } | undefined;
    if (!row) return fallback;
    try {
        return JSON.parse(row.value) as T;
    } catch {
        return fallback;
    }
}

async function writeState(key: string, value: unknown): Promise<void> {
    (await db()).prepare("INSERT INTO comms_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
}

type Row = Record<string, unknown>;

function parseAskers(value: unknown): CommsAsker[] {
    try {
        const list = JSON.parse(String(value || "[]"));
        return Array.isArray(list) ? (list as CommsAsker[]) : [];
    } catch {
        return [];
    }
}

const toAsk = (r: Row): CommsAsk => {
    const askers = parseAskers(r.askers_json);
    return {
        id: Number(r.id),
        org: String(r.org),
        prId: Number(r.pr_id),
        project: String(r.project || ""),
        repo: String(r.repo || ""),
        repoId: String(r.repo_id || ""),
        title: String(r.title || ""),
        author: String(r.author || ""),
        created: String(r.created || ""),
        isDraft: Number(r.is_draft) === 1,
        url: String(r.url || ""),
        audience: askers.some((a) => a.audience === "direct") ? "direct" : "broad",
        openedAt: String(r.opened_at),
        updatedAt: String(r.updated_at),
        askers,
    };
};

/** The open asks, the oldest first. */
export async function openAsks(): Promise<CommsAsk[]> {
    const rows = (await db()).prepare("SELECT * FROM comms_asks WHERE state = 'open' ORDER BY opened_at, id").all() as Row[];
    return rows.map(toAsk);
}

/**
 * Keep what a scan saw. A message already kept (a chat read twice) changes nothing; a new one
 * joins its PR's open ask, or opens one. A PR whose ask closed after the message was sent stays
 * closed. Returns how many asks opened or got a new asker.
 */
export async function recordAsks(seen: SeenAsk[], orgs: string[]): Promise<number> {
    const d = await db();
    const known = new Set(orgs.map((o) => o.toLowerCase()));
    let changed = 0;
    const at = iso();
    // Oldest first, so an ask's askers end up newest first.
    for (const s of [...seen].sort((a, b) => time(a.at) - time(b.at))) {
        // A broad ask about a PR outside the user's organizations is someone else's business.
        if (s.audience === "broad" && !known.has(s.ref.org)) continue;
        const rows = d.prepare("SELECT * FROM comms_asks WHERE org = ? AND pr_id = ? ORDER BY id DESC LIMIT 5").all(s.ref.org, s.ref.prId) as Row[];
        if (rows.some((r) => r.note === OWN_PR || parseAskers(r.askers_json).some((a) => a.messageId === s.messageId))) continue;
        const asker: CommsAsker = {
            name: s.fromName || "Someone",
            chatKind: s.chatKind,
            chatTopic: s.chatTopic,
            messageId: s.messageId,
            at: s.at,
            snippet: s.snippet,
            link: s.link,
            audience: s.audience,
        };
        const open = rows.find((r) => r.state === "open");
        if (open) {
            const askers = [asker, ...parseAskers(open.askers_json)].sort((a, b) => time(b.at) - time(a.at)).slice(0, COMMS_LIMITS.askers);
            d.prepare("UPDATE comms_asks SET askers_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(askers), at, Number(open.id));
            changed++;
            continue;
        }
        if (rows.some((r) => r.state !== "open" && time(String(r.closed_at || "")) >= time(s.at))) continue;
        if (runtime.now() - time(s.at) > COMMS_LIMITS.expireMs) continue;
        d.prepare(
            "INSERT INTO comms_asks (org, pr_id, project, repo, opened_at, updated_at, askers_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(s.ref.org, s.ref.prId, s.ref.project, s.ref.repo, s.at, at, JSON.stringify([asker]));
        changed++;
    }
    return changed;
}

async function closeAsk(id: number, state: "done" | "dismissed", note: string): Promise<void> {
    const at = iso();
    (await db()).prepare("UPDATE comms_asks SET state = ?, note = ?, closed_at = ?, updated_at = ? WHERE id = ? AND state = 'open'").run(state, note, at, at, id);
}

/** The user dismissed an ask: it leaves Needs you, and a to-do made from it ticks. */
export async function dismissAsk(id: unknown): Promise<void> {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw new JarvisError("Unknown ask.", 404);
    const row = (await db()).prepare("SELECT state FROM comms_asks WHERE id = ?").get(n) as { state: string } | undefined;
    if (!row) throw new JarvisError("That ask is gone.", 404);
    await closeAsk(n, "dismissed", "dismissed");
}

// ---- closing asks -------------------------------------------------------------------
//
// An ask closes on something that happened after it was asked: a vote or comment of the user's
// on the PR newer than the newest ask (so "addressed your comments, please look again" after a
// "waiting for author" vote still shows), the PR closing, the user's reply in that 1:1 chat, a
// week going by, or the user dismissing it. Whether the user ever voted or commented says
// nothing about a newer ask.

/** The note on an ask about the user's own PR; later messages about that PR aren't asks either. */
const OWN_PR = "your own PR";

/**
 * What the PR's state says about an ask, whenever it was asked: closed, the user's own, or approved
 * by them. A standing approval leaves nothing to do ("need one more approval" after they approved);
 * a push that resets votes takes it back to 0. A -5, a -10 or a comment only answers asks it came after.
 */
function prVerdict(pr: { status?: string; authoredByMe?: boolean; myVote?: number }): { state: "done" | "dismissed"; note: string } | null {
    if (pr.authoredByMe) return { state: "dismissed", note: OWN_PR };
    const status = String(pr.status || "active").toLowerCase();
    if (status !== "active") return { state: "done", note: `the PR was ${status}` };
    if ((pr.myVote || 0) > 0) return { state: "done", note: "you approved the PR" };
    return null;
}

/** When the newest ask was made. */
const lastAsked = (ask: CommsAsk): number => Math.max(time(ask.openedAt), ...ask.askers.map((a) => time(a.at)));

function fillPr(id: number, s: { project: string; repo: string; repoId: string; title: string; author: string; created: string; isDraft: boolean; url: string }) {
    return db().then((d) =>
        d
            .prepare("UPDATE comms_asks SET project = ?, repo = ?, repo_id = ?, title = ?, author = ?, created = ?, is_draft = ?, url = ? WHERE id = ?")
            .run(s.project, s.repo, s.repoId, s.title, s.author, s.created, s.isDraft ? 1 : 0, s.url, id),
    );
}

/**
 * Fill in the asks' PRs from the page's list of the user's PRs, and close the ones about their own
 * or closed PRs. Cheap (no network): every Today poll runs it. The list is as old as the page's last
 * load, so its votes and comments close nothing: an approval there may since have been reset by a
 * push ("please re-approve"). ADO's current vote (settleWithAdo) and the user's own votes in the
 * app (answerAsks) do that.
 */
export async function settleWithPrs(prs: ReadonlyArray<Pr> | null): Promise<number> {
    if (!prs?.length) return 0;
    const byKey = new Map(prs.map((p) => [`${p.org.toLowerCase()}|${p.id}`, p]));
    let closed = 0;
    for (const ask of await openAsks()) {
        const pr = byKey.get(`${ask.org}|${ask.prId}`);
        if (!pr) continue;
        if (!ask.repoId && pr.repoId) {
            await fillPr(ask.id, {
                project: pr.project || "",
                repo: pr.repo || "",
                repoId: pr.repoId,
                title: pr.title,
                author: pr.author || "",
                created: pr.created,
                isDraft: !!pr.isDraft,
                url: pr.url,
            });
        }
        const verdict = prVerdict({ status: pr.status, authoredByMe: pr.authoredByMe });
        if (verdict) {
            await closeAsk(ask.id, verdict.state, verdict.note);
            closed++;
        }
    }
    return closed;
}

/**
 * The user voted or commented on PRs in the app just now: that answers any open ask about them.
 * Returns how many closed.
 */
export async function answerAsks(refs: ReadonlyArray<{ org?: string | null; prId: string | number }>, note: string): Promise<number> {
    let closed = 0;
    const open = await openAsks();
    for (const ref of refs) {
        const org = String(ref.org || "").toLowerCase();
        for (const ask of open) {
            if (ask.prId !== Number(ref.prId) || (org && ask.org !== org)) continue;
            await closeAsk(ask.id, "done", note);
            closed++;
        }
    }
    return closed;
}

/**
 * Ask ADO about the open asks' PRs not checked lately: fills them in, and closes the ones whose PR
 * closed, is the user's own, or got a vote or comment of the user's after the newest ask.
 */
async function settleWithAdo(): Promise<void> {
    const d = await db();
    const due = (await openAsks())
        .filter((a) => {
            const row = d.prepare("SELECT checked_at FROM comms_asks WHERE id = ?").get(a.id) as { checked_at: string | null } | undefined;
            return runtime.now() - time(row?.checked_at) >= COMMS_LIMITS.checkPrMs;
        })
        .slice(0, COMMS_LIMITS.prChecksPerScan);
    for (const ask of due) {
        d.prepare("UPDATE comms_asks SET checked_at = ? WHERE id = ?").run(iso(), ask.id);
        let raw: any;
        try {
            raw = await runtime.pr(ask.org, ask.prId);
        } catch {
            continue;
        }
        if (!raw) continue;
        const s = snapshotOf(ask.org, raw);
        await fillPr(ask.id, s);
        const me = await runtime.adoMe(ask.org).catch(() => null);
        const myVote = me ? Number(((raw.reviewers || []) as any[]).find((r) => r?.id === me.id)?.vote) || 0 : 0;
        const verdict = prVerdict({ status: s.status, authoredByMe: !!me && raw?.createdBy?.id === me.id, myVote });
        if (verdict) {
            await closeAsk(ask.id, verdict.state, verdict.note);
            continue;
        }
        if (!me || !s.projectId || !s.repoId) continue;
        // A vote shows in the threads as a system comment by the voter, with its time.
        const comments = await runtime.threads(ask.org, s.projectId, s.repoId, ask.prId).catch(() => null);
        const latest = Math.max(0, ...(comments || []).filter((c) => c.authorId === me.id).map((c) => time(c.published)));
        if (latest > lastAsked(ask)) await closeAsk(ask.id, "done", "you responded on the PR");
    }
}

/** Close the asks the user answered in their 1:1 chat (the scan's read of it says when they last wrote). */
async function settleReplies(mine: ReadonlyMap<string, string>): Promise<void> {
    for (const ask of await openAsks()) {
        // Only a 1:1 chat: in a group, a later message of the user's may be about anything.
        const replied = ask.askers.some((a) => {
            if (a.chatKind !== "oneOnOne") return false;
            const chatId = chatIdOf(a.link);
            return !!chatId && time(mine.get(chatId)) > time(a.at);
        });
        if (replied) await closeAsk(ask.id, "done", "you answered in Teams");
    }
}

/** Close the asks nobody repeated for a week. */
async function expireAsks(): Promise<void> {
    for (const ask of await openAsks()) {
        if (runtime.now() - lastAsked(ask) > COMMS_LIMITS.expireMs) await closeAsk(ask.id, "done", "asked over a week ago");
    }
}

/** What closes asks without reading Teams: a week going by, and the PRs in ADO. Runs whether Teams could be read or not. */
async function settleAsks(): Promise<void> {
    await expireAsks();
    await settleWithAdo();
}

function chatIdOf(link: string): string | null {
    const m = /\/l\/message\/([^/]+)\//.exec(link);
    if (!m) return null;
    try {
        return decodeURIComponent(m[1]);
    } catch {
        return null;
    }
}

/** Closed asks past keeping, cursors of chats not read in as long, and meetings older than two weeks. */
export async function pruneComms(now = runtime.now()): Promise<number> {
    const d = await db();
    const before = new Date(now - COMMS_LIMITS.keepClosedMs).toISOString();
    const asks = d.prepare("DELETE FROM comms_asks WHERE state <> 'open' AND closed_at < ?").run(before);
    const cursors = d.prepare("DELETE FROM comms_cursors WHERE at < ?").run(before);
    const meetings = d.prepare("DELETE FROM comms_meetings WHERE start_at < ?").run(new Date(now - COMMS_LIMITS.keepMeetingsMs).toISOString());
    if (Number(meetings.changes)) await bumpMeetingsVersion();
    const chats = (await pruneStream(CHATS, now)) + (await pruneStream(MAIL, now));
    return Number(asks.changes) + Number(cursors.changes) + Number(meetings.changes) + chats;
}

// ---- meetings -------------------------------------------------------------------------

function parseList<T>(value: unknown): T[] {
    try {
        const list = JSON.parse(String(value || "[]"));
        return Array.isArray(list) ? (list as T[]) : [];
    } catch {
        return [];
    }
}

const toMeeting = (r: Row, now = runtime.now()): CommsMeeting => {
    const stored = String(r.state) as RecapState;
    // Ended, and not looked at yet: it's waiting for its recap.
    const state = stored === "upcoming" && time(String(r.end_at)) <= now ? "pending" : stored;
    return {
        id: String(r.id),
        subject: String(r.subject || ""),
        start: String(r.start_at),
        end: String(r.end_at),
        organizer: String(r.organizer || ""),
        attendees: Number(r.attendees) || 0,
        chatLink: typeof r.chat_link === "string" && r.chat_link ? r.chat_link : null,
        state,
        notes: parseList<MeetingNote>(r.notes_json),
        actions: parseList<MeetingAction>(r.actions_json),
        readyAt: typeof r.ready_at === "string" ? r.ready_at : null,
        updatedAt: String(r.updated_at),
    };
};

const asCalendarMeeting = (r: Row): CalendarMeeting => ({
    id: String(r.id),
    subject: String(r.subject || ""),
    start: String(r.start_at),
    end: String(r.end_at),
    organizer: String(r.organizer || ""),
    attendees: Number(r.attendees) || 0,
    joinUrl: String(r.join_url || ""),
    chatLink: typeof r.chat_link === "string" ? r.chat_link : null,
});

/** The meetings of the last two weeks, the latest first. */
export async function listCommsMeetings(): Promise<CommsMeeting[]> {
    const now = runtime.now();
    const rows = (await db())
        .prepare("SELECT * FROM comms_meetings WHERE start_at >= ? ORDER BY start_at DESC, id")
        .all(new Date(now - COMMS_LIMITS.keepMeetingsMs).toISOString()) as Row[];
    return rows.map((r) => toMeeting(r, now));
}

/** What the Today poll carries of the meetings. */
export async function meetingsDigest(): Promise<MeetingsDigest> {
    const d = await db();
    const since = new Date(runtime.now() - COMMS_LIMITS.keepMeetingsMs).toISOString();
    const ready = d.prepare("SELECT ready_at FROM comms_meetings WHERE ready_at IS NOT NULL AND start_at >= ? ORDER BY ready_at").all(since) as Array<{ ready_at: string }>;
    return { version: String(await readState<number>("meetings.version", 0)), ready: ready.map((r) => r.ready_at) };
}

/** Something the Meetings tab shows changed: its version moves on, and the page reads them again. */
async function bumpMeetingsVersion(): Promise<void> {
    await writeState("meetings.version", (await readState<number>("meetings.version", 0)) + 1);
}

/**
 * Keep what the calendar lists from `from` to `to`: new meetings, and changes to known ones (which
 * bump their version). A meeting no longer listed there that has no recap yet was cancelled or
 * moved away: it goes.
 */
export async function saveMeetings(listed: CalendarMeeting[], from: string, to: string): Promise<void> {
    const d = await db();
    const at = iso();
    const put = d.prepare(`
        INSERT INTO comms_meetings (id, subject, start_at, end_at, organizer, attendees, join_url, chat_link, state, listed_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'upcoming', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            updated_at = CASE WHEN subject <> excluded.subject OR start_at <> excluded.start_at OR end_at <> excluded.end_at
                OR organizer <> excluded.organizer OR attendees <> excluded.attendees THEN excluded.updated_at ELSE updated_at END,
            subject = excluded.subject, start_at = excluded.start_at, end_at = excluded.end_at, organizer = excluded.organizer,
            attendees = excluded.attendees, join_url = excluded.join_url, chat_link = excluded.chat_link, listed_at = excluded.listed_at`);
    for (const m of listed) put.run(m.id, m.subject, m.start, m.end, m.organizer, m.attendees, m.joinUrl, m.chatLink, at, at);
    const ids = listed.map((m) => m.id);
    const gone = d.prepare(
        `DELETE FROM comms_meetings WHERE start_at >= ? AND start_at < ? AND state IN ('upcoming', 'pending')
         AND id NOT IN (SELECT value FROM json_each(?))`,
    ).run(from, to, JSON.stringify(ids));
    const { touched } = d.prepare("SELECT count(*) AS touched FROM comms_meetings WHERE updated_at = ?").get(at) as { touched: number };
    if (Number(touched) || Number(gone.changes)) await bumpMeetingsVersion();
}

/**
 * Meetings that ended and are due a look for their recap: those still waiting first, the latest
 * first, then ready ones whose wait isn't over (a restarted transcription adds a part). One that
 * kept failing for three days has none.
 */
async function dueMeetings(now: number): Promise<Array<{ meeting: CalendarMeeting; known: string[] | null }>> {
    const d = await db();
    const rows = d
        .prepare(
            `SELECT * FROM comms_meetings WHERE end_at <= ? AND (state IN ('upcoming', 'pending') OR (state = 'ready' AND end_at > ?))
             ORDER BY CASE WHEN state = 'ready' THEN 1 ELSE 0 END, end_at DESC`,
        )
        .all(new Date(now).toISOString(), new Date(now - MEETING_LIMITS.recapWaitMs).toISOString()) as Row[];
    const due: Array<{ meeting: CalendarMeeting; known: string[] | null }> = [];
    for (const r of rows) {
        const ready = r.state === "ready";
        if (!ready && now - time(String(r.end_at)) > MEETING_LIMITS.giveUpMs) {
            await saveRecap(String(r.id), { state: "none", insightIds: [], notes: [], actions: [], calls: 0 }, false);
            continue;
        }
        if (now - time(r.checked_at as string | null) < (ready ? MEETING_LIMITS.readyRecheckMs : MEETING_LIMITS.recheckMs)) continue;
        if (due.length >= MEETING_LIMITS.checksPerScan) continue;
        const known = ready ? String(r.insight_id || "").split(",").filter(Boolean) : null;
        due.push({ meeting: asCalendarMeeting(r), known });
    }
    return due;
}

/**
 * Keep what a look for a recap found. A failed look, or one that found the same recap, only notes
 * when it looked. Returns whether a recap came in.
 */
async function saveRecap(id: string, recap: Recap, looked = true): Promise<boolean> {
    const d = await db();
    const at = iso();
    const before = d.prepare("SELECT state, notes_json, actions_json FROM comms_meetings WHERE id = ?").get(id) as Row | undefined;
    if (!before) return false;
    if (recap.failed || recap.unchanged) {
        d.prepare("UPDATE comms_meetings SET checked_at = ?, tries = tries + 1 WHERE id = ?").run(at, id);
        return false;
    }
    const notes = JSON.stringify(recap.notes);
    const actions = JSON.stringify(recap.actions);
    const changed = before.state !== recap.state || before.notes_json !== notes || before.actions_json !== actions;
    d.prepare(
        `UPDATE comms_meetings SET state = ?, insight_id = ?, notes_json = ?, actions_json = ?,
            checked_at = CASE WHEN ? THEN ? ELSE checked_at END, tries = tries + ?,
            ready_at = CASE WHEN ? = 'ready' AND ready_at IS NULL THEN ? ELSE ready_at END,
            updated_at = CASE WHEN ? THEN ? ELSE updated_at END
         WHERE id = ?`,
    ).run(
        recap.state,
        recap.insightIds.join(",") || null,
        notes,
        actions,
        looked ? 1 : 0,
        at,
        looked ? 1 : 0,
        recap.state,
        at,
        changed ? 1 : 0,
        at,
        id,
    );
    if (changed) await bumpMeetingsVersion();
    return before.state !== "ready" && recap.state === "ready";
}

/** Read the calendar and the recaps that are due. Throws when the calendar couldn't be read at all. */
async function scanMeetingsOnce(): Promise<MeetingScanInfo> {
    const at = iso();
    const me = await whoAmI();
    const now = runtime.now();
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    // Calendar days, not 24-hour steps: a day can be 23 or 25 hours long.
    const fromDay = new Date(day);
    fromDay.setDate(fromDay.getDate() - COMMS_LIMITS.meetingDaysBack);
    const toDay = new Date(day);
    toDay.setDate(toDay.getDate() + 1);
    const from = fromDay.toISOString();
    const to = toDay.toISOString();
    const client = await runtime.open("calendar");
    let calls = 1;
    let recaps = 0;
    let throttled = false;
    let listed: CalendarMeeting[] = [];
    try {
        listed = await listMeetings(client, from, to);
        await saveMeetings(listed, from, to);
        for (const { meeting, known } of await dueMeetings(now)) {
            try {
                const recap = await readRecap(client, meeting, me, now, known);
                calls += recap.calls;
                if (await saveRecap(meeting.id, recap)) recaps++;
            } catch (error) {
                if (error instanceof McpError && error.throttled) {
                    throttled = true;
                    break;
                }
                throw error;
            }
        }
    } finally {
        client.close();
    }
    const d = await db();
    const { pending } = d
        .prepare("SELECT count(*) AS pending FROM comms_meetings WHERE state IN ('upcoming', 'pending') AND end_at <= ? AND end_at > ?")
        .get(new Date(now).toISOString(), new Date(now - MEETING_LIMITS.recapWaitMs).toISOString()) as { pending: number };
    const nextEnd = listed.map((m) => time(m.end)).filter((t) => t > now).sort((a, b) => a - b)[0];
    return {
        at,
        ok: !throttled,
        calls,
        meetings: listed.length,
        recaps,
        pending: Number(pending),
        nextEndMs: nextEnd ? nextEnd - now : null,
        throttled,
        error: throttled ? "Teams asked to slow down; the rest waits for the next scan." : null,
    };
}

/**
 * Make one of a meeting's action items a to-do: what to do, and the meeting it came from (its chat
 * in Teams). Asked again while that to-do is open, it gives the same one back.
 */
export async function addMeetingTodo(id: unknown, index: unknown): Promise<Todo> {
    const key = typeof id === "string" && /^[0-9a-f]{24}$/.test(id) ? id : "";
    const i = Number(index);
    if (!key || !Number.isInteger(i) || i < 0) throw new JarvisError("Unknown action item.", 404);
    const row = (await db()).prepare("SELECT * FROM comms_meetings WHERE id = ?").get(key) as Row | undefined;
    if (!row) throw new JarvisError("That meeting is gone.", 404);
    const m = toMeeting(row);
    const action = m.actions[i];
    if (!action) throw new JarvisError("That action item is gone.", 404);
    const what = (action.title && action.text && action.text !== action.title ? `${action.title}: ${action.text}` : action.title || action.text).replace(/\s+/g, " ").trim();
    const subject = m.subject.length > 120 ? `${m.subject.slice(0, 119).trimEnd()}…` : m.subject;
    const text = `${what.length > 340 ? `${what.slice(0, 339).trimEnd()}…` : what} (from ${subject})`;
    return addTodo(text, "you", {
        key: `meet:${key}:${i}`,
        taskTitle: m.subject,
        who: "meeting",
        ...(m.chatLink ? { link: m.chatLink } : {}),
    });
}

// ---- chats ----------------------------------------------------------------------------

/** A time's local day, YYYY-MM-DD: a conversation's summary is per day, the user's day. */
function localDay(at: string): string {
    const d = new Date(at);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A chat in Teams. */
export const chatLink = (chatId: string): string => `https://teams.microsoft.com/l/chat/${encodeURIComponent(chatId)}/0`;

/** A conversation's name: a group's topic; for a 1:1, the other person; else who wrote. */
export function chatTitle(kind: ChatKind, topic: string, people: readonly string[]): string {
    const t = topic.replace(/\s+/g, " ").trim();
    if (kind !== "oneOnOne" && t) return t.length > 120 ? `${t.slice(0, 119).trimEnd()}…` : t;
    if (kind === "oneOnOne") return people[0] || "1:1 chat";
    if (!people.length) return "Group chat";
    if (people.length <= 2) return people.join(" and ");
    const more = people.length - 2;
    return `${people.slice(0, 2).join(", ")} and ${more} other${more === 1 ? "" : "s"}`;
}

/** Keep the new messages of the chats read, for their summaries. One already kept (read again) is left alone. Returns how many were new. */
export async function queueChatLines(lines: readonly ChatLine[]): Promise<number> {
    const d = await db();
    const at = iso();
    const put = d.prepare(
        `INSERT OR IGNORE INTO comms_chat_lines (chat_id, message_id, day, at, chat_kind, chat_topic, from_name, mine, text, state, queued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    );
    let added = 0;
    for (const l of lines) added += Number(put.run(l.chatId, l.messageId, localDay(l.at), l.at, l.chatKind, l.chatTopic, l.fromName, l.mine ? 1 : 0, l.text, at).changes);
    return added;
}

/** Keep the new messages of the email threads read, for their summaries. One already kept is left alone. Returns how many were new. */
export async function queueMailLines(lines: readonly MailLine[]): Promise<number> {
    const d = await db();
    const at = iso();
    const put = d.prepare(
        `INSERT OR IGNORE INTO comms_mail_lines (chat_id, message_id, day, at, chat_kind, chat_topic, from_name, mine, text, link, state, queued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    );
    let added = 0;
    for (const l of lines) added += Number(put.run(l.threadId, l.messageId, localDay(l.at), l.at, l.to, l.subject, l.fromName, l.mine ? 1 : 0, l.text, l.link, at).changes);
    return added;
}

const clockOf = (at: string): string => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** A conversation's day waiting for its summary: a chat's or an email thread's. */
interface Group {
    chatId: string;
    day: string;
    kind: string;
    topic: string;
    lines: Row[];
    tries: number;
}

/**
 * What's summarized, and how: Teams chats, or email threads. Their tables have the same columns
 * (for mail, chat_id is the thread, chat_kind how it reached the user, chat_topic the subject).
 */
interface Stream {
    name: "chats" | "mail";
    lines: "comms_chat_lines" | "comms_mail_lines";
    days: "comms_chat_days" | "comms_mail_days";
    brief: string;
    prompt(inputs: ChatInput[]): string;
    /** The day's name, kind and link, from its new lines and what was kept of it. */
    describe(g: Group, people: string[], prev: Row | undefined): { title: string; kind: string; link: string };
    /** A line as the model reads it. */
    message(l: Row): ChatInput["messages"][number];
    /** The line kept when the model never manages a summary. */
    givenUp: string;
}

const lineFrom = (l: Row): string => (Number(l.mine) ? "You" : String(l.from_name || "Someone"));

const CHATS: Stream = {
    name: "chats",
    lines: "comms_chat_lines",
    days: "comms_chat_days",
    brief: CHAT_BRIEF,
    prompt: chatPrompt,
    describe: (g, people) => ({ title: chatTitle(g.kind as ChatKind, g.topic, people), kind: g.kind, link: chatLink(g.chatId) }),
    message: (l) => ({ at: clockOf(String(l.at)), from: lineFrom(l), text: String(l.text) }),
    givenUp: "open the chat to read them",
};

const TO_RANK: Record<string, number> = { list: 0, cc: 1, you: 2 };

const MAIL: Stream = {
    name: "mail",
    lines: "comms_mail_lines",
    days: "comms_mail_days",
    brief: MAIL_BRIEF,
    prompt: mailPrompt,
    describe: (g, _people, prev) => {
        const theirs = g.lines.filter((l) => !Number(l.mine));
        // How the thread reached the user: the closest any of its messages came that day.
        const kinds = [...theirs.map((l) => String(l.chat_kind)), ...(prev ? [String(prev.kind)] : [])].filter((k) => k in TO_RANK);
        const kind = kinds.sort((a, b) => TO_RANK[b] - TO_RANK[a])[0] || "list";
        // Kept before the deep links, a line's or day's link may be Graph's old one: made one that opens.
        const link = [...theirs].reverse().map((l) => openableOutlookLink(l.link)).find(Boolean) || (prev ? openableOutlookLink(prev.link) : "");
        return { title: g.topic || (prev ? String(prev.title) : "") || "(no subject)", kind, link };
    },
    message: (l) => (Number(l.mine) ? { at: clockOf(String(l.at)), from: "You", text: String(l.text) } : { at: clockOf(String(l.at)), from: lineFrom(l), text: String(l.text), to: String(l.chat_kind) }),
    givenUp: "open the thread in Outlook to read them",
};

/**
 * Summarize the conversations with messages waiting: each chat's or thread's day, with what its
 * summary said so far, a batch per model call, at most a few calls a scan. A summary kept clears
 * its messages' text. A conversation the answer left out, or couldn't be read for, is tried again
 * on its own, after the others, so one that keeps breaking the answer can't hold the rest back;
 * failing on its own a few times, it's given up on. A call that fails (Copilot down, a timeout)
 * counts against no one: the next batch is still tried, and what's left waits for the next scan.
 */
async function summarizeStream(stream: Stream, limits = CHAT_LIMITS): Promise<ChatsInfo> {
    const d = await db();
    const at = iso();
    const rows = d.prepare(`SELECT * FROM ${stream.lines} WHERE state = 'pending' ORDER BY at, message_id`).all() as Row[];
    const groups = new Map<string, Group>();
    for (const r of rows) {
        const key = `${r.chat_id}|${r.day}`;
        const g = groups.get(key) || { chatId: String(r.chat_id), day: String(r.day), kind: String(r.chat_kind), topic: String(r.chat_topic || ""), lines: [], tries: 0 };
        g.lines.push(r);
        g.tries = Math.max(g.tries, Number(r.tries) || 0);
        if (r.chat_topic) g.topic = String(r.chat_topic);
        groups.set(key, g);
    }
    const lastOf = (g: Group) => time(String(g.lines[g.lines.length - 1].at));
    // The latest day first, then the conversations that moved last.
    const ordered = [...groups.values()].sort((a, b) => b.day.localeCompare(a.day) || lastOf(b) - lastOf(a));
    const inputs: ChatInput[] = [];
    const meta = new Map<string, { group: Group; prev: Row | undefined; people: string[]; title: string; kind: string; link: string; lastAt: string }>();
    ordered.forEach((g, i) => {
        const prev = d.prepare(`SELECT * FROM ${stream.days} WHERE chat_id = ? AND day = ?`).get(g.chatId, g.day) as Row | undefined;
        // A new day of a conversation (the user's reply the next morning) is named, and has its people
        // and link, from the conversation's last day before; its summary starts afresh.
        const known = prev ?? (d.prepare(`SELECT * FROM ${stream.days} WHERE chat_id = ? AND day < ? ORDER BY day DESC LIMIT 1`).get(g.chatId, g.day) as Row | undefined);
        const theirs = g.lines.filter((l) => !Number(l.mine) && l.from_name).map((l) => String(l.from_name));
        const people = [...new Set([...parseList<string>(prev?.people_json), ...theirs])].slice(0, 8);
        if (!people.length && known) people.push(...parseList<string>(known.people_json).slice(0, 8));
        const { title, kind, link } = stream.describe(g, people, known);
        const key = `c${i + 1}`;
        const newest = String(g.lines[g.lines.length - 1].at);
        meta.set(key, { group: g, prev, people, title, kind, link, lastAt: prev && time(String(prev.last_at)) > time(newest) ? String(prev.last_at) : newest });
        inputs.push({
            key,
            chat: title,
            kind,
            previous: prev
                ? { summary: String(prev.summary), points: parseList<string>(prev.points_json), importance: importanceOf(prev.importance), needsYou: String(prev.needs_you || "") }
                : null,
            messages: g.lines.map(stream.message),
        });
    });
    const triesOf = (i: ChatInput) => meta.get(i.key)!.group.tries;
    const retries = inputs.filter((i) => triesOf(i) > 0).sort((a, b) => triesOf(a) - triesOf(b));
    const batches = [...packInputs(inputs.filter((i) => !triesOf(i)), limits), ...retries.map((i) => packInputs([i], limits)[0])];
    let calls = 0;
    let summarized = 0;
    let error: string | null = null;
    const put = d.prepare(`
        INSERT INTO ${stream.days} (chat_id, day, kind, title, summary, points_json, importance, needs_you, people_json, messages, last_at, link, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id, day) DO UPDATE SET kind = excluded.kind, title = excluded.title, summary = excluded.summary,
            points_json = excluded.points_json, importance = excluded.importance, needs_you = excluded.needs_you,
            people_json = excluded.people_json, messages = messages + excluded.messages, last_at = excluded.last_at,
            link = excluded.link, updated_at = excluded.updated_at`);
    const ids = (g: Group) => JSON.stringify(g.lines.map((l) => String(l.message_id)));
    const done = d.prepare(`UPDATE ${stream.lines} SET state = 'done', text = '' WHERE chat_id = ? AND day = ? AND state = 'pending' AND message_id IN (SELECT value FROM json_each(?))`);
    const failed = d.prepare(`UPDATE ${stream.lines} SET tries = tries + 1 WHERE chat_id = ? AND day = ? AND state = 'pending' AND message_id IN (SELECT value FROM json_each(?))`);
    // The user wrote after an earlier day's last message: nobody waits on them there any more.
    const answered = d.prepare(`UPDATE ${stream.days} SET needs_you = '' WHERE chat_id = ? AND day < ? AND needs_you <> '' AND last_at < ?`);
    const keep = (m: NonNullable<ReturnType<typeof meta.get>>, s: ChatSummary) => {
        const g = m.group;
        put.run(g.chatId, g.day, m.kind, m.title, s.summary, JSON.stringify(s.points), s.importance, s.needsYou, JSON.stringify(m.people), g.lines.length, m.lastAt, m.link, at);
        done.run(g.chatId, g.day, ids(g));
        const wrote = g.lines.filter((l) => Number(l.mine)).map((l) => String(l.at)).sort((a, b) => time(b) - time(a))[0];
        if (wrote) answered.run(g.chatId, g.day, wrote);
        summarized++;
    };
    for (const batch of batches.slice(0, limits.callsPerScan)) {
        calls++;
        let answer: string;
        try {
            answer = await runtime.summarize(stream.prompt(batch), stream.brief);
        } catch (e) {
            error = ((e as Error).message || String(e)).slice(0, 300);
            continue;
        }
        const parsed = parseSummaries(answer, batch.map((b) => b.key), limits);
        if (!parsed.size) error = "The summary couldn't be read; it's tried again next time.";
        for (const input of batch) {
            const m = meta.get(input.key)!;
            const s = parsed.get(input.key);
            if (s) keep(m, mergeSummary(s, m.prev, m.group.lines.some((l) => Number(l.mine))));
            else if (batch.length === 1 && m.group.tries + 1 >= limits.maxTries) keep(m, givenUp(m.prev, m.group.lines.length, stream.givenUp));
            else failed.run(m.group.chatId, m.group.day, ids(m.group));
        }
    }
    if (summarized) await bumpVersion(stream.name);
    const { pending } = d.prepare(`SELECT count(*) AS pending FROM (SELECT DISTINCT chat_id, day FROM ${stream.lines} WHERE state = 'pending')`).get() as { pending: number };
    return { at, ok: !error, summarized, calls, pending: Number(pending), error };
}

const bumpVersion = async (name: Stream["name"]) => writeState(`${name}.version`, (await readState<number>(`${name}.version`, 0)) + 1);

/** Summarize the Teams conversations with messages waiting. */
export const summarizeChats = (limits = CHAT_LIMITS): Promise<ChatsInfo> => summarizeStream(CHATS, limits);
/** Summarize the email threads with messages waiting. */
export const summarizeMail = (limits = CHAT_LIMITS): Promise<ChatsInfo> => summarizeStream(MAIL, limits);

const importanceOf = (v: unknown): Importance => (v === "high" || v === "low" ? v : "normal");
const IMPORTANCE_RANK: Record<Importance, number> = { low: 0, normal: 1, high: 2 };

/**
 * The new summary, holding on to what the day had: its importance never drops, and someone waiting
 * on the user stays waiting until the user writes in the chat or thread (a small model easily
 * drops it when the new messages are only "thanks").
 */
function mergeSummary(s: ChatSummary, prev: Row | undefined, userWrote: boolean): ChatSummary {
    if (!prev) return s;
    const before = importanceOf(prev.importance);
    return {
        ...s,
        importance: IMPORTANCE_RANK[before] > IMPORTANCE_RANK[s.importance] ? before : s.importance,
        needsYou: s.needsYou || (userWrote ? "" : String(prev.needs_you || "")),
    };
}

/** What's kept of a conversation the model couldn't summarize: the day's summary so far, or a line saying so. */
function givenUp(prev: Row | undefined, count: number, how: string): ChatSummary {
    if (prev) return { summary: String(prev.summary), points: parseList<string>(prev.points_json), importance: importanceOf(prev.importance), needsYou: String(prev.needs_you || "") };
    return { summary: `${count} message${count === 1 ? "" : "s"} that couldn't be summarized; ${how}.`, points: [], importance: "normal", needsYou: "" };
}

const toChat = (r: Row): CommsChat => ({
    chatId: String(r.chat_id),
    day: String(r.day),
    kind: String(r.kind) as ChatKind,
    title: String(r.title),
    summary: String(r.summary),
    points: parseList<string>(r.points_json),
    importance: importanceOf(r.importance),
    needsYou: String(r.needs_you || ""),
    people: parseList<string>(r.people_json),
    messages: Number(r.messages) || 0,
    lastAt: String(r.last_at),
    link: String(r.link),
    updatedAt: String(r.updated_at),
});

const toMail = (r: Row): CommsMail => ({
    threadId: String(r.chat_id),
    day: String(r.day),
    to: (String(r.kind) in TO_RANK ? String(r.kind) : "list") as MailTo,
    subject: String(r.title),
    summary: String(r.summary),
    points: parseList<string>(r.points_json),
    importance: importanceOf(r.importance),
    needsYou: String(r.needs_you || ""),
    people: parseList<string>(r.people_json),
    messages: Number(r.messages) || 0,
    lastAt: String(r.last_at),
    link: openableOutlookLink(r.link),
    updatedAt: String(r.updated_at),
});

/** The first day of the two weeks kept. */
const firstKeptDay = (): string => {
    const d = new Date(runtime.now());
    d.setDate(d.getDate() - Math.round(COMMS_LIMITS.keepMeetingsMs / 86_400_000));
    return localDay(d.toISOString());
};

/** A stream's days of the last two weeks: the latest day first; in a day, what needs the user, then the important, then the latest. */
async function listDays(stream: Stream): Promise<Row[]> {
    return (await db())
        .prepare(
            `SELECT * FROM ${stream.days} WHERE day >= ?
             ORDER BY day DESC, CASE WHEN needs_you <> '' THEN 0 WHEN importance = 'high' THEN 1 WHEN importance = 'normal' THEN 2 ELSE 3 END, last_at DESC`,
        )
        .all(firstKeptDay()) as Row[];
}

/** The Teams conversations of the last two weeks, in the Communication tab's order. */
export async function listCommsChats(): Promise<CommsChat[]> {
    return (await listDays(CHATS)).map(toChat);
}

/** The email threads of the last two weeks, in the Communication tab's order. */
export async function listCommsMail(): Promise<CommsMail[]> {
    return (await listDays(MAIL)).map(toMail);
}

/** What the Today poll carries of a stream: when to read it again, and when its flagged days last moved (the tab's badge). */
async function digestOf(stream: Stream): Promise<ChatsDigest> {
    const flagged = (await db())
        .prepare(`SELECT updated_at FROM ${stream.days} WHERE day >= ? AND (importance = 'high' OR needs_you <> '') ORDER BY updated_at`)
        .all(firstKeptDay()) as Array<{ updated_at: string }>;
    return { version: String(await readState<number>(`${stream.name}.version`, 0)), flagged: flagged.map((r) => r.updated_at) };
}

/**
 * A chat or email thread someone waits on the user in, as Needs you shows it: its latest day that
 * says so, this week. One per conversation, so a to-do made from it stays the same as the ask moves on.
 */
export interface CommsNeed {
    /** need:chat:<hash> or need:mail:<hash> of the conversation. */
    key: string;
    source: "chat" | "mail";
    /** The chat or thread, and the day its ask was last seen. */
    id: string;
    day: string;
    title: string;
    /** A chat's kind (oneOnOne, group), or how an email reached the user (you, cc, list). */
    kind: string;
    people: string[];
    needsYou: string;
    summary: string;
    lastAt: string;
    /** The chat in Teams, or the email in Outlook on the web; "" when there's none. */
    link: string;
}

/** The Needs you key of a conversation: the same for as long as it waits on the user. */
export const commsNeedKey = (source: CommsNeed["source"], id: string): string => `need:${source}:${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;

/**
 * What chats and email threads wait on the user, oldest first. A chat with an open PR ask whose
 * line is about a review is left to the ask, which opens the PR (`asks`: the open ones).
 */
export async function commsNeeds(asks: ReadonlyArray<Pick<CommsAsk, "askers">> = []): Promise<CommsNeed[]> {
    const d = await db();
    const from = localDay(iso(runtime.now() - (COMMS_LIMITS.needDays - 1) * 86_400_000));
    const askChats = new Set(asks.flatMap((a) => a.askers.map((x) => chatIdOf(x.link))).filter((x): x is string => !!x));
    const out: CommsNeed[] = [];
    for (const stream of [CHATS, MAIL]) {
        const source = stream === CHATS ? "chat" : "mail";
        const rows = d.prepare(`SELECT * FROM ${stream.days} WHERE day >= ? AND needs_you <> '' ORDER BY day DESC, last_at DESC`).all(from) as Row[];
        const seen = new Set<string>();
        for (const r of rows) {
            const id = String(r.chat_id);
            if (seen.has(id)) continue;
            seen.add(id);
            const needsYou = String(r.needs_you);
            if (source === "chat" && askChats.has(id) && /\b(pr|pull request|review)\b/i.test(needsYou)) continue;
            const link = String(r.link || "");
            out.push({
                key: commsNeedKey(source, id),
                source,
                id,
                day: String(r.day),
                title: String(r.title),
                kind: String(r.kind),
                people: parseList<string>(r.people_json),
                needsYou,
                summary: String(r.summary),
                lastAt: String(r.last_at),
                link: source === "mail" ? openableOutlookLink(link) : link.startsWith("https://teams.microsoft.com/l/chat/") ? link : "",
            });
        }
    }
    return out.sort((a, b) => time(a.lastAt) - time(b.lastAt) || a.key.localeCompare(b.key));
}

/**
 * The user dismissed a chat's or thread's ask in Needs you: nobody waits on them there now, that
 * day or before (a later ask shows again). Returns what still waits.
 */
export async function dismissCommsNeed(key: unknown, asks: ReadonlyArray<Pick<CommsAsk, "askers">> = []): Promise<CommsNeed[]> {
    if (typeof key !== "string" || !/^need:(chat|mail):[0-9a-f]{16}$/.test(key)) throw new JarvisError("Unknown ask.");
    const need = (await commsNeeds()).find((n) => n.key === key);
    if (!need) throw new JarvisError("That ask is gone.", 404);
    const stream = need.source === "chat" ? CHATS : MAIL;
    (await db()).prepare(`UPDATE ${stream.days} SET needs_you = '' WHERE chat_id = ? AND day <= ?`).run(need.id, need.day);
    await bumpVersion(stream.name);
    return commsNeeds(asks);
}

export const chatsDigest = (): Promise<ChatsDigest> => digestOf(CHATS);
export const mailDigest = (): Promise<ChatsDigest> => digestOf(MAIL);

/** Old summaries, the rows that keep a message from being summarized twice, and messages that never got summarized. */
async function pruneStream(stream: Stream, now: number): Promise<number> {
    const d = await db();
    const day = new Date(now);
    day.setDate(day.getDate() - Math.round(COMMS_LIMITS.keepMeetingsMs / 86_400_000));
    const days = d.prepare(`DELETE FROM ${stream.days} WHERE day < ?`).run(localDay(day.toISOString()));
    const lines = d
        .prepare(`DELETE FROM ${stream.lines} WHERE (state = 'done' AND queued_at < ?) OR (state = 'pending' AND at < ?)`)
        .run(new Date(now - COMMS_LIMITS.chatLinesKeepMs).toISOString(), new Date(now - COMMS_LIMITS.chatPendingMaxMs).toISOString());
    if (Number(days.changes)) await bumpVersion(stream.name);
    return Number(days.changes) + Number(lines.changes);
}

/** With a stream's summaries off, the text of messages still waiting for one goes at once. */
async function dropWaiting(stream: Stream): Promise<void> {
    (await db()).prepare(`UPDATE ${stream.lines} SET state = 'done', text = '' WHERE state = 'pending'`).run();
}

// ---- the scan -----------------------------------------------------------------------

/**
 * Whether the bridge reads Teams chats (PR asks), meeting recaps, summarizes chats, or reads email. Each is on
 * unless the user turned it off; chat summaries, never set, follow PR asks turned off, since they
 * read the same chats (a user who stopped Teams being read isn't read again by an upgrade), and
 * email, never set, follows either turned off.
 */
export async function commsEnabled(source: CommsSource = "teams"): Promise<boolean> {
    if (process.env.ADO_PR_OPS_COMMS === "off") return false;
    const on = await readState<boolean | null>(`${source}.enabled`, null);
    if (on !== null) return on !== false;
    if (source === "chats") return (await readState<boolean>("teams.enabled", true)) !== false;
    // Email, never set, stays off for a user who turned Teams reading or chat summaries off.
    if (source === "mail") return (await readState<boolean>("teams.enabled", true)) !== false && (await readState<boolean>("chats.enabled", true)) !== false;
    return true;
}

export type CommsSource = "teams" | "meetings" | "chats" | "mail";

async function whoAmI(): Promise<TeamsMe> {
    const cached = await readState<{ me: TeamsMe; at: number } | null>("teams.me", null);
    if (cached?.me?.id && runtime.now() - cached.at < COMMS_LIMITS.meMs) return cached.me;
    const client = await runtime.open("m365-user");
    try {
        const me = meFrom((await client.call("GetMyDetails", { select: "id,displayName,givenName,mail,userPrincipalName" })).json);
        if (!me) throw new Error("Couldn't tell who you are from your Microsoft 365 profile.");
        await writeState("teams.me", { me, at: runtime.now() });
        return me;
    } finally {
        client.close();
    }
}

async function cursorsNow(): Promise<Map<string, string>> {
    const rows = (await db()).prepare("SELECT key, at FROM comms_cursors WHERE key LIKE 'teams:%'").all() as Array<{ key: string; at: string }>;
    return new Map(rows.map((r) => [r.key.slice("teams:".length), r.at]));
}

async function saveCursors(cursors: ReadonlyMap<string, string>): Promise<void> {
    const d = await db();
    const put = d.prepare("INSERT INTO comms_cursors (key, at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at");
    for (const [chatId, at] of cursors) put.run(`teams:${chatId}`, at);
}

/**
 * Read Teams: keep the asks (when PR asks are on) and the new messages for their summaries (when
 * chat summaries are on), and close the asks the user answered in their 1:1. Throws when Teams
 * couldn't be read at all.
 */
async function scanOnce(want: { asks: boolean; chats: boolean } = { asks: true, chats: false }): Promise<CommsScanInfo> {
    const at = iso();
    const me = await whoAmI();
    const cursors = await cursorsNow();
    const client = await runtime.open("teams");
    let scan: TeamsScan;
    try {
        scan = await scanTeams(client, me, (id) => cursors.get(id) ?? null, runtime.now(), TEAMS_LIMITS);
    } finally {
        client.close();
    }
    const found = want.asks ? await recordAsks(scan.asks, await runtime.orgs()) : 0;
    if (want.chats && (await commsEnabled("chats"))) await queueChatLines(scan.lines);
    await saveCursors(scan.cursors);
    if (want.asks) await settleReplies(scan.mine);
    return {
        at,
        ok: !scan.throttled && !scan.errors.length,
        calls: scan.calls,
        chats: scan.chats,
        messages: scan.messages,
        found,
        left: scan.left,
        throttled: scan.throttled,
        error: scan.throttled ? "Teams asked to slow down; the rest waits for the next scan." : scan.errors[0] || null,
    };
}

/**
 * Read the inbox since the last read: the mail from people, each thread's new messages with their
 * text, and the user's replies; kept for the threads' summaries. Throws when the inbox couldn't
 * be read at all.
 */
async function scanMailOnce(): Promise<MailScanInfo> {
    const at = iso();
    const me = await whoAmI();
    if (!me.mail) throw new Error("Couldn't tell your email address from your Microsoft 365 profile.");
    const d = await db();
    const cursor = (key: string) => (d.prepare("SELECT at FROM comms_cursors WHERE key = ?").get(key) as { at: string } | undefined)?.at ?? null;
    const kept = new Set((d.prepare("SELECT message_id FROM comms_mail_lines").all() as Array<{ message_id: string }>).map((r) => r.message_id));
    const known = new Set(
        (d.prepare("SELECT chat_id FROM comms_mail_lines UNION SELECT chat_id FROM comms_mail_days WHERE day >= ?").all(localDay(iso(runtime.now() - 3 * 86_400_000))) as Array<{ chat_id: string }>).map((r) => r.chat_id),
    );
    const client = await runtime.open("mail");
    let scan: MailScan;
    try {
        scan = await scanMail(client, me, { inbox: cursor("mail:inbox"), sent: cursor("mail:sent") }, (id) => known.has(id), (id) => kept.has(id), runtime.now(), MAIL_LIMITS);
    } finally {
        client.close();
    }
    // Turned off while it read: what was read isn't kept.
    const found = (await commsEnabled("mail")) ? await queueMailLines(scan.lines) : 0;
    const put = d.prepare("INSERT INTO comms_cursors (key, at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at");
    if (scan.cursors.inbox) put.run("mail:inbox", scan.cursors.inbox);
    if (scan.cursors.sent) put.run("mail:sent", scan.cursors.sent);
    return {
        at,
        ok: !scan.throttled && !scan.errors.length,
        calls: scan.calls,
        messages: scan.messages,
        threads: scan.threads,
        found,
        left: scan.left,
        more: scan.more,
        throttled: scan.throttled,
        error: scan.throttled ? "Outlook asked to slow down; the rest waits for the next read." : scan.errors[0] || null,
    };
}

// ---- the schedule -------------------------------------------------------------------
//
// Teams chats, meetings and email keep their own next time and back-off: the calendar slowing
// down doesn't delay PR asks, and a recap that's due doesn't make Teams be read more often. One
// timer fires at the earliest; each tick reads the sources that are due. Scan now reads them all.

type Source = "teams" | "meetings" | "mail";

const runner: {
    timer: ReturnType<typeof setTimeout> | null;
    nextAt: number | null;
    scanning: Promise<CommsScanInfo | null> | null;
    stopped: boolean;
    started: boolean;
    backoff: Record<Source, number>;
    /** When each source, and the closing of open asks, is next due; null when it isn't. */
    due: Record<Source | "settle", number | null>;
} = {
    timer: null,
    nextAt: null,
    scanning: null,
    stopped: false,
    started: false,
    backoff: { teams: 0, meetings: 0, mail: 0 },
    due: { teams: null, meetings: null, mail: null, settle: null },
};

function schedule(ms: number): void {
    if (runner.timer) clearTimeout(runner.timer);
    runner.timer = null;
    runner.nextAt = null;
    // A negative delay just stops the timer.
    if (runner.stopped || !runner.started || ms < 0) return;
    runner.nextAt = runtime.now() + ms;
    runner.timer = setTimeout(() => void scanComms("due").catch(() => undefined), ms);
    runner.timer.unref?.();
}

/** Set the timer for the earliest due time; stop it when nothing is due. */
function scheduleNext(): void {
    const times = Object.values(runner.due).filter((t): t is number => t !== null);
    if (!times.length) return schedule(-1);
    schedule(Math.max(0, Math.min(...times) - runtime.now()));
}

const failedScan = (i: { throttled: boolean; ok: boolean; calls: number } | null): boolean => !!i && (i.throttled || (!i.ok && !i.calls));
const backedOff = (backoff: number): { ms: number; backoff: number } => {
    const next = Math.min(backoff ? backoff * 2 : COMMS_LIMITS.backoffMs, COMMS_LIMITS.maxBackoffMs);
    return { ms: next, backoff: next };
};

/** When Teams chats (or the inbox) are next read after a read that went like this: back off when slowed down or not started; soon when some were left. */
export function nextDelay(info: { throttled: boolean; ok: boolean; calls: number; left: number; more?: boolean } | null, backoff: number): { ms: number; backoff: number } {
    if (failedScan(info)) return backedOff(backoff);
    if (info?.left || info?.more) return { ms: COMMS_LIMITS.soonMs, backoff: 0 };
    return { ms: COMMS_LIMITS.everyMs, backoff: 0 };
}

/**
 * When the calendar is next read: back off when slowed down or not started; in 10 minutes while a
 * meeting that ended waits for its recap; and just after the next meeting ends.
 */
export function nextMeetingsDelay(info: MeetingScanInfo | null, backoff: number): { ms: number; backoff: number } {
    if (failedScan(info)) return backedOff(backoff);
    let ms = COMMS_LIMITS.everyMs;
    if (info?.pending) ms = Math.min(ms, COMMS_LIMITS.recapSoonMs);
    if (info?.nextEndMs != null) ms = Math.min(ms, Math.max(COMMS_LIMITS.soonMs, info.nextEndMs + COMMS_LIMITS.afterMeetingMs));
    return { ms, backoff: 0 };
}

/**
 * Scan, unless one is running (then its result): "all" reads every source that's on (Scan now,
 * turning one on); "due" (the timer) only those due. Either way it then closes what a week or ADO
 * closes, so asks still close while Teams is off or can't be read, and sets the timer for what's
 * next: each source on its own schedule, and the closing every 30 minutes while asks are open.
 * Returns what the Teams read found; null when Teams wasn't read.
 */
export function scanComms(which: "all" | "due" = "all"): Promise<CommsScanInfo | null> {
    if (runner.scanning) return runner.scanning;
    runner.scanning = (async () => {
        const isDue = (source: Source) => which === "all" || (runner.due[source] ?? Infinity) <= runtime.now();
        const asksOn = await commsEnabled("teams");
        const chatsOn = await commsEnabled("chats");
        // Teams is read for PR asks, chat summaries, or both: one read.
        const teamsOn = asksOn || chatsOn;
        const meetingsOn = await commsEnabled("meetings");
        const mailOn = await commsEnabled("mail");
        let info: CommsScanInfo | null = null;
        if (teamsOn && isDue("teams")) {
            try {
                info = await scanOnce({ asks: asksOn, chats: chatsOn });
            } catch (error) {
                const message = (error as Error).message || String(error);
                info = {
                    at: iso(),
                    ok: false,
                    calls: 0,
                    chats: 0,
                    messages: 0,
                    found: 0,
                    left: 0,
                    throttled: !!(error as { throttled?: boolean }).throttled,
                    error: message.slice(0, 300),
                };
            }
            await writeState("teams.last", info);
            if (!info.ok) console.warn(`[comms] scan: ${info.error}`);
            else if (info.found) console.log(`[comms] scan: ${info.found} new ask${info.found === 1 ? "" : "s"} from ${info.chats} chat(s), ${info.calls} calls`);
            const next = nextDelay(info, runner.backoff.teams);
            runner.backoff.teams = next.backoff;
            runner.due.teams = runtime.now() + next.ms;
            // The new messages, and any that waited, summarized: even when Teams couldn't be read this time.
            if (chatsOn && (await commsEnabled("chats"))) {
                let chats: ChatsInfo;
                try {
                    chats = await summarizeChats();
                } catch (error) {
                    chats = { at: iso(), ok: false, summarized: 0, calls: 0, pending: 0, error: ((error as Error).message || String(error)).slice(0, 300) };
                }
                if (chats.calls || !chats.ok) await writeState("chats.last", chats);
                if (!chats.ok) console.warn(`[comms] chat summaries: ${chats.error}`);
                else if (chats.summarized) console.log(`[comms] chat summaries: ${chats.summarized} conversation(s), ${chats.calls} call(s)`);
            }
        }
        if (meetingsOn && isDue("meetings")) {
            let meetings: MeetingScanInfo;
            try {
                meetings = await scanMeetingsOnce();
            } catch (error) {
                meetings = {
                    at: iso(),
                    ok: false,
                    calls: 0,
                    meetings: 0,
                    recaps: 0,
                    pending: 0,
                    nextEndMs: null,
                    throttled: !!(error as { throttled?: boolean }).throttled,
                    error: ((error as Error).message || String(error)).slice(0, 300),
                };
            }
            await writeState("meetings.last", meetings);
            if (!meetings.ok) console.warn(`[comms] meetings: ${meetings.error}`);
            else if (meetings.recaps) console.log(`[comms] meetings: ${meetings.recaps} new recap${meetings.recaps === 1 ? "" : "s"}, ${meetings.calls} calls`);
            const next = nextMeetingsDelay(meetings, runner.backoff.meetings);
            runner.backoff.meetings = next.backoff;
            runner.due.meetings = runtime.now() + next.ms;
        }
        if (!teamsOn) {
            runner.due.teams = null;
            runner.backoff.teams = 0;
        }
        if (mailOn && isDue("mail")) {
            let mail: MailScanInfo;
            try {
                mail = await scanMailOnce();
            } catch (error) {
                mail = {
                    at: iso(),
                    ok: false,
                    calls: 0,
                    messages: 0,
                    threads: 0,
                    found: 0,
                    left: 0,
                    throttled: !!(error as { throttled?: boolean }).throttled,
                    error: ((error as Error).message || String(error)).slice(0, 300),
                };
            }
            await writeState("mail.last", mail);
            if (!mail.ok) console.warn(`[comms] mail: ${mail.error}`);
            else if (mail.found) console.log(`[comms] mail: ${mail.found} new message(s) in ${mail.threads} thread(s), ${mail.calls} calls`);
            const next = nextDelay(mail, runner.backoff.mail);
            runner.backoff.mail = next.backoff;
            runner.due.mail = runtime.now() + next.ms;
            // The new mail, and any that waited, summarized: even when the inbox couldn't be read this time.
            if (await commsEnabled("mail")) {
                let sums: ChatsInfo;
                try {
                    sums = await summarizeMail();
                } catch (error) {
                    sums = { at: iso(), ok: false, summarized: 0, calls: 0, pending: 0, error: ((error as Error).message || String(error)).slice(0, 300) };
                }
                if (sums.calls || !sums.ok) await writeState("mail.summaries", sums);
                if (!sums.ok) console.warn(`[comms] mail summaries: ${sums.error}`);
                else if (sums.summarized) console.log(`[comms] mail summaries: ${sums.summarized} thread(s), ${sums.calls} call(s)`);
            }
        }
        // Turned off while this read ran: the text it left waiting goes now.
        if (!(await commsEnabled("chats"))) await dropWaiting(CHATS);
        if (!(await commsEnabled("mail"))) await dropWaiting(MAIL);
        if (!mailOn) {
            runner.due.mail = null;
            runner.backoff.mail = 0;
        }
        if (!meetingsOn) {
            runner.due.meetings = null;
            runner.backoff.meetings = 0;
        }
        await settleAsks().catch((error: Error) => console.warn(`[comms] closing asks: ${error.message}`));
        runner.due.settle = (await openAsks()).length ? runtime.now() + COMMS_LIMITS.everyMs : null;
        scheduleNext();
        return info;
    })().finally(() => {
        runner.scanning = null;
    });
    return runner.scanning;
}

export async function commsStatus(): Promise<CommsStatus> {
    return {
        enabled: await commsEnabled("teams"),
        scanning: !!runner.scanning,
        last: await readState<CommsScanInfo | null>("teams.last", null),
        nextAt: runner.nextAt ? new Date(runner.nextAt).toISOString() : null,
        meetings: { enabled: await commsEnabled("meetings"), last: await readState<MeetingScanInfo | null>("meetings.last", null) },
        chats: { enabled: await commsEnabled("chats"), last: await readState<ChatsInfo | null>("chats.last", null) },
        mail: {
            enabled: await commsEnabled("mail"),
            last: await readState<MailScanInfo | null>("mail.last", null),
            summaries: await readState<ChatsInfo | null>("mail.summaries", null),
        },
    };
}

/**
 * Turn PR asks from Teams chats, meeting recaps, chat summaries, or email on or off. On scans at once;
 * off keeps what was found (asks close as before; meetings and summaries stay their two weeks),
 * but with summaries off, the text of messages still waiting for one goes at once.
 */
export async function setCommsEnabled(on: unknown, source: unknown = "teams"): Promise<CommsStatus> {
    if (typeof on !== "boolean") throw new JarvisError("Say whether to read Teams.");
    if (source !== "teams" && source !== "meetings" && source !== "chats" && source !== "mail") throw new JarvisError("Unknown source.");
    await writeState(`${source}.enabled`, on);
    if (!(await commsEnabled("chats"))) await dropWaiting(CHATS);
    if (!(await commsEnabled("mail"))) await dropWaiting(MAIL);
    if (on && runner.started) {
        // A tick under way may have started while it was off: scan again once it's done, so it's read and the timer set.
        const scan = runner.scanning ? runner.scanning.catch(() => null).then(() => scanComms()) : scanComms();
        void scan.catch(() => undefined);
    }
    return commsStatus();
}

export function startCommsRunner(): void {
    if (runner.started) return;
    runner.started = true;
    runner.stopped = false;
    // The first read of each source, soon after the service starts.
    const first = runtime.now() + COMMS_LIMITS.firstMs;
    runner.due = { teams: first, meetings: first, mail: first, settle: null };
    scheduleNext();
}

/** Start the runner if the app didn't (dev server). Never restarts a stopped one. */
export function ensureCommsRunner(): void {
    if (!runner.started && !runner.stopped) startCommsRunner();
}

export async function stopCommsRunner(): Promise<void> {
    runner.stopped = true;
    if (runner.timer) clearTimeout(runner.timer);
    runner.timer = null;
    runner.nextAt = null;
    await runner.scanning?.catch(() => undefined);
}

/** Back to a clean slate (the harness). */
export function resetComms(): void {
    if (runner.timer) clearTimeout(runner.timer);
    Object.assign(runner, {
        timer: null,
        nextAt: null,
        scanning: null,
        stopped: false,
        started: false,
        backoff: { teams: 0, meetings: 0, mail: 0 },
        due: { teams: null, meetings: null, mail: null, settle: null },
    });
    schemaReady = null;
}
