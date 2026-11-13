// Entry for todos.html: the full To-dos window. One for the app; the Workspace's To-dos panel
// opens it, and a second open brings it forward. The list is todoList.ts, the same controller
// as the panel's; this page adds search, the filters and select mode around it, and keeps the
// list fresh: a change here tells the main window, and a change there tells this one.
import { applyShellClasses } from "./shell.js";
import { bindIdentity, getJSON } from "./api.js";
import { esc } from "./util.js";
import { icon } from "./icons.js";
import { state } from "./state.js";
import type { Todo } from "./jarvisModel.js";
import { createTodoList, onTodosChanged } from "./todoList.js";
import { TODO_FILTERS, filterCounts, isTodoFilter, todayKey, type TodoFilter } from "./todoModel.js";

interface TaskLine {
  id: string;
  title: string;
  status: string;
}

const FILTER_KEY = "adoPrOps.todosWindow.filter";
const QUERY_KEY = "adoPrOps.todosWindow.query";
const POLL_MS = 15_000;

const params = new URLSearchParams(location.search);
applyShellClasses(params);

const toolsEl = document.getElementById("todosTools") as HTMLElement;
const listEl = document.getElementById("todosList") as HTMLElement;
const errEl = document.getElementById("todosErr") as HTMLElement;

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: it lasts for the page */
  }
}

let todos: Todo[] | null = null;
let tasks: TaskLine[] = [];
const saved = readPref(FILTER_KEY);
let filter: TodoFilter = isTodoFilter(saved) ? saved : "all";
let query = readPref(QUERY_KEY) || "";
let loadToken = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

// ---- toolbar ------------------------------------------------------------------------

toolsEl.innerHTML = `
  <label class="queue-search pp-search tw-search">${icon("search")}<input type="search" id="todosQuery" value="${esc(
    query
  )}" placeholder="Search to-dos" aria-label="Search to-dos" aria-keyshortcuts="/ Control+F" spellcheck="false" autocomplete="off"></label>
  <div class="pp-chips tw-chips" role="group" aria-label="Show">${TODO_FILTERS.map(
    (f) =>
      `<button type="button" class="pp-chip" data-filter="${f.id}" aria-pressed="${f.id === filter}">${esc(f.label)}<span class="tw-chip-n"></span></button>`
  ).join("")}</div>
  <span class="tw-sp"></span>
  <button type="button" class="btn sm ghost tw-select" data-act="tw-select" aria-pressed="false" title="Select to-dos to check off, date, delete or start together">${icon("check")}<span>Select</span></button>`;

const searchEl = toolsEl.querySelector<HTMLInputElement>("#todosQuery")!;
const selectBtn = toolsEl.querySelector<HTMLButtonElement>('[data-act="tw-select"]')!;
const chips = [...toolsEl.querySelectorAll<HTMLButtonElement>(".pp-chip[data-filter]")];

// The task a to-do started, or came from, opens in the main window.
const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("devis-todos") : null;

const list = createTodoList(listEl, {
  mode: "window",
  todos: () => todos,
  setTodos: (next) => {
    todos = next;
  },
  reload: () => void load(),
  repaint: () => paint(),
  openTask: (taskId) => {
    channel?.postMessage({ type: "open-task", taskId });
    // The shell brings the main window forward; a page can't raise another window by itself.
    if (document.documentElement.classList.contains("wco")) window.open("/?focus=main");
  },
  taskTitle: (taskId) => tasks.find((t) => t.id === taskId)?.title ?? null,
  view: () => ({ filter, query }),
  onSelecting: (on) => selectBtn.setAttribute("aria-pressed", String(on)),
  selectButton: () => selectBtn,
});

