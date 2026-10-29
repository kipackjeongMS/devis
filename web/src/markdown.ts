// Markdown -> HTML for PR descriptions, comments, review findings, and chat.
//
// Escape-first and allowlist-only: every tag in the output is constructed here.
// Raw HTML in the source survives only as rebuilt allowlisted tags with vetted
// attributes, so event handlers, inline styles, and non-http(s) URLs never get
// through. Covers CommonMark blocks (ATX/setext headings, rules, quotes, nested
// lists, fences), GFM tables, task lists and strikethrough, HTML comments
// (stripped), inline HTML, bare URLs, emoji shortcodes, and `#1234` work items.
// A ```mermaid fence becomes a diagram container that mermaid.ts renders later.
import { esc } from "./util.js";
import { sanitizeHtml } from "./sanitizeHtml.js";

export interface MarkdownOptions {
  /** Builds the link for `#1234` work item references. Omit to leave them as text. */
  workItemUrl?: (id: string) => string;
}

interface Ctx {
  opts: MarkdownOptions;
}

const SAFE_URL_RE = /^(?:https?:|mailto:)/i;
const LINK_ATTRS = `target="_blank" rel="noopener noreferrer"`;

// ---------------------------------------------------------------- inline

/** Placeholders keep finished HTML out of reach of later inline passes. */
class Stash {
  private items: string[] = [];
  keep(html: string): string {
    this.items.push(html);
    return `\u0000${this.items.length - 1}\u0001`;
  }
  restore(s: string): string {
    for (let pass = 0; pass < 16 && s.includes("\u0000"); pass++) {
      s = s.replace(/\u0000(\d+)\u0001/g, (_, i: string) => this.items[Number(i)] ?? "");
    }
    return s;
  }
}

const HTML_TAGS = new Set([
  "a", "abbr", "b", "blockquote", "br", "code", "del", "details", "div", "em",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark",
  "ol", "p", "pre", "s", "small", "span", "strike", "strong", "sub", "summary",
  "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
]);
const VOID_TAGS = new Set(["br", "hr", "img"]);
type AttrKind = "text" | "url" | "num" | "bool";
const TAG_ATTRS: Record<string, Record<string, AttrKind>> = {
  a: { href: "url", title: "text" },
  abbr: { title: "text" },
  img: { src: "url", alt: "text", title: "text", width: "num", height: "num" },
  td: { colspan: "num", rowspan: "num" },
  th: { colspan: "num", rowspan: "num" },
  ol: { start: "num" },
  details: { open: "bool" },
};
const TAG_RE =
  /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z_:][-\w:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTR_RE = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
};

function decodeEntities(v: string): string {
  return v.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]+);/g, (all, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? all;
  });
}

/** Rebuild an allowlisted raw HTML tag, keeping only vetted attributes. */
function rebuildTag(closing: string, rawName: string, rawAttrs: string): string {
  const name = rawName.toLowerCase();
  if (closing) return VOID_TAGS.has(name) ? "" : `</${name}>`;
  const spec = TAG_ATTRS[name] || {};
  const seen = new Set<string>();
  let attrs = "";
  for (const m of rawAttrs.matchAll(ATTR_RE)) {
    const key = m[1].toLowerCase();
    const kind = spec[key];
    if (!kind || seen.has(key)) continue;
    seen.add(key);
    const raw = m[2] ?? m[3] ?? m[4] ?? "";
    // A placeholder here would splice finished HTML into a quoted attribute.
    if (/[\u0000\u0001]/.test(raw)) continue;
    const value = decodeEntities(raw).trim();
    if (kind === "bool") attrs += ` ${key}`;
    else if (kind === "num") {
      if (/^\d{1,5}$/.test(value)) attrs += ` ${key}="${value}"`;
    } else if (kind === "url") {
      if (SAFE_URL_RE.test(value) && !/[\u0000-\u001f]/.test(value)) attrs += ` ${key}="${esc(value)}"`;
    } else attrs += ` ${key}="${esc(value)}"`;
  }
  if (name === "img") return seen.has("src") && attrs.includes(" src=") ? `<img${attrs} class="md-img">` : "";
  if (name === "a") attrs += ` ${LINK_ATTRS}`;
  return `<${name}${attrs}>`;
}

