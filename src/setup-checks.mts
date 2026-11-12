// Settings › Setup: what Devis needs from the machine, checked in one go. Copilot and its
// sign-in, the Azure CLI and its sign-in to Azure DevOps, Git, Agency and VS Code. A gap never
// stops Devis, so each row says what it holds up, not only what's missing.

import { APP_NAME } from "./brand.mjs";

export type SetupStatus = "ok" | "warn" | "missing";

export interface SetupCheck {
    id: "copilot" | "azure" | "git" | "agency" | "vscode";
    label: string;
    status: SetupStatus;
    detail: string;
    /** What waits for it, when it's missing. */
    needs?: string[];
}

export interface CopilotProbe {
    via: "agency" | "bundled" | "copilot";
    version: string;
    signedIn: boolean;
    login: string | null;
}

export interface GitProbe {
    source: "system" | "bundled" | null;
    version: string | null;
    note: string | null;
}

/** The machine, behind one seam, so the harness can stand in for it. */
export interface SetupProbes {
    copilot(): Promise<CopilotProbe>;
    azureCli(): string | null;
    /** An Azure DevOps token from the Azure CLI. */
    adoToken(): Promise<string>;
    git(): GitProbe;
    agency(): string | null;
    ides(): string[];
}

export const SETUP_TIMEOUT_MS = 25_000;

class TimedOut extends Error {}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimedOut()), ms);
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

const firstLine = (error: unknown): string => ((error as Error)?.message || String(error)).split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 200) || "unknown error";
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Who the token is for, from its claims, without checking it: only to show. */
export function tokenAccount(token: string): string | null {
    try {
        const claims = JSON.parse(Buffer.from(token.split(".")[1] || "", "base64url").toString("utf8"));
        const who = claims.upn || claims.unique_name || claims.preferred_username || claims.email;
        return typeof who === "string" && who ? who : null;
    } catch {
        return null;
    }
}

const RUNTIME = { agency: "Through Agency", bundled: "Built-in runtime", copilot: "Copilot CLI" } as const;

async function copilotCheck(probes: SetupProbes, ms: number): Promise<SetupCheck> {
    const row = { id: "copilot", label: "GitHub Copilot" } as const;
    try {
        const c = await within(probes.copilot(), ms);
        const base = [RUNTIME[c.via], c.version].filter(Boolean).join(" ");
        if (!c.signedIn) {
            return { ...row, status: "warn", detail: `${base}. Not signed in to GitHub, so reviews and the Lead wait. Sign in with \`copilot login\`, then check again.` };
        }
        return { ...row, status: "ok", detail: [base, c.login].filter(Boolean).join(" · ") };
    } catch (error) {
        if (error instanceof TimedOut) return { ...row, status: "warn", detail: `Copilot didn't answer in ${Math.round(ms / 1000)} s. Check again in a minute.` };
        return { ...row, status: "missing", detail: `Copilot didn't start, so reviews and the Lead wait: ${firstLine(error)}` };
    }
}

async function azureCheck(probes: SetupProbes, ms: number): Promise<SetupCheck> {
    const row = { id: "azure", label: "Azure DevOps" } as const;
    if (!probes.azureCli()) {
        return { ...row, status: "missing", detail: "The Azure CLI isn't installed, so pull requests and reviews wait. Install it, run `az login`, then check again." };
    }
    try {
        const who = tokenAccount(await within(probes.adoToken(), ms));
        return { ...row, status: "ok", detail: who ? `Signed in through the Azure CLI as ${who}` : "Signed in through the Azure CLI" };
    } catch (error) {
        if (error instanceof TimedOut) return { ...row, status: "warn", detail: `The Azure CLI didn't answer in ${Math.round(ms / 1000)} s. Run \`az login\` if it asks, then check again.` };
        return { ...row, status: "warn", detail: "The Azure CLI isn't signed in, or the sign-in expired, so pull requests and reviews are paused. Run `az login`, then check again." };
    }
}

function gitCheck(probes: SetupProbes): SetupCheck {
    const row = { id: "git", label: "Git" } as const;
    const g = probes.git();
    if (g.source === "bundled") return { ...row, status: "ok", detail: [`Built-in ${g.version || ""}`.trim(), g.note && cap(g.note)].filter(Boolean).join(". ") };
    if (g.source === "system" && !g.note) return { ...row, status: "ok", detail: `${g.version ? `Git ${g.version}` : "Git"} on this machine` };
    if (g.source === "system") return { ...row, status: "warn", detail: `${cap(g.note || "")}, and this build has none of its own, so workers may fail to check out code. Update Git.` };
    return { ...row, status: "missing", detail: "Not installed, and this build has none of its own, so workers can't check out code. Install Git." };
}

const AGENCY_NEEDS = ["Teams catch-up", "Meeting recaps", "Email summaries", "Code search"];

function agencyCheck(probes: SetupProbes): SetupCheck {
    const row = { id: "agency", label: "Agency" } as const;
    if (probes.agency()) return { ...row, status: "ok", detail: "Installed. Its MCP servers are on in reviews, the Workspace and Teams catch-up." };
    return { ...row, status: "warn", detail: "Not installed, so these wait for it:", needs: AGENCY_NEEDS };
}

function vscodeCheck(probes: SetupProbes): SetupCheck {
    const row = { id: "vscode", label: "VS Code" } as const;
    const ides = probes.ides();
    if (ides.length) return { ...row, status: "ok", detail: `Found ${ides.join(" and ")}` };
    return { ...row, status: "warn", detail: "Not found, so a worker's Open in VSCode won't work. Install it, then check again." };
}

/** Every check, at once; the slow ones (Copilot, the Azure CLI) give up after `ms`. */
export async function runSetupChecks(probes: SetupProbes, ms = SETUP_TIMEOUT_MS): Promise<SetupCheck[]> {
    const [copilot, azure] = await Promise.all([copilotCheck(probes, ms), azureCheck(probes, ms)]);
    return [copilot, azure, gitCheck(probes), agencyCheck(probes), vscodeCheck(probes)];
}

/** The real machine. */
export async function machineProbes(): Promise<SetupProbes> {
    const [{ resolveCopilotRuntime, withCopilotClient, agencyExePath }, tools, { getAzToken }, { ADO_RESOURCE }, { installedIdes }] = await Promise.all([
        import("./copilot-runtime.mjs"),
        import("./machine-tools.mjs"),
        import("./azauth.mjs"),
        import("./ado.mjs"),
        import("./workspace-ide.mjs"),
    ]);
    return {
        copilot: async () => {
            const { via } = await resolveCopilotRuntime();
            const [status, auth] = await withCopilotClient((client) => Promise.all([client.getStatus(), client.getAuthStatus()]));
            return { via, version: status.version, signedIn: auth.isAuthenticated, login: auth.login ?? null };
        },
        azureCli: () => tools.findAzureCli().command,
        adoToken: () => getAzToken(ADO_RESOURCE),
        git: () => {
            const { source, version, note } = tools.prepareGit();
            return { source, version, note: note?.replace(`, so ${APP_NAME} uses its own`, "") ?? null };
        },
        agency: agencyExePath,
        ides: installedIdes,
    };
}
