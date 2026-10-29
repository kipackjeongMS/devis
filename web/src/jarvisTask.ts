// A task opened as a modal: on the left, tabs for its status timeline, its
// details and its Artifacts (note.md, recap.md and any other notes); on the
// right, a chat with its workers. The chat runs the Copilot CLI's slash
// commands and the user's skills behind "/". Today's polling keeps it live; the
// modal re-renders only the regions whose data changed, so typing and focus
// survive every poll.

import { getJSON, postJSON } from "./api.js";
import { esc } from "./util.js";
import { icon, type IconName } from "./icons.js";
import { closeIdePicker, idePickerHtml } from "./idePicker.js";
import { renderMarkdown } from "./markdown.js";
import { patchHtml } from "./patch.js";
import {
  autoSize,
  chatLogSig,
  chatPaneHtml,
  chatPaneRefs,
  composerKey,
  emptyHtml,
  errorOutHtml,
  modelPickerHtml,
  mutedHtml,
  paintChatLog,
  setComposer,
  setHint,
  type ChatLogSpec,
  type ChatPane,
} from "./chatPane.js";
import { loadModelCatalog, modelCatalog } from "./modelCatalog.js";
import { effortLabel, nextChoice, type PickerState } from "./modelChoice.js";
import { toast } from "./toast.js";
import { openActionDialog } from "./prActions.js";
import {
  NOTE_NAME,
  RECAP_NAME,
  WORKER_LABEL,
  WORKER_TONE,
  activityLine,
  agoPhrase,
  artifactRole,
  formatBytes,
  groupTaskPrs,
  isMarkdownName,
  mergeStatuses,
  newArtifactText,
  nextArtifactName,
  prSignals,
  prSourceText,
  prState,
  recapLine,
  statusDays,
  taskMeta,
  withLive,
  workerState,
  type Artifact,
  type ArtifactInfo,
  type LiveRead,
  type StatusUpdate,
  type TaskPr,
  type TodayTask,
  type TodayWorker,
  type WorkerLive,
  type WorkerRequest,
} from "./jarvisModel.js";
import {
  NOTES_KEPT,
  chatItems,
  composerIntent,
  matchCommands,
  noteFromOutcome,
  noteTurn,
  pendingShown,
  resolveCommand,
  settleSeen,
  slashQuery,
  withTurn,
  type ChatCommand,
  type ChatMessage,
  type ChatNote,
  type CommandOutcome,
  type SeenMessage,
} from "./taskChatModel.js";
import { createValidationPanel, type ValidationPanel } from "./taskValidation.js";
import { zoomable } from "./viewZoom.js";
import { attachSplitter } from "./splitter.js";
import { ImageDraft, paintTray, trayNote, uploadWith, wireImages, type ChatImage } from "./chatImages.js";

/** The narrowest the task panel and the chat get when the border between them is dragged. */
const SPLIT_MIN_LEFT = 340;
const SPLIT_MIN_CHAT = 380;

export interface TaskModalHost {
  /** The task as of Today's latest poll. */
  task(id: string): TodayTask | undefined;
  /** When Today's latest poll was asked for: a live read of a worker asked for later is fresher. */
  todayAt(): number;
  /** Reload Today now; the modal repaints from it. */
  refresh(): Promise<void>;
  startWorker(task: TodayTask): void;
  deleteTask(task: TodayTask): void;
  /** Close the task and open the PR in the app's own PR view. */
  openPr(ref: { org: string; project: string; repoId: string; prId: number }): Promise<void>;
}

const svg = (name: IconName): string => icon(name);

/** A worker's open question or approval, for Needs you and the modal's chat. */
export function requestCardHtml(label: string, r: WorkerRequest, draft: string): string {
  if (r.kind === "repos") return reposCardHtml(label, r);
  if (r.kind === "permission") {
    return `
      <div class="ask-card" data-key="r:${esc(r.id)}" data-request="${esc(r.id)}">
        <p class="ask-card-title">${svg("warning")}<span>${esc(r.title)}</span></p>
        ${r.detail ? `<pre class="ask-card-detail">${esc(r.detail)}</pre>` : ""}
        <div class="ask-card-actions">
          <button type="button" class="btn sm accent" data-decide="allow">Allow</button>
          <button type="button" class="btn sm" data-decide="always" title="Allow this and every later request from ${esc(label)}">Allow all for ${esc(label)}</button>
          <button type="button" class="btn sm ghost" data-decide="deny">Deny</button>
        </div>
      </div>`;
  }
  return `
    <div class="ask-card question" data-key="r:${esc(r.id)}" data-request="${esc(r.id)}">
      <div class="ask-card-q md">${renderMarkdown(r.title)}</div>
      ${r.choices.length ? `<div class="ask-card-choices">${r.choices.map((c) => `<button type="button" class="chip-btn" data-choice="${esc(c)}">${esc(c)}</button>`).join("")}</div>` : ""}
      ${
        r.allowFreeform
          ? `<form class="worker-msg" data-form="answer">
               <textarea rows="1" data-draft="ans:${esc(r.id)}" placeholder="Answer ${esc(label)}… (Enter to send)" aria-label="Answer ${esc(label)}">
${esc(draft)}</textarea>
               <button type="submit" class="btn sm accent">${svg("reply")}<span>Send</span></button>
             </form>`
          : ""
      }
    </div>`;
}

/**
 * The worker proposes repositories; the user checks the ones it gets worktrees of.
 * The checkboxes are pinned by data-v, so a poll's repaint keeps what the user checked.
 */
function reposCardHtml(label: string, r: WorkerRequest): string {
  const picked = new Set((r.selected || []).map((s) => s.toLowerCase()));
  const choices = [...r.choices].sort((a, b) => Number(picked.has(b.toLowerCase())) - Number(picked.has(a.toLowerCase())) || a.localeCompare(b));
  const rows = choices
    .map((c) => {
      const parts = c.split("/");
      const name = parts.pop() || c;
      return `<label class="repo-pick"><input type="checkbox" value="${esc(c)}"${picked.has(c.toLowerCase()) ? " checked" : ""}>
        <span class="repo-pick-name">${esc(name)}</span><span class="repo-pick-where">${esc(parts.join(" / "))}</span></label>`;
    })
    .join("");
  return `
    <div class="ask-card repos" data-key="r:${esc(r.id)}" data-request="${esc(r.id)}">
      <p class="ask-card-title">${svg("folder")}<span>${esc(label)} proposes these repositories</span></p>
      <div class="ask-card-q md">${renderMarkdown(r.title)}</div>
      ${r.detail ? `<p class="ask-card-note">${esc(r.detail)}</p>` : ""}
      <div class="ask-card-repos" data-v="${esc(r.id)}">${rows}</div>
      <p class="ask-card-note">Each one you keep gets a git worktree in ${esc(label)}'s folder, on its own branch off the repo's default branch.</p>
      <div class="ask-card-actions">
        <button type="button" class="btn sm accent" data-repos="confirm">Make worktrees</button>
        <button type="button" class="btn sm ghost" data-repos="none" title="Give ${esc(label)} no repositories">None</button>
      </div>
    </div>`;
}

/** The repositories checked in a repos card, or none for its None button. */
export function reposFromCard(button: HTMLElement): string[] | null {
  const card = button.closest<HTMLElement>("[data-request]");
  if (!card) return null;
  if (button.dataset.repos === "none") return [];
  return [...card.querySelectorAll<HTMLInputElement>('.ask-card-repos input[type="checkbox"]:checked')].map((i) => i.value);
}

/** Say in a remove dialog what its worktrees hold that isn't committed or pushed yet. */
export async function warnUnsaved(dialog: HTMLElement, query: string): Promise<void> {
  const note = dialog.querySelector<HTMLElement>(".jt-changes");
  if (!note) return;
  try {
    const res: { changes: Array<{ repo: string; path: string; uncommitted: number; unpushed: number }> } = await getJSON(
      `/api/jarvis/tasks/changes?${query}`
    );
    if (!res.changes.length || !dialog.isConnected) return;
    const lines = res.changes.map((c) => {
      const parts = [
        c.uncommitted ? `${c.uncommitted} uncommitted ${c.uncommitted === 1 ? "change" : "changes"}` : "",
        c.unpushed ? `${c.unpushed} unpushed ${c.unpushed === 1 ? "commit" : "commits"}` : "",
      ].filter(Boolean);
      return `<li><code>${esc(c.path)}</code>: ${esc(parts.join(" and "))}</li>`;
    });
    note.innerHTML = `<span class="jt-changes-head">${svg("warning")}<span>Deleting these loses work:</span></span><ul>${lines.join("")}</ul>`;
    note.hidden = false;
  } catch {
    /* the dialog's own text still says what goes */
  }
}

// ---- state that outlives one opening ------------------------------------------------

const notesBySession = new Map<string, ChatNote[]>();
const draftsBySession = new Map<string, string>();
/** Images waiting to go with the next message, per worker, like the text drafts. */
const imageDrafts = new Map<string, ImageDraft>();
const uploadImage = uploadWith((path, body) => postJSON(path, body));

/** The worker's tray of images, made the first time the user adds one. It repaints while its worker is shown. */
function draftFor(sessionId: string): ImageDraft {
  let draft = imageDrafts.get(sessionId);
  if (!draft) {
    const made = new ImageDraft(uploadImage, () => {
      const m = modal;
      if (!m || m.sessionId !== sessionId) return;
      paintTray(m.pane.tray, made, patchHtml);
      renderHint(currentWorker());
    });
    draft = made;
    imageDrafts.set(sessionId, made);
  }
  return draft;
}
const answerDrafts = new Map<string, string>();
const selectedByTask = new Map<string, string>();
const leftTabByTask = new Map<string, LeftTab>();
let noteSeq = 0;

/** Forget chat notes, drafts and tab choices for workers, questions and tasks that left Today. */
export function pruneTaskModalState(taskIds: Set<string>, sessionIds: Set<string>, requestIds: Set<string>): void {
  for (const id of [...notesBySession.keys()]) if (!sessionIds.has(id)) notesBySession.delete(id);
  for (const id of [...draftsBySession.keys()]) if (!sessionIds.has(id)) draftsBySession.delete(id);
  for (const [id, draft] of [...imageDrafts]) {
    if (sessionIds.has(id)) continue;
    draft.release(draft.items);
    imageDrafts.delete(id);
  }
  for (const key of [...answerDrafts.keys()]) if (!requestIds.has(key.replace(/^ans:/, ""))) answerDrafts.delete(key);
  for (const id of [...selectedByTask.keys()]) if (!taskIds.has(id)) selectedByTask.delete(id);
  for (const id of [...leftTabByTask.keys()]) if (!taskIds.has(id)) leftTabByTask.delete(id);
}

export type LeftTab = "status" | "devops" | "validation" | "artifacts";
const LEFT_TABS: readonly LeftTab[] = ["status", "devops", "validation", "artifacts"];

interface Devops {
  /** The task's PRs as last read; Today's copy until the first read. */
  prs: TaskPr[] | null;
  syncing: boolean;
  syncedAt: string | null;
  error: string;
  token: number;
  /** When it was last read, and what Today said about the PRs then. */
  loadedAt: number;
  todaySig: string;
  showFinished: boolean;
}

interface Timeline {
  /** The task's updates over its life, newest first, as far back as loaded. */
  items: StatusUpdate[] | null;
  hasMore: boolean;
  /** Older pages were read; from then on they decide whether more remain. */
  pagedBack: boolean;
  error: string;
  sig: string;
  token: number;
}

interface Arts {
  list: ArtifactInfo[] | null;
  dir: string;
  error: string;
  /** What the list was last read for; a change reads it again. */
  sig: string;
  token: number;
  /** The artifact being viewed, or null for the list. */
  open: string | null;
  file: Artifact | null;
  fileError: string;
  fileToken: number;
  /** "edit" and "new" keep their form as typed: polls don't repaint it. */
  mode: "view" | "edit" | "new";
  /** The text the editor started from, so a worker's newer write isn't overwritten. */
  editBase: string;
}

