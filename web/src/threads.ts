// Comment threads: the inline composer, a collapsible thread, and a single comment.
import { el } from "./dom.js";
import { esc, timeAgo } from "./util.js";
import { postJSON } from "./api.js";
import { toast } from "./toast.js";
import type { PR, FileChange, Thread, Comment } from "./types.js";

/** Inline composer row for a brand-new line-anchored thread/range (ADO write on submit). */
export function buildComposerRow(
  pr: PR,
  file: FileChange,
  startLine: number,
  endLine: number,
  side: string,
  onDone?: (created: Thread) => void,
  onCancel?: () => void
): HTMLTableRowElement {
  const s = Number(startLine),
    e2 = Number(endLine);
  const locText = e2 > s ? `Comment on lines ${s}–${e2}` : `Comment on line ${s}`;
  const row = el<HTMLTableRowElement>(
    `<tr class="cmt-compose"><td colspan="5">
       <div class="compose">
         <div class="compose-loc">${esc(locText)}</div>
         <textarea rows="2" placeholder="Leave a comment…"></textarea>
         <div class="compose-actions">
           <button class="btn ghost sm cancel">Cancel</button>
           <button class="btn sm submit">Comment</button>
         </div>
       </div>
     </td></tr>`
  );
  const ta = row.querySelector("textarea") as HTMLTextAreaElement;
  const cancel = row.querySelector(".cancel") as HTMLButtonElement;
  const submit = row.querySelector(".submit") as HTMLButtonElement;
  cancel.addEventListener("click", () => {
    row.remove();
    if (typeof onCancel === "function") onCancel();
  });
  submit.addEventListener("click", async () => {
    const content = ta.value.trim();
    if (!content) return;
    submit.disabled = true;
    submit.textContent = "…";
    try {
      const created = await postJSON("/api/thread", {
        org: pr.org,
        project: pr.project,
        repoId: pr.repoId,
        prId: pr.id,
        filePath: file.path,
        line: s,
        endLine: e2,
        side,
        content,
      });
      row.remove();
      if (typeof onDone === "function") onDone(created);
      toast("Comment added", "ok");
    } catch (err: any) {
      toast("Comment failed: " + err.message, "err");
      submit.disabled = false;
      submit.textContent = "Comment";
    }
  });
  return row;
}

export function lineLabel(t: Thread): string {
  if (t.line == null) return "";
  if (t.endLine != null && t.endLine > t.line) return `:${t.line}–${t.endLine}`;
  return `:${t.line}`;
}

export function renderThread(pr: PR, thread: Thread): HTMLElement {
  const box = el(`<div class="thread"></div>`);
  const where = thread.filePath
    ? `${esc(thread.filePath.split("/").pop())}${lineLabel(thread)}`
    : "General";
  const header = el(
    `<div class="thread-loc">
       <span class="thread-chev">▾</span>
       <span class="thread-where">${where}</span>
       <span class="thread-count">${thread.comments.length}</span>
       <span class="st">${esc(thread.status)}</span>
     </div>`
  );
  header.addEventListener("click", () => box.classList.toggle("collapsed"));

  const body = el(`<div class="thread-body"></div>`);
  const list = el(`<div class="cmt-list"></div>`);
  for (const c of thread.comments) list.appendChild(renderComment(c));
  body.appendChild(list);

  const rb = el(
    `<div class="reply-box">
       <textarea placeholder="Reply…" rows="1"></textarea>
       <button class="btn sm">Reply</button>
     </div>`
  );
  const ta = rb.querySelector("textarea") as HTMLTextAreaElement;
  const btn = rb.querySelector("button") as HTMLButtonElement;
  btn.addEventListener("click", async () => {
    const content = ta.value.trim();
    if (!content) return;
    btn.disabled = true;
    btn.textContent = "…";
    try {
      const parent = thread.comments.length ? thread.comments[thread.comments.length - 1].id : 0;
      const created = await postJSON("/api/reply", {
        org: pr.org,
        project: pr.project,
        repoId: pr.repoId,
        prId: pr.id,
        threadId: thread.id,
        content,
        parentCommentId: parent,
      });
      const c: Comment = {
        id: created.id,
        author: created.author?.displayName || "You",
        content,
        parentCommentId: parent,
        published: created.publishedDate,
      };
      thread.comments.push(c);
      list.appendChild(renderComment(c));
      (header.querySelector(".thread-count") as HTMLElement).textContent = String(thread.comments.length);
      ta.value = "";
      toast("Reply posted", "ok");
    } catch (e: any) {
      toast("Reply failed: " + e.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Reply";
    }
  });
  body.appendChild(rb);

  box.appendChild(header);
  box.appendChild(body);
  return box;
}

export function renderComment(c: Comment): HTMLElement {
  const reply = c.parentCommentId ? " reply" : "";
  return el(
    `<div class="comment${reply}">
       <div class="cmt-head">
         <span class="cmt-author">${esc(c.author)}</span>
         <span class="cmt-time">${esc(timeAgo(c.published))}</span>
       </div>
       <div class="cmt-body">${esc(c.content)}</div>
     </div>`
  );
}
