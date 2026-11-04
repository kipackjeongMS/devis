// The Workspace: Devis and the day's sections in columns, and a drawer over Devis's column.
//   Devis    — the Lead console, one persistent Copilot session that watches the Workspace and
//              keeps its history. "Today so far" is pinned over its thread.
//   Sections — the day at a glance: Needs you, Tasks, Pull Requests (yours and reviews),
//              Communication, Meetings, the user's own to-dos and a quick note. Each folds. The
//              to-dos and note belong to no day; Devis and the workers can read them when asked.
//   Layout   — every panel, Devis too, moves by its grip (or Alt+arrows) to any place in any
//              column, and the gaps drag to resize; workspaceGrid.ts does that. On a narrow
//              window Devis stands alone and the sections are a sheet behind the Overview button.
//   Drawer   — opens over Devis's column, the others staying in view: a task (its timeline and
//              its Copilot workers), Communication (email and Teams chats) or Meetings (recaps).
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
import { openDetail } from "./detail.js";
import { openActionDialog } from "./prActions.js";
import { sendPrsToCopilot } from "./bridge.js";
import { requestNotifyPermission } from "./notifyWatch.js";
import { closeTaskModal, openTaskModal, pruneTaskModalState, reposFromCard, requestCardHtml, updateTaskModal, warnUnsaved, type LeftTab, type TaskModalHost } from "./jarvisTask.js";
import { initViewZoom, zoomable } from "./viewZoom.js";
import { PANEL_NAME, SECTIONS as PANEL_SECTIONS, isPanelId, isSection as isPanelSection, type PanelId, type Section as PanelSection } from "./workspaceLayout.js";
import { afterFold, hideGrid, initGrid, isFlat, keyMove } from "./workspaceGrid.js";
import { meetingDetailHtml, meetingsHtml, meetingsRail, meetingsSig, meetingsSub, pruneMeetingsState, selectMeeting, toggleDay, toggleNote, type MeetingsView } from "./meetingsView.js";
import {
  communicationDetailHtml,
  communicationHtml,
  communicationRail,
  communicationSig,
  communicationSub,
  pruneCommunicationState,
  revealConversation,
  selectConversation,
  toggleChatDay,
  toggleQuietMail,
  type CommunicationView,
} from "./communicationView.js";
import { openContextMenu, type ContextMenuEntry } from "./contextMenu.js";
import { isOutlookLink, isTeamsLink, unseenRecaps, type ChatsInfo, type CommsChat, type CommsMail, type CommsMeeting, type MeetingScanInfo } from "./commsModel.js";
import {
  ALL_SERVICES,
  SECTIONS,
  WORKER_LABEL,
  WORKER_TONE,
  activityLine,
  ago,
  agoPhrase,
  askerWhere,
  askersLine,
  askPr,
  cardPrs,
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
import { clearSearch, initPrPanel, loadOlder, prPanelHtml, setQuery, showMore, toggleFilter, toggleFold, watchSentinel } from "./prPanel.js";
import { inboxItems, markPrRead } from "./inboxPanel.js";
import { matchNotificationPr } from "./inboxRoute.js";
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

/** The day's sections (workspaceLayout.ts places them). */
type RailSection = PanelSection;
const RAIL_SECTIONS = PANEL_SECTIONS;
const RAIL_NAME = PANEL_NAME;
const isRailSection = isPanelSection;
/** What opens in the drawer over Devis. */
type Drawer = { kind: "task"; taskId: string; tab?: LeftTab } | { kind: "comms" } | { kind: "meetings" };

/** The rail's folded sections. */
const RAIL_FOLD_KEY = "adoPrOps.workspace.railFolded";
/** The drawer's width, in px, as the user last dragged it. */
const DRAWER_WIDTH_KEY = "adoPrOps.workspace.drawerWidth";
const DRAWER_MIN = 560;
const SERVICE_KEY = "adoPrOps.jarvis.service";
const OVERVIEW_KEY = "adoPrOps.jarvis.overviewCollapsed";
const DONE_TODOS_KEY = "adoPrOps.workspace.showDoneTodos";
/** When the user last opened Meetings: recaps after it make its badge. */
const MEETINGS_SEEN_KEY = "adoPrOps.workspace.meetingsSeen";
/** When the user last opened Communication: important chats that moved after it make its badge. */
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
/** At this width and under, the rail is a sheet behind the Overview button. */
const sheetQuery = window.matchMedia("(max-width: 1023.98px)");

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
/** PRs whose Copilot review request is on its way to the queue. */
const queuing = new Set<string>();
const prKey = (pr: PR): string => JSON.stringify([pr.org, pr.project, pr.repoId, String(pr.id)]);
const drafts = new Map<string, string>();
let overviewCollapsed = readPref(OVERVIEW_KEY, "0") === "1";
let overviewRefreshing = false;
let railFolded = readRailFolded();

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
/** The center: Devis's chat, with the drawer over it. */
let center: HTMLElement;
let rail: HTMLElement;
/** The Overview button that opens the rail as a sheet on a narrow window, and its count of needs. */
let railButton: HTMLButtonElement;
let railBadge: HTMLElement;
/** The needs line over Devis on a narrow window. */
let needsBanner: HTMLElement;
/** "Today so far", pinned over Devis's thread so it stays in view while the chat scrolls. */
let overviewEl: HTMLElement;
/** Devis's line under the hello: what it watches. */
let leadWatch: HTMLElement;
let needsBody: HTMLElement;
let needsCount: HTMLElement;
let tasksBody: HTMLElement;
let tasksCount: HTMLElement;
let prsBody: HTMLElement;
let prsCount: HTMLElement;
let prsSig = "";
let serviceSelect: HTMLSelectElement;
let commsRailBody: HTMLElement;
let commsRailCount: HTMLElement;
let meetRailBody: HTMLElement;
let meetRailCount: HTMLElement;
let todosBody: HTMLElement;
let todosCount: HTMLElement;
let noteBody: HTMLElement;
let statusLine: HTMLElement;
let needsSig = "";
let daySig = "";
let tasksSig = "";
let overviewSig = "";

// The drawer over Devis: a task, Communication or Meetings. Opening one from another keeps a way back.
let drawer: Drawer | null = null;
const drawerBack: Drawer[] = [];
let drawerLayer: HTMLElement;
let drawerEl: HTMLElement;
let drawerHead: HTMLElement;
let drawerTitle: HTMLElement;
let drawerMeta: HTMLElement;
let drawerActs: HTMLElement;
let drawerBackBtn: HTMLButtonElement;
let drawerBody: HTMLElement;
/** What had focus before the drawer opened, to go back to when it closes. */
let drawerReturn: HTMLElement | null = null;
/** Communication or Meetings shows the selected item rather than the list (a narrow drawer shows one). */
let ldDetail = false;

// Communication (Teams chats' and email summaries, communicationView.ts) and Meetings (meetings and
// their recaps, meetingsView.ts): today's few in the rail, everything in the drawer.
const meetingsView: MeetingsView = { meetings: null, status: null, error: "", scanning: false };
/** The meetings' version the list in hand was read at; the Today poll says when it moved on. */
let meetingsVersion: string | null = null;
let meetingsLoading: Promise<void> | null = null;
let meetingsRendered = "";
const commsView: CommunicationView = { chats: null, status: null, mail: null, mailStatus: null, error: "", scanning: false };
let chatsVersion: string | null = null;
let mailVersion: string | null = null;
let mailLoading: Promise<void> | null = null;
let chatsLoading: Promise<void> | null = null;
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

/** The rail's folded sections. The Note starts folded. */
function readRailFolded(): Set<RailSection> {
  try {
    const list = JSON.parse(readPref(RAIL_FOLD_KEY, '["note"]'));
    if (Array.isArray(list)) return new Set(list.filter(isRailSection));
  } catch {
    /* unreadable: the default */
  }
  return new Set<RailSection>(["note"]);
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
  void loadMeetings();
  loadCommunication();
}

export function hideJarvis(): void {
  visible = false;
  clearTimeout(todayTimer);
  clearTimeout(leadTimer);
  closeDrawer(false);
  setSheet(false);
  hideGrid();
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
  if (data.tasks.some((t) => t.id === p.taskId)) openDrawer({ kind: "task", taskId: p.taskId, tab: p.tab });
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
    closeDrawer(false);
    await openDetail(pr);
  },
  close: () => closeDrawer(),
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
  for (const b of root?.querySelectorAll<HTMLButtonElement>('[data-act="prs-refresh"]') || []) {
    b.disabled = false;
    b.removeAttribute("aria-busy");
  }
  if (visible) renderToday(true);
});
window.addEventListener("ado-pr-updated", () => {
  if (visible) renderToday(true);
});
// New comments on your PRs, and the last push and your last word on each, land on their own.
for (const name of ["ado-inbox", "ado-pr-recency"]) {
  window.addEventListener(name, () => {
    if (visible) renderPrs(true);
  });
}

