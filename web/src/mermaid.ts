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

const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;
const SCALE_STEP = 0.25;

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

function svgSize(svg: SVGSVGElement): { width: number; height: number } {
  const viewBox = svg.viewBox?.baseVal;
  if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
    return { width: viewBox.width, height: viewBox.height };
  }
  const width = Number.parseFloat(svg.getAttribute("width") || "");
  const height = Number.parseFloat(svg.getAttribute("height") || "");
  if (width > 0 && height > 0) return { width, height };
  const rect = svg.getBoundingClientRect();
  return { width: rect.width || 1, height: rect.height || 1 };
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
  const fitButton = diagramButton("Fit", "Fit the entire diagram in the pane");
  const actualButton = diagramButton("100%", "Show the diagram at its natural size");
  const zoomOutButton = diagramButton("−", "Zoom out");
  const zoomInButton = diagramButton("+", "Zoom in");
  const scaleLabel = document.createElement("span");
  scaleLabel.className = "mmd-scale";
  scaleLabel.setAttribute("aria-live", "polite");
  toolbar.append(fitButton, actualButton, zoomOutButton, zoomInButton, scaleLabel);

  const viewport = document.createElement("div");
  viewport.className = "mmd-viewport";
  svg.replaceWith(viewport);
  viewport.appendChild(svg);
  node.prepend(toolbar);

  let scale = 1;
  const setScale = (next: number, fitMode = false): void => {
    scale = Math.min(MAX_SCALE, Math.max(fitMode ? Number.EPSILON : MIN_SCALE, next));
    svg.style.width = `${Math.max(1, Math.round(size.width * scale))}px`;
    svg.style.height = `${Math.max(1, Math.round(size.height * scale))}px`;
    svg.style.maxWidth = "none";
    scaleLabel.textContent = `${Math.round(scale * 100)}%`;
    zoomOutButton.disabled = scale <= MIN_SCALE;
    zoomInButton.disabled = scale >= MAX_SCALE;
  };
  const fit = (): void => {
    const styles = window.getComputedStyle(viewport);
    const horizontalPadding = Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight);
    const verticalPadding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
    const availableWidth = viewport.clientWidth - horizontalPadding;
    const availableHeight = Math.min(640, window.innerHeight * 0.65) - verticalPadding;
    setScale(fitDiagramScale(size.width, size.height, availableWidth, availableHeight), true);
  };

  fitButton.addEventListener("click", fit);
  actualButton.addEventListener("click", () => setScale(1));
  zoomOutButton.addEventListener("click", () => setScale(scale - SCALE_STEP));
  zoomInButton.addEventListener("click", () => setScale(scale + SCALE_STEP));
  setScale(1);
  window.requestAnimationFrame(fit);
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
    try {
      const { svg } = await window.mermaid.render("mmd-" + ++_mermaidSeq, src);
      node.innerHTML = svg;
      const renderedSvg = node.querySelector<SVGSVGElement>("svg");
      if (renderedSvg && adjustable) addDiagramControls(node, renderedSvg);
      node.classList.add("rendered");
    } catch (_) {
      node.classList.add("mmd-error");
      node.innerHTML =
        '<div class="mmd-err">⚠ Diagram failed to render</div><pre class="md-pre"><code>' +
        esc(src) +
        "</code></pre>";
    }
  }
}
