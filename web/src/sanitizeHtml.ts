// A small allowlist HTML sanitizer for rendering untrusted PR comment content
// (e.g. GitOps/bot posts that embed inline HTML) without XSS. It parses the
// markup into a detached document, drops any tag/attribute outside the
// allowlist, rewrites href/src to safe schemes, and returns clean innerHTML.

const ALLOWED_TAGS = new Set([
  "A", "ABBR", "B", "BLOCKQUOTE", "BR", "CODE", "DETAILS", "DIV", "EM", "H1",
  "H2", "H3", "H4", "H5", "H6", "HR", "I", "IMG", "KBD", "LI", "OL", "P", "PRE",
  "S", "SMALL", "SPAN", "STRONG", "SUB", "SUMMARY", "SUP", "TABLE", "TBODY",
  "TD", "TH", "THEAD", "TR", "U", "UL",
]);

// Tags removed together with their contents (never merely unwrapped).
const DROP_WITH_CONTENT = new Set([
  "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "FORM",
  "INPUT", "BUTTON", "TEXTAREA", "SELECT", "SVG", "MATH", "NOSCRIPT", "TEMPLATE",
]);

// Per-tag attribute allowlist. Anything not listed (all on* handlers, style,
// class, id, etc.) is stripped.
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  A: new Set(["href", "title"]),
  IMG: new Set(["src", "alt", "title", "width", "height"]),
  TD: new Set(["colspan", "rowspan"]),
  TH: new Set(["colspan", "rowspan"]),
};

function safeUrl(raw: string): string | null {
  const v = (raw || "").trim();
  return /^(https?:|mailto:)/i.test(v) ? v : null;
}

function cleanElement(elm: Element): void {
  for (const attr of Array.from(elm.attributes)) {
    const name = attr.name.toLowerCase();
    const allowed = ALLOWED_ATTRS[elm.tagName]?.has(name) ?? false;
    if (!allowed) {
      elm.removeAttribute(attr.name);
      continue;
    }
    if (name === "href" || name === "src") {
      const url = safeUrl(attr.value);
      if (url) elm.setAttribute(attr.name, url);
      else elm.removeAttribute(attr.name);
    }
  }
  if (elm.tagName === "A") {
    elm.setAttribute("target", "_blank");
    elm.setAttribute("rel", "noopener noreferrer");
  }
}

// Post-order walk: sanitize each subtree BEFORE deciding the parent's fate, so
// unwrapping a disallowed wrapper only ever lifts already-clean children.
function walk(node: Element): void {
  for (const child of Array.from(node.children)) {
    walk(child);
    const tag = child.tagName;
    if (ALLOWED_TAGS.has(tag)) {
      cleanElement(child);
    } else if (DROP_WITH_CONTENT.has(tag)) {
      child.remove();
    } else {
      const parent = child.parentNode!;
      while (child.firstChild) parent.insertBefore(child.firstChild, child);
      parent.removeChild(child);
    }
  }
}

/** Sanitize an untrusted HTML string into XSS-safe HTML suitable for innerHTML. */
export function sanitizeHtml(dirty: string): string {
  const doc = new DOMParser().parseFromString(String(dirty || ""), "text/html");
  walk(doc.body);
  return doc.body.innerHTML;
}
