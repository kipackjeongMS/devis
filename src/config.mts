// Config persistence: the list of Azure DevOps organizations to query. Stored as
// JSON in the extension dir (`config.json`) so it survives extension reloads.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "config.json");

export interface Config {
    organizations: string[];
    // Per-org list of projects to scope "all active PRs" to. Orgs absent here (or
    // with an empty list) fall back to the org-wide reviewer=me query.
    projects: Record<string, string[]>;
    // AI model used for background PR reviews (e.g. "claude-opus-4.8"). Empty or
    // "auto" means the Copilot CLI picks automatically.
    reviewModel: string;
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

export async function readConfig(): Promise<Config> {
    try {
        const raw = await readFile(CONFIG_PATH, "utf8");
        const c = JSON.parse(raw);
        if (!Array.isArray(c.organizations)) c.organizations = [];
        // Migrate legacy configs that predate the `projects` field.
        c.projects = normalizeProjects(c.organizations, c.projects);
        if (typeof c.reviewModel !== "string") c.reviewModel = "";
        return c as Config;
    } catch {
        // First run: seed with the primary org.
        const seed: Config = { organizations: ["msazure"], projects: {}, reviewModel: "" };
        await writeConfig(seed).catch(() => {});
        return seed;
    }
}

export async function writeConfig(cfg: { organizations?: unknown; projects?: unknown; reviewModel?: unknown }): Promise<Config> {
    const arr = Array.isArray(cfg.organizations) ? cfg.organizations : [];
    const organizations = [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];
    const clean: Config = {
        organizations,
        projects: normalizeProjects(organizations, cfg.projects),
        reviewModel: typeof cfg.reviewModel === "string" ? cfg.reviewModel.trim() : "",
    };
    await writeFile(CONFIG_PATH, JSON.stringify(clean, null, 2), "utf8");
    return clean;
}
