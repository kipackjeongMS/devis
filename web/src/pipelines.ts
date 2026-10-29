// Pipelines view: a searchable catalog of build pipelines beside a chain canvas.
// A chain is a saved graph of pipeline blocks; arrows mean "runs after". The main
// process runs chains; this view edits them (autosaved), starts and stops runs,
// and polls the active run so the blocks show live status.
import { getJSON, postJSON } from "./api.js";
import { ChainCanvas, PIPELINE_MIME, type BlockAction, type Selection } from "./chainCanvas.js";
import { icon } from "./icons.js";
import {
  activeRemoval,
  blockViews,
  autoLayout,
  canConnect,
  definitionUrl,
  descendants,
  filterPipelines,
  formatElapsed,
  groupPipelines,
  isActive,
  isDefaultValue,
  lastAppBuild,
  latestTone,
  nextNodeId,
  nodeBranchLabel,
  nodeElapsed,
  normalizeBranch,
  paramProblem,
  paramSummary,
  placeNewNode,
  repoBranchFor,
  repoSummary,
  resourceSources,
  runProgress,
  setParam,
  setRepoBranch,
  stages,
  statusLabel,
  statusTone,
  stopCheck,
  timeAgo,
  triggerScope,
  upstreamCandidates,
  type AppBuild,
  type BlockResult,
  type CatalogPipeline,
  type ChainGraph,
  type ChainNode,
  type ChainRun,
  type ChainSummary,
  type DefinitionInfo,
  type NodeRunState,
  type RepositoryResource,
  type RunParameter,
} from "./pipelineModel.js";
import { openActionDialog } from "./prActions.js";
import { paneZoomCommand } from "./shellModel.js";
import { toast } from "./toast.js";
import { esc } from "./util.js";

export interface PipelinesHooks {
  openSettings(): void;
}

interface ChainDoc {
  id: string | null;
  name: string;
  graph: ChainGraph;
  dirty: boolean;
  version: number;
  saveError: string | null;
  /** The server's updatedAt for what this document was loaded or last saved as. */
  updatedAt: string | null;
}

type SaveState = "idle" | "saving" | "saved" | "error";

const INSPECTOR_FOCUS_ATTRS = [
  "data-select",
  "data-unlink",
  "data-remove-node",
  "data-remove-edge",
  "data-block-action",
  "data-param",
  "data-param-reset",
  "data-param-remove",
  "data-params-clear",
  "data-params-reload",
  "data-repo",
  "data-repo-remove",
  "data-repos-clear",
  "data-repos-reload",
];
const INSPECTOR_FOCUS_CLASSES = ["insp-close", "insp-add-up", "insp-branch", "insp-follow", "insp-link", "insp-params-summary", "insp-repos-summary"];

const MAX_NODES = 50;
const MAX_ROWS = 300;
const UNDO_LIMIT = 50;
const SAVE_DELAY = 600;
const RUN_POLL_MS = 3000;
const SUMMARY_POLL_MS = 10000;
const INFO_DELAY = 500;
const LAST_CHAIN_KEY = "adoPrOps.pipelines.lastChain";

let hooks: PipelinesHooks = { openSettings: () => {} };
let root: HTMLElement | null = null;
let canvas: ChainCanvas;
let visible = false;

let catalog: CatalogPipeline[] = [];
let catalogByKey = new Map<string, CatalogPipeline>();
let catalogErrors: string[] = [];
let unscopedOrgs: string[] = [];
let catalogLoaded = false;
let catalogToken = 0;
let query = "";
let scope = "";
let catalogSig = "";

let chains: ChainSummary[] = [];
/** A chain to open once the chain list loads (asked for from a task). */
let pendingChain: string | null = null;
/** The task's PRs a block of its validation chain can follow, per task. */
const ownerPrs = new Map<string, { status: "loading" | "ready" | "error"; prs: OwnerPr[]; error?: string }>();
let doc: ChainDoc = emptyDoc();
let run: ChainRun | null = null;
let selection: Selection = null;
let openToken = 0;

let undoStack: ChainGraph[] = [];
let redoStack: ChainGraph[] = [];
let lastUndoKey = "";
let lastUndoAt = 0;
/** Typing in one inspector field (branch or a parameter) undoes as one step. */
let fieldUndoPushed = false;

// What each pipeline takes at run time, per branch: its parameters and the pipelines it consumes.
type InfoEntry = { status: "loading" } | { status: "ready"; info: DefinitionInfo } | { status: "error"; error: string };
const infoCache = new Map<string, InfoEntry>();
let infoTimer = 0;
let paramsOpen = false;
let reposOpen = false;

let saveTimer = 0;
let saveQueue: Promise<void> = Promise.resolve();
let runSig = "";
let lastOverlay: Record<string, NodeRunState> | null = null;

// What the chain's blocks did in its earlier runs, so every block keeps its own last result no
// matter which block was run since: the builds a block consumes (appBuilds) and each block's
// last result (results). Refetched when the chain or its run changes.
let appBuilds: AppBuild[] = [];
let results: BlockResult[] = [];
let buildsKey = "";
let buildsChain: string | null = null;

let pollTimer = 0;
let tickTimer = 0;
let summaryTimer = 0;

// ---- elements -----------------------------------------------------------------------------

let searchInput: HTMLInputElement;
let scopeSelect: HTMLSelectElement;
let catalogCount: HTMLElement;
let catalogNotes: HTMLElement;
let catalogList: HTMLElement;
let picker: HTMLSelectElement;
let nameInput: HTMLInputElement;
let saveStatus: HTMLElement;
let zoomLevel: HTMLButtonElement;
let runChip: HTMLElement;
let runBtn: HTMLButtonElement;
let deleteBtn: HTMLButtonElement;
let emptyHint: HTMLElement;
let inspector: HTMLElement;
let live: HTMLElement;
let ownerBar: HTMLElement;

interface OwnerPr {
  org: string;
  prId: number;
  title: string;
  sourceRef: string;
  status: string;
}

// ---- public API ---------------------------------------------------------------------------

export function showPipelines(h: PipelinesHooks): void {
  hooks = h;
  const first = !root;
  if (first) mount();
  visible = true;
  document.addEventListener("keydown", onGlobalKey);
  if (first) {
    void loadCatalog(false);
    void loadChains(true);
  } else {
    void loadChains(false);
    if (run?.status === "running") void pollRun();
  }
  syncTimers();
}

export function hidePipelines(): void {
  if (!root || !visible) return;
  visible = false;
  document.removeEventListener("keydown", onGlobalKey);
  void flushSave();
  syncTimers();
}

/** Reload the catalog (bypassing the server cache when `refresh`), the chain list, and the run. */
export function reloadPipelines(refresh = false): void {
  if (!root) return;
  void loadCatalog(refresh);
  void loadChains(false);
  if (run) void pollRun();
}

/** Show this chain when Pipelines next loads its chains (call before showing Pipelines). */
export function showChainById(id: string): void {
  pendingChain = id;
}

// ---- mount --------------------------------------------------------------------------------

function mount(): void {
  root = document.getElementById("pipelinesView")!;
  root.innerHTML = `
    <aside class="pipeline-catalog" aria-label="Pipeline catalog">
      <div class="catalog-head">
        <h1 class="list-title">Pipelines</h1>
        <span class="count catalog-count" aria-live="polite"></span>
      </div>
      <div class="catalog-tools">
        <label class="catalog-search">${icon("search")}
          <input type="search" placeholder="Search pipelines" aria-label="Search pipelines" title="Search pipelines (Ctrl+F)" spellcheck="false" autocomplete="off">
        </label>
        <select class="filter-select catalog-scope" aria-label="Project"></select>
      </div>
      <div class="catalog-notes"></div>
      <div class="catalog-list"></div>
    </aside>
    <section class="chain-pane" aria-label="Chain editor">
      <div class="chain-toolbar">
        <div class="chain-toolbar-doc">
          <select class="filter-select chain-picker" id="chainPicker" aria-label="Chain"></select>
          <button type="button" class="icon-btn chain-new" title="New chain" aria-label="New chain">${icon("add")}</button>
          <span class="chain-sep" aria-hidden="true"></span>
          <input class="chain-name" maxlength="120" placeholder="Untitled chain" aria-label="Chain name" spellcheck="false" autocomplete="off">
          <span class="chain-save" aria-live="polite"></span>
        </div>
        <div class="chain-toolbar-run">
          <span class="chain-run-chip" role="status" hidden></span>
          <button type="button" class="btn accent chain-run"></button>
          <button type="button" class="icon-btn chain-delete" title="Delete chain" aria-label="Delete chain">${icon("trash")}</button>
        </div>
        <div class="chain-owner" role="note" hidden></div>
      </div>
      <div class="chain-body">
        <div class="chain-stage">
          <div class="chain-empty" hidden>
            <span class="chain-empty-icon">${icon("flow")}</span>
            <p class="chain-empty-title">Drag pipelines here</p>
            <p class="chain-empty-text">Then drag from a block's right edge onto another block to run it next.</p>
          </div>
          <div class="chain-zoom" role="group" aria-label="View">
            <button type="button" class="icon-btn" data-zoom="-1" title="Zoom out (Ctrl+−)" aria-label="Zoom out">${icon("minus")}</button>
            <button type="button" class="chain-zoom-level" title="Reset to 100% (Ctrl+0)" aria-label="Reset zoom">100%</button>
            <button type="button" class="icon-btn" data-zoom="1" title="Zoom in (Ctrl+=)" aria-label="Zoom in">${icon("add")}</button>
            <span class="chain-sep" aria-hidden="true"></span>
            <button type="button" class="icon-btn" data-act="fit" title="Fit to view" aria-label="Fit to view">${icon("fit")}</button>
            <button type="button" class="icon-btn" data-act="tidy" title="Tidy layout" aria-label="Tidy layout">${icon("tidy")}</button>
          </div>
        </div>
        <aside class="chain-inspector" aria-label="Chain details"></aside>
      </div>
      <div class="visually-hidden chain-live" aria-live="polite"></div>
    </section>`;

  const q = <T extends Element>(sel: string): T => root!.querySelector<T>(sel)!;
  searchInput = q("input[type=search]");
  scopeSelect = q(".catalog-scope");
  catalogCount = q(".catalog-count");
  catalogNotes = q(".catalog-notes");
  catalogList = q(".catalog-list");
  picker = q(".chain-picker");
  nameInput = q(".chain-name");
  saveStatus = q(".chain-save");
  zoomLevel = q(".chain-zoom-level");
  runChip = q(".chain-run-chip");
  runBtn = q(".chain-run");
  deleteBtn = q(".chain-delete");
  emptyHint = q(".chain-empty");
  inspector = q(".chain-inspector");
  live = q(".chain-live");
  ownerBar = q(".chain-owner");
  ownerBar.addEventListener("click", (e) => void onOwnerClick(e));

  canvas = new ChainCanvas({
    onSelect: (sel) => {
      selection = sel;
      renderInspector();
    },
    onMove: moveNode,
    onConnect: connect,
    onRemove: remove,
    onDrop: (payload, at) => {
      const p = parsePayload(payload);
      if (p) addPipeline(p, at);
    },
    onReject: (reason) => toast(reason, "err"),
    onView: (v) => {
      zoomLevel.textContent = `${Math.round(v.zoom * 100)}%`;
    },
    blockAction,
    onBlockAction: (id, kind) => (kind === "run" ? confirmTrigger(id) : confirmStopNode(id)),
  });
  q(".chain-stage").prepend(canvas.el);

  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    renderCatalogList();
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && searchInput.value) {
      e.preventDefault();
      searchInput.value = query = "";
      renderCatalogList();
    }
  });
  scopeSelect.addEventListener("change", () => {
    scope = scopeSelect.value;
    renderCatalogList();
  });
  catalogNotes.addEventListener("click", (e) => {
    if ((e.target as Element).closest(".catalog-settings")) hooks.openSettings();
  });
  catalogList.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>(".catalog-add");
    const p = btn && catalogByKey.get(btn.dataset.key!);
    if (p) addPipeline(p);
  });
  catalogList.addEventListener("dblclick", (e) => {
    const t = e.target as Element;
    const row = t.closest<HTMLElement>(".catalog-row");
    const p = row && !t.closest(".catalog-add") && catalogByKey.get(row.dataset.key!);
    if (p) addPipeline(p);
  });
  catalogList.addEventListener("dragstart", (e) => {
    const row = (e.target as Element).closest<HTMLElement>(".catalog-row");
    const p = row && catalogByKey.get(row.dataset.key!);
    if (!p || !e.dataTransfer) return e.preventDefault();
    e.dataTransfer.setData(PIPELINE_MIME, JSON.stringify(p));
    e.dataTransfer.effectAllowed = "copy";
  });

  picker.addEventListener("change", () => void switchTo(picker.value || null));
  q(".chain-new").addEventListener("click", () => void switchTo(null));
  nameInput.addEventListener("input", () => {
    doc.name = nameInput.value;
    markDirty();
    renderPicker();
  });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") nameInput.blur();
  });
  saveStatus.addEventListener("click", (e) => {
    if ((e.target as Element).closest(".chain-save-retry")) void flushSave();
  });
  runBtn.addEventListener("click", () => (isRunning() ? confirmStop() : confirmRun()));
  deleteBtn.addEventListener("click", confirmDelete);

  q(".chain-zoom").addEventListener("click", (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>("button");
    if (!btn) return;
    if (btn === zoomLevel) canvas.zoomStep(0);
    else if (btn.dataset.zoom) canvas.zoomStep(Number(btn.dataset.zoom) as 1 | -1);
    else if (btn.dataset.act === "fit") canvas.fit();
    else if (btn.dataset.act === "tidy") tidy();
  });

  inspector.addEventListener("click", onInspectorClick);
  inspector.addEventListener("change", onInspectorChange);
  inspector.addEventListener("input", onInspectorInput);
  inspector.addEventListener("focusin", (e) => {
    if ((e.target as Element).matches(".insp-branch, [data-param], [data-repo]")) fieldUndoPushed = false;
  });
  // `toggle` doesn't bubble, so listen in the capture phase.
  inspector.addEventListener(
    "toggle",
    (e) => {
      const t = e.target;
      if (t instanceof HTMLDetailsElement && t.classList.contains("insp-params")) paramsOpen = t.open;
      if (t instanceof HTMLDetailsElement && t.classList.contains("insp-repos")) reposOpen = t.open;
    },
    true
  );

  renderAll();
}

