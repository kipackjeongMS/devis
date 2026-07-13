// Shared Azure AD token acquisition via the local user's `az` login.
// One cache per resource (ADO, Ev2, …) so every backend module mints tokens the
// same way — no PAT, no client secret, no MSAL. Dependency-free: node built-ins.

import { execFile } from "node:child_process";

interface TokenCache {
    value: string;
    expEpochMs: number;
}

interface AzTokenResult {
    value: string;
    expiresOn: string;
}

// resource (audience) -> cached token
const _cache = new Map<string, TokenCache>();

function azToken(resource: string): Promise<AzTokenResult> {
    return new Promise((resolve, reject) => {
        // `az` is a .cmd shim on Windows; run through the shell so it resolves.
        const isWin = process.platform === "win32";
        const cmd = isWin ? "az.cmd" : "az";
        execFile(
            cmd,
            ["account", "get-access-token", "--resource", resource, "--output", "json"],
            { shell: isWin, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err) {
                    reject(new Error(`az token failed: ${stderr || err.message}`));
                    return;
                }
                try {
                    const j = JSON.parse(stdout);
                    resolve({ value: j.accessToken, expiresOn: j.expiresOn });
                } catch (e) {
                    reject(new Error(`az token parse failed: ${(e as Error).message}`));
                }
            },
        );
    });
}

// Cached access token for a resource; refreshed ~2min before expiry.
export async function getAzToken(resource: string): Promise<string> {
    const now = Date.now();
    const hit = _cache.get(resource);
    if (hit && hit.expEpochMs - 120000 > now) return hit.value;
    const t = await azToken(resource);
    // expiresOn is a local-time string like "2025-01-01 12:00:00.000000"; be lenient.
    let exp = Date.parse(t.expiresOn);
    if (Number.isNaN(exp)) exp = now + 45 * 60 * 1000; // fallback 45m
    _cache.set(resource, { value: t.value, expEpochMs: exp });
    return t.value;
}
