// The code window (workerChanges.ts, code.html) in a hidden Electron window: the tree, every diff
// state, the three comparisons, polling, the narrow picker, and the layout from 480 to 2560px.
// Set ADO_PR_OPS_UI_SCREENSHOTS to a folder to save code-<width>.png at each width.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER = "0b7c7c1e-5d55-4c5e-9a43-6f1d2a3b4c5d";
const WIDTHS = [480, 768, 1024, 1440, 2560];
const web = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");
const root = mkdtempSync(join(tmpdir(), "worker-changes-ui-"));
const shots = process.env.ADO_PR_OPS_UI_SCREENSHOTS ? resolve(process.env.ADO_PR_OPS_UI_SCREENSHOTS) : "";
const electron = (await import("electron")).default;

const PAGE =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head>' +
    '<body data-page="code"><header class="titlebar"><div class="brand"><span class="brand-name" id="codeTitle">Changes</span></div></header>' +
    '<main id="code" class="cw" aria-label="Worker changes"></main></body></html>';

// code.html runs code.js for real, so its entry check talks to this server instead of a mocked fetch.
function api(url, res) {
    const send = (status, data) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
    };
    if (url.searchParams.get("sessionId") !== WORKER) return send(404, { error: "No such worker." });
    if (url.pathname === "/api/jarvis/workers/changes") {
        return send(200, {
            mode: url.searchParams.get("mode"), at: new Date().toISOString(),
            worker: { name: "atlas", task: "Worker workspace", busy: false, state: "turnDone" },
            repos: [{
                key: "app", name: "ado-pr-ops", branch: "devis/atlas", base: "master", fromRef: "abc1234", head: "def5678",
                files: [{ path: "README.md", status: "M", added: 1, removed: 0 }],
            }],
        });
    }
    if (url.pathname === "/api/jarvis/workers/diff") return send(200, { hunks: [[{ t: "add", nn: 1, text: "# Devis" }]], editable: false });
    return send(404, { error: "Not found" });
}

const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/") {
        res.setHeader("Content-Type", "text/html");
        return res.end(PAGE);
    }
    if (url.pathname.startsWith("/api/")) return api(url, res);
    const file = resolve(web, "." + decodeURIComponent(url.pathname));
    if (!file.startsWith(web + sep)) {
        res.writeHead(403).end();
        return;
    }
    try {
        res.setHeader("Content-Type", { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png" }[extname(file)] || "application/octet-stream");
        res.end(readFileSync(file));
    } catch {
        res.writeHead(404).end();
    }
});

// ---- in the page ----------------------------------------------------------------------------

function setup(worker) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const deferred = () => {
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        return { promise, resolve };
    };
    const file = (path, status, added, removed, extra = {}) => ({ path, status, added, removed, ...extra });
    const app = (files, extra = {}) => ({ key: "app", name: "ado-pr-ops", branch: "devis/atlas", base: "master", fromRef: "abc1234", head: "def5678aa11", files, ...extra });
    const lib = (files, extra = {}) => ({ key: "lib", name: "devis-lib", branch: "devis/atlas", base: "main", fromRef: "0123abc", head: "4567defbb22", files, ...extra });
    const noCommits = "No commits on devis/atlas yet.";
    const lists = () => ({
        branch: [
            app([
                file("web/src/workerChanges.ts", "M", 120, 4),
                file("web/src/code.ts", "A", 31, 0),
                file("src/worker-changes.mts", "M", 80, 10),
                file("README.md", "M", 2, 1),
                file("assets/logo.png", "M", null, null, { binary: true }),
                file("old/legacy.ts", "D", 0, 3),
                file("big/data.json", "M", 9000, 0),
                file("docs/renamed.md", "R", 0, 0, { oldPath: "docs/old.md" }),
                file("empty.txt", "A", 0, 0),
            ]),
            lib([], { error: "fatal: not a git repository" }),
        ],
        uncommitted: [app([file("web/src/workerChanges.ts", "M", 3, 1), file("notes.md", "U", 5, 0)]), lib([])],
        last: [app([], { note: noCommits }), lib([], { note: noCommits })],
    });
    const S = {
        worker: { name: "atlas", task: "Worker workspace", busy: false, state: "turnDone" },
        lists: lists(),
        listStatus: 200, listError: "", offline: false, hold: null,
        diffs: {
            "assets/logo.png": { binary: true, oldSize: 1200, newSize: 2400, editable: false },
            "big/data.json": { tooLarge: true, oldCount: 12, newCount: 9012, editable: false },
            "docs/renamed.md": { hunks: [], editable: false },
            "empty.txt": { hunks: [], editable: false },
            "old/legacy.ts": {
                hunks: [[{ t: "del", o: 1, text: "export const legacy = 1;" }, { t: "del", o: 2, text: "" }, { t: "del", o: 3, text: "// gone" }]],
                editable: false,
            },
        },
        diffStatus: 200, diffError: "", ideStatus: 200, ideError: "",
    };
    // Every text diff names its own file, so a check can tell which diff is on screen.
    const textDiff = (path) => ({
        hunks: [[{ t: "ctx", o: 1, nn: 1, text: "const a = 1;" }, { t: "del", o: 2, text: "const b = 2;" }, { t: "add", nn: 2, text: `const b = "${path}";` }]],
        editable: false, hash: "h",
    });
    const calls = { list: [], diff: [], ide: [], other: [] };
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    window.fetch = async (input, init = {}) => {
        const url = new URL(String(input), location.href);
        const q = url.searchParams;
        switch (url.pathname) {
            case "/api/jarvis/workers/changes": {
                calls.list.push({ t: performance.now(), sessionId: q.get("sessionId"), mode: q.get("mode"), busy: S.worker.busy });
                if (S.hold) await S.hold.promise;
                if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
                if (S.offline) throw new TypeError("Failed to fetch");
                if (S.listStatus !== 200) return json({ error: S.listError }, S.listStatus);
                return json({ mode: q.get("mode"), at: new Date().toISOString(), worker: { ...S.worker }, repos: structuredClone(S.lists[q.get("mode")]) });
            }
            case "/api/jarvis/workers/diff": {
                const path = q.get("path");
                calls.diff.push({ t: performance.now(), sessionId: q.get("sessionId"), repo: q.get("repo"), path, mode: q.get("mode"), oldPath: q.get("oldPath") });
                if (S.offline) throw new TypeError("Failed to fetch");
                if (S.diffStatus !== 200) return json({ error: S.diffError }, S.diffStatus);
                return json(S.diffs[path] || textDiff(path));
            }
            case "/api/jarvis/workers/ide":
                calls.ide.push(JSON.parse(init.body));
                if (S.ideStatus !== 200) return json({ error: S.ideError }, S.ideStatus);
                return json({ ok: true });
            default:
                calls.other.push(url.pathname);
                return json({ error: "Not found" }, 404);
        }
    };

    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => [...document.querySelectorAll(sel)];
    const key = (path, repo = "app") => JSON.stringify(["f", repo, path]);
    const H = {
        worker, S, calls, failures: [], prefix: "", view: null, titles: [],
        slow: { busy: 600000, idle: 600000, retry: 600000, retryMax: 600000, settle: 600000, tick: 600000, focusGap: 600000 },
        sleep, deferred, app, lib, $, $$, key,
        check(name, ok) { if (!ok) H.failures.push(`${H.prefix}: ${name}`); },
        async until(name, test, ms = 2000) {
            const end = performance.now() + ms;
            for (;;) {
                let ok = false;
                try { ok = !!test(); } catch { ok = false; }
                if (ok) return true;
                if (performance.now() > end) {
                    H.failures.push(`${H.prefix}: timed out: ${name}`);
                    return false;
                }
                await sleep(10);
            }
        },
        press(target, k, opts = {}) {
            target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));
        },
        row: (path, repo = "app") => $$(".cw-file").find((r) => r.dataset.key === key(path, repo)),
        selPath() {
            const r = $(".cw-file.sel");
            return r ? JSON.parse(r.dataset.key)[2] : null;
        },
        stateTitle: () => $(".cw-dbody .cw-state-title")?.textContent || "",
        hash: () => Object.fromEntries(new URLSearchParams(location.hash.slice(1))),
        diffFor: (path) => ($(".cw-dbody table.diff tr.add .code")?.textContent || "").includes(`"${path}"`),
        stale: () => $("#code").classList.contains("cw-stale"),
        reset() {
            S.lists = lists();
            Object.assign(S.worker, { busy: false, state: "turnDone" });
            Object.assign(S, { listStatus: 200, listError: "", offline: false, hold: null, diffStatus: 200, diffError: "", ideStatus: 200, ideError: "" });
        },
        async mount(intervals) {
            const { mountWorkerChanges } = await import("/workerChanges.js");
            H.titles = [];
            H.view = mountWorkerChanges(document.getElementById("code"), {
                worker,
                intervals,
                onTitle: (name, task) => H.titles.push(`${name} \u00b7 ${task}`),
            });
        },
        destroy() {
            H.view.destroy();
            H.view = null;
        },
        async run(name, body) {
            H.prefix = name;
            H.failures = [];
            let extra = {};
            try {
                extra = (await body()) || {};
            } catch (error) {
                H.failures.push(`${name}: threw ${(error && error.stack) || error}`);
            }
            return { ...extra, failures: H.failures };
        },
    };
    window.H = H;
    return { failures: [] };
}

function wide() {
    return H.run("wide", async () => {
        const { S, calls, check, until, sleep, $, $$, press, row, selPath, stateTitle, hash, diffFor, stale, deferred, key } = H;
        const body = document.body;
        const pos = () => $(".cw-dhead .cw-pos")?.textContent || "";
        const diffs = () => calls.diff.length;
        const lastDiff = () => calls.diff[calls.diff.length - 1] || {};
        const seg = (mode) => $(`.cw-seg-btn[data-mode="${mode}"]`);

        check("the page is visible, so polling isn't paused", !document.hidden);
        localStorage.removeItem("devis.codeWindow.treeWidth");
        history.replaceState(null, "", "/");
        S.hold = deferred();
        await H.mount(H.slow);
        check("the tree starts as a skeleton", !!$(".cw-tree .cw-skeleton"));
        check("the diff starts as a skeleton", !!$(".cw-dbody .cw-skeleton"));
        check("the split is busy until the list lands", $(".cw-split").getAttribute("aria-busy") === "true");
        check("the first request names the worker and comparison", calls.list[0]?.sessionId === H.worker && calls.list[0]?.mode === "branch");
        S.hold.resolve();
        S.hold = null;
        await until("the tree loads", () => $$(".cw-file").length > 0);

        // The list
        check("the window title gets the worker and task", H.titles.join("|") === "atlas \u00b7 Worker workspace");
        check("the chip shows the worker's state", $(".cw-chip-nm").textContent === "atlas" && $(".cw-chip-st").textContent === "Turn done" && $(".cw-dot").dataset.tone === "ok");
        check("totals add up every file", $(".cw-totals").textContent === "9 files +9,233\u221218");
        check("the update time shows", $(".cw-updated").textContent === "Updated just now");
        check("Since branching is the default", seg("branch").classList.contains("on") && seg("branch").getAttribute("aria-checked") === "true" && $(".cw-mode-select").value === "branch");
        const labels = $$(".cw-tree [role=treeitem]").map((r) => r.querySelector(".cw-nm").textContent);
        check("the tree lists folders first, then files, per repo", JSON.stringify(labels) === JSON.stringify([
            "ado-pr-ops", "assets", "logo.png", "big", "data.json", "docs", "renamed.md", "old", "legacy.ts",
            "src", "worker-changes.mts", "web/src", "code.ts", "workerChanges.ts", "empty.txt", "README.md", "devis-lib",
        ]));
        check("a folder with one subfolder shows as one row", $$(".cw-dir").some((r) => r.querySelector(".cw-nm").textContent === "web/src" && r.title === "web/src"));
        check("the repo row counts its files", $(".cw-repo .cw-n").textContent === "9");
        check("the repo says where it branched from", $(".cw-meta.cw-from")?.textContent === "from master \u00b7 abc1234");
        const bad = $(".cw-meta.bad");
        check("a repo that failed shows why, with Retry", !!bad && bad.textContent.includes("fatal: not a git repository") && !!bad.querySelector('[data-act="refresh"]'));

        // The first file
        await until("the first file's diff loads", () => stateTitle() === "Binary file, no text diff");
        check("the first file in tree order is picked", selPath() === "assets/logo.png" && H.row("assets/logo.png").getAttribute("aria-selected") === "true");
        check("the pick goes in the hash", hash().mode === "branch" && hash().repo === "app" && hash().path === "assets/logo.png");
        check("the diff request names the worker, repo, file, and comparison",
            lastDiff().sessionId === H.worker && lastDiff().repo === "app" && lastDiff().path === "assets/logo.png" && lastDiff().mode === "branch");
        check("a binary file shows its sizes", $(".cw-dbody .cw-state-text")?.textContent === "logo.png \u00b7 1.2 KB \u2192 2.3 KB");
        check("a binary file offers the IDEs", $$(".cw-dbody [data-act=ide]").length === 2);
        check("a state fills the diff pane", $(".cw-dbody .cw-state").offsetHeight >= $(".cw-dbody").clientHeight - 1);
        check("the header names the repo when there are two",
            $(".cw-dhead .cw-drepo")?.textContent === "ado-pr-ops" && $(".cw-dhead .cw-ddir")?.textContent === "assets/" && $(".cw-dhead .cw-dname")?.textContent === "logo.png");
        check("the header shows the status and position", $(".cw-dhead .cw-pill").textContent === "Modified" && pos() === "1 of 9");
        check("the first file can't go back", $(".cw-dhead [data-act=prev]").disabled && !$(".cw-dhead [data-act=next]").disabled);
        check("the status line shows the comparison", $(".cw-status-repo").textContent === "ado-pr-ops" && $(".cw-status-cmp").textContent === "merge-base abc1234 \u2192 working tree");

        // Stepping through every kind of diff
        let n = diffs();
        press(body, "ArrowDown", { altKey: true });
        await until("Alt+Down shows the next file", () => stateTitle() === "This diff is too big to show here");
        check("the next file is picked and in the hash", selPath() === "big/data.json" && pos() === "2 of 9" && hash().path === "big/data.json");
        check("a too-big diff says why", $(".cw-dbody .cw-state.caution .cw-state-text")?.textContent === "9,012 lines. The limit is 6,000 per side.");
        check("each new file loads its diff once", diffs() === n + 1);

        $(".cw-dhead [data-act=next]").click();
        await until("Next shows the rename", () => stateTitle() === "Renamed, no line changes");
        check("a rename shows where it came from", $(".cw-dhead .cw-dfrom")?.textContent === "from docs/old.md" && $(".cw-dhead .cw-pill").textContent === "Renamed");
        check("a rename's request sends the old path", lastDiff().oldPath === "docs/old.md");

        $(".cw-dhead [data-act=next]").click();
        await until("the deleted file loads", () => !!$(".cw-dbody .cw-dnote"));
        check("a deleted file shows the lines it had", $$(".cw-dbody table.diff tr.del").length === 3 && $(".cw-dhead .cw-dpath").classList.contains("del") && $(".cw-dhead .cw-pill").textContent === "Deleted");

        $(".cw-dhead [data-act=next]").click();
        await until("a text diff loads", () => diffFor("src/worker-changes.mts") && !$(".cw-dbody .cw-dnote"));
        check("a text diff has its rows", $$(".cw-dbody table.diff tr.add").length === 1 && $$(".cw-dbody table.diff tr.del").length === 1);

        H.row("empty.txt").click();
        await until("clicking a row picks it", () => stateTitle() === "Empty file");
        check("only one row is selected", $$(".cw-file.sel").length === 1 && pos() === "8 of 9");

        press(body, "ArrowDown", { altKey: true });
        await until("the last file loads", () => diffFor("README.md"));
        check("the last file can't go forward", pos() === "9 of 9" && $(".cw-dhead [data-act=next]").disabled && !$(".cw-dhead [data-act=prev]").disabled);
        n = diffs();
        press(body, "ArrowDown", { altKey: true });
        await sleep(50);
        check("Alt+Down on the last file stays put", selPath() === "README.md" && diffs() === n);
        press(body, "ArrowUp", { altKey: true });
        await until("Alt+Up goes back", () => selPath() === "empty.txt" && stateTitle() === "Empty file");

        // Tree keys
        H.row("empty.txt").focus();
        press(H.row("empty.txt"), "ArrowUp");
        check("Up moves focus in the tree", document.activeElement === H.row("web/src/workerChanges.ts"));
        check("the tree has one tab stop", $$(".cw-tree [role=treeitem]").filter((r) => r.tabIndex === 0).length === 1 && H.row("web/src/workerChanges.ts").tabIndex === 0);
        press(document.activeElement, "Enter");
        await until("Enter picks the focused file", () => diffFor("web/src/workerChanges.ts"));
        const dir = () => $$(".cw-dir").find((r) => r.querySelector(".cw-nm").textContent === "web/src");
        press(document.activeElement, "ArrowLeft");
        check("Left on a file goes to its folder", document.activeElement === dir());
        press(dir(), "ArrowLeft");
        check("Left on an open folder closes it", dir().getAttribute("aria-expanded") === "false" && !H.row("web/src/code.ts") && document.activeElement === dir());
        press(dir(), "ArrowRight");
        check("Right opens it again", dir().getAttribute("aria-expanded") === "true" && !!H.row("web/src/code.ts"));
        press(dir(), "Home");
        check("Home goes to the first row", document.activeElement === $(".cw-repo"));
        press(document.activeElement, "End");
        check("End goes to the last row", document.activeElement === $$(".cw-tree [role=treeitem]").at(-1));
        H.row("web/src/workerChanges.ts").focus();
        press(document.activeElement, "ArrowDown", { altKey: true });
        await until("Alt+Down from the tree picks the next file", () => selPath() === "empty.txt");
        check("Alt+Down from the tree takes focus along", document.activeElement === H.row("empty.txt"));
        press(document.activeElement, "ArrowUp", { altKey: true });
        await until("Alt+Up from the tree goes back", () => diffFor("web/src/workerChanges.ts"));

        // Comparisons
        S.hold = deferred();
        n = diffs();
        seg("uncommitted").click();
        check("a switch dims the old comparison", stale());
        check("a switch shows at once", seg("uncommitted").classList.contains("on") && $(".cw-mode-select").value === "uncommitted" && hash().mode === "uncommitted");
        check("a switch asks for the new comparison", calls.list.at(-1).mode === "uncommitted");
        S.hold.resolve();
        S.hold = null;
        await until("the uncommitted list lands", () => !stale() && !!H.row("notes.md"));
        await until("the same file reloads for the new comparison", () => diffs() === n + 1 && diffFor("web/src/workerChanges.ts"));
        check("the picked file stays picked", selPath() === "web/src/workerChanges.ts" && lastDiff().mode === "uncommitted");
        check("uncommitted totals", $(".cw-totals").textContent === "2 files +8\u22121");
        check("uncommitted says what it's on top of", $(".cw-meta.cw-from")?.textContent === "on top of def5678");
        check("uncommitted status line", $(".cw-status-cmp").textContent === "HEAD def5678 \u2192 working tree" && pos() === "1 of 2");

        $(".cw-mode-select").value = "last";
        $(".cw-mode-select").dispatchEvent(new Event("change", { bubbles: true }));
        await until("a worker with no commits says so", () => stateTitle() === "atlas hasn't committed yet");
        check("no file means no diff header", $(".cw-dhead").hidden);
        check("the repo shows its note", $$(".cw-meta").some((m) => m.textContent === "No commits on devis/atlas yet."));
        check("the picker says there are no files", $(".cw-pick-nm").textContent === "No changed files" && $(".cw-pick").disabled);
        $('.cw-dbody [data-act="mode"][data-mode="uncommitted"]').click();
        await until("the state's button switches comparisons", () => hash().mode === "uncommitted" && !stale() && diffFor("web/src/workerChanges.ts"));
        check("a comparison with no files keeps your file for the next one", selPath() === "web/src/workerChanges.ts");

        seg("uncommitted").focus();
        press(seg("uncommitted"), "ArrowLeft");
        check("arrow keys move between comparisons", hash().mode === "branch" && document.activeElement === seg("branch") && seg("branch").tabIndex === 0 && seg("uncommitted").tabIndex === -1);
        await until("the branch list lands", () => !stale() && !!H.row("README.md") && diffFor("web/src/workerChanges.ts"));

        // Empty and failed lists
        S.lists.branch = [H.app([]), H.lib([])];
        press(body, "F5");
        await until("an empty branch says No changes yet", () => stateTitle() === "No changes yet");
        check("no files, no totals", $(".cw-totals").textContent.trim() === "0 files");
        S.lists.uncommitted = [H.app([]), H.lib([])];
        seg("uncommitted").click();
        await until("Nothing uncommitted", () => stateTitle() === "Nothing uncommitted" && !!$('.cw-dbody [data-act="mode"][data-mode="branch"]'));
        S.lists.last = [H.app([]), H.lib([], { note: "No commits on devis/atlas yet." })];
        seg("last").click();
        await until("an empty last commit", () => stateTitle() === "The last commit changed no files");
        S.lists.last = [];
        press(body, "F5");
        await until("no repos", () => stateTitle() === "No repos to compare");
        check("no repos, empty tree", $(".cw-tree").children.length === 0);
        S.lists.last = [H.app([], { error: "fatal: bad revision 'HEAD~1'" }), H.lib([], { error: "fatal: bad object" })];
        press(body, "F5");
        await until("every repo failing", () => stateTitle() === "Couldn't read changes");
        check("it shows the first error, with Retry", $(".cw-dbody .cw-state-code")?.textContent === "fatal: bad revision 'HEAD~1'" && !!$('.cw-dbody [data-act="refresh"]'));
        H.reset();
        seg("branch").click();
        await until("back to the branch", () => !stale() && diffFor("web/src/workerChanges.ts"));

        // Failures
        S.diffStatus = 500;
        S.diffError = "git diff exited 128";
        H.row("README.md").click();
        await until("a failed diff says so", () => stateTitle() === "Couldn't load this diff");
        check("it shows the reason", $(".cw-dbody .cw-state-code")?.textContent === "git diff exited 128");
        S.diffStatus = 200;
        $('.cw-dbody [data-act="retry-diff"]').click();
        await until("Retry loads the diff", () => diffFor("README.md"));

        S.listStatus = 500;
        S.listError = "git status timed out";
        press(body, "F5");
        await until("a failed refresh shows a banner", () => !$(".cw-banner").hidden && $(".cw-banner").classList.contains("bad"));
        check("the banner says why", $(".cw-banner").textContent.includes("Couldn't refresh.") && $(".cw-banner").textContent.includes("git status timed out"));
        check("a failed refresh keeps what's on screen", !!H.row("README.md") && diffFor("README.md"));
        check("the time says it's stale", $(".cw-updated").textContent.startsWith("Last updated"));
        S.listStatus = 200;
        $('.cw-banner [data-act="refresh"]').click();
        await until("Retry clears the banner", () => $(".cw-banner").hidden);
        check("the time is fresh again", $(".cw-updated").textContent === "Updated just now");

        S.offline = true;
        press(body, "F5");
        await until("offline shows Reconnecting", () => !$(".cw-banner").hidden && $(".cw-banner").classList.contains("caution"));
        check("the banner says it's reconnecting", $(".cw-banner").textContent.includes("Reconnecting."));
        check("offline keeps the diff", diffFor("README.md"));
        S.offline = false;
        press(body, "r", { ctrlKey: true });
        await until("Ctrl+R reconnects", () => $(".cw-banner").hidden);

        n = calls.list.length;
        $('.cw-meta.bad [data-act="refresh"]').click();
        await until("a repo's Retry refreshes", () => calls.list.length === n + 1 && !$(".cw-toolbar .cw-spinning"));
        $('.cw-toolbar [data-act="refresh"]').click();
        await until("the toolbar's Refresh refreshes", () => calls.list.length === n + 2 && !$(".cw-toolbar .cw-spinning"));

        // IDE buttons
        const ide = (id) => $(`#cw-open-in [data-ide="${id}"]`);
        $('[popovertarget="cw-open-in"]').click();
        check("Open in shows the icon-only panel", $("#cw-open-in").matches(":popover-open") && ide("vscode").textContent.trim() === "" && ide("vscode-insiders").textContent.trim() === "");
        ide("vscode").click();
        check("a launch disables its button", ide("vscode").disabled);
        await until("the launch finishes", () => !ide("vscode").disabled);
        check("launch completion keeps keyboard focus on the chosen IDE", document.activeElement === ide("vscode"));
        check("the launch names this worker", JSON.stringify(calls.ide.at(-1)) === JSON.stringify({ sessionId: H.worker, ide: "vscode" }));
        check("the panel stays open after launching", $("#cw-open-in").matches(":popover-open"));
        check("a launch that works says nothing", $(".cw-banner").hidden);
        S.ideStatus = 409;
        S.ideError = "VSCode Insiders was not found.";
        ide("vscode-insiders").click();
        await until("a failed launch shows a notice", () => !$(".cw-banner").hidden);
        check("the notice says which IDE and why", $(".cw-banner").textContent.includes("Couldn't open VSCode Insiders. VSCode Insiders was not found."));
        $('.cw-banner [data-act="dismiss"]').click();
        check("Dismiss hides the notice", $(".cw-banner").hidden);
        S.ideStatus = 200;
        press(ide("vscode-insiders"), "Escape");
        check("Escape closes the IDE panel and restores focus", !$("#cw-open-in").matches(":popover-open") && document.activeElement.matches('[popovertarget="cw-open-in"]'));

        // The splitter
        const grip = $(".cw-grip");
        const now = () => grip.getAttribute("aria-valuenow");
        const side = () => Math.round($(".cw-side").getBoundingClientRect().width);
        check("the tree starts at 300px", $("#code").style.getPropertyValue("--cw-tree") === "300px" && now() === "300" && side() === 300);
        grip.focus();
        press(grip, "ArrowRight");
        check("Right widens the tree by 16", now() === "316");
        press(grip, "ArrowRight", { shiftKey: true });
        check("Shift+Right widens it by 64, and it's saved", now() === "380" && localStorage.getItem("devis.codeWindow.treeWidth") === "380");
        // With reduced motion on, style.css gives every element a 0.01ms transition.
        // A hidden window never ticks frames, so finish them before measuring.
        document.getAnimations().forEach((a) => a instanceof CSSTransition && a.finish());
        check(`the tree follows the grip (got ${side()})`, side() === 380);
        press(grip, "Home");
        press(grip, "ArrowLeft");
        check("the tree stops at 200", now() === "200");
        press(grip, "End");
        check("the tree stops at half the window", now() === String(Math.floor(innerWidth / 2)) && grip.getAttribute("aria-valuemax") === now());
        grip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        check("double-click resets it", now() === "300" && localStorage.getItem("devis.codeWindow.treeWidth") === "300");

        // A new view on the same window comes back to the same spot
        seg("uncommitted").click();
        await until("uncommitted again", () => !stale() && !!H.row("notes.md"));
        H.row("notes.md").click();
        await until("notes.md loads", () => diffFor("notes.md"));
        check("the hash has the comparison and file", hash().mode === "uncommitted" && hash().repo === "app" && hash().path === "notes.md");
        H.destroy();
        check("destroy empties the window", $("#code").childElementCount === 0 && !stale());
        n = calls.list.length;
        await H.mount(H.slow);
        await until("a new view restores the file", () => selPath() === "notes.md" && diffFor("notes.md"));
        check("and the comparison", calls.list[n]?.mode === "uncommitted" && seg("uncommitted").classList.contains("on"));
        n = diffs();
        $(".cw-dhead [data-act=prev]").click();
        await until("Prev works in the new view", () => diffFor("web/src/workerChanges.ts"));
        await sleep(50);
        check("the old view doesn't answer clicks", diffs() === n + 1);

        // Removed
        $('[popovertarget="cw-open-in"]').click();
        S.listStatus = 404;
        S.listError = "No such worker.";
        n = calls.list.length;
        press(body, "F5");
        await until("a removed worker shows so", () => $("#code").classList.contains("cw-is-removed"));
        check("removing a worker closes its IDE panel", !$("#cw-open-in").matches(":popover-open"));
        check("it says who", $(".cw-gone .cw-state-title")?.textContent === "atlas was removed" && !$(".cw-gone").hidden);
        check("it hides the tree, picker, and status line", $(".cw-split").hidden && $(".cw-picker").hidden && $(".cw-status").hidden);
        check("it turns off the toolbar", $$(".cw-toolbar button, .cw-toolbar select").every((c) => c.disabled));
        check("the chip says Removed", $(".cw-chip-st").textContent === "Removed" && $(".cw-dot").dataset.tone === "off");
        check("it offers to close", !!$('.cw-gone [data-act="close"]'));
        press(body, "F5");
        await sleep(50);
        check("a removed worker isn't asked again", calls.list.length === n + 1);
        H.destroy();
        check("destroy clears the removed look", !$("#code").classList.contains("cw-is-removed"));
        H.reset();
        check("no other API was called", calls.other.length === 0);
        void key;
    });
}

