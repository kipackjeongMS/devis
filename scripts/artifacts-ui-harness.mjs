// The Artifacts window (artifacts.html, artifacts.ts) and the task drawer's Artifacts tab that opens it, in hidden
// Electron windows: the list and the file beside it, files picked here or asked for through the hash, editing and
// saving (with a worker's write in between), new notes, delete, following a worker's changes, a removed task, and
// the drawer opening the window, making a note into its editor, and reading its list again on the window's word.
// Set ADO_PR_OPS_UI_SCREENSHOT to a .png path to save the window at 1080 × 820 (and at 600 × 700, beside it as -narrow.png).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TASK = "0f8fad5b-d9cb-469f-a165-70867728950e";
const web = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");
const root = mkdtempSync(join(tmpdir(), "artifacts-ui-"));
const shot = process.env.ADO_PR_OPS_UI_SCREENSHOT ? resolve(process.env.ADO_PR_OPS_UI_SCREENSHOT).replace(/\\/g, "/") : "";
const electron = (await import("electron")).default;

// ---- in the window, before artifacts.js runs: the task's files and a fake API over them -------------------------

function fake(task) {
    const mode = new URLSearchParams(location.search).get("fake") || "";
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let clock = Date.now() - 60 * 60_000;
    const stamp = () => new Date((clock += 1000)).toISOString();
    const dir = "C:\\Tasks\\Devis app development\\artifacts";
    const S = {
        title: "Devis app development",
        gone: mode === "gone",
        files: new Map(),
        createdAt: new Date(clock - 86_400_000).toISOString(),
    };
    const put = (name, content) => S.files.set(name, { name, content, modifiedAt: stamp() });
    put("data.json", '{ "a": 1 }');
    put("recap.md", "# Recap\n\nAll done.");
    put("note.md", "# Shared note\n\nDecisions go here.");
    put("design.md", "# Design\n\nThe window.\n\n```mermaid\ngraph TD\n  A[Drawer] --> B[Window]\n```\n");
    const lower = (s) => String(s || "").toLowerCase();
    const find = (name) => [...S.files.values()].find((f) => lower(f.name) === lower(name)) || null;
    const size = (f) => new TextEncoder().encode(f.content).length;
    const info = (f) => ({ name: f.name, size: size(f), modifiedAt: f.modifiedAt });
    const artifact = (f) => ({ ...info(f), content: f.content, path: `${dir}\\${f.name}` });
    const rank = (n) => (lower(n) === "note.md" ? 0 : lower(n) === "recap.md" ? 1 : 2);
    const list = () =>
        [...S.files.values()].sort((a, b) => rank(a.name) - rank(b.name) || b.modifiedAt.localeCompare(a.modifiedAt)).map(info);
    const calls = [];
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    window.fetch = async (input, init = {}) => {
        const url = new URL(String(input), location.href);
        const q = url.searchParams;
        const body = init.body ? JSON.parse(init.body) : null;
        const method = init.method || "GET";
        calls.push({ path: url.pathname, method, q: Object.fromEntries(q), body });
        await sleep(5);
        if (url.pathname === "/api/ping") return json({ pid: 1, startedAt: 1 });
        const id = body?.id ?? q.get("id");
        if (S.gone || id !== task) return json({ error: "Task not found." }, 404);
        switch (url.pathname) {
            case "/api/jarvis/artifacts":
                return json({ artifacts: list(), dir, title: S.title });
            case "/api/jarvis/artifact": {
                const name = method === "POST" ? body.name : q.get("name");
                const cur = find(name);
                if (method === "POST") {
                    if (body.create && cur) return json({ error: `${name} is already in this task's Artifacts.` }, 409);
                    if (typeof body.base === "string" && cur && cur.content !== body.base) {
                        return json({ error: `${cur.name} changed while you were editing it.` }, 409);
                    }
                    put(cur ? cur.name : name, body.content);
                    return json({ artifact: artifact(find(name)) });
                }
                if (cur) return json({ artifact: artifact(cur) });
                if (lower(name) === "note.md") return json({ artifact: { name: "note.md", size: 0, modifiedAt: S.createdAt, content: "", path: `${dir}\\note.md` } });
                return json({ error: "No such artifact." }, 404);
            }
            case "/api/jarvis/artifact/delete":
                S.files.delete(find(body.name)?.name);
                return json({ ok: true });
            case "/api/jarvis/artifacts/open-folder":
                return json({ ok: true });
        }
        return json({ error: "Not found" }, 404);
    };
    const broadcasts = [];
    new BroadcastChannel("devis-artifacts").addEventListener("message", (e) => broadcasts.push(e.data));
    const errors = [];
    window.addEventListener("error", (e) => errors.push(`error: ${e.message}`));
    window.addEventListener("unhandledrejection", (e) => errors.push(`unhandled: ${(e.reason && e.reason.stack) || e.reason}`));
    const consoleError = console.error.bind(console);
    console.error = (...args) => {
        errors.push(`console.error: ${args.map(String).join(" ")}`);
        consoleError(...args);
    };
    window.W = { S, calls, broadcasts, errors, put, find, dir, stamp };
}

