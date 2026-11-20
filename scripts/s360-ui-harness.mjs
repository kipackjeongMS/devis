// The Workspace's S360 parts in a hidden Electron window, against a fake API: the rail lists the
// open items, Needs you shows the ones that need the user, the drawer lists them by SLA with the
// picked one's detail, and Dismiss, To-do, Add to to-dos (the detail's button and a row's right-click),
// a to-do's chip and turning S360 off do what they say.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");
const root = mkdtempSync(join(tmpdir(), "s360-ui-"));
const electron = (await import("electron")).default;
const server = createServer((req, res) => {
    if (req.url === "/") {
        res.setHeader("Content-Type", "text/html");
        return res.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body data-page="queue" data-feature="jarvis"><section id="jarvisView" class="jarvis-view" aria-label="Workspace" tabindex="-1"></section><div id="toast" role="status" hidden></div></body></html>');
    }
    const file = resolve(web, "." + decodeURIComponent(new URL(req.url, "http://localhost").pathname));
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
    const until = async (name, test) => {
        for (let i = 0; i < 400; i++) {
            if (test()) return true;
            await new Promise((r) => setTimeout(r, 10));
        }
        failures.push("timed out: " + name);
        return false;
    };
    const now = Date.now();
    const iso = (days) => new Date(now + days * 86_400_000).toISOString();
    const base = {
        kpiId: "kpi-1", itemId: "", targetType: "Service", targetId: "svc-1", title: "", sla: "InSla", due: "", eta: "",
        status: "", statusBy: "", assignedTo: "kipackjeong", owner: "kipackjeong", service: "Azure App Configuration",
        kind: "Action", severity: "", url: "", adoUrl: "", link: "", published: "", updated: "", roles: ["assigned"],
        firstSeen: iso(-3), lastSeen: iso(0), resolvedAt: null, need: false, dismissed: false,
    };
    const late = {
        ...base, key: "aaaaaaaaaaaaaaaa", itemId: "i-late", title: "Rotate the storage keys", sla: "OutOfSla", due: iso(-2),
        status: "Waiting on a change", statusBy: "dana", url: "https://aka.ms/s360-guide", adoUrl: "https://dev.azure.com/org/proj/_workitems/edit/7",
        link: "https://s360.example/late", roles: ["assigned", "owner"], need: true,
    };
    const soon = { ...base, key: "dddddddddddddddd", itemId: "i-soon", title: "Raise the TLS floor", sla: "ApproachingSla", due: iso(5), link: "https://s360.example/soon", need: true };
    const fine = { ...base, key: "bbbbbbbbbbbbbbbb", itemId: "i-fine", title: "Use Default Deny for pipeline", due: iso(40), link: "https://s360.example/fine", roles: ["owner"], assignedTo: "dana" };
    const closed = { ...base, key: "cccccccccccccccc", itemId: "i-closed", title: "Renew the old certificate", resolvedAt: iso(-1), link: "https://s360.example/closed" };
    const items = [late, soon, fine, closed];
    const status = {
        enabled: true, scanning: false, agency: true, alias: "kipackjeong",
        last: { at: iso(0), ok: true, calls: 6, items: 3, found: 0, resolved: 1, throttled: false }, readAt: iso(0), nextAt: null,
    };
    let version = 1;
    const needOf = (item, hoursAgo) => ({ key: `need:s360:${item.key}`, at: new Date(now - hoursAgo * 3_600_000).toISOString(), item });
    let needs = [needOf(late, 2), needOf(soon, 1)];
    const digest = () => ({
        version: String(version), enabled: status.enabled,
        open: status.enabled ? items.filter((i) => !i.resolvedAt).length : 0, soon: status.enabled ? 1 : 0, late: status.enabled ? 1 : 0,
    });
    const todos = [];
    const posts = [];
    const today = () => ({ tasks: [], reviewed: [], folders: [], organizations: [], todos, s360: { ...digest(), needs: status.enabled ? needs : [] } });
    const lead = { sessionId: null, messages: [], pending: false, partial: "", activity: "", error: null, model: "", currentModel: null };
    window.fetch = async (path, init) => {
        const url = new URL(path, location.href);
        const body = init?.body ? JSON.parse(init.body) : null;
        if (init?.method === "POST") posts.push([url.pathname, body]);
        let data = {};
        switch (url.pathname) {
            case "/api/jarvis/today": data = today(); break;
            case "/api/jarvis/lead": data = lead; break;
            case "/api/jarvis/lead/commands": data = { commands: [] }; break;
            case "/api/models": data = { models: [] }; break;
            case "/api/jarvis/s360": data = { items: status.enabled ? items : [], digest: digest(), status }; break;
            case "/api/jarvis/s360/needs/dismiss": {
                const item = needs.find((n) => n.key === body.key)?.item;
                if (item) Object.assign(item, { need: false, dismissed: true });
                needs = needs.filter((n) => n.key !== body.key);
                version++;
                data = { needs, digest: digest() };
                break;
            }
            case "/api/jarvis/todos":
                if (init?.method === "POST") {
                    const at = new Date().toISOString();
                    todos.push({ id: todos.length + 1, text: body.text, done: false, author: "you", createdAt: at, updatedAt: at, doneAt: null, source: body.source, doneNote: null, parentId: null, due: null, priority: 0, taskId: null });
                }
                data = { todos };
                break;
        }
        return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const { state } = await import("/state.js");
    const { showJarvis, hideJarvis } = await import("/jarvis.js");
    const view = document.getElementById("jarvisView");
    const $ = (sel) => view.querySelector(sel);
    const $$ = (sel) => [...view.querySelectorAll(sel)];
    const text = (sel) => $(sel)?.textContent.replace(/\s+/g, " ").trim() || "";
    const click = (sel) => {
        const node = $(sel);
        check("present to click: " + sel, !!node);
        node?.click();
    };
    const drawer = () => $(".jv-drawer");
    const detail = () => $(".jv-dbody .ld-detail article.ld-doc");
    const listItem = (key) => $(`.jv-dbody .ld-list .ld-item[data-s360="${key}"]`);
    const panelNeed = (key) => $(`#rs-b-needs .need-s360[data-s360-need="need:s360:${key}"]`);

    state.config = { ...state.config, needsIn: undefined };
    showJarvis({ openSettings() {} });

    // Needs you: the late one and the one close to its SLA, each with its way to S360.
    await until("Needs you lists both S360 items", () => $$("#rs-b-needs .need-s360").length === 2);
    const lateNeed = panelNeed(late.key);
    check("the late need names the item", lateNeed?.querySelector(".need-task")?.textContent.trim() === late.title);
    check("the late need says it's out of SLA", /Out of SLA/.test(lateNeed?.textContent || ""));
    check("the late need says how it's the user's", /Assigned to you, and you're the action owner/.test(lateNeed?.textContent || ""));
    check("the late need opens the item in S360", lateNeed?.querySelector('[data-act="need-open"]')?.getAttribute("href") === late.link);
    check("the late need offers To-do and Dismiss", !!lateNeed?.querySelector('[data-act="need-todo"]') && !!lateNeed?.querySelector('[data-act="need-dismiss"]'));
    check("the soon need says it's approaching", /Approaching SLA/.test(panelNeed(soon.key)?.textContent || ""));

    // The rail: the open ones only, with their count, and the drawer behind them.
    await until("the S360 rail lists the open items", () => $$("#rs-b-s360 .rr2").length === 3);
    check("the rail counts the open items", text('[data-rs="s360"] .rs-n') === "3");
    check("the rail leaves the closed one out", !$(`#rs-b-s360 .rr2[data-s360="${closed.key}"]`));
    check("the rail marks the late one Needs you", /Out of SLA · Needs you/.test(text(`#rs-b-s360 .rr2[data-s360="${late.key}"]`)));
    check("the rail offers the rest", !!$('#rs-b-s360 .rs-more[data-act="s360-open"]'));

    // A need's title opens the drawer on its item.
    lateNeed?.querySelector('[data-act="need-s360"]')?.click();
    await until("the drawer opens on S360", () => drawer()?.dataset.kind === "s360" && !!detail());
    check("the drawer is titled S360", text("#jv-dtitle") === "S360");
    check("the drawer's sub line counts what's open", text(".jv-dmeta").startsWith("3 open (1 out of SLA, 1 approaching)"));
    check("the drawer picks the need's item", listItem(late.key)?.classList.contains("sel") && detail()?.dataset.s360 === late.key);
    check("the list groups by SLA, closed folded", $$(".jv-dbody [data-act='s360-group']").map((b) => b.dataset.group).join() === "late,soon,open,closed" && $$(".jv-dbody .ld-item").length === 3);
    check("the detail says why it needs the user", /past its SLA/.test(text(".jv-dbody .ld-needs")));
    check("the detail opens it in S360", detail()?.querySelector('[data-act="s360-portal"]')?.getAttribute("href") === late.link);
    check("the detail links the guidance and the work item", detail()?.querySelector('[data-act="s360-guide"]')?.getAttribute("href") === late.url && detail()?.querySelector('[data-act="s360-ado"]')?.getAttribute("href") === late.adoUrl);
    check("the detail shows the status and who set it", $$(".jv-dbody .ld-sh").some((h) => h.textContent === "Status from dana") && $$(".jv-dbody .ld-sum").some((p) => p.textContent === "Waiting on a change"));
    check("the detail says it's read once a day", text(".jv-dbody .ld-foot") === "From S360, read once a day.");

    // The closed group opens; a closed item has nothing to act on.
    click('.jv-dbody [data-act="s360-group"][data-group="closed"]');
    await until("the closed group opens", () => $$(".jv-dbody .ld-item").length === 4);
    listItem(closed.key)?.click();
    await until("the closed item shows", () => detail()?.dataset.s360 === closed.key);
    check("a closed item says so", /Closed/.test(text(".jv-dbody .ld-meta")) && !$(".jv-dbody .ld-needs") && !$('.jv-dbody [data-act="s360-dismiss"]'));

    // An item the user owns but someone else has.
    listItem(fine.key)?.click();
    await until("the owned item shows", () => detail()?.dataset.s360 === fine.key);
    check("the owned item says whose it is", /You're the action owner \(assigned to dana\)/.test(text(".jv-dbody .ld-kv")));
    check("an item in SLA has no Dismiss", !$('.jv-dbody [data-act="s360-dismiss"]'));

    // Dismiss from the drawer: it leaves Needs you, and the list says it's dismissed.
    listItem(late.key)?.click();
    await until("the late item shows again", () => detail()?.dataset.s360 === late.key);
    click('.jv-dbody [data-act="s360-dismiss"]');
    await until("the late need leaves Needs you", () => !panelNeed(late.key) && !!panelNeed(soon.key));
    check("Dismiss posts the need's key", posts.some(([p, b]) => p === "/api/jarvis/s360/needs/dismiss" && b?.key === `need:s360:${late.key}`));
    await until("the list says it's dismissed", () => /Dismissed/.test(listItem(late.key)?.textContent || ""));
    check("a dismissed item has no Dismiss", !$('.jv-dbody [data-act="s360-dismiss"]') && !$(".jv-dbody .ld-needs"));

    // To-do from Needs you: it leaves Needs you, the to-do links to S360, and the item says so.
    click(`#rs-b-needs .need-s360[data-s360-need="need:s360:${soon.key}"] [data-act="need-todo"]`);
    await until("the soon need leaves Needs you", () => !$("#rs-b-needs .need-s360"));
    const made = posts.find(([p]) => p === "/api/jarvis/todos")?.[1];
    check("the to-do remembers the need", made?.source?.key === `need:s360:${soon.key}` && made?.source?.link === soon.link);
    check("the to-do says what to do", /^Resolve the S360 item: Raise the TLS floor \(approaching its SLA, due /.test(made?.text || ""));
    await until("the to-do's chip points at the item", () => $("#rs-b-todos .todo-src")?.dataset.srcS360 === soon.key && $("#rs-b-todos .todo-src")?.dataset.act === "todo-open-s360");
    await until("the rail says it's in the to-dos", () => /In your to-dos/.test(text(`#rs-b-s360 .rr2[data-s360="${soon.key}"]`)));
    listItem(soon.key)?.click();
    await until("the soon item shows", () => detail()?.dataset.s360 === soon.key);
    check("the detail says it's in the to-dos", /It's in your to-dos/.test(text(".jv-dbody .ld-needs")) && !$('.jv-dbody [data-act="s360-dismiss"]'));
    check("an item in the to-dos has no Add to to-dos", !$('.jv-dbody [data-act="s360-todo"]'));

    // Add to to-dos from the detail: any open item, not only one under Needs you.
    const todoPosts = () => posts.filter(([p]) => p === "/api/jarvis/todos").map(([, b]) => b);
    listItem(fine.key)?.click();
    await until("the owned item shows again", () => detail()?.dataset.s360 === fine.key);
    click('.jv-dbody [data-act="s360-todo"]');
    await until("the detail's to-do is made", () => todoPosts().length === 2);
    const fromDetail = todoPosts()[1];
    check("the detail's to-do is the item's", fromDetail?.source?.key === `need:s360:${fine.key}` && fromDetail?.source?.link === fine.link && fromDetail?.source?.who === "S360");
    check("the detail's to-do says what to do", fromDetail?.text === `Resolve the S360 item: ${fine.title} (due ${new Date(Date.parse(fine.due)).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })})`);
    await until("the detail says it's in the to-dos now", () => /It's in your to-dos/.test(text(".jv-dbody .ld-needs")) && !$('.jv-dbody [data-act="s360-todo"]'));
    listItem(closed.key)?.click();
    await until("the closed item shows again", () => detail()?.dataset.s360 === closed.key);
    check("a closed item has no Add to to-dos", !$('.jv-dbody [data-act="s360-todo"]'));

    // Right-click an S360 row: its menu, with Add to to-dos while it's not in them.
    const menuOf = (sel) => {
        const row = $(sel);
        check("present to right-click: " + sel, !!row);
        row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
        const menu = document.querySelector(".ctx-menu");
        return menu ? [...menu.querySelectorAll(".detail-menu-item")] : [];
    };
    const labelOf = (b) => b.querySelector(".detail-menu-label")?.textContent || "";
    let entries = menuOf(`#rs-b-s360 .rr2[data-s360="${late.key}"]`);
    check("the late row's menu", entries.map(labelOf).join() === "Add to to-dos,Open in S360,Guidance,Work item");
    entries.find((b) => labelOf(b) === "Add to to-dos")?.click();
    check("choosing closes the menu", !document.querySelector(".ctx-menu"));
    await until("the row's to-do is made", () => todoPosts().length === 3);
    check("the row's to-do is the item's", todoPosts()[2]?.source?.key === `need:s360:${late.key}`);
    await until("the rail says the late one is in the to-dos", () => /In your to-dos/.test(text(`#rs-b-s360 .rr2[data-s360="${late.key}"]`)));
    entries = menuOf(`.jv-dbody .ld-list .ld-item[data-s360="${soon.key}"]`);
    const inTodos = entries.find((b) => labelOf(b) === "In your to-dos");
    check("a row in the to-dos says so, and can't be added again", !!inTodos && inTodos.getAttribute("aria-disabled") === "true" && !entries.some((b) => labelOf(b) === "Add to to-dos"));
    inTodos?.click();
    check("the disabled entry does nothing", todoPosts().length === 3 && !!document.querySelector(".ctx-menu"));
    entries = menuOf(`.jv-dbody .ld-list .ld-item[data-s360="${closed.key}"]`);
    check("a closed row offers only where it lives", entries.map(labelOf).join() === "Open in S360");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    check("Esc closes the menu", !document.querySelector(".ctx-menu"));

    // A to-do's chip shows its item in the drawer.
    click(`#rs-b-todos .todo-src[data-src-s360="${fine.key}"]`);
    await until("the chip shows its item", () => detail()?.dataset.s360 === fine.key && listItem(fine.key)?.classList.contains("sel"));

    // Off: the rail says so, nothing waits under Needs you, and nothing's counted.
    hideJarvis();
    status.enabled = false;
    version++;
    showJarvis({ openSettings() {} });
    await until("the rail says S360 is off", () => text("#rs-b-s360") === "S360 is off.");
    check("off: no count", text('[data-rs="s360"] .rs-n') === "");
    check("off: nothing under Needs you", !$("#rs-b-needs .need-s360"));
    hideJarvis();
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
            const win = new BrowserWindow({ show: false, width: 1440, height: 920, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
            const errors = [];
            win.webContents.on("console-message", (e) => { if (e.level === "error") errors.push(e.message); });
            await win.loadURL(${JSON.stringify(url)});
            let result = { failures: [] };
            try {
                result = await win.webContents.executeJavaScript(${JSON.stringify(`(${inPage.toString()})().catch((error) => ({ failures: [error.stack] }))`)});
            } catch (error) {
                result.failures.push(String(error.message || error));
            }
            for (const e of errors) result.failures.push("console error: " + e);
            process.stdout.write("RESULT " + JSON.stringify(result) + "\\n");
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
    console.log("s360-ui-harness: ok");
} finally {
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
}
