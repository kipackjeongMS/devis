// PR detail view: loads a PR's detail payload and renders it in the docked
// reading pane (header + command bar + section tabs, review panel, description,
// discussion threads, changed files). The queue stays mounted beside it.
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
import { openPane, closePane } from "./readingPane.js";
import { mountSectionNav, type PaneSection } from "./sectionNav.js";
import { icon } from "./icons.js";
import { requestNotifyPermission } from "./notifyWatch.js";
import { toast } from "./toast.js";
import type { PR, Detail, Thread } from "./types.js";
import { statusBadge, voteBadge, myActionBadge } from "./prStatus.js";
import { mountPrComments, unmountPrComments } from "./prComments.js";
import { hydratePrDescriptionImages } from "./prDescriptionImages.js";
import { closePrActionMenu, mountDecisionMenu, mountLifecycleMenu } from "./prActions.js";

// Closing the reading pane: stop the review poll and drop the current selection.
function onDetailClose(): void {
  stopReviewPoll();
  unmountSeverityLights();
  unmountPrComments();
  closePrActionMenu();
  state.current = undefined;
  window.dispatchEvent(new CustomEvent("ado-pr-open", { detail: null }));
}

export async function openDetail(pr: PR): Promise<void> {
  // Switching PRs replaces the pane silently, so release the previous PR's
  // drawers and menus here rather than in onDetailClose.
  stopReviewPoll();
  unmountSeverityLights();
  unmountPrComments();
  closePrActionMenu();
  const container = el(
    `<div class="detail-view"><div class="loading"><span class="spinner"></span> Loading PR #${pr.id}…</div></div>`
  );
  openPane(container, { onClose: onDetailClose, label: `Pull request ${pr.id}` });
  window.dispatchEvent(new CustomEvent("ado-pr-open", { detail: pr }));
  let detail: Detail;
  try {
    detail = await fetchDetail(pr);
  } catch (e: any) {
    if (!container.isConnected) return; // pane was closed/replaced mid-fetch
    container.innerHTML = `<div class="empty">Failed to load PR: ${esc(e.message)}</div>`;
    return;
  }
  if (!container.isConnected) return; // pane was closed/replaced mid-fetch
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

// Render a fully-loaded PR into the reading pane.
function buildDetail(container: HTMLElement, pr: PR, detail: Detail): void {
  syncPrSummary(pr, detail);
  closePrActionMenu();
  state.current = { pr, detail };
  container.innerHTML = "";

  // Re-fetch and re-render in place, keeping the pane's scroll position.
  const reload = async (): Promise<void> => {
    const panel = container.closest<HTMLElement>(".pane-scroll");
    const scrollTop = panel?.scrollTop || 0;
    const next = await fetchDetail(pr, true);
    if (!container.isConnected) return;
    stopReviewPoll();
    buildDetail(container, pr, next);
    window.dispatchEvent(new CustomEvent("ado-pr-updated"));
    requestAnimationFrame(() => {
      if (panel) panel.scrollTop = scrollTop;
    });
  };
  const reloadAfterAction = (): void => {
    reload().catch((e: any) => toast("Refresh failed: " + e.message, "err"));
  };

  const head = el(`<header class="detail-head"></header>`);
  // Only shown when the pane is stacked over the queue (narrow windows).
  const backBtn = el(
    `<button type="button" class="pane-back" title="Back to pull requests" aria-label="Back to pull requests">${icon("back")}</button>`
  );
  backBtn.addEventListener("click", () => closePane());
  const sendAll = el(
    `<button type="button" class="detail-icon-btn copilot-review-btn"
             title="Review PR with Copilot" aria-label="Review this pull request with Copilot">
       <svg class="stroke-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
         <path d="M8 6.5 12 4l4 2.5 3.5-.8 1.2 5.1-1.9 2.5v3.4L15.5 20h-7l-3.3-3.3v-3.4l-1.9-2.5 1.2-5.1z"></path>
         <circle cx="9" cy="11.5" r="1" fill="currentColor" stroke="none"></circle>
         <circle cx="15" cy="11.5" r="1" fill="currentColor" stroke="none"></circle>
         <path d="M8.5 16c2.2 1.3 4.8 1.3 7 0"></path>
       </svg>
     </button>`
  ) as HTMLButtonElement;
  sendAll.addEventListener("click", async () => {
    if (sendAll.disabled) return;
    requestNotifyPermission(); // within the user gesture, so the host honors it
    sendAll.disabled = true;
    sendAll.setAttribute("aria-busy", "true");
    sendAll.setAttribute("aria-label", "Preparing Copilot review");
    try {
      await sendPrToCopilot(pr, detail);
    } finally {
      sendAll.disabled = false;
      sendAll.removeAttribute("aria-busy");
      sendAll.setAttribute("aria-label", "Review this pull request with Copilot");
    }
  });
  const refreshBtn = el(
    `<button type="button" class="detail-icon-btn pr-refresh"
             title="Refresh this PR" aria-label="Refresh this pull request">
       <svg class="pr-refresh-icon stroke-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
         <path d="M20 7v5h-5"></path>
         <path d="M19 12a7 7 0 1 0-2 5"></path>
       </svg>
     </button>`
  ) as HTMLButtonElement;
  refreshBtn.addEventListener("click", async () => {
    if (refreshBtn.disabled) return;
    refreshBtn.disabled = true;
    refreshBtn.setAttribute("aria-busy", "true");
    refreshBtn.setAttribute("aria-label", "Refreshing this pull request");
    try {
      await reload();
      toast("PR refreshed", "ok");
    } catch (e: any) {
      if (container.isConnected) toast("Refresh failed: " + e.message, "err");
      refreshBtn.disabled = false;
      refreshBtn.removeAttribute("aria-busy");
      refreshBtn.setAttribute("aria-label", "Refresh this pull request");
    }
  });
  const sub = el(`<div class="detail-bar"></div>`);
  sub.appendChild(backBtn);
  sub.appendChild(el(`<h2 class="detail-title">${esc(pr.title)}</h2>`));
  const actions = el(`<span class="detail-sub-actions"></span>`);
  const decisionBtn = mountDecisionMenu(pr, detail, reloadAfterAction);
  const lifecycleBtn = mountLifecycleMenu(pr, detail, reloadAfterAction);
  actions.appendChild(decisionBtn);
  actions.appendChild(lifecycleBtn);
  actions.appendChild(sendAll);
  actions.appendChild(refreshBtn);
  const adoLink = el<HTMLButtonElement>(
    `<button type="button" class="detail-icon-btn ado-icon-btn"
             title="Open in Azure DevOps" aria-label="Open this pull request in Azure DevOps">
       <svg viewBox="0 0 24 24" aria-hidden="true">
         <path d="M2.5 6.3 6 2.8l11.2 4V4l4.3 4.2v10.4l-10.7 2.6v-3.1l-4.8-1.4v2.1l-3.5-3.4zm3.5 8 4.8 1.1V9.1L6 10.6zm6.8 1.6 4.4-1.1V9.2l-4.4 1.4z"></path>
       </svg>
     </button>`
  );
  adoLink.addEventListener("click", () => window.open(pr.url, "_blank", "noopener"));
  actions.appendChild(adoLink);
  actions.appendChild(mountPrComments(pr, detail.threads));
  sub.appendChild(actions);
  head.appendChild(sub);

  const meta = el(`<div class="detail-sub"></div>`);
  const identity = el(`<span class="detail-id-group"></span>`);
  identity.appendChild(el(`<span class="id">#${pr.id}</span>`));
  // Lifecycle status comes from the freshly-loaded detail (authoritative), falling
  // back to the list payload's isDraft for the brief moment before detail arrives.
  const st = statusBadge({ status: detail.status, isDraft: detail.isDraft ?? pr.isDraft });
  if (st.cls !== "st-unknown") {
    identity.appendChild(el(`<span class="st-badge ${st.cls}">${st.label}</span>`));
  }
  identity.appendChild(mountSeverityLights(pr));
  meta.appendChild(identity);
  meta.appendChild(el(`<span class="detail-repo">${esc(pr.repo)} · ${esc(pr.project)}</span>`));
  meta.appendChild(
    el(
      `<span class="detail-branch" title="${esc(pr.sourceRef)} into ${esc(pr.targetRef)}">` +
        `<code>${esc(pr.sourceRef)}</code><span class="branch-arrow" aria-label="into">→</span><code>${esc(pr.targetRef)}</code></span>`
    )
  );
  head.appendChild(meta);
  container.appendChild(head);

  // Reviewer strip: my own action first, then each named reviewer with their vote.
  const strip = buildReviewerStrip(detail);
  if (strip) container.appendChild(strip);

  const sections: PaneSection[] = [];

  // Background-review result panel (populated async; polls while running).
  const revPanel = el(`<div class="rev-panel" hidden></div>`);
  container.appendChild(revPanel);
  refreshReviewPanel(pr, revPanel, refreshSeverityLights);
  sections.push({ label: "Review", target: revPanel });

  // PR description rendered as a lightweight markdown preview.
  if (detail.description && detail.description.trim()) {
    const section = paneSection("Description");
    const desc = el(`<div class="pr-desc md"></div>`);
    desc.innerHTML = renderMarkdown(detail.description);
    hydratePrDescriptionImages(desc, pr.org);
    section.appendChild(desc);
    container.appendChild(section);
    renderMermaid(desc);
    sections.push({ label: "Description", target: section });
  }

  // General (non-file) threads
  const general = detail.threads.filter((t) => !t.filePath);
  if (general.length) {
    const section = paneSection("Discussion", general.length);
    for (const t of general) section.appendChild(renderThread(pr, t));
    container.appendChild(section);
    sections.push({ label: "Discussion", count: general.length, target: section });
  }

  // Files
  const files = paneSection("Changed files", detail.files.length);
  const threadsByFile = new Map<string, Thread[]>();
  for (const t of detail.threads) {
    if (!t.filePath) continue;
    if (!threadsByFile.has(t.filePath)) threadsByFile.set(t.filePath, []);
    threadsByFile.get(t.filePath)!.push(t);
  }
  for (const f of detail.files) {
    files.appendChild(renderFile(pr, detail, f, threadsByFile.get(f.path) || []));
  }
  container.appendChild(files);
  sections.push({ label: "Files", count: detail.files.length, target: files });

  mountSectionNav(head, sections);
}

function paneSection(title: string, count?: number): HTMLElement {
  const n = count != null ? `<span class="section-count">${count}</span>` : "";
  return el(`<section class="pane-section"><h3 class="section-title">${esc(title)}${n}</h3></section>`);
}

// "Ada Lovelace" -> "AL"; ADO prefixes such as "[org]\" are ignored.
function initials(name: string): string {
  const words = name.replace(/^\[[^\]]*\]\\?/, "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = words[0][0] || "";
  const last = words.length > 1 ? words[words.length - 1][0] || "" : "";
  return (first + last).toUpperCase();
}

// The reviewer strip under the header: the current user's own action first (which
// can include "You commented"), then every individual reviewer as a persona chip
// whose presence badge shows their vote. Group/team reviewers (isContainer) are
// filtered out; those who cast a real vote sort ahead of no-vote reviewers.
function buildReviewerStrip(detail: Detail): HTMLElement | null {
  const all = (detail.reviewers || []).filter((r) => !r.isContainer);
  const voted = all.filter((r) => r.vote !== 0).sort((a, b) => b.vote - a.vote);
  const noVote = all.filter((r) => r.vote === 0);
  const ordered = [...voted, ...noVote];

  const mine = myActionBadge(detail.myVote || 0, detail.iCommented);
  if (!mine && ordered.length === 0) {
    return el(`<div class="reviewer-strip"><span class="rev-none">No reviewers yet</span></div>`);
  }

  const strip = el(`<div class="reviewer-strip" role="list" aria-label="Reviewers"></div>`);
  if (mine) {
    strip.appendChild(el(`<span class="my-act ${mine.cls}" role="listitem">${icon(mine.icon)}${mine.label}</span>`));
  }
  for (const r of ordered) {
    const v = voteBadge(r.vote);
    const req = r.isRequired ? '<span class="rev-req" title="Required reviewer">Required</span>' : "";
    strip.appendChild(
      el(
        `<span class="reviewer ${v.cls}" role="listitem" title="${esc(r.name)}: ${esc(v.label)}">` +
          `<span class="persona" aria-hidden="true">${esc(initials(r.name))}<span class="presence">${icon(v.icon)}</span></span>` +
          `<span class="reviewer-name">${esc(r.name)}</span>` +
          `<span class="visually-hidden">, ${esc(v.label)}</span>${req}</span>`
      )
    );
  }
  return strip;
}