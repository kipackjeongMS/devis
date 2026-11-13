// The shared Playwright server, run through the real process guard with a stand-in server
// (never the real Playwright): it stands in only for the user's own Playwright entry; it's
// ready once it says it's listening; it comes back on the same port after a crash, and on a
// new one when that fails; a start that hangs is cut off; stopping it ends its tree and lets
// waiters go; a service killed outright takes the server with it; and the switch turns it off.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { getPriority, constants, tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "shared-playwright-"));
const fake = join(root, "fake-server.mjs");
// Like Playwright over HTTP: says where it's listening, and doesn't notice its parent going.
writeFileSync(
    fake,
    `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const [mode, port, pidFile] = process.argv.slice(2);
writeFileSync(pidFile, String(process.pid));
if (mode === "fail") { console.error("fake: could not start"); process.exit(3); }
setInterval(() => {}, 1 << 30);
if (mode === "listen") {
    const server = createServer((req, res) => res.end(String(process.pid)));
    server.listen(Number(port), "127.0.0.1", () => console.log("Listening on http://127.0.0.1:" + server.address().port));
}
`,
);
const userConfig = { mcpServers: { ado: { type: "http", url: "https://example.test" }, browser: { type: "local", command: "npx", args: ["-y", "@playwright/mcp@latest"], tools: ["browser_navigate"] } } };