// ---- mount --------------------------------------------------------------------------

const iconBtn = (act: string, name: IconName, label: string): string =>
  `<button type="button" class="icon-btn" data-act="${act}" title="${esc(label)}" aria-label="${esc(label)}">${svg(name)}</button>`;

/** A section: a grip to move it, a fold toggle with its name and count, its own tools, and its body. */
function railSectionHtml(sec: RailSection, tools = ""): string {
  const fold = railFolded.has(sec);
  return `<section class="rs pn${fold ? " folded" : ""}" data-rs="${sec}" data-panel="${sec}" aria-label="${RAIL_NAME[sec]}">
      <div class="rs-h">
        <button type="button" class="pn-grip" data-act="pn-move" aria-haspopup="menu" aria-label="Move ${RAIL_NAME[sec]}" title="Drag to move · Alt+arrows">${svg("grip")}</button>
        <button type="button" class="rs-t" data-act="rs-fold" aria-expanded="${!fold}" aria-controls="rs-b-${sec}">${svg("chevron")}<span class="rs-name">${RAIL_NAME[sec]}</span><span class="rs-n"></span><span class="rs-new" hidden></span></button>
        ${tools ? `<span class="rs-ha">${tools}</span>` : ""}
      </div>
      <div class="rs-b" id="rs-b-${sec}"${fold ? " hidden" : ""}></div>
    </section>`;
}

