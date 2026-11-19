// The chat UI shared by the Lead (Devis) and a task's workers: one pane (head,
// conversation, request cards, composer), one message look, one set of
// helpers for painting the log and the composer. A host (the Lead pane, the
// task modal) supplies the data and decides when to repaint; it never writes
// chat markup of its own, so the two chats can't drift apart.
//
// The builders are pure strings so harnesses can import the compiled module;
// the paint helpers at the end are the only parts that touch the DOM.

import { esc } from "./util.js";
import { icon } from "./icons.js";
import { renderMarkdown, renderMarkdownMemo } from "./markdown.js";
import { patchHtml } from "./patch.js";
import { groupOptions, type ChatNote } from "./taskChatModel.js";
import { pickerView, type PickerOption, type PickerState } from "./modelChoice.js";
import { IMAGE_TYPES, messageImagesHtml, type ChatImage } from "./chatImages.js";
import { aboutOf } from "./needsChat.js";
import { dayStart } from "./jarvisModel.js";

/** A message as the log shows it. One from the session's history carries its id. */
export interface ChatLine {
  id?: string;
  role: "user" | "assistant";
  content: string;
  /** When it was sent, from the session's events: the prompt index shows it. */
  timestamp?: string;
  /** Images the user sent with it. */
  images?: ChatImage[];
}

export type LogItem =
  | { type: "message"; message: ChatLine }
  | { type: "note"; note: ChatNote }
  /** Something the host writes into the thread itself, such as Devis's notices. `sig` changes when it does. */
  | { type: "html"; key: string; sig: string; html: string };

// ---- the pane -----------------------------------------------------------------------

export interface ChatPaneOptions {
  /** Prefix for ids inside the pane, so two panes on a page don't share any. */
  id: string;
  /** What the message box is for, for screen readers. */
  inputLabel: string;
  /** Names the pane for screen readers when its host doesn't. */
  label?: string;
  /** The "/" list is wired to the box. */
  commands?: boolean;
  /** The head's contents. A pane without any hides its head until the host fills it. */
  headHtml?: string;
}

/** The jump button's name, and its name when something new arrived below. */
const JUMP_LABEL = "Jump to the latest message";
const JUMP_NEW_LABEL = "New messages below. Jump to the latest message";

export function chatPaneHtml(o: ChatPaneOptions): string {
  const popup = `${o.id}-popup`;
  const wired = o.commands ? ` aria-autocomplete="list" aria-controls="${esc(popup)}"` : "";
  return `
    <div class="chat"${o.label ? ` role="group" aria-label="${esc(o.label)}"` : ""}>
      <div class="chat-head"${o.headHtml ? "" : " hidden"}>${o.headHtml || ""}</div>
      <div class="chat-view">
        <div class="chat-log" role="log" aria-live="polite" tabindex="0"></div>
        <button type="button" class="chat-jump" title="${JUMP_LABEL}" aria-label="${JUMP_LABEL}">${icon("down")}</button>
        <nav class="chat-index" aria-label="Your prompts" hidden></nav>
        <div class="chat-index-card" aria-hidden="true" hidden></div>
      </div>
      <div class="chat-requests" hidden></div>
      <div class="chat-tools" hidden></div>
      <form class="chat-compose">
        <div class="chat-popup" id="${esc(popup)}" role="listbox" aria-label="Commands and skills" hidden></div>
        <div class="chat-tray" role="list" aria-label="Images to send" hidden></div>
        <textarea class="chat-input" rows="1" data-max="200" spellcheck="true" aria-label="${esc(o.inputLabel)}"${wired}></textarea>
        <span class="visually-hidden chat-sr" aria-live="polite"></span>
        <div class="chat-bar">
          <span class="chat-hint"></span>
          <span class="chat-buttons">
            <button type="button" class="icon-btn sm chat-attach" title="Attach images (or paste or drop them in)" aria-label="Attach images">${icon("image")}</button>
            <input type="file" class="chat-file" accept="${IMAGE_TYPES.join(",")}" multiple hidden tabindex="-1">
            <button type="button" class="btn sm ghost chat-steer" hidden title="Send it into the turn that's running (Ctrl+Enter)">Send now</button>
            <button type="submit" class="btn sm accent chat-send">Send</button>
          </span>
        </div>
      </form>
    </div>`;
}

export interface ChatPane {
  root: HTMLElement;
  head: HTMLElement;
  /** The log and the jump-to-latest button that floats over it. */
  view: HTMLElement;
  log: HTMLElement;
  jump: HTMLButtonElement;
  requests: HTMLElement;
  /** The row over the composer: the model and effort picker. Hidden until the host fills it. */
  tools: HTMLElement;
  form: HTMLFormElement;
  input: HTMLTextAreaElement;
  /** Images waiting to go with the next message. */
  tray: HTMLElement;
  /** Picks images from disk into the tray. */
  attach: HTMLButtonElement;
  file: HTMLInputElement;
  send: HTMLButtonElement;
  /** "Send now": puts the message into the running turn. */
  steer: HTMLButtonElement;
  hint: HTMLElement;
  popup: HTMLElement;
  /** Screen-reader line for the highlighted "/" item. */
  sr: HTMLElement;
}

/** The parts of the pane that `chatPaneHtml` put inside `scope`. */
export function chatPaneRefs(scope: ParentNode): ChatPane {
  const root = scope.querySelector<HTMLElement>(".chat")!;
  const q = <T extends Element>(sel: string): T => root.querySelector<T>(sel)!;
  return {
    root,
    head: q(".chat-head"),
    view: q(".chat-view"),
    log: q(".chat-log"),
    jump: q(".chat-jump"),
    requests: q(".chat-requests"),
    tools: q(".chat-tools"),
    form: q(".chat-compose"),
    input: q(".chat-input"),
    tray: q(".chat-tray"),
    attach: q(".chat-attach"),
    file: q(".chat-file"),
    send: q(".chat-send"),
    steer: q(".chat-steer"),
    hint: q(".chat-hint"),
    popup: q(".chat-popup"),
    sr: q(".chat-sr"),
  };
}

// ---- the model picker ------------------------------------------------------------------

const optionsHtml = (options: PickerOption[]): string =>
  options.map((o) => `<option value="${esc(o.value)}"${o.selected ? " selected" : ""}>${esc(o.label)}</option>`).join("");

/**
 * The model and effort picker that sits over the composer, as full markup: the host patches it
 * into the pane's tools row (patchHtml keeps the selects, their focus and value, while nothing
 * changed). Changes come back as `change` events from `select[data-model-pick="model"]` and
 * `select[data-model-pick="effort"]`.
 */
