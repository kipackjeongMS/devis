// The code window's view: the files one worker changed, as a tree of repos and folders,
// beside the picked file's diff. Read only. The window polls its own worker over the local
// API, so the main window never has to push anything here. The URL hash keeps the
// comparison and the file, so a reload (or a service restart on a new port) lands on the
// same spot. Below about 900px the tree folds into a file picker (CSS picks the layout).
// askQueue.ts adds "Ask <worker>" on top: line and file selection, a queue, and Send all.
import { mountAskQueue, type AskQueue } from "./askQueue.js";
import { diffTable } from "./diffTable.js";
import { icon, type IconName } from "./icons.js";
import { closeIdePicker, idePickerHtml } from "./idePicker.js";
import { WORKER_LABEL, WORKER_TONE, workerState, type WorkerState } from "./jarvisModel.js";
import type { DiffLine } from "./types.js";
import { esc } from "./util.js";

export type ChangesMode = "branch" | "uncommitted" | "last";
type Status = "A" | "M" | "D" | "R" | "U" | "T";

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: Status;
  added: number | null;
  removed: number | null;
  binary?: boolean;
  size?: number;
  mtimeMs?: number;
}

export interface RepoChanges {
  key: string;
  name: string;
  branch: string;
  base: string;
  fromRef: string | null;
  head: string | null;
  note?: string;
  error?: string;
  truncated?: number;
  files: ChangedFile[];
}

export interface WorkerChanges {
  mode: ChangesMode;
  at: string;
  worker: { name: string; task: string; busy: boolean; state: string; taskId?: string };
  repos: RepoChanges[];
}

export interface FileDiff {
  hunks?: DiffLine[][];
  tooLarge?: boolean;
  binary?: boolean;
  oldCount?: number;
  newCount?: number;
  oldSize?: number;
  newSize?: number;
  editable: boolean;
  hash?: string;
}

export interface Intervals {
  /** List poll while the worker is working. */
  busy: number;
  /** List poll while it's idle. */
  idle: number;
  /** First retry after a failed poll. Doubles up to retryMax. */
  retry: number;
  retryMax: number;
  /** One more poll this long after the worker stops working, to catch its last writes. */
  settle: number;
  /** How often "Updated Ns ago" ticks. */
  tick: number;
  /** Focusing the window refreshes, at most this often. */
  focusGap: number;
}

export const DEFAULT_INTERVALS: Intervals = {
  busy: 10_000,
  idle: 30_000,
  retry: 3_000,
  retryMax: 15_000,
  settle: 1_500,
  tick: 5_000,
  focusGap: 2_000,
};

export interface ChangesOptions {
  /** The worker's session id. */
  worker: string;
  intervals?: Partial<Intervals>;
  /** Called when the worker's name or task title changes, for the window title. */
  onTitle?: (name: string, task: string) => void;
}

export interface ChangesView {
  refresh(): Promise<void>;
  destroy(): void;
}

const MODES: ReadonlyArray<{ id: ChangesMode; label: string }> = [
  { id: "branch", label: "Since branching" },
  { id: "uncommitted", label: "Uncommitted" },
  { id: "last", label: "Last commit" },
];

const STATUS_LABEL: Record<Status, string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
  U: "Untracked",
  T: "Type changed",
};

const STATUS_TONE: Record<Status, string> = { A: "add", U: "add", D: "del", R: "acc", T: "warn", M: "" };

/** Mirrors CHANGE_LIMITS in src/worker-changes.mts, for the "too big" wording only. */
const LINE_LIMIT = 6000;
const BYTE_LIMIT = 2 * 1024 * 1024;

const TREE_WIDTH_KEY = "devis.codeWindow.treeWidth";
const TREE_DEFAULT = 300;
const TREE_MIN = 200;

const IDE_NAME: Record<string, string> = { "vscode-insiders": "VSCode Insiders", vscode: "VSCode" };

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Status 0 means the service didn't answer at all. */
async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new HttpError("Devis's service isn't answering.", 0);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Not JSON. The status says enough.
  }
  if (!res.ok) {
    const said = data && typeof (data as { error?: unknown }).error === "string" ? (data as { error: string }).error : "";
    throw new HttpError(said || `The service said ${res.status}.`, res.status);
  }
  return data as T;
}

const nf = new Intl.NumberFormat("en-US");
const num = (v: number): string => nf.format(v);
const svg = (name: IconName): string => icon(name);
const PICK_CHECK = icon("check").replace('class="ic ic-check"', 'class="ic ic-check cw-pickck"');
const isMode = (v: unknown): v is ChangesMode => MODES.some((m) => m.id === v);
const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
const shortSha = (sha: string | null): string => (sha ? sha.slice(0, 7) : "");

