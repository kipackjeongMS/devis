// One Copilot CLI runtime shared by every SDK session the desktop app runs:
// background reviewers, the reviewer chat, Ask/Elaborate, rephrase and the
// model catalog. The runtime is the user's installed `copilot` CLI, so sessions
// use the same GitHub login, plugins and session store as the terminal CLI
// (a reviewer session can be reopened with `copilot --resume <id>`).

import {
    CopilotClient,
    RuntimeConnection,
    type CopilotSession,
    type MCPServerConfig,
    type MessageOptions,
    type PermissionHandler,
} from "@github/copilot-sdk";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CLIENT_NAME = "ado-pr-ops";

let cliPathPromise: Promise<string> | null = null;
let clientPromise: Promise<CopilotClient> | null = null;

async function locateCopilotCli(): Promise<string> {
    const override = process.env.ADO_PR_OPS_COPILOT_PATH?.trim();
    if (override) return override;
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const { stdout } = await execFileAsync(locator, ["copilot"], { windowsHide: true });
    const candidates = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    // A .cmd/.ps1 shim cannot be spawned without a shell; prefer the real binary.
    const cliPath =
        process.platform === "win32"
            ? candidates.find((path) => /\.exe$/i.test(path)) || candidates[0]
            : candidates[0];
    if (!cliPath) throw new Error("Copilot CLI is not available on PATH");
    return cliPath;
}

export function resolveCopilotCliPath(): Promise<string> {
    if (!cliPathPromise) {
        cliPathPromise = locateCopilotCli().catch((error) => {
            cliPathPromise = null;
            throw error;
        });
    }
    return cliPathPromise;
}

export function getCopilotClient(): Promise<CopilotClient> {
    if (!clientPromise) {
        clientPromise = (async () => {
            const client = new CopilotClient({
                connection: RuntimeConnection.forStdio({ path: await resolveCopilotCliPath() }),
            });
            await client.start();
            return client;
        })().catch((error) => {
            clientPromise = null;
            throw error;
        });
    }
    return clientPromise;
}

const DEAD_RUNTIME = /not connected|connection (?:closed|failed)|server exited|EPIPE|ECONNRESET|disposed/i;

/** Run `task` on the shared client, restarting the runtime once if it died. */
export async function withCopilotClient<T>(task: (client: CopilotClient) => Promise<T>): Promise<T> {
    const client = await getCopilotClient();
    try {
        return await task(client);
    } catch (error) {
        if (!DEAD_RUNTIME.test((error as Error)?.message || "")) throw error;
        if (clientPromise) {
            const stale = clientPromise;
            clientPromise = null;
            void stale.then((old) => old.forceStop()).catch(() => undefined);
        }
        return task(await getCopilotClient());
    }
}

export async function stopCopilotClient(): Promise<void> {
    const pending = clientPromise;
    clientPromise = null;
    if (!pending) return;
    try {
        const client = await pending;
        for (const error of await client.stop()) {
            console.error(`[copilot] shutdown: ${error.message}`);
        }
    } catch (error) {
        console.error(`[copilot] shutdown failed: ${(error as Error).message}`);
    }
}

/** Empty working directory for app-run sessions, so no repo instructions leak in. */
export function sessionWorkingDirectory(): string {
    const dir = process.env.ADO_PR_OPS_WORK_DIR || join(tmpdir(), "ado-pr-ops-sessions");
    mkdirSync(dir, { recursive: true });
    return dir;
}

export function agencyExePath(): string | null {
    const override = process.env.ADO_PR_OPS_AGENCY_PATH?.trim();
    if (override) return existsSync(override) ? override : null;
    const appData = process.env.APPDATA;
    if (!appData) return null;
    const path = join(appData, "agency", "CurrentVersion", "agency.exe");
    return existsSync(path) ? path : null;
}

// Agency MCP servers attached to PR sessions: ADO (related PRs, repos) and
// Bluebird (code search) for the PR's own org/project.
const REVIEW_MCP_SERVERS = ["ado", "bluebird"] as const;

