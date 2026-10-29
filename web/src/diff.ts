// Per-file diff rendering: change-type pill, collapsible file with lazy diff load,
// and the diff table with inline threads, comment bubbles, and range commenting.
import { el } from "./dom.js";
import { esc } from "./util.js";
import { getJSON } from "./api.js";
import { state } from "./state.js";
import { diffTable, diffRowKey } from "./diffTable.js";
import { renderThread, buildComposerRow, renderStagedFinding } from "./threads.js";
import { installSelectionToolbar } from "./selection.js";
import { openAskModal } from "./ask.js";
import { reviewStateKey } from "./reviewKey.js";
import { canonicalReviewFilePath } from "./reviewPath.js";
import { icon } from "./icons.js";
import type { RevealableFile } from "./reveal.js";
import type { PR, Detail, FileChange, Diff, Thread, Finding } from "./types.js";

/** A rendered diff that can place findings staged after it was painted. */
interface StagedHost extends HTMLElement {
  _insertStaged?: (finding: Finding) => void;
}

/** Unposted, line-anchored findings for one file (staged inline comments). */
function stagedForFile(pr: PR, filePath: string): Finding[] {
  const review = state.reviews ? state.reviews[reviewStateKey(pr)] : undefined;
  const list = (review && review.findingsList) || [];
  return list.filter(
    (f) =>
      f &&
      !f.posted &&
      canonicalReviewFilePath(f.file) === canonicalReviewFilePath(filePath)
  );
}

export function chgClass(t: string | undefined): [string, string] {
  const s = (t || "").toLowerCase();
  if (s.includes("add")) return ["chg-add", "add"];
  if (s.includes("delete")) return ["chg-delete", "del"];
  return ["chg-edit", "edit"];
}

export function renderFile(pr: PR, detail: Detail, file: FileChange, threads: Thread[]): HTMLElement {
  const [cls, label] = chgClass(file.changeType);
  const box = el<RevealableFile>(`<div class="file"></div>`);
  box.dataset.path = file.path; // lookup key for revealFinding()
  const slash = file.path.lastIndexOf("/");
  const name = file.path.slice(slash + 1);
  const dir = slash > 0 ? file.path.slice(0, slash).replace(/^\/+/, "") : "";
  const head = el(
    `<button type="button" class="file-head" aria-expanded="false">
       <span class="file-chev" aria-hidden="true">${icon("chevron")}</span>
       <span class="file-path" title="${esc(file.path)}"><span class="file-name">${esc(name)}</span>${
         dir ? `<span class="file-dir"><bdi>${esc(dir)}</bdi></span>` : ""
       }</span>
       ${threads.length ? '<span class="file-cmt-dot" title="' + threads.length + ' comment(s)"></span>' : ""}
       <span class="chg ${cls}">${esc(label)}</span>
     </button>`
  );
  const body = el(`<div class="file-body"></div>`);
  // Staged findings already shown (or dismissed) in this loaded diff, so a
  // refresh adds only findings that arrived later, e.g. from the reviewer chat.
  const renderedStaged = new Set<string>();
  let diffWrap: StagedHost | null = null;

  function syncAiDot(count: number): void {
    const dot = head.querySelector(".file-ai-dot");
    if (!count) {
      dot?.remove();
      return;
    }
    const next = el(`<span class="file-ai-dot" title="${count} staged AI comment(s)">${icon("sparkle")}${count}</span>`);
    if (dot) dot.replaceWith(next);
    else head.querySelector(".file-path")!.after(next);
  }

  async function loadDiff(): Promise<void> {
    body.innerHTML = '<div class="diff-note"><span class="spinner"></span> Loading diff…</div>';
    try {
      const diff = await getJSON(
        `/api/diff?org=${encodeURIComponent(pr.org)}&project=${encodeURIComponent(pr.project)}` +
          `&repoId=${encodeURIComponent(pr.repoId)}&path=${encodeURIComponent(file.path)}` +
          `&src=${detail.commits.source || ""}&base=${detail.commits.base || ""}` +
          `&changeType=${encodeURIComponent(file.changeType)}`
      );
      body.innerHTML = "";
      file._diff = diff; // cache for bridge
      const staged = stagedForFile(pr, file.path);
      if (staged.length && !head.querySelector(".file-ai-dot")) syncAiDot(staged.length);
      for (const f of staged) renderedStaged.add(String(f.id));
      // File-level threads (no line) render above the diff; line threads render inline.
      const fileLevel = threads.filter((t) => t.line == null);
      const lineThreads = threads.filter((t) => t.line != null);
      const stagedFile = staged.filter((f) => f.line == null);
      const stagedLine = staged.filter((f) => f.line != null);
      for (const t of fileLevel) body.appendChild(renderThread(pr, t));
      for (const f of stagedFile) body.appendChild(renderStagedFinding(pr, file, f));
      diffWrap = renderDiff(pr, detail, file, diff, lineThreads, stagedLine);
      body.appendChild(diffWrap);
    } catch (e: any) {
      body.innerHTML = '<div class="diff-note">Could not load diff: ' + esc(e.message) + "</div>";
    }
  }

  // One shared in-flight load, so opening from the header and from a severity
  // light can't kick off two fetches for the same file.
  let loading: Promise<void> | null = null;
  const ensureLoaded = (): Promise<void> => (loading ||= loadDiff());

  head.addEventListener("click", () => {
    const open = box.classList.toggle("open");
    head.setAttribute("aria-expanded", String(open));
    if (open) void ensureLoaded();
  });

  box._ensureOpen = async () => {
    box.classList.add("open");
    head.setAttribute("aria-expanded", "true");
    await ensureLoaded();
  };

  // Add findings staged after this diff loaded. Unloaded files pick them up on load.
  box._refreshStaged = () => {
    if (!diffWrap?.isConnected) return;
    const staged = stagedForFile(pr, file.path);
    const added = staged.filter((f) => !renderedStaged.has(String(f.id)));
    for (const f of added) {
      renderedStaged.add(String(f.id));
      if (f.line == null || !diffWrap._insertStaged) diffWrap.before(renderStagedFinding(pr, file, f));
      else diffWrap._insertStaged(f);
    }
    if (added.length) syncAiDot(staged.length);
  };

  box.appendChild(head);
  box.appendChild(body);
  return box;
}