/** The chips' counts and the window's title, then the list. */
function paint(): void {
  const counts = todos ? filterCounts(todos, todayKey()) : null;
  for (const chip of chips) {
    const id = chip.dataset.filter as TodoFilter;
    chip.setAttribute("aria-pressed", String(id === filter));
    const n = chip.querySelector<HTMLElement>(".tw-chip-n")!;
    const text = counts && counts[id] ? String(counts[id]) : "";
    if (n.textContent !== text) n.textContent = text;
    // Overdue reads as a warning only while something is.
    chip.classList.toggle("is-alert", id === "overdue" && !!counts?.overdue);
  }
  const open = counts?.all ?? 0;
  document.title = open ? `To-dos (${open}) \u00b7 Devis` : "To-dos \u00b7 Devis";
  list.render();
}

function setFilter(next: TodoFilter): void {
  if (next === filter) return;
  filter = next;
  writePref(FILTER_KEY, filter);
  paint();
}

function setQuery(next: string): void {
  if (next === query) return;
  query = next;
  writePref(QUERY_KEY, query);
  paint();
}

toolsEl.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const chip = target.closest<HTMLButtonElement>(".pp-chip[data-filter]");
  if (chip && isTodoFilter(chip.dataset.filter)) return setFilter(chip.dataset.filter);
  if (target.closest('[data-act="tw-select"]')) list.setSelecting(!list.selecting);
});

searchEl.addEventListener("input", () => setQuery(searchEl.value));
searchEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && searchEl.value) {
    e.preventDefault();
    e.stopPropagation();
    searchEl.value = "";
    setQuery("");
  } else if (e.key === "ArrowDown") {
    // Down from the search steps into the list.
    const first = listEl.querySelector<HTMLElement>(".todo[data-todo] > .todo-pick, .todo[data-todo] > .todo-check");
    if (!first) return;
    e.preventDefault();
    first.focus();
  }
});

// "/" or Ctrl+F finds; anywhere but a text box.
document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented) return;
  const target = e.target as HTMLElement;
  const typing = target.closest("input, textarea, select, [contenteditable]");
  const find = (e.key === "f" || e.key === "F") && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
  const slash = e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing;
  if (!find && !slash) return;
  if (document.querySelector("[role=menu], [role=dialog]")) return;
  e.preventDefault();
  searchEl.focus();
  searchEl.select();
});

// ---- loading ------------------------------------------------------------------------

async function load(): Promise<void> {
  clearTimeout(pollTimer);
  const token = ++loadToken;
  // A read that was on its way while the list changed carries the list from before; it's set aside.
  const rev = list.rev;
  try {
    const res = await getJSON("/api/jarvis/todos");
    if (token !== loadToken) return;
    if (rev === list.rev && Array.isArray(res?.todos)) {
      todos = res.todos;
      tasks = Array.isArray(res.tasks) ? res.tasks : [];
      list.prune();
    }
    showError("");
    paint();
  } catch (e) {
    if (token !== loadToken) return;
    // With a list on screen, a missed read waits for the next one.
    if (!todos) showError((e as Error).message);
  } finally {
    if (token === loadToken && !document.hidden) pollTimer = setTimeout(() => void load(), POLL_MS);
  }
}

function showError(message: string): void {
  if (!message) {
    errEl.hidden = true;
    errEl.replaceChildren();
    return;
  }
  errEl.hidden = false;
  errEl.innerHTML = `${icon("warning")}<span>Couldn't read your to-dos. ${esc(message)}</span><button type="button" class="btn sm ghost" data-act="tw-retry">Try again</button>`;
}

errEl.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest('[data-act="tw-retry"]')) void load();
});

onTodosChanged(() => void load());
window.addEventListener("focus", () => void load());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(pollTimer);
  else void load();
});

async function boot(): Promise<void> {
  paint();
  await bindIdentity();
  // The start dialog proposes the task's folder under the configured task root.
  try {
    state.config = await getJSON("/api/config");
  } catch {
    /* the dialog asks for the folder instead */
  }
  await load();
  if (!readPref(QUERY_KEY) && filter !== "done") listEl.querySelector<HTMLInputElement>('[data-td-draft="new"]')?.focus();
}

void boot();
