import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

const source = (await readFile(new URL("../web/src/app.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const loadSource = source.match(/async function loadPRs\([\s\S]*?\n}\n/)[0];
const watchSource = source.match(/window\.addEventListener\("ado-pr-updated",[\s\S]*?\n}\);/)[0];
const compiled = ts.transpileModule(`${loadSource}\n${watchSource}\nloadPRs;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(response, opts = {}) {
    const errors = [];
    const warnings = [];
    const notes = [];
    const renders = [];
    const previousPrs = opts.firstLoad ? [] : [{ id: 1 }];
    const dispatched = [];
    let updated;
    const busy = [];
    const recency = [];
    const scope = {
        prsLoad: 0,
        listAsOf: opts.firstLoad ? null : Date.now() - 60_000,
        state: { prs: previousPrs, authoredPrs: [], cappedProjects: [], olderPrs: opts.olderPrs || [] },
        prIdentity: (pr) => String(pr.id),
        loadPrRecency: () => recency.push(true),
        view: { innerHTML: "" },
        filterbar: { hidden: !!opts.firstLoad },
        document: { body: { dataset: { page: "queue" } } },
        CustomEvent: class {
            constructor(type) {
                this.type = type;
            }
        },
        window: {
            addEventListener: (_name, handler) => { updated = handler; },
            dispatchEvent: (event) => dispatched.push(event.type),
        },
        $: () => ({
            setAttribute: (name, value) => busy.push([name, value]),
            removeAttribute: (name) => busy.push([name, null]),
        }),
        getJSON: async (url) => {
            if (url.includes("cached=1")) return opts.snapshot || { prs: null };
            if (opts.liveDelay) await new Promise((r) => setTimeout(r, opts.liveDelay));
            if (response instanceof Error) throw response;
            return response;
        },
        loadReviews: async () => {},
        setPage: () => {},
        setupFilters: () => { scope.filterbar.hidden = false; },
        renderList: () => renders.push(scope.state.prs),
        loadCommentActivity: async () => {},
        toast: (message) => warnings.push(message),
        noteStaleList: (message) => notes.push(message),
        renderError: (message) => {
            errors.push(message);
            scope.filterbar.hidden = true;
            scope.view.innerHTML = message;
        },
    };
    const load = vm.runInNewContext(compiled, scope);
    return { load, scope, errors, warnings, notes, renders, previousPrs, dispatched, busy, recency, updated: () => updated() };
}

// A refresh that fails keeps the list on screen and says so until one succeeds.
const failed = fixture({ prs: [], errors: ["org/project: az token failed"] });
await failed.load();
assert.equal(failed.errors.length, 0, "a failed refresh doesn't throw the list away");
assert.equal(failed.notes.filter(Boolean).length, 1, "…it says the list couldn't be refreshed");
assert.match(failed.notes.filter(Boolean)[0], /az token failed/);
assert.equal(failed.renders.length, 0);
assert.equal(failed.scope.state.prs, failed.previousPrs, "a failed refresh preserves previous PR data");
assert.deepEqual(failed.dispatched, ["ado-prs-loaded"], "Jarvis stops waiting for PRs even when loading fails");
assert.deepEqual(failed.busy, [["aria-busy", "true"], ["aria-busy", null]], "the refresh button spins while it loads");
failed.updated();
assert.equal(failed.renders.length, 1, "the kept list still follows review updates");

// With nothing on screen yet, a failure is the error screen: never an empty queue.
const firstFailed = fixture({ prs: [], errors: ["org/project: az token failed"] }, { firstLoad: true });
await firstFailed.load();
assert.equal(firstFailed.errors.length, 1, "failed retrieval must not look like an empty queue");
assert.match(firstFailed.errors[0], /az token failed/);
firstFailed.updated();
assert.equal(firstFailed.renders.length, 0, "review polling must not erase the persistent load error");

const partial = fixture({ prs: [{ id: 2 }], errors: ["other-org: denied"] });
await partial.load();
assert.equal(partial.errors.length, 0);
assert.equal(partial.renders.length, 1, "available scopes still render when another scope fails");
assert.deepEqual(partial.warnings, ["other-org: denied"]);
assert.deepEqual(partial.notes, [null], "a successful load clears the stale-list notice");
assert.deepEqual(partial.dispatched, ["ado-prs-loaded"], "Jarvis repaints its review section once PRs land");
partial.updated();
assert.equal(partial.renders.length, 2, "successful queues still respond to review updates");

const empty = fixture({ prs: [], errors: [] });
await empty.load();
assert.equal(empty.errors.length, 0);
assert.equal(empty.renders.length, 1, "a genuinely empty result still renders the normal empty state");

// The Workspace's Pull Requests panel: your own PRs, capped projects, older pages and recency.
const panel = fixture(
    { prs: [{ id: 3 }, { id: 4 }], authored: [{ id: 7 }], capped: [{ org: "o", project: "p" }], errors: [], recencyPending: 2 },
    { olderPrs: [{ id: 4 }, { id: 5 }] },
);
await panel.load();
assert.deepEqual(panel.scope.state.authoredPrs.map((p) => p.id), [7], "your own PRs are kept for My PRs");
assert.deepEqual(panel.scope.state.cappedProjects, [{ org: "o", project: "p" }]);
assert.deepEqual(panel.scope.state.olderPrs.map((p) => p.id), [5], "older pages stay, minus PRs that moved onto the first page");
assert.equal(panel.recency.length, 1, "pending recency is read in the background");
assert.equal(empty.recency.length, 0, "…and only when some is pending");

const disconnected = fixture(new Error("Connection lost"), { firstLoad: true });
await disconnected.load();
assert.match(disconnected.errors[0], /Connection lost/);
disconnected.updated();
assert.equal(disconnected.renders.length, 0);

// First launch: the last list shows at once, then the live one replaces it.
const snapshotAt = new Date(Date.now() - 3_600_000).toISOString();
const launch = fixture({ prs: [{ id: 9 }], errors: [] }, { firstLoad: true, liveDelay: 30, snapshot: { prs: [{ id: 8 }], at: snapshotAt, cached: true } });
await launch.load();
assert.deepEqual(launch.renders.map((prs) => prs.map((p) => p.id)), [[8], [9]], "the snapshot paints first, the live list replaces it");
assert.deepEqual(launch.dispatched, ["ado-prs-loaded", "ado-prs-loaded"]);

// …and if ADO can't be reached, the snapshot stays with a notice instead of an error screen.
const offline = fixture(new Error("getaddrinfo ENOTFOUND dev.azure.com"), { firstLoad: true, liveDelay: 30, snapshot: { prs: [{ id: 8 }], at: snapshotAt, cached: true } });
await offline.load();
assert.equal(offline.errors.length, 0);
assert.equal(offline.scope.listAsOf, Date.parse(snapshotAt), "the notice dates the list to the snapshot");
assert.match(offline.notes.filter(Boolean)[0], /ENOTFOUND/);

// A snapshot that arrives after the live list is ignored.
const late = fixture({ prs: [{ id: 9 }], errors: [] }, { firstLoad: true, snapshot: { prs: [{ id: 8 }], at: snapshotAt, cached: true } });
late.scope.getJSON = async (url) => {
    if (url.includes("cached=1")) {
        await new Promise((r) => setTimeout(r, 40));
        return { prs: [{ id: 8 }], at: snapshotAt, cached: true };
    }
    return { prs: [{ id: 9 }], errors: [] };
};
await late.load();
await new Promise((r) => setTimeout(r, 80));
assert.deepEqual(late.renders.map((prs) => prs.map((p) => p.id)), [[9]], "a late snapshot never paints over the live list");
console.log("pr-load-harness: ok");