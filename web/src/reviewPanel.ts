// The background-review result panel: fetches the stored review for a PR, keeps
// the list badge in sync, polls while running, and renders the semantic story +
// implementation summary. Findings are componentized as staged inline diff comments.
import { getJSON, postJSON } from "./api.js";
import { toast } from "./toast.js";
import { reviewerChatSection } from "./reviewerChat.js";
import { el } from "./dom.js";
import { esc, timeAgo } from "./util.js";
import { state, scheduleReviewPoll } from "./state.js";
import { renderMarkdown } from "./markdown.js";
import { renderMermaid } from "./mermaid.js";
import { openRephraseModal } from "./rephraseModal.js";
import type { PR, Review, SemanticFinding } from "./types.js";
import { reviewStateKey } from "./reviewKey.js";
import { refreshSeverityLights } from "./severityLights.js";
import { icon } from "./icons.js";
import type { RevealableFile } from "./reveal.js";

const SEMANTIC_SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function semanticCategoryLabel(category: string): string {
  return category.replace(/^\w/, (value) => value.toUpperCase());
}

function semanticFindingCard(pr: PR, finding: SemanticFinding): HTMLElement {
  const severity = finding.severity.toLowerCase();
  const card = el(
    `<article class="semantic-finding sev-${esc(severity)}">
       <div class="semantic-finding-head">
         <span class="semantic-category">${esc(semanticCategoryLabel(finding.category))}</span>
         <span class="semantic-severity">${esc(finding.severity)}</span>
         <strong>${esc(finding.title)}</strong>
       </div>
       <div class="semantic-comment md"></div>
       <div class="semantic-files"></div>
       <div class="semantic-actions">
         <button class="btn sm semantic-post">${finding.posted ? "Posted" : "Post to ADO"}</button>
       </div>
     </article>`
  );
  card.setAttribute("data-semantic-finding-id", finding.id);
  const comment = card.querySelector(".semantic-comment") as HTMLElement;
  comment.innerHTML = renderMarkdown(finding.comment);
  const files = card.querySelector(".semantic-files") as HTMLElement;
  for (const file of finding.files || []) {
    files.appendChild(el(`<code>${esc(file)}</code>`));
  }

  const postButton = card.querySelector(".semantic-post") as HTMLButtonElement;
  postButton.disabled = !!finding.posted;
  if (finding.posted) card.classList.add("posted");
  postButton.addEventListener("click", () => {
    if (postButton.disabled) return;
    openRephraseModal({
      title: finding.title,
      comment: finding.comment,
      semanticFindingId: finding.id,
      initialText: finding.humanizedComment ?? finding.comment,
      loc: `${semanticCategoryLabel(finding.category)} · PR-level`,
      model: state.config.reviewModel,
      prId: pr.id,
      org: pr.org,
      project: pr.project,
      repoId: pr.repoId,
      onHumanized: (text) => {
        finding.humanizedComment = text;
      },
      onPost: async (text) => {
        await postJSON("/api/review/post-semantic-finding", {
          org: pr.org,
          project: pr.project,
          repoId: pr.repoId,
          prId: pr.id,
          semanticFindingId: finding.id,
          content: text,
        });
        finding.posted = true;
        refreshSeverityLights();
        card.classList.add("posted");
        postButton.disabled = true;
        postButton.textContent = "Posted";
      },
    });
  });
  return card;
}

// Poll again only while the panel is still on the page; a closed or replaced
// pane leaves nothing to update.
function schedulePanelPoll(pr: PR, panel: HTMLElement, onUpdate?: () => void): void {
  scheduleReviewPoll(() => {
    if (panel.isConnected) void refreshReviewPanel(pr, panel, onUpdate);
  }, 4000);
}

