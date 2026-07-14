// The Copilot bridge: turns a PR + its diffs + comments into a background-review
// prompt and sends it into the CLI session via POST /api/bridge.
import { getJSON, postJSON } from "./api.js";
import { toast } from "./toast.js";
import { state } from "./state.js";
import { refreshReviewPanel } from "./reviewPanel.js";
import { markTriggered } from "./notify.js";
import { startNotifyWatch } from "./notifyWatch.js";
import type { PR, Detail, FileChange, Diff, Thread } from "./types.js";

export function diffToText(diff: Diff | null | undefined): string {
  if (!diff) return "(diff unavailable)";
  if (diff.tooLarge) return `(file too large to diff inline: ${diff.oldCount}→${diff.newCount} lines — see it in ADO)`;
  if (!diff.hunks) return "(no textual changes)";
  const out: string[] = [];
  // Each line is prefixed with its anchor: R<n> = right/new side (use side='right'),
  // L<n> = left/old side (use side='left'). This lets the reviewer anchor findings.
  diff.hunks.forEach((h, i) => {
    if (i > 0) out.push("       ⋯");
    for (const ln of h) {
      if (ln.t === "add") out.push(`R${ln.nn}: + ${ln.text}`);
      else if (ln.t === "del") out.push(`L${ln.o}: - ${ln.text}`);
      else out.push(`R${ln.nn}:   ${ln.text}`);
    }
  });
  return out.join("\n") || "(no textual changes)";
}

// Fetch+cache a file's diff if it wasn't already loaded from the user opening it in the UI.
export async function ensureDiff(pr: PR, detail: Detail, file: FileChange): Promise<Diff> {
  if (file._diff) return file._diff;
  try {
    const diff = await getJSON(
      `/api/diff?org=${encodeURIComponent(pr.org)}&project=${encodeURIComponent(pr.project)}` +
        `&repoId=${encodeURIComponent(pr.repoId)}&path=${encodeURIComponent(file.path)}` +
        `&src=${detail.commits.source || ""}&base=${detail.commits.base || ""}` +
        `&changeType=${encodeURIComponent(file.changeType)}`
    );
    file._diff = diff;
    return diff;
  } catch (e: any) {
    return { _error: e.message };
  }
}

// Pinned (file/line-anchored) comments are flagged distinctly from general/PR-level ones.
export function threadToText(t: Thread): string {
  const loc = t.filePath
    ? `📌 ${t.filePath}${t.line ? ":" + (t.endLine && t.endLine !== t.line ? t.line + "-" + t.endLine : t.line) : ""}`
    : "General (not pinned to a file/line)";
  const cmts = t.comments.map((c) => `    - ${c.author}: ${c.content}`).join("\n");
  return `  [${loc}] (${t.status})\n${cmts}`;
}