const EMOJI = new Map<string, string>(Object.entries({
  "+1": "👍", "-1": "👎", thumbsup: "👍", thumbsdown: "👎",
  warning: "⚠️", white_check_mark: "✅", heavy_check_mark: "✔️", x: "❌",
  negative_squared_cross_mark: "❎", heavy_multiplication_x: "✖️", no_entry: "⛔",
  no_entry_sign: "🚫", stop_sign: "🛑", exclamation: "❗", question: "❓",
  information_source: "ℹ️", bulb: "💡", memo: "📝", pencil: "📝", pencil2: "✏️",
  rocket: "🚀", tada: "🎉", bug: "🐛", fire: "🔥", sparkles: "✨", construction: "🚧",
  lock: "🔒", unlock: "🔓", key: "🔑", link: "🔗", mag: "🔍", wrench: "🔧",
  hammer: "🔨", gear: "⚙️", package: "📦", zap: "⚡", boom: "💥", art: "🎨",
  recycle: "♻️", wastebasket: "🗑️", rotating_light: "🚨", eyes: "👀", smile: "😄",
  slightly_smiling_face: "🙂", thinking: "🤔", heart: "❤️", star: "⭐", clipboard: "📋",
  calendar: "📅", chart_with_upwards_trend: "📈", test_tube: "🧪", books: "📚",
  point_right: "👉", arrow_right: "➡️", hourglass: "⌛", hourglass_flowing_sand: "⏳",
  red_circle: "🔴", green_circle: "🟢", yellow_circle: "🟡", large_blue_circle: "🔵",
  white_circle: "⚪", new: "🆕", ok: "🆗", pushpin: "📌", lipstick: "💄",
}));

const IMG_RE =
  /!\[((?:[^[\]]|\[[^[\]]*\])*)\]\(\s*((?:[^\s()]|\([^\s()]*\))+)(?:\s+=(\d*)x(\d*))?(?:\s+&quot;(.*?)&quot;|\s+'([^'\n]*)')?\s*\)/g;
const LINK_RE =
  /\[((?:[^[\]]|\[[^[\]]*\])*)\]\(\s*((?:[^\s()]|\([^\s()]*\))*)(?:\s+&quot;(.*?)&quot;|\s+'([^'\n]*)')?\s*\)/g;
