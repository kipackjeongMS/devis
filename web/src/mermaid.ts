// Mermaid diagram rendering (vendored @10.9.3 UMD, loaded offline via index.html).
import { esc } from "./util.js";

// The vendored UMD bundle attaches a global `mermaid`.
declare global {
  interface Window {
    mermaid?: any;
  }
}

let _mermaidReady = false;
export function initMermaid(): void {
  if (_mermaidReady || !window.mermaid) return;
  try {
    window.mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
    _mermaidReady = true;
  } catch (_) {
    /* ignore */
  }
}

let _mermaidSeq = 0;

const MIN_SCALE = 0.1;
const MAX_SCALE = 4;
const ZOOM_LEVELS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const WHEEL_ZOOM_RATE = 0.0015;
const FRAME_PAD = 12;
const FRAME_MIN_HEIGHT = 200;
const FRAME_MAX_HEIGHT = 640;
const KEEP_VISIBLE = 48;

export function fitDiagramScale(
  contentWidth: number,
  contentHeight: number,
  viewportWidth: number,
  viewportHeight: number
): number {
  if (
    !Number.isFinite(contentWidth) ||
    !Number.isFinite(contentHeight) ||
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    contentWidth <= 0 ||
    contentHeight <= 0 ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    return 1;
  }
  return Math.min(1, viewportWidth / contentWidth, viewportHeight / contentHeight);
}

export const PAN_DRAG_THRESHOLD = 3;
const KEY_PAN_STEP = 40;

type Point = { x: number; y: number };
type Size = { width: number; height: number };
// Where the diagram's top-left corner sits inside the fixed frame, and its zoom.
export type DiagramView = { x: number; y: number; scale: number };

export function panView(start: DiagramView, from: Point, to: Point): DiagramView {
  return { x: start.x + (to.x - from.x), y: start.y + (to.y - from.y), scale: start.scale };
}

// Keeps the diagram point under `anchor` (frame-relative) fixed while the scale changes.
export function zoomViewAt(view: DiagramView, anchor: Point, scale: number): DiagramView {
  const ratio = scale / view.scale;
  return {
    x: anchor.x - (anchor.x - view.x) * ratio,
    y: anchor.y - (anchor.y - view.y) * ratio,
    scale,
  };
}

// Panning is free, but at least `keep` pixels of the diagram (or all of a tiny one) stay in the frame.
export function clampView(view: DiagramView, content: Size, frame: Size, keep = KEEP_VISIBLE): DiagramView {
  const width = content.width * view.scale;
  const height = content.height * view.scale;
  const keepX = Math.min(keep, width);
  const keepY = Math.min(keep, height);
  return {
    x: Math.min(frame.width - keepX, Math.max(keepX - width, view.x)),
    y: Math.min(frame.height - keepY, Math.max(keepY - height, view.y)),
    scale: view.scale,
  };
}

export function fitView(content: Size, frame: Size, pad = FRAME_PAD): DiagramView {
  const scale = fitDiagramScale(content.width, content.height, frame.width - 2 * pad, frame.height - 2 * pad);
  return {
    x: (frame.width - content.width * scale) / 2,
    y: (frame.height - content.height * scale) / 2,
    scale,
  };
}

// Steps to the next familiar zoom level, skipping levels within 5% of the current scale.
export function nextZoomLevel(scale: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_LEVELS.find((level) => level > scale * 1.05) ?? MAX_SCALE;
  return [...ZOOM_LEVELS].reverse().find((level) => level < scale / 1.05) ?? MIN_SCALE;
}

// The frame height is chosen once, from the diagram fitted to the frame width; zooming never changes it.
export function diagramFrameHeight(content: Size, frameWidth: number, pad: number, min: number, max: number): number {
  const scale = frameWidth > 0 ? fitDiagramScale(content.width, content.height, frameWidth - 2 * pad, Number.MAX_VALUE) : 1;
  return Math.round(Math.min(max, Math.max(min, content.height * scale + 2 * pad)));
}

function svgSize(svg: SVGSVGElement): Size {
  const viewBox = svg.viewBox?.baseVal;
  if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
    return { width: viewBox.width, height: viewBox.height };
  }
  const width = Number.parseFloat(svg.getAttribute("width") || "");
  const height = Number.parseFloat(svg.getAttribute("height") || "");
  if (width > 0 && height > 0) return { width, height };
  const rect = svg.getBoundingClientRect();
  const zoom = svg.currentCSSZoom || 1;
  return { width: rect.width / zoom || 1, height: rect.height / zoom || 1 };
}