interface Log {
  messages: ChatMessage[];
  loading: boolean;
  error: string;
  /** The worker's busy/state/updatedAt when this copy was read. */
  sig: string;
  token: number;
}

interface Commands {
  list: ChatCommand[] | null;
  loading: Promise<void> | null;
  error: string;
}

type Popup =
  | { mode: "commands"; items: ChatCommand[]; index: number }
  | { mode: "choices"; command: ChatCommand; items: Array<{ name: string; description: string }>; index: number };

interface Modal {
  taskId: string;
  host: TaskModalHost;
  overlay: HTMLElement;
  dialog: HTMLElement;
  head: HTMLElement;
  ltabs: HTMLElement;
  panels: Record<LeftTab, HTMLElement>;
  leftTab: LeftTab;
  validation: ValidationPanel | null;
  artsCount: HTMLElement;
  statusList: HTMLElement;
  statusInput: HTMLInputElement;
  timeline: Timeline;
  dvCount: HTMLElement;
  dvWi: HTMLElement;
  dvHead: HTMLElement;
  dvLink: HTMLFormElement;
  dvLinkInput: HTMLInputElement;
  dvList: HTMLElement;
  devops: Devops;
  artsEl: HTMLElement;
  arts: Arts;
  tabs: HTMLElement;
  /** The shared chat pane; the fields below are its parts. */
  pane: ChatPane;
  chatHead: HTMLElement;
  log: HTMLElement;
  requests: HTMLElement;
  form: HTMLFormElement;
  input: HTMLTextAreaElement;
  send: HTMLButtonElement;
  hint: HTMLElement;
  popupEl: HTMLElement;
  /** Screen-reader line for the highlighted "/" item. */
  sr: HTMLElement;
  sessionId: string | null;
  workerIds: string[];
  logs: Map<string, Log>;
  commands: Map<string, Commands>;
  /** A message the user sent, until the conversation has it; `accepted` once the app has it. */
  pending: Map<string, { text: string; at: number; accepted: boolean; images?: ChatImage[] }>;
  /** The shown worker's latest live read, and the worker being followed (read every LIVE_MS). */
  live: LiveRead | null;
  liveFor: string | null;
  liveTimer: number;
  liveToken: number;
  /** Per worker: the turn's messages read live that its transcript doesn't have yet. */
  seen: Map<string, SeenMessage[]>;
  sending: boolean;
  /** A model or effort change is on its way for the shown worker. */
  switching: boolean;
  /** Launch requests in flight, keyed by worker and IDE. */
  openingIde: Set<string>;
  popup: Popup | null;
  sigs: Record<string, string>;
  returnFocus: HTMLElement | null;
  hintError: string;
}

let modal: Modal | null = null;
let logToken = 0;

const nowIso = (): string => new Date().toISOString();

export function isTaskModalOpen(): boolean {
  return !!modal;
}

// ---- open and close -----------------------------------------------------------------

