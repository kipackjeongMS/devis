// "Ask Copilot about this selection": a self-contained dialog (its own overlay so
// it stacks above the PR-detail slide-over) that sends the selected code + a
// question to Copilot and renders the answer back in place.
//
// The server answers in one of two places and fills the entry polled via
// /api/ask-result:
//   - default: a throwaway headless Copilot session.
//   - Elaborate on a finding whose review recorded a reviewer session: the
//     server resumes that session, which already holds the PR context.
import { el } from "./dom.js";
import { icon } from "./icons.js";
import { esc } from "./util.js";
import { postJSON, getJSON } from "./api.js";
import { toast } from "./toast.js";
import { renderMarkdown } from "./markdown.js";
import { renderMermaid } from "./mermaid.js";
import type { PR, FileChange, Finding } from "./types.js";
import type { DiffSelection } from "./selection.js";

const POLL_MS = 2000;
// A fresh session has to start before it answers; the server gives up at 3 min.
const MAX_POLLS = 100; // ~3.3 min
// Resuming the reviewer session replays its history before it answers, so give
// that path a longer budget than a live in-session reply.
const MAX_POLLS_REVIEWER = 150; // ~5 min

function newAskId(): string {
  const c = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}

const ANSWER_INSTRUCTIONS =
  "Answer concisely and directly in Markdown (you may use a small ```mermaid fenced diagram " +
  "if it genuinely aids understanding). Output only the answer — no preamble, no restatement of the question.";
// The selected code travels as a `selection` attachment (see buildAskAttachment)
// instead of being inlined here, so the prompt just references it.
function buildAskPrompt(
  pr: PR,
  file: FileChange,
  sel: DiffSelection,
  question: string
): string {
  const { side, startLine, endLine } = sel.anchor;
  const loc = endLine > startLine ? `${startLine}–${endLine}` : `${startLine}`;
  return [
    `The user is asking a question about a specific part of Azure DevOps PR #${pr.id} ("${pr.title}").`,
    ``,
    `File: ${file.path}`,
    `Lines: ${loc} (${side} side) — see the attached code selection for the exact snippet.`,
    ``,
    `Question: ${question}`,
    ``,
    ANSWER_INSTRUCTIONS,
  ].join("\n");
}

// Prompt for the Elaborate flow: hands the agent the staged AI comment and its
// location and asks for a deeper explanation.
function buildElaboratePrompt(
  pr: PR,
  file: FileChange,
  finding: Finding,
  question: string
): string {
  return [
    `The user wants a deeper explanation of an AI-generated code review comment on Azure DevOps PR #${pr.id} ("${pr.title}").`,
    ``,
    ...elaborateContext(file, finding),
    ``,
    `The user's follow-up: ${question}`,
    ``,
    ANSWER_INSTRUCTIONS,
  ].join("\n");
}

// Same request, addressed to the session that actually produced the review. It
// already holds the diffs and the reasoning behind the comment.
function buildReviewerElaboratePrompt(
  pr: PR,
  file: FileChange,
  finding: Finding,
  question: string
): string {
  return [
    `You previously reviewed Azure DevOps PR #${pr.id} ("${pr.title}") and staged this review comment:`,
    ``,
    ...elaborateContext(file, finding),
    ``,
    `The user's follow-up: ${question}`,
    ``,
    "Answer concisely and directly in Markdown, drawing on what you already know about this PR " +
      "(you may use a small ```mermaid fenced diagram if it genuinely aids understanding). " +
      "Output only the answer — no preamble, no restatement of the question.",
  ].join("\n");
}

// The finding's location, human review, and deeper technical context shared by
// both Elaborate prompts. Older stored findings fall back to the review comment.
function elaborateContext(file: FileChange, finding: Finding): string[] {
  const loc =
    finding.line != null
      ? finding.endLine && finding.endLine > finding.line
        ? `${finding.line}–${finding.endLine}`
        : `${finding.line}`
      : "n/a";
  const side = finding.side || "right";
  const technicalExplanation = finding.technicalExplanation || finding.comment;
  return [
    `File: ${file.path}`,
    `Location: lines ${loc} (${side} side)`,
    ``,
    ...(finding.title ? [`Title: ${finding.title}`] : []),
    `Review comment: ${finding.comment}`,
    `Technical explanation: ${technicalExplanation}`,
  ];
}

