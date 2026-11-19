// The chat's prompt index (a tick per prompt you sent, down the conversation's right edge) in a hidden Electron window.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");
const root = mkdtempSync(join(tmpdir(), "chat-index-"));
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
    const errors = [];
    window.addEventListener("error", (e) => errors.push(e.message));

    const c = await import("/chatPane.js");
    const host = document.createElement("div");
    host.style.cssText = "position: fixed; top: 24px; left: 24px; display: flex; flex-direction: column; width: 720px; height: 480px; background: #0b0b0b;";
    host.innerHTML = c.chatPaneHtml({ id: "t", inputLabel: "Message the worker" });
    document.body.append(host);
    const pane = c.chatPaneRefs(host);
    const { log, view, input } = pane;
    const nav = view.querySelector(".chat-index");
    const card = view.querySelector(".chat-index-card");
    const ticks = () => [...nav.querySelectorAll(".chat-index-tick")];
    const current = () => ticks().findIndex((t) => t.classList.contains("is-current"));
    const bubble = (i) => log.querySelector(`.chat-msg[data-key="m:u${i}"]`);
    const topOf = (el) => el.getBoundingClientRect().top - log.getBoundingClientRect().top;
    const landed = (i) => !!bubble(i) && Math.abs(topOf(bubble(i)) - c.PROMPT_PAD) <= 2;
    const max = () => log.scrollHeight - log.clientHeight;
    const atBottom = () => log.clientHeight > 0 && max() - log.scrollTop <= 2;
    const shown = () => pane.jump.classList.contains("is-shown");
    const state = () => `top ${log.scrollTop}/${max()}, current ${current()}, ticks ${ticks().length}, focus ${document.activeElement?.className}`;
    const until = async (name, test, tries = 300) => {
        for (let i = 0; i < tries; i++) {
            if (test()) return true;
            await sleep(10);
        }
        failures.push(`${name} (${state()})`);
        return false;
    };
    const frame = () => new Promise((r) => {
        const late = setTimeout(r, 1000);
        requestAnimationFrame(() => { clearTimeout(late); r(); });
    });
    // Let a smooth scroll finish: the log holds still for a few frames.
    const settle = async () => {
        let last = NaN;
        for (let i = 0, still = 0; i < 150 && still < 3; i++) {
            await frame();
            still = log.scrollTop === last ? still + 1 : 0;
            last = log.scrollTop;
        }
        await sleep(30);
    };
    const scrollToPrompt = async (i, by = 0) => {
        await settle();
        log.scrollTop = Math.round(log.scrollTop + topOf(bubble(i)) - c.PROMPT_PAD + by);
        await frame();
        await frame();
    };

    const base = new Date();
    base.setHours(9, 19, 0, 0);
    const clock = (i) => new Date(base.getTime() + i * 60_000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const turn = (i) => [
        { type: "message", message: { id: `u${i}`, role: "user", content: `Prompt ${i}: please look at part ${i} of the build.`, timestamp: new Date(base.getTime() + i * 60_000).toISOString() } },
        { type: "message", message: { id: `a${i}`, role: "assistant", content: `Reply ${i}. ` + "The quick brown fox jumps over the lazy dog. ".repeat(20) } },
    ];
    const conv = (n, from = 0) => Array.from({ length: n }, (_, i) => turn(from + i)).flat();
    const paint = (spec) => c.paintChatLog(log, spec);
    const alt = (key, target = input) => {
        const e = new KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true });
        target.dispatchEvent(e);
        return e;
    };
    const press = (key) => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    const cardText = () => card.querySelector(".chat-index-text")?.textContent;
    const cardWhen = () => card.querySelector(".chat-index-when")?.textContent;

    // One prompt: no rail, and no room kept for it.
    paint({ session: "a", items: conv(1) });
    await frame();
    check("one prompt: no rail", nav.hidden && getComputedStyle(nav).display === "none" && !view.classList.contains("has-index"));
    check(`one prompt: the log keeps its padding (${getComputedStyle(log).paddingRight})`, getComputedStyle(log).paddingRight === "18px");

    // From two prompts: a tick each, down the right edge.
    const items = conv(8);
    paint({ session: "a", items });
    await until("the conversation opens at its latest", atBottom);
    check("the rail shows from two prompts", !nav.hidden && getComputedStyle(nav).display === "flex" && view.classList.contains("has-index"));
    await until("the log makes room for the rail", () => getComputedStyle(log).paddingRight === "44px");
    check(`a tick per prompt (${ticks().length})`, ticks().length === 8);
    const vr = view.getBoundingClientRect();
    const nr = nav.getBoundingClientRect();
    check(`the rail is at the right edge, clear of the scrollbar (${vr.right - nr.right}px in)`, vr.right - nr.right >= 12 && vr.right - nr.right <= 20);
    check(`the rail runs down the view (${nr.top - vr.top}px from the top)`, nr.top - vr.top >= 8 && nr.top - vr.top <= 16 && nr.height > 100);
    check("the prompts' bubbles clear the rail", [...log.querySelectorAll(".chat-msg.user")].every((b) => b.getBoundingClientRect().right <= nr.left));
    check(`a tick is named for its prompt and when (${ticks()[3].getAttribute("aria-label")})`, ticks()[3].getAttribute("aria-label") === `Prompt 4 of 8: Prompt 3: please look at part 3 of the build. (Today, ${clock(3)})`);
    check("ticks are buttons out of the tab order but the one", ticks().every((t) => t.type === "button") && ticks().filter((t) => t.tabIndex === 0).length === 1);
    await until("at the latest, the last prompt is current", () => current() === 7);
    check("the current tick says so", ticks()[7].getAttribute("aria-current") === "location" && ticks().filter((t) => t.hasAttribute("aria-current")).length === 1);
    check("the rail's tab stop is the current tick", ticks()[7].tabIndex === 0);
    await sleep(250);
    const tickLine = (i) => getComputedStyle(ticks()[i], "::before");
    check(`the current tick is brighter (${tickLine(7).opacity} vs ${tickLine(2).opacity})`, tickLine(7).opacity === "1" && Number(tickLine(2).opacity) < 0.7);
    check(`and longer (${tickLine(7).transform})`, tickLine(7).transform !== "none" && tickLine(2).transform === "none");
    check("no backdrop blur on the rail or its card", getComputedStyle(nav).backdropFilter === "none" && getComputedStyle(card).backdropFilter === "none");

    // A click scrolls its prompt to the top of the view, flashes it, and lets go of the latest.
    ticks()[2].click();
    check("the clicked tick is current at once", current() === 2);
    await until("a click scrolls its prompt to the top of the view", () => landed(2));
    await until("and flashes it", () => bubble(2).classList.contains("flash"));
    await settle();
    check("it stays current", current() === 2);
    check("the jump button offers the way back", shown());
    const kept = log.scrollTop;
    const more = [...items, { type: "message", message: { id: "x1", role: "assistant", content: "One more thing." } }];
    paint({ session: "a", items: more });
    await sleep(60);
    check("a new message leaves you at the prompt", log.scrollTop === kept);
    check("and marks the jump button", pane.jump.classList.contains("has-new"));
    check("a repaint keeps the current tick", current() === 2);
    await until("the flash fades", () => !bubble(2).classList.contains("flash"));

    // Scrolling moves the current tick along.
    await scrollToPrompt(5);
    await until("scrolling a prompt to the top makes it current", () => current() === 5);
    log.scrollTop -= 40;
    await until("scrolling back above its start, the one before is current", () => current() === 4);

    // Alt+↓ and Alt+↑ step between prompts from the message box.
    input.focus();
    await scrollToPrompt(3);
    await until("reading prompt 3", () => current() === 3);
    check("Alt+↓ is taken", alt("ArrowDown").defaultPrevented);
    await until("Alt+↓ goes to the next prompt", () => landed(4) && current() === 4);
    check("focus stays in the message box", document.activeElement === input);
    alt("ArrowDown");
    alt("ArrowDown");
    await until("Alt+↓ twice in a row goes two along", () => landed(6) && current() === 6);
    await settle();
    alt("ArrowUp");
    await until("Alt+↑ goes to the one before", () => landed(5) && current() === 5);
    await scrollToPrompt(5, 100);
    await until("reading prompt 5's reply", () => current() === 5 && !landed(5));
    alt("ArrowUp");
    await until("Alt+↑ goes back to the start of the prompt you're in first", () => landed(5));
    await settle();
    alt("ArrowUp");
    await until("then to the one before", () => landed(4) && current() === 4);
    await settle();
    let before = log.scrollTop;
    pane.popup.hidden = false;
    const inList = alt("ArrowDown");
    await sleep(80);
    check("while the \"/\" list is open, Alt+↓ is the list's", !inList.defaultPrevented && log.scrollTop === before);
    pane.popup.hidden = true;
    const shifted = new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, shiftKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(shifted);
    await sleep(80);
    check("Alt+Shift+↓ isn't it", !shifted.defaultPrevented && log.scrollTop === before);
    ticks()[0].click();
    await until("back to the first prompt", () => landed(0));
    await settle();
    alt("ArrowUp");
    await sleep(80);
    check("nothing before the first prompt", landed(0) && current() === 0);

    // The rail from the keyboard: one tab stop, the arrows move along it, a tick's card follows focus.
    const stop = ticks().find((t) => t.tabIndex === 0);
    check("the tab stop is the current tick", stop === ticks()[0]);
    stop.focus();
    await until(`focusing a tick shows its card (hasFocus ${document.hasFocus()})`, () => !card.hidden);
    check(`the card has the prompt (${cardText()})`, cardText() === "Prompt 0: please look at part 0 of the build.");
    check(`and when it was sent (${cardWhen()})`, cardWhen() === `Today, ${clock(0)}`);
    check("the card is for sighted readers only: the tick has its name", card.getAttribute("aria-hidden") === "true");
    press("ArrowDown");
    check("↓ moves focus to the next tick", document.activeElement === ticks()[1]);
    check("which becomes the tab stop", ticks()[1].tabIndex === 0 && ticks().filter((t) => t.tabIndex === 0).length === 1);
    check(`the card follows focus (${cardText()})`, cardText()?.startsWith("Prompt 1:"));
    const cr = card.getBoundingClientRect();
    const tr = ticks()[1].getBoundingClientRect();
    check(`the card sits beside its tick (${Math.round(cr.right)} vs ${Math.round(tr.left)})`, cr.right <= tr.left && tr.left - cr.right <= 16);
    check(`level with it (${Math.round(cr.top + cr.height / 2)} vs ${Math.round(tr.top + tr.height / 2)})`, Math.abs(cr.top + cr.height / 2 - (tr.top + tr.height / 2)) <= 2 || cr.top - vr.top <= 9);
    check("moving focus along the rail doesn't scroll", landed(0));
    press("End");
    check("End goes to the last tick", document.activeElement === ticks()[7]);
    press("Home");
    check("Home to the first", document.activeElement === ticks()[0]);
    press("ArrowUp");
    check("↑ at the first stays", document.activeElement === ticks()[0]);
    press("ArrowDown");
    press("ArrowDown");
    document.activeElement.click();
    await until("activating a focused tick jumps to its prompt", () => landed(2) && current() === 2);
    check("focus stays on the tick", document.activeElement === ticks()[2]);
    await settle();
    alt("ArrowDown", document.activeElement);
    await until("Alt+↓ in the rail jumps and moves focus along", () => landed(3) && document.activeElement === ticks()[3]);
    await settle();
    log.focus();
    await until("focus leaving the rail hides the card", () => card.hidden);
    check("and the tab stop is the current tick again", ticks()[3].tabIndex === 0 && ticks().filter((t) => t.tabIndex === 0).length === 1);

    // Hovering shows a tick's card; leaving the rail hides it.
    ticks()[5].dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    check(`hovering a tick shows its card (${cardText()})`, !card.hidden && cardText()?.startsWith("Prompt 5:"));
    nav.dispatchEvent(new PointerEvent("pointerleave"));
    check("leaving the rail hides it", card.hidden);

    // A jump up while a reply streams in at the latest isn't pulled back down by it.
    const stream = (n) => paint({ session: "a", items: more, busy: true, partial: "Streaming along. ".repeat(n) });
    stream(40);
    pane.jump.click();
    await until("back at the latest", atBottom);
    await settle();
    ticks()[1].click();
    for (let i = 1; i <= 15; i++) {
        await sleep(20);
        stream(40 + i * 8);
    }
    await until("a jump up mid-stream lands at its prompt", () => landed(1));
    await settle();
    stream(200);
    await sleep(100);
    check("and stays there as the reply streams on", landed(1) && current() === 1);
    paint({ session: "a", items: more });

    // A jump to a prompt at the foot keeps following the conversation.
    ticks()[7].click();
    await until("the last prompt is current", () => current() === 7);
    await settle();
    check("a jump to the foot keeps following", !shown());
    paint({ session: "a", items: [...more, { type: "message", message: { id: "x2", role: "assistant", content: "And another." } }] });
    check("so a new message keeps the log at the latest", atBottom());

    // A prompt on its way, and one sent mid-turn, get ticks too; the ticks already there stay put.
    const first = ticks()[0];
    paint({ session: "a", items: more, sending: "One more question" });
    check(`a prompt being sent gets a tick (${ticks().at(-1)?.getAttribute("aria-label")})`, ticks().length === 9 && ticks()[8].getAttribute("aria-label") === "Prompt 9 of 9: One more question (Just now)");
    check("the rail is patched, not rebuilt", ticks()[0] === first);
    await until("sending goes to the latest, and its tick is current", () => atBottom() && current() === 8);
    paint({ session: "a", items: more, busy: true, steered: [{ id: "s1", text: "Also check the docs" }] });
    check("a prompt sent mid-turn gets a tick", ticks().length === 9 && ticks()[8].getAttribute("aria-label") === "Prompt 9 of 9: Also check the docs (Sent mid-turn)");

    // Another session has its own rail.
    paint({ session: "b", items: conv(3, 20) });
    check(`another session: its own ticks (${ticks().length})`, ticks().length === 3);
    await until("opened at its latest, its last prompt is current", () => current() === 2);

    // Down to one prompt, the rail goes.
    paint({ session: "c", items: conv(1) });
    check("down to one prompt, the rail goes", nav.hidden && ticks().length === 0 && !view.classList.contains("has-index"));
    await until("and so does the room for it", () => getComputedStyle(log).paddingRight === "18px");

    // A long conversation: the rail scrolls, with the current tick in view.
    paint({ session: "d", items: conv(90) });
    await until("a long conversation opens at its latest", atBottom);
    check(`a long rail scrolls (${nav.scrollHeight} in ${nav.clientHeight})`, nav.scrollHeight > nav.clientHeight);
    check("its ticks are at least 6px", ticks().every((t) => t.getBoundingClientRect().height >= 5.9));
    const inRail = (i) => {
        const r = ticks()[i].getBoundingClientRect();
        const n = nav.getBoundingClientRect();
        return r.top >= n.top - 1 && r.bottom <= n.bottom + 1;
    };
    await until("the current tick is kept in view", () => current() === 89 && inRail(89));
    check("the rail's own scrollbar is hidden", getComputedStyle(nav).scrollbarWidth === "none");
    ticks()[0].click();
    await until("a jump to the first prompt", () => landed(0) && current() === 0 && inRail(0));
    await settle();

    // Left for the real-input checks: eight prompts, at the latest.
    paint({ session: "e", items });
    await until("ready for real input", () => atBottom() && current() === 7);
    check(`no errors (${errors.join("; ")})`, errors.length === 0);
    window.__t = { pane, ticks, current, landed, atBottom, settle, card, cardText, nav, errors };
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
            // Focus events reach a page only while it has focus, which a never-shown window doesn't: pretend it does.
            win.webContents.debugger.attach("1.3");
            await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
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
                    for (let i = 0; i < 120; i++) {
                        if (await run(code)) return true;
                        await sleep(25);
                    }
                    result.failures.push(name + " (" + await run("__t.pane.log.scrollTop + ' ' + __t.current() + ' ' + document.activeElement.className") + ")");
                    return false;
                };
                const tick = (i) => run('JSON.parse(JSON.stringify((() => { const r = __t.ticks()[' + i + '].getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()))');
                const key = (keyCode, modifiers = []) => {
                    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
                    // A button acts on Enter from the keypress, which only a char event makes.
                    if (keyCode === "Return") win.webContents.sendInputEvent({ type: "char", keyCode: "\\r", modifiers });
                    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
                };

                // The mouse over a tick shows its card, and leaving the rail hides it.
                await sleep(250);
                let point = await tick(4);
                win.webContents.sendInputEvent({ type: "mouseMove", ...point });
                await until("hovering a tick shows its card", "!__t.card.hidden && __t.cardText().startsWith('Prompt 4:')");
                win.webContents.sendInputEvent({ type: "mouseMove", x: 200, y: 200 });
                await until("the mouse leaving the rail hides it", "__t.card.hidden");

                // A click jumps without taking focus from the message box.
                await run("__t.pane.input.focus()");
                win.webContents.sendInputEvent({ type: "mouseMove", ...point });
                win.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
                win.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
                await until("a click on a tick jumps to its prompt", "__t.landed(4) && __t.current() === 4");
                if (!await run("document.activeElement === __t.pane.input")) result.failures.push("a click on a tick leaves focus in the message box");
                await run("__t.settle()");

                // Alt+↓ and Alt+↑ from the message box, as typed.
                key("Down", ["alt"]);
                await until("Alt+↓ typed in the message box goes to the next prompt", "__t.landed(5) && __t.current() === 5");
                await run("__t.settle()");
                key("Up", ["alt"]);
                await until("Alt+↑ typed goes back", "__t.landed(4) && __t.current() === 4");
                await run("__t.settle()");
                if (await run("__t.pane.input.value !== ''")) result.failures.push("Alt+arrows type nothing into the message box");

                // Enter on a focused tick jumps to its prompt.
                await run("__t.ticks()[4].focus()");
                key("Down");
                key("Down");
                key("Return");
                await until("Enter on a focused tick jumps to its prompt", "__t.landed(6) && document.activeElement === __t.ticks()[6]");
                await run("__t.settle()");
                await run("__t.pane.input.focus()");

                // The wheel over a rail that fits scrolls the conversation.
                const top = await run("__t.pane.log.scrollTop");
                point = await tick(1);
                win.webContents.sendInputEvent({ type: "mouseMove", ...point });
                win.webContents.sendInputEvent({ type: "mouseWheel", ...point, deltaX: 0, deltaY: 120, wheelTicksY: 1, canScroll: true });
                await until("the wheel over the rail scrolls the log", "__t.pane.log.scrollTop < " + (top - 10));
                win.webContents.sendInputEvent({ type: "mouseMove", x: 200, y: 200 });

                ${process.env.ADO_PR_OPS_UI_SCREENSHOT ? `
                    await sleep(300);
                    point = await tick(2);
                    win.webContents.sendInputEvent({ type: "mouseMove", ...point });
                    await sleep(300);
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
        const timeout = setTimeout(() => { child.kill(); reject(new Error("Electron UI test timed out")); }, 90_000);
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
    console.log("chat-index-ui-harness: ok");
} finally {
    await new Promise((r) => server.close(r));
    // Electron's helpers can hold the profile for a moment after it exits: retry, and never let cleanup hide the result.
    try { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch {}
}
