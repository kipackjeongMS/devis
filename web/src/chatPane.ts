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

/** A message as the log shows it. One from the session's history carries its id. */
export interface ChatLine {
  id?: string;
  role: "user" | "assistant";
  content: string;
  /** Images the user sent with it. */
  images?: ChatImage[];
}

export type LogItem = { type: "message"; message: ChatLine } | { type: "note"; note: ChatNote };

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

export function chatPaneHtml(o: ChatPaneOptions): string {
  const popup = `${o.id}-popup`;
  const wired = o.commands ? ` aria-autocomplete="list" aria-controls="${esc(popup)}"` : "";
  return `
    <div class="chat"${o.label ? ` role="group" aria-label="${esc(o.label)}"` : ""}>
      <div class="chat-head"${o.headHtml ? "" : " hidden"}>${o.headHtml || ""}</div>
      <div class="chat-log" role="log" aria-live="polite" tabindex="0"></div>
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
  log: HTMLElement;
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
    log: q(".chat-log"),
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

/** The user's words in their bubble; none for a message that is only images. */
const userText = (content: string): string => (content.trim() ? `<p>${esc(content)}</p>` : "");

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
        <div class="chat-queued-body">${messageImagesHtml(m.images, true)}${m.text.trim() ? `<p>${esc(m.text)}</p>` : ""}</div>
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
  for (const item of spec.items) history.push(item.type === "message" ? messageHtml(item.message) : noteHtml(item.note));
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
const itemSig = (i: LogItem): string => (i.type === "message" ? `${i.message.id ?? ""}:${i.message.content.length}:${i.message.images?.length || 0}` : `n:${i.note.id}`);

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
  if (known && known.history.parentNode === log && known.tail.parentNode === log) return known;
  log.innerHTML = `<div class="chat-hist"></div><div class="chat-tail"></div>`;
  const p: LogPaint = {
    history: log.firstElementChild as HTMLElement,
    tail: log.lastElementChild as HTMLElement,
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
  const stick = nearBottom(log);
  p.shown = revealStep(p.shown, p.target.length, dt);
  paintTail(p);
  if (stick) log.scrollTop = log.scrollHeight;
  if (p.shown < p.target.length) p.frame = requestAnimationFrame((t) => revealFrame(log, p, t));
}

/**
 * Patch the log to `spec`. The conversation repaints only when it changed, the live tail as
 * it moves, and a streaming reply flows in (see revealStep). The log stays pinned to the
 * bottom if it was there, and goes there when the user sends a message.
 */
export function paintChatLog(log: HTMLElement, spec: ChatLogSpec): void {
  const p = logPaint(log);
  const stick = nearBottom(log);
  const key = historySig(spec);
  if (key !== p.historyKey) {
    p.historyKey = key;
    patchHtml(p.history, chatLogParts(spec).history);
  }
  const target = spec.busy ? spec.partial || "" : "";
  p.shown = reduceMotion() ? target.length : revealKept(p.target, p.shown, target);
  p.target = target;
  p.spec = spec;
  paintTail(p);
  // Only a message just sent pulls the log down; one waiting to be read doesn't hold it there.
  const sending = sendingSig(spec);
  const sent = !!sending && sending !== p.sending;
  p.sending = sending;
  if (stick || sent) log.scrollTop = log.scrollHeight;
  if (p.shown < target.length && !p.frame) {
    p.last = performance.now();
    p.frame = requestAnimationFrame((t) => revealFrame(log, p, t));
  }
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
