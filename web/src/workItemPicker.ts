// The New task dialog's work item picker: the Work item field as a combobox (the APG "list
// autocomplete" pattern) over GET /api/jarvis/workitems. Empty, it lists the open items assigned to
// you; typed words search the titles in the projects opted in under Settings; a number or link
// closes the list and is looked up as it is. The rules are in workItemPickerModel.ts.
//
// The list sits inside the dialog, under the field: the dialog is aria-modal, so a screen reader
// reads nothing outside it, and its backdrop-filter would clip a fixed-position list anyway.
import { api } from "./api.js";
import { esc } from "./util.js";
import {
  classifyQuery,
  countAnnouncement,
  highlightParts,
  listHeading,
  moveIndex,
  optionAnnouncement,
  optionMeta,
  searchQuery,
  suggestionsNote,
  type WorkItemOption,
  type WorkItemSuggestions,
} from "./workItemPickerModel.js";

/** Typing pauses this long before a search goes out. */
const SEARCH_DELAY_MS = 250;
/** The service gives each ADO call 15s; the assigned list makes two, after a token. */
const REQUEST_TIMEOUT_MS = 45_000;
/** Your assigned items barely change while a dialog is open; reopening it within this reuses them. */
const ASSIGNED_TTL_MS = 60_000;
const SEARCH_CACHE_MAX = 30;
/** The list flips above the field when less than this fits below it. */
const MIN_ROOM_BELOW = 160;
const MIN_LIST_HEIGHT = 120;

let assignedCache: { at: number; data: WorkItemSuggestions } | null = null;

export interface WorkItemPicker {
  /** Hide the list and drop any lookup in flight. */
  close(): void;
  /** Close, and stop listening to the field. */
  destroy(): void;
}

export interface WorkItemPickerOptions {
  /** The field, in a positioned wrapper the list is added to. */
  input: HTMLInputElement;
  /** Items can come from more than one org, so each row names its own. */
  multiOrg: boolean;
  onPick: (item: WorkItemOption) => void;
}

