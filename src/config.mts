// Config persistence: the list of Azure DevOps organizations to query. Stored as
// JSON in the extension dir (`config.json`) so it survives extension reloads.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Overridable for Node test harnesses (mirrors ADO_PR_OPS_DB_PATH in store.mts)
// so a scan/discovery test can control organizations/projects deterministically
// without touching a real developer's config.json.
const CONFIG_PATH = process.env.ADO_PR_OPS_CONFIG_PATH || join(__dirname, "config.json");

export interface Config {
    organizations: string[];
    // Per-org list of projects to scope "all active PRs" to. Orgs absent here (or
    // with an empty list) fall back to the org-wide reviewer=me query.
    projects: Record<string, string[]>;
    // Per org, per configured project: the only repos to list PRs from. A
    // project with none here lists all of its active PRs; a huge project (like
    // msazure/One, 16,000+ active PRs) is only usable narrowed to a few repos.
    repos: Record<string, Record<string, string[]>>;
    // AI model used for background PR reviews (e.g. "claude-opus-4.8"). Empty or
    // "auto" means the Copilot CLI picks automatically.
    reviewModel: string;
    // Absolute folder where completed reviews are mirrored as markdown
    // (<reviewsDir>/<RepoName>/<prId>-<title>.md). Empty disables the mirror.
    // User-specific, so it is NOT seeded — configured via the settings UX.
    reviewsDir: string;
    // Repos Jarvis workers can work in. Each is cloned once under the Jarvis
    // folder (codebase/<org>/<project>/<repo>); workers get worktrees of them.
    codebase: CodebaseRepo[];
    // The default folder new Jarvis tasks get their own folder in. A task can
    // name another one when it's created.
    taskRoot: string;
}

export interface CodebaseRepo {
    org: string;
    project: string;
    repo: string;
}

/** The repo's "org/project/repo" key, compared case-insensitively. */
export function codebaseKey(r: CodebaseRepo): string {
    return `${r.org}/${r.project}/${r.repo}`;
}

function normalizeCodebase(raw: unknown): CodebaseRepo[] {
    const list = Array.isArray(raw) ? raw : [];
    const out: CodebaseRepo[] = [];
    const seen = new Set<string>();
    for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const r = item as Record<string, unknown>;
        const repo = {
            org: String(r.org ?? "").trim(),
            project: String(r.project ?? "").trim(),
            repo: String(r.repo ?? "").trim(),
        };
        if (!repo.org || !repo.project || !repo.repo) continue;
        const key = codebaseKey(repo).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(repo);
    }
    return out;
}

function normalizeProjects(organizations: string[], raw: unknown): Record<string, string[]> {
    const src =
        raw && typeof raw === "object" && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : {};
    const out: Record<string, string[]> = {};
    for (const org of organizations) {
        const list = Array.isArray(src[org]) ? (src[org] as unknown[]) : [];
        out[org] = [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
    }
    return out;
}

function normalizeRepos(
    projects: Record<string, string[]>,
    raw: unknown,
): Record<string, Record<string, string[]>> {
    const obj = (v: unknown): Record<string, unknown> =>
        v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    const src = obj(raw);
    const out: Record<string, Record<string, string[]>> = {};
    for (const [org, list] of Object.entries(projects)) {
        const byProject = obj(src[org]);
        const kept: Record<string, string[]> = {};
        for (const project of list) {
            const names = Array.isArray(byProject[project]) ? (byProject[project] as unknown[]) : [];
            const seen = new Set<string>();
            const repos: string[] = [];
            for (const n of names) {
                // A repo name never holds a slash; anything else is a bad entry.
                const name = String(n ?? "").trim();
                if (!name || name.includes("/") || seen.has(name.toLowerCase())) continue;
                seen.add(name.toLowerCase());
                repos.push(name);
            }
            if (repos.length) kept[project] = repos;
        }
        if (Object.keys(kept).length) out[org] = kept;
    }
    return out;
}

/** Where to list an org's active PRs: each configured project, or each of its picked repos. */
export function prScopes(
    cfg: Pick<Config, "projects" | "repos">,
    org: string,
): Array<{ project: string; repo?: string }> {
    return (cfg.projects[org] || []).flatMap((project) => {
        const repos = cfg.repos?.[org]?.[project] || [];
        return repos.length ? repos.map((repo) => ({ project, repo })) : [{ project }];
    });
}

export async function readConfig(): Promise<Config> {
    try {
        const raw = await readFile(CONFIG_PATH, "utf8");
        const c = JSON.parse(raw);
        if (!Array.isArray(c.organizations)) c.organizations = [];
        // Migrate legacy configs that predate the `projects` field.
        c.projects = normalizeProjects(c.organizations, c.projects);
        c.repos = normalizeRepos(c.projects, c.repos);
        if (typeof c.reviewModel !== "string") c.reviewModel = "";
        if (typeof c.reviewsDir !== "string") c.reviewsDir = "";
        c.codebase = normalizeCodebase(c.codebase);
        if (typeof c.taskRoot !== "string") c.taskRoot = "";
        return c as Config;
    } catch {
        // First run: seed with the primary org.
        const seed: Config = { organizations: ["msazure"], projects: {}, repos: {}, reviewModel: "", reviewsDir: "", codebase: [], taskRoot: "" };
        await writeConfig(seed).catch(() => {});
        return seed;
    }
}

export async function writeConfig(cfg: {
    organizations?: unknown;
    projects?: unknown;
    repos?: unknown;
    reviewModel?: unknown;
    reviewsDir?: unknown;
    codebase?: unknown;
    taskRoot?: unknown;
}): Promise<Config> {
    const arr = Array.isArray(cfg.organizations) ? cfg.organizations : [];
    const organizations = [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];
    // A save that leaves out the repo scopes or the Jarvis workspace settings keeps them.
    const keep =
        cfg.repos === undefined || cfg.codebase === undefined || cfg.taskRoot === undefined ? await readStored() : null;
    const projects = normalizeProjects(organizations, cfg.projects);
    const clean: Config = {
        organizations,
        projects,
        repos: normalizeRepos(projects, cfg.repos === undefined ? keep?.repos : cfg.repos),
        reviewModel: typeof cfg.reviewModel === "string" ? cfg.reviewModel.trim() : "",
        reviewsDir: typeof cfg.reviewsDir === "string" ? cfg.reviewsDir.trim() : "",
        codebase: normalizeCodebase(cfg.codebase === undefined ? keep?.codebase : cfg.codebase),
        taskRoot: (typeof cfg.taskRoot === "string" ? cfg.taskRoot : typeof keep?.taskRoot === "string" ? keep.taskRoot : "").trim(),
    };
    await writeFile(CONFIG_PATH, JSON.stringify(clean, null, 2), "utf8");
    return clean;
}

async function readStored(): Promise<Record<string, unknown> | null> {
    try {
        return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    } catch {
        return null;
    }
}
