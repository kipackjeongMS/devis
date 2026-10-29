// Regression harness for web/src/markdown.ts (PR description + comment renderer).
// Covers block structure, GFM extras seen in real ADO PR descriptions, and XSS cases.
import assert from "node:assert/strict";

const { renderMarkdown, renderCommentBody } = await import("../web/markdown.js");

const md = (s, o) => renderMarkdown(s, o);
const has = (html, needle, msg) => assert.ok(html.includes(needle), `${msg ?? needle}\n--- got ---\n${html}`);
const lacks = (html, needle, msg) => assert.ok(!html.includes(needle), `${msg ?? `unexpected ${needle}`}\n--- got ---\n${html}`);
const lacksRe = (html, re, msg) => assert.ok(!re.test(html), `${msg ?? `unexpected ${re}`}\n--- got ---\n${html}`);

// Headings, setext, rules, paragraphs
{
  const h = md("# Title\n\nSub\n---\n\ntext *em* **strong**\n\n***\n\nend");
  has(h, "<h1>Title</h1>");
  has(h, "<h2>Sub</h2>");
  has(h, "<hr>");
  has(h, "<em>em</em>");
  has(h, "<strong>strong</strong>");
  lacks(h, "# Title");
}

// Task lists become disabled checkboxes; no raw [x]/[ ] markers survive
{
  const h = md("- [x] done\n- [ ] todo\n- plain");
  has(h, 'class="md-tasks"');
  has(h, '<input type="checkbox" class="md-check" disabled checked>');
  has(h, '<input type="checkbox" class="md-check" disabled>');
  lacks(h, "[x]");
  lacks(h, "[ ]");
}

// Nested lists keep their hierarchy; ordered start is preserved
{
  const h = md("- a\n  - b\n    - c\n- d\n\n3. three\n4. four");
  assert.match(h, /<ul><li>a\s*<ul><li>b\s*<ul><li>c<\/li><\/ul><\/li><\/ul><\/li><li>d<\/li><\/ul>/);
  has(h, '<ol start="3">');
}

// GFM tables with alignment, escaped pipes, and code spans
{
  const h = md("| L | C | R |\n|:--|:-:|--:|\n| a \\| b | `x|y` | 3 |");
  has(h, '<div class="md-table"><table>');
  has(h, '<th class="md-c">C</th>');
  has(h, '<td class="md-r">3</td>');
  has(h, "a | b");
  has(h, "<code>x|y</code>");
}

// HTML comments are stripped, but kept verbatim inside code
{
  const h = md("<!-- hidden template hint -->\nvisible\n\n```\n<!-- keep -->\n```\n\nInline `<!-- code -->` here");
  lacks(h, "hidden template hint");
  has(h, "visible");
  has(h, "&lt;!-- keep --&gt;");
  has(h, "<code>&lt;!-- code --&gt;</code>");
}

// Raw <details>/<summary> are rebuilt from an allowlist (attributes like style/class dropped)
{
  const h = md('<details class="x" style="color:red" open>\n<summary onclick="alert(1)">More</summary>\n\nBody **bold**\n\n</details>');
  has(h, "<details open>");
  has(h, "<summary>More</summary>");
  has(h, "<strong>bold</strong>");
  lacks(h, "style=");
  lacks(h, "onclick");
}

// Entity-escaped whole-line details/summary from PR templates collapse too
{
  const h = md("&lt;details&gt;\n&lt;summary&gt;Rollback details&lt;/summary&gt;\n\nRedeploy.\n\n&lt;/details&gt;");
  has(h, "<details>");
  has(h, "<summary>Rollback details</summary>");
  has(h, "</details>");
  lacks(h, "&lt;details&gt;");
  // ...but only outside code and only as whole lines
  const code = md("```\n&lt;details&gt;\n```\n\ntext &lt;details&gt; inline");
  lacks(code, "<details>");
}

