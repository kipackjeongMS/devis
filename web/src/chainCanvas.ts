// The chain canvas: pipeline blocks are HTML cards in a transformed "world" layer and
// arrows are SVG paths in the same world coordinates, so pan and zoom move them together.
// Drag the background (or scroll) to pan, Ctrl+scroll to zoom at the cursor, drag a block
// to move it, and drag from a block's right port onto another block to chain them.
import { el } from "./dom.js";
import { icon } from "./icons.js";
import { esc } from "./util.js";
import {
  GRID,
  NODE_H,
  NODE_W,
  bounds,
  canConnect,
  edgePath,
  fitTransform,
  formatElapsed,
  nodeBranchLabel,
  nodeElapsed,
  snap,
  statusLabel,
  statusTone,
  zoomAt,
  type ChainEdge,
  type ChainGraph,
  type ChainNode,
  type NodeRunState,
  type View,
} from "./pipelineModel.js";

export type Selection = { kind: "node"; id: string } | { kind: "edge"; from: string; to: string } | null;

/** The run/stop control floated over the selected block. */
export interface BlockAction {
  kind: "run" | "stop";
  label: string;
  title: string;
  disabled: boolean;
}

/** Drag-and-drop type for catalog rows (the payload is the pipeline's JSON). */
export const PIPELINE_MIME = "application/x-ado-pipeline";

export interface CanvasHooks {
  onSelect(sel: Selection): void;
  onMove(id: string, x: number, y: number): void;
  onConnect(from: string, to: string): void;
  onRemove(sel: NonNullable<Selection>): void;
  onDrop(payload: string, at: { x: number; y: number }): void;
  onReject(reason: string): void;
  onView(view: View): void;
  blockAction(id: string): BlockAction | null;
  onBlockAction(id: string, kind: BlockAction["kind"]): void;
}

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const DRAG_SLOP = 3;
const SVG_MARGIN = 400;
const PASSED = new Set(["succeeded", "partiallySucceeded"]);
const ACTIVE = new Set(["queuing", "queued", "running"]);

type Gesture =
  | { kind: "pan"; pointerId: number; sx: number; sy: number; vx: number; vy: number; moved: boolean }
  | { kind: "node"; pointerId: number; id: string; sx: number; sy: number; nx: number; ny: number; x: number; y: number; moved: boolean }
  | { kind: "connect"; pointerId: number; from: string; target: string | null; moved: boolean };

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

export class ChainCanvas {
  readonly el: HTMLElement;
  private readonly world: HTMLElement;
  private readonly gridEl: HTMLElement;
  private gridSize = 0;
  private settleTimer = 0;
  private readonly svg: SVGSVGElement;
  private readonly edgeLayer: SVGGElement;
  private readonly draft: SVGPathElement;
  private readonly nodeLayer: HTMLElement;
  private readonly removeBtn: HTMLButtonElement;
  private readonly actionBtn: HTMLButtonElement;
  private actionSig = "";
  private readonly nodeEls = new Map<string, HTMLElement>();
  private readonly painted = new WeakMap<HTMLElement, string>();
  private graph: ChainGraph = { nodes: [], edges: [] };
  private states: Record<string, NodeRunState> | null = null;
  private selection: Selection = null;
  /** A run is live: blocks outside it are dimmed. Editing stays open. */
  private live = false;
  /** The blocks of the live run. Blocks outside it keep showing their last result, dimmed. */
  private inRun: ReadonlySet<string> | null = null;
  private view: View = { x: 48, y: 48, zoom: 1 };
  private gesture: Gesture | null = null;
  private pendingFit = false;
  private animTimer = 0;

