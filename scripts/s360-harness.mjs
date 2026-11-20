// The S360 watcher (s360.mts), over a fake S360 MCP server: what S360 sends read as items, the two
// searches merged, the first read as a baseline, what Needs you shows and when a dismissed item
// comes back, which reads may close items, paging and the page cap, the S360 links (cached, capped,
// never failing a read), who the user is, the daily schedule and its backoff, off and without
// Agency, the to-dos made from an item, and the HTTP routes.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "s360-"));
process.env.ADO_PR_OPS_DB_PATH = join(root, "data", "reviews.db");
process.env.ADO_PR_OPS_JARVIS_DIR = join(root, "jarvis");
process.env.ADO_PR_OPS_CONFIG_PATH = join(root, "config.json");
delete process.env.ADO_PR_OPS_S360;

const s360 = await import("../s360.mjs");
const mcp = await import("../mcp-stdio.mjs");
const { needKeys, NEED_KEY } = await import("../jarvis-needs.mjs");
const notes = await import("../jarvis-notes.mjs");
const { jarvisDb } = await import("../jarvis-store.mjs");
const { handleJarvisApi } = await import("../jarvis-api.mjs");
const { closeDb } = await import("../store.mjs");

const L = s360.S360_LIMITS;
const DAY = 86_400_000;
const SEARCH = "search_active_s360_kpi_action_items";
const LINK = "generate_s360_item_link";
const SERVICE = "0F3C1E2D-1111-4A4A-9B9B-ABCDEFABCDEF";
// Local noon, so a good read's timer waits the full hour.
const NOON = new Date(2026, 9, 27, 12, 0, 0).getTime();

let clock = NOON;
const iso = (ms = clock) => new Date(ms).toISOString();

/** An action item as S360 sends it: on the user (a Person), due n days into November. */
const raw = (n, over = {}) => ({
    KpiId: `kpi-${n}`,
    KpiActionItemId: `item-${n}`,
    TargetType: "Person",
    TargetId: "kj",
    Title: `Item ${n}`,
    SLAState: "InSla",
    CurrentDueDate: new Date(Date.UTC(2026, 10, 1) + n * DAY).toISOString(),
    OriginalDueDate: null,
    CurrentETA: "0001-01-01T00:00:00",
    CurrentStatus: "",
    CurrentStatusAuthor: "",
    AssignedTo: "kj",
    S360Dimensions: { ActionOwnerAlias: "kj", Severity: "", ADOWorkItemHTMLUrl: null },
    CustomDimensions: { ServiceName: "AppConfig", ActionItemSubtype: "Security" },
    URL: "https://aka.ms/guide",
    OriginalPublishTime: "2026-10-01T00:00:00Z",
    LastUpdateTime: "2026-10-20T00:00:00Z",
    ...over,
});
/** One on a service the user is the action owner of. */
const service = (n, over = {}) => raw(n, { TargetType: "Service", TargetId: SERVICE, AssignedTo: "dana", ...over });
const keyOf = (r) => s360.s360ItemKey(r.KpiId, r.KpiActionItemId, r.TargetId);
const needOf = (r) => s360.s360NeedKey(keyOf(r));
const linkFor = (kpiId, serviceId) => `https://s360.msftcloudes.com/blades/kpi?kpi=${kpiId}${serviceId ? `&service=${serviceId}` : ""}`;

// ---- a fake S360 MCP server, and Microsoft 365 for who the user is ------------------------

const fake = {};
function resetFake() {
    Object.assign(fake, {
        /** What each search lists. */
        assigned: [],
        owner: [],
        /** A role whose search throws this. */
        fail: {},
        /** Items per page; 0 is all on one. */
        pageSize: 0,
        /** A role whose cursor never ends ("owner"), or repeats ("owner:same"). */
        endless: "",
        /** A promise every search waits on. */
        gate: null,
        link: (args) => ({ success: true, result: { url: linkFor(args.kpiId, args.serviceId) } }),
        me: { user: { userPrincipalName: "KJ@contoso.com", displayName: "Kipack Jeong" } },
        meFail: null,
        openFail: null,
        agency: true,
    });
}
resetFake();

let calls = [];
const opened = [];
let clients = 0;
let closed = 0;
const take = () => {
    const made = calls;
    calls = [];
    return made;
};
const searches = (list) => list.filter((c) => c.tool === SEARCH);
const links = (list) => list.filter((c) => c.tool === LINK);

const page = (resources, nextCursor) => ({ text: "", json: { success: true, result: { resources: structuredClone(resources), nextCursor } } });

async function search(args) {
    if (fake.gate) await fake.gate;
    const role = args.request.assignedTo ? "assigned" : "owner";
    if (fake.fail[role]) throw fake.fail[role];
    const cursor = args.request.cursor || "";
    if (fake.endless === role) return page([], `c${Number(cursor.slice(1) || 0) + 1}`);
    if (fake.endless === `${role}:same`) return page([], "same");
    const all = fake[role];
    const size = fake.pageSize || Math.max(all.length, 1);
    const start = Number(cursor || 0);
    return page(all.slice(start, start + size), start + size < all.length ? String(start + size) : null);
}

