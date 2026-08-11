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
import { mountSeverityLights, refreshSeverityLights, unmountSeverityLights } from "./severityLights.js";
import { sendPrToCopilot } from "./bridge.js";
import { openModal, closeModal } from "./modal.js";
import { requestNotifyPermission } from "./notifyWatch.js";
import { toast } from "./toast.js";
import type { PR, Detail, Thread } from "./types.js";
import { statusBadge, voteBadge, myActionBadge } from "./prStatus.js";

// Closing the detail modal: stop the review poll and drop the current selection.
function onDetailClose(): void {
  stopReviewPoll();
  unmountSeverityLights();
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
    detail = await fetchDetail(pr);
  } catch (e: any) {
    if (!container.isConnected) return; // modal was closed/replaced mid-fetch
    container.innerHTML = `<div class="empty">Failed to load PR: ${esc(e.message)}</div>`;
    return;
  }
  if (!container.isConnected) return; // modal was closed/replaced mid-fetch
  buildDetail(container, pr, detail);
}

function fetchDetail(pr: PR, refresh = false): Promise<Detail> {
  const cacheBust = refresh ? `&_=${Date.now()}` : "";
  return getJSON(
    `/api/pr?org=${encodeURIComponent(pr.org)}&project=${encodeURIComponent(pr.project)}` +
      `&repoId=${encodeURIComponent(pr.repoId)}&id=${pr.id}${cacheBust}`
  );
}

function syncPrSummary(pr: PR, detail: Detail): void {
  if (detail.status !== undefined) {
    pr.status = detail.status;
    pr.isDraft = detail.isDraft ?? pr.isDraft;
    pr.reviewers = detail.reviewers || [];
    pr.myVote = detail.myVote || 0;
  }
  pr.iCommented = !!detail.iCommented;
}

// Render a fully-loaded PR into a slide-over modal.
function buildDetail(container: HTMLElement, pr: PR, detail: Detail): void {
  syncPrSummary(pr, detail);
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
    sendAll.textContent = "Preparing…";
    try {
      await sendPrToCopilot(pr, detail);
    } finally {
      sendAll.disabled = false;
      sendAll.textContent = orig;
    }
  });
  const refreshBtn = el(
    `<button class="btn ghost sm pr-refresh" title="Refresh this PR" aria-label="Refresh this pull request">` +
      `<span class="pr-refresh-icon" aria-hidden="true">⟳</span>` +
      `<span class="pr-refresh-label">Refresh</span></button>`
  ) as HTMLButtonElement;
  const refreshLabel = refreshBtn.querySelector<HTMLElement>(".pr-refresh-label")!;
  refreshBtn.addEventListener("click", async () => {
    if (refreshBtn.disabled) return;
    refreshBtn.disabled = true;
    refreshBtn.setAttribute("aria-busy", "true");
    refreshBtn.setAttribute("aria-label", "Refreshing this pull request");
    refreshLabel.textContent = "Refreshing…";
    const panel = container.closest<HTMLElement>(".modal-panel");
    const scrollTop = panel?.scrollTop || 0;
    try {
      const next = await fetchDetail(pr, true);
      if (!container.isConnected) return;
      stopReviewPoll();
      buildDetail(container, pr, next);
      window.dispatchEvent(new CustomEvent("ado-pr-updated"));
      requestAnimationFrame(() => {
        if (panel) panel.scrollTop = scrollTop;
      });
      toast("PR refreshed", "ok");
    } catch (e: any) {
      if (container.isConnected) toast("Refresh failed: " + e.message, "err");
      refreshBtn.disabled = false;
      refreshBtn.removeAttribute("aria-busy");
      refreshBtn.setAttribute("aria-label", "Refresh this pull request");
      refreshLabel.textContent = "Refresh";
    }
  });
  const rightGroup = el(`<div class="backbar-actions"></div>`);
  const closeBtn = el(`<button class="modal-close" title="Close (Esc)" aria-label="Close">✕</button>`);
  closeBtn.addEventListener("click", () => closeModal());
  rightGroup.appendChild(refreshBtn);
  rightGroup.appendChild(sendAll);
  rightGroup.appendChild(closeBtn);
  back.appendChild(backBtn);
  back.appendChild(rightGroup);
  head.appendChild(back);

  head.appendChild(el(`<div class="detail-title">${esc(pr.title)}</div>`));
  const sub = el(`<div class="detail-sub"></div>`);
  sub.appendChild(el(`<span class="id">#${pr.id}</span>`));
  // Lifecycle status comes from the freshly-loaded detail (authoritative), falling
  // back to the list payload's isDraft for the brief moment before detail arrives.
  const st = statusBadge({ status: detail.status, isDraft: detail.isDraft ?? pr.isDraft });
  if (st.cls !== "st-unknown") {
    sub.appendChild(el(`<span class="st-badge ${st.cls}">${st.label}</span>`));
  }
  sub.appendChild(el(`<span>${esc(pr.repo)} · ${esc(pr.project)}</span>`));
  sub.appendChild(el(`<span><code>${esc(pr.sourceRef)}</code> → <code>${esc(pr.targetRef)}</code></span>`));
  const link = el(`<button class="link-btn">Open in ADO ↗</button>`);
  link.addEventListener("click", () => window.open(pr.url, "_blank"));
  sub.appendChild(link);
  head.appendChild(sub);
  container.appendChild(head);

  // Reviewer strip: my own action first, then each named reviewer with their vote.
  const strip = buildReviewerStrip(detail);
  if (strip) container.appendChild(strip);

  // Sticky severity lights, pinned directly below the header (hidden until the
  // background review lands findings).
  container.appendChild(mountSeverityLights(pr));

  // Background-review result panel (populated async; polls while running).
  const revPanel = el(`<div class="rev-panel" hidden></div>`);
  container.appendChild(revPanel);
  refreshReviewPanel(pr, revPanel, refreshSeverityLights);

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

// The reviewer strip under the header: the current user's own action first (which
// can include "💬 Commented"), then every individual reviewer with their vote.
// Group/team reviewers (isContainer) are filtered out; those who cast a real vote
// sort ahead of no-vote reviewers. Returns null only when there is nothing to show.
function buildReviewerStrip(detail: Detail): HTMLElement | null {
  const all = (detail.reviewers || []).filter((r) => !r.isContainer);
  const voted = all.filter((r) => r.vote !== 0).sort((a, b) => b.vote - a.vote);
  const noVote = all.filter((r) => r.vote === 0);
  const ordered = [...voted, ...noVote];

  const mine = myActionBadge(detail.myVote || 0, detail.iCommented);
  if (!mine && ordered.length === 0) {
    return el(`<div class="reviewer-strip"><span class="rev-none">No reviewers yet</span></div>`);
  }

  const strip = el(`<div class="reviewer-strip"></div>`);
  if (mine) {
    strip.appendChild(el(`<span class="my-act ${mine.cls}">${mine.icon} ${mine.label}</span>`));
  }
  for (const r of ordered) {
    const v = voteBadge(r.vote);
    const req = r.isRequired ? '<span class="rev-req" title="Required reviewer">*</span>' : "";
    strip.appendChild(
      el(`<span class="reviewer ${v.cls}" title="${esc(v.label)}">${v.icon} ${esc(r.name)}${req}</span>`)
    );
  }
  return strip;
}