  constructor(private readonly hooks: CanvasHooks) {
    this.el = el(
      `<div class="chain-canvas" tabindex="0" aria-label="Chain canvas" aria-describedby="chainCanvasHelp">
         <div class="chain-grid" aria-hidden="true"></div>
         <div class="chain-world">
           <svg class="chain-edges" aria-hidden="true"><g></g><path class="chain-draft" d=""></path></svg>
           <div class="chain-nodes"></div>
           <button type="button" class="chain-edge-remove" aria-label="Remove arrow" title="Remove arrow (Delete)" hidden>${icon("dismiss")}</button>
           <button type="button" class="chain-block-action" hidden></button>
         </div>
         <p id="chainCanvasHelp" class="visually-hidden">Drag the background or scroll to pan. Hold Ctrl and scroll, or press Ctrl plus or minus, to zoom.
           Tab to a block and press Enter to select it, arrow keys to move it, and Delete to remove it.</p>
       </div>`
    );
    this.world = this.el.querySelector(".chain-world")!;
    this.gridEl = this.el.querySelector(".chain-grid")!;
    this.svg = this.el.querySelector("svg.chain-edges")!;
    this.edgeLayer = this.svg.querySelector("g")!;
    this.draft = this.svg.querySelector(".chain-draft")!;
    this.nodeLayer = this.el.querySelector(".chain-nodes")!;
    this.removeBtn = this.el.querySelector(".chain-edge-remove")!;
    this.actionBtn = this.el.querySelector(".chain-block-action")!;

    this.el.addEventListener("pointerdown", this.onPointerDown);
    this.el.addEventListener("pointermove", this.onPointerMove);
    this.el.addEventListener("pointerup", (e) => this.endGesture(e, true));
    this.el.addEventListener("pointercancel", (e) => this.endGesture(e, false));
    this.el.addEventListener("wheel", this.onWheel, { passive: false });
    this.el.addEventListener("keydown", this.onKey);
    this.el.addEventListener("dragover", this.onDragOver);
    this.el.addEventListener("dragleave", (e) => {
      if (!this.el.contains(e.relatedTarget as Node | null)) this.el.classList.remove("drop-target");
    });
    this.el.addEventListener("drop", this.onDrop);
    this.removeBtn.addEventListener("click", () => {
      if (this.selection?.kind === "edge") this.hooks.onRemove(this.selection);
    });
    this.actionBtn.addEventListener("click", () => {
      const sel = this.selection;
      const kind = this.actionBtn.dataset.kind as BlockAction["kind"] | undefined;
      if (sel?.kind === "node" && kind && this.actionBtn.getAttribute("aria-disabled") !== "true") this.hooks.onBlockAction(sel.id, kind);
    });
    const resize = new ResizeObserver(() => {
      if (!this.el.isConnected) return resize.disconnect();
      if (this.pendingFit && this.el.clientWidth > 0) this.fit(false);
    });
    resize.observe(this.el);
    this.applyView();
  }

  // ---- public API --------------------------------------------------------------------------

  setGraph(graph: ChainGraph): void {
    this.graph = { nodes: graph.nodes.map((n) => ({ ...n })), edges: graph.edges.map((e) => ({ ...e })) };
    const g = this.gesture;
    if (g?.kind === "node" && g.moved) {
      const n = this.graph.nodes.find((x) => x.id === g.id);
      if (n) Object.assign(n, { x: g.x, y: g.y });
    }
    if (this.selection && !this.selectionExists(this.selection)) this.selection = null;
    this.render();
  }

  setRun(states: Record<string, NodeRunState> | null, inRun: ReadonlySet<string> | null = null): void {
    this.states = states;
    this.inRun = inRun;
    this.render();
  }

  setSelection(sel: Selection): void {
    this.selection = sel && this.selectionExists(sel) ? sel : null;
    this.render();
  }

  setLive(live: boolean): void {
    if (this.live === live) return;
    this.live = live;
    this.render();
  }

  get zoom(): number {
    return this.view.zoom;
  }

  /** Frame every block (deferred until the canvas has a size). */
  fit(animate = true): void {
    const { clientWidth: w, clientHeight: h } = this.el;
    if (!w || !h) {
      this.pendingFit = true;
      return;
    }
    this.pendingFit = false;
    this.setView(fitTransform(this.graph.nodes, w, h, 56), animate);
  }

