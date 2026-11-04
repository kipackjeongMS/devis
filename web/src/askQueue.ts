/*
 * Ask worker: a batch queue for the worker Changes window.
 *
 * Select diff lines (gutter drag, Shift+click, or a text selection) or files (Ctrl/Shift+click in
 * the tree), right-click, and "Ask <worker>…" opens a small input. Each ask lands in a queue rail.
 * "Send all" composes the queue into one numbered message and posts it to the worker; if the worker
 * is mid-turn it runs as the next turn. Sent batches are matched against the worker log so replies
 * show up next to each ask, split per number when the worker answers in a numbered list.
 *
 * The host (workerChanges.ts) owns the tree, the diff and the toolbar. This module only adds to them
 * and reaches back through AskQueueContext.
 */
import { icon } from "./icons.js";
import type { IconName } from "./icons.js";
import { renderMarkdown } from "./markdown.js";
import { esc } from "./util.js";

export interface AskFileInfo {
  key: string;
  path: string;
  repoName: string;
}

export interface AskQueueContext {
  root: HTMLElement;
  refreshBtn: HTMLElement;
  split: HTMLElement;
  side: HTMLElement;
  tree: HTMLElement;
  body: HTMLElement;
  sessionId: string;
  name(): string;
  busy(): boolean;
  taskId(): string | undefined;
  modeLabel(): string;
  multiRepo(): boolean;
  /** False once the worker is removed; asks can't be sent then. */
  alive(): boolean;
  fileByKey(key: string): AskFileInfo | undefined;
  currentKey(): string | undefined;
  open(key: string): void;
  focusRow(row: HTMLElement): void;
}

export interface AskQueue {
  /** After the host re-renders or re-selects the tree. */
  syncTree(): void;
  /** After the host replaces the diff body. */
  afterDiff(): void;
  /** After new worker data (busy, name, removed). */
  update(): void;
  /** Ctrl/Shift+click picks files. True when handled. */
  treeClick(e: MouseEvent, row: HTMLElement): boolean;
  /** Picking and the context menu from the keyboard. True when handled. */
  treeKey(e: KeyboardEvent, row: HTMLElement): boolean;
  clearPicks(): void;
  /** Closes the innermost ask layer. True when something closed. */
  escape(): boolean;
  /** Asks about the open file, anchored to the given control. */
  askFile(anchor?: HTMLElement): void;
  destroy(): void;
}

interface FileRef {
  key: string;
  path: string;
  repo: string;
}

interface LinesTarget {
  kind: "lines";
  file: FileRef;
  label: string;
  excerpt: string;
  /** First and last diff row keys, `${side}:${line}`. */
  rows: [string, string];
}

interface FilesTarget {
  kind: "files";
  files: FileRef[];
  label: string;
}

type Target = LinesTarget | FilesTarget;

interface Ask {
  id: string;
  target: Target;
  text: string;
  at: number;
}

type BatchStatus = "queued" | "working" | "answered" | "lost";

interface Batch {
  id: string;
  at: number;
  items: Ask[];
  status: BatchStatus;
  message: string;
  reply?: string;
  answers?: string[] | null;
}

interface Saved {
  queue: Ask[];
  sent: Batch[];
  qopen: boolean;
  seq: number;
  everAdded: boolean;
}

interface LogMessage {
  id?: unknown;
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
}

interface LiveState {
  busy?: boolean;
  queue?: { text?: unknown }[];
}

interface MenuItem {
  icon: IconName;
  label: string;
  hint?: string;
  primary?: boolean;
  run(): void;
}

const PROMPT_MAX = 20000;
const ASK_MAX = 4000;
const SENT_CAP = 10;
const POLL_MS = 4000;
const LOST_MS = 120_000;
const SEEN_GRACE_MS = 10_000;
const UNDO_MS = 8000;
const JUMP_MS = 5000;
const EXCERPT_LINES = 12;
const WIDE = 900;
const STATUSES: BatchStatus[] = ["queued", "working", "answered", "lost"];

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1) || p;
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isFileRef(v: unknown): v is FileRef {
  const f = v as FileRef;
  return !!f && isStr(f.key) && isStr(f.path) && isStr(f.repo);
}

function isTarget(v: unknown): v is Target {
  const t = v as Target;
  if (!t || !isStr(t.label)) return false;
  if (t.kind === "lines") {
    return isFileRef(t.file) && isStr(t.excerpt) && Array.isArray(t.rows) && t.rows.length === 2 && t.rows.every(isStr);
  }
  return t.kind === "files" && Array.isArray(t.files) && t.files.length > 0 && t.files.every(isFileRef);
}

function isAsk(v: unknown): v is Ask {
  const a = v as Ask;
  return !!a && isStr(a.id) && isStr(a.text) && isNum(a.at) && isTarget(a.target);
}

function isBatch(v: unknown): v is Batch {
  const b = v as Batch;
  return (
    !!b &&
    isStr(b.id) &&
    isNum(b.at) &&
    isStr(b.message) &&
    STATUSES.includes(b.status) &&
    Array.isArray(b.items) &&
    b.items.every(isAsk) &&
    (b.reply === undefined || isStr(b.reply)) &&
    (b.answers === undefined || b.answers === null || (Array.isArray(b.answers) && b.answers.every(isStr)))
  );
}

function messageText(c: unknown): string {
  if (isStr(c)) return c;
  if (Array.isArray(c)) return c.map((p) => (isStr(p) ? p : isStr((p as { text?: unknown })?.text) ? (p as { text: string }).text : "")).join("");
  return "";
}

/** A backtick fence longer than any backtick run inside the text. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

function commonIndent(lines: string[]): string {
  let prefix: string | null = null;
  for (const l of lines) {
    if (!l.trim()) continue;
    const ws = /^[ \t]*/.exec(l)![0];
    if (prefix === null) prefix = ws;
    else {
      let i = 0;
      while (i < prefix.length && i < ws.length && prefix[i] === ws[i]) i++;
      prefix = prefix.slice(0, i);
    }
    if (!prefix) return "";
  }
  return prefix ?? "";
}

function dedent(lines: string[]): string[] {
  const [first, ...rest] = lines;
  const ind = commonIndent(rest);
  return [first ?? "", ...rest.map((l) => (l.startsWith(ind) ? l.slice(ind.length) : l.trimStart()))];
}

/**
 * Splits a reply written as a top-level numbered list ("1. …", "2) …", "### 3. …") into one answer
 * per ask. Numbers must run in order; anything inside code fences is ignored. Null when the reply
 * isn't shaped that way.
 */
export function splitAnswers(reply: string, n: number): string[] | null {
  if (n <= 1 || !reply.trim()) return null;
  const out: string[][] = [];
  let cur: string[] | null = null;
  let expect = 1;
  let fence: RegExp | null = null;
  for (const line of reply.split("\n")) {
    if (fence) {
      if (fence.test(line)) fence = null;
      cur?.push(line);
      continue;
    }
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      fence = new RegExp(`^ {0,3}${f[1]![0] === "`" ? "`" : "~"}{${f[1]!.length},}\\s*$`);
      cur?.push(line);
      continue;
    }
    const m = /^ ?(?:#{1,6}\s+)?(\d+)[.)]\s+(.*)$/.exec(line);
    if (m && Number(m[1]) === expect && expect <= n) {
      cur = [m[2]!];
      out.push(cur);
      expect++;
      continue;
    }
    cur?.push(line);
  }
  if (out.length < 2) return null;
  return Array.from({ length: n }, (_, i) => (out[i] ? dedent(out[i]!).join("\n").trim() : ""));
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init });
  } catch {
    throw new Error("Devis's service isn't answering.");
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Not JSON. The status says enough.
  }
  if (!res.ok) {
    const said = data && isStr((data as { error?: unknown }).error) ? (data as { error: string }).error : "";
    throw new Error(said || `The service said ${res.status}.`);
  }
  return data as T;
}

