import { el } from "./dom.js";
import { esc, timeAgo } from "./util.js";
import { renderCommentBody } from "./markdown.js";
import { revealThread } from "./reveal.js";
import { toast } from "./toast.js";
import type { Thread } from "./types.js";

let drawer: HTMLElement | null = null;
let activeButton: HTMLButtonElement | null = null;
let onOutside: ((event: MouseEvent) => void) | null = null;
let onKey: ((event: KeyboardEvent) => void) | null = null;
let onCommentsUpdated: (() => void) | null = null;

const reducedMotion = (): boolean =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function closeDrawer(): void {
  activeButton?.setAttribute("aria-expanded", "false");
  activeButton?.classList.remove("on");
  activeButton = null;
  if (drawer) {
    const closing = drawer;
    drawer = null;
    closing.classList.remove("open");
    if (reducedMotion()) closing.remove();
    else setTimeout(() => closing.remove(), 180);
  }
  if (onOutside) document.removeEventListener("mousedown", onOutside, true);
  if (onKey) document.removeEventListener("keydown", onKey, true);
  onOutside = null;
  onKey = null;
}

export function unmountPrComments(): void {
  closeDrawer();
  if (onCommentsUpdated) window.removeEventListener("ado-pr-comments-updated", onCommentsUpdated);
  onCommentsUpdated = null;
}

export function mountPrComments(threads: Thread[]): HTMLButtonElement {
  unmountPrComments();
  const countComments = (): number =>
    threads.reduce((total, thread) => total + thread.comments.length, 0);
  const count = countComments();
  const label = `${count} Azure DevOps comment${count === 1 ? "" : "s"}`;
  const button = el<HTMLButtonElement>(
    `<button type="button" class="detail-icon-btn comments-btn" aria-label="${label}"
             title="${label}" aria-expanded="false">
       <svg viewBox="0 0 24 24" aria-hidden="true">
         <path d="M4 4.75h16v11.5H9.2L5 19.5v-3.25H4z"></path>
       </svg>
       <span class="detail-icon-count">${count}</span>
     </button>`
  );
  const countNode = button.querySelector<HTMLElement>(".detail-icon-count")!;
  const refresh = () => {
    const next = countComments();
    const nextLabel = `${next} Azure DevOps comment${next === 1 ? "" : "s"}`;
    countNode.textContent = String(next);
    button.title = nextLabel;
    button.setAttribute("aria-label", nextLabel);
  };
  onCommentsUpdated = refresh;
  window.addEventListener("ado-pr-comments-updated", refresh);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (activeButton === button) return closeDrawer();
    openDrawer(button, threads, countComments());
  });
  return button;
}

function openDrawer(button: HTMLButtonElement, threads: Thread[], count: number): void {
  closeDrawer();
  const host = button.closest<HTMLElement>(".detail-head");
  if (!host) return;

  activeButton = button;
  button.classList.add("on");
  button.setAttribute("aria-expanded", "true");
  const node = el(
    `<div class="pr-comments-pop" role="region" aria-label="Azure DevOps comments">
       <div class="pr-comments-head">
         <span>ADO comments</span>
         <span class="pr-comments-total">${count}</span>
       </div>
       <div class="pr-comments-list"></div>
     </div>`
  );
  const list = node.querySelector<HTMLElement>(".pr-comments-list")!;
  if (!threads.length || count === 0) {
    list.appendChild(el(`<div class="pr-comments-empty">No comments posted to Azure DevOps.</div>`));
  } else {
    for (const thread of threads) list.appendChild(renderThreadGroup(thread));
  }
  host.appendChild(node);
  drawer = node;
  requestAnimationFrame(() => node.classList.add("open"));

  onOutside = (event: MouseEvent) => {
    const target = event.target as Node;
    if (!node.contains(target) && !button.contains(target)) closeDrawer();
  };
  document.addEventListener("mousedown", onOutside, true);
  onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeDrawer();
    button.focus();
  };
  document.addEventListener("keydown", onKey, true);
}

function renderThreadGroup(thread: Thread): HTMLElement {
  const location = thread.filePath
    ? `${thread.filePath}${thread.line != null ? `:${thread.line}${thread.endLine && thread.endLine > thread.line ? `–${thread.endLine}` : ""}` : ""}`
    : "General";
  const group = el(
    `<section class="pr-comments-thread">
       <button type="button" class="pr-comments-loc" title="Jump to ${esc(location)}">
         <span>${esc(location)}</span>
         <span class="pr-comments-status">${esc(thread.status)}</span>
       </button>
       <div class="pr-comments-thread-body"></div>
     </section>`
  );
  group.querySelector<HTMLButtonElement>(".pr-comments-loc")!.addEventListener("click", async () => {
    closeDrawer();
    if (!(await revealThread(thread))) toast("Could not locate that ADO comment thread", "err");
  });
  const body = group.querySelector<HTMLElement>(".pr-comments-thread-body")!;
  for (const comment of thread.comments) {
    const item = el(
      `<article class="pr-comments-comment">
         <div class="pr-comments-meta">
           <span class="pr-comments-author">${esc(comment.author)}</span>
           <span>${esc(timeAgo(comment.published))}</span>
         </div>
         <div class="pr-comments-body"></div>
       </article>`
    );
    item.querySelector<HTMLElement>(".pr-comments-body")!.innerHTML = renderCommentBody(comment.content);
    body.appendChild(item);
  }
  return group;
}