  /** Step through the zoom ladder around the viewport center; 0 resets to 100%. */
  zoomStep(direction: 1 | -1 | 0): void {
    const z = this.view.zoom;
    const next =
      direction === 0
        ? 1
        : direction > 0
          ? (ZOOM_STEPS.find((s) => s > z + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1])
          : ([...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? ZOOM_STEPS[0]);
    this.setView(zoomAt(this.view, next, this.el.clientWidth / 2, this.el.clientHeight / 2), true);
  }

  /** Pan just enough to bring a block fully into view. */
  reveal(id: string): void {
    const n = this.graph.nodes.find((x) => x.id === id);
    const { clientWidth: w, clientHeight: h } = this.el;
    if (!n || !w) return;
    const { x, y, zoom } = this.view;
    const m = 32;
    const left = n.x * zoom + x;
    const top = n.y * zoom + y;
    const right = left + NODE_W * zoom;
    const bottom = top + NODE_H * zoom;
    let dx = 0;
    let dy = 0;
    if (left < m) dx = m - left;
    else if (right > w - m) dx = Math.max(m - left, w - m - right);
    if (top < m) dy = m - top;
    else if (bottom > h - m) dy = Math.max(m - top, h - m - bottom);
    if (dx || dy) this.setView({ x: x + dx, y: y + dy, zoom }, true);
  }

  focusNode(id: string): void {
    this.nodeEls.get(id)?.focus({ preventScroll: true });
  }

  // ---- view ---------------------------------------------------------------------------------

  private setView(v: View, animate = false): void {
    this.view = { x: Math.round(v.x * 100) / 100, y: Math.round(v.y * 100) / 100, zoom: v.zoom };
    window.clearTimeout(this.animTimer);
    const smooth = animate && !reducedMotion.matches;
    this.el.classList.toggle("animating", smooth);
    if (smooth) this.animTimer = window.setTimeout(() => this.el.classList.remove("animating"), 260);
    this.applyView();
  }

  private applyView(): void {
    const { x, y, zoom } = this.view;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    // Promote the blocks while the view moves, then let them repaint sharp at the new zoom.
    this.world.classList.add("moving");
    window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => this.world.classList.remove("moving"), 200);
    let grid = GRID * 2 * zoom;
    while (grid < 10) grid *= 4;
    // The grid repeats every major step (five dots), so sliding it by the offset within one step
    // draws the same plot as painting it at the full offset. --grid only changes with the zoom.
    if (grid !== this.gridSize) {
      this.gridSize = grid;
      this.gridEl.style.setProperty("--grid", `${grid}px`);
    }
    const major = grid * 5;
    const within = (v: number): number => ((v % major) + major) % major;
    this.gridEl.style.transform = `translate(${within(x)}px, ${within(y)}px)`;
    this.hooks.onView(this.view);
  }

