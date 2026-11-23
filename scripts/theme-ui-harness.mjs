// The theme live, in a hidden Electron window: themeBoot.js sets it from ?theme= before paint, a
// pick from the shell (devis:theme) switches the page and its URL, "system" follows the shell's
// nativeTheme, and drawn Mermaid diagrams are drawn again in the new theme.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");
const root = mkdtempSync(join(tmpdir(), "theme-ui-"));
const electron = (await import("electron")).default;
const server = createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/") {
        res.setHeader("Content-Type", "text/html");
        return res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><script src="/themeBoot.js"></script><link rel="stylesheet" href="/style.css"><script src="/vendor/mermaid.min.js"></script></head><body><div class="md" id="doc"></div></body></html>');
    }
    const file = resolve(web, "." + decodeURIComponent(path));
    if (!file.startsWith(web + sep)) {
        res.writeHead(403).end();
        return;
    }
    try {
        res.setHeader("Content-Type", { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" }[extname(file)] || "application/octet-stream");
        res.end(readFileSync(file));
    } catch {
        res.writeHead(404).end();
    }
});

async function inPage() {
    const failures = [];
    const check = (name, ok) => { if (!ok) failures.push(name); };
    const until = async (name, test) => {
        for (let i = 0; i < 500; i++) {
            if (test()) return true;
            await new Promise((r) => setTimeout(r, 10));
        }
        failures.push("timed out: " + name);
        return false;
    };
    const html = document.documentElement;
    const token = (name) => getComputedStyle(html).getPropertyValue(name).trim();
    const scheme = () => document.querySelector('meta[name="color-scheme"]').getAttribute("content");

    // Before any module runs, themeBoot.js already applied the URL's pref.
    check("boot: light from ?theme=light", html.dataset.theme === "light" && html.dataset.themePref === "light");
    check("boot: color-scheme meta is light", scheme() === "light");
    check("boot: light tokens apply", token("--text-1") === "#1b1b1b" && token("--accent") === "#0078a8");
    check("boot: body text is dark ink", getComputedStyle(document.body).color === "rgb(27, 27, 27)");

    const { followTheme, themePref, currentTheme } = await import("/theme.js");
    const { renderMermaid } = await import("/mermaid.js");
    const applied = [];
    window.addEventListener("devis:theme-applied", (e) => applied.push(e.detail));
    followTheme();
    check("follow: no event when nothing changed", applied.length === 0);

    // Inserted after load, as the app does, so Mermaid's own startOnLoad never sees it.
    const doc = document.getElementById("doc");
    doc.innerHTML = '<div class="mermaid" data-mermaid>graph TD; A-->B</div>';
    await renderMermaid(doc, true);
    const svgOf = () => doc.querySelector(".mermaid.rendered svg");
    check("mermaid: drawn", !!svgOf());
    const lightSvg = svgOf();
    const lightStyle = lightSvg?.querySelector("style")?.textContent || "";

    // The shell's pick, as main.mts sends it to every window.
    window.dispatchEvent(new CustomEvent("devis:theme", { detail: "dark" }));
    check("switch: dark applied", currentTheme() === "dark" && themePref() === "dark");
    check("switch: dark tokens apply", token("--text-1") === "#f2f2f2" && token("--accent") === "#4cd6ff");
    check("switch: color-scheme meta is dark", scheme() === "dark");
    check("switch: URL keeps the pref for a reload", new URL(location.href).searchParams.get("theme") === "dark");
    check("switch: one applied event", applied.length === 1 && applied[0].theme === "dark" && applied[0].pref === "dark");

    await until("mermaid: drawn again in dark", () => svgOf() && svgOf() !== lightSvg);
    const darkSvg = svgOf();
    const darkStyle = darkSvg?.querySelector("style")?.textContent || "";
    check("mermaid: the dark drawing has different colors", darkStyle && darkStyle !== lightStyle.replaceAll(lightSvg.id, darkSvg.id));
    check("mermaid: one set of diagram controls", doc.querySelectorAll(".mmd-toolbar").length === 1);
    check("mermaid: still adjustable", doc.querySelector(".mermaid").classList.contains("adjustable"));

    // "Use Windows setting" follows nativeTheme, which this window's shell set to light. The moment its
    // redraw starts, switch straight back to dark (an unknown pref reads as dark): dark must win.
    const node = doc.querySelector(".mermaid");
    let flipped = false;
    const midDraw = new MutationObserver(() => {
        if (node.classList.contains("rendered")) return;
        midDraw.disconnect();
        flipped = true;
        window.dispatchEvent(new CustomEvent("devis:theme", { detail: "bogus" }));
    });
    midDraw.observe(node, { attributes: true, attributeFilter: ["class"] });
    window.dispatchEvent(new CustomEvent("devis:theme", { detail: "system" }));
    check("system: resolves to the shell's light", currentTheme() === "light" && themePref() === "system");
    check("system: tokens follow", token("--text-1") === "#1b1b1b");
    await until("the light redraw starts", () => flipped);
    check("junk pref falls back to dark", currentTheme() === "dark" && themePref() === "dark");
    const inDark = () => {
        const svg = svgOf();
        return !!svg && svg !== darkSvg && svg.querySelector("style")?.textContent === darkStyle.replaceAll(darkSvg.id, svg.id);
    };
    await until("mermaid: a switch mid-draw still ends in dark", inDark);
    await new Promise((r) => setTimeout(r, 300));
    check("mermaid: stays in dark", inDark() && doc.querySelectorAll(".mmd-toolbar").length === 1);

    // A diagram still drawing when the theme changes is drawn again once it lands.
    doc.insertAdjacentHTML("beforeend", '<div class="mermaid" data-mermaid id="late">graph LR; C-->D</div>');
    const drawing = renderMermaid(doc);
    window.dispatchEvent(new CustomEvent("devis:theme", { detail: "light" }));
    await drawing;
    const late = () => document.querySelector("#late svg style")?.textContent || "";
    await until("mermaid: a diagram drawn mid-switch ends in light", () => /fill:#eee;stroke:#999/.test(late()));
    return { failures };
}

try {
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}/?theme=light`;
    const main = join(root, "main.cjs");
    writeFileSync(main, `
        const { app, BrowserWindow, nativeTheme } = require("electron");
        app.setPath("userData", ${JSON.stringify(join(root, "profile"))});
        app.whenReady().then(async () => {
            nativeTheme.themeSource = "light";
            const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
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
    console.log("theme-ui-harness: ok");
} finally {
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
}
