// The New task dialog's work item picker: the service's search text and WIQL, how each org's
// list is merged, what one org failing does, the web side's pure rules, and the wiring that
// keeps Escape and the dialog's close in step with the list.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "workitem-picker-"));
process.env.ADO_PR_OPS_DB_PATH = join(root, "data", "reviews.db");
process.env.ADO_PR_OPS_JARVIS_DIR = join(root, "jarvis");

const ado = await import("../ado.mjs");
const today = await import("../jarvis-today.mjs");
const { closeDb } = await import("../store.mjs");
const model = await import("../web/workItemPickerModel.js");

const FINISHED = ado.FINISHED_WORK_ITEM_STATES.map((s) => `NOT s:${s}`).join(" ");
const item = (org, id, over = {}) => ({
    org,
    project: "P",
    id,
    title: `Item ${id}`,
    type: "Task",
    state: "Active",
    url: `https://dev.azure.com/${org}/P/_workitems/edit/${id}`,
    ...over,
});

try {
    // ---- the search text ----
    assert.equal(ado.workItemSearchText("config  store"), `(config store*) ${FINISHED}`, "the last word matches as a prefix too");
    assert.equal(ado.workItemSearchText("config store "), `(config store) ${FINISHED}`, "a trailing space makes the last word whole");
    assert.equal(ado.workItemSearchText("fix ab"), `(fix ab) ${FINISHED}`, "a word under 3 letters is never a prefix");
    assert.equal(ado.workItemSearchText('s:Closed OR "Foo"'), `(s closed or foo*) ${FINISHED}`, "filters, operators and quotes are taken as words");
    assert.equal(ado.workItemSearchText("NOT done"), `(not done*) ${FINISHED}`, "a typed NOT can't negate the search");
    assert.equal(ado.workItemSearchText("Azconfig.GenevaActions"), `(azconfig.genevaactions*) ${FINISHED}`, "dotted names stay one word");
    assert.equal(ado.workItemSearchText("!!! ... --"), "", "nothing searchable left");
    assert.equal(ado.workItemSearchText(""), "");
    const many = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
    assert.equal(ado.workItemSearchText(many).match(/\((.*)\)/)[1].split(" ").length, 12, "at most 12 words");

    // ---- the assigned-to-me WIQL ----
    const wiql = ado.assignedWorkItemsWiql(["Azure AppConfig", "O'Brien"]);
    assert.match(wiql, /\[System\.TeamProject\] IN \('Azure AppConfig', 'O''Brien'\)/, "project names are quoted, quotes doubled");
    assert.match(wiql, /\[System\.AssignedTo\] = @Me/);
    assert.match(wiql, /\[System\.State\] NOT IN \('Closed', 'Done', 'Removed', 'Resolved', 'Completed', 'Cut'\)/, "finished items are left out");
    assert.match(wiql, /ORDER BY \[System\.ChangedDate\] DESC$/);

    // ---- merging each org's list ----
    const merged = today.mergeWorkItemLists([
        [item("One", 1), item("One", 2), item("One", 3)],
        [item("Two", 10), item("two", 10, { title: "dup" }), item("Two", 11, { state: "closed" })],
    ]);
    assert.deepEqual(
        merged.map((w) => `${w.org}:${w.id}`),
        ["One:1", "Two:10", "One:2", "One:3"],
        "taken in turns, each once (org case aside), finished states left out whatever their case",
    );
    assert.equal(today.mergeWorkItemLists([[1, 2, 3].map((id) => item("One", id)), [4, 5].map((id) => item("Two", id))], 3).length, 3, "the limit");
    assert.deepEqual(today.mergeWorkItemLists([]), []);

    // ---- suggestWorkItems, with fake lookups ----
    const cfg = { organizations: ["One", "Two", "Three"], projects: { One: ["P1"], Two: ["P2", "P3"], Three: [] } };
    const calls = [];
    const lookups = {
        assigned: async (org, projects, top) => {
            calls.push({ kind: "assigned", org, projects, top });
            if (org === "Two") throw new Error("ADO POST 401: no access");
            return [item(org, 1), item(org, 2, { state: "Done" })];
        },
        search: async (org, projects, text, top) => {
            calls.push({ kind: "search", org, projects, text, top });
            return [item(org, 7)];
        },
    };

    let r = await today.suggestWorkItems("", cfg, lookups);
    assert.equal(r.scope, "assigned", "nothing typed lists your items");
    assert.deepEqual(calls.map((c) => c.org), ["One", "Two"], "an org with no opted-in project isn't asked");
    assert.deepEqual(calls[1].projects, ["P2", "P3"], "each org is asked about its own opted-in projects");
    assert.deepEqual(r.items.map((w) => `${w.org}:${w.id}`), ["One:1"], "one org failing doesn't hide the others; finished items are dropped");
    assert.deepEqual(r.errors, [{ org: "Two", message: "ADO POST 401: no access" }]);
    assert.equal(r.noProjects, false);

    calls.length = 0;
    r = await today.suggestWorkItems("config store ", cfg, lookups);
    assert.equal(r.scope, "search");
    assert.deepEqual(calls.map((c) => c.text), ["config store ", "config store "], "the trailing space reaches the search");
    assert.deepEqual(r.items.map((w) => `${w.org}:${w.id}`), ["One:7", "Two:7"]);
    assert.deepEqual(r.errors, []);

    calls.length = 0;
    r = await today.suggestWorkItems("x".repeat(500), cfg, lookups);
    assert.equal(calls[0].text.length, 200, "what's typed is capped");

    calls.length = 0;
    r = await today.suggestWorkItems("?! ..", cfg, lookups);
    assert.deepEqual([r.scope, r.items, r.errors, calls.length], ["search", [], [], 0], "nothing searchable asks no one");

    r = await today.suggestWorkItems("", { organizations: ["One"], projects: {} }, lookups);
    assert.deepEqual([r.scope, r.noProjects, r.items], ["assigned", true, []], "no opted-in project says so");
    r = await today.suggestWorkItems("config", { organizations: [], projects: { One: ["P1"] } }, lookups);
    assert.deepEqual([r.scope, r.noProjects], ["search", true], "only Settings' orgs count");

    // ---- the web model: what's in the field ----
    assert.equal(model.classifyQuery(""), "empty");
    assert.equal(model.classifyQuery("   "), "empty");
    assert.equal(model.classifyQuery("2841124"), "ref");
    assert.equal(model.classifyQuery(" #2841124 "), "ref");
    assert.equal(model.classifyQuery("https://msazure.visualstudio.com/One/_workitems/edit/1"), "ref");
    assert.equal(model.classifyQuery("a"), "short");
    assert.equal(model.classifyQuery("a !"), "short", "punctuation doesn't count toward a search");
    assert.equal(model.classifyQuery("ab"), "text");
    assert.equal(model.classifyQuery("12 flaky tests"), "text", "a number with words is a search");
    assert.equal(model.searchQuery("  fix   login\t"), "fix login ", "spaces folded, the start trimmed, a trailing one kept");
    assert.equal(model.searchQuery("y".repeat(300)).length, 200);

    // ---- moving through the rows ----
    assert.equal(model.moveIndex(-1, 1, 3), 0, "down from none is the first");
    assert.equal(model.moveIndex(-1, -1, 3), 2, "up from none is the last");
    assert.equal(model.moveIndex(2, 1, 3), 0, "wraps at the bottom");
    assert.equal(model.moveIndex(0, -1, 3), 2, "wraps at the top");
    assert.equal(model.moveIndex(1, 1, 0), -1, "no rows, no active row");

    // ---- what a row and a screen reader say ----
    const w = item("One", 2841124, { type: "User Story", project: "Azure AppConfig", title: "Fix login timeout" });
    assert.equal(model.optionMeta(w, false), "User Story #2841124 · Active · Azure AppConfig");
    assert.equal(model.optionMeta(w, true), "User Story #2841124 · Active · Azure AppConfig · One", "the org shows when there are several");
    assert.equal(model.optionMeta({ ...w, type: "", state: "" }, false), "Work item #2841124 · Azure AppConfig");
    assert.equal(model.optionAnnouncement(w, 1, 4, false), "Fix login timeout, User Story #2841124 · Active · Azure AppConfig. 2 of 4.");
    assert.equal(model.listHeading("assigned"), "Assigned to you");
    assert.equal(model.listHeading("search"), "Best matches");
    assert.equal(model.countAnnouncement("assigned", 1), "1 open work item assigned to you.");
    assert.equal(model.countAnnouncement("search", 3), "3 matches.");

    // ---- the line under or instead of the rows ----
    const base = { scope: "search", items: [], errors: [], noProjects: false };
    assert.match(model.suggestionsNote({ ...base, noProjects: true }).text, /^Opt in to projects under Settings/);
    assert.equal(model.suggestionsNote({ ...base, items: [w] }), null, "the rows say it all");
    let note = model.suggestionsNote({ ...base, errors: [{ org: "One", message: "401" }, { org: "Two", message: "timed out" }] });
    assert.equal(note.text, "Couldn't search One or Two. Enter the work item's number or link instead.");
    assert.equal(note.detail, "One: 401\nTwo: timed out", "the full errors are in the tooltip");
    assert.equal(note.error, true);
    note = model.suggestionsNote({ ...base, items: [w], errors: [{ org: "Two", message: "x" }] });
    assert.equal(note.text, "Couldn't search Two; these are from the rest.", "a partial answer says what's missing");
    assert.match(model.suggestionsNote({ ...base, scope: "assigned" }).text, /^Nothing open is assigned to you/);
    assert.match(model.suggestionsNote(base).text, /^No open work items match/);

    // ---- marking what matched ----
    assert.deepEqual(model.highlightParts("Fix login timeout", "log time"), [
        { text: "Fix ", hit: false },
        { text: "log", hit: true },
        { text: "in ", hit: false },
        { text: "time", hit: true },
        { text: "out", hit: false },
    ]);
    assert.deepEqual(model.highlightParts("Fix login", ""), [{ text: "Fix login", hit: false }], "nothing typed marks nothing");
    assert.deepEqual(model.highlightParts("Fix login", "l"), [{ text: "Fix login", hit: false }], "a one-letter word marks nothing");
    assert.deepEqual(
        model.highlightParts("Config configuration", "config configur"),
        [
            { text: "Config", hit: true },
            { text: " ", hit: false },
            { text: "configur", hit: true },
            { text: "ation", hit: false },
        ],
        "the longest typed word that starts a title word wins",
    );
    assert.equal(model.highlightParts("<b>x</b> login", "login").map((p) => p.text).join(""), "<b>x</b> login", "the parts put the title back together");

    // ---- the wiring ----
    const picker = await readFile(new URL("../web/src/workItemPicker.ts", import.meta.url), "utf8");
    assert.match(picker, /setAttribute\("role", "combobox"\)/, "the field is a combobox");
    assert.match(picker, /setAttribute\("aria-expanded", "true"\)/);
    assert.match(picker, /"aria-activedescendant"/, "the active row is announced without moving focus");
    assert.match(picker, /role="listbox"/);
    assert.match(picker, /new AbortController\(\)/, "a newer lookup aborts the one in flight");
    assert.match(picker, /if \(my !== seq \|\| gone\(\)\) return;/, "a stale answer never paints");
    assert.match(picker, /popup\.addEventListener\("mousedown", \(e\) => e\.preventDefault\(\)\)/, "clicking a row keeps focus in the field");

    const actions = await readFile(new URL("../web/src/prActions.ts", import.meta.url), "utf8");
    assert.match(
        actions,
        /event\.key === "Escape" && \(event\.target as Element \| null\)\?\.matches\?\.\('\[role="combobox"\]\[aria-expanded="true"\]'\)\) return;/,
        "Escape in an open combobox closes its list, not the dialog",
    );
    assert.match(actions, /opts\.onClose\?\.\(\);/, "the dialog says when it closes");

    const jarvis = await readFile(new URL("../web/src/jarvis.ts", import.meta.url), "utf8");
    assert.match(jarvis, /attachWorkItemPicker\(\{ input: refField/, "the New task dialog's Work item field gets the picker");
    assert.match(jarvis, /onClose: \(\) => picker\?\.destroy\(\)/, "closing the dialog lets go of the picker");
    assert.match(jarvis, /if \(classifyQuery\(ref\) !== "ref"\) throw new Error/, "words alone don't create a task");

    const api = await readFile(new URL("../src/jarvis-api.mts", import.meta.url), "utf8");
    assert.match(api, /p === "\/api\/jarvis\/workitems" && get[\s\S]{0,120}suggestWorkItems\(q\.get\("q"\) \|\| "", await readConfig\(\)\)/);

    const css = await readFile(new URL("../web/style.css", import.meta.url), "utf8");
    assert.match(css, /\.wi-anchor \{ position: relative; \}/, "the list is placed against the field");
    assert.match(css, /\.wi-popup\[hidden\] \{ display: none; \}/);

    console.log("workitem-picker harness: ok");
} finally {
    closeDb();
    rmSync(root, { recursive: true, force: true });
}
