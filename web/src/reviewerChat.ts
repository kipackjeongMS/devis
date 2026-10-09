// Reviewer chat: follow-up conversation with the Copilot session that produced a
// PR's review. The server resumes that session only when the chat is opened,
// because resuming replays its history.
import { getJSON, postJSON } from "./api.js";
import { el } from "./dom.js";
import { esc } from "./util.js";
import { renderMarkdown } from "./markdown.js";
import { renderMermaid } from "./mermaid.js";
import { chatFingerprint, chatItems, type ChatItem, type ReviewerChat } from "./reviewerChatModel.js";
import type { PR } from "./types.js";

const POLL_MS = 1500;

function prIdentity(pr: PR) {
  return { prId: String(pr.id), org: pr.org, project: pr.project, repoId: pr.repoId };
}

function itemElement(item: ChatItem): HTMLElement {
  if (item.kind === "task") return el(`<div class="rev-chat-task">${esc(item.text)}</div>`);
  if (item.kind === "thinking") {
    return el('<div class="rev-chat-msg assistant thinking"><span class="spinner"></span> Thinking…</div>');
  }
  if (item.kind === "user") {
    const node = el('<div class="rev-chat-msg user"></div>');
    node.textContent = item.text;
    return node;
  }
  const node = el(`<div class="rev-chat-msg assistant md${item.streaming ? " streaming" : ""}"></div>`);
  node.innerHTML = renderMarkdown(item.text);
  return node;
}

export function reviewerChatSection(pr: PR): HTMLElement {
  const section = el(
    `<details class="rev-chat">
       <summary>
         <span class="rev-chat-title">Chat with the reviewer</span>
         <span class="rev-chat-hint">Follow up with the session that reviewed this PR</span>
       </summary>
       <div class="rev-chat-log" role="log" aria-live="polite"></div>
       <div class="rev-chat-status" role="status"></div>
       <form class="rev-chat-form">
         <textarea class="rev-chat-input" rows="2" aria-label="Message the reviewer"
           placeholder="Ask a follow-up… (Enter to send, Shift+Enter for a new line)"></textarea>
         <button class="btn sm rev-chat-send" type="submit">Send</button>
       </form>
     </details>`
  ) as HTMLDetailsElement;
  const log = section.querySelector(".rev-chat-log") as HTMLElement;
  const status = section.querySelector(".rev-chat-status") as HTMLElement;
  const form = section.querySelector(".rev-chat-form") as HTMLFormElement;
  const input = section.querySelector(".rev-chat-input") as HTMLTextAreaElement;
  const send = section.querySelector(".rev-chat-send") as HTMLButtonElement;

  let loaded = false;
  let pending = false;
  let sentText = "";
  let fingerprint = "";
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  function setStatus(text: string, error = false): void {
    status.textContent = text;
    status.classList.toggle("err", error);
  }

  function setBusy(busy: boolean): void {
    pending = busy;
    send.disabled = busy;
    send.textContent = busy ? "Waiting…" : "Send";
  }

  function render(chat: ReviewerChat): void {
    const next = chatFingerprint(chat, sentText);
    if (next === fingerprint) return;
    fingerprint = next;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.replaceChildren(...chatItems(chat, sentText).map(itemElement));
    if (!chat.pending) void renderMermaid(log);
    if (nearBottom || chat.pending) log.scrollTop = log.scrollHeight;
  }

  async function load(): Promise<void> {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (!section.isConnected) return;
    let chat: ReviewerChat;
    try {
      chat = await getJSON("/api/reviewer-chat?" + new URLSearchParams(prIdentity(pr)).toString());
    } catch (e) {
      setStatus("Could not open the reviewer session: " + (e as Error).message, true);
      setBusy(false);
      return;
    }
    loaded = true;
    render(chat);
    if (chat.pending) {
      setBusy(true);
      setStatus("");
      pollTimer = setTimeout(() => void load(), POLL_MS);
      return;
    }
    sentText = "";
    setBusy(false);
    setStatus(chat.error ? "The reviewer did not reply: " + chat.error : "", !!chat.error);
  }

  async function submit(): Promise<void> {
    const text = input.value.trim();
    if (!text || pending) return;
    setBusy(true);
    setStatus("");
    try {
      await postJSON("/api/reviewer-chat", { ...prIdentity(pr), text });
    } catch (e) {
      setBusy(false);
      setStatus("Could not send: " + (e as Error).message, true);
      return;
    }
    sentText = text;
    input.value = "";
    void load();
  }

  section.addEventListener("toggle", () => {
    if (!section.open || loaded) return;
    setStatus("Opening the reviewer session…");
    void load();
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void submit();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void submit();
    }
  });
  return section;
}
