// The S360 watcher: the S360 action items (KPIs) assigned to the user, or whose action owner the
// user is, kept and shown in the Workspace's S360 panel. Once a day (soon after the service starts,
// then just after each local midnight, and on Scan now) it reads them through the S360 MCP server
// (`agency mcp s360-breeze`): one search for the items assigned to the user and one for the items
// they own, merged into one list. No model, no tools beyond those reads: it never changes anything
// in S360.
//
// Needs you shows an item that's new, or approaching or past its SLA. It stays until the user
// dismisses it, makes it a to-do, or S360 closes it (it's no longer in a complete read). A dismissed
// item comes back only when it gets worse: in SLA to approaching, approaching to out of SLA. The
// very first read is a baseline: what's already there only shows when it's approaching or past its
// SLA, so turning the watcher on doesn't fill Needs you with old items. The panel lists them all.

import { createHash } from "node:crypto";
import { jarvisDb, JarvisError } from "./jarvis-store.mjs";
import { McpError, openMcp, type McpClient } from "./mcp-stdio.mjs";
import { agencyExePath } from "./copilot-runtime.mjs";
import { s360Link, webLink } from "./s360-link.mjs";

export { s360Link, webLink };

export const S360_LIMITS = {
    /** The first look after the service starts, once Copilot is up. */
    firstMs: 25_000,
    /** A new day's read lands this long after local midnight. */
    afterMidnightMs: 5 * 60_000,
    /** The timer never waits longer than this, so a sleep or a clock change can't skip a day. */
    maxWaitMs: 60 * 60_000,
    /** Without Agency: how soon to look for it again, so its install is picked up. */
    agencyMs: 5 * 60_000,
    /** After a failed read: doubles each time, up to the max. */
    backoffMs: 30 * 60_000,
    maxBackoffMs: 2 * 60 * 60_000,
    /** Items per page, and pages per search; more than that and the read isn't complete. */
    pageSize: 200,
    maxPages: 10,
    /** S360 links asked for per read; the rest wait for the next one. */
    linkCalls: 20,
    /** Closed items are kept this long, so the panel can show what closed lately. */
    keepClosedMs: 14 * 86_400_000,
    /** An S360 link is asked for again after this. */
    keepLinksMs: 30 * 86_400_000,
    /** Who the user is (their alias) is looked up again after this. */
    meMs: 7 * 86_400_000,
    statusChars: 1_000,
};

const SEARCH_TOOL = "search_active_s360_kpi_action_items";
const LINK_TOOL = "generate_s360_item_link";
const THROTTLED = /\b429\b|too ?many ?requests|throttl/i;
const ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How an item is the user's: assigned to them, or they're its action owner. */
export type S360Role = "assigned" | "owner";

/** An action item as a read found it. */
export interface S360Seen {
    /** A hash of the KPI, the action item and its target: the same for as long as the item is open. */
    key: string;
    kpiId: string;
    itemId: string;
    /** What the item is on: Person, Service, ... and its id (an alias, a Service Tree id). */
    targetType: string;
    targetId: string;
    title: string;
    /** InSla, ApproachingSla or OutOfSla, as S360 says it. */
    sla: string;
    /** Its due date and ETA, ISO; "" when there's none. */
    due: string;
    eta: string;
    /** The latest status someone wrote on it, and who. */
    status: string;
    statusBy: string;
    assignedTo: string;
    /** The action owner's alias. */
    owner: string;
    /** The service it's on, and its kind of work (ActionItemSubtype). */
    service: string;
    kind: string;
    severity: string;
    /** The KPI's guidance, and the item's ADO work item; "" when there's none. */
    url: string;
    adoUrl: string;
    published: string;
    updated: string;
    roles: S360Role[];
}

/** An item as the panel shows it. */
export interface S360Item extends S360Seen {
    /** The KPI in the S360 portal (for a service, the service's view of it); "" until it's known. */
    link: string;
    firstSeen: string;
    lastSeen: string;
    /** When S360 stopped listing it; null while it's open. */
    resolvedAt: string | null;
    /** Needs you shows it. */
    need: boolean;
    /** The user dismissed it from Needs you. */
    dismissed: boolean;
}

/** An item waiting on the user, as Needs you shows it. */
export interface S360Need {
    /** need:s360:<the item's key>. */
    key: string;
    /** When it came to need the user: found, or got closer to (or past) its SLA. */
    at: string;
    item: S360Item;
}

