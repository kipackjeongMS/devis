// The background-review result panel: fetches the stored review for a PR, keeps
// the list badge in sync, polls while running, and renders the semantic story +
// implementation summary. Findings are componentized as staged inline diff comments.
import { getJSON } from "./api.js";
import { el } from "./dom.js";
import { esc, timeAgo } from "./util.js";
import { state, scheduleReviewPoll } from "./state.js";
import { renderMarkdown } from "./markdown.js";
import { renderMermaid } from "./mermaid.js";
import type { PR, Review } from "./types.js";

// Populate (and, while running, poll) the background-review panel for one PR.
// Renders the semantic story + findings as markdown once a result exists.
export async function refreshReviewPanel(pr: PR, panel: HTMLElement): Promise<void> {
  let review: Review | null = null;
  try {
    const res = await getJSON("/api/review-result?prId=" + encodeURIComponent(pr.id));
    review = res.review;
  } catch {
    /* leave hidden on error */
  }

  // Keep the list badge in sync with what we just learned.
  if (review) state.reviews[String(pr.id)] = review;
  else delete state.reviews[String(pr.id)];

  if (!review || review.status === "pending") {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  if (review.status === "running") {
    panel.className = "rev-panel running";
    panel.innerHTML =
      '<div class="rev-head"><span class="spinner"></span> Copilot is reviewing this PR in the background…</div>' +
      '<div class="rev-note">Results will appear here automatically when the review completes.</div>';
    scheduleReviewPoll(() => refreshReviewPanel(pr, panel), 4000);
    return;
  }

  if (review.status === "error") {
    panel.className = "rev-panel error";
    panel.innerHTML =
      '<div class="rev-head">⚠ Background review failed</div>' +
      '<div class="rev-note">' + esc(review.error || "Unknown error.") + "</div>";
    return;
  }

  // status === "done"
  panel.className = "rev-panel done";
  panel.innerHTML = "";
  const header = el(
    '<div class="rev-head done"><span class="rev-chev">▼</span>' +
      '<span class="rev-title">✓ Copilot review</span>' +
      (review.summary ? '<span class="rev-summary">' + esc(review.summary) + "</span>" : "") +
      (review.updated_at ? '<span class="rev-when">' + esc(timeAgo(review.updated_at)) + "</span>" : "") +
      "</div>"
  );
  const body = el('<div class="rev-body"></div>');
  header.addEventListener("click", () => {
    panel.classList.toggle("collapsed");
    (header.querySelector(".rev-chev") as HTMLElement).textContent = panel.classList.contains("collapsed") ? "▶" : "▼";
  });
  if (review.story && review.story.trim()) {
    body.appendChild(el('<div class="rev-sub">Semantic story</div>'));
    const s = el('<div class="md"></div>');
    s.innerHTML = renderMarkdown(review.story);
    body.appendChild(s);
  }
  // Findings are componentized: each renders as a STAGED inline comment in the
  // diff below (with a per-comment Post button), not listed here.
  const staged = (review.findingsList || []).filter((f) => f && !f.posted);
  if (staged.length) {
    const n = staged.length;
    body.appendChild(
      el(
        '<div class="rev-staged-hint">✦ ' +
          n +
          " inline review comment" +
          (n === 1 ? "" : "s") +
          " staged in the diff below — expand a changed file to review and Post them.</div>"
      )
    );
  }
  panel.appendChild(header);
  panel.appendChild(body);
  renderMermaid(body);
}