function mount(): void {
  root = document.getElementById("jarvisView")!;
  const railTools: Partial<Record<RailSection, string>> = {
    tasks: `<select class="filter-select today-service" aria-label="Service"></select>${iconBtn("history", "clock", "History")}${iconBtn("new-task", "add", "New task")}`,
    prs: iconBtn("prs-refresh", "sync", "Refresh pull requests"),
    comms: iconBtn("comms-scan", "sync", "Read Teams and email now"),
    meetings: iconBtn("meetings-scan", "sync", "Read the calendar now"),
  };
  root.innerHTML = `
    <section class="jv-center pn pn-devis" data-panel="devis" data-pane-el="lead" aria-label="Devis, the Lead">
      <div class="jv-tools">
        <button type="button" class="jv-railbtn" data-act="rail-open" aria-expanded="false" aria-label="Show the overview">${svg("panel")}<span>Overview</span><span class="jv-badge" hidden></span></button>
        <span class="jv-sp"></span>
        ${iconBtn("lead-new", "add", "New Lead session")}
        ${iconBtn("lead-terminal", "terminal", "Open the Lead in a terminal")}
      </div>
      <button type="button" class="jv-banner" data-act="rail-open" hidden></button>
      ${chatPaneHtml({
        id: "lead",
        inputLabel: "Message Devis",
        headHtml: `<button type="button" class="pn-grip" data-act="pn-move" aria-haspopup="menu" aria-label="Move Devis" title="Drag to move · Alt+arrows">${svg("grip")}</button>
          <span class="jv-who">${svg("sparkle")}<b>Devis</b><span class="jv-watch"></span></span>
          <span class="chat-state tone-idle" hidden></span>
          <span class="chat-actions"><button type="button" class="btn sm ghost" data-act="lead-stop" hidden>${svg("stop")}<span>Stop</span></button></span>`,
      })}
    </section>
    <div class="jv-layer" hidden>
      <div class="jv-scrim" data-act="drawer-close"></div>
      <section class="jv-drawer" role="dialog" aria-modal="false" aria-labelledby="jv-dtitle" tabindex="-1">
        <div class="jv-grip" role="separator" aria-orientation="vertical" aria-label="Resize the drawer" aria-valuemin="${DRAWER_MIN}" tabindex="0"></div>
        <header class="jv-dhead">
          <button type="button" class="icon-btn" data-act="drawer-back" title="Back" aria-label="Back" hidden>${svg("back")}</button>
          <div class="jv-dt"><h3 id="jv-dtitle"></h3><p class="jv-dmeta"></p></div>
          <div class="jv-dacts"></div>
          ${iconBtn("drawer-close", "dismiss", "Close (Esc)")}
        </header>
        <div class="jv-dbody"></div>
      </section>
    </div>
    <aside class="jv-rail" aria-label="Overview" tabindex="-1">
      <div class="jv-rhead"><b>Overview</b>${iconBtn("rail-close", "dismiss", "Close the overview")}</div>
      <div class="jv-rscroll">
        ${RAIL_SECTIONS.map((sec) => railSectionHtml(sec, railTools[sec])).join("")}
      </div>
      <footer class="today-status"><span class="today-status-dot"></span><span class="today-status-text"></span></footer>
    </aside>
    <div class="jv-sheet-scrim" data-act="rail-close"></div>
    <div class="visually-hidden rs-live" aria-live="polite"></div>`;

  const q = <T extends Element>(sel: string): T => root!.querySelector<T>(sel)!;
  center = q(".jv-center");
  rail = q(".jv-rail");
  leadPane = chatPaneRefs(center);
  leadDraft = new ImageDraft(uploadImage, () => {
    paintTray(leadPane.tray, leadDraft, patchHtml);
    leadSig = "";
    renderLead();
  });
  wireImages(leadPane, { draft: () => leadDraft, refused: (problems) => toast(problems.join(" "), "err") });
  leadState = q(".chat-state");
  leadPicker = leadPane.tools;
  leadStop = q('[data-act="lead-stop"]');
  leadWatch = q(".jv-watch");
  leadPane.tools.addEventListener("change", onLeadPick);
  leadPane.steer.addEventListener("click", () => void sendToLead(leadPane.input.value, "now"));
  void loadModelCatalog().then(() => renderLeadPicker());
  overviewEl = el('<div class="jv-overview"></div>');
  leadPane.log.before(overviewEl);

  railButton = q(".jv-railbtn");
  railBadge = q(".jv-badge");
  needsBanner = q(".jv-banner");
  const body = (sec: RailSection): HTMLElement => q(`#rs-b-${sec}`);
  const count = (sec: RailSection): HTMLElement => q(`[data-rs="${sec}"] .rs-n`);
  needsBody = body("needs");
  needsCount = count("needs");
  tasksBody = body("tasks");
  tasksCount = count("tasks");
  prsBody = body("prs");
  prsCount = count("prs");
  initPrPanel(() => {
    if (visible) renderPrs(true);
  });
  commsRailBody = body("comms");
  commsRailCount = count("comms");
  meetRailBody = body("meetings");
  meetRailCount = count("meetings");
  todosBody = body("todos");
  todosCount = count("todos");
  noteBody = body("note");
  serviceSelect = q(".today-service");
  statusLine = q(".today-status-text");

  drawerLayer = q(".jv-layer");
  drawerEl = q(".jv-drawer");
  drawerHead = q(".jv-dhead");
  drawerTitle = q("#jv-dtitle");
  drawerMeta = q(".jv-dmeta");
  drawerActs = q(".jv-dacts");
  drawerBackBtn = q('[data-act="drawer-back"]');
  drawerBody = q(".jv-dbody");
  wireGrip(q<HTMLElement>(".jv-grip"));
  // The panels go into their columns (or, on a narrow window, the overview sheet).
  initGrid({
    root,
    rail,
    railScroll: q<HTMLElement>(".jv-rscroll"),
    footer: q<HTMLElement>(".today-status"),
    layer: drawerLayer,
    live: q<HTMLElement>(".rs-live"),
    editButton: document.getElementById("btnLayout") as HTMLButtonElement | null,
    sheetQuery,
    folded: (id: PanelId) => isRailSection(id) && railFolded.has(id),
    onFlatChange: () => setSheet(false),
  });

  // Ctrl +/−/0 zoom what you're in: Devis's chat or a section (the drawer zooms on its own).
  zoomable(leadPane.root, "lead");
  for (const b of root.querySelectorAll<HTMLElement>(".rs-b")) zoomable(b, "today");
  initViewZoom();

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

/** The drawer's left edge: drag it, or use Left and Right, to size the drawer. The width is kept. */
function wireGrip(grip: HTMLElement): void {
  const setWidth = (px: number, save: boolean): void => {
    const max = Math.max(DRAWER_MIN, drawerLayer.clientWidth - 64);
    const width = Math.round(Math.min(max, Math.max(DRAWER_MIN, px)));
    root!.style.setProperty("--drawer-w", `${width}px`);
    grip.setAttribute("aria-valuenow", String(width));
    if (save) writePref(DRAWER_WIDTH_KEY, String(width));
  };
  const saved = Number(readPref(DRAWER_WIDTH_KEY, "0"));
  if (saved >= DRAWER_MIN) root!.style.setProperty("--drawer-w", `${saved}px`);
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const right = drawerLayer.getBoundingClientRect().right;
    const move = (ev: PointerEvent): void => setWidth(right - ev.clientX, false);
    const up = (): void => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      setWidth(drawerEl.getBoundingClientRect().width, true);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  grip.addEventListener("dblclick", () => {
    root!.style.removeProperty("--drawer-w");
    try {
      localStorage.removeItem(DRAWER_WIDTH_KEY);
    } catch {
      /* private mode */
    }
  });
  grip.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    setWidth(drawerEl.getBoundingClientRect().width + (e.key === "ArrowLeft" ? 32 : -32), true);
  });
}

// ---- the drawer ---------------------------------------------------------------------

const sameDrawer = (a: Drawer, b: Drawer): boolean =>
  a.kind === b.kind && (a.kind !== "task" || (b.kind === "task" && a.taskId === b.taskId));

/**
 * Open a task, Communication or Meetings over Devis. Opened from inside the drawer, Back
 * returns to what was there. `detail` shows the selected conversation or meeting at once
 * on a narrow window, where the list and the detail take turns.
 */
function openDrawer(d: Drawer, detail = false): void {
  if (!root) return;
  const active = document.activeElement as HTMLElement | null;
  const fromDrawer = !!drawer && !!active && drawerEl.contains(active);
  if (drawer && sameDrawer(drawer, d) && !(d.kind === "task" && d.tab)) {
    if (d.kind !== "task") {
      ldDetail = detail || ldDetail;
      renderComms(true);
    }
    return;
  }
  if (!fromDrawer) {
    drawerReturn = active && active !== document.body ? active : null;
    drawerBack.length = 0;
  } else if (drawer && !sameDrawer(drawer, d)) drawerBack.push(drawer);
  showDrawer(d, detail);
}

