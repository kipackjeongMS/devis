// The Workspace: three panes side by side, each folding to a slim rail.
//   Devis  — the Lead console, one persistent Copilot session that watches the
//            Workspace and keeps its history.
//   Today  — the user's day: Today so far, Needs you, their own to-dos and a
//            quick note. The to-dos and note belong to no day; Devis and the
//            workers can read them when asked.
//   Tasks  — the board: pull request reviews, running and open tasks, done today.
//            Each task hosts the Copilot workers doing it. Its other tabs:
//            Communication (email and Teams chats) and Meetings (recaps by day).
import { getJSON, postJSON, type ApiError } from "./api.js";
import { el } from "./dom.js";
import { esc } from "./util.js";
import { icon, type IconName } from "./icons.js";
import {
  autoSize,
  chatPaneHtml,
  chatPaneRefs,
  composerKey,
  emptyHtml,
  modelPickerHtml,
  mutedHtml,
  paintChatLog,
  setComposer,
  setHint,
  type ChatLogSpec,
  type ChatPane,
} from "./chatPane.js";
import { loadModelCatalog, modelCatalog } from "./modelCatalog.js";
import { ImageDraft, paintTray, sameImages, trayNote, uploadWith, wireImages, type ChatImage } from "./chatImages.js";
import { effortLabel, effortsFor, nextChoice, type PickerState } from "./modelChoice.js";
import { patchHtml } from "./patch.js";
import { toast } from "./toast.js";
import { state } from "./state.js";
import { reviewPhase } from "./list.js";
import { openDetail } from "./detail.js";
import { openActionDialog } from "./prActions.js";
import { sendPrsToCopilot } from "./bridge.js";
import { requestNotifyPermission } from "./notifyWatch.js";
import { closeTaskModal, openTaskModal, pruneTaskModalState, reposFromCard, requestCardHtml, updateTaskModal, warnUnsaved, type LeftTab, type TaskModalHost } from "./jarvisTask.js";
import { initViewZoom, zoomable } from "./viewZoom.js";
import { meetingsHtml, meetingsSig, meetingsSub, pruneMeetingsState, toggleDay, toggleMeeting, toggleNote, type MeetingsView } from "./meetingsView.js";
import { communicationHtml, communicationSig, communicationSub, pruneCommunicationState, revealConversation, toggleChat, toggleChatDay, toggleQuietMail, type CommunicationView } from "./communicationView.js";
import { isOutlookLink, isTeamsLink, unseenRecaps, type ChatsInfo, type CommsChat, type CommsMail, type CommsMeeting, type MeetingScanInfo } from "./commsModel.js";
import {
  ALL_SERVICES,
  REVIEW_PREVIEW,
  SECTIONS,
  WORKER_LABEL,
  WORKER_TONE,
  activityLine,
  ago,
  agoPhrase,
  askerWhere,
  askersLine,
  askFor,
  askPr,
  cardPrs,
  copilotReviewControl,
  dayStart,
  groupTasks,
  inService,
  needsItems,
  needTodo,
  commsNeedTitle,
  commsNeedWhere,
  commsNeedWho,
  type CommsNeed,
  serviceKey,
  taskNeeds,
  visibleNeeds,
  needLine,
  reconcileNote,
  narrativeLines,
  overviewFreshness,
  overviewSummary,
  prChipText,
  prCommentsChip,
  prBuildsChip,
  reviewQueue,
  serviceOptions,
  taskFolderPreview,
  taskMeta,
  todayFingerprint,
  todayHasTasks,
  todaySummary,
  validationChip,
  workerState,
  type BoardSection,
  type CommsAsk,
  type JarvisEvent,
  type NarrativePart,
  type NeedItem,
  type QuickNote,
  type SectionId,
  type Todo,
  type TodayData,
  type TodayTask,
  type TodayWorker,
  type WorkerRequest,
} from "./jarvisModel.js";
import type { PR } from "./types.js";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  images?: ChatImage[];
}

interface LeadChat {
  sessionId: string | null;
  messages: ChatMessage[];
  pending: boolean;
  partial: string;
  activity: string;
  error: string | null;
  /** The last turn was stopped by the user. */
  stopped?: boolean;
  /** The chosen model, or "" for the Copilot default. */
  model: string;
  /** The effort chosen with it, or "" for its default. */
  effort?: string;
  /** What the session is running now, when there is one. */
  currentModel: string | null;
  currentEffort?: string | null;
  /** Messages sent while a turn ran, waiting their turn. */
  queue?: Array<{ id: string; text: string; images?: ChatImage[] }>;
  queueHeld?: boolean;
  /** A message sent now goes into the running turn. */
  canSteer?: boolean;
  /** The session is still resuming after a launch; these are the messages as last read. */
  resuming?: boolean;
}

export interface JarvisHooks {
  openSettings: () => void;
}

type Pane = "lead" | "today" | "tasks";
const PANES: readonly Pane[] = ["lead", "today", "tasks"];
const PANE_NAME: Record<Pane, string> = { lead: "Devis", today: "Today", tasks: "Tasks" };
/** Widths for an open pane that isn't the last open one; the last takes what's left. */
const PANE_WIDTH: Record<Pane, string> = {
  lead: "clamp(320px, 26vw, 440px)",
  today: "clamp(300px, 28vw, 460px)",
  tasks: "minmax(0, 1fr)",
};
const isPane = (value: unknown): value is Pane => PANES.includes(value as Pane);

/** The two-pane layout before the Workspace: "both", "lead" (Today folded) or "today" (Lead folded). */
const LAYOUT_KEY = "adoPrOps.jarvis.layout";
const FOLD_KEY = "adoPrOps.workspace.folded";
const SERVICE_KEY = "adoPrOps.jarvis.service";
const OVERVIEW_KEY = "adoPrOps.jarvis.overviewCollapsed";
const DONE_TODOS_KEY = "adoPrOps.workspace.showDoneTodos";
/** Which tab the Tasks pane shows: Tasks, Communication or Meetings. */
const PANE_TAB_KEY = "adoPrOps.workspace.paneTab";
/** When the user last looked at the Meetings tab: recaps after it make its badge. */
const MEETINGS_SEEN_KEY = "adoPrOps.workspace.meetingsSeen";
/** When the user last looked at the Communication tab: important chats that moved after it make its badge. */
const COMMUNICATION_SEEN_KEY = "adoPrOps.workspace.communicationSeen";
/** The quick note's unsaved edit, kept until it saves. */
const NOTE_DRAFT_KEY = "adoPrOps.workspace.noteDraft";
const FAST_MS = 1500;
const MID_MS = 4000;
const SLOW_MS = 8000;
const LEAD_MS = 1000;
/** While Devis answers: reads close together, so its reply flows in rather than landing in lumps. */
const LEAD_LIVE_MS = 400;
const NOTE_SAVE_MS = 700;
const NOTE_RETRY_MS = 5000;
const NOTE_MAX_CHARS = 50_000;
const narrowQuery = window.matchMedia("(max-width: 900px)");

let hooks: JarvisHooks = { openSettings: () => {} };
let root: HTMLElement | null = null;
let visible = false;
let data: TodayData | null = null;
let loadError = "";
let prsLoaded = false;
let todayTimer = 0;
let todayToken = 0;
/** When the Today data in hand was asked for. */
let todayAskedAt = 0;
let lead: LeadChat | null = null;
let leadSent = "";
/** The images sent with leadSent. */
let leadSentImages: ChatImage[] = [];
/** Images waiting to go with the next message to Devis. */
let leadDraft: ImageDraft | null = null;
const uploadImage = uploadWith((path, body) => postJSON(path, body));
/** Something sent to Devis is on its way or starting its turn. */
const leadSending = (): boolean => !!leadSent || leadSentImages.length > 0;
let leadNote = "";
let modelNote = "";
let modelSwitching = false;
let modelSig = "";
let leadSig = "";
let leadTimer = 0;
let leadToken = 0;
let service = readPref(SERVICE_KEY, ALL_SERVICES);
let showAllReviews = false;
/** PRs whose Copilot review request is on its way to the queue. */
const queuing = new Set<string>();
const prKey = (pr: PR): string => JSON.stringify([pr.org, pr.project, pr.repoId, String(pr.id)]);
const drafts = new Map<string, string>();
/** Tasks whose status timeline is open. */
const timelines = new Set<string>();
let overviewCollapsed = readPref(OVERVIEW_KEY, "0") === "1";
let overviewRefreshing = false;
let folded = readFolded();

// The to-dos come with every Today poll. A poll that was on its way while a to-do
// changed carries the list from before, so it's ignored: `todoRev` moves on each change.
let todoRev = 0;
let todoEditing: number | null = null;
let showDoneTodos = readPref(DONE_TODOS_KEY, "0") === "1";

// The quick note: the saved copy, the user's unsaved edit and the saved copy it
// started from. A save names that version; if the note moved on meanwhile (Devis
// added to it), the save is refused and the edit is merged, never dropped.
let note: QuickNote | null = null;
let noteDraft: string | null = null;
let noteBase: QuickNote | null = null;
let noteSaving = false;
let noteLoading = false;
let noteTimer = 0;
let noteStashTimer = 0;
let noteRetryMs = NOTE_RETRY_MS;
let noteError = "";
let noteMerged = "";
/** The note as saved elsewhere, when it changed in a way that can't be merged. */
let noteConflict: QuickNote | null = null;
/** Saves this page sent, by id, with their text (the latest 20). */
const ownSaves = new Map<string, string>();
/** The save on its way now, as [id, text]. */
let noteSending: [string, string] | null = null;

let leadPane: ChatPane;
/** The Lead's run state in the chat head, beside its model picker. */
let leadState: HTMLElement;
/** Where the model and effort picker is patched in. */
let leadPicker: HTMLElement;
let leadStop: HTMLButtonElement;
/** A message or queue action is on its way to the Lead. */
let leadPosting = false;
let dayBody: HTMLElement;
let daySub: HTMLElement;
let tasksBody: HTMLElement;
let tasksSub: HTMLElement;
let serviceSelect: HTMLSelectElement;
let statusLine: HTMLElement;
let daySig = "";
let tasksSig = "";

// The Tasks pane's other tabs: Communication (Teams chats' summaries, communicationView.ts; email
// to come) and Meetings (meetings and their recaps, meetingsView.ts).
type PaneTab = "tasks" | "comms" | "meetings";
const PANE_TABS: PaneTab[] = ["tasks", "comms", "meetings"];
const asPaneTab = (value: string | undefined): PaneTab => (PANE_TABS.includes(value as PaneTab) ? (value as PaneTab) : "tasks");
let paneTab: PaneTab = asPaneTab(readPref(PANE_TAB_KEY, "tasks"));
const meetingsView: MeetingsView = { meetings: null, status: null, error: "", scanning: false };
/** The meetings' version the list in hand was read at; the Today poll says when it moved on. */
let meetingsVersion: string | null = null;
let meetingsLoading: Promise<void> | null = null;
let meetingsBody: HTMLElement;
let meetingsSubEl: HTMLElement;
let meetingsBadge: HTMLElement;
let meetingsRendered = "";
const commsView: CommunicationView = { chats: null, status: null, mail: null, mailStatus: null, error: "", scanning: false };
let chatsVersion: string | null = null;
let mailVersion: string | null = null;
let mailLoading: Promise<void> | null = null;
let chatsLoading: Promise<void> | null = null;
let commsBody: HTMLElement;
let commsSubEl: HTMLElement;
let commsBadge: HTMLElement;
let commsRendered = "";

function readPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

/** Which panes are folded to rails; the two-pane setting carries over the first time. */
function readFolded(): Set<Pane> {
  const saved = readPref(FOLD_KEY, "");
  if (saved) {
    try {
      const list = JSON.parse(saved);
      if (Array.isArray(list)) return new Set(list.filter(isPane));
    } catch {
      /* unreadable: carry over below */
    }
  }
  const old = readPref(LAYOUT_KEY, "both");
  return new Set<Pane>(old === "today" ? ["lead"] : old === "lead" ? ["today", "tasks"] : []);
}

const svg = (name: IconName): string => icon(name);

// ---- public API ---------------------------------------------------------------------

export function showJarvis(h: JarvisHooks): void {
  hooks = h;
  if (!root) mount();
  visible = true;
  void loadToday();
  void loadLead();
  if (!note) void loadNote();
  if (paneTab === "meetings") void loadMeetings();
  if (paneTab === "comms") loadCommunication();
}

export function hideJarvis(): void {
  visible = false;
  clearTimeout(todayTimer);
  clearTimeout(leadTimer);
  closeTaskModal();
  void flushNote();
}

/** A task to open once Today has loaded (asked for from another tab, like a task's chain in Pipelines). */
let pendingTask: { taskId: string; tab?: LeftTab } | null = null;

export function openTaskById(taskId: string, tab?: LeftTab): void {
  pendingTask = { taskId, tab };
  if (data) openPendingTask();
}

function openPendingTask(): void {
  const p = pendingTask;
  if (!p || !data || !visible) return;
  pendingTask = null;
  if (data.tasks.some((t) => t.id === p.taskId)) openTaskModal(p.taskId, modalHost, p.tab);
  else toast("That task isn't on the board anymore: it was done before today, or removed.", "err");
}

// Closing the window mid-edit: the service outlives the window, so a keepalive request still lands.
// The stash covers the rest: a pending conflict, or a reload onto a restarted service.
window.addEventListener("pagehide", () => {
  if (noteDraft === null) return;
  // Write, never clear, on the way out: a page with no edit of its own mustn't wipe one an earlier page left.
  // The stash names this last save, so the next page can tell whether it landed.
  const saveId = newSaveId();
  stashNote([saveId, noteDraft]);
  if (noteConflict) return;
  void fetch("/api/jarvis/note", {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: noteDraft, base: noteBase?.version ?? note?.version ?? 0, saveId }),
  }).catch(() => {});
});

/** What the task modal needs from Today: its data, a reload, and the dialogs it reuses. */
const modalHost: TaskModalHost = {
  task: (id) => data?.tasks.find((t) => t.id === id),
  todayAt: () => todayAskedAt,
  refresh: () => loadToday(),
  startWorker: (task) => openStartWorker(task),
  deleteTask: (task) => confirmDeleteTask(task),
  openPr: async ({ org, project, repoId, prId }) => {
    const sameOrg = (a: string) => a.toLowerCase() === org.toLowerCase();
    // Tasks keep the org lowercased; reviews are keyed by the spelling in Settings.
    const spelled = [...(data?.organizations || []), ...(state.config.organizations || [])].find(sameOrg) || org;
    let pr = state.prs.find((p) => sameOrg(p.org) && p.id === prId);
    if (!pr) {
      const res = await getJSON(
        `/api/pr-summary?org=${encodeURIComponent(spelled)}&project=${encodeURIComponent(project)}&repoId=${encodeURIComponent(repoId)}&prId=${prId}`
      );
      pr = res.pr as PR;
    }
    closeTaskModal();
    await openDetail(pr);
  },
};

/** Refresh: work items from ADO, then Today. */
export async function reloadJarvis(): Promise<void> {
  if (!root) return;
  try {
    const res = await postJSON("/api/jarvis/refresh", {});
    if (res.errors?.length) toast("Some work items did not refresh: " + res.errors[0], "err");
  } catch (e) {
    toast("Could not refresh work items: " + (e as Error).message, "err");
  }
  await loadToday();
}

// The PR list loads on its own schedule; Today repaints when it lands.
window.addEventListener("ado-prs-loaded", () => {
  prsLoaded = true;
  if (visible) renderToday(true);
});
window.addEventListener("ado-pr-updated", () => {
  if (visible) renderToday(true);
});

// ---- mount --------------------------------------------------------------------------

