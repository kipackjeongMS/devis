// Tests the to-dos window (src/todos-window.mts): which window.open URLs ask for it, the URL the shell
// builds, and the controller that keeps it to one window (open again focuses, close and reopen, moving
// with the service). Run after `npm run build:backend`: node scripts/todos-window-harness.mjs
import assert from "node:assert/strict";
import { codeWindowWorker, isFocusMainUrl } from "../code-window.mjs";
import { prWindowTarget } from "../pr-window.mjs";
import { createTodosWindowController, isTodosWindowUrl, TODOS_WINDOW_MIN, TODOS_WINDOW_SIZE, todosWindowUrl } from "../todos-window.mjs";

const origin = "http://127.0.0.1:4317";

// ---- which URLs ask for the to-dos window ----
assert.equal(isTodosWindowUrl(`${origin}/todos.html`, origin), true);
assert.equal(isTodosWindowUrl(`${origin}/todos.html?shell=glass#x`, origin), true, "extra params and hash ignored");
assert.equal(isTodosWindowUrl(`${origin}/todos.htm`, origin), false);
assert.equal(isTodosWindowUrl(`${origin}/code.html?worker=x`, origin), false, "the code window is not the to-dos window");
assert.equal(isTodosWindowUrl(`${origin}/?org=c&project=p&repoId=r&prId=1`, origin), false, "the PR window is not the to-dos window");
assert.equal(isTodosWindowUrl(`${origin}/`, origin), false);
assert.equal(isTodosWindowUrl(`http://127.0.0.1:9999/todos.html`, origin), false, "another port");
assert.equal(isTodosWindowUrl(`https://evil.example/todos.html`, origin), false, "another host");
assert.equal(isTodosWindowUrl(`${origin}/todos.html`, ""), false, "no origin yet");
assert.equal(isTodosWindowUrl("not a url", origin), false);

// ---- the URL the shell builds, and that no other window claims it ----
const url = todosWindowUrl(origin);
assert.equal(url, `${origin}/todos.html`);
assert.equal(isTodosWindowUrl(url, origin), true, "round trip");
assert.equal(codeWindowWorker(url, origin), null, "never a code window");
assert.equal(prWindowTarget(url, origin), null, "never the PR window");
assert.equal(isFocusMainUrl(url, origin), false, "never focus-main");
assert.ok(TODOS_WINDOW_MIN.width <= TODOS_WINDOW_SIZE.width && TODOS_WINDOW_MIN.height <= TODOS_WINDOW_SIZE.height, "the minimum fits in the default size");

// ---- the controller ----
function rig() {
    const windows = [];
    let at = origin;
    const controller = createTodosWindowController({
        origin: () => at,
        create: () => {
            const w = {
                id: windows.length + 1,
                destroyed: false,
                reveals: 0,
                loads: [],
                isDestroyed: () => w.destroyed,
                reveal: () => void w.reveals++,
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
    // First open creates and loads it; opening again only brings it forward, keeping what the user has in it.
    const { controller, windows } = rig();
    assert.equal(controller.alive, false);
    assert.equal(controller.open(), "created");
    assert.equal(windows.length, 1);
    assert.equal(windows[0].loads.length, 1);
    assert.equal(windows[0].loads[0].url, url);
    assert.equal(windows[0].loads[0].current(), true);
    assert.equal(controller.alive, true);

    assert.equal(controller.open(), "focused");
    assert.equal(controller.open(), "focused");
    assert.equal(windows.length, 1, "still one window");
    assert.equal(windows[0].reveals, 2);
    assert.equal(windows[0].loads.length, 1, "focusing does not reload it");
}

{
    // Closing lets the next open create a new one; the old window's pending load goes stale.
    const { controller, windows } = rig();
    controller.open();
    const first = windows[0];
    first.destroyed = true;
    controller.closed(first);
    assert.equal(controller.alive, false);
    assert.equal(first.loads[0].current(), false, "a closed window's load is stale");

    assert.equal(controller.open(), "created");
    assert.equal(windows.length, 2);
    assert.equal(windows[1].loads[0].current(), true);
    assert.equal(first.reveals, 0, "the closed window is never revealed");

    // A late "closed" from the old window does not forget the new one.
    controller.closed(first);
    assert.equal(controller.alive, true);
    assert.equal(controller.open(), "focused");
    assert.equal(windows.length, 2);
}

{
    // A window destroyed without its closed event yet is not reused.
    const { controller, windows } = rig();
    controller.open();
    windows[0].destroyed = true;
    assert.equal(controller.alive, false);
    assert.equal(controller.open(), "created");
    assert.equal(windows.length, 2);
}

{
    // The service moved: the window reloads on the new origin, and the older load is no longer current.
    const { controller, windows, setOrigin } = rig();
    controller.moveTo("http://127.0.0.1:5000");
    assert.equal(windows.length, 0, "moving never creates the window");

    controller.open();
    const next = "http://127.0.0.1:5001";
    setOrigin(next);
    controller.moveTo(next);
    assert.equal(windows.length, 1);
    assert.equal(windows[0].loads.length, 2);
    assert.equal(windows[0].loads[1].url, `${next}/todos.html`);
    assert.equal(windows[0].loads[0].current(), false, "the first load is stale");
    assert.equal(windows[0].loads[1].current(), true);
    windows[0].loads.forEach((l) => l.resolve());
}

{
    // A load that fails does not throw out of open().
    const windows = [];
    const controller = createTodosWindowController({
        origin: () => origin,
        create: () => {
            const w = { isDestroyed: () => false, reveal: () => undefined, load: () => Promise.reject(new Error("gone")) };
            windows.push(w);
            return w;
        },
    });
    assert.equal(controller.open(), "created");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(controller.alive, true);
}

console.log("todos-window harness: ok");