export function modelPickerHtml(state: PickerState): string {
  const v = pickerView(state);
  const off = v.disabled ? " disabled" : "";
  return `<span class="chat-picker" data-key="picker">
      <label class="chat-model" data-key="pick-model" title="${esc(v.modelTitle)}">${icon("sparkle")}<select class="filter-select chat-model-select" data-model-pick="model" aria-label="${esc(state.who)}'s model"${off}>${optionsHtml(v.models)}</select></label>${
        v.efforts
          ? `<label class="chat-effort" data-key="pick-effort" title="${esc(v.effortTitle)}"><select class="filter-select chat-model-select chat-effort-select" data-model-pick="effort" aria-label="${esc(state.who)}'s reasoning effort"${off}>${optionsHtml(v.efforts)}</select></label>`
          : ""
      }${v.note ? `<span class="chat-pick-note" data-key="pick-note">${esc(v.note)}</span>` : ""}
    </span>`;
}

// ---- what the log holds -------------------------------------------------------------

/**
 * A chat message. One from the session's history carries its id: with its length, that pins
 * the content, so repaints keep its DOM and its Markdown renders once. The message being
 * sent and the reply streaming in are keyed by their state, and re-render as they change.
 * "sending" is on its way (faded); "sent" reached the app and waits for the conversation to
 * have it, so it reads as sent. Both share a key, so the bubble stays put between the two.
 */
export function messageHtml(msg: ChatLine, state: "" | "sending" | "sent" | "streaming" = ""): string {
  const key = msg.id
    ? ` data-key="m:${esc(msg.id)}" data-v="${msg.content.length}${msg.images?.length ? `.${msg.images.length}` : ""}"`
    : state
      ? ` data-key="${state === "sent" ? "sending" : state}"`
      : "";
  const extra = state ? ` ${state}` : "";
  if (msg.role === "user") return `<div class="chat-msg user${extra}${msg.images?.length ? " has-imgs" : ""}"${key}>${messageImagesHtml(msg.images)}${userText(msg.content)}</div>`;
  return `<div class="chat-msg assistant md${extra}"${key}>${msg.id ? renderMarkdownMemo(msg.content) : renderMarkdown(msg.content)}</div>`;
}

/** Command output, a list to pick from, or an error: shown in the log but not part of the session's history. */
export function noteHtml(n: ChatNote): string {
  // A note never changes once shown, so its key pins it across repaints.
  const key = ` data-key="n:${esc(n.id)}" data-v="1"`;
  const head = `<div class="chat-out-cmd">${esc(n.command)}</div>`;
  if (n.kind === "error") return `<div class="chat-out err"${key}>${head}<p>${esc(n.text)}</p></div>`;
  if (n.kind === "choices") {
    const groups = groupOptions(n.options)
      .map(
        (g) =>
          `${g.group ? `<p class="chat-out-group">${esc(g.group)}</p>` : ""}<div class="chat-out-choices">${g.options
            .map(
              (o) =>
                `<button type="button" class="chip-btn" data-run="${esc(`/${n.choiceCommand} ${o.name}`)}" title="${esc(o.description || `/${n.choiceCommand} ${o.name}`)}">${esc(o.name)}${
                  o.description === "Current" ? ` <span class="chat-current">current</span>` : ""
                }</button>`
            )
            .join("")}</div>`
      )
      .join("");
    return `<div class="chat-out"${key}>${head}<p class="chat-out-title">${esc(n.text)}</p>${groups}</div>`;
  }
  const body = n.markdown ? `<div class="md">${renderMarkdownMemo(n.text)}</div>` : `<pre class="chat-out-text">${esc(n.text)}</pre>`;
  const link = n.url ? `<a class="chat-out-link" href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.url)}</a>` : "";
  return `<div class="chat-out"${key}>${head}${body}${link}</div>`;
}

/**
 * The user's words in their bubble; none for a message that is only images. A message sent with
 * a Needs you item attached shows the item's name over the words, and keeps its details for Devis.
 */
const userText = (content: string): string => {
  const about = aboutOf(content);
  const words = about ? about.text : content;
  const ref = about ? `<span class="chat-about">${icon("warning")}<span>${esc(about.label)}</span></span>` : "";
  return ref + (words.trim() ? `<p>${esc(words)}</p>` : "");
};

export const thinkingHtml = (text: string): string => `<p class="chat-thinking" data-key="thinking"><span class="spinner"></span> ${esc(text)}</p>`;

export const mutedHtml = (text: string): string => `<p class="chat-muted">${esc(text)}</p>`;

/** A failure in the log. `innerHtml` is the body, already escaped. */
export const errorOutHtml = (innerHtml: string): string => `<div class="chat-out err">${innerHtml}</div>`;

/** A card for a log with nothing to show: what this chat is, and what to do first. `bodyHtml` and `actionsHtml` are already escaped. */
export function emptyHtml(title: string, bodyHtml: string, actionsHtml = ""): string {
  return `<div class="chat-empty"><p class="chat-empty-title">${esc(title)}</p>${bodyHtml ? `<p>${bodyHtml}</p>` : ""}${actionsHtml}</div>`;
}

export interface QueuedLine {
  id: string;
  text: string;
  images?: ChatImage[];
}

export interface ChatLogSpec {
  /** Which conversation this is. When it changes, the log opens the new one at its latest message. */
  session?: string;
  /** The conversation, in order. */
  items: LogItem[];
  /** Show a "loading" line: the transcript is being read and there is none yet. */
  loading?: boolean;
  /** Shown above the conversation, such as a failed read with its retry. Already escaped. */
  notice?: string;
  /** What the user just sent, until the transcript has it. */
  sending?: string | null;
  /** The images sent with it. */
  sendingImages?: ChatImage[];
  /** The app has `sending`: it reads as sent rather than on its way. */
  sendingAccepted?: boolean;
  /** Messages sent into the running turn that the conversation doesn't show yet. */
  steered?: QueuedLine[];
  /** A turn is running: the reply streams in as `partial`, or `thinking` says what it is doing. */
  busy?: boolean;
  partial?: string;
  thinking?: string;
  /** Shown after the conversation while no turn is running, such as a failure. Already escaped. */
  trailer?: string;
  /** Messages waiting for the turn to end, in the order they run. */
  queued?: QueuedLine[];
  /** A stop or failure holds the queue until the user sends again. */
  queueHeld?: boolean;
  /** "Send now" can go into the running turn (not while it's starting, stopping or waiting on the user). */
  canSteer?: boolean;
  /** Shown when there is nothing else to show. Already escaped. */
  empty?: string;
}

