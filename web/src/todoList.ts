// The to-do list, in the Workspace's To-dos panel and in the full To-dos window. One controller
// owns the list's markup, selection, editing, keyboard and menus; its host owns where the list
// sits and how the to-dos load. A change shows at once and the server's answer, which carries the
// whole list, settles it; the other window hears of the change and reads the list again.
import { postJSON, type ApiError } from "./api.js";
import { esc } from "./util.js";
import { icon as svg, type IconName } from "./icons.js";
import { patchHtml } from "./patch.js";
import { toast } from "./toast.js";
import { state } from "./state.js";
import { openActionDialog } from "./prActions.js";
import { openContextMenu, menuPoint, type ContextMenuEntry } from "./contextMenu.js";
import { MODEL_FIELDS, chosenModel, wireModelFields } from "./modelFields.js";
import { agoPhrase, taskFolderPreview, type Todo } from "./jarvisModel.js";
import { checkState, contextIsSelected, pruned, ranged, rowClick, toggled, toggledAll } from "./prSelectionModel.js";
import {
  MAX_WORKERS,
  PRIORITIES,
  addDays,
  ancestors,
  canMove,
  descendants,
  dueInfo,
  isDayKey,
  movedTodos,
  nextMonday,
  priorityName,
  progress,
  shortDay,
  splitBlocked,
  splitGroups,
  todayKey,
  topPicks,
  visibleRows,
  type SplitMode,
  type TodoFilter,
  type TodoRow,
} from "./todoModel.js";

export interface TodoListHost {
  /** The Workspace's To-dos panel, or the full To-dos window. */
  readonly mode: "panel" | "window";
  /** The to-dos, or null while the first read is on its way. */
  todos(): Todo[] | null;
  setTodos(list: Todo[]): void;
  /** Read the list from the server again. */
  reload(): void;
  /** Paint the host around the list; it renders the list too. */
  repaint(): void;
  openTask(taskId: string): void;
  /** A task's title, while the task is still there. */
  taskTitle(taskId: string): string | null;
  view(): { filter: TodoFilter; query: string };
  /** Select mode turned on or off, for the host's toggle. */
  onSelecting?(on: boolean): void;
  /** The host's select toggle, where the keyboard goes when Esc ends select mode. */
  selectButton?(): HTMLElement | null;
}

export interface TodoList {
  /** Moves on every change, so a read that was on its way during one can be set aside. */
  readonly rev: number;
  readonly selecting: boolean;
  render(force?: boolean): void;
  /** Change the to-dos on the server and show the list it answers with. */
  act(path: string, body: unknown, onFail?: () => void): Promise<boolean>;
  focusTodo(id: number): void;
  setSelecting(on: boolean): void;
  /** Drop selection and editing state for to-dos that are gone. */
  prune(): void;
}

// ---- between windows ----------------------------------------------------------------

const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("devis-todos") : null;
const changeListeners = new Set<() => void>();
channel?.addEventListener("message", (e: MessageEvent) => {
  if (e.data?.type === "todos-changed") for (const listener of changeListeners) listener();
});

/** Hear of a change made in another window. */
export function onTodosChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

const announce = (): void => channel?.postMessage({ type: "todos-changed" });

/** Where a to-do from Teams, a meeting or an email came from, as a link to it. */
export function todoLinkHtml(src: NonNullable<Todo["source"]>): string {
  const mail = src.key.startsWith("need:mail:");
  const meet = src.key.startsWith("meet:");
  const title = mail ? "Open the email in Outlook" : meet ? "Open the meeting's chat in Teams" : src.key.startsWith("need:chat:") ? "Open the chat in Teams" : "Open the message in Teams";
  return `<a class="todo-src" data-key="src" href="${esc(src.link!)}" target="_blank" rel="noopener" title="${title}">${svg(mail ? "mail" : meet ? "calendar" : "chat")}<span>${esc(src.taskTitle || (mail ? "Email" : "Teams"))}${src.who ? ` · ${esc(src.who)}` : ""}</span></a>`;
}

// ---- preferences --------------------------------------------------------------------

const FOLDS_KEY = "adoPrOps.todos.folded";
const DONE_KEY = "adoPrOps.workspace.showDoneTodos";

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