export function openTaskModal(taskId: string, host: TaskModalHost, tab?: LeftTab): void {
  const task = host.task(taskId);
  if (!task) return;
  if (modal) closeTaskModal();
  const returnFocus = document.activeElement as HTMLElement | null;
  const overlay = document.createElement("div");
  overlay.className = "ask-overlay tm-overlay";
  const tabButton = (id: LeftTab, label: string, extra = "") =>
    `<button type="button" class="tm-ltab" role="tab" id="tm-lt-${id}" aria-controls="tm-lp-${id}" data-ltab="${id}" aria-selected="false" tabindex="-1">${label}${extra}</button>`;
  overlay.innerHTML = `
    <div class="tm" role="dialog" aria-modal="true" aria-labelledby="tm-title" tabindex="-1">
      <header class="tm-head"></header>
      <div class="tm-body">
        <section class="tm-left" aria-label="Task">
          <div class="tm-ltabs" role="tablist" aria-label="Task">
            ${tabButton("status", "Status")}${tabButton("devops", "Azure DevOps", '<span class="tm-ltab-count tm-dv-count"></span>')}${tabButton("validation", "Validation", '<span class="tm-ltab-dot tm-val-dot" hidden></span>')}${tabButton("artifacts", "Artifacts", '<span class="tm-ltab-count tm-arts-count"></span>')}
          </div>
          <div class="tm-lpanel" role="tabpanel" id="tm-lp-status" aria-labelledby="tm-lt-status" hidden>
            <form class="tl-post tm-status-form" data-form="status">
              <input type="text" maxlength="160" placeholder="Post a status… (Enter to post)" aria-label="Post a status" autocomplete="off">
              <button type="submit" class="btn sm">Post</button>
            </form>
            <div class="tm-status-list"></div>
          </div>
          <div class="tm-lpanel tm-dv" role="tabpanel" id="tm-lp-devops" aria-labelledby="tm-lt-devops" hidden>
            <div class="tm-dv-wi"></div>
            <div class="tm-dv-head"></div>
            <form class="tm-dv-link" data-form="pr-link" hidden>
              <input type="text" spellcheck="false" autocomplete="off" placeholder="Paste a pull request link" aria-label="Pull request link">
              <button type="submit" class="btn sm accent">Link</button>
              <button type="button" class="btn sm ghost" data-act="pr-link-cancel">Cancel</button>
            </form>
            <div class="tm-dv-list"></div>
          </div>
          <div class="tm-lpanel tm-val" role="tabpanel" id="tm-lp-validation" aria-labelledby="tm-lt-validation" hidden></div>
          <div class="tm-lpanel tm-arts" role="tabpanel" id="tm-lp-artifacts" aria-labelledby="tm-lt-artifacts" hidden></div>
          <div class="tm-split" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize the task and chat panels" title="Drag to resize · double-click to reset"></div>
        </section>
        <section class="tm-chat" aria-label="Worker chat">
          <div class="tm-tabs" role="tablist" aria-label="Workers"></div>
          ${chatPaneHtml({ id: "tm", commands: true, inputLabel: "Message the worker. Type slash for commands and skills." })}
        </section>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const q = <T extends Element>(sel: string): T => overlay.querySelector<T>(sel)!;
  const pane = chatPaneRefs(overlay);
  modal = {
    taskId,
    host,
    overlay,
    dialog: q(".tm"),
    head: q(".tm-head"),
    ltabs: q(".tm-ltabs"),
    panels: { status: q("#tm-lp-status"), devops: q("#tm-lp-devops"), validation: q("#tm-lp-validation"), artifacts: q("#tm-lp-artifacts") },
    leftTab: "status",
    validation: null,
    artsCount: q(".tm-arts-count"),
    statusList: q(".tm-status-list"),
    statusInput: q(".tm-status-form input"),
    timeline: { items: null, hasMore: false, pagedBack: false, error: "", sig: "", token: 0 },
    dvCount: q(".tm-dv-count"),
    dvWi: q(".tm-dv-wi"),
    dvHead: q(".tm-dv-head"),
    dvLink: q(".tm-dv-link"),
    dvLinkInput: q(".tm-dv-link input"),
    dvList: q(".tm-dv-list"),
    devops: { prs: task.prs ? [...task.prs] : null, syncing: false, syncedAt: null, error: "", token: 0, loadedAt: 0, todaySig: "", showFinished: false },
    artsEl: q(".tm-arts"),
    arts: {
      list: null,
      dir: "",
      error: "",
      sig: "",
      token: 0,
      open: null,
      file: null,
      fileError: "",
      fileToken: 0,
      mode: "view",
      editBase: "",
    },
    tabs: q(".tm-tabs"),
    pane,
    chatHead: pane.head,
    log: pane.log,
    requests: pane.requests,
    form: pane.form,
    input: pane.input,
    send: pane.send,
    hint: pane.hint,
    popupEl: pane.popup,
    sr: pane.sr,
    sessionId: null,
    workerIds: task.workers.map((w) => w.sessionId),
    logs: new Map(),
    commands: new Map(),
    pending: new Map(),
    live: null,
    liveFor: null,
    liveTimer: 0,
    liveToken: 0,
    seen: new Map(),
    sending: false,
    switching: false,
    openingIde: new Set(),
    popup: null,
    sigs: {},
    returnFocus,
    hintError: "",
  };
  const m = modal;
  // Every task sheet opens at the zoom last set on one (Ctrl +/−/0).
  zoomable(m.dialog, "task");
  // And split the way the last one was left (drag the border between the panels).
  const body = q<HTMLElement>(".tm-body");
  attachSplitter({
    container: body,
    handle: q<HTMLElement>(".tm-split"),
    left: q<HTMLElement>(".tm-left"),
    view: "task",
    minLeft: SPLIT_MIN_LEFT,
    minRight: SPLIT_MIN_CHAT,
    apply: (share) =>
      share === null
        ? body.style.removeProperty("--tm-left")
        : body.style.setProperty("--tm-left", `clamp(${SPLIT_MIN_LEFT}px, ${(share * 100).toFixed(2)}%, calc(100% - ${SPLIT_MIN_CHAT}px))`),
  });
  m.validation = createValidationPanel({
    taskId,
    panel: m.panels.validation,
    badge: q(".tm-val-dot"),
    refresh: () => m.host.refresh(),
    close: () => modal === m && closeTaskModal(),
    visible: () => modal === m && m.leftTab === "validation",
  });
  m.sessionId = pickWorker(task);
  m.input.value = (m.sessionId && draftsBySession.get(m.sessionId)) || "";
  m.dialog.addEventListener("click", onClick);
  m.dialog.addEventListener("submit", onSubmit);
  m.dialog.addEventListener("input", onInput);
  m.dialog.addEventListener("keydown", onKeydown);
  pane.tools.addEventListener("change", onWorkerPick);
  pane.steer.addEventListener("click", () => void submit(undefined, "now"));
  wireImages(pane, {
    draft: () => (modal === m && m.sessionId && !m.input.disabled ? draftFor(m.sessionId) : null),
    refused: (problems) => toast(problems.join(" "), "err"),
  });
  paintTray(pane.tray, m.sessionId ? (imageDrafts.get(m.sessionId) ?? null) : null, patchHtml);
  void loadModelCatalog().then(() => modal === m && render());
  m.input.addEventListener("blur", () => window.setTimeout(() => modal === m && document.activeElement !== m.input && hidePopup(), 150));
  // Picking from the list keeps the cursor in the box.
  m.popupEl.addEventListener("mousedown", (e) => e.preventDefault());
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeTaskModal();
  });
  document.addEventListener("keydown", onDocumentKey, true);
  selectLeftTab(tab || leftTabByTask.get(taskId) || "status");
  render();
  autoSize(m.input);
  requestAnimationFrame(() => (tab ? m.ltabs.querySelector<HTMLElement>(`[data-ltab="${tab}"]`)! : m.sessionId && !m.input.disabled ? m.input : m.dialog).focus());
}

export function closeTaskModal(): void {
  const m = modal;
  if (!m) return;
  if (m.sessionId) draftsBySession.set(m.sessionId, m.input.value);
  modal = null;
  clearTimeout(m.liveTimer);
  document.removeEventListener("keydown", onDocumentKey, true);
  m.overlay.remove();
  // Today repaints while the modal is open, so the button that opened it may be a new node.
  const back = m.returnFocus?.isConnected
    ? m.returnFocus
    : document.querySelector<HTMLElement>(`article.task-card[data-task="${CSS.escape(m.taskId)}"] .task-open`);
  back?.focus();
}

/** Today reloaded: repaint what changed, or close if the task is gone. */
export function updateTaskModal(): void {
  if (!modal) return;
  if (!modal.host.task(modal.taskId)) {
    closeTaskModal();
    return;
  }
  render();
}

/** The worker to show: the last one picked, else one that needs the user, is working, or moved last. */
function pickWorker(task: TodayTask): string | null {
  const remembered = selectedByTask.get(task.id);
  if (remembered && task.workers.some((w) => w.sessionId === remembered)) return remembered;
  const order = [...task.workers].sort(
    (a, b) =>
      Number(b.requests.length > 0) - Number(a.requests.length > 0) ||
      Number(b.busy) - Number(a.busy) ||
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  );
  return order[0]?.sessionId || null;
}

function currentTask(): TodayTask | undefined {
  return modal ? modal.host.task(modal.taskId) : undefined;
}

function currentWorker(): TodayWorker | undefined {
  const task = currentTask();
  const w = task?.workers.find((w) => w.sessionId === modal?.sessionId);
  return w && shown(w);
}

/** A worker as the chat shows it: Today's read, with the live read of it on top (see withLive). */
function shown(w: TodayWorker): TodayWorker {
  const m = modal;
  if (!m) return w;
  // Following counts while its reads keep coming; a stalled one gives way to Today's.
  const following = m.liveFor === w.sessionId && !!m.live && Date.now() - m.live.at < LIVE_FRESH_MS;
  return withLive(w, m.live, m.host.todayAt(), following);
}

// ---- following the shown worker's turn -------------------------------------------------

/** How often the shown worker is read while it works: the reply streams in, the turn's state stays current. */
const LIVE_MS = 250;
/** After a failed read, wait this long before the next. */
const LIVE_RETRY_MS = 2000;
/** A live read this recent outranks Today's while the chat follows the worker. */
const LIVE_FRESH_MS = 3000;
/** A message the user sent is followed this long for its turn to start, at most. */
const PENDING_FOLLOW_MS = 60_000;

/** Read the shown worker every LIVE_MS while it works or a message to it is on its way; stop when neither. */
function syncLive(w: TodayWorker | undefined): void {
  const m = modal!;
  const pending = w ? m.pending.get(w.sessionId) : undefined;
  const follow = w && (w.busy || (pending && Date.now() - pending.at < PENDING_FOLLOW_MS)) ? w.sessionId : null;
  if (follow === m.liveFor) return;
  clearTimeout(m.liveTimer);
  m.liveTimer = 0;
  m.liveToken++;
  m.liveFor = follow;
  if (follow) void readLive(follow);
}

async function readLive(sessionId: string): Promise<void> {
  const m = modal;
  if (!m || m.liveFor !== sessionId) return;
  const token = m.liveToken;
  const askedAt = Date.now();
  let failed = false;
  try {
    const res: { live: WorkerLive & { turn?: ChatMessage[] } } = await getJSON("/api/jarvis/workers/live?sessionId=" + encodeURIComponent(sessionId));
    if (modal !== m || token !== m.liveToken) return;
    const { turn, ...view } = res.live;
    m.live = { sessionId, view, at: askedAt };
    m.seen.set(sessionId, noteTurn(m.seen.get(sessionId) || [], turn || [], Date.now()));
  } catch {
    // The next read tries again, a little later; Today's reads carry on meanwhile.
    if (modal !== m || token !== m.liveToken) return;
    failed = true;
  }
  render();
  if (modal === m && token === m.liveToken && m.liveFor === sessionId) {
    m.liveTimer = window.setTimeout(() => void readLive(sessionId), failed ? LIVE_RETRY_MS : LIVE_MS);
  }
}

function selectWorker(sessionId: string): void {
  const m = modal;
  if (!m || m.sessionId === sessionId) return;
  if (m.sessionId) draftsBySession.set(m.sessionId, m.input.value);
  m.sessionId = sessionId;
  selectedByTask.set(m.taskId, sessionId);
  m.input.value = draftsBySession.get(sessionId) || "";
  m.hintError = "";
  hidePopup();
  autoSize(m.input);
  paintTray(m.pane.tray, imageDrafts.get(sessionId) ?? null, patchHtml);
  render();
  // Each worker's conversation opens at its latest message.
  m.log.scrollTop = m.log.scrollHeight;
  m.input.focus();
}

// ---- render -------------------------------------------------------------------------

/** A control's identity across repaints: what it does and what it belongs to. */
function focusKey(node: HTMLElement): string {
  const own = ["data-act", "data-ide", "popovertarget", "data-tab", "data-ltab", "data-name", "data-decide", "data-choice", "data-repos", "data-run", "data-draft"].map((a) => node.getAttribute(a) || "");
  // Controls repeated per request or per PR row belong to that row.
  const owner =
    node.closest<HTMLElement>("[data-request]")?.dataset.request || node.closest<HTMLElement>("[data-pr-key]")?.dataset.prKey || "";
  return [node.tagName, owner, ...own].join("|");
}

/**
 * Repaint without losing the keyboard. Patching keeps most nodes, but a focused
 * control can still be replaced, moved (which drops focus), or reused for another
 * row; in each case focus goes back to the control with the same identity, or the
 * dialog takes it, so Escape and Tab keep working.
 */
function keepFocus(paint: () => void): void {
  const m = modal!;
  const active = document.activeElement as HTMLElement | null;
  const key = active && active !== m.dialog && m.dialog.contains(active) ? focusKey(active) : null;
  paint();
  if (!key) return;
  const still = document.activeElement === active && active!.isConnected && focusKey(active!) === key;
  if (!still) restoreFocus(key);
}

/** Focus the visible control with this identity, or the dialog when it's gone. */
function restoreFocus(key: string): void {
  const m = modal;
  if (!m) return;
  const next = [...m.dialog.querySelectorAll<HTMLElement>("button, a[href], textarea, input")].find(
    (n) => focusKey(n) === key && !(n as HTMLButtonElement).disabled && n.offsetParent !== null
  );
  (next || m.dialog).focus({ preventScroll: true });
}

/** Run `paint` only when `sig` changed for `region`. */
function region(name: string, sig: string, paint: () => void): void {
  if (!modal || modal.sigs[name] === sig) return;
  modal.sigs[name] = sig;
  keepFocus(paint);
}

function render(): void {
  const m = modal;
  const task = currentTask();
  if (!m || !task) return;
  const now = Date.now();
  // A worker that just appeared (started from here) becomes the one shown.
  const ids = task.workers.map((w) => w.sessionId);
  const added = ids.filter((id) => !m.workerIds.includes(id));
  m.workerIds = ids;
  if (added.length) {
    const newest = task.workers.filter((w) => added.includes(w.sessionId)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (newest) {
      if (m.sessionId) draftsBySession.set(m.sessionId, m.input.value);
      m.sessionId = newest.sessionId;
      selectedByTask.set(m.taskId, newest.sessionId);
      m.input.value = draftsBySession.get(newest.sessionId) || "";
    }
  }
  if (!m.sessionId || !ids.includes(m.sessionId)) {
    const next = pickWorker(task);
    if (next !== m.sessionId) {
      m.sessionId = next;
      m.input.value = (next && draftsBySession.get(next)) || "";
      autoSize(m.input);
    }
  }
  const minute = Math.floor(now / 60_000);
  region("head", JSON.stringify([task.title, task.status, task.workItem, task.org, task.project, task.doneAt, minute]), () => renderHead(task, now));
  syncTimeline(task);
  paintTimeline(now);
  region(
    "dv-wi",
    JSON.stringify([task.workItem, task.org, task.project, task.createdAt, task.description, task.folder, task.workers.map((w) => [w.label, w.worktrees])]),
    () => renderWorkItem(task)
  );
  syncDevops(task);
  paintDevops(now);
  m.validation?.sync(task);
  syncArtifacts(task);
  paintArts();
  region("tabs", JSON.stringify([task.workers.map((w) => [w.sessionId, w.label, workerState(shown(w))]), m.sessionId, task.status]), () => renderTabs(task));
  const w = currentWorker();
  if (w) syncLog(w);
  syncLive(w);
  region(
    "chatHead",
    JSON.stringify([w?.sessionId, w?.cwd, w?.label, !!task.folder, w && workerState(w), w?.activity, w?.busy, minute, w?.updatedAt, [...m.openingIde]]),
    () => renderChatHead(task, w, now)
  );
  region(
    "picker",
    JSON.stringify([w?.sessionId, w?.label, w?.model, w?.effort, w?.currentModel, w?.currentEffort, w?.busy, m.switching, !!modelCatalog()]),
    () => renderPicker(w)
  );
  renderLog(task, w);
  region("requests", JSON.stringify([w?.sessionId, w?.requests]), () => renderRequests(w));
  renderComposer(task, w);
}

function renderHead(task: TodayTask, now: number): void {
  const m = modal!;
  const done = task.status === "done";
  const meta = taskMeta(task) + (done && task.doneAt ? ` · done ${agoPhrase(task.doneAt, now)}` : "");
  patchHtml(
    m.head,
    `
    <span class="tm-icon${done ? " tone-ok" : ""}">${svg(done ? "check" : "circle")}</span>
    <div class="tm-heading">
      <h2 class="tm-title" id="tm-title">${esc(task.title)}</h2>
      <p class="tm-meta" title="${esc(meta)}">${esc(meta)}</p>
    </div>
    <div class="tm-actions">
      ${
        task.workItem?.url
          ? `<a class="icon-btn" href="${esc(task.workItem.url)}" target="_blank" rel="noopener" title="Open in Azure DevOps" aria-label="Open in Azure DevOps">${svg("external")}</a>`
          : ""
      }
      ${
        done
          ? `<button type="button" class="btn sm ghost" data-act="reopen">Reopen</button>`
          : `<button type="button" class="btn sm ghost" data-act="done">${svg("check")}<span>Mark done</span></button>`
      }
      <button type="button" class="icon-btn" data-act="delete-task" title="Remove task" aria-label="Remove task">${svg("trash")}</button>
      <button type="button" class="icon-btn tm-close" data-act="close" title="Close (Esc)" aria-label="Close">${svg("dismiss")}</button>
    </div>`
  );
}

// ---- the status timeline, over the task's life ---------------------------------------

const TIMELINE_PAGE = 200;

/** The newest page is read again whenever the task's latest update changes. */
function syncTimeline(task: TodayTask): void {
  const t = modal!.timeline;
  const sig = JSON.stringify([task.updates?.latest?.id ?? null, task.updates?.today.length ?? 0]);
  if (sig === t.sig) return;
  t.sig = sig;
  void loadTimeline();
}

async function loadTimeline(before?: number): Promise<void> {
  const m = modal;
  if (!m) return;
  const t = m.timeline;
  // Only the newest-page reads race each other; an older page never cancels one.
  const token = before ? 0 : ++t.token;
  try {
    const res: { statuses: StatusUpdate[]; hasMore: boolean } = await getJSON(
      `/api/jarvis/statuses?id=${encodeURIComponent(m.taskId)}&limit=${TIMELINE_PAGE}${before ? `&before=${before}` : ""}`
    );
    if (modal !== m || (!before && token !== t.token)) return;
    t.items = mergeStatuses(t.items || [], res.statuses);
    if (before) {
      t.pagedBack = true;
      t.hasMore = res.hasMore;
    } else if (!t.pagedBack) {
      t.hasMore = res.hasMore;
    }
    t.error = "";
  } catch (e) {
    if (modal !== m) return;
    if (before) throw e;
    t.error = (e as Error).message;
    // The next poll tries again.
    t.sig = "";
  }
  paintTimeline(Date.now());
}

function paintTimeline(now: number): void {
  const m = modal;
  if (!m) return;
  const t = m.timeline;
  const items = t.items;
  region("timeline", JSON.stringify([items?.length ?? -1, items?.[0]?.id, items?.[items.length - 1]?.id, t.hasMore, t.error, new Date(now).toDateString()]), () => {
    if (!items) {
      m.statusList.innerHTML = t.error
        ? `<p class="tl-empty err">Couldn't read the timeline: ${esc(t.error)}</p>`
        : `<p class="tl-empty"><span class="spinner"></span> Loading the timeline…</p>`;
      return;
    }
    if (!items.length) {
      m.statusList.innerHTML = `<p class="tl-empty">No status yet. Workers post one after each turn.</p>`;
      return;
    }
    const days = statusDays(items, now)
      .map(
        (day) => `<section class="tl-day" data-key="d:${esc(day.label)}" aria-label="${esc(day.label)}">
          <h4 class="tl-day-h">${esc(day.label)}</h4>
          <ol class="tl">${day.items
            .map(
              (s) =>
                `<li data-key="s:${esc(String(s.id))}"><time datetime="${esc(s.at)}">${esc(new Date(s.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }))}</time><span class="tl-who">${esc(s.author)}</span><span class="tl-text">${esc(s.text)}</span></li>`
            )
            .join("")}</ol>
        </section>`
      )
      .join("");
    patchHtml(
      m.statusList,
      `${days}${t.hasMore ? `<button type="button" class="btn sm ghost tl-older" data-act="status-older">Show older updates</button>` : ""}`
    );
  });
}