function diagramButton(label: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mmd-control";
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  return button;
}

function addDiagramControls(node: HTMLElement, svg: SVGSVGElement): void {
  node.classList.add("adjustable");
  const size = svgSize(svg);
  const toolbar = document.createElement("div");
  toolbar.className = "mmd-toolbar";
  const hint = document.createElement("span");
  hint.className = "mmd-hint";
  hint.textContent = "Drag to pan · Ctrl+scroll to zoom";
  const fitButton = diagramButton("Fit", "Fit the entire diagram in the frame");
  const zoomOutButton = diagramButton("−", "Zoom out");
  const scaleButton = diagramButton("100%", "Reset zoom to 100%");
  scaleButton.classList.add("mmd-scale");
  const zoomInButton = diagramButton("+", "Zoom in");
  const status = document.createElement("span");
  status.className = "visually-hidden";
  status.setAttribute("aria-live", "polite");
  toolbar.append(hint, fitButton, zoomOutButton, scaleButton, zoomInButton, status);

  const viewport = document.createElement("div");
  viewport.className = "mmd-viewport";
  viewport.tabIndex = 0;
  viewport.setAttribute("role", "group");
  viewport.setAttribute("aria-label", "Diagram. Drag or use arrow keys to pan; use plus, minus, or 0 to zoom.");
  const stage = document.createElement("div");
  stage.className = "mmd-stage";
  svg.replaceWith(viewport);
  stage.appendChild(svg);
  viewport.appendChild(stage);
  node.prepend(toolbar);
  svg.style.width = `${size.width}px`;
  svg.style.height = `${size.height}px`;
  svg.style.maxWidth = "none";

  let view: DiagramView = { x: 0, y: 0, scale: 1 };
  let fitScale = 1;
  let fitted = true; // Refit on resize until the user pans or zooms.
  let frameLocked = false;
  const frame = (): Size => ({ width: viewport.clientWidth, height: viewport.clientHeight });
  const center = (): Point => ({ x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 });
  const minScale = (): number => Math.min(MIN_SCALE, fitScale);
  // Client px are visual; the stage lives in its ancestors' CSS-zoomed px (the task sheet reads at 1.125).
  const paneZoom = (): number => viewport.currentCSSZoom || 1;

  const render = (next: DiagramView, animate = false): void => {
    const box = frame();
    view = box.width > 0 && box.height > 0 ? clampView(next, size, box) : next;
    stage.classList.toggle("easing", animate);
    stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    const percent = `${Math.round(view.scale * 100)}%`;
    if (scaleButton.textContent !== percent) {
      scaleButton.textContent = percent;
      scaleButton.setAttribute("aria-label", `Zoom ${percent}. Reset to 100%`);
      status.textContent = `Zoom ${percent}`;
    }
    zoomOutButton.disabled = view.scale <= minScale() + 1e-6;
    zoomInButton.disabled = view.scale >= MAX_SCALE - 1e-6;
  };
  const zoomTo = (scale: number, anchor: Point = center(), animate = false): void => {
    const next = Math.min(MAX_SCALE, Math.max(minScale(), scale));
    if (next === view.scale) return;
    fitted = false;
    render(zoomViewAt(view, anchor, next), animate);
  };
  const step = (direction: 1 | -1): void => {
    const next = nextZoomLevel(view.scale, direction);
    if (direction > 0 ? next > view.scale : next < view.scale) zoomTo(next, center(), true);
  };
  const fit = (animate = false): void => {
    const box = frame();
    if (box.width <= 0 || box.height <= 0) return;
    const target = fitView(size, box);
    fitScale = target.scale;
    fitted = true;
    render(target, animate);
  };
  const lockFrame = (): boolean => {
    if (frameLocked) return true;
    const width = viewport.clientWidth;
    if (width <= 0) return false;
    frameLocked = true;
    const max = Math.min(FRAME_MAX_HEIGHT, (window.innerHeight * 0.65) / paneZoom());
    viewport.style.height = `${diagramFrameHeight(size, width, FRAME_PAD, FRAME_MIN_HEIGHT, max)}px`;
    return true;
  };

  let drag: { id: number; from: Point; start: DiagramView; moved: boolean } | null = null;
  const pointer = (event: MouseEvent): Point => ({ x: event.clientX / paneZoom(), y: event.clientY / paneZoom() });
  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.pointerType === "touch") return;
    drag = { id: event.pointerId, from: pointer(event), start: view, moved: false };
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const to = pointer(event);
    if (!drag.moved) {
      if (Math.hypot(to.x - drag.from.x, to.y - drag.from.y) < PAN_DRAG_THRESHOLD) return;
      drag.moved = true;
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add("panning");
      window.getSelection()?.removeAllRanges();
    }
    fitted = false;
    render(panView(drag.start, drag.from, to));
    event.preventDefault();
  });
  const endDrag = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.id) return;
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    viewport.classList.remove("panning");
    drag = null;
  };
  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);

  // Plain wheel keeps scrolling the page; Ctrl/⌘+wheel (and trackpad pinch) zooms at the cursor.
  viewport.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      const rect = viewport.getBoundingClientRect();
      const zoom = paneZoom();
      zoomTo(view.scale * Math.exp(-event.deltaY * unit * WHEEL_ZOOM_RATE), {
        x: (event.clientX - rect.left) / zoom - viewport.clientLeft,
        y: (event.clientY - rect.top) / zoom - viewport.clientTop,
      });
    },
    { passive: false }
  );

  viewport.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-KEY_PAN_STEP, 0],
      ArrowRight: [KEY_PAN_STEP, 0],
      ArrowUp: [0, -KEY_PAN_STEP],
      ArrowDown: [0, KEY_PAN_STEP],
    };
    const pan = delta[event.key];
    if (pan) {
      fitted = false;
      render({ x: view.x - pan[0], y: view.y - pan[1], scale: view.scale });
    } else if (event.key === "+" || event.key === "=") step(1);
    else if (event.key === "-" || event.key === "_") step(-1);
    else if (event.key === "0") zoomTo(1, center(), true);
    else return;
    event.preventDefault();
  });

  fitButton.addEventListener("click", () => fit(true));
  scaleButton.addEventListener("click", () => zoomTo(1, center(), true));
  zoomOutButton.addEventListener("click", () => step(-1));
  zoomInButton.addEventListener("click", () => step(1));

  render(view);
  if (lockFrame()) fit();
  // Panels can mount collapsed (zero width) and the window can resize; refit until the user takes over.
  const observer = new ResizeObserver(() => {
    if (!viewport.isConnected) {
      observer.disconnect();
      return;
    }
    if (!frameLocked) {
      // Defer the height change so it doesn't trigger a ResizeObserver loop.
      window.requestAnimationFrame(() => {
        if (lockFrame()) fit();
      });
    } else if (fitted) fit();
    else render(view);
  });
  observer.observe(viewport);
}

