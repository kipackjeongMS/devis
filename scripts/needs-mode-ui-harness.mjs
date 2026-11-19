// The Workspace in a hidden Electron window, in both places what needs you can show: the
// Needs you panel (the default) and Devis's chat, switched back and forth as Save does.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");
const root = mkdtempSync(join(tmpdir(), "needs-mode-ui-"));
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
        for (let i = 0; i < 300; i++) {
            if (test()) return true;
            await new Promise((r) => setTimeout(r, 10));
        }
        failures.push("timed out: " + name);
        return false;
    };
    const at = new Date(Date.now() - 5 * 60_000).toISOString();
    const worker = {
        sessionId: "atlas-id", label: "atlas", taskId: "task", cwd: "C:\\Tasks\\Needs\\atlas",
        model: null, state: "turnDone", summary: "", autoApprove: false,
        createdAt: at, updatedAt: at, busy: false, partial: "", activity: "", worktrees: [],
        requests: [{ id: "q1", kind: "question", title: "Which branch should I use?", detail: "", choices: ["main", "dev"], allowFreeform: true, at }],
    };
    const task = {
        id: "task", title: "Needs mode", folder: "C:\\Tasks\\Needs",
        org: null, project: null, workItem: null, status: "open", createdAt: at, updatedAt: at,
        doneAt: null, workers: [worker], updates: { latest: null, today: [] }, prs: [],
    };
    const today = { tasks: [task], reviewed: [], folders: [], organizations: [], todos: [] };
    const lead = { sessionId: null, messages: [], pending: false, partial: "", activity: "", error: null, model: "", currentModel: null };
    window.fetch = async (path) => {
        const url = new URL(path, location.href);
        let data = {};
        switch (url.pathname) {
            case "/api/jarvis/today": data = today; break;
            case "/api/jarvis/lead": data = lead; break;
            case "/api/jarvis/lead/commands": data = { commands: [] }; break;
            case "/api/models": data = { models: [] }; break;
        }
        return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const { state } = await import("/state.js");
    const { showJarvis, hideJarvis } = await import("/jarvis.js");
    const view = document.getElementById("jarvisView");
    const panel = () => document.getElementById("rs-b-needs");
    const panelItems = () => panel()?.isConnected ? panel().querySelectorAll(".need").length : 0;
    const notices = () => view.querySelectorAll(".nt").length;
    const show = () => showJarvis({ openSettings() {} });

    state.config = { ...state.config, needsIn: undefined };
    show();
    await until("the Needs you panel lists the ask", () => panelItems() === 1);
    check("panel by default: the Needs you panel is placed", !!panel()?.isConnected);
    check("panel by default: no notices in Devis's chat", notices() === 0);
    check("panel by default: the ask's buttons are the panel's (no Ask Devis)", !view.querySelector('#rs-b-needs [data-act="need-ask"]'));

    hideJarvis();
    state.config = { ...state.config, needsIn: "chat" };
    show();
    await until("Devis's chat shows the ask", () => notices() === 1);
    check("chat: the Needs you panel is gone", !panel()?.isConnected);
    check("chat: the notice offers Ask Devis", !!view.querySelector('.nt [data-act="need-ask"]'));
    check("chat: no panel items left", panelItems() === 0);

    hideJarvis();
    state.config = { ...state.config, needsIn: "panel" };
    show();
    await until("the Needs you panel is back", () => panelItems() === 1);
    check("panel again: the notice left Devis's chat", notices() === 0);
    check("panel again: the panel sits in the Workspace", !!view.contains(panel()));
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
    console.log("needs-mode-ui-harness: ok");
} finally {
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
}