function poll() {
    return H.run("polling", async () => {
        const { S, calls, check, until, sleep, $, selPath, stateTitle, hash, diffFor } = H;
        const since = (t) => calls.list.filter((c) => c.t >= t);
        const gaps = (list) => list.slice(1).map((c, i) => c.t - list[i].t);
        H.reset();
        history.replaceState(null, "", "#mode=branch&repo=app&path=gone.ts");
        await H.mount({ busy: 80, idle: 300, retry: 40, retryMax: 80, settle: 20, tick: 50, focusGap: 600000 });
        await until("a hash file that's gone falls back to the first file", () => selPath() === "assets/logo.png" && stateTitle() === "Binary file, no text diff");
        check("the hash is fixed", hash().path === "assets/logo.png");
        H.row("src/worker-changes.mts").click();
        await until("the text diff loads", () => diffFor("src/worker-changes.mts"));

        const l = calls.list.length;
        const d = calls.diff.length;
        $('[popovertarget="cw-open-in"]').click();
        const openPanel = $("#cw-open-in");
        await sleep(700);
        check("idle polls keep coming", calls.list.length - l >= 2);
        check("polling preserves the open IDE panel", $("#cw-open-in") === openPanel && openPanel.matches(":popover-open"));
        check("polls that change nothing leave the diff alone", calls.diff.length === d);
        check("the time keeps ticking", $(".cw-updated").textContent.startsWith("Updated"));
        S.lists.branch[0].files.find((f) => f.path === "src/worker-changes.mts").added = 81;
        await until("a changed file reloads its diff", () => calls.diff.length === d + 1, 1500);
        await until("the tree shows the new count", () => H.row("src/worker-changes.mts").textContent.includes("+81"));
        await until("the reloaded diff lands", () => !$(".cw-dbody").hasAttribute("aria-busy"));
        check("a reload keeps the diff in place", diffFor("src/worker-changes.mts") && !$(".cw-dbody .cw-skeleton"));

        S.worker.busy = true;
        await until("a busy worker shows Working", () => $(".cw-chip-st").textContent === "Working" && $(".cw-dot").dataset.tone === "run", 1500);
        let t0 = performance.now();
        await sleep(400);
        check("a busy worker is polled faster", since(t0).length >= 3);

        S.worker.busy = false;
        t0 = performance.now();
        await sleep(500);
        const after = gaps(since(t0));
        check(`one quick poll follows the last busy one (gaps ${after.map(Math.round).join(", ")})`, after.length >= 2 && after[0] < 150 && after[1] >= 250);
        check("the chip settles", $(".cw-chip-st").textContent === "Turn done");

        S.offline = true;
        t0 = performance.now();
        await until("a poll notices the service is gone", () => !$(".cw-banner").hidden && $(".cw-banner").classList.contains("caution"), 1500);
        await sleep(400);
        const off = gaps(since(t0));
        check(`offline retries back off to the cap (gaps ${off.map(Math.round).join(", ")})`, off.length >= 3 && off[0] < 80 && off.every((g) => g < 160));
        check("offline keeps the diff", diffFor("src/worker-changes.mts"));
        S.offline = false;
        await until("polling reconnects by itself", () => $(".cw-banner").hidden, 1000);
        t0 = performance.now();
        await sleep(250);
        check("after reconnecting, polls slow back down", since(t0).length <= 1);

        const before = calls.list.length;
        H.destroy();
        check("destroy removes the open IDE panel", !openPanel.isConnected && !document.querySelector(".ide-panel:popover-open"));
        await sleep(400);
        check("destroy stops polling", calls.list.length === before);
    });
}

