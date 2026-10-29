import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "jarvis-overview-"));
process.env.ADO_PR_OPS_DB_PATH = join(root, "data", "reviews.db");
process.env.ADO_PR_OPS_JARVIS_DIR = join(root, "jarvis");
delete process.env.ADO_PR_OPS_OVERVIEW_MODEL;

const store = await import("../jarvis-store.mjs");
const status = await import("../jarvis-status.mjs");
const ov = await import("../jarvis-overview.mjs");
const model = await import("../web/jarvisModel.js");
const { closeDb } = await import("../store.mjs");

// ---- a fake clock and model ---------------------------------------------------------
const base = Date.now();
let clock = base;
const at = (sec) => (clock = base + sec * 1000);
const calls = [];
let reply = () => "Nothing needs you.";
let aborted = 0;
const fake = {
    now: () => clock,
    models: async () => ["gpt-5-mini", "claude-haiku-4.5", "claude-opus-5.5"],
    generate: async (prompt, m) => {
        calls.push({ prompt, model: m });
        return reply(prompt);
    },
    abort: async () => {
        aborted++;
    },
};
ov.setOverviewRuntime(fake);
const tick = async () => {
    await ov.overviewTick();
    await ov.overviewIdle();
};
const writeups = async () => (await store.listWriteups({ limit: 500 })).length;

