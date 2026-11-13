// Keeps the Copilot runtime and everything under it (Agency, copilot, each session's MCP
// servers, browsers) at below-normal CPU priority, so a busy worker never makes the
// machine feel slow: the user's own apps get the CPU first, and the workers still get all
// of it when the machine is idle. Windows hands a below-normal parent's priority to the
// children it starts, so lowering the tree once it's up covers what starts later too; a
// second sweep half a minute on catches what started while the first one ran.
// ADO_PR_OPS_NO_LOW_PRIORITY turns it off.

import { execFile } from "node:child_process";
import { constants, getPriority, setPriority } from "node:os";

export interface ProcessRow {
    pid: number;
    ppid: number;
    /** When it started (Windows file time), or 0 when unknown. */
    created: number;
}

const BELOW_NORMAL = constants.priority.PRIORITY_BELOW_NORMAL;
const LATE_SWEEP_MS = 30_000;
const LIST_TIMEOUT_MS = 30_000;

export const lowPriorityEnabled = (): boolean => !process.env.ADO_PR_OPS_NO_LOW_PRIORITY;

/** Rows of "pid ppid created", one per line; anything else is skipped. */
export function parseProcessRows(text: string): ProcessRow[] {
    const rows: ProcessRow[] = [];
    for (const line of text.split(/\r?\n/)) {
        const [pid, ppid, created] = line.trim().split(/\s+/).map(Number);
        if (Number.isInteger(pid) && pid > 0 && Number.isInteger(ppid) && ppid >= 0) {
            rows.push({ pid, ppid, created: Number.isFinite(created) ? created : 0 });
        }
    }
    return rows;
}

/**
 * `root` and every process under it, parents before children. A process that started
 * before its parent isn't its child: Windows reuses the ids of processes that ended.
 */
export function descendantsOf(root: number, rows: ProcessRow[]): number[] {
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const children = new Map<number, ProcessRow[]>();
    for (const row of rows) {
        if (row.pid === row.ppid) continue;
        const list = children.get(row.ppid) ?? [];
        list.push(row);
        children.set(row.ppid, list);
    }
    const found = [root];
    const seen = new Set(found);
    for (let i = 0; i < found.length; i++) {
        const parent = byPid.get(found[i]);
        for (const child of children.get(found[i]) ?? []) {
            if (seen.has(child.pid)) continue;
            if (parent && parent.created && child.created && child.created < parent.created) continue;
            seen.add(child.pid);
            found.push(child.pid);
        }
    }
    return found;
}

const LIST_WINDOWS =
    "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 })\" }";

function listProcesses(): Promise<ProcessRow[]> {
    const [file, args] =
        process.platform === "win32"
            ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", LIST_WINDOWS]]
            : ["ps", ["-A", "-o", "pid=", "-o", "ppid="]];
    return new Promise((resolve, reject) => {
        execFile(file, args, { windowsHide: true, timeout: LIST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
            error ? reject(error) : resolve(parseProcessRows(stdout)),
        );
    });
}

/** Below-normal for `pid`, unless it already runs at that or lower (an idle process stays idle). Whether it changed. */
export function lowerProcess(pid: number): boolean {
    try {
        if (getPriority(pid) >= BELOW_NORMAL) return false;
        setPriority(pid, BELOW_NORMAL);
        return true;
    } catch {
        return false; // gone, or not ours to change
    }
}

export interface LowerTreeDeps {
    list?: () => Promise<ProcessRow[]>;
    lower?: (pid: number) => boolean;
}

/** Lower `root` at once, then every process under it. How many changed. */
export async function lowerProcessTree(root: number, deps: LowerTreeDeps = {}): Promise<number> {
    const lower = deps.lower ?? lowerProcess;
    let changed = lower(root) ? 1 : 0;
    const rows = await (deps.list ?? listProcesses)();
    for (const pid of descendantsOf(root, rows).slice(1)) if (lower(pid)) changed++;
    return changed;
}

/** Lower the tree under `root` now and once more a little later. Never throws. */
export function keepTreeLow(root: number | undefined, label: string): void {
    if (!root || !lowPriorityEnabled()) return;
    const sweep = (when: string) =>
        lowerProcessTree(root)
            .then((changed) => {
                if (changed) console.log(`[priority] ${label}: ${changed} process(es) set to below normal (${when})`);
            })
            .catch((error: Error) => console.warn(`[priority] ${label}: could not lower the process tree: ${error.message}`));
    void sweep("now");
    setTimeout(() => void sweep("late sweep"), LATE_SWEEP_MS).unref();
}