/** A message sent into the running turn: it reads like the user's other messages, marked as such. */
export function steeredHtml(m: QueuedLine): string {
  return `<div class="chat-msg user steered${m.images?.length ? " has-imgs" : ""}" data-key="st:${esc(m.id)}" data-v="1">${messageImagesHtml(m.images)}${userText(m.text)}<span class="chat-msg-tag">Sent mid-turn</span></div>`;
}

/** The queue under the conversation: each message with Send now and Remove. */
export function queueHtml(spec: Pick<ChatLogSpec, "queued" | "queueHeld" | "busy" | "canSteer">): string {
  const queued = spec.queued || [];
  if (!queued.length) return "";
  const head = spec.queueHeld
    ? "Held · runs after your next message"
    : spec.busy
      ? `Queued · ${queued.length === 1 ? "runs" : "run in order"} when this turn ends`
      : "Queued";
  // Mid-turn, Send now steers the message in; that waits while the turn starts, stops or asks you something.
  const blocked = spec.busy && !spec.canSteer;
  const sendTitle = blocked ? "Not now: the turn is starting, stopping or waiting on you" : spec.busy ? "Send it into the turn that's running" : "Send it now";
  const items = queued
    .map(
      (m, i) => `<li class="chat-queued" data-key="q:${esc(m.id)}">
        <span class="chat-queued-n" aria-hidden="true">${i + 1}</span>
        <div class="chat-queued-body">${messageImagesHtml(m.images, true)}${userText(m.text)}</div>
        <span class="chat-queued-actions">
          <button type="button" class="btn sm ghost" data-queue-send="${esc(m.id)}" title="${esc(sendTitle)}"${blocked ? " disabled" : ""}>Send now</button>
          <button type="button" class="icon-btn sm" data-queue-remove="${esc(m.id)}" title="Remove from the queue" aria-label="Remove from the queue">${icon("dismiss")}</button>
        </span>
      </li>`
    )
    .join("");
  return `<div class="chat-queue${spec.queueHeld ? " held" : ""}" data-key="queue">
      <p class="chat-queue-head">${esc(head)}</p>
      <ol class="chat-queue-list" aria-label="Queued messages">${items}</ol>
    </div>`;
}

/**
 * The log in two parts: the conversation as read (`history`), and the live tail after it:
 * what's being sent, messages sent mid-turn, the reply streaming in or what the turn is
 * doing, and the queue. `partial` is how much of the streaming reply to show.
 */
export function chatLogParts(spec: ChatLogSpec, partial: string | undefined = spec.partial): { history: string; tail: string } {
  const history: string[] = [];
  if (spec.loading) history.push(`<p class="chat-muted"><span class="spinner"></span> Loading the conversation…</p>`);
  if (spec.notice) history.push(spec.notice);
  for (const item of spec.items) history.push(item.type === "message" ? messageHtml(item.message) : item.type === "note" ? noteHtml(item.note) : item.html);
  const tail: string[] = [];
  if (isSending(spec)) tail.push(messageHtml({ role: "user", content: spec.sending || "", images: spec.sendingImages }, spec.sendingAccepted ? "sent" : "sending"));
  for (const m of spec.steered || []) tail.push(steeredHtml(m));
  if (spec.busy) {
    tail.push(partial ? messageHtml({ role: "assistant", content: partial }, "streaming") : thinkingHtml(spec.thinking || "Thinking…"));
  } else if (spec.trailer) {
    tail.push(spec.trailer);
  }
  const queue = queueHtml(spec);
  if (queue) tail.push(queue);
  if (!history.length && !tail.length && spec.empty) history.push(spec.empty);
  return { history: history.join(""), tail: tail.join("") };
}

/** Something the user sent shows until the transcript has it: words, images, or both. */
const isSending = (spec: Pick<ChatLogSpec, "sending" | "sendingImages">): boolean => !!spec.sending || !!spec.sendingImages?.length;

/** A message as the signatures see it: id, length, and how many images. */
const itemSig = (i: LogItem): string =>
  i.type === "message" ? `${i.message.id ?? ""}:${i.message.content.length}:${i.message.images?.length || 0}` : i.type === "note" ? `n:${i.note.id}` : `h:${i.key}:${i.sig}`;

/** What's being sent, in a few bytes: its words and its images. */
const sendingSig = (spec: Pick<ChatLogSpec, "sending" | "sendingImages">): string =>
  isSending(spec) ? `${spec.sending || ""}|${(spec.sendingImages || []).map((i) => i.id).join(",")}` : "";

export function chatLogHtml(spec: ChatLogSpec): string {
  const { history, tail } = chatLogParts(spec);
  return history + tail;
}

/** The conversation part of the log, in few bytes: it repaints only when this changes. */
function historySig(spec: ChatLogSpec): string {
  return JSON.stringify([
    spec.items.map(itemSig),
    !!spec.loading,
    spec.notice ?? "",
    // The empty card shows only when there is nothing else at all.
    spec.empty && !isSending(spec) && !spec.steered?.length && !spec.busy && !spec.trailer && !spec.queued?.length ? spec.empty : "",
  ]);
}

/**
 * What `chatLogHtml` would paint, in few bytes: a host repaints only when it changes.
 * A message is pinned by its id and length, a streaming reply by its length.
 */
export function chatLogSig(spec: ChatLogSpec): string {
  return JSON.stringify([
    spec.items.map(itemSig),
    !!spec.loading,
    spec.notice ?? "",
    sendingSig(spec),
    !!spec.sendingAccepted,
    (spec.steered || []).map((m) => m.id),
    !!spec.busy,
    spec.partial?.length ?? 0,
    spec.thinking ?? "",
    spec.trailer ?? "",
    (spec.queued || []).map((m) => m.id),
    !!spec.queueHeld,
    !!spec.canSteer,
    spec.empty ?? "",
  ]);
}

// ---- the prompt index: what it shows -----------------------------------------------------
//
// A thin rail down the conversation's right edge with a tick per prompt the user sent, in order.
// Hovering or focusing one shows its first line and when it was sent, and clicking it scrolls
// there. The tick of the turn being read is brighter. Alt+↑ and Alt+↓ anywhere in the pane step
// between prompts. The rail shows once there are INDEX_MIN prompts. These rules are pure; the
// rail itself is painted with the log (see "the prompt index: the rail").

/** One prompt on the rail: the key of its bubble in the log, its first line, and when it was sent. */
export interface PromptMark {
  key: string;
  text: string;
  /** When it was sent (ms since the epoch), or NaN when the transcript doesn't say. */
  at: number;
  /** Said instead of the time for one that isn't in the conversation yet. */
  note?: string;
}

/** The rail shows from this many prompts. */
export const INDEX_MIN = 2;
/** A prompt scrolled to sits this far under the log's top edge. */
export const PROMPT_PAD = 12;
const PROMPT_TEXT_MAX = 200;

