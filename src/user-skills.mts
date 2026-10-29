// The user's own skills (~/.copilot/skills, ~/.agents/skills, ~/.claude/skills),
// read by the app itself so a prompt can carry one whether or not the Copilot
// session it runs in loads skills. Used for the in-my-language skill: comments
// the user posts under their name are written in their own voice.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, extname, join, relative, resolve, sep } from "node:path";

/** Where the user's skills live, first match wins. `ADO_PR_OPS_USER_SKILL_DIRS` overrides it for tests. */
export function userSkillDirectories(): string[] {
    const override = process.env.ADO_PR_OPS_USER_SKILL_DIRS;
    if (override !== undefined) return override.split(delimiter).filter(Boolean);
    const home = homedir();
    return [join(home, ".copilot", "skills"), join(home, ".agents", "skills"), join(home, ".claude", "skills")];
}

/** A skill can't push a whole book into every prompt. */
export const SKILL_TEXT_LIMIT = 40_000;
const READABLE = new Set([".md", ".markdown", ".txt"]);

export interface UserSkill {
    name: string;
    /** The SKILL.md it was read from. */
    path: string;
    /** SKILL.md without its front matter, then each Markdown file it links to inside its folder. */
    text: string;
}

const stripFrontMatter = (text: string): string => text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();

/** Files SKILL.md links to, inside the skill's folder only (no `..`, no absolute paths, no URLs). */
function linkedFiles(skillDir: string, body: string): string[] {
    const out: string[] = [];
    for (const m of body.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
        const target = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/") || target.startsWith("\\")) continue;
        const full = resolve(skillDir, target);
        const rel = relative(skillDir, full);
        if (!rel || rel.startsWith("..") || rel.includes(`..${sep}`) || !READABLE.has(extname(full).toLowerCase())) continue;
        if (!out.includes(full)) out.push(full);
    }
    return out;
}

/** The user's skill by folder name, or null when they don't have it. Never throws. */
export function readUserSkill(name: string): UserSkill | null {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return null;
    for (const dir of userSkillDirectories()) {
        const path = join(dir, name, "SKILL.md");
        try {
            if (!existsSync(path) || !statSync(path).isFile()) continue;
            const skillDir = dirname(path);
            const body = stripFrontMatter(readFileSync(path, "utf8"));
            if (!body) continue;
            const parts = [body];
            for (const file of linkedFiles(skillDir, body)) {
                try {
                    if (!statSync(file).isFile()) continue;
                    const text = readFileSync(file, "utf8").trim();
                    if (text) parts.push(`--- ${relative(skillDir, file).split(sep).join("/")} ---\n${text}`);
                } catch {
                    /* a missing reference: use what's there */
                }
            }
            let text = parts.join("\n\n");
            if (text.length > SKILL_TEXT_LIMIT) text = text.slice(0, SKILL_TEXT_LIMIT).trimEnd() + "\n…";
            return { name, path, text };
        } catch {
            /* unreadable here: try the next folder */
        }
    }
    return null;
}

export const VOICE_SKILL = "in-my-language";

/**
 * The prompt section that tells Copilot to write in the user's own voice, from their
 * in-my-language skill; null when they don't have it.
 */
export function voiceGuide(): string | null {
    const skill = readUserSkill(VOICE_SKILL);
    if (!skill) return null;
    return [
        `The user's ${VOICE_SKILL} skill says how they write. Apply it to the text they'll post under their name. It controls the language, not the technical facts.`,
        "<skill name=\"in-my-language\">",
        skill.text,
        "</skill>",
    ].join("\n");
}