// Renders every un-rendered .mermaid container inside `container`. Idempotent:
// the data-mermaid flag is cleared once drawn, so it is safe to re-run on poll refresh.
export async function renderMermaid(container: HTMLElement | null, adjustable = false): Promise<void> {
  if (!container || !window.mermaid) return;
  initMermaid();
  const nodes = container.querySelectorAll<HTMLElement>(".mermaid[data-mermaid]");
  for (const node of nodes) {
    const src = node.textContent || "";
    node.removeAttribute("data-mermaid");
    if (!src || !src.trim()) continue;
    const id = "mmd-" + ++_mermaidSeq;
    try {
      const { svg } = await window.mermaid.render(id, src);
      // A repaint may have replaced this node while it rendered; drawing into it would only hold the old tree.
      if (!node.isConnected) continue;
      node.innerHTML = svg;
      const renderedSvg = node.querySelector<SVGSVGElement>("svg");
      if (renderedSvg && adjustable) addDiagramControls(node, renderedSvg);
      node.classList.add("rendered");
    } catch (_) {
      if (!node.isConnected) continue;
      node.classList.add("mmd-error");
      node.innerHTML =
        '<div class="mmd-err">⚠ Diagram failed to render</div><pre class="md-pre"><code>' +
        esc(src) +
        "</code></pre>";
    } finally {
      // Mermaid renders in a scratch element under <body>; a failed render can leave it behind.
      document.getElementById("d" + id)?.remove();
    }
  }
}
