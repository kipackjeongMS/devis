// The last complete PR list, kept so the page can show the queue the moment it
// opens instead of waiting several seconds on ADO. It is only a first paint:
// the live list replaces it as soon as it arrives.

import type { Pr } from "./ado.mjs";
import { getMeta, setMeta } from "./store.mjs";

const KEY = "prs_snapshot";
/** Older than this, the list is too far behind to be worth showing. */
export const PR_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

interface Scope {
    organizations: string[];
    projects: Record<string, string[]>;
    repos?: Record<string, Record<string, string[]>>;
}

interface Snapshot {
    scope: string;
    at: string;
    prs: Pr[];
}

/** The orgs, projects and picked repos a list was loaded for; a list from other settings is never shown. */
export function prScopeKey(cfg: Scope): string {
    return JSON.stringify(
        cfg.organizations.map((org) => {
            const projects = [...(cfg.projects[org] || [])].sort();
            const repos = projects
                .map((p) => [p, [...(cfg.repos?.[org]?.[p] || [])].map((r) => r.toLowerCase()).sort()] as const)
                .filter(([, list]) => list.length);
            // Without picked repos the key stays as it was, so a kept list still shows.
            return repos.length ? [org, projects, repos] : [org, projects];
        }),
    );
}

/** Keep a complete list (one where every org and project answered). */
export function savePrSnapshot(cfg: Scope, prs: Pr[], now = Date.now()): void {
    const snapshot: Snapshot = { scope: prScopeKey(cfg), at: new Date(now).toISOString(), prs };
    setMeta(KEY, JSON.stringify(snapshot));
}

export function readPrSnapshot(cfg: Scope, now = Date.now()): { prs: Pr[]; at: string } | null {
    const raw = getMeta(KEY);
    if (!raw) return null;
    try {
        const snapshot = JSON.parse(raw) as Snapshot;
        if (snapshot.scope !== prScopeKey(cfg) || !Array.isArray(snapshot.prs)) return null;
        const age = now - Date.parse(snapshot.at);
        if (!(age >= 0 && age <= PR_SNAPSHOT_MAX_AGE_MS)) return null;
        return { prs: snapshot.prs, at: snapshot.at };
    } catch {
        return null;
    }
}