function bytes(v?: number): string {
  if (v == null) return "";
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function counts(added: number | null, removed: number | null): string {
  return (
    (added ? `<span class="cw-plus">+${num(added)}</span>` : "") +
    (removed ? `<span class="cw-minus">\u2212${num(removed)}</span>` : "")
  );
}

function filesWord(n: number): string {
  return `${num(n)} ${n === 1 ? "file" : "files"}`;
}

// ---- tree model --------------------------------------------------------------------------

interface FileNode {
  kind: "file";
  key: string;
  repo: RepoChanges;
  file: ChangedFile;
  name: string;
  dir: string;
}

interface DirNode {
  kind: "dir";
  key: string;
  name: string;
  path: string;
  dirs: Map<string, DirNode>;
  files: FileNode[];
}

interface RepoNode {
  key: string;
  repo: RepoChanges;
  root: DirNode;
  /** Every file in tree order: folders first, then names. */
  files: FileNode[];
}

const fileKey = (repo: string, path: string): string => JSON.stringify(["f", repo, path]);
const dirKey = (repo: string, path: string): string => JSON.stringify(["d", repo, path]);
const repoKey = (repo: string): string => JSON.stringify(["r", repo]);

function sortedDirs(dir: DirNode): DirNode[] {
  return [...dir.dirs.values()].sort((a, b) => byName(a.name, b.name));
}

function sortedFiles(dir: DirNode): FileNode[] {
  return [...dir.files].sort((a, b) => byName(a.name, b.name));
}

function walkFiles(dir: DirNode, out: FileNode[]): FileNode[] {
  for (const d of sortedDirs(dir)) walkFiles(d, out);
  out.push(...sortedFiles(dir));
  return out;
}

function buildRepo(repo: RepoChanges): RepoNode {
  const root: DirNode = { kind: "dir", key: dirKey(repo.key, ""), name: "", path: "", dirs: new Map(), files: [] };
  for (const file of repo.files) {
    const parts = file.path.split("/");
    const name = parts.pop() || file.path;
    let at = root;
    for (const part of parts) {
      let next = at.dirs.get(part);
      if (!next) {
        const path = at.path ? `${at.path}/${part}` : part;
        next = { kind: "dir", key: dirKey(repo.key, path), name: part, path, dirs: new Map(), files: [] };
        at.dirs.set(part, next);
      }
      at = next;
    }
    at.files.push({ kind: "file", key: fileKey(repo.key, file.path), repo, file, name, dir: parts.join("/") });
  }
  return { key: repoKey(repo.key), repo, root, files: walkFiles(root, []) };
}

/** A folder with one subfolder and no files shows as one row: "web/src". */
function compact(dir: DirNode): { node: DirNode; label: string } {
  let node = dir;
  let label = dir.name;
  while (node.files.length === 0 && node.dirs.size === 1) {
    node = node.dirs.values().next().value as DirNode;
    label += `/${node.name}`;
  }
  return { node, label };
}

// ---- the view ----------------------------------------------------------------------------

export function mountWorkerChanges(root: HTMLElement, options: ChangesOptions): ChangesView {
  const iv: Intervals = { ...DEFAULT_INTERVALS, ...options.intervals };
  const worker = options.worker;

  const hash = new URLSearchParams(location.hash.slice(1));
  const hashMode = hash.get("mode");
  let mode: ChangesMode = isMode(hashMode) ? hashMode : "branch";
  let sel: { repo: string; path: string } | null =
    hash.get("repo") && hash.get("path") ? { repo: hash.get("repo") as string, path: hash.get("path") as string } : null;

  let data: WorkerChanges | null = null;
  let repoNodes: RepoNode[] = [];
  let files: FileNode[] = [];
  let fileByKey = new Map<string, FileNode>();
  const collapsed = new Set<string>();
  let activeKey = "";
  let treeSig = "";
  let lastAt = 0;
  let lastTitle = "";

  let offline = false;
  let listError = "";
  let notice = "";
  let noticeTimer: number | undefined;
  let removed = false;
  let destroyed = false;

  let timer: number | undefined;
  let retryDelay = iv.retry;
  let settlePending = false;
  let lastStart = 0;
  let listCtl: AbortController | null = null;
  let listToken = 0;

  let diffCtl: AbortController | null = null;
  let diffToken = 0;
  let shownKey = "";
  let shownSig = "";
  let diffBroken = false;
  let skeletonTimer: number | undefined;

  const opening = new Set<string>();
  let pickKeys: string[] = [];
  let pickActive = 0;
  let ask: AskQueue | null = null;

  root.classList.add("cw");
  root.innerHTML = `
    <div class="cw-banner" role="status" hidden></div>
    <div class="cw-toolbar" role="toolbar" aria-label="Changes">
      <span class="cw-chip"><span class="cw-dot" aria-hidden="true"></span><span class="cw-chip-nm">Worker</span><span class="cw-chip-st" aria-live="polite"></span></span>
      <span class="cw-vr" aria-hidden="true"></span>
      <div class="cw-seg" role="radiogroup" aria-label="Compare">
        ${MODES.map((m) => `<button type="button" role="radio" class="cw-seg-btn" data-mode="${m.id}">${m.label}</button>`).join("")}
      </div>
      <select class="cw-mode-select" aria-label="Compare">
        ${MODES.map((m) => `<option value="${m.id}">${m.label}</option>`).join("")}
      </select>
      <span class="cw-totals"></span>
      <span class="cw-sp"></span>
      <span class="cw-updated"></span>
      <button type="button" class="btn sm ghost cw-icon" data-act="refresh" aria-label="Refresh" title="Refresh (F5)">${svg("sync")}</button>
      <span class="cw-vr cw-wide" aria-hidden="true"></span>
      ${idePickerHtml({ id: "cw-open-in", action: "ide" })}
    </div>
    <div class="cw-picker">
      <button type="button" class="btn sm ghost cw-icon" data-act="prev" aria-label="Previous file" title="Previous file (Alt+\u2191)">${svg("up")}</button>
      <button type="button" class="cw-pick" aria-haspopup="dialog" aria-expanded="false">
        <span class="cw-pick-nm">No file</span><b class="cw-st" hidden></b><span class="cw-sp"></span><span class="cw-pick-pos"></span>${svg("down")}
      </button>
      <button type="button" class="btn sm ghost cw-icon" data-act="next" aria-label="Next file" title="Next file (Alt+\u2193)">${svg("down")}</button>
      <div class="cw-dd" role="dialog" aria-label="Pick a file" hidden>
        <label class="cw-filter">${svg("search")}<input type="search" placeholder="Filter files" aria-label="Filter files" aria-controls="cw-pick-list" aria-autocomplete="list" autocomplete="off" spellcheck="false" /></label>
        <div class="cw-pick-list" id="cw-pick-list" role="listbox" aria-label="Changed files"></div>
      </div>
    </div>
    <div class="cw-split" aria-busy="true">
      <nav class="cw-side" aria-label="Changed files">
        <div class="cw-tree" role="tree" aria-label="Changed files"></div>
      </nav>
      <div class="cw-grip" role="separator" aria-orientation="vertical" aria-label="Resize the file tree" tabindex="0" title="Drag to resize. Double-click to reset."></div>
      <section class="cw-pane" aria-label="Diff">
        <header class="cw-dhead"></header>
        <div class="cw-dbody" tabindex="-1"></div>
      </section>
    </div>
    <div class="cw-gone" hidden></div>
    <footer class="cw-status"><span class="cw-status-repo"></span><span class="cw-status-cmp"></span><span class="cw-sp"></span><span class="cw-status-hint">Alt+\u2191 / Alt+\u2193 next file \u00b7 F5 refresh</span></footer>
  `;

  const $ = <T extends Element>(sel: string): T => root.querySelector(sel) as T;
  const banner = $<HTMLElement>(".cw-banner");
  const toolbar = $<HTMLElement>(".cw-toolbar");
  const chipNm = $<HTMLElement>(".cw-chip-nm");
  const chipSt = $<HTMLElement>(".cw-chip-st");
  const dot = $<HTMLElement>(".cw-dot");
  const seg = $<HTMLElement>(".cw-seg");
  const modeSelect = $<HTMLSelectElement>(".cw-mode-select");
  const totals = $<HTMLElement>(".cw-totals");
  const updated = $<HTMLElement>(".cw-updated");
  const refreshBtn = $<HTMLButtonElement>('[data-act="refresh"]');
  const picker = $<HTMLElement>(".cw-picker");
  const pickBtn = $<HTMLButtonElement>(".cw-pick");
  const pickNm = $<HTMLElement>(".cw-pick-nm");
  const pickSt = $<HTMLElement>(".cw-pick .cw-st");
  const pickPos = $<HTMLElement>(".cw-pick-pos");
  const dd = $<HTMLElement>(".cw-dd");
  const filter = $<HTMLInputElement>(".cw-filter input");
  const pickList = $<HTMLElement>(".cw-pick-list");
  const split = $<HTMLElement>(".cw-split");
  const tree = $<HTMLElement>(".cw-tree");
  const grip = $<HTMLElement>(".cw-grip");
  const head = $<HTMLElement>(".cw-dhead");
  const body = $<HTMLElement>(".cw-dbody");
  const gone = $<HTMLElement>(".cw-gone");
  const status = $<HTMLElement>(".cw-status");
  const statusRepo = $<HTMLElement>(".cw-status-repo");
  const statusCmp = $<HTMLElement>(".cw-status-cmp");

  const workerName = (): string => data?.worker.name || "This worker";

  // ---- skeletons and states ----

  const skelBars = (widths: number[]): string =>
    widths.map((w) => `<span class="cw-skel" style="width:${w}%"></span>`).join("");
  const TREE_SKELETON = `<div class="cw-skeleton" aria-hidden="true">${skelBars([70, 90, 55, 80, 62, 85, 48, 74])}</div>`;
  const DIFF_SKELETON = `<div class="cw-skeleton cw-skeleton-diff" aria-hidden="true">${skelBars([45, 92, 80, 96, 38, 72, 88, 60, 84, 50])}</div><span class="visually-hidden">Loading</span>`;

  interface StateSpec {
    icon: IconName;
    tone?: "ok" | "caution" | "bad";
    title: string;
    /** HTML. Escape anything that came from the server. */
    text?: string;
    code?: string;
    actions?: string;
  }

  function stateHtml(s: StateSpec): string {
    return (
      `<div class="cw-state${s.tone ? ` ${s.tone}` : ""}">` +
      `<span class="cw-state-ic">${svg(s.icon)}</span>` +
      `<p class="cw-state-title">${esc(s.title)}</p>` +
      (s.text ? `<p class="cw-state-text">${s.text}</p>` : "") +
      (s.code ? `<code class="cw-state-code">${esc(s.code)}</code>` : "") +
      (s.actions ? `<div class="cw-state-acts">${s.actions}</div>` : "") +
      `</div>`
    );
  }

  const modeButton = (m: ChangesMode, label: string): string =>
    `<button type="button" class="btn sm" data-act="mode" data-mode="${m}">${esc(label)}</button>`;
  const retryButton = `<button type="button" class="btn sm" data-act="refresh">${svg("sync")}<span>Retry</span></button>`;
  const ideButtons = (): string => idePickerHtml({ id: "cw-file-open-in", action: "ide", opening });

  // ---- toolbar ----

  function renderModes(): void {
    for (const b of seg.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
      const on = b.dataset.mode === mode;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle("on", on);
    }
    modeSelect.value = mode;
  }

  function renderChip(): void {
    if (removed) {
      dot.dataset.tone = "off";
      chipSt.textContent = "Removed";
      chipNm.parentElement!.title = `${chipNm.textContent} · Removed`;
      return;
    }
    if (!data) return;
    const st = workerState({ state: data.worker.state as WorkerState, busy: data.worker.busy, requests: [] });
    chipNm.textContent = data.worker.name;
    chipSt.textContent = WORKER_LABEL[st] || "";
    chipNm.parentElement!.title = chipSt.textContent ? `${data.worker.name} · ${chipSt.textContent}` : data.worker.name;
    dot.dataset.tone = WORKER_TONE[st] || "idle";
  }

  function renderTotals(): void {
    if (!data) {
      totals.innerHTML = "";
      return;
    }
    let added = 0;
    let removedLines = 0;
    for (const f of files) {
      added += f.file.added || 0;
      removedLines += f.file.removed || 0;
    }
    totals.innerHTML = `<span class="cw-tot-files">${filesWord(files.length)}</span> ${counts(added, removedLines)}`;
  }

  function renderUpdated(): void {
    if (!lastAt) {
      updated.textContent = offline ? "Not loaded yet" : "";
      return;
    }
    const when = ago(Date.now() - lastAt);
    updated.textContent = offline || listError ? `Last updated ${when}` : `Updated ${when}`;
  }

  function renderBanner(): void {
    if (removed) {
      banner.hidden = true;
      return;
    }
    if (offline) {
      banner.className = "cw-banner caution";
      banner.innerHTML = `${svg("sync")}<span><b>Reconnecting.</b> Devis's service isn't answering right now. This window keeps your file and picks up when it's back.</span>`;
    } else if (listError) {
      banner.className = "cw-banner bad";
      banner.innerHTML = `${svg("warning")}<span><b>Couldn't refresh.</b> ${esc(listError)}</span><span class="cw-banner-acts">${retryButton}</span>`;
    } else if (notice) {
      banner.className = "cw-banner bad";
      banner.innerHTML = `${svg("warning")}<span>${esc(notice)}</span><span class="cw-banner-acts"><button type="button" class="btn sm ghost cw-icon" data-act="dismiss" aria-label="Dismiss">${svg("dismiss")}</button></span>`;
    } else {
      banner.hidden = true;
      banner.innerHTML = "";
      return;
    }
    banner.hidden = false;
  }

  function showNotice(text: string): void {
    notice = text;
    renderBanner();
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      notice = "";
      renderBanner();
    }, 8000);
  }

  function setRefreshing(on: boolean): void {
    refreshBtn.classList.toggle("cw-spinning", on);
    split.setAttribute("aria-busy", String(on && !data));
  }

  // ---- tree ----

  function repoMeta(r: RepoChanges, open: boolean): string {
    const rows: string[] = [];
    const meta = (html: string, cls = ""): void => {
      rows.push(`<div class="cw-meta${cls}" role="none">${html}</div>`);
    };
    meta(`${svg("branch")}<span class="cw-nm" title="${esc(r.branch)}">${esc(r.branch || "detached")}</span>`);
    if (r.error) {
      meta(
        `${svg("warning")}<span class="cw-nm" title="${esc(r.error)}">${esc(r.error)}</span><button type="button" class="btn sm ghost" data-act="refresh">Retry</button>`,
        " bad",
      );
      return rows.join("");
    }
    if (!open) return rows.join("");
    const from =
      mode === "branch"
        ? `from ${r.base}${r.fromRef ? ` \u00b7 ${r.fromRef}` : ""}`
        : mode === "uncommitted"
          ? `on top of ${shortSha(r.head)}`
          : r.fromRef
            ? `commit ${shortSha(r.head)}`
            : `first commit ${shortSha(r.head)}`;
    meta(`<span class="cw-nm" title="${esc(from)}">${esc(from)}</span>`, " cw-from");
    if (r.note) meta(`<span class="cw-nm">${esc(r.note)}</span>`);
    if (r.truncated) meta(`<span class="cw-nm">Showing the first ${filesWord(r.files.length)}. ${num(r.truncated)} more not shown.</span>`, " caution");
    return rows.join("");
  }

  function fileRow(f: FileNode, level: number): string {
    const x = f.file;
    const parts = [x.path, STATUS_LABEL[x.status]];
    if (x.oldPath) parts.push(`renamed from ${x.oldPath}`);
    if (x.binary) parts.push("binary");
    else {
      if (x.added) parts.push(`${x.added} added`);
      if (x.removed) parts.push(`${x.removed} removed`);
    }
    const title = x.oldPath ? `${x.path}\nRenamed from ${x.oldPath}` : x.path;
    return (
      `<div class="cw-row cw-file${x.status === "D" ? " del" : ""}" role="treeitem" aria-level="${level}" aria-selected="false" ` +
      `aria-label="${esc(parts.join(", "))}" data-key="${esc(f.key)}" tabindex="-1" title="${esc(title)}" style="--d:${level - 1}">` +
      `<span class="cw-twist"></span>${svg("file")}${PICK_CHECK}<span class="cw-nm">${esc(f.name)}</span>` +
      `<span class="cw-r"><span class="cw-qmark" hidden></span>${x.binary ? `<span class="cw-n">bin</span>` : counts(x.added, x.removed)}<b class="cw-st cw-st-${x.status}" aria-hidden="true">${x.status}</b></span>` +
      `</div>`
    );
  }

  function dirRows(dir: DirNode, level: number, out: string[]): void {
    for (const d of sortedDirs(dir)) {
      const { node, label } = compact(d);
      const open = !collapsed.has(node.key);
      out.push(
        `<div class="cw-row cw-dir" role="treeitem" aria-level="${level}" aria-expanded="${open}" data-key="${esc(node.key)}" tabindex="-1" title="${esc(node.path)}" style="--d:${level - 1}">` +
          `<span class="cw-twist">${svg("chevron")}</span>${svg("folder")}<span class="cw-nm">${esc(label)}</span></div>`,
      );
      if (open) dirRows(node, level + 1, out);
    }
    for (const f of sortedFiles(dir)) out.push(fileRow(f, level));
  }

  function treeHtml(): string {
    const out: string[] = [];
    for (const r of repoNodes) {
      const open = !collapsed.has(r.key);
      let added = 0;
      let removedLines = 0;
      for (const f of r.repo.files) {
        added += f.added || 0;
        removedLines += f.removed || 0;
      }
      const n = r.repo.files.length + (r.repo.truncated || 0);
      out.push(
        `<div class="cw-row cw-repo" role="treeitem" aria-level="1" aria-expanded="${open}" data-key="${esc(r.key)}" tabindex="-1" style="--d:0">` +
          `<span class="cw-twist">${svg("chevron")}</span><span class="cw-nm">${esc(r.repo.name)}</span>` +
          `<span class="cw-r"><span class="cw-n" title="${esc(filesWord(n))}">${num(n)}</span>${counts(added, removedLines)}</span></div>`,
      );
      out.push(repoMeta(r.repo, open));
      if (open && !r.repo.error) dirRows(r.root, 2, out);
    }
    return out.join("");
  }

  const treeRows = (): HTMLElement[] => [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const rowFor = (key: string): HTMLElement | null => {
    for (const row of treeRows()) if (row.dataset.key === key) return row;
    return null;
  };

  function renderTree(force = false): void {
    if (!data) {
      tree.innerHTML = TREE_SKELETON;
      treeSig = "";
      return;
    }
    if (!data.repos.length) {
      tree.innerHTML = "";
      treeSig = "";
      return;
    }
    const sig = JSON.stringify([mode, data.repos, [...collapsed].sort()]);
    if (!force && sig === treeSig) return;
    treeSig = sig;
    const hadFocus = tree.contains(document.activeElement);
    const focusKey = hadFocus ? ((document.activeElement as HTMLElement).closest<HTMLElement>("[data-key]")?.dataset.key ?? "") : "";
    const top = tree.scrollTop;
    tree.innerHTML = treeHtml();
    tree.scrollTop = top;
    applySelection(false);
    if (hadFocus) {
      const row = (focusKey && rowFor(focusKey)) || rowFor(activeKey) || treeRows()[0];
      row?.focus({ preventScroll: true });
    }
  }

  /** One row is the tree's tab stop: the active one, else the selected file, else the first row. */
  function applyRoving(): void {
    const rows = treeRows();
    const target =
      (activeKey && rows.find((r) => r.dataset.key === activeKey)) ||
      rows.find((r) => r.getAttribute("aria-selected") === "true") ||
      rows[0];
    for (const r of rows) r.tabIndex = r === target ? 0 : -1;
  }

  function applySelection(reveal: boolean): void {
    const key = sel ? fileKey(sel.repo, sel.path) : "";
    for (const r of tree.querySelectorAll<HTMLElement>(".cw-file")) {
      const on = r.dataset.key === key;
      r.classList.toggle("sel", on);
      r.setAttribute("aria-selected", String(on));
      if (on && reveal) r.scrollIntoView({ block: "nearest" });
    }
    applyRoving();
    ask?.syncTree();
  }

  function focusRow(row: HTMLElement | undefined | null): void {
    if (!row) return;
    activeKey = row.dataset.key || "";
    applyRoving();
    row.focus();
    row.scrollIntoView({ block: "nearest" });
  }

  function toggle(key: string, open?: boolean): void {
    const isOpen = !collapsed.has(key);
    const want = open ?? !isOpen;
    if (want === isOpen) return;
    if (want) collapsed.delete(key);
    else collapsed.add(key);
    activeKey = key;
    renderTree(true);
  }

  /** Opens the repo and folders above a file so its row exists. */
  function expandTo(f: FileNode): boolean {
    let changed = collapsed.delete(repoKey(f.repo.key));
    const parts = f.dir ? f.dir.split("/") : [];
    for (let i = 1; i <= parts.length; i++) changed = collapsed.delete(dirKey(f.repo.key, parts.slice(0, i).join("/"))) || changed;
    return changed;
  }

  function onTreeClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (target.closest("[data-act]")) return;
    const row = target.closest<HTMLElement>('[role="treeitem"]');
    if (!row) return;
    const key = row.dataset.key || "";
    activeKey = key;
    const f = fileByKey.get(key);
    if (f) {
      if (ask?.treeClick(e, row)) return;
      select(f);
      row.focus({ preventScroll: true });
    } else {
      toggle(key);
    }
  }

  function onTreeKey(e: KeyboardEvent): void {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (!row || e.target !== row) return;
    if (ask?.treeKey(e, row)) {
      e.preventDefault();
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const rows = treeRows();
    const i = rows.indexOf(row);
    const key = row.dataset.key || "";
    const container = row.hasAttribute("aria-expanded");
    const open = row.getAttribute("aria-expanded") === "true";
    const level = Number(row.getAttribute("aria-level")) || 1;
    switch (e.key) {
      case "ArrowDown":
        focusRow(rows[i + 1]);
        break;
      case "ArrowUp":
        focusRow(rows[i - 1]);
        break;
      case "Home":
        focusRow(rows[0]);
        break;
      case "End":
        focusRow(rows[rows.length - 1]);
        break;
      case "ArrowRight":
        if (container && !open) toggle(key, true);
        else if (container && rows[i + 1] && Number(rows[i + 1]!.getAttribute("aria-level")) > level) focusRow(rows[i + 1]);
        break;
      case "ArrowLeft":
        if (container && open) toggle(key, false);
        else {
          for (let j = i - 1; j >= 0; j--) {
            if (Number(rows[j]!.getAttribute("aria-level")) < level) {
              focusRow(rows[j]);
              break;
            }
          }
        }
        break;
      case "Enter":
      case " ": {
        const f = fileByKey.get(key);
        if (f) {
          ask?.clearPicks();
          select(f);
        } else toggle(key);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  }

  // ---- picker (narrow windows) ----

  function renderPicker(): void {
    const f = current();
    const i = f ? files.indexOf(f) : -1;
    pickBtn.disabled = !files.length;
    pickNm.textContent = f ? f.name : files.length ? "Pick a file" : "No changed files";
    pickNm.title = f ? f.file.path : "";
    pickSt.hidden = !f;
    if (f) {
      pickSt.textContent = f.file.status;
      pickSt.className = `cw-st cw-st-${f.file.status}`;
    }
    pickPos.textContent = f ? `${i + 1}/${files.length}` : "";
    for (const b of picker.querySelectorAll<HTMLButtonElement>("[data-act=prev], [data-act=next]")) {
      b.disabled = !f || (b.dataset.act === "prev" ? i <= 0 : i >= files.length - 1);
    }
    if (!dd.hidden) renderPickList();
  }

  function renderPickList(): void {
    const q = filter.value.trim().toLowerCase();
    const key = sel ? fileKey(sel.repo, sel.path) : "";
    const out: string[] = [];
    pickKeys = [];
    for (const r of repoNodes) {
      const items = q ? r.files.filter((f) => f.file.path.toLowerCase().includes(q)) : r.files;
      if (!items.length) continue;
      out.push(
        `<div role="group" aria-label="${esc(r.repo.name)}"><div class="cw-opt-repo" role="presentation">${esc(r.repo.name)}<span class="cw-n">${num(items.length)}</span></div>`,
      );
      for (const f of items) {
        const on = f.key === key;
        out.push(
          `<div role="option" id="cw-opt-${pickKeys.length}" class="cw-opt${on ? " sel" : ""}${f.file.status === "D" ? " del" : ""}" aria-selected="${on}" data-key="${esc(f.key)}" title="${esc(f.file.path)}">` +
            (f.dir ? `<span class="cw-odir">${esc(f.dir)}/</span>` : "") +
            `<span class="cw-nm">${esc(f.name)}</span><b class="cw-st cw-st-${f.file.status}" aria-hidden="true">${f.file.status}</b></div>`,
        );
        pickKeys.push(f.key);
      }
      out.push(`</div>`);
    }
    pickList.innerHTML = pickKeys.length ? out.join("") : `<p class="cw-pick-empty">No files match.</p>`;
    const at = pickKeys.indexOf(key);
    setPickActive(at >= 0 ? at : 0);
  }

  function setPickActive(i: number): void {
    if (!pickKeys.length) {
      filter.removeAttribute("aria-activedescendant");
      return;
    }
    pickActive = Math.max(0, Math.min(pickKeys.length - 1, i));
    for (const o of pickList.querySelectorAll<HTMLElement>(".cw-opt.active")) o.classList.remove("active");
    const opt = pickList.querySelector<HTMLElement>(`#cw-opt-${pickActive}`);
    opt?.classList.add("active");
    opt?.scrollIntoView({ block: "nearest" });
    filter.setAttribute("aria-activedescendant", `cw-opt-${pickActive}`);
  }

  function openPicker(): void {
    if (!files.length) return;
    dd.hidden = false;
    pickBtn.setAttribute("aria-expanded", "true");
    filter.value = "";
    renderPickList();
    filter.focus();
  }

  function closePicker(returnFocus: boolean): void {
    if (dd.hidden) return;
    dd.hidden = true;
    pickBtn.setAttribute("aria-expanded", "false");
    if (returnFocus) pickBtn.focus();
  }

  function pick(key: string | undefined): void {
    const f = key ? fileByKey.get(key) : undefined;
    if (!f) return;
    closePicker(true);
    select(f);
  }

  function onFilterKey(e: KeyboardEvent): void {
    switch (e.key) {
      case "ArrowDown":
        setPickActive(pickActive + 1);
        break;
      case "ArrowUp":
        setPickActive(pickActive - 1);
        break;
      case "Enter":
        pick(pickKeys[pickActive]);
        break;
      case "Escape":
        closePicker(true);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  // ---- selection and the diff pane ----

  function current(): FileNode | undefined {
    return sel ? fileByKey.get(fileKey(sel.repo, sel.path)) : undefined;
  }

  function writeHash(): void {
    const p = new URLSearchParams();
    p.set("mode", mode);
    if (sel) {
      p.set("repo", sel.repo);
      p.set("path", sel.path);
    }
    const next = `#${p.toString()}`;
    if (location.hash !== next) history.replaceState(history.state, "", next);
  }

  function select(f: FileNode): void {
    sel = { repo: f.repo.key, path: f.file.path };
    if (expandTo(f)) renderTree(true);
    applySelection(true);
    writeHash();
    renderPicker();
    renderStatus();
    syncDiff();
  }

  function step(delta: number): void {
    const f = current();
    const i = f ? files.indexOf(f) : -1;
    const next = files[i + delta];
    if (!next) return;
    const treeFocused = tree.contains(document.activeElement);
    select(next);
    if (treeFocused) focusRow(rowFor(next.key));
  }

  function fileSig(f: FileNode): string {
    const x = f.file;
    return JSON.stringify([mode, f.repo.head, x.status, x.oldPath, x.added, x.removed, x.size, x.mtimeMs]);
  }

  function headHtml(f: FileNode): string {
    const x = f.file;
    const i = files.indexOf(f);
    const tone = STATUS_TONE[x.status];
    const repo = repoNodes.length > 1 ? `<span class="cw-drepo">${esc(f.repo.name)}</span>` : "";
    return (
      `<div class="cw-dpath${x.status === "D" ? " del" : ""}" title="${esc(x.path)}">${repo}` +
      (f.dir ? `<span class="cw-ddir">${esc(f.dir)}/</span>` : "") +
      `<span class="cw-dname">${esc(f.name)}</span></div>` +
      `<span class="cw-pill${tone ? ` ${tone}` : ""}">${STATUS_LABEL[x.status]}</span>` +
      (x.oldPath ? `<span class="cw-dfrom" title="${esc(x.oldPath)}">from ${esc(x.oldPath)}</span>` : "") +
      `<span class="cw-counts">${x.binary ? "" : counts(x.added, x.removed)}</span>` +
      `<span class="cw-sp"></span>` +
      `<span class="cw-pos">${num(i + 1)} of ${num(files.length)}</span>` +
      askFileButton("btn sm ghost cw-askfile") +
      `<span class="cw-nav">` +
      `<button type="button" class="btn sm ghost cw-icon" data-act="prev" aria-label="Previous file" title="Previous file (Alt+\u2191)"${i <= 0 ? " disabled" : ""}>${svg("up")}</button>` +
      `<button type="button" class="btn sm ghost cw-icon" data-act="next" aria-label="Next file" title="Next file (Alt+\u2193)"${i >= files.length - 1 ? " disabled" : ""}>${svg("down")}</button>` +
      `</span>`
    );
  }

  function renderHead(f: FileNode | undefined): void {
    const html = f ? headHtml(f) : "";
    if (head.innerHTML === html) return;
    const act = head.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.act : undefined;
    head.innerHTML = html;
    head.hidden = !f;
    if (act) {
      const btn = head.querySelector<HTMLButtonElement>(`[data-act="${act}"]:not(:disabled)`) || head.querySelector<HTMLButtonElement>(".cw-nav button:not(:disabled)");
      btn?.focus({ preventScroll: true });
    }
  }

  function setBody(html: string): void {
    window.clearTimeout(skeletonTimer);
    body.classList.remove("cw-pending");
    body.innerHTML = html;
    ask?.afterDiff();
  }

  function askFileButton(cls: string): string {
    if (removed) return "";
    const nm = esc(workerName());
    return `<button type="button" class="${cls}" data-act="ask-file" title="Ask ${nm} about this file">${svg("ask")}<span>Ask ${nm}</span></button>`;
  }

  /** The diff pane when no file is picked: loading, nothing to show, or why. */
  function renderNoFile(): void {
    renderHead(undefined);
    shownKey = "";
    shownSig = "";
    if (!data) {
      setBody(DIFF_SKELETON);
      return;
    }
    const name = esc(workerName());
    if (!data.repos.length) {
      setBody(
        stateHtml({
          icon: "folder",
          title: "No repos to compare",
          text: `${name}'s task folder doesn't have any repo worktrees yet.`,
        }),
      );
      return;
    }
    const errors = data.repos.filter((r) => r.error);
    if (errors.length === data.repos.length) {
      setBody(stateHtml({ icon: "warning", tone: "bad", title: "Couldn't read changes", code: errors[0]!.error, actions: retryButton }));
      return;
    }
    if (mode === "branch") {
      const bases = [...new Set(data.repos.map((r) => r.base))];
      const from = bases.length === 1 ? ` from <code>${esc(bases[0])}</code>` : "";
      setBody(stateHtml({ icon: "check", tone: "ok", title: "No changes yet", text: `${name} hasn't touched any files since branching${from}.` }));
    } else if (mode === "uncommitted") {
      setBody(
        stateHtml({
          icon: "check",
          tone: "ok",
          title: "Nothing uncommitted",
          text: `${name}'s work is all committed, or it hasn't started.`,
          actions: modeButton("branch", "Show since branching"),
        }),
      );
    } else if (data.repos.every((r) => r.note || r.error)) {
      setBody(
        stateHtml({
          icon: "clock",
          title: `${workerName()} hasn't committed yet`,
          text: "Its work is all in the working tree for now.",
          actions: modeButton("uncommitted", "Show uncommitted"),
        }),
      );
    } else {
      setBody(
        stateHtml({
          icon: "check",
          title: "The last commit changed no files",
          actions: modeButton("branch", "Show since branching"),
        }),
      );
    }
  }

  function syncDiff(): void {
    const f = current();
    if (!f) {
      renderNoFile();
      return;
    }
    renderHead(f);
    const sig = fileSig(f);
    if (f.key === shownKey && sig === shownSig && !diffBroken) return;
    const same = f.key === shownKey;
    shownKey = f.key;
    shownSig = sig;
    void loadDiff(f, same);
  }

  async function loadDiff(f: FileNode, keep: boolean): Promise<void> {
    diffCtl?.abort();
    const ctl = (diffCtl = new AbortController());
    const token = ++diffToken;
    diffBroken = false;
    window.clearTimeout(skeletonTimer);
    if (!keep) {
      // Keep the old diff, dimmed, for a moment. Most diffs load before a skeleton would flash.
      body.classList.add("cw-pending");
      skeletonTimer = window.setTimeout(() => {
        if (token === diffToken) setBody(DIFF_SKELETON);
      }, 150);
    }
    body.setAttribute("aria-busy", "true");
    const q = new URLSearchParams({ sessionId: worker, repo: f.repo.key, path: f.file.path, mode });
    if (f.file.oldPath) q.set("oldPath", f.file.oldPath);
    try {
      const d = await request<FileDiff>(`/api/jarvis/workers/diff?${q.toString()}`, { signal: ctl.signal });
      if (token !== diffToken) return;
      const top = body.scrollTop;
      const left = body.scrollLeft;
      renderDiffBody(f, d);
      body.scrollTop = keep ? top : 0;
      body.scrollLeft = keep ? left : 0;
    } catch (error) {
      if (token !== diffToken || ctl.signal.aborted) return;
      diffBroken = true;
      const status = error instanceof HttpError ? error.status : 0;
      // A poll that can't reach the service keeps the diff on screen. The banner says why.
      if (keep && status === 0) return;
      setBody(stateHtml({ icon: "warning", tone: "bad", title: "Couldn't load this diff", code: (error as Error).message, actions: `<button type="button" class="btn sm" data-act="retry-diff">${svg("sync")}<span>Retry</span></button>` }));
    } finally {
      if (token === diffToken) body.removeAttribute("aria-busy");
    }
  }

  function renderDiffBody(f: FileNode, d: FileDiff): void {
    const x = f.file;
    if (d.binary) {
      const size =
        x.status === "A" || x.status === "U"
          ? bytes(d.newSize)
          : x.status === "D"
            ? `${bytes(d.oldSize)}, now deleted`
            : `${bytes(d.oldSize)} \u2192 ${bytes(d.newSize)}`;
      setBody(stateHtml({ icon: "file", title: "Binary file, no text diff", text: `<span class="cw-mono">${esc(f.name)} \u00b7 ${esc(size)}</span>`, actions: ideButtons() + askFileButton("btn sm") }));
      return;
    }
    if (d.tooLarge) {
      const lines = Math.max(d.oldCount || 0, d.newCount || 0);
      const why = lines > LINE_LIMIT ? `${num(lines)} lines. The limit is ${num(LINE_LIMIT)} per side.` : `${bytes(Math.max(d.oldSize || 0, d.newSize || 0))}. The limit is ${bytes(BYTE_LIMIT)}.`;
      setBody(stateHtml({ icon: "warning", tone: "caution", title: "This diff is too big to show here", text: esc(why), actions: ideButtons() + askFileButton("btn sm") }));
      return;
    }
    const hunks = d.hunks || [];
    if (!hunks.length) {
      let title = "No line changes";
      let text = "Only the file mode or line endings changed.";
      if (x.status === "R") {
        title = "Renamed, no line changes";
        text = `From <span class="cw-mono">${esc(x.oldPath || "")}</span>.`;
      } else if (x.status === "T") {
        title = "Only the file type changed";
        text = "For example, a file became a link.";
      } else if (x.status === "A" || x.status === "U") {
        title = "Empty file";
        text = "It was added with no content.";
      } else if (x.status === "D") {
        title = "Empty file, deleted";
        text = "It had no content.";
      }
      setBody(stateHtml({ icon: "file", title, text }));
      return;
    }
    const { table } = diffTable(hunks);
    setBody(x.status === "D" ? `<p class="cw-dnote">${svg("trash")}<span>Deleted in this comparison. These are the lines it had.</span></p>` : "");
    body.append(table);
    ask?.afterDiff();
  }

  function renderStatus(): void {
    const f = current();
    if (!f) {
      statusRepo.textContent = data?.repos.length === 1 ? data.repos[0]!.name : "";
      statusCmp.textContent = "";
      return;
    }
    const r = f.repo;
    statusRepo.textContent = r.name;
    statusCmp.textContent =
      mode === "branch"
        ? `merge-base ${r.fromRef || "?"} \u2192 working tree`
        : mode === "uncommitted"
          ? `HEAD ${shortSha(r.head)} \u2192 working tree`
          : `${r.fromRef || "empty tree"} \u2192 ${shortSha(r.head)}`;
  }

  // ---- data ----

  function apply(next: WorkerChanges): void {
    data = next;
    repoNodes = next.repos.map(buildRepo);
    files = repoNodes.flatMap((r) => r.files);
    fileByKey = new Map(files.map((f) => [f.key, f]));
    root.classList.remove("cw-stale");

    const title = `${next.worker.name}\u0000${next.worker.task}`;
    if (title !== lastTitle) {
      lastTitle = title;
      options.onTitle?.(next.worker.name, next.worker.task);
    }

    let f = current();
    if (!f && files.length) {
      f = files[0]!;
      sel = { repo: f.repo.key, path: f.file.path };
      expandTo(f);
    }
    writeHash();

    renderChip();
    renderTotals();
    renderUpdated();
    renderBanner();
    renderTree();
    applySelection(false);
    renderPicker();
    renderStatus();
    syncDiff();
    ask?.update();
  }

  function scheduleNext(): void {
    window.clearTimeout(timer);
    if (destroyed || removed || document.hidden) return;
    let ms: number;
    if (offline || listError) {
      ms = retryDelay;
      retryDelay = Math.min(retryDelay * 2, iv.retryMax);
    } else if (settlePending) {
      settlePending = false;
      ms = iv.settle;
    } else {
      ms = data?.worker.busy ? iv.busy : iv.idle;
    }
    timer = window.setTimeout(() => void refresh(), ms);
  }

  function markRemoved(): void {
    removed = true;
    window.clearTimeout(timer);
    diffCtl?.abort();
    closePicker(false);
    root.classList.add("cw-is-removed");
    split.hidden = true;
    picker.hidden = true;
    status.hidden = true;
    for (const c of toolbar.querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button, select")) c.disabled = true;
    closeIdePicker(root);
    gone.innerHTML = stateHtml({
      icon: "dismiss",
      title: `${workerName()} was removed`,
      text: "There's nothing left to show here. The window stays open until you close it.",
      actions: `<button type="button" class="btn sm" data-act="close">Close window</button>`,
    });
    gone.hidden = false;
    renderChip();
    renderBanner();
    renderUpdated();
    ask?.update();
  }

  async function refresh(): Promise<void> {
    if (destroyed || removed) return;
    window.clearTimeout(timer);
    listCtl?.abort();
    const ctl = (listCtl = new AbortController());
    const token = ++listToken;
    lastStart = Date.now();
    setRefreshing(true);
    try {
      const next = await request<WorkerChanges>(
        `/api/jarvis/workers/changes?sessionId=${encodeURIComponent(worker)}&mode=${encodeURIComponent(mode)}`,
        { signal: ctl.signal },
      );
      if (token !== listToken || destroyed) return;
      if (data?.worker.busy && !next.worker.busy) settlePending = true;
      offline = false;
      listError = "";
      retryDelay = iv.retry;
      lastAt = Date.now();
      apply(next);
    } catch (error) {
      if (token !== listToken || ctl.signal.aborted || destroyed) return;
      const status = error instanceof HttpError ? error.status : 0;
      if (status === 404) {
        markRemoved();
        return;
      }
      offline = status === 0;
      listError = offline ? "" : (error as Error).message;
      root.classList.remove("cw-stale");
      if (!data) {
        renderTree();
        setBody(offline ? DIFF_SKELETON : stateHtml({ icon: "warning", tone: "bad", title: "Couldn't read changes", code: listError, actions: retryButton }));
      }
      renderBanner();
      renderUpdated();
    } finally {
      if (token === listToken) {
        setRefreshing(false);
        scheduleNext();
      }
    }
  }

  function setMode(m: ChangesMode): void {
    if (m === mode || removed) return;
    mode = m;
    renderModes();
    writeHash();
    // The tree and diff on screen are for the old comparison until the new list lands.
    root.classList.add("cw-stale");
    shownSig = "";
    void refresh();
  }

  async function openIde(ide: string): Promise<void> {
    if (opening.has(ide) || !IDE_NAME[ide]) return;
    opening.add(ide);
    const buttons = (): HTMLButtonElement[] => [...root.querySelectorAll<HTMLButtonElement>(`[data-act="ide"][data-ide="${ide}"]`)];
    const focused = document.activeElement;
    for (const b of buttons()) {
      b.disabled = true;
      b.setAttribute("aria-busy", "true");
    }
    try {
      await request("/api/jarvis/workers/ide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: worker, ide }),
      });
    } catch (error) {
      showNotice(`Couldn't open ${IDE_NAME[ide]}. ${(error as Error).message}`);
    } finally {
      opening.delete(ide);
      if (!removed && !destroyed) {
        for (const b of buttons()) {
          b.disabled = false;
          b.removeAttribute("aria-busy");
        }
        if (focused instanceof HTMLButtonElement && focused.isConnected && focused.getClientRects().length && document.activeElement === document.body) focused.focus();
      }
    }
  }

  // ---- splitter ----

  const maxTree = (): number => Math.max(TREE_MIN, Math.floor(window.innerWidth * 0.5));
  let preferred = TREE_DEFAULT;
  try {
    const saved = Number(localStorage.getItem(TREE_WIDTH_KEY));
    if (Number.isFinite(saved) && saved > 0) preferred = saved;
  } catch {
    // Storage can be off. The default width is fine.
  }
  let treeWidth = preferred;

  function setTreeWidth(px: number, save: boolean): void {
    treeWidth = Math.round(Math.min(Math.max(px, TREE_MIN), maxTree()));
    root.style.setProperty("--cw-tree", `${treeWidth}px`);
    grip.setAttribute("aria-valuemin", String(TREE_MIN));
    grip.setAttribute("aria-valuemax", String(maxTree()));
    grip.setAttribute("aria-valuenow", String(treeWidth));
    if (save) {
      preferred = treeWidth;
      try {
        localStorage.setItem(TREE_WIDTH_KEY, String(treeWidth));
      } catch {
        // Not saved. It still applies to this window.
      }
    }
  }

  function onGripDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = treeWidth;
    root.classList.add("cw-resizing");
    const move = (ev: PointerEvent): void => setTreeWidth(startW + ev.clientX - startX, false);
    const up = (): void => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      root.classList.remove("cw-resizing");
      setTreeWidth(treeWidth, true);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  }

  function onGripKey(e: KeyboardEvent): void {
    const big = e.shiftKey ? 64 : 16;
    let next: number;
    if (e.key === "ArrowLeft") next = treeWidth - big;
    else if (e.key === "ArrowRight") next = treeWidth + big;
    else if (e.key === "Home") next = TREE_MIN;
    else if (e.key === "End") next = maxTree();
    else return;
    e.preventDefault();
    setTreeWidth(next, true);
  }

  // ---- events ----

  function onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const opt = target.closest<HTMLElement>(".cw-opt");
    if (opt && pickList.contains(opt)) {
      pick(opt.dataset.key);
      return;
    }
    if (target.closest(".cw-pick")) {
      if (dd.hidden) openPicker();
      else closePicker(true);
      return;
    }
    const modeBtn = target.closest<HTMLElement>("[data-mode]");
    if (modeBtn && (modeBtn.closest(".cw-seg") || modeBtn.dataset.act === "mode")) {
      setMode(modeBtn.dataset.mode as ChangesMode);
      return;
    }
    const act = target.closest<HTMLElement>("[data-act]");
    if (!act || (act as HTMLButtonElement).disabled) return;
    switch (act.dataset.act) {
      case "refresh":
        void refresh();
        break;
      case "retry-diff":
        shownSig = "";
        syncDiff();
        break;
      case "prev":
        step(-1);
        break;
      case "next":
        step(1);
        break;
      case "ide":
        void openIde(act.dataset.ide || "");
        break;
      case "ask-file":
        ask?.askFile(act);
        break;
      case "dismiss":
        notice = "";
        renderBanner();
        break;
      case "close":
        window.close();
        break;
    }
  }

  function onSegKey(e: KeyboardEvent): void {
    const i = MODES.findIndex((m) => m.id === mode);
    let next = i;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % MODES.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + MODES.length) % MODES.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = MODES.length - 1;
    else return;
    e.preventDefault();
    setMode(MODES[next]!.id);
    seg.querySelector<HTMLButtonElement>(`[data-mode="${MODES[next]!.id}"]`)?.focus();
  }

  function onDocKey(e: KeyboardEvent): void {
    if (destroyed) return;
    if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "r")) {
      e.preventDefault();
      void refresh();
      return;
    }
    if (e.key === "Escape") {
      if (closeIdePicker(root, true)) {
        e.preventDefault();
      } else if (!dd.hidden) {
        e.preventDefault();
        closePicker(true);
      } else if (!e.defaultPrevented && ask?.escape()) {
        e.preventDefault();
      }
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      step(e.key === "ArrowDown" ? 1 : -1);
    }
  }

  function onDocPointer(e: PointerEvent): void {
    const t = e.target as Node;
    if (!dd.hidden && !picker.contains(t)) closePicker(false);
  }

  function onVisibility(): void {
    if (document.hidden) window.clearTimeout(timer);
    else void refresh();
  }

  function onFocus(): void {
    if (Date.now() - lastStart < iv.focusGap) return;
    void refresh();
  }

  const onResize = (): void => setTreeWidth(preferred, false);

  root.addEventListener("click", onClick);
  tree.addEventListener("click", onTreeClick);
  tree.addEventListener("keydown", onTreeKey);
  tree.addEventListener("focusin", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (row) {
      activeKey = row.dataset.key || "";
      applyRoving();
    }
  });
  seg.addEventListener("keydown", onSegKey);
  modeSelect.addEventListener("change", () => setMode(modeSelect.value as ChangesMode));
  filter.addEventListener("input", renderPickList);
  filter.addEventListener("keydown", onFilterKey);
  grip.addEventListener("pointerdown", onGripDown);
  grip.addEventListener("keydown", onGripKey);
  grip.addEventListener("dblclick", () => setTreeWidth(TREE_DEFAULT, true));
  document.addEventListener("keydown", onDocKey);
  document.addEventListener("pointerdown", onDocPointer);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onFocus);
  window.addEventListener("resize", onResize);
  const ticker = window.setInterval(renderUpdated, iv.tick);

  ask = mountAskQueue({
    root,
    refreshBtn,
    split,
    side: root.querySelector<HTMLElement>(".cw-side")!,
    tree,
    body,
    sessionId: worker,
    name: () => data?.worker.name ?? "",
    busy: () => !!data?.worker.busy,
    taskId: () => data?.worker.taskId,
    modeLabel: () => MODES.find((m) => m.id === mode)?.label ?? "",
    multiRepo: () => repoNodes.length > 1,
    alive: () => !removed && !destroyed,
    fileByKey: (k) => {
      const f = fileByKey.get(k);
      return f ? { key: f.key, path: f.file.path, repoName: f.repo.name } : undefined;
    },
    currentKey: () => current()?.key,
    open: (k) => {
      const f = fileByKey.get(k);
      if (f) select(f);
    },
    focusRow: (row) => focusRow(row),
  });

  setTreeWidth(preferred, false);
  renderModes();
  renderTree();
  renderNoFile();
  void refresh();

  return {
    refresh,
    destroy(): void {
      destroyed = true;
      ask?.destroy();
      window.clearTimeout(timer);
      window.clearTimeout(noticeTimer);
      window.clearTimeout(skeletonTimer);
      window.clearInterval(ticker);
      listCtl?.abort();
      diffCtl?.abort();
      root.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onDocKey);
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("resize", onResize);
      root.classList.remove("cw-stale", "cw-is-removed", "cw-resizing");
      root.replaceChildren();
    },
  };
}