function mount(): void {
  root = document.getElementById("jarvisView")!;
  const fold = (pane: Pane): string =>
    `<button type="button" class="icon-btn pane-fold" data-act="pane-fold" data-pane="${pane}" title="Fold ${PANE_NAME[pane]}" aria-label="Fold ${PANE_NAME[pane]}">${svg("panel")}</button>`;
  const rail = (pane: Pane, iconName: IconName): string =>
    `<button type="button" class="jarvis-rail" data-act="pane-open" data-pane="${pane}" data-rail="${pane}" title="Show ${PANE_NAME[pane]}" aria-label="Show ${PANE_NAME[pane]}" hidden>
      ${svg(iconName)}<span>${PANE_NAME[pane]}</span>
    </button>`;
  root.innerHTML = `
    <aside class="lead-pane" data-pane-el="lead" aria-label="Devis, the Lead">
      <header class="lead-head">
        <div class="lead-heading">
          <h1 class="lead-title">${svg("sparkle")}<span>Devis</span></h1>
          <p class="lead-sub">Lead · watches the Workspace and keeps its history</p>
        </div>
        <div class="lead-tools">
          <button type="button" class="icon-btn" data-act="lead-new" title="New Lead session" aria-label="New Lead session">${svg("add")}</button>
          <button type="button" class="icon-btn" data-act="lead-terminal" title="Open the Lead in a terminal" aria-label="Open the Lead in a terminal">${svg("terminal")}</button>
          ${fold("lead")}
        </div>
      </header>
      ${chatPaneHtml({
        id: "lead",
        inputLabel: "Message Devis",
        headHtml: `<span class="chat-state tone-idle" hidden></span>
          <span class="chat-actions"><button type="button" class="btn sm ghost" data-act="lead-stop" hidden>${svg("stop")}<span>Stop</span></button></span>`,
      })}
    </aside>
    ${rail("lead", "sparkle")}
    <section class="today-pane day-pane" data-pane-el="today" aria-label="Today">
      <header class="today-head">
        <div class="today-heading">
          <h1 class="today-title">Today</h1>
          <p class="today-sub day-sub"></p>
        </div>
        <div class="today-tools">${fold("today")}</div>
      </header>
      <div class="today-body day-body" tabindex="-1"></div>
    </section>
    ${rail("today", "calendar")}
    <section class="today-pane tasks-pane" data-pane-el="tasks" data-tab="${paneTab}" aria-label="Tasks">
      <header class="today-head">
        <div class="today-heading">
          <div class="pane-tabs" role="tablist" aria-label="Tasks, communication or meetings">
            <button type="button" class="pane-tab" role="tab" id="pane-tab-tasks" data-ptab="tasks" aria-controls="pane-panel-tasks">Tasks</button>
            <button type="button" class="pane-tab" role="tab" id="pane-tab-comms" data-ptab="comms" aria-controls="pane-panel-comms">Communication<span class="pane-tab-badge" hidden></span></button>
            <button type="button" class="pane-tab" role="tab" id="pane-tab-meetings" data-ptab="meetings" aria-controls="pane-panel-meetings">Meetings<span class="pane-tab-badge" hidden></span></button>
          </div>
          <p class="today-sub tasks-sub"></p>
          <p class="today-sub comms-sub"></p>
          <p class="today-sub meetings-sub"></p>
        </div>
        <div class="today-tools">
          <span class="tab-tools" data-for="tasks">
            <select class="filter-select today-service" aria-label="Service"></select>
            <button type="button" class="btn sm ghost" data-act="history" title="History" aria-label="History">${svg("clock")}<span>History</span></button>
            <button type="button" class="btn sm accent" data-act="new-task" title="New task" aria-label="New task">${svg("add")}<span>Task</span></button>
          </span>
          <span class="tab-tools" data-for="comms">
            <button type="button" class="icon-btn" data-act="comms-scan" title="Read Teams and email now" aria-label="Read Teams and email now">${svg("sync")}</button>
          </span>
          <span class="tab-tools" data-for="meetings">
            <button type="button" class="icon-btn" data-act="meetings-scan" title="Read the calendar now" aria-label="Read the calendar now">${svg("sync")}</button>
          </span>
          ${fold("tasks")}
        </div>
      </header>
      <div class="today-body tasks-body" id="pane-panel-tasks" role="tabpanel" aria-labelledby="pane-tab-tasks" tabindex="-1"></div>
      <div class="today-body comms-body" id="pane-panel-comms" role="tabpanel" aria-labelledby="pane-tab-comms" tabindex="-1"></div>
      <div class="today-body meetings-body" id="pane-panel-meetings" role="tabpanel" aria-labelledby="pane-tab-meetings" tabindex="-1"></div>
      <footer class="today-status"><span class="today-status-dot"></span><span class="today-status-text"></span></footer>
    </section>
    ${rail("tasks", "checklist")}`;

  const q = <T extends Element>(sel: string): T => root!.querySelector<T>(sel)!;
  leadPane = chatPaneRefs(root);
  leadDraft = new ImageDraft(uploadImage, () => {
    paintTray(leadPane.tray, leadDraft, patchHtml);
    leadSig = "";
    renderLead();
  });
  wireImages(leadPane, { draft: () => leadDraft, refused: (problems) => toast(problems.join(" "), "err") });
  leadState = q(".chat-state");
  leadPicker = leadPane.tools;
  leadStop = q('[data-act="lead-stop"]');
  leadPane.tools.addEventListener("change", onLeadPick);
  leadPane.steer.addEventListener("click", () => void sendToLead(leadPane.input.value, "now"));
  void loadModelCatalog().then(() => renderLeadPicker());
  dayBody = q(".day-body");
  daySub = q(".day-sub");
  tasksBody = q(".tasks-body");
  tasksSub = q(".tasks-sub");
  serviceSelect = q(".today-service");
  statusLine = q(".today-status-text");
  commsBody = q(".comms-body");
  commsSubEl = q(".comms-sub");
  meetingsBody = q(".meetings-body");
  meetingsSubEl = q(".meetings-sub");
  meetingsBadge = q('.pane-tab[data-ptab="meetings"] .pane-tab-badge');
  commsBadge = q('.pane-tab[data-ptab="comms"] .pane-tab-badge');
  applyPaneTab();
  // Ctrl +/−/0 zoom the pane you're in; each keeps its level.
  for (const pane of PANES) zoomable(q<HTMLElement>(`[data-pane-el="${pane}"]`), pane);
  initViewZoom();
  applyLayout();
  narrowQuery.addEventListener("change", () => applyLayout());

  root.addEventListener("click", onClick);
  root.addEventListener("dblclick", onDblClick);
  root.addEventListener("submit", onSubmit);
  root.addEventListener("input", onInput);
  root.addEventListener("keydown", onKeydown);
  root.addEventListener("focusout", onFocusOut);
  serviceSelect.addEventListener("change", () => {
    service = serviceSelect.value;
    writePref(SERVICE_KEY, service);
    renderToday(true);
  });
}

/**
 * Lay the panes out from which are folded. Folded panes become 40px rails; open
 * ones keep their width, and the last open one takes the rest. Narrow windows
 * stack them instead. One pane always stays open.
 */
function applyLayout(): void {
  if (!root) return;
  if (PANES.every((p) => folded.has(p))) folded.delete("tasks");
  const open = PANES.filter((p) => !folded.has(p));
  const fill = open[open.length - 1];
  const narrow = narrowQuery.matches;
  const tracks = PANES.map((p) =>
    folded.has(p) ? (narrow ? "38px" : "40px") : narrow ? (p === "lead" ? "minmax(0, 2fr)" : "minmax(0, 3fr)") : p === fill ? "minmax(0, 1fr)" : PANE_WIDTH[p]
  );
  root.style.gridTemplateColumns = narrow ? "minmax(0, 1fr)" : tracks.join(" ");
  root.style.gridTemplateRows = narrow ? tracks.join(" ") : "minmax(0, 1fr)";
  root.classList.toggle("is-narrow", narrow);
  for (const p of PANES) {
    root.querySelector<HTMLElement>(`[data-pane-el="${p}"]`)!.hidden = folded.has(p);
    root.querySelector<HTMLElement>(`[data-rail="${p}"]`)!.hidden = !folded.has(p);
  }
  // Folding the only open pane would leave nothing to fold back from.
  for (const button of root.querySelectorAll<HTMLButtonElement>(".pane-fold")) button.disabled = open.length === 1;
  writePref(FOLD_KEY, JSON.stringify([...folded]));
  // Needs you sits in Today, or at the top of Tasks while Today is folded.
  renderToday(true);
}

function setFolded(pane: Pane, fold: boolean): void {
  if (fold === folded.has(pane)) return;
  if (fold) folded.add(pane);
  else folded.delete(pane);
  applyLayout();
  if (fold) root!.querySelector<HTMLElement>(`[data-rail="${pane}"]`)?.focus();
  else if (pane === "lead") leadPane.input.focus();
  else (pane === "today" ? dayBody : tasksBody).focus({ preventScroll: true });
}

// ---- the Lead -----------------------------------------------------------------------

async function loadLead(): Promise<void> {
  clearTimeout(leadTimer);
  if (!visible) return;
  // Only the latest load schedules the next one, so two can't run as parallel loops.
  const token = ++leadToken;
  try {
    const next = await getJSON("/api/jarvis/lead");
    if (token !== leadToken) return;
    lead = next;
  } catch (e) {
    if (token !== leadToken) return;
    leadNote = "Could not reach Devis: " + (e as Error).message;
    renderLead();
    // Mid-reply, keep trying so the console does not freeze on one failed poll.
    if (lead?.pending || leadSending()) leadTimer = window.setTimeout(() => void loadLead(), LEAD_MS * 3);
    return;
  }
  leadNote = "";
  if (!lead!.pending) {
    leadSent = "";
    leadSentImages = [];
  }
  renderLead();
  if (lead!.pending) leadTimer = window.setTimeout(() => void loadLead(), LEAD_LIVE_MS);
  // Shown from the last read while the session resumes; read again until it's live.
  else if (lead!.resuming) leadTimer = window.setTimeout(() => void loadLead(), LEAD_MS * 2);
}

const LEAD_STARTERS = ["What needs me today?", "Recap yesterday for my standup", "Which workers finished a turn?"];

function renderLead(): void {
  const chat = lead;
  const sig = JSON.stringify([
    chat?.messages.map((m) => `${m.id}:${m.content.length}:${m.images?.length || 0}`),
    chat?.pending,
    chat?.partial,
    chat?.activity,
    chat?.error,
    chat?.stopped,
    chat?.resuming,
    chat?.queue?.map((m) => m.id),
    chat?.queueHeld,
    chat?.canSteer,
    leadSent,
    leadSentImages.map((i) => i.id),
    leadDraft?.items.map((d) => d.state),
    leadNote,
    modelNote,
    leadPosting,
  ]);
  if (sig === leadSig) return renderLeadPicker();
  leadSig = sig;
  const messages = chat?.messages || [];
  const last = messages[messages.length - 1];
  // A turn is running (or the one just sent is starting): what's sent now is queued, or steered in.
  const working = !!chat?.pending || leadSending();
  // What was just sent shows until the transcript has it: the same words and images.
  const shownSent = leadSending() && !(last?.role === "user" && last.content === leadSent && sameImages(last.images, leadSentImages));
  const spec: ChatLogSpec = {
    items: messages.map((message) => ({ type: "message", message })),
    sending: shownSent ? leadSent : null,
    sendingImages: shownSent ? leadSentImages : undefined,
    sendingAccepted: !leadPosting,
    busy: working,
    partial: chat?.partial,
    thinking: activityLine(chat?.activity || ""),
    trailer: chat?.stopped ? mutedHtml("Stopped. Send a message to continue.") : "",
    queued: chat?.queue || [],
    queueHeld: !!chat?.queueHeld,
    canSteer: !!chat?.canSteer,
    empty: emptyHtml(
      "Ask Devis",
      "I watch your Workspace and keep its history: tasks, the workers on them, the pull requests waiting for you, and your to-dos and quick note when you ask.",
      `<div class="chat-starters">${LEAD_STARTERS.map((s) => `<button type="button" class="chip-btn" data-starter="${esc(s)}">${esc(s)}</button>`).join("")}</div>`
    ),
  };
  paintChatLog(leadPane.log, spec);
  setComposer(leadPane, {
    placeholder: working ? "Queue a message for after this turn, or send it now…" : "Ask or direct Devis…",
    disabled: false,
    busy: leadPosting,
    working,
    canSteer: !!chat?.canSteer,
  });
  const error = leadNote || (chat?.error && !working ? "Devis did not reply: " + chat.error : "");
  const note = error || modelNote;
  setHint(
    leadPane,
    note || trayNote(leadDraft?.items || []) || (working ? "Enter queues it for after this turn · Ctrl+Enter sends it now" : "Enter to send · Shift+Enter for a new line"),
    !!error
  );
  // The hint isn't a live region; a failure or a model switch is announced here.
  if (leadPane.sr.textContent !== note) leadPane.sr.textContent = note;
  const live = chat?.resuming ? "Resuming" : chat?.pending ? `Working${chat.activity ? ` · ${chat.activity}` : ""}` : "Idle";
  leadState.hidden = !chat;
  leadState.className = `chat-state tone-${chat?.resuming || chat?.pending ? "run" : "idle"}`;
  if (leadState.textContent !== live) leadState.textContent = live;
  leadStop.hidden = !chat?.pending;
  renderLeadPicker();
}

function leadPickerState(): PickerState {
  return {
    model: lead?.model ?? "",
    effort: lead?.effort ?? "",
    currentModel: lead?.currentModel ?? null,
    currentEffort: lead?.currentEffort ?? null,
    catalog: modelCatalog(),
    busy: !!lead?.pending,
    switching: modelSwitching,
    disabled: !lead,
    who: "Devis",
  };
}

/** The model and effort picker over the composer: Copilot default, then every model the user's Copilot can run. */
function renderLeadPicker(): void {
  if (!leadPicker) return;
  const html = modelPickerHtml(leadPickerState());
  if (html === modelSig) return;
  modelSig = html;
  patchHtml(leadPicker, html);
  leadPicker.hidden = false;
}

function onLeadPick(e: Event): void {
  const select = (e.target as HTMLElement).closest<HTMLSelectElement>("select[data-model-pick]");
  if (!select || !lead) return;
  const now = leadPickerState();
  const choice = select.dataset.modelPick === "model" ? nextChoice(now, select.value) : { model: now.model, effort: select.value };
  void changeModel(choice.model, choice.effort);
}

const modelLabel = (model: string, effort: string): string => `${model}${effort ? ` (${effortLabel(effort).toLowerCase()} effort)` : ""}`;

async function changeModel(model: string, effort: string): Promise<void> {
  if (model === (lead?.model ?? "") && effort === (lead?.effort ?? "")) return;
  modelSwitching = true;
  modelNote = model ? `Switching Devis to ${modelLabel(model, effort)}…` : "";
  leadSig = "";
  renderLead();
  try {
    const res: { model: string; effort: string; currentModel: string | null; currentEffort: string | null; deferred: boolean } = await postJSON(
      "/api/jarvis/lead/model",
      { model, effort }
    );
    if (lead) Object.assign(lead, { model: res.model, effort: res.effort, currentModel: res.currentModel, currentEffort: res.currentEffort });
    if (res.model && res.deferred) toast(`Devis switches to ${modelLabel(res.model, res.effort)} when this answer ends`, "ok");
    else if (res.model) toast(`Devis now uses ${modelLabel(res.model, res.effort)}`, "ok");
    else if (res.currentModel) {
      toast(`New Lead sessions use the Copilot default. This conversation stays on ${res.currentModel} until you start a new session.`, "ok");
    } else toast("Devis will use the Copilot default", "ok");
  } catch (e) {
    toast("Could not change the model: " + (e as Error).message, "err");
  } finally {
    modelSwitching = false;
    modelNote = "";
    // Repaint even if nothing changed, so a refused choice goes back to what's set.
    modelSig = "";
    leadSig = "";
    renderLead();
  }
}

/**
 * Send what's typed. While Devis answers, it's queued for after the turn, or with "now"
 * (Ctrl+Enter, Send now) steered into it.
 */
async function sendToLead(text: string, how: "send" | "now" = "send"): Promise<void> {
  const message = text.trim();
  if (leadPosting || (!message && !leadDraft?.ready.length)) return;
  if (leadDraft?.uploading) return toast("An image is still uploading. Send once it's in.", "err");
  const taken = leadDraft?.take() || [];
  const images: ChatImage[] = taken.map((d) => ({ id: d.id!, name: d.name }));
  const working = !!lead?.pending || leadSending();
  const mode = working ? (how === "now" ? "now" : "queue") : undefined;
  leadPosting = true;
  if (!working) {
    leadSent = message;
    leadSentImages = images;
  }
  leadPane.input.value = "";
  autoSize(leadPane.input);
  renderLead();
  try {
    const res: { result?: string } = await postJSON("/api/jarvis/lead", { text: message, ...(mode ? { mode } : {}), ...(images.length ? { images } : {}) });
    // The turn ended on the way: it started as a new one.
    if (res.result === "sent") {
      leadSent = message;
      leadSentImages = images;
    }
    leadDraft?.release(taken);
    leadNote = "";
    if (mode === "now" && res.result === "queued") toast("Devis was starting its turn, so this is queued to run after it.", "ok");
    if (res.result === "steered" && leadPane.sr.textContent !== "Sent into this turn") leadPane.sr.textContent = "Sent into this turn";
  } catch (e) {
    if (!working) {
      leadSent = "";
      leadSentImages = [];
    }
    if (!leadPane.input.value) {
      leadPane.input.value = message;
      autoSize(leadPane.input);
    }
    leadDraft?.restore(taken);
    leadNote = "Could not send: " + (e as Error).message;
  } finally {
    leadPosting = false;
    leadSig = "";
    renderLead();
  }
  void loadLead();
}