/** A prompt's line for the rail: its words on one line, else the item it's about, else its images. */
export function promptText(content: string, images = 0): string {
  const about = aboutOf(content);
  const line = (about ? about.text : content).replace(/\s+/g, " ").trim();
  const text = line || about?.label || (images === 1 ? "An image" : images > 1 ? `${images} images` : "");
  return text.length > PROMPT_TEXT_MAX ? text.slice(0, PROMPT_TEXT_MAX - 1).trimEnd() + "…" : text;
}

/** The prompts in the log, in its order: the conversation's, then the one being sent, then those sent mid-turn. */
export function promptMarks(spec: Pick<ChatLogSpec, "items" | "sending" | "sendingImages" | "steered">): PromptMark[] {
  const marks: PromptMark[] = [];
  for (const item of spec.items) {
    if (item.type !== "message" || item.message.role !== "user" || !item.message.id) continue;
    const m = item.message;
    marks.push({ key: `m:${m.id}`, text: promptText(m.content, m.images?.length), at: Date.parse(m.timestamp || "") });
  }
  if (isSending(spec)) marks.push({ key: "sending", text: promptText(spec.sending || "", spec.sendingImages?.length), at: NaN, note: "Just now" });
  for (const m of spec.steered || []) marks.push({ key: `st:${m.id}`, text: promptText(m.text, m.images?.length), at: NaN, note: "Sent mid-turn" });
  return marks;
}

/** When a prompt was sent, as the rail says it: "Today, 9:19 AM", "Yesterday, 9:19 AM", "Mon, 9:19 AM", "Nov 12, 9:19 AM". */
export function promptTime(at: number, now: number): string {
  if (!Number.isFinite(at)) return "";
  const d = new Date(at);
  const clock = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const today = dayStart(now);
  if (at >= today) return `Today, ${clock}`;
  if (at >= dayStart(today - 1)) return `Yesterday, ${clock}`;
  if (at >= dayStart(today - 6 * 86_400_000)) return `${d.toLocaleDateString([], { weekday: "short" })}, ${clock}`;
  const year = d.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" as const };
  return `${d.toLocaleDateString([], { month: "short", day: "numeric", ...year })}, ${clock}`;
}

const promptWhen = (m: PromptMark, now: number): string => m.note || promptTime(m.at, now);

/** The rail's ticks: a button per prompt, named for it. None below INDEX_MIN prompts. */
export function promptIndexHtml(marks: readonly PromptMark[], now: number): string {
  if (marks.length < INDEX_MIN) return "";
  return marks
    .map((m, i) => {
      const when = promptWhen(m, now);
      const label = `Prompt ${i + 1} of ${marks.length}: ${m.text}${when ? ` (${when})` : ""}`;
      return `<button type="button" class="chat-index-tick" data-key="${esc(m.key)}" data-i="${i}" tabindex="-1" aria-label="${esc(label)}"></button>`;
    })
    .join("");
}

/**
 * The prompt being read, from where each one starts in the log (`tops`, NaN for one not on the
 * page) and how the log is scrolled: the last one that starts above a reading line near the top
 * of the view. Over the last screen of the log the line slides down to the view's foot, since the
 * log can't scroll further to bring the prompts there up; at the end, the last one in view is it.
 */
export function currentPrompt(tops: readonly number[], scrollTop: number, height: number, scrollHeight: number): number {
  if (!tops.length) return -1;
  const reading = scrollTop + PROMPT_PAD + 8;
  const foot = scrollTop + height - 1;
  const left = Math.max(0, scrollHeight - height - scrollTop);
  const line = height > 0 && left < height ? reading + (foot - reading) * (1 - left / height) : reading;
  let current = 0;
  tops.forEach((top, i) => {
    if (top <= line) current = i;
  });
  return current;
}

/**
 * Where Alt+↑ (-1) or Alt+↓ (1) goes from the prompt being read: up goes back to that prompt's
 * start first when it's scrolled past, then to the one before. -1 when there's nowhere to go.
 */
export function stepPrompt(tops: readonly number[], current: number, scrollTop: number, dir: -1 | 1): number {
  if (!tops.length) return -1;
  if (current < 0) return dir > 0 ? 0 : -1;
  if (dir > 0) return current + 1 < tops.length ? current + 1 : -1;
  if (tops[current]! < scrollTop + PROMPT_PAD - 4) return current;
  return current - 1;
}

// ---- painting -----------------------------------------------------------------------

/** How close to the bottom the log must be for new content to keep it there. */
const STICKY_PX = 64;
const DEFAULT_MAX_PX = 160;

// A streaming reply arrives in chunks, one per read of the worker or the Lead. Shown as they
// come, it jumps a line or two at a time; instead the chat reveals each chunk over about the
// time until the next one, so the text flows in. It never lags far: the pace rises with what's
// left to show.
/** Show what has arrived within about this long. */
export const REVEAL_CATCHUP_MS = 320;
/** The slowest pace, in characters a millisecond (~90 a second). */
export const REVEAL_MIN_RATE = 0.09;

/** How much of the reply to show after `dtMs` more of revealing, from `shown` of `total` characters. */
export function revealStep(shown: number, total: number, dtMs: number): number {
  if (shown >= total) return total;
  const rate = Math.max(REVEAL_MIN_RATE, (total - shown) / REVEAL_CATCHUP_MS);
  return Math.min(total, shown + Math.max(1, Math.round(rate * dtMs)));
}

/**
 * How much of a new streaming text to keep showing: all that was shown when it carries on the
 * text before it, all of it when it's an older copy of what's shown, and none when it's a
 * different reply.
 */
export function revealKept(previous: string, shown: number, next: string): number {
  if (!next) return 0;
  const kept = Math.min(shown, previous.length);
  if (next.startsWith(previous.slice(0, kept))) return Math.min(kept, next.length);
  return previous.startsWith(next) ? next.length : 0;
}

/** What one log has on screen: its two parts, and how far the streaming reply is revealed. */
interface LogPaint {
  /** Holds the two parts, so one box measures how tall the conversation is. */
  flow: HTMLElement;
  history: HTMLElement;
  tail: HTMLElement;
  historyKey: string;
  tailHtml: string;
  spec: ChatLogSpec | null;
  /** The whole streaming reply, and how many characters of it are on screen. */
  target: string;
  shown: number;
  sending: string;
  frame: number;
  last: number;
}

const paints = new WeakMap<HTMLElement, LogPaint>();