try {
    // ---- status text rules ----
    assert.equal(status.cleanStatusText("  - **API   change\ndone**  "), "API change done");
    assert.equal(status.cleanStatusText("**Setup guide rewritten**, waiting on `review_queue`"), "Setup guide rewritten, waiting on review_queue");
    assert.equal(status.cleanStatusText("### Tests next"), "Tests next");
    assert.equal(status.cleanStatusText("x".repeat(400)).length, status.STATUS_MAX);
    assert.ok(status.cleanStatusText("x".repeat(400)).endsWith("…"));
    assert.equal(status.cleanStatusText(42), "");
    assert.equal(
        status.statusFromSummary("I **updated** the `schema` and [docs](http://x).\nNext: tests."),
        "I updated the schema and docs.",
    );
    assert.equal(status.statusFromSummary("```\ncode\n```\n- Fixed the build"), "Fixed the build");
    assert.equal(status.statusFromSummary("## Summary\n\nFixed the null check in parser.ts. Tests next."), "Fixed the null check in parser.ts.");
    assert.equal(status.statusFromSummary("**Summary**\nUpdated my_func_name and ran tests."), "Updated my_func_name and ran tests.");
    assert.equal(status.statusFromSummary("Here is what I did:\n- Added tests for the parser\n- Fixed lint"), "Added tests for the parser");
    assert.equal(status.statusFromSummary("**Done.** Updated the API."), "Done. Updated the API.", "a short opener takes the next sentence too");
    assert.equal(status.statusFromSummary("**Summary in one sentence:** The README is a small demo repo. More here."), "The README is a small demo repo.", "a bold label in front is dropped");
    assert.equal(status.statusFromSummary("__Result__: Tests pass on all three regions."), "Tests pass on all three regions.");
    assert.equal(status.statusFromSummary("## Summary\n---\n**Changes:**"), "", "nothing usable, nothing posted");
    assert.equal(status.cleanStatusText("Renamed snake_case_name and a * b"), "Renamed snake_case_name and a * b");
    assert.equal(status.cleanStatusText("*Tests* pass, _mostly_"), "Tests pass, mostly");
    assert.equal(status.cleanStatusText("Added exports to `__init__.py`."), "Added exports to __init__.py.", "code spans keep their text");
    assert.equal(status.cleanStatusText("**Guarded `__main__`** and `_tmp_`"), "Guarded __main__ and _tmp_");
    assert.equal(status.statusFromSummary("Wrote `x` then:\n```py\n## not a heading\n```\nUpdated `__init__.py` exports."), "Updated __init__.py exports.");
    for (const huge of [" **y".repeat(32_000), " *y".repeat(32_000), "[".repeat(128_000), "```\n".repeat(20_000) + "Done here."]) {
        const started = Date.now();
        status.cleanStatusText(huge);
        status.statusFromSummary(huge);
        assert.ok(Date.now() - started < 300, `long input stays fast (${Date.now() - started} ms)`);
    }

    // ---- no tasks: nothing to write ----
    await tick();
    assert.equal(calls.length, 0);
    assert.equal((await ov.overviewState()).phase, "none");

    // ---- posting statuses ----
    const { task: a } = await store.createTask({ title: "Parameter editor for blocks" });
    const { task: b } = await store.createTask({ title: "Canary test scope v1.2" });
    await assert.rejects(status.postStatus({ taskId: "nope", text: "x", author: "you" }), /Task not found/);
    await assert.rejects(status.postStatus({ taskId: a.id, text: "   ", author: "you" }), /short status line/);
    const first = await status.postStatus({ taskId: a.id, text: "API change done, tests next", author: "appconfig-api", sessionId: "s1" });
    assert.equal(first.created, true);
    const repeat = await status.postStatus({ taskId: a.id, text: "api change DONE, tests next", author: "appconfig-api" });
    assert.equal(repeat.created, false, "the same line from the same author is not posted twice");
    assert.equal(repeat.status.id, first.status.id);
    const byOther = await status.postStatus({ taskId: a.id, text: "API change done, tests next", author: "you" });
    assert.equal(byOther.created, true, "another author's identical line still counts");
    assert.doesNotMatch(readFileSync(store.notePath(a.id), "utf8"), /Status:/, "status lines stay out of note.md; the timeline is the record");
    const events = await store.listEvents({ kinds: ["task.status"], taskId: a.id });
    assert.equal(events.length, 2);
    assert.equal(events[1].text, "appconfig-api: API change done, tests next");
    assert.deepEqual((await store.latestStatuses([a.id, b.id])).get(a.id)?.author, "you");
    assert.equal((await store.latestStatuses([b.id])).size, 0);

    // ---- the quiet period ----
    // These cases check settling; the hourly gap has its own section below.
    const hourly = ov.OVERVIEW_LIMITS.intervalMs;
    assert.equal(hourly, 60 * 60_000, "hourly by default");
    ov.OVERVIEW_LIMITS.intervalMs = 0;
    at(0);
    await tick();
    assert.equal(calls.length, 0, "a change waits for quiet");
    let state = await ov.overviewState();
    assert.equal(state.phase, "updating");
    assert.equal(state.text, null, "nothing to show before the first write-up");
    at(60);
    await tick();
    assert.equal(calls.length, 0);
    reply = (prompt) => {
        const data = JSON.parse(prompt.slice(prompt.indexOf("DATA (JSON):") + 12, prompt.lastIndexOf("}") + 1));
        const ref = data.tasks.find((x) => x.title === "Parameter editor for blocks").ref;
        return `- [[${ref}]] is moving: the API change is done and tests are next.\n- [[Canary test scope v1.2]] hasn't started.`;
    };
    at(91);
    await tick();
    assert.equal(calls.length, 1, "written after 90 s of quiet");
    assert.equal(calls[0].model, "claude-haiku-4.5", "the first small model the user's Copilot offers");
    assert.match(calls[0].prompt, /DATA \(JSON\):/);
    assert.match(calls[0].prompt, /"title": "Parameter editor for blocks"/);
    assert.match(calls[0].prompt, /"ref": "T1"/);
    assert.match(calls[0].prompt, /like \[\[T1\]\]/);
    assert.match(calls[0].prompt, /Two to four bullet points, one per line/);
    assert.match(calls[0].prompt, /"text": "API change done, tests next"/);
    assert.match(calls[0].prompt, /treat|Name only tasks in the data/);
    state = await ov.overviewState();
    assert.equal(state.phase, "fresh");
    assert.equal(state.stale, false);
    assert.equal(state.text, "- [[Parameter editor for blocks]] is moving: the API change is done and tests are next.\n- [[Canary test scope v1.2]] hasn't started.", "one point per line, refs spelled out");
    assert.equal(state.model, "claude-haiku-4.5");

    // ---- time passing alone is not a change ----
    at(400);
    await tick();
    assert.equal(calls.length, 1);
    assert.equal((await ov.overviewState()).phase, "fresh");

    // ---- a burst becomes one write-up; the old text stays, marked out of date ----
    await status.postStatus({ taskId: b.id, text: "Waiting on regions", author: "you" });
    at(410);
    await tick();
    state = await ov.overviewState();
    assert.equal(state.phase, "fresh", "between write-ups the narrative stays as is; the facts are live");
    assert.equal(state.stale, true, "but it's known to be older than Today");
    assert.match(state.text, /Parameter editor/);
    await status.postStatus({ taskId: b.id, text: "Regions decided: two", author: "you" });
    at(470);
    await tick();
    at(540);
    await tick();
    assert.equal(calls.length, 1, "each change restarts the quiet period");
    at(561);
    await tick();
    assert.equal(calls.length, 2);

    // ---- a steady stream of changes still gets a write-up within the max wait ----
    let t = 600;
    for (let i = 0; i < 8; i++) {
        await status.postStatus({ taskId: b.id, text: `step ${i}`, author: "you" });
        at((t += 60));
        await tick();
    }
    assert.equal(calls.length, 3, "written once the burst passed five minutes");

    // ---- the check: a write-up naming an unknown task is not shown ----
    reply = () => "[[Ghost task]] is done.";
    await status.postStatus({ taskId: a.id, text: "Tests pass", author: "appconfig-api" });
    at((t += 10));
    await tick();
    at((t += 91));
    await tick();
    assert.equal(calls.length, 4);
    state = await ov.overviewState();
    assert.equal(state.phase, "failed");
    assert.match(state.text, /^- \[\[Parameter editor for blocks\]\] is moving/, "today's last good write-up stays on screen");
    assert.equal(state.stale, true, "marked as older than the current Today");
    assert.match(state.error, /check: names a task that isn't on Today: Ghost task/);
    const rejected = await store.latestWriteup();
    assert.equal(rejected.valid, false);
    assert.equal(rejected.text, "[[Ghost task]] is done.", "the rejected text is kept for diagnosis");

    // ---- retries: spaced out, then give up ----
    at((t += 60));
    await tick();
    assert.equal(calls.length, 4, "no retry within five minutes");
    at((t += 300));
    await tick();
    assert.equal(calls.length, 5, "retried after five minutes");
    at((t += 301));
    await tick();
    assert.equal(calls.length, 6);
    at((t += 301));
    await tick();
    assert.equal(calls.length, 6, "three attempts per set of inputs at most");

    // ---- Refresh writes now, even for the same inputs ----
    reply = () => "- [[Parameter editor for blocks]]: tests pass.";
    state = await ov.refreshOverview();
    await ov.overviewIdle();
    assert.equal(calls.length, 7);
    state = await ov.overviewState();
    assert.equal(state.phase, "fresh");
    assert.equal(state.text, "- [[Parameter editor for blocks]]: tests pass.");

    // ---- a failed Refresh doesn't hide a good write-up for the same inputs ----
    reply = () => "[[Ghost task]] again.";
    await ov.refreshOverview();
    await ov.overviewIdle();
    state = await ov.overviewState();
    assert.equal(state.phase, "fresh");
    assert.equal(state.text, "- [[Parameter editor for blocks]]: tests pass.");
    assert.equal(state.stale, false);
    const afterRefresh = calls.length;
    at((t += 400));
    await tick();
    assert.equal(calls.length, afterRefresh, "no retries while a good write-up covers these inputs");

    // ---- a model error: facts only, with the reason ----
    reply = () => {
        throw new Error("model unavailable");
    };
    await status.postStatus({ taskId: a.id, text: "Opening the PR", author: "appconfig-api" });
    at((t += 10));
    await tick();
    at((t += 91));
    await tick();
    state = await ov.overviewState();
    assert.equal(state.phase, "failed");
    assert.equal(state.error, "model unavailable");

    // ---- a write-up that never comes times out and is aborted ----
    const limits = { ...ov.OVERVIEW_LIMITS };
    ov.OVERVIEW_LIMITS.generateTimeoutMs = 50;
    reply = () => new Promise(() => {});
    await ov.refreshOverview();
    await ov.overviewIdle();
    state = await ov.overviewState();
    assert.equal(state.phase, "failed");
    assert.match(state.error, /no write-up after/);
    assert.ok(aborted >= 1, "the session is aborted on timeout");
    ov.OVERVIEW_LIMITS.generateTimeoutMs = limits.generateTimeoutMs;

    // ---- the daily cap pauses automatic write-ups, but Refresh still works ----
    ov.OVERVIEW_LIMITS.dailyCap = await writeups();
    reply = () => "[[Canary test scope v1.2]] is next.";
    const before = calls.length;
    await status.postStatus({ taskId: b.id, text: "Ready to start", author: "you" });
    at((t += 10));
    await tick();
    at((t += 400));
    await tick();
    assert.equal(calls.length, before, "no automatic write-up past the daily cap");
    state = await ov.overviewState();
    assert.equal(state.phase, "failed");
    assert.match(state.error, /used up/);
    await ov.refreshOverview();
    await ov.overviewIdle();
    assert.equal(calls.length, before + 1, "Refresh still works");
    assert.equal((await ov.overviewState()).phase, "fresh");
    ov.OVERVIEW_LIMITS.dailyCap = limits.dailyCap;

    // ---- a Refresh during a write-up runs right after it ----
    let release;
    reply = () => new Promise((r) => (release = () => r("[[Parameter editor for blocks]] is done.")));
    const mid = calls.length;
    const firstRun = ov.refreshOverview();
    await firstRun;
    assert.equal((await ov.overviewState()).phase, "updating");
    reply = () => "[[Parameter editor for blocks]] is done, again.";
    const second = ov.refreshOverview();
    release();
    await second;
    await ov.overviewIdle();
    await new Promise((r) => setTimeout(r, 20));
    await ov.overviewIdle();
    assert.equal(calls.length, mid + 2, "the queued Refresh ran after the first write-up");

    // ---- stopping aborts an in-flight write-up and writes nothing after ----
    reply = () => new Promise(() => {});
    const count = await writeups();
    void ov.refreshOverview();
    await new Promise((r) => setTimeout(r, 10));
    const abortsBefore = aborted;
    await ov.stopOverviewRunner();
    assert.ok(aborted > abortsBefore);
    assert.equal(await writeups(), count, "nothing is saved after stop");
    ov.ensureOverviewRunner();
    assert.equal(calls.length, mid + 3, "a stopped runner is not restarted by a page poll");
    ov.resetOverviewRunner();

    // ---- stop during the model lookup: no session opens, and stop doesn't wait ----
    let lookups = 0;
    let generated = 0;
    const slowLookup = {
        ...fake,
        models: () => {
            lookups++;
            return new Promise((r) => setTimeout(() => r(["claude-haiku-4.5"]), 300));
        },
        generate: async () => {
            generated++;
            return "[[Parameter editor for blocks]] is moving.";
        },
    };
    ov.setOverviewRuntime(slowLookup);
    const savedBeforeLookup = await writeups();
    void ov.refreshOverview();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(lookups, 1, "the model catalog is being read");
    const stopStarted = Date.now();
    await ov.stopOverviewRunner();
    assert.ok(Date.now() - stopStarted < 200, "stop doesn't wait for the lookup");
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(generated, 0, "no write-up starts after stop");
    assert.equal(await writeups(), savedBeforeLookup);
    ov.resetOverviewRunner();

    // ---- a lookup that never answers times out like a write-up ----
    ov.OVERVIEW_LIMITS.generateTimeoutMs = 50;
    ov.setOverviewRuntime({ ...slowLookup, models: () => new Promise(() => {}) });
    await status.postStatus({ taskId: a.id, text: "Checking the lookup timeout", author: "you" });
    await ov.refreshOverview();
    await ov.overviewIdle();
    state = await ov.overviewState();
    assert.equal(state.phase, "failed");
    assert.match(state.error, /no write-up after/);
    assert.equal(generated, 0);
    ov.OVERVIEW_LIMITS.generateTimeoutMs = limits.generateTimeoutMs;
    ov.resetOverviewRunner();
    ov.setOverviewRuntime(fake);

    // ---- yesterday's write-up never shows as today's ----
    const savedClock = clock;
    clock = base + 36 * 3_600_000;
    state = await ov.overviewState();
    assert.equal(state.phase, "updating");
    assert.equal(state.text, null, "a new day starts without a narrative");
    clock = savedClock;

    // ---- hourly: after the day's first write-up, at most one automatic write-up an hour ----
    // On a fresh day at 9:00, so the hours never cross midnight.
    ov.OVERVIEW_LIMITS.intervalMs = hourly;
    ov.resetOverviewRunner();
    const nine = new Date(base);
    nine.setDate(nine.getDate() + 2);
    nine.setHours(9, 0, 0, 0);
    const atMin = (min) => (clock = nine.getTime() + min * 60_000);
    reply = () => "[[Parameter editor for blocks]] is moving.";
    const n0 = calls.length;
    atMin(0);
    await tick();
    assert.equal(calls.length, n0, "the day's first write-up waits for Today to settle");
    assert.equal((await ov.overviewState()).phase, "updating", "and shows as on its way");
    atMin(2);
    await tick();
    assert.equal(calls.length, n0 + 1, "then comes without waiting an hour");
    await status.postStatus({ taskId: a.id, text: "Hourly: a change at 9:03", author: "you" });
    for (const min of [3, 10, 30, 61]) {
        atMin(min);
        await tick();
    }
    assert.equal(calls.length, n0 + 1, "within the hour, changes wait");
    state = await ov.overviewState();
    assert.equal(state.phase, "fresh");
    assert.equal(state.stale, true);
    atMin(62);
    await tick();
    assert.equal(calls.length, n0 + 2, "an hour after the last write-up, the change is written");
    atMin(130);
    await tick();
    assert.equal(calls.length, n0 + 2, "nothing changed, nothing written");
    await ov.refreshOverview();
    await ov.overviewIdle();
    assert.equal(calls.length, n0 + 3, "Refresh writes now");
    await status.postStatus({ taskId: a.id, text: "Hourly: a change after Refresh", author: "you" });
    atMin(140);
    await tick();
    atMin(185);
    await tick();
    assert.equal(calls.length, n0 + 3, "a Refresh restarts the hour");
    atMin(191);
    await tick();
    assert.equal(calls.length, n0 + 4);
    // A change during a busy stretch on the hour still waits for quiet, up to five minutes.
    await status.postStatus({ taskId: a.id, text: "Hourly: busy 1", author: "you" });
    atMin(251.5);
    await tick();
    await status.postStatus({ taskId: a.id, text: "Hourly: busy 2", author: "you" });
    atMin(252);
    await tick();
    assert.equal(calls.length, n0 + 4, "due, but still changing");
    atMin(253.6);
    await tick();
    assert.equal(calls.length, n0 + 5, "written once it settles");
    ov.resetOverviewRunner();
    clock = savedClock;

    // ---- the narrative check ----
    const inputs = {
        tasks: [
            { title: "Parameter editor for blocks", workItemId: 2841120 },
            { title: "Canary test scope v1.2", workItemId: null },
        ],
    };
    const ok = (text) => ov.checkNarrative(text, inputs);
    assert.deepEqual(ok('  "[[parameter editor for blocks]] is moving."  '), { ok: true, text: "- [[Parameter editor for blocks]] is moving." }, "mentions are spelled with the exact title");
    assert.deepEqual(
        ok("[[Canary test scope v1.2]] is next. Two. Three."),
        { ok: true, text: "- [[Canary test scope v1.2]] is next.\n- Two.\n- Three." },
        "prose becomes a point per sentence; periods inside a title don't split",
    );
    assert.deepEqual(
        ok("- **[[T1]]**: tests pass\n* [[T2]] is idle\n\n• 3 PRs wait on you"),
        { ok: true, text: "- [[Parameter editor for blocks]]: tests pass\n- [[Canary test scope v1.2]] is idle\n- 3 PRs wait on you" },
        "any bullet marker; bold is dropped",
    );
    assert.deepEqual(ok("Today so far:\n1. [[T1]] is moving.\n2) Nothing done yet."), {
        ok: true,
        text: "- [[Parameter editor for blocks]] is moving.\n- Nothing done yet.",
    }, "a lead-in line is dropped; numbered items count");
    assert.equal(ok("One. Two. Three. Four.").ok, true, "four points");
    assert.equal(ok("One. Two. Three. Four. Five.").ok, false, "five is too many");
    assert.equal(ok("- a\n- b\n- c\n- d\n- e").ok, false);
    assert.equal(ok("Intro line\n- a\n- b").ok, false, "text outside the list");
    assert.equal(ok("- a\n- b\nLet me know if you need more.").ok, false);
    assert.equal(ok("- - nested").ok, false);
    assert.equal(ok("- **").ok, false, "an empty point");
    assert.equal(ok(`- ${"x".repeat(220)}`).ok, false, "a point is too long");
    assert.equal(ok(Array.from({ length: 4 }, () => `- ${"y".repeat(180)}`).join("\n")).ok, false, "too long in total");
    assert.equal(ok("").ok, false);
    assert.equal(ok("x".repeat(600)).ok, false);
    assert.equal(ok("See https://evil.example now.").ok, false);
    assert.equal(ok("- See [this](x).").ok, false);
    assert.equal(ok("Use `code`.").ok, false);
    assert.equal(ok("<img src=x onerror=alert(1)>").ok, false);
    assert.equal(ok("- ## Heading").ok, false);
    assert.equal(ok("[[Parameter editor for blocks] is open.").ok, false);
    assert.equal(ok("- [[Ghost]] is done").ok, false, "unknown tasks are rejected in a list too");
    assert.equal(ok("Work item #2841120 is moving.").ok, true, "known work item ids are fine");
    assert.equal(ok("- PR #17514805 merged.").ok, false, "unknown ids are not");
    assert.equal(ok("33 PRs need your review.").ok, true);

    // Titles with brackets, and #ids quoted in the data.
    const tagged = {
        tasks: [
            {
                title: "[AppConfig] Fix snapshot export",
                workItemId: 2841124,
                status: "Opened PR #98765, waiting on review",
                waitingOnUser: ["Approval: run the deployment for #4455"],
            },
            { title: "Fix", workItemId: null },
        ],
    };
    const ok2 = (text) => ov.checkNarrative(text, tagged);
    assert.deepEqual(ok2("[[T1]] is waiting on review of PR #98765. [[ t2 ]] is idle."), {
        ok: true,
        text: "- [[[AppConfig] Fix snapshot export]] is waiting on review of PR #98765.\n- [[Fix]] is idle.",
    }, "refs become exact titles, brackets and all");
    assert.equal(ok2("[[T3]] is idle.").ok, false, "a ref past the list is rejected");
    assert.equal(ok2("Awaiting review: [[AppConfig] Fix snapshot export] on PR #98765.").ok, false, "a mangled title is rejected");
    assert.equal(ok2("[[[AppConfig] Fix snapshot export]] is waiting on review of PR #98765. [[Fix]] is idle.").ok, true);
    assert.equal(ok2("[[[appconfig] fix snapshot export]] needs approval for #4455.").ok, true, "case doesn't matter; ids from requests count");
    assert.equal(ok2("[[Fix export]] is idle.").ok, false, "a known title's prefix is not a match");
    assert.equal(ok2("[[[AppConfig] Fix snapshot]] is idle.").ok, false);
    assert.equal(ok2("PR #11111 merged.").ok, false, "ids that aren't in the data are still rejected");
    assert.equal(ok2("[[Ghost]] is idle.").ok, false);

    // ---- hashing ignores time; sections agree with the page ----
    at(0);
    const h1 = ov.hashInputs(await ov.collectInputs(clock));
    at(30);
    const h2 = ov.hashInputs(await ov.collectInputs(clock));
    assert.equal(h1, h2);
    const dayStart = model.dayStart(Date.now());
    const w = (over) => ({ state: "idle", busy: false, requests: [], ...over });
    const fixtures = [
        { status: "open", doneAt: null, workers: [] },
        { status: "open", doneAt: null, workers: [w({ requests: [{ id: "r" }] })] },
        { status: "open", doneAt: null, workers: [w({ state: "error" })] },
        { status: "open", doneAt: null, workers: [w({ busy: true })] },
        { status: "open", doneAt: null, workers: [w({ state: "needsInput" })] },
        { status: "done", doneAt: new Date().toISOString(), workers: [] },
        { status: "done", doneAt: new Date(dayStart - 1000).toISOString(), workers: [] },
        { status: "done", doneAt: new Date(dayStart - 1000).toISOString(), workers: [w({ requests: [{ id: "r" }] })] },
        { status: "done", doneAt: new Date().toISOString(), workers: [w({ busy: true })] },
    ];
    for (const f of fixtures) {
        assert.equal(ov.sectionOf(f, dayStart), model.taskSection(f, dayStart), `server and page agree: ${JSON.stringify(f)}`);
    }

    // ---- daily cap on status lines, and cleanup on delete ----
    for (let i = 0; i < status.STATUS_DAILY_CAP; i++) await store.insertStatus({ taskId: b.id, author: "x", text: `n${i}` });
    await assert.rejects(status.postStatus({ taskId: b.id, text: "one more", author: "you" }), /already has 100 updates today/);
    await store.deleteTask(b.id);
    assert.equal((await store.listStatuses({ taskId: b.id })).length, 0, "a deleted task leaves no status rows");

    // ---- write-up retention ----
    await store.insertWriteup({ at: new Date(Date.now() - 40 * 86_400_000).toISOString(), inputsHash: "old", model: null, text: "old", valid: true, error: null });
    assert.ok((await store.listWriteups({ limit: 500 })).some((x) => x.inputsHash === "old"), "an insert never loses its own row");
    await store.insertWriteup({ inputsHash: "new", model: null, text: "new", valid: true, error: null });
    assert.ok(!(await store.listWriteups({ limit: 500 })).some((x) => x.inputsHash === "old"), "write-ups older than 30 days are pruned");

    assert.ok(existsSync(store.notePath(a.id)));
    console.log("jarvis-overview harness: ok");
} finally {
    await ov.stopOverviewRunner().catch(() => undefined);
    closeDb();
    rmSync(root, { recursive: true, force: true });
}
