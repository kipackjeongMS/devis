// The New task dialog's work item picker in a hidden Electron window: the real dialog, the real
// combobox, and a local stand-in for GET /api/jarvis/workitems that answers slow, fast, partly or not at all.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");
const root = mkdtempSync(join(tmpdir(), "workitem-picker-"));
const electron = (await import("electron")).default;

const item = (id, title, extra = {}) => ({
    org: "One", project: "AAPT-AppConfig", id, title, type: "User Story", state: "Active",
    url: `https://dev.azure.com/One/AAPT-AppConfig/_workitems/edit/${id}`, ...extra,
});
const assigned = [item(101, "Rotate the signing keys"), item(102, "Config snapshot export"), item(103, "Fix the replica sync bug", { type: "Bug" })];
/** Every lookup the page made, in order: its `q`. */
const asked = [];

function answer(q) {
    if (q === "") return { delay: 40, body: { scope: "assigned", items: assigned, errors: [], noProjects: false } };
    if (q.startsWith("slow")) return { delay: 700, body: { scope: "search", items: [item(201, "Slow answer one"), item(202, "Slow answer two")], errors: [], noProjects: false } };
    if (q.startsWith("boom")) return { delay: 20, status: 500, body: { error: "ADO is down" } };
    if (q.startsWith("partial")) {
        return { delay: 20, body: { scope: "search", items: [item(301, "Partial answer")], errors: [{ org: "Two", message: "TF400813: not authorized" }], noProjects: false } };
    }
    if (q.startsWith("nothing")) return { delay: 20, body: { scope: "search", items: [], errors: [], noProjects: false } };
    return { delay: 30, body: { scope: "search", items: [item(401, `Config ${q} first`), item(402, `Configuration ${q} second`, { org: "Two", project: "Other" })], errors: [], noProjects: false } };
}

const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.url === "/") {
        res.setHeader("Content-Type", "text/html");
        return res.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body></body></html>');
    }
    if (url.pathname === "/__asked") {
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify(asked));
    }
    if (url.pathname === "/api/jarvis/workitems") {
        const q = url.searchParams.get("q") ?? "";
        asked.push(q);
        const { delay, status = 200, body } = answer(q);
        const timer = setTimeout(() => {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(body));
        }, delay);
        req.on("close", () => clearTimeout(timer));
        return;
    }
    const file = resolve(web, "." + decodeURIComponent(url.pathname));
    if (!file.startsWith(web + sep)) {
        res.writeHead(403).end();
        return;
    }
    try {
        res.setHeader("Content-Type", { ".js": "text/javascript", ".css": "text/css", ".png": "image/png" }[extname(file)] || "application/octet-stream");
        res.end(readFileSync(file));
    } catch {
        res.writeHead(404).end();
    }
});

