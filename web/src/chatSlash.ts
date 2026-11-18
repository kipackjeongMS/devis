// The "/" list over a chat's message box: commands and skills as you type, then a command's own
// choices. The task's worker chat and Devis's chat show the same list; this is its shared part.

import { esc } from "./util.js";
import { matchCommands, resolveCommand, slashQuery, type ChatCommand } from "./taskChatModel.js";
import type { ChatPane } from "./chatPane.js";

export type SlashPopup =
  | { mode: "commands"; items: ChatCommand[]; index: number }
  | { mode: "choices"; command: ChatCommand; items: Array<{ name: string; description: string }>; index: number };

/** The list's rows, with the highlighted one marked. `prefix` keeps ids apart between panes. */
export function slashPopupHtml(p: SlashPopup, prefix: string): string {
  const row = (i: number, inner: string): string =>
    `<div class="chat-pop-item${i === p.index ? " active" : ""}" role="option" id="${esc(prefix)}-opt-${i}" aria-selected="${i === p.index}" data-pick="${i}">${inner}</div>`;
  let html = "";
  if (p.mode === "commands") {
    let kind = "";
    p.items.forEach((c, i) => {
      if (c.kind !== kind) {
        kind = c.kind;
        html += `<p class="chat-pop-group">${kind === "skill" ? "Skills" : "Commands"}</p>`;
      }
      // Every skill takes free text, so only built-ins show what they take.
      const hint = c.kind === "builtin" ? c.hint : "";
      html += row(
        i,
        `<span class="chat-pop-name">/${esc(c.name)}</span>${hint ? `<span class="chat-pop-hint">${esc(hint)}</span>` : ""}<span class="chat-pop-desc">${esc(c.description)}</span>`
      );
    });
  } else {
    html += `<p class="chat-pop-group">/${esc(p.command.name)}</p>`;
    p.items.forEach((c, i) => {
      html += row(i, `<span class="chat-pop-name">${esc(c.name)}</span><span class="chat-pop-desc">${esc(c.description)}</span>`);
    });
  }
  return html;
}

/** What a screen reader hears for the highlighted row. */
export function slashPopupLabel(p: SlashPopup): string {
  const item = p.items[p.index];
  const name = p.mode === "commands" ? `/${item.name}` : item.name;
  return `${name}${item.description ? `, ${item.description}` : ""}. ${p.index + 1} of ${p.items.length}.`;
}

/** The line under the box for a command that's been typed: what it is and what it takes. */
export function commandHint(list: ChatCommand[] | null, text: string): string | null {
  const typed = list ? resolveCommand(list, text) : null;
  if (!typed) return null;
  const c = typed.command;
  return `/${c.name}${c.hint ? ` ${c.hint}` : ""}${c.description ? ` · ${c.description}` : ""}`;
}

/** The "/" list for one pane: loads the commands once, filters them as the user types, and picks into the box. */
export class SlashList {
  list: ChatCommand[] | null = null;
  popup: SlashPopup | null = null;
  private loading: Promise<void> | null = null;
  private error = "";

  constructor(
    private readonly pane: ChatPane,
    private readonly prefix: string,
    private readonly load: () => Promise<ChatCommand[]>,
    /** After picking: the box changed, so the hint and size may too. */
    private readonly changed: () => void
  ) {
    // Picking from the list keeps the cursor in the box.
    pane.popup.addEventListener("mousedown", (e) => e.preventDefault());
    pane.input.addEventListener("blur", () => window.setTimeout(() => document.activeElement !== pane.input && this.hide(), 150));
  }

  get open(): boolean {
    return !!this.popup || !this.pane.popup.hidden;
  }

  /** Read the commands again (a new session may have different skills). */
  reset(): void {
    this.list = null;
    this.error = "";
    this.hide();
  }

  private fetch(): void {
    if (this.loading || this.list) return;
    this.loading = this.load()
      .then((list) => {
        this.list = list;
        this.error = "";
      })
      .catch((e: Error) => {
        this.error = e.message;
      })
      .finally(() => {
        this.loading = null;
        this.refresh();
      });
  }

  /** Show what the box's text calls for: matching commands, a command's choices, or nothing. */
  refresh(): void {
    const { input } = this.pane;
    if (input.disabled || document.activeElement !== input) return this.hide();
    const text = input.value;
    const query = slashQuery(text);
    if (query !== null) {
      if (!this.list) {
        if (!this.error) this.fetch();
        return this.message(this.error ? `Couldn't load commands: ${this.error}` : "Loading commands and skills…", !!this.error);
      }
      const items = matchCommands(this.list, query);
      const prev = this.popup?.mode === "commands" ? this.popup.items[this.popup.index]?.name : undefined;
      const index = Math.max(0, items.findIndex((c) => c.name === prev));
      this.popup = items.length ? { mode: "commands", items, index } : null;
      return items.length ? this.paint() : this.message(`No command or skill matches /${query}.`, false);
    }
    // "/name partial": the command's own choices, like /mcp show.
    const choice = /^\/([\w.:-]+) ([\w.:-]*)$/.exec(text.trimStart());
    const command = choice && this.list ? resolveCommand(this.list, `/${choice[1]}`)?.command : undefined;
    if (command?.choices.length) {
      const typed = choice![2].toLowerCase();
      const items = command.choices.filter((c) => c.name.toLowerCase().startsWith(typed));
      if (items.length && !(items.length === 1 && items[0].name.toLowerCase() === typed)) {
        this.popup = { mode: "choices", command, items, index: 0 };
        return this.paint();
      }
    }
    this.hide();
  }

  private message(text: string, error: boolean): void {
    this.popup = null;
    this.pane.popup.innerHTML = `<p class="chat-pop-msg${error ? " err" : ""}">${esc(text)}</p>`;
    this.pane.popup.hidden = false;
    this.pane.sr.textContent = text;
  }

  hide(): void {
    this.popup = null;
    this.pane.popup.hidden = true;
    this.pane.popup.innerHTML = "";
  }

  private paint(): void {
    const p = this.popup;
    if (!p) return this.hide();
    this.pane.popup.innerHTML = slashPopupHtml(p, this.prefix);
    this.pane.popup.hidden = false;
    this.pane.sr.textContent = slashPopupLabel(p);
    this.pane.popup.querySelector<HTMLElement>(".chat-pop-item.active")?.scrollIntoView({ block: "nearest" });
  }

  /** Move the highlight. */
  move(delta: number): void {
    const p = this.popup;
    if (!p) return;
    p.index = (p.index + delta + p.items.length) % p.items.length;
    this.paint();
  }

  /** Put the picked row in the box. True when what's there is complete enough to send. */
  pick(index: number): boolean {
    const p = this.popup;
    if (!p) return false;
    const { input } = this.pane;
    if (p.mode === "commands") {
      const c = p.items[index];
      if (!c) return false;
      input.value = `/${c.name} `;
      this.hide();
      this.changed();
      if (c.choices.length) this.refresh();
      return !c.hint && !c.required && !c.choices.length;
    }
    const choice = p.items[index];
    if (!choice) return false;
    input.value = `/${p.command.name} ${choice.name}`;
    this.hide();
    this.changed();
    return true;
  }
}