/** The work item behind the task (or that it's a custom task), its service and when it was added. */
function renderWorkItem(task: TodayTask): void {
  const rows: string[] = [];
  const wi = task.workItem;
  if (wi) {
    rows.push(
      `<div class="tm-kv"><span>Work item</span><span>${
        wi.url ? `<a href="${esc(wi.url)}" target="_blank" rel="noopener">${esc(`${wi.type} #${wi.id}`)}</a>` : esc(`${wi.type} #${wi.id}`)
      }${wi.state ? ` · ${esc(wi.state)}` : ""}</span></div>`
    );
    if (wi.parent) rows.push(`<div class="tm-kv"><span>Parent</span><span>${esc(`${wi.parent.type} #${wi.parent.id} · ${wi.parent.title}`)}</span></div>`);
  } else {
    rows.push(`<div class="tm-kv"><span>Work item</span><span class="tm-kv-muted">None: a custom task</span></div>`);
  }
  rows.push(`<div class="tm-kv"><span>Service</span><span>${esc(task.org && task.project ? `${task.org} / ${task.project}` : "None")}</span></div>`);
  rows.push(
    `<div class="tm-kv"><span>Added</span><span>${esc(new Date(task.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }))}</span></div>`
  );
  if (task.folder) rows.push(`<div class="tm-kv"><span>Folder</span><span class="tm-kv-path" title="${esc(task.folder)}">${esc(task.folder)}</span></div>`);
  const trees = task.workers.flatMap((w) => (w.worktrees || []).map((t) => ({ ...t, worker: w.label })));
  if (trees.length) {
    rows.push(
      `<div class="tm-kv"><span>Worktrees</span><span class="tm-trees">${trees
        .map(
          (t) =>
            `<span class="tm-tree" title="${esc(t.path)}"><strong>${esc(t.repo)}</strong> · ${esc(t.worker)} · <code>${esc(t.branch)}</code></span>`
        )
        .join("")}</span></div>`
    );
  }
  if (task.description) {
    rows.push(`<div class="tm-desc"><span class="tm-desc-h">Description</span><div class="tm-desc-body md">${renderMarkdown(task.description)}</div></div>`);
  }
  modal!.dvWi.innerHTML = rows.join("");
}

// ---- the task's pull requests -------------------------------------------------------

/** Read the PRs when the modal opens, while the server is still reading them, once a minute, and when Today saw them change. */
function syncDevops(task: TodayTask): void {
  const m = modal!;
  const d = m.devops;
  const todaySig = JSON.stringify((task.prs || []).map((p) => [p.org, p.prId, p.refreshedAt]));
  const age = Date.now() - d.loadedAt;
  if (!d.loadedAt || todaySig !== d.todaySig || age > 60_000 || (d.syncing && age > 3_000)) {
    d.todaySig = todaySig;
    void loadDevops(false);
  }
}

async function loadDevops(refresh: boolean): Promise<void> {
  const m = modal;
  if (!m) return;
  const d = m.devops;
  const token = ++d.token;
  d.loadedAt = Date.now();
  if (refresh) d.syncing = true;
  try {
    const res: { prs: TaskPr[]; syncing: boolean; syncedAt: string | null; error: string | null } = await getJSON(
      `/api/jarvis/task-prs?id=${encodeURIComponent(m.taskId)}${refresh ? "&refresh=1" : ""}`
    );
    if (modal !== m || token !== d.token) return;
    d.prs = res.prs;
    d.syncing = res.syncing;
    d.syncedAt = res.syncedAt;
    d.error = res.error || "";
  } catch (e) {
    if (modal !== m || token !== d.token) return;
    d.error = (e as Error).message;
    d.syncing = false;
  }
  paintDevops(Date.now());
}

function paintDevops(now: number): void {
  const m = modal;
  if (!m) return;
  const d = m.devops;
  const prs = d.prs;
  m.dvCount.textContent = prs?.length ? ` ${prs.length}` : "";
  const minute = Math.floor(now / 60_000);
  region("dv-head", JSON.stringify([prs?.length ?? -1, d.syncing, d.error, d.syncedAt, minute, m.dvLink.hidden]), () => {
    const fresh = d.syncing
      ? `<span class="tm-dv-fresh"><span class="spinner"></span> Checking…</span>`
      : d.syncedAt
        ? `<span class="tm-dv-fresh" title="Checked Azure DevOps at ${esc(new Date(d.syncedAt).toLocaleTimeString())}">${esc(agoPhrase(d.syncedAt, now))}</span>`
        : `<span class="tm-dv-fresh"></span>`;
    patchHtml(
      m.dvHead,
      `
      <div class="tm-dv-bar">
        <h4 class="tm-dv-h">Pull requests</h4>
        ${fresh}
        <button type="button" class="icon-btn" data-act="pr-refresh" title="Check Azure DevOps now" aria-label="Check Azure DevOps now"${d.syncing ? " disabled" : ""}>${svg("sync")}</button>
        ${m.dvLink.hidden ? `<button type="button" class="btn sm ghost" data-act="pr-link">${svg("add")}<span>Link PR</span></button>` : ""}
      </div>
      ${d.error ? `<p class="tm-muted err">${esc(d.error)}</p>` : ""}`
    );
  });
  region("dv-list", JSON.stringify([prs, d.showFinished, minute]), () => {
    if (!prs) {
      patchHtml(m.dvList, `<p class="tm-muted"><span class="spinner"></span> Loading pull requests…</p>`);
      return;
    }
    if (!prs.length) {
      const task = currentTask();
      patchHtml(
        m.dvList,
        `<p class="tm-muted tm-dv-empty">No pull requests yet. ${
          task?.workItem ? "PRs linked to the work item in Azure DevOps show here, and so do the ones" : "The ones"
        } this task's workers open. You can also link one yourself.</p>`
      );
      return;
    }
    const { open, finished } = groupTaskPrs(prs);
    const rows = (list: TaskPr[]) => list.map((p) => prRowHtml(p, now)).join("");
    patchHtml(
      m.dvList,
      `
      ${open.length ? `<ul class="tm-pr-list">${rows(open)}</ul>` : `<p class="tm-muted">No open pull requests.</p>`}
      ${
        finished.length
          ? `<button type="button" class="tm-pr-fold" data-act="pr-finished" aria-expanded="${d.showFinished}">${svg("chevron")}<span>${finished.length} finished</span></button>
             ${d.showFinished ? `<ul class="tm-pr-list is-finished">${rows(finished)}</ul>` : ""}`
          : ""
      }`
    );
  });
}

function prRowHtml(p: TaskPr, now: number): string {
  const s = p.snapshot;
  const state = prState(p);
  const key = esc(JSON.stringify([p.org, p.prId]));
  const title = s?.title || `Pull request ${p.prId}`;
  const meta = s
    ? [
        s.repo,
        `PR ${p.prId}`,
        s.sourceRef && s.targetRef ? `${s.sourceRef} → ${s.targetRef}` : "",
        s.status === "completed" && s.closed
          ? `merged ${agoPhrase(s.closed, now)}`
          : s.status === "abandoned" && s.closed
            ? `abandoned ${agoPhrase(s.closed, now)}`
            : s.created
              ? `opened ${agoPhrase(s.created, now)}${s.author ? ` by ${s.author}` : ""}`
              : "",
      ].filter(Boolean)
    : [`${p.org} · PR ${p.prId}`];
  const signals = prSignals(p)
    .map((sig) => `<span class="tm-sig tone-${sig.tone}">${esc(sig.text)}</span>`)
    .join("");
  const canOpen = !!(s?.project && s.repoId);
  return `<li class="tm-pr" data-key="pr:${key}" data-pr-key="${key}">
      <div class="tm-pr-top">
        <span class="tm-pr-state tone-${state.tone}">${esc(state.label)}</span>
        ${
          canOpen
            ? `<button type="button" class="tm-pr-title" data-act="pr-open" title="Open in the app">${esc(title)}</button>`
            : `<span class="tm-pr-title">${esc(title)}</span>`
        }
        ${s?.url ? `<a class="icon-btn tm-pr-ext" data-act="pr-ext" href="${esc(s.url)}" target="_blank" rel="noopener" title="Open in Azure DevOps" aria-label="Open PR ${p.prId} in Azure DevOps">${svg("external")}</a>` : ""}
      </div>
      <p class="tm-pr-meta" title="${esc(meta.join(" · "))}">${esc(meta.join(" · "))}</p>
      ${signals ? `<div class="tm-pr-signals">${signals}</div>` : ""}
      ${p.error ? `<p class="tm-muted err">${esc(p.error)}</p>` : ""}
      <div class="tm-pr-foot">
        <span class="tm-pr-src">${esc(prSourceText(p.source))}</span>
        ${p.source === "workitem" ? "" : `<button type="button" class="btn sm ghost tm-pr-unlink" data-act="pr-unlink" aria-label="Unlink PR ${p.prId}">Unlink</button>`}
      </div>
    </li>`;
}

function prOfNode(node: HTMLElement): TaskPr | undefined {
  const raw = node.closest<HTMLElement>("[data-pr-key]")?.dataset.prKey;
  if (!raw || !modal?.devops.prs) return undefined;
  const [org, prId] = JSON.parse(raw) as [string, number];
  return modal.devops.prs.find((p) => p.org === org && p.prId === prId);
}

function showLinkForm(show: boolean): void {
  const m = modal!;
  m.dvLink.hidden = !show;
  if (show) {
    m.dvLinkInput.value = "";
    paintDevops(Date.now());
    m.dvLinkInput.focus();
  } else {
    paintDevops(Date.now());
    m.dvHead.querySelector<HTMLElement>("[data-act='pr-link']")?.focus();
  }
}

async function linkPr(): Promise<void> {
  const m = modal!;
  const text = m.dvLinkInput.value.trim();
  if (!text) return;
  await withButton(m.dvLink.querySelector("button[type=submit]"), async () => {
    const res: { pr: TaskPr; prs: TaskPr[]; syncing: boolean; syncedAt: string | null; error: string | null } = await postJSON(
      "/api/jarvis/task-prs/link",
      { id: m.taskId, pr: text }
    );
    if (modal !== m) return;
    m.devops.prs = res.prs;
    m.devops.syncing = res.syncing;
    toast(`Linked PR ${res.pr.prId}`, "ok");
    showLinkForm(false);
    await m.host.refresh();
  });
}

async function unlinkPr(p: TaskPr, button: HTMLElement): Promise<void> {
  const m = modal!;
  await withButton(button, async () => {
    await postJSON("/api/jarvis/task-prs/unlink", { id: m.taskId, org: p.org, prId: p.prId });
    if (modal !== m) return;
    if (m.devops.prs) m.devops.prs = m.devops.prs.filter((x) => !(x.org === p.org && x.prId === p.prId));
    toast(`Unlinked PR ${p.prId}. Paste its link in Link PR to bring it back.`, "ok");
    paintDevops(Date.now());
    (m.dvHead.querySelector<HTMLElement>("[data-act='pr-link']") || m.dialog).focus();
    await m.host.refresh();
  });
}

async function openPrInApp(p: TaskPr, button: HTMLElement): Promise<void> {
  const m = modal!;
  const s = p.snapshot;
  if (!s) return;
  await withButton(button, () => m.host.openPr({ org: p.org, project: s.project, repoId: s.repoId, prId: p.prId }));
}

// ---- left tabs ----------------------------------------------------------------------