async function leadQueueAct(button: HTMLElement, path: string, id: string): Promise<void> {
  await act(button, () => postJSON(path, { id }));
  void loadLead();
}

// ---- Today: data --------------------------------------------------------------------

async function loadToday(): Promise<void> {
  clearTimeout(todayTimer);
  if (!visible) return;
  const token = ++todayToken;
  const rev = todoRev;
  const askedAt = Date.now();
  try {
    const since = new Date(dayStart(Date.now())).toISOString();
    const next: TodayData = await getJSON("/api/jarvis/today?since=" + encodeURIComponent(since));
    if (token !== todayToken) return;
    if (rev !== todoRev && data) next.todos = data.todos;
    data = next;
    todayAskedAt = askedAt;
    loadError = "";
    pruneTodayState(next);
    // The poll says only which version the note is at; read it when that moves on.
    const version = next.note?.version;
    if (version !== undefined && (!note || version !== note.version)) void loadNote();
    // Likewise the meetings, while their tab shows.
    const meetingsAt = next.comms?.meetings?.version;
    if (paneTab === "meetings" && meetingsAt !== undefined && meetingsAt !== meetingsVersion) void loadMeetings();
    const chatsAt = next.comms?.chats?.version;
    if (paneTab === "comms" && chatsAt !== undefined && chatsAt !== chatsVersion) void loadChats();
    const mailAt = next.comms?.mail?.version;
    if (paneTab === "comms" && mailAt !== undefined && mailAt !== mailVersion) void loadMail();
  } catch (e) {
    if (token !== todayToken) return;
    loadError = (e as Error).message;
  }
  renderToday();
  updateTaskModal();
  openPendingTask();
  const live = !!data?.tasks.some((t) => t.workers.some((w) => w.busy || w.requests.length));
  const updating = data?.overview?.phase === "updating";
  if (visible) todayTimer = window.setTimeout(() => void loadToday(), live ? FAST_MS : updating ? MID_MS : SLOW_MS);
}

function scopedPrs(): PR[] {
  return reviewQueue(state.prs, reviewPhase).filter((pr) => inService(pr, service));
}

/**
 * Drop per-task and per-request state for what's no longer on Today: drafts,
 * open timelines, and the task modal's chat notes and choices. The page runs
 * for days; without this, every task and question ever seen stays in memory.
 */
function pruneTodayState(today: TodayData): void {
  const taskIds = new Set(today.tasks.map((t) => t.id));
  const sessionIds = new Set(today.tasks.flatMap((t) => t.workers.map((w) => w.sessionId)));
  const requestIds = new Set(today.tasks.flatMap((t) => t.workers.flatMap((w) => w.requests.map((r) => r.id))));
  const todoIds = new Set((today.todos || []).map((t) => String(t.id)));
  for (const id of [...timelines]) if (!taskIds.has(id)) timelines.delete(id);
  for (const key of [...drafts.keys()]) {
    const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    if ((kind === "st" && !taskIds.has(id)) || (kind === "ans" && !requestIds.has(id))) drafts.delete(key);
    if (kind === "todo" && id !== "new" && !todoIds.has(id)) drafts.delete(key);
  }
  if (todoEditing !== null && !todoIds.has(String(todoEditing))) todoEditing = null;
  pruneTaskModalState(taskIds, sessionIds, requestIds);
}

function reviewedInService(events: JarvisEvent[]): JarvisEvent[] {
  return events.filter((e) => service === ALL_SERVICES || `${e.ref?.org}/${e.ref?.project}` === service);
}

// ---- Today: render ------------------------------------------------------------------

/** Repaint both panes; each skips itself when nothing it shows changed. */
function renderToday(force = false): void {
  if (!root) return;
  renderTasks(force);
  renderDay(force);
  renderComms(force);
}

// ---- the Tasks pane's tabs: Tasks and Communication ---------------------------------