// ---- data loading -------------------------------------------------------------------------

async function loadCatalog(refresh: boolean): Promise<void> {
  const token = ++catalogToken;
  if (!catalogLoaded) catalogList.innerHTML = `<div class="loading"><span class="spinner"></span>Loading pipelines…</div>`;
  root?.classList.add("catalog-busy");
  try {
    const res = await getJSON(`/api/pipelines${refresh ? "?refresh=1" : ""}`);
    if (token !== catalogToken) return;
    catalog = res.pipelines || [];
    catalogErrors = res.errors || [];
    unscopedOrgs = res.unscopedOrgs || [];
  } catch (e) {
    if (token !== catalogToken) return;
    catalogErrors = [errorText(e)];
  } finally {
    if (token === catalogToken) root?.classList.remove("catalog-busy");
  }
  catalogLoaded = true;
  catalogByKey = new Map(catalog.map((p) => [catalogKey(p), p]));
  renderScope();
  renderCatalogNotes();
  renderCatalogList();
}

async function loadChains(openInitial: boolean): Promise<void> {
  try {
    const res = await getJSON("/api/pipeline-chains");
    chains = res.chains || [];
  } catch (e) {
    if (openInitial) toast(`Couldn't load chains: ${errorText(e)}`, "err");
    return;
  }
  renderPicker();
  syncTimers();
  if (pendingChain && chains.some((c) => c.id === pendingChain)) {
    const id = pendingChain;
    pendingChain = null;
    // Asked for from its task, which may have just replaced it: read it fresh even when it's open.
    if (id === doc.id) {
      await flushSave();
      await openChain(id);
    } else await switchTo(id);
    return;
  }
  // The open chain changed elsewhere (a task accepted a proposal into it, or another window): show that.
  const open = doc.id ? chains.find((c) => c.id === doc.id) : undefined;
  if (open && !doc.dirty && doc.updatedAt && open.updatedAt > doc.updatedAt) {
    await openChain(open.id);
    announce("This chain changed elsewhere; showing the saved version");
  }
  if (!openInitial) return;
  const running = chains.find((c) => c.lastRun?.status === "running");
  const last = localStorage.getItem(LAST_CHAIN_KEY);
  const target = running || chains.find((c) => c.id === last) || mostRecent();
  if (target) await openChain(target.id);
}

async function openChain(id: string): Promise<void> {
  const token = ++openToken;
  try {
    const res = await getJSON(`/api/pipeline-chain?id=${encodeURIComponent(id)}`);
    if (token !== openToken) return;
    const c = res.chain;
    setDoc({ id: c.id, name: c.name, graph: c.graph, dirty: false, version: 0, saveError: null, updatedAt: c.updatedAt ?? null }, res.run || null);
  } catch (e) {
    if (token !== openToken) return;
    toast(`Couldn't open the chain: ${errorText(e)}`, "err");
    renderPicker();
  }
}

function openDraft(): void {
  openToken++;
  setDoc(emptyDoc(), null);
  nameInput.focus();
}

function setDoc(next: ChainDoc, nextRun: ChainRun | null): void {
  doc = next;
  run = nextRun;
  selection = null;
  undoStack = [];
  redoStack = [];
  lastUndoKey = "";
  setSaveState("idle");
  if (doc.id) localStorage.setItem(LAST_CHAIN_KEY, doc.id);
  canvas.setGraph(doc.graph);
  canvas.setSelection(null);
  canvas.fit(false);
  renderAll();
}

async function switchTo(id: string | null): Promise<void> {
  if (id && id === doc.id) return;
  if (!(await flushSave())) {
    toast("Couldn't save this chain, so it stays open. Retry the save first.", "err");
    renderPicker();
    return;
  }
  if (id) await openChain(id);
  else openDraft();
}

// ---- saving -------------------------------------------------------------------------------

function emptyDoc(): ChainDoc {
  return { id: null, name: "", graph: { nodes: [], edges: [] }, dirty: false, version: 0, saveError: null, updatedAt: null };
}

const isEmptyDraft = (d: ChainDoc): boolean => d.id === null && !d.graph.nodes.length && !d.name.trim();

function markDirty(): void {
  doc.dirty = true;
  doc.version++;
  window.clearTimeout(saveTimer);
  if (isEmptyDraft(doc)) return setSaveState("idle");
  setSaveState("saving");
  saveTimer = window.setTimeout(() => void flushSave(), SAVE_DELAY);
}

/** Save now (after any save in flight); resolves true when the document is saved. */
function flushSave(): Promise<boolean> {
  window.clearTimeout(saveTimer);
  const target = doc;
  saveQueue = saveQueue.then(() => doSave(target));
  return saveQueue.then(() => !target.dirty || isEmptyDraft(target));
}

async function doSave(target: ChainDoc): Promise<void> {
  if (!target.dirty || isEmptyDraft(target)) return;
  const version = target.version;
  if (target === doc) setSaveState("saving");
  try {
    const res = await postJSON("/api/pipeline-chains/save", {
      id: target.id ?? undefined,
      name: target.name,
      graph: target.graph,
      // The version this edit was made on: the server refuses it over a newer one.
      updatedAt: target.updatedAt ?? undefined,
    });
    const chain = res.chain;
    target.id = chain.id;
    target.updatedAt = chain.updatedAt ?? target.updatedAt;
    target.saveError = null;
    if (target.version === version) target.dirty = false;
    const prev = chains.find((c) => c.id === chain.id);
    chains = [
      ...chains.filter((c) => c.id !== chain.id),
      { id: chain.id, name: chain.name, nodeCount: chain.graph.nodes.length, updatedAt: chain.updatedAt, lastRun: prev?.lastRun ?? null, owner: prev?.owner ?? null },
    ].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    if (target === doc) {
      localStorage.setItem(LAST_CHAIN_KEY, chain.id);
      if (!target.dirty) setSaveState("saved");
      renderPicker();
      renderToolbar();
      // The runner applies the edit to the live run right away; show it without waiting a poll.
      if (isRunning()) window.setTimeout(() => void pollRun(), 300);
    }
  } catch (e) {
    target.saveError = errorText(e);
    if (target === doc && target.id && /before removing it/.test(target.saveError) && (await restoreSaved(target))) return;
    if (target === doc && target.id && /changed elsewhere/.test(target.saveError)) {
      toast("This chain changed elsewhere since you opened it, so your last edit wasn't saved. Showing the saved version.", "err");
      await openChain(target.id);
      return;
    }
    if (target === doc) setSaveState("error");
  }
}

/**
 * The server refused an edit that drops a block now building in Azure DevOps (it started
 * after the edit was made). Put the saved chain back so later saves don't keep failing.
 */
async function restoreSaved(target: ChainDoc): Promise<boolean> {
  const reason = target.saveError || "";
  let res: { chain: { name: string; graph: ChainGraph; updatedAt?: string }; run?: ChainRun | null };
  try {
    res = await getJSON(`/api/pipeline-chain?id=${encodeURIComponent(target.id!)}`);
  } catch {
    return false;
  }
  if (target !== doc) return false;
  doc.graph = res.chain.graph;
  doc.updatedAt = res.chain.updatedAt ?? doc.updatedAt;
  doc.saveError = null;
  run = res.run || null;
  if (selection && !selectionExists(selection)) {
    selection = null;
    canvas.setSelection(null);
  }
  canvas.setGraph(doc.graph);
  if (doc.name !== res.chain.name) markDirty();
  else {
    doc.dirty = false;
    setSaveState("saved");
  }
  renderRun();
  renderEmptyHint();
  toast(`${reason} Your change was undone.`, "err");
  announce("The change was undone");
  return true;
}

function setSaveState(state: SaveState): void {
  if (!saveStatus) return;
  saveStatus.className = `chain-save is-${state}`;
  saveStatus.removeAttribute("title");
  if (state === "saving") saveStatus.textContent = "Saving…";
  else if (state === "saved") saveStatus.textContent = "Saved";
  else if (state === "error") {
    saveStatus.title = doc.saveError || "";
    saveStatus.innerHTML = `${icon("warning")}<span>Couldn't save</span><button type="button" class="btn ghost sm chain-save-retry">Retry</button>`;
  } else saveStatus.textContent = "";
}

// ---- editing ------------------------------------------------------------------------------

const cloneGraph = (g: ChainGraph): ChainGraph => ({ nodes: g.nodes.map((n) => ({ ...n })), edges: g.edges.map((e) => ({ ...e })) });

/** Remember the graph before an edit. Edits sharing `key` within a second undo together. */
function pushUndo(key = ""): void {
  const now = Date.now();
  const merge = key && key === lastUndoKey && now - lastUndoAt < 1000;
  lastUndoKey = key;
  lastUndoAt = now;
  if (merge) return;
  undoStack.push(cloneGraph(doc.graph));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack = [];
}

function commit(graph: ChainGraph, renderDetails = true): void {
  doc.graph = graph;
  const overlay = overlayStates();
  if (overlay !== lastOverlay) {
    lastOverlay = overlay;
    canvas.setRun(overlay, liveIds());
  }
  canvas.setGraph(graph);
  if (selection && !selectionExists(selection)) {
    selection = null;
    canvas.setSelection(null);
  }
  markDirty();
  if (renderDetails) renderInspector();
  renderToolbar();
  renderEmptyHint();
  syncCatalogMarks();
}

function selectionExists(sel: NonNullable<Selection>): boolean {
  if (sel.kind === "node") return doc.graph.nodes.some((n) => n.id === sel.id);
  return doc.graph.edges.some((e) => e.from === sel.from && e.to === sel.to);
}

/** Refuses an edit that would take a block out of the live run while it builds in Azure DevOps. */
function guardRemoval(next: ChainGraph): boolean {
  const name = activeRemoval(liveRun(), next);
  if (!name) return false;
  toast(`Stop "${name}" before removing it. It's running in Azure DevOps.`, "err");
  return true;
}