/** What a read did. */
export interface S360ReadInfo {
    at: string;
    ok: boolean;
    calls: number;
    /** The user's open items S360 listed. */
    items: number;
    /** New ones, closed ones. */
    found: number;
    resolved: number;
    throttled: boolean;
    error?: string;
}

export interface S360Status {
    enabled: boolean;
    scanning: boolean;
    agency: boolean;
    /** The alias the items are read for; null until the first read. */
    alias: string | null;
    last: S360ReadInfo | null;
    /** When it last read S360 whole. */
    readAt: string | null;
    nextAt: string | null;
}

/** What Today carries: enough to know when to read the list again, and what's late. */
export interface S360Digest {
    version: string;
    enabled: boolean;
    open: number;
    /** Open items approaching, and past, their SLA. */
    soon: number;
    late: number;
}

// ---- where the data comes from ------------------------------------------------------

/** S360, who the user is, and the clock, as the module sees them. The harness swaps in a fake. */
export interface S360Runtime {
    now(): number;
    open(server: "s360-breeze" | "m365-user"): Promise<McpClient>;
    /** Agency is installed, so its S360 server can start. Absent means yes. */
    agency?(): boolean;
}

const sdkRuntime: S360Runtime = {
    now: () => Date.now(),
    open: (server) => openMcp(server),
    agency: () => !!agencyExePath(),
};

let runtime: S360Runtime = sdkRuntime;

export function setS360Runtime(next: S360Runtime | null): void {
    runtime = next || sdkRuntime;
}

const iso = (ms = runtime.now()): string => new Date(ms).toISOString();
const time = (value: string | null | undefined): number => Date.parse(value || "") || 0;