/** Show the tab chosen: its tools, sub line and body; the other's hide. */
function applyPaneTab(): void {
  const pane = root!.querySelector<HTMLElement>('[data-pane-el="tasks"]')!;
  pane.dataset.tab = paneTab;
  for (const tab of pane.querySelectorAll<HTMLButtonElement>(".pane-tab")) {
    const on = tab.dataset.ptab === paneTab;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  for (const tools of pane.querySelectorAll<HTMLElement>(".tab-tools")) tools.hidden = tools.dataset.for !== paneTab;
  tasksBody.hidden = paneTab !== "tasks";
  tasksSub.hidden = paneTab !== "tasks";
  commsBody.hidden = paneTab !== "comms";
  commsSubEl.hidden = paneTab !== "comms";
  meetingsBody.hidden = paneTab !== "meetings";
  meetingsSubEl.hidden = paneTab !== "meetings";
  pane.querySelector<HTMLElement>(".today-status")!.hidden = paneTab !== "tasks";
}

function setPaneTab(tab: PaneTab, focus = false): void {
  if (tab !== paneTab) {
    paneTab = tab;
    writePref(PANE_TAB_KEY, tab);
    applyPaneTab();
  }
  if (tab === "meetings") {
    markMeetingsSeen();
    if (!meetingsView.meetings || meetingsVersion !== (data?.comms?.meetings?.version ?? meetingsVersion)) void loadMeetings();
  }
  if (tab === "comms") {
    writePref(COMMUNICATION_SEEN_KEY, String(Date.now()));
    loadCommunication();
  }
  renderToday(true);
  if (focus) root!.querySelector<HTMLElement>(`.pane-tab[data-ptab="${tab}"]`)?.focus();
}

const meetingsShown = (): boolean => visible && paneTab === "meetings" && !folded.has("tasks");
const commsShown = (): boolean => visible && paneTab === "comms" && !folded.has("tasks");

/** Read the chats' summaries, unless a read is under way. */
function loadChats(): Promise<void> {
  chatsLoading ??= (async () => {
    try {
      const res: { chats: CommsChat[]; digest: { version: string }; status: { enabled: boolean; last: ChatsInfo | null; readAt: string | null } } =
        await getJSON("/api/jarvis/comms/chats");
      commsView.chats = res.chats;
      commsView.status = res.status;
      commsView.error = "";
      chatsVersion = res.digest.version;
      pruneCommunicationState(res.chats, commsView.mail);
    } catch (e) {
      commsView.error = (e as Error).message;
    } finally {
      chatsLoading = null;
    }
    if (commsShown()) writePref(COMMUNICATION_SEEN_KEY, String(Date.now()));
    renderComms(true);
  })();
  return chatsLoading;
}

/** Read the email threads' summaries, unless a read is under way. */
function loadMail(): Promise<void> {
  mailLoading ??= (async () => {
    try {
      const res: { mail: CommsMail[]; digest: { version: string }; status: { enabled: boolean; last: ChatsInfo | null; readAt: string | null } } =
        await getJSON("/api/jarvis/comms/mail");
      commsView.mail = res.mail;
      commsView.mailStatus = res.status;
      commsView.error = "";
      mailVersion = res.digest.version;
      pruneCommunicationState(commsView.chats, res.mail);
    } catch (e) {
      commsView.error = (e as Error).message;
    } finally {
      mailLoading = null;
    }
    if (commsShown()) writePref(COMMUNICATION_SEEN_KEY, String(Date.now()));
    renderComms(true);
  })();
  return mailLoading;
}

/** Read the Communication tab's chats and email when they're not read yet, or moved on. */
function loadCommunication(): void {
  if (!commsView.chats || chatsVersion !== (data?.comms?.chats?.version ?? chatsVersion)) void loadChats();
  if (!commsView.mail || mailVersion !== (data?.comms?.mail?.version ?? mailVersion)) void loadMail();
}

/** The tab is in view: its recaps are seen, and the badge clears. */
function markMeetingsSeen(): void {
  writePref(MEETINGS_SEEN_KEY, String(Date.now()));
}

/** Read the meetings, unless a read is under way. */
function loadMeetings(): Promise<void> {
  meetingsLoading ??= (async () => {
    try {
      const res: { meetings: CommsMeeting[]; digest: { version: string }; status: { enabled: boolean; last: MeetingScanInfo | null } } =
        await getJSON("/api/jarvis/comms/meetings");
      meetingsView.meetings = res.meetings;
      meetingsView.status = res.status;
      meetingsView.error = "";
      meetingsVersion = res.digest.version;
      pruneMeetingsState(res.meetings);
    } catch (e) {
      meetingsView.error = (e as Error).message;
    } finally {
      meetingsLoading = null;
    }
    if (meetingsShown()) markMeetingsSeen();
    renderComms(true);
  })();
  return meetingsLoading;
}

/**
 * Repaint the Communication and Meetings tabs and the Meetings badge; a tab's body only while
 * it's showing.
 */
function renderComms(force = false): void {
  if (!root) return;
  const seen = Number(readPref(MEETINGS_SEEN_KEY, "0")) || dayStart(Date.now());
  const unseen = meetingsShown() ? 0 : unseenRecaps(data?.comms?.meetings?.ready, seen);
  meetingsBadge.hidden = !unseen;
  meetingsBadge.textContent = unseen ? String(unseen) : "";
  root.querySelector(".pane-tab[data-ptab='meetings']")!.setAttribute("aria-label", unseen ? `Meetings, ${unseen} new recap${unseen === 1 ? "" : "s"}` : "Meetings");
  // Communication: conversations and threads that need you, or matter, and moved since you last looked.
  const commsSeen = Number(readPref(COMMUNICATION_SEEN_KEY, "0")) || dayStart(Date.now());
  const flagged = commsShown() ? 0 : unseenRecaps(data?.comms?.chats?.flagged, commsSeen) + unseenRecaps(data?.comms?.mail?.flagged, commsSeen);
  commsBadge.hidden = !flagged;
  commsBadge.textContent = flagged ? String(flagged) : "";
  root.querySelector(".pane-tab[data-ptab='comms']")!.setAttribute("aria-label", flagged ? `Communication, ${flagged} to look at` : "Communication");
  const now = Date.now();
  if (paneTab === "comms") {
    commsSubEl.textContent = communicationSub(commsView, now);
    const sig = communicationSig(commsView, now);
    if (!force && sig === commsRendered) return;
    commsRendered = sig;
    patchPane(commsBody, communicationHtml(commsView, now));
    return;
  }
  if (paneTab !== "meetings") return;
  meetingsSubEl.textContent = meetingsSub(meetingsView, now);
  const sig = meetingsSig(meetingsView, data?.todos, now);
  if (!force && sig === meetingsRendered) return;
  meetingsRendered = sig;
  patchPane(meetingsBody, meetingsHtml(meetingsView, data?.todos, now));
}

/** Read Teams and email now, from the Communication tab's head: the chats and threads, and their summaries. */
async function scanChatsNow(button: HTMLElement): Promise<void> {
  if (commsView.scanning) return;
  commsView.scanning = true;
  if (button instanceof HTMLButtonElement) button.disabled = true;
  renderComms(true);
  try {
    await postJSON("/api/jarvis/comms/scan", {});
  } catch (e) {
    toast(`Couldn't read Teams and email: ${(e as Error).message}`, "err");
  } finally {
    commsView.scanning = false;
    if (button instanceof HTMLButtonElement) button.disabled = false;
  }
  await Promise.all([loadChats(), loadMail()]);
  void loadToday();
}

/** Read the calendar now, from the Meetings tab's head. */
async function scanMeetingsNow(button: HTMLElement): Promise<void> {
  if (meetingsView.scanning) return;
  meetingsView.scanning = true;
  if (button instanceof HTMLButtonElement) button.disabled = true;
  renderComms(true);
  try {
    await postJSON("/api/jarvis/comms/scan", {});
  } catch (e) {
    toast(`Couldn't read the calendar: ${(e as Error).message}`, "err");
  } finally {
    meetingsView.scanning = false;
    if (button instanceof HTMLButtonElement) button.disabled = false;
  }
  await loadMeetings();
  void loadToday();
}

/** Make a meeting's action item a to-do. */
async function meetingTodo(node: HTMLElement): Promise<void> {
  const id = node.closest<HTMLElement>("[data-meet]")?.dataset.meet;
  const index = Number(node.dataset.index);
  if (!id || !Number.isInteger(index)) return;
  if (node instanceof HTMLButtonElement) node.disabled = true;
  todoRev++;
  try {
    const res = await postJSON("/api/jarvis/comms/meetings/todo", { id, index });
    if (data && Array.isArray(res?.todos)) data.todos = res.todos;
    toast("Added to your to-dos", "ok");
  } catch (e) {
    toast((e as Error).message, "err");
    if (node instanceof HTMLButtonElement) node.disabled = false;
  } finally {
    todoRev++;
    renderToday(true);
  }
}

/**
 * Patch a pane's body, keeping focus and what the user is typing: polling must
 * not pull the user off an Allow button, out of an answer box, or out of the note.
 */
function patchPane(body: HTMLElement, html: string): void {
  const active = document.activeElement as HTMLElement | null;
  const activeKey = active && body.contains(active) ? focusKey(active) : null;
  const selection =
    active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null;
  // Patched, not replaced: unchanged cards keep their DOM, so a poll doesn't reflow the board
  // or drop hover and text selection. Focus stays on a kept control; the restore below covers the rest.
  patchHtml(body, html);
  for (const area of body.querySelectorAll<HTMLTextAreaElement>("textarea")) if (area.value) autoSize(area);
  if (!activeKey) return;
  const again = [...body.querySelectorAll<HTMLElement>('button, textarea, input, a[href], [role="button"][tabindex]')].find((node) => focusKey(node) === activeKey);
  if (!again) return;
  if (document.activeElement !== again) again.focus({ preventScroll: true });
  if (selection && (again instanceof HTMLTextAreaElement || again instanceof HTMLInputElement)) {
    again.setSelectionRange(selection[0], selection[1]);
  }
}

const loadingHtml = (what: string): string =>
  loadError
    ? `<div class="empty">Could not load ${what}: ${esc(loadError)}</div>`
    : `<div class="loading"><span class="spinner"></span> Loading ${what}…</div>`;
const staleNote = (): string => (loadError ? `<div class="today-note err">Showing the last update. ${esc(loadError)}</div>` : "");

function sectionHead(title: string, tone: string, count: number): string {
  return `<h2 class="today-group tone-${tone}"><span class="today-group-dot"></span>${esc(title)}<span class="count">${count}</span></h2>`;
}

/**
 * Needs you: everything waiting on the user, from every service, one compact item per ask:
 * the task, who asks, and the ask itself, answerable here. The tasks' cards stay on the board.
 */
function needsSection(items: NeedItem[], now: number): string {
  const section = SECTIONS[0];
  return `<section class="today-section" data-section="needs" data-key="sec:needs">${sectionHead(section.title, section.tone, items.length)}${
    items.length ? items.map((n) => needHtml(n, now)).join("") : `<p class="today-empty">${esc(section.empty)}</p>`
  }</section>`;
}

function needHtml(n: NeedItem, now: number): string {
  if (n.kind === "teams") return teamsNeedHtml(n, now);
  if (n.kind === "comms") return commsNeedHtml(n, now);
  const who = n.kind === "validation" || n.kind === "prComments" || n.kind === "prBuilds" ? n.who : n.worker.label;
  const session = n.kind === "validation" || n.kind === "prComments" || n.kind === "prBuilds" ? "" : ` data-session="${esc(n.worker.sessionId)}"`;
  const glyph = n.kind === "validation" ? "flow" : n.kind === "prComments" ? "pullRequest" : n.kind === "prBuilds" ? "pipeline" : "warning";
  const ask = (text: string, button: string): string =>
    `<div class="ask-card"><p class="ask-card-title">${svg(glyph)}<span>${esc(text)}</span></p><div class="ask-card-actions">${button}</div></div>`;
  const body =
    n.kind === "request"
      ? n.worker.requests.map((r) => requestCardHtml(n.worker.label, r, drafts.get(`ans:${r.id}`) || "")).join("")
      : n.kind === "failed"
        ? ask(n.worker.summary ? `Its turn failed: ${n.worker.summary}` : "Its turn failed.", `<button type="button" class="btn sm accent" data-act="open-task">Open the chat</button>`)
        : n.kind === "prComments"
          ? ask(n.text, `<button type="button" class="btn sm accent" data-act="task-comments">${n.pr.attention === "proposal" ? "Review the plan" : "See what happened"}</button>`)
          : n.kind === "prBuilds"
            ? ask(n.text, `<button type="button" class="btn sm accent" data-act="task-comments">${n.pr.attention === "proposal" ? "Review the plan" : "See what happened"}</button>`)
            : ask(
              n.text,
              `<button type="button" class="btn sm accent" data-act="task-validation">${n.task.validation?.attention === "proposal" ? "Review the proposal" : "See what failed"}</button>`
            );
  const age = n.at ? `<span class="need-age">${esc(ago(new Date(n.at).toISOString(), now))}</span>` : "";
  // Taken on as a to-do, it leaves Needs you; the to-do ticks itself once the ask is gone.
  const toTodo = `<button type="button" class="need-todo" data-act="need-todo" title="Move it to your to-dos" aria-label="Move to your to-dos: ${esc(n.task.title)}, ${esc(who)}">${svg("checklist")}<span>To-do</span></button>`;
  return `
    <article class="need" data-key="need:${esc(n.key)}" data-need="${esc(n.task.id)}" data-task="${esc(n.task.id)}" data-source="${esc(n.source)}"${session}>
      <div class="need-head">
        <span class="need-icon">${svg("warning")}</span>
        <button type="button" class="need-task" data-act="open-task" title="Open the task">${esc(n.task.title)}</button>
        <span class="need-who">${esc(who)}</span>
        <span class="need-end">${age}${toTodo}</span>
      </div>
      <div class="need-body">${body}</div>
    </article>`;
}

/**
 * A PR someone asked the user to review in Teams: the PR and who asked on one line, then what they
 * wrote and where, with the PR to open, the message in Teams, To-do and Dismiss.
 */
function teamsNeedHtml(n: Extract<NeedItem, { kind: "teams" }>, now: number): string {
  const a = n.ask;
  const latest = a.askers[0];
  const who = askersLine(a.askers);
  const pr = `PR ${a.prId}${a.title ? ` · ${a.title}` : ""}`;
  // The PR's title says what it's about; who asked, where and when are on the line under it.
  const title = a.title || `PR ${a.prId}`;
  const toTodo = `<button type="button" class="need-todo" data-act="need-todo" title="Move it to your to-dos" aria-label="Move to your to-dos: ${esc(pr)}, asked by ${esc(who)}">${svg("checklist")}<span>To-do</span></button>`;
  const dismiss = `<button type="button" class="icon-btn need-dismiss" data-act="need-dismiss" title="Dismiss" aria-label="Dismiss: ${esc(pr)}, asked by ${esc(who)}">${svg("dismiss")}</button>`;
  const asked = (x: CommsAsk["askers"][number]): string =>
    `<p class="ask-teams-line"><span class="ask-teams-who">${esc(x.name)}</span> ${esc(askerWhere(x))} · ${esc(agoPhrase(x.at, now))}</p>` +
    (x.snippet ? `<p class="ask-teams-quote">${esc(x.snippet)}</p>` : "");
  const others = a.askers.slice(1, 3).map(asked).join("");
  const more = a.askers.length > 3 ? `<p class="ask-teams-line">and ${a.askers.length - 3} more</p>` : "";
  const teams = latest?.link
    ? `<a class="btn sm" href="${esc(latest.link)}" target="_blank" rel="noopener" data-act="need-teams">${svg("chat")}<span>Open in Teams</span></a>`
    : "";
  return `
    <article class="need need-teams" data-key="need:${esc(n.key)}" data-ask="${a.id}" data-source="${esc(n.source)}">
      <div class="need-head">
        <span class="need-icon">${svg("chat")}</span>
        <button type="button" class="need-task" data-act="need-pr" title="Open ${esc(pr)}">${esc(title)}</button>
        <span class="need-end">${toTodo}${dismiss}</span>
      </div>
      <div class="need-body">
        <div class="ask-card ask-teams">
          ${latest ? asked(latest) : ""}${others}${more}
          <div class="ask-card-actions">
            <button type="button" class="btn sm accent" data-act="need-pr">${svg("pullRequest")}<span>Review PR</span></button>${teams}
          </div>
        </div>
      </div>
    </article>`;
}

/**
 * A chat or email thread someone waits on you in: what it is on one line (it opens in the
 * Communication tab), then who asked, where and when, and what they need, with the chat in Teams or
 * the email in Outlook, To-do and Dismiss.
 */
function commsNeedHtml(n: Extract<NeedItem, { kind: "comms" }>, now: number): string {
  const c = n.need;
  const mail = c.source === "mail";
  const who = commsNeedWho(c);
  const title = commsNeedTitle(c);
  const label = `${title}, ${who}`;
  const ask = c.needsYou.charAt(0).toUpperCase() + c.needsYou.slice(1);
  const toTodo = `<button type="button" class="need-todo" data-act="need-todo" title="Move it to your to-dos" aria-label="Move to your to-dos: ${esc(label)}">${svg("checklist")}<span>To-do</span></button>`;
  const dismiss = `<button type="button" class="icon-btn need-dismiss" data-act="need-dismiss" title="Dismiss: nobody's waiting on you" aria-label="Dismiss: ${esc(label)}">${svg("dismiss")}</button>`;
  const open = c.link && (mail ? isOutlookLink(c.link) : isTeamsLink(c.link))
    ? `<a class="btn sm" href="${esc(c.link)}" target="_blank" rel="noopener" data-act="need-open">${svg(mail ? "mail" : "chat")}<span>${mail ? "Open in Outlook" : "Open in Teams"}</span></a>`
    : "";
  return `
    <article class="need need-teams need-comms" data-key="need:${esc(n.key)}" data-comms-need="${esc(c.key)}" data-source="${esc(n.source)}">
      <div class="need-head">
        <span class="need-icon">${svg(mail ? "mail" : "chat")}</span>
        <button type="button" class="need-task" data-act="need-comms" title="${esc(c.summary || "Show it in Communication")}">${esc(title)}</button>
        <span class="need-end">${toTodo}${dismiss}</span>
      </div>
      <div class="need-body">
        <div class="ask-card ask-teams">
          <p class="ask-teams-line"><span class="ask-teams-who">${esc(who)}</span> ${esc(commsNeedWhere(c))} · ${esc(agoPhrase(c.lastAt, now))}</p>
          <p class="ask-teams-quote">${esc(ask)}</p>
          ${open ? `<div class="ask-card-actions">${open}</div>` : ""}
        </div>
      </div>
    </article>`;
}

/** Where a to-do from Teams, a meeting or an email came from, as a link to it. */
function todoLinkHtml(src: NonNullable<Todo["source"]>): string {
  const mail = src.key.startsWith("need:mail:");
  const meet = src.key.startsWith("meet:");
  const title = mail ? "Open the email in Outlook" : meet ? "Open the meeting's chat in Teams" : src.key.startsWith("need:chat:") ? "Open the chat in Teams" : "Open the message in Teams";
  return `<a class="todo-src" data-key="src" href="${esc(src.link!)}" target="_blank" rel="noopener" title="${title}">${svg(mail ? "mail" : meet ? "calendar" : "chat")}<span>${esc(src.taskTitle || (mail ? "Email" : "Teams"))}${src.who ? ` · ${esc(src.who)}` : ""}</span></a>`;
}

/** The chats and email threads someone waits on you in. */
const commsNeedsNow = (): CommsNeed[] => data?.comms?.needs || [];

/** Show a chat or thread that waits on you in the Communication tab, opened, in view. */
function showCommsNeed(key: string): void {
  const need = commsNeedsNow().find((n) => n.key === key);
  if (!need) return;
  const at = revealConversation(need.source, need.id, need.day);
  if (folded.has("tasks")) {
    folded.delete("tasks");
    applyLayout();
  }
  setPaneTab("comms");
  const show = (): boolean => {
    const el = commsBody.querySelector<HTMLElement>(`[data-chat="${CSS.escape(at)}"]`);
    if (el) flashInView(el, el.querySelector<HTMLElement>(".cs-head"));
    return !!el;
  };
  if (!show()) void Promise.all([loadChats(), loadMail()]).then(() => void show());
}

/** Dismiss a chat's or thread's ask: it leaves Needs you at once, and no longer shows as waiting in Communication. */
async function dismissCommsNeed(key: string): Promise<void> {
  if (!data?.comms) return;
  const before = data.comms.needs || [];
  data.comms.needs = before.filter((n) => n.key !== key);
  renderToday(true);
  try {
    const res = await postJSON("/api/jarvis/comms/needs/dismiss", { key });
    if (data?.comms && Array.isArray(res?.needs)) data.comms.needs = res.needs;
  } catch (e) {
    if ((e as ApiError).status !== 404 && data?.comms) {
      data.comms.needs = before;
      toast((e as Error).message, "err");
    }
  }
  renderToday(true);
}

/** The open Teams asks: all of them, or those of a service ("org/project"). */
function teamsAsks(of = ALL_SERVICES): CommsAsk[] {
  const asks = data?.comms?.asks || [];
  if (of === ALL_SERVICES) return asks;
  const key = of.toLowerCase();
  return asks.filter((a) => serviceKey(a.org, a.project).toLowerCase() === key);
}

function askOf(node: Element): CommsAsk | undefined {
  const id = Number(node.closest<HTMLElement>("[data-ask]")?.dataset.ask);
  return data?.comms?.asks.find((a) => a.id === id);
}

/** Open the PR a Teams ask is about: here when the app knows enough of it, else in Azure DevOps. */
function openAskPr(ask: CommsAsk): void {
  const pr = askPr(ask, state.prs);
  if (pr) return void openDetail(pr);
  const enc = encodeURIComponent;
  const url = ask.url || `https://dev.azure.com/${enc(ask.org)}/${enc(ask.project)}/_git/${enc(ask.repo)}/pullrequest/${ask.prId}`;
  window.open(url, "_blank", "noopener");
}

/** Dismiss a Teams ask: it leaves Needs you at once; a to-do made from it ticks on the next poll. */
async function dismissAsk(ask: CommsAsk): Promise<void> {
  if (!data?.comms) return;
  const before = data.comms.asks;
  data.comms.asks = before.filter((a) => a.id !== ask.id);
  renderToday(true);
  try {
    const res = await postJSON("/api/jarvis/comms/dismiss", { id: ask.id });
    if (data?.comms && Array.isArray(res?.asks)) data.comms.asks = res.asks;
  } catch (e) {
    if ((e as ApiError).status !== 404 && data?.comms) {
      data.comms.asks = before;
      toast((e as Error).message, "err");
    }
  }
  renderToday(true);
}

// ---- Tasks: the board ---------------------------------------------------------------

function renderTasks(force: boolean): void {
  const now = Date.now();
  const prs = scopedPrs();
  const needsHere = folded.has("today");
  const sig = todayFingerprint(
    data,
    JSON.stringify([
      service,
      loadError,
      needsHere,
      // What the to-dos took out of Needs you.
      data?.todos?.filter((t) => !t.done && t.source).map((t) => t.source!.key),
      prsLoaded || state.prs.length > 0,
      prs.map((p) => [p.id, reviewPhase(p)]),
      [...timelines],
      // Ages ("4m ago") move on even when nothing else does.
      Math.floor(now / 60_000),
    ])
  );
  if (!force && sig === tasksSig) return;
  tasksSig = sig;

  const options = serviceOptions(data?.tasks || [], state.prs);
  if (service !== ALL_SERVICES && !options.includes(service)) service = ALL_SERVICES;
  serviceSelect.innerHTML =
    `<option value="${ALL_SERVICES}">All services</option>` +
    options.map((o) => `<option value="${esc(o)}">${esc(o.replace("/", " / "))}</option>`).join("");
  serviceSelect.value = service;
  serviceSelect.hidden = options.length < 2 && service === ALL_SERVICES;

  if (!data) {
    tasksBody.innerHTML = loadingHtml("tasks");
    return;
  }

  const tasks = data.tasks.filter((t) => inService(t, service));
  const groups = groupTasks(tasks, dayStart(now));
  const needs = visibleNeeds(needsItems(tasks, teamsAsks(service), commsNeedsNow()), data.todos);
  const reviewed = reviewedInService(data.reviewed);
  const counts: Partial<Record<SectionId, number>> = {
    needs: needs.length,
    reviews: prs.length,
    running: groups.running.length,
    idle: groups.idle.length,
    done: groups.done.length + reviewed.length,
  };
  const workers = tasks.flatMap((t) => t.workers);
  const open = tasks.filter((t) => t.status === "open").length;
  tasksSub.textContent = `${open} open task${open === 1 ? "" : "s"} · ${workers.length} worker${workers.length === 1 ? "" : "s"}`;
  statusLine.textContent = todaySummary(counts);
  root!.querySelector(".today-status")!.className = `today-status tone-${counts.needs ? "warn" : counts.running ? "run" : "ok"}`;

  const html: string[] = [staleNote()];
  if (!data.tasks.length) {
    html.push(`
      <div class="today-start" data-key="start">
        <p class="today-start-title">Add your first task</p>
        <p>A task is an ADO work item, or a custom one. Start Copilot workers on it, and Devis keeps track.</p>
        <button type="button" class="btn sm accent" data-act="new-task">${svg("add")}<span>Task</span></button>
      </div>`);
  }
  // While Today is folded, what needs the user stays in sight here.
  if (needsHere && needs.length) html.push(needsSection(needs, now));
  for (const section of SECTIONS) {
    const id = section.id;
    if (id === "needs") continue;
    const count = counts[id] || 0;
    if (!count && id !== "reviews") continue;
    html.push(`<section class="today-section" data-section="${id}" data-key="sec:${id}">${sectionHead(section.title, section.tone, count)}`);
    if (id === "reviews") html.push(renderReviews(prs, now));
    else if (id === "done") {
      html.push(groups.done.map((t) => taskCard(t, now, "done")).join(""));
      html.push(reviewed.map((e) => reviewedRow(e, now)).join(""));
    } else html.push(groups[id].map((t) => taskCard(t, now, id)).join(""));
    html.push(`</section>`);
  }
  patchPane(tasksBody, html.join(""));
}

// ---- Today: the user's day ----------------------------------------------------------

function renderDay(force: boolean): void {
  // The note can save before the Workspace is ever shown (an edit restored at startup).
  if (!root) return;
  const now = Date.now();
  const needsHere = !folded.has("today");
  const sig = JSON.stringify([
    todayFingerprint(data, ""),
    loadError,
    needsHere,
    [...timelines],
    overviewCollapsed,
    overviewRefreshing,
    data?.todos?.map((t) => [t.id, t.text, t.done, t.author, t.source?.key, t.doneNote]),
    todoEditing,
    showDoneTodos,
    note?.version,
    noteDraft === null,
    noteSaving,
    noteError,
    noteMerged,
    noteConflict?.version,
    Math.floor(now / 60_000),
  ]);
  if (!force && sig === daySig) return;
  daySig = sig;

  const todos = data?.todos || [];
  const openTodos = todos.filter((t) => !t.done).length;
  const needs = data ? visibleNeeds(needsItems(data.tasks, teamsAsks(), commsNeedsNow()), data.todos) : [];
  daySub.textContent = [
    new Date(now).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
    needs.length ? `${needs.length} need${needs.length === 1 ? "s" : ""} you` : "",
    `${openTodos} to-do${openTodos === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(" · ");

  if (!data) {
    dayBody.innerHTML = loadingHtml("Today");
    return;
  }
  const html: string[] = [staleNote()];
  // Today covers every service: the filter belongs to the board in Tasks.
  html.push(renderOverview(data.tasks, now));
  if (needsHere) html.push(needsSection(needs, now));
  html.push(renderTodos(todos, now));
  html.push(renderNote(now));
  patchPane(dayBody, html.join(""));
}

// ---- Today: to-dos ------------------------------------------------------------------

function renderTodos(todos: Todo[], now: number): string {
  const open = todos.filter((t) => !t.done);
  const done = todos.filter((t) => t.done);
  const draft = drafts.get("todo:new") || "";
  const add = `<form class="todo-add" data-form="todo-add" data-key="todo-add">
      ${svg("add")}
      <input type="text" maxlength="500" data-draft="todo:new" value="${esc(draft)}" placeholder="Add a to-do (Enter)" aria-label="Add a to-do" autocomplete="off">
    </form>`;
  const list = open.length
    ? `<ul class="todo-list" data-key="todo-open">${open.map((t, i) => todoRow(t, now, i, open.length)).join("")}</ul>`
    : `<p class="today-empty" data-key="todo-none">Nothing on your list.</p>`;
  const doneHead = done.length
    ? `<div class="todo-done-head" data-key="todo-done-head">
        <button type="button" class="tu-toggle" data-act="todo-show-done" aria-expanded="${showDoneTodos}">Done · ${done.length}${svg("chevron")}</button>
        ${showDoneTodos ? `<button type="button" class="btn sm ghost todo-clear" data-act="todo-clear-done">Clear done</button>` : ""}
      </div>`
    : "";
  const doneList =
    done.length && showDoneTodos ? `<ul class="todo-list is-done" data-key="todo-done">${done.map((t) => todoRow(t, now, 0, 0)).join("")}</ul>` : "";
  return `<section class="today-section todo-section" data-section="todos" data-key="sec:todos">
      ${sectionHead("To-dos", "idle", open.length)}${add}${list}${doneHead}${doneList}
    </section>`;
}

function todoRow(t: Todo, now: number, index: number, count: number): string {
  const key = `todo:${t.id}`;
  const editing = todoEditing === t.id && !t.done;
  const text = editing
    ? `<input type="text" class="todo-edit" data-key="edit" maxlength="500" data-draft="${key}" value="${esc(drafts.get(key) ?? t.text)}" aria-label="Edit the to-do" autocomplete="off">`
    : `<span class="todo-text" data-key="text">${esc(t.text)}</span>`;
  // From Needs you: the task it's about opens from here; one that ticked itself says why.
  const src = t.source;
  const from = src?.taskId
    ? `<button type="button" class="todo-src" data-key="src" data-act="todo-open-task" data-src-task="${esc(src.taskId)}" title="Open ${esc(src.taskTitle)}">${svg("checklist")}<span>${esc(src.taskTitle || "the task")}${src.who ? ` · ${esc(src.who)}` : ""}</span></button>`
    : src?.link
      ? todoLinkHtml(src)
      : "";
  const note = t.done && t.doneNote ? `<span class="todo-note" data-key="note">Done by itself · ${esc(t.doneNote)}</span>` : "";
  const by =
    t.author !== "you"
      ? `<span class="todo-by" data-key="by" title="Added by ${esc(t.author)} ${esc(agoPhrase(t.createdAt, now))}">${esc(t.author)}</span>`
      : "";
  // Keyed, so a repaint between mousedown and click (an edit saved on focusout) can't turn the pressed button into another one.
  const tool = (act: string, name: IconName, label: string): string =>
    `<button type="button" class="icon-btn" data-key="${act}" data-act="${act}" title="${label}" aria-label="${label}">${svg(name)}</button>`;
  const tools = t.done
    ? tool("todo-delete", "trash", "Delete")
    : [
        editing ? "" : tool("todo-edit", "edit", "Edit"),
        index > 0 ? tool("todo-up", "up", "Move up (Alt+Up)") : "",
        index < count - 1 ? tool("todo-down", "down", "Move down (Alt+Down)") : "",
        tool("todo-delete", "trash", "Delete"),
      ].join("");
  // Every child is keyed: swapping the text for the edit box must not rebuild the tools under the pointer.
  return `<li class="todo${t.done ? " done" : ""}${editing ? " editing" : ""}" data-key="${key}" data-todo="${t.id}">
      <button type="button" class="todo-check" data-key="check" data-act="todo-toggle" role="checkbox" aria-checked="${t.done}"
        aria-label="${t.done ? "Done" : "Not done"}: ${esc(t.text)}" title="${t.done ? "Mark not done" : "Check off"}">${svg("check")}</button>
      <span class="todo-main" data-key="main">${text}${from}${note}</span>${by}<span class="todo-tools" data-key="tools">${tools}</span>
    </li>`;
}

function todoFor(node: Element): Todo | undefined {
  const id = Number(node.closest<HTMLElement>("[data-todo]")?.dataset.todo);
  return data?.todos?.find((t) => t.id === id);
}

/** Change the to-dos, then show the list the answer carries; after a failure, read the list again. */
async function todoAct(path: string, body: unknown, onFail?: () => void): Promise<boolean> {
  todoRev++;
  let ok = false;
  try {
    const res = await postJSON(path, body);
    if (data && Array.isArray(res?.todos)) data.todos = res.todos;
    ok = true;
  } catch (e) {
    // A to-do that's gone (deleted while its edit was on the way) isn't worth a toast; the reload settles it.
    if ((e as ApiError).status !== 404) toast((e as Error).message, "err");
    onFail?.();
  } finally {
    todoRev++;
    renderDay(true);
  }
  // Started after the change settled, so this read isn't set aside as stale.
  if (!ok) void loadToday();
  return ok;
}

function addTodo(form: HTMLFormElement): void {
  const input = form.querySelector<HTMLInputElement>("input")!;
  const text = input.value.trim();
  if (!text) return;
  // Cleared at once so the next one can be typed; put back if it didn't save.
  drafts.delete("todo:new");
  input.value = "";
  void todoAct("/api/jarvis/todos", { text }, () => {
    if (input.value) return;
    drafts.set("todo:new", text);
    input.value = text;
  });
}

/**
 * Take a Needs you item on as a to-do: it leaves Needs you at once, and the to-do it becomes
 * remembers it, so it ticks itself once the ask is gone. Undo takes the to-do back out.
 */
async function needToTodo(button: HTMLElement): Promise<void> {
  const source = button.closest<HTMLElement>("[data-source]")?.dataset.source;
  const item = data ? needsItems(data.tasks, teamsAsks(), commsNeedsNow()).find((n) => n.source === source) : undefined;
  if (!item || !data) return;
  const { text, source: from } = needTodo(item);
  // Where the keyboard goes once the item is gone: the next item's To-do, else the new to-do.
  const next = button.closest(".need")?.nextElementSibling?.querySelector<HTMLElement>("[data-act='need-todo']")?.closest<HTMLElement>("[data-source]")?.dataset.source;
  const iso = new Date().toISOString();
  const placeholder: Todo = { id: -Date.now(), text, done: false, author: "you", createdAt: iso, updatedAt: iso, doneAt: null, source: from, doneNote: null };
  data.todos = [...(data.todos || []), placeholder];
  renderToday(true);
  const ok = await todoAct("/api/jarvis/todos", { text, source: from }, () => {
    if (data?.todos) data.todos = data.todos.filter((t) => t !== placeholder);
  });
  renderTasks(true);
  if (!ok) return;
  const added = data.todos?.find((t) => !t.done && t.source?.key === from.key);
  const focusTarget = next
    ? root!.querySelector<HTMLElement>(`[data-source="${CSS.escape(next)}"] [data-act='need-todo']`)
    : added
      ? dayBody.querySelector<HTMLElement>(`[data-todo="${added.id}"] .todo-check`)
      : null;
  focusTarget?.focus({ preventScroll: true });
  toast("Moved to your to-dos", "ok", added ? { label: "Undo", run: () => void todoAct("/api/jarvis/todos/delete", { id: added.id }).then(() => renderTasks(true)) } : undefined);
}

function toggleTodo(todo: Todo): void {
  // Checked at once; the answer settles it, or puts it back.
  const was = todo.done;
  todo.done = !was;
  renderDay(true);
  void todoAct("/api/jarvis/todos/update", { id: todo.id, done: !was }, () => {
    todo.done = was;
  });
}

function moveTodo(todo: Todo, direction: "up" | "down"): void {
  const list = data?.todos;
  if (!list || todo.done) return;
  const open = list.filter((t) => !t.done);
  const at = open.indexOf(todo);
  const to = direction === "up" ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= open.length) return;
  [open[at], open[to]] = [open[to], open[at]];
  data!.todos = [...open, ...list.filter((t) => t.done)];
  renderDay(true);
  void todoAct("/api/jarvis/todos/move", { id: todo.id, direction }, () => {
    if (data) data.todos = list;
  });
}

function startTodoEdit(todo: Todo): void {
  if (todo.done) return;
  todoEditing = todo.id;
  drafts.set(`todo:${todo.id}`, todo.text);
  renderDay(true);
  const input = dayBody.querySelector<HTMLInputElement>(`[data-todo="${todo.id}"] .todo-edit`);
  input?.focus();
  input?.setSelectionRange(input.value.length, input.value.length);
}

/** Save or drop the edit in progress; `refocus` puts the keyboard back on the row. */
function endTodoEdit(save: boolean, refocus: boolean): void {
  const id = todoEditing;
  if (id === null) return;
  const key = `todo:${id}`;
  const text = (drafts.get(key) || "").trim();
  todoEditing = null;
  drafts.delete(key);
  const todo = data?.todos?.find((t) => t.id === id);
  const focusRow = (): void => {
    if (refocus) dayBody.querySelector<HTMLElement>(`[data-todo="${id}"] .todo-check`)?.focus();
  };
  if (!save || !todo || !text || text === todo.text) {
    renderDay(true);
    return focusRow();
  }
  const before = todo.text;
  todo.text = text;
  renderDay(true);
  focusRow();
  void todoAct("/api/jarvis/todos/update", { id, text }, () => {
    todo.text = before;
  });
}

// ---- Today: the quick note ----------------------------------------------------------

const noteValue = (): string => noteDraft ?? note?.text ?? "";

function noteState(now: number): { text: string; tone: string; title: string } {
  if (noteConflict) return { text: "Changed elsewhere", tone: "warn", title: "" };
  if (noteError) return { text: "Not saved", tone: "warn", title: noteError };
  if (noteSaving || noteDraft !== null) return { text: "Saving…", tone: "run", title: "" };
  if (!note) return { text: noteLoading ? "Loading…" : "", tone: "idle", title: "" };
  if (!note.updatedAt) return { text: "", tone: "idle", title: "" };
  const when = agoPhrase(note.updatedAt, now);
  const who = note.updatedBy && note.updatedBy !== "you" ? note.updatedBy : "";
  return { text: who ? `${who} added ${when}` : `Saved ${when}`, tone: who ? "run" : "idle", title: "" };
}

function renderNote(now: number): string {
  const s = noteState(now);
  const conflict = noteConflict
    ? `<div class="note-conflict" data-key="note-conflict" role="alert">
        <p>The note was changed somewhere else while you were editing it.</p>
        <div class="note-conflict-actions">
          <button type="button" class="btn sm" data-act="note-keep-both">Keep both</button>
          <button type="button" class="btn sm ghost" data-act="note-keep-mine">Keep mine</button>
          <button type="button" class="btn sm ghost" data-act="note-use-saved">Use the saved one</button>
        </div>
      </div>`
    : "";
  const merged = noteMerged ? `<p class="note-merged" data-key="note-merged">${esc(noteMerged)}</p>` : "";
  return `<section class="today-section note-section" data-section="note" data-key="sec:note">
      <h2 class="today-group tone-idle"><span class="today-group-dot"></span>Quick note
        <span class="note-state tone-${s.tone}" role="status"${s.title ? ` title="${esc(s.title)}"` : ""}>${esc(s.text)}</span></h2>
      ${conflict}${merged}
      <textarea class="quick-note" data-role="quick-note" data-max="480" rows="5" maxlength="${NOTE_MAX_CHARS}" spellcheck="true"
        aria-label="Quick note" placeholder="Anything to keep in mind. Devis and your workers can read it when you ask."${
          note || noteDraft !== null ? "" : " disabled"
        }>
${esc(noteValue())}</textarea>
    </section>`;
}

/** Repaint just the note's status, so typing doesn't repaint the pane. */
function paintNoteState(): void {
  const label = dayBody?.querySelector<HTMLElement>(".note-state");
  if (!label) return;
  const s = noteState(Date.now());
  label.textContent = s.text;
  label.className = `note-state tone-${s.tone}`;
  if (s.title) label.title = s.title;
  else label.removeAttribute("title");
}

async function loadNote(): Promise<void> {
  if (noteLoading) return;
  noteLoading = true;
  try {
    const res = await getJSON("/api/jarvis/note");
    const fresh = res?.note as QuickNote | undefined;
    // A save that landed meanwhile may already be newer.
    if (fresh && (!note || fresh.version >= note.version)) note = fresh;
    if (fresh && noteDraft === null) restoreNoteDraft(fresh);
  } catch {
    /* the next poll tries again */
  } finally {
    noteLoading = false;
    renderDay(true);
  }
}

/** Restore and save a quick-note edit an earlier page left unsaved, if there is one. */
export function resumeNoteDraft(): void {
  try {
    if (!localStorage.getItem(NOTE_DRAFT_KEY)) return;
  } catch {
    return;
  }
  if (!note) void loadNote();
}

/**
 * Keep the unsaved edit in the page's storage: the saved copy it started from, and the
 * ids of saves of it that may have landed (one in flight, the one sent on the way out).
 * The window reloads when the service restarts; this brings the edit back on the other side.
 */
function stashNote(extra?: [string, string]): void {
  clearTimeout(noteStashTimer);
  try {
    if (noteDraft === null) localStorage.removeItem(NOTE_DRAFT_KEY);
    else {
      const base = noteBase ?? note;
      const sends = [noteSending, extra].filter((s): s is [string, string] => !!s);
      localStorage.setItem(NOTE_DRAFT_KEY, JSON.stringify({ text: noteDraft, base: base?.version ?? 0, baseText: base?.text ?? "", sends }));
    }
  } catch {
    /* storage off or full: the save on the way out still tries */
  }
}

function stashNoteSoon(): void {
  clearTimeout(noteStashTimer);
  noteStashTimer = window.setTimeout(() => stashNote(), 300);
}

const newSaveId = (): string =>
  typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** A save this page sent, by id, with its text: when the note names it, everything after it was appended. */
function rememberSave(id: string, text: string): void {
  ownSaves.set(id, text);
  while (ownSaves.size > 20) ownSaves.delete(ownSaves.keys().next().value!);
}

/** An edit the last page didn't get to save: put it back and save it, merging with anything added since. */
function restoreNoteDraft(saved: QuickNote): void {
  let stash: { text?: unknown; base?: unknown; baseText?: unknown; sends?: unknown } | null = null;
  try {
    stash = JSON.parse(localStorage.getItem(NOTE_DRAFT_KEY) || "null");
  } catch {
    /* unreadable: nothing to restore */
  }
  if (!stash || typeof stash.text !== "string") return;
  if (Array.isArray(stash.sends)) {
    for (const s of stash.sends) if (Array.isArray(s) && typeof s[0] === "string" && typeof s[1] === "string") rememberSave(s[0], s[1]);
  }
  noteDraft = stash.text;
  noteBase = { text: typeof stash.baseText === "string" ? stash.baseText : "", version: Number(stash.base) || 0, updatedAt: null, updatedBy: null };
  mergeNote(saved);
  // It made it after all (the save on the way out landed), or it needs the user's call.
  if (noteDraft === null || noteConflict) return stashNote();
  noteMerged ||= "Your unsaved edit from before the app reloaded is back, and saving.";
  scheduleNoteSave(0);
}

function onNoteInput(area: HTMLTextAreaElement): void {
  if (noteDraft === null) noteBase = note;
  noteDraft = area.value;
  scheduleNoteSave(NOTE_SAVE_MS);
  stashNoteSoon();
  if (noteMerged) {
    noteMerged = "";
    renderDay(true);
  } else paintNoteState();
}

function scheduleNoteSave(ms: number): void {
  clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => void saveNote(), ms);
}

/** Save now, when there's an edit waiting. */
function flushNote(): Promise<void> {
  clearTimeout(noteTimer);
  return saveNote();
}

async function saveNote(): Promise<void> {
  clearTimeout(noteTimer);
  if (noteSaving || noteDraft === null || noteConflict) return;
  const text = noteDraft;
  const base = noteBase?.version ?? note?.version ?? 0;
  const saveId = newSaveId();
  rememberSave(saveId, text);
  noteSending = [saveId, text];
  noteSaving = true;
  paintNoteState();
  try {
    const res = await postJSON("/api/jarvis/note", { text, base, saveId });
    note = res.note as QuickNote;
    noteError = "";
    noteRetryMs = NOTE_RETRY_MS;
    // Typed on while it saved: the rest goes in the next save, from this version.
    if (noteDraft === text) {
      noteDraft = null;
      noteBase = null;
    } else noteBase = note;
  } catch (e) {
    const err = e as ApiError;
    if (err.status === 409 && err.data?.note) {
      // The app answered: whatever failed before is past.
      noteError = "";
      noteRetryMs = NOTE_RETRY_MS;
      mergeNote(err.data.note as QuickNote);
    } else {
      noteError = `Couldn't save the note: ${err.message}. It's kept here and saved when the app answers.`;
      scheduleNoteSave(noteRetryMs);
      noteRetryMs = Math.min(noteRetryMs * 2, 60_000);
    }
  } finally {
    noteSending = null;
    noteSaving = false;
    stashNote();
    // Typed on while it saved, or merged with what was added meanwhile: save the rest.
    if (noteDraft !== null && !noteConflict && !noteError) scheduleNoteSave(NOTE_SAVE_MS);
    renderDay(true);
  }
}

/** The note moved on while the user edited it: drop what already landed, fold in what was added, or ask. */
function mergeNote(saved: QuickNote): void {
  note = saved;
  if (noteDraft === null) return;
  const own = saved.lastSaveId ? ownSaves.get(saved.lastSaveId) : undefined;
  const result = reconcileNote(noteBase?.text ?? "", noteDraft, saved.text, own);
  if (result.kind === "conflict") {
    noteConflict = saved;
    return;
  }
  noteBase = saved;
  if (result.kind === "landed") {
    noteDraft = null;
    noteBase = null;
    return;
  }
  noteDraft = result.text;
  if (result.added) noteMerged = `${saved.updatedBy || "Someone"} added to the note while you were typing. It's below your text.`;
}

function resolveConflict(choice: "both" | "mine" | "saved"): void {
  const saved = noteConflict;
  if (!saved) return;
  noteConflict = null;
  if (choice === "saved" || noteDraft === null) {
    noteDraft = null;
    noteBase = null;
    note = saved;
  } else {
    if (choice === "both") noteDraft = `${noteDraft.replace(/\s+$/, "")}\n\n${saved.text}`;
    noteBase = saved;
    scheduleNoteSave(0);
  }
  stashNote();
  renderDay(true);
}

// ---- Today: the overview ------------------------------------------------------------

/** "Today so far": a short write-up of the day across tasks. What each task is doing is on its card. */
function renderOverview(tasks: TodayTask[], now: number): string {
  const start = dayStart(now);
  const o = data?.overview;
  if (!todayHasTasks(tasks, start) && !o?.text) return "";
  const phase = overviewRefreshing ? "updating" : o?.phase || "none";
  const freshness = overviewRefreshing ? "Updating…" : overviewFreshness(o, now);
  const tone = phase === "failed" ? "warn" : phase === "updating" ? "run" : "idle";
  const written = o?.at ? new Date(o.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
  const tip =
    phase === "failed" && o?.error
      ? `The last write-up didn't work out: ${o.error}`
      : o?.model && o.at
        ? `Written by ${o.model} at ${written}. A new one is written about once an hour when Today changes; Refresh writes one now.`
        : "";
  const head = `
    <div class="ov-head">
      <span class="ov-title">${svg("sparkle")}<span>Today so far</span></span>
      ${overviewCollapsed ? `<span class="ov-sum">${esc(overviewSummary(tasks, start))}</span>` : ""}
      <span class="ov-fresh tone-${tone}"${tip ? ` title="${esc(tip)}"` : ""}>${phase === "updating" ? '<span class="spinner"></span>' : ""}<span class="ov-fresh-text">${esc(freshness)}</span></span>
      ${phase === "failed" ? `<button type="button" class="btn sm ghost ov-retry" data-act="ov-refresh" data-role="retry">Retry</button>` : ""}
      <button type="button" class="icon-btn" data-act="ov-refresh" data-role="refresh" title="Write a new overview now" aria-label="Write a new overview now"${overviewRefreshing ? " disabled" : ""}>${svg("sync")}</button>
      <button type="button" class="icon-btn ov-toggle" data-act="ov-toggle" aria-expanded="${!overviewCollapsed}"
        title="${overviewCollapsed ? "Show the overview" : "Fold the overview"}" aria-label="${overviewCollapsed ? "Show the overview" : "Fold the overview"}">${svg("chevron")}</button>
    </div>`;
  if (overviewCollapsed) return `<section class="ov collapsed" data-key="ov" aria-label="Today so far">${head}</section>`;
  // It's written hourly, so between write-ups it shows as is; it dims only while a
  // new one is on its way, or when the last attempt failed.
  const dim = !!o?.stale && phase !== "fresh";
  const staleTip =
    phase === "failed" && o?.at
      ? `From ${written}. A newer write-up couldn't be made.`
      : "From before the latest changes. A new one is on its way.";
  const narrative = o?.text
    ? `<ul class="ov-narrative${dim ? " stale" : ""}"${dim ? ` title="${esc(staleTip)}"` : ""}>${narrativeHtml(o.text, tasks)}</ul>`
    : `<p class="ov-pending">${esc(phase === "failed" ? "No write-up yet. Retry writes one." : "The day's write-up comes once there's news. Refresh writes one now.")}</p>`;
  return `<section class="ov" data-key="ov" aria-label="Today so far">${head}${narrative}</section>`;
}

/** The narrative as list items of escaped text; task mentions become links to their cards. */
function narrativeHtml(text: string, tasks: TodayTask[]): string {
  return narrativeLines(text, tasks)
    .map((line) => `<li>${line.map((part) => mentionHtml(part)).join("")}</li>`)
    .join("");
}

function mentionHtml(part: NarrativePart): string {
  if (part.mention && part.taskId) {
    // Inline, not a <button>: a button lays out as one block, so a long title would sit on a line of its own.
    return `<span class="ov-mention" role="button" tabindex="0" data-act="ov-jump" data-role="mention" data-jump="${esc(part.taskId)}">${esc(part.text)}</span>`;
  }
  // A task outside the service filter, or one gone since the write-up.
  if (part.mention) return `<strong>${esc(part.text)}</strong>`;
  return esc(part.text);
}

async function refreshOverview(): Promise<void> {
  if (overviewRefreshing) return;
  overviewRefreshing = true;
  renderToday(true);
  try {
    const res = await postJSON("/api/jarvis/overview/refresh", {});
    if (data && res?.overview) data.overview = res.overview;
  } catch (e) {
    toast("Could not refresh the overview: " + (e as Error).message, "err");
  } finally {
    overviewRefreshing = false;
    renderToday(true);
    clearTimeout(todayTimer);
    todayTimer = window.setTimeout(() => void loadToday(), MID_MS);
  }
}

/**
 * Scroll to a task's card in whichever pane shows it. A card that's hidden by
 * the service filter or a folded Tasks pane is brought into view first.
 */
function jumpToTask(taskId: string): void {
  const find = (): HTMLElement | null =>
    root!.querySelector<HTMLElement>(`.today-pane:not([hidden]) article.task-card[data-task="${CSS.escape(taskId)}"]`);
  let card = find();
  if (!card) {
    const task = data?.tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (!inService(task, service)) {
      service = ALL_SERVICES;
      writePref(SERVICE_KEY, service);
    }
    if (folded.has("tasks")) {
      folded.delete("tasks");
      applyLayout();
    } else renderToday(true);
    card = find();
  }
  if (!card) return;
  flashInView(card, card.querySelector<HTMLElement>("button"));
}

/** Scroll to the first thing a task waits on you for, under Needs you, wherever that shows. */
function jumpToNeed(taskId: string): void {
  const find = (): HTMLElement | null => root!.querySelector<HTMLElement>(`.today-pane:not([hidden]) .need[data-need="${CSS.escape(taskId)}"]`);
  let item = find();
  if (!item && folded.has("today") && folded.has("tasks")) {
    folded.delete("today");
    applyLayout();
    item = find();
  }
  if (item) return flashInView(item, item.querySelector<HTMLElement>(".need-body button, .need-body textarea, .need-body input"));
  // Taken on as a to-do: that's where it is now. Else the task itself.
  const todo = root!.querySelector<HTMLElement>(`.today-pane:not([hidden]) .todo-src[data-src-task="${CSS.escape(taskId)}"]`)?.closest<HTMLElement>(".todo");
  if (todo) return flashInView(todo, todo.querySelector<HTMLElement>(".todo-check"));
  openTaskById(taskId);
}

function flashInView(el: HTMLElement, focus: HTMLElement | null): void {
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
  focus?.focus({ preventScroll: true });
}

// ---- Today: a task's status updates -------------------------------------------------

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** The latest status under a task's title, and the toggle for its timeline. `tone` colors its dot like the card's icon. */
function updateRow(task: TodayTask, now: number, tone: string): string {
  const latest = task.updates?.latest || null;
  const count = task.updates?.today.length || 0;
  const open = timelines.has(task.id);
  const text = latest
    ? `<span class="tu-text">${esc(latest.text)}</span><span class="tu-meta">${esc(latest.author)} · ${esc(agoPhrase(latest.at, now))}</span>`
    : `<span class="tu-text is-muted">No status yet</span>`;
  const label = count ? `${count} update${count === 1 ? "" : "s"} today` : "Post status";
  return `<div class="task-update tone-${tone}"><span class="tu-dot"></span>${text}<button type="button" class="tu-toggle" data-act="updates" aria-expanded="${open}">${esc(label)}${svg("chevron")}</button></div>`;
}

function timelineBlock(task: TodayTask, now: number): string {
  const today = task.updates?.today || [];
  const latest = task.updates?.latest;
  const list = today.length
    ? `<ol class="tl">${today
        .map(
          (s) =>
            `<li><time datetime="${esc(s.at)}">${esc(clockTime(s.at))}</time><span class="tl-who">${esc(s.author)}</span><span class="tl-text">${esc(s.text)}</span></li>`
        )
        .join("")}</ol>`
    : `<p class="tl-empty">No updates today${latest ? `. The last one, ${esc(agoPhrase(latest.at, now))}: ${esc(latest.text)}` : ""}.</p>`;
  const key = `st:${task.id}`;
  return `<div class="task-timeline">${list}
    <form class="tl-post" data-form="status">
      <input type="text" maxlength="160" data-draft="${esc(key)}" value="${esc(drafts.get(key) || "")}"
        placeholder="Post a status… (Enter to post)" aria-label="Post a status on ${esc(task.title)}" autocomplete="off">
      <button type="submit" class="btn sm">Post</button>
      <button type="button" class="btn sm ghost" data-act="all-updates" title="Every update since the task started">All updates</button>
    </form>
  </div>`;
}

/** A stable identity for a control across repaints: its owners' ids plus its own role. */
function focusKey(node: HTMLElement): string | null {
  if (!node.matches('button, textarea, input, a[href], [role="button"][tabindex]')) return null;
  const owners = ["data-task", "data-pr", "data-session", "data-request", "data-todo", "data-meet"].map(
    (attr) => node.closest<HTMLElement>(`[${attr}]`)?.getAttribute(attr) || ""
  );
  const own = ["data-draft", "data-act", "data-decide", "data-choice", "data-repos", "data-jump", "data-role", "data-day", "data-index"].map((attr) => node.getAttribute(attr) || "");
  return [...owners, ...own, node.tagName].join("|");
}

function renderReviews(prs: PR[], now: number): string {
  if (!prs.length) {
    const loading = !prsLoaded && !state.prs.length;
    return `<p class="today-empty">${loading ? '<span class="spinner"></span> Loading pull requests…' : esc(SECTIONS.find((s) => s.id === "reviews")!.empty)}</p>`;
  }
  // PRs someone asked for in Teams come first; otherwise the feed's order stands.
  const asks = data?.comms?.asks;
  const ordered = asks?.length ? [...prs].sort((a, b) => Number(!!askFor(asks, b)) - Number(!!askFor(asks, a))) : prs;
  const shown = showAllReviews ? ordered : ordered.slice(0, REVIEW_PREVIEW);
  const more = prs.length - shown.length;
  const toggle =
    prs.length > REVIEW_PREVIEW
      ? `<button type="button" class="btn sm ghost today-more" data-act="more-reviews">${
          more ? `Show ${more} more` : "Show fewer"
        }</button>`
      : "";
  return (
    shown
    .map((pr) => {
      const control = copilotReviewControl(reviewPhase(pr));
      const chip = control.chip
        ? `<span class="tchip tone-${control.chip.tone}">${svg("sparkle")}${esc(control.chip.label)}</span>`
        : "";
      const queued = queuing.has(prKey(pr));
      const busy = control.disabled || queued;
      const copilot = `<button type="button" class="btn sm ghost copilot-review" data-act="copilot-review" title="${esc(
        control.title
      )}"${busy ? " disabled" : ""}>${busy ? '<span class="spinner"></span>' : svg("sparkle")}<span>${esc(
        queued ? "Queuing…" : control.label
      )}</span></button>`;
      const ask = askFor(asks, pr);
      const asked = ask
        ? `<a class="tchip tone-warn ask-chip" href="${esc(ask.askers[0]?.link || "")}" target="_blank" rel="noopener" data-act="pr-teams" title="${esc(
            `${askersLine(ask.askers)} asked ${ask.askers[0] ? askerWhere(ask.askers[0]) : "in Teams"}. Open the message in Teams.`
          )}">${svg("chat")}<span>Asked by ${esc(askersLine(ask.askers))}</span></a>`
        : "";
      return `
        <article class="task-card review-card" data-key="pr:${esc(prKey(pr))}" data-pr="${esc(JSON.stringify([pr.org, pr.project, pr.repoId, pr.id]))}">
          <div class="task-row" data-act="open-pr">
            <span class="task-icon tone-run">${svg("pullRequest")}</span>
            <div class="task-main">
              <div class="task-title">${esc(pr.title)}</div>
              <div class="task-meta">#${pr.id} · ${esc(pr.repo)} · ${esc(pr.author)} · waiting ${esc(ago(pr.created, now))}${pr.isDraft ? " · Draft" : ""}</div>
            </div>
            <div class="task-side">${asked}${chip}${copilot}<button type="button" class="btn sm" data-act="open-pr">Review</button></div>
          </div>
        </article>`;
    })
    .join("") + toggle
  );
}

function reviewedRow(e: JarvisEvent, now: number): string {
  return `
    <article class="task-card done-card">
      <div class="task-row">
        <span class="task-icon tone-ok">${svg("pullRequest")}</span>
        <div class="task-main">
          <div class="task-title">${esc(e.text)}</div>
          <div class="task-meta">Pull request review · ${esc(agoPhrase(e.at, now))}</div>
        </div>
      </div>
    </article>`;
}

const SECTION_ICON: Record<BoardSection, [IconName, string]> = {
  running: ["sync", "run"],
  idle: ["circle", "idle"],
  done: ["check", "ok"],
};

function taskCard(task: TodayTask, now: number, section: BoardSection): string {
  // Waiting on the user: the card stays where it is, marked, and its warning leads to the ask under Needs you.
  const asks = taskNeeds([task]);
  const [iconName, tone] = asks.length ? (["warning", "warn"] as [IconName, string]) : SECTION_ICON[section];
  const reason = asks.length ? `Needs you: ${asks.map(needLine).join(" · ")}` : "";
  // Asks the user took on as to-dos are there now, not under Needs you.
  const where = asks.length && !visibleNeeds(asks, data?.todos).length ? "Show it in your to-dos" : "Show it under Needs you";
  const icon = asks.length
    ? `<button type="button" class="task-icon task-need tone-warn" data-act="need-jump" title="${esc(reason)}" aria-label="${esc(reason)}. ${where}">${svg(iconName)}</button>`
    : `<span class="task-icon tone-${tone}">${svg(iconName)}</span>`;
  const done = task.status === "done";
  const pills = task.workers
    .map((w) => {
      const s = workerState(w);
      const doing = s === "working" && w.activity ? ` · ${w.activity}` : "";
      return `<span class="wpill tone-${WORKER_TONE[s]}"><span class="wdot"></span><span class="wname">${esc(w.label)}</span><span class="wstate">${esc(WORKER_LABEL[s] + doing)}</span></span>`;
    })
    .join("");
  const actions = [
    task.workItem?.url
      ? `<a class="icon-btn" href="${esc(task.workItem.url)}" target="_blank" rel="noopener" title="Open in Azure DevOps" aria-label="Open in Azure DevOps">${svg("external")}</a>`
      : "",
    `<button type="button" class="btn sm ghost" data-act="artifacts">${svg("file")}<span>Artifacts</span></button>`,
    done
      ? `<button type="button" class="btn sm ghost" data-act="reopen">Reopen</button>`
      : `<button type="button" class="btn sm ghost" data-act="start-worker">${svg("play")}<span>Worker</span></button>
         <button type="button" class="icon-btn" data-act="done" title="Mark done" aria-label="Mark done">${svg("check")}</button>`,
    `<button type="button" class="icon-btn" data-act="delete-task" title="Remove task" aria-label="Remove task">${svg("trash")}</button>`,
  ].join("");
  const { shown, more } = cardPrs(task.prs);
  const vChip = validationChip(task.validation);
  const cChip = prCommentsChip(task.prComments);
  const bChip = prBuildsChip(task.prBuilds);
  const prChips =
    shown.length || vChip || cChip || bChip
      ? `<div class="task-prs">${shown
          .map((p) => {
            const chip = prChipText(p);
            return `<button type="button" class="pr-chip tone-${chip.tone}" data-act="task-prs" title="${esc(p.snapshot?.title || `PR ${p.prId}`)}">${svg("pullRequest")}<span>${esc(chip.text)}</span></button>`;
          })
          .join("")}${more ? `<button type="button" class="pr-chip more" data-act="task-prs" title="All of this task's pull requests">+${more}</button>` : ""}${
          vChip
            ? `<button type="button" class="pr-chip tone-${vChip.tone}" data-act="task-validation" title="${esc(task.validation?.name || "Validation")}">${svg("flow")}<span>${esc(vChip.text)}</span></button>`
            : ""
        }${
          cChip ? `<button type="button" class="pr-chip tone-${cChip.tone}" data-act="task-comments" title="Review comments on this task's PRs">${svg("chat")}<span>${esc(cChip.text)}</span></button>` : ""
        }${
          bChip ? `<button type="button" class="pr-chip tone-${bChip.tone}" data-act="task-comments" title="Failed builds on this task's PRs">${svg("pipeline")}<span>${esc(bChip.text)}</span></button>` : ""
        }</div>`
      : "";
  return `
    <article class="task-card${asks.length ? " needs" : ""}" data-key="task:${esc(task.id)}" data-task="${esc(task.id)}">
      <div class="task-row" data-act="open-task">
        ${icon}
        <div class="task-main">
          <button type="button" class="task-title task-open" data-act="open-task" title="Open the task and chat with its workers">${esc(task.title)}</button>
          <div class="task-meta" title="${esc(taskMeta(task))}">${esc(taskMeta(task))}${done && task.doneAt ? ` · done ${esc(agoPhrase(task.doneAt, now))}` : ""}</div>
          ${prChips}
          ${pills ? `<div class="task-workers">${pills}</div>` : section === "idle" ? `<div class="task-workers"><span class="today-hint">No worker yet</span></div>` : ""}
        </div>
        <div class="task-side">${actions}</div>
      </div>
      ${updateRow(task, now, asks.length ? "warn" : tone)}
      ${timelines.has(task.id) ? timelineBlock(task, now) : ""}
    </article>`;
}

// ---- events -------------------------------------------------------------------------

function taskFor(node: Element): TodayTask | undefined {
  const id = node.closest<HTMLElement>("[data-task]")?.dataset.task;
  return id ? data?.tasks.find((t) => t.id === id) : undefined;
}

function workerFor(node: Element): TodayWorker | undefined {
  const id = node.closest<HTMLElement>("[data-session]")?.dataset.session;
  return id ? data?.tasks.flatMap((t) => t.workers).find((w) => w.sessionId === id) : undefined;
}

function prFor(node: Element): PR | undefined {
  const key = node.closest<HTMLElement>("[data-pr]")?.dataset.pr;
  if (!key) return undefined;
  const [org, project, repoId, id] = JSON.parse(key);
  return state.prs.find((p) => p.org === org && p.project === project && p.repoId === repoId && p.id === id);
}

/** Run a Today action, then refresh. Errors become toasts. */
async function act(button: HTMLElement | null, run: () => Promise<unknown>): Promise<void> {
  if (button instanceof HTMLButtonElement) button.disabled = true;
  try {
    await run();
  } catch (e) {
    toast((e as Error).message, "err");
  } finally {
    if (button instanceof HTMLButtonElement) button.disabled = false;
    await loadToday();
  }
}

function onClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  if (target.closest("a[href]")) return;
  const paneTabButton = target.closest<HTMLElement>(".pane-tab[data-ptab]");
  if (paneTabButton) return setPaneTab(asPaneTab(paneTabButton.dataset.ptab));
  const starter = target.closest<HTMLElement>("[data-starter]");
  if (starter) return void sendToLead(starter.dataset.starter || "");
  // The Lead's queue: send a message now, or take it out.
  const queued = leadPane.log.contains(target) ? target.closest<HTMLElement>("[data-queue-send], [data-queue-remove]") : null;
  if (queued) {
    const id = queued.dataset.queueSend ?? queued.dataset.queueRemove ?? "";
    return void leadQueueAct(queued, queued.dataset.queueSend !== undefined ? "/api/jarvis/lead/queue/send" : "/api/jarvis/lead/queue/remove", id);
  }
  const decision = target.closest<HTMLElement>("[data-decide]");
  if (decision) {
    const w = workerFor(decision);
    const requestId = decision.closest<HTMLElement>("[data-request]")?.dataset.request;
    if (w && requestId) {
      void act(decision, () =>
        postJSON("/api/jarvis/workers/decide", { sessionId: w.sessionId, requestId, decision: decision.dataset.decide })
      );
    }
    return;
  }
  const choice = target.closest<HTMLElement>("[data-choice]");
  if (choice) {
    const w = workerFor(choice);
    const requestId = choice.closest<HTMLElement>("[data-request]")?.dataset.request;
    if (w && requestId) {
      void act(choice, () => postJSON("/api/jarvis/workers/message", { sessionId: w.sessionId, requestId, text: choice.dataset.choice }));
    }
    return;
  }
  const reposButton = target.closest<HTMLElement>("[data-repos]");
  if (reposButton) {
    const w = workerFor(reposButton);
    const requestId = reposButton.closest<HTMLElement>("[data-request]")?.dataset.request;
    const repos = reposFromCard(reposButton);
    if (!w || !requestId || !repos) return;
    if (reposButton.dataset.repos === "confirm" && !repos.length) return void toast("Check at least one repository, or choose None.", "err");
    void act(reposButton, () => postJSON("/api/jarvis/workers/repos", { sessionId: w.sessionId, requestId, repos }));
    return;
  }
  const node = target.closest<HTMLElement>("[data-act]");
  if (!node) return;
  const task = taskFor(node);
  const todo = todoFor(node);
  switch (node.dataset.act) {
    case "pane-fold":
    case "pane-open": {
      const pane = node.dataset.pane;
      if (isPane(pane)) setFolded(pane, node.dataset.act === "pane-fold");
      return;
    }
    case "todo-toggle":
      return void (todo && toggleTodo(todo));
    case "todo-edit":
      return void (todo && startTodoEdit(todo));
    case "todo-up":
    case "todo-down":
      return void (todo && moveTodo(todo, node.dataset.act === "todo-up" ? "up" : "down"));
    case "todo-delete":
      if (!todo) return;
      if (todoEditing === todo.id) todoEditing = null;
      return void todoAct("/api/jarvis/todos/delete", { id: todo.id });
    case "todo-show-done":
      showDoneTodos = !showDoneTodos;
      writePref(DONE_TODOS_KEY, showDoneTodos ? "1" : "0");
      return renderDay(true);
    case "todo-clear-done":
      return void todoAct("/api/jarvis/todos/clear-done", {});
    case "todo-open-task":
      return void (node.dataset.srcTask && openTaskById(node.dataset.srcTask));
    case "need-todo":
      return void needToTodo(node);
    case "need-pr": {
      const ask = askOf(node);
      if (ask) openAskPr(ask);
      return;
    }
    case "need-comms": {
      const key = node.closest<HTMLElement>("[data-comms-need]")?.dataset.commsNeed;
      if (key) showCommsNeed(key);
      return;
    }
    case "need-dismiss": {
      const commsKey = node.closest<HTMLElement>("[data-comms-need]")?.dataset.commsNeed;
      if (commsKey) return void dismissCommsNeed(commsKey);
      const ask = askOf(node);
      if (ask) void dismissAsk(ask);
      return;
    }
    case "meet-day":
      toggleDay(node.dataset.day || "", node.dataset.today === "1");
      return renderComms(true);
    case "meet-toggle": {
      const id = node.closest<HTMLElement>("[data-meet]")?.dataset.meet;
      if (id) toggleMeeting(id);
      return renderComms(true);
    }
    case "note-toggle": {
      const id = node.closest<HTMLElement>("[data-meet]")?.dataset.meet;
      if (id) toggleNote(id, Number(node.dataset.index));
      return renderComms(true);
    }
    case "meet-todo":
      return void meetingTodo(node);
    case "meetings-scan":
      return void scanMeetingsNow(node);
    case "meetings-settings":
    case "comms-settings":
      return hooks.openSettings();
    case "comms-scan":
      return void scanChatsNow(node);
    case "chat-day":
      toggleChatDay(node.dataset.day || "", node.dataset.today === "1");
      return renderComms(true);
    case "mail-quiet":
      toggleQuietMail(node.dataset.day || "");
      return renderComms(true);
    case "chat-toggle": {
      const key = node.closest<HTMLElement>("[data-chat]")?.dataset.chat;
      if (key) toggleChat(key);
      return renderComms(true);
    }
    case "note-keep-both":
      return resolveConflict("both");
    case "note-keep-mine":
      return resolveConflict("mine");
    case "note-use-saved":
      return resolveConflict("saved");
    case "lead-terminal":
      return void postJSON("/api/jarvis/lead/terminal", {}).then(
        () => toast("Opened the Lead in a terminal.", "ok"),
        (err: Error) => toast(err.message, "err")
      );
    case "lead-new":
      return confirmNewLead();
    case "lead-stop":
      return void act(node, () => postJSON("/api/jarvis/lead/stop", {})).then(() => loadLead());
    case "history":
      return void openHistory();
    case "new-task":
      return openNewTask();
    case "more-reviews":
      showAllReviews = !showAllReviews;
      return renderToday(true);
    case "open-pr": {
      const pr = prFor(node);
      if (pr) void openDetail(pr);
      return;
    }
    case "copilot-review": {
      const pr = prFor(node);
      if (pr) void queueCopilotReview(pr);
      return;
    }
    case "ov-refresh":
      return void refreshOverview();
    case "ov-toggle":
      overviewCollapsed = !overviewCollapsed;
      writePref(OVERVIEW_KEY, overviewCollapsed ? "1" : "0");
      return renderToday(true);
    case "ov-jump":
      return jumpToTask(node.dataset.jump || "");
    case "need-jump":
      return void (task && jumpToNeed(task.id));
    case "updates": {
      if (!task) return;
      const opening = !timelines.has(task.id);
      if (opening) timelines.add(task.id);
      else timelines.delete(task.id);
      renderToday(true);
      if (opening) root!.querySelector<HTMLInputElement>(`.today-pane:not([hidden]) article.task-card[data-task="${CSS.escape(task.id)}"] .tl-post input`)?.focus();
      return;
    }
    case "open-task":
      return void (task && openTaskModal(task.id, modalHost));
    case "artifacts":
      return void (task && openTaskModal(task.id, modalHost, "artifacts"));
    case "all-updates":
      return void (task && openTaskModal(task.id, modalHost, "status"));
    case "task-prs":
      return void (task && openTaskModal(task.id, modalHost, "devops"));
    case "task-validation":
      return void (task && openTaskModal(task.id, modalHost, "validation"));
    case "task-comments":
      return void (task && openTaskModal(task.id, modalHost, "comments"));
    case "start-worker":
      return void (task && openStartWorker(task));
    case "done":
      return void (task && act(node, () => postJSON("/api/jarvis/tasks/update", { id: task.id, status: "done" })));
    case "reopen":
      return void (task && act(node, () => postJSON("/api/jarvis/tasks/update", { id: task.id, status: "open" })));
    case "delete-task":
      return void (task && confirmDeleteTask(task));
  }
}

function onSubmit(e: SubmitEvent): void {
  const form = e.target as HTMLFormElement;
  e.preventDefault();
  if (form === leadPane.form) return void sendToLead(leadPane.input.value);
  if (form.dataset.form === "todo-add") return addTodo(form);
  if (form.dataset.form === "status") {
    const input = form.querySelector<HTMLInputElement>("input");
    const task = taskFor(form);
    const text = input?.value.trim() || "";
    if (!input || !task || !text) return;
    const key = input.dataset.draft || "";
    void act(form.querySelector<HTMLButtonElement>("button[type=submit]"), async () => {
      await postJSON("/api/jarvis/status", { taskId: task.id, text });
      drafts.delete(key);
      input.value = "";
    });
    return;
  }
  const area = form.querySelector<HTMLTextAreaElement>("textarea");
  const w = workerFor(form);
  const text = area?.value.trim() || "";
  if (!w || !area || !text) return;
  const key = area.dataset.draft || "";
  const requestId = form.dataset.form === "answer" ? form.closest<HTMLElement>("[data-request]")?.dataset.request : undefined;
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
  void act(button, async () => {
    await postJSON("/api/jarvis/workers/message", { sessionId: w.sessionId, text, requestId });
    drafts.delete(key);
    area.value = "";
  });
}

function onInput(e: Event): void {
  const field = e.target as HTMLElement;
  if (!(field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement)) return;
  if (field.dataset.role === "quick-note") onNoteInput(field as HTMLTextAreaElement);
  if (field.dataset.draft) drafts.set(field.dataset.draft, field.value);
  if (field instanceof HTMLTextAreaElement) autoSize(field);
}

function onKeydown(e: KeyboardEvent): void {
  const target = e.target as HTMLElement;
  // A task named in Today so far is inline text that acts as a button: Enter or Space follows it.
  if ((e.key === "Enter" || e.key === " ") && target.matches('span.ov-mention[role="button"]')) {
    e.preventDefault();
    target.click();
    return;
  }
  // A to-do being edited: Enter keeps the change, Escape drops it.
  if (target.classList.contains("todo-edit") && !e.isComposing) {
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      endTodoEdit(e.key === "Enter", true);
    }
    return;
  }
  // Alt+Up/Down moves the focused to-do.
  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    const todo = todoFor(target);
    if (todo && !todo.done) {
      e.preventDefault();
      moveTodo(todo, e.key === "ArrowUp" ? "up" : "down");
    }
    return;
  }
  // The Tasks pane's tabs: Left and Right (or Home and End) move between them.
  if (target.matches(".pane-tab") && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
    e.preventDefault();
    const at = PANE_TABS.indexOf(paneTab);
    const next =
      e.key === "Home"
        ? PANE_TABS[0]
        : e.key === "End"
          ? PANE_TABS[PANE_TABS.length - 1]
          : PANE_TABS[(at + (e.key === "ArrowRight" ? 1 : PANE_TABS.length - 1)) % PANE_TABS.length];
    return setPaneTab(next, true);
  }
  // The Lead's box: Ctrl+Enter sends it now, into the turn that's running.
  if (target === leadPane.input && composerKey(e) === "steer") {
    e.preventDefault();
    return void sendToLead(leadPane.input.value, "now");
  }
  // The quick note takes Enter as a new line.
  if (target.tagName !== "TEXTAREA" || target.dataset.role === "quick-note" || e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  const form = target.closest("form");
  if (!form) return;
  e.preventDefault();
  form.requestSubmit();
}

function onDblClick(e: MouseEvent): void {
  const text = (e.target as HTMLElement).closest(".todo-text");
  const todo = text && todoFor(text);
  if (todo) startTodoEdit(todo);
}

function onFocusOut(e: FocusEvent): void {
  const target = e.target as HTMLElement;
  // Clicking away keeps a to-do edit, as Enter does.
  if (target.classList.contains("todo-edit") && todoEditing !== null && document.hasFocus()) endTodoEdit(true, false);
  // Leaving the note saves it now rather than after the pause.
  if (target.dataset.role === "quick-note" && noteDraft !== null) void flushNote();
}

// ---- dialogs ------------------------------------------------------------------------

/**
 * Queue a Copilot review through the same queue, runner and review model as the
 * Pull requests page, so the result shows in the PR's review panel.
 */
async function queueCopilotReview(pr: PR): Promise<void> {
  const key = prKey(pr);
  if (queuing.has(key)) return;
  // From this click, so the OS can show "review ready" when the window is in the background.
  requestNotifyPermission();
  queuing.add(key);
  renderToday(true);
  try {
    const result = await sendPrsToCopilot([pr]);
    if (result.accepted.length) toast(`Queued PR #${pr.id} for a Copilot review`, "ok");
    else if (result.failed.length) toast("Could not queue the review: " + result.failed[0].error, "err");
    else toast(`PR #${pr.id} is already queued or being reviewed`, "ok");
  } finally {
    queuing.delete(key);
    // The PR list and Today both repaint from the updated review state.
    window.dispatchEvent(new CustomEvent("ado-pr-updated"));
  }
}

function confirmNewLead(): void {
  openActionDialog({
    title: "Start a new Lead session",
    loc: "Devis",
    body: `<p class="pa-note">Devis starts over with an empty conversation. Today and its history stay, so it can still recap past work.</p>`,
    confirmLabel: "Start over",
    onConfirm: async () => {
      await postJSON("/api/jarvis/lead/new", {});
      leadSig = "";
      await loadLead();
    },
  });
}

function confirmDeleteTask(task: TodayTask): void {
  const n = task.workers.length;
  const title = `<strong>${esc(task.title)}</strong>`;
  const flow =
    n === 1
      ? `Its worker first writes <strong>recap.md</strong> in the task's Artifacts. Then ${title} comes off Tasks, the worker stops, and its Copilot session is deleted.`
      : n > 1
        ? `One of its ${n} workers first writes <strong>recap.md</strong> in the task's Artifacts. Then ${title} comes off Tasks, its workers stop, and their Copilot sessions are deleted.`
        : `${title} comes off Tasks.`;
  const wipe = task.folder
    ? ` The task's folder <code>${esc(task.folder)}</code> is deleted with every worker's worktrees and their local branches; branches already pushed stay in Azure DevOps.`
    : "";
  const dialog = openActionDialog({
    title: "Remove task",
    loc: task.workItem ? `#${task.workItem.id}` : "Custom task",
    body: `<p class="pa-note">${flow}${wipe} Its Artifacts folder (note.md, recap.md and the rest) stays on disk${
      task.workItem ? ", and the work item in Azure DevOps is not touched" : ""
    }. History keeps a record.</p>${task.folder ? `<p class="pa-note jt-changes" hidden></p>` : ""}`,
    confirmLabel: "Remove",
    danger: true,
    onConfirm: async () => {
      const res = await postJSON("/api/jarvis/tasks/delete", { id: task.id });
      toast(res.recap ? `Writing the recap, then removing ${task.title}` : `Removed ${task.title}`, "ok");
      await loadToday();
    },
  });
  if (task.folder) void warnUnsaved(dialog, `id=${encodeURIComponent(task.id)}`);
}

function serviceChoices(): string[] {
  const projects = state.config.projects || {};
  const keys = new Set<string>(serviceOptions(data?.tasks || [], state.prs));
  for (const [org, list] of Object.entries(projects)) for (const p of list || []) keys.add(`${org}/${p}`);
  return [...keys].sort((a, b) => a.localeCompare(b));
}

function openNewTask(): void {
  const orgs = data?.organizations?.length ? data.organizations : state.config.organizations || [];
  const orgField =
    orgs.length > 1
      ? `<label class="rp-label" for="jt-org">Organization</label>
         <select id="jt-org" class="filter-select jv-field">${orgs.map((o) => `<option>${esc(o)}</option>`).join("")}</select>`
      : "";
  const services = serviceChoices();
  const root = state.config.taskRoot || "";
  const dialog = openActionDialog({
    title: "New task",
    loc: "Today",
    body: `
      <fieldset class="pa-fieldset">
        <legend class="rp-label">Task</legend>
        <label class="pa-radio"><input type="radio" name="jt-kind" value="wi" checked>
          <span><span class="pa-radio-label">From an ADO work item</span><span class="pa-radio-hint">User Story, Task, Bug… Devis reads its title, description, state and parent.</span></span></label>
        <label class="pa-radio"><input type="radio" name="jt-kind" value="custom">
          <span><span class="pa-radio-label">Custom task</span><span class="pa-radio-hint">No work item behind it.</span></span></label>
      </fieldset>
      <div class="jv-fields jt-wi">
        <label class="rp-label" for="jt-ref">Work item</label>
        <input id="jt-ref" class="ask-q jv-field" spellcheck="false" autocomplete="off" placeholder="2841124, or paste its link">
        <p class="pa-note jt-wi-found" hidden></p>
        ${orgField}
      </div>
      <div class="jv-fields jt-custom" hidden>
        <label class="rp-label" for="jt-title">Title</label>
        <input id="jt-title" class="ask-q jv-field" maxlength="200" autocomplete="off" placeholder="What is this task?">
        <label class="rp-label" for="jt-service">Service</label>
        <select id="jt-service" class="filter-select jv-field"><option value="">None</option>${services
          .map((s) => `<option value="${esc(s)}"${s === service ? " selected" : ""}>${esc(s.replace("/", " / "))}</option>`)
          .join("")}</select>
      </div>
      <div class="jv-fields">
        <label class="rp-label" for="jt-desc">Description</label>
        <textarea id="jt-desc" class="ask-q jt-desc" rows="4" maxlength="8000" placeholder="What it's for, what done looks like, anything the worker should know."></textarea>
        <label class="rp-label" for="jt-root">Folder</label>
        <input id="jt-root" class="ask-q jv-field" spellcheck="false" autocomplete="off" placeholder="C:\\work\\tasks" value="${esc(root)}">
        <p class="pa-note jt-root-note"></p>
      </div>
      <p class="pa-note">A worker starts right away in the task's folder. It proposes the repositories it needs for you to confirm, gets a worktree of each, and settles the goal with you before it starts.</p>`,
    confirmLabel: "Add task",
    onConfirm: async (node) => {
      const kind = node.querySelector<HTMLInputElement>('input[name="jt-kind"]:checked')?.value;
      const description = node.querySelector<HTMLTextAreaElement>("#jt-desc")!.value;
      const folderRoot = node.querySelector<HTMLInputElement>("#jt-root")!.value.trim();
      if (!folderRoot) throw new Error("Choose the folder the task's own folder goes in, or set it in Settings.");
      let body: Record<string, unknown>;
      if (kind === "custom") {
        const [org, project] = (node.querySelector<HTMLSelectElement>("#jt-service")!.value || "/").split("/");
        body = { title: node.querySelector<HTMLInputElement>("#jt-title")!.value, org: org || null, project: project || null, description, folderRoot };
      } else {
        const ref = node.querySelector<HTMLInputElement>("#jt-ref")!.value.trim();
        if (!ref) throw new Error("Enter a work item number or link.");
        body = { workItem: ref, org: node.querySelector<HTMLSelectElement>("#jt-org")?.value || orgs[0], description, folderRoot };
      }
      const res = await postJSON("/api/jarvis/tasks", body);
      if (!res.created) toast(`${res.task.title} is already in Tasks`, "ok");
      else if (res.workerError) toast(`Added ${res.task.title}, but its worker didn't start: ${res.workerError}`, "err");
      else toast(res.worker ? `Added ${res.task.title}. ${res.worker.label} is setting it up.` : `Added ${res.task.title}`, "ok");
      await loadToday();
      // Show the new task's chat, where its worker asks about the repositories.
      if (res.created && res.worker && data?.tasks.some((t) => t.id === res.task.id)) openTaskModal(res.task.id, modalHost);
    },
  });
  const field = <T extends HTMLElement>(sel: string) => dialog.querySelector<T>(sel)!;
  const desc = field<HTMLTextAreaElement>("#jt-desc");
  const found = field<HTMLElement>(".jt-wi-found");
  const rootNote = field<HTMLElement>(".jt-root-note");
  const custom = (): boolean => dialog.querySelector<HTMLInputElement>('input[name="jt-kind"]:checked')?.value === "custom";
  // What the description holds came from the work item until the user types in it.
  let descFromItem = true;
  let itemTitle = "";
  const paintRoot = (): void => {
    const title = custom() ? field<HTMLInputElement>("#jt-title").value : itemTitle;
    const where = taskFolderPreview(field<HTMLInputElement>("#jt-root").value, title || "task title");
    rootNote.textContent = where
      ? `Makes ${where}${title ? "" : " (named after the title)"}. Each worker gets a folder there with its worktrees.`
      : "Where the task's own folder goes. Set a default in Settings.";
  };
  let lookup = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const findItem = (): void => {
    if (timer) clearTimeout(timer);
    const ref = field<HTMLInputElement>("#jt-ref").value.trim();
    const token = ++lookup;
    itemTitle = "";
    if (!ref) {
      found.hidden = true;
      paintRoot();
      return;
    }
    timer = setTimeout(async () => {
      found.hidden = false;
      found.textContent = "Looking it up…";
      try {
        const org = dialog.querySelector<HTMLSelectElement>("#jt-org")?.value || orgs[0] || "";
        const { item } = await getJSON(`/api/jarvis/workitem?ref=${encodeURIComponent(ref)}&org=${encodeURIComponent(org)}`);
        if (token !== lookup) return;
        itemTitle = item.title;
        found.textContent = `${item.type} #${item.id} · ${item.title}${item.state ? ` · ${item.state}` : ""}`;
        if (descFromItem || !desc.value.trim()) {
          desc.value = item.description || "";
          descFromItem = true;
        }
      } catch (e) {
        if (token !== lookup) return;
        found.textContent = (e as Error).message;
      }
      paintRoot();
    }, 500);
  };
  desc.addEventListener("input", () => (descFromItem = !desc.value.trim()));
  field<HTMLInputElement>("#jt-ref").addEventListener("input", findItem);
  dialog.querySelector<HTMLSelectElement>("#jt-org")?.addEventListener("change", findItem);
  field<HTMLInputElement>("#jt-title").addEventListener("input", paintRoot);
  field<HTMLInputElement>("#jt-root").addEventListener("input", paintRoot);
  const sync = (): void => {
    const isCustom = custom();
    field<HTMLElement>(".jt-wi").hidden = isCustom;
    field<HTMLElement>(".jt-custom").hidden = !isCustom;
    // A work item's description doesn't carry over to a custom task.
    if (isCustom && descFromItem) desc.value = "";
    paintRoot();
    (dialog.querySelector<HTMLInputElement>(isCustom ? "#jt-title" : "#jt-ref") || dialog).focus();
  };
  dialog.querySelectorAll('input[name="jt-kind"]').forEach((r) => r.addEventListener("change", sync));
  paintRoot();
  requestAnimationFrame(() => dialog.querySelector<HTMLInputElement>("#jt-ref")?.focus());
}

/** A start dialog's Model and Reasoning effort fields. Effort shows for a model that takes one. */
const MODEL_FIELDS = `<label class="rp-label" for="jw-model">Model</label>
        <select id="jw-model" class="filter-select jv-field"><option value="">Copilot default</option></select>
        <label class="rp-label" for="jw-effort" hidden>Reasoning effort</label>
        <select id="jw-effort" class="filter-select jv-field" hidden><option value="">Default effort</option></select>`;

function wireModelFields(dialog: HTMLElement): void {
  const model = dialog.querySelector<HTMLSelectElement>("#jw-model")!;
  const effort = dialog.querySelector<HTMLSelectElement>("#jw-effort")!;
  const label = dialog.querySelector<HTMLElement>('label[for="jw-effort"]')!;
  const sync = (): void => {
    const efforts = effortsFor(modelCatalog(), model.value);
    const keep = efforts.includes(effort.value) ? effort.value : "";
    effort.replaceChildren(new Option("Default effort", ""), ...efforts.map((e) => new Option(effortLabel(e), e)));
    effort.value = keep;
    effort.hidden = label.hidden = !efforts.length;
  };
  model.addEventListener("change", sync);
  void loadModelCatalog().then((catalog) => {
    for (const m of catalog) model.append(new Option(m.id, m.id));
    sync();
  });
}

const chosenModel = (node: HTMLElement): { model: string | null; effort: string | null } => ({
  model: node.querySelector<HTMLSelectElement>("#jw-model")!.value || null,
  effort: node.querySelector<HTMLSelectElement>("#jw-effort")!.value || null,
});

function openStartWorker(task: TodayTask): void {
  if (task.folder) return openStartTaskWorker(task, task.folder);
  const folders = data?.folders || [];
  const dialog = openActionDialog({
    title: "Start a worker",
    loc: task.title,
    body: `
      <div class="jv-fields">
        <label class="rp-label" for="jw-folder">Folder</label>
        <input id="jw-folder" class="ask-q jv-field" list="jw-folders" spellcheck="false" autocomplete="off"
          placeholder="C:\\src\\repo" value="${esc(folders[0] || "")}">
        <datalist id="jw-folders">${folders.map((f) => `<option value="${esc(f)}"></option>`).join("")}</datalist>
        <label class="rp-label" for="jw-prompt">Instructions</label>
        <textarea id="jw-prompt" class="ask-q" rows="5" placeholder="What should this worker do first?"></textarea>
        ${MODEL_FIELDS}
      </div>
      <p class="pa-note">The worker is a Copilot session in that folder with your own Copilot setup. It can read freely. Shell commands, file edits and other tools wait for you under Needs you.</p>`,
    confirmLabel: "Start worker",
    onConfirm: async (node) => {
      const res = await postJSON("/api/jarvis/workers/start", {
        taskId: task.id,
        cwd: node.querySelector<HTMLInputElement>("#jw-folder")!.value,
        prompt: node.querySelector<HTMLTextAreaElement>("#jw-prompt")!.value,
        ...chosenModel(node),
      });
      toast(`Started ${res.worker.label}`, "ok");
      await loadToday();
    },
  });
  wireModelFields(dialog);
  requestAnimationFrame(() => dialog.querySelector<HTMLElement>(folders.length ? "#jw-prompt" : "#jw-folder")?.focus());
}

/** A worker on a task with its own folder: it gets a folder there and sets up its repositories itself. */
function openStartTaskWorker(task: TodayTask, folder: string): void {
  const dialog = openActionDialog({
    title: "Start a worker",
    loc: task.title,
    body: `
      <div class="jv-fields">
        <label class="rp-label" for="jw-prompt">Instructions <span class="rp-optional">(optional)</span></label>
        <textarea id="jw-prompt" class="ask-q" rows="5" placeholder="What should this worker take on? Leave it empty to have it work from the task's description."></textarea>
        ${MODEL_FIELDS}
      </div>
      <p class="pa-note">The worker gets its own folder in <code>${esc(folder)}</code>. Like the task's other workers, it proposes the repositories it needs for you to confirm, gets a worktree of each on its own branch, and settles the goal with you before it starts. Shell commands, file edits and other tools wait for you under Needs you.</p>`,
    confirmLabel: "Start worker",
    onConfirm: async (node) => {
      const res = await postJSON("/api/jarvis/workers/start", {
        taskId: task.id,
        prompt: node.querySelector<HTMLTextAreaElement>("#jw-prompt")!.value,
        ...chosenModel(node),
      });
      toast(`Started ${res.worker.label}`, "ok");
      await loadToday();
    },
  });
  wireModelFields(dialog);
  requestAnimationFrame(() => dialog.querySelector<HTMLElement>("#jw-prompt")?.focus());
}

async function openHistory(): Promise<void> {
  let events: JarvisEvent[];
  try {
    events = (await getJSON("/api/jarvis/history?days=14")).events || [];
  } catch (e) {
    toast("Could not load history: " + (e as Error).message, "err");
    return;
  }
  const days = new Map<string, JarvisEvent[]>();
  for (const e of events) {
    const day = new Date(e.at).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    const list = days.get(day) || [];
    list.push(e);
    days.set(day, list);
  }
  const body = events.length
    ? [...days]
        .map(
          ([day, list]) => `
          <h3 class="jh-day">${esc(day)}</h3>
          <ul class="jh-list">${list
            .map(
              (e) => `<li class="jh-item kind-${esc(e.kind.split(".")[0])}"><time>${esc(
                new Date(e.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
              )}</time><span>${esc(e.text)}</span></li>`
            )
            .join("")}</ul>`
        )
        .join("")
    : `<p class="pa-note">Nothing yet. Tasks, workers and PR reviews show up here as they happen.</p>`;
  const history = openActionDialog({
    title: "History",
    loc: "Last 14 days",
    body: `<div class="jh">${body}</div>`,
    confirmLabel: "Close",
    onConfirm: async () => undefined,
  });
  history.classList.add("jh-dialog");
  zoomable(history, "history");
  history.querySelector(".pa-cancel")?.remove();
}