export async function sendPrToCopilot(pr: PR, detail: Detail): Promise<void> {
  const lines: string[] = [];
  lines.push(`# Azure DevOps PR #${pr.id}: ${pr.title}`);
  lines.push(`Repo: ${pr.repo} (${pr.project}, org ${pr.org})`);
  lines.push(`Branch: ${pr.sourceRef} → ${pr.targetRef}`);
  lines.push(`Author: ${pr.author}`);
  lines.push(`Status: ${pr.isDraft ? "Draft" : "Active"}`);
  lines.push(`URL: ${pr.url}`);
  if (detail.description && detail.description.trim()) {
    lines.push("");
    lines.push("## Description");
    lines.push(detail.description.trim());
  }

  lines.push("");
  lines.push(`## Changed files (${detail.files.length}) with diffs`);
  lines.push("Each diff line is prefixed with its anchor: `R<n>` = right/new side (side='right'), `L<n>` = left/old side (side='left'). Use these exact numbers + the exact file path when anchoring findings.");
  for (const f of detail.files) {
    lines.push("");
    lines.push(`### ${f.changeType}: ${f.path}`);
    const diff = await ensureDiff(pr, detail, f);
    const text = diff && diff._error ? `(diff unavailable: ${diff._error})` : diffToText(diff);
    lines.push("```diff");
    lines.push(text);
    lines.push("```");
  }

  const threads = detail.threads;
  if (threads.length) {
    lines.push("");
    lines.push(`## Comments (${threads.length} threads — 📌 = pinned to a file/line, otherwise general/PR-level)`);
    for (const t of threads) lines.push(threadToText(t));
  }

  const callbackUrl = window.location.origin + "/api/review-result";

  // Optimistically mark this PR "running" so the canvas shows a badge immediately.
  postJSON("/api/review-result", {
    prId: String(pr.id),
    org: pr.org,
    project: pr.project,
    repo: pr.repo,
    title: pr.title,
    status: "running",
  }).catch(() => {});
  if (state.reviews) state.reviews[String(pr.id)] = { pr_id: String(pr.id), status: "running" };
  // Watch for this review's completion so we can notify when it finishes (see
  // notifyWatch). Only this session watches the reviews it launched.
  markTriggered(String(pr.id));
  startNotifyWatch();
  // If this PR's detail modal is on screen, show the running state right away.
  const panelEl = document.querySelector(".rev-panel") as HTMLElement | null;
  if (panelEl && state.current && state.current.pr && String(state.current.pr.id) === String(pr.id)) {
    refreshReviewPanel(pr, panelEl);
  }

  const reviewModel = state.config.reviewModel || "";
  const modelNote = reviewModel
    ? ` Use model='${reviewModel}' for the forked session.`
    : "";

  lines.push("");
  lines.push("---");
  lines.push("IMPORTANT: Run this review in the BACKGROUND — do NOT perform it in this chat.");
  lines.push("1. Call `fork_session` (omit `to_event_id`, so it forks at the latest turn) to create a separate chat session that contains a copy of this conversation, including the full PR content above." + modelNote);
  lines.push("2. Call `send_session_message` targeting that new forked session's ID with this exact message:");
  lines.push("   \"Please review the Azure DevOps PR above thoroughly using a multi-agent approach:");
  lines.push("   1. Write the semantic 'story' of this change: in plain English, what is this PR actually doing, why (the underlying problem/motivation), and how do the changed files work together to accomplish it? Then add a SHORT '## What changed' implementation summary — just a few brief bullets (what changed / why / notable decisions). Keep the WHOLE story compact and scannable (Markdown bullets, no wall-of-text). Where a code flow, control/data path, sequence of calls, or a structural relationship aids comprehension, include a small valid Mermaid diagram in a ```mermaid fenced block (`flowchart TD` for flows/structure, `sequenceDiagram` for interactions; <=~12 nodes, syntactically valid). Do NOT list individual issues/findings in the story — those go ONLY in the structured findings array below.");
  lines.push("   2. Dispatch one agent to review the PR in depth using the `code-review-and-quality` skill (correctness, readability, architecture, security, performance). Produce EVERY commentable item as a discrete structured finding anchored to a specific file + line — this includes not just bugs/security/correctness/perf/readability issues but ALSO nits, typos/misspellings, and indentation/style. Each finding needs: file (the EXACT path from '## Changed files' above), line (the R<n> or L<n> number shown on the relevant diff line), side ('right' for R / 'left' for L), optional endLine for a range, severity ('high'|'medium'|'low'|'nit'), and comment (a concise, actionable review comment — what's wrong and the suggested fix). Anchor to the changed line the comment is about.");
  lines.push("   3. Check whether related PRs or branches exist in this repo or other repos (e.g. a companion/dependent change, an earlier version of this PR, or a linked service). If any are found, cross-review this PR against them for consistency and add any resulting findings to the array.");
  lines.push("   4. IMPORTANT — when the review is complete, publish the result back to the ADO DevOps canvas so it renders there, by POSTing a JSON body to " + callbackUrl + " using your `powershell` tool. Shape: { prId, status, summary, story, findings }. Set status='done'; summary=a <=140-char one-line verdict; story=the semantic story + '## What changed' bullets (Markdown, may include ```mermaid); findings=a JSON ARRAY of finding objects { file, line, side, endLine?, severity, comment } — one per commentable item (issues AND nits/typos/indentation). Build it safely so newlines/quotes survive, e.g. `$findings = @(@{ file='/src/foo.ts'; line=42; side='right'; severity='nit'; comment='Typo: \"recieve\" -> \"receive\".' }, @{ file='/src/bar.ts'; line=88; side='right'; severity='high'; comment='Possible null deref when the list is empty.' }); $body = @{ prId='" + pr.id + "'; status='done'; summary='…'; story=$storyText; findings=$findings } | ConvertTo-Json -Depth 8; Invoke-RestMethod -Uri '" + callbackUrl + "' -Method Post -ContentType 'application/json' -Body $body`. Always emit findings as an ARRAY even if there is only one (wrap in @( )). If there are genuinely no commentable items, send findings=@(). If the review fails, POST { prId:'" + pr.id + "', status:'error', error:'<message>' } instead.");
  lines.push("   5. Do NOT post anything to Azure DevOps. The canvas STAGES each finding as an inline comment in the PR diff, and the human posts the ones they want via a per-comment Post button. Your job ends at publishing the JSON to the canvas.\"");
  lines.push("3. Back in THIS chat, reply with ONLY a one-line acknowledgment (e.g. \"🔍 Started background review for PR #" + pr.id + "; results will appear in the canvas when done.\"). Do NOT narrate, summarize, or perform any part of the actual review here.");
  await bridge(lines.join("\n"), `PR #${pr.id} sent to Copilot (background)`);
}

export async function bridge(prompt: string, okMsg?: string): Promise<void> {
  try {
    await postJSON("/api/bridge", { prompt });
    toast(okMsg || "Sent to Copilot", "ok");
  } catch (e: any) {
    toast("Bridge failed: " + e.message, "err");
  }
}