// Populate (and, while running, poll) the background-review panel for one PR.
// Renders the semantic story + findings as markdown once a result exists.
// `onUpdate` fires after every refresh (including polls), so dependent UI such
// as the severity lights can re-read the findings.
export async function refreshReviewPanel(
  pr: PR,
  panel: HTMLElement,
  onUpdate?: () => void
): Promise<void> {
  let review: Review | null = null;
  try {
    const query = new URLSearchParams({
      prId: String(pr.id),
      org: pr.org,
      project: pr.project,
      repoId: pr.repoId,
    });
    const res = await getJSON("/api/review-result?" + query.toString());
    review = res.review;
  } catch {
    /* leave hidden on error */
  }

  // Keep the list badge in sync with what we just learned.
  const stateKey = reviewStateKey(pr);
  if (review) state.reviews[stateKey] = review;
  else delete state.reviews[stateKey];
  if (onUpdate) onUpdate();

  if (!review || review.status === "pending") {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  if (review.status === "queued") {
    // Polls land here every few seconds; rewrite only on a change so focus and the DOM stay put.
    if (panel.className !== "rev-panel queued") {
      panel.className = "rev-panel queued";
      panel.innerHTML =
        '<div class="rev-head">' + icon("clock") + 'Review queued</div>' +
        '<div class="rev-note">Waiting for an independent reviewer session to become available.</div>';
    }
    schedulePanelPoll(pr, panel, onUpdate);
    return;
  }

  if (review.status === "running") {
    // Rewriting on every poll would restart the spinner mid-turn.
    if (panel.className !== "rev-panel running") {
      panel.className = "rev-panel running";
      panel.innerHTML =
        '<div class="rev-head"><span class="spinner"></span> Copilot is reviewing this PR in the background…</div>' +
        '<div class="rev-note">Results will appear here automatically when the review completes.</div>';
    }
    schedulePanelPoll(pr, panel, onUpdate);
    return;
  }

  if (review.status === "error") {
    panel.className = "rev-panel error";
    panel.innerHTML =
      '<div class="rev-head">' + icon("warning") + 'Background review failed</div>' +
      '<div class="rev-note">' + esc(review.error || "Unknown error.") + "</div>";
    return;
  }

  // status === "done"
  // A refresh of an already-shown review (e.g. the reviewer chat staged more
  // findings) keeps the open chat element and the collapsed state.
  const keepCollapsed = panel.classList.contains("done") && panel.classList.contains("collapsed");
  const liveChat = panel.querySelector<HTMLElement>(".rev-chat");
  const chat =
    liveChat && review.reviewer_session_id && liveChat.dataset.session === review.reviewer_session_id
      ? liveChat
      : null;
  // Re-attaching the chat drops its log scroll and input focus; restore both.
  const chatLog = chat?.querySelector<HTMLElement>(".rev-chat-log") ?? null;
  const chatScroll = chatLog?.scrollTop ?? 0;
  const chatFocus =
    chat && document.activeElement instanceof HTMLElement && chat.contains(document.activeElement)
      ? document.activeElement
      : null;
  const chatCaret =
    chatFocus instanceof HTMLTextAreaElement ? [chatFocus.selectionStart, chatFocus.selectionEnd] : null;
  panel.className = "rev-panel done" + (keepCollapsed ? " collapsed" : "");
  panel.innerHTML = "";
  const header = el(
    '<div class="rev-head done"><button type="button" class="rev-toggle" aria-expanded="' + String(!keepCollapsed) + '">' +
      '<span class="rev-chev" aria-hidden="true">' + icon("chevron") + "</span>" +
      '<span class="rev-title">' + icon("sparkle") + "Copilot review</span></button>" +
      (review.summary ? '<span class="rev-summary">' + esc(review.summary) + "</span>" : "") +
      (review.updated_at ? '<span class="rev-when">' + esc(timeAgo(review.updated_at)) + "</span>" : "") +
      "</div>"
  );
  // The session that produced this review — Elaborate, Rephrase, and the
  // reviewer chat resume it, and "Open in terminal" hands it to the CLI.
  if (review.reviewer_session_id) {
    const id = review.reviewer_session_id;
    const chip = el(
      '<button class="rev-session" title="Reviewed in Copilot session ' +
        esc(id) +
        ' — click to copy the id">' + icon("copy") +
        esc(id.slice(0, 8)) +
        "</button>"
    ) as HTMLButtonElement;
    chip.addEventListener("click", (e) => {
      e.stopPropagation(); // don't collapse the panel
      void navigator.clipboard?.writeText(id).then(
        () => {
          chip.classList.add("copied");
          setTimeout(() => chip.classList.remove("copied"), 1200);
        },
        () => undefined
      );
    });
    header.appendChild(chip);
  }

  const body = el('<div class="rev-body"></div>');
  header.addEventListener("click", () => {
    panel.classList.toggle("collapsed");
    header.querySelector(".rev-toggle")?.setAttribute("aria-expanded", String(!panel.classList.contains("collapsed")));
  });

  // Opt-in: save this review as a markdown record in the configured folder.
  const actions = el('<div class="rev-actions"></div>');
  const saveBtn = el('<button class="btn sm rev-save">Save as .md</button>') as HTMLButtonElement;
  const saveStatus = el('<span class="rev-save-status"></span>');
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    saveStatus.className = "rev-save-status";
    saveStatus.textContent = "Saving…";
    try {
      const r = await postJSON("/api/review-md", {
        prId: pr.id,
        org: pr.org,
        project: pr.project,
        repoId: pr.repoId,
      });
      if (r.saved) {
        saveStatus.classList.add("ok");
        saveStatus.textContent = "Saved";
        if (r.path) saveStatus.title = r.path;
      } else {
        saveStatus.classList.add("warn");
        saveStatus.textContent =
          r.reason === "disabled"
            ? "Set a Reviews folder in Settings first"
            : r.reason === "empty"
              ? "Nothing to save yet"
              : "Save failed";
      }
    } catch (e) {
      saveStatus.classList.add("warn");
      saveStatus.textContent = (e as Error).message || "Save failed";
    } finally {
      saveBtn.disabled = false;
    }
  });
  actions.appendChild(saveBtn);
  if (review.reviewer_session_id) {
    const terminalBtn = el(
      '<button class="btn sm ghost rev-terminal" title="Continue this review session in the Copilot CLI">Open in terminal</button>'
    ) as HTMLButtonElement;
    terminalBtn.addEventListener("click", async () => {
      terminalBtn.disabled = true;
      try {
        await postJSON("/api/reviewer-terminal", {
          prId: pr.id,
          org: pr.org,
          project: pr.project,
          repoId: pr.repoId,
        });
        toast("Opened the reviewer session in a terminal. Close it there before chatting here.", "ok");
      } catch (e) {
        toast("Could not open the terminal: " + (e as Error).message, "err");
      } finally {
        terminalBtn.disabled = false;
      }
    });
    actions.appendChild(terminalBtn);
  }
  actions.appendChild(saveStatus);
  body.appendChild(actions);

  if (review.story && review.story.trim()) {
    body.appendChild(el('<div class="rev-sub">Semantic story</div>'));
    const s = el('<div class="md"></div>');
    s.innerHTML = renderMarkdown(review.story);
    body.appendChild(s);
  }
  const semanticFindings = [...(review.semanticFindingsList || [])].sort(
    (a, b) =>
      (SEMANTIC_SEVERITY_RANK[a.severity] ?? 4) -
      (SEMANTIC_SEVERITY_RANK[b.severity] ?? 4)
  );
  if (semanticFindings.length) {
    body.appendChild(el('<div class="rev-sub">High-level semantic findings</div>'));
    const findings = el('<div class="semantic-findings"></div>');
    for (const finding of semanticFindings) {
      findings.appendChild(semanticFindingCard(pr, finding));
    }
    body.appendChild(findings);
  }
  // Findings are componentized: each renders as a STAGED inline comment in the
  // diff below (with a per-comment Post button), not listed here.
  const staged = (review.findingsList || []).filter((f) => f && !f.posted);
  if (staged.length) {
    const n = staged.length;
    body.appendChild(
      el(
        '<div class="rev-staged-hint">' + icon("sparkle") +
          n +
          " inline review comment" +
          (n === 1 ? "" : "s") +
          " staged in the diff below — expand a changed file to review and Post them.</div>"
      )
    );
  }
  if (review.reviewer_session_id) {
    body.appendChild(
      chat ||
        reviewerChatSection(pr, review.reviewer_session_id, () => refreshReviewPanel(pr, panel, onUpdate))
    );
  }
  panel.appendChild(header);
  panel.appendChild(body);
  if (chatLog) chatLog.scrollTop = chatScroll;
  if (chatFocus) {
    chatFocus.focus({ preventScroll: true });
    if (chatCaret && chatFocus instanceof HTMLTextAreaElement) chatFocus.setSelectionRange(chatCaret[0], chatCaret[1]);
  }
  renderMermaid(body, true);
  // Loaded diffs show findings staged since they rendered.
  panel.parentElement
    ?.querySelectorAll<RevealableFile>(".file[data-path]")
    .forEach((file) => file._refreshStaged?.());
}