function showDrawer(d: Drawer, detail: boolean): void {
  if (drawer?.kind === "task") closeTaskModal();
  const opening = drawerLayer.hidden;
  drawer = d;
  ldDetail = detail;
  drawerLayer.hidden = false;
  if (opening) {
    drawerLayer.classList.remove("anim");
    void drawerLayer.offsetWidth;
    drawerLayer.classList.add("anim");
  }
  drawerBody.replaceChildren();
  drawerActs.replaceChildren();
  delete drawerBody.dataset.zoomView;
  drawerBody.style.removeProperty("--view-zoom");
  drawerEl.dataset.kind = d.kind;
  drawerBackBtn.hidden = !drawerBack.length;
  if (d.kind === "task") {
    // The task brings its own head, with its close button.
    drawerHead.hidden = true;
    drawerEl.removeAttribute("aria-labelledby");
    drawerEl.setAttribute("aria-label", `Task: ${data?.tasks.find((t) => t.id === d.taskId)?.title || ""}`);
    openTaskModal(d.taskId, modalHost, d.tab, drawerBody);
  } else {
    const comms = d.kind === "comms";
    drawerHead.hidden = false;
    drawerEl.removeAttribute("aria-label");
    drawerEl.setAttribute("aria-labelledby", "jv-dtitle");
    drawerTitle.textContent = comms ? "Communication" : "Meetings";
    drawerMeta.textContent = "";
    drawerActs.innerHTML = comms
      ? iconBtn("comms-scan", "sync", "Read Teams and email now") + iconBtn("comms-settings", "settings", "Communication settings")
      : iconBtn("meetings-scan", "sync", "Read the calendar now") + iconBtn("meetings-settings", "settings", "Meetings settings");
    drawerBody.innerHTML = `<div class="ld" data-pane="${detail ? "detail" : "list"}"><div class="ld-list" tabindex="-1"></div><div class="ld-detail" tabindex="-1"></div></div>`;
    zoomable(drawerBody, "drawer");
    if (comms) {
      writePref(COMMUNICATION_SEEN_KEY, String(Date.now()));
      loadCommunication();
    } else {
      markMeetingsSeen();
      void loadMeetings();
    }
    drawerEl.focus({ preventScroll: true });
  }
  commsRendered = "";
  meetingsRendered = "";
  renderComms(true);
}

/** Close the drawer; `restore` puts focus back where it was before the drawer opened. */
function closeDrawer(restore = true): void {
  if (!drawer) return;
  if (drawer.kind === "task") closeTaskModal();
  drawer = null;
  drawerBack.length = 0;
  ldDetail = false;
  drawerBody.replaceChildren();
  drawerActs.replaceChildren();
  delete drawerBody.dataset.zoomView;
  drawerBody.style.removeProperty("--view-zoom");
  delete drawerEl.dataset.kind;
  drawerLayer.hidden = true;
  drawerLayer.classList.remove("anim");
  const back = drawerReturn;
  drawerReturn = null;
  if (restore) (back?.isConnected ? back : leadPane.input).focus({ preventScroll: true });
  // The rail's "new" marks come back, now counted from this visit.
  commsRendered = "";
  meetingsRendered = "";
  renderComms(true);
}

function drawerGoBack(): void {
  const prev = drawerBack.pop();
  if (!prev || !drawer) return;
  showDrawer(prev, false);
}

// ---- the sections -------------------------------------------------------------------

/**
 * On a narrow window the sections are a sheet over the right edge, behind the Overview button.
 * With columns they're always in view: "open" takes the keyboard to Needs you.
 */
function setSheet(open: boolean): void {
  if (!root) return;
  if (open && !isFlat()) {
    root.querySelector<HTMLElement>('[data-rs="needs"] .rs-t')?.focus({ preventScroll: true });
    return;
  }
  const was = root.classList.contains("sheet-open");
  root.classList.toggle("sheet-open", open);
  railButton.setAttribute("aria-expanded", String(open));
  if (open) rail.focus({ preventScroll: true });
  else if (was && rail.contains(document.activeElement)) railButton.focus({ preventScroll: true });
}

function setRailFold(sec: RailSection, fold: boolean): void {
  if (fold) railFolded.add(sec);
  else railFolded.delete(sec);
  writePref(RAIL_FOLD_KEY, JSON.stringify([...railFolded]));
  const box = root?.querySelector<HTMLElement>(`[data-rs="${sec}"]`);
  if (!box) return;
  box.classList.toggle("folded", fold);
  box.querySelector(".rs-t")?.setAttribute("aria-expanded", String(!fold));
  box.querySelector<HTMLElement>(".rs-b")!.hidden = fold;
  afterFold();
}