const BARE_URL_RE = /(^|[\s(\[*_~]|&quot;)(https?:\/\/[^\s\u0000\u0001]+)/g;
const WORK_ITEM_RE = /(^|[\s(\[,;])#(\d{3,9})(?![\w#])/g;

/** Resolve an (already escaped) link destination; null when it is not a safe absolute URL. */
function linkTarget(stash: Stash, raw: string): string | null {
  const url = stash.restore(raw).trim();
  if (!url || /[\s<>"\u0000\u0001]/.test(url) || !SAFE_URL_RE.test(url)) return null;
  return url;
}

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

function linkBareUrls(s: string, stash: Stash): string {
  return s.replace(BARE_URL_RE, (all, lead: string, raw: string) => {
    let url = raw;
    let tail = "";
    const cut = url.search(/&(?:lt|gt|quot);/);
    if (cut >= 0) {
      tail = url.slice(cut);
      url = url.slice(0, cut);
    }
    for (;;) {
      if (url.endsWith("&amp;")) {
        tail = "&amp;" + tail;
        url = url.slice(0, -5);
        continue;
      }
      const last = url.slice(-1);
      if (
        /[.,;:!?'*_~]/.test(last) ||
        (last === ")" && count(url, "(") < count(url, ")")) ||
        (last === "]" && count(url, "[") < count(url, "]"))
      ) {
        tail = last + tail;
        url = url.slice(0, -1);
        continue;
      }
      break;
    }
    if (!/^https?:\/\/[^/?#]/.test(url)) return all;
    return `${lead}${stash.keep(`<a href="${url}" ${LINK_ATTRS}>${url}</a>`)}${tail}`;
  });
}

/** Passes that run on escaped text: links, URLs, work items, emoji, emphasis. */
function decorate(s: string, ctx: Ctx, stash: Stash, links: boolean): string {
  if (links) {
    s = s.replace(IMG_RE, (_all, alt: string, dest: string, w: string, h: string, t1?: string, t2?: string) => {
      const altText = stash.restore(alt).replace(/<[^>]*>/g, "").replace(/["<>]/g, "");
      const src = linkTarget(stash, dest);
      if (!src) return altText;
      const title = t1 ?? t2;
      let attrs = ` src="${src}" alt="${altText}"`;
      if (title && !/[\u0000\u0001]/.test(title)) attrs += ` title="${title}"`;
      if (w) attrs += ` width="${w}"`;
      if (h) attrs += ` height="${h}"`;
      return stash.keep(`<img${attrs} class="md-img">`);
    });
    s = s.replace(LINK_RE, (_all, text: string, dest: string, t1?: string, t2?: string) => {
      const inner = decorate(text, ctx, stash, false);
      const href = linkTarget(stash, dest);
      if (!href) return inner;
      const title = t1 ?? t2;
      const titleAttr = title && !/[\u0000\u0001]/.test(title) ? ` title="${title}"` : "";
      return stash.keep(`<a href="${href}"${titleAttr} ${LINK_ATTRS}>${inner}</a>`);
    });
    s = linkBareUrls(s, stash);
    const workItemUrl = ctx.opts.workItemUrl;
    if (workItemUrl) {
      s = s.replace(WORK_ITEM_RE, (all, lead: string, id: string) => {
        const url = workItemUrl(id);
        if (!SAFE_URL_RE.test(url)) return all;
        return `${lead}${stash.keep(`<a href="${esc(url)}" class="md-wi" ${LINK_ATTRS}>#${id}</a>`)}`;
      });
    }
  }
  // Word-bounded so `config:key:value` stays text.
  s = s.replace(/(?<![\w:]):([a-z0-9_+-]{1,40}):(?![\w:])/g, (all, name: string) => EMOJI.get(name) ?? all);
  return s
    .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
}

function renderInline(src: string, ctx: Ctx): string {
  const stash = new Stash();
  let s = src
    // Code spans first: their contents are literal.
    .replace(/(?<![`\\])(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_all, _ticks: string, code: string) => {
      let c = code.replace(/\n/g, " ");
      if (c.length > 2 && c.startsWith(" ") && c.endsWith(" ") && c.trim()) c = c.slice(1, -1);
      return stash.keep(`<code>${esc(c)}</code>`);
    })
    .replace(/\\([!-/:-@[-`{-~])/g, (_all, ch: string) => stash.keep(esc(ch)))
    .replace(/<((?:https?:\/\/|mailto:)[^\s<>\u0000\u0001]+)>/gi, (_all, u: string) =>
      stash.keep(`<a href="${esc(u)}" ${LINK_ATTRS}>${esc(u)}</a>`))
    .replace(TAG_RE, (all, closing: string, name: string, attrs: string) =>
      HTML_TAGS.has(name.toLowerCase()) ? stash.keep(rebuildTag(closing, name, attrs)) : all)
    // Valid entities pass through untouched instead of being double-escaped.
    .replace(/&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (e) => stash.keep(e));
  s = decorate(esc(s), ctx, stash, true);
  return stash.restore(s);
}

/** Inline markdown only (no block structure). Escape-first and XSS-safe. */
export function mdInline(s: string): string {
  return renderInline(String(s == null ? "" : s), { opts: {} });
}

// ---------------------------------------------------------------- blocks

const FENCE_OPEN_RE = /^( *)(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ *(`{3,}|~{3,})[ \t]*$/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^ {0,3}> ?(.*)$/;
const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const TASK_RE = /^\[([ xX])\](?:[ \t]+(.*))?$/;
const TABLE_DELIM_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const HTML_BLOCK_RE =
  /^ {0,3}<\/?(?:details|summary|div|p|table|thead|tbody|tfoot|tr|td|th|ul|ol|li|blockquote|h[1-6]|hr|pre)(?=[\s/>]|$)/i;

const isBlank = (line: string): boolean => !line.trim();
const indentOf = (line: string): number => line.length - line.trimStart().length;

function openFence(line: string): { ch: string; len: number; indent: number; info: string } | null {
  const m = line.match(FENCE_OPEN_RE);
  if (!m || (m[2][0] === "`" && m[3].includes("`"))) return null;
  return { ch: m[2][0], len: m[2].length, indent: m[1].length, info: m[3].trim() };
}

function closesFence(line: string, fence: { ch: string; len: number }): boolean {
  const m = line.match(FENCE_CLOSE_RE);
  return !!m && m[1][0] === fence.ch && m[1].length >= fence.len;
}

function renderFence(lang: string, code: string): string {
  // Source is HTML-escaped here; textContent reads it back unescaped for mermaid (XSS-safe).
  if (lang === "mermaid") return `<div class="mermaid" data-mermaid="1">${esc(code)}</div>`;
  return `<pre class="md-pre"><code>${esc(code)}</code></pre>`;
}

/** Split a table row on unescaped pipes outside code spans. */
function splitRow(line: string, codeAware = true): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let ticks = 0;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === "\\" && s[k + 1] === "|") {
      cur += "|";
      k++;
    } else if (ch === "`" && codeAware) {
      let run = 1;
      while (s[k + run] === "`") run++;
      if (!ticks) ticks = run;
      else if (run === ticks) ticks = 0;
      cur += s.slice(k, k + run);
      k += run - 1;
    } else if (ch === "|" && !ticks) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (ticks && codeAware) return splitRow(line, false);
  cells.push(cur.trim());
  return cells;
}

function isTableStart(head: string, delim: string | undefined): boolean {
  if (delim === undefined || !head.includes("|") || !delim.includes("|") || !TABLE_DELIM_RE.test(delim)) {
    return false;
  }
  return splitRow(head).length === splitRow(delim).length;
}

/** Lines that end a paragraph (or a table, or a lazy continuation) without a blank line. */
function startsBlock(line: string): boolean {
  return (
    !!openFence(line) || ATX_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || HTML_BLOCK_RE.test(line)
  );
}

function interruptsParagraph(line: string, next: string | undefined): boolean {
  if (startsBlock(line)) return true;
  const m = line.match(LIST_RE);
  if (m && m[4] && m[4].trim() && (!/\d/.test(m[2]) || parseInt(m[2], 10) === 1)) return true;
  return isTableStart(line, next);
}

function parseTable(ctx: Ctx, lines: string[], start: number): { html: string; next: number } {
  const header = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    return left && right ? ` class="md-c"` : right ? ` class="md-r"` : "";
  });
  const row = (tag: "th" | "td", cells: string[]) =>
    `<tr>${header.map((_, k) => `<${tag}${aligns[k]}>${renderInline(cells[k] ?? "", ctx)}</${tag}>`).join("")}</tr>`;
  const body: string[] = [];
  let i = start + 2;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line) || !line.includes("|") || startsBlock(line) || LIST_RE.test(line)) break;
    body.push(row("td", splitRow(line)));
  }
  const tbody = body.length ? `<tbody>${body.join("")}</tbody>` : "";
  return {
    html: `<div class="md-table"><table><thead>${row("th", header)}</thead>${tbody}</table></div>`,
    next: i,
  };
}

interface ListItem {
  body: string[];
  task: boolean | null;
}

function parseList(ctx: Ctx, lines: string[], start: number): { html: string; next: number } {
  const first = lines[start].match(LIST_RE)!;
  const ordered = /\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items: ListItem[] = [];
  let loose = false;
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(LIST_RE);
    if (!m || /\d/.test(m[2]) !== ordered || HR_RE.test(lines[i])) break;
    const markerIndent = m[1].length;
    const gap = (m[3] ?? "").replace(/\t/g, "    ").length;
    const text = m[4] ?? "";
    // Content more than 4 columns past the marker counts as 1 (CommonMark); empty items use 1.
    const contentIndent = markerIndent + m[2].length + (gap >= 1 && gap <= 4 && text ? gap : 1);
    const body = [gap > 4 ? " ".repeat(gap - 1) + text : text];
    // Children may sit anywhere from 2 columns past the marker (lenient for 1. / 10. lists).
    const isChild = (line: string): boolean => {
      if (indentOf(line) >= contentIndent) return true;
      const lm = line.match(LIST_RE);
      return !!lm && !HR_RE.test(line) && lm[1].length >= markerIndent + 2;
    };
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) {
        let j = i;
        while (j < lines.length && isBlank(lines[j])) j++;
        if (j < lines.length && isChild(lines[j])) {
          for (; i < j; i++) body.push("");
          loose = true;
          continue;
        }
        break;
      }
      if (isChild(line)) {
        body.push(line.slice(Math.min(indentOf(line), contentIndent)));
        i++;
        continue;
      }
      // Lazy continuation of the item's trailing paragraph.
      if (!isBlank(body[body.length - 1]) && !startsBlock(line) && !LIST_RE.test(line)) {
        body.push(line.trim());
        i++;
        continue;
      }
      break;
    }
    let task: boolean | null = null;
    const t = body[0].match(TASK_RE);
    if (t) {
      task = t[1] !== " ";
      body[0] = t[2] ?? "";
    }
    items.push({ body, task });

    let j = i;
    while (j < lines.length && isBlank(lines[j])) j++;
    const next = j < lines.length ? lines[j].match(LIST_RE) : null;
    if (!next || /\d/.test(next[2]) !== ordered || HR_RE.test(lines[j])) break;
    if (j > i) loose = true;
    i = j;
  }

  const hasTasks = items.some((it) => it.task !== null);
  const attrs =
    (ordered && startNum !== 1 ? ` start="${startNum}"` : "") + (hasTasks ? ` class="md-tasks"` : "");
  const lis = items.map((it) => {
    const inner = renderBlocks(ctx, it.body, !loose);
    if (it.task === null) return `<li>${inner}</li>`;
    const box = `<input type="checkbox" class="md-check" disabled${it.task ? " checked" : ""}>`;
    return `<li class="md-task">${inner.startsWith("<p>") ? `<p>${box}${inner.slice(3)}` : box + inner}</li>`;
  });
  const tag = ordered ? "ol" : "ul";
  return { html: `<${tag}${attrs}>${lis.join("")}</${tag}>`, next: i };
}

function renderBlocks(ctx: Ctx, lines: string[], tight = false): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = openFence(line);
    if (fence) {
      const strip = new RegExp(`^ {0,${fence.indent}}`);
      const code: string[] = [];
      for (i++; i < lines.length; i++) {
        if (closesFence(lines[i], fence)) {
          i++;
          break;
        }
        code.push(lines[i].replace(strip, ""));
      }
      out.push(renderFence(fence.info.split(/\s+/)[0].toLowerCase(), code.join("\n")));
      continue;
    }

    const m = line.match(ATX_RE);
    if (m) {
      const level = m[1].length;
      out.push(`<h${level}>${renderInline((m[2] ?? "").trim(), ctx)}</h${level}>`);
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && !isBlank(lines[i]); i++) {
        const q = lines[i].match(QUOTE_RE);
        if (q) body.push(q[1]);
        else if (!startsBlock(lines[i]) && !LIST_RE.test(lines[i])) body.push(lines[i]);
        else break;
      }
      out.push(`<blockquote>${renderBlocks(ctx, body)}</blockquote>`);
      continue;
    }

    if (isTableStart(line, lines[i + 1])) {
      const table = parseTable(ctx, lines, i);
      out.push(table.html);
      i = table.next;
      continue;
    }

    if (LIST_RE.test(line)) {
      const list = parseList(ctx, lines, i);
      out.push(list.html);
      i = list.next;
      continue;
    }

    if (HTML_BLOCK_RE.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && !isBlank(lines[i]); i++) body.push(lines[i].trim());
      out.push(renderInline(body.join("\n"), ctx));
      continue;
    }

    // Paragraph, possibly a setext heading.
    const para = [line.trim()];
    let heading = 0;
    for (i++; i < lines.length; i++) {
      const next = lines[i];
      if (isBlank(next)) break;
      if (/^ {0,3}=+[ \t]*$/.test(next)) {
        heading = 1;
        i++;
        break;
      }
      if (/^ {0,3}-+[ \t]*$/.test(next)) {
        heading = 2;
        i++;
        break;
      }
      if (interruptsParagraph(next, lines[i + 1])) break;
      para.push(next.trim());
    }
    const html = renderInline(para.map((l) => l.replace(/\\$/, "")).join("\n"), ctx).replace(/\n/g, "<br>");
    if (heading) out.push(`<h${heading}>${html}</h${heading}>`);
    else out.push(tight ? html : `<p>${html}</p>`);
  }
  return out.join("\n");
}