  private clientToWorld(cx: number, cy: number): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: (cx - r.left - this.view.x) / this.view.zoom, y: (cy - r.top - this.view.y) / this.view.zoom };
  }

  // ---- rendering ----------------------------------------------------------------------------

  private selectionExists(sel: NonNullable<Selection>): boolean {
    if (sel.kind === "node") return this.graph.nodes.some((n) => n.id === sel.id);
    return this.graph.edges.some((e) => e.from === sel.from && e.to === sel.to);
  }

  private render(): void {
    this.renderNodes();
    this.renderEdges();
    this.renderAction();
  }

  private renderNodes(): void {
    const keep = new Set<string>();
    for (const n of this.graph.nodes) {
      keep.add(n.id);
      let node = this.nodeEls.get(n.id);
      if (!node) {
        node = document.createElement("div");
        node.className = "chain-node";
        node.tabIndex = 0;
        node.setAttribute("role", "button");
        node.dataset.id = n.id;
        this.nodeLayer.appendChild(node);
        this.nodeEls.set(n.id, node);
      }
      this.paintNode(node, n);
    }
    for (const [id, node] of this.nodeEls) {
      if (keep.has(id)) continue;
      node.remove();
      this.nodeEls.delete(id);
    }
  }

  private paintNode(node: HTMLElement, n: ChainNode): void {
    const st = this.states?.[n.id];
    const out = this.isOutOfRun(n.id);
    const tone = st ? statusTone(st.status) : "";
    const selected = this.selection?.kind === "node" && this.selection.id === n.id;
    const g = this.gesture;
    const stopping = !!st?.stopRequested && ACTIVE.has(st.status);
    node.style.left = `${n.x}px`;
    node.style.top = `${n.y}px`;
    node.classList.toggle("selected", selected);
    node.classList.toggle("dragging", g?.kind === "node" && g.moved && g.id === n.id);
    node.classList.toggle("is-out", out);
    for (const t of ["ok", "warn", "bad", "run", "off", "idle"]) node.classList.toggle(`tone-${t}`, t === tone);
    node.setAttribute("aria-pressed", String(selected));
    const path = n.path && n.path !== "\\" ? n.path.replace(/^\\/, "") : "";
    const elapsed = st ? nodeElapsed(st, Date.now()) : null;
    const paramCount = n.params ? Object.keys(n.params).length : 0;
    const repoCount = n.repoBranches ? Object.keys(n.repoBranches).length : 0;
    const label = st ? (stopping ? "Stopping…" : statusLabel(st.status)) : "";
    const status = st
      ? `<span class="chain-node-status">${ACTIVE.has(st.status) ? '<span class="spinner"></span>' : '<span class="chain-dot"></span>'}` +
        `${esc(label)}${elapsed != null && st.status !== "waiting" && st.status !== "skipped" ? ` · ${formatElapsed(elapsed)}` : ""}</span>`
      : "";
    node.setAttribute(
      "aria-label",
      `${n.name}, ${n.project}${st ? `, ${label}` : ""}${out ? ", not part of this run" : ""}, ${nodeBranchLabel(n)}${paramCount ? `, ${paramCount} ${paramCount === 1 ? "parameter" : "parameters"} set` : ""}${repoCount ? `, ${repoCount} ${repoCount === 1 ? "repository branch" : "repository branches"} set` : ""}`
    );
    const html =
      `<span class="chain-node-bar" aria-hidden="true"></span>` +
      `<span class="chain-node-head"><span class="chain-node-icon">${icon("pipeline")}</span>` +
      `<span class="chain-node-name" title="${esc(n.name)}">${esc(n.name)}</span></span>` +
      `<span class="chain-node-meta" title="${esc(`${n.org} / ${n.project}${path ? ` · ${path}` : ""}`)}">${esc(n.project)}${path ? ` · ${esc(path)}` : ""}</span>` +
      `<span class="chain-node-foot"><span class="chain-node-branch">${icon("branch")}<span>${esc(nodeBranchLabel(n))}</span></span>` +
      `${paramCount ? `<span class="chain-node-params" title="${paramCount} ${paramCount === 1 ? "parameter" : "parameters"} set">${icon("settings")}${paramCount}</span>` : ""}` +
      `${repoCount ? `<span class="chain-node-params" title="${esc(Object.entries(n.repoBranches!).map(([a, b]) => `${a} on ${b}`).join(", "))}">${icon("folder")}${repoCount}</span>` : ""}${status}</span>` +
      `<span class="chain-port" data-port="out" title="Drag onto the pipeline that runs next" aria-hidden="true"></span>`;
    if (this.painted.get(node) !== html) {
      node.innerHTML = html;
      this.painted.set(node, html);
    }
  }

  private isOutOfRun(id: string): boolean {
    return this.live && !!this.inRun && !this.inRun.has(id);
  }

  private edgeTone(e: ChainEdge): string {
    if (!this.states) return "";
    const from = this.states[e.from]?.status || "";
    const to = this.states[e.to]?.status || "";
    if (to === "skipped") return "is-off";
    // An earlier result of a block outside the live run doesn't feed the blocks inside it.
    if (PASSED.has(from) && ACTIVE.has(to) && !this.isOutOfRun(e.from)) return "is-flowing";
    if (PASSED.has(from)) return "is-done";
    return "";
  }

  private renderEdges(): void {
    const pos = new Map(this.graph.nodes.map((n) => [n.id, n]));
    const sel = this.selection;
    const parts: string[] = [];
    for (const e of this.graph.edges) {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) continue;
      const d = edgePath(a, b);
      const tx = b.x;
      const ty = b.y + NODE_H / 2;
      const selected = sel?.kind === "edge" && sel.from === e.from && sel.to === e.to;
      parts.push(
        `<g class="chain-edge${selected ? " selected" : ""} ${this.edgeTone(e)}" data-from="${esc(e.from)}" data-to="${esc(e.to)}">` +
          `<path class="chain-edge-hit" d="${d}"></path><path class="chain-edge-line" d="${d}"></path>` +
          `<path class="chain-edge-head" d="M ${tx - 9} ${ty - 5} L ${tx} ${ty} L ${tx - 9} ${ty + 5} Z"></path></g>`
      );
    }
    this.edgeLayer.innerHTML = parts.join("");
    this.sizeSvg();
    if (sel?.kind === "edge") {
      const a = pos.get(sel.from)!;
      const b = pos.get(sel.to)!;
      this.removeBtn.style.left = `${(a.x + NODE_W + b.x) / 2}px`;
      this.removeBtn.style.top = `${(a.y + b.y + NODE_H) / 2}px`;
      this.removeBtn.hidden = false;
    } else {
      this.removeBtn.hidden = true;
    }
  }

  // The selected block's run/stop pill floats just above its top-right corner.
  private renderAction(): void {
    const sel = this.selection;
    const n = sel?.kind === "node" ? this.graph.nodes.find((x) => x.id === sel.id) : undefined;
    const action = n && this.gesture?.kind !== "connect" ? this.hooks.blockAction(n.id) : null;
    if (!n || !action) {
      this.actionBtn.hidden = true;
      this.actionSig = "";
      return;
    }
    this.actionBtn.style.left = `${n.x + NODE_W}px`;
    this.actionBtn.style.top = `${n.y}px`;
    this.actionBtn.hidden = false;
    const sig = [action.kind, action.label, action.title, action.disabled].join("\u0001");
    if (sig === this.actionSig) return;
    this.actionSig = sig;
    this.actionBtn.dataset.kind = action.kind;
    this.actionBtn.className = `chain-block-action is-${action.kind}`;
    this.actionBtn.title = action.title;
    this.actionBtn.setAttribute("aria-label", `${action.label}: ${n.name}`);
    this.actionBtn.setAttribute("aria-disabled", String(action.disabled));
    this.actionBtn.innerHTML = `${icon(action.kind === "run" ? "play" : "stop")}<span>${esc(action.label)}</span>`;
  }

  // The SVG covers the blocks plus a margin (and the draft arrow's tip) so arrows stay
  // hit-testable without an unbounded layer.
  private sizeSvg(extra?: { x: number; y: number }): void {
    const pts: { x: number; y: number }[] = this.graph.nodes.length ? [...this.graph.nodes] : [{ x: 0, y: 0 }];
    if (extra) pts.push(extra);
    const b = bounds(pts);
    const x = Math.floor(b.minX - SVG_MARGIN);
    const y = Math.floor(b.minY - SVG_MARGIN);
    const w = Math.ceil(b.maxX - b.minX + SVG_MARGIN * 2);
    const h = Math.ceil(b.maxY - b.minY + SVG_MARGIN * 2);
    this.svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
    this.svg.setAttribute("width", String(w));
    this.svg.setAttribute("height", String(h));
    this.svg.style.left = `${x}px`;
    this.svg.style.top = `${y}px`;
  }

  // ---- interaction --------------------------------------------------------------------------

  private select(sel: Selection): void {
    const same = JSON.stringify(sel) === JSON.stringify(this.selection);
    this.selection = sel;
    this.render();
    if (!same) this.hooks.onSelect(sel);
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (this.gesture) return;
    const t = e.target as Element;
    const startPan = (): void => {
      this.gesture = { kind: "pan", pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y, moved: false };
      this.el.setPointerCapture(e.pointerId);
      this.el.focus({ preventScroll: true });
      e.preventDefault();
    };
    if (e.button === 1) return startPan();
    if (e.button !== 0 || t.closest(".chain-edge-remove, .chain-block-action")) return;
    const nodeEl = t.closest<HTMLElement>(".chain-node");
    const id = nodeEl?.dataset.id;
    if (id && t.closest(".chain-port")) {
      this.gesture = { kind: "connect", pointerId: e.pointerId, from: id, target: null, moved: false };
      this.el.setPointerCapture(e.pointerId);
      this.el.classList.add("connecting");
      nodeEl!.classList.add("connect-source");
      e.preventDefault();
      return;
    }
    if (id) {
      const n = this.graph.nodes.find((x) => x.id === id)!;
      this.gesture = { kind: "node", pointerId: e.pointerId, id, sx: e.clientX, sy: e.clientY, nx: n.x, ny: n.y, x: n.x, y: n.y, moved: false };
      this.el.setPointerCapture(e.pointerId);
      nodeEl!.focus({ preventScroll: true });
      this.select({ kind: "node", id });
      e.preventDefault();
      return;
    }
    const edge = t.closest<SVGGElement>(".chain-edge");
    if (edge) {
      this.el.focus({ preventScroll: true });
      this.select({ kind: "edge", from: edge.dataset.from!, to: edge.dataset.to! });
      e.preventDefault();
      return;
    }
    startPan();
  };

  private onPointerMove = (e: PointerEvent): void => {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    if (g.kind === "pan") {
      const dx = e.clientX - g.sx;
      const dy = e.clientY - g.sy;
      if (!g.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
      if (!g.moved) this.el.classList.add("panning");
      g.moved = true;
      this.setView({ x: g.vx + dx, y: g.vy + dy, zoom: this.view.zoom });
      return;
    }
    if (g.kind === "node") {
      const dx = e.clientX - g.sx;
      const dy = e.clientY - g.sy;
      if (!g.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
      g.moved = true;
      g.x = snap(g.nx + dx / this.view.zoom);
      g.y = snap(g.ny + dy / this.view.zoom);
      const n = this.graph.nodes.find((x) => x.id === g.id);
      if (!n) return;
      n.x = g.x;
      n.y = g.y;
      this.render();
      return;
    }
    g.moved = true;
    const from = this.graph.nodes.find((x) => x.id === g.from);
    if (!from) return;
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".chain-node");
    const target = hit && this.el.contains(hit) && hit.dataset.id !== g.from ? hit.dataset.id! : null;
    if (target !== g.target) {
      for (const node of this.nodeEls.values()) node.classList.remove("drop-ok", "drop-bad");
      g.target = target;
      if (target) this.nodeEls.get(target)?.classList.add(canConnect(this.graph, g.from, target).ok ? "drop-ok" : "drop-bad");
    }
    const to = target ? this.graph.nodes.find((x) => x.id === target)! : null;
    const tip = to ? { x: to.x, y: to.y + NODE_H / 2 } : this.clientToWorld(e.clientX, e.clientY);
    this.draft.setAttribute("d", edgePath(from, { x: tip.x, y: tip.y - NODE_H / 2 }));
    this.sizeSvg(tip);
  };

  private endGesture(e: PointerEvent, commit: boolean): void {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    this.gesture = null;
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
    this.el.classList.remove("panning", "connecting");
    if (g.kind === "pan") {
      if (!g.moved && commit) this.select(null);
      return;
    }
    if (g.kind === "node") {
      this.nodeEls.get(g.id)?.classList.remove("dragging");
      if (g.moved && (g.x !== g.nx || g.y !== g.ny)) this.hooks.onMove(g.id, g.x, g.y);
      return;
    }
    this.draft.setAttribute("d", "");
    for (const node of this.nodeEls.values()) node.classList.remove("drop-ok", "drop-bad", "connect-source");
    this.sizeSvg();
    if (!commit || !g.target) return;
    const verdict = canConnect(this.graph, g.from, g.target);
    if (verdict.ok) this.hooks.onConnect(g.from, g.target);
    else this.hooks.onReject(verdict.reason || "Those blocks cannot be connected");
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      this.setView(zoomAt(this.view, this.view.zoom * factor, e.clientX - r.left, e.clientY - r.top));
      return;
    }
    const k = e.deltaMode === 1 ? 16 : 1;
    let dx = e.deltaX * k;
    let dy = e.deltaY * k;
    if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
    this.setView({ x: this.view.x - dx, y: this.view.y - dy, zoom: this.view.zoom });
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const nodeEl = (e.target as Element).closest?.<HTMLElement>(".chain-node");
    const sel = this.selection;
    if ((e.key === "Delete" || e.key === "Backspace") && sel) {
      e.preventDefault();
      this.hooks.onRemove(sel);
      return;
    }
    if (e.key === "Escape" && sel) {
      e.preventDefault();
      this.select(null);
      this.el.focus({ preventScroll: true });
      return;
    }
    if ((e.key === "Enter" || e.key === " ") && nodeEl) {
      e.preventDefault();
      this.select({ kind: "node", id: nodeEl.dataset.id! });
      return;
    }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const dir = arrows[e.key];
    if (!dir) return;
    e.preventDefault();
    if (nodeEl && sel?.kind === "node" && sel.id === nodeEl.dataset.id) {
      const n = this.graph.nodes.find((x) => x.id === sel.id)!;
      const step = GRID * (e.shiftKey ? 4 : 1);
      this.hooks.onMove(n.id, n.x + dir[0] * step, n.y + dir[1] * step);
      requestAnimationFrame(() => this.reveal(n.id));
      return;
    }
    if (!nodeEl) this.setView({ x: this.view.x - dir[0] * 48, y: this.view.y - dir[1] * 48, zoom: this.view.zoom }, true);
  };

  private onDragOver = (e: DragEvent): void => {
    if (!e.dataTransfer?.types.includes(PIPELINE_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    this.el.classList.add("drop-target");
  };

  private onDrop = (e: DragEvent): void => {
    this.el.classList.remove("drop-target");
    const payload = e.dataTransfer?.getData(PIPELINE_MIME);
    if (!payload) return;
    e.preventDefault();
    const w = this.clientToWorld(e.clientX, e.clientY);
    this.hooks.onDrop(payload, { x: w.x - NODE_W / 2, y: w.y - NODE_H / 2 });
  };
}