function addPipeline(p: CatalogPipeline, at?: { x: number; y: number }): void {
  const nodes = doc.graph.nodes;
  if (nodes.length >= MAX_NODES) return toast(`A chain can hold up to ${MAX_NODES} pipelines.`, "err");
  pushUndo();
  const id = nextNodeId(nodes);
  const pos = placeNewNode(nodes, at);
  const node: ChainNode = { id, org: p.org, project: p.project, definitionId: p.id, name: p.name, path: p.path || "", branch: "", ...pos };
  selection = { kind: "node", id };
  commit({ nodes: [...nodes.map((n) => ({ ...n })), node], edges: doc.graph.edges.map((e) => ({ ...e })) });
  canvas.setSelection(selection);
  if (!at && nodes.length === 0) canvas.fit();
  else requestAnimationFrame(() => canvas.reveal(id));
  announce(`Added ${p.name}`);
}

function moveNode(id: string, x: number, y: number): void {
  pushUndo(`move:${id}`);
  const graph = cloneGraph(doc.graph);
  const n = graph.nodes.find((node) => node.id === id);
  if (!n) return;
  Object.assign(n, { x, y });
  commit(graph, false);
}

function connect(from: string, to: string): void {
  const verdict = canConnect(doc.graph, from, to);
  if (!verdict.ok) return toast(verdict.reason || "Those blocks cannot be connected", "err");
  pushUndo();
  const graph = cloneGraph(doc.graph);
  graph.edges.push({ from, to });
  commit(graph);
  announce(`${nodeName(to)} now runs after ${nodeName(from)}`);
}

function remove(sel: NonNullable<Selection>): void {
  const graph = cloneGraph(doc.graph);
  let msg: string;
  if (sel.kind === "node") {
    msg = `Removed ${nodeName(sel.id)}`;
    graph.nodes = graph.nodes.filter((n) => n.id !== sel.id);
    graph.edges = graph.edges.filter((e) => e.from !== sel.id && e.to !== sel.id);
  } else {
    graph.edges = graph.edges.filter((e) => !(e.from === sel.from && e.to === sel.to));
    msg = "Removed the arrow";
  }
  if (guardRemoval(graph)) return;
  pushUndo();
  announce(msg);
  selection = null;
  canvas.setSelection(null);
  commit(graph);
  canvas.el.focus({ preventScroll: true });
}

function tidy(): void {
  if (!doc.graph.nodes.length) return;
  pushUndo();
  commit({ nodes: autoLayout(cloneGraph(doc.graph).nodes, doc.graph.edges), edges: doc.graph.edges.map((e) => ({ ...e })) }, false);
  canvas.fit();
}

function undo(): void {
  const prev = undoStack[undoStack.length - 1];
  if (!prev || guardRemoval(prev)) return;
  undoStack.pop();
  redoStack.push(cloneGraph(doc.graph));
  lastUndoKey = "";
  commit(prev);
  announce("Undid the last change");
}

function redo(): void {
  const next = redoStack[redoStack.length - 1];
  if (!next || guardRemoval(next)) return;
  redoStack.pop();
  undoStack.push(cloneGraph(doc.graph));
  lastUndoKey = "";
  commit(next);
  announce("Redid the change");
}

function parsePayload(payload: string): CatalogPipeline | null {
  try {
    const p = JSON.parse(payload);
    if (p && typeof p.org === "string" && typeof p.project === "string" && Number.isInteger(p.id) && typeof p.name === "string") return p;
  } catch {
    /* not ours */
  }
  return null;
}

// ---- runs ---------------------------------------------------------------------------------

const isRunning = (): boolean => run?.status === "running";

/**
 * The result painted on each block: its state in the newest run if that run has it, otherwise
 * what it last did in an earlier run. Returns the previous object while nothing changed.
 */
function overlayStates(): Record<string, NodeRunState> | null {
  const views = blockViews(doc.graph, run, results);
  const ids = Object.keys(views);
  if (!ids.length) return null;
  const prev = lastOverlay;
  if (prev && Object.keys(prev).length === ids.length && ids.every((id) => prev[id] === views[id].state)) return prev;
  return Object.fromEntries(ids.map((id) => [id, views[id].state]));
}

/** The blocks of the run in progress; the rest are dimmed but keep their last result. */
const liveIds = (): ReadonlySet<string> | null => (run && isRunning() ? new Set(Object.keys(run.states)) : null);

function paintRun(): void {
  lastOverlay = overlayStates();
  canvas.setRun(lastOverlay, liveIds());
}

function confirmRun(): void {
  if (!doc.graph.nodes.length) return;
  const order = stages(doc.graph);
  const total = doc.graph.nodes.length;
  const issues = paramIssues(doc.graph.nodes.map((n) => n.id));
  const body = `
    <p class="pa-note">${total === 1 ? "Queues 1 pipeline." : `Queues ${total} pipelines in ${order.length} ${order.length === 1 ? "stage" : "stages"}. Each stage starts once every pipeline before it passes; a failure skips everything after it.`}</p>
    ${stageListHtml(order)}
    ${issues.length ? `<ul class="run-confirm-notes">${issues.join("")}</ul>` : ""}
    <p class="pa-note">Keep Devis open until the chain finishes. The app queues each next pipeline.</p>`;
  openActionDialog({
    title: "Run chain",
    loc: chainTitle(),
    body,
    confirmLabel: "Run chain",
    onConfirm: async () => {
      if (!(await flushSave())) throw new Error(`Couldn't save the chain: ${doc.saveError || "unknown error"}`);
      const res = await postJSON("/api/pipeline-chains/run", { id: doc.id });
      run = res.run;
      renderRun();
      void loadChains(false);
      toast("Chain started", "ok");
      announce("Chain started");
    },
  });
}

function confirmStop(): void {
  if (!run || run.cancelRequested) return;
  const runId = run.runId;
  openActionDialog({
    title: "Stop run",
    loc: chainTitle(),
    body: `<p class="pa-note">Cancels the builds this run queued in Azure DevOps and skips the pipelines that haven't started.</p>`,
    confirmLabel: "Stop run",
    danger: true,
    onConfirm: async () => {
      const res = await postJSON("/api/pipeline-runs/cancel", { runId });
      if (run?.runId === runId) {
        run = res.run;
        renderRun();
      }
      announce("Stopping the run");
    },
  });
}

function stageListHtml(order: string[][]): string {
  return `<ol class="run-confirm">${order
    .map(
      (ids, i) => `<li><span class="run-confirm-stage">Stage ${i + 1}</span><ul>${ids
        .map((id) => {
          const n = nodeById(id)!;
          const set = n.params ? Object.keys(n.params).length : 0;
          const params = set ? `<span class="run-confirm-meta">${icon("settings")}${set} ${set === 1 ? "parameter" : "parameters"}</span>` : "";
          const repoSet = Object.keys(n.repoBranches ?? {}).length;
          const repos = repoSet ? `<span class="run-confirm-meta">${icon("folder")}${repoSet} ${repoSet === 1 ? "repository branch" : "repository branches"}</span>` : "";
          return `<li><span class="run-confirm-name">${esc(n.name)}</span><span class="run-confirm-branch">${icon("branch")}${esc(nodeBranchLabel(n))}</span>${params}${repos}</li>`;
        })
        .join("")}</ul></li>`
    )
    .join("")}</ol>`;
}

/** Blocks whose parameters or repository branches the runner would refuse, as dialog notes (only for pipelines already read). */
function paramIssues(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const n = nodeById(id);
    const entry = n && infoCache.get(infoKey(n));
    if (!n || entry?.status !== "ready") continue;
    const sum = paramSummary(entry.info.parameters, n.params);
    const bad = sum.invalid + sum.stale.length;
    if (bad) {
      out.push(
        `<li><b>${esc(n.name)}</b> has ${bad === 1 ? "a parameter" : `${bad} parameters`} to fix. It fails when its turn comes unless you fix ${bad === 1 ? "it" : "them"} first.</li>`
      );
    }
    const repoSet = Object.keys(n.repoBranches ?? {}).length;
    const repoBad = entry.info.yaml ? repoSummary(entry.info.repositories ?? [], n.repoBranches).stale.length : repoSet;
    if (repoBad) {
      out.push(
        `<li><b>${esc(n.name)}</b> has ${repoBad === 1 ? "a repository branch for a repository" : `${repoBad} repository branches for repositories`} its YAML doesn't use. It fails when its turn comes unless you remove ${repoBad === 1 ? "it" : "them"} first.</li>`
      );
    }
  }
  return out;
}

// ---- per-block run and stop ---------------------------------------------------------------
// A chain has at most one live run. "Run from here" on an idle chain starts a run of just the
// block and everything after it; on a running chain it joins that run, so a block fed by two
// arrows waits for both and runs once. The runner applies both commands, so they never race it.

const liveRun = (): ChainRun | null => (isRunning() ? run : null);

// Uses the chain as edited: the trigger saves first, and the runner applies a save before a trigger.
function scopeFor(id: string): ReturnType<typeof triggerScope> {
  const live = liveRun();
  return triggerScope(doc.graph, live?.states ?? null, id, !!live?.cancelRequested);
}

/** The pill floated over the selected block: Stop while it runs, otherwise Run from here. */
function blockAction(id: string): BlockAction | null {
  if (!nodeById(id)) return null;
  const live = liveRun();
  const s = live?.states[id];
  if (live && s && isActive(s.status)) {
    const check = stopCheck(s);
    return { kind: "stop", label: s.stopRequested ? "Stopping…" : "Stop", title: check.ok ? "Cancel this pipeline's build" : check.reason!, disabled: !check.ok };
  }
  if (live && scopeFor(id).blocked) return null;
  const title = live ? "Start this pipeline in the running chain, then everything after it" : "Run this pipeline, then everything after it";
  return { kind: "run", label: "Run from here", title, disabled: false };
}

function confirmTrigger(id: string): void {
  const n = nodeById(id);
  if (!n) return;
  const live = liveRun();
  const scope = scopeFor(id);
  if (scope.blocked) {
    toast(scope.blocked, "err");
    return;
  }
  const inScope = new Set(scope.ids);
  const order = stages(doc.graph).map((ids) => ids.filter((x) => inScope.has(x))).filter((ids) => ids.length);
  const b = (x: string): string => `<b>${esc(nodeName(x))}</b>`;
  const rest = scope.ids.length - 1;
  const follow = rest === 1 ? "The block after it starts" : `Each of the ${rest} blocks after it starts`;
  const then = rest ? ` ${follow} once everything it waits for in this run passes.` : "";
  const lead = live
    ? `Queues ${b(id)} in the running chain.${then}`
    : `Queues ${b(id)} now.${then} Blocks before it don't run and aren't waited for.`;
  const notes = [
    ...scope.waits.map((w) => `<li>${b(w.id)} also waits for ${w.on.map(b).join(", ")}, already in this run.</li>`),
    ...scope.skips.map(
      (s) => `<li>${b(s.id)} will be skipped: ${b(s.because)} ${inScope.has(s.because) ? "is skipped" : "didn't pass in this run"}.</li>`
    ),
    ...paramIssues(scope.ids),
  ];
  openActionDialog({
    title: "Run from here",
    loc: `${chainTitle()} · ${n.name}`,
    body: `<p class="pa-note">${lead}</p>
      ${stageListHtml(order)}
      ${notes.length ? `<ul class="run-confirm-notes">${notes.join("")}</ul>` : ""}
      <p class="pa-note">Keep Devis open until the chain finishes. The app queues each next pipeline.</p>`,
    confirmLabel: "Run from here",
    onConfirm: async () => {
      if (!(await flushSave())) throw new Error(`Couldn't save the chain: ${doc.saveError || "unknown error"}`);
      const res = await postJSON("/api/pipeline-chains/trigger", { id: doc.id, nodeId: id });
      run = res.run;
      renderRun();
      void loadChains(false);
      const msg = res.pending
        ? `Requested. "${n.name}" starts on the runner's next check.`
        : live
          ? `Added "${n.name}" to the running chain`
          : `Started from "${n.name}"`;
      toast(msg, "ok");
      announce(msg);
    },
  });
}