// XSS: dangerous tags, handlers, schemes, and attribute breakouts are neutralized
{
  const cases = [
    '<img src="https://x/a.png" onerror="alert(1)">',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="jav&#x61;script:alert(1)">x</a>',
    "[x](javascript:alert(1))",
    "![x](javascript:alert(1))",
    "<script>alert(1)</script>",
    '<iframe src="https://evil"></iframe>',
    "<svg onload=alert(1)>",
    '<a title="<https://x/onmouseover=alert(1)>">t</a>',
    '<a href="https://ok/" title="`x` onmouseover=alert(1)">t</a>',
    '<div style="background:url(javascript:alert(1))">s</div>',
  ];
  for (const c of cases) {
    const h = md(c);
    lacksRe(h, /<(script|iframe|svg)\b/i, `dangerous tag survived: ${c}`);
    lacksRe(h, /<[a-z][^>]*\son[a-z]+\s*=/i, `event handler survived: ${c}`);
    lacksRe(h, /<[a-z][^>]*\s(href|src)\s*=\s*"?\s*javascript:/i, `javascript: URL survived: ${c}`);
    lacksRe(h, /<[a-z][^>]*\sstyle\s*=/i, `style attribute survived: ${c}`);
  }
  const ok = md('<a href="https://example.com/x">site</a>');
  has(ok, 'href="https://example.com/x"');
  has(ok, 'rel="noopener noreferrer"');
}

// Entities are not double-escaped; literal angle text stays text
{
  const h = md("AT&amp;T &copy; 5 &lt; 6 and a < b");
  has(h, "AT&amp;T");
  has(h, "&copy;");
  has(h, "5 &lt; 6");
  has(h, "a &lt; b");
  lacks(h, "&amp;amp;");
  lacks(h, "&amp;lt;");
}

// No emphasis inside code spans; underscores in identifiers stay literal
{
  const h = md("Use `*not em*` and snake_case_name");
  has(h, "<code>*not em*</code>");
  has(h, "snake_case_name");
  lacks(h, "<em>case</em>");
}

// Bare URLs are linked; trailing punctuation is not part of the link
{
  const h = md("See https://example.com/path. Also (https://x.dev/a).");
  has(h, 'href="https://example.com/path"');
  has(h, 'href="https://x.dev/a"');
  lacks(h, 'href="https://example.com/path."');
}

// Emoji shortcodes, but not inside config-like tokens
{
  const h = md(":warning: careful with config:key:value");
  has(h, "\u26a0\ufe0f");
  has(h, "config:key:value");
}

// Work item refs link only when a URL builder is provided
{
  const plain = md("Fixes #12345");
  lacks(plain, "md-wi");
  const linked = md("Fixes #12345", { workItemUrl: (id) => `https://dev.azure.com/o/p/_workitems/edit/${id}` });
  has(linked, 'class="md-wi"');
  has(linked, 'href="https://dev.azure.com/o/p/_workitems/edit/12345"');
}

// Mermaid fences keep the container contract renderMermaid depends on
{
  const h = md("```mermaid\ngraph TD; A-->B\n```");
  has(h, '<div class="mermaid" data-mermaid="1">graph TD; A--&gt;B</div>');
}

// Representative ADO PR template renders with no raw markdown markers left over
{
  const tpl = [
    "## Why is this change being made?",
    "<!-- Explain the motivation -->",
    "Fixes a race in the poller.",
    "",
    "## What is being changed?",
    "- [x] Code change",
    "- [ ] Config change",
    "  - nested detail",
    "",
    "| Area | Risk |",
    "| --- | --- |",
    "| Poller | **Low** |",
    "",
    "> **Note**: rollout is staged",
    "",
    "&lt;details&gt;",
    "&lt;summary&gt;Rollback&lt;/summary&gt;",
    "",
    "Redeploy previous build.",
    "",
    "&lt;/details&gt;",
  ].join("\r\n");
  const h = md(tpl);
  for (const raw of ["## ", "<!--", "[x]", "[ ]", "| ---", "**", "&lt;details", "> "]) lacks(h, raw, `raw marker left: ${raw}`);
  has(h, "<blockquote>");
  has(h, "<table>");
}

// Plain comment bodies route through markdown (the HTML branch uses DOMParser, browser-only)
{
  has(renderCommentBody("**hi** and `code`"), "<strong>hi</strong>");
}

console.log("markdown-render-harness: ok");