export function attachWorkItemPicker({ input, multiOrg, onPick }: WorkItemPickerOptions): WorkItemPicker {
  const base = input.id || "wi-picker";
  const listId = `${base}-list`;
  const popup = document.createElement("div");
  popup.className = "wi-popup";
  popup.hidden = true;
  popup.innerHTML = `<p class="chat-pop-group" aria-hidden="true" hidden></p>
    <div class="wi-list" role="listbox" id="${esc(listId)}" aria-label="Work items"></div>
    <p class="chat-pop-msg" hidden></p>`;
  const head = popup.querySelector<HTMLElement>(".chat-pop-group")!;
  const list = popup.querySelector<HTMLElement>(".wi-list")!;
  const msg = popup.querySelector<HTMLElement>(".chat-pop-msg")!;
  const live = document.createElement("span");
  live.className = "visually-hidden";
  live.setAttribute("aria-live", "polite");
  input.parentElement!.append(popup, live);

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", listId);
  input.setAttribute("aria-expanded", "false");

  let open = false;
  let items: WorkItemOption[] = [];
  let scope: WorkItemSuggestions["scope"] = "assigned";
  /** What the rows shown answer, for marking the matched words. */
  let shownQuery = "";
  let index = -1;
  /** A lookup is in flight; the rows shown, if any, answer an earlier one. */
  let busy = false;
  let busyLabel = "Searching…";
  let seq = 0;
  let timer: number | undefined;
  let controller: AbortController | null = null;
  let destroyed = false;
  const searches = new Map<string, WorkItemSuggestions>();

  const announce = (text: string): void => {
    if (live.textContent !== text) live.textContent = text;
  };

  /** Room for the list inside the dialog's visible box: below the field, or above when below is cramped. */
  const place = (): void => {
    const field = input.getBoundingClientRect();
    const frame = input.closest(".ask-dialog")?.getBoundingClientRect();
    const top = Math.max(frame?.top ?? 0, 0) + 8;
    const bottom = Math.min(frame?.bottom ?? window.innerHeight, window.innerHeight) - 8;
    const below = bottom - field.bottom - 4;
    const above = field.top - top - 4;
    const flip = below < MIN_ROOM_BELOW && above > below;
    const cap = Math.min(340, window.innerHeight * 0.5);
    popup.classList.toggle("above", flip);
    popup.style.maxHeight = `${Math.round(Math.max(MIN_LIST_HEIGHT, Math.min(cap, flip ? above : below)))}px`;
  };

  const setNote = (note: { text: string; detail?: string; error?: boolean } | null): void => {
    msg.hidden = !note;
    msg.textContent = note?.text || "";
    msg.classList.toggle("err", !!note?.error);
    if (note?.detail) msg.title = note.detail;
    else msg.removeAttribute("title");
  };

  const paintActive = (): void => {
    const rows = [...list.querySelectorAll<HTMLElement>("[role=option]")];
    rows.forEach((option, i) => {
      option.classList.toggle("active", i === index);
      option.setAttribute("aria-selected", String(i === index));
    });
    const row = index >= 0 ? rows[index] : undefined;
    if (row) {
      input.setAttribute("aria-activedescendant", row.id);
      row.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  };

  const paintRows = (): void => {
    head.hidden = !items.length;
    head.textContent = busy ? busyLabel : listHeading(scope);
    list.setAttribute("aria-label", items.length ? listHeading(scope) : "Work items");
    list.setAttribute("aria-busy", String(busy));
    const marked = scope === "search" ? shownQuery : "";
    list.innerHTML = items
      .map((item, i) => {
        const title = highlightParts(item.title, marked)
          .map((p) => (p.hit ? `<mark>${esc(p.text)}</mark>` : esc(p.text)))
          .join("");
        return `<div class="chat-pop-item wi-option" role="option" id="${esc(`${base}-opt-${i}`)}" aria-selected="false" data-pick="${i}">
            <span class="wi-title" title="${esc(item.title)}">${title}</span>
            <span class="wi-meta">${esc(optionMeta(item, multiOrg))}</span>
          </div>`;
      })
      .join("");
    paintActive();
  };

  const show = (): void => {
    if (!open) {
      open = true;
      popup.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }
    place();
  };

  const cancel = (): void => {
    seq++;
    window.clearTimeout(timer);
    controller?.abort();
    controller = null;
  };

  const close = (): void => {
    cancel();
    open = false;
    busy = false;
    items = [];
    index = -1;
    popup.hidden = true;
    list.innerHTML = "";
    setNote(null);
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    announce("");
  };

  const destroy = (): void => {
    if (destroyed) return;
    close();
    destroyed = true;
    input.removeEventListener("focus", update);
    input.removeEventListener("click", reopen);
    input.removeEventListener("input", update);
    input.removeEventListener("keydown", onKey);
    input.removeEventListener("blur", close);
    window.removeEventListener("resize", onResize);
    popup.remove();
    live.remove();
  };

  /** The field was taken out with its dialog: let go of everything. */
  const gone = (): boolean => {
    if (!input.isConnected) destroy();
    return destroyed;
  };

  const showResults = (data: WorkItemSuggestions, query: string): void => {
    busy = false;
    scope = data.scope;
    items = Array.isArray(data.items) ? data.items : [];
    shownQuery = query;
    index = items.length ? 0 : -1;
    const note = suggestionsNote({ ...data, items, errors: Array.isArray(data.errors) ? data.errors : [] });
    setNote(note);
    paintRows();
    show();
    announce(
      items.length
        ? `${countAnnouncement(scope, items.length)} ${optionAnnouncement(items[0], 0, items.length, multiOrg)}`
        : note?.text || ""
    );
  };

  const request = (query: string, want: WorkItemSuggestions["scope"]): void => {
    cancel();
    const my = seq;
    const key = query.toLowerCase();
    const cached =
      want === "assigned"
        ? assignedCache && Date.now() - assignedCache.at < ASSIGNED_TTL_MS
          ? assignedCache.data
          : null
        : searches.get(key);
    if (cached) return showResults(cached, query);
    // Rows from an earlier lookup stay, dimmed, until this one answers. None is active, so Enter
    // can't take an old row by accident; the arrows can still choose one on purpose.
    busy = true;
    busyLabel = want === "assigned" ? "Looking up what's assigned to you…" : "Searching…";
    index = -1;
    if (items.length) setNote(null);
    else setNote({ text: busyLabel });
    paintRows();
    show();
    timer = window.setTimeout(async () => {
      const mine = new AbortController();
      controller = mine;
      try {
        const data = (await api(`/api/jarvis/workitems?q=${encodeURIComponent(query)}`, {
          signal: mine.signal,
          timeoutMs: REQUEST_TIMEOUT_MS,
        })) as WorkItemSuggestions;
        if (my !== seq || gone()) return;
        // Only a full answer is kept: a failed org, or no projects yet, is asked again next time.
        if (!data?.errors?.length && !data?.noProjects) {
          if (want === "assigned") assignedCache = { at: Date.now(), data };
          else {
            searches.delete(key);
            searches.set(key, data);
            if (searches.size > SEARCH_CACHE_MAX) searches.delete(searches.keys().next().value!);
          }
        }
        showResults(data, query);
      } catch (e) {
        if (my !== seq || gone() || (e as Error)?.name === "AbortError") return;
        const message = (e as Error)?.message || "The lookup failed.";
        busy = false;
        items = [];
        index = -1;
        setNote({ text: "Couldn't look up work items. Enter the work item's number or link instead.", detail: message, error: true });
        paintRows();
        show();
        announce(`Couldn't look up work items: ${message}`);
      } finally {
        if (controller === mine) controller = null;
      }
    }, want === "assigned" ? 0 : SEARCH_DELAY_MS);
  };

  /** Show what fits what's in the field now. */
  function update(): void {
    if (destroyed) return;
    const kind = classifyQuery(input.value);
    if (kind === "ref") return close();
    if (kind === "short") {
      cancel();
      busy = false;
      items = [];
      index = -1;
      setNote({ text: "Keep typing to search titles." });
      paintRows();
      show();
      return;
    }
    request(kind === "empty" ? "" : searchQuery(input.value), kind === "empty" ? "assigned" : "search");
  }

  const move = (delta: number): void => {
    if (!items.length) return;
    index = moveIndex(index, delta, items.length);
    paintActive();
    announce(optionAnnouncement(items[index], index, items.length, multiOrg));
  };

  const pick = (i: number): void => {
    const item = items[i];
    if (!item) return;
    close();
    onPick(item);
    announce(`Chose ${item.type || "work item"} #${item.id}, ${item.title}.`);
  };

  function onKey(e: KeyboardEvent): void {
    if (e.isComposing) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) update();
        else if (!e.altKey) move(1);
        return;
      case "ArrowUp":
        if (!open) return;
        e.preventDefault();
        if (e.altKey) close();
        else move(-1);
        return;
      case "Enter":
        if (!open || !items[index]) return;
        e.preventDefault();
        e.stopPropagation();
        pick(index);
        return;
      case "Escape":
        // The dialog lets an open list's Escape through (prActions.ts), so this one closes just the list.
        if (!open) return;
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      case "Tab":
        close();
        return;
    }
  }

  /** A click in the field brings back a list Escape or a pick put away; the keyboard has Alt+Down. */
  function reopen(): void {
    if (!open) update();
  }

  function onResize(): void {
    if (!gone() && open) place();
  }

  // Keep the field focused while a row is clicked, so blur doesn't close the list first.
  popup.addEventListener("mousedown", (e) => e.preventDefault());
  popup.addEventListener("click", (e) => {
    const row = (e.target as Element).closest<HTMLElement>("[data-pick]");
    if (row) pick(Number(row.dataset.pick));
  });
  input.addEventListener("focus", update);
  input.addEventListener("click", reopen);
  input.addEventListener("input", update);
  input.addEventListener("keydown", onKey);
  input.addEventListener("blur", close);
  window.addEventListener("resize", onResize);

  return { close, destroy };
}
