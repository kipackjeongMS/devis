// The comms bridge's meetings: the user's Teams meetings from their calendar, and each one's
// recap, as Teams' own Copilot wrote it (GetOnlineMeetingAiInsights): notes with their points,
// and action items with who owns them. Read through the Calendar MCP server. No AI of ours.
//
// A recurring meeting keeps one insight per occurrence; the one whose call ended nearest the
// occurrence's end is its recap.

import { createHash } from "node:crypto";
import { McpError, type McpClient } from "./mcp-stdio.mjs";
import { isMe, type TeamsMe } from "./comms-teams.mjs";

export const MEETING_LIMITS = {
    /** A recap is looked for until this long after the meeting ends; Teams says it can take up to four hours. */
    recapWaitMs: 4 * 3600_000,
    /** A meeting still waiting for its recap is asked about at most this often. */
    recheckMs: 8 * 60_000,
    /** A recap is looked at again this often until the wait is over: a restarted transcription adds a part. */
    readyRecheckMs: 60 * 60_000,
    /** Looks that keep failing stop after this long: the meeting has no recap. */
    giveUpMs: 3 * 86_400_000,
    /** Recaps looked for in one scan, the meetings that ended last first. */
    checksPerScan: 8,
    /** How far a call can start early or run over and still be the occurrence's. */
    earlyMs: 20 * 60_000,
    notes: 12,
    subpoints: 8,
    actions: 20,
    titleChars: 200,
    textChars: 700,
    listTop: 200,
};

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

/** A Teams meeting on the user's calendar. */
export interface CalendarMeeting {
    /** A short, stable id: a hash of the calendar's event id (each occurrence has its own). */
    id: string;
    subject: string;
    start: string;
    end: string;
    organizer: string;
    attendees: number;
    joinUrl: string;
    /** The meeting's chat in Teams, where its recap is. */
    chatLink: string | null;
}

export interface Recap {
    state: "pending" | "ready" | "none" | "noaccess";
    /** The insights it was made from, oldest first. */
    insightIds: string[];
    notes: MeetingNote[];
    actions: MeetingAction[];
    calls: number;
    /** The look failed (not throttling, not no access): what was known stays as it was. */
    failed?: boolean;
    /** A ready recap's insights are the same ones as before: nothing to change. */
    unchanged?: boolean;
}

const time = (iso: string | null | undefined): number => Date.parse(iso || "") || 0;

