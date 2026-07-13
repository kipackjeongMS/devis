// Lightweight, language-agnostic syntax highlighting (per-line).
// One regex pass over RAW text; each token is escaped as it is emitted, so this is
// XSS-safe. Tradeoff: state is per-line, so multi-line block comments/strings that
// span diff rows are not tracked across lines.
import { esc } from "./util.js";

const HL_KEYWORDS = new Set(
  (
    "abstract async await base bool boolean break byte case catch char class const continue " +
    "def default delegate do double elif else elseif end enum event export extends false final " +
    "finally float for foreach from func function global goto if implements import in int " +
    "interface internal is lambda let local long module namespace new nil none not null " +
    "object or override package params private protected public readonly record ref require " +
    "return sealed self short static string struct super switch template then this throw throws " +
    "true try type typedef typeof undefined union unsigned using val var virtual void when " +
    "while with yield and as begin echo elif fi then do done esac local set param"
  ).split(/\s+/)
);

const HL_RE =
  /(\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*|(?<![^\s])#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b0[xX][0-9a-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;

export function highlightCode(src: unknown): string {
  src = String(src == null ? "" : src);
  if (!src) return "";
  let out = "",
    last = 0,
    m: RegExpExecArray | null;
  HL_RE.lastIndex = 0;
  while ((m = HL_RE.exec(src as string))) {
    if (m.index > last) out += esc((src as string).slice(last, m.index));
    if (m[1]) out += `<span class="t-c">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="t-s">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="t-n">${esc(m[3])}</span>`;
    else if (m[4]) out += HL_KEYWORDS.has(m[4]) ? `<span class="t-k">${esc(m[4])}</span>` : esc(m[4]);
    last = HL_RE.lastIndex;
    if (m.index === HL_RE.lastIndex) HL_RE.lastIndex++; // guard against zero-length loops
  }
  if (last < (src as string).length) out += esc((src as string).slice(last));
  return out;
}
