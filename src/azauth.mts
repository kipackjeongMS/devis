// Shared Azure AD token acquisition via the local user's `az` login.
// One cache per resource so every backend module mints tokens the
// same way — no PAT, no client secret, no MSAL. Dependency-free: node built-ins.

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findAzureCli } from "./machine-tools.mjs";

interface TokenCache {
    value: string;
    expEpochMs: number;
}

interface AzTokenResult {
    value: string;
    expEpochMs: number;
}

// A healthy `az` call takes 1-3s. One that is still running after this is stuck
// (usually on the MSAL token-cache lock) and would otherwise linger for days.
const TOKEN_TIMEOUT_MS = 60_000;
// This built-in command needs no CLI extensions. Use an app-local, unpopulated
// extension directory so broken user extensions cannot block authentication.
const CORE_EXTENSION_DIR = fileURLToPath(new URL("./az-core-extensions", import.meta.url));

// resource (audience) -> cached token
const _cache = new Map<string, TokenCache>();
// resource -> the one `az` call in flight; concurrent callers share it.
const _inflight = new Map<string, Promise<string>>();

/** Forget the tokens read so far, after a sign-in, so the next call asks `az` again. */
export function clearAzTokenCache(): void {
    _cache.clear();
}

// With shell:true on Windows the child is cmd.exe, and killing it alone orphans
// the python process az runs under it, so end the whole tree.
function killTree(pid: number | undefined): void {
    if (!pid) return;
    if (process.platform === "win32") {
        execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
        return;
    }
    try {
        process.kill(pid, "SIGKILL");
    } catch {
        // already gone
    }
}

function azToken(resource: string): Promise<AzTokenResult> {
    return new Promise((resolve, reject) => {
        const az = findAzureCli().command;
        if (!az) {
            reject(new Error("az token failed: the Azure CLI isn't installed. Install it and run `az login`, then try again."));
            return;
        }
        // `az` is a .cmd shim on Windows; run through the shell so it resolves. The shell needs
        // a path with spaces (Program Files) quoted.
        const isWin = process.platform === "win32";
        const cmd = isWin && /\s/.test(az) ? `"${az}"` : az;
        let timedOut = false;
        const child = execFile(
            cmd,
            ["account", "get-access-token", "--resource", resource, "--output", "json"],
            {
                shell: isWin,
                windowsHide: true,
                maxBuffer: 4 * 1024 * 1024,
                env: { ...process.env, AZURE_EXTENSION_DIR: CORE_EXTENSION_DIR },
            },
            (err, stdout, stderr) => {
                clearTimeout(timer);
                if (timedOut) return;
                if (err) {
                    reject(new Error(`az token failed: ${stderr || err.message}`));
                    return;
                }
                try {
                    const j = JSON.parse(stdout);
                    // expires_on (epoch seconds) is unambiguous; expiresOn is a local-time string.
                    const epoch = Number(j.expires_on);
                    let exp = Number.isFinite(epoch) && epoch > 0 ? epoch * 1000 : Date.parse(j.expiresOn);
                    if (Number.isNaN(exp)) exp = Date.now() + 45 * 60 * 1000; // fallback 45m
                    resolve({ value: j.accessToken, expEpochMs: exp });
                } catch (e) {
                    reject(new Error(`az token parse failed: ${(e as Error).message}`));
                }
            },
        );
        const timer = setTimeout(() => {
            timedOut = true;
            killTree(child.pid);
            reject(new Error(`az token timed out after ${TOKEN_TIMEOUT_MS / 1000}s; try \`az login\``));
        }, TOKEN_TIMEOUT_MS);
    });
}

async function mint(resource: string): Promise<string> {
    const t = await azToken(resource);
    _cache.set(resource, { value: t.value, expEpochMs: t.expEpochMs });
    return t.value;
}

// Cached access token for a resource; refreshed ~2min before expiry. A burst of
// callers on a cold or expiring cache shares one `az` process instead of racing.
export function getAzToken(resource: string): Promise<string> {
    const hit = _cache.get(resource);
    if (hit && hit.expEpochMs - 120000 > Date.now()) return Promise.resolve(hit.value);
    let pending = _inflight.get(resource);
    if (!pending) {
        pending = mint(resource).finally(() => _inflight.delete(resource));
        _inflight.set(resource, pending);
    }
    return pending;
}
