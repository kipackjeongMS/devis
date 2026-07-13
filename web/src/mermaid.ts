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
// Renders every un-rendered .mermaid container inside `container`. Idempotent:
// the data-mermaid flag is cleared once drawn, so it is safe to re-run on poll refresh.
export async function renderMermaid(container: HTMLElement | null): Promise<void> {
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