function clip(value: unknown, max: number): string {
    const t = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** A calendar time ({ dateTime, timeZone }, asked for in UTC) as an ISO timestamp; null when it isn't UTC or isn't a time. */
export function calendarTime(t: { dateTime?: unknown; timeZone?: unknown } | null | undefined): string | null {
    const dt = typeof t?.dateTime === "string" ? t.dateTime : "";
    const zone = typeof t?.timeZone === "string" ? t.timeZone : "UTC";
    if (!dt || !/^(UTC|Etc\/UTC|Coordinated Universal Time)$/i.test(zone)) return null;
    // Graph writes seven fractional digits and no zone: "2026-10-27T17:00:00.0000000".
    const ms = Date.parse(`${dt.replace(/(\.\d{3})\d*$/, "$1").replace(/Z$/i, "")}Z`);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The meeting's chat in Teams, from its join link (…/l/meetup-join/19%3ameeting_…%40thread.v2/0?…). */
export function meetingChatLink(joinUrl: string): string | null {
    const m = /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\/([^/?#]+)/i.exec(joinUrl);
    if (!m) return null;
    let thread: string;
    try {
        thread = decodeURIComponent(m[1]);
    } catch {
        return null;
    }
    if (!/^19:meeting_[\w-]+@thread\.v2$/i.test(thread)) return null;
    return `https://teams.microsoft.com/l/chat/${encodeURIComponent(thread)}/0`;
}

export const meetingId = (eventId: string): string => createHash("sha256").update(eventId).digest("hex").slice(0, 24);

/** The Teams meetings in a ListCalendarView result: online, not cancelled, not all-day, not declined. */
export function meetingsFrom(json: any): CalendarMeeting[] {
    const events = (Array.isArray(json?.value) ? json.value : []) as any[];
    const out: CalendarMeeting[] = [];
    for (const e of events) {
        if (!e || typeof e.id !== "string" || e.isCancelled || e.isAllDay) continue;
        const joinUrl = typeof e.onlineMeeting?.joinUrl === "string" ? e.onlineMeeting.joinUrl : "";
        if (!e.isOnlineMeeting || !/^https:\/\/teams\.microsoft\.com\//i.test(joinUrl)) continue;
        if (String(e.responseStatus?.response || "").toLowerCase() === "declined") continue;
        const start = calendarTime(e.start);
        const end = calendarTime(e.end);
        if (!start || !end) continue;
        out.push({
            id: meetingId(e.id),
            subject: clip(e.subject, MEETING_LIMITS.titleChars) || "(no title)",
            start,
            end,
            organizer: clip(e.organizer?.emailAddress?.name, 120),
            attendees: Array.isArray(e.attendees) ? e.attendees.length : 0,
            joinUrl,
            chatLink: meetingChatLink(joinUrl),
        });
    }
    return out;
}

/** The fields a meetings list asks the calendar for. */
export const MEETING_FIELDS = "subject,start,end,isOnlineMeeting,onlineMeeting,organizer,attendees,isCancelled,isAllDay,responseStatus";

/** The user's Teams meetings between two times. */
export async function listMeetings(client: McpClient, from: string, to: string): Promise<CalendarMeeting[]> {
    const res = await client.call("ListCalendarView", {
        startDateTime: from,
        endDateTime: to,
        timeZone: "UTC",
        select: MEETING_FIELDS,
        top: MEETING_LIMITS.listTop,
    });
    return meetingsFrom(res.json);
}

/**
 * Of a meeting's insights, this occurrence's: every one whose call ended within reason of it, oldest
 * first. A recurring meeting has one per occurrence; an occurrence whose transcription was stopped
 * and started again has one per part. An insight is asked for by its id here; the one that comes
 * back carries its id in another encoding, so it's known by its end time.
 */
export function pickInsights(all: unknown, start: string, end: string, limits = MEETING_LIMITS): Array<{ id: string; ended: number }> {
    const list = (Array.isArray(all) ? all : []) as any[];
    const from = time(start) - limits.earlyMs;
    const to = time(end) + limits.recapWaitMs;
    const out: Array<{ id: string; ended: number }> = [];
    for (const i of list) {
        const ended = time(i?.endDateTime) || time(i?.createdDateTime);
        if (typeof i?.id !== "string" || !ended || ended < from || ended > to) continue;
        out.push({ id: i.id, ended });
    }
    return out.sort((a, b) => a.ended - b.ended || a.id.localeCompare(b.id));
}

const endedAt = (insight: any): number => time(insight?.endDateTime) || time(insight?.createdDateTime);

/** An insight's notes and action items, clipped; the user's action items marked. */
export function recapFrom(insight: any, me: TeamsMe): Pick<Recap, "notes" | "actions"> {
    const L = MEETING_LIMITS;
    const notes = ((Array.isArray(insight?.meetingNotes) ? insight.meetingNotes : []) as any[]).slice(0, L.notes).map((n) => ({
        title: clip(n?.title, L.titleChars),
        text: clip(n?.text, L.textChars),
        points: ((Array.isArray(n?.subpoints) ? n.subpoints : []) as any[]).slice(0, L.subpoints).map((p) => ({ title: clip(p?.title, L.titleChars), text: clip(p?.text, L.textChars) })),
    }));
    const actions = ((Array.isArray(insight?.actionItems) ? insight.actionItems : []) as any[]).slice(0, L.actions).map((a) => {
        const owner = clip(a?.ownerDisplayName, 120);
        return { title: clip(a?.title, L.titleChars), text: clip(a?.text, L.textChars), owner, mine: !!owner && isMe(owner, me) };
    });
    return {
        notes: notes.filter((n) => n.title || n.text),
        actions: actions.filter((a) => a.title || a.text),
    };
}

const NO_ACCESS = /forbidden|does not have access|\b403\b|3003/i;

/**
 * A meeting's recap, if Teams wrote one: every part of this occurrence's, merged. Throttling throws
 * (the scan stops there); no access is final. Only a look that worked can say there's no recap (once
 * the wait is over); a look that failed changes nothing. `known` names the insights a ready recap was
 * made from: when they're still all there is, nothing more is read.
 */
export async function readRecap(client: McpClient, meeting: CalendarMeeting, me: TeamsMe, now: number, known: string[] | null = null): Promise<Recap> {
    const empty = { insightIds: [], notes: [], actions: [] };
    const failed = (calls: number): Recap => ({ state: "pending", ...empty, calls, failed: true });
    let first;
    try {
        first = await client.call("GetOnlineMeetingAiInsights", { joinWebUrl: meeting.joinUrl });
    } catch (error) {
        if (error instanceof McpError && error.throttled) throw error;
        if (NO_ACCESS.test((error as Error).message)) return { state: "noaccess", ...empty, calls: 1 };
        return failed(1);
    }
    const picks = pickInsights(first.json?.allInsights, meeting.start, meeting.end);
    if (!picks.length) return { state: now - time(meeting.end) > MEETING_LIMITS.recapWaitMs ? "none" : "pending", ...empty, calls: 1 };
    const ids = picks.map((p) => p.id);
    if (known && known.length === ids.length && known.every((id, i) => id === ids[i])) return { state: "ready", ...empty, insightIds: ids, calls: 1, unchanged: true };
    let calls = 1;
    const parts: Array<Pick<Recap, "notes" | "actions">> = [];
    for (const pick of picks) {
        let insight = endedAt(first.json?.selectedInsight) === pick.ended ? first.json.selectedInsight : null;
        if (!insight) {
            calls++;
            try {
                insight = (await client.call("GetOnlineMeetingAiInsights", { joinWebUrl: meeting.joinUrl, aiInsightId: pick.id })).json?.selectedInsight;
            } catch (error) {
                if (error instanceof McpError && error.throttled) throw error;
                return failed(calls);
            }
        }
        if (!insight || endedAt(insight) !== pick.ended) return failed(calls);
        parts.push(recapFrom(insight, me));
    }
    const seen = new Set<string>();
    const actions = parts
        .flatMap((p) => p.actions)
        .filter((a) => {
            const key = `${a.title}|${a.text}|${a.owner}`.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    return {
        state: "ready",
        insightIds: ids,
        notes: parts.flatMap((p) => p.notes).slice(0, MEETING_LIMITS.notes),
        actions: actions.slice(0, MEETING_LIMITS.actions),
        calls,
    };
}
