// Lightweight markdown -> HTML (escape-first, safe subset).
// A ```mermaid fence becomes a diagram container that mermaid.ts renders later.
import { esc } from "./util.js";

/** Inline markdown: code, bold, italic, and http(s) links (escape-first, XSS-safe). */
export function mdInline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>")
    .replace(/\b_([^_\s][^_]*?)_\b/g, "<em>$1</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`
    );
}

/** Block markdown: headings, hr, blockquote, lists, fenced code, and paragraphs. */
export function renderMarkdown(src: unknown): string {
  const lines = String(src == null ? "" : src)
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  let quote: string[] = [];
  let fence: string[] | null = null;
  let fenceLang: string | null = null;
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.join("<br>")}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const closeQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${quote.join("<br>")}</blockquote>`);
      quote = [];
    }
  };
  const closeBlocks = () => {
    flushPara();
    closeList();
    closeQuote();
  };
  const emitFence = () => {
    if (fence == null) return;
    const code = fence.join("\n");
    // ```mermaid fences become diagram containers rendered later by renderMermaid().
    // Source is HTML-escaped here; textContent reads it back unescaped for mermaid (XSS-safe).
    if (fenceLang === "mermaid") out.push(`<div class="mermaid" data-mermaid="1">${esc(code)}</div>`);
    else out.push(`<pre class="md-pre"><code>${esc(code)}</code></pre>`);
    fence = null;
    fenceLang = null;
  };
  for (const raw of lines) {
    // fenced code block
    const fenceHit = raw.match(/^\s*```(.*)$/);
    if (fence != null) {
      if (fenceHit) emitFence();
      else fence.push(raw);
      continue;
    }
    if (fenceHit) {
      closeBlocks();
      fence = [];
      fenceLang = (fenceHit[1] || "").trim().toLowerCase();
      continue;
    }

    if (!raw.trim()) {
      closeBlocks();
      continue;
    }

    let m: RegExpMatchArray | null;
    if ((m = raw.match(/^(#{1,6})\s+(.*)$/))) {
      closeBlocks();
      const n = Math.min(6, m[1].length);
      out.push(`<h${n}>${mdInline(m[2])}</h${n}>`);
    } else if (/^\s*(?:---|\*\*\*|___)\s*$/.test(raw)) {
      closeBlocks();
      out.push("<hr>");
    } else if ((m = raw.match(/^>\s?(.*)$/))) {
      flushPara();
      closeList();
      quote.push(mdInline(m[1]));
    } else if ((m = raw.match(/^\s*[-*+]\s+(.*)$/))) {
      flushPara();
      closeQuote();
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${mdInline(m[1])}</li>`);
    } else if ((m = raw.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      closeQuote();
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${mdInline(m[1])}</li>`);
    } else {
      closeList();
      closeQuote();
      para.push(mdInline(raw));
    }
  }
  if (fence != null) emitFence();
  closeBlocks();
  return out.join("\n");
}