// Builds the SDK "selection" attachment carrying the snippet as inline `text`
// (rather than `type: "file"` + `path`) since PR files are repo-relative ADO
// paths that generally don't exist on the local session's disk.
function buildAskAttachment(file: FileChange, sel: DiffSelection) {
  const { startLine, endLine } = sel.anchor;
  const lines = sel.snippet.split("\n");
  const lastLineLen = lines[lines.length - 1]?.length || 0;
  const base = file.path.split("/").pop() || file.path;
  const loc = endLine > startLine ? `${startLine}-${endLine}` : `${startLine}`;
  return {
    type: "selection" as const,
    filePath: file.path,
    displayName: `${base}:${loc}`,
    selection: {
      start: { line: Math.max(0, startLine - 1), character: 0 },
      end: { line: Math.max(0, endLine - 1), character: lastLineLen },
    },
    text: sel.snippet,
  };
}

interface AskOptions {
  title: string; // header title (e.g. "Ask Copilot" / "Elaborate")
  loc: string; // header location text (e.g. "file.md:3 · right")
  context: string; // the code/comment shown in the context block
  contextClass?: string; // extra class on the context block (e.g. "prose")
  placeholder: string; // textarea placeholder
  initialQuestion?: string; // prefilled (and selected) question text
  sendLabel: string; // send button label
  buildPrompt: (question: string) => string;
  attachments?: unknown[]; // SDK attachments to send with the prompt
  /**
   * Set both to offer the reviewer-session transport. The client names only the
   * PR — the server looks up the session that produced its review and, if there
   * is one, resumes it with buildReviewerPrompt() instead of answering
   * buildPrompt() in a fresh session. Naming the PR rather than the
   * session keeps the resume target unforgeable from here.
   */
  prId?: string | number;
  org?: string;
  project?: string;
  repoId?: string;
  buildReviewerPrompt?: (question: string) => string;
}

// The shared Ask/Elaborate dialog: a snippet-or-comment context block, a question
// box, and a polled Copilot answer rendered in place. The two exported entry
// points below configure it via AskOptions; the polling/close machinery is
// identical across both.
function openAsk(opts: AskOptions): void {
  const overlay = el(`<div class="ask-overlay"></div>`);
  const dialog = el(`<div class="ask-dialog" role="dialog" aria-modal="true" tabindex="-1"></div>`);
  dialog.innerHTML =
    `<div class="ask-head">` +
    `<span class="ask-title">${esc(opts.title)}</span>` +
    `<span class="ask-loc">${esc(opts.loc)}</span>` +
    `<button type="button" class="ask-close" title="Close (Esc)" aria-label="Close">${icon("dismiss")}</button>` +
    `</div>` +
    `<pre class="ask-snippet${opts.contextClass ? " " + opts.contextClass : ""}"><code>${esc(opts.context)}</code></pre>` +
    `<textarea class="ask-q" rows="3" placeholder="${esc(opts.placeholder)}"></textarea>` +
    `<div class="ask-actions">` +
    `<button class="btn ghost sm ask-cancel">Cancel</button>` +
    `<button class="btn sm ask-send">${esc(opts.sendLabel)}</button>` +
    `</div>` +
    `<div class="ask-answer" hidden></div>`;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const ta = dialog.querySelector(".ask-q") as HTMLTextAreaElement;
  const sendBtn = dialog.querySelector(".ask-send") as HTMLButtonElement;
  const cancelBtn = dialog.querySelector(".ask-cancel") as HTMLButtonElement;
  const closeBtn = dialog.querySelector(".ask-close") as HTMLButtonElement;
  const answer = dialog.querySelector(".ask-answer") as HTMLElement;
  if (opts.initialQuestion) ta.value = opts.initialQuestion;

  let closed = false;
  function close(): void {
    closed = true;
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    e.preventDefault(); // consumed: the reading pane must not also close
    close();
  }
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  cancelBtn.addEventListener("click", close);
  closeBtn.addEventListener("click", close);

  async function ask(): Promise<void> {
    const question = ta.value.trim();
    if (!question) return;
    sendBtn.disabled = true;
    ta.disabled = true;
    const askId = newAskId();
    answer.hidden = false;
    answer.className = "ask-answer loading-ans";
    answer.innerHTML = '<span class="spinner"></span> Asking Copilot…';
    const body: Record<string, unknown> = {
      askId,
      prompt: opts.buildPrompt(question),
      attachments: opts.attachments ?? [],
    };
    if (opts.prId != null && opts.buildReviewerPrompt) {
      body.prId = opts.prId;
      body.org = opts.org;
      body.project = opts.project;
      body.repoId = opts.repoId;
      body.reviewerPrompt = opts.buildReviewerPrompt(question);
    }
    // The server picks the transport and reports it back, so the wait budget and
    // wording match the path that actually ran.
    let via = "fresh";
    try {
      const res: any = await postJSON("/api/ask", body);
      if (res && typeof res.via === "string") via = res.via;
    } catch (e: any) {
      answer.className = "ask-answer err-ans";
      answer.textContent = "Failed to send: " + e.message;
      sendBtn.disabled = false;
      ta.disabled = false;
      return;
    }
    if (via === "reviewer-session") {
      answer.innerHTML = '<span class="spinner"></span> Asking the session that reviewed this PR…';
    }
    pollAnswer(askId, via);
  }

  async function pollAnswer(askId: string, via: string): Promise<void> {
    const reviewer = via === "reviewer-session";
    const maxPolls = reviewer ? MAX_POLLS_REVIEWER : MAX_POLLS;
    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (closed) return;
      let res: any;
      try {
        res = await getJSON("/api/ask-result?askId=" + encodeURIComponent(askId));
      } catch {
        continue; // transient; keep polling
      }
      if (closed) return;
      if (res.status === "done") {
        answer.className = "ask-answer md";
        answer.innerHTML = renderMarkdown(res.answer || "_(empty answer)_");
        renderMermaid(answer);
        resetInput("Ask again");
        return;
      }
      if (res.status === "error") {
        answer.className = "ask-answer err-ans";
        answer.textContent = "Copilot couldn't answer: " + (res.error || "unknown error");
        resetInput(opts.sendLabel);
        return;
      }
    }
    if (closed) return;
    answer.className = "ask-answer err-ans";
    answer.textContent = reviewer
      ? "The reviewer session didn't respond in time."
      : "Copilot didn't respond in time.";
    resetInput(opts.sendLabel);
  }

  function resetInput(label: string): void {
    sendBtn.disabled = false;
    sendBtn.textContent = label;
    ta.disabled = false;
  }

  sendBtn.addEventListener("click", () => void ask());
  ta.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void ask();
  });
  dialog.focus();
  ta.focus();
  if (opts.initialQuestion) ta.select();
}