function selectLeftTab(tab: LeftTab, focus = false): void {
  const m = modal;
  if (!m) return;
  m.leftTab = tab;
  leftTabByTask.set(m.taskId, tab);
  for (const button of m.ltabs.querySelectorAll<HTMLElement>("[data-ltab]")) {
    const selected = button.dataset.ltab === tab;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  for (const name of LEFT_TABS) m.panels[name].hidden = name !== tab;
  if (focus) m.ltabs.querySelector<HTMLElement>(`[data-ltab="${tab}"]`)?.focus();
  // Coming back to Artifacts reads the folder again; a worker may have added something.
  if (tab === "artifacts" && m.arts.mode === "view") void loadArtifacts();
  const task = currentTask();
  if (tab === "validation" && task) m.validation?.shown(task);
}

/** Arrow keys, Home and End move between the left tabs. */
function onLeftTabKey(e: KeyboardEvent): boolean {
  const m = modal!;
  const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };
  let index = LEFT_TABS.indexOf(m.leftTab);
  if (e.key in keys) index = (index + keys[e.key] + LEFT_TABS.length) % LEFT_TABS.length;
  else if (e.key === "Home") index = 0;
  else if (e.key === "End") index = LEFT_TABS.length - 1;
  else return false;
  e.preventDefault();
  selectLeftTab(LEFT_TABS[index], true);
  return true;
}

// ---- artifacts ----------------------------------------------------------------------

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The list is read again when the task's workers or updates move, since workers write artifacts. */
function syncArtifacts(task: TodayTask): void {
  const m = modal!;
  const sig = JSON.stringify([task.updates?.latest?.id, task.workers.map((w) => [w.updatedAt, w.busy]), task.updatedAt, task.recap?.state, task.status]);
  if (sig === m.arts.sig) return;
  m.arts.sig = sig;
  void loadArtifacts();
}

async function loadArtifacts(): Promise<void> {
  const m = modal;
  if (!m) return;
  const token = ++m.arts.token;
  try {
    const res: { artifacts: ArtifactInfo[]; dir: string } = await getJSON("/api/jarvis/artifacts?id=" + encodeURIComponent(m.taskId));
    if (modal !== m || token !== m.arts.token) return;
    m.arts.list = res.artifacts;
    m.arts.dir = res.dir;
    m.arts.error = "";
    const open = m.arts.open;
    if (open && m.arts.mode !== "edit") {
      const info = res.artifacts.find((i) => sameName(i.name, open));
      if (!info && !sameName(open, NOTE_NAME)) {
        // Deleted elsewhere: back to the list.
        m.arts.open = null;
        m.arts.file = null;
      } else if (info && m.arts.file && info.modifiedAt !== m.arts.file.modifiedAt) {
        void loadFile(open);
      }
    }
  } catch (e) {
    if (modal !== m || token !== m.arts.token) return;
    m.arts.error = (e as Error).message;
    // The next poll tries again.
    m.arts.sig = "";
  }
  paintArts();
}

async function loadFile(name: string): Promise<void> {
  const m = modal;
  if (!m) return;
  const token = ++m.arts.fileToken;
  try {
    const res: { artifact: Artifact } = await getJSON(
      `/api/jarvis/artifact?id=${encodeURIComponent(m.taskId)}&name=${encodeURIComponent(name)}`
    );
    if (modal !== m || token !== m.arts.fileToken || !m.arts.open || !sameName(m.arts.open, name)) return;
    m.arts.file = res.artifact;
    m.arts.fileError = "";
  } catch (e) {
    if (modal !== m || token !== m.arts.fileToken) return;
    m.arts.fileError = (e as Error).message;
  }
  paintArts();
}

/** Repaint the Artifacts panel when what it shows changed. An open editor or new-note form is left alone. */
function paintArts(): void {
  const m = modal;
  const task = currentTask();
  if (!m || !task) return;
  const a = m.arts;
  m.artsCount.textContent = a.list ? ` ${a.list.length}` : "";
  if (a.mode !== "view") return;
  const sig = JSON.stringify([
    a.list,
    a.dir,
    a.error,
    a.open,
    a.file && [a.file.name, a.file.modifiedAt, a.file.content.length],
    a.fileError,
    task.recap,
    task.status,
    task.workers.length,
    Math.floor(Date.now() / 60_000),
  ]);
  region("arts", sig, () => (a.open ? paintFile() : paintList(task)));
}

function paintList(task: TodayTask): void {
  const m = modal!;
  const a = m.arts;
  const now = Date.now();
  const hasRecap = !!a.list?.some((i) => sameName(i.name, RECAP_NAME));
  const recap = recapLine(task, hasRecap);
  const recapHtml = recap
    ? `<div class="tm-recap tone-${recap.tone}" role="status">
        ${recap.busy ? '<span class="spinner"></span>' : svg(recap.tone === "warn" ? "warning" : "sparkle")}
        <span class="tm-recap-text">${esc(recap.text)}</span>
        ${recap.action ? `<button type="button" class="btn sm ghost" data-act="art-recap">${esc(recap.action)}</button>` : ""}
      </div>`
    : "";
  let body: string;
  if (!a.list) {
    body = a.error
      ? `<p class="tm-muted err">Couldn't read the artifacts: ${esc(a.error)}</p>`
      : `<p class="tm-muted"><span class="spinner"></span> Loading artifacts…</p>`;
  } else {
    body = `<ul class="tm-art-list">${a.list
      .map((i) => {
        const role = artifactRole(i.name);
        return `<li><button type="button" class="tm-art" data-act="art-open" data-name="${esc(i.name)}">
            <span class="tm-art-icon">${svg(sameName(i.name, RECAP_NAME) ? "sparkle" : "file")}</span>
            <span class="tm-art-name">${esc(i.name)}</span>
            ${role ? `<span class="tm-art-role">${esc(role)}</span>` : ""}
            <span class="tm-art-meta">${esc(formatBytes(i.size))} · ${esc(agoPhrase(i.modifiedAt, now))}</span>
          </button></li>`;
      })
      .join("")}</ul>`;
  }
  m.artsEl.innerHTML = `
    <div class="tm-art-bar">
      <p class="tm-art-intro">Shared by you and this task's workers.</p>
      <button type="button" class="btn sm ghost" data-act="art-new">${svg("add")}<span>New note</span></button>
    </div>
    ${recapHtml}
    ${body}
    ${a.dir ? `<p class="tm-path" title="${esc(a.dir)}">${esc(a.dir)}</p>` : ""}`;
}

function paintFile(): void {
  const m = modal!;
  const a = m.arts;
  const name = a.file?.name || a.open || "";
  const isNote = sameName(name, NOTE_NAME);
  let content: string;
  if (a.fileError && !a.file) content = `<p class="tm-muted err">Couldn't read ${esc(name)}: ${esc(a.fileError)}</p>`;
  else if (!a.file) content = `<p class="tm-muted"><span class="spinner"></span> Loading ${esc(name)}…</p>`;
  else if (!a.file.content.trim()) {
    content = `<p class="tm-muted">${isNote ? "Empty. You and the task's workers share this note: decisions, findings, open questions." : "Empty."}</p>`;
  } else if (isMarkdownName(name)) content = `<div class="md tm-note-md">${renderMarkdown(a.file.content)}</div>`;
  else content = `<pre class="tm-art-pre">${esc(a.file.content)}</pre>`;
  m.artsEl.innerHTML = `
    <div class="tm-art-bar">
      <button type="button" class="btn sm ghost tm-art-back" data-act="art-back" title="All artifacts">${svg("back")}<span>Artifacts</span></button>
      <span class="tm-art-crumb" title="${esc(name)}">${esc(name)}</span>
      <span class="tm-art-actions">
        ${a.file ? `<button type="button" class="btn sm ghost" data-act="art-edit">Edit</button>` : ""}
        ${
          isNote
            ? ""
            : `<button type="button" class="icon-btn" data-act="art-delete" title="Delete ${esc(name)}" aria-label="Delete ${esc(name)}">${svg("trash")}</button>`
        }
      </span>
    </div>
    ${content}
    ${a.file ? `<p class="tm-path" title="${esc(a.file.path)}">${esc(a.file.path)}</p>` : ""}`;
}

function openArtifact(name: string): void {
  const m = modal!;
  m.arts.open = name;
  m.arts.file = null;
  m.arts.fileError = "";
  paintArts();
  m.artsEl.querySelector<HTMLElement>("[data-act='art-back']")?.focus();
  void loadFile(name);
}

function backToList(): void {
  const m = modal!;
  const was = m.arts.open;
  m.arts.open = null;
  m.arts.file = null;
  m.arts.fileError = "";
  m.arts.mode = "view";
  paintArts();
  const item = was ? [...m.artsEl.querySelectorAll<HTMLElement>("[data-act='art-open']")].find((n) => sameName(n.dataset.name || "", was)) : null;
  (item || m.artsEl.querySelector<HTMLElement>("[data-act='art-new']") || m.dialog).focus();
  void loadArtifacts();
}

/** Leave the editor or the new-note form for the normal view, repainting it. */
function toView(): void {
  const m = modal!;
  m.arts.mode = "view";
  delete m.sigs.arts;
  paintArts();
}

function startArtEdit(): void {
  const m = modal!;
  const file = m.arts.file;
  if (!file) return;
  m.arts.mode = "edit";
  m.arts.editBase = file.content;
  m.artsEl.innerHTML = `
    <div class="tm-art-bar"><span class="tm-art-crumb">Editing ${esc(file.name)}</span></div>
    <textarea class="ask-q jv-note tm-note-text" rows="16" spellcheck="true" aria-label="Edit ${esc(file.name)}">
${esc(file.content)}</textarea>
    <div class="tm-note-actions">
      <button type="button" class="btn sm ghost" data-act="art-cancel">Cancel</button>
      <button type="button" class="btn sm accent" data-act="art-save">Save</button>
    </div>`;
  m.artsEl.querySelector<HTMLTextAreaElement>("textarea")!.focus();
}

function cancelArtEdit(): void {
  const m = modal!;
  toView();
  m.artsEl.querySelector<HTMLElement>("[data-act='art-edit']")?.focus();
  if (m.arts.open) void loadFile(m.arts.open);
}

async function saveArt(button: HTMLElement): Promise<void> {
  const m = modal!;
  const file = m.arts.file;
  if (!file) return;
  const text = m.artsEl.querySelector<HTMLTextAreaElement>("textarea")?.value ?? "";
  if (button instanceof HTMLButtonElement) button.disabled = true;
  try {
    const res: { artifact: Artifact } = await postJSON("/api/jarvis/artifact", { id: m.taskId, name: file.name, content: text, base: m.arts.editBase });
    if (modal !== m) return;
    m.arts.file = res.artifact;
    toView();
    m.artsEl.querySelector<HTMLElement>("[data-act='art-edit']")?.focus();
    toast(`Saved ${file.name}`, "ok");
    void loadArtifacts();
  } catch (e) {
    const message = (e as Error).message;
    if (/changed while you were editing/.test(message) && modal === m) {
      // Keep the user's text; the next Save replaces the newer copy on purpose.
      try {
        const res: { artifact: Artifact } = await getJSON(
          `/api/jarvis/artifact?id=${encodeURIComponent(m.taskId)}&name=${encodeURIComponent(file.name)}`
        );
        m.arts.editBase = res.artifact.content;
      } catch {
        /* the next Save reports it */
      }
      toast(`${file.name} changed while you edited it, likely a worker's entry. Your text is kept. Save again to replace it, or Cancel to see the new version.`, "err");
    } else {
      toast(message, "err");
    }
  } finally {
    if (button instanceof HTMLButtonElement && button.isConnected) button.disabled = false;
    // Disabling the focused Save dropped focus to the page; after a failed save, it goes back to the text.
    if (modal === m && m.arts.mode === "edit" && !m.dialog.contains(document.activeElement)) {
      m.artsEl.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    }
  }
}

