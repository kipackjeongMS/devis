// Runs one command for the service and takes its whole process tree down when the service
// goes away, however it goes, killed included. The service holds this process's stdin open
// and never writes to it, so the pipe ending means the service is gone. Started as a script
// (`process-guard.mjs <command line as JSON>`), it passes the command's output on and exits
// with its exit code. The shared Playwright server needs it: over HTTP it never notices its
// parent ending. On Windows, Node kills a process's direct children when it dies, but not
// theirs: the service starts this detached so it lives to clean up, and this kills the tree.

import { spawn, spawnSync } from "node:child_process";

interface GuardedCommand {
    command: string;
    args: string[];
    verbatim?: boolean;
}

let line: GuardedCommand | null = null;
try {
    line = JSON.parse(process.argv[2] ?? "null") as GuardedCommand | null;
} catch {
    /* reported below */
}
if (!line || typeof line.command !== "string" || !Array.isArray(line.args)) {
    console.error("process-guard: expected the command line as JSON");
    process.exit(2);
}
// Only there so Electron runs this as Node: the command must not inherit it.
delete process.env.ELECTRON_RUN_AS_NODE;

const child = spawn(line.command, line.args, {
    windowsHide: true,
    windowsVerbatimArguments: line.verbatim,
    // Its stdin stays open, as a server's does under a client. All pipes, so its console has no window.
    stdio: ["pipe", "pipe", "pipe"],
    // Elsewhere its own process group, so the whole tree can be signalled at once.
    detached: process.platform !== "win32",
});
child.stdin?.on("error", () => undefined);

function killTree(): void {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        return;
    }
    try {
        process.kill(-child.pid, "SIGKILL");
    } catch {
        /* already gone */
    }
}

let leaving = false;
function leave(): void {
    if (leaving) return;
    leaving = true;
    killTree();
    process.exit(0);
}

process.stdin.on("end", leave);
process.stdin.on("close", leave);
process.stdin.on("error", leave);
process.stdin.resume();
// Output that can't reach the service means it's gone too.
process.stdout.on("error", leave);
process.stderr.on("error", leave);
child.stdout?.pipe(process.stdout);
child.stderr?.pipe(process.stderr);
process.on("SIGTERM", leave);
process.on("SIGINT", leave);
child.on("error", (error) => {
    console.error(`process-guard: ${error.message}`);
    process.exit(1);
});
// After its output is through, so the service sees why it ended.
child.on("close", (code, signal) => {
    if (!leaving) process.exit(code ?? (signal ? 1 : 0));
});