function narrow() {
    return H.run("narrow", async () => {
        const { calls, check, until, $, $$, press, key, stateTitle, hash, diffFor } = H;
        const shown = (sel) => !!$(sel) && $(sel).getClientRects().length > 0;
        H.reset();
        history.replaceState(null, "", "/");
        check("the window is narrow", innerWidth === 600);
        await H.mount(H.slow);
        await until("the narrow view loads", () => $(".cw-pick-nm").textContent === "logo.png" && stateTitle() === "Binary file, no text diff");
        check("the picker replaces the tree", shown(".cw-picker") && !shown(".cw-side") && !shown(".cw-grip"));
        check("the comparison is a dropdown", shown(".cw-mode-select") && !shown(".cw-seg"));
        check("Open in stays visible at narrow widths", shown('.cw-toolbar .ide-trigger') && !shown("#cw-open-in"));
        check("the diff header drops its own nav", !shown(".cw-dhead .cw-nav") && !shown(".cw-dhead .cw-pos"));
        check("the picker shows the position", $(".cw-pick-pos").textContent === "1/9" && $('.cw-picker [data-act="prev"]').disabled);
        check("a state fills the pane", $(".cw-dbody .cw-state").offsetHeight >= $(".cw-dbody").clientHeight - 1);
        $('[popovertarget="cw-open-in"]').click();
        $('[popovertarget="cw-file-open-in"]').click();
        check("a file's Open in uses the same panel and closes the toolbar panel", $("#cw-file-open-in").matches(":popover-open") && !$("#cw-open-in").matches(":popover-open"));
        press(document.body, "Escape");
        $('.cw-picker [data-act="next"]').click();
        await until("the picker's next button steps", () => $(".cw-pick-nm").textContent === "data.json" && $(".cw-pick-pos").textContent === "2/9");

        const pick = $(".cw-pick");
        const dd = $(".cw-dd");
        const filter = $(".cw-filter input");
        const type = (text) => {
            filter.value = text;
            filter.dispatchEvent(new Event("input", { bubbles: true }));
        };
        pick.click();
        check("the picker opens on the filter", !dd.hidden && pick.getAttribute("aria-expanded") === "true" && document.activeElement === filter);
        check("it lists every changed file", $$(".cw-opt").length === 9);
        check("the current file is active", $(".cw-opt.active")?.dataset.key === key("big/data.json") && filter.getAttribute("aria-activedescendant") === $(".cw-opt.active")?.id);
        type("work");
        check("the filter narrows the list", $$(".cw-opt").map((o) => o.title).join("|") === "src/worker-changes.mts|web/src/workerChanges.ts");
        press(filter, "ArrowDown");
        press(filter, "Enter");
        check("Enter picks and closes", dd.hidden && document.activeElement === pick);
        await until("the picked file loads", () => $(".cw-pick-nm").textContent === "workerChanges.ts" && diffFor("web/src/workerChanges.ts"));
        pick.click();
        type("zzz");
        check("no matches says so", $(".cw-pick-empty")?.textContent === "No files match.");
        press(filter, "Escape");
        check("Escape closes and gives focus back", dd.hidden && document.activeElement === pick);
        pick.click();
        document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        check("a click outside closes it", dd.hidden);
        pick.click();
        $$(".cw-opt").find((o) => o.title === "README.md").click();
        await until("clicking an option picks it", () => dd.hidden && $(".cw-pick-nm").textContent === "README.md" && diffFor("README.md"));

        const menu = $("#cw-open-in");
        const trigger = $('[popovertarget="cw-open-in"]');
        trigger.click();
        check("the IDE panel opens", menu.matches(":popover-open"));
        press(document.body, "Escape");
        check("Escape closes the IDE panel", !menu.matches(":popover-open") && document.activeElement === trigger);
        trigger.click();
        const n = calls.ide.length;
        menu.querySelector('[data-ide="vscode"]').click();
        await until("the menu launches", () => calls.ide.length === n + 1);
        check("the panel stays open after a launch", menu.matches(":popover-open") && calls.ide.at(-1).ide === "vscode");
        trigger.click();

        $(".cw-mode-select").value = "uncommitted";
        $(".cw-mode-select").dispatchEvent(new Event("change", { bubbles: true }));
        await until("the dropdown switches comparisons", () => hash().mode === "uncommitted" && $(".cw-pick-pos").textContent === "1/2");
        H.destroy();
    });
}