// ---- the window's checks ---------------------------------------------------------------------------------------------

function windowSteps(task) {
    const failures = [];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const check = (name, ok) => { if (!ok) failures.push(name); };
    const until = async (name, test, ms = 3000) => {
        const end = performance.now() + ms;
        for (;;) {
            let ok = false;
            try { ok = !!test(); } catch { ok = false; }
            if (ok) return true;
            if (performance.now() > end) {
                failures.push(`timed out: ${name}`);
                return false;
            }
            await sleep(10);
        }
    };
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => [...document.querySelectorAll(s)];
    const { S, calls, broadcasts, errors, put, find, dir, stamp } = window.W;
    const names = () => $$(".aw-file").map((b) => b.dataset.name);
    const item = (name) => $$(".aw-file").find((b) => b.dataset.name === name);
    const current = () => $$('.aw-file[aria-current="true"]').map((b) => b.dataset.name);
    const crumb = () => $(".aw-crumb")?.textContent || "";
    const area = () => $(".aw-main textarea");
    const toastText = () => ($("#toast") && !$("#toast").hidden ? $("#toast").textContent : "");
    const posts = () => calls.filter((c) => c.method === "POST" && c.path === "/api/jarvis/artifact");
    const press = (target, key, opts = {}) =>
        target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }));
    const shows = (name, test) => until(`${name} shows`, () => crumb() === name && !$(".aw-main .spinner") && (!test || test()));
    const viewing = () => !!$('[data-act="aw-edit"]') && !area();
    const clearToast = () => { if ($("#toast")) $("#toast").hidden = true; };

    return (async () => {
        // ---- the first paint ----
        await until("the list loads", () => names().length === 4);
        check("the list is note, recap, then newest", JSON.stringify(names()) === JSON.stringify(["note.md", "recap.md", "design.md", "data.json"]));
        check("the window title names the task", document.title === "Devis app development \u00b7 Artifacts");
        check("the title bar names the task", $("#artsTitle").textContent === "Artifacts \u00b7 Devis app development");
        check("the count shows", $(".aw-count").textContent === " 4");
        check("the folder shows under the list", $(".aw-dir").textContent === dir && !$(".aw-dir").hidden);
        check("roles show in the meta line", item("note.md").querySelector(".aw-file-meta").textContent.startsWith("Shared note \u00b7 ") &&
            item("recap.md").querySelector(".aw-file-meta").textContent.startsWith("Recap \u00b7 "));
        await shows("note.md", () => $(".aw-md h1")?.textContent === "Shared note");
        check("without a file in the hash, the note opens", current().join() === "note.md" && location.hash === "#file=note.md");
        check("the note has Edit but no Delete", !!$('[data-act="aw-edit"]') && !$('[data-act="aw-delete"]'));
        check("the file's path shows", $(".aw-path")?.textContent === `${dir}\\note.md`);
        check("the request names the task", calls.some((c) => c.path === "/api/jarvis/artifacts" && c.q.id === task));

        // ---- picking files ----
        item("design.md").click();
        await shows("design.md", () => $(".aw-md h1")?.textContent === "Design");
        check("a pick goes in the hash", location.hash === "#file=design.md");
        check("the list marks it", current().join() === "design.md");
        check("other files have Delete", !!$('[data-act="aw-delete"]'));
        await until("the diagram draws", () => $(".aw-md .mermaid.rendered svg"), 8000);
        item("data.json").click();
        await shows("data.json", () => $(".aw-pre")?.textContent === '{ "a": 1 }');
        check("a file that isn't Markdown shows as text", !$(".aw-md"));

        // The Workspace asks for a file: the shell sets the hash.
        location.hash = "#file=recap.md";
        await shows("recap.md", () => $(".aw-md h1")?.textContent === "Recap");
        check("the list follows the hash", current().join() === "recap.md");

        // Up and down step through the files.
        item("note.md").focus();
        press(item("note.md"), "ArrowDown");
        check("ArrowDown moves to the next file", document.activeElement === item("recap.md"));
        press(item("recap.md"), "End");
        check("End moves to the last file", document.activeElement === item("data.json"));
        press(item("data.json"), "Home");
        check("Home moves to the first file", document.activeElement === item("note.md"));

        // ---- editing ----
        item("design.md").click();
        await shows("design.md", () => !!$(".aw-md h1"));
        const original = find("design.md").content;
        $('[data-act="aw-edit"]').click();
        check("Edit opens the editor on the file", area()?.value === original && document.activeElement === area());
        check("the head says what's being edited", crumb() === "Editing design.md" && !!$('[data-act="aw-save"]') && !!$('[data-act="aw-cancel"]'));
        area().value = original + "\nMore.";
        press(area(), "s", { ctrlKey: true });
        await until("Ctrl+S saves", () => viewing() && $(".aw-md")?.textContent.includes("More."));
        const saved = posts().at(-1)?.body;
        check("the save sends the text and the text it started from", saved?.content === original + "\nMore." && saved?.base === original && saved?.id === task);
        check("the save says so", toastText() === "Saved design.md");
        check("focus goes back to Edit", document.activeElement === $('[data-act="aw-edit"]'));
        await until("the save tells the Workspace", () => broadcasts.some((b) => b.type === "changed" && b.taskId === task));

        // A file asked for during an edit waits; the edit stays.
        $('[data-act="aw-edit"]').click();
        area().value = "Half typed";
        clearToast();
        location.hash = "#file=note.md";
        await until("the switch is refused", () => toastText() === "Save or cancel your edit to design.md first.");
        check("the edit stays", area()?.value === "Half typed" && crumb() === "Editing design.md");
        check("the hash goes back to the file being edited", location.hash === "#file=design.md");
        clearToast();
        item("recap.md").click();
        check("so does a pick in the list", toastText() === "Save or cancel your edit to design.md first." && area()?.value === "Half typed");
        clearToast();
        $('[data-act="aw-new"]').click();
        check("and New note", toastText() === "Save or cancel your edit to design.md first." && area()?.value === "Half typed" && !$("#aw-new-name"));

        // Escape drops an edit only while nothing was typed.
        press(area(), "Escape");
        check("Escape keeps typed text", !!area() && area().value === "Half typed" && toastText().startsWith("Your edit isn't saved."));
        $('[data-act="aw-cancel"]').click();
        await shows("design.md", () => viewing() && $(".aw-md")?.textContent.includes("More."));
        check("Cancel drops the edit", !$(".aw-md").textContent.includes("Half typed") && document.activeElement === $('[data-act="aw-edit"]'));
        $('[data-act="aw-edit"]').click();
        press(area(), "Escape");
        check("Escape with nothing typed leaves the editor", viewing());

        // A worker wrote the file during the edit: the save is refused, the text kept; saving again replaces it.
        $('[data-act="aw-edit"]').click();
        put("design.md", "# Design\n\nA worker's version.");
        area().value = "# Design\n\nMine.";
        $('[data-act="aw-save"]').click();
        await until("the conflict is explained", () => toastText().includes("changed while you edited it"));
        check("the text is kept after a conflict", area()?.value === "# Design\n\nMine." && crumb() === "Editing design.md");
        check("Save is usable again", !$('[data-act="aw-save"]').disabled);
        $('[data-act="aw-save"]').click();
        await until("the second save goes through", () => viewing() && $(".aw-md")?.textContent.includes("Mine."));
        check("the second save is based on the worker's version", posts().at(-1)?.body.base === "# Design\n\nA worker's version.");
        check("the file holds the user's text", find("design.md").content === "# Design\n\nMine.");

        // The Workspace made a note and asks for its editor.
        put("plan.md", "# Plan\n");
        location.hash = "#file=plan.md&edit=1";
        await until("the note opens in the editor", () => crumb() === "Editing plan.md" && area()?.value === "# Plan\n");
        check("the caret is at the end", area().selectionStart === "# Plan\n".length && document.activeElement === area());
        check("the hash drops edit, so a reload only shows it", location.hash === "#file=plan.md");
        press(area(), "Escape");
        await until("plan.md is in the list", () => names().includes("plan.md"));

        // ---- new notes ----
        const before = broadcasts.length;
        $('[data-act="aw-new"]').click();
        const input = $("#aw-new-name");
        check("New note asks for a name", !!input && input.value === "notes.md" && document.activeElement === input);
        input.value = "findings.md";
        $('form[data-form="aw-new"]').requestSubmit();
        await until("the new note opens in the editor", () => crumb() === "Editing findings.md" && !!area());
        const made = posts().at(-1)?.body;
        check("it's made with create", made?.create === true && made?.name === "findings.md");
        check("its editor starts from the template", area().value === find("findings.md").content);
        check("it goes in the hash", location.hash === "#file=findings.md");
        await until("it shows in the list", () => names().includes("findings.md") && current().join() === "findings.md");
        await until("the Workspace hears of it", () => broadcasts.length > before);
        press(area(), "Escape");
        check("Escape leaves the untouched editor", viewing());

        $('[data-act="aw-new"]').click();
        $("#aw-new-name").value = "design.md";
        clearToast();
        $('form[data-form="aw-new"]').requestSubmit();
        await until("a taken name is refused", () => toastText().includes("already in this task's Artifacts"));
        check("the form stays", !!$("#aw-new-name") && $("#aw-new-name").value === "design.md");
        press($("#aw-new-name"), "Escape");
        await shows("findings.md", viewing);
        check("Escape leaves the form", !$("#aw-new-name") && document.activeElement === $('[data-act="aw-new"]'));

        $('[data-act="aw-new"]').click();
        item("recap.md").click();
        await shows("recap.md", viewing);
        check("a pick leaves the form", !$("#aw-new-name"));

        // ---- delete ----
        item("findings.md").click();
        await shows("findings.md", viewing);
        const deletesBefore = broadcasts.length;
        $('[data-act="aw-delete"]').click();
        await until("Delete asks first", () => $(".ask-overlay .pa-confirm"));
        check("the dialog names the file", $(".ask-overlay").textContent.includes("findings.md"));
        $(".ask-overlay .pa-confirm").click();
        await until("the file is deleted", () => toastText() === "Deleted findings.md");
        check("the delete names the task and file", calls.some((c) => c.path === "/api/jarvis/artifact/delete" && c.body.id === task && c.body.name === "findings.md"));
        await shows("note.md", viewing);
        await until("the list drops it", () => !names().includes("findings.md"));
        await until("the Workspace hears of the delete", () => broadcasts.length > deletesBefore);
        check("focus lands in the list", document.activeElement?.classList.contains("aw-file") || document.activeElement === $('[data-act="aw-new"]'));

        // ---- following the workers ----
        item("design.md").click();
        await shows("design.md", viewing);
        put("design.md", "# Design v2\n");
        window.dispatchEvent(new Event("focus"));
        await until("a worker's write shows", () => $(".aw-md h1")?.textContent === "Design v2");
        S.files.delete("design.md");
        clearToast();
        window.dispatchEvent(new Event("focus"));
        await until("a deleted file says so", () => toastText() === "design.md was deleted.");
        await shows("note.md", viewing);
        check("the list drops the deleted file", !names().includes("design.md"));

        clearToast();
        location.hash = "#file=ghost.md";
        await until("a missing file says so", () => toastText() === "ghost.md isn't in this task's Artifacts anymore.");
        await shows("note.md", viewing);

        // The folder button asks the service to open it.
        $('[data-act="aw-folder"]').click();
        await until("the folder opens", () => calls.some((c) => c.path === "/api/jarvis/artifacts/open-folder" && c.body.id === task));

        // ---- the task is removed during an edit ----
        $('[data-act="aw-edit"]').click();
        area().value = "Keep me";
        S.gone = true;
        clearToast();
        window.dispatchEvent(new Event("focus"));
        await until("the edit hears the task is gone", () => toastText().startsWith("This task was removed"));
        check("the text stays to copy", area()?.value === "Keep me");
        $('[data-act="aw-cancel"]').click();
        check("Cancel shows the task is gone", $(".cw-state-title")?.textContent === "This task is gone" && !!$('[data-act="aw-close"]'));
        check("the title drops the task", document.title === "Artifacts \u00b7 Devis");
        const after = calls.length;
        window.dispatchEvent(new Event("focus"));
        await sleep(60);
        check("a gone task isn't asked again", calls.length === after);

        check("no page errors", errors.length === 0);
        return { failures: failures.concat(errors) };
    })().catch((error) => ({ failures: failures.concat(String((error && error.stack) || error)) }));
}

