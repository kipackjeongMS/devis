// Tests the Artifacts window (src/artifacts-window.mts): which window.open URLs ask for a task's window, the
// hash that names its file (and that the page's helpers in web/src/artifactsWindow.ts write the same one), where
// it opens, the controller that keeps one window per task, and that its file names are the store's.
// Run after `npm run build`: node scripts/artifacts-window-harness.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "artifacts-window-"));
process.env.ADO_PR_OPS_DB_PATH = join(root, "data", "reviews.db");
process.env.ADO_PR_OPS_JARVIS_DIR = join(root, "jarvis");

const {
    ARTIFACTS_WINDOW_MIN,
    ARTIFACTS_WINDOW_SIZE,
    artifactsWindowHash,
    artifactsWindowTarget,
    artifactsWindowUrl,
    createArtifactsWindowController,
    isArtifactFileName,
    parseArtifactsHash,
    placeArtifactsWindow,
} = await import("../artifacts-window.mjs");
const { CASCADE_STEP, codeWindowWorker, isFocusMainUrl } = await import("../code-window.mjs");
const { prWindowTarget } = await import("../pr-window.mjs");
const { isTodosWindowUrl } = await import("../todos-window.mjs");
const { artifactName } = await import("../jarvis-store.mjs");
const { closeDb } = await import("../store.mjs");
const page = await import("../web/artifactsWindow.js");

const origin = "http://127.0.0.1:4317";
const task = "0f8fad5b-d9cb-469f-a165-70867728950e";
const other = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

