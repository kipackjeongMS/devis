// Slash commands in a Copilot-backed chat: the CLI's built-ins and the user's skills, read from the
// session and run through it. A worker's chat and the Lead's chat share this; each supplies what
// differs (how the model switches, how a prompt command starts a turn).

import type { CopilotSession } from "@github/copilot-sdk";
import { JarvisError } from "./jarvis-store.mjs";

export interface ChatCommand {
    name: string;
    aliases: string[];
    description: string;
    kind: "builtin" | "skill";
    /** What the command takes after its name; empty when it takes nothing. */
    hint: string;
    required: boolean;
    choices: Array<{ name: string; description: string }>;
    /** It can run while the session is mid-turn. */
    duringTurn: boolean;
}

/** What running a command did, for the chat to show. */
export type CommandOutcome =
    | { kind: "sent"; display: string; notice: string | null }
    | { kind: "note"; text: string; markdown: boolean; url: string | null }
    | {
          kind: "choices";
          title: string;
          command: string;
          options: Array<{ name: string; description: string; group: string | null }>;
      };

type CommandInfo = Awaited<ReturnType<CopilotSession["rpc"]["commands"]["list"]>>["commands"][number];
export type CommandResult = Awaited<ReturnType<CopilotSession["rpc"]["commands"]["invoke"]>>;

const NOTE_MAX = 20_000;

/** Built-ins that don't fit a chat: they move the session to another folder or mode, or schedule work the app wouldn't see. */
const UNSUPPORTED = new Map<string, string>([
    ["autopilot", "Autopilot mode isn't"],
    ["plan", "Plan mode isn't"],
    ["every", "Schedules aren't"],
    ["after", "Schedules aren't"],
    ["remote", "Remote control isn't"],
    ["sandbox", "Sandbox settings aren't"],
]);

/** Why a command can't run in this chat (`chat` is how it's named, like "worker chat"), or null when it can. */
export function unsupportedReason(name: string, chat: string): string | null {
    if (name === "cwd") return chat === "worker chat" ? "A worker stays in its folder. Start another worker for a different folder." : `The ${chat} stays in its own folder.`;
    const feature = UNSUPPORTED.get(name);
    return feature ? `${feature} available in the ${chat}.` : null;
}

/** The CLI's color and link escapes, which a chat can't show. */
export function stripAnsi(text: string): string {
    return text.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** "/name rest" into the command name and its input. */
export function parseSlash(text: string): { name: string; input: string } | null {
    const m = /^\/([\w.:-]{1,100})(?:\s+([\s\S]*))?$/.exec(text.trim());
    return m ? { name: m[1].toLowerCase(), input: (m[2] || "").trim() } : null;
}

function toCommand(info: CommandInfo, noun: string): ChatCommand {
    const command: ChatCommand = {
        name: info.name.toLowerCase(),
        aliases: (info.aliases || []).map((a) => a.toLowerCase()),
        description: info.description || "",
        kind: info.kind === "skill" ? "skill" : "builtin",
        hint: info.input?.hint?.trim() || "",
        required: !!info.input?.required,
        choices: (info.input?.choices || []).map((c) => ({ name: c.name, description: c.description || "" })),
        duringTurn: !!info.allowDuringAgentExecution,
    };
    // The app switches the model itself, so the user's saved CLI default stays as it is.
    if (command.name === "model") {
        Object.assign(command, { description: `Switch this ${noun}'s model`, hint: "model", required: false, choices: [], duringTurn: true });
    }
    return command;
}

/** The session's commands the chat offers: built-ins first, then skills. */
export async function readSessionCommands(session: CopilotSession, chat: string): Promise<ChatCommand[]> {
    const { commands } = await session.rpc.commands.list({ includeBuiltins: true, includeSkills: true, includeClientCommands: false });
    return commands
        .filter((c) => c.kind !== "client" && !unsupportedReason(c.name.toLowerCase(), chat))
        .map((c) => toCommand(c, chat === "worker chat" ? "worker" : "chat"))
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "builtin" ? -1 : 1));
}

export function note(text: string, markdown = false, url: string | null = null): CommandOutcome {
    // Keep the CLI's line layout; only the length is capped.
    let body = stripAnsi(text).replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
    if (body.length > NOTE_MAX) body = body.slice(0, NOTE_MAX - 1).trimEnd() + "…";
    return { kind: "note", text: body || "Done.", markdown, url };
}

/** What differs between chats when a command runs. */
export interface CommandHooks {
    /** How the chat is named in messages, like "worker chat". */
    chat: string;
    /** /model: a list to pick from when `value` is empty, or a switch. */
    switchModel(value: string): Promise<CommandOutcome>;
    /** Start a turn with the command's prompt. Throws when the chat can't take one now. */
    startTurn(prompt: string, display: string): void | Promise<void>;
}

/**
 * Look the command up in what the chat offers, and refuse what can't run now. The text is
 * checked before `load` runs, so a malformed or unsupported command never touches the session.
 */
export async function pickCommand(
    text: unknown,
    o: { chat: string; who: string; maxInput: number; load: () => Promise<ChatCommand[]>; busy: () => boolean },
): Promise<{ command: ChatCommand; input: string }> {
    const parsed = typeof text === "string" ? parseSlash(text) : null;
    if (!parsed) throw new JarvisError("Type a command, like /usage.");
    if (parsed.input.length > o.maxInput) throw new JarvisError("The message is too long.");
    const unsupported = unsupportedReason(parsed.name, o.chat);
    if (unsupported) throw new JarvisError(unsupported);
    const commands = await o.load();
    const command = commands.find((c) => c.name === parsed.name || c.aliases.includes(parsed.name));
    if (!command) throw new JarvisError(`Unknown command /${parsed.name}. Type / to see what ${o.who} can run.`, 404);
    if (o.busy() && !command.duringTurn) throw new JarvisError(`${o.who} is working. Wait for its turn to end, or stop it.`, 409);
    if (command.required && !parsed.input) throw new JarvisError(`/${command.name} needs ${command.hint || "more input"}.`);
    return { command, input: parsed.input };
}

export async function applyCommandResult(command: ChatCommand, result: CommandResult, hooks: CommandHooks): Promise<CommandOutcome> {
    switch (result.kind) {
        case "text":
            return note(result.text, !!result.markdown);
        case "completed":
            return note(result.message || `/${command.name} done.`);
        case "add-timeline-entry":
            return note(result.entry.text, false, result.entry.url || null);
        case "set-plan-model":
            return note(result.message);
        case "select-subcommand":
            return {
                kind: "choices",
                title: result.title,
                command: result.command,
                options: result.options.map((o) => ({ name: o.name, description: o.description || "", group: o.group || null })),
            };
        case "set-model":
            return hooks.switchModel(result.model);
        case "show-dialog":
            if (result.dialog.kind === "model-picker") return hooks.switchModel("");
            return note(`/${command.name} opens a picker the ${hooks.chat} doesn't have. Run it from the Copilot CLI instead.`);
        case "agent-prompt": {
            if (result.mode && result.mode !== "interactive") {
                return note(`/${command.name} needs ${result.mode} mode, which the ${hooks.chat} doesn't have. Run it from the Copilot CLI instead.`);
            }
            const display = (result.displayPrompt || `/${command.name}`).trim();
            await hooks.startTurn(result.prompt, display);
            return { kind: "sent", display, notice: result.notice ? stripAnsi(result.notice) : null };
        }
        default:
            return note(`/${command.name} ran.`);
    }
}
