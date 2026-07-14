// PR detail view: loads a PR's detail payload and renders it inside a slide-over
// modal (header, review panel, description, discussion threads, changed files).
// The list stays mounted underneath, so closing the modal returns to it with its
// scroll position intact.
import { el } from "./dom.js";
import { esc } from "./util.js";
import { state, stopReviewPoll } from "./state.js";
import { getJSON } from "./api.js";
import { renderMarkdown } from "./markdown.js";
import { renderMermaid } from "./mermaid.js";
import { renderThread } from "./threads.js";
import { renderFile } from "./diff.js";
import { refreshReviewPanel } from "./reviewPanel.js";
import { sendPrToCopilot } from "./bridge.js";
import { openModal, closeModal } from "./modal.js";
import { requestNotifyPermission } from "./notifyWatch.js";
import type { PR, Detail, Thread } from "./types.js";

// Closing the detail modal: stop the review poll and drop the current selection.
function onDetailClose(): void {
  stopReviewPoll();
  state.current = undefined;
}

export async function openDetail(pr: PR): Promise<void> {
  stopReviewPoll();
  const container = el(
    `<div class="detail-modal"><div class="loading"><span class="spinner"></span> Loading PR #${pr.id}…</div></div>`
  );
  openModal(container, { onClose: onDetailClose });
  let detail: Detail;
  try {
    detail = await getJSON(
      `/api/pr?org=${encodeURIComponent(pr.org)}&project=${encodeURIComponent(pr.project)}` +
        `&repoId=${encodeURIComponent(pr.repoId)}&id=${pr.id}`
    );
  } catch (e: any) {
    if (!container.isConnected) return; // modal was closed/replaced mid-fetch
    container.innerHTML = `<div class="empty">Failed to load PR: ${esc(e.message)}</div>`;
    return;
  }
  if (!container.isConnected) return; // modal was closed/replaced mid-fetch
  buildDetail(container, pr, detail);
}

// Render a fully-loaded PR into a slide-over modal.
function buildDetail(container: HTMLElement, pr: PR, detail: Detail): void {
  state.current = { pr, detail };
  container.innerHTML = "";

  const head = el(`<div class="detail-head"></div>`);
  const back = el(`<div class="backbar"></div>`);
  const backBtn = el(`<button class="back-btn">← Pull requests</button>`);
  backBtn.addEventListener("click", () => closeModal());
  const sendAll = el(`<button class="btn sm">Review PR with Copilot</button>`) as HTMLButtonElement;
  sendAll.addEventListener("click", async () => {
    if (sendAll.disabled) return;
    requestNotifyPermission(); // within the user gesture, so the host honors it
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
  const rightGroup = el(`<div class="backbar-actions"></div>`);
  const closeBtn = el(`<button class="modal-close" title="Close (Esc)" aria-label="Close">✕</button>`);
  closeBtn.addEventListener("click", () => closeModal());
  rightGroup.appendChild(sendAll);
  rightGroup.appendChild(closeBtn);
  back.appendChild(backBtn);
  back.appendChild(rightGroup);
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
  container.appendChild(head);

  // Background-review result panel (populated async; polls while running).
  const revPanel = el(`<div class="rev-panel" hidden></div>`);
  container.appendChild(revPanel);
  refreshReviewPanel(pr, revPanel);

  // PR description rendered as a lightweight markdown preview.
  if (detail.description && detail.description.trim()) {
    container.appendChild(el(`<div class="section-title">Description</div>`));
    const desc = el(`<div class="pr-desc md"></div>`);
    desc.innerHTML = renderMarkdown(detail.description);
    container.appendChild(desc);
    renderMermaid(desc);
  }

  // General (non-file) threads
  const general = detail.threads.filter((t) => !t.filePath);
  if (general.length) {
    container.appendChild(el(`<div class="section-title">Discussion</div>`));
    for (const t of general) container.appendChild(renderThread(pr, t));
  }

  // Files
  container.appendChild(el(`<div class="section-title">Changed files (${detail.files.length})</div>`));
  const threadsByFile = new Map<string, Thread[]>();
  for (const t of detail.threads) {
    if (!t.filePath) continue;
    if (!threadsByFile.has(t.filePath)) threadsByFile.set(t.filePath, []);
    threadsByFile.get(t.filePath)!.push(t);
  }
  for (const f of detail.files) {
    container.appendChild(renderFile(pr, detail, f, threadsByFile.get(f.path) || []));
  }
}