/** Index of the next backtick run of exactly `run` ticks at or after `from`, or -1. */
function findTicks(s: string, from: number, run: number): number {
  for (let k = from; k < s.length; ) {
    if (s[k] !== "`") {
      k++;
      continue;
    }
    let r = 1;
    while (s[k + r] === "`") r++;
    if (r === run) return k;
    k += r;
  }
  return -1;
}

/** Remove <!-- comments --> (PR templates are full of them), leaving code untouched. */
function stripComments(src: string): string {
  if (!src.includes("<!--")) return src;
  const out: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  let inComment = false;
  let offset = 0;
  for (const line of src.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    if (!inComment) {
      if (fence) {
        out.push(line);
        if (closesFence(line, fence)) fence = null;
        continue;
      }
      const open = openFence(line);
      if (open) {
        fence = open;
        out.push(line);
        continue;
      }
    }
    let kept = "";
    let k = 0;
    while (k < line.length) {
      if (inComment) {
        const end = line.indexOf("-->", k);
        if (end < 0) break;
        inComment = false;
        k = end + 3;
        continue;
      }
      if (line[k] === "`") {
        let run = 1;
        while (line[k + run] === "`") run++;
        const close = findTicks(line, k + run, run);
        const stop = close >= 0 ? close + run : k + run;
        kept += line.slice(k, stop);
        k = stop;
        continue;
      }
      // An unterminated <!-- stays literal rather than swallowing the rest of the text.
      if (line.startsWith("<!--", k) && src.indexOf("-->", lineStart + k + 4) >= 0) {
        inComment = true;
        k += 4;
        continue;
      }
      kept += line[k++];
    }
    if (isBlank(kept) && !isBlank(line)) continue; // comment-only line: drop it entirely
    out.push(kept);
  }
  return out.join("\n");
}

const ESCAPED_DETAILS_RE = /^( {0,3})&lt;(\/?)details&gt;[ \t]*$/i;
const ESCAPED_SUMMARY_RE = /^( {0,3})&lt;summary&gt;(.*?)&lt;\/summary&gt;[ \t]*$/i;

/**
 * Some PR templates are stored with their collapsible section entity-escaped
 * (`&lt;details&gt;`). Restore just those whole-line, attribute-free
 * details/summary tags so the section collapses instead of printing as text.
 */
function unescapeDisclosureTags(src: string): string {
  if (!/&lt;\/?(?:details|summary)&gt;/i.test(src)) return src;
  let fence: { ch: string; len: number } | null = null;
  return src
    .split("\n")
    .map((line) => {
      if (fence) {
        if (closesFence(line, fence)) fence = null;
        return line;
      }
      const open = openFence(line);
      if (open) {
        fence = open;
        return line;
      }
      const d = line.match(ESCAPED_DETAILS_RE);
      if (d) return `${d[1]}<${d[2]}details>`;
      const s = line.match(ESCAPED_SUMMARY_RE);
      return s ? `${s[1]}<summary>${s[2]}</summary>` : line;
    })
    .join("\n");
}

/** Block markdown -> HTML. Safe to assign to innerHTML. */
export function renderMarkdown(src: unknown, opts: MarkdownOptions = {}): string {
  const text = String(src == null ? "" : src)
    .replace(/[\u0000\u0001]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/^[ \t]+/gm, (ws) => ws.replace(/\t/g, "    "));
  return renderBlocks({ opts }, unescapeDisclosureTags(stripComments(text)).split("\n"));
}