async function bootChecks(expect) {
    const failures = [];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const $ = (s) => document.querySelector(s);
    for (let i = 0; i < 300; i++) {
        const done =
            expect === "edit" ? $(".aw-main textarea") :
            expect === "gone" ? $(".cw-state-title")?.textContent === "This task is gone" :
            $(".cw-state-title")?.textContent === "This window needs a task";
        if (done) break;
        await sleep(10);
    }
    const W = window.W;
    if (expect === "edit") {
        if ($(".aw-crumb")?.textContent !== "Editing design.md") failures.push("boot: #file=…&edit=1 opens that file's editor");
        if (location.hash !== "#file=design.md") failures.push("boot: the hash drops edit once it's open");
    } else if (expect === "gone") {
        if ($(".cw-state-title")?.textContent !== "This task is gone") failures.push("boot: a removed task says so");
        if (!$('[data-act="aw-close"]')) failures.push("boot: a removed task offers Close window");
    } else {
        if ($(".cw-state-title")?.textContent !== "This window needs a task") failures.push("boot: no task id says so");
        if (W.calls.some((c) => c.path.startsWith("/api/jarvis/"))) failures.push("boot: no task id asks for nothing");
    }
    failures.push(...W.errors);
    return { failures };
}

// ---- the drawer's Artifacts tab -----------------------------------------------------------------------------------