const reduceMotion = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The log's two parts, made on first paint (and again if anything replaced them). */
function logPaint(log: HTMLElement): LogPaint {
  const known = paints.get(log);
  if (known && known.flow.parentNode === log && known.history.parentNode === known.flow && known.tail.parentNode === known.flow) return known;
  log.innerHTML = `<div class="chat-flow"><div class="chat-hist"></div><div class="chat-tail"></div></div>`;
  const flow = log.firstElementChild as HTMLElement;
  const p: LogPaint = {
    flow,
    history: flow.firstElementChild as HTMLElement,
    tail: flow.lastElementChild as HTMLElement,
    historyKey: "",
    tailHtml: "",
    spec: null,
    target: "",
    shown: 0,
    sending: "",
    frame: 0,
    last: 0,
  };
  paints.set(log, p);
  return p;
}

const nearBottom = (log: HTMLElement): boolean => log.scrollHeight - log.scrollTop - log.clientHeight < STICKY_PX;

const toBottom = (log: HTMLElement): void => {
  log.scrollTop = log.scrollHeight;
};

// ---- following the conversation --------------------------------------------------------
//
// A log opens at its latest message and stays there as the conversation grows, until the
// user scrolls up to read. It opens at the latest again whenever it's shown or put back on the
// page (a hidden or detached log has no height to scroll, and loses its place), when it shows
// another session, and when the user sends. Content that grows after it's painted (an image
// loading, a diagram drawing, a section opening) keeps it pinned too: a ResizeObserver on the
// log and its content re-pins on every size change.
//
// Only the user scrolling up unpins it, and reaching the bottom pins it again. The log's own
// jumps to the bottom only ever scroll down, so they can't unpin it, however the scroll events
// and the content's growth interleave. A jump up to a prompt (see "the prompt index: the rail")
// unpins it too, and its smooth scroll passing the foot doesn't pin it again. While unpinned, a
// button over the log jumps back down, and marks when something new arrived below.

/** Where one log is in its conversation. */
interface Follow {
  /** New content keeps the log at the bottom. */
  pinned: boolean;
  /** Something arrived below while the user was reading further up. */
  unseen: boolean;
  /** The log's height when last measured: 0 while it's hidden. */
  height: number;
  /** Where the log was last scrolled to, to tell scrolling up from the rest. */
  top: number;
  session: string | undefined;
  /** The content being watched for size changes. */
  flow: HTMLElement | null;
  jump: HTMLButtonElement | null;
  observer: ResizeObserver | null;
}

const follows = new WeakMap<HTMLElement, Follow>();

/** The log's follow state, made on first paint. It watches `flow`, the log's current content. */
function follow(log: HTMLElement, flow: HTMLElement): Follow {
  let f = follows.get(log);
  if (!f) {
    const made: Follow = { pinned: true, unseen: false, height: 0, top: log.scrollTop, session: undefined, flow: null, jump: null, observer: null };
    log.addEventListener("scroll", () => onScroll(log, made), { passive: true });
    follows.set(log, made);
    f = made;
  }
  if (!f.jump) {
    const jump = log.parentElement?.querySelector<HTMLButtonElement>(":scope > .chat-jump") ?? null;
    if (jump) wireJump(log, f, jump);
  }
  // A log painted before it's on the page is measured once it's there, so it opens at the latest too.
  if (typeof ResizeObserver === "function") {
    let observer = f.observer;
    if (!observer) {
      const state = f;
      // Hidden or taken off the page, the log measures 0; shown or put back, its real height.
      observer = f.observer = new ResizeObserver(() => onResize(log, state));
      observer.observe(log);
    }
    if (f.flow !== flow) {
      if (f.flow) observer.unobserve(f.flow);
      observer.observe(flow);
      f.flow = flow;
    }
  }
  return f;
}

function onScroll(log: HTMLElement, f: Follow): void {
  if (!log.clientHeight) return;
  const top = log.scrollTop;
  const up = top < f.top;
  f.top = top;
  // A jump to a prompt decided where the log is pinned; its smooth scroll passing the foot doesn't change that.
  if (!promptJumping(log)) {
    if (nearBottom(log)) {
      f.pinned = true;
      f.unseen = false;
    } else if (up) {
      f.pinned = false;
    }
  }
  showJump(log, f);
  indexScrolled(log);
}

function onResize(log: HTMLElement, f: Follow): void {
  // Hidden or off the page: nothing to scroll until it's back.
  const height = log.isConnected ? log.clientHeight : 0;
  if (!height) {
    f.height = 0;
    return;
  }
  // Shown (again): it opens at the latest, wherever it was left.
  if (!f.height) {
    f.pinned = true;
    f.unseen = false;
  }
  f.height = height;
  if (f.pinned) stick(log, f);
  else f.top = log.scrollTop;
  showJump(log, f);
  scheduleIndex(log);
}

/**
 * Jump to the latest, and remember it as where the log is: a scroll up that lands in the
 * same frame then reads as up from here, rather than from wherever the log was before.
 */
function stick(log: HTMLElement, f: Follow): void {
  toBottom(log);
  f.top = log.scrollTop;
}

/** The jump button shows while the log is scrolled up from the latest, marked when there's more below. */
function showJump(log: HTMLElement, f: Follow): void {
  const jump = f.jump;
  if (!jump) return;
  const shown = !f.pinned && log.clientHeight > 0 && !nearBottom(log);
  const fresh = shown && f.unseen;
  // Hiding a focused button would drop focus to the page: the log takes it, as the button's target.
  if (!shown && document.activeElement === jump) log.focus({ preventScroll: true });
  jump.classList.toggle("is-shown", shown);
  jump.classList.toggle("has-new", fresh);
  const label = fresh ? JUMP_NEW_LABEL : JUMP_LABEL;
  if (jump.getAttribute("aria-label") !== label) {
    jump.setAttribute("aria-label", label);
    jump.title = label;
  }
}

function wireJump(log: HTMLElement, f: Follow, jump: HTMLButtonElement): void {
  f.jump = jump;
  // A click leaves focus where it was (such as the message box); Enter or Space moves it to the log.
  jump.addEventListener("mousedown", (e) => e.preventDefault());
  jump.addEventListener("click", () => {
    f.pinned = true;
    f.unseen = false;
    log.scrollTo({ top: log.scrollHeight, behavior: reduceMotion() ? "auto" : "smooth" });
    showJump(log, f);
  });
  // The button floats over the log but outside it: the wheel over it scrolls the log as it would.
  jump.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) wheelLog(log, e);
    },
    { passive: false }
  );
}

/** The last message, and how many there are: it changes when one arrives or grows. */
const tipSig = (items: LogItem[]): string => (items.length ? `${items.length}|${itemSig(items[items.length - 1])}` : "");