try {
    // ---- which URLs ask for a task's Artifacts window ----
    assert.deepEqual(artifactsWindowTarget(`${origin}/artifacts.html?task=${task}`, origin), { task, file: null, edit: false });
    assert.deepEqual(artifactsWindowTarget(`${origin}/artifacts.html?task=${task}#file=design.md`, origin), { task, file: "design.md", edit: false });
    assert.deepEqual(artifactsWindowTarget(`${origin}/artifacts.html?task=${task}#file=design.md&edit=1`, origin), { task, file: "design.md", edit: true });
    assert.deepEqual(
        artifactsWindowTarget(`${origin}/artifacts.html?task=${task.toUpperCase()}&shell=glass#file=my+notes.md`, origin),
        { task, file: "my notes.md", edit: false },
        "the task is lower-cased, extra params are ignored, and the name is decoded",
    );
    assert.deepEqual(artifactsWindowTarget(`${origin}/artifacts.html?task=${task}#file=../x.md&edit=1`, origin), { task, file: null, edit: false }, "a bad file name is dropped, and edit with it");
    assert.deepEqual(artifactsWindowTarget(`${origin}/artifacts.html?task=${task}#edit=1`, origin), { task, file: null, edit: false }, "edit without a file means nothing");
    assert.equal(artifactsWindowTarget(`${origin}/artifacts.html`, origin), null, "no task");
    assert.equal(artifactsWindowTarget(`${origin}/artifacts.html?task=nope`, origin), null, "not a task id");
    assert.equal(artifactsWindowTarget(`${origin}/artifacts.html?task=${task}x`, origin), null, "not a task id");
    assert.equal(artifactsWindowTarget(`${origin}/artifacts.htm?task=${task}`, origin), null);
    assert.equal(artifactsWindowTarget(`${origin}/todos.html?task=${task}`, origin), null);
    assert.equal(artifactsWindowTarget(`${origin}/code.html?worker=x`, origin), null, "the code window is not an Artifacts window");
    assert.equal(artifactsWindowTarget(`http://127.0.0.1:9999/artifacts.html?task=${task}`, origin), null, "another port");
    assert.equal(artifactsWindowTarget(`https://evil.example/artifacts.html?task=${task}`, origin), null, "another host");
    assert.equal(artifactsWindowTarget(`${origin}/artifacts.html?task=${task}`, ""), null, "no origin yet");
    assert.equal(artifactsWindowTarget("not a url", origin), null);

    // ---- the URL the shell builds, and that no other window claims it ----
    const url = artifactsWindowUrl(origin, task, "#file=design.md&edit=1");
    assert.equal(url, `${origin}/artifacts.html?task=${task}#file=design.md&edit=1`);
    assert.deepEqual(artifactsWindowTarget(url, origin), { task, file: "design.md", edit: true }, "round trip");
    assert.equal(artifactsWindowUrl(origin, task), `${origin}/artifacts.html?task=${task}`);
    assert.equal(artifactsWindowUrl(origin, task, "#file=design.md&x=<script>"), `${origin}/artifacts.html?task=${task}#file=design.md`, "only the file and edit ride along");
    assert.equal(artifactsWindowUrl(origin, task, "#file=a/b.md"), `${origin}/artifacts.html?task=${task}`, "a bad name is dropped");
    for (const u of [url, artifactsWindowUrl(origin, task)]) {
        assert.equal(codeWindowWorker(u, origin), null, "never a code window");
        assert.equal(prWindowTarget(u, origin), null, "never the PR window");
        assert.equal(isFocusMainUrl(u, origin), false, "never focus-main");
        assert.equal(isTodosWindowUrl(u, origin), false, "never the to-dos window");
    }
    assert.ok(ARTIFACTS_WINDOW_MIN.width <= ARTIFACTS_WINDOW_SIZE.width && ARTIFACTS_WINDOW_MIN.height <= ARTIFACTS_WINDOW_SIZE.height, "the minimum fits in the default size");

    // ---- the hash: the shell's and the page's agree ----
    assert.equal(artifactsWindowHash({ file: "design.md" }), "#file=design.md");
    assert.equal(artifactsWindowHash({ file: "design.md", edit: true }), "#file=design.md&edit=1");
    assert.equal(artifactsWindowHash({ file: null, edit: true }), "");
    assert.equal(artifactsWindowHash({ file: "x.exe" }), "");
    assert.deepEqual(parseArtifactsHash(""), { file: null, edit: false });
    assert.deepEqual(parseArtifactsHash("#file=a.md&edit=0"), { file: "a.md", edit: false });
    assert.deepEqual(parseArtifactsHash("file=a.md&edit=1"), { file: "a.md", edit: true }, "without the #");
    for (const name of ["note.md", "recap.md", "my notes.md", "data-more.md", "R_1-2.MARKDOWN", "flow.mmd"]) {
        for (const edit of [false, true]) {
            const shell = artifactsWindowHash({ file: name, edit });
            assert.equal(page.artifactsHash(name, edit), shell, `the page writes the shell's hash for ${name}`);
            assert.deepEqual(page.readArtifactsHash(shell), { file: name, edit }, `the page reads the shell's hash for ${name}`);
            assert.deepEqual(parseArtifactsHash(page.artifactsHash(name, edit)), { file: name, edit });
            assert.deepEqual(artifactsWindowTarget(origin + page.artifactsWindowPath(task, name, edit), origin), { task, file: name, edit }, "the page's path asks for the window");
        }
    }
    assert.equal(page.artifactsHash(null, true), "");
    assert.deepEqual(page.readArtifactsHash("#edit=1"), { file: null, edit: false });
    assert.deepEqual(artifactsWindowTarget(origin + page.artifactsWindowPath(task), origin), { task, file: null, edit: false });

    // ---- file names: the shell takes exactly what the store does ----
    const storeTakes = (name) => {
        try {
            return artifactName(name) === name;
        } catch {
            return false;
        }
    };
    const good = ["note.md", "recap.md", "design.md", "My Notes.md", "data.json", "a.yaml", "b.yml", "c.csv", "d.log", "e.mmd", "f.txt", "g.markdown", "X_1-2.MD", "a".repeat(79) + ".md"];
    const bad = ["", "../x.md", "a/b.md", "a\\b.md", "con.md", "LPT1.txt", "nul", "com1.md", "x.exe", ".hidden.md", "x..md", "a".repeat(80) + ".md", "a".repeat(90) + ".md", " x.md", "x.md ", "x.md\n"];
    for (const name of good) {
        assert.equal(isArtifactFileName(name), true, `takes ${JSON.stringify(name)}`);
        assert.equal(storeTakes(name), true, `the store takes ${JSON.stringify(name)}`);
    }
    for (const name of bad) {
        assert.equal(isArtifactFileName(name), false, `refuses ${JSON.stringify(name)}`);
        assert.equal(storeTakes(name), false, `the store refuses ${JSON.stringify(name)}`);
    }
    assert.equal(isArtifactFileName(null), false);
    assert.equal(isArtifactFileName(42), false);

    // ---- where it opens ----
    const screen = { x: 0, y: 0, width: 1920, height: 1080 };
    const first = placeArtifactsWindow(screen);
    assert.deepEqual(first, { x: 420, y: 130, width: ARTIFACTS_WINDOW_SIZE.width, height: ARTIFACTS_WINDOW_SIZE.height }, "centred at its default size");
    const second = placeArtifactsWindow(screen, [first]);
    assert.deepEqual(second, { ...first, x: first.x + CASCADE_STEP, y: first.y + CASCADE_STEP }, "steps past one already there");
    assert.deepEqual(placeArtifactsWindow(screen, [first, second]), { ...first, x: first.x + 2 * CASCADE_STEP, y: first.y + 2 * CASCADE_STEP });
    assert.deepEqual(placeArtifactsWindow(screen, [{ ...first, x: 0 }]), first, "a window elsewhere doesn't move it");
    const small = { x: 100, y: 50, width: 800, height: 600 };
    const fit = placeArtifactsWindow(small);
    assert.deepEqual(fit, { x: 100, y: 50, width: 800, height: 600 }, "a small screen gets a smaller window");
    assert.deepEqual(placeArtifactsWindow(small, [fit]), fit, "no room to step, so it stays on screen");
    const wide = { x: 0, y: 0, width: 4000, height: 3000 };
    const big = placeArtifactsWindow(wide);
    const stack = Array.from({ length: 20 }, (_, i) => ({ ...big, x: big.x + i * CASCADE_STEP, y: big.y + i * CASCADE_STEP }));
    assert.deepEqual(placeArtifactsWindow(wide, stack), { ...big, x: big.x + 12 * CASCADE_STEP, y: big.y + 12 * CASCADE_STEP }, "it steps at most 12 times");

    // ---- the controller ----
    function rig() {
        const windows = [];
        let at = origin;
        const controller = createArtifactsWindowController({
            origin: () => at,
            create: (forTask) => {
                const w = {
                    id: windows.length + 1,
                    task: forTask,
                    destroyed: false,
                    reveals: 0,
                    selects: [],
                    loads: [],
                    pageHash: "",
                    isDestroyed: () => w.destroyed,
                    reveal: () => void w.reveals++,
                    select: (hash) => void w.selects.push(hash),
                    hash: () => w.pageHash,
                    load: (u, current) =>
                        new Promise((resolve) => {
                            w.loads.push({ url: u, current, resolve });
                        }),
                };
                windows.push(w);
                return w;
            },
        });
        return { controller, windows, setOrigin: (o) => (at = o) };
    }

    {
        // First open for a task creates its window on the file asked for; opening again brings it forward and
        // points it at the new file without reloading it.
        const { controller, windows } = rig();
        assert.equal(controller.count, 0);
        assert.equal(controller.isOpen(task), false);
        assert.equal(controller.open({ task, file: "design.md", edit: false }), "created");
        assert.equal(windows.length, 1);
        assert.equal(windows[0].task, task);
        assert.deepEqual(
            windows[0].loads.map((l) => l.url),
            [`${origin}/artifacts.html?task=${task}#file=design.md`],
        );
        assert.equal(windows[0].loads[0].current(), true);
        assert.equal(windows[0].reveals, 0, "a new window shows itself");
        assert.equal(controller.isOpen(task), true);

        assert.equal(controller.open({ task, file: "notes.md", edit: true }), "focused");
        assert.equal(controller.open({ task, file: null, edit: false }), "focused");
        assert.equal(windows.length, 1, "still one window for the task");
        assert.equal(windows[0].reveals, 2);
        assert.deepEqual(windows[0].selects, ["#file=notes.md&edit=1"], "a file is selected; no file only focuses");
        assert.equal(windows[0].loads.length, 1, "focusing does not reload it");

        // Another task gets a window of its own.
        assert.equal(controller.open({ task: other, file: null, edit: false }), "created");
        assert.equal(windows.length, 2);
        assert.equal(windows[1].loads[0].url, `${origin}/artifacts.html?task=${other}`);
        assert.equal(controller.count, 2);
        assert.equal(windows[0].reveals, 2, "the first task's window is left alone");
    }

    {
        // Closing lets the next open create a new one; the old window's pending load goes stale.
        const { controller, windows } = rig();
        controller.open({ task, file: null, edit: false });
        const old = windows[0];
        old.destroyed = true;
        controller.closed(task, old);
        assert.equal(controller.isOpen(task), false);
        assert.equal(controller.count, 0);
        assert.equal(old.loads[0].current(), false, "a closed window's load is stale");

        assert.equal(controller.open({ task, file: "design.md", edit: true }), "created");
        assert.equal(windows.length, 2);
        assert.equal(windows[1].loads[0].url, `${origin}/artifacts.html?task=${task}#file=design.md&edit=1`);
        assert.equal(windows[1].loads[0].current(), true);
        assert.equal(old.reveals, 0, "the closed window is never revealed");

        // A late "closed" from the old window, or one for another task, does not forget the new one.
        controller.closed(task, old);
        controller.closed(other, windows[1]);
        assert.equal(controller.isOpen(task), true);
        assert.equal(controller.open({ task, file: null, edit: false }), "focused");
        assert.equal(windows.length, 2);
    }

    {
        // A window destroyed before its closed event is not reused.
        const { controller, windows } = rig();
        controller.open({ task, file: null, edit: false });
        windows[0].destroyed = true;
        assert.equal(controller.isOpen(task), false);
        assert.equal(controller.count, 0);
        assert.equal(controller.open({ task, file: null, edit: false }), "created");
        assert.equal(windows.length, 2);
        assert.equal(windows[0].selects.length + windows[0].reveals, 0);
    }

    {
        // The service moved: each window reloads on the new origin with the file it has open, checked again, and
        // the older load is no longer current. A destroyed one is skipped.
        const { controller, windows, setOrigin } = rig();
        controller.moveTo("http://127.0.0.1:5000");
        assert.equal(windows.length, 0, "moving never creates a window");

        controller.open({ task, file: "design.md", edit: true });
        controller.open({ task: other, file: null, edit: false });
        const third = "0e5c3a9e-1b2d-4c3e-8f9a-0b1c2d3e4f50";
        controller.open({ task: third, file: null, edit: false });
        windows[0].pageHash = "#file=findings.md";
        windows[1].pageHash = "#file=../../etc.md&edit=1";
        windows[2].destroyed = true;
        const next = "http://127.0.0.1:5001";
        setOrigin(next);
        controller.moveTo(next);
        assert.deepEqual(windows[0].loads.map((l) => l.url), [`${origin}/artifacts.html?task=${task}#file=design.md&edit=1`, `${next}/artifacts.html?task=${task}#file=findings.md`]);
        assert.deepEqual(windows[1].loads.map((l) => l.url), [`${origin}/artifacts.html?task=${other}`, `${next}/artifacts.html?task=${other}`], "a bad hash is dropped");
        assert.equal(windows[2].loads.length, 1, "a destroyed window is not reloaded");
        assert.equal(windows[0].loads[0].current(), false, "the first load is stale");
        assert.equal(windows[0].loads[1].current(), true);

        // Moving again supersedes that load too.
        controller.moveTo("http://127.0.0.1:5002");
        assert.equal(windows[0].loads[1].current(), false);
        assert.equal(windows[0].loads[2].current(), true);
        for (const w of windows) w.loads.forEach((l) => l.resolve());
    }

    {
        // A load that fails does not throw out of open().
        const controller = createArtifactsWindowController({
            origin: () => origin,
            create: () => ({
                isDestroyed: () => false,
                reveal: () => undefined,
                select: () => undefined,
                hash: () => "",
                load: () => Promise.reject(new Error("gone")),
            }),
        });
        assert.equal(controller.open({ task, file: null, edit: false }), "created");
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(controller.isOpen(task), true);
    }

    console.log("artifacts-window harness: ok");
} finally {
    closeDb();
    rmSync(root, { recursive: true, force: true });
}