async function drawerSteps(task) {
    const failures = [];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const check = (name, ok) => { if (!ok) failures.push(name); };
    const until = async (name, test, ms = 3000) => {
        const end = performance.now() + ms;
        for (;;) {
            if (test()) return true;
            if (performance.now() > end) {
                failures.push(`timed out: ${name}`);
                return false;
            }
            await sleep(10);
        }
    };
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => [...document.querySelectorAll(s)];
    const at = new Date().toISOString();
    const files = [
        { name: "note.md", size: 10, modifiedAt: at },
        { name: "design.md", size: 20, modifiedAt: at },
    ];
    const t = {
        id: task, title: "Devis app development", folder: "C:\\Tasks\\Devis", org: null, project: null, workItem: null,
        status: "open", createdAt: at, updatedAt: at, doneAt: null, workers: [], updates: { latest: null, today: [] }, prs: [],
    };
    const calls = [];
    const errors = [];
    window.addEventListener("error", (e) => errors.push(`error: ${e.message}`));
    window.addEventListener("unhandledrejection", (e) => errors.push(`unhandled: ${(e.reason && e.reason.stack) || e.reason}`));
    window.fetch = async (input, init = {}) => {
        const url = new URL(String(input), location.href);
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ path: url.pathname, method: init.method || "GET", body });
        let data = {};
        if (url.pathname === "/api/jarvis/statuses") data = { statuses: [], hasMore: false };
        else if (url.pathname === "/api/jarvis/task-prs") data = { prs: [], syncedAt: null };
        else if (url.pathname === "/api/models") data = { models: [] };
        else if (url.pathname === "/api/jarvis/artifacts") data = { artifacts: files.slice(), dir: "C:\\Tasks\\Devis\\artifacts", title: t.title };
        else if (url.pathname === "/api/jarvis/artifact" && init.method === "POST") {
            const made = { name: body.name, size: body.content.length, modifiedAt: new Date().toISOString() };
            files.push(made);
            data = { artifact: { ...made, content: body.content, path: `C:\\Tasks\\Devis\\artifacts\\${body.name}` } };
        }
        return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const opened = [];
    window.open = (url, name) => { opened.push({ url, name }); return null; };
    const { openTaskModal, closeTaskModal } = await import("/jarvisTask.js");
    const host = { task: () => t, todayAt: () => Date.now(), refresh: async () => {}, startWorker() {}, deleteTask() {}, openPr: async () => {} };
    const lists = () => calls.filter((c) => c.path === "/api/jarvis/artifacts").length;

    openTaskModal(t.id, host, "artifacts");
    await until("the drawer lists the artifacts", () => $$(".tm-art").length === 2);
    const design = $$(".tm-art").find((b) => b.dataset.name === "design.md");
    check("a file says where it opens", design.title === "Open design.md in the Artifacts window");
    design.click();
    check("a file opens the task's Artifacts window on it",
        opened.length === 1 && opened[0].url === `/artifacts.html?task=${task}#file=design.md` && opened[0].name === `devis-artifacts-${task}`);
    check("the drawer keeps its list", $$(".tm-art").length === 2 && !$(".tm-arts textarea") && !$(".tm-arts .md"));

    $('[data-act="art-new"]').click();
    const input = $("#tm-art-name");
    check("New note asks for a name", !!input && document.activeElement === input);
    input.value = "findings.md";
    $('form[data-form="art-new"]').requestSubmit();
    await until("the note opens in the window's editor", () => opened.length === 2);
    check("the window opens on the new note's editor", opened[1]?.url === `/artifacts.html?task=${task}#file=findings.md&edit=1` && opened[1]?.name === `devis-artifacts-${task}`);
    check("the note is made with create", calls.some((c) => c.method === "POST" && c.body?.create === true && c.body?.name === "findings.md" && c.body?.id === task));
    await until("the drawer goes back to the list with the note", () => !$("#tm-art-name") && $$(".tm-art").some((b) => b.dataset.name === "findings.md"));
    check("focus goes back to New note", document.activeElement === $('[data-act="art-new"]'));

    // The window changed a file: the drawer reads its list again, for its own task only.
    const before = lists();
    const channel = new BroadcastChannel("devis-artifacts");
    channel.postMessage({ type: "changed", taskId: task.toUpperCase() });
    await until("the window's change reaches the drawer", () => lists() > before);
    const now = lists();
    channel.postMessage({ type: "changed", taskId: "7c9e6679-7425-40de-944b-e07fc1f90ae7" });
    channel.postMessage({ type: "other", taskId: task });
    await sleep(120);
    check("another task's change, or another message, is ignored", lists() === now);
    channel.close();

    $('[data-act="art-new"]').click();
    $("#tm-art-name").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    check("Escape leaves the drawer's form", !$("#tm-art-name") && $$(".tm-art").length === 3);
    closeTaskModal();
    check("no page errors", errors.length === 0);
    return { failures: failures.concat(errors) };
}

