// Dynamic model discovery via the Copilot CLI, with session-level caching and
// a hardcoded fallback for environments where the CLI is unavailable.

import { exec } from "node:child_process";

let cached: string[] | null = null;

const FALLBACK: string[] = [
    "claude-sonnet-5", "claude-sonnet-4.6", "claude-sonnet-4.5",
    "claude-haiku-4.5",
    "claude-opus-4.8", "claude-opus-4.7", "claude-opus-4.6", "claude-opus-4.5",
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
    "gpt-5.5", "gpt-5.4", "gpt-5.3-codex",
    "gpt-5.4-mini", "gpt-5-mini",
    "gemini-3.1-pro-preview", "gemini-3.5-flash",
    "mai-code-1-flash-picker",
];

function probe(): Promise<string[]> {
    return new Promise((resolve) => {
        const cmd = 'copilot -p "list all available model names as a simple comma-separated list, nothing else" --model auto -s --allow-all-tools --no-custom-instructions';
        exec(cmd, { timeout: 45_000 }, (err, stdout) => {
            if (err || !stdout || !stdout.trim()) return resolve(FALLBACK);
            const models = stdout
                .trim()
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
            resolve(models.length >= 3 ? models : FALLBACK);
        });
    });
}

export async function getAvailableModels(refresh = false): Promise<string[]> {
    if (cached && !refresh) return cached;
    cached = await probe();
    return cached;
}
