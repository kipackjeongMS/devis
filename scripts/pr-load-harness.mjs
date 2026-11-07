import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

// loadPRs feeds state for the Workspace's PR panel, which repaints itself on "ado-prs-loaded".
const source = (await readFile(new URL("../web/src/app.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const loadSource = source.match(/async function loadPRs\([\s\S]*?\n}\n/)[0];
const compiled = ts.transpileModule(`${loadSource}\nloadPRs;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(response, opts = {}) {
    const warnings = [];
    const dispatched = [];
    const busy = [];
    const recency = [];
    const previousPrs = opts.firstLoad ? [] : [{ id: 1 }];
    const scope = {
        prsLoad: 0,
        state: { prs: previousPrs, authoredPrs: [], cappedProjects: [], olderPrs: opts.olderPrs || [] },
        prIdentity: (pr) => String(pr.id),
        loadPrRecency: () => recency.push(true),
        CustomEvent: class {
            constructor(type) {
                this.type = type;
            }
        },
        window: { dispatchEvent: (event) => dispatched.push(event.type) },
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
        loadCommentActivity: async () => {},
        toast: (message) => warnings.push(message),
    };
    const load = vm.runInNewContext(compiled, scope);
    return { load, scope, warnings, previousPrs, dispatched, busy, recency };
}

// A refresh that fails keeps the list and says so; the panel still stops waiting.
const failed = fixture({ prs: [], errors: ["org/project: az token failed"] });
await failed.load();
assert.equal(failed.scope.state.prs, failed.previousPrs, "a failed refresh preserves previous PR data");
assert.match(failed.warnings[0], /az token failed/);
assert.deepEqual(failed.dispatched, ["ado-prs-loaded"], "the panel stops waiting for PRs even when loading fails");
assert.deepEqual(failed.busy, [["aria-busy", "true"], ["aria-busy", null]], "the refresh button spins while it loads");

// Partial results still land, and the failing scope is reported.
const partial = fixture({ prs: [{ id: 2 }], errors: ["other-org: denied"] });
await partial.load();
assert.deepEqual(partial.scope.state.prs.map((p) => p.id), [2]);
assert.deepEqual(partial.warnings, ["other-org: denied"]);
assert.deepEqual(partial.dispatched, ["ado-prs-loaded"], "the panel repaints once PRs land");

const empty = fixture({ prs: [], errors: [] });
await empty.load();
assert.deepEqual(empty.scope.state.prs, [], "a genuinely empty result is the normal empty state");
assert.deepEqual(empty.warnings, []);
assert.deepEqual(empty.dispatched, ["ado-prs-loaded"]);

// The panel's data: your own PRs, capped projects, older pages and recency.
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
assert.match(disconnected.warnings[0], /Connection lost/);
assert.deepEqual(disconnected.dispatched, ["ado-prs-loaded"]);

// First launch: the last list shows at once, then the live one replaces it.
const snapshotAt = new Date(Date.now() - 3_600_000).toISOString();
const launch = fixture({ prs: [{ id: 9 }], errors: [] }, { firstLoad: true, liveDelay: 30, snapshot: { prs: [{ id: 8 }], at: snapshotAt, cached: true } });
const seen = [];
const realDispatch = launch.scope.window.dispatchEvent;
launch.scope.window.dispatchEvent = (event) => {
    seen.push(launch.scope.state.prs.map((p) => p.id));
    realDispatch(event);
};
await launch.load();
assert.deepEqual(seen, [[8], [9]], "the snapshot paints first, the live list replaces it");

// A snapshot that arrives after the live list is ignored.
const late = fixture({ prs: [{ id: 9 }], errors: [] }, { firstLoad: true });
late.scope.getJSON = async (url) => {
    if (url.includes("cached=1")) {
        await new Promise((r) => setTimeout(r, 40));
        return { prs: [{ id: 8 }], at: snapshotAt, cached: true };
    }
    return { prs: [{ id: 9 }], errors: [] };
};
await late.load();
await new Promise((r) => setTimeout(r, 80));
assert.deepEqual(late.scope.state.prs.map((p) => p.id), [9], "a late snapshot never paints over the live list");
assert.equal(late.dispatched.length, 1);
console.log("pr-load-harness: ok");