export function reviewMcpServers(org: string, project: string): Record<string, MCPServerConfig> {
    const agency = agencyExePath();
    if (!agency) return {};
    return {
        ado: { type: "local", command: agency, args: ["mcp", "ado", "--org", org], tools: ["*"] },
        bluebird: {
            type: "local",
            command: agency,
            args: ["mcp", "bluebird", "--org", org, "--project", project],
            tools: ["*"],
        },
    };
}

/**
 * The user's own MCP servers (mail, Teams, browsers, …) stay out of PR
 * sessions: they add startup cost and give untrusted PR text reach into
 * unrelated accounts.
 */
export function userMcpServerNames(): string[] {
    try {
        const config = JSON.parse(
            readFileSync(join(homedir(), ".copilot", "mcp-config.json"), "utf8"),
        ) as { mcpServers?: Record<string, unknown> };
        return Object.keys(config.mcpServers || {}).filter(
            (name) => !(REVIEW_MCP_SERVERS as readonly string[]).includes(name),
        );
    } catch {
        return [];
    }
}

const READ_ONLY_TOOL = /(?:^|[_-])(?:get|list|search|read|query|find|show|fetch|lookup)(?:[_-]|$)/i;

/**
 * PR sessions process untrusted PR content, so they get read access only:
 * file reads, app-provided tools and read-only ado/bluebird MCP tools. Shell,
 * file writes, URL fetches and every other MCP server are refused.
 */
export const reviewPermissionHandler: PermissionHandler = (request) => {
    if (request.kind === "read" || request.kind === "custom-tool") return { kind: "approve-once" };
    if (request.kind === "mcp") {
        if (
            (REVIEW_MCP_SERVERS as readonly string[]).includes(request.serverName) &&
            (request.readOnly || READ_ONLY_TOOL.test(request.toolName))
        ) {
            return { kind: "approve-once" };
        }
        return {
            kind: "reject",
            feedback: "PR sessions may only call read-only ado and bluebird MCP tools.",
        };
    }
    return {
        kind: "reject",
        feedback: `${request.kind} access is disabled in PR sessions because they process untrusted PR content. Use the PR data you were given and read-only ado/bluebird MCP tools.`,
    };
};

export function prSessionOptions(org: string, project: string) {
    return {
        clientName: CLIENT_NAME,
        workingDirectory: sessionWorkingDirectory(),
        mcpServers: reviewMcpServers(org, project),
        disabledMcpServers: userMcpServerNames(),
        onPermissionRequest: reviewPermissionHandler,
    };
}

/** Last top-level assistant reply text, or "" when the turn produced none. */
export function replyText(reply: Awaited<ReturnType<CopilotSession["sendAndWait"]>>): string {
    const content = (reply as { data?: { content?: unknown } } | undefined)?.data?.content;
    return typeof content === "string" ? content.trim() : "";
}

export interface OneShotOptions {
    model?: string;
    attachments?: MessageOptions["attachments"];
    timeoutMs?: number;
}

/** Answer one prompt in a throwaway session that is deleted afterwards. */
export function runOneShot(prompt: string, options: OneShotOptions = {}): Promise<string> {
    return withCopilotClient(async (client) => {
        const model = options.model?.trim();
        const session = await client.createSession({
            clientName: CLIENT_NAME,
            workingDirectory: sessionWorkingDirectory(),
            model: model && model !== "auto" ? model : undefined,
            skipCustomInstructions: true,
            disabledMcpServers: userMcpServerNames(),
            onPermissionRequest: reviewPermissionHandler,
        });
        try {
            const reply = await session.sendAndWait(
                { prompt, attachments: options.attachments },
                options.timeoutMs ?? 180_000,
            );
            const text = replyText(reply);
            if (!text) throw new Error("Copilot returned an empty reply");
            return text;
        } catch (error) {
            await session.abort().catch(() => undefined);
            throw error;
        } finally {
            await session.disconnect().catch(() => undefined);
            await client.deleteSession(session.sessionId).catch(() => undefined);
        }
    });
}
