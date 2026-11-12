// First run: whether this install has been through setup, and the machine-level choices made
// there (start at sign-in). It's setup.json, next to config.json and not inside it, because
// saving the config rewrites that file whole. Read by the service and by the window's shell.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SetupState {
    /** Setup was finished, or this install predates it. */
    done: boolean;
    /** Windows starts Devis' service when you sign in, and it keeps running without a window. */
    startAtSignIn: boolean;
    doneAt?: string;
}

const DEFAULTS: SetupState = { done: true, startAtSignIn: false };

export function setupStatePath(configPath = process.env.ADO_PR_OPS_CONFIG_PATH || ""): string {
    return join(dirname(configPath), "setup.json");
}

/** What's on disk. Missing or unreadable reads as an install that's set up, so a bad file never traps anyone in setup. */
export function readSetupState(path = setupStatePath()): SetupState {
    try {
        const raw = JSON.parse(readFileSync(path, "utf8"));
        return { done: raw?.done !== false, startAtSignIn: raw?.startAtSignIn === true, ...(typeof raw?.doneAt === "string" ? { doneAt: raw.doneAt } : {}) };
    } catch {
        return { ...DEFAULTS };
    }
}

export function writeSetupState(patch: Partial<SetupState>, path = setupStatePath()): SetupState {
    const next: SetupState = { ...readSetupState(path), ...pick(patch) };
    if (patch.done === true && !next.doneAt) next.doneAt = new Date().toISOString();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 1));
    renameSync(tmp, path);
    return next;
}

function pick(patch: Partial<SetupState>): Partial<SetupState> {
    const out: Partial<SetupState> = {};
    if (typeof patch.done === "boolean") out.done = patch.done;
    if (typeof patch.startAtSignIn === "boolean") out.startAtSignIn = patch.startAtSignIn;
    return out;
}

/**
 * Once, at service start and before anything reads the config (reading it creates it): with no
 * config yet this is a new install, which goes through setup; with one, it's an install from
 * before setup existed, already set up.
 */
export function initSetupState(configPath: string): SetupState {
    const path = setupStatePath(configPath);
    if (existsSync(path)) return readSetupState(path);
    return writeSetupState({ done: existsSync(configPath), startAtSignIn: false }, path);
}