const MARKDOWN_MEMO_SIZE = 400;
const markdownMemo = new Map<string, string>();

/**
 * renderMarkdown with default options, remembered for the latest few hundred
 * texts. Chats re-render on every poll while a reply streams; their earlier
 * messages never change, so they render once.
 */
export function renderMarkdownMemo(src: string): string {
  const hit = markdownMemo.get(src);
  if (hit !== undefined) {
    // Refresh its place so the oldest-used text is the one evicted.
    markdownMemo.delete(src);
    markdownMemo.set(src, hit);
    return hit;
  }
  const html = renderMarkdown(src);
  markdownMemo.set(src, html);
  if (markdownMemo.size > MARKDOWN_MEMO_SIZE) markdownMemo.delete(markdownMemo.keys().next().value!);
  return html;
}

// Comment bodies that carry inline HTML (bot/GitOps posts) vs. plain markdown.
const HTML_TAG_RE =
  /<\/?(?:span|div|small|details|summary|p|br|b|strong|i|em|u|s|a|img|ul|ol|li|h[1-6]|blockquote|table|thead|tbody|tr|td|th|hr|code|pre|kbd|sub|sup|abbr)\b/i;

/**
 * Render a PR comment body. Comments that embed inline HTML (e.g. the GitOps PR
 * Assistant) are sanitized and rendered as HTML; everything else goes through
 * the markdown renderer. Both branches return XSS-safe HTML for innerHTML.
 */
export function renderCommentBody(content: unknown): string {
  const s = String(content == null ? "" : content);
  return HTML_TAG_RE.test(s) ? sanitizeHtml(s) : renderMarkdown(s);
}
