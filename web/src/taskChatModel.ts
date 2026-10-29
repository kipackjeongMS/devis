// Pure rules for a task's worker chat: finding and ranking slash commands, and
// the transcript merged with command output. No DOM, so harnesses can import
// the compiled module directly.

import { sameImages, type ChatImage } from "./chatImages.js";

/** A slash command the worker can run: a Copilot CLI built-in or one of the user's skills. */
export interface ChatCommand {
  name: string;
  aliases: string[];
  description: string;
  kind: "builtin" | "skill";
  /** What the command takes after its name; empty when it takes nothing. */
  hint: string;
  required: boolean;
  choices: Array<{ name: string; description: string }>;
  /** It can run while the worker is mid-turn. */
  duringTurn: boolean;
}

export interface ChoiceOption {
  name: string;
  description: string;
  group: string | null;
}

/** What the server says running a command did. */
export type CommandOutcome =
  | { kind: "sent"; display: string; notice: string | null }
  | { kind: "note"; text: string; markdown: boolean; url: string | null }
  | { kind: "choices"; title: string; command: string; options: ChoiceOption[] };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  /** Images the user sent with it. */
  images?: ChatImage[];
}

/** Something the chat shows that isn't in the session's history: command output, a list to pick from, an error. */
export interface ChatNote {
  id: string;
  at: string;
  kind: "note" | "error" | "choices";
  /** What the user typed, shown above the output. */
  command: string;
  text: string;
  markdown: boolean;
  url: string | null;
  /** For choices: the command each option runs with, like "mcp" for "/mcp show". */
  choiceCommand: string;
  options: ChoiceOption[];
}

export type ChatItem = { type: "message"; message: ChatMessage } | { type: "note"; note: ChatNote };

/** Notes kept per worker; older ones drop off. */
export const NOTES_KEPT = 30;

/** The command name being typed: "/sk" gives "sk", "/" gives "". Null once there's a space, or no leading slash. */
export function slashQuery(text: string): string | null {
  const m = /^\/([\w.:-]*)$/.exec(text.trimStart());
  return m ? m[1].toLowerCase() : null;
}

function score(c: ChatCommand, q: string): number {
  if (c.name === q || c.aliases.includes(q)) return 100;
  if (c.name.startsWith(q)) return 80;
  if (c.aliases.some((a) => a.startsWith(q))) return 70;
  if (c.name.split(/[-_.:]/).some((part) => part.startsWith(q))) return 60;
  if (c.name.includes(q)) return 40;
  if (c.description.toLowerCase().includes(q)) return 10;
  return 0;
}

const kindRank = (c: ChatCommand): number => (c.kind === "builtin" ? 0 : 1);

/**
 * Commands for what's typed after "/": exact names first, then name and alias
 * prefixes, word prefixes ("slop" finds no-ai-slop), names containing it, and
 * descriptions. An empty query lists everything, built-ins before skills.
 */