function paintTail(p: LogPaint): void {
  const html = chatLogParts(p.spec!, p.target.slice(0, p.shown)).tail;
  if (html === p.tailHtml) return;
  p.tailHtml = html;
  patchHtml(p.tail, html);
}

function revealFrame(log: HTMLElement, p: LogPaint, now: number): void {
  p.frame = 0;
  if (!log.isConnected || paints.get(log) !== p || p.shown >= p.target.length) return;
  // A long gap (a hidden window) shows the rest at once rather than racing through it.
  const dt = now - p.last > 250 ? REVEAL_CATCHUP_MS : now - p.last;
  p.last = now;
  const f = follows.get(log);
  const pinned = f ? f.pinned : nearBottom(log);
  p.shown = revealStep(p.shown, p.target.length, dt);
  paintTail(p);
  if (pinned) {
    if (f) stick(log, f);
    else toBottom(log);
  }
  if (p.shown < p.target.length) p.frame = requestAnimationFrame((t) => revealFrame(log, p, t));
}

/**
 * Patch the log to `spec`. The conversation repaints only when it changed, the live tail as
 * it moves, and a streaming reply flows in (see revealStep). The log opens a session at its
 * latest message, stays pinned to the bottom while it's there, and goes there when the user
 * sends a message (see "following the conversation").
 */
export function paintChatLog(log: HTMLElement, spec: ChatLogSpec): void {
  const p = logPaint(log);
  const f = follow(log, p.flow);
  if (spec.session !== f.session) {
    f.session = spec.session;
    f.pinned = true;
    f.unseen = false;
  }
  const before = p.spec;
  const key = historySig(spec);
  if (key !== p.historyKey) {
    p.historyKey = key;
    patchHtml(p.history, chatLogParts(spec).history);
  }
  const target = spec.busy ? spec.partial || "" : "";
  // Something arrived below: a message, more of the reply, or the turn's outcome.
  const arrived =
    (!!before && (tipSig(spec.items) !== tipSig(before.items) || (!!spec.trailer && spec.trailer !== before.trailer))) || target.length > p.target.length;
  p.shown = reduceMotion() ? target.length : revealKept(p.target, p.shown, target);
  p.target = target;
  p.spec = spec;
  paintTail(p);
  // Only a message just sent pulls the log down; one waiting to be read doesn't hold it there.
  const sending = sendingSig(spec);
  const sent = !!sending && sending !== p.sending;
  p.sending = sending;
  if (sent) {
    f.pinned = true;
    f.unseen = false;
  } else if (!f.pinned && arrived) {
    f.unseen = true;
  }
  if (f.pinned) stick(log, f);
  showJump(log, f);
  if (p.shown < target.length && !p.frame) {
    p.last = performance.now();
    p.frame = requestAnimationFrame((t) => revealFrame(log, p, t));
  }
  paintIndex(log, spec);
}

/** The wheel over something floating on the log scrolls the log, as it would over the log itself. */
function wheelLog(log: HTMLElement, e: WheelEvent): void {
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? log.clientHeight : 1;
  log.scrollBy({ top: e.deltaY * unit, left: e.deltaX * unit });
}

// ---- the prompt index: the rail ------------------------------------------------------------
//
// Painted with the log, from the same spec (see "the prompt index: what it shows"). The ticks
// are one tab stop: Tab reaches the current one, the arrows, Home and End move between them, and
// Enter or a click jumps. A jump scrolls the prompt to the top of the view (or as far as the log
// goes) and flashes it, and that prompt stays current until the log scrolls away from where the
// jump landed. A jump up leaves the log unpinned; one to the foot keeps it pinned.

interface PromptIndex {
  view: HTMLElement;
  nav: HTMLElement;
  card: HTMLElement;
  marks: PromptMark[];
  /** The prompts' bubbles in the log, in the marks' order: null for one not on the page. */
  els: (HTMLElement | null)[];
  sig: string;
  /** The tick marked current: -1 when the ticks need marking again. */
  current: number;
  /** Focus was in the rail when the ticks were marked. */
  focused: boolean;
  /** The prompt jumped to, or -1. */
  picked: number;
  /** Where that jump landed: NaN while it's on its way. */
  pickedTop: number;
  /** The bubble to flash when the jump lands. */
  landing: HTMLElement | null;
  settle: number;
  flash: { el: HTMLElement; timer: number } | null;
  /** The tick whose card shows, or -1. */
  cardFor: number;
  cardHtml: string;
  frame: number;
  session: string | undefined;
}

const indexes = new WeakMap<HTMLElement, PromptIndex>();
/** A little longer than the flash's animation. */
const FLASH_MS = 1300;
/** A jump that hasn't reported its end by then has landed. */
const SETTLE_MS = 1500;

/** The log's prompt index, wired on first paint. None for a log outside a chat pane. */
function promptIndex(log: HTMLElement): PromptIndex | null {
  const known = indexes.get(log);
  if (known) return known;
  const view = log.parentElement;
  const nav = view?.querySelector<HTMLElement>(":scope > .chat-index");
  const card = view?.querySelector<HTMLElement>(":scope > .chat-index-card");
  if (!view || !nav || !card) return null;
  const x: PromptIndex = {
    view,
    nav,
    card,
    marks: [],
    els: [],
    sig: "",
    current: -1,
    focused: false,
    picked: -1,
    pickedTop: NaN,
    landing: null,
    settle: 0,
    flash: null,
    cardFor: -1,
    cardHtml: "",
    frame: 0,
    session: undefined,
  };
  indexes.set(log, x);
  wireIndex(log, x);
  return x;
}

function paintIndex(log: HTMLElement, spec: ChatLogSpec): void {
  const x = promptIndex(log);
  if (!x) return;
  if (spec.session !== x.session) {
    x.session = spec.session;
    dropPick(x);
  }
  const now = Date.now();
  const marks = promptMarks(spec);
  // The day is in it so "Today" turns into "Yesterday" overnight.
  const sig = JSON.stringify([dayStart(now), marks]);
  if (sig !== x.sig) {
    x.sig = sig;
    x.marks = marks;
    const html = promptIndexHtml(marks, now);
    // A rail going away with focus in it hands focus to the log, as the jump button does.
    if (!html && x.nav.contains(document.activeElement)) log.focus({ preventScroll: true });
    // Patching syncs each tick's attributes, so the marks go on again after.
    patchHtml(x.nav, html);
    x.nav.hidden = !html;
    x.view.classList.toggle("has-index", !!html);
    x.current = -1;
    x.els = [];
    if (x.picked >= marks.length) dropPick(x);
    if (x.cardFor >= 0) showCard(x, x.cardFor);
  }
  markCurrent(log, x);
}

