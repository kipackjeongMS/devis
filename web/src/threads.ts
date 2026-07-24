// Comment threads: the inline composer, a collapsible thread, and a single comment.
import { el } from "./dom.js";
import { esc, timeAgo } from "./util.js";
import { postJSON } from "./api.js";
import { toast } from "./toast.js";
import type { PR, FileChange, Thread, Comment, Finding } from "./types.js";
import { openElaborateModal } from "./ask.js";

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

/**
 * A STAGED AI review finding: a local-only inline comment card with a severity
 * badge and a "Post to ADO" button. Posting creates a real thread (createThread)
 * and swaps the card for it; nothing hits ADO until the user clicks Post.
 */
export function renderStagedFinding(
  pr: PR,
  file: FileChange,
  finding: Finding,
  onPosted?: (created: Thread) => void
): HTMLElement {
  const box = el(`<div class="thread staged"></div>`);
  const sev = String(finding.severity || "note").toLowerCase();
  const base = (file.path.split("/").pop() || file.path);
  const where =
    finding.line != null
      ? `${base}:${finding.line}${finding.endLine && finding.endLine > finding.line ? "–" + finding.endLine : ""}`
      : base;
  const header = el(
    `<div class="thread-loc staged-loc">
       <span class="sev-badge sev-${esc(sev)}">${esc(sev)}</span>
       <span class="thread-where">${esc(where)}</span>
       <span class="staged-tag">AI · staged</span>
     </div>`
  );
  const body = el(`<div class="thread-body"></div>`);
  const parts = [
    '<div class="comment ai">',
    '<div class="cmt-head"><span class="cmt-author">Copilot review</span></div>',
    finding.title ? `<div class="cmt-title">${esc(finding.title)}</div>` : "",
    `<div class="cmt-body">${esc(finding.comment)}</div>`,
    "</div>",
  ];
  body.appendChild(el(parts.join("")));

  const actions = el(
    `<div class="staged-actions">
       <button class="btn sm post">Post to ADO</button>
       <button class="btn ghost sm elaborate">Elaborate</button>
       <button class="btn ghost sm dismiss">Dismiss</button>
     </div>`
  );
  const postBtn = actions.querySelector(".post") as HTMLButtonElement;
  const elaborateBtn = actions.querySelector(".elaborate") as HTMLButtonElement;
  const dismissBtn = actions.querySelector(".dismiss") as HTMLButtonElement;
  elaborateBtn.addEventListener("click", () => openElaborateModal(pr, file, finding));
  dismissBtn.addEventListener("click", () => box.remove());
  postBtn.addEventListener("click", async () => {
    if (postBtn.disabled) return;
    postBtn.disabled = true;
    postBtn.textContent = "Posting…";
    try {
      const created: Thread = await postJSON("/api/review/post-finding", {
        org: pr.org,
        project: pr.project,
        repoId: pr.repoId,
        prId: pr.id,
        findingId: finding.id,
        filePath: file.path,
        line: finding.line,
        endLine: finding.endLine,
        side: finding.side || "right",
        content: finding.comment,
      });
      finding.posted = true;
      toast("Comment posted to ADO", "ok");
      box.replaceWith(renderThread(pr, created));
      if (typeof onPosted === "function") onPosted(created);
    } catch (e: any) {
      toast("Post failed: " + e.message, "err");
      postBtn.disabled = false;
      postBtn.textContent = "Post to ADO";
    }
  });
  body.appendChild(actions);

  box.appendChild(header);
  box.appendChild(body);
  return box;
}