/** Unfold a section and, on a narrow window, bring the sheet up, so something in it can be shown. */
function revealRail(sec: RailSection): void {
  if (railFolded.has(sec)) setRailFold(sec, false);
  if (isFlat() && !root!.classList.contains("sheet-open")) {
    root!.classList.add("sheet-open");
    railButton.setAttribute("aria-expanded", "true");
  }
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
    // Likewise the meetings, chats and email: the rail shows today's, and the drawer all of them.
    const meetingsAt = next.comms?.meetings?.version;
    if ((!meetingsView.meetings && !meetingsView.error) || (meetingsAt !== undefined && meetingsAt !== meetingsVersion)) void loadMeetings();
    const chatsAt = next.comms?.chats?.version;
    if ((!commsView.chats && !commsView.error) || (chatsAt !== undefined && chatsAt !== chatsVersion)) void loadChats();
    const mailAt = next.comms?.mail?.version;
    if ((!commsView.mail && !commsView.error) || (mailAt !== undefined && mailAt !== mailVersion)) void loadMail();
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

/**
 * Drop per-task and per-request state for what's no longer on Today: drafts
 * and the task modal's chat notes and choices. The page runs
 * for days; without this, every task and question ever seen stays in memory.
 */
function pruneTodayState(today: TodayData): void {
  const taskIds = new Set(today.tasks.map((t) => t.id));
  const sessionIds = new Set(today.tasks.flatMap((t) => t.workers.map((w) => w.sessionId)));
  const requestIds = new Set(today.tasks.flatMap((t) => t.workers.flatMap((w) => w.requests.map((r) => r.id))));
  const todoIds = new Set((today.todos || []).map((t) => String(t.id)));
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
  renderPrs(force);
  renderDay(force);
  renderComms(force);
}

/** Pull Requests: yours, then other people's to review. Skips the paint when nothing changed. */
function renderPrs(force = false): void {
  if (!root) return;
  const view = prPanelHtml({
    now: Date.now(),
    service,
    loaded: prsLoaded || state.prs.length > 0,
    asks: data?.comms?.asks,
    queuing,
  });
  // The HTML carries every age and state on screen, so it's the panel's signature.
  if (!force && view.html === prsSig) return;
  prsSig = view.html;
  prsCount.textContent = view.count ? String(view.count) : "";
  paintNew("prs", view.newCount, view.newLabel);
  paintRailBadge();
  patchPane(prsBody, view.html);
  watchSentinel(prsBody);
}

// ---- Communication and Meetings ---------------------------------------------------

const meetingsShown = (): boolean => visible && drawer?.kind === "meetings";
const commsShown = (): boolean => visible && drawer?.kind === "comms";

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

/** What's new, by rail section; on a narrow window the Overview button's badge adds them up. */
const railNew = { needs: 0, prs: 0, comms: 0, meetings: 0 };

function paintRailBadge(): void {
  const n = railNew.needs + railNew.prs + railNew.comms + railNew.meetings;
  railBadge.hidden = !n;
  railBadge.textContent = n ? String(n) : "";
  railButton.setAttribute("aria-label", n ? `Show the overview, ${n} new` : "Show the overview");
}

/** A rail section's "N new" pill; none while its drawer is open, since you're looking at it. */
function paintNew(sec: "prs" | "comms" | "meetings", n: number, label: string): void {
  railNew[sec] = n;
  const pill = root!.querySelector<HTMLElement>(`[data-rs="${sec}"] .rs-new`)!;
  pill.hidden = !n;
  pill.textContent = n ? `${n} new` : "";
  root!.querySelector(`[data-rs="${sec}"] .rs-t`)!.setAttribute("aria-label", n ? `${RAIL_NAME[sec]}, ${label}` : RAIL_NAME[sec]);
}

/**
 * Repaint Communication and Meetings: the rail's rows and "new" pills, and, while the drawer
 * shows one of them, its list and the selected conversation or meeting.
 */
function renderComms(force = false): void {
  if (!root) return;
  const now = Date.now();
  const seen = Number(readPref(MEETINGS_SEEN_KEY, "0")) || dayStart(now);
  const unseen = meetingsShown() ? 0 : unseenRecaps(data?.comms?.meetings?.ready, seen);
  paintNew("meetings", unseen, `${unseen} new recap${unseen === 1 ? "" : "s"}`);
  // Communication: conversations and threads that need you, or matter, and moved since you last looked.
  const commsSeen = Number(readPref(COMMUNICATION_SEEN_KEY, "0")) || dayStart(now);
  const flagged = commsShown() ? 0 : unseenRecaps(data?.comms?.chats?.flagged, commsSeen) + unseenRecaps(data?.comms?.mail?.flagged, commsSeen);
  paintNew("comms", flagged, `${flagged} to look at`);
  paintRailBadge();
  patchPane(commsRailBody, communicationRail(commsView, now).html);
  patchPane(meetRailBody, meetingsRail(meetingsView, now));
  if (!drawer || drawer.kind === "task") return;
  const ld = drawerBody.querySelector<HTMLElement>(".ld");
  if (!ld) return;
  ld.dataset.pane = ldDetail ? "detail" : "list";
  const list = ld.querySelector<HTMLElement>(".ld-list")!;
  const detail = ld.querySelector<HTMLElement>(".ld-detail")!;
  if (drawer.kind === "comms") {
    drawerMeta.textContent = communicationSub(commsView, now);
    const sig = communicationSig(commsView, now);
    if (!force && sig === commsRendered) return;
    commsRendered = sig;
    patchPane(list, communicationHtml(commsView, now));
    patchPane(detail, communicationDetailHtml(commsView, now));
    return;
  }
  drawerMeta.textContent = meetingsSub(meetingsView, now);
  const sig = meetingsSig(meetingsView, data?.todos, now);
  if (!force && sig === meetingsRendered) return;
  meetingsRendered = sig;
  patchPane(list, meetingsHtml(meetingsView, data?.todos, now));
  patchPane(detail, meetingDetailHtml(meetingsView, data?.todos, now));
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

/** Open a chat or thread that waits on you in Communication, selected and in view. */
function showCommsNeed(key: string): void {
  const need = commsNeedsNow().find((n) => n.key === key);
  if (!need) return;
  const at = revealConversation(need.source, need.id, need.day);
  if (isFlat()) setSheet(false);
  openDrawer({ kind: "comms" }, true);
  const show = (): boolean => {
    const row = drawerBody.querySelector<HTMLElement>(`.ld-list [data-chat="${CSS.escape(at)}"]`);
    if (row) row.scrollIntoView({ block: "nearest" });
    return !!row;
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

// ---- Tasks: the rail's board -------------------------------------------------------

function renderTasks(force: boolean): void {
  const now = Date.now();
  // The service choices come from tasks and PRs, so the PR list moves them too.
  const options = serviceOptions(data?.tasks || [], state.prs);
  const sig = todayFingerprint(
    data,
    JSON.stringify([
      service,
      loadError,
      // What the to-dos took out of Needs you.
      data?.todos?.filter((t) => !t.done && t.source).map((t) => t.source!.key),
      options,
      // Ages ("4m") move on even when nothing else does.
      Math.floor(now / 60_000),
    ])
  );
  if (!force && sig === tasksSig) return;
  tasksSig = sig;

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
    running: groups.running.length,
    idle: groups.idle.length,
    done: groups.done.length + reviewed.length,
  };
  const open = tasks.filter((t) => t.status === "open").length;
  tasksCount.textContent = open ? String(open) : "";
  const allOpen = data.tasks.filter((t) => t.status === "open").length;
  const working = data.tasks.flatMap((t) => t.workers).filter((w) => workerState(w) === "working").length;
  leadWatch.textContent = allOpen ? `Watching ${allOpen} task${allOpen === 1 ? "" : "s"}${working ? ` · ${working} working` : ""}` : "";
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
  for (const section of SECTIONS) {
    const id = section.id;
    if (id === "needs") continue;
    const count = counts[id] || 0;
    if (!count) continue;
    html.push(`<div class="rr-sec" data-section="${id}" data-key="sec:${id}">${subHead(section.title, count)}`);
    if (id === "done") {
      html.push(groups.done.map((t) => taskCard(t, now, "done")).join(""));
      html.push(reviewed.map((e) => reviewedRow(e, now)).join(""));
    } else html.push(groups[id].map((t) => taskCard(t, now, id)).join(""));
    html.push(`</div>`);
  }
  patchPane(tasksBody, html.join(""));
}

// ---- The day: Needs you, the overview, to-dos and the note ----------------------------

function renderDay(force: boolean): void {
  // The note can save before the Workspace is ever shown (an edit restored at startup).
  if (!root) return;
  const now = Date.now();
  const sig = JSON.stringify([
    todayFingerprint(data, ""),
    loadError,
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
  todosCount.textContent = openTodos ? String(openTodos) : "";
  // Needs you covers every service: the filter belongs to the board in Tasks.
  const needs = data ? visibleNeeds(needsItems(data.tasks, teamsAsks(), commsNeedsNow()), data.todos) : [];
  needsCount.textContent = needs.length ? String(needs.length) : "";
  root.querySelector('[data-rs="needs"]')!.classList.toggle("has-needs", needs.length > 0);
  railNew.needs = needs.length;
  paintRailBadge();
  const banner = needs.length ? `${needs.length} thing${needs.length === 1 ? "" : "s"} need${needs.length === 1 ? "s" : ""} you` : "";
  needsBanner.hidden = !banner;
  if (needsBanner.dataset.text !== banner) {
    needsBanner.dataset.text = banner;
    needsBanner.innerHTML = banner ? `${svg("warning")}<span>${esc(banner)}</span><span class="jv-banner-go">Show</span>` : "";
  }

  if (!data) {
    needsBody.innerHTML = loadingHtml("Today");
    return;
  }
  patchPane(
    needsBody,
    staleNote() + (needs.length ? needs.map((n) => needHtml(n, now)).join("") : `<p class="rs-empty" data-key="none">${esc(SECTIONS[0].empty)}</p>`)
  );
  patchPane(overviewEl, renderOverview(data.tasks, now));
  patchPane(todosBody, renderTodos(todos, now));
  patchPane(noteBody, renderNote(now));
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
    : `<p class="rs-empty" data-key="todo-none">Nothing on your list.</p>`;
  const doneHead = done.length
    ? `<div class="todo-done-head" data-key="todo-done-head">
        <button type="button" class="tu-toggle" data-act="todo-show-done" aria-expanded="${showDoneTodos}">Done · ${done.length}${svg("chevron")}</button>
        ${showDoneTodos ? `<button type="button" class="btn sm ghost todo-clear" data-act="todo-clear-done">Clear done</button>` : ""}
      </div>`
    : "";
  const doneList =
    done.length && showDoneTodos ? `<ul class="todo-list is-done" data-key="todo-done">${done.map((t) => todoRow(t, now, 0, 0)).join("")}</ul>` : "";
  return `${list}${add}${doneHead}${doneList}`;
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
      ? todosBody.querySelector<HTMLElement>(`[data-todo="${added.id}"] .todo-check`)
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
  const input = todosBody.querySelector<HTMLInputElement>(`[data-todo="${todo.id}"] .todo-edit`);
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
    if (refocus) todosBody.querySelector<HTMLElement>(`[data-todo="${id}"] .todo-check`)?.focus();
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
  return `${conflict}${merged}
      <textarea class="quick-note" data-role="quick-note" data-max="480" rows="5" maxlength="${NOTE_MAX_CHARS}" spellcheck="true"
        aria-label="Quick note" placeholder="Anything to keep in mind. Devis and your workers can read it when you ask."${
          note || noteDraft !== null ? "" : " disabled"
        }>
${esc(noteValue())}</textarea>
      <p class="note-foot" data-key="note-foot"><span class="note-state tone-${s.tone}" role="status"${s.title ? ` title="${esc(s.title)}"` : ""}>${esc(s.text)}</span></p>`;
}

/** Repaint just the note's status, so typing doesn't repaint the pane. */
function paintNoteState(): void {
  const label = noteBody?.querySelector<HTMLElement>(".note-state");
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

/** Show a task's row in the rail; one hidden by the service filter is brought into view first. Else open it. */
function jumpToTask(taskId: string): void {
  const find = (): HTMLElement | null => tasksBody.querySelector<HTMLElement>(`.rr[data-task="${CSS.escape(taskId)}"]`);
  const task = data?.tasks.find((t) => t.id === taskId);
  if (!task) return;
  if (!inService(task, service)) {
    service = ALL_SERVICES;
    writePref(SERVICE_KEY, service);
  }
  revealRail("tasks");
  renderToday(true);
  const row = find();
  if (row) return flashInView(row, row.querySelector<HTMLElement>(".rr-main"));
  openDrawer({ kind: "task", taskId });
}

/** Show the first thing a task waits on you for, under Needs you. */
function jumpToNeed(taskId: string): void {
  if (drawer) closeDrawer(false);
  revealRail("needs");
  const item = needsBody.querySelector<HTMLElement>(`.need[data-need="${CSS.escape(taskId)}"]`);
  if (item) return flashInView(item, item.querySelector<HTMLElement>(".need-body button, .need-body textarea, .need-body input"));
  // Taken on as a to-do: that's where it is now. Else the task itself.
  revealRail("todos");
  const todo = todosBody.querySelector<HTMLElement>(`.todo-src[data-src-task="${CSS.escape(taskId)}"]`)?.closest<HTMLElement>(".todo");
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

/** A stable identity for a control across repaints: its owners' ids plus its own role. */
function focusKey(node: HTMLElement): string | null {
  if (!node.matches('button, textarea, input, a[href], [role="button"][tabindex]')) return null;
  const owners = ["data-task", "data-pr", "data-session", "data-request", "data-todo", "data-meet"].map(
    (attr) => node.closest<HTMLElement>(`[${attr}]`)?.getAttribute(attr) || ""
  );
  const own = ["data-draft", "data-act", "data-decide", "data-choice", "data-repos", "data-jump", "data-role", "data-day", "data-index"].map((attr) => node.getAttribute(attr) || "");
  return [...owners, ...own, node.tagName].join("|");
}

/** A group's quiet head inside the rail's Tasks: its name and count. */
const subHead = (title: string, count: number): string =>
  `<h4 class="rr-group" data-key="h">${esc(title)}<span>${count}</span></h4>`;

function reviewedRow(e: JarvisEvent, now: number): string {
  return `
    <div class="rr is-done" data-key="rev:${esc(e.at)}">
      <span class="rr-main" title="Pull request review · ${esc(agoPhrase(e.at, now))}">
        <span class="rdot tone-ok"></span><span class="rr-t ell">${esc(e.text)}</span><span class="rr-tm">${esc(ago(e.at, now))}</span>
      </span>
    </div>`;
}

const SECTION_TONE: Record<BoardSection, string> = { running: "run", idle: "idle", done: "ok" };

/**
 * A task in the rail: its state, title and when it last moved. It opens in the drawer;
 * ✓ marks it done, and ⋯ has the rest (artifacts, status, pull requests, a worker, …).
 */
function taskCard(task: TodayTask, now: number, section: BoardSection): string {
  const asks = taskNeeds([task]);
  const done = task.status === "done";
  const tone = asks.length ? "warn" : task.validation?.attention === "failed" ? "bad" : SECTION_TONE[section];
  const working = task.workers.filter((w) => workerState(w) === "working");
  const workers = task.workers.length
    ? `${task.workers.length} worker${task.workers.length === 1 ? "" : "s"}${working.length ? `, ${working.length} working` : ""}`
    : "No worker yet";
  const tip = [asks.length ? `Needs you: ${asks.map(needLine).join(" · ")}` : "", taskMeta(task), done ? "" : workers].filter(Boolean).join("\n");
  const at = done ? task.doneAt : task.updatedAt;
  const doing = working.find((w) => w.activity);
  const { shown, more } = cardPrs(task.prs);
  const vChip = validationChip(task.validation);
  const cChip = prCommentsChip(task.prComments);
  const bChip = prBuildsChip(task.prBuilds);
  const chips = [
    ...shown.map((p) => {
      const chip = prChipText(p);
      return `<button type="button" class="rr-chip tone-${chip.tone}" data-act="task-prs" title="${esc(p.snapshot?.title || `PR ${p.prId}`)}">${svg("pullRequest")}<span>${esc(chip.text)}</span></button>`;
    }),
    more ? `<button type="button" class="rr-chip" data-act="task-prs" title="All of this task's pull requests">+${more}</button>` : "",
    vChip
      ? `<button type="button" class="rr-chip tone-${vChip.tone}" data-act="task-validation" title="${esc(task.validation?.name || "Validation")}">${svg("flow")}<span>${esc(vChip.text)}</span></button>`
      : "",
    cChip
      ? `<button type="button" class="rr-chip tone-${cChip.tone}" data-act="task-comments" title="Review comments on this task's PRs">${svg("chat")}<span>${esc(cChip.text)}</span></button>`
      : "",
    bChip
      ? `<button type="button" class="rr-chip tone-${bChip.tone}" data-act="task-comments" title="Failed builds on this task's PRs">${svg("pipeline")}<span>${esc(bChip.text)}</span></button>`
      : "",
  ].join("");
  const sub = doing ? `<span class="rr-doing ell">${esc(doing.label)} · ${esc(doing.activity)}</span>` : "";
  return `
    <div class="rr${asks.length ? " needs" : ""}${done ? " is-done" : ""}" data-key="task:${esc(task.id)}" data-task="${esc(task.id)}">
      <button type="button" class="rr-main" data-act="open-task" title="${esc(tip)}">
        <span class="rdot tone-${tone}"></span><span class="rr-t ell">${esc(task.title)}</span><span class="rr-tm">${esc(ago(at, now))}</span>
      </button>
      <span class="rr-ha">
        ${done ? "" : `<button type="button" class="icon-btn" data-act="done" title="Mark done" aria-label="Mark done: ${esc(task.title)}">${svg("check")}</button>`}
        <button type="button" class="icon-btn rr-more" data-act="task-more" title="More" aria-label="More for ${esc(task.title)}" aria-haspopup="menu">⋯</button>
      </span>
      ${sub || chips ? `<div class="rr-p">${sub}${chips}</div>` : ""}
    </div>`;
}

/** ⋯ on a task's row: everything its old card had, as a menu. */
function taskMenu(task: TodayTask, anchor: HTMLElement): void {
  const done = task.status === "done";
  const open = (tab?: LeftTab) => (): void => openDrawer({ kind: "task", taskId: task.id, tab });
  const status = (to: "done" | "open") => (): void =>
    void act(anchor, () => postJSON("/api/jarvis/tasks/update", { id: task.id, status: to }));
  const entries: ContextMenuEntry[] = [
    { label: "Open", icon: "panel", run: open() },
    { label: "Artifacts", icon: "file", run: open("artifacts") },
    { label: "Status updates", icon: "clock", run: open("status") },
    { label: "Pull requests", icon: "pullRequest", run: open("prs") },
    { label: "Validation", icon: "flow", run: open("validation") },
  ];
  if (taskNeeds([task]).length) entries.unshift({ label: "Show what it needs", icon: "warning", run: () => jumpToNeed(task.id) });
  if (done) entries.push({ label: "Reopen", icon: "sync", run: status("open") });
  else {
    entries.push({ label: "Start a worker", icon: "play", run: () => openStartWorker(task) });
    entries.push({ label: "Mark done", icon: "check", run: status("done") });
  }
  const url = task.workItem?.url;
  if (url) entries.push({ label: "Open in Azure DevOps", icon: "external", run: () => void window.open(url, "_blank", "noopener") });
  entries.push({ label: "Remove", icon: "trash", run: () => confirmDeleteTask(task) });
  const r = anchor.getBoundingClientRect();
  openContextMenu(r.right - 200, r.bottom + 4, `Task: ${task.title}`, entries, () => anchor.isConnected && anchor.focus());
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
  const match = (p: PR): boolean => p.org === org && p.project === project && p.repoId === repoId && p.id === id;
  return state.prs.find(match) || state.authoredPrs.find(match) || state.olderPrs.find(match);
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

/** The task drawer's tab each of a task row's actions opens. */
const TASK_TAB: Record<string, LeftTab | undefined> = { artifacts: "artifacts", "all-updates": "status", "task-prs": "prs", "task-validation": "validation", "task-comments": "prs" };

/** After picking a conversation or meeting, the keyboard follows it to the detail. */
function focusDetail(): void {
  const detail = drawerBody.querySelector<HTMLElement>(".ld-detail");
  if (!detail) return;
  detail.scrollTop = 0;
  // A narrow drawer shows the item alone (style.css, @container jvbody): move focus into it.
  const list = drawerBody.querySelector<HTMLElement>(".ld-list");
  if (ldDetail && list && !list.getClientRects().length) detail.focus({ preventScroll: true });
}

/** Inside the task drawer: the task handles its own events. */
const inTask = (e: Event): boolean => !!(e.target as Element).closest?.(".tm-mount");

function onClick(e: MouseEvent): void {
  if (inTask(e)) return;
  const target = e.target as HTMLElement;
  if (target.closest("a[href]")) return;
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
    case "rail-open":
      return setSheet(true);
    case "rail-close":
      return setSheet(false);
    case "rs-fold": {
      const sec = node.closest<HTMLElement>("[data-rs]")?.dataset.rs as RailSection | undefined;
      if (sec) setRailFold(sec, !railFolded.has(sec));
      return;
    }
    case "drawer-close":
      return closeDrawer();
    case "drawer-back":
      return drawerGoBack();
    case "ld-back":
      ldDetail = false;
      renderComms(true);
      return void drawerBody.querySelector<HTMLElement>(".ld-list .sel, .ld-list")?.focus({ preventScroll: true });
    case "chat-select": {
      const key = node.closest<HTMLElement>("[data-chat]")?.dataset.chat;
      if (!key) return;
      selectConversation(key);
      ldDetail = true;
      renderComms(true);
      return focusDetail();
    }
    case "meet-select": {
      const id = node.closest<HTMLElement>("[data-meet]")?.dataset.meet;
      if (!id) return;
      selectMeeting(id, node.closest<HTMLElement>("[data-day]")?.dataset.day);
      ldDetail = true;
      renderComms(true);
      return focusDetail();
    }
    case "comms-open":
    case "meet-open": {
      const comms = node.dataset.act === "comms-open";
      const key = comms ? node.dataset.chat : node.dataset.meet;
      if (key) {
        if (comms) selectConversation(key);
        else selectMeeting(key);
      }
      if (isFlat()) setSheet(false);
      return openDrawer({ kind: comms ? "comms" : "meetings" }, !!key);
    }
    case "task-more": {
      if (task) taskMenu(task, node);
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
      closeDrawer(false);
      return hooks.openSettings();
    case "comms-scan":
      return void scanChatsNow(node);
    case "chat-day":
      toggleChatDay(node.dataset.day || "", node.dataset.today === "1");
      return renderComms(true);
    case "mail-quiet":
      toggleQuietMail(node.dataset.day || "");
      return renderComms(true);
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
    case "open-pr": {
      const pr = prFor(node);
      if (!pr) return;
      // Opening your PR reads its new comments, so the row stops asking for you.
      const unread = inboxItems().filter((n) => n.unread && matchNotificationPr([pr], n));
      if (unread.length) void markPrRead(unread.map((n) => n.id));
      void openDetail(pr);
      return;
    }
    case "copilot-review": {
      const pr = prFor(node);
      if (pr) void queueCopilotReview(pr);
      return;
    }
    case "prs-fold":
      toggleFold(node.dataset.fold);
      return renderPrs(true);
    case "pr-filter":
      toggleFilter(node.dataset.filter);
      return renderPrs(true);
    case "pr-clear":
      clearSearch();
      renderPrs(true);
      return prsBody.querySelector<HTMLInputElement>('[data-role="pr-search"]')?.focus();
    case "prs-more":
      showMore();
      return renderPrs(true);
    case "prs-older":
      return void loadOlder(service, true);
    case "prs-refresh":
      if (node instanceof HTMLButtonElement) node.disabled = true;
      node.setAttribute("aria-busy", "true");
      window.dispatchEvent(new CustomEvent("ado-prs-refresh"));
      return;
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
    case "open-task":
    case "artifacts":
    case "all-updates":
    case "task-prs":
    case "task-validation":
    case "task-comments": {
      if (!task) return;
      const tab = TASK_TAB[node.dataset.act];
      if (isFlat()) setSheet(false);
      return openDrawer({ kind: "task", taskId: task.id, tab });
    }
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
  if (inTask(e)) return;
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
  if (inTask(e)) return;
  const field = e.target as HTMLElement;
  if (!(field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement)) return;
  if (field.dataset.role === "quick-note") onNoteInput(field as HTMLTextAreaElement);
  if (field.dataset.role === "pr-search") {
    setQuery(field.value);
    renderPrs(true);
  }
  if (field.dataset.draft) drafts.set(field.dataset.draft, field.value);
  if (field instanceof HTMLTextAreaElement) autoSize(field);
}

function onKeydown(e: KeyboardEvent): void {
  const target = e.target as HTMLElement;
  if (e.key === "Escape" && !e.defaultPrevented && !e.isComposing && !target.classList.contains("todo-edit")) {
    const typing = (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) && !!target.value;
    if (drawer && !typing && (drawerEl.contains(target) || !target.closest("[data-rs], .jv-rail"))) {
      e.preventDefault();
      return closeDrawer();
    }
    if (root!.classList.contains("sheet-open") && !typing) {
      e.preventDefault();
      return setSheet(false);
    }
  }
  if (inTask(e)) return;
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
  // Alt+arrows on a panel's header (or its grip) move the panel (a select keeps Alt+Down to open).
  if (e.altKey && e.key.startsWith("Arrow") && target.closest(".rs-h, .pn-grip") && !(target instanceof HTMLSelectElement)) {
    const id = target.closest<HTMLElement>("[data-panel]")?.dataset.panel;
    if (isPanelId(id) && keyMove(id, e.key)) e.preventDefault();
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
  if (inTask(e)) return;
  const text = (e.target as HTMLElement).closest(".todo-text");
  const todo = text && todoFor(text);
  if (todo) startTodoEdit(todo);
}

function onFocusOut(e: FocusEvent): void {
  if (inTask(e)) return;
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
      if (res.created && res.worker && data?.tasks.some((t) => t.id === res.task.id)) openDrawer({ kind: "task", taskId: res.task.id });
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