// "Ask Copilot about this selection": seeded from a diff text selection, sending
// the snippet as a `selection` attachment.
export function openAskModal(pr: PR, file: FileChange, sel: DiffSelection): void {
  const { side, startLine, endLine } = sel.anchor;
  const loc = endLine > startLine ? `${startLine}–${endLine}` : `${startLine}`;
  const base = file.path.split("/").pop() || file.path;
  openAsk({
    title: "Ask Copilot",
    loc: `${base}:${loc} · ${side}`,
    context: sel.snippet,
    placeholder: "Ask a question about this code…",
    sendLabel: "Ask Copilot",
    buildPrompt: (q) => buildAskPrompt(pr, file, sel, q),
    attachments: [buildAskAttachment(file, sel)],
  });
}

// "Elaborate": dive deeper into a staged AI review finding. Seeded with the AI
// comment and a prefilled follow-up so a single send yields a fuller explanation.
export function openElaborateModal(pr: PR, file: FileChange, finding: Finding): void {
  const base = file.path.split("/").pop() || file.path;
  const loc =
    finding.line != null
      ? `${finding.line}${finding.endLine && finding.endLine > finding.line ? "–" + finding.endLine : ""}`
      : base;
  const side = finding.side || "right";
  const technicalExplanation = finding.technicalExplanation || finding.comment;
  const context = (finding.title ? finding.title + "\n\n" : "") + technicalExplanation;
  openAsk({
    title: "Elaborate",
    loc: `${base}:${loc} · ${side}`,
    context,
    contextClass: "prose",
    placeholder: "Ask a follow-up, or just send for a deeper explanation…",
    initialQuestion:
      "Explain this review comment in more detail — what it means, why it matters, and how to address it.",
    sendLabel: "Ask Copilot",
    prId: pr.id,
    org: pr.org,
    project: pr.project,
    repoId: pr.repoId,
    buildReviewerPrompt: (q) => buildReviewerElaboratePrompt(pr, file, finding, q),
    buildPrompt: (q) => buildElaboratePrompt(pr, file, finding, q),
  });
}