s360.setS360Runtime({
    now: () => clock,
    agency: () => fake.agency,
    open: async (server) => {
        opened.push(server);
        if (fake.openFail && server === "s360-breeze") throw fake.openFail;
        clients++;
        return {
            async call(tool, args) {
                calls.push({ server, tool, args: structuredClone(args) });
                if (server === "m365-user") {
                    if (fake.meFail) throw fake.meFail;
                    return { text: "", json: fake.me };
                }
                if (tool === SEARCH) return search(args);
                if (tool === LINK) return { text: "", json: fake.link(args) };
                throw new Error(`unexpected tool ${tool}`);
            },
            close() {
                closed++;
            },
        };
    },
});

/** A clean slate: no items, links or state; the runner stopped; the fake as new. */
async function fresh() {
    await s360.stopS360Runner();
    s360.resetS360();
    (await jarvisDb()).exec("DROP TABLE IF EXISTS s360_items; DROP TABLE IF EXISTS s360_links; DROP TABLE IF EXISTS s360_state;");
    resetFake();
    clock = NOON;
    calls = [];
    opened.length = 0;
}

async function until(check, what) {
    const deadline = Date.now() + 5000;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

let failures = 0;
async function test(name, run) {
    try {
        await run();
        console.log(`ok   ${name}`);
    } catch (error) {
        failures++;
        console.log(`FAIL ${name}\n     ${error.stack?.split("\n").slice(0, 3).join("\n     ")}`);
    }
}

// ---- reading what S360 sends ----------------------------------------------------------

await test("what S360 sends reads as items", () => {
    const one = raw(1, {
        CurrentStatus: "  On it,\n  ETA   Friday ",
        CurrentStatusAuthor: "dana",
        S360Dimensions: { ActionOwnerAlias: "kj", Severity: "High", ADOWorkItemHTMLUrl: "https://msazure.visualstudio.com/One/_workitems/edit/1" },
    });
    const read = s360.parseS360Page(
        {
            success: true,
            result: {
                resources: [
                    one,
                    { KpiId: "kpi-x" },
                    "junk",
                    null,
                    raw(2, { Title: "", CustomDimensions: { RuleDisplayName: "Rotate the keys" }, CurrentDueDate: null, OriginalDueDate: "2026-12-01T00:00:00Z", URL: "javascript:alert(1)" }),
                    raw(3, { Title: "  ", CustomDimensions: {}, URL: "http://aka.ms/plain", CurrentStatus: "x".repeat(1500), CurrentDueDate: "0001-01-01T00:00:00" }),
                ],
                nextCursor: "abc",
            },
        },
        "owner",
    );
    assert.equal(read.cursor, "abc");
    assert.deepEqual(read.items[0], {
        key: keyOf(one),
        kpiId: "kpi-1",
        itemId: "item-1",
        targetType: "Person",
        targetId: "kj",
        title: "Item 1",
        sla: "InSla",
        due: "2026-11-02T00:00:00.000Z",
        eta: "",
        status: "On it, ETA Friday",
        statusBy: "dana",
        assignedTo: "kj",
        owner: "kj",
        service: "AppConfig",
        kind: "Security",
        severity: "High",
        url: "https://aka.ms/guide",
        adoUrl: "https://msazure.visualstudio.com/One/_workitems/edit/1",
        published: "2026-10-01T00:00:00.000Z",
        updated: "2026-10-20T00:00:00.000Z",
        roles: ["owner"],
    });
    assert.equal(read.items.length, 3, "one without a KPI or an id is dropped");
    const [, two, three] = read.items;
    assert.equal(two.title, "Rotate the keys", "no title: the rule's name");
    assert.equal(two.due, "2026-12-01T00:00:00.000Z", "no current due date: the original one");
    assert.equal(two.url, "", "only https links");
    assert.equal(two.service, "");
    assert.equal(three.title, "(untitled)");
    assert.equal(three.url, "");
    assert.equal(three.due, "", "a placeholder date is none");
    assert.equal(three.status.length, L.statusChars);
    assert.ok(three.status.endsWith("…"));
    assert.equal(s360.parseS360Page({ success: true, result: { resources: [], nextCursor: null } }, "assigned").cursor, "", "the last page");
});

await test("S360 saying no, or sending something else, fails the search", () => {
    const parse = (json) => () => s360.parseS360Page(json, "assigned");
    assert.throws(parse({ success: false, error: "429 Too Many Requests" }), (e) => e instanceof mcp.McpError && e.throttled && e.message === "S360: 429 Too Many Requests");
    assert.throws(parse({ success: false, error: { message: "No access to S360" } }), (e) => e instanceof mcp.McpError && !e.throttled && e.message === "S360: No access to S360");
    assert.throws(parse({ success: false, message: "Request throttled" }), (e) => e.throttled === true);
    assert.throws(parse({ success: false }), (e) => !e.throttled && e.message === "S360 couldn't list the action items.");
    for (const json of [null, [], {}, { success: true }, { result: { resources: "none" } }]) assert.throws(parse(json), /unexpected/, JSON.stringify(json));
});

await test("an item both searches find is one item, with both roles", () => {
    const asAssigned = s360.parseS360Page({ success: true, result: { resources: [raw(1, { S360Dimensions: {} }), raw(2)] } }, "assigned").items;
    const asOwner = s360.parseS360Page({ success: true, result: { resources: [raw(1, { S360Dimensions: { ActionOwnerAlias: "kj", Severity: "High" } }), raw(3)] } }, "owner").items;
    const merged = s360.mergeS360Items(asAssigned, asOwner);
    assert.deepEqual(
        merged.map((i) => i.kpiId),
        ["kpi-1", "kpi-2", "kpi-3"],
    );
    assert.deepEqual(merged[0].roles, ["assigned", "owner"]);
    assert.equal(merged[0].owner, "kj", "what one search left empty, the other fills in");
    assert.equal(merged[0].severity, "High");
    assert.deepEqual(s360.mergeS360Items(asOwner, asAssigned)[0].roles, ["assigned", "owner"], "in the same order either way");
    assert.deepEqual(asAssigned[0].roles, ["assigned"], "the lists themselves are left alone");
    assert.equal(asAssigned[0].owner, "");
});

await test("the user's alias comes from their sign-in name, or their mail", () => {
    assert.equal(s360.aliasFrom({ user: { userPrincipalName: "KJ@contoso.com" } }), "kj");
    assert.equal(s360.aliasFrom({ mail: "dana.lee@contoso.com" }), "dana.lee");
    assert.equal(s360.aliasFrom({ user: { userPrincipalName: "kj_contoso.com#EXT#@fabrikam.onmicrosoft.com", mail: "kj@contoso.com" } }), "kj", "a guest's sign-in name isn't an alias; their mail is");
    assert.equal(s360.aliasFrom({ user: { displayName: "Kipack Jeong" } }), null);
    assert.equal(s360.aliasFrom({ userPrincipalName: "@contoso.com" }), null);
    assert.equal(s360.aliasFrom(null), null);
});

await test("an item's key, its Needs you key, and the links it shows", () => {
    const key = s360.s360ItemKey("KPI-1", "Item-1", "KJ");
    assert.match(key, /^[0-9a-f]{16}$/);
    assert.equal(key, s360.s360ItemKey("kpi-1", "item-1", "kj"), "case doesn't make it another item");
    assert.notEqual(key, s360.s360ItemKey("kpi-1", "item-1", "dana"), "the same KPI on another target is another item");
    assert.equal(s360.s360NeedKey(key), `need:s360:${key}`);
    assert.match(s360.s360NeedKey(key), NEED_KEY);
    assert.deepEqual(
        ["OutOfSla", "approachingsla", "InSla", "", "Unknown"].map((s) => s360.slaRank(s)),
        [2, 1, 0, 0, 0],
    );
    assert.equal(s360.webLink(" https://aka.ms/guide "), "https://aka.ms/guide");
    for (const bad of ["http://aka.ms/guide", "javascript:alert(1)", "https://me:secret@aka.ms/x", "not a link", 42, null, `https://aka.ms/${"x".repeat(2000)}`]) {
        assert.equal(s360.webLink(bad), "", String(bad).slice(0, 40));
    }
    assert.equal(s360.s360Link("https://s360.msftcloudes.com/blades/security?x=1"), "https://s360.msftcloudes.com/blades/security?x=1");
    assert.equal(s360.s360Link("https://preview.s360.msftcloudes.com/x"), "https://preview.s360.msftcloudes.com/x");
    for (const bad of ["https://aka.ms/guide", "https://s360.msftcloudes.com.evil.example/x", "https://evil.example/?s360.msftcloudes.com", "http://s360.msftcloudes.com/x"]) {
        assert.equal(s360.s360Link(bad), "", bad);
    }
});

await test("when the next read is due, and the wait after a failed one", () => {
    const at = (h, m = 0) => new Date(2026, 9, 27, h, m).getTime();
    assert.equal(s360.msToNextRead(at(12)), L.maxWaitMs, "midday: look again within the hour");
    assert.equal(s360.msToNextRead(at(23, 58)), 2 * 60_000 + L.afterMidnightMs, "late: just after midnight");
    assert.equal(s360.msToNextRead(at(0, 0)), L.maxWaitMs, "just past midnight: the next one is a day off");
    assert.equal(s360.nextBackoff(0), L.backoffMs);
    assert.equal(s360.nextBackoff(L.backoffMs), 2 * L.backoffMs);
    assert.equal(s360.nextBackoff(2 * L.backoffMs), L.maxBackoffMs);
    assert.equal(s360.nextBackoff(L.maxBackoffMs), L.maxBackoffMs, "capped");
});

// ---- reads ----------------------------------------------------------------------------

await test("the first read is a baseline: the panel lists everything, Needs you only what's near or past its SLA", async () => {
    await fresh();
    const one = raw(1);
    const two = raw(2, { SLAState: "ApproachingSla" });
    const three = service(3);
    const four = service(4, { KpiId: "kpi-3", SLAState: "OutOfSla" });
    fake.assigned = [one, two];
    fake.owner = [one, three, four];
    s360.startS360Runner();
    assert.equal(Date.parse((await s360.s360Status()).nextAt), clock + L.firstMs, "the first read soon after the service starts");
    const info = await s360.scanS360("now");
    assert.deepEqual(info, { at: iso(), ok: true, calls: 6, items: 4, found: 4, resolved: 0, throttled: false });
    const made = take();
    assert.deepEqual(
        made.filter((c) => c.server === "m365-user").map((c) => [c.tool, c.args]),
        [["GetMyDetails", { select: "id,displayName,givenName,mail,userPrincipalName" }]],
    );
    assert.deepEqual(
        searches(made).map((c) => c.args),
        [
            { request: { assignedTo: ["kj"], pageSize: L.pageSize }, environment: "Production" },
            { request: { actionOwners: ["kj"], pageSize: L.pageSize }, environment: "Production" },
        ],
    );
    assert.deepEqual(
        links(made)
            .map((c) => c.args)
            .sort((a, b) => a.kpiId.localeCompare(b.kpiId)),
        [{ kpiId: "kpi-1" }, { kpiId: "kpi-2" }, { kpiId: "kpi-3", serviceId: SERVICE.toLowerCase() }],
        "one link per KPI and service; a person's item links the KPI alone",
    );
    assert.deepEqual(opened, ["m365-user", "s360-breeze"]);
    assert.equal(clients, closed, "every client it opened, it closed");

    const items = await s360.listS360Items();
    assert.deepEqual(
        items.map((i) => i.key),
        [four, two, one, three].map(keyOf),
        "late first, then soon, then by due date",
    );
    const byKey = new Map(items.map((i) => [i.key, i]));
    const first = byKey.get(keyOf(one));
    assert.deepEqual(first.roles, ["assigned", "owner"]);
    assert.equal(first.link, linkFor("kpi-1"));
    assert.deepEqual([first.need, first.dismissed, first.resolvedAt, first.firstSeen, first.lastSeen], [false, false, null, iso(), iso()]);
    assert.equal(byKey.get(keyOf(three)).link, linkFor("kpi-3", SERVICE.toLowerCase()));
    assert.equal(byKey.get(keyOf(four)).link, linkFor("kpi-3", SERVICE.toLowerCase()), "the same KPI on the same service shares its link");
    const needs = await s360.s360Needs();
    assert.deepEqual(needs.map((n) => n.key).sort(), [two, four].map(needOf).sort());
    assert.ok(needs.every((n) => n.at === iso() && n.item.need));
    assert.deepEqual(await s360.s360Digest(), { version: "1", enabled: true, open: 4, soon: 1, late: 1 });
    assert.deepEqual(await s360.s360Status(), { enabled: true, scanning: false, agency: true, alias: "kj", last: info, readAt: info.at, nextAt: iso(clock + L.maxWaitMs) });
});

await test("each new day it reads again: a new item needs the user; who they are and the links are kept", async () => {
    clock += DAY;
    const five = raw(5);
    fake.assigned.push(five);
    const info = await s360.scanS360("due");
    assert.equal(info.ok, true);
    assert.deepEqual([info.items, info.found, info.calls], [5, 1, 3], "two searches and the new KPI's link; the alias is kept a week");
    const made = take();
    assert.deepEqual(
        links(made).map((c) => c.args),
        [{ kpiId: "kpi-5" }],
    );
    assert.equal(made.filter((c) => c.server === "m365-user").length, 0);
    const need = (await s360.s360Needs()).find((n) => n.key === needOf(five));
    assert.ok(need, "after the baseline, a new item needs the user, in SLA or not");
    assert.equal(need.at, iso());
    const first = (await s360.listS360Items()).find((i) => i.key === keyOf(fake.assigned[0]));
    assert.deepEqual([first.firstSeen, first.lastSeen], [iso(clock - DAY), iso()]);
    assert.equal(await s360.scanS360("due"), null, "read today: the timer waits for tomorrow");
    assert.equal(take().length, 0);
    assert.equal(Date.parse((await s360.s360Status()).nextAt), clock + L.maxWaitMs);
    const again = await s360.scanS360("now");
    assert.deepEqual([again.ok, again.calls, again.found], [true, 2, 0], "Scan now reads anyway");
    take();
});

await test("a dismissed item is back only when it gets worse; a need stays until then", async () => {
    const [one, two, five] = fake.assigned;
    const item = async (r) => (await s360.listS360Items()).find((i) => i.key === keyOf(r));
    const version = Number((await s360.s360Digest()).version);
    const left = await s360.dismissS360Need(needOf(two));
    assert.ok(!left.some((n) => n.key === needOf(two)));
    assert.equal(Number((await s360.s360Digest()).version), version + 1, "the page reads the list again");
    assert.deepEqual([(await item(two)).need, (await item(two)).dismissed], [false, true]);
    await assert.rejects(s360.dismissS360Need(needOf(two)), (e) => e.status === 404 && e.message === "That item is gone.", "dismissed already");
    await assert.rejects(s360.dismissS360Need(needOf(one)), (e) => e.status === 404, "not a need: in SLA since the baseline");
    for (const bad of ["need:s360:XYZ", "need:chat:0123456789abcdef", `${needOf(one)}0`, 42, null]) {
        await assert.rejects(s360.dismissS360Need(bad), (e) => e.status === 400 && e.message === "Unknown item.", String(bad));
    }

    clock += 60_000;
    await s360.scanS360("now");
    assert.equal((await item(two)).dismissed, true, "read again the same: it stays dismissed");

    clock += 60_000;
    two.SLAState = "OutOfSla";
    one.SLAState = "ApproachingSla";
    await s360.scanS360("now");
    const needs = await s360.s360Needs();
    assert.deepEqual(
        needs.filter((n) => n.key === needOf(one) || n.key === needOf(two)).map((n) => n.at),
        [iso(), iso()],
    );
    assert.equal((await item(two)).dismissed, false, "out of SLA now: it's back");
    assert.equal((await item(one)).need, true, "in SLA at the baseline, approaching now: it needs the user");

    clock += 60_000;
    one.SLAState = "InSla";
    await s360.scanS360("now");
    assert.equal((await item(one)).need, true, "back in SLA, it still waits until it's dismissed, made a to-do, or closed");

    await s360.dismissS360Need(needOf(five));
    clock += 60_000;
    five.SLAState = "ApproachingSla";
    await s360.scanS360("now");
    assert.equal((await item(five)).need, true, "dismissed in SLA, back once it's approaching");
    take();
});

await test("only a complete read closes items; one listed again is new", async () => {
    const three = fake.owner[1];
    const readAt = (await s360.s360Status()).readAt;
    const version = Number((await s360.s360Digest()).version);
    fake.owner = fake.owner.filter((r) => r !== three);
    fake.fail.owner = new mcp.McpError("S360: the owner search broke");
    clock += 60_000;
    const partial = await s360.scanS360("now");
    assert.deepEqual(partial, {
        at: iso(),
        ok: false,
        calls: 2,
        items: 3,
        found: 0,
        resolved: 0,
        throttled: false,
        error: "Only part of S360 could be read: S360: the owner search broke",
    });
    assert.equal((await s360.listS360Items()).find((i) => i.key === keyOf(three)).resolvedAt, null, "a part read closes nothing");
    const status = await s360.s360Status();
    assert.equal(status.readAt, readAt, "and isn't a read of the day");
    assert.equal(status.last.ok, false);
    assert.equal(Date.parse(status.nextAt), clock + L.backoffMs, "it tries again in half an hour");
    assert.equal(Number((await s360.s360Digest()).version), version + 1, "a failed read still tells the page");
    clock += 60_000;
    await s360.scanS360("now");
    assert.equal(Date.parse((await s360.s360Status()).nextAt), clock + 2 * L.backoffMs, "then in an hour");

    delete fake.fail.owner;
    clock += 60_000;
    const whole = await s360.scanS360("now");
    assert.deepEqual([whole.ok, whole.resolved, whole.items], [true, 1, 4]);
    assert.equal(Date.parse((await s360.s360Status()).nextAt), clock + L.maxWaitMs, "a good read: back to the daily timer");
    const gone = (await s360.listS360Items()).at(-1);
    assert.deepEqual([gone.key, gone.resolvedAt, gone.need], [keyOf(three), iso(), false], "closed ones come last");
    assert.ok(!(await s360.s360OpenKeys()).includes(needOf(three)));

    clock += 60_000;
    fake.owner.push(three);
    const back = await s360.scanS360("now");
    assert.deepEqual([back.found, back.resolved], [1, 0]);
    const reopened = (await s360.listS360Items()).find((i) => i.key === keyOf(three));
    assert.deepEqual([reopened.resolvedAt, reopened.need, reopened.firstSeen], [null, true, iso(NOON)], "open again, and new to the user");
    take();
});

await test("throttled: the read stops where it is, and asks for no links", async () => {
    fake.fail.assigned = new mcp.McpError("S360: 429 Too Many Requests", true);
    clock += 60_000;
    const none = await s360.scanS360("now");
    assert.deepEqual(none, { at: iso(), ok: false, calls: 1, items: 0, found: 0, resolved: 0, throttled: true, error: "S360: 429 Too Many Requests" });
    assert.equal(searches(take()).length, 1, "the owner search isn't tried after a 429");

    delete fake.fail.assigned;
    fake.fail.owner = new mcp.McpError("S360: 429 Too Many Requests", true);
    const six = raw(6);
    fake.assigned.push(six);
    clock += 60_000;
    const part = await s360.scanS360("now");
    assert.deepEqual([part.ok, part.throttled, part.found], [false, true, 1]);
    assert.equal(links(take()).length, 0, "no links asked for while S360 is throttling");

    delete fake.fail.owner;
    clock += 60_000;
    await s360.scanS360("now");
    assert.deepEqual(
        links(take()).map((c) => c.args),
        [{ kpiId: "kpi-6" }],
    );
});

await test("S360 out of reach: the read fails and says why", async () => {
    fake.openFail = new mcp.McpError("s360-breeze MCP server exited (1): boom");
    clock += 60_000;
    const version = Number((await s360.s360Digest()).version);
    const info = await s360.scanS360("now");
    assert.deepEqual([info.ok, info.calls, info.error], [false, 0, "s360-breeze MCP server exited (1): boom"]);
    assert.equal(Number((await s360.s360Digest()).version), version + 1);
    fake.openFail = null;
    fake.fail = { assigned: new mcp.McpError("S360: No access"), owner: new mcp.McpError("S360: Owner gone") };
    const both = await s360.scanS360("now");
    assert.deepEqual([both.ok, both.throttled, both.error, both.calls], [false, false, "S360: No access", 2], "the first failure says why");
    fake.fail = {};
    assert.equal((await s360.scanS360("now")).ok, true);
    assert.equal(clients, closed, "every client it opened, it closed, on failed reads too");
    take();
});

await test("a search reads every page; the page cap or a stuck cursor leaves the read incomplete", async () => {
    await fresh();
    s360.startS360Runner();
    fake.pageSize = 2;
    const items = [1, 2, 3, 4, 5].map((n) => raw(n));
    fake.assigned = [...items];
    const info = await s360.scanS360("now");
    assert.deepEqual([info.ok, info.items, info.calls, info.error], [true, 5, 1 + 3 + 1 + 5, undefined]);
    assert.deepEqual(
        searches(take()).map((c) => c.args.request.cursor ?? null),
        [null, "2", "4", null],
    );

    fake.endless = "owner";
    fake.assigned = items.slice(0, 4);
    clock += DAY;
    const capped = await s360.scanS360("due");
    assert.deepEqual([capped.ok, capped.resolved, capped.error], [true, 0, "S360 listed more items than one read takes; the rest wait for the next read."]);
    assert.equal(searches(take()).filter((c) => c.args.request.actionOwners).length, L.maxPages);
    const status = await s360.s360Status();
    assert.equal(status.readAt, capped.at, "it's the day's read: reading again wouldn't get further");
    assert.equal(Date.parse(status.nextAt), clock + L.maxWaitMs);

    fake.endless = "owner:same";
    clock += 60_000;
    const stuck = await s360.scanS360("now");
    assert.deepEqual([stuck.ok, stuck.resolved], [true, 0]);
    assert.equal(searches(take()).filter((c) => c.args.request.actionOwners).length, 2, "the same cursor twice: stop");

    fake.endless = "";
    clock += 60_000;
    assert.equal((await s360.scanS360("now")).resolved, 1, "a complete read closes it");
    take();
});

await test("the baseline lasts until a read gets everything", async () => {
    await fresh();
    fake.endless = "owner";
    fake.assigned = [raw(1)];
    await s360.scanS360("now");
    fake.assigned.push(raw(2));
    clock += DAY;
    await s360.scanS360("now");
    fake.endless = "";
    fake.assigned.push(raw(3));
    clock += DAY;
    await s360.scanS360("now");
    assert.deepEqual(await s360.s360Needs(), [], "found before anything was read whole: still the baseline");
    fake.assigned.push(raw(4));
    clock += DAY;
    await s360.scanS360("now");
    assert.deepEqual(
        (await s360.s360Needs()).map((n) => n.key),
        [needOf(fake.assigned[3])],
    );
    take();
});

await test("links: at most 20 a read; one that fails is asked for again; only S360 portal links are kept", async () => {
    await fresh();
    fake.assigned = Array.from({ length: 25 }, (_, i) => raw(i + 1));
    const first = await s360.scanS360("now");
    assert.deepEqual([first.ok, links(take()).length], [true, L.linkCalls]);
    const rest = (await s360.listS360Items())
        .filter((i) => !i.link)
        .map((i) => i.kpiId)
        .sort();
    assert.equal(rest.length, 25 - L.linkCalls);
    const [broke, refused, elsewhere, empty] = rest;
    fake.link = (args) => {
        if (args.kpiId === broke) throw new Error("the link tool broke");
        if (args.kpiId === refused) return { success: false, error: "no" };
        if (args.kpiId === elsewhere) return { success: true, result: { url: "https://evil.example/kpi" } };
        if (args.kpiId === empty) return { success: true, result: {} };
        return { success: true, result: { url: linkFor(args.kpiId) } };
    };
    const second = await s360.scanS360("now");
    assert.equal(second.ok, true, "a link that fails never fails the read");
    assert.equal(links(take()).length, 5);
    assert.deepEqual(
        (await s360.listS360Items())
            .filter((i) => !i.link)
            .map((i) => i.kpiId)
            .sort(),
        [broke, refused, elsewhere, empty].sort(),
    );

    fake.link = () => {
        throw new mcp.McpError("429 Too Many Requests", true);
    };
    assert.equal((await s360.scanS360("now")).ok, true);
    assert.equal(links(take()).length, 1, "throttled: no more links this read");

    fake.link = (args) => ({ success: true, result: { url: linkFor(args.kpiId) } });
    await s360.scanS360("now");
    assert.equal(links(take()).length, 4, "the ones that failed, asked for again");
    assert.ok((await s360.listS360Items()).every((i) => i.link === linkFor(i.kpiId)));
});

await test("closed items are dropped after two weeks; links are asked for again after a month", async () => {
    await fresh();
    const [one, two] = [raw(1), raw(2)];
    fake.assigned = [one, two];
    await s360.scanS360("now");
    fake.assigned = [one];
    clock += 60_000;
    assert.equal((await s360.scanS360("now")).resolved, 1);
    take();
    clock += 15 * DAY;
    await s360.scanS360("now");
    assert.deepEqual(
        (await s360.listS360Items()).map((i) => i.key),
        [keyOf(one)],
        "closed over two weeks ago: gone",
    );
    assert.equal(links(take()).length, 0, "links are kept a month");
    clock += 16 * DAY;
    await s360.scanS360("now");
    assert.deepEqual(
        links(take()).map((c) => c.args),
        [{ kpiId: "kpi-1" }],
        "a month on, asked for again",
    );
});

await test("who the user is: read from their profile, kept a week; without an alias nothing is read", async () => {
    await fresh();
    fake.assigned = [raw(1)];
    fake.me = { user: { displayName: "Kipack Jeong" } };
    const none = await s360.scanS360("now");
    assert.deepEqual([none.ok, none.calls, none.error], [false, 1, "Couldn't tell your alias from your Microsoft 365 profile."]);
    assert.ok(!opened.includes("s360-breeze"), "S360 isn't asked without the alias");
    assert.equal((await s360.s360Status()).alias, null);

    fake.me = { user: { userPrincipalName: "kj@contoso.com" } };
    assert.equal((await s360.scanS360("now")).ok, true);
    assert.equal((await s360.s360Status()).alias, "kj");
    take();
    clock += 6 * DAY;
    await s360.scanS360("now");
    assert.equal(take().filter((c) => c.server === "m365-user").length, 0, "kept for a week");

    clock += 2 * DAY;
    fake.meFail = new mcp.McpError("m365-user MCP server exited (1)");
    const failed = await s360.scanS360("now");
    assert.deepEqual([failed.ok, failed.error], [false, "m365-user MCP server exited (1)"], "a week on, asked again");
    fake.meFail = null;
    assert.equal((await s360.scanS360("now")).ok, true);
    assert.equal(take().filter((c) => c.server === "m365-user").length, 2);
});

// ---- on, off, and the timer -----------------------------------------------------------

await test("off: no reads, nothing in Needs you, the timer stops; on again reads at once", async () => {
    await fresh();
    const late = raw(1, { SLAState: "OutOfSla" });
    fake.assigned = [late];
    s360.startS360Runner();
    await s360.scanS360("now");
    take();
    const version = Number((await s360.s360Digest()).version);
    const off = await s360.setS360Enabled(false);
    assert.equal(off.enabled, false);
    await until(async () => {
        const status = await s360.s360Status();
        return !status.scanning && status.nextAt === null;
    }, "the timer stops");
    assert.deepEqual(
        await s360.s360Today(),
        { digest: { version: String(version + 1), enabled: false, open: 1, soon: 0, late: 1 }, needs: [], open: [] },
        "the page hears of it; Needs you and the to-dos don't",
    );
    assert.equal((await s360.listS360Items()).length, 1, "what was read is kept");
    assert.equal(await s360.scanS360("now"), null);
    assert.equal(take().length, 0, "and S360 isn't read");
    await assert.rejects(s360.setS360Enabled("yes"), (e) => e.status === 400 && /whether/.test(e.message));

    await s360.setS360Enabled(true);
    await until(async () => searches(calls).length === 2 && !(await s360.s360Status()).scanning, "on reads at once");
    assert.deepEqual(
        (await s360.s360Needs()).map((n) => n.key),
        [needOf(late)],
    );
    assert.equal(Date.parse((await s360.s360Status()).nextAt), clock + L.maxWaitMs);

    process.env.ADO_PR_OPS_S360 = "off";
    try {
        assert.equal(await s360.s360Enabled(), false, "the environment can turn it off");
        assert.deepEqual(await s360.s360Needs(), []);
        assert.equal(await s360.scanS360("now"), null);
    } finally {
        delete process.env.ADO_PR_OPS_S360;
    }
    take();
});

await test("without Agency: nothing is read, and it looks again in five minutes", async () => {
    await fresh();
    s360.startS360Runner();
    fake.agency = false;
    assert.equal(await s360.scanS360("now"), null);
    assert.deepEqual(opened, []);
    const status = await s360.s360Status();
    assert.deepEqual([status.agency, Date.parse(status.nextAt), status.last], [false, clock + L.agencyMs, null]);
});

await test("a read under way is shared; turned off during one, the timer stops after it", async () => {
    await fresh();
    s360.startS360Runner();
    fake.assigned = [raw(1)];
    let release;
    fake.gate = new Promise((resolve) => (release = resolve));
    const a = s360.scanS360("now");
    const b = s360.scanS360("due");
    assert.equal(a, b, "one read, both get it");
    assert.equal((await s360.s360Status()).scanning, true);
    await s360.setS360Enabled(false);
    release();
    fake.gate = null;
    assert.equal((await a).ok, true, "the read under way finishes");
    await until(async () => {
        const status = await s360.s360Status();
        return !status.scanning && status.nextAt === null;
    }, "then the timer stops");
    assert.equal(searches(take()).length, 2, "S360 was read once");
    await s360.setS360Enabled(true);
    await until(async () => searches(calls).length === 2 && !(await s360.s360Status()).scanning, "on again: a read");
    take();
});

// ---- Needs you's to-dos, and the routes -----------------------------------------------

await test("a to-do made from an S360 item ticks itself only once S360 closes the item", async () => {
    await fresh();
    const late = raw(1, { SLAState: "OutOfSla" });
    const quiet = raw(2);
    fake.assigned = [late, quiet];
    await s360.scanS360("now");
    const today = await s360.s360Today();
    assert.deepEqual(
        today.needs.map((n) => n.key),
        [needOf(late)],
    );
    assert.deepEqual(today.open.sort(), [needOf(late), needOf(quiet)].sort(), "every open item keeps its to-do, a need or not");
    const link = today.needs[0].item.link;
    assert.equal(link, linkFor("kpi-1"));
    const todo = await notes.addTodo("Fix the late S360 item", "you", { key: needOf(late), taskTitle: "Item 1", who: "S360", link });
    assert.deepEqual(todo.source, { key: needOf(late), taskId: "", taskTitle: "Item 1", who: "S360", link });
    const other = await notes.addTodo("Look at item 2", "you", { key: needOf(quiet), taskTitle: "Item 2", who: "S360", link: "https://evil.example/x" });
    assert.equal(other.source.link, undefined, "only a link into S360 is kept");

    // As Today does it: the open items' keys, and S360 left alone while the watcher is off.
    const settle = async () => {
        const t = await s360.s360Today();
        return notes.settleNeedTodos(
            needKeys([], [], [], t.open.map((key) => ({ key }))),
            t.digest.enabled ? [] : ["s360"],
        );
    };
    await s360.dismissS360Need(needOf(late));
    assert.equal(await settle(), 0, "dismissed but open: the to-do stays");
    await s360.setS360Enabled(false);
    assert.equal(await settle(), 0, "off: its to-dos are left alone");
    await s360.setS360Enabled(true);
    fake.assigned = [quiet];
    clock += 60_000;
    assert.equal((await s360.scanS360("now")).resolved, 1);
    assert.equal(await settle(), 1, "closed in S360: the to-do ticks itself");
    const todos = await notes.listTodos();
    assert.equal(todos.find((t) => t.id === todo.id).done, true);
    assert.equal(todos.find((t) => t.id === other.id).done, false);
});

await test("the routes: the list, Scan now, on and off, dismiss", async () => {
    await fresh();
    fake.assigned = [raw(1, { SLAState: "ApproachingSla" })];
    const server = createServer((req, res) => void handleJarvisApi(req, res, new URL(req.url, "http://localhost")));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const call = async (method, path, body) => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
            method,
            headers: { "Content-Type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: res.status, body: await res.json() };
    };
    try {
        const empty = await call("GET", "/api/jarvis/s360");
        assert.equal(empty.status, 200);
        assert.deepEqual([empty.body.items, empty.body.digest.version, empty.body.status.last, empty.body.status.enabled], [[], "0", null, true]);

        const scan = await call("POST", "/api/jarvis/s360/scan", {});
        assert.equal(scan.status, 200);
        assert.deepEqual([scan.body.last.ok, scan.body.items.length, scan.body.digest.soon, scan.body.status.alias, scan.body.items[0].need], [true, 1, 1, "kj", true]);

        const key = needOf(fake.assigned[0]);
        assert.deepEqual(await call("POST", "/api/jarvis/s360/needs/dismiss", { key: "need:s360:nope" }), { status: 400, body: { error: "Unknown item." } });
        assert.deepEqual(await call("POST", "/api/jarvis/s360/needs/dismiss", { key: "need:s360:0123456789abcdef" }), { status: 404, body: { error: "That item is gone." } });
        const dismissed = await call("POST", "/api/jarvis/s360/needs/dismiss", { key });
        assert.deepEqual([dismissed.status, dismissed.body.needs, dismissed.body.digest.open], [200, [], 1]);

        assert.deepEqual(await call("POST", "/api/jarvis/s360/enabled", { enabled: "off" }), { status: 400, body: { error: "Say whether to read S360." } });
        const off = await call("POST", "/api/jarvis/s360/enabled", { enabled: false });
        assert.deepEqual([off.status, off.body.status.enabled, off.body.digest.enabled], [200, false, false]);
        const offScan = await call("POST", "/api/jarvis/s360/scan", {});
        assert.deepEqual([offScan.status, offScan.body.last, offScan.body.items.length], [200, null, 1]);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

await s360.stopS360Runner();
s360.resetS360();
s360.setS360Runtime(null);
closeDb();
rmSync(root, { recursive: true, force: true });
if (failures) {
    console.log(`\n${failures} failed`);
    process.exit(1);
}
console.log("\ns360 harness: all passed");