let fresh = 0;
const load = () => import(`../shared-playwright.mjs?case=${++fresh}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what, ms = 15_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const value = await check();
        if (value) return value;
        await sleep(50);
    }
    assert.fail(`timed out waiting for ${what}`);
}
const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === "EPERM";
    }
};
let pidFiles = 0;
const nextPidFile = () => join(root, `server-${++pidFiles}.pid`);
const pidIn = (file) => until(() => existsSync(file) && Number(readFileSync(file, "utf8")) || 0, `the server's pid in ${file}`);
const leftover = [];

/** A shared server over the stand-in, which runs each launch in the next mode (then "listen"). */
function standIn(sp, modes, options = {}) {
    const launches = [];
    const instance = new sp.SharedPlaywright({
        readConfig: () => userConfig,
        restartMinMs: 300,
        ...options,
        command: (port) => {
            const pidFile = nextPidFile();
            launches.push({ port, mode: modes.shift() ?? "listen", pidFile });
            return { command: process.execPath, args: [fake, launches.at(-1).mode, String(port), pidFile] };
        },
    });
    return { instance, launches };
}

try {
    delete process.env.ADO_PR_OPS_NO_SHARED_PLAYWRIGHT;
    delete process.env.ADO_PR_OPS_PLAYWRIGHT_MCP;
    delete process.env.ADO_PR_OPS_NO_LOW_PRIORITY;
    const sp = await load();

    // ---- which entry it stands in for ----
    const entry = (servers) => sp.userPlaywrightEntry({ mcpServers: servers });
    assert.equal(sp.userPlaywrightEntry(null), null);
    assert.equal(sp.userPlaywrightEntry({}), null);
    assert.equal(sp.userPlaywrightEntry({ mcpServers: "nope" }), null);
    assert.deepEqual(entry({ playwright: { tools: ["*"], type: "local", command: "npx", args: ["-y", "@playwright/mcp@latest"] } }), { name: "playwright", tools: ["*"] });
    assert.deepEqual(entry({ web: { command: "npx", args: ["@playwright/mcp"] } }), { name: "web", tools: ["*"] }, "no type is local; no version is fine");
    assert.deepEqual(entry({ b: { type: "stdio", command: "@playwright/mcp@1.2.3", tools: ["browser_click", "browser_type"] } }), { name: "b", tools: ["browser_click", "browser_type"] }, "the entry's tools carry over");
    assert.deepEqual(entry({ b: { command: "npx", args: ["@playwright/mcp"], tools: [1] } }), { name: "b", tools: ["*"] }, "tools that aren't names mean all of them");
    assert.equal(entry({ b: { command: "npx", args: ["@playwright/mcp"], disabled: true } }), null, "one the user turned off stays off");
    assert.equal(entry({ b: { type: "http", url: "http://127.0.0.1:1/mcp", args: ["@playwright/mcp"] } }), null, "a server the user already shares isn't replaced");
    assert.equal(entry({ b: { command: "npx", args: ["@playwright/mcp-extension"] } }), null, "another package isn't Playwright's server");
    assert.deepEqual(entry({ x: null, a: { command: "node", args: ["x.js"] }, z: { command: "npx", args: ["@playwright/mcp"] } }), { name: "z", tools: ["*"] });

    // ---- the command line ----
    const line = sp.playwrightCommand(sp.PLAYWRIGHT_MCP_SPEC, 0);
    const wanted = ["-y", "@playwright/mcp@0.0.84", "--port", "0", "--host", "127.0.0.1", "--isolated", "--headless"];
    if (process.platform === "win32") {
        assert.equal(line.verbatim, true, "a cmd.exe line, already quoted");
        assert.deepEqual(line.args.slice(0, 3), ["/d", "/s", "/c"]);
        assert.equal(line.args[3], `"npx ${wanted.join(" ")}"`);
        assert.equal(sp.playwrightCommand("@scope/x y&z", 5).args[3], `"npx -y "@scope/x y&z" --port 5 --host 127.0.0.1 --isolated --headless"`, "cmd's special characters are quoted");
    } else {
        assert.deepEqual(line, { command: "npx", args: wanted });
    }

    // ---- no Playwright in the user's config: nothing starts ----
    {
        const none = new sp.SharedPlaywright({ readConfig: () => ({ mcpServers: { ado: { type: "http", url: "https://example.test" } } }), command: () => assert.fail("nothing to stand in for") });
        none.start(root);
        assert.equal(await none.whenReady(5_000), false, "answers at once");
        assert.deepEqual(none.servers(), {});
        assert.equal(none.endpoint, null);
    }

    // ---- ready, a crash, a failed restart, and stop ----
    {
        let listeningPid = 0;
        const modes = [];
        const { instance, launches } = standIn(sp, modes, { onListening: (pid) => (listeningPid = pid) });
        assert.deepEqual(instance.servers(), {}, "nothing before it's listening");
        instance.start(root);
        instance.start(root);
        assert.equal(await instance.whenReady(15_000), true);
        assert.equal(launches.length, 1, "starting twice starts it once");
        const url = instance.endpoint;
        assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
        assert.deepEqual(instance.servers(), { browser: { type: "http", url, tools: ["browser_navigate"] } }, "under the user's name, with the user's tools");
        assert.ok(listeningPid > 0, "told the guard's pid once listening");
        assert.equal(getPriority(listeningPid), constants.priority.PRIORITY_BELOW_NORMAL, "the guard runs below normal from the start");
        const first = await pidIn(launches[0].pidFile);
        leftover.push(first);

        // It crashes: the next run, which fails, gets the same port; the one after, a new one.
        const port = Number(new URL(url).port);
        modes.push("fail");
        process.kill(first);
        await until(() => instance.endpoint === null, "the crash to be seen");
        assert.deepEqual(instance.servers(), {}, "sessions start with the user's own server while it's down");
        assert.equal(await instance.whenReady(15_000), false, "a waiter hears about the failed restart");
        assert.equal(launches[1].port, port, "it came back on the port sessions know");
        await until(() => instance.endpoint, "the second restart to listen");
        assert.equal(launches[2].port, 0, "after a failed start on that port, any port");
        const second = await pidIn(launches[2].pidFile);
        leftover.push(second);
        assert.equal(await (await fetch(instance.endpoint.replace(/\/mcp$/, "/"))).text(), String(second), "it answers there");
        const guard = listeningPid;

        instance.stop();
        assert.equal(instance.endpoint, null);
        assert.deepEqual(instance.servers(), {});
        assert.equal(await instance.whenReady(5_000), false, "stopped: answers at once");
        await until(() => !alive(second) && !alive(guard), "stop to end the server and its guard");
        const count = launches.length;
        await sleep(800);
        assert.equal(launches.length, count, "stopped stays stopped");
    }

    // ---- a start that hangs is cut off, and tried again ----
    {
        const { instance, launches } = standIn(sp, ["silent"], { startTimeoutMs: 1_000 });
        instance.start(root);
        assert.equal(await instance.whenReady(15_000), false, "the hung start gives up");
        const hung = await pidIn(launches[0].pidFile);
        leftover.push(hung);
        await until(() => !alive(hung), "the hung server to be ended");
        await until(() => instance.endpoint, "the next start to listen");
        assert.equal(launches.length, 2);
        leftover.push(await pidIn(launches[1].pidFile));
        instance.stop();
    }

    // ---- stopping lets waiters go ----
    {
        const { instance, launches } = standIn(sp, ["silent"]);
        instance.start(root);
        const waiting = instance.whenReady(30_000);
        const silent = await pidIn(launches[0].pidFile);
        leftover.push(silent);
        instance.stop();
        assert.equal(await waiting, false);
        await until(() => !alive(silent), "stop to end a server that never listened");
    }

    // ---- the service killed outright takes the server with it ----
    {
        const service = join(root, "service.mjs");
        const pidFile = nextPidFile();
        writeFileSync(
            service,
            `const sp = await import(${JSON.stringify(new URL("../shared-playwright.mjs", import.meta.url).href)});
let guard = 0;
const instance = new sp.SharedPlaywright({
    readConfig: () => (${JSON.stringify(userConfig)}),
    command: (port) => ({ command: process.execPath, args: [${JSON.stringify(fake)}, "listen", String(port), ${JSON.stringify(pidFile)}] }),
    onListening: (pid) => (guard = pid),
});
instance.start(process.cwd());
if (await instance.whenReady(15000)) console.log("READY " + guard);
setInterval(() => {}, 1 << 30);
`,
        );
        const child = spawn(process.execPath, [service], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
        const guard = await new Promise((resolve, reject) => {
            let text = "";
            child.stdout.on("data", (chunk) => {
                const match = /READY (\d+)/.exec((text += chunk));
                if (match) resolve(Number(match[1]));
            });
            child.on("exit", (code) => reject(new Error(`the service exited (${code})`)));
        });
        const server = await pidIn(pidFile);
        leftover.push(server, guard);
        assert.ok(alive(server) && alive(guard));
        child.kill("SIGKILL");
        await until(() => !alive(server), "the server to go with the service", 10_000);
        await until(() => !alive(guard), "the guard to go once it's done", 10_000);
    }

    // ---- the app's instance: off with the switch, and nothing without the user's entry ----
    const home = join(root, "copilot-home");
    mkdirSync(home);
    process.env.COPILOT_HOME = home;
    writeFileSync(join(home, "mcp-config.json"), JSON.stringify(userConfig));
    process.env.ADO_PR_OPS_NO_SHARED_PLAYWRIGHT = "1";
    let app = await load();
    assert.equal(app.sharedPlaywrightEnabled(), false);
    app.startSharedPlaywright(root);
    assert.equal(await app.sharedPlaywrightReady(5_000), false, "switched off: never starts");
    assert.deepEqual(app.sharedMcpServers(), {});
    app.stopSharedPlaywright();
    delete process.env.ADO_PR_OPS_NO_SHARED_PLAYWRIGHT;
    writeFileSync(join(home, "mcp-config.json"), JSON.stringify({ mcpServers: { ado: { type: "http", url: "https://example.test" } } }));
    app = await load();
    assert.equal(app.sharedPlaywrightEnabled(), true);
    app.startSharedPlaywright(root);
    assert.equal(await app.sharedPlaywrightReady(5_000), false, "no Playwright in the user's config: nothing to share");
    assert.deepEqual(app.sharedMcpServers(), {});
    app.stopSharedPlaywright();

    console.log("shared-playwright harness: ok");
} finally {
    for (const pid of leftover) {
        try {
            process.kill(pid);
        } catch {
            /* already gone */
        }
    }
    rmSync(root, { recursive: true, force: true });
}