/** A jump to a prompt is on its way. */
function promptJumping(log: HTMLElement): boolean {
  const x = indexes.get(log);
  return !!x && x.picked >= 0 && Number.isNaN(x.pickedTop);
}

function dropPick(x: PromptIndex): void {
  clearTimeout(x.settle);
  x.settle = 0;
  x.picked = -1;
  x.pickedTop = NaN;
  x.landing = null;
}

/** The prompts' bubbles, found again when the log changed under them. */
function promptEls(log: HTMLElement, x: PromptIndex): (HTMLElement | null)[] {
  if (x.els.length !== x.marks.length || x.els.some((el) => !el?.isConnected)) {
    x.els = x.marks.map((m) => log.querySelector<HTMLElement>(`.chat-msg[data-key="${CSS.escape(m.key)}"]`));
  }
  return x.els;
}

/** Where each bubble starts in the log's scrolled content. */
function promptTops(log: HTMLElement, els: readonly (HTMLElement | null)[]): number[] {
  const base = log.getBoundingClientRect().top + log.clientTop - log.scrollTop;
  return els.map((el) => (el?.isConnected ? el.getBoundingClientRect().top - base : NaN));
}

/** Mark the tick of the prompt being read, and make it the rail's tab stop unless focus is moving along the rail. */
function markCurrent(log: HTMLElement, x: PromptIndex, force = false): void {
  if (x.nav.hidden || !log.clientHeight) return;
  const current = x.picked >= 0 ? x.picked : currentPrompt(promptTops(log, promptEls(log, x)), log.scrollTop, log.clientHeight, log.scrollHeight);
  const active = document.activeElement;
  const focused = !!active && x.nav.contains(active);
  if (!force && current === x.current && focused === x.focused) return;
  const moved = current !== x.current;
  x.current = current;
  x.focused = focused;
  const ticks = x.nav.children;
  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i] as HTMLElement;
    const on = i === current;
    tick.classList.toggle("is-current", on);
    if (on) tick.setAttribute("aria-current", "location");
    else tick.removeAttribute("aria-current");
    tick.tabIndex = (focused ? tick === active : on) ? 0 : -1;
  }
  if (moved && !focused) keepTickInView(x, current);
}

/** A rail too long for the view scrolls: keep tick `i` in sight. */
function keepTickInView(x: PromptIndex, i: number): void {
  const nav = x.nav;
  const tick = nav.children[i] as HTMLElement | undefined;
  if (!tick || nav.scrollHeight <= nav.clientHeight) return;
  const top = tick.offsetTop;
  const bottom = top + tick.offsetHeight;
  if (top < nav.scrollTop) nav.scrollTop = top;
  else if (bottom > nav.scrollTop + nav.clientHeight) nav.scrollTop = bottom - nav.clientHeight;
}

function focusTick(log: HTMLElement, x: PromptIndex, i: number): void {
  const ticks = x.nav.children;
  const tick = ticks[i] as HTMLElement | undefined;
  if (!tick) return;
  for (let j = 0; j < ticks.length; j++) (ticks[j] as HTMLElement).tabIndex = j === i ? 0 : -1;
  tick.focus({ preventScroll: true });
  keepTickInView(x, i);
  markCurrent(log, x, true);
}

/** Scroll prompt `i` to the top of the view, or as far as the log goes, and flash it when it gets there. */
function jumpToPrompt(log: HTMLElement, x: PromptIndex, i: number): void {
  const el = promptEls(log, x)[i];
  if (!el || !log.clientHeight) return;
  const max = Math.max(0, log.scrollHeight - log.clientHeight);
  const target = Math.round(Math.max(0, Math.min(max, promptTops(log, [el])[0]! - PROMPT_PAD)));
  const f = follows.get(log);
  if (f) {
    // Up the conversation, the log stops following it; at its foot, it carries on.
    f.pinned = max - target < STICKY_PX;
    if (f.pinned) f.unseen = false;
  }
  dropPick(x);
  x.picked = i;
  x.landing = el;
  markCurrent(log, x);
  if (Math.abs(log.scrollTop - target) < 1) return settleJump(log, x);
  const smooth = !reduceMotion();
  log.scrollTo({ top: target, behavior: smooth ? "smooth" : "instant" });
  if (!smooth) return settleJump(log, x);
  x.settle = window.setTimeout(() => settleJump(log, x), SETTLE_MS);
}

/** The jump landed: remember where, so scrolling away from there lets the rail follow the log again. */
function settleJump(log: HTMLElement, x: PromptIndex): void {
  clearTimeout(x.settle);
  x.settle = 0;
  if (x.picked < 0 || !Number.isNaN(x.pickedTop)) return;
  x.pickedTop = log.scrollTop;
  const f = follows.get(log);
  if (f) {
    f.top = log.scrollTop;
    if (nearBottom(log)) {
      f.pinned = true;
      f.unseen = false;
    }
    showJump(log, f);
  }
  const el = x.landing;
  x.landing = null;
  if (el?.isConnected) flashPrompt(x, el);
  markCurrent(log, x, true);
}

function flashPrompt(x: PromptIndex, el: HTMLElement): void {
  if (x.flash) {
    clearTimeout(x.flash.timer);
    x.flash.el.classList.remove("flash");
  }
  // Restart the animation on a bubble that's still flashing.
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
  const timer = window.setTimeout(() => {
    el.classList.remove("flash");
    if (x.flash?.el === el) x.flash = null;
  }, FLASH_MS);
  x.flash = { el, timer };
}

/** Alt+↑ (-1) or Alt+↓ (1): the next prompt along from the one jumped to, or from the one being read. */
function stepToPrompt(log: HTMLElement, x: PromptIndex, dir: -1 | 1): void {
  let to: number;
  if (x.picked >= 0) {
    to = x.picked + dir;
  } else {
    const tops = promptTops(log, promptEls(log, x));
    to = stepPrompt(tops, currentPrompt(tops, log.scrollTop, log.clientHeight, log.scrollHeight), log.scrollTop, dir);
  }
  if (to < 0 || to >= x.marks.length) return;
  const inRail = x.nav.contains(document.activeElement);
  jumpToPrompt(log, x, to);
  if (inRail) focusTick(log, x, to);
}

/** The log scrolled: a landed jump lets go once the log moves away from it, and the ticks follow. */
function indexScrolled(log: HTMLElement): void {
  const x = indexes.get(log);
  if (!x) return;
  if (x.picked >= 0 && !Number.isNaN(x.pickedTop) && Math.abs(log.scrollTop - x.pickedTop) > 2) dropPick(x);
  scheduleIndex(log);
}