export function matchCommands(commands: ChatCommand[], query: string, limit = 100): ChatCommand[] {
  const q = query.trim().toLowerCase();
  const scored = commands
    .map((c) => ({ c, s: q ? score(c, q) : 1 }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || kindRank(a.c) - kindRank(b.c) || a.c.name.localeCompare(b.c.name));
  return scored.slice(0, limit).map((x) => x.c);
}

/** "/name input" for a known command; null when the name isn't one. */
export function resolveCommand(commands: ChatCommand[], text: string): { command: ChatCommand; input: string } | null {
  const m = /^\/([\w.:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  const command = commands.find((c) => c.name === name || c.aliases.includes(name));
  return command ? { command, input: (m[2] || "").trim() } : null;
}

export type ComposerIntent = { kind: "command"; text: string } | { kind: "message"; text: string } | { kind: "empty" };

/**
 * What sending the composer's text does. "/name …" runs a command; a path like
 * "/src/app is slow" is a message; "//text" sends "/text" as a message.
 */
export function composerIntent(raw: string): ComposerIntent {
  const text = raw.trim();
  if (!text) return { kind: "empty" };
  if (text.startsWith("//")) return { kind: "message", text: text.slice(1) };
  if (/^\/[\w.:-]+(?:\s|$)/.test(text)) return { kind: "command", text };
  return { kind: "message", text };
}

/** A note for what a command did, or null when it started a turn. */
export function noteFromOutcome(outcome: CommandOutcome, command: string, id: string, at: string): ChatNote | null {
  const base = { id, at, command, text: "", markdown: false, url: null, choiceCommand: "", options: [] as ChoiceOption[] };
  if (outcome.kind === "note") return { ...base, kind: "note", text: outcome.text, markdown: outcome.markdown, url: outcome.url };
  if (outcome.kind === "choices") {
    return { ...base, kind: "choices", text: outcome.title, choiceCommand: outcome.command, options: outcome.options };
  }
  if (outcome.notice) return { ...base, kind: "note", text: outcome.notice };
  return null;
}

/** Messages and notes in time order. Items without a time keep their place at the start. */
export function chatItems(messages: ChatMessage[], notes: ChatNote[]): ChatItem[] {
  const items = [
    ...messages.map((message, i) => ({ item: { type: "message", message } as ChatItem, t: Date.parse(message.timestamp) || 0, i })),
    ...notes.map((note, i) => ({ item: { type: "note", note } as ChatItem, t: Date.parse(note.at) || 0, i: messages.length + i })),
  ];
  return items.sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.item);
}

/**
 * A message the user just sent shows until the transcript has it: the same words and the same
 * images. The transcript stores a command as what it displayed ("/skill args").
 */
export function pendingShown(messages: ChatMessage[], pending: { text: string; at: number; images?: ChatImage[] } | null): boolean {
  if (!pending) return false;
  const want = pending.text.trim();
  return !messages.some(
    (m) =>
      m.role === "user" &&
      m.content.trim() === want &&
      sameImages(m.images, pending.images) &&
      (Date.parse(m.timestamp) || pending.at) >= pending.at - 5000
  );
}

// ---- the turn in flight ---------------------------------------------------------------
// While a worker works, a live read lists the turn's finished messages; the transcript is
// read once the turn ends. The chat shows the transcript plus what the turn added, so a
// reply never leaves the chat between the two reads. Messages carry the transcript's ids.

/** A turn message read live, and when the chat first saw it. */
export interface SeenMessage extends ChatMessage {
  seenAt: number;
}

/** Take in a live read of the turn: new messages join in order; ones seen before take their latest content. */
export function noteTurn(seen: SeenMessage[], turn: ChatMessage[], now: number): SeenMessage[] {
  if (!turn.length) return seen;
  const next = [...seen];
  for (const m of turn) {
    const at = next.findIndex((s) => s.id === m.id);
    if (at < 0) next.push({ ...m, seenAt: now });
    else if (next[at].content !== m.content) next[at] = { ...m, seenAt: next[at].seenAt };
  }
  return next;
}

/** The conversation: the transcript, then what the turn added that the transcript doesn't have yet. */
export function withTurn(transcript: ChatMessage[], seen: SeenMessage[]): ChatMessage[] {
  if (!seen.length) return transcript;
  const ids = new Set(transcript.map((m) => m.id));
  const extra = seen.filter((m) => !ids.has(m.id));
  return extra.length ? [...transcript, ...extra.map(({ seenAt: _seenAt, ...m }) => m)] : transcript;
}

/**
 * After a transcript read: what it has drops out, and so does anything seen before the read
 * began, which the transcript would have had (it is the truth once read).
 */
export function settleSeen(seen: SeenMessage[], transcript: ChatMessage[], readStartedAt: number): SeenMessage[] {
  const ids = new Set(transcript.map((m) => m.id));
  return seen.filter((m) => !ids.has(m.id) && m.seenAt >= readStartedAt);
}

/** Options grouped under their labels, in first-seen order. Ungrouped options come first. */
export function groupOptions(options: ChoiceOption[]): Array<{ group: string | null; options: ChoiceOption[] }> {
  const groups = new Map<string | null, ChoiceOption[]>();
  for (const o of options) {
    const key = o.group || null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(o);
  }
  const list = [...groups].map(([group, opts]) => ({ group, options: opts }));
  return list.sort((a, b) => (a.group === null ? -1 : b.group === null ? 1 : 0));
}