function layout(width) {
    return H.run(`layout ${width}`, async () => {
        const { check, until, sleep, $, $$, diffFor } = H;
        if (!H.view) {
            H.reset();
            history.replaceState(null, "", "#mode=branch&repo=app&path=web%2Fsrc%2FworkerChanges.ts");
            await H.mount(H.slow);
        }
        await until("the diff shows", () => diffFor("web/src/workerChanges.ts"));
        await sleep(50);
        const visible = (sel) => !!$(sel) && $(sel).getClientRects().length > 0;
        const box = (sel) => $(sel).getBoundingClientRect();
        const pane = box("#code");
        const inside = (sel) => $$(sel).filter((el) => el.getClientRects().length).every((el) => {
            const r = el.getBoundingClientRect();
            return r.left >= pane.left - 1 && r.right <= pane.right + 1;
        });
        check(`the viewport is ${width}px (got ${innerWidth})`, Math.abs(innerWidth - width) <= 1);
        check("nothing scrolls sideways", document.documentElement.scrollWidth <= innerWidth + 1 && document.body.scrollWidth <= innerWidth + 1);
        check("the toolbar fits", inside(".cw-toolbar > *"));
        const tops = $$(".cw-toolbar > *").filter((el) => el.getClientRects().length).map((el) => el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2);
        check("the toolbar is one row", Math.max(...tops) - Math.min(...tops) <= 4);
        check("the chip's tooltip names the worker and state", $(".cw-chip").title === "atlas \u00b7 Turn done");
        check("the diff header fits", inside(".cw-dhead > *"));
        check("the picker fits", inside(".cw-picker > *"));
        check("the status line is one line", box(".cw-status").height <= 26);
        check("the diff has room", box(".cw-dbody").height > 300);
        if (width >= 900) {
            check("the tree shows, the picker doesn't", visible(".cw-side") && !visible(".cw-picker"));
            check("the tree keeps its width", Math.abs(box(".cw-side").width - 300) <= 1);
        } else {
            check("the picker shows, the tree doesn't", visible(".cw-picker") && !visible(".cw-side"));
        }
        check("the update time shows only with room", visible(".cw-updated") === width >= 600);
        const trigger = $('.cw-toolbar .ide-trigger');
        const panel = $("#cw-open-in");
        if (!panel.matches(":popover-open")) trigger.click();
        await until("both bundled IDE icons load", () => [...panel.querySelectorAll("img")].every((img) => img.complete && img.naturalWidth > 0));
        document.getAnimations().forEach((a) => { if (a instanceof CSSTransition) a.finish(); });
        const p = panel.getBoundingClientRect();
        const t = trigger.getBoundingClientRect();
        check("the IDE panel fits the viewport", p.left >= 0 && p.right <= innerWidth && p.top >= 0 && p.bottom <= innerHeight);
        check("the IDE panel stays beside Open in", Math.min(Math.abs(p.left - t.right), Math.abs(t.left - p.right)) <= 8 &&
            Math.abs(p.top + p.height / 2 - t.top - t.height / 2) <= 1);
        return { width: innerWidth };
    });
}