async function inPage() {
    const failures = [];
    const check = (name, ok) => { if (!ok) failures.push(name); };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (name, test, ms = 3000) => {
        for (let waited = 0; waited < ms; waited += 10) {
            if (test()) return true;
            await sleep(10);
        }
        failures.push(`${name} (${diag()})`);
        return false;
    };
    let diag = () => "";
    const errors = [];
    window.addEventListener("error", (e) => errors.push(e.message));
    window.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason?.stack || e.reason)));

    const { openActionDialog } = await import("/prActions.js");
    const { attachWorkItemPicker } = await import("/workItemPicker.js");
    const asked = async () => (await fetch("/__asked")).json();

    const picks = [];
    let confirms = 0;
    let closes = 0;
    let picker = null;
    const opener = document.createElement("button");
    opener.textContent = "New task";
    document.body.append(opener);
    const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
    // The dialog focuses its first field on the next frame; New task then focuses the work item field, as here.
    const openDialog = async () => {
        opener.focus();
        const dialog = openActionDialog({
            title: "New task",
            loc: "Today",
            body: `<div class="jv-fields">
                <label class="rp-label" for="jt-ref">Work item</label>
                <div class="wi-anchor"><input id="jt-ref" class="ask-q jv-field" spellcheck="false" autocomplete="off"></div>
                <label class="rp-label" for="jt-desc">Description</label>
                <textarea id="jt-desc" class="ask-q jt-desc" rows="4"></textarea>
            </div>`,
            confirmLabel: "Add task",
            onConfirm: async () => { confirms++; throw new Error("kept open"); },
            onClose: () => { closes++; picker?.destroy(); },
        });
        const input = dialog.querySelector("#jt-ref");
        picker = attachWorkItemPicker({ input, multiOrg: true, onPick: (it) => picks.push(it) });
        const popup = dialog.querySelector(".wi-popup");
        await nextFrame();
        return { dialog, input, popup, list: popup.querySelector("[role=listbox]"), head: popup.querySelector(".chat-pop-group"), msg: popup.querySelector(".chat-pop-msg"), live: dialog.querySelector("[aria-live]") };
    };
    const key = (target, name, init = {}) => {
        const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, composed: true, ...init });
        target.dispatchEvent(event);
        return event;
    };
    // A hidden window never has the document's focus, and Chromium sends no focus events then: send the field's ourselves.
    const focusField = (input) => {
        input.focus();
        if (!document.hasFocus()) input.dispatchEvent(new FocusEvent("focus"));
    };
    const type = (input, value) => {
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const rows = (d) => [...d.list.querySelectorAll("[role=option]")];
    const titles = (d) => rows(d).map((r) => r.querySelector(".wi-title").textContent);
    const expanded = (d) => d.input.getAttribute("aria-expanded") === "true";
    const activeRow = (d) => d.list.querySelector('[aria-selected="true"]');

    // ARIA wiring.
    let d = await openDialog();
    diag = () => `expanded ${d.input.getAttribute("aria-expanded")}, rows ${rows(d).length}, head "${d.head.textContent}", msg "${d.msg.textContent}" ${d.msg.title}, focus ${document.activeElement?.id || document.activeElement?.tagName}, hasFocus ${document.hasFocus()}`;
    check("the field is a combobox", d.input.getAttribute("role") === "combobox" && d.input.getAttribute("aria-autocomplete") === "list");
    check("it controls the list", d.input.getAttribute("aria-controls") === d.list.id && d.list.getAttribute("role") === "listbox");
    check("it starts closed", !expanded(d) && d.popup.hidden);
    check("the list lives inside the modal dialog", d.dialog.contains(d.popup) && d.dialog.contains(d.live));

    // Focus on an empty field: what's assigned to you.
    focusField(d.input);
    await until("focus lists what's assigned to you", () => rows(d).length === 3);
    check("the list is open", expanded(d) && !d.popup.hidden);
    check("headed Assigned to you", d.head.textContent === "Assigned to you" && !d.head.hidden);
    check("the first row is active", activeRow(d) === rows(d)[0] && d.input.getAttribute("aria-activedescendant") === rows(d)[0].id);
    check("each row says its type, number, state, project and org", rows(d)[2]?.querySelector(".wi-meta").textContent === "Bug #103 · Active · AAPT-AppConfig · One");
    check("the count is announced", /^3 open work items assigned to you\./.test(d.live.textContent));
    check("nothing is marked in the assigned list", !d.list.querySelector("mark"));
    const box = d.popup.getBoundingClientRect();
    const frame = d.dialog.getBoundingClientRect();
    check(`the list sits under the field, inside the dialog (${Math.round(box.top)}..${Math.round(box.bottom)} in ${Math.round(frame.top)}..${Math.round(frame.bottom)})`,
        box.top >= d.input.getBoundingClientRect().bottom - 1 && box.left >= frame.left - 1 && box.right <= frame.right + 1 && box.bottom <= window.innerHeight);

    // Arrows move the active row and wrap.
    key(d.input, "ArrowDown");
    check("Down moves to the next row", activeRow(d) === rows(d)[1] && d.input.getAttribute("aria-activedescendant") === rows(d)[1].id);
    check("the active row is announced", d.live.textContent === "Config snapshot export, User Story #102 · Active · AAPT-AppConfig · One. 2 of 3.");
    key(d.input, "ArrowUp");
    key(d.input, "ArrowUp");
    check("Up from the first wraps to the last", activeRow(d) === rows(d)[2]);

    // Escape closes just the list; the next one closes the dialog.
    let esc = key(d.input, "Escape");
    check("Escape on an open list closes the list", !expanded(d) && d.popup.hidden && esc.defaultPrevented);
    check("and leaves the dialog open", d.dialog.isConnected);
    check("and drops the active row", !d.input.hasAttribute("aria-activedescendant"));
    key(d.input, "ArrowDown", { altKey: true });
    await until("Alt+Down opens it again", () => expanded(d) && rows(d).length === 3);
    key(d.input, "ArrowUp", { altKey: true });
    check("Alt+Up closes it", !expanded(d));
    d.input.click();
    await until("a click in the field opens it again", () => expanded(d));
    key(d.input, "Escape");
    key(d.input, "Escape");
    check("Escape on a closed list closes the dialog", !d.dialog.isConnected && closes === 1);
    check("which takes the picker's list with it", !document.querySelector(".wi-popup"));
    check("and gives focus back", document.activeElement === opener);

    // A second dialog: the assigned list comes from the minute-long cache.
    d = await openDialog();
    focusField(d.input);
    await until("a second dialog lists them at once", () => rows(d).length === 3, 200);
    check("from the cache, without asking again", (await asked()).filter((q) => q === "").length === 1);

    // Typing searches titles, after a pause, once.
    for (const v of ["co", "con", "conf", "confi", "config"]) {
        type(d.input, v);
        await sleep(40);
    }
    check("while it waits the old rows stay, dimmed and not active", d.list.getAttribute("aria-busy") === "true" && !activeRow(d) && !d.input.hasAttribute("aria-activedescendant"));
    check("headed Searching…", d.head.textContent === "Searching…");
    await until("the search answers", () => titles(d)[0] === "Config config first");
    check("headed Best matches", d.head.textContent === "Best matches" && d.list.getAttribute("aria-busy") === "false");
    let searches = (await asked()).filter((q) => q.startsWith("co"));
    check(`a burst of typing makes one request (${JSON.stringify(searches)})`, searches.length === 1 && searches[0] === "config");
    check("the typed word is marked in the titles", [...d.list.querySelectorAll("mark")].map((m) => m.textContent).join(",") === "Config,config,Config,config");
    check("rows from another org name it", rows(d)[1].querySelector(".wi-meta").textContent.endsWith(" · Other · Two"));
    check("the count is announced", /^2 matches\. Config config first/.test(d.live.textContent));

    // Enter while a lookup is in flight takes nothing; once it answers, Enter takes the active row.
    type(d.input, "slow one");
    await sleep(320);
    check("rows are busy while the slow search runs", d.list.getAttribute("aria-busy") === "true" && rows(d).length === 2);
    let enter = key(d.input, "Enter");
    check("Enter while busy picks nothing", picks.length === 0 && !enter.defaultPrevented && expanded(d));
    await until("the slow search answers", () => titles(d)[0] === "Slow answer one", 3000);
    key(d.input, "ArrowDown");
    enter = key(d.input, "Enter");
    check("Enter picks the active row", picks.length === 1 && picks[0].id === 202 && enter.defaultPrevented);
    check("a pick closes the list", !expanded(d) && d.popup.hidden);
    check("a pick is announced", d.live.textContent === "Chose User Story #202, Slow answer two.");
    check("and doesn't confirm the dialog", confirms === 0 && d.dialog.isConnected);

    // The latest typing wins over a slower earlier search.
    type(d.input, "slow two");
    await sleep(320);
    type(d.input, "fast");
    await until("the later search answers", () => titles(d)[0] === "Config fast first");
    await sleep(800);
    check("and the earlier, slower one never paints over it", titles(d)[0] === "Config fast first");

    // The search cache: the same words again answer at once.
    const before = (await asked()).length;
    type(d.input, "config");
    await until("a repeated search answers from the cache", () => titles(d)[0] === "Config config first", 200);
    check("without asking again", (await asked()).length === before);

    // A number or a link isn't searched: the list closes.
    type(d.input, "12345");
    check("a number closes the list", !expanded(d));
    type(d.input, "https://dev.azure.com/One/AAPT-AppConfig/_workitems/edit/12345");
    check("so does a link", !expanded(d));
    // One letter isn't enough to search.
    type(d.input, "a");
    check("one letter asks for more", expanded(d) && !d.msg.hidden && d.msg.textContent === "Keep typing to search titles." && !rows(d).length);

    // Failures: the whole lookup, or one org of several.
    type(d.input, "boom");
    await until("a failed lookup says so", () => d.msg.classList.contains("err") && !d.msg.hidden);
    check("and points at the number or link", d.msg.textContent === "Couldn't look up work items. Enter the work item's number or link instead." && d.msg.title === "ADO is down");
    check("with no rows", !rows(d).length && d.head.hidden);
    type(d.input, "partial");
    await until("a partial answer shows what came back", () => titles(d)[0] === "Partial answer");
    check("and names the org that failed", d.msg.textContent === "Couldn't search Two; these are from the rest." && d.msg.title === "Two: TF400813: not authorized");
    const repeats = (await asked()).filter((q) => q === "partial").length;
    type(d.input, "partia");
    type(d.input, "partial");
    await sleep(400);
    check("a partial answer isn't kept, so the same words ask again", (await asked()).filter((q) => q === "partial").length === repeats + 1);
    type(d.input, "nothing here");
    await until("no matches says so", () => d.msg.textContent === "No open work items match. Try other words, or enter a number or link.");

    // Tab and blur put the list away.
    type(d.input, "config");
    await until("the list is back", () => rows(d).length === 2);
    key(d.input, "Tab");
    check("Tab closes the list", !expanded(d));

    // Closed with Cancel while a search is in flight: the picker goes with it, and the answer paints nowhere.
    type(d.input, "slow three");
    await sleep(320);
    d.dialog.querySelector(".pa-cancel").click();
    check("Cancel closes the dialog and its picker", !d.dialog.isConnected && closes === 2 && !d.popup.isConnected);
    await sleep(900);

    // A field taken out some other way, mid-search: the answer finds it gone and the picker lets go.
    const wrap = document.createElement("div");
    wrap.className = "wi-anchor";
    wrap.innerHTML = '<input id="loose" class="ask-q">';
    document.body.append(wrap);
    const loose = wrap.querySelector("input");
    attachWorkItemPicker({ input: loose, multiOrg: false, onPick: (it) => picks.push(it) });
    focusField(loose);
    type(loose, "slow four");
    await sleep(320);
    wrap.remove();
    await sleep(900);
    check("a field removed mid-search drops its list", !wrap.querySelector(".wi-popup") && !wrap.querySelector("[aria-live]"));

    // Wiring for the main process's real mouse and keys.
    d = await openDialog();
    focusField(d.input);
    await until("the third dialog lists them", () => rows(d).length === 3, 500);
    window.__t = {
        d, picks, rows, expanded, errors,
        get confirms() { return confirms; },
        get closes() { return closes; },
        // For a look at it: a dialog with a search's rows open and the second one active.
        async shoot() {
            const s = await openDialog();
            focusField(s.input);
            type(s.input, "config");
            await until("the screenshot's search answers", () => rows(s).length === 2);
            key(s.input, "ArrowDown");
        },
    };
    check(`no errors (${errors.join("; ")})`, errors.length === 0);
    return { failures };
}

