// Tests the pull request window (src/pr-window.mts): which window.open URLs ask for it, the URL the
// shell builds, and the controller that keeps it to one window (re-targeting, latest open wins,
// close and reopen). Run after `npm run build:backend`: node scripts/pr-window-harness.mjs
import assert from "node:assert/strict";
import { codeWindowWorker } from "../code-window.mjs";
import { createPrWindowController, prWindowTarget, prWindowUrl, sameTarget } from "../pr-window.mjs";

const origin = "http://127.0.0.1:4317";
const a = { org: "contoso", project: "Web", repoId: "r-1", prId: "101" };
const b = { org: "contoso", project: "Web", repoId: "r-2", prId: "202" };

// ---- which URLs ask for the PR window ----
assert.deepEqual(prWindowTarget(`${origin}/?org=contoso&project=Web&repoId=r-1&prId=101`, origin), a);
assert.deepEqual(prWindowTarget(`${origin}/?org=contoso&project=Web&repoId=r-1&prId=101&shell=glass`, origin), a, "extra params ignored");
assert.equal(prWindowTarget(`${origin}/?org=contoso&project=Web&repoId=r-1&prId=0`, origin), null, "not a positive id");
assert.equal(prWindowTarget(`${origin}/?org=contoso&project=Web&repoId=r-1`, origin), null, "no prId");
assert.equal(prWindowTarget(`${origin}/?`, origin), null);
assert.equal(prWindowTarget(`${origin}/?focus=main`, origin), null, "back to the main window is not a PR");
assert.equal(prWindowTarget(`${origin}/?focus=main&org=c&project=p&repoId=r&prId=1`, origin), null);
assert.equal(prWindowTarget(`http://127.0.0.1:9999/?org=c&project=p&repoId=r&prId=1`, origin), null, "another port");
assert.equal(prWindowTarget(`https://evil.example/?org=c&project=p&repoId=r&prId=1`, origin), null, "another host");
assert.equal(prWindowTarget(`${origin}/code.html?org=c&project=p&repoId=r&prId=1`, origin), null, "another page");
assert.equal(prWindowTarget(`${origin}/?org=c&project=p&repoId=r&prId=1`, ""), null, "no origin yet");
assert.equal(prWindowTarget("not a url", origin), null);
assert.equal(codeWindowWorker(prWindowUrl(origin, a), origin), null, "a PR url never opens a code window");

// ---- the URL the shell builds ----
assert.equal(prWindowUrl(origin, a), `${origin}/?org=contoso&project=Web&repoId=r-1&prId=101`);
assert.deepEqual(prWindowTarget(prWindowUrl(origin, { org: "a b", project: "p&q", repoId: "r/1", prId: "7" }), origin), { org: "a b", project: "p&q", repoId: "r/1", prId: "7" }, "round trip with odd characters");
assert.equal(sameTarget(a, { ...a }), true);
assert.equal(sameTarget(a, b), false);
assert.equal(sameTarget(null, a), false);

// ---- the controller ----
function rig() {
    const windows = [];
    let nextId = 0;
    const controller = createPrWindowController({
        origin: () => origin,
        create: () => {
            const w = {
                id: ++nextId,
                destroyed: false,
                reveals: 0,
                loads: [],
                isDestroyed: () => w.destroyed,
                reveal: () => void w.reveals++,
                // A load stays pending until released, so a test can finish them out of order.
                load: (url, current) =>
                    new Promise((resolve) => {
                        w.loads.push({ url, current, resolve });
                    }),
            };
            windows.push(w);
            return w;
        },
    });
    return { controller, windows };
}

{
    // one window for any number of PRs
    const { controller, windows } = rig();
    assert.equal(controller.alive, false);
    assert.equal(controller.open(a), "created");
    assert.equal(windows.length, 1);
    assert.equal(windows[0].loads[0].url, prWindowUrl(origin, a));
    assert.equal(controller.open(b), "navigated");
    assert.equal(windows.length, 1, "PR B re-targets the same window");
    assert.equal(windows[0].reveals, 1, "and brings it forward");
    assert.equal(windows[0].loads[1].url, prWindowUrl(origin, b));
    assert.deepEqual(controller.target, b);
    assert.equal(controller.open(b), "focused", "the same PR only focuses");
    assert.equal(windows[0].loads.length, 2, "no reload for the same PR");
    assert.equal(windows[0].reveals, 2);
}
{
    // rapid switching: the latest open wins, earlier loads see they're stale
    const { controller, windows } = rig();
    const ids = ["1", "2", "3", "4", "5"];
    for (const prId of ids) controller.open({ ...a, prId });
    assert.equal(windows.length, 1);
    const { loads } = windows[0];
    assert.equal(loads.length, 5);
    assert.deepEqual(loads.map((l) => l.current()), [false, false, false, false, true], "only the last is current");
    assert.deepEqual(controller.target, { ...a, prId: "5" });
}
{
    // closing lets the next open recreate it; a stale load from the old window can't touch the new one
    const { controller, windows } = rig();
    controller.open(a);
    const old = windows[0];
    old.destroyed = true;
    controller.closed(old);
    assert.equal(controller.alive, false);
    assert.equal(controller.target, null);
    assert.equal(old.loads[0].current(), false, "a load for the closed window is stale");
    assert.equal(controller.open(a), "created");
    assert.equal(windows.length, 2, "reopened after close");
    assert.equal(windows[1].loads[0].current(), true);
    controller.closed(old);
    assert.equal(controller.alive, true, "a late close of the old window doesn't drop the new one");
}
{
    // a window destroyed without its closed event yet is replaced, not focused
    const { controller, windows } = rig();
    controller.open(a);
    windows[0].destroyed = true;
    assert.equal(controller.open(b), "created");
    assert.equal(windows.length, 2);
}
{
    // a load that rejects doesn't throw out of open()
    const rejecting = createPrWindowController({
        origin: () => origin,
        create: () => ({ isDestroyed: () => false, reveal() {}, load: () => Promise.reject(new Error("ERR_ABORTED")) }),
    });
    assert.equal(rejecting.open(a), "created");
}
{
    // the service moves to another port: the window follows, on the PR it shows
    const { controller, windows } = rig();
    controller.open(a);
    controller.moveTo("http://127.0.0.1:5000");
    assert.equal(windows[0].loads[1].url, prWindowUrl("http://127.0.0.1:5000", a));
    assert.equal(windows[0].loads[0].current(), false);
    const closed = rig();
    closed.controller.moveTo("http://127.0.0.1:5000");
    assert.equal(closed.windows.length, 0, "nothing to move when no window is up");
}

console.log("pr-window-harness: ok");
