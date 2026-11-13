// The chat log following its conversation, and the jump-to-latest button, in a hidden Electron window.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");
const root = mkdtempSync(join(tmpdir(), "chat-follow-"));
const electron = (await import("electron")).default;
const server = createServer((req, res) => {
    if (req.url === "/") {
        res.setHeader("Content-Type", "text/html");
        return res.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body></body></html>');
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
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (name, test) => {
        for (let i = 0; i < 150; i++) {
            if (test()) return true;
            await sleep(10);
        }
        const log = document.querySelector(".chat-log");
        const jump = document.querySelector(".chat-jump");
        failures.push(`${name} (top ${log?.scrollTop}, height ${log?.scrollHeight}, client ${log?.clientHeight}, button ${jump?.className})`);
        return false;
    };
    const errors = [];
    window.addEventListener("error", (e) => errors.push(e.message));

    const c = await import("/chatPane.js");
    const host = document.createElement("div");
    host.style.cssText = "position: fixed; top: 24px; left: 24px; display: flex; flex-direction: column; width: 720px; height: 480px; background: #0b0b0b;";
    host.innerHTML = c.chatPaneHtml({ id: "t", inputLabel: "Message the worker" });
    document.body.append(host);
    const pane = c.chatPaneRefs(host);
    const { log, jump } = pane;

    const item = (i) => ({
        type: "message",
        message: { role: i % 2 ? "assistant" : "user", content: `Message ${i}. ` + "The quick brown fox jumps over the lazy dog. ".repeat(4), id: `m${i}` },
    });
    const many = (n) => Array.from({ length: n }, (_, i) => item(i));
    const paint = (spec) => c.paintChatLog(log, spec);
    const max = () => log.scrollHeight - log.clientHeight;
    const atBottom = () => log.clientHeight > 0 && max() - log.scrollTop <= 2;
    const shown = () => jump.classList.contains("is-shown");
    const fresh = () => jump.classList.contains("has-new");
    // Frames come on the offscreen window's steady clock; still, never wait on one for ever.
    const frame = () => new Promise((r) => {
        const late = setTimeout(r, 1000);
        requestAnimationFrame(() => { clearTimeout(late); r(); });
    });
    // A hide or a detach the browser never lays out is never seen, by the page or by a person: wait
    // until a frame has taken it in (the pane's own observers, made first, hear of it in that frame),
    // then act on it from a task of its own, as a person would, not from inside the observer's turn.
    const laidOut = (name, Observer, test) => new Promise((resolve) => {
        const done = (ok) => { observer.disconnect(); clearTimeout(late); if (!ok) failures.push(`the test window never laid out ${name}`); setTimeout(resolve); };
        const observer = new Observer((entries) => { if (entries.some(test)) done(true); });
        const late = setTimeout(() => done(false), 5000);
        observer.observe(log);
    });
    // A smooth jump still running would carry on over the test's next scroll (a real wheel would
    // stop it): wait until the log has held still for a few frames.
    const settle = async () => {
        let last = NaN;
        for (let i = 0, still = 0; i < 120 && still < 3; i++) {
            await frame();
            still = log.scrollTop === last ? still + 1 : 0;
            last = log.scrollTop;
        }
    };
    const scrollUp = async (to = 0) => {
        await settle();
        log.scrollTop = to;
        await until(`scrolled up to ${to}`, () => Math.abs(log.scrollTop - to) <= 1 && shown());
    };
    const grow = (px) => {
        const box = document.createElement("div");
        box.className = "grown";
        log.querySelector(".chat-hist").lastElementChild.append(box);
        box.style.height = `${px}px`;
    };

    // Painted while hidden: nothing to scroll yet, then it opens at the latest once shown.
    host.style.display = "none";
    paint({ session: "a", items: many(40) });
    await sleep(60);
    check("a hidden log has no jump button", !shown());
    host.style.display = "flex";
    await until("a log painted while hidden opens at its latest message once shown", atBottom);
    check("the log scrolls (the test content overflows)", max() > 400);
    check("no jump button at the latest", !shown());

    // Content that grows after it's painted (an image loading, a section opening) keeps it there.
    grow(320);
    await until("content that grows after paint keeps the log at its latest", atBottom);

    // Scrolling up to read lets go, and the button offers the way back.
    await scrollUp(0);
    check("scrolling up shows the jump button", shown());
    check("with its plain name", jump.getAttribute("aria-label") === "Jump to the latest message" && jump.title === "Jump to the latest message");
    check("and no new-messages mark", !fresh());
    grow(240);
    await sleep(80);
    check("content growing while you read further up leaves you there", log.scrollTop === 0);
    check("growing content isn't a new message", !fresh());

    // A new message while reading further up: you stay, and the button marks it.
    paint({ session: "a", items: many(41) });
    await sleep(40);
    check("a new message leaves you where you were reading", log.scrollTop === 0);
    check("a new message marks the button", fresh() && shown());
    check("the mark is in the button's name", jump.getAttribute("aria-label") === "New messages below. Jump to the latest message");

    // The button floats centred over the conversation's foot.
    await sleep(300);
    const view = pane.view.getBoundingClientRect();
    const btn = jump.getBoundingClientRect();
    check(`the button is centred (${btn.left + btn.width / 2} vs ${view.left + view.width / 2})`, Math.abs(btn.left + btn.width / 2 - (view.left + view.width / 2)) <= 1);
    check(`the button sits at the foot (${view.bottom - btn.bottom}px up)`, view.bottom - btn.bottom >= 8 && view.bottom - btn.bottom <= 16);
    check("the button is round and 32px", Math.round(btn.width) === 32 && Math.round(btn.height) === 32 && getComputedStyle(jump).borderRadius === "50%");
    check("the button is above the log's foot, not in the composer", btn.bottom <= log.getBoundingClientRect().bottom);

    // The button takes you to the latest and gets out of the way.
    jump.click();
    await until("the jump button scrolls to the latest message", atBottom);
    await until("and hides there", () => !shown() && !fresh());
    check("its name resets", jump.getAttribute("aria-label") === "Jump to the latest message");
    check("a hidden button leaves the tab order", getComputedStyle(jump).visibility === "hidden" || !shown());

    // Pinned again: the next message keeps it at the latest.
    paint({ session: "a", items: many(42) });
    check("a new message at the latest stays there", atBottom());

    // Scrolling back near the bottom picks the conversation up again.
    await scrollUp(max() - 300);
    log.scrollTop = max() - 10;
    await until("scrolling back near the bottom hides the button", () => !shown());
    paint({ session: "a", items: many(43) });
    check("and keeps you at the latest", atBottom());

    // Another session opens at its latest message, wherever the last one was left.
    await scrollUp(0);
    paint({ session: "b", items: many(30) });
    check("another session opens at its latest message", atBottom());
    check("with no jump button", !shown() && !fresh());

    // Sending pulls the log down from wherever you were reading.
    await scrollUp(0);
    paint({ session: "b", items: many(30), sending: "Can you also update the docs?" });
    check("sending a message goes to the latest", atBottom());
    await sleep(40);
    check("and hides the button", !shown());

    // Shown again after being hidden: it opens at the latest.
    paint({ session: "b", items: many(31) });
    await scrollUp(0);
    host.style.display = "none";
    await laidOut("the hidden log", ResizeObserver, (e) => e.contentRect.height === 0);
    host.style.display = "flex";
    await until("a log shown again opens at its latest message", atBottom);
    check("with no jump button", !shown());

    // Taken off the page and put back: it opens at the latest too.
    await scrollUp(0);
    host.remove();
    await laidOut("the detached log", IntersectionObserver, (e) => !e.isIntersecting);
    document.body.append(host);
    await until("a log put back on the page opens at its latest message", atBottom);

    // A reply streaming in keeps the log at the latest as it grows.
    paint({ session: "b", items: many(31), busy: true, partial: "Working through it. ".repeat(120) });
    await sleep(200);
    check("a streaming reply keeps the log at the latest", atBottom());

    // ...and while you read further up, it marks the button.
    await scrollUp(0);
    paint({ session: "b", items: many(31), busy: true, partial: "Working through it. ".repeat(140) });
    await sleep(40);
    check("more of a streaming reply leaves you where you were reading", log.scrollTop === 0);
    check("and marks the button", fresh());
    paint({ session: "b", items: many(32) });

    // Keyboard: the hidden button hands focus to the log rather than dropping it.
    await scrollUp(0);
    jump.focus();
    check("a shown button takes focus", document.activeElement === jump);
    jump.click();
    await until("activating the focused button reaches the latest", atBottom);
    check("and focus moves to the log", document.activeElement === log);

    check(`no errors (${errors.join("; ")})`, errors.length === 0);
    window.__t = { pane, paint, many, atBottom, shown, fresh, scrollUp, errors };
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
            // Offscreen: a never-shown window draws only now and then, and a ResizeObserver hears only of the frames drawn.
            const win = new BrowserWindow({ show: false, width: 800, height: 560, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
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
                const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
                const until = async (name, code) => {
                    for (let i = 0; i < 60; i++) {
                        if (await run(code)) return true;
                        await sleep(25);
                    }
                    result.failures.push(name);
                    return false;
                };
                const center = 'JSON.parse(JSON.stringify((() => { const r = __t.pane.jump.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()))';

                // A mouse click jumps without taking focus from the message box.
                await run("__t.scrollUp(0)");
                await run("__t.pane.input.focus()");
                await sleep(250);
                let point = await run(center);
                win.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
                win.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
                await until("a click on the button reaches the latest", "__t.atBottom() && !__t.shown()");
                if (!await run("document.activeElement === __t.pane.input")) result.failures.push("a click leaves focus in the message box");

                // Enter on the focused button: the log takes focus as the button goes.
                await run("__t.scrollUp(0)");
                await run("__t.pane.jump.focus()");
                win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
                win.webContents.sendInputEvent({ type: "char", keyCode: "\\r" });
                win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
                await until("Enter on the button reaches the latest", "__t.atBottom() && !__t.shown()");
                if (!await run("document.activeElement === __t.pane.log")) result.failures.push("Enter moves focus to the log");

                // End in the log goes to the latest, as it always did.
                await run("__t.scrollUp(0)");
                await run("__t.pane.log.focus()");
                win.webContents.sendInputEvent({ type: "keyDown", keyCode: "End" });
                win.webContents.sendInputEvent({ type: "keyUp", keyCode: "End" });
                await until("End in the log reaches the latest and hides the button", "__t.atBottom() && !__t.shown()");

                // The wheel over the floating button scrolls the log under it.
                await run("__t.scrollUp(200)");
                await sleep(250);
                point = await run(center);
                win.webContents.sendInputEvent({ type: "mouseMove", ...point });
                win.webContents.sendInputEvent({ type: "mouseWheel", ...point, deltaX: 0, deltaY: 120, wheelTicksY: 1, canScroll: true });
                await until("the wheel over the button scrolls the log", "__t.pane.log.scrollTop < 190");

                ${process.env.ADO_PR_OPS_UI_SCREENSHOT ? `
                    await run("__t.scrollUp(0)");
                    await run('__t.paint({ session: "b", items: __t.many(40) })');
                    await sleep(400);
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
    console.log("chat-follow-harness: ok");
} finally {
    await new Promise((r) => server.close(r));
    // Electron's helpers can hold the profile for a moment after it exits: retry, and never let cleanup hide the result.
    try { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch {}
}