try {
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const main = join(root, "main.cjs");
    writeFileSync(main, `
        const { app, BrowserWindow } = require("electron");
        app.setPath("userData", ${JSON.stringify(join(root, "profile"))});
        app.whenReady().then(async () => {
            const win = new BrowserWindow({ show: false, width: 900, height: 760, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
            await win.loadURL(${JSON.stringify(url)});
            win.webContents.focus();
            let result = { failures: [] };
            try {
                result = await win.webContents.executeJavaScript(${JSON.stringify(`(${inPage.toString()})().catch((error) => ({ failures: [error.stack] }))`)});
                if (result.failures.length) {
                    process.stdout.write("RESULT " + JSON.stringify(result) + "\\n");
                    return app.exit(0);
                }
                const run = async (code) => {
                    try { return await win.webContents.executeJavaScript(code); }
                    catch (error) { throw new Error(code + ": " + error.message); }
                };
                const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
                const until = async (name, code) => {
                    for (let i = 0; i < 80; i++) {
                        if (await run(code)) return true;
                        await sleep(25);
                    }
                    result.failures.push(name);
                    return false;
                };
                const press = (keyCode, modifiers = []) => {
                    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
                    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
                };

                // A real click on a row picks it, and the field keeps focus through the click.
                const center = 'JSON.parse(JSON.stringify((() => { const r = __t.rows(__t.d)[1].getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()))';
                const point = await run(center);
                win.webContents.sendInputEvent({ type: "mouseMove", ...point });
                win.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
                win.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
                await until("a click on a row picks it", "__t.picks.length === 2 && __t.picks[1].id === 102");
                if (!await run("document.activeElement === __t.d.input")) result.failures.push("the field keeps focus through a row click");
                if (await run("__t.expanded(__t.d)")) result.failures.push("a clicked pick closes the list");

                // Real keys: Down opens, Down moves, Enter picks without confirming the dialog.
                press("Down");
                await until("Down on a closed field opens the list", "__t.expanded(__t.d) && __t.rows(__t.d).length === 3");
                press("Down");
                press("Return");
                await until("Enter picks the row Down chose", "__t.picks.length === 3 && __t.picks[2].id === 102");
                if (await run("__t.confirms !== 0 || !__t.d.dialog.isConnected")) result.failures.push("Enter on a row leaves the dialog unconfirmed and open");

                // Real Escape: the list first, then the dialog.
                press("Down");
                await until("the list opens again", "__t.expanded(__t.d)");
                press("Escape");
                await until("a real Escape closes just the list", "!__t.expanded(__t.d)");
                if (!await run("__t.d.dialog.isConnected")) result.failures.push("a real Escape on the list leaves the dialog open");
                press("Escape");
                await until("the next Escape closes the dialog", "!__t.d.dialog.isConnected && __t.closes === 3");

                ${process.env.ADO_PR_OPS_UI_SCREENSHOT ? `
                    await run("__t.shoot()");
                    await sleep(500);
                    require("node:fs").writeFileSync(${JSON.stringify(process.env.ADO_PR_OPS_UI_SCREENSHOT)}, (await win.webContents.capturePage()).toPNG());
                ` : ""}
                const errors = await run("__t.errors.join('; ')");
                if (errors) result.failures.push("page errors: " + errors);
                process.stdout.write("RESULT " + JSON.stringify(result) + "\\n");
            } catch (error) {
                result.failures.push(String(error.message || error));
                process.stdout.write("RESULT " + JSON.stringify(result) + "\\n");
            }
            app.exit(0);
        });
    `);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await new Promise((resolve, reject) => {
        const child = spawn(electron, [main], { env, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        let errors = "";
        const timeout = setTimeout(() => { child.kill(); reject(new Error("Electron UI test timed out")); }, 60_000);
        child.stdout.on("data", (data) => output += data);
        child.stderr.on("data", (data) => errors += data);
        child.once("error", (error) => { clearTimeout(timeout); reject(error); });
        child.once("close", (code) => {
            clearTimeout(timeout);
            const line = output.split(/\r?\n/).find((l) => l.startsWith("RESULT "));
            if (!line) reject(new Error(`Electron exited ${code}: ${errors || output}`));
            else resolve(JSON.parse(line.slice(7)));
        });
    });
    assert.deepEqual(result.failures, [], result.failures.join("\n"));
    console.log("workitem-picker-ui-harness: ok");
} finally {
    await new Promise((r) => server.close(r));
    // Electron's helpers can hold the profile for a moment after it exits: retry, and never let cleanup hide the result.
    try { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch {}
}
