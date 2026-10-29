// The actual task modal and its IDE actions in a hidden Electron window.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");
const root = mkdtempSync(join(tmpdir(), "worker-ide-ui-"));
const electron = (await import("electron")).default;
const server = createServer((req, res) => {
    if (req.url === "/") {
        res.setHeader("Content-Type", "text/html");
        return res.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body data-feature="jarvis"><div id="toast" role="status" hidden></div></body></html>');
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
    const until = async (test) => {
        for (let i = 0; i < 100; i++) {
            if (test()) return;
            await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("Timed out waiting for the task modal");
    };
    const at = new Date().toISOString();
    const makeWorker = (sessionId, label) => ({
        sessionId, label, taskId: "task", cwd: `C:\\Tasks\\IDE actions\\${label}`,
        model: null, state: "turnDone", summary: "", autoApprove: false,
        createdAt: at, updatedAt: at, busy: false, partial: "", activity: "", requests: [], worktrees: [],
    });
    const atlas = makeWorker("atlas-id", "atlas");
    const birch = makeWorker("birch-id", "birch");
    const task = {
        id: "task", title: "Worker workspace", folder: "C:\\Tasks\\IDE actions",
        org: null, project: null, workItem: null, status: "open", createdAt: at, updatedAt: at,
        doneAt: null, workers: [atlas, birch], updates: { latest: null, today: [] }, prs: [],
    };
    const calls = [];
    const unexpected = [];
    let failNext = false;
    let release = null;
    window.fetch = async (path, opts) => {
        const url = new URL(path, location.href);
        let data;
        let status = 200;
        switch (url.pathname) {
            case "/api/models": data = { models: [] }; break;
            case "/api/jarvis/statuses": data = { statuses: [], hasMore: false }; break;
            case "/api/jarvis/task-prs": data = { prs: [], syncedAt: null }; break;
            case "/api/jarvis/artifacts": data = { artifacts: [], dir: "C:\\Artifacts" }; break;
            case "/api/jarvis/workers/log": data = { messages: [] }; break;
            case "/api/jarvis/workers/commands": data = { commands: [] }; break;
            case "/api/jarvis/workers/live": data = { live: { ...atlas, turn: [] } }; break;
            case "/api/jarvis/workers/ide":
                calls.push(JSON.parse(opts.body));
                await new Promise((r) => { release = r; });
                status = failNext ? 409 : 200;
                data = failNext ? { error: "VSCode Insiders was not found." } : { ok: true };
                break;
            default: unexpected.push(url.pathname); data = {};
        }
        return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    };
    const { openTaskModal, closeTaskModal, updateTaskModal } = await import("/jarvisTask.js");
    const host = { task: () => task, todayAt: () => Date.now(), refresh: async () => {}, startWorker() {}, deleteTask() {}, openPr: async () => {} };
    const button = (ide) => document.querySelector(`[data-act="open-workspace"][data-ide="${ide}"]`);
    const trigger = () => document.querySelector('[popovertarget="tm-open-in"]');
    const panel = () => document.querySelector("#tm-open-in");
    const isOpen = () => panel()?.matches(":popover-open");
    const open = () => { if (!isOpen()) trigger().click(); };
    const changes = () => document.querySelector('[data-act="view-changes"]');
    const opened = [];
    window.open = (url, name) => { opened.push({ url, name }); return null; };
    openTaskModal(task.id, host);
    await until(() => button("vscode") && !document.querySelector(".chat-loading"));
    await new Promise(requestAnimationFrame);
    check("View changes comes first", changes() && changes().parentElement.firstElementChild === changes());
    check("View changes is labeled and enabled", changes().textContent.trim() === "View changes" && !changes().disabled);
    changes().click();
    check("View changes opens the worker's code window",
        opened.length === 1 && opened[0].url === "/code.html?worker=atlas-id" && opened[0].name === "code-atlas-id");
    check("View changes sends no API request", calls.length === 0);
    check("one Open in entry replaces the two labels", trigger().textContent.trim() === "Open in" && !isOpen());
    check("hidden options take no layout space", button("vscode").getClientRects().length === 0);
    open();
    check("Open in shows a sticky panel and focuses its first option", isOpen() && document.activeElement === button("vscode"));
    check("the IDE choices have no visible wording", button("vscode").textContent.trim() === "" && button("vscode-insiders").textContent.trim() === "");
    check("the icons have accessible names", button("vscode").getAttribute("aria-label") === "Open in VS Code" &&
        button("vscode-insiders").getAttribute("aria-label") === "Open in VS Code Insiders");
    await until(() => [...panel().querySelectorAll("img")].every((img) => img.complete && img.naturalWidth > 0));
    check("the IDEs use their own bundled icons", button("vscode").querySelector("img").getAttribute("src") === "./assets/ide-icons/vscode.png" &&
        button("vscode-insiders").querySelector("img").getAttribute("src") === "./assets/ide-icons/vscode-insiders.png");
    trigger().click();
    check("the entry button toggles the panel closed", !isOpen());
    open();
    button("vscode").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    check("Escape closes only the panel and returns focus", !isOpen() && document.activeElement === trigger() && !!document.querySelector(".tm-chat"));
    open();
    check("buttons are keyboard focusable", button("vscode").tabIndex === 0 && button("vscode-insiders").tabIndex === 0);
    check("button titles identify the workspace", button("vscode").title.includes(atlas.cwd));
    button("vscode").focus();
    button("vscode").click();
    await until(() => release);
    check("a launch disables its button", button("vscode").disabled);
    check("the stable action sends the selected worker ID", calls[0].sessionId === atlas.sessionId && calls[0].ide === "vscode");
    atlas.updatedAt = new Date(Date.now() + 1000).toISOString();
    const originalPanel = panel();
    updateTaskModal();
    check("polling keeps an in-flight launch disabled", button("vscode").disabled);
    check("polling preserves the open panel", isOpen() && panel() === originalPanel);
    release(); release = null;
    await until(() => !button("vscode").disabled);
    check("focus returns to the same IDE, not the other edition", document.activeElement === button("vscode"));
    check("a completed launch leaves the panel open", isOpen());
    check("success is shown", document.querySelector("#toast").textContent.includes("atlas's workspace in VSCode."));

    document.querySelector('[data-tab="birch-id"]').click();
    check("switching workers closes the previous worker's panel", !isOpen());
    check("switching workers updates the target", button("vscode-insiders").title.includes(birch.cwd));
    changes().click();
    check("View changes follows the selected worker", opened[1]?.url === "/code.html?worker=birch-id" && opened[1]?.name === "code-birch-id");
    failNext = true;
    open();
    button("vscode-insiders").click();
    await until(() => release);
    document.querySelector('[data-tab="atlas-id"]').click();
    check("a different worker does not inherit the pending launch", !button("vscode-insiders").disabled);
    document.querySelector('[data-tab="birch-id"]').click();
    open();
    check("switching back keeps the launch disabled", button("vscode-insiders").disabled);
    button("vscode-insiders").click();
    check("a pending launch cannot be sent twice", calls.length === 2);
    release(); release = null;
    await until(() => !button("vscode-insiders").disabled);
    check("Insiders sends the other worker ID", calls[1].sessionId === birch.sessionId && calls[1].ide === "vscode-insiders");
    check("launch errors reach the UI", document.querySelector("#toast").classList.contains("err") &&
        document.querySelector("#toast").textContent === "VSCode Insiders was not found.");
    check("a failed launch leaves the panel available", isOpen());
    failNext = false;

    atlas.busy = true;
    atlas.state = "working";
    document.querySelector('[data-tab="atlas-id"]').click();
    open();
    check("working workers can open both IDEs", !button("vscode").disabled && !button("vscode-insiders").disabled);
    button("vscode-insiders").click();
    await until(() => release);
    release(); release = null;
    await until(() => !button("vscode-insiders").disabled);
    check("opening an IDE while working sends only a launch request", calls[2].sessionId === atlas.sessionId && calls[2].ide === "vscode-insiders");
    for (const width of [320, 380, 768, 1024, 1440]) {
        const chat = document.querySelector(".tm-chat");
        chat.style.width = `${width}px`;
        chat.style.flex = "none";
        document.getAnimations().forEach((a) => { if (a instanceof CSSTransition) a.finish(); });
        const panelBox = panel().getBoundingClientRect();
        const triggerBox = trigger().getBoundingClientRect();
        check(`the panel fits the viewport with a ${width}px chat`, panelBox.left >= 0 && panelBox.right <= innerWidth && panelBox.top >= 0 && panelBox.bottom <= innerHeight);
        check(`the panel stays beside its trigger with a ${width}px chat`,
            Math.min(Math.abs(panelBox.left - triggerBox.right), Math.abs(triggerBox.left - panelBox.right)) <= 8 &&
            Math.abs(panelBox.top + panelBox.height / 2 - triggerBox.top - triggerBox.height / 2) <= 1);
        for (const ide of ["vscode", "vscode-insiders"]) {
            const rect = button(ide).getBoundingClientRect();
            check(`${ide} fits the panel with a ${width}px chat`, getComputedStyle(button(ide)).width === "44px" && rect.left >= panelBox.left && rect.right <= panelBox.right);
        }
        const rect = changes().getBoundingClientRect();
        const head = document.querySelector(".chat-head").getBoundingClientRect();
        check(`View changes fits a ${width}px chat`, rect.width > 0 && rect.left >= head.left && rect.right <= head.right + 1);
        chat.style.removeProperty("width");
        chat.style.removeProperty("flex");
    }
    task.status = "done";
    updateTaskModal();
    check("done tasks keep workspace access", !!button("vscode") && !button("vscode").disabled);
    check("done tasks keep View changes", !changes().disabled);
    task.folder = null;
    updateTaskModal();
    check("a task with no folder disables View changes", changes().disabled && /no folder/.test(changes().title));
    check("a task with no folder keeps the IDE buttons", !button("vscode").disabled);
    changes().click();
    check("a disabled View changes opens nothing", opened.length === 2);
    task.folder = "C:\\Tasks\\IDE actions";
    closeTaskModal();
    task.workers = [];
    openTaskModal(task.id, host);
    check("a task with no workers has no IDE actions", !button("vscode") && !button("vscode-insiders") && !changes());
    closeTaskModal();
    check("no unrelated API actions were triggered", unexpected.length === 0);
    task.workers = [atlas, birch];
    task.status = "open";
    openTaskModal(task.id, host);
    await new Promise(requestAnimationFrame);
    return { failures, calls };
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
            await win.loadURL(${JSON.stringify(url)});
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
                const key = async (keyCode) => {
                    win.webContents.sendInputEvent({ type: "keyDown", keyCode });
                    if (keyCode === "Return" || keyCode === "Space") win.webContents.sendInputEvent({ type: "char", keyCode: keyCode === "Return" ? "\\r" : " " });
                    win.webContents.sendInputEvent({ type: "keyUp", keyCode });
                    await new Promise((r) => setTimeout(r, 50));
                };
                await run('document.querySelector("[popovertarget=tm-open-in]").focus()');
                await key("Return");
                if (!await run('document.querySelector("#tm-open-in").matches(":popover-open")')) result.failures.push("Enter opens the panel");
                await key("Tab");
                if (!await run('document.activeElement.dataset.ide === "vscode-insiders"')) result.failures.push("Tab reaches Insiders");
                await key("Escape");
                if (!await run('!document.querySelector("#tm-open-in").matches(":popover-open") && document.activeElement.matches("[popovertarget=tm-open-in]")')) result.failures.push("native Escape returns to Open in");
                await key("Space");
                if (!await run('document.querySelector("#tm-open-in").matches(":popover-open")')) result.failures.push("Space opens the panel");
                const point = await run('(() => { const r = document.querySelector(".chat-log").getBoundingClientRect(); return {x: Math.round(r.left + 20), y: Math.round(r.top + 80)}; })()');
                win.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
                win.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
                await new Promise((r) => setTimeout(r, 50));
                if (!await run('!document.querySelector("#tm-open-in").matches(":popover-open")')) result.failures.push("a click outside dismisses the panel");
                ${process.env.ADO_PR_OPS_UI_SCREENSHOT ? `
                    await run('document.querySelector("[popovertarget=tm-open-in]").click()');
                    win.setContentSize(1439, 920);
                    await new Promise((r) => setTimeout(r, 150));
                    win.setContentSize(1440, 920);
                    await new Promise((r) => setTimeout(r, 250));
                    require("node:fs").writeFileSync(${JSON.stringify(process.env.ADO_PR_OPS_UI_SCREENSHOT)}, (await win.webContents.capturePage()).toPNG());
                ` : ""}
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
    console.log("worker-ide-ui-harness: ok");
} finally {
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
}