/** A time's local day, YYYY-MM-DD: the watcher reads once per the user's day. */
function localDay(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---- reading what S360 sends --------------------------------------------------------

const str = (value: unknown, max = 300): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** A date S360 sent, as ISO; "" when there's none (null, or a placeholder year). */
function when(value: unknown): string {
    const t = Date.parse(str(value, 60));
    return Number.isFinite(t) && new Date(t).getUTCFullYear() >= 2000 ? new Date(t).toISOString() : "";
}

/** How far along an item is: in SLA (or unknown) 0, approaching 1, out of SLA 2. */
export function slaRank(sla: string): number {
    const s = sla.toLowerCase();
    if (s === "outofsla") return 2;
    if (s === "approachingsla") return 1;
    return 0;
}

export const s360ItemKey = (kpiId: string, itemId: string, targetId: string): string =>
    createHash("sha256").update(`${kpiId}|${itemId}|${targetId}`.toLowerCase()).digest("hex").slice(0, 16);

/** The Needs you key of an item: the same for as long as it's open. */
export const s360NeedKey = (key: string): string => `need:s360:${key}`;

const obj = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** One action item S360 sent; null when it has no KPI or id to know it by. */
function seenFrom(value: unknown, role: S360Role): S360Seen | null {
    const r = obj(value);
    const kpiId = str(r.KpiId, 100);
    const itemId = str(r.KpiActionItemId, 500);
    if (!kpiId || !itemId) return null;
    const targetId = str(r.TargetId, 200);
    const dims = obj(r.S360Dimensions);
    const custom = obj(r.CustomDimensions);
    const status = typeof r.CurrentStatus === "string" ? r.CurrentStatus.replace(/\s+/g, " ").trim() : "";
    return {
        key: s360ItemKey(kpiId, itemId, targetId),
        kpiId,
        itemId,
        targetType: str(r.TargetType, 40),
        targetId,
        title: str(r.Title) || str(custom.RuleDisplayName) || "(untitled)",
        sla: str(r.SLAState, 40),
        due: when(r.CurrentDueDate) || when(r.OriginalDueDate),
        eta: when(r.CurrentETA),
        status: status.length > S360_LIMITS.statusChars ? `${status.slice(0, S360_LIMITS.statusChars - 1).trimEnd()}…` : status,
        statusBy: str(r.CurrentStatusAuthor, 80),
        assignedTo: str(r.AssignedTo, 80),
        owner: str(dims.ActionOwnerAlias, 80) || str(r.ActionOwnerAlias, 80),
        service: str(custom.ServiceName, 200),
        kind: str(custom.ActionItemSubtype, 120),
        severity: str(dims.Severity, 40),
        url: webLink(r.URL),
        adoUrl: webLink(dims.ADOWorkItemHTMLUrl),
        published: when(r.OriginalPublishTime),
        updated: when(r.LastUpdateTime),
        roles: [role],
    };
}

/** One page of a search: its items, and the cursor to the next page ("" on the last). Throws when S360 said no. */
export function parseS360Page(json: unknown, role: S360Role): { items: S360Seen[]; cursor: string } {
    const body = obj(json);
    if (body.success === false) {
        const e = body.error;
        const why = str(typeof e === "string" ? e : obj(e).message, 300) || str(body.message, 300);
        throw new McpError(why ? `S360: ${why}` : "S360 couldn't list the action items.", THROTTLED.test(why));
    }
    const result = obj(body.result);
    if (!Array.isArray(result.resources)) throw new McpError("S360 sent back something unexpected.");
    const items = result.resources.map((r) => seenFrom(r, role)).filter((s): s is S360Seen => !!s);
    return { items, cursor: typeof result.nextCursor === "string" ? result.nextCursor : "" };
}

/** The items of every search as one list: an item both searches found is one, with both roles. */
export function mergeS360Items(...lists: ReadonlyArray<ReadonlyArray<S360Seen>>): S360Seen[] {
    const byKey = new Map<string, S360Seen>();
    for (const list of lists) {
        for (const item of list) {
            const had = byKey.get(item.key);
            if (!had) {
                byKey.set(item.key, { ...item, roles: [...item.roles] });
                continue;
            }
            const merged: Record<string, unknown> = { ...had };
            for (const [field, value] of Object.entries(item)) if (typeof value === "string" && !merged[field]) merged[field] = value;
            const roles = new Set<S360Role>([...had.roles, ...item.roles]);
            merged.roles = (["assigned", "owner"] as const).filter((r) => roles.has(r));
            byKey.set(item.key, merged as unknown as S360Seen);
        }
    }
    return [...byKey.values()];
}

/** The user's alias from their Microsoft 365 profile: the sign-in name before the @. */
export function aliasFrom(json: unknown): string | null {
    const body = obj(json);
    const u = Object.keys(obj(body.user)).length ? obj(body.user) : body;
    for (const value of [u.userPrincipalName, u.mail]) {
        if (typeof value !== "string" || !value.includes("@")) continue;
        const alias = value.trim().split("@")[0].toLowerCase();
        if (ALIAS.test(alias)) return alias;
    }
    return null;
}

/** When the next day's read is due from `now`: just after the next local midnight, but never more than an hour away. */
export function msToNextRead(now: number): number {
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const ms = midnight.getTime() + S360_LIMITS.afterMidnightMs - now;
    return Math.max(1_000, Math.min(ms, S360_LIMITS.maxWaitMs));
}

/** The wait after a failed read: 30 minutes, doubling each time, up to 2 hours. */
export function nextBackoff(backoff: number): number {
    return Math.min(backoff ? backoff * 2 : S360_LIMITS.backoffMs, S360_LIMITS.maxBackoffMs);
}

// ---- storage ------------------------------------------------------------------------

let schemaReady: Promise<void> | null = null;

async function db() {
    const d = await jarvisDb();
    schemaReady ??= Promise.resolve().then(() => {
        d.exec(`
            CREATE TABLE IF NOT EXISTS s360_items (
                key            TEXT PRIMARY KEY,
                kpi_id         TEXT NOT NULL,
                item_id        TEXT NOT NULL,
                target_type    TEXT NOT NULL DEFAULT '',
                target_id      TEXT NOT NULL DEFAULT '',
                title          TEXT NOT NULL DEFAULT '',
                sla            TEXT NOT NULL DEFAULT '',
                due            TEXT NOT NULL DEFAULT '',
                eta            TEXT NOT NULL DEFAULT '',
                status         TEXT NOT NULL DEFAULT '',
                status_by      TEXT NOT NULL DEFAULT '',
                assigned_to    TEXT NOT NULL DEFAULT '',
                owner          TEXT NOT NULL DEFAULT '',
                service        TEXT NOT NULL DEFAULT '',
                kind           TEXT NOT NULL DEFAULT '',
                severity       TEXT NOT NULL DEFAULT '',
                url            TEXT NOT NULL DEFAULT '',
                ado_url        TEXT NOT NULL DEFAULT '',
                published      TEXT NOT NULL DEFAULT '',
                updated        TEXT NOT NULL DEFAULT '',
                roles          TEXT NOT NULL DEFAULT '',
                first_seen     TEXT NOT NULL,
                last_seen      TEXT NOT NULL,
                resolved_at    TEXT,
                noticed        INTEGER NOT NULL DEFAULT 0,
                noticed_at     TEXT,
                dismissed_rank INTEGER
            );
            CREATE TABLE IF NOT EXISTS s360_links (pair TEXT PRIMARY KEY, link TEXT NOT NULL, at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS s360_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        `);
    });
    await schemaReady;
    return d;
}

async function readState<T>(key: string, fallback: T): Promise<T> {
    const row = (await db()).prepare("SELECT value FROM s360_state WHERE key = ?").get(key) as { value: string } | undefined;
    if (!row) return fallback;
    try {
        return JSON.parse(row.value) as T;
    } catch {
        return fallback;
    }
}

async function writeState(key: string, value: unknown): Promise<void> {
    (await db()).prepare("INSERT INTO s360_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
}

const bumpVersion = async (): Promise<void> => writeState("version", (await readState<number>("version", 0)) + 1);

type Db = Awaited<ReturnType<typeof db>>;
type Row = Record<string, unknown>;

function inTransaction<T>(d: Db, fn: () => T): T {
    d.exec("BEGIN IMMEDIATE");
    try {
        const result = fn();
        d.exec("COMMIT");
        return result;
    } catch (error) {
        d.exec("ROLLBACK");
        throw error;
    }
}

/** The service an item's S360 link is for: a Service Tree id, or "" for the KPI alone. */
const serviceOf = (targetType: string, targetId: string): string => (targetType.toLowerCase() === "service" && GUID.test(targetId) ? targetId.toLowerCase() : "");
const pairOf = (kpiId: string, service: string): string => `${kpiId.toLowerCase()}|${service}`;

function itemOf(r: Row, links: ReadonlyMap<string, string>): S360Item {
    const targetType = String(r.target_type);
    const targetId = String(r.target_id);
    const resolvedAt = (r.resolved_at as string | null) ?? null;
    const dismissed = r.dismissed_rank !== null && r.dismissed_rank !== undefined;
    const roles = String(r.roles || "")
        .split(",")
        .filter((x): x is S360Role => x === "assigned" || x === "owner");
    return {
        key: String(r.key),
        kpiId: String(r.kpi_id),
        itemId: String(r.item_id),
        targetType,
        targetId,
        title: String(r.title),
        sla: String(r.sla),
        due: String(r.due),
        eta: String(r.eta),
        status: String(r.status),
        statusBy: String(r.status_by),
        assignedTo: String(r.assigned_to),
        owner: String(r.owner),
        service: String(r.service),
        kind: String(r.kind),
        severity: String(r.severity),
        url: String(r.url),
        adoUrl: String(r.ado_url),
        published: String(r.published),
        updated: String(r.updated),
        roles,
        link: links.get(pairOf(String(r.kpi_id), serviceOf(targetType, targetId))) || "",
        firstSeen: String(r.first_seen),
        lastSeen: String(r.last_seen),
        resolvedAt,
        need: !resolvedAt && Number(r.noticed) === 1 && !dismissed,
        dismissed,
    };
}

async function linkMap(): Promise<Map<string, string>> {
    const rows = (await db()).prepare("SELECT pair, link FROM s360_links WHERE link <> ''").all() as Array<{ pair: string; link: string }>;
    return new Map(rows.map((r) => [r.pair, r.link]));
}

/**
 * Keep what a read found. New items need the user (in the baseline read, only those approaching or
 * past their SLA); an item that got to approaching or past its SLA needs them; a dismissed item that
 * got worse comes back; a closed one that's listed again opens again. When the read was complete,
 * an open item it didn't list is closed.
 */
async function saveItems(items: ReadonlyArray<S360Seen>, complete: boolean): Promise<{ found: number; resolved: number }> {
    const d = await db();
    const baseline = !(await readState<boolean>("baselined", false));
    const at = iso();
    const counts = inTransaction(d, () => {
        const rows = new Map((d.prepare("SELECT key, resolved_at, noticed, noticed_at, dismissed_rank FROM s360_items").all() as Row[]).map((r) => [String(r.key), r]));
        const insert = d.prepare(`
            INSERT INTO s360_items (key, kpi_id, item_id, target_type, target_id, title, sla, due, eta, status, status_by, assigned_to, owner,
                service, kind, severity, url, ado_url, published, updated, roles, first_seen, last_seen, resolved_at, noticed, noticed_at, dismissed_rank)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`);
        const update = d.prepare(`
            UPDATE s360_items SET kpi_id = ?, item_id = ?, target_type = ?, target_id = ?, title = ?, sla = ?, due = ?, eta = ?, status = ?, status_by = ?,
                assigned_to = ?, owner = ?, service = ?, kind = ?, severity = ?, url = ?, ado_url = ?, published = ?, updated = ?, roles = ?,
                last_seen = ?, resolved_at = NULL, noticed = ?, noticed_at = ?, dismissed_rank = ?
            WHERE key = ?`);
        let found = 0;
        let resolved = 0;
        for (const it of items) {
            const rank = slaRank(it.sla);
            const fields = [it.kpiId, it.itemId, it.targetType, it.targetId, it.title, it.sla, it.due, it.eta, it.status, it.statusBy, it.assignedTo, it.owner, it.service, it.kind, it.severity, it.url, it.adoUrl, it.published, it.updated, it.roles.join(",")];
            const old = rows.get(it.key);
            if (!old) {
                const noticed = !baseline || rank >= 1;
                insert.run(it.key, ...fields, at, at, noticed ? 1 : 0, noticed ? at : null);
                found++;
                continue;
            }
            let noticed = Number(old.noticed) === 1;
            let noticedAt = (old.noticed_at as string | null) ?? null;
            let dismissedRank = old.dismissed_rank === null || old.dismissed_rank === undefined ? null : Number(old.dismissed_rank);
            if (old.resolved_at) {
                // Closed, and listed again: it's open again, and new to the user.
                noticed = true;
                noticedAt = at;
                dismissedRank = null;
                found++;
            } else {
                if (rank >= 1 && !noticed) {
                    noticed = true;
                    noticedAt = at;
                }
                if (dismissedRank !== null && rank > dismissedRank) {
                    noticed = true;
                    noticedAt = at;
                    dismissedRank = null;
                }
            }
            update.run(...fields, at, noticed ? 1 : 0, noticedAt, dismissedRank, it.key);
        }
        if (complete) {
            const listed = new Set(items.map((i) => i.key));
            const close = d.prepare("UPDATE s360_items SET resolved_at = ? WHERE key = ?");
            for (const [key, r] of rows) {
                if (r.resolved_at || listed.has(key)) continue;
                close.run(at, key);
                resolved++;
            }
        }
        d.prepare("DELETE FROM s360_items WHERE resolved_at IS NOT NULL AND resolved_at < ?").run(iso(runtime.now() - S360_LIMITS.keepClosedMs));
        d.prepare("DELETE FROM s360_links WHERE at < ?").run(iso(runtime.now() - S360_LIMITS.keepLinksMs));
        return { found, resolved };
    });
    if (complete && baseline) await writeState("baselined", true);
    return counts;
}

/**
 * Ask S360 for the links of the open items that have none: one per KPI and service, kept a month.
 * At most a few per read; a link that fails is asked for again next read and never fails the read.
 */
async function fillLinks(client: McpClient, counter: { calls: number }): Promise<number> {
    const d = await db();
    const known = new Set((d.prepare("SELECT pair FROM s360_links").all() as Array<{ pair: string }>).map((r) => r.pair));
    const rows = d.prepare("SELECT DISTINCT kpi_id, target_type, target_id FROM s360_items WHERE resolved_at IS NULL").all() as Row[];
    const wanted = new Map<string, { kpiId: string; service: string }>();
    for (const r of rows) {
        const service = serviceOf(String(r.target_type), String(r.target_id));
        const pair = pairOf(String(r.kpi_id), service);
        if (!known.has(pair)) wanted.set(pair, { kpiId: String(r.kpi_id), service });
    }
    const put = d.prepare("INSERT INTO s360_links (pair, link, at) VALUES (?, ?, ?) ON CONFLICT(pair) DO UPDATE SET link = excluded.link, at = excluded.at");
    let added = 0;
    let asked = 0;
    for (const [pair, w] of wanted) {
        if (asked >= S360_LIMITS.linkCalls) break;
        asked++;
        counter.calls++;
        try {
            const r = await client.call(LINK_TOOL, { kpiId: w.kpiId, ...(w.service ? { serviceId: w.service } : {}) });
            const body = obj(r.json);
            const link = body.success === false ? "" : s360Link(obj(body.result).url);
            if (!link) continue;
            put.run(pair, link, iso());
            added++;
        } catch (error) {
            console.warn(`[s360] link: ${(error as Error).message}`);
            if ((error as { throttled?: boolean }).throttled) break;
        }
    }
    return added;
}

// ---- reading S360 -------------------------------------------------------------------

/** Whether the watcher reads S360: on unless the user turned it off (or ADO_PR_OPS_S360=off). */
export async function s360Enabled(): Promise<boolean> {
    if (process.env.ADO_PR_OPS_S360 === "off") return false;
    return (await readState<boolean>("enabled", true)) !== false;
}

async function myAlias(counter: { calls: number }): Promise<string> {
    const cached = await readState<{ alias: string; at: number } | null>("me", null);
    if (cached?.alias && ALIAS.test(cached.alias) && runtime.now() - cached.at < S360_LIMITS.meMs) return cached.alias;
    const client = await runtime.open("m365-user");
    try {
        counter.calls++;
        const alias = aliasFrom((await client.call("GetMyDetails", { select: "id,displayName,givenName,mail,userPrincipalName" })).json);
        if (!alias) throw new Error("Couldn't tell your alias from your Microsoft 365 profile.");
        await writeState("me", { alias, at: runtime.now() });
        return alias;
    } finally {
        client.close();
    }
}

/** Every page of one search. Not complete when it ran out of pages, or S360 gave the same cursor twice. */
async function searchAll(client: McpClient, alias: string, role: S360Role, counter: { calls: number }): Promise<{ items: S360Seen[]; complete: boolean }> {
    const items: S360Seen[] = [];
    let cursor = "";
    for (let page = 0; page < S360_LIMITS.maxPages; page++) {
        const request = { ...(role === "assigned" ? { assignedTo: [alias] } : { actionOwners: [alias] }), pageSize: S360_LIMITS.pageSize, ...(cursor ? { cursor } : {}) };
        counter.calls++;
        const next = parseS360Page((await client.call(SEARCH_TOOL, { request, environment: "Production" })).json, role);
        items.push(...next.items);
        if (!next.cursor) return { items, complete: true };
        if (next.cursor === cursor) return { items, complete: false };
        cursor = next.cursor;
    }
    return { items, complete: false };
}

/** One read: both searches, what changed kept, and the links that are missing. Throws when nothing could be read. */
async function readOnce(counter: { calls: number }): Promise<S360ReadInfo> {
    const alias = await myAlias(counter);
    const client = await runtime.open("s360-breeze");
    try {
        const lists: S360Seen[][] = [];
        let complete = true;
        let failure: Error | null = null;
        for (const role of ["assigned", "owner"] as const) {
            try {
                const r = await searchAll(client, alias, role, counter);
                lists.push(r.items);
                if (!r.complete) complete = false;
            } catch (error) {
                complete = false;
                failure ??= error as Error;
                if ((error as { throttled?: boolean }).throttled) break;
            }
        }
        if (!lists.length) throw failure ?? new Error("S360 couldn't be read.");
        const items = mergeS360Items(...lists);
        const { found, resolved } = await saveItems(items, complete);
        const throttled = !!(failure as { throttled?: boolean } | null)?.throttled;
        if (!throttled) await fillLinks(client, counter);
        // Cut short by the page cap, the read still counts for the day: reading again wouldn't get
        // further. It just closes nothing, and stays a baseline until a read gets everything.
        const ok = !failure;
        const error = failure
            ? `Only part of S360 could be read: ${failure.message}`
            : !complete
              ? "S360 listed more items than one read takes; the rest wait for the next read."
              : undefined;
        return {
            at: iso(),
            ok,
            calls: counter.calls,
            items: items.length,
            found,
            resolved,
            throttled,
            ...(error ? { error: error.slice(0, 300) } : {}),
        };
    } finally {
        client.close();
    }
}

/** Every item, open ones first (the latest SLA first, then the soonest due), then the ones closed lately. */
export async function listS360Items(): Promise<S360Item[]> {
    const links = await linkMap();
    const rows = (await db()).prepare("SELECT * FROM s360_items").all() as Row[];
    const due = (i: S360Item): number => time(i.due) || Number.MAX_SAFE_INTEGER;
    return rows
        .map((r) => itemOf(r, links))
        .sort(
            (a, b) =>
                Number(!!a.resolvedAt) - Number(!!b.resolvedAt) ||
                (a.resolvedAt && b.resolvedAt ? time(b.resolvedAt) - time(a.resolvedAt) : 0) ||
                slaRank(b.sla) - slaRank(a.sla) ||
                due(a) - due(b) ||
                a.title.localeCompare(b.title) ||
                a.key.localeCompare(b.key),
        );
}

/** What waits on the user, oldest first. None while the watcher is off. */
export async function s360Needs(): Promise<S360Need[]> {
    if (!(await s360Enabled())) return [];
    const links = await linkMap();
    const rows = (await db()).prepare("SELECT * FROM s360_items WHERE resolved_at IS NULL AND noticed = 1 AND dismissed_rank IS NULL").all() as Row[];
    return rows
        .map((r) => ({ key: s360NeedKey(String(r.key)), at: String(r.noticed_at || r.first_seen), item: itemOf(r, links) }))
        .sort((a, b) => time(a.at) - time(b.at) || a.key.localeCompare(b.key));
}

/**
 * The Needs you keys of every open item, dismissed or not: a to-do made from one ticks itself only
 * once S360 closes the item. None while the watcher is off (then its to-dos are left alone).
 */
export async function s360OpenKeys(): Promise<string[]> {
    if (!(await s360Enabled())) return [];
    const rows = (await db()).prepare("SELECT key FROM s360_items WHERE resolved_at IS NULL").all() as Array<{ key: string }>;
    return rows.map((r) => s360NeedKey(r.key));
}

export async function s360Digest(): Promise<S360Digest> {
    const rows = (await db()).prepare("SELECT sla FROM s360_items WHERE resolved_at IS NULL").all() as Array<{ sla: string }>;
    return {
        version: String(await readState<number>("version", 0)),
        enabled: await s360Enabled(),
        open: rows.length,
        soon: rows.filter((r) => slaRank(r.sla) === 1).length,
        late: rows.filter((r) => slaRank(r.sla) === 2).length,
    };
}

/** What Today carries: the digest, what waits on the user, and the keys that keep its to-dos open. */
export async function s360Today(): Promise<{ digest: S360Digest; needs: S360Need[]; open: string[] }> {
    const [digest, needs, open] = await Promise.all([s360Digest(), s360Needs(), s360OpenKeys()]);
    return { digest, needs, open };
}

/** The user dismissed an item from Needs you: it's back only if it gets worse. Returns what still waits. */
export async function dismissS360Need(key: unknown): Promise<S360Need[]> {
    if (typeof key !== "string" || !/^need:s360:[0-9a-f]{16}$/.test(key)) throw new JarvisError("Unknown item.");
    const id = key.slice("need:s360:".length);
    const d = await db();
    const row = d.prepare("SELECT sla FROM s360_items WHERE key = ? AND resolved_at IS NULL AND noticed = 1 AND dismissed_rank IS NULL").get(id) as { sla: string } | undefined;
    if (!row) throw new JarvisError("That item is gone.", 404);
    d.prepare("UPDATE s360_items SET dismissed_rank = ? WHERE key = ?").run(slaRank(row.sla), id);
    await bumpVersion();
    return s360Needs();
}

// ---- the schedule -------------------------------------------------------------------

const runner: {
    timer: ReturnType<typeof setTimeout> | null;
    nextAt: number | null;
    scanning: Promise<S360ReadInfo | null> | null;
    stopped: boolean;
    started: boolean;
    backoff: number;
} = { timer: null, nextAt: null, scanning: null, stopped: false, started: false, backoff: 0 };

function schedule(ms: number): void {
    if (runner.timer) clearTimeout(runner.timer);
    runner.timer = null;
    runner.nextAt = null;
    // A negative delay just stops the timer.
    if (runner.stopped || !runner.started || ms < 0) return;
    runner.nextAt = runtime.now() + ms;
    runner.timer = setTimeout(() => void scanS360("due").catch(() => undefined), ms);
    runner.timer.unref?.();
}

/** S360 was read whole today, the user's day. */
async function readToday(): Promise<boolean> {
    const at = await readState<string | null>("readAt", null);
    return !!at && localDay(time(at)) === localDay(runtime.now());
}

/**
 * Read S360, unless a read is running (then its result). "due" (the timer) reads only when it
 * wasn't read whole today; "now" (Scan now, turning it on) reads anyway. Off, it doesn't read and
 * the timer stops; without Agency it looks again in 5 minutes. A failed read is tried again in 30
 * minutes, then an hour, then every 2 hours, until one lands. Returns what the read did; null when
 * it didn't read.
 */
export function scanS360(which: "now" | "due" = "now"): Promise<S360ReadInfo | null> {
    if (runner.scanning) return runner.scanning;
    runner.scanning = (async () => {
        let info: S360ReadInfo | null = null;
        let ms: number;
        if (!(await s360Enabled())) {
            runner.backoff = 0;
            ms = -1;
        } else if (!(runtime.agency?.() ?? true)) {
            runner.backoff = 0;
            ms = S360_LIMITS.agencyMs;
        } else if (which === "due" && (await readToday())) {
            ms = msToNextRead(runtime.now());
        } else {
            const counter = { calls: 0 };
            try {
                info = await readOnce(counter);
            } catch (error) {
                info = {
                    at: iso(),
                    ok: false,
                    calls: counter.calls,
                    items: 0,
                    found: 0,
                    resolved: 0,
                    throttled: !!(error as { throttled?: boolean }).throttled,
                    error: ((error as Error).message || String(error)).slice(0, 300),
                };
            }
            await writeState("last", info);
            if (info.ok) await writeState("readAt", info.at);
            // Once what the read did is written: the page reads the items again, with it.
            await bumpVersion();
            if (info.ok) {
                runner.backoff = 0;
                ms = msToNextRead(runtime.now());
                console.log(`[s360] read: ${info.items} item(s), ${info.found} new, ${info.resolved} closed, ${info.calls} call(s)`);
            } else {
                runner.backoff = nextBackoff(runner.backoff);
                ms = runner.backoff;
                console.warn(`[s360] read: ${info.error}`);
            }
        }
        schedule(ms);
        return info;
    })().finally(() => {
        runner.scanning = null;
    });
    return runner.scanning;
}

export async function s360Status(): Promise<S360Status> {
    const me = await readState<{ alias: string } | null>("me", null);
    return {
        enabled: await s360Enabled(),
        scanning: !!runner.scanning,
        agency: runtime.agency?.() ?? true,
        alias: me?.alias || null,
        last: await readState<S360ReadInfo | null>("last", null),
        readAt: await readState<string | null>("readAt", null),
        nextAt: runner.nextAt ? new Date(runner.nextAt).toISOString() : null,
    };
}

/** Turn the watcher on or off. On reads at once; off keeps what was read, and Needs you stops showing it. */
export async function setS360Enabled(on: unknown): Promise<S360Status> {
    if (typeof on !== "boolean") throw new JarvisError("Say whether to read S360.");
    await writeState("enabled", on);
    await bumpVersion();
    if (runner.started) {
        // A read under way may have started before the switch: go again once it's done, so the timer fits.
        const scan = runner.scanning ? runner.scanning.catch(() => null).then(() => scanS360(on ? "now" : "due")) : scanS360(on ? "now" : "due");
        void scan.catch(() => undefined);
    }
    return s360Status();
}

export function startS360Runner(): void {
    if (runner.started) return;
    runner.started = true;
    runner.stopped = false;
    schedule(S360_LIMITS.firstMs);
}

/** Start the runner if the app didn't (dev server). Never restarts a stopped one. */
export function ensureS360Runner(): void {
    if (!runner.started && !runner.stopped) startS360Runner();
}

export async function stopS360Runner(): Promise<void> {
    runner.stopped = true;
    if (runner.timer) clearTimeout(runner.timer);
    runner.timer = null;
    runner.nextAt = null;
    await runner.scanning?.catch(() => undefined);
}

/** Back to a clean slate (the harness). */
export function resetS360(): void {
    if (runner.timer) clearTimeout(runner.timer);
    Object.assign(runner, { timer: null, nextAt: null, scanning: null, stopped: false, started: false, backoff: 0 });
    schemaReady = null;
}