function startNewArt(): void {
  const m = modal!;
  const name = nextArtifactName((m.arts.list || []).map((i) => i.name));
  m.arts.mode = "new";
  m.artsEl.innerHTML = `
    <form class="tm-art-new" data-form="art-new">
      <label class="rp-label" for="tm-art-name">New note</label>
      <input id="tm-art-name" class="ask-q jv-field" value="${esc(name)}" maxlength="80" spellcheck="false" autocomplete="off">
      <p class="tm-muted">A file in this task's Artifacts, like design.md or findings.md. Workers can read it too.</p>
      <div class="tm-note-actions">
        <button type="button" class="btn sm ghost" data-act="art-new-cancel">Cancel</button>
        <button type="submit" class="btn sm accent" data-act="art-create">Create</button>
      </div>
    </form>`;
  const input = m.artsEl.querySelector<HTMLInputElement>("input")!;
  input.focus();
  input.setSelectionRange(0, name.lastIndexOf("."));
}

function cancelNewArt(): void {
  const m = modal!;
  toView();
  m.artsEl.querySelector<HTMLElement>("[data-act='art-new']")?.focus();
}

async function createArt(form: HTMLFormElement): Promise<void> {
  const m = modal!;
  const name = form.querySelector<HTMLInputElement>("input")?.value.trim() || "";
  if (!name) return;
  await withButton(form.querySelector("button[type=submit]"), async () => {
    const res: { artifact: Artifact } = await postJSON("/api/jarvis/artifact", {
      id: m.taskId,
      name,
      content: newArtifactText(name),
      create: true,
    });
    if (modal !== m) return;
    m.arts.mode = "view";
    m.arts.open = res.artifact.name;
    m.arts.file = res.artifact;
    m.arts.fileError = "";
    startArtEdit();
    void loadArtifacts();
  });
}

function confirmDeleteArt(name: string): void {
  const m = modal!;
  openActionDialog({
    title: "Delete artifact",
    loc: name,
    body: `<p class="pa-note">Deletes <strong>${esc(name)}</strong> from this task's Artifacts. Workers won't see it anymore.</p>`,
    confirmLabel: "Delete",
    danger: true,
    onConfirm: async () => {
      await postJSON("/api/jarvis/artifact/delete", { id: m.taskId, name });
      if (modal !== m) return;
      toast(`Deleted ${name}`, "ok");
      backToList();
      // The dialog hands focus back to the trash button, which is gone; put it in the list instead.
      window.setTimeout(() => {
        if (modal === m && !m.dialog.contains(document.activeElement)) {
          (m.artsEl.querySelector<HTMLElement>("[data-act='art-new']") || m.dialog).focus();
        }
      }, 0);
    },
  });
}

function renderTabs(task: TodayTask): void {
  const m = modal!;
  const done = task.status === "done";
  const tabs = task.workers
    .map((w) => {
      const s = workerState(shown(w));
      const selected = w.sessionId === m.sessionId;
      return `<button type="button" class="tm-tab tone-${WORKER_TONE[s]}" role="tab" aria-selected="${selected}" data-key="t:${esc(w.sessionId)}" data-tab="${esc(w.sessionId)}" title="${esc(w.cwd)}">
          <span class="wdot"></span><span class="wname">${esc(w.label)}</span><span class="wstate">${esc(WORKER_LABEL[s])}</span>
        </button>`;
    })
    .join("");
  patchHtml(
    m.tabs,
    `${tabs}${
      done
        ? ""
        : `<button type="button" class="icon-btn tm-tab-add" data-act="start-worker" title="Start a worker on this task" aria-label="Start a worker on this task">${svg("add")}</button>`
    }`
  );
  m.tabs.hidden = !task.workers.length;
}

function workerPickerState(w: TodayWorker): PickerState {
  return {
    model: w.model || "",
    effort: w.effort || "",
    currentModel: w.currentModel ?? null,
    currentEffort: w.currentEffort ?? null,
    catalog: modelCatalog(),
    busy: w.busy,
    switching: !!modal?.switching,
    who: w.label,
  };
}

function renderChatHead(task: TodayTask, w: TodayWorker | undefined, now: number): void {
  const m = modal!;
  if (!w) {
    m.chatHead.innerHTML = "";
    m.chatHead.hidden = true;
    return;
  }
  m.chatHead.hidden = false;
  const s = workerState(w);
  const doing = s === "working" && w.activity ? ` · ${w.activity}` : "";
  const opening = new Set(["vscode", "vscode-insiders"].filter((ide) => m.openingIde.has(`${w.sessionId}:${ide}`)));
  const changes = task.folder && w.cwd
    ? `title="See what ${esc(w.label)} changed, in its own window"`
    : `disabled title="${esc(w.label)} has no folder of its own yet"`;
  patchHtml(
    m.chatHead,
    `
    <span class="chat-folder" data-key="folder" title="${esc(w.cwd)}">${svg("folder")}<span>${esc(shortPath(w.cwd))}</span></span>
    <span class="chat-state tone-${WORKER_TONE[s]}" data-key="state">${esc(WORKER_LABEL[s] + doing)} · ${esc(agoPhrase(w.updatedAt, now))}</span>
    <span class="chat-actions" data-key="actions">
      ${w.busy ? `<button type="button" class="btn sm ghost" data-act="stop">${svg("stop")}<span>Stop</span></button>` : ""}
      <button type="button" class="icon-btn" data-act="remove-worker" title="Remove ${esc(w.label)}" aria-label="Remove ${esc(w.label)}">${svg("trash")}</button>
    </span>
    <div class="tm-ide-actions" data-key="ide-actions:${esc(w.sessionId)}" role="group" aria-label="Open ${esc(w.label)}'s workspace">
      <button type="button" class="btn sm ghost" data-act="view-changes" ${changes}>${svg("diff")}<span>View changes</span></button>
      ${idePickerHtml({ id: "tm-open-in", action: "open-workspace", workspace: w.cwd, opening })}
    </div>`
  );
}

/** The worker's model and effort, over the composer. */
function renderPicker(w: TodayWorker | undefined): void {
  const m = modal!;
  m.pane.tools.hidden = !w;
  if (!w) {
    m.pane.tools.innerHTML = "";
    return;
  }
  patchHtml(m.pane.tools, modelPickerHtml(workerPickerState(w)));
}

/** The model or effort picked in the chat head: the worker switches now, or when its turn ends. */
function onWorkerPick(e: Event): void {
  const m = modal;
  const select = (e.target as HTMLElement).closest<HTMLSelectElement>("select[data-model-pick]");
  const w = currentWorker();
  if (!m || !select || !w || m.switching) return;
  const now = workerPickerState(w);
  const choice = select.dataset.modelPick === "model" ? nextChoice(now, select.value) : { model: now.model, effort: select.value };
  if (choice.model === now.model && choice.effort === now.effort) return;
  const sessionId = w.sessionId;
  m.switching = true;
  render();
  void postJSON("/api/jarvis/workers/model", { sessionId, model: choice.model, effort: choice.effort })
    .then((res: { model: string; effort: string; deferred: boolean }) => {
      const label = res.model ? `${res.model}${res.effort ? ` (${effortLabel(res.effort).toLowerCase()} effort)` : ""}` : "the Copilot default";
      toast(
        res.deferred
          ? `${w.label} switches to ${label} when this turn ends`
          : res.model
            ? `${w.label} now uses ${label}`
            : `${w.label} uses the Copilot default from its next session`,
        "ok"
      );
    })
    .catch((err: Error) => toast(`Could not change ${w.label}'s model: ${err.message}`, "err"))
    .finally(async () => {
      if (modal !== m) return;
      m.switching = false;
      // Repaint even if nothing changed, so a refused choice goes back to what's set.
      delete m.sigs.picker;
      await m.host.refresh();
      if (modal === m) render();
    });
}

/** The last three folders of a path; the full path is in the tooltip. */
function shortPath(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.length > 4 ? "…\\" + parts.slice(-3).join("\\") : path;
}

// ---- the conversation ---------------------------------------------------------------

function workerSig(w: TodayWorker): string {
  return `${w.busy}|${w.state}|${w.updatedAt}`;
}

/** Read the worker's transcript when it is new to the modal or a turn just ended. */
function syncLog(w: TodayWorker): void {
  const m = modal!;
  const log = m.logs.get(w.sessionId);
  if (log && (log.loading || w.busy || log.sig === workerSig(w))) return;
  if (log?.error && log.sig === workerSig(w)) return;
  void loadLog(w);
}

async function loadLog(w: TodayWorker): Promise<void> {
  const m = modal!;
  const prev = m.logs.get(w.sessionId);
  const token = ++logToken;
  const sig = workerSig(w);
  const askedAt = Date.now();
  m.logs.set(w.sessionId, { messages: prev?.messages || [], loading: true, error: "", sig, token });
  renderLog(currentTask()!, currentWorker());
  try {
    const res: { messages: ChatMessage[] } = await getJSON("/api/jarvis/workers/log?sessionId=" + encodeURIComponent(w.sessionId));
    if (modal !== m || m.logs.get(w.sessionId)?.token !== token) return;
    const messages = res.messages || [];
    m.logs.set(w.sessionId, { messages, loading: false, error: "", sig, token });
    // What the turn showed live is in the transcript now; anything newer stays until the next read.
    m.seen.set(w.sessionId, settleSeen(m.seen.get(w.sessionId) || [], messages, askedAt));
    const pending = m.pending.get(w.sessionId);
    if (pending && !pendingShown(messages, pending)) m.pending.delete(w.sessionId);
    void loadCommands(w.sessionId);
  } catch (e) {
    if (modal !== m || m.logs.get(w.sessionId)?.token !== token) return;
    m.logs.set(w.sessionId, { messages: prev?.messages || [], loading: false, error: (e as Error).message, sig, token });
  }
  render();
}

function loadCommands(sessionId: string, force = false): Promise<void> {
  const m = modal!;
  const known = m.commands.get(sessionId);
  if (known?.loading) return known.loading;
  if (known?.list && !force) return Promise.resolve();
  const entry: Commands = { list: known?.list || null, loading: null, error: "" };
  entry.loading = getJSON("/api/jarvis/workers/commands?sessionId=" + encodeURIComponent(sessionId))
    .then((res: { commands: ChatCommand[] }) => {
      entry.list = res.commands || [];
      entry.error = "";
    })
    .catch((e: Error) => {
      entry.error = e.message;
    })
    .finally(() => {
      entry.loading = null;
      if (modal === m && m.sessionId === sessionId) refreshPopup();
    });
  m.commands.set(sessionId, entry);
  return entry.loading;
}

function renderLog(task: TodayTask, w: TodayWorker | undefined): void {
  const m = modal!;
  if (!w) {
    region("log", JSON.stringify(["none", task.status]), () =>
      paintChatLog(m.log, {
        items: [],
        empty:
          task.status === "done"
            ? emptyHtml("No workers", "Reopen the task to start one.")
            : emptyHtml(
                "No worker on this task yet",
                "A worker is a Copilot session in a repo folder with your skills and setup. Chat with it here, and type <code>/</code> for commands and skills.",
                `<button type="button" class="btn sm accent" data-act="start-worker">${svg("play")}<span>Start a worker</span></button>`
              ),
      })
    );
    return;
  }
  const log = m.logs.get(w.sessionId);
  const notes = notesBySession.get(w.sessionId) || [];
  // The transcript, plus what the turn in flight has added (read live).
  const messages = withTurn(log?.messages || [], m.seen.get(w.sessionId) || []);
  // The conversation has the message the user sent: it shows there, not as sent.
  if (m.pending.has(w.sessionId) && !pendingShown(messages, m.pending.get(w.sessionId)!)) m.pending.delete(w.sessionId);
  const pending = m.pending.get(w.sessionId) || null;
  const showPending = !!pending;
  const s = workerState(w);
  const spec: ChatLogSpec = {
    items: chatItems(messages, notes),
    loading: !!log?.loading && !messages.length,
    notice: log?.error
      ? errorOutHtml(
          `<p>Couldn't load the conversation: ${esc(log.error)}</p><button type="button" class="btn sm ghost" data-act="log-retry">Retry</button>`
        )
      : "",
    sending: showPending && pending ? pending.text : null,
    sendingImages: showPending ? pending?.images : undefined,
    sendingAccepted: !!pending?.accepted,
    steered: w.steered || [],
    busy: w.busy,
    partial: w.partial,
    thinking: activityLine(w.activity),
    trailer:
      s === "error" && w.summary
        ? errorOutHtml(`<p>${esc(w.label)} failed: ${esc(w.summary)}</p>${mutedHtml("Send a message to try again.")}`)
        : s === "stopped"
          ? mutedHtml("Stopped. Send a message to continue.")
          : "",
    queued: w.queue || [],
    queueHeld: !!w.queueHeld,
    canSteer: !!w.canSteer,
    empty: mutedHtml("No messages yet."),
  };
  region("log", `${w.sessionId}|${chatLogSig(spec)}`, () => paintChatLog(m.log, spec));
}