function confirmStopNode(id: string): void {
  const live = liveRun();
  if (!live) return;
  const s = live.states[id];
  const check = stopCheck(s);
  if (!check.ok) {
    toast(check.reason!, "err");
    return;
  }
  const runId = live.runId;
  const name = nodeName(id);
  const doomed = descendants(live.graph, id).filter((x) => live.states[x]?.status === "waiting");
  openActionDialog({
    title: "Stop pipeline",
    loc: `${chainTitle()} · ${name}`,
    body: `<p class="pa-note">Cancels build ${esc(s.buildNumber || `#${s.buildId}`)} of <b>${esc(name)}</b> in Azure DevOps. Other branches of the chain keep running.</p>
      ${doomed.length
        ? `<p class="pa-note">${doomed.length === 1 ? "This block waits for it and will be skipped:" : "These blocks wait for it and will be skipped:"}</p>
           <ul class="run-confirm-notes">${doomed.map((x) => `<li><b>${esc(nodeName(x))}</b></li>`).join("")}</ul>`
        : ""}
      <p class="pa-note">Once it stops, select it and choose Run from here to run it again.</p>`,
    confirmLabel: "Stop pipeline",
    danger: true,
    onConfirm: async () => {
      const res = await postJSON("/api/pipeline-runs/stop-node", { runId, nodeId: id });
      if (run?.runId === runId) {
        run = res.run;
        renderRun();
      }
      const msg = res.pending ? `Stop requested. "${name}" stops on the runner's next check.` : `Stopping "${name}"`;
      if (res.pending) toast(msg, "ok");
      announce(msg);
    },
  });
}

