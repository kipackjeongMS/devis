// "Ask Copilot about this selection": a self-contained dialog (its own overlay so
// it stacks above the PR-detail slide-over) that sends the selected code + a
// question to the CLI session and renders Copilot's answer back in place. Because
// session.send() is fire-and-forget, we hand the agent a callback URL + askId and
// poll /api/ask-result for the reply.
import { el } from "./dom.js";
import { esc } from "./util.js";
import { postJSON, getJSON } from "./api.js";
import { toast } from "./toast.js";
import { renderMarkdown } from "./markdown.js";
import { renderMermaid } from "./mermaid.js";
import type { PR, FileChange } from "./types.js";
import type { DiffSelection } from "./selection.js";

const POLL_MS = 2000;
const MAX_POLLS = 60; // ~2 min

function newAskId(): string {
  const c = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}

function buildAskPrompt(
  pr: PR,
  file: FileChange,
  sel: DiffSelection,
  question: string,
  askId: string,
  callbackUrl: string
): string {
  const { side, startLine, endLine } = sel.anchor;
  const loc = endLine > startLine ? `${startLine}–${endLine}` : `${startLine}`;
  return [
    `The user is asking a question about a specific part of Azure DevOps PR #${pr.id} ("${pr.title}").`,
    ``,
    `File: ${file.path}`,
    `Lines: ${loc} (${side} side)`,
    ``,
    `Selected code:`,
    "```",
    sel.snippet,
    "```",
    ``,
    `Question: ${question}`,
    ``,
    `Answer this question concisely and directly in Markdown (you may use a small ` +
      "```mermaid fenced diagram if it genuinely aids understanding). When done, publish your " +
      `answer back to the ADO DevOps canvas by POSTing JSON to ${callbackUrl} using your ` +
      "`powershell` tool. Shape: { askId, answer } — set askId='" +
      askId +
      "' and answer=<your Markdown answer>. Build it safely so newlines/quotes survive, e.g. " +
      "`$body = @{ askId='" +
      askId +
      "'; answer=$answerText } | ConvertTo-Json -Depth 6; Invoke-RestMethod -Uri '" +
      callbackUrl +
      "' -Method Post -ContentType 'application/json' -Body $body`. If you cannot answer, POST { askId:'" +
      askId +
      "', error:'<reason>' } instead. Keep any chat reply to a one-line acknowledgment — the answer belongs in the canvas.",
  ].join("\n");
}

export function openAskModal(pr: PR, file: FileChange, sel: DiffSelection): void {
  const { side, startLine, endLine } = sel.anchor;
  const loc = endLine > startLine ? `${startLine}–${endLine}` : `${startLine}`;
  const base = file.path.split("/").pop() || file.path;

  const overlay = el(`<div class="ask-overlay"></div>`);
  const dialog = el(`<div class="ask-dialog" role="dialog" aria-modal="true" tabindex="-1"></div>`);
  dialog.innerHTML =
    `<div class="ask-head">` +
    `<span class="ask-title">Ask Copilot</span>` +
    `<span class="ask-loc">${esc(base)}:${esc(loc)} · ${esc(side)}</span>` +
    `<button class="ask-close" title="Close (Esc)" aria-label="Close">✕</button>` +
    `</div>` +
    `<pre class="ask-snippet"><code>${esc(sel.snippet)}</code></pre>` +
    `<textarea class="ask-q" rows="3" placeholder="Ask a question about this code…"></textarea>` +
    `<div class="ask-actions">` +
    `<button class="btn ghost sm ask-cancel">Cancel</button>` +
    `<button class="btn sm ask-send">Ask Copilot</button>` +
    `</div>` +
    `<div class="ask-answer" hidden></div>`;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const ta = dialog.querySelector(".ask-q") as HTMLTextAreaElement;
  const sendBtn = dialog.querySelector(".ask-send") as HTMLButtonElement;
  const cancelBtn = dialog.querySelector(".ask-cancel") as HTMLButtonElement;
  const closeBtn = dialog.querySelector(".ask-close") as HTMLButtonElement;
  const answer = dialog.querySelector(".ask-answer") as HTMLElement;

  let closed = false;
  function close(): void {
    closed = true;
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
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
    const callbackUrl = window.location.origin + "/api/ask-result";
    answer.hidden = false;
    answer.className = "ask-answer loading-ans";
    answer.innerHTML = '<span class="spinner"></span> Asking Copilot…';
    try {
      await postJSON("/api/ask", { askId, prompt: buildAskPrompt(pr, file, sel, question, askId, callbackUrl) });
    } catch (e: any) {
      answer.className = "ask-answer err-ans";
      answer.textContent = "Failed to send: " + e.message;
      sendBtn.disabled = false;
      ta.disabled = false;
      return;
    }
    pollAnswer(askId);
  }

  async function pollAnswer(askId: string): Promise<void> {
    for (let i = 0; i < MAX_POLLS; i++) {
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
        resetInput("Ask Copilot");
        return;
      }
    }
    if (closed) return;
    answer.className = "ask-answer err-ans";
    answer.textContent = "Copilot didn't respond in time. It may still reply in the chat.";
    resetInput("Ask Copilot");
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
}