export function renderDiff(
  pr: PR,
  detail: Detail,
  file: FileChange,
  diff: Diff,
  lineThreads?: Thread[],
  stagedLine?: Finding[]
): StagedHost {
  lineThreads = lineThreads || [];
  stagedLine = stagedLine || [];
  if (diff.tooLarge) {
    return el(
      `<div class="diff-note">File too large to render inline (${diff.oldCount}→${diff.newCount} lines). Open in ADO.</div>`
    );
  }
  const hunks = diff.hunks || [];
  const wrap = el<StagedHost>(`<div class="diff-wrap"></div>`);
  if (!hunks.length && !lineThreads.length && !stagedLine.length) {
    wrap.appendChild(el(`<div class="diff-note">No textual changes.</div>`));
    return wrap;
  }

  const { table, tbody, rowByKey } = diffTable(hunks);
  const keyOf = diffRowKey;
  wrap.appendChild(table);

  const orphans = el(`<div class="diff-orphans"></div>`);
  wrap.appendChild(orphans);

  // Place a thread inline right after its anchored row (stacking multiples in order),
  // or in the orphan block when the line isn't part of the visible diff.
  function insertThread(thread: Thread): void {
    const k = keyOf(thread.side!, thread.line!);
    const tr = rowByKey.get(k);
    if (!tr) {
      if (!orphans.querySelector(".diff-orphans-title")) {
        orphans.appendChild(el(`<div class="diff-orphans-title">Comments outside the shown diff</div>`));
      }
      orphans.appendChild(renderThread(pr, thread));
      return;
    }
    let after: Element = tr;
    while (
      after.nextElementSibling &&
      after.nextElementSibling.classList.contains("thread-row") &&
      (after.nextElementSibling as HTMLElement).dataset.anchor === k
    ) {
      after = after.nextElementSibling;
    }
    const trow = document.createElement("tr");
    trow.className = "thread-row";
    trow.dataset.anchor = k;
    const td = document.createElement("td");
    td.colSpan = 5;
    td.appendChild(renderThread(pr, thread));
    trow.appendChild(td);
    after.after(trow);
    markBubble(tr, k);
  }

  // Turn a commentable row's gutter into a comment bubble (count) that toggles its threads.
  function markBubble(tr: HTMLTableRowElement, k: string): void {
    const gutter = tr.firstElementChild as HTMLElement;
    const count = tbody.querySelectorAll(`tr.thread-row[data-anchor="${k}"]`).length;
    let bubble = gutter.querySelector(".cmt-bubble") as HTMLElement | null;
    if (!bubble) {
      gutter.innerHTML = `<button class="cmt-bubble" tabindex="-1" title="Toggle comments" aria-label="Toggle comments">${icon("chat")}<span class="n"></span></button>`;
      bubble = gutter.querySelector(".cmt-bubble") as HTMLElement;
    }
    (bubble.querySelector(".n") as HTMLElement).textContent = count > 1 ? String(count) : "";
  }

  // Place a STAGED AI finding inline directly under its anchored row (always
  // visible — not toggled behind a bubble), or in the orphan block if off-diff.
  function insertStaged(finding: Finding): void {
    const side = finding.side || "right";
    const k = keyOf(side, finding.line!);
    const tr = rowByKey.get(k);
    if (!tr) {
      if (!orphans.querySelector(".diff-orphans-title")) {
        orphans.appendChild(el(`<div class="diff-orphans-title">Comments outside the shown diff</div>`));
      }
      orphans.appendChild(renderStagedFinding(pr, file, finding));
      return;
    }
    const trow = document.createElement("tr");
    trow.className = "staged-row";
    trow.dataset.anchor = k;
    const td = document.createElement("td");
    td.colSpan = 5;
    td.appendChild(renderStagedFinding(pr, file, finding));
    trow.appendChild(td);
    tr.after(trow);
  }

  function clearCompose(): void {
    tbody.querySelectorAll(".cmt-compose").forEach((r) => r.remove());
  }
  function clearHighlight(): void {
    tbody.querySelectorAll("tr.sel").forEach((r) => r.classList.remove("sel"));
  }
  function highlight(side: string, start: number, end: number): void {
    clearHighlight();
    for (let l = start; l <= end; l++) {
      const r = rowByKey.get(keyOf(side, l));
      if (r) r.classList.add("sel");
    }
  }

  // Open the inline comment composer for a line/range (invoked from the
  // selection toolbar's comment action).
  function openComposer(side: string, start: number, end: number): void {
    clearCompose();
    highlight(side, start, end);
    const endTr = rowByKey.get(keyOf(side, end)) || rowByKey.get(keyOf(side, start));
    if (!endTr) return;
    const onDone = (created: Thread) => {
      clearHighlight();
      if (!detail.threads.some((thread) => String(thread.id) === String(created.id))) {
        detail.threads.push(created);
      }
      insertThread(created);
      window.dispatchEvent(new CustomEvent("ado-pr-comments-updated"));
    };
    const onCancel = () => clearHighlight();
    const row = buildComposerRow(pr, file, start, end, side, onDone, onCancel);
    endTr.after(row);
    (row.querySelector("textarea") as HTMLTextAreaElement).focus();
  }

  // Delegated: toggle a line's existing threads via its comment bubble.
  tbody.addEventListener("click", (e: MouseEvent) => {
    const bubble = (e.target as HTMLElement).closest(".cmt-bubble");
    if (!bubble) return;
    const tr = bubble.closest("tr") as HTMLElement;
    const k = keyOf(tr.dataset.side!, tr.dataset.line!);
    let hidden = false;
    tbody.querySelectorAll(`tr.thread-row[data-anchor="${k}"]`).forEach((r) => {
      r.classList.toggle("hidden");
      hidden = r.classList.contains("hidden");
    });
    bubble.classList.toggle("off", hidden);
  });

  // Highlight text in the diff to reveal an Ask Copilot / comment toolbar.
  installSelectionToolbar(tbody, {
    onComment: (s) => {
      window.getSelection()?.removeAllRanges();
      openComposer(s.anchor.side, s.anchor.startLine, s.anchor.endLine);
    },
    onAsk: (s) => {
      window.getSelection()?.removeAllRanges();
      openAskModal(pr, file, s);
    },
  });

  // Initial paint: staged AI findings first (directly under the line), then
  // existing ADO threads (which stack below and behind a bubble toggle).
  for (const f of stagedLine) insertStaged(f);
  for (const t of lineThreads) insertThread(t);
  wrap._insertStaged = insertStaged;

  return wrap;
}