function renderRequests(w: TodayWorker | undefined): void {
  const m = modal!;
  patchHtml(
    m.requests,
    w?.requests.length
      ? `<div data-key="s:${esc(w.sessionId)}" data-session="${esc(w.sessionId)}">${w.requests.map((r) => requestCardHtml(w.label, r, answerDrafts.get(`ans:${r.id}`) || "")).join("")}</div>`
      : ""
  );
  m.requests.hidden = !w?.requests.length;
}

function renderComposer(task: TodayTask, w: TodayWorker | undefined): void {
  const m = modal!;
  const done = task.status === "done";
  setComposer(m.pane, {
    placeholder: done
      ? "Reopen the task to message its workers"
      : !w
        ? "Start a worker to chat"
        : w.busy
          ? `Queue a message for ${w.label}, or send it now…`
          : `Message ${w.label}… Type / for commands and skills`,
    disabled: !w || done,
    busy: m.sending,
    working: !!w?.busy,
    canSteer: !!w?.canSteer,
  });
  renderHint(w);
}

function renderHint(w: TodayWorker | undefined): void {
  const m = modal!;
  if (m.hintError) return setHint(m.pane, m.hintError, true);
  const images = m.sessionId ? trayNote(imageDrafts.get(m.sessionId)?.items || []) : null;
  if (images) return setHint(m.pane, images);
  const list = m.sessionId ? m.commands.get(m.sessionId)?.list : null;
  const typed = list ? resolveCommand(list, m.input.value) : null;
  if (typed) {
    const c = typed.command;
    return setHint(m.pane, `/${c.name}${c.hint ? ` ${c.hint}` : ""}${c.description ? ` · ${c.description}` : ""}`);
  }
  setHint(
    m.pane,
    w?.requests.length
      ? `${w.label} is waiting on you. Answer above, or Enter to queue a message.`
      : w?.busy
        ? "Enter queues it for after this turn · Ctrl+Enter sends it now · /usage and other commands still run"
        : "Enter to send · Shift+Enter for a new line · / for commands and skills"
  );
}

// ---- the "/" list -------------------------------------------------------------------

function refreshPopup(): void {
  const m = modal;
  if (!m || !m.sessionId || m.input.disabled || document.activeElement !== m.input) return hidePopup();
  const text = m.input.value;
  const query = slashQuery(text);
  const entry = m.commands.get(m.sessionId);
  if (query !== null) {
    if (!entry?.list) {
      if (!entry?.loading && !entry?.error) void loadCommands(m.sessionId);
      return showPopupMessage(entry?.error ? `Couldn't load commands: ${entry.error}` : "Loading commands and skills…", !!entry?.error);
    }
    const items = matchCommands(entry.list, query);
    const prev = m.popup?.mode === "commands" ? m.popup.items[m.popup.index]?.name : undefined;
    const index = Math.max(0, items.findIndex((c) => c.name === prev));
    m.popup = items.length ? { mode: "commands", items, index } : null;
    return items.length ? paintPopup() : showPopupMessage(`No command or skill matches /${query}.`, false);
  }
  // "/name partial": the command's own choices, like /mcp show.
  const choice = /^\/([\w.:-]+) ([\w.:-]*)$/.exec(text.trimStart());
  const command = choice && entry?.list ? resolveCommand(entry.list, `/${choice[1]}`)?.command : undefined;
  if (command?.choices.length) {
    const typed = choice![2].toLowerCase();
    const items = command.choices.filter((c) => c.name.toLowerCase().startsWith(typed));
    if (items.length && !(items.length === 1 && items[0].name.toLowerCase() === typed)) {
      m.popup = { mode: "choices", command, items, index: 0 };
      return paintPopup();
    }
  }
  hidePopup();
}

function showPopupMessage(text: string, error: boolean): void {
  const m = modal!;
  m.popup = null;
  m.popupEl.innerHTML = `<p class="chat-pop-msg${error ? " err" : ""}">${esc(text)}</p>`;
  m.popupEl.hidden = false;
  announce(text);
}

function hidePopup(): void {
  const m = modal;
  if (!m) return;
  m.popup = null;
  m.popupEl.hidden = true;
  m.popupEl.innerHTML = "";
  m.sr.textContent = "";
}

/** The highlighted item for screen readers; the list itself can't take focus from the box. */
function announce(text: string): void {
  const m = modal!;
  if (m.sr.textContent !== text) m.sr.textContent = text;
}

function paintPopup(): void {
  const m = modal!;
  const p = m.popup;
  if (!p) return hidePopup();
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
      html += `<div class="chat-pop-item${i === p.index ? " active" : ""}" role="option" id="tm-opt-${i}" aria-selected="${i === p.index}" data-pick="${i}">
          <span class="chat-pop-name">/${esc(c.name)}</span>${hint ? `<span class="chat-pop-hint">${esc(hint)}</span>` : ""}
          <span class="chat-pop-desc">${esc(c.description)}</span>
        </div>`;
    });
  } else {
    html += `<p class="chat-pop-group">/${esc(p.command.name)}</p>`;
    p.items.forEach((c, i) => {
      html += `<div class="chat-pop-item${i === p.index ? " active" : ""}" role="option" id="tm-opt-${i}" aria-selected="${i === p.index}" data-pick="${i}">
          <span class="chat-pop-name">${esc(c.name)}</span><span class="chat-pop-desc">${esc(c.description)}</span>
        </div>`;
    });
  }
  m.popupEl.innerHTML = html;
  m.popupEl.hidden = false;
  const item = p.items[p.index];
  const label = p.mode === "commands" ? `/${item.name}` : item.name;
  announce(`${label}${item.description ? `, ${item.description}` : ""}. ${p.index + 1} of ${p.items.length}.`);
  m.popupEl.querySelector<HTMLElement>(".chat-pop-item.active")?.scrollIntoView({ block: "nearest" });
}

/** Put the picked item in the box. Returns true when it is complete enough to send. */
function pick(index: number): boolean {
  const m = modal!;
  const p = m.popup;
  if (!p) return false;
  if (p.mode === "commands") {
    const c = p.items[index];
    if (!c) return false;
    m.input.value = `/${c.name} `;
    hidePopup();
    autoSize(m.input);
    renderHint(currentWorker());
    if (c.choices.length) refreshPopup();
    return !c.hint && !c.required && !c.choices.length;
  }
  const choice = p.items[index];
  if (!choice) return false;
  m.input.value = `/${p.command.name} ${choice.name}`;
  hidePopup();
  autoSize(m.input);
  renderHint(currentWorker());
  return true;
}

// ---- sending ------------------------------------------------------------------------

function addNote(sessionId: string, note: ChatNote): void {
  const list = [...(notesBySession.get(sessionId) || []), note].slice(-NOTES_KEPT);
  notesBySession.set(sessionId, list);
}

function errorNote(command: string, text: string): ChatNote {
  return { id: `n${++noteSeq}`, at: nowIso(), kind: "error", command, text, markdown: false, url: null, choiceCommand: "", options: [] };
}

/**
 * Send what's typed (or `textOverride`). While the worker works, a message is queued for
 * after its turn, or with "now" (Ctrl+Enter, Send now) steered into it; commands run as before.
 */
async function submit(textOverride?: string, how: "send" | "now" = "send"): Promise<void> {
  const m = modal;
  const task = currentTask();
  const w = currentWorker();
  if (!m || !task || !w || m.sending) return;
  const typed = textOverride === undefined;
  const raw = typed ? m.input.value : textOverride;
  // Images go with what's typed in the box, not with a chip or a picked command.
  const draft = typed ? (imageDrafts.get(w.sessionId) ?? null) : null;
  let intent = composerIntent(raw);
  if (intent.kind === "empty" && !draft?.ready.length) return;
  if (task.status === "done") return;
  if (intent.kind === "command" && draft?.items.length) {
    m.hintError = "Commands can't carry images. Remove them, or send them with a message.";
    renderHint(w);
    return;
  }
  if (draft?.uploading) return toast("An image is still uploading. Send once it's in.", "err");
  if (intent.kind === "empty") intent = { kind: "message", text: "" };
  const mode = intent.kind === "message" && w.busy ? (how === "now" ? "now" : "queue") : undefined;
  if (mode === "now" && w.requests.length) {
    m.hintError = `${w.label} is waiting on you. Answer above first, or Enter to queue it.`;
    renderHint(w);
    return;
  }
  const sessionId = w.sessionId;
  const taken = intent.kind === "message" ? draft?.take() || [] : [];
  const images: ChatImage[] = taken.map((d) => ({ id: d.id!, name: d.name }));
  m.sending = true;
  m.hintError = "";
  hidePopup();
  if (typed) {
    m.input.value = "";
    draftsBySession.delete(sessionId);
    autoSize(m.input);
  }
  try {
    if (intent.kind === "message") {
      // A queued message shows in the queue, and one sent now as sent mid-turn, once Today reloads.
      const withImages = images.length ? { images } : {};
      if (!mode) m.pending.set(sessionId, { text: intent.text, at: Date.now(), accepted: false, ...withImages });
      render();
      const res: { result?: string } = await postJSON("/api/jarvis/workers/message", { sessionId, text: intent.text, ...(mode ? { mode } : {}), ...withImages });
      draft?.release(taken);
      // Sent: it reads as sent, and the turn it started is followed from here. (The turn may also
      // have ended on the way, so a queued or steered message became a new turn.)
      if (res.result === "sent") {
        const had = m.pending.get(sessionId);
        m.pending.set(sessionId, { text: intent.text, at: had?.at ?? Date.now(), accepted: true, ...withImages });
      }
      if (mode === "now" && res.result === "queued") toast(`${w.label} was starting its turn, so this is queued to run after it.`, "ok");
      if (res.result === "queued" || res.result === "steered") announce(res.result === "queued" ? "Queued for after this turn" : "Sent into this turn");
    } else {
      render();
      const res: { outcome: CommandOutcome } = await postJSON("/api/jarvis/workers/command", { sessionId, text: intent.text });
      if (res.outcome.kind === "sent") m.pending.set(sessionId, { text: res.outcome.display, at: Date.now(), accepted: true });
      const note = noteFromOutcome(res.outcome, intent.text, `n${++noteSeq}`, nowIso());
      if (note) addNote(sessionId, note);
      // A model switch shows in the header once Today reloads.
    }
  } catch (e) {
    m.pending.delete(sessionId);
    draft?.restore(taken);
    addNote(sessionId, errorNote(intent.kind === "command" ? intent.text : "Message not sent", (e as Error).message));
    if (typed && modal === m && m.sessionId === sessionId && !m.input.value) {
      m.input.value = raw.trim();
      autoSize(m.input);
    }
  } finally {
    if (modal === m) {
      m.sending = false;
      render();
    }
  }
  await m.host.refresh();
}

// ---- actions ------------------------------------------------------------------------

async function withButton(button: HTMLElement | null, run: () => Promise<unknown>): Promise<void> {
  const m = modal;
  // Disabling the focused button drops focus to the page; it comes back afterwards.
  const key = m && button && button === document.activeElement ? focusKey(button) : null;
  if (button instanceof HTMLButtonElement) button.disabled = true;
  try {
    await run();
  } catch (e) {
    toast((e as Error).message, "err");
  } finally {
    if (button instanceof HTMLButtonElement) button.disabled = false;
    if (key && modal === m) {
      const active = document.activeElement;
      if (!active || active === document.body || !m!.dialog.contains(active)) restoreFocus(key);
    }
  }
}

