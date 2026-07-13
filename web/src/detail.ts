// PR detail view: loads a PR's detail payload and renders header, review panel,
// description, discussion threads, and the changed-files list.
//
// NOTE: detail <-> list form an intentional runtime cycle (renderDetail's back
// button calls renderList; a list card click calls openDetail). The references
// are only invoked from event handlers, never at module-eval time, so the ES
// module cycle resolves safely (function bindings are hoisted/live).
import { el, view, renderError } from "./dom.js";
import { esc } from "./util.js";
import { state, stopReviewPoll } from "./state.js";
import { getJSON } from "./api.js";
import { renderMarkdown } from "./markdown.js";
import { renderMermaid } from "./mermaid.js";
import { renderThread } from "./threads.js";
import { renderFile } from "./diff.js";
import { refreshReviewPanel } from "./reviewPanel.js";
import { sendPrToCopilot } from "./bridge.js";
import { renderList } from "./list.js";
import type { PR, Detail, Thread } from "./types.js";

export async function openDetail(pr: PR): Promise<void> {
  stopReviewPoll();
  view.innerHTML = '<div class="loading"><span class="spinner"></span> Loading PR #' + pr.id + "…</div>";
  let detail: Detail;
  try {
    detail = await getJSON(
      `/api/pr?org=${encodeURIComponent(pr.org)}&project=${encodeURIComponent(pr.project)}` +
        `&repoId=${encodeURIComponent(pr.repoId)}&id=${pr.id}`
    );
  } catch (e: any) {
    return renderError("Failed to load PR: " + e.message);
  }
  renderDetail(pr, detail);
}

export function renderDetail(pr: PR, detail: Detail): void {
  state.current = { pr, detail };
  view.innerHTML = "";

  const head = el(`<div class="detail-head"></div>`);
  const back = el(`<div class="backbar"></div>`);
  const backBtn = el(`<button class="back-btn">← Pull requests</button>`);
  backBtn.addEventListener("click", renderList);
  const sendAll = el(`<button class="btn sm">Review PR with Copilot</button>`) as HTMLButtonElement;
  sendAll.addEventListener("click", async () => {
    if (sendAll.disabled) return;
    sendAll.disabled = true;
    const orig = sendAll.textContent;
    sendAll.textContent = "Reviewing…";
    try {
      await sendPrToCopilot(pr, detail);
    } finally {
      sendAll.disabled = false;
      sendAll.textContent = orig;
    }
  });
  back.appendChild(backBtn);
  back.appendChild(sendAll);
  head.appendChild(back);

  head.appendChild(el(`<div class="detail-title">${esc(pr.title)}</div>`));
  const sub = el(`<div class="detail-sub"></div>`);
  sub.appendChild(el(`<span class="id">#${pr.id}</span>`));
  sub.appendChild(el(`<span>${esc(pr.repo)} · ${esc(pr.project)}</span>`));
  sub.appendChild(el(`<span><code>${esc(pr.sourceRef)}</code> → <code>${esc(pr.targetRef)}</code></span>`));
  const link = el(`<button class="link-btn">Open in ADO ↗</button>`);
  link.addEventListener("click", () => window.open(pr.url, "_blank"));
  sub.appendChild(link);
  head.appendChild(sub);
  view.appendChild(head);

  // Background-review result panel (populated async; polls while running).
  const revPanel = el(`<div class="rev-panel" hidden></div>`);
  view.appendChild(revPanel);
  refreshReviewPanel(pr, revPanel);

  // PR description rendered as a lightweight markdown preview.
  if (detail.description && detail.description.trim()) {
    view.appendChild(el(`<div class="section-title">Description</div>`));
    const desc = el(`<div class="pr-desc md"></div>`);
    desc.innerHTML = renderMarkdown(detail.description);
    view.appendChild(desc);
    renderMermaid(desc);
  }

  // General (non-file) threads
  const general = detail.threads.filter((t) => !t.filePath);
  if (general.length) {
    view.appendChild(el(`<div class="section-title">Discussion</div>`));
    for (const t of general) view.appendChild(renderThread(pr, t));
  }

  // Files
  view.appendChild(el(`<div class="section-title">Changed files (${detail.files.length})</div>`));
  const threadsByFile = new Map<string, Thread[]>();
  for (const t of detail.threads) {
    if (!t.filePath) continue;
    if (!threadsByFile.has(t.filePath)) threadsByFile.set(t.filePath, []);
    threadsByFile.get(t.filePath)!.push(t);
  }
  for (const f of detail.files) {
    view.appendChild(renderFile(pr, detail, f, threadsByFile.get(f.path) || []));
  }
}