function confirmDelete(): void {
  if (!doc.id || isRunning()) return;
  const id = doc.id;
  openActionDialog({
    title: "Delete chain",
    loc: chainTitle(),
    body: `<p class="pa-note">Removes this chain and its run history from Devis. The pipelines in Azure DevOps aren't changed.${
      ownerOf(id) ? ` It's the validation of the task "${esc(ownerOf(id)!.title)}"; the task keeps going without one.` : ""
    }</p>`,
    confirmLabel: "Delete",
    danger: true,
    onConfirm: async () => {
      window.clearTimeout(saveTimer);
      await saveQueue;
      await postJSON("/api/pipeline-chains/delete", { id });
      doc.dirty = false;
      chains = chains.filter((c) => c.id !== id);
      if (localStorage.getItem(LAST_CHAIN_KEY) === id) localStorage.removeItem(LAST_CHAIN_KEY);
      const next = mostRecent();
      if (next) await openChain(next.id);
      else openDraft();
      toast("Chain deleted", "ok");
    },
  });
}

/** A run poll still waiting; the next tick skips instead of stacking requests. */
let runPoll: Promise<void> | null = null;
let summaryPoll: Promise<void> | null = null;

function pollRun(): Promise<void> {
  if (!runPoll) runPoll = readRun().finally(() => (runPoll = null));
  return runPoll;
}

function pollSummaries(): void {
  if (!summaryPoll) summaryPoll = loadChains(false).catch(() => undefined).finally(() => (summaryPoll = null));
}

async function readRun(): Promise<void> {
  if (!run) return;
  const runId = run.runId;
  const was = run.status;
  let next: ChainRun;
  try {
    next = (await getJSON(`/api/pipeline-run?runId=${encodeURIComponent(runId)}`)).run;
  } catch {
    return; // transient; the next poll retries
  }
  if (run?.runId !== runId || !next) return;
  run = next;
  if (runSignature() !== runSig) renderRun();
  else tick();
  if (was === "running" && next.status !== "running") {
    const msg = { succeeded: "Chain succeeded", failed: "Chain failed", canceled: "Chain stopped", running: "" }[next.status];
    toast(msg, next.status === "succeeded" ? "ok" : "err");
    announce(msg);
    void loadChains(false);
  }
}

function syncTimers(): void {
  const polling = visible && isRunning();
  if (polling && !pollTimer) {
    pollTimer = window.setInterval(() => void pollRun(), RUN_POLL_MS);
    tickTimer = window.setInterval(tick, 1000);
  } else if (!polling && pollTimer) {
    window.clearInterval(pollTimer);
    window.clearInterval(tickTimer);
    pollTimer = tickTimer = 0;
  }
  const others = visible && chains.some((c) => c.id !== doc.id && c.lastRun?.status === "running");
  if (others && !summaryTimer) summaryTimer = window.setInterval(pollSummaries, SUMMARY_POLL_MS);
  else if (!others && summaryTimer) {
    window.clearInterval(summaryTimer);
    summaryTimer = 0;
  }
}

/** Advance the elapsed clocks without rebuilding the inspector. */
function tick(): void {
  paintRun();
  renderRunChip();
  const nodeRun = inspector.querySelector<HTMLElement>(".insp-run");
  if (nodeRun) nodeRun.innerHTML = nodeRunHtml(nodeRun.dataset.id!);
  const lastRun = inspector.querySelector<HTMLElement>(".insp-lastrun");
  if (lastRun) lastRun.innerHTML = lastRunHtml();
}

// ---- rendering ----------------------------------------------------------------------------

function renderAll(): void {
  nameInput.value = doc.name;
  renderPicker();
  renderEmptyHint();
  renderRun();
}

/** Everything that depends on the run: overlay, live flag, toolbar, inspector, catalog, timers. */
function renderRun(): void {
  forgetOtherChain();
  runSig = runSignature();
  paintRun();
  canvas.setLive(isRunning());
  root!.classList.toggle("is-running", isRunning());
  renderToolbar();
  renderInspector();
  syncCatalogMarks();
  syncTimers();
  syncHistory();
}

// Results belong to one chain: block ids repeat across chains, so drop them before painting another.
function forgetOtherChain(): void {
  if (buildsChain === doc.id) return;
  appBuilds = [];
  results = [];
  buildsChain = doc.id;
  buildsKey = "";
}

function syncHistory(): void {
  const key = doc.id ? `${doc.id}|${run?.runId ?? ""}|${run?.status ?? ""}` : "";
  if (key === buildsKey) return;
  buildsKey = key;
  if (!doc.id) return;
  const id = encodeURIComponent(doc.id);
  Promise.all([getJSON(`/api/pipeline-chain-builds?id=${id}`), getJSON(`/api/pipeline-chain-results?id=${id}`)])
    .then(([b, r]: [{ builds: AppBuild[] }, { results: BlockResult[] }]) => {
      if (buildsKey !== key) return;
      appBuilds = b.builds || [];
      results = r.results || [];
      paintRun();
      renderInspector();
    })
    .catch(() => {
      if (buildsKey === key) buildsKey = "";
    });
}

/** What a poll can change that is worth a full re-render (elapsed clocks tick separately). */
function runSignature(): string {
  if (!run) return "";
  const states = Object.entries(run.states)
    .map(([id, s]) => [id, s.status, s.buildNumber, s.url, s.error, s.cancelError, s.pollError, s.stopRequested, s.manual].join("\u0001"))
    .join("\u0002");
  return [run.runId, run.status, run.cancelRequested, run.error, states].join("\u0003");
}

function renderPicker(): void {
  const options: string[] = [];
  if (!doc.id) options.push(`<option value="" selected>${esc(doc.name.trim() || "New chain")} (unsaved)</option>`);
  const option = (c: ChainSummary): string => {
    const name = c.id === doc.id ? doc.name.trim() || c.name : c.name;
    const running = c.lastRun?.status === "running" || (c.id === doc.id && isRunning());
    return `<option value="${esc(c.id)}"${c.id === doc.id ? " selected" : ""}>${esc(name)}${running ? " · running" : ""}</option>`;
  };
  const own = chains.filter((c) => !c.owner);
  const owned = chains.filter((c) => c.owner);
  options.push(...own.map(option));
  // Each task's validation chain lives with the task; they're listed apart from the user's own.
  if (owned.length) options.push(`<optgroup label="Task chains">${owned.map(option).join("")}</optgroup>`);
  picker.innerHTML = options.join("");
  picker.disabled = options.length < 2 && !doc.id;
  renderOwner();
}

const ownerOf = (id: string | null): ChainSummary["owner"] => (id ? chains.find((c) => c.id === id)?.owner ?? null : null);

/** A task's chain says whose it is, and that its blocks can follow the task's PRs. */
function renderOwner(): void {
  const owner = ownerOf(doc.id);
  ownerBar.hidden = !owner;
  root?.classList.toggle("is-task-chain", !!owner);
  if (!owner) {
    ownerBar.innerHTML = "";
    return;
  }
  const html = `${icon("flow")}<span class="chain-owner-text">Validation for the task <b>${esc(owner.title)}</b>${
    owner.status === "done" ? " · done, so it can't run until the task is reopened" : ""
  }. Blocks can follow the task's pull requests. It goes away with the task.</span>
    <button type="button" class="btn sm ghost" data-owner-act="open-task">Open the task</button>
    <button type="button" class="btn sm ghost" data-owner-act="reusable">${icon("copy")}<span>Save as reusable</span></button>`;
  if (ownerBar.dataset.sig !== html) {
    ownerBar.dataset.sig = html;
    ownerBar.innerHTML = html;
  }
}

async function onOwnerClick(e: MouseEvent): Promise<void> {
  const btn = (e.target as Element).closest<HTMLButtonElement>("[data-owner-act]");
  const owner = ownerOf(doc.id);
  if (!btn || !owner) return;
  if (btn.dataset.ownerAct === "open-task") {
    window.dispatchEvent(new CustomEvent("ado-open-task", { detail: { taskId: owner.taskId, tab: "validation" } }));
    return;
  }
  btn.disabled = true;
  try {
    if (!(await flushSave())) throw new Error("Save this chain first.");
    const res = await postJSON("/api/jarvis/validation/reusable", { id: owner.taskId });
    toast(`Saved "${res.chain.name}" to your chains`, "ok");
    await loadChains(false);
  } catch (err) {
    toast(errorText(err), "err");
  } finally {
    btn.disabled = false;
  }
}

function renderToolbar(): void {
  const running = isRunning();
  if (running) {
    const stopping = !!run?.cancelRequested;
    runBtn.className = "btn chain-run is-stop";
    runBtn.disabled = stopping;
    runBtn.innerHTML = stopping ? `<span class="spinner"></span>Stopping…` : `${icon("stop")}Stop`;
    runBtn.title = stopping ? "Canceling the builds this run queued" : "Stop this run";
  } else {
    const empty = !doc.graph.nodes.length;
    runBtn.className = "btn accent chain-run";
    runBtn.disabled = empty;
    runBtn.innerHTML = `${icon("play")}Run chain`;
    runBtn.title = empty ? "Add a pipeline to run this chain" : "Queue the pipelines in order";
  }
  deleteBtn.disabled = !doc.id || running;
  deleteBtn.title = running ? "Stop the run before deleting this chain" : "Delete chain";
  renderRunChip();
}

function renderRunChip(): void {
  if (!run) {
    runChip.hidden = true;
    return;
  }
  const now = Date.now();
  const tone = statusTone(run.status);
  const dot = tone === "run" ? `<span class="spinner"></span>` : `<span class="chain-dot tone-${tone}"></span>`;
  let text: string;
  if (run.status === "running") {
    const p = runProgress(run.states);
    text = `${run.cancelRequested ? "Stopping" : "Running"} · ${p.done}/${p.total} · ${formatElapsed(now - Date.parse(run.createdAt))}`;
  } else {
    text = `${run.status === "canceled" ? "Stopped" : statusLabel(run.status)} · ${timeAgo(run.finishedAt || run.updatedAt, now)}`;
  }
  runChip.hidden = false;
  runChip.className = `chain-run-chip tone-${tone}`;
  runChip.innerHTML = `${dot}<span>${esc(text)}</span>`;
  runChip.title = run.status === "running" ? "This chain is running" : "Last run of this chain";
}

function renderEmptyHint(): void {
  emptyHint.hidden = doc.graph.nodes.length > 0;
}

// ---- catalog ------------------------------------------------------------------------------

const pipelineKey = (org: string, project: string, definitionId: number): string =>
  `${org.toLowerCase()}/${project.toLowerCase()}/${definitionId}`;
const catalogKey = (p: CatalogPipeline): string => pipelineKey(p.org, p.project, p.id);

function renderScope(): void {
  const groups = groupPipelines(catalog);
  if (scope && !groups.some((g) => g.key === scope)) scope = "";
  scopeSelect.innerHTML =
    `<option value="">All projects</option>` +
    groups.map((g) => `<option value="${esc(g.key)}"${g.key === scope ? " selected" : ""}>${esc(g.project)} · ${esc(g.org)}</option>`).join("");
  scopeSelect.hidden = groups.length < 2;
}

function renderCatalogNotes(): void {
  const notes = catalogErrors.map((msg) => `<div class="catalog-note is-error">${icon("warning")}<span>${esc(msg)}</span></div>`);
  if (unscopedOrgs.length) {
    const orgs = unscopedOrgs.map((o) => `<b>${esc(o)}</b>`).join(", ");
    notes.push(
      `<div class="catalog-note">${icon("folder")}<span>Pick projects for ${orgs} in Settings to list ${unscopedOrgs.length === 1 ? "its" : "their"} pipelines.
        <button type="button" class="catalog-link catalog-settings">Open Settings</button></span></div>`
    );
  }
  catalogNotes.innerHTML = notes.join("");
}

function inChainCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of doc.graph.nodes) {
    const key = pipelineKey(n.org, n.project, n.definitionId);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/** Re-render catalog rows only when the "in chain" marks change. */
function syncCatalogMarks(): void {
  const sig = [...inChainCounts()].sort().join(",");
  if (sig === catalogSig) return;
  renderCatalogList();
}

function renderCatalogList(): void {
  if (!catalogLoaded) return;
  const counts = inChainCounts();
  catalogSig = [...counts].sort().join(",");
  const focusKey = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>(".catalog-row")?.dataset.key;
  const list = filterPipelines(catalog, query, scope);
  catalogCount.textContent = list.length === catalog.length ? String(catalog.length) : `${list.length} of ${catalog.length}`;
  catalogCount.hidden = !catalog.length;

  if (!catalog.length) {
    const failed = catalogErrors.length > 0;
    catalogList.innerHTML = `<div class="empty">${icon("pipeline")}<span>${failed ? "Couldn't list pipelines" : "No pipelines yet"}</span>
      <span class="hint">${unscopedOrgs.length || !failed ? "Add organizations and projects in Settings." : "Refresh to try again."}</span>
      <button type="button" class="btn sm catalog-settings">Open Settings</button></div>`;
    catalogList.querySelector(".catalog-settings")!.addEventListener("click", () => hooks.openSettings());
    return;
  }
  if (!list.length) {
    catalogList.innerHTML = `<div class="empty">${icon("search")}<span>No pipelines match “${esc(query.trim())}”</span>
      <span class="hint">Search matches names, folders, and projects.</span></div>`;
    return;
  }

  const shown = list.slice(0, MAX_ROWS);
  const groups = groupPipelines(shown);
  const showHeads = groups.length > 1 || !scope;
  const html = groups.map((g) => {
    const head = showHeads
      ? `<div class="catalog-group-head"><span class="catalog-group-name">${esc(g.project)}</span><span class="catalog-group-org">${esc(g.org)}</span></div>`
      : "";
    return `<section class="catalog-group" aria-label="${esc(g.project)}">${head}<ul class="catalog-rows">${g.items
      .map((p) => rowHtml(p, counts.get(catalogKey(p)) || 0))
      .join("")}</ul></section>`;
  });
  if (list.length > shown.length) {
    html.push(`<p class="catalog-more">Showing ${MAX_ROWS} of ${list.length}. Refine the search to see the rest.</p>`);
  }
  catalogList.innerHTML = html.join("");
  if (focusKey) catalogList.querySelector<HTMLElement>(`.catalog-row[data-key="${CSS.escape(focusKey)}"] .catalog-add`)?.focus({ preventScroll: true });
}

function rowHtml(p: CatalogPipeline, inChain: number): string {
  const key = catalogKey(p);
  const folder = p.path && p.path !== "\\" ? p.path.replace(/^\\/, "") : "";
  const latest = p.latest;
  const tone = latestTone(latest);
  const lastBuild = !latest
    ? "No builds yet"
    : latest.status && latest.status !== "completed"
      ? `Building ${latest.buildNumber || ""}`.trim()
      : `Last build ${statusLabel(latest.result || "unknown").toLowerCase()}${latest.buildNumber ? ` (${latest.buildNumber})` : ""}`;
  const tags = [
    p.queueStatus === "paused" ? `<span class="catalog-tag">Paused</span>` : "",
    p.queueStatus === "disabled" ? `<span class="catalog-tag">Disabled</span>` : "",
    inChain ? `<span class="catalog-tag is-in">${inChain > 1 ? `In chain ×${inChain}` : "In chain"}</span>` : "",
  ].join("");
  return `<li class="catalog-row${inChain ? " in-chain" : ""}" draggable="true" data-key="${esc(key)}">
      <span class="catalog-dot tone-${tone}" role="img" aria-label="${esc(lastBuild)}" title="${esc(lastBuild)}"></span>
      <span class="catalog-text">
        <span class="catalog-name" title="${esc(p.name)}">${esc(p.name)}</span>
        ${folder || tags ? `<span class="catalog-meta">${folder ? `<span class="catalog-path">${esc(folder)}</span>` : ""}${tags}</span>` : ""}
      </span>
      <button type="button" class="icon-btn catalog-add" data-key="${esc(key)}" aria-label="Add ${esc(p.name)} to the chain"
        title="Add to chain">${icon("add")}</button>
    </li>`;
}

// ---- inspector ----------------------------------------------------------------------------

function renderInspector(): void {
  root!.classList.toggle("has-selection", !!selection);
  const active = document.activeElement as HTMLElement | null;
  const restore = active && inspector.contains(active) ? focusSelector(active) : null;
  const caret = textCaret(active);
  if (selection?.kind === "node") {
    const n = nodeById(selection.id);
    if (n && !infoCache.has(infoKey(n))) void requestInfo(n);
    inspector.innerHTML = nodeHtml(selection.id);
  } else if (selection?.kind === "edge") inspector.innerHTML = edgeHtml(selection.from, selection.to);
  else inspector.innerHTML = overviewHtml();
  if (restore === null) return;
  const target = inspector.querySelector<HTMLElement>(restore || ".insp-close") ?? inspector.querySelector<HTMLElement>(".insp-close");
  target?.focus({ preventScroll: true });
  // Re-rendering mid-typing (a poll, a param re-read) must not move the caret.
  if (caret && target && document.activeElement === target && textCaret(target)) {
    (target as HTMLInputElement | HTMLTextAreaElement).setSelectionRange(caret[0], caret[1]);
  }
}

function textCaret(el: Element | null): [number, number] | null {
  if (!(el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === "text"))) return null;
  return el.selectionStart === null || el.selectionEnd === null ? null : [el.selectionStart, el.selectionEnd];
}

/** A selector that finds the same control after a re-render ("" when there is none). */
function focusSelector(node: HTMLElement): string {
  for (const attr of INSPECTOR_FOCUS_ATTRS) {
    const value = node.getAttribute(attr);
    if (value !== null) return `[${attr}="${CSS.escape(value)}"]`;
  }
  const cls = INSPECTOR_FOCUS_CLASSES.find((c) => node.classList.contains(c));
  return cls ? `.${cls}` : "";
}

function overviewHtml(): string {
  const nodes = doc.graph.nodes;
  if (!nodes.length) {
    return `<div class="insp-section">
        <h2 class="insp-title">Build a chain</h2>
        <ol class="insp-steps">
          <li><b>Add pipelines</b><span>Drag them from the list, or press + on a row.</span></li>
          <li><b>Connect them</b><span>Drag from a block's right edge onto the block that should run next.</span></li>
          <li><b>Run the chain</b><span>Each pipeline starts once every pipeline before it passes.</span></li>
        </ol>
      </div>`;
  }
  const states = overlayStates();
  const order = stages(doc.graph);
  const stageHtml = order
    .map(
      (ids, i) => `<li class="insp-stage"><span class="insp-stage-n" aria-hidden="true">${i + 1}</span><div class="insp-stage-blocks">
        <span class="visually-hidden">Stage ${i + 1}:</span>${ids
          .map((id) => {
            const s = states?.[id];
            return `<button type="button" class="insp-block" data-select="${esc(id)}">${statusDot(s?.status)}<span>${esc(nodeName(id))}</span></button>`;
          })
          .join("")}</div></li>`
    )
    .join("");
  return `<div class="insp-section">
      <h2 class="insp-title">Run order</h2>
      <p class="insp-muted">${nodes.length} ${nodes.length === 1 ? "pipeline" : "pipelines"} in ${order.length} ${order.length === 1 ? "stage" : "stages"}. Pipelines in the same stage run in parallel.</p>
      <ol class="insp-stages">${stageHtml}</ol>
    </div>
    <div class="insp-section insp-lastrun">${lastRunHtml()}</div>`;
}

function lastRunHtml(): string {
  if (!run) return `<h3 class="insp-label">Last run</h3><p class="insp-muted">This chain hasn't run yet.</p>`;
  const now = Date.now();
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  const counts = { ok: 0, bad: 0, off: 0, run: 0, idle: 0, warn: 0 };
  for (const s of Object.values(run.states)) counts[statusTone(s.status)]++;
  const parts = [
    counts.ok + counts.warn ? `<span class="insp-count tone-ok">${counts.ok + counts.warn} passed</span>` : "",
    counts.bad ? `<span class="insp-count tone-bad">${counts.bad} failed</span>` : "",
    counts.off ? `<span class="insp-count tone-off">${counts.off} skipped</span>` : "",
    counts.run ? `<span class="insp-count tone-run">${counts.run} running</span>` : "",
    counts.idle ? `<span class="insp-count tone-idle">${counts.idle} waiting</span>` : "",
  ].join("");
  const label = run.status === "canceled" ? "Stopped" : statusLabel(run.status);
  return `<h3 class="insp-label">${run.status === "running" ? "This run" : "Last run"}</h3>
    <div class="insp-run-status">${statusDot(run.status)}<span>${esc(label)}</span><span class="insp-run-time">${formatElapsed(end - Date.parse(run.createdAt))}</span></div>
    <p class="insp-muted">Started ${esc(timeAgo(run.createdAt, now))}</p>
    <div class="insp-counts">${parts}</div>
    ${run.error ? `<p class="insp-run-note">${esc(run.error)}</p>` : ""}`;
}

function nodeHtml(id: string): string {
  const n = nodeById(id);
  if (!n) return "";
  const state = liveRun()?.states[id];
  const building = isActive(state?.status);
  const order = stages(doc.graph);
  const stage = order.findIndex((ids) => ids.includes(id));
  const ups = doc.graph.edges.filter((e) => e.to === id);
  const downs = doc.graph.edges.filter((e) => e.from === id);
  const candidates = upstreamCandidates(doc.graph, id);
  const folder = n.path && n.path !== "\\" ? n.path.replace(/^\\/, "") : "";
  const chip = (other: string, from: string, to: string): string =>
    `<span class="insp-chip"><button type="button" class="insp-chip-name" data-select="${esc(other)}">${esc(nodeName(other))}</button><button type="button" class="chip-x"
      data-unlink="${esc(from)}>${esc(to)}" aria-label="Remove the arrow between ${esc(nodeName(from))} and ${esc(nodeName(to))}">${icon("dismiss")}</button></span>`;
  // A waiting block reads its branches and parameters when it queues; one past that keeps what it had.
  const started = state && state.status !== "waiting"
    ? `<p class="insp-note">${icon("clock")}<span>${building ? "Already queued" : "Already done"} in this run. Branch, repository and parameter changes apply the next time it runs.</span></p>`
    : "";
  return `<div class="insp-head">
      <span class="insp-head-icon">${icon("pipeline")}</span>
      <div class="insp-head-text"><h2 class="insp-name">${esc(n.name)}</h2><span class="insp-sub">${esc(n.project)}</span></div>
      <button type="button" class="icon-btn insp-close" title="Close details (Esc)" aria-label="Close details">${icon("dismiss")}</button>
    </div>
    <a class="insp-link" href="${esc(definitionUrl(n))}" target="_blank" rel="noreferrer">Open in Azure DevOps${icon("external")}</a>
    ${nodeActionsHtml(id)}
    <div class="insp-section insp-run" data-id="${esc(id)}">${nodeRunHtml(id)}</div>
    ${started}
    ${branchFieldHtml(n)}
    ${reposHtml(n)}
    ${paramsHtml(n)}
    ${consumesHtml(n)}
    <div class="insp-section">
      <h3 class="insp-label">Runs after</h3>
      ${ups.length ? `<div class="insp-chips">${ups.map((e) => chip(e.from, e.from, id)).join("")}</div>` : `<p class="insp-muted">Nothing. It starts as soon as the chain runs.</p>`}
      ${candidates.length
        ? `<select class="filter-select insp-add-up" aria-label="Add a pipeline this one waits for"><option value="">Wait for another pipeline…</option>${candidates
            .map((c) => `<option value="${esc(c)}">${esc(nodeName(c))}</option>`)
            .join("")}</select>`
        : ""}
    </div>
    <div class="insp-section">
      <h3 class="insp-label">Then triggers</h3>
      ${downs.length ? `<div class="insp-chips">${downs.map((e) => chip(e.to, id, e.to)).join("")}</div>` : `<p class="insp-muted">Nothing. It ends this branch of the chain.</p>`}
    </div>
    <dl class="insp-facts">
      <div><dt>Stage</dt><dd>${stage >= 0 ? `${stage + 1} of ${order.length}` : "—"}</dd></div>
      <div><dt>Organization</dt><dd>${esc(n.org)}</dd></div>
      ${folder ? `<div><dt>Folder</dt><dd>${esc(folder)}</dd></div>` : ""}
      <div><dt>Definition</dt><dd>${n.definitionId}</dd></div>
    </dl>
    <button type="button" class="btn insp-remove" data-remove-node="${esc(id)}"${building ? ` disabled title="Stop it before removing it"` : ""}>${icon("trash")}Remove from chain</button>
    ${building ? `<span class="insp-hint insp-remove-hint">Stop it before removing it. It's building in Azure DevOps.</span>` : ""}`;
}

/** A task's PRs, for blocks that follow one. Read once per task, again when asked. */
function requestOwnerPrs(taskId: string, again = false): void {
  const have = ownerPrs.get(taskId);
  if (have && !again && have.status !== "error") return;
  ownerPrs.set(taskId, { status: "loading", prs: have?.prs || [] });
  getJSON(`/api/jarvis/task-prs?id=${encodeURIComponent(taskId)}`)
    .then((res: { prs: Array<{ org: string; prId: number; hidden?: boolean; snapshot: { title: string; sourceRef: string; status: string } | null }> }) => {
      const prs = (res.prs || [])
        .filter((p) => p.snapshot && !p.hidden)
        .map((p) => ({ org: p.org, prId: p.prId, title: p.snapshot!.title, sourceRef: p.snapshot!.sourceRef, status: p.snapshot!.status }));
      ownerPrs.set(taskId, { status: "ready", prs });
    })
    .catch((e) => ownerPrs.set(taskId, { status: "error", prs: [], error: errorText(e) }))
    .finally(() => {
      if (selection?.kind === "node") renderInspector();
    });
}

const prValue = (p: { org: string; prId: number }): string => `${p.org.toLowerCase()}|${p.prId}`;

/** The block's branch: typed, or (on a task's chain) a PR of the task to follow. */
function branchFieldHtml(n: ChainNode): string {
  const owner = ownerOf(doc.id);
  const typed = `<label class="insp-field">
      <span class="insp-label">Branch</span>
      <span class="insp-input">${icon("branch")}<input class="insp-branch" value="${esc(n.branch)}" placeholder="Default branch" spellcheck="false" autocomplete="off"></span>
      <span class="insp-hint">Leave empty to build the pipeline's default branch.</span>
    </label>`;
  if (!owner && !n.branchFrom) return typed;
  const entry = owner ? ownerPrs.get(owner.taskId) : undefined;
  if (owner && !entry) requestOwnerPrs(owner.taskId);
  const prs = entry?.prs || [];
  const current = n.branchFrom ? prValue(n.branchFrom) : "";
  const known = !current || prs.some((p) => prValue(p) === current);
  const options = [
    `<option value=""${current ? "" : " selected"}>A branch I type</option>`,
    ...prs.map(
      (p) =>
        `<option value="${esc(prValue(p))}"${prValue(p) === current ? " selected" : ""}>Follow PR ${p.prId} · ${esc(p.sourceRef)}${p.status !== "active" ? ` (${esc(p.status)})` : ""}</option>`
    ),
    ...(known ? [] : [`<option value="${esc(current)}" selected>Follow PR ${n.branchFrom!.prId} (not linked to the task)</option>`]),
  ].join("");
  const hint = n.branchFrom
    ? "Builds the PR's source branch as it is when this block queues, so new commits are picked up."
    : entry?.status === "loading"
      ? "Reading the task's pull requests…"
      : entry?.status === "error"
        ? `Couldn't read the task's pull requests: ${entry.error}`
        : prs.length
          ? "Follow a PR to build whatever its branch has when this block runs."
          : "The task has no pull requests to follow yet.";
  return `<div class="insp-field">
      <label class="insp-label" for="inspFollow">Builds</label>
      <select class="filter-select insp-follow" id="inspFollow">${options}</select>
    </div>
    ${n.branchFrom ? `<p class="insp-hint insp-follow-hint">${esc(hint)}</p>` : `${typed.replace('<span class="insp-hint">Leave empty to build the pipeline\'s default branch.</span>', `<span class="insp-hint">Leave empty to build the pipeline's default branch. ${esc(hint)}</span>`)}`}`;
}

// ---- parameters and consumed pipelines -------------------------------------------------------

const infoKey = (n: ChainNode): string => `${pipelineKey(n.org, n.project, n.definitionId)}/${normalizeBranch(n.branch)}`;

/** Reads what the block's pipeline takes on its branch, once per pipeline and branch (or on Reload). */
async function requestInfo(n: ChainNode, refresh = false): Promise<void> {
  const key = infoKey(n);
  const current = infoCache.get(key);
  if (current?.status === "loading" || (current && !refresh)) return;
  infoCache.set(key, { status: "loading" });
  const q = new URLSearchParams({ org: n.org, project: n.project, id: String(n.definitionId) });
  const branch = normalizeBranch(n.branch);
  if (branch) q.set("branch", branch);
  if (refresh) q.set("refresh", "1");
  let entry: InfoEntry;
  try {
    entry = { status: "ready", info: await getJSON(`/api/pipeline-definition-info?${q}`) };
  } catch (e) {
    entry = { status: "error", error: errorText(e) };
  }
  infoCache.set(key, entry);
  const selected = selection?.kind === "node" ? nodeById(selection.id) : undefined;
  if (selected && infoKey(selected) === key) renderInspector();
}

function paramDef(n: ChainNode, name: string): RunParameter | undefined {
  const entry = infoCache.get(infoKey(n));
  return entry?.status === "ready" ? entry.info.parameters.find((p) => p.name === name) : undefined;
}

/** The count beside "Parameters": what needs fixing first, then what changed, then how many. */
function paramCount(n: ChainNode): { text: string; tone: string } {
  const entry = infoCache.get(infoKey(n));
  const set = n.params ? Object.keys(n.params).length : 0;
  if (entry?.status !== "ready") return { text: set ? `${set} set` : "", tone: "" };
  if (!entry.info.yaml) return set ? { text: `${set} to fix`, tone: "bad" } : { text: "None", tone: "" };
  const sum = paramSummary(entry.info.parameters, n.params);
  const bad = sum.invalid + sum.stale.length;
  if (bad) return { text: `${bad} to fix`, tone: "bad" };
  if (sum.changed) return { text: `${sum.changed} of ${sum.total} changed`, tone: "accent" };
  return { text: sum.total ? String(sum.total) : "None", tone: "" };
}

function paramsHtml(n: ChainNode): string {
  const entry = infoCache.get(infoKey(n));
  const count = paramCount(n);
  let body: string;
  if (!entry || entry.status === "loading") {
    body = `<p class="insp-muted insp-params-loading"><span class="spinner" aria-hidden="true"></span>Reading the pipeline's YAML…</p>`;
  } else if (entry.status === "error") {
    body = `<p class="insp-run-note">Couldn't read its parameters: ${esc(entry.error)}</p>
      <button type="button" class="btn sm insp-params-btn" data-params-reload="retry">${icon("sync")}Try again</button>`;
  } else if (!entry.info.yaml) {
    const set = n.params ? Object.keys(n.params).length : 0;
    body = `<p class="insp-muted">Classic pipelines don't take runtime parameters.</p>
      ${set
        ? `<p class="insp-run-note">${set === 1 ? "A parameter is" : `${set} parameters are`} still set, so it fails to queue.</p>
           <button type="button" class="btn sm insp-params-btn" data-params-clear="all">${icon("trash")}Clear parameters</button>`
        : ""}`;
  } else {
    const info = entry.info;
    const stale = paramSummary(info.parameters, n.params).stale;
    const warnings = info.errors.map((msg) => `<p class="insp-warn">${icon("warning")}<span>${esc(msg)}</span></p>`).join("");
    const list = info.parameters.length
      ? `<div class="param-list">${info.parameters.map((p, i) => paramFieldHtml(p, n.params?.[p.name], i)).join("")}</div>`
      : `<p class="insp-muted">This pipeline has no runtime parameters.</p>`;
    const staleHtml = stale.length
      ? `<div class="insp-stale">
          <p class="insp-run-note">${stale.length === 1 ? "This value is for a parameter" : "These values are for parameters"} the pipeline no longer has. It fails to queue until you remove ${stale.length === 1 ? "it" : "them"}.</p>
          <ul>${stale
            .map(
              (name) => `<li><code class="param-name">${esc(name)}</code><span class="insp-stale-value">${esc(shortValue(n.params![name]))}</span><button type="button" class="icon-btn sm"
                data-param-remove="${esc(name)}" title="Remove" aria-label="Remove the value for ${esc(name)}">${icon("dismiss")}</button></li>`
            )
            .join("")}</ul>
        </div>`
      : "";
    body = `${warnings}${list}${staleHtml}
      <div class="insp-params-foot">
        <span class="insp-hint">From the YAML on ${esc(branchLabel(n.branch || info.defaultBranch))}.${info.parameters.length ? " Only changed values are sent; the rest use their defaults." : ""}</span>
        <button type="button" class="btn sm insp-params-btn" data-params-reload="reload" title="Read the YAML again">${icon("sync")}Reload</button>
      </div>`;
  }
  return `<details class="insp-section insp-params"${paramsOpen ? " open" : ""}>
      <summary class="insp-params-summary"><span class="insp-label">Parameters</span><span class="insp-params-count${count.tone ? ` tone-${count.tone}` : ""}">${esc(count.text)}</span>${icon("chevron")}</summary>
      <div class="insp-params-body">${body}</div>
    </details>`;
}

function paramFieldHtml(p: RunParameter, override: string | undefined, i: number): string {
  const id = `insp-param-${i}`;
  const value = override ?? p.default;
  const changed = override !== undefined;
  const problem = changed ? paramProblem(p, value) : null;
  const attrs = `id="${id}" data-param="${esc(p.name)}" aria-invalid="${problem ? "true" : "false"}" aria-describedby="${id}-error"`;
  const isSwitch = p.kind === "boolean" && !p.values;
  let control: string;
  if (p.values) {
    const extra = p.values.includes(value) ? "" : `<option value="${esc(value)}" selected>${esc(shortValue(value))} (not allowed)</option>`;
    control = `<select class="filter-select param-select" ${attrs}>${extra}${p.values
      .map((v) => `<option value="${esc(v)}"${v === value ? " selected" : ""}>${esc(v || "(empty)")}</option>`)
      .join("")}</select>`;
  } else if (isSwitch) {
    control = `<input type="checkbox" role="switch" class="param-switch" ${attrs}${value.toLowerCase() === "true" ? " checked" : ""}>`;
  } else if (p.kind === "object") {
    const rows = Math.min(10, Math.max(3, value.split("\n").length));
    control = `<textarea class="param-code" rows="${rows}" spellcheck="false" autocomplete="off" ${attrs}>${esc(value)}</textarea>`;
  } else {
    const mode = p.kind === "number" ? ` inputmode="decimal"` : "";
    control = `<input type="text" class="param-input"${mode} spellcheck="false" autocomplete="off" ${attrs} value="${esc(value)}">`;
  }
  const meta = paramMetaHtml(p, changed);
  return `<div class="param${changed ? " is-changed" : ""}${problem ? " is-invalid" : ""}">
      <div class="param-head">
        <label class="param-label" for="${id}">${esc(p.label)}</label>
        <button type="button" class="param-reset" data-param-reset="${esc(p.name)}" aria-label="Reset ${esc(p.label)} to its default"${changed ? "" : " hidden"}>Reset</button>
        ${isSwitch ? control : ""}
      </div>
      ${isSwitch ? "" : control}
      <div class="param-meta"${meta ? "" : " hidden"}>${meta}</div>
      <p class="param-error" id="${id}-error"${problem ? "" : " hidden"}>${esc(problem || "")}</p>
    </div>`;
}

function paramMetaHtml(p: RunParameter, changed: boolean): string {
  return [
    p.label !== p.name ? `<code class="param-name">${esc(p.name)}</code>` : "",
    changed ? `<span>Default: ${esc(shortValue(p.default))}</span>` : "",
  ].join("");
}

const shortValue = (v: string): string => {
  const one = v.replace(/\s+/g, " ").trim();
  return !one ? "(empty)" : one.length > 60 ? `${one.slice(0, 59)}…` : one;
};

/** Updates one parameter row (and the count) in place, so typing never re-renders the field. */
function syncParamRow(n: ChainNode, def: RunParameter): void {
  const control = inspector.querySelector<HTMLElement>(`[data-param="${CSS.escape(def.name)}"]`);
  const row = control?.closest<HTMLElement>(".param");
  if (!control || !row) return;
  const override = n.params?.[def.name];
  const changed = override !== undefined;
  const problem = changed ? paramProblem(def, override) : null;
  row.classList.toggle("is-changed", changed);
  row.classList.toggle("is-invalid", !!problem);
  control.setAttribute("aria-invalid", problem ? "true" : "false");
  row.querySelector<HTMLElement>(".param-reset")!.hidden = !changed;
  const error = row.querySelector<HTMLElement>(".param-error")!;
  error.hidden = !problem;
  error.textContent = problem || "";
  const meta = row.querySelector<HTMLElement>(".param-meta")!;
  meta.innerHTML = paramMetaHtml(def, changed);
  meta.hidden = !meta.innerHTML;
  const count = inspector.querySelector<HTMLElement>(".insp-params-count");
  if (count) {
    const c = paramCount(n);
    count.textContent = c.text;
    count.className = `insp-params-count${c.tone ? ` tone-${c.tone}` : ""}`;
  }
}

/** The count beside "Repositories": what needs fixing first, then what changed, then how many. */
function repoCount(n: ChainNode): { text: string; tone: string } {
  const entry = infoCache.get(infoKey(n));
  const set = Object.keys(n.repoBranches ?? {}).length;
  if (entry?.status !== "ready") return { text: set ? `${set} set` : "", tone: "" };
  if (!entry.info.yaml) return set ? { text: `${set} to fix`, tone: "bad" } : { text: "None", tone: "" };
  const sum = repoSummary(entry.info.repositories ?? [], n.repoBranches);
  if (sum.stale.length) return { text: `${sum.stale.length} to fix`, tone: "bad" };
  if (sum.changed) return { text: `${sum.changed} of ${sum.total} changed`, tone: "accent" };
  return { text: sum.total ? String(sum.total) : "None", tone: "" };
}

const repoHint = (value: string, yamlRef: string): string =>
  value.trim() ? `Instead of ${yamlRef}, the ref in the YAML.` : `Uses ${yamlRef}, the ref in the YAML.`;

/** The YAML's `resources.repositories` (templates and other repos it checks out), each with a branch to use instead. */
function reposHtml(n: ChainNode): string {
  const entry = infoCache.get(infoKey(n));
  const count = repoCount(n);
  const set = Object.keys(n.repoBranches ?? {}).length;
  let body: string;
  if (!entry || entry.status === "loading") {
    body = `<p class="insp-muted insp-params-loading"><span class="spinner" aria-hidden="true"></span>Reading the pipeline's YAML…</p>`;
  } else if (entry.status === "error") {
    body = `<p class="insp-run-note">Couldn't read its repositories: ${esc(entry.error)}</p>
      <button type="button" class="btn sm insp-params-btn" data-repos-reload="retry">${icon("sync")}Try again</button>`;
  } else if (!entry.info.yaml) {
    body = `<p class="insp-muted">Classic pipelines don't have repository resources.</p>
      ${set
        ? `<p class="insp-run-note">${set === 1 ? "A repository branch is" : `${set} repository branches are`} still set, so it fails to queue.</p>
           <button type="button" class="btn sm insp-params-btn" data-repos-clear="all">${icon("trash")}Clear repository branches</button>`
        : ""}`;
  } else {
    const repos = entry.info.repositories ?? [];
    const stale = repoSummary(repos, n.repoBranches).stale;
    const list = repos.length
      ? `<div class="repo-list">${repos.map((r, i) => repoFieldHtml(r, repoBranchFor(n.repoBranches, r.alias), i)).join("")}</div>`
      : `<p class="insp-muted">Its YAML uses no other repositories. Its own repository builds the branch above.</p>`;
    const staleHtml = stale.length
      ? `<div class="insp-stale">
          <p class="insp-run-note">${stale.length === 1 ? "This branch is for a repository" : "These branches are for repositories"} the pipeline no longer uses. It fails to queue until you remove ${stale.length === 1 ? "it" : "them"}.</p>
          <ul>${stale
            .map(
              (alias) => `<li><code class="param-name">${esc(alias)}</code><span class="insp-stale-value">${esc(branchLabel(n.repoBranches![alias]))}</span><button type="button" class="icon-btn sm"
                data-repo-remove="${esc(alias)}" title="Remove" aria-label="Remove the branch for ${esc(alias)}">${icon("dismiss")}</button></li>`
            )
            .join("")}</ul>
        </div>`
      : "";
    body = `${list}${staleHtml}
      <div class="insp-params-foot">
        <span class="insp-hint">From the YAML on ${esc(branchLabel(n.branch || entry.info.defaultBranch))}.${repos.length ? " Leave a branch empty to use the ref the YAML names." : ""}</span>
        <button type="button" class="btn sm insp-params-btn" data-repos-reload="reload" title="Read the YAML again">${icon("sync")}Reload</button>
      </div>`;
  }
  return `<details class="insp-section insp-repos"${reposOpen ? " open" : ""}>
      <summary class="insp-repos-summary"><span class="insp-label">Repositories</span><span class="insp-repos-count${count.tone ? ` tone-${count.tone}` : ""}">${esc(count.text)}</span>${icon("chevron")}</summary>
      <div class="insp-params-body">${body}</div>
    </details>`;
}

function repoFieldHtml(r: RepositoryResource, value: string, i: number): string {
  const id = `insp-repo-${i}`;
  const yamlRef = r.ref ? branchLabel(r.ref) : "its default branch";
  const where = [r.name.toLowerCase() !== r.alias.toLowerCase() ? r.name : "", r.project || "", r.type && r.type.toLowerCase() !== "tfsgit" ? r.type : ""]
    .filter(Boolean)
    .join(" · ");
  return `<div class="repo${value.trim() ? " is-changed" : ""}">
      <div class="repo-head"><label class="repo-alias" for="${id}">${esc(r.alias)}</label>${where ? `<span class="repo-where" title="${esc(where)}">${esc(where)}</span>` : ""}</div>
      <span class="insp-input">${icon("branch")}<input id="${id}" class="repo-branch" data-repo="${esc(r.alias)}" data-yaml-ref="${esc(yamlRef)}" value="${esc(value)}"
        placeholder="${esc(r.ref ? branchLabel(r.ref) : "Default branch")}" spellcheck="false" autocomplete="off" aria-describedby="${id}-hint"></span>
      <span class="insp-hint" id="${id}-hint">${esc(repoHint(value, yamlRef))}</span>
    </div>`;
}

/** Updates one repository row (and the count) in place, so typing never re-renders the field. */
function syncRepoRow(n: ChainNode, input: HTMLInputElement): void {
  const row = input.closest<HTMLElement>(".repo");
  row?.classList.toggle("is-changed", !!input.value.trim());
  const hint = row?.querySelector<HTMLElement>(".insp-hint");
  if (hint) hint.textContent = repoHint(input.value, input.dataset.yamlRef || "the YAML's ref");
  const count = inspector.querySelector<HTMLElement>(".insp-repos-count");
  if (count) {
    const c = repoCount(n);
    count.textContent = c.text;
    count.className = `insp-repos-count${c.tone ? ` tone-${c.tone}` : ""}`;
  }
}

/** Which earlier block's build each `resources.pipelines` entry uses (shown once the YAML is read). */
function consumesHtml(n: ChainNode): string {
  const entry = infoCache.get(infoKey(n));
  if (entry?.status !== "ready" || !entry.info.resources.length) return "";
  const block = (id: string): string => `<button type="button" class="insp-inline" data-select="${esc(id)}">${esc(nodeName(id))}</button>`;
  const items = resourceSources(doc.graph, n.id, entry.info.resources).map((r) => {
    let tone: string;
    let text: string;
    if (r.from) {
      tone = "is-linked";
      text = `Uses the build from ${block(r.from)} when it passes earlier in the same run. ${earlierBuildText(r.from)}`;
    } else if (r.tied.length) {
      tone = "is-tied";
      // Ties only happen between blocks of the same pipeline, so the name is shared.
      const count = r.tied.length === 2 ? "Two" : String(r.tied.length);
      text = `${count} ${esc(nodeName(r.tied[0]))} blocks run before it, equally close. This block fails when it can't tell which build to use. Remove one of the arrows.`;
    } else {
      tone = "";
      text = "Not built by this chain. Azure DevOps uses its default build.";
    }
    const glyph = r.from ? "flow" : r.tied.length ? "warning" : "pipeline";
    return `<li class="consume ${tone}">
        <div class="consume-head">${icon(glyph)}<code class="consume-alias">${esc(r.alias)}</code>${r.name.toLowerCase() !== r.alias.toLowerCase() ? `<span class="consume-name">${esc(r.name)}</span>` : ""}</div>
        <p class="consume-text">${text}</p>
      </li>`;
  });
  return `<div class="insp-section insp-consumes">
      <h3 class="insp-label">Consumes</h3>
      <ul class="consume-list">${items.join("")}</ul>
    </div>`;
}

/** What a consumer falls back to when its upstream block didn't build in the same run. */
function earlierBuildText(id: string): string {
  const n = nodeById(id);
  const past = n && lastAppBuild(n, appBuilds);
  const name = esc(nodeName(id));
  if (!past) return `Otherwise Azure DevOps uses its default build, because this app hasn't built ${name} on its current branch yet.`;
  const url = past.url && /^https:\/\//i.test(past.url) ? past.url : "";
  const build = url
    ? `<a class="insp-inline" href="${esc(url)}" target="_blank" rel="noreferrer">${esc(past.buildNumber)}</a>`
    : `<b>${esc(past.buildNumber)}</b>`;
  const when = timeAgo(past.finishedAt, Date.now());
  return `Otherwise it uses ${name}'s last build from this app, ${build}${when ? ` (${when})` : ""}.`;
}

function nodeActionsHtml(id: string): string {
  const live = liveRun();
  const s = live?.states[id];
  if (s && isActive(s.status)) {
    const check = stopCheck(s);
    const hint = s.stopRequested ? "Canceling its build in Azure DevOps." : check.ok ? "Cancels its build. Blocks that wait for it are skipped." : check.reason!;
    return `<div class="insp-actions">
        <button type="button" class="btn insp-action is-stop" data-block-action="stop"${check.ok ? "" : " disabled"}>${s.stopRequested ? `<span class="spinner" aria-hidden="true"></span>Stopping…` : `${icon("stop")}Stop pipeline`}</button>
        <span class="insp-hint">${esc(hint)}</span>
      </div>`;
  }
  const scope = scopeFor(id);
  const rest = scope.ids.length - 1;
  const restText = rest === 1 ? "the block after it" : `the ${rest} blocks after it`;
  const hint = scope.blocked
    ? scope.blocked
    : live
      ? `Joins the running chain${rest ? ` with ${restText}` : ""}.`
      : rest
        ? `Runs this pipeline, then ${restText}.`
        : "Runs just this pipeline.";
  return `<div class="insp-actions">
      <button type="button" class="btn accent insp-action" data-block-action="run"${scope.blocked ? " disabled" : ""}>${icon("play")}Run from here</button>
      <span class="insp-hint">${esc(hint)}</span>
    </div>`;
}

function nodeRunHtml(id: string): string {
  const view = blockViews(doc.graph, run, results)[id];
  const live = liveRun();
  const notInRun = `<p class="insp-muted">Not part of this run. Run from here adds it to this run.</p>`;
  if (!view) return live ? `<h3 class="insp-label">This run</h3>${notInRun}` : "";
  const s = view.state;
  const elapsed = nodeElapsed(s, Date.now());
  const label = s.stopRequested && isActive(s.status) ? "Stopping…" : statusLabel(s.status);
  const build = s.buildNumber || (s.buildId ? `#${s.buildId}` : "");
  const url = s.url && /^https:\/\//i.test(s.url) ? s.url : "";
  const buildHtml = build
    ? url
      ? `<a class="insp-link" href="${esc(url)}" target="_blank" rel="noreferrer">Build ${esc(build)}${icon("external")}</a>`
      : `<span class="insp-muted">Build ${esc(build)}</span>`
    : "";
  const notes = [s.error, s.cancelError && `Couldn't cancel: ${s.cancelError}`, s.pollError && `Last status check failed: ${s.pollError}`].filter(Boolean) as string[];
  const pins = s.resources?.length
    ? `<ul class="insp-pins">${s.resources
        .map(
          (p) =>
            `<li>${icon("flow")}<span><code>${esc(p.alias)}</code> uses build ${esc(p.version)} from ${esc(nodeName(p.from))}${p.runId ? ", built in an earlier run" : ""}</span></li>`,
        )
        .join("")}</ul>`
    : "";
  const set = s.params ? Object.keys(s.params).length : 0;
  const repos = Object.entries(s.repoBranches ?? {});
  const at = s.finishedAt ?? s.startedAt ?? s.queuedAt;
  const when = view.live
    ? ""
    : at
      ? `<p class="insp-muted">${s.finishedAt ? "Finished" : "Started"} ${esc(timeAgo(at, Date.now()))}${view.earlier ? ", in an earlier run" : ""}</p>`
      : view.earlier
        ? `<p class="insp-muted">From an earlier run</p>`
        : "";
  return `<h3 class="insp-label">${view.live ? "This run" : "Last run"}</h3>
    <div class="insp-run-status">${statusDot(s.status)}<span>${esc(label)}</span>${elapsed !== null ? `<span class="insp-run-time">${formatElapsed(elapsed)}</span>` : ""}</div>
    ${when}
    ${buildHtml}
    ${pins}
    ${set ? `<p class="insp-muted">Queued with ${set} changed ${set === 1 ? "parameter" : "parameters"}.</p>` : ""}
    ${repos.length ? `<p class="insp-muted">Queued with ${repos.map(([a, ref]) => `<code>${esc(a)}</code> on ${esc(branchLabel(ref))}`).join(", ")}.</p>` : ""}
    ${s.manual ? `<p class="insp-muted">Started from here, so it didn't wait for the blocks before it.</p>` : ""}
    ${notes.map((note) => `<p class="insp-run-note">${esc(note)}</p>`).join("")}
    ${live && !view.live ? notInRun : ""}`;
}

function edgeHtml(from: string, to: string): string {
  return `<div class="insp-head">
      <span class="insp-head-icon">${icon("flow")}</span>
      <div class="insp-head-text"><h2 class="insp-name">Arrow</h2><span class="insp-sub">${esc(nodeName(from))} → ${esc(nodeName(to))}</span></div>
      <button type="button" class="icon-btn insp-close" title="Close details (Esc)" aria-label="Close details">${icon("dismiss")}</button>
    </div>
    <div class="insp-section">
      <p class="insp-text"><b>${esc(nodeName(to))}</b> starts after <b>${esc(nodeName(from))}</b> passes. Partially succeeded counts as passed.</p>
      <p class="insp-text">If it fails or is canceled, ${esc(nodeName(to))} and everything after it are skipped.</p>
    </div>
    <button type="button" class="btn insp-remove" data-remove-edge="${esc(from)}>${esc(to)}">${icon("trash")}Remove arrow</button>`;
}

function onInspectorClick(e: MouseEvent): void {
  const t = e.target as Element;
  const btn = t.closest<HTMLButtonElement>("button");
  if (!btn || btn.disabled) return;
  if (btn.classList.contains("insp-close")) {
    selection = null;
    canvas.setSelection(null);
    renderInspector();
    canvas.el.focus({ preventScroll: true });
  } else if (btn.dataset.select) {
    const id = btn.dataset.select;
    selection = { kind: "node", id };
    canvas.setSelection(selection);
    renderInspector();
    canvas.reveal(id);
    canvas.focusNode(id);
  } else if (btn.dataset.unlink) {
    const [from, to] = btn.dataset.unlink.split(">");
    pushUndo();
    const graph = cloneGraph(doc.graph);
    graph.edges = graph.edges.filter((x) => !(x.from === from && x.to === to));
    commit(graph);
    announce("Removed the arrow");
  } else if (btn.dataset.removeNode) {
    remove({ kind: "node", id: btn.dataset.removeNode });
  } else if (btn.dataset.blockAction && selection?.kind === "node") {
    if (btn.dataset.blockAction === "run") confirmTrigger(selection.id);
    else confirmStopNode(selection.id);
  } else if (btn.dataset.removeEdge) {
    const [from, to] = btn.dataset.removeEdge.split(">");
    remove({ kind: "edge", from, to });
  } else if (selection?.kind === "node") {
    onParamsClick(btn, selection.id);
  }
}

function onParamsClick(btn: HTMLButtonElement, id: string): void {
  const summary = (): void => inspector.querySelector<HTMLElement>(".insp-params-summary")?.focus({ preventScroll: true });
  const name = btn.dataset.paramReset ?? btn.dataset.paramRemove;
  if (name !== undefined) {
    editNode(id, (n) => (n.params = setParam(n.params, name, undefined)), false);
    const control = inspector.querySelector<HTMLElement>(`[data-param="${CSS.escape(name)}"]`);
    if (control) control.focus({ preventScroll: true });
    else summary();
    announce(btn.dataset.paramReset !== undefined ? `${name} uses its default` : `Removed the value for ${name}`);
  } else if (btn.dataset.paramsClear !== undefined) {
    editNode(id, (n) => delete n.params, false);
    summary();
    announce("Cleared the parameters");
  } else if (btn.dataset.paramsReload !== undefined) {
    const n = nodeById(id);
    if (!n) return;
    void requestInfo(n, true);
    renderInspector();
    summary();
  } else if (btn.dataset.repoRemove !== undefined) {
    const alias = btn.dataset.repoRemove;
    editNode(id, (n) => (n.repoBranches = setRepoBranch(n.repoBranches, alias, "")), false);
    reposSummary();
    announce(`Removed the branch for ${alias}`);
  } else if (btn.dataset.reposClear !== undefined) {
    editNode(id, (n) => delete n.repoBranches, false);
    reposSummary();
    announce("Cleared the repository branches");
  } else if (btn.dataset.reposReload !== undefined) {
    const n = nodeById(id);
    if (!n) return;
    void requestInfo(n, true);
    renderInspector();
    reposSummary();
  }
}

const reposSummary = (): void => inspector.querySelector<HTMLElement>(".insp-repos-summary")?.focus({ preventScroll: true });

/** Applies an edit to one block. Typing in a field (`grouped`) undoes as one step per focus. */
function editNode(id: string, fn: (n: ChainNode) => void, grouped: boolean): ChainNode | null {
  const graph = cloneGraph(doc.graph);
  const n = graph.nodes.find((node) => node.id === id);
  if (!n) return null;
  if (!grouped || !fieldUndoPushed) pushUndo();
  if (grouped) fieldUndoPushed = true;
  fn(n);
  if (!n.params) delete n.params;
  if (!n.repoBranches) delete n.repoBranches;
  commit(graph, !grouped);
  return n;
}

/** Stores `value` for a parameter; the default clears the override, so only changes are sent. */
function paramValue(def: RunParameter, value: string): (n: ChainNode) => void {
  return (n) => {
    n.params = setParam(n.params, def.name, isDefaultValue(def, value) ? undefined : value);
  };
}

function onInspectorChange(e: Event): void {
  const t = e.target as HTMLElement;
  if (selection?.kind !== "node") return;
  if (t instanceof HTMLSelectElement && t.classList.contains("insp-add-up")) {
    if (t.value) connect(t.value, selection.id);
    return;
  }
  if (t instanceof HTMLSelectElement && t.classList.contains("insp-follow")) {
    const owner = ownerOf(doc.id);
    const listed = owner ? ownerPrs.get(owner.taskId)?.prs.find((p) => prValue(p) === t.value) : undefined;
    const n = nodeById(selection.id);
    const kept = n?.branchFrom && prValue(n.branchFrom) === t.value ? n.branchFrom : null;
    const pr = t.value ? (listed ? { org: listed.org, prId: listed.prId } : kept) : null;
    editNode(
      selection.id,
      (node) => {
        if (pr) {
          node.branchFrom = { ...pr };
          node.branch = "";
        } else delete node.branchFrom;
      },
      false
    );
    announce(pr ? `Follows PR ${pr.prId}` : "Builds a branch you type");
    renderInspector();
    return;
  }
  // Text fields commit on `input`; only selects and switches commit here.
  const name = t.dataset.param;
  const isSwitch = t instanceof HTMLInputElement && t.type === "checkbox";
  if (name === undefined || !(t instanceof HTMLSelectElement || isSwitch)) return;
  const n = nodeById(selection.id);
  const def = n && paramDef(n, name);
  if (!def) return;
  editNode(selection.id, paramValue(def, isSwitch ? String((t as HTMLInputElement).checked) : (t as HTMLSelectElement).value), false);
}

function onInspectorInput(e: Event): void {
  const t = e.target as HTMLElement;
  if (selection?.kind !== "node") return;
  const id = selection.id;
  if (t instanceof HTMLInputElement && t.classList.contains("insp-branch")) {
    if (!editNode(id, (n) => (n.branch = t.value), true)) return;
    const runSection = inspector.querySelector<HTMLElement>(".insp-run");
    if (runSection) runSection.innerHTML = nodeRunHtml(id);
    // Parameters and consumed pipelines come from the YAML on that branch: re-read once typing pauses.
    window.clearTimeout(infoTimer);
    infoTimer = window.setTimeout(() => {
      if (selection?.kind === "node" && selection.id === id) renderInspector();
    }, INFO_DELAY);
    return;
  }
  const alias = t.dataset.repo;
  if (alias !== undefined && t instanceof HTMLInputElement) {
    const next = editNode(id, (n) => (n.repoBranches = setRepoBranch(n.repoBranches, alias, t.value)), true);
    if (next) syncRepoRow(next, t);
    return;
  }
  const name = t.dataset.param;
  const text = t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && t.type === "text");
  if (name === undefined || !text) return;
  const n = nodeById(id);
  const def = n && paramDef(n, name);
  if (!def) return;
  const next = editNode(id, paramValue(def, (t as HTMLInputElement | HTMLTextAreaElement).value), true);
  if (next) syncParamRow(next, def);
}

// ---- keyboard -----------------------------------------------------------------------------

function isTextField(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  return t instanceof HTMLInputElement && !["checkbox", "radio", "button"].includes(t.type);
}

function onGlobalKey(e: KeyboardEvent): void {
  if (!visible || e.defaultPrevented || document.body.dataset.page === "settings" || document.querySelector(".ask-overlay")) return;
  const zoom = paneZoomCommand(e);
  if (zoom) {
    e.preventDefault();
    canvas.zoomStep(zoom === "in" ? 1 : zoom === "out" ? -1 : 0);
    return;
  }
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === "f") {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  } else if (key === "s") {
    e.preventDefault();
    void flushSave();
  } else if (!isTextField(e.target) && key === "z") {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  } else if (!isTextField(e.target) && key === "y") {
    e.preventDefault();
    redo();
  }
}

// ---- helpers ------------------------------------------------------------------------------

const nodeById = (id: string): ChainNode | undefined => doc.graph.nodes.find((n) => n.id === id);
const nodeName = (id: string): string => nodeById(id)?.name || id;
const branchLabel = (branch: string): string => branch.trim().replace(/^refs\/heads\//, "") || "Default branch";
const chainTitle = (): string => doc.name.trim() || "Untitled chain";
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function statusDot(status: string | undefined): string {
  if (!status) return `<span class="chain-dot tone-idle"></span>`;
  const tone = statusTone(status);
  return tone === "run" ? `<span class="spinner" aria-hidden="true"></span>` : `<span class="chain-dot tone-${tone}" aria-hidden="true"></span>`;
}

function mostRecent(): ChainSummary | undefined {
  return [...chains].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
}

function announce(msg: string): void {
  live.textContent = "";
  requestAnimationFrame(() => (live.textContent = msg));
}