function confirmRemoveWorker(w: TodayWorker): void {
  const m = modal!;
  const task = currentTask();
  const ownFolder = !!task?.folder;
  const dialog = openActionDialog({
    title: "Remove worker",
    loc: w.label,
    body: ownFolder
      ? `<p class="pa-note">Stops <strong>${esc(w.label)}</strong>, deletes its Copilot session, and deletes its folder <code>${esc(w.cwd)}</code> with its worktrees and their local branches. Branches it already pushed stay in Azure DevOps.</p><p class="pa-note jt-changes" hidden></p>`
      : `<p class="pa-note">Stops <strong>${esc(w.label)}</strong> and deletes its Copilot session. Files it changed in <code>${esc(w.cwd)}</code> stay as they are.</p>`,
    confirmLabel: "Remove",
    danger: true,
    onConfirm: async () => {
      await postJSON("/api/jarvis/workers/remove", { sessionId: w.sessionId });
      notesBySession.delete(w.sessionId);
      draftsBySession.delete(w.sessionId);
      if (modal === m) {
        m.logs.delete(w.sessionId);
        m.commands.delete(w.sessionId);
        m.pending.delete(w.sessionId);
        m.seen.delete(w.sessionId);
        if (m.sessionId === w.sessionId) {
          m.sessionId = null;
          m.input.value = "";
          selectedByTask.delete(m.taskId);
        }
      }
      await m.host.refresh();
    },
  });
  if (ownFolder) void warnUnsaved(dialog, `sessionId=${encodeURIComponent(w.sessionId)}`);
}

function onClick(e: MouseEvent): void {
  const m = modal;
  const task = currentTask();
  if (!m || !task) return;
  const target = e.target as HTMLElement;
  if (target.closest("a[href]")) return;
  const pickNode = target.closest<HTMLElement>("[data-pick]");
  if (pickNode) {
    e.preventDefault();
    if (pick(Number(pickNode.dataset.pick))) void submit();
    m.input.focus();
    return;
  }
  const tab = target.closest<HTMLElement>("[data-tab]");
  if (tab) return selectWorker(tab.dataset.tab || "");
  const ltab = target.closest<HTMLElement>("[data-ltab]");
  if (ltab) return selectLeftTab(ltab.dataset.ltab as LeftTab);
  const run = target.closest<HTMLElement>("[data-run]");
  if (run) return void submit(run.dataset.run || "");
  const w = currentWorker();
  // The worker's queue: send a message now, or take it out.
  const queued = m.log.contains(target) ? target.closest<HTMLElement>("[data-queue-send], [data-queue-remove]") : null;
  if (queued && w) {
    const sending = queued.dataset.queueSend !== undefined;
    void withButton(queued, async () => {
      await postJSON(sending ? "/api/jarvis/workers/queue/send" : "/api/jarvis/workers/queue/remove", {
        sessionId: w.sessionId,
        id: sending ? queued.dataset.queueSend : queued.dataset.queueRemove,
      });
      await m.host.refresh();
    });
    return;
  }
  const decision = target.closest<HTMLElement>("[data-decide]");
  if (decision && w) {
    const requestId = decision.closest<HTMLElement>("[data-request]")?.dataset.request;
    if (requestId) {
      void withButton(decision, async () => {
        await postJSON("/api/jarvis/workers/decide", { sessionId: w.sessionId, requestId, decision: decision.dataset.decide });
        await m.host.refresh();
      });
    }
    return;
  }
  const choice = target.closest<HTMLElement>("[data-choice]");
  if (choice && w) {
    const requestId = choice.closest<HTMLElement>("[data-request]")?.dataset.request;
    if (requestId) {
      void withButton(choice, async () => {
        await postJSON("/api/jarvis/workers/message", { sessionId: w.sessionId, requestId, text: choice.dataset.choice });
        await m.host.refresh();
      });
    }
    return;
  }
  const reposButton = target.closest<HTMLElement>("[data-repos]");
  if (reposButton && w) {
    const requestId = reposButton.closest<HTMLElement>("[data-request]")?.dataset.request;
    const repos = reposFromCard(reposButton);
    if (!requestId || !repos) return;
    if (reposButton.dataset.repos === "confirm" && !repos.length) return void toast("Check at least one repository, or choose None.", "err");
    void withButton(reposButton, async () => {
      await postJSON("/api/jarvis/workers/repos", { sessionId: w.sessionId, requestId, repos });
      await m.host.refresh();
    });
    return;
  }
  const node = target.closest<HTMLElement>("[data-act]");
  if (!node) return;
  switch (node.dataset.act) {
    case "close":
      return closeTaskModal();
    case "done":
    case "reopen":
      return void withButton(node, async () => {
        await postJSON("/api/jarvis/tasks/update", { id: task.id, status: node.dataset.act === "done" ? "done" : "open" });
        await m.host.refresh();
      });
    case "delete-task":
      return m.host.deleteTask(task);
    case "start-worker":
      return m.host.startWorker(task);
    case "view-changes":
      if (w && task.folder) window.open(`/code.html?worker=${encodeURIComponent(w.sessionId)}`, `code-${w.sessionId}`);
      return;
    case "open-workspace": {
      if (!w) return;
      const ide = node.dataset.ide;
      const key = `${w.sessionId}:${ide}`;
      if (m.openingIde.has(key)) return;
      return void withButton(node, async () => {
        m.openingIde.add(key);
        render();
        try {
          await postJSON("/api/jarvis/workers/ide", { sessionId: w.sessionId, ide });
          toast(`Opened ${w.label}'s workspace in ${ide === "vscode-insiders" ? "VSCode Insiders" : "VSCode"}.`, "ok");
        } finally {
          m.openingIde.delete(key);
          if (modal === m) render();
        }
      });
    }
    case "stop":
      return void (w && withButton(node, async () => {
        await postJSON("/api/jarvis/workers/stop", { sessionId: w.sessionId });
        await m.host.refresh();
      }));
    case "remove-worker":
      return void (w && confirmRemoveWorker(w));
    case "log-retry":
      return void (w && loadLog(w));
    case "art-open":
      return openArtifact(node.dataset.name || "");
    case "art-back":
      return backToList();
    case "art-edit":
      return startArtEdit();
    case "art-cancel":
      return cancelArtEdit();
    case "art-save":
      return void saveArt(node);
    case "art-new":
      return startNewArt();
    case "art-new-cancel":
      return cancelNewArt();
    case "art-delete":
      return void (m.arts.open && confirmDeleteArt(m.arts.file?.name || m.arts.open));
    case "art-recap":
      return void withButton(node, async () => {
        await postJSON("/api/jarvis/recap", { id: task.id });
        await m.host.refresh();
      });
    case "status-older": {
      const oldest = m.timeline.items?.[m.timeline.items.length - 1]?.id;
      return void (oldest && withButton(node, () => loadTimeline(oldest)));
    }
    case "pr-open": {
      const p = prOfNode(node);
      return void (p && openPrInApp(p, node));
    }
    case "pr-unlink": {
      const p = prOfNode(node);
      return void (p && unlinkPr(p, node));
    }
    case "pr-link":
      return showLinkForm(true);
    case "pr-link-cancel":
      return showLinkForm(false);
    case "pr-refresh":
      return void withButton(node, () => loadDevops(true));
    case "pr-finished":
      m.devops.showFinished = !m.devops.showFinished;
      return paintDevops(Date.now());
  }
}

function onSubmit(e: SubmitEvent): void {
  const m = modal;
  e.preventDefault();
  if (!m) return;
  const form = e.target as HTMLFormElement;
  if (form === m.form) return void submit();
  if (form.dataset.form === "art-new") return void createArt(form);
  if (form.dataset.form === "pr-link") return void linkPr();
  if (form.dataset.form === "status") {
    const text = m.statusInput.value.trim();
    if (!text) return;
    void withButton(form.querySelector("button[type=submit]"), async () => {
      await postJSON("/api/jarvis/status", { taskId: m.taskId, text });
      m.statusInput.value = "";
      await m.host.refresh();
    });
    return;
  }
  if (form.dataset.form === "answer") {
    const w = currentWorker();
    const area = form.querySelector<HTMLTextAreaElement>("textarea");
    const requestId = form.closest<HTMLElement>("[data-request]")?.dataset.request;
    const text = area?.value.trim() || "";
    if (!w || !area || !requestId || !text) return;
    void withButton(form.querySelector("button[type=submit]"), async () => {
      await postJSON("/api/jarvis/workers/message", { sessionId: w.sessionId, text, requestId });
      answerDrafts.delete(`ans:${requestId}`);
      await m.host.refresh();
    });
  }
}

function onInput(e: Event): void {
  const m = modal;
  if (!m) return;
  const field = e.target as HTMLElement;
  if (field === m.input) {
    if (m.sessionId) draftsBySession.set(m.sessionId, m.input.value);
    m.hintError = "";
    autoSize(m.input);
    refreshPopup();
    renderHint(currentWorker());
    return;
  }
  if (field instanceof HTMLTextAreaElement && field.dataset.draft) {
    answerDrafts.set(field.dataset.draft, field.value);
    autoSize(field);
  }
}

function onKeydown(e: KeyboardEvent): void {
  const m = modal;
  if (!m) return;
  const target = e.target as HTMLElement;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    if (closeIdePicker(m.dialog, true)) return;
    if (m.popup || !m.popupEl.hidden) return hidePopup();
    if (m.arts.mode === "edit" && m.artsEl.contains(target)) return cancelArtEdit();
    if (m.arts.mode === "new" && m.artsEl.contains(target)) return cancelNewArt();
    if (!m.dvLink.hidden && m.dvLink.contains(target)) return showLinkForm(false);
    if (m.validation?.escape(target)) return;
    return closeTaskModal();
  }
  if (target.closest("[data-ltab]") && onLeftTabKey(e)) return;
  if (e.key === "Tab" && !(target === m.input && m.popup)) return trapFocus(e);
  if (target === m.input) {
    const p = m.popup;
    if (p && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      p.index = (p.index + (e.key === "ArrowDown" ? 1 : -1) + p.items.length) % p.items.length;
      return paintPopup();
    }
    if (p && e.key === "Tab") {
      e.preventDefault();
      pick(p.index);
      return;
    }
    const key = composerKey(e);
    if (key) {
      e.preventDefault();
      if (p) {
        if (pick(p.index)) void submit();
        return;
      }
      return void submit(undefined, key === "steer" ? "now" : "send");
    }
    return;
  }
  // Enter sends in the answer boxes too; Shift+Enter adds a line.
  if (target.tagName === "TEXTAREA" && e.key === "Enter" && !e.shiftKey && !e.isComposing && target.closest("form[data-form='answer']")) {
    e.preventDefault();
    target.closest("form")!.requestSubmit();
  }
}

/**
 * Keys that land outside the sheet while it's on top (focus fell to the page):
 * Escape still closes it and Tab brings focus back in. A dialog opened over the
 * sheet handles its own keys.
 */
function onDocumentKey(e: KeyboardEvent): void {
  const m = modal;
  if (!m || m.dialog.contains(e.target as Node)) return;
  const overlays = document.querySelectorAll(".ask-overlay");
  if (overlays[overlays.length - 1] !== m.overlay) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    if (closeIdePicker(m.dialog, true)) return;
    closeTaskModal();
  } else if (e.key === "Tab") {
    e.preventDefault();
    m.dialog.focus();
  }
}

function trapFocus(e: KeyboardEvent): void {
  const m = modal!;
  const focusable = [...m.dialog.querySelectorAll<HTMLElement>("button, input, textarea, a[href], [tabindex='0']")].filter(
    (node) => !(node as HTMLButtonElement).disabled && node.offsetParent !== null
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