const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function mountAskQueue(ctx: AskQueueContext): AskQueue {
  const storeKey = `devis.askQueue.${ctx.sessionId}`;
  const st = load();
  if (innerWidth < WIDE) st.qopen = false;

  let dead = false;
  const nm = (): string => ctx.name() || "the worker";

  // Line selection in the diff: anchor and focus row keys on one file.
  let selFile = "";
  let selA = "";
  let selB = "";
  let dragPointer = -1;
  // Pointer capture retargets the click that ends a gutter gesture to the body; that click must not clear it.
  let gestureClick = false;

  // Files picked in the tree, in pick order.
  let picks: string[] = [];
  let pickAnchor = "";

  let menu: HTMLElement | null = null;
  let menuReturn: HTMLElement | null = null;
  let pop: HTMLElement | null = null;
  let popReturn: HTMLElement | null = null;
  const drafts = new Map<string, string>();

  let editing: string | null = null;
  let editDraft = "";
  let undo: { items: { ask: Ask; index: number }[]; label: string; timer: number } | null = null;
  let flashId = "";
  let flashTimer: number | undefined;
  let sending = false;
  let sendErr = "";
  let prevOpen = false;
  const openSent = new Set<string>();
  const openFull = new Set<string>();
  let pendingJump: { key: string; rows: [string, string] | null; until: number } | null = null;
  let pollTimer: number | undefined;
  const idleSince = new Map<string, number>();
  const seenAt = new Map<string, number>();
  let lastTaskId = ctx.taskId();
  const htmlCache = new WeakMap<Element, string>();

  // ---- DOM ----

  const live = document.createElement("div");
  live.className = "visually-hidden";
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  ctx.root.append(live);

  const qbtn = document.createElement("button");
  qbtn.type = "button";
  qbtn.className = "btn sm ghost cw-qbtn";
  qbtn.setAttribute("aria-controls", "cw-queue");
  qbtn.innerHTML = `${icon("queue")}<span class="cw-qlabel">Queue</span><span class="cw-qcount">0</span>`;
  ctx.refreshBtn.after(qbtn);
  const qcount = qbtn.querySelector<HTMLElement>(".cw-qcount")!;

  const q = document.createElement("aside");
  q.className = "cw-queue";
  q.id = "cw-queue";
  q.setAttribute("aria-labelledby", "cw-qtitle");
  q.innerHTML = `<div class="cw-qhead"></div><div class="cw-qbody"></div><div class="cw-qfoot" hidden></div>`;
  ctx.split.append(q);
  const qhead = q.querySelector<HTMLElement>(".cw-qhead")!;
  const qbody = q.querySelector<HTMLElement>(".cw-qbody")!;
  const qfoot = q.querySelector<HTMLElement>(".cw-qfoot")!;

  const dock = document.createElement("div");
  dock.className = "cw-qdock";
  ctx.split.append(dock);

  const selbar = document.createElement("div");
  selbar.className = "cw-selbar";
  selbar.hidden = true;
  selbar.setAttribute("role", "toolbar");
  selbar.setAttribute("aria-label", "Selected files");
  ctx.side.prepend(selbar);
  ctx.tree.setAttribute("aria-multiselectable", "true");

  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "cw-askpill";
  pill.hidden = true;
  ctx.body.append(pill);

  function setHtml(el: Element, html: string): void {
    if (htmlCache.get(el) === html && el.innerHTML) return;
    htmlCache.set(el, html);
    el.innerHTML = html;
  }

  function announce(msg: string): void {
    live.textContent = "";
    window.setTimeout(() => {
      if (!dead) live.textContent = msg;
    }, 30);
  }

  // ---- persistence ----

  function load(): Saved {
    const d: Saved = { queue: [], sent: [], qopen: innerWidth >= WIDE, seq: 1, everAdded: false };
    try {
      const raw = localStorage.getItem(storeKey);
      if (!raw) return d;
      const v = JSON.parse(raw) as Partial<Saved>;
      if (!v || typeof v !== "object") return d;
      const queue = Array.isArray(v.queue) ? v.queue.filter(isAsk) : [];
      const sent = Array.isArray(v.sent) ? v.sent.filter(isBatch).slice(0, SENT_CAP) : [];
      let seq = isNum(v.seq) && v.seq > 0 ? Math.floor(v.seq) : 1;
      for (const id of [...queue.map((a) => a.id), ...sent.map((b) => b.id), ...sent.flatMap((b) => b.items.map((a) => a.id))]) {
        const n = Number(id.slice(1));
        if (Number.isInteger(n) && n >= seq) seq = n + 1;
      }
      return { queue, sent, qopen: typeof v.qopen === "boolean" ? v.qopen : d.qopen, seq, everAdded: !!v.everAdded || queue.length > 0 };
    } catch {
      return d;
    }
  }

  function save(): void {
    try {
      if (!st.queue.length && !st.sent.length && !st.everAdded) localStorage.removeItem(storeKey);
      else localStorage.setItem(storeKey, JSON.stringify(st));
    } catch {
      // Storage is full or blocked. The queue still works for this window.
    }
  }

  // ---- targets ----

  const disp = (f: FileRef): string => (ctx.multiRepo() ? `${f.repo}/${f.path}` : f.path);
  const targetFiles = (t: Target): FileRef[] => (t.kind === "lines" ? [t.file] : t.files);
  const targetKey = (t: Target): string =>
    t.kind === "lines" ? `L|${t.file.key}|${t.rows.join("~")}` : `F|${t.files.map((f) => f.key).sort().join("|")}`;
  const refFor = (key: string): FileRef | null => {
    const i = ctx.fileByKey(key);
    return i ? { key: i.key, path: i.path, repo: i.repoName } : null;
  };

  const lineRows = (): HTMLTableRowElement[] => [...ctx.body.querySelectorAll<HTMLTableRowElement>("table.diff tr[data-line]")];
  const rowKey = (tr: HTMLElement): string => `${tr.dataset.side}:${tr.dataset.line}`;
  const codeText = (tr: HTMLElement): string => (tr.querySelector("td.code")?.textContent ?? "").replace(/\n$/, "");

  function selectedRows(): HTMLTableRowElement[] {
    if (!selFile || selFile !== ctx.currentKey()) return [];
    const rows = lineRows();
    const a = rows.findIndex((r) => rowKey(r) === selA);
    const b = rows.findIndex((r) => rowKey(r) === selB);
    if (a < 0 || b < 0) return [];
    return rows.slice(Math.min(a, b), Math.max(a, b) + 1);
  }

  function lineRange(rows: HTMLElement[]): { label: string; anchor: string } {
    const right = rows.filter((r) => r.dataset.side !== "left").map((r) => Number(r.dataset.line));
    const left = rows.filter((r) => r.dataset.side === "left").map((r) => Number(r.dataset.line));
    const span = (ns: number[]): [number, number] => [Math.min(...ns), Math.max(...ns)];
    if (right.length) {
      const [a, b] = span(right);
      return {
        label: (a === b ? `L${a}` : `L${a}\u2013${b}`) + (left.length ? ` \u00b7 ${left.length} removed` : ""),
        anchor: a === b ? `#L${a}` : `#L${a}-L${b}`,
      };
    }
    const [a, b] = span(left);
    return { label: a === b ? `old L${a}` : `old L${a}\u2013${b}`, anchor: "" };
  }

  function linesTarget(rows: HTMLTableRowElement[]): LinesTarget | null {
    const key = ctx.currentKey();
    const file = key ? refFor(key) : null;
    if (!file || !rows.length) return null;
    const hasDel = rows.some((r) => r.dataset.side === "left");
    const raw = rows.map(codeText);
    const ind = commonIndent(raw);
    let lines = rows.map((r, i) => {
      const t = raw[i]!.startsWith(ind) ? raw[i]!.slice(ind.length) : raw[i]!;
      if (!hasDel) return t;
      return (r.classList.contains("del") ? "-" : r.classList.contains("add") ? "+" : " ") + t;
    });
    if (lines.length > EXCERPT_LINES) {
      const more = lines.length - EXCERPT_LINES;
      lines = [...lines.slice(0, EXCERPT_LINES), `\u2026 ${plural(more, "more line")}`];
    }
    return {
      kind: "lines",
      file,
      label: lineRange(rows).label,
      excerpt: lines.join("\n"),
      rows: [rowKey(rows[0]!), rowKey(rows[rows.length - 1]!)],
    };
  }

  function filesTarget(keys: string[]): FilesTarget | null {
    const files = keys.map(refFor).filter((f): f is FileRef => !!f);
    if (!files.length) return null;
    return { kind: "files", files, label: files.length === 1 ? "whole file" : plural(files.length, "file") };
  }

  function namesHint(files: FileRef[]): string {
    return files.slice(0, 3).map((f) => basename(f.path)).join(", ") + (files.length > 3 ? ` +${files.length - 3}` : "");
  }

  // ---- line selection ----

  function paintSel(): void {
    const on = new Set<Element>(selectedRows());
    for (const r of ctx.body.querySelectorAll("tr.sel")) if (!on.has(r)) r.classList.remove("sel");
    for (const r of on) r.classList.add("sel");
    placePill();
  }

  function clearSel(): void {
    if (!selA && !selFile) return;
    selFile = selA = selB = "";
    paintSel();
  }

  function placePill(): void {
    const rows = dragPointer >= 0 ? [] : selectedRows();
    const t = rows.length ? linesTarget(rows) : null;
    if (!t || !ctx.alive()) {
      pill.hidden = true;
      return;
    }
    if (pill.parentElement !== ctx.body) ctx.body.append(pill);
    pill.innerHTML = `${icon("ask")}<span>Ask ${esc(nm())}</span><span class="cw-pill-tgt">${esc(t.label)}</span>`;
    pill.title = `Ask ${nm()} about ${disp(t.file)} ${t.label}`;
    pill.hidden = false;
    const last = rows[rows.length - 1]!;
    const br = ctx.body.getBoundingClientRect();
    const lr = last.getBoundingClientRect();
    const cr = (last.querySelector<HTMLElement>("td.code") ?? last).getBoundingClientRect();
    const minLeft = ctx.body.scrollLeft + 8;
    const maxLeft = ctx.body.scrollLeft + ctx.body.clientWidth - pill.offsetWidth - 8;
    const left = Math.max(minLeft, Math.min(cr.left - br.left + ctx.body.scrollLeft + 8, maxLeft));
    pill.style.top = `${lr.bottom - br.top + ctx.body.scrollTop + 4}px`;
    pill.style.left = `${left}px`;
  }

  function onBodyDown(e: PointerEvent): void {
    gestureClick = false;
    if (e.button !== 0) return;
    const t = e.target as Element;
    if (t.closest(".cw-askpill")) return;
    const tr = t.closest<HTMLTableRowElement>("tr[data-line]");
    const cell = t.closest("td");
    const key = ctx.currentKey();
    if (!tr || !cell || cell.classList.contains("code") || !key || !ctx.body.contains(tr)) return;
    e.preventDefault();
    gestureClick = true;
    getSelection()?.removeAllRanges();
    const k = rowKey(tr);
    const same = !!selA && selFile === key;
    if (e.pointerType === "touch" && same) {
      if (tr.classList.contains("sel")) clearSel();
      else {
        selB = k;
        paintSel();
      }
      return;
    }
    if (e.shiftKey && same) {
      selB = k;
      paintSel();
      return;
    }
    selFile = key;
    selA = selB = k;
    dragPointer = e.pointerId;
    try {
      ctx.body.setPointerCapture(e.pointerId);
    } catch {
      // The pointer already went away.
    }
    ctx.root.classList.add("cw-selecting");
    paintSel();
  }

  function onBodyMove(e: PointerEvent): void {
    if (e.pointerId !== dragPointer) return;
    const tr = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLTableRowElement>("tr[data-line]");
    if (tr && ctx.body.contains(tr)) {
      const k = rowKey(tr);
      if (k !== selB) {
        selB = k;
        paintSel();
      }
    }
    const r = ctx.body.getBoundingClientRect();
    if (e.clientY < r.top + 24) ctx.body.scrollTop -= 14;
    else if (e.clientY > r.bottom - 24) ctx.body.scrollTop += 14;
  }

  function onBodyUp(e: PointerEvent): void {
    if (e.pointerId !== dragPointer) return;
    dragPointer = -1;
    ctx.root.classList.remove("cw-selecting");
    try {
      ctx.body.releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
    paintSel();
  }

  function onBodyClick(e: MouseEvent): void {
    if (gestureClick) {
      gestureClick = false;
      return;
    }
    const t = e.target as Element;
    if (t.closest(".cw-askpill") || e.shiftKey) return;
    const cell = t.closest("td");
    if (cell && !cell.classList.contains("code") && cell.closest("tr[data-line]")) return;
    if (getSelection()?.isCollapsed !== false) clearSel();
  }

  function onBodyMouseUp(): void {
    window.setTimeout(() => {
      if (!dead) mapNativeSelection();
    }, 0);
  }

  /** A text selection in the code column becomes a line selection on the rows it covers. */
  function mapNativeSelection(): boolean {
    const s = getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return false;
    const range = s.getRangeAt(0);
    const key = ctx.currentKey();
    if (!key || !ctx.body.contains(range.commonAncestorContainer)) return false;
    const covers = (tr: HTMLElement): boolean => {
      const c = tr.querySelector("td.code");
      if (!c) return false;
      const r = document.createRange();
      r.selectNodeContents(c);
      if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) r.setStart(range.startContainer, range.startOffset);
      if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) r.setEnd(range.endContainer, range.endOffset);
      return r.toString().length > 0;
    };
    const hit = lineRows().filter((tr) => {
      const c = tr.querySelector("td.code");
      return !!c && s.containsNode(c, true);
    });
    while (hit.length && !covers(hit[0]!)) hit.shift();
    while (hit.length && !covers(hit[hit.length - 1]!)) hit.pop();
    if (!hit.length) return false;
    selFile = key;
    selA = rowKey(hit[0]!);
    selB = rowKey(hit[hit.length - 1]!);
    paintSel();
    return true;
  }

  function onBodyContext(e: MouseEvent): void {
    const tr = (e.target as Element).closest<HTMLTableRowElement>("tr[data-line]");
    const key = ctx.currentKey();
    if (!tr || !key || !ctx.body.contains(tr) || !ctx.alive()) return;
    mapNativeSelection();
    if (!tr.classList.contains("sel")) {
      selFile = key;
      selA = selB = rowKey(tr);
      paintSel();
    }
    e.preventDefault();
    openLinesMenu({ x: e.clientX, y: e.clientY }, ctx.body);
  }

  function onBodyKey(e: KeyboardEvent): void {
    if (!(e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) return;
    if (!selectedRows().length || pill.hidden) return;
    e.preventDefault();
    const r = pill.getBoundingClientRect();
    openLinesMenu({ x: r.left, y: r.bottom + 4 }, pill);
  }

  // ---- tree picks ----

  const fileRows = (): HTMLElement[] => [...ctx.tree.querySelectorAll<HTMLElement>(".cw-row.cw-file")];
  const treeOrder = (keys: string[]): string[] => {
    const order = fileRows().map((r) => r.dataset.key ?? "");
    const pos = (k: string): number => {
      const i = order.indexOf(k);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    return [...keys].sort((a, b) => pos(a) - pos(b));
  };

  function syncTree(): void {
    if (dead) return;
    const valid = picks.filter((k) => ctx.fileByKey(k));
    if (valid.length !== picks.length) picks = valid;
    for (const row of fileRows()) {
      const on = picks.includes(row.dataset.key ?? "");
      row.classList.toggle("pick", on);
      row.setAttribute("aria-selected", String(on || row.classList.contains("sel")));
    }
    renderSelbar();
    marks();
  }

  function setPicks(next: string[]): void {
    picks = [...new Set(next)];
    syncTree();
  }

  function clearPicks(): void {
    if (!picks.length) return;
    pickAnchor = "";
    setPicks([]);
  }

  function togglePick(k: string): void {
    const cur = ctx.currentKey();
    const base = !picks.length && cur && cur !== k ? [cur] : picks;
    setPicks(base.includes(k) ? base.filter((x) => x !== k) : [...base, k]);
    pickAnchor = k;
    if (picks.length) announce(`${plural(picks.length, "file")} selected`);
  }

  function rangeKeys(a: string, b: string): string[] {
    const order = fileRows().map((r) => r.dataset.key ?? "");
    const i = order.indexOf(a);
    const j = order.indexOf(b);
    if (i < 0 || j < 0) return [b];
    return order.slice(Math.min(i, j), Math.max(i, j) + 1);
  }

  function treeClick(e: MouseEvent, row: HTMLElement): boolean {
    const k = row.dataset.key ?? "";
    if (!k || !ctx.fileByKey(k)) return false;
    if (e.ctrlKey || e.metaKey) {
      togglePick(k);
      ctx.focusRow(row);
      return true;
    }
    if (e.shiftKey) {
      setPicks(rangeKeys(pickAnchor || ctx.currentKey() || k, k));
      announce(`${plural(picks.length, "file")} selected`);
      ctx.focusRow(row);
      return true;
    }
    clearPicks();
    return false;
  }

  function treeKey(e: KeyboardEvent, row: HTMLElement): boolean {
    const k = row.dataset.key ?? "";
    const isFile = !!k && !!ctx.fileByKey(k);
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      if (!isFile) return false;
      const r = row.getBoundingClientRect();
      openTreeMenu(row, { x: r.left + 24, y: r.bottom });
      return true;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === " " && isFile) {
      togglePick(k);
      return true;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "a" || e.key === "A")) {
      setPicks(fileRows().map((r) => r.dataset.key ?? "").filter(Boolean));
      announce(`${plural(picks.length, "file")} selected`);
      return true;
    }
    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      const rows = [...ctx.tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
      const next = rows[rows.indexOf(row) + (e.key === "ArrowDown" ? 1 : -1)];
      if (!next) return true;
      const nk = next.dataset.key ?? "";
      const add = [isFile ? k : "", ctx.fileByKey(nk) ? nk : ""].filter(Boolean);
      if (add.length) {
        if (!pickAnchor) pickAnchor = isFile ? k : nk;
        setPicks([...picks, ...add]);
        announce(`${plural(picks.length, "file")} selected`);
      }
      ctx.focusRow(next);
      return true;
    }
    return false;
  }

  function renderSelbar(): void {
    selbar.hidden = !picks.length;
    if (!picks.length) return;
    setHtml(
      selbar,
      `<span class="cw-selcount">${plural(picks.length, "file")} selected</span>` +
        `<button type="button" class="btn sm accent" data-q="ask-picks"${ctx.alive() ? "" : " disabled"}>${icon("ask")}<span>Ask ${esc(nm())}</span></button>` +
        `<button type="button" class="btn sm ghost cw-icon" data-q="clear-picks" aria-label="Clear file selection" title="Clear selection (Esc)">${icon("dismiss")}</button>`,
    );
  }

  function onSelbarClick(e: MouseEvent): void {
    const b = (e.target as Element).closest<HTMLElement>("[data-q]");
    if (!b) return;
    if (b.dataset.q === "ask-picks") {
      const t = filesTarget(treeOrder(picks));
      if (t) openPopover(t, b, b.getBoundingClientRect());
    } else if (b.dataset.q === "clear-picks") {
      clearPicks();
      const row = ctx.tree.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]');
      if (row) ctx.focusRow(row);
    }
  }

  function onTreeContext(e: MouseEvent): void {
    const row = (e.target as Element).closest<HTMLElement>(".cw-row.cw-file");
    if (!row || !ctx.fileByKey(row.dataset.key ?? "")) return;
    e.preventDefault();
    openTreeMenu(row, { x: e.clientX, y: e.clientY });
  }

  function openTreeMenu(row: HTMLElement, at: { x: number; y: number }): void {
    const k = row.dataset.key ?? "";
    openFileMenu(picks.includes(k) ? treeOrder(picks) : [k], at, row);
  }

  // ---- context menus ----

  function openMenu(items: (MenuItem | "sep")[], at: { x: number; y: number }, returnTo: HTMLElement, label: string): void {
    closeMenu(false);
    closePopover(false);
    const m = document.createElement("div");
    m.className = "detail-menu ctx-menu cw-ctx";
    m.setAttribute("role", "menu");
    m.setAttribute("aria-label", label);
    m.innerHTML = items
      .map((it, i) =>
        it === "sep"
          ? `<div class="cw-ctx-sep" role="separator"></div>`
          : `<button type="button" class="detail-menu-item${it.primary ? " primary" : ""}" role="menuitem" tabindex="-1" data-i="${i}">` +
            `${icon(it.icon)}<span class="detail-menu-text"><span class="detail-menu-label">${esc(it.label)}</span>` +
            `${it.hint ? `<span class="detail-menu-hint">${esc(it.hint)}</span>` : ""}</span></button>`,
      )
      .join("");
    document.body.append(m);
    const w = m.offsetWidth;
    const h = m.offsetHeight;
    const x = Math.max(8, Math.min(at.x, innerWidth - w - 8));
    const y = at.y + h > innerHeight - 8 ? Math.max(8, at.y - h) : at.y;
    m.style.left = `${x}px`;
    m.style.top = `${y}px`;
    m.addEventListener("click", (e) => {
      const b = (e.target as Element).closest<HTMLElement>("[data-i]");
      const it = b ? items[Number(b.dataset.i)] : undefined;
      if (!it || it === "sep") return;
      closeMenu(false);
      it.run();
    });
    m.addEventListener("keydown", (e) => {
      const btns = [...m.querySelectorAll<HTMLElement>("[data-i]")];
      const i = btns.indexOf(document.activeElement as HTMLElement);
      let next: HTMLElement | undefined;
      switch (e.key) {
        case "ArrowDown":
          next = btns[(i + 1) % btns.length];
          break;
        case "ArrowUp":
          next = btns[(i - 1 + btns.length) % btns.length];
          break;
        case "Home":
          next = btns[0];
          break;
        case "End":
          next = btns[btns.length - 1];
          break;
        case "Escape":
        case "Tab":
          e.preventDefault();
          e.stopPropagation();
          closeMenu(true);
          return;
        default:
          return;
      }
      e.preventDefault();
      next?.focus();
    });
    menu = m;
    menuReturn = returnTo;
    m.querySelector<HTMLElement>("[data-i]")?.focus();
  }

  function closeMenu(restore: boolean): void {
    if (!menu) return;
    menu.remove();
    menu = null;
    const back = menuReturn;
    menuReturn = null;
    if (restore && back?.isConnected) back.focus({ preventScroll: true });
  }

  function copy(text: string, done: string): void {
    navigator.clipboard?.writeText(text).then(
      () => announce(done),
      () => announce("Couldn't copy to the clipboard."),
    );
  }

  function openFileMenu(keys: string[], at: { x: number; y: number }, returnTo: HTMLElement): void {
    const t = filesTarget(keys);
    if (!t) return;
    const n = t.files.length;
    const items: (MenuItem | "sep")[] = [];
    if (ctx.alive()) {
      items.push({
        icon: "ask",
        label: n === 1 ? `Ask ${nm()} about this file\u2026` : `Ask ${nm()} about ${n} files\u2026`,
        hint: n === 1 ? disp(t.files[0]!) : namesHint(t.files),
        primary: true,
        run: () => openPopover(t, returnTo, new DOMRect(at.x, at.y, 0, 0)),
      });
    }
    items.push({
      icon: "copy",
      label: n === 1 ? "Copy path" : `Copy ${n} paths`,
      run: () => copy(t.files.map(disp).join("\n"), n === 1 ? "Path copied" : `${n} paths copied`),
    });
    openMenu(items, at, returnTo, n === 1 ? "File actions" : `Actions for ${n} files`);
  }

  function openLinesMenu(at: { x: number; y: number }, returnTo: HTMLElement): void {
    const rows = selectedRows();
    const t = linesTarget(rows);
    if (!t) return;
    const raw = rows.map(codeText).join("\n");
    const { anchor } = lineRange(rows);
    openMenu(
      [
        {
          icon: "ask",
          label: `Ask ${nm()} about ${t.label}\u2026`,
          hint: disp(t.file),
          primary: true,
          run: () => openPopover(t, returnTo, pill.hidden ? new DOMRect(at.x, at.y, 0, 0) : pill.getBoundingClientRect()),
        },
        { icon: "copy", label: rows.length === 1 ? "Copy line" : `Copy ${rows.length} lines`, run: () => copy(raw, rows.length === 1 ? "Line copied" : `${rows.length} lines copied`) },
        "sep",
        { icon: "copy", label: "Copy path", hint: `${disp(t.file)}${anchor}`, run: () => copy(`${disp(t.file)}${anchor}`, "Path copied") },
      ],
      at,
      returnTo,
      "Line actions",
    );
  }

  // ---- the ask popover ----

  function openPopover(t: Target, returnTo: HTMLElement | null, anchor?: DOMRect): void {
    if (!ctx.alive()) {
      announce(`${nm()} is gone. Asks can't be sent.`);
      return;
    }
    closeMenu(false);
    closePopover(false);
    const tk = targetKey(t);
    const where =
      t.kind === "lines"
        ? `${icon("lines")}<b>${esc(disp(t.file))}</b><span>${esc(t.label)}</span>`
        : t.files.length === 1
          ? `${icon("file")}<b>${esc(disp(t.files[0]!))}</b><span>whole file</span>`
          : `${icon("files")}<b>${esc(namesHint(t.files))}</b><span>${esc(t.label)}</span>`;
    const title = t.kind === "lines" ? `${disp(t.file)} ${t.label}` : t.files.map(disp).join("\n");
    const p = document.createElement("div");
    p.className = "cw-ask";
    p.setAttribute("role", "dialog");
    p.setAttribute("aria-label", `Ask ${nm()}`);
    p.innerHTML =
      `<div class="cw-ask-tgt" title="${esc(title)}">${where}</div>` +
      `<textarea rows="2" maxlength="${ASK_MAX}" spellcheck="true" aria-label="Question or change for ${esc(nm())}" placeholder="Ask a question or describe a change"></textarea>` +
      `<div class="cw-ask-foot"><span class="cw-ask-hint"><kbd>Enter</kbd> adds \u00b7 <kbd>Shift</kbd>+<kbd>Enter</kbd> new line</span>` +
      `<button type="button" class="btn sm ghost" data-a="cancel">Cancel</button>` +
      `<button type="button" class="btn sm accent" data-a="add" disabled>Add to queue</button></div>`;
    document.body.append(p);
    const ta = p.querySelector("textarea")!;
    const add = p.querySelector<HTMLButtonElement>('[data-a="add"]')!;
    const fit = (): void => {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight + 2, 200)}px`;
      add.disabled = !ta.value.trim();
    };
    ta.value = drafts.get(tk) ?? "";
    fit();

    const a = anchor ?? returnTo?.getBoundingClientRect() ?? ctx.body.getBoundingClientRect();
    const w = p.offsetWidth;
    const h = p.offsetHeight;
    let top = a.bottom + 6;
    if (top + h > innerHeight - 8) top = Math.max(8, a.top - h - 6);
    p.style.top = `${top}px`;
    p.style.left = `${Math.max(8, Math.min(a.left, innerWidth - w - 8))}px`;

    const submit = (): void => {
      const text = ta.value.trim();
      if (!text) return;
      drafts.delete(tk);
      closePopover(true);
      addToQueue(t, text);
    };
    ta.addEventListener("input", () => {
      drafts.set(tk, ta.value);
      fit();
    });
    p.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closePopover(true);
      } else if (e.key === "Enter" && e.target === ta && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      } else if (e.key === "Tab") {
        const f = [ta, ...p.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const i = f.indexOf(document.activeElement as HTMLTextAreaElement);
        const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i + 1) % f.length;
        e.preventDefault();
        f[next]?.focus();
      }
    });
    p.addEventListener("click", (e) => {
      const b = (e.target as Element).closest<HTMLElement>("[data-a]");
      if (b?.dataset.a === "cancel") closePopover(true);
      else if (b?.dataset.a === "add") submit();
    });
    pop = p;
    popReturn = returnTo;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  function closePopover(restore: boolean): void {
    if (!pop) return;
    pop.remove();
    pop = null;
    const back = popReturn;
    popReturn = null;
    if (!restore) return;
    if (back?.isConnected && !back.hidden) back.focus({ preventScroll: true });
    else ctx.body.focus({ preventScroll: true });
  }

  // ---- the queue ----

  function addToQueue(t: Target, text: string): void {
    const a: Ask = { id: `a${st.seq++}`, target: t, text, at: Date.now() };
    st.queue.push(a);
    if (!st.everAdded) {
      st.everAdded = true;
      if (innerWidth >= WIDE) st.qopen = true;
    }
    if (t.kind === "lines") {
      selFile = selA = selB = "";
      getSelection()?.removeAllRanges();
      paintSel();
    } else clearPicks();
    flashId = a.id;
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      flashId = "";
      q.querySelector(`.cw-qi[data-id="${a.id}"]`)?.classList.remove("enter", "flash");
    }, 1200);
    sendErr = "";
    save();
    render();
    renderCount(true);
    marks();
    q.querySelector(`.cw-qi[data-id="${a.id}"]`)?.scrollIntoView({ block: "nearest" });
    announce(`Added to the queue. ${plural(st.queue.length, "ask")} for ${nm()}.`);
  }

  function setOpen(open: boolean): void {
    st.qopen = open;
    save();
    applyOpen();
  }

  function applyOpen(): void {
    ctx.root.classList.toggle("cw-qopen", st.qopen);
    ctx.root.classList.toggle("cw-hasq", st.queue.length > 0);
    qbtn.setAttribute("aria-pressed", String(st.qopen));
    qbtn.title = st.qopen ? "Hide the ask queue" : "Show the ask queue";
  }

  function renderCount(bump = false): void {
    const n = st.queue.length;
    qcount.textContent = String(n);
    qcount.classList.toggle("has", n > 0);
    qbtn.setAttribute("aria-label", n ? `Queue, ${plural(n, "ask")}` : "Queue");
    if (bump) {
      qcount.classList.remove("bump");
      void qcount.offsetWidth;
      qcount.classList.add("bump");
    }
  }

  function removeAsks(ids: string[], label: string): void {
    const items = ids
      .map((id) => ({ ask: st.queue.find((a) => a.id === id), index: st.queue.findIndex((a) => a.id === id) }))
      .filter((x): x is { ask: Ask; index: number } => !!x.ask);
    if (!items.length) return;
    st.queue = st.queue.filter((a) => !ids.includes(a.id));
    if (editing && ids.includes(editing)) editing = null;
    if (undo) window.clearTimeout(undo.timer);
    undo = {
      items,
      label,
      timer: window.setTimeout(() => {
        const hadFocus = q.contains(document.activeElement);
        undo = null;
        render();
        if (hadFocus && !q.contains(document.activeElement)) focusQueue();
      }, UNDO_MS),
    };
    save();
    render();
    renderCount();
    marks();
    q.querySelector<HTMLElement>('[data-f="undo"]')?.focus();
    announce(`${label}. Undo is available for a few seconds.`);
  }

  function doUndo(): void {
    if (!undo) return;
    window.clearTimeout(undo.timer);
    const items = [...undo.items].sort((x, y) => x.index - y.index);
    undo = null;
    for (const { ask, index } of items) st.queue.splice(Math.min(index, st.queue.length), 0, ask);
    save();
    render();
    renderCount();
    marks();
    q.querySelector<HTMLElement>(`[data-f="jump:${items[0]!.ask.id}"], .cw-qi[data-id="${items[0]!.ask.id}"] [data-q="edit"]`)?.focus();
    announce(`Restored ${plural(items.length, "ask")}.`);
  }

  function focusQueue(): void {
    (q.querySelector<HTMLElement>('[data-q="send"]:not(:disabled)') ?? q.querySelector<HTMLElement>('[data-f="close"]'))?.focus();
  }

  function startEdit(id: string): void {
    const a = st.queue.find((x) => x.id === id);
    if (!a) return;
    editing = id;
    editDraft = a.text;
    render();
    const t = q.querySelector<HTMLTextAreaElement>(".cw-qi-edit textarea");
    if (t) {
      t.focus();
      t.setSelectionRange(t.value.length, t.value.length);
    }
  }

  function endEdit(saveIt: boolean): void {
    const id = editing;
    if (!id) return;
    const a = st.queue.find((x) => x.id === id);
    const v = editDraft.trim();
    if (saveIt && a && v) a.text = v.slice(0, ASK_MAX);
    editing = null;
    save();
    render();
    q.querySelector<HTMLElement>(`.cw-qi[data-id="${id}"] [data-q="edit"]`)?.focus();
  }

  function jump(t: Target | null, fileKey?: string): void {
    let key = fileKey ?? "";
    let rows: [string, string] | null = null;
    if (t?.kind === "lines") {
      key = t.file.key;
      rows = t.rows;
    } else if (t) key = t.files[0]!.key;
    if (!key || !ctx.fileByKey(key)) {
      announce("That file is no longer in this diff.");
      return;
    }
    pendingJump = { key, rows, until: Date.now() + JUMP_MS };
    if (innerWidth < WIDE && st.qopen) setOpen(false);
    if (ctx.currentKey() === key) applyJump();
    else ctx.open(key);
  }

  function applyJump(): void {
    const j = pendingJump;
    if (!j) return;
    if (Date.now() > j.until) {
      pendingJump = null;
      return;
    }
    if (ctx.currentKey() !== j.key) return;
    if (!j.rows) {
      pendingJump = null;
      ctx.body.focus({ preventScroll: true });
      return;
    }
    const rows = lineRows();
    const first = rows.find((r) => rowKey(r) === j.rows![0]);
    if (!first) {
      // Still loading, or those lines changed since the ask was written.
      if (ctx.body.querySelector("table.diff")) {
        pendingJump = null;
        announce("Those lines changed since you asked.");
      }
      return;
    }
    pendingJump = null;
    selFile = j.key;
    selA = j.rows[0];
    selB = rows.some((r) => rowKey(r) === j.rows![1]) ? j.rows[1] : j.rows[0];
    first.scrollIntoView({ block: "center" });
    paintSel();
    ctx.body.focus({ preventScroll: true });
  }

  /** Dots on tree rows and a left mark on diff rows that have asks waiting. */
  function marks(): void {
    if (dead) return;
    const pend = st.sent.filter(isPending);
    const queued = new Set(st.queue.flatMap((a) => targetFiles(a.target).map((f) => f.key)));
    const sent = new Set(pend.flatMap((b) => b.items.flatMap((a) => targetFiles(a.target).map((f) => f.key))));
    for (const row of fileRows()) {
      const m = row.querySelector<HTMLElement>(".cw-qmark");
      if (!m) continue;
      const k = row.dataset.key ?? "";
      const isQ = queued.has(k);
      const isS = !isQ && sent.has(k);
      m.hidden = !isQ && !isS;
      m.classList.toggle("sent", isS);
      m.title = isQ ? "Has queued asks" : isS ? "Sent, waiting on an answer" : "";
    }
    const cur = ctx.currentKey();
    const rows = lineRows();
    const idx = new Map(rows.map((r, i) => [rowKey(r), i]));
    const qs = new Set<number>();
    const ss = new Set<number>();
    const mark = (t: Target, into: Set<number>): void => {
      if (t.kind !== "lines" || t.file.key !== cur) return;
      const a = idx.get(t.rows[0]);
      const b = idx.get(t.rows[1]);
      if (a === undefined || b === undefined) return;
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) into.add(i);
    };
    for (const a of st.queue) mark(a.target, qs);
    for (const b of pend) for (const a of b.items) mark(a.target, ss);
    rows.forEach((r, i) => {
      r.classList.toggle("q", qs.has(i) || ss.has(i));
      r.classList.toggle("q-sent", !qs.has(i) && ss.has(i));
    });
  }

  // ---- composing and sending ----

  function compose(items: Ask[]): string {
    const n = items.length;
    const repos = [...new Set(items.flatMap((a) => targetFiles(a.target).map((f) => f.repo)))];
    const scope = [ctx.modeLabel(), ...repos].filter(Boolean).join(" \u00b7 ");
    const head =
      n === 1
        ? `1 ask from the Changes view (${scope}).\nIf it's a question, answer it. If it asks for a change, make it, then list the files you changed.`
        : `${n} asks from the Changes view (${scope}).\nSome may be questions and some change requests. Reply with a numbered list that matches these numbers: answer each question, and for each change, make it and say which files you changed.`;
    const body = items.map((a, i) => {
      const t = a.target;
      const where = t.kind === "lines" ? `${disp(t.file)} ${t.label}` : t.files.map(disp).join(", ") + (t.files.length === 1 ? " (whole file)" : "");
      const fence = t.kind === "lines" && t.excerpt ? fenceFor(t.excerpt) : "";
      const code = fence ? `\n${fence}\n${(t as LinesTarget).excerpt}\n${fence}` : "";
      return `${i + 1}. ${where}${code}\n${a.text}`;
    });
    return [head, ...body].join("\n\n").trim();
  }

  async function sendAll(): Promise<void> {
    if (sending || !st.queue.length) return;
    const items = st.queue.slice();
    const message = compose(items);
    if (!ctx.alive() || message.length > PROMPT_MAX) {
      renderNote();
      return;
    }
    sending = true;
    sendErr = "";
    renderNote();
    renderDock();
    let batch: Batch | null = null;
    try {
      const r = await call<{ result?: string }>("/api/jarvis/workers/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: ctx.sessionId, text: message, mode: "queue" }),
      });
      if (dead) return;
      batch = { id: `b${st.seq++}`, at: Date.now(), items, status: r?.result === "queued" ? "queued" : "working", message };
      st.sent.unshift(batch);
      st.sent = st.sent.slice(0, SENT_CAP);
      openSent.add(batch.id);
      const ids = new Set(items.map((a) => a.id));
      st.queue = st.queue.filter((a) => !ids.has(a.id));
      if (editing && ids.has(editing)) editing = null;
      if (undo) {
        window.clearTimeout(undo.timer);
        undo = null;
      }
      prevOpen = false;
      save();
      announce(`Sent ${plural(items.length, "ask")} to ${nm()}.`);
    } catch (err) {
      if (dead) return;
      sendErr = `Couldn't send. ${(err as Error).message}`;
    }
    sending = false;
    render();
    renderCount();
    marks();
    if (batch) {
      q.querySelector<HTMLElement>(`[data-f="sb:${batch.id}"]`)?.focus();
      schedulePoll(1500);
    } else q.querySelector<HTMLElement>('[data-q="send"]')?.focus();
  }

  // ---- following sent batches ----

  const isPending = (b: Batch): boolean => b.status === "queued" || b.status === "working";

  function schedulePoll(delay = POLL_MS): void {
    if (dead || pollTimer !== undefined || !ctx.alive() || !st.sent.some(isPending)) return;
    pollTimer = window.setTimeout(() => {
      pollTimer = undefined;
      void poll();
    }, delay);
  }

  async function poll(): Promise<void> {
    if (dead || !st.sent.some(isPending)) return;
    const sid = encodeURIComponent(ctx.sessionId);
    try {
      const [log, lv] = await Promise.all([
        call<{ messages?: LogMessage[] }>(`/api/jarvis/workers/log?sessionId=${sid}`),
        call<{ live?: LiveState | null }>(`/api/jarvis/workers/live?sessionId=${sid}`),
      ]);
      if (dead) return;
      if (reconcile(Array.isArray(log?.messages) ? log.messages : [], lv?.live ?? null)) {
        save();
        render();
        marks();
      }
    } catch {
      // Try again on the next tick.
    }
    schedulePoll();
  }

  function findUser(msgs: LogMessage[], b: Batch, claimed: Set<number>): number {
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]!;
      if (m.role !== "user" || claimed.has(i) || messageText(m.content).trim() !== b.message) continue;
      const at = isNum(m.timestamp) ? m.timestamp : Date.parse(String(m.timestamp ?? ""));
      if (Number.isFinite(at) && at < b.at - 120_000) continue;
      return i;
    }
    return -1;
  }

  function reconcile(msgs: LogMessage[], lv: LiveState | null): boolean {
    const busy = !!lv?.busy;
    const waiting = (Array.isArray(lv?.queue) ? lv!.queue! : []).map((x) => messageText(x?.text).trim());
    const now = Date.now();
    const claimed = new Set<number>();
    let changed = false;
    for (const b of st.sent.filter(isPending).reverse()) {
      const i = findUser(msgs, b, claimed);
      let next: BatchStatus = b.status;
      if (i < 0) {
        if (waiting.includes(b.message)) {
          next = "queued";
          idleSince.delete(b.id);
        } else if (busy) idleSince.delete(b.id);
        else {
          const since = idleSince.get(b.id) ?? now;
          idleSince.set(b.id, since);
          if (now - since > LOST_MS) next = "lost";
        }
      } else {
        claimed.add(i);
        idleSince.delete(b.id);
        const after = msgs.slice(i + 1);
        const nextUser = after.findIndex((m) => m.role === "user");
        const reply = (nextUser < 0 ? after : after.slice(0, nextUser))
          .filter((m) => m.role === "assistant")
          .map((m) => messageText(m.content).trim())
          .filter(Boolean)
          .join("\n\n");
        const seen = seenAt.get(b.id) ?? now;
        seenAt.set(b.id, seen);
        if (nextUser >= 0 || (!busy && (reply.length > 0 || now - seen > SEEN_GRACE_MS))) {
          next = "answered";
          b.reply = reply;
          b.answers = splitAnswers(reply, b.items.length);
          announce(`${nm()} answered ${plural(b.items.length, "ask")}.`);
        } else next = "working";
      }
      if (next !== b.status) {
        b.status = next;
        changed = true;
      }
    }
    return changed;
  }

  function requeue(bid: string): void {
    const b = st.sent.find((x) => x.id === bid);
    if (!b) return;
    for (const a of b.items) st.queue.push({ ...a, id: `a${st.seq++}` });
    st.sent = st.sent.filter((x) => x !== b);
    if (!st.qopen && innerWidth >= WIDE) st.qopen = true;
    save();
    render();
    renderCount(true);
    marks();
    focusQueue();
    announce(`Put ${plural(b.items.length, "ask")} back in the queue.`);
  }

  function dismiss(bid: string): void {
    const i = st.sent.findIndex((x) => x.id === bid);
    if (i < 0) return;
    st.sent.splice(i, 1);
    openSent.delete(bid);
    openFull.delete(bid);
    save();
    render();
    marks();
    (q.querySelector<HTMLElement>(`[data-f="sb:${st.sent[Math.min(i, st.sent.length - 1)]?.id ?? ""}"]`) ?? null)?.focus();
    if (!q.contains(document.activeElement)) focusQueue();
  }

  function openChat(): void {
    const taskId = ctx.taskId();
    if (!taskId) return;
    try {
      const ch = new BroadcastChannel("devis-code");
      ch.postMessage({ type: "open-worker", taskId, sessionId: ctx.sessionId });
      ch.close();
    } catch {
      // No BroadcastChannel. Nothing else to reach the main window with.
    }
    if (document.documentElement.classList.contains("wco")) window.open("/?focus=main");
  }

  // ---- rendering ----

  function targetHtml(t: Target, act: string, f: string, extra = ""): string {
    let inner: string;
    let link = true;
    if (t.kind === "lines") {
      inner = `${icon("lines")}<span class="cw-qi-path">${esc(disp(t.file))}</span><span class="cw-qi-lines">${esc(t.label)}</span>`;
      link = !!ctx.fileByKey(t.file.key);
    } else if (t.files.length === 1) {
      inner = `${icon("file")}<span class="cw-qi-path">${esc(disp(t.files[0]!))}</span><span class="cw-qi-lines">whole file</span>`;
      link = !!ctx.fileByKey(t.files[0]!.key);
    } else {
      inner = `${icon("files")}<span class="cw-qi-path">${esc(t.label)}</span>`;
      link = false;
    }
    return link
      ? `<button type="button" class="cw-qi-tgt" data-q="${act}" data-f="${f}"${extra} title="Show in the diff">${inner}</button>`
      : `<span class="cw-qi-tgt static"${t.kind === "files" && t.files.length > 1 ? "" : ` title="No longer in this diff"`}>${inner}</span>`;
  }

  function filesListHtml(t: Target, f: string): string {
    if (t.kind !== "files" || t.files.length < 2) return "";
    return (
      `<ul class="cw-qi-files">` +
      t.files
        .map((x, i) =>
          ctx.fileByKey(x.key)
            ? `<li><button type="button" data-q="jumpf" data-k="${esc(x.key)}" data-f="${f}:${i}" title="${esc(disp(x))}">${esc(basename(x.path))}</button></li>`
            : `<li><button type="button" disabled title="No longer in this diff">${esc(basename(x.path))}</button></li>`,
        )
        .join("") +
      `</ul>`
    );
  }

  function itemHtml(a: Ask, i: number): string {
    const n = i + 1;
    const t = a.target;
    const cls = a.id === flashId ? " enter flash" : "";
    const text =
      editing === a.id
        ? `<div class="cw-qi-edit"><textarea class="cw-qi-input" rows="2" maxlength="${ASK_MAX}" data-f="einput:${a.id}" aria-label="Edit ask ${n}">${esc(editDraft)}</textarea>` +
          `<div class="cw-qi-eacts"><button type="button" class="btn sm ghost" data-q="edit-cancel" data-f="ecancel:${a.id}">Cancel</button>` +
          `<button type="button" class="btn sm accent" data-q="edit-save" data-f="esave:${a.id}">Save</button></div></div>`
        : `<p class="cw-qi-text">${esc(a.text)}</p>`;
    return (
      `<li class="cw-qi${cls}" data-id="${a.id}">` +
      `<div class="cw-qi-top"><span class="cw-qi-n" aria-hidden="true">${n}</span>${targetHtml(t, "jump", `jump:${a.id}`)}` +
      `<span class="cw-qi-acts">` +
      `<button type="button" class="btn sm ghost cw-icon" data-q="edit" data-f="edit:${a.id}" aria-label="Edit ask ${n}" title="Edit">${icon("edit")}</button>` +
      `<button type="button" class="btn sm ghost cw-icon" data-q="remove" data-f="remove:${a.id}" aria-label="Remove ask ${n}" title="Remove">${icon("dismiss")}</button>` +
      `</span></div>` +
      (t.kind === "lines" && t.excerpt ? `<pre class="cw-qi-ex" aria-hidden="true">${esc(t.excerpt)}</pre>` : "") +
      filesListHtml(t, `jumpf:${a.id}`) +
      text +
      `</li>`
    );
  }

  const STATUS_TONE: Record<BatchStatus, string> = { queued: "", working: "run", answered: "ok", lost: "warn" };

  function statusText(s: BatchStatus): string {
    switch (s) {
      case "queued":
        return `Waiting for ${nm()} to finish its turn`;
      case "working":
        return `${nm()} is on it`;
      case "answered":
        return "Answered";
      default:
        return `Couldn't confirm ${nm()} got this`;
    }
  }

  function batchHtml(b: Batch): string {
    const pending = isPending(b);
    const tone = STATUS_TONE[b.status];
    const asks = b.items
      .map((a, i) => {
        const ans = b.answers?.[i];
        return (
          `<li class="cw-sb-ask"><div class="cw-qi-top"><span class="cw-qi-n" aria-hidden="true">${i + 1}</span>` +
          `${targetHtml(a.target, "sjump", `sjump:${b.id}:${i}`, ` data-i="${i}"`)}</div>` +
          filesListHtml(a.target, `sjumpf:${b.id}:${i}`) +
          `<p class="cw-sb-q">${esc(a.text)}</p>` +
          (ans ? `<div class="cw-sb-a md">${renderMarkdown(ans)}</div>` : "") +
          `</li>`
        );
      })
      .join("");
    let more = "";
    if (pending) {
      more = `<div class="cw-sb-more" aria-busy="true"><div class="cw-sb-wait" aria-hidden="true"><span class="cw-skel"></span><span class="cw-skel"></span></div></div>`;
    } else if (b.status === "answered") {
      if (!b.reply) more = `<div class="cw-sb-more"><p class="cw-qnote">${esc(nm())} finished without a written reply.</p></div>`;
      else if (b.answers)
        more =
          `<div class="cw-sb-more"><details class="cw-qprev cw-sb-full" data-full="${b.id}"${openFull.has(b.id) ? " open" : ""}>` +
          `<summary data-f="full:${b.id}">Full reply</summary><div class="cw-sb-a md">${renderMarkdown(b.reply)}</div></details></div>`;
      else more = `<div class="cw-sb-more"><div class="cw-sb-a md">${renderMarkdown(b.reply)}</div></div>`;
    }
    const foot =
      (b.status === "lost" ? `<button type="button" class="btn sm" data-q="requeue" data-f="requeue:${b.id}">${icon("queue")}<span>Put back in queue</span></button>` : "") +
      (ctx.taskId() ? `<button type="button" class="btn sm ghost" data-q="chat" data-f="chat:${b.id}">${icon("chat")}<span>Open in worker chat</span></button>` : "") +
      (!pending ? `<button type="button" class="btn sm ghost" data-q="dismiss" data-f="dismiss:${b.id}">Dismiss</button>` : "");
    return (
      `<details class="cw-sb" data-b="${b.id}"${openSent.has(b.id) ? " open" : ""}>` +
      `<summary data-f="sb:${b.id}">${icon("chevron")}<span class="cw-dot"${tone ? ` data-tone="${tone}"` : ""} aria-hidden="true"></span>` +
      `<span class="cw-sb-st">${esc(statusText(b.status))} \u00b7 ${plural(b.items.length, "ask")}</span>` +
      `<time datetime="${new Date(b.at).toISOString()}">${esc(clock(b.at))}</time></summary>` +
      `<ol class="cw-sb-list">${asks}</ol>${more}` +
      (foot ? `<div class="cw-sb-foot">${foot}</div>` : "") +
      `</details>`
    );
  }

  function emptyHtml(): string {
    return (
      `<div class="cw-qempty"><p class="cw-qempty-t">Nothing queued</p>` +
      `<p>Collect questions and change requests, then send them to ${esc(nm())} in one go.</p>` +
      `<ol><li>Select lines in the gutter, or Ctrl+click files.</li><li>Right-click and pick <b>Ask ${esc(nm())}</b>.</li><li>Press <b>Send all</b> when you're done.</li></ol></div>`
    );
  }

  function render(): void {
    if (dead) return;
    const ae = document.activeElement as HTMLElement | null;
    const focusKey = ae && q.contains(ae) ? (ae.dataset.f ?? "") : "";
    const caret = ae instanceof HTMLTextAreaElement ? [ae.selectionStart, ae.selectionEnd] : null;
    const scroll = qbody.scrollTop;
    const n = st.queue.length;

    setHtml(
      qhead,
      `<h2 class="cw-qtitle" id="cw-qtitle">Queue<span class="cw-n">${n}</span></h2>` +
        `<span class="cw-qfor">for ${esc(nm())}</span><span class="cw-sp"></span>` +
        (n ? `<button type="button" class="btn sm ghost" data-q="clear" data-f="clear">Clear</button>` : "") +
        `<button type="button" class="btn sm ghost cw-icon" data-q="close" data-f="close" aria-label="Close the queue" title="Close (Esc)">${icon("dismiss")}</button>`,
    );

    const undoHtml = undo
      ? `<div class="cw-qundo" role="status"><span>${esc(undo.label)}</span><span class="cw-sp"></span><button type="button" class="btn sm ghost" data-q="undo" data-f="undo">Undo</button></div>`
      : "";
    const list = n ? `<ol class="cw-qlist" aria-label="Queued asks">${st.queue.map(itemHtml).join("")}</ol>` : emptyHtml();
    const sent = st.sent.length ? `<section class="cw-sent" aria-labelledby="cw-sent-h"><h3 class="cw-sent-h" id="cw-sent-h">Sent</h3>${st.sent.map(batchHtml).join("")}</section>` : "";
    qbody.innerHTML = undoHtml + list + sent;
    htmlCache.delete(qbody);

    qfoot.hidden = !n;
    if (n) {
      qfoot.innerHTML =
        `<details class="cw-qprev" data-prev${prevOpen ? " open" : ""}><summary data-f="prev">Preview message</summary><pre>${esc(compose(st.queue))}</pre></details>` +
        `<p class="cw-qnote"></p>` +
        `<button type="button" class="btn accent cw-qsend" data-q="send" data-f="send">${icon("send")}<span></span></button>`;
    } else qfoot.innerHTML = "";
    renderNote();
    renderDock();
    applyOpen();
    qbody.scrollTop = scroll;

    if (focusKey) {
      const el = q.querySelector<HTMLElement>(`[data-f="${CSS.escape(focusKey)}"]`);
      if (el) {
        el.focus({ preventScroll: true });
        if (caret && el instanceof HTMLTextAreaElement) el.setSelectionRange(caret[0]!, caret[1]!);
      } else focusQueue();
    }
  }

  function renderNote(): void {
    const note = qfoot.querySelector<HTMLElement>(".cw-qnote");
    const send = qfoot.querySelector<HTMLButtonElement>(".cw-qsend");
    const forEl = qhead.querySelector<HTMLElement>(".cw-qfor");
    if (forEl) forEl.textContent = `for ${nm()}`;
    if (!note || !send) return;
    const n = st.queue.length;
    const len = n ? compose(st.queue).length : 0;
    let html: string;
    let bad = true;
    if (sendErr) html = esc(sendErr);
    else if (!ctx.alive()) html = `${esc(nm())} is gone. These can't be sent.`;
    else if (len > PROMPT_MAX)
      html = `Too long for one message: ${len.toLocaleString()} of ${PROMPT_MAX.toLocaleString()} characters. Remove or shorten an ask.`;
    else {
      bad = false;
      html = ctx.busy()
        ? `<span class="cw-dot" data-tone="run" aria-hidden="true"></span><span><b>${esc(nm())}</b> is mid-turn. These run as its next turn.</span>`
        : `<span>Goes to <b>${esc(nm())}</b> as one message.</span>`;
    }
    note.classList.toggle("bad", bad);
    if (note.innerHTML !== html) note.innerHTML = html;
    send.disabled = sending || !n || !ctx.alive() || len > PROMPT_MAX;
    const label = send.querySelector("span")!;
    label.textContent = sending ? "Sending\u2026" : `Send all (${n})`;
  }

  function renderDock(): void {
    const n = st.queue.length;
    const off = sending || !ctx.alive();
    setHtml(
      dock,
      n
        ? `<button type="button" class="cw-qdock-open" data-q="open" aria-label="Open the queue, ${plural(n, "ask")} for ${esc(nm())}">${icon("queue")}` +
            `<span>${n} queued</span><span class="cw-qdock-sub">for ${esc(nm())}</span></button>` +
            `<button type="button" class="btn sm accent" data-q="send"${off ? " disabled" : ""}>${icon("send")}<span>${sending ? "Sending\u2026" : "Send all"}</span></button>`
        : "",
    );
  }

  // ---- events ----

  function onQClick(e: MouseEvent): void {
    const b = (e.target as Element).closest<HTMLElement>("[data-q]");
    if (!b || (b as HTMLButtonElement).disabled) return;
    const id = b.closest<HTMLElement>(".cw-qi")?.dataset.id ?? "";
    const bid = b.closest<HTMLElement>("[data-b]")?.dataset.b ?? "";
    const ask = st.queue.find((a) => a.id === id);
    switch (b.dataset.q) {
      case "close":
        setOpen(false);
        qbtn.focus();
        break;
      case "open":
        setOpen(true);
        focusQueue();
        break;
      case "clear":
        removeAsks(
          st.queue.map((a) => a.id),
          `Cleared ${plural(st.queue.length, "ask")}`,
        );
        break;
      case "undo":
        doUndo();
        break;
      case "remove":
        removeAsks([id], "Removed 1 ask");
        break;
      case "edit":
        startEdit(id);
        break;
      case "edit-save":
        endEdit(true);
        break;
      case "edit-cancel":
        endEdit(false);
        break;
      case "jump":
        if (ask) jump(ask.target);
        break;
      case "jumpf":
        jump(null, b.dataset.k);
        break;
      case "sjump": {
        const batch = st.sent.find((x) => x.id === bid);
        const a = batch?.items[Number(b.dataset.i)];
        if (a) jump(a.target);
        break;
      }
      case "send":
        void sendAll();
        break;
      case "requeue":
        requeue(bid);
        break;
      case "dismiss":
        dismiss(bid);
        break;
      case "chat":
        openChat();
        break;
    }
  }

  function onQKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLTextAreaElement && t.classList.contains("cw-qi-input")) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        endEdit(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        endEdit(false);
      }
    }
  }

  function onQInput(e: Event): void {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLTextAreaElement && t.classList.contains("cw-qi-input")) editDraft = t.value;
  }

  function onToggle(e: Event): void {
    const d = e.target as HTMLDetailsElement;
    if (!(d instanceof HTMLDetailsElement)) return;
    if (d.hasAttribute("data-prev")) prevOpen = d.open;
    else if (d.dataset.full) (d.open ? openFull.add(d.dataset.full) : openFull.delete(d.dataset.full));
    else if (d.dataset.b) (d.open ? openSent.add(d.dataset.b) : openSent.delete(d.dataset.b));
  }

  const onQbtn = (): void => {
    setOpen(!st.qopen);
    if (st.qopen && innerWidth < WIDE) focusQueue();
  };

  const onPill = (): void => {
    const rows = selectedRows();
    const t = linesTarget(rows);
    if (t) openPopover(t, pill, pill.getBoundingClientRect());
  };

  const onDocDown = (e: PointerEvent): void => {
    const t = e.target as Node;
    if (menu && !menu.contains(t)) closeMenu(false);
    if (pop && !pop.contains(t) && !(t instanceof Element && t.closest(".cw-askpill"))) closePopover(false);
  };

  const onResize = (): void => {
    closeMenu(false);
    placePill();
    if (pop) {
      const r = pop.getBoundingClientRect();
      pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - r.width - 8))}px`;
      pop.style.top = `${Math.max(8, Math.min(r.top, innerHeight - r.height - 8))}px`;
    }
  };

  const onBodyScroll = (): void => closeMenu(false);

  qbtn.addEventListener("click", onQbtn);
  q.addEventListener("click", onQClick);
  q.addEventListener("keydown", onQKey);
  q.addEventListener("input", onQInput);
  q.addEventListener("toggle", onToggle, true);
  dock.addEventListener("click", onQClick);
  selbar.addEventListener("click", onSelbarClick);
  pill.addEventListener("click", onPill);
  ctx.tree.addEventListener("contextmenu", onTreeContext);
  ctx.body.addEventListener("pointerdown", onBodyDown);
  ctx.body.addEventListener("pointermove", onBodyMove);
  ctx.body.addEventListener("pointerup", onBodyUp);
  ctx.body.addEventListener("pointercancel", onBodyUp);
  ctx.body.addEventListener("click", onBodyClick);
  ctx.body.addEventListener("mouseup", onBodyMouseUp);
  ctx.body.addEventListener("contextmenu", onBodyContext);
  ctx.body.addEventListener("keydown", onBodyKey);
  ctx.body.addEventListener("scroll", onBodyScroll, { passive: true });
  document.addEventListener("pointerdown", onDocDown, true);
  window.addEventListener("resize", onResize);

  render();
  renderCount();
  schedulePoll(800);

  return {
    syncTree,
    afterDiff(): void {
      if (dead) return;
      const key = ctx.currentKey() ?? "";
      if (selFile && selFile !== key) selFile = selA = selB = "";
      if (pill.parentElement !== ctx.body) ctx.body.append(pill);
      applyJump();
      paintSel();
      marks();
    },
    update(): void {
      if (dead) return;
      if (!ctx.alive()) {
        closeMenu(false);
        closePopover(false);
      }
      const tid = ctx.taskId();
      if (tid !== lastTaskId) {
        lastTaskId = tid;
        render();
      } else {
        renderNote();
        renderDock();
      }
      renderSelbar();
      placePill();
      schedulePoll();
    },
    treeClick,
    treeKey,
    clearPicks,
    escape(): boolean {
      if (menu) {
        closeMenu(true);
        return true;
      }
      if (pop) {
        closePopover(true);
        return true;
      }
      if (editing) {
        endEdit(false);
        return true;
      }
      if (selA) {
        clearSel();
        getSelection()?.removeAllRanges();
        return true;
      }
      if (picks.length) {
        clearPicks();
        return true;
      }
      if (st.qopen && innerWidth < WIDE) {
        setOpen(false);
        qbtn.focus();
        return true;
      }
      return false;
    },
    askFile(anchor?: HTMLElement): void {
      const key = ctx.currentKey();
      const t = key ? filesTarget([key]) : null;
      if (t) openPopover(t, anchor ?? null, anchor?.getBoundingClientRect());
    },
    destroy(): void {
      if (dead) return;
      dead = true;
      window.clearTimeout(pollTimer);
      window.clearTimeout(flashTimer);
      if (undo) window.clearTimeout(undo.timer);
      document.removeEventListener("pointerdown", onDocDown, true);
      window.removeEventListener("resize", onResize);
      closeMenu(false);
      closePopover(false);
      ctx.root.classList.remove("cw-qopen", "cw-hasq", "cw-selecting");
    },
  };
}