// ---- the server -----------------------------------------------------------------------------------------------------

const artifactsPage = () =>
    readFileSync(join(web, "artifacts.html"), "utf8").replace(
        '<script src="vendor/mermaid.min.js" defer></script>',
        `<script>(${fake.toString()})(${JSON.stringify(TASK)});</script>\n    <script src="vendor/mermaid.min.js" defer></script>`,
    );

const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/") {
        res.setHeader("Content-Type", "text/html");
        return res.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body data-feature="jarvis"><div id="toast" role="status" hidden></div></body></html>');
    }
    if (url.pathname === "/artifacts.html") {
        res.setHeader("Content-Type", "text/html");
        return res.end(artifactsPage());
    }
    const file = resolve(web, "." + decodeURIComponent(url.pathname));
    if (!file.startsWith(web + sep)) {
        res.writeHead(403).end();
        return;
    }
    try {
        res.setHeader("Content-Type", { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".svg": "image/svg+xml" }[extname(file)] || "application/octet-stream");
        res.end(readFileSync(file));
    } catch {
        res.writeHead(404).end();
    }
});

try {
    assert.ok(artifactsPage().includes("window.W ="), "the fake API goes in ahead of artifacts.js");
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (fn, ...args) => `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(", ")})`;
    const steps = {
        window: call(windowSteps, TASK),
        edit: call(bootChecks, "edit"),
        gone: call(bootChecks, "gone"),
        noTask: call(bootChecks, "none"),
        drawer: call(drawerSteps, TASK),
    };
    const main = join(root, "main.cjs");
    writeFileSync(main, `
        const { app, BrowserWindow } = require("electron");
        const base = ${JSON.stringify(base)};
        const task = ${JSON.stringify(TASK)};
        const steps = ${JSON.stringify(steps)};
        const shot = ${JSON.stringify(shot)};
        const prefs = { sandbox: true, contextIsolation: true, backgroundThrottling: false };
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        app.setPath("userData", ${JSON.stringify(join(root, "profile"))});
        // Each page gets a fresh window; closing one mustn't quit the app before the next opens.
        app.on("window-all-closed", () => {});
        app.whenReady().then(async () => {
            const out = { failures: [] };
            const open = async (path, width = 1080, height = 820, extra = {}) => {
                const win = new BrowserWindow({ show: false, useContentSize: true, width, height, webPreferences: { ...prefs, ...extra } });
                win.webContents.on("console-message", (event, level, message) => {
                    const lv = typeof level === "number" ? level : event.level;
                    const text = typeof message === "string" ? message : event.message;
                    if (lv === 3 || lv === "error") out.failures.push(path + ": console: " + text);
                });
                await win.loadURL(base + path);
                return win;
            };
            const run = async (win, code) => {
                const r = await win.webContents.executeJavaScript(code);
                out.failures.push(...r.failures);
            };
            try {
                const win = await open("/artifacts.html?task=" + task);
                await run(win, steps.window);
                win.destroy();
                if (shot) {
                    // A fresh window, since the steps end on a removed task: design.md with its diagram, wide and narrow.
                    // Offscreen rendering paints every frame, as a shown window does; a hidden one skips frames and
                    // animation callbacks, so the diagram's frame would be caught half-fitted.
                    for (const [file, width, height] of [[shot, 1080, 820], [shot.replace(/\\.png$/i, "-narrow.png"), 600, 700]]) {
                        const w = await open("/artifacts.html?task=" + task + "#file=design.md", width, height, { offscreen: true });
                        await w.webContents.executeJavaScript(
                            "new Promise((r) => { const t = setInterval(() => { if (document.querySelector('.aw-md .mermaid.rendered svg')) { clearInterval(t); r(); } }, 20); setTimeout(() => { clearInterval(t); r(); }, 8000); })"
                        );
                        await wait(500);
                        require("node:fs").writeFileSync(file, (await w.webContents.capturePage()).toPNG());
                        w.destroy();
                    }
                }
                for (const [path, step] of [
                    ["/artifacts.html?task=" + task.toUpperCase() + "#file=design.md&edit=1", steps.edit],
                    ["/artifacts.html?task=" + task + "&fake=gone", steps.gone],
                    ["/artifacts.html?task=nope", steps.noTask],
                ]) {
                    const w = await open(path, 700, 500);
                    await run(w, step);
                    w.destroy();
                }
                const drawer = await open("/", 1440, 920);
                await run(drawer, steps.drawer);
                drawer.destroy();
            } catch (error) {
                out.failures.push(String((error && error.stack) || error));
            }
            process.stdout.write("RESULT " + JSON.stringify(out) + "\\n");
            app.exit(0);
        });
    `);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await new Promise((resolvePromise, reject) => {
        const child = spawn(electron, [main], { env, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        let errors = "";
        const timeout = setTimeout(() => { child.kill(); reject(new Error("Electron UI test timed out")); }, 120_000);
        child.stdout.on("data", (data) => (output += data));
        child.stderr.on("data", (data) => (errors += data));
        child.once("error", (error) => { clearTimeout(timeout); reject(error); });
        child.once("close", (code) => {
            clearTimeout(timeout);
            const line = output.split(/\r?\n/).find((l) => l.startsWith("RESULT "));
            if (!line) reject(new Error(`Electron exited ${code}: ${errors || output}`));
            else resolvePromise(JSON.parse(line.slice(7)));
        });
    });
    assert.deepEqual(result.failures, [], result.failures.join("\n"));
    console.log("artifacts-ui-harness: ok");
} finally {
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
}