function readFolds(): number[] {
  try {
    const list = JSON.parse(readPref(FOLDS_KEY) || "[]");
    return Array.isArray(list) ? list.filter((n): n is number => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

/** The text with what the search matched marked. */
function marked(text: string, query: string): string {
  const q = query.toLowerCase();
  if (!q) return esc(text);
  const lower = text.toLowerCase();
  if (lower.length !== text.length) return esc(text);
  let out = "";
  let at = 0;
  for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, at)) {
    out += `${esc(text.slice(at, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>`;
    at = i + q.length;
  }
  return out + esc(text.slice(at));
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The list with a to-do checked off (and its subtasks) or reopened (and the ancestors above it). */
function withDone(list: readonly Todo[], id: number, done: boolean): Todo[] {
  const ids = new Set<number>([id, ...(done ? descendants(list, id).map((t) => t.id) : ancestors(list, id))]);
  const at = new Date().toISOString();
  return list.map((t) => (ids.has(t.id) && t.done !== done ? { ...t, done, doneAt: done ? at : null, doneNote: null } : t));
}

const EMPTY: Record<TodoFilter, string> = {
  all: "Nothing on your list.",
  today: "Nothing due today.",
  overdue: "Nothing overdue.",
  upcoming: "Nothing due later.",
  done: "Nothing done yet.",
};

interface Paint {
  todos: Todo[];
  today: string;
  now: number;
  query: string;
  narrowed: boolean;
  flat: boolean;
}

export function createTodoList(body: HTMLElement, host: TodoListHost): TodoList {
  let rev = 0;
  let selecting = false;
  let sel = new Set<string>();
  let anchor: string | null = null;
  /** The selectable rows, in the order they show. */
  let order: string[] = [];
  let editing: number | null = null;
  /** The to-do whose add-a-subtask box is open. */
  let subFor: number | null = null;
  /** The row whose menu is open. */
  let ctxId: number | null = null;
  let showDone = readPref(DONE_KEY) === "1";
  const folded = new Set<number>(readFolds());
  const drafts = new Map<string, string>();
  let lastHtml = "";
  let pointerDown = false;

  body.classList.add("td-mount", host.mode === "window" ? "is-window" : "is-panel");

  const all = (): Todo[] => host.todos() ?? [];
  const find = (id: number): Todo | undefined => all().find((t) => t.id === id);
  const todoOf = (node: Element | null): Todo | undefined => {
    const id = Number(node?.closest<HTMLElement>("[data-todo]")?.dataset.todo);
    return Number.isFinite(id) ? find(id) : undefined;
  };
  const rowEl = (id: number): HTMLElement | null => body.querySelector<HTMLElement>(`.todo[data-todo="${id}"]`);
  const primaryOf = (row: Element | null): HTMLElement | null =>
    row?.querySelector<HTMLElement>(":scope > .todo-pick, :scope > .todo-check") ?? row?.querySelector<HTMLElement>("button, a") ?? null;
  const rowIds = (): number[] => [...body.querySelectorAll<HTMLElement>(".todo[data-todo]")].map((r) => Number(r.dataset.todo));
  const selIds = (): Set<number> => new Set([...sel].map(Number));
  const saveFolds = (): void => writePref(FOLDS_KEY, JSON.stringify([...folded]));

  /** After a mouse press, run once the click is over, so a repaint can't move what's under the pointer. */
  const afterPress = (fn: () => void): void => {
    if (!pointerDown) return fn();
    window.addEventListener("mouseup", () => setTimeout(fn), { once: true });
  };

  // ---- markup -------------------------------------------------------------------------

  function listHtml(todos: Todo[]): string {
    const today = todayKey();
    const { filter, query } = host.view();
    const q = query.trim();
    const narrowed = filter !== "all" || !!q;
    // Searching or looking at what's done, the done ones show in the one list.
    const together = filter === "done" || !!q;
    const rows = visibleRows(todos, { filter, query: q, folded, today });
    const main = together ? [...rows.open, ...rows.done] : rows.open;
    const doneRows = !together && showDone ? rows.done : [];
    const shown = [...main, ...doneRows];
    order = shown.filter((r) => !r.context).map((r) => String(r.todo.id));
    sel = pruned(sel, order);
    if (anchor !== null && !order.includes(anchor)) anchor = null;
    const ids = new Set(todos.map((t) => t.id));
    if (editing !== null && !todos.some((t) => t.id === editing && !t.done)) editing = null;
    if (subFor !== null && !todos.some((t) => t.id === subFor && !t.done)) subFor = null;
    if (ctxId !== null && !ids.has(ctxId)) ctxId = null;
    const paint: Paint = {
      todos,
      today,
      now: Date.now(),
      query: q,
      narrowed,
      // With no subtasks anywhere, rows don't keep room for a fold.
      flat: subFor === null && shown.every((r) => r.depth === 0 && !r.parent),
    };
    const windowed = host.mode === "window";
    const draft = drafts.get("new") || "";
    const dueToday = windowed && filter === "today";
    const add =
      filter === "all" || filter === "today"
        ? `<form class="todo-add" data-form="todo-add" data-key="todo-add">
            ${svg("add")}
            <input type="text" maxlength="500" data-td-draft="new" value="${esc(draft)}" placeholder="${dueToday ? "Add a to-do due today (Enter)" : "Add a to-do (Enter)"}" aria-label="${dueToday ? "Add a to-do due today" : "Add a to-do"}" autocomplete="off">
          </form>`
        : "";
    const list = main.length
      ? treeHtml(main, "todo-open", paint)
      : `<p class="rs-empty" data-key="todo-none">${q ? `No to-dos match “${esc(q)}”.` : EMPTY[filter]}</p>`;
    const doneCount = rows.done.filter((r) => r.depth === 0 && !r.context).length;
    const clear = `<button type="button" class="btn sm ghost todo-clear" data-key="clear" data-act="todo-clear-done">Clear done</button>`;
    let doneHead = "";
    if (filter === "done" && !q && doneCount) {
      doneHead = `<div class="todo-done-head" data-key="todo-done-head"><span class="todo-done-n">${plural(doneCount, "done to-do")}</span>${clear}</div>`;
    } else if (!together && doneCount) {
      doneHead = `<div class="todo-done-head" data-key="todo-done-head">
          <button type="button" class="tu-toggle" data-key="show" data-act="todo-show-done" aria-expanded="${showDone}">Done · ${doneCount}${svg("chevron")}</button>
          ${showDone ? clear : ""}
        </div>`;
    }
    const doneList = doneRows.length ? treeHtml(doneRows, "todo-done", paint, " is-done") : "";
    const bulk = selecting ? bulkHtml(todos) : "";
    return filter === "done"
      ? `${bulk}${doneHead}${list}`
      : windowed
        ? `${bulk}${add}${list}${doneHead}${doneList}`
        : `${bulk}${list}${add}${doneHead}${doneList}`;
  }

  /** Rows, flat and depth first, as nested lists. */
  function treeHtml(rows: TodoRow[], key: string, p: Paint, extra = ""): string {
    let i = 0;
    const level = (depth: number): string => {
      let out = "";
      while (i < rows.length && rows[i]!.depth >= depth) {
        const r = rows[i++]!;
        const sub = i < rows.length && rows[i]!.depth > r.depth ? level(r.depth + 1) : "";
        const adding = subFor === r.todo.id && !r.todo.done ? addSubHtml(r.todo) : "";
        const subList = sub || adding ? `<ul class="todo-list todo-sub" data-key="sub">${sub}${adding}</ul>` : "";
        out += `<li class="todo-item" data-key="todo:${r.todo.id}">${rowHtml(r, p)}${subList}</li>`;
      }
      return out;
    };
    return `<ul class="todo-list${p.flat ? " is-flat" : ""}${extra}" data-key="${key}">${level(rows[0]?.depth ?? 0)}</ul>`;
  }

  function addSubHtml(t: Todo): string {
    const key = `sub:${t.id}`;
    return `<li class="todo-addsub" data-key="addsub">
        <form class="todo-add todo-add-sub" data-form="todo-sub" data-parent="${t.id}">
          ${svg("subtask")}
          <input type="text" maxlength="500" data-td-draft="${key}" value="${esc(drafts.get(key) || "")}" placeholder="Add a subtask (Enter)" aria-label="Add a subtask to ${esc(t.text)}" autocomplete="off">
        </form>
      </li>`;
  }

  function rowHtml(r: TodoRow, p: Paint): string {
    const t = r.todo;
    const id = String(t.id);
    const isEditing = editing === t.id && !t.done;
    const picked = sel.has(id);
    const root = t.parentId === null;
    const prio = !t.done && root && t.priority ? t.priority : 0;
    const cls = [
      "todo",
      t.done && "done",
      isEditing && "editing",
      picked && "is-selected",
      ctxId === t.id && "is-ctx",
      r.context && "is-context",
      prio && `prio-${prio}`,
    ]
      .filter(Boolean)
      .join(" ");
    const fold = p.flat
      ? ""
      : r.parent && !p.narrowed
        ? `<button type="button" class="todo-fold" data-key="fold" data-act="todo-fold" aria-expanded="${!r.folded}" aria-label="Subtasks of ${esc(t.text)}" title="${r.folded ? "Show" : "Hide"} subtasks">${svg("chevron")}</button>`
        : `<span class="todo-fold" data-key="fold-sp"></span>`;
    const prioWords = prio ? `, ${priorityName(prio)} priority` : "";
    const lead = r.context && selecting
      ? `<span class="todo-pick-sp" data-key="pick-sp"></span>`
      : selecting
        ? `<input type="checkbox" class="pp-check-box todo-pick" data-key="pick" data-act="todo-pick" aria-label="Select: ${esc(t.text)}"${picked ? " checked" : ""}>`
        : `<button type="button" class="todo-check" data-key="check" data-act="todo-toggle" role="checkbox" aria-checked="${t.done}"
            aria-label="${t.done ? "Done" : "Not done"}: ${esc(t.text)}${prioWords}" title="${t.done ? "Mark not done" : "Check off"}">${svg("check")}</button>`;
    const text = isEditing
      ? `<input type="text" class="todo-edit" data-key="edit" maxlength="500" data-td-draft="edit:${t.id}" value="${esc(drafts.get(`edit:${t.id}`) ?? t.text)}" aria-label="Edit the to-do" autocomplete="off">`
      : `<span class="todo-text" data-key="text">${marked(t.text, p.query)}</span>`;
    const meta: string[] = [];
    if (prio) meta.push(`<span class="todo-prio prio-${prio}" data-key="prio" title="${priorityName(prio)} priority">${svg("flag")}<span>${priorityName(prio)}</span></span>`);
    if (t.due) {
      const due = dueInfo(t.due, p.today, t.done);
      meta.push(
        t.done
          ? `<span class="todo-chip todo-due tone-done" data-key="due-sp" title="${esc(due.title)}">${svg("calendar")}<span>${esc(due.label)}</span></span>`
          : `<button type="button" class="todo-chip todo-due tone-${due.tone}" data-key="due" data-act="todo-due" aria-haspopup="menu" title="${esc(due.title)}. Change it" aria-label="${esc(due.title)}. Change the due date">${svg("calendar")}<span>${esc(due.label)}</span></button>`
      );
    }
    const prog = r.parent ? progress(p.todos, t.id) : null;
    if (prog) {
      meta.push(
        `<span class="todo-prog${prog.done === prog.total ? " is-done" : ""}" data-key="prog" title="${prog.done} of ${plural(prog.total, "subtask")} done">${svg("subtask")}<span>${prog.done}/${prog.total}</span></span>`
      );
    }
    const src = t.source;
    const taskTitle = t.taskId && t.taskId !== src?.taskId ? host.taskTitle(t.taskId) : null;
    if (taskTitle !== null) {
      meta.push(`<button type="button" class="todo-chip todo-task" data-key="task" data-act="todo-task" title="Open ${esc(taskTitle)}, the task started from it">${svg("play")}<span>${esc(taskTitle)}</span></button>`);
    }
    // From Needs you: the task it's about opens from here; one from Teams or email links to it.
    if (src?.taskId) {
      meta.push(
        `<button type="button" class="todo-src" data-key="src" data-act="todo-open-task" data-src-task="${esc(src.taskId)}" title="Open ${esc(src.taskTitle)}">${svg("checklist")}<span>${esc(src.taskTitle || "the task")}${src.who ? ` · ${esc(src.who)}` : ""}</span></button>`
      );
    } else if (src?.link) meta.push(todoLinkHtml(src));
    const metaHtml = meta.length ? `<span class="todo-meta" data-key="meta">${meta.join("")}</span>` : "";
    const note = t.done && t.doneNote ? `<span class="todo-note" data-key="note">Done by itself · ${esc(t.doneNote)}</span>` : "";
    const by =
      t.author !== "you"
        ? `<span class="todo-by" data-key="by" title="Added by ${esc(t.author)} ${esc(agoPhrase(t.createdAt, p.now))}">${esc(t.author)}</span>`
        : "";
    // Keyed, so a repaint between mousedown and click can't turn the pressed button into another one.
    const tool = (act: string, name: IconName, label: string, more = ""): string =>
      `<button type="button" class="icon-btn" data-key="${act}" data-act="${act}" title="${label}" aria-label="${label}"${more}>${svg(name)}</button>`;
    const list = p.todos;
    const tools = selecting
      ? ""
      : t.done
        ? tool("todo-delete", "trash", "Delete")
        : [
            tool("todo-addsub", "subtask", "Add a subtask"),
            t.due ? "" : tool("todo-due", "calendar", "Due date", ' aria-haspopup="menu"'),
            isEditing ? "" : tool("todo-edit", "edit", "Edit (F2)"),
            canMove(list, t, "up") ? tool("todo-up", "up", "Move up (Alt+Up)") : "",
            canMove(list, t, "down") ? tool("todo-down", "down", "Move down (Alt+Down)") : "",
            tool("todo-delete", "trash", "Delete"),
          ].join("");
    // Every child is keyed: swapping the text for the edit box must not rebuild the tools under the pointer.
    return `<div class="${cls}" data-key="row" data-todo="${t.id}">
        ${fold}${lead}<span class="todo-main" data-key="main">${text}${metaHtml}${note}</span>${by}${tools ? `<span class="todo-tools" data-key="tools">${tools}</span>` : ""}
      </div>`;
  }

  function bulkHtml(todos: Todo[]): string {
    const n = sel.size;
    const st = checkState(sel, order);
    const picks = topPicks(todos, selIds());
    const open = picks.filter((t) => !t.done);
    const reopen = picks.length > 0 && !open.length;
    const labelled = host.mode === "window";
    const btn = (act: string, name: IconName, label: string, title: string, on: boolean, more = ""): string =>
      labelled
        ? `<button type="button" class="btn sm ghost" data-key="${act}" data-act="${act}" title="${title}"${on ? "" : " disabled"}${more}>${svg(name)}<span>${label}</span></button>`
        : `<button type="button" class="icon-btn" data-key="${act}" data-act="${act}" title="${title}" aria-label="${title}"${on ? "" : " disabled"}${more}>${svg(name)}</button>`;
    return `
      <div class="pp-bulk td-bulk" data-key="bulk" role="toolbar" aria-label="Selected to-dos">
        <label class="pp-all" title="Select every listed to-do"><input type="checkbox" class="pp-check-box" data-act="todo-select-all" data-role="select-all" aria-label="Select all listed to-dos"${
          st === "all" ? " checked" : ""
        }${order.length ? "" : " disabled"}><span class="pp-count" aria-live="polite">${n ? `${n} selected` : "Select to-dos"}</span></label>
        <button type="button" class="btn sm ghost" data-key="todo-bulk-clear" data-act="todo-bulk-clear"${n ? "" : " disabled"}>Clear</button>
        <span class="pp-bulk-sp"></span>
        ${btn("todo-bulk-due", "calendar", "Due", "Set a due date", open.length > 0, ' aria-haspopup="menu"')}
        ${btn("todo-bulk-done", reopen ? "reset" : "check", reopen ? "Reopen" : "Check off", reopen ? "Reopen the selected to-dos" : "Check off the selected to-dos", n > 0)}
        ${btn("todo-bulk-delete", "trash", "Delete", "Delete the selected to-dos", n > 0)}
        <button type="button" class="btn sm" data-key="todo-bulk-start" data-act="todo-bulk-start" title="Start one task from the selected to-dos"${open.length ? "" : " disabled"}>${svg("play")}<span>Start task${
          open.length ? ` (${open.length})` : ""
        }</span></button>
      </div>`;
  }

  // ---- painting -----------------------------------------------------------------------

  /** A control's identity across repaints: its row, its role and its tag. */
  function focusKey(node: Element | null): string | null {
    if (!(node instanceof HTMLElement) || node === body || !body.contains(node)) return null;
    const row = node.closest<HTMLElement>("[data-todo]")?.dataset.todo ?? "";
    const role = node.dataset.act ?? node.dataset.tdDraft ?? node.dataset.key ?? node.className;
    return `${row}|${role}|${node.tagName}`;
  }

  function render(force = false): void {
    const todos = host.todos();
    const html = todos ? listHtml(todos) : `<p class="rs-empty" data-key="todo-loading">Loading…</p>`;
    if (!force && html === lastHtml) return;
    lastHtml = html;
    const key = focusKey(document.activeElement);
    patchHtml(body, html);
    const selectAll = body.querySelector<HTMLInputElement>('[data-role="select-all"]');
    if (selectAll) selectAll.indeterminate = checkState(sel, order) === "some";
    // A row that moved was taken out and put back, which drops the keyboard; put it back too.
    const active = document.activeElement;
    if (key && (!active || active === document.body || !body.contains(active))) {
      for (const node of body.querySelectorAll<HTMLElement>("button, input, a")) {
        if (focusKey(node) === key) {
          node.focus({ preventScroll: true });
          break;
        }
      }
    }
  }

  function repaint(): void {
    host.repaint();
  }

  function focusTodo(id: number): void {
    primaryOf(rowEl(id))?.focus({ preventScroll: false });
  }

  /** When a change took the focused row away, the keyboard goes to the row nearest it. */
  function settleFocus(near: number | null, before: number[]): void {
    const active = document.activeElement;
    if (active && active !== document.body && document.contains(active)) return;
    const at = near === null ? -1 : before.indexOf(near);
    for (let i = at + 1; i > 0 && i < before.length; i++) if (rowEl(before[i]!)) return focusTodo(before[i]!);
    for (let i = at - 1; i >= 0; i--) if (rowEl(before[i]!)) return focusTodo(before[i]!);
    body.querySelector<HTMLElement>('[data-td-draft="new"]')?.focus();
  }

  // ---- changes ------------------------------------------------------------------------

  /** Make the calls in turn and show each answer's list; after a failure, put things back and read the list again. */
  async function run(calls: Array<[string, unknown]>, onFail?: () => void): Promise<boolean> {
    rev++;
    let ok = true;
    let changed = false;
    try {
      for (const [path, payload] of calls) {
        const res = await postJSON(path, payload);
        changed = true;
        if (Array.isArray(res?.todos)) host.setTodos(res.todos);
      }
    } catch (e) {
      ok = false;
      // A to-do that's gone (deleted while a change to it was on the way) isn't worth a toast; the reload settles it.
      if ((e as ApiError).status !== 404) toast((e as Error).message, "err");
      onFail?.();
    } finally {
      rev++;
      repaint();
    }
    // Started after the change settled, so this read isn't set aside as stale.
    if (!ok) host.reload();
    if (changed) announce();
    return ok;
  }

  const act = (path: string, payload: unknown, onFail?: () => void): Promise<boolean> => run([[path, payload]], onFail);

  /** Show a change at once; if the server turns it down, the list goes back to how it was. */
  function change(next: Todo[], calls: Array<[string, unknown]>): Promise<boolean> {
    const before = host.todos();
    host.setTodos(next);
    repaint();
    return run(calls, () => before && host.setTodos(before));
  }

  function toggle(t: Todo, done = !t.done): void {
    const had = rowEl(t.id)?.contains(document.activeElement) ?? false;
    const before = rowIds();
    void change(withDone(all(), t.id, done), [["/api/jarvis/todos/update", { id: t.id, done }]]);
    if (had) settleFocus(t.id, before);
  }

  function move(t: Todo, direction: "up" | "down"): void {
    if (!canMove(all(), t, direction)) return;
    void change(movedTodos(all(), t.id, direction), [["/api/jarvis/todos/move", { id: t.id, direction }]]);
  }

  function setDue(targets: Todo[], due: string | null): Promise<boolean> {
    const ids = new Set(targets.filter((t) => !t.done && t.due !== due).map((t) => t.id));
    if (!ids.size) return Promise.resolve(true);
    return change(
      all().map((t) => (ids.has(t.id) ? { ...t, due } : t)),
      [...ids].map((id) => ["/api/jarvis/todos/update", { id, due }])
    );
  }

  function setPriority(t: Todo, priority: number): void {
    if (t.priority === priority) return;
    void change(
      all().map((x) => (x.id === t.id ? { ...x, priority } : x)),
      [["/api/jarvis/todos/update", { id: t.id, priority }]]
    );
  }

  function addTop(form: HTMLFormElement): void {
    const input = form.querySelector<HTMLInputElement>("input")!;
    const text = input.value.trim();
    if (!text) return;
    // Cleared at once so the next one can be typed; put back if it didn't save.
    drafts.delete("new");
    input.value = "";
    const due = host.mode === "window" && host.view().filter === "today" ? todayKey() : undefined;
    void act("/api/jarvis/todos", { text, ...(due ? { due } : {}) }, () => {
      if (input.value) return;
      drafts.set("new", text);
      input.value = text;
    });
  }

  function addSub(form: HTMLFormElement): void {
    const parentId = Number(form.dataset.parent);
    const input = form.querySelector<HTMLInputElement>("input")!;
    const text = input.value.trim();
    const key = `sub:${parentId}`;
    if (!text) return closeSub(true);
    drafts.delete(key);
    input.value = "";
    void act("/api/jarvis/todos", { text, parentId }, () => {
      if (input.value) return;
      drafts.set(key, text);
      input.value = text;
    });
  }

  function openSub(t: Todo): void {
    if (t.done) return;
    if (editing !== null) endEdit(true, false);
    subFor = t.id;
    if (folded.delete(t.id)) saveFolds();
    repaint();
    body.querySelector<HTMLInputElement>(`[data-td-draft="sub:${t.id}"]`)?.focus();
  }

  function closeSub(refocus: boolean): void {
    const id = subFor;
    if (id === null) return;
    subFor = null;
    drafts.delete(`sub:${id}`);
    repaint();
    if (refocus) focusTodo(id);
  }

  function startEdit(t: Todo): void {
    if (t.done || selecting) return;
    if (editing !== null && editing !== t.id) endEdit(true, false);
    editing = t.id;
    drafts.set(`edit:${t.id}`, t.text);
    repaint();
    const input = rowEl(t.id)?.querySelector<HTMLInputElement>(".todo-edit");
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }

  /** Save or drop the edit in progress; `refocus` puts the keyboard back on the row. */
  function endEdit(save: boolean, refocus: boolean): void {
    const id = editing;
    if (id === null) return;
    const key = `edit:${id}`;
    const text = (drafts.get(key) || "").trim();
    editing = null;
    drafts.delete(key);
    const todo = find(id);
    if (save && todo && text && text !== todo.text) {
      void change(
        all().map((t) => (t.id === id ? { ...t, text } : t)),
        [["/api/jarvis/todos/update", { id, text }]]
      );
    } else repaint();
    if (refocus) focusTodo(id);
  }

  function remove(picks: Todo[]): void {
    const list = all();
    if (!picks.length) return;
    const gone = new Set<number>();
    for (const t of picks) for (const id of [t.id, ...descendants(list, t.id).map((d) => d.id)]) gone.add(id);
    const subs = gone.size - picks.length;
    const go = (): Promise<boolean> => {
      const before = rowIds();
      const first = before.find((id) => gone.has(id)) ?? null;
      if (editing !== null && gone.has(editing)) editing = null;
      if (subFor !== null && gone.has(subFor)) subFor = null;
      const done = change(
        all().filter((t) => !gone.has(t.id)),
        picks.map((t) => ["/api/jarvis/todos/delete", { id: t.id }])
      );
      // A dialog puts the keyboard back where it was when it closes; that row may be gone.
      setTimeout(() => settleFocus(first, before));
      return done;
    };
    if (picks.length === 1 && !subs) return void go();
    const one = picks.length === 1 ? picks[0]! : null;
    openActionDialog({
      title: one ? "Delete the to-do" : `Delete ${picks.length} to-dos`,
      loc: one ? one.text : "To-dos",
      body: `<p class="pa-note">${
        one ? `Its ${plural(subs, "subtask")} go${subs === 1 ? "es" : ""} with it.` : `${subs ? `Their ${plural(subs, "subtask")} go with them. ` : ""}`
      }You can't undo this.</p>`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        await go();
      },
    });
  }

  function clearDone(): void {
    const list = all();
    const ids = new Set(list.map((t) => t.id));
    const gone = new Set<number>();
    for (const t of list) {
      if (!t.done || (t.parentId !== null && ids.has(t.parentId))) continue;
      gone.add(t.id);
      for (const d of descendants(list, t.id)) gone.add(d.id);
    }
    const before = rowIds();
    void change(
      list.filter((t) => !gone.has(t.id)),
      [["/api/jarvis/todos/clear-done", {}]]
    );
    settleFocus(null, before);
  }

  // ---- selection ----------------------------------------------------------------------

  function setSelecting(on: boolean): void {
    if (selecting === on) return;
    if (on && editing !== null) endEdit(true, false);
    if (on) subFor = null;
    selecting = on;
    if (!on) {
      sel = new Set();
      anchor = null;
    }
    host.onSelecting?.(on);
    repaint();
  }

  function pick(id: string, mode: "toggle" | "range"): void {
    sel = mode === "range" ? ranged(sel, order, anchor, id) : toggled(sel, id);
    if (mode === "toggle" || anchor === null) anchor = id;
    if (!selecting) setSelecting(true);
    else repaint();
  }

  // ---- menus --------------------------------------------------------------------------

  function dueEntries(targets: Todo[]): ContextMenuEntry[] {
    const today = todayKey();
    const tomorrow = addDays(today, 1);
    const monday = nextMonday(today);
    const dues = new Set(targets.map((t) => t.due));
    // The current choice is marked only when every target shares it.
    const cur = dues.size === 1 ? targets[0]!.due : undefined;
    const custom = !!cur && cur !== today && cur !== tomorrow && cur !== monday;
    const set = (due: string | null) => () => void setDue(targets, due);
    return [
      { label: "Due today", checked: cur === today, run: set(today) },
      { label: "Due tomorrow", checked: cur === tomorrow, run: set(tomorrow) },
      { label: "Due next week", hint: `Monday, ${shortDay(monday, today)}`, checked: cur === monday, run: set(monday) },
      { label: "Due on a date…", hint: custom ? shortDay(cur!, today) : undefined, checked: custom, run: () => pickDate(targets) },
      { label: "No due date", checked: cur === null, run: set(null) },
    ];
  }

  function pickDate(targets: Todo[]): void {
    const today = todayKey();
    const one = targets.length === 1 ? targets[0]! : null;
    const dialog = openActionDialog({
      title: "Due date",
      loc: one ? one.text : `${targets.length} to-dos`,
      body: `<div class="jv-fields">
          <label class="rp-label" for="td-date">Due on</label>
          <input id="td-date" type="date" class="ask-q jv-field td-date" value="${esc(one?.due ?? addDays(today, 1))}">
        </div>`,
      confirmLabel: "Set the date",
      onConfirm: async (node) => {
        const value = node.querySelector<HTMLInputElement>("#td-date")!.value;
        if (!isDayKey(value)) throw new Error("Pick a date.");
        await setDue(targets, value);
      },
    });
    requestAnimationFrame(() => dialog.querySelector<HTMLElement>("#td-date")?.focus());
  }

  function rowEntries(t: Todo): ContextMenuEntry[] {
    const list = all();
    const out: ContextMenuEntry[] = [];
    // The row under the pointer is one of several selected: the selection's own action leads.
    if (contextIsSelected(sel, String(t.id))) {
      const open = topPicks(list, selIds()).filter((x) => !x.done);
      out.push({ label: `Start a task from ${plural(sel.size, "selected to-do")}…`, icon: "play", disabled: !open.length, run: () => openStart(open) });
    }
    const taskTitle = t.taskId ? host.taskTitle(t.taskId) : null;
    const openTask: ContextMenuEntry | null = taskTitle !== null ? { label: "Open its task", hint: taskTitle, icon: "checklist", run: () => host.openTask(t.taskId!) } : null;
    if (t.done) {
      out.push({ label: "Reopen", icon: "reset", sepBefore: out.length > 0, run: () => toggle(t, false) });
      if (openTask) out.push(openTask);
      out.push({ label: "Delete", icon: "trash", danger: true, sepBefore: true, run: () => remove([t]) });
      return out;
    }
    out.push(
      { label: "Check off", icon: "check", sepBefore: out.length > 0, run: () => toggle(t, true) },
      { label: "Edit", icon: "edit", hint: "F2", disabled: selecting, run: () => startEdit(t) },
      { label: "Add a subtask", icon: "subtask", run: () => (selecting ? undefined : openSub(t)), disabled: selecting },
      { label: "Move up", icon: "up", hint: "Alt+↑", disabled: !canMove(list, t, "up"), run: () => move(t, "up") },
      { label: "Move down", icon: "down", hint: "Alt+↓", disabled: !canMove(list, t, "down"), run: () => move(t, "down") },
      { label: "Start a task…", icon: "play", sepBefore: true, run: () => openStart([t]) }
    );
    if (openTask) out.push(openTask);
    const due = dueEntries([t]);
    due[0]!.sepBefore = true;
    out.push(...due);
    if (t.parentId === null) {
      out.push(
        ...[...PRIORITIES, { value: 0, label: "No" }].map((p, i) => ({
          label: `${p.label} priority`,
          checked: t.priority === p.value,
          sepBefore: i === 0,
          run: () => setPriority(t, p.value),
        }))
      );
    }
    out.push({ label: "Delete", icon: "trash", danger: true, sepBefore: true, run: () => remove([t]) });
    return out;
  }

  function openRowMenu(t: Todo, x: number, y: number): void {
    const id = t.id;
    openContextMenu(
      x,
      y,
      `To-do: ${t.text}`,
      rowEntries(t),
      () => focusTodo(id),
      () => {
        if (ctxId !== id) return;
        ctxId = null;
        repaint();
      }
    );
    ctxId = id;
    repaint();
  }

  function openMenuAt(button: HTMLElement, label: string, entries: ContextMenuEntry[]): void {
    const rect = button.getBoundingClientRect();
    const key = focusKey(button);
    openContextMenu(rect.left, rect.bottom + 4, label, entries, () => {
      // The button may have been rebuilt meanwhile; find it again by what it is.
      const again = [...body.querySelectorAll<HTMLElement>("button")].find((b) => focusKey(b) === key);
      (again ?? button).focus({ preventScroll: true });
    });
  }

  // ---- starting a task ----------------------------------------------------------------

  function openStart(picked: Todo[]): void {
    const list = all();
    const picks = picked.filter((t) => !t.done);
    if (!picks.length) return;
    const ids = picks.map((t) => t.id);
    const textOf = new Map(picks.map((t) => [t.id, t.text]));
    const count = picks.length;
    const one = count === 1 ? picks[0]! : null;
    const subs = picks.reduce((n, t) => n + descendants(list, t.id).filter((d) => !d.done).length, 0);
    const eachBlocked = splitBlocked("each", count, 1);
    const split = one
      ? ""
      : `<fieldset class="pa-fieldset td-split">
          <legend class="rp-label">Workers</legend>
          <label class="pa-radio"><input type="radio" name="td-split" value="one" checked>
            <span><span class="pa-radio-label">One worker</span><span class="pa-radio-hint">It takes all ${count} to-dos.</span></span></label>
          <label class="pa-radio"><input type="radio" name="td-split" value="each"${eachBlocked ? " disabled" : ""}>
            <span><span class="pa-radio-label">A worker per to-do</span><span class="pa-radio-hint">${esc(eachBlocked || `${count} workers, one to-do each.`)}</span></span></label>
          <label class="pa-radio"><input type="radio" name="td-split" value="chunk">
            <span><span class="pa-radio-label">A worker per <input type="number" id="td-chunk" class="td-num" min="1" max="${count}" value="2" aria-label="To-dos per worker"> to-dos</span><span class="pa-radio-hint">In list order.</span></span></label>
          <label class="pa-radio"><input type="radio" name="td-split" value="workers">
            <span><span class="pa-radio-label">Share them across <input type="number" id="td-workers" class="td-num" min="1" max="${Math.min(MAX_WORKERS, count)}" value="2" aria-label="Number of workers"> workers</span><span class="pa-radio-hint">Dealt out in turn.</span></span></label>
        </fieldset>
        <ol class="td-plan" aria-label="Who takes what" aria-live="polite"></ol>`;
    const subNote = subs
      ? `<p class="pa-note">${one ? `Its ${plural(subs, "open subtask")} go${subs === 1 ? "es" : ""} with it.` : `Subtasks go with their to-do: ${plural(subs, "open subtask")} in all.`}</p>`
      : "";
    const root = state.config.taskRoot || "";
    const dialog = openActionDialog({
      title: one ? "Start a task from the to-do" : `Start a task from ${count} to-dos`,
      loc: one ? one.text : "To-dos",
      body: `
        ${split}
        ${subNote}
        <div class="jv-fields">
          <label class="rp-label" for="td-title">Title${one ? ' <span class="rp-optional">(optional)</span>' : ""}</label>
          <input id="td-title" class="ask-q jv-field" maxlength="200" autocomplete="off" placeholder="${one ? esc(one.text) : "What is this task?"}">
          <label class="rp-label" for="td-desc">Description <span class="rp-optional">(optional)</span></label>
          <textarea id="td-desc" class="ask-q jt-desc" rows="3" maxlength="8000" placeholder="What it's for and what done looks like. The to-dos are listed under it."></textarea>
          <label class="rp-label" for="td-root">Folder</label>
          <input id="td-root" class="ask-q jv-field" spellcheck="false" autocomplete="off" placeholder="C:\\work\\tasks" value="${esc(root)}">
          <p class="pa-note td-root-note"></p>
          <label class="rp-label" for="td-prompt">Instructions <span class="rp-optional">(optional)</span></label>
          <textarea id="td-prompt" class="ask-q" rows="3" placeholder="Anything ${one ? "the worker" : "every worker"} should know besides ${one ? "the to-do" : "its to-dos"}."></textarea>
          ${MODEL_FIELDS}
        </div>
        <p class="pa-note">${
          one ? "A worker starts" : "The workers start"
        } right away in the task's folder. Like any worker, each proposes the repositories it needs for you to confirm and settles the goal with you before it starts. The to-dos link to the task.</p>`,
      confirmLabel: "Start task",
      onConfirm: async (node) => {
        const plan = choice();
        if (plan.blocked) throw new Error(plan.blocked);
        const title = node.querySelector<HTMLInputElement>("#td-title")!.value.trim();
        if (!title && !one) throw new Error("Give the task a title.");
        const folderRoot = node.querySelector<HTMLInputElement>("#td-root")!.value.trim();
        if (!folderRoot) throw new Error("Choose the folder the task's own folder goes in, or set it in Settings.");
        rev++;
        let res: any;
        try {
          res = await postJSON("/api/jarvis/todos/start", {
            groups: plan.groups,
            title,
            description: node.querySelector<HTMLTextAreaElement>("#td-desc")!.value,
            folderRoot,
            instructions: node.querySelector<HTMLTextAreaElement>("#td-prompt")!.value,
            ...chosenModel(node),
          });
        } finally {
          rev++;
        }
        if (Array.isArray(res?.todos)) host.setTodos(res.todos);
        const errors: string[] = res?.workerErrors ?? [];
        const started = res?.workers?.length ?? 0;
        if (errors.length) {
          toast(`Started ${res.task.title}, but ${started ? `${plural(errors.length, "worker")} of ${plan.groups.length}` : "its workers"} didn't start: ${errors[0]}`, "err");
        } else toast(`Started ${res.task.title} with ${started === 1 ? "a worker" : `${started} workers`}`, "ok");
        announce();
        sel = new Set();
        if (selecting) setSelecting(false);
        else repaint();
        host.reload();
        host.openTask(res.task.id);
      },
    });
    const field = <T extends HTMLElement>(sel: string): T | null => dialog.querySelector<T>(sel);
    const confirm = field<HTMLButtonElement>(".pa-confirm")!;
    const plan = field<HTMLElement>(".td-plan");
    const rootNote = field<HTMLElement>(".td-root-note")!;
    const size = (input: HTMLInputElement | null, max: number): number => Math.max(1, Math.min(max, Math.floor(Number(input?.value)) || 1));
    function choice(): { groups: number[][]; blocked: string } {
      if (one) return { groups: [ids], blocked: "" };
      const mode = (field<HTMLInputElement>('input[name="td-split"]:checked')?.value ?? "one") as SplitMode;
      const n = mode === "chunk" ? size(field("#td-chunk"), count) : mode === "workers" ? size(field("#td-workers"), Math.min(MAX_WORKERS, count)) : 1;
      return { groups: splitGroups(ids, mode, n), blocked: splitBlocked(mode, count, n) };
    }
    const paintPlan = (): void => {
      const { groups, blocked } = choice();
      if (plan) {
        plan.innerHTML = blocked
          ? `<li class="td-plan-warn">${esc(blocked)}</li>`
          : groups
              .map((g, i) => {
                const names = g.map((id) => textOf.get(id) ?? "").join(" · ");
                return `<li><span class="td-plan-w">Worker ${i + 1}</span><span class="td-plan-t" title="${esc(names)}">${esc(names)}</span></li>`;
              })
              .join("");
      }
      if (!confirm.textContent?.endsWith("…")) confirm.textContent = groups.length > 1 && !blocked ? `Start task · ${groups.length} workers` : "Start task";
    };
    const paintRoot = (): void => {
      const title = field<HTMLInputElement>("#td-title")!.value.trim() || one?.text || "";
      const where = taskFolderPreview(field<HTMLInputElement>("#td-root")!.value, title || "task title");
      rootNote.textContent = where
        ? `Makes ${where}${title ? "" : " (named after the title)"}. Each worker gets a folder there with its worktrees.`
        : "Where the task's own folder goes. Set a default in Settings.";
    };
    dialog.addEventListener("input", (e) => {
      const target = e.target as HTMLElement;
      if (target.id === "td-title" || target.id === "td-root") paintRoot();
      else paintPlan();
    });
    dialog.addEventListener("change", paintPlan);
    // Choosing a number chooses the split it belongs to.
    dialog.addEventListener("focusin", (e) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains("td-num")) return;
      const radio = target.closest(".pa-radio")?.querySelector<HTMLInputElement>('input[type="radio"]');
      if (radio && !radio.checked) {
        radio.checked = true;
        paintPlan();
      }
    });
    wireModelFields(dialog);
    paintPlan();
    paintRoot();
    requestAnimationFrame(() => field<HTMLElement>(one ? "#td-title" : 'input[name="td-split"]:checked')?.focus());
  }

  // ---- events -------------------------------------------------------------------------

  function onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const node = target.closest<HTMLElement>("[data-act]");
    const t = todoOf(target);
    if (node && body.contains(node)) {
      switch (node.dataset.act) {
        case "todo-toggle":
          return void (t && toggle(t));
        case "todo-pick":
          return void (t && pick(String(t.id), e.shiftKey ? "range" : "toggle"));
        case "todo-fold":
          if (!t) return;
          if (!folded.delete(t.id)) folded.add(t.id);
          saveFolds();
          return repaint();
        case "todo-edit":
          return void (t && startEdit(t));
        case "todo-up":
        case "todo-down":
          return void (t && move(t, node.dataset.act === "todo-up" ? "up" : "down"));
        case "todo-delete":
          return void (t && remove([t]));
        case "todo-addsub":
          return void (t && openSub(t));
        case "todo-due":
          return void (t && openMenuAt(node, `Due date: ${t.text}`, dueEntries([t])));
        case "todo-task":
          return void (t?.taskId && host.openTask(t.taskId));
        case "todo-open-task":
          return void (node.dataset.srcTask && host.openTask(node.dataset.srcTask));
        case "todo-show-done":
          showDone = !showDone;
          writePref(DONE_KEY, showDone ? "1" : "0");
          return repaint();
        case "todo-clear-done":
          return clearDone();
        case "todo-select-all":
          sel = toggledAll(sel, order);
          return repaint();
        case "todo-bulk-clear":
          sel = new Set();
          anchor = null;
          return repaint();
        case "todo-bulk-due": {
          const targets = all().filter((x) => sel.has(String(x.id)) && !x.done);
          return void (targets.length && openMenuAt(node, `Due date: ${plural(targets.length, "to-do")}`, dueEntries(targets)));
        }
        case "todo-bulk-done": {
          const list = all();
          const picks = topPicks(list, selIds());
          const open = picks.filter((x) => !x.done);
          // Checked off, a to-do takes its subtasks with it; reopened, each selected one opens.
          const targets = open.length ? open : list.filter((x) => sel.has(String(x.id)) && x.done);
          const done = open.length > 0;
          let next = list;
          for (const x of targets) next = withDone(next, x.id, done);
          return void change(
            next,
            targets.map((x) => ["/api/jarvis/todos/update", { id: x.id, done }])
          );
        }
        case "todo-bulk-delete":
          return remove(topPicks(all(), selIds()));
        case "todo-bulk-start":
          return openStart(topPicks(all(), selIds()));
      }
      return;
    }
    // A click on a row itself, away from its controls: with Ctrl or Shift, or in select mode, it selects.
    if (!t || target.closest("a, button, input, textarea, label")) return;
    const row = target.closest<HTMLElement>(".todo");
    if (!row || row.classList.contains("is-context")) return;
    const how = rowClick(selecting, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey });
    if (how !== "open") pick(String(t.id), how);
  }

  function onContextMenu(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    // Text boxes keep their own menu (cut, copy, paste).
    if (target.closest("input[type=text], textarea")) return;
    const row = target.closest<HTMLElement>(".todo[data-todo]");
    const t = todoOf(row);
    if (!row || !t) return;
    e.preventDefault();
    if (editing !== null) endEdit(true, false);
    const { x, y } = menuPoint(e, row.querySelector<HTMLElement>(".todo-main") ?? row);
    openRowMenu(t, x, y);
  }

  function onKeydown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    if (target.classList.contains("todo-edit")) {
      if (e.key === "Enter") {
        e.preventDefault();
        endEdit(true, true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        endEdit(false, true);
      }
      return;
    }
    if (target.closest('[data-form="todo-sub"]') && e.key === "Escape") {
      e.preventDefault();
      return closeSub(true);
    }
    if (target.matches("input[type=text], textarea")) return;
    if (e.key === "Escape" && selecting) {
      e.preventDefault();
      const row = todoOf(target)?.id;
      setSelecting(false);
      return row !== undefined && rowEl(row) ? focusTodo(row) : void host.selectButton?.()?.focus();
    }
    const row = target.closest<HTMLElement>(".todo[data-todo]");
    const t = todoOf(row);
    if (!row || !t) return;
    const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    if (e.key === "F2" && plain) {
      e.preventDefault();
      startEdit(t);
    } else if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      if (!selecting) move(t, e.key === "ArrowUp" ? "up" : "down");
    } else if (plain && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      // Up and Down step from row to row.
      const rows = [...body.querySelectorAll<HTMLElement>(".todo[data-todo]")];
      const next = rows[rows.indexOf(row) + (e.key === "ArrowUp" ? -1 : 1)];
      if (!next) return;
      e.preventDefault();
      primaryOf(next)?.focus();
    } else if (plain && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      // Left folds a row or steps out to its parent; Right unfolds it or steps into its first subtask.
      const fold = row.querySelector<HTMLButtonElement>(":scope > .todo-fold[data-act]");
      const open = fold?.getAttribute("aria-expanded") === "true";
      if (e.key === "ArrowLeft") {
        if (fold && open) {
          folded.add(t.id);
          saveFolds();
          repaint();
        } else if (t.parentId !== null && rowEl(t.parentId)) focusTodo(t.parentId);
        else return;
      } else if (fold && !open) {
        folded.delete(t.id);
        saveFolds();
        repaint();
      } else {
        const first = row.parentElement?.querySelector<HTMLElement>(":scope > .todo-sub > .todo-item > .todo");
        if (!first) return;
        primaryOf(first)?.focus();
      }
      e.preventDefault();
    }
  }

  function onSubmit(e: SubmitEvent): void {
    const form = e.target as HTMLFormElement;
    if (form.dataset.form === "todo-add") {
      e.preventDefault();
      addTop(form);
    } else if (form.dataset.form === "todo-sub") {
      e.preventDefault();
      addSub(form);
    }
  }

  function onInput(e: Event): void {
    const input = e.target as HTMLInputElement;
    const key = input.dataset?.tdDraft;
    if (key) drafts.set(key, input.value);
  }

  function onFocusOut(e: FocusEvent): void {
    const target = e.target as HTMLElement;
    if (target.classList.contains("todo-edit")) {
      const id = editing;
      afterPress(() => {
        if (editing === id) endEdit(true, false);
      });
    } else if (target.closest('[data-form="todo-sub"]')) {
      const input = target as HTMLInputElement;
      const id = subFor;
      // Left empty, the box goes; with words in it, it stays for them.
      if (!input.value.trim()) {
        afterPress(() => {
          if (subFor === id && !(drafts.get(`sub:${id}`) || "").trim()) closeSub(false);
        });
      }
    }
  }

  body.addEventListener("click", onClick);
  body.addEventListener("contextmenu", onContextMenu);
  body.addEventListener("dblclick", (e) => {
    const target = e.target as HTMLElement;
    if (selecting || !target.closest(".todo-text")) return;
    const t = todoOf(target);
    if (t) startEdit(t);
  });
  body.addEventListener("submit", onSubmit);
  body.addEventListener("input", onInput);
  body.addEventListener("keydown", onKeydown);
  body.addEventListener("focusout", onFocusOut);
  body.addEventListener("mousedown", (e) => {
    pointerDown = true;
    window.addEventListener("mouseup", () => setTimeout(() => (pointerDown = false)), { once: true });
    // Shift- or Ctrl-clicking rows selects them, not their words.
    const target = e.target as HTMLElement;
    if ((e.shiftKey || e.ctrlKey || e.metaKey) && target.closest(".todo") && !target.closest("a, button, input")) e.preventDefault();
  });

  return {
    get rev() {
      return rev;
    },
    get selecting() {
      return selecting;
    },
    render,
    act,
    focusTodo,
    setSelecting,
    prune: () => {
      const todos = host.todos();
      if (!todos) return;
      const ids = new Set(todos.map((t) => String(t.id)));
      for (const key of [...drafts.keys()]) {
        const id = key.slice(key.indexOf(":") + 1);
        if (key !== "new" && !ids.has(id)) drafts.delete(key);
      }
      const gone = [...folded].filter((id) => !ids.has(String(id)));
      if (gone.length) {
        for (const id of gone) folded.delete(id);
        saveFolds();
      }
      listHtml(todos);
    },
  };
}