async function entryBad() {
    const title = document.querySelector(".cw-gone .cw-state-title")?.textContent;
    return { failures: title === "This window needs a worker" ? [] : [`entry: a bad worker id shows a message (got ${title})`] };
}

async function entryGood() {
    const failures = [];
    for (let i = 0; i < 300 && !document.querySelector(".cw-dbody table.diff"); i++) await new Promise((r) => setTimeout(r, 10));
    if (!document.querySelector(".cw-dbody table.diff")) failures.push("entry: code.html loads the worker's diff");
    if (document.title !== "atlas \u00b7 Worker workspace \u00b7 Changes") failures.push(`entry: the window title names the worker and task (got ${document.title})`);
    if (document.getElementById("codeTitle")?.textContent !== "atlas \u00b7 Worker workspace") failures.push("entry: the title bar names the worker and task");
    return { failures };
}

// ---- the Electron side ----------------------------------------------------------------------

const call = (fn, ...args) => `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(", ")})`;
const steps = {
    setup: call(setup, WORKER),
    wide: call(wide),
    poll: call(poll),
    narrow: call(narrow),
    layout: WIDTHS.map((w) => [w, call(layout, w)]),
    entryBad: call(entryBad),
    entryGood: call(entryGood),
};

try {
    if (shots) mkdirSync(shots, { recursive: true });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const main = join(root, "main.cjs");
    writeFileSync(main, `
        const { app, BrowserWindow } = require("electron");
        const { writeFileSync } = require("node:fs");
        const { join } = require("node:path");
        const steps = ${JSON.stringify(steps)};
        const url = ${JSON.stringify(url)};
        const shots = ${JSON.stringify(shots)};
        const prefs = { sandbox: true, contextIsolation: true, backgroundThrottling: false };
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        app.setPath("userData", ${JSON.stringify(join(root, "profile"))});
        app.whenReady().then(async () => {
            const out = { failures: [], widths: [] };
            const run = async (win, code) => {
                const r = await win.webContents.executeJavaScript(code);
                out.failures.push(...r.failures);
                return r;
            };
            // Wider than the screen allows, zoom out so the page still sees the width it asked for.
            // A hidden window sometimes misses a resize, so wait for the page to agree and nudge it if not.
            const size = async (win, width, height) => {
                for (let i = 0; i < 20; i++) {
                    win.setContentSize(Math.min(width, 1600) - (i % 2), height);
                    await wait(100);
                    if (i % 2) continue;
                    win.webContents.setZoomFactor(win.getContentSize()[0] / width);
                    await wait(150);
                    if (Math.abs((await win.webContents.executeJavaScript("innerWidth")) - width) <= 1) break;
                }
                await wait(100);
            };
            try {
                const win = new BrowserWindow({ show: false, useContentSize: true, width: 1440, height: 900, webPreferences: prefs });
                await win.loadURL(url);
                await run(win, steps.setup);
                await run(win, steps.wide);
                await run(win, steps.poll);
                await size(win, 600, 800);
                await run(win, steps.narrow);
                for (const [width, code] of steps.layout) {
                    await size(win, width, 900);
                    const r = await run(win, code);
                    out.widths.push(r.width + "/" + win.getContentSize()[0] + "@" + win.webContents.getZoomFactor().toFixed(3));
                    if (shots) {
                        // A hidden window may not repaint after the view remounts, so nudge it first.
                        const [w, h] = win.getContentSize();
                        win.setContentSize(w - 1, h);
                        await wait(150);
                        win.setContentSize(w, h);
                        await wait(250);
                        writeFileSync(join(shots, "code-" + width + ".png"), (await win.webContents.capturePage()).toPNG());
                    }
                }
                win.webContents.setZoomFactor(1);
                const entry = new BrowserWindow({ show: false, width: 1100, height: 700, webPreferences: prefs });
                await entry.loadURL(url + "code.html?worker=not-a-worker");
                await run(entry, steps.entryBad);
                await entry.loadURL(url + "code.html?worker=" + ${JSON.stringify(WORKER)});
                await run(entry, steps.entryGood);
            } catch (error) {
                out.failures.push(String((error && error.stack) || error));
            }
            process.stdout.write("RESULT " + JSON.stringify(out) + "\\n");
            app.exit(0);
        });
    `);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await new Promise((resolve, reject) => {
        const child = spawn(electron, [main], { env, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        let errors = "";
        const timeout = setTimeout(() => { child.kill(); reject(new Error("Electron UI test timed out")); }, 120_000);
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
    assert.deepEqual(result.failures, [], result.failures.join("\n") + "\nwidths " + result.widths.join(", "));
    console.log(`worker-changes-ui-harness: ok (widths ${result.widths.join(", ")})`);
} finally {
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
}