/** Mark the current tick on the next frame: scrolling and resizing ask for it many times a frame. */
function scheduleIndex(log: HTMLElement): void {
  const x = indexes.get(log);
  if (!x || x.frame || x.nav.hidden) return;
  x.frame = requestAnimationFrame(() => {
    x.frame = 0;
    if (log.isConnected) markCurrent(log, x);
  });
}

/** Show tick `i`'s card beside it: the prompt's first line, and when it was sent. */
function showCard(x: PromptIndex, i: number): void {
  const m = x.marks[i];
  const tick = x.nav.children[i] as HTMLElement | undefined;
  if (!m || !tick || x.nav.hidden) return hideCard(x);
  x.cardFor = i;
  const when = promptWhen(m, Date.now());
  const html = `<p class="chat-index-text">${esc(m.text || `Prompt ${i + 1}`)}</p>${when ? `<p class="chat-index-when">${esc(when)}</p>` : ""}`;
  if (html !== x.cardHtml) {
    x.cardHtml = html;
    x.card.innerHTML = html;
  }
  x.card.hidden = false;
  const view = x.view.getBoundingClientRect();
  const r = tick.getBoundingClientRect();
  const h = x.card.offsetHeight;
  const top = Math.max(8, Math.min(view.height - h - 8, r.top + r.height / 2 - view.top - h / 2));
  x.card.style.top = `${Math.round(top)}px`;
}

function hideCard(x: PromptIndex): void {
  x.cardFor = -1;
  x.card.hidden = true;
}

function wireIndex(log: HTMLElement, x: PromptIndex): void {
  const nav = x.nav;
  const tickAt = (t: EventTarget | null): number => {
    const tick = t instanceof Element ? t.closest<HTMLElement>(".chat-index-tick") : null;
    return tick && nav.contains(tick) ? Number(tick.dataset.i) : -1;
  };
  // The user scrolling takes over from a jump on its way.
  const takeOver = (): void => {
    if (promptJumping(log)) dropPick(x);
  };
  // A click leaves focus where it was (such as the message box); Enter or Space on a focused tick jumps too.
  nav.addEventListener("mousedown", (e) => e.preventDefault());
  nav.addEventListener("click", (e) => {
    const i = tickAt(e.target);
    if (i >= 0) jumpToPrompt(log, x, i);
  });
  nav.addEventListener("pointerover", (e) => {
    const i = tickAt(e.target);
    if (i >= 0) showCard(x, i);
  });
  nav.addEventListener("pointerleave", () => {
    const i = tickAt(document.activeElement);
    if (i >= 0) showCard(x, i);
    else hideCard(x);
  });
  nav.addEventListener("focusin", (e) => {
    const i = tickAt(e.target);
    if (i >= 0) showCard(x, i);
    markCurrent(log, x, true);
  });
  nav.addEventListener("focusout", (e) => {
    if (e.relatedTarget instanceof Node && nav.contains(e.relatedTarget)) return;
    if (!nav.matches(":hover")) hideCard(x);
    markCurrent(log, x, true);
  });
  nav.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const at = tickAt(document.activeElement);
    if (at < 0) return;
    const last = nav.children.length - 1;
    const to = e.key === "ArrowUp" ? at - 1 : e.key === "ArrowDown" ? at + 1 : e.key === "Home" ? 0 : e.key === "End" ? last : NaN;
    if (Number.isNaN(to)) return;
    e.preventDefault();
    focusTick(log, x, Math.max(0, Math.min(last, to)));
  });
  nav.addEventListener(
    "scroll",
    () => {
      if (x.cardFor >= 0) showCard(x, x.cardFor);
    },
    { passive: true }
  );
  // A rail that fits has nothing to scroll: the wheel over it scrolls the conversation.
  nav.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey || nav.scrollHeight > nav.clientHeight) return;
      takeOver();
      wheelLog(log, e);
    },
    { passive: false }
  );
  log.addEventListener("scrollend", () => {
    if (promptJumping(log)) settleJump(log, x);
  });
  log.addEventListener("wheel", takeOver, { passive: true });
  log.addEventListener("pointerdown", takeOver);
  log.addEventListener("keydown", (e) => {
    if (!e.altKey) takeOver();
  });
  // Alt+↑ and Alt+↓ step between prompts from anywhere in the pane, except while the "/" list has the arrows.
  const pane = log.closest<HTMLElement>(".chat");
  pane?.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    if (e.defaultPrevented || e.isComposing || nav.hidden || !log.clientHeight) return;
    const popup = pane.querySelector<HTMLElement>(":scope > .chat-compose > .chat-popup");
    if (popup && !popup.hidden) return;
    e.preventDefault();
    stepToPrompt(log, x, e.key === "ArrowUp" ? -1 : 1);
  });
}

export interface ComposerState {
  placeholder: string;
  /** The box can't be used at all. */
  disabled: boolean;
  /** A send is on its way: the box stays, but sending waits. */
  busy: boolean;
  /** A turn is running: Send queues the message for after it, and Send now puts it in. */
  working?: boolean;
  /** Send now can go into the running turn. */
  canSteer?: boolean;
}

export function setComposer(pane: ChatPane, s: ComposerState): void {
  pane.input.disabled = s.disabled;
  pane.input.placeholder = s.placeholder;
  pane.send.disabled = s.disabled || s.busy;
  const label = s.busy ? "…" : s.working ? "Queue" : "Send";
  if (pane.send.textContent !== label) pane.send.textContent = label;
  pane.send.title = s.working ? "Run it after this turn (Enter)" : "";
  pane.steer.hidden = !s.working;
  pane.steer.disabled = s.disabled || s.busy || !s.canSteer;
  pane.attach.disabled = s.disabled;
}

/** What a key in the message box asks for: send (Enter), send now (Ctrl+Enter), or nothing. */
export function composerKey(e: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "isComposing">): "send" | "steer" | null {
  if (e.key !== "Enter" || e.isComposing || e.shiftKey || e.altKey) return null;
  return e.ctrlKey || e.metaKey ? "steer" : "send";
}

export function setHint(pane: ChatPane, text: string, error = false): void {
  pane.hint.classList.toggle("err", error);
  if (pane.hint.textContent !== text) pane.hint.textContent = text;
}

/**
 * Grow a textarea to its text, up to its `data-max` (or 160px). Sizes are border-box:
 * scrollHeight leaves out the border, so add it back or a bordered box scrolls.
 */
export function autoSize(area: HTMLTextAreaElement): void {
  area.style.height = "auto";
  const border = area.offsetHeight - area.clientHeight;
  area.style.height = Math.min(area.scrollHeight + border, Number(area.dataset.max) || DEFAULT_MAX_PX) + "px";
}
