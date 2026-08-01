// Per-file diff rendering: change-type pill, collapsible file with lazy diff load,
// and the diff table with inline threads, comment bubbles, and range commenting.
import { el } from "./dom.js";
import { esc } from "./util.js";
import { getJSON } from "./api.js";
import { state } from "./state.js";
import { highlightCode } from "./highlight.js";
import { renderThread, buildComposerRow, renderStagedFinding } from "./threads.js";
import { installSelectionToolbar } from "./selection.js";
import { openAskModal } from "./ask.js";
import type { RevealableFile } from "./reveal.js";
import type { PR, Detail, FileChange, Diff, DiffLine, Thread, Finding } from "./types.js";

/** Unposted, line-anchored findings for one file (staged inline comments). */
function stagedForFile(pr: PR, filePath: string): Finding[] {
  const review = state.reviews ? state.reviews[String(pr.id)] : undefined;
  const list = (review && review.findingsList) || [];
  return list.filter((f) => f && !f.posted && f.file === filePath);
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
  const head = el(
    `<div class="file-head">
       <span class="file-chev">▶</span>
       <span class="file-path">${esc(file.path)}</span>
       ${threads.length ? '<span class="file-cmt-dot" title="' + threads.length + ' comment(s)"></span>' : ""}
       <span class="chg ${cls}">${esc(label)}</span>
     </div>`
  );
  const body = el(`<div class="file-body"></div>`);

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
      if (staged.length && !head.querySelector(".file-ai-dot")) {
        head.querySelector(".file-path")!.after(
          el(`<span class="file-ai-dot" title="${staged.length} staged AI comment(s)">✦ ${staged.length}</span>`)
        );
      }
      // File-level threads (no line) render above the diff; line threads render inline.
      const fileLevel = threads.filter((t) => t.line == null);
      const lineThreads = threads.filter((t) => t.line != null);
      const stagedFile = staged.filter((f) => f.line == null);
      const stagedLine = staged.filter((f) => f.line != null);
      for (const t of fileLevel) body.appendChild(renderThread(pr, t));
      for (const f of stagedFile) body.appendChild(renderStagedFinding(pr, file, f));
      body.appendChild(renderDiff(pr, detail, file, diff, lineThreads, stagedLine));
    } catch (e: any) {
      body.innerHTML = '<div class="diff-note">Could not load diff: ' + esc(e.message) + "</div>";
    }
  }

  // One shared in-flight load, so opening from the header and from a severity
  // light can't kick off two fetches for the same file.
  let loading: Promise<void> | null = null;
  const ensureLoaded = (): Promise<void> => (loading ||= loadDiff());

  head.addEventListener("click", () => {
    box.classList.toggle("open");
    if (box.classList.contains("open")) void ensureLoaded();
  });

  box._ensureOpen = async () => {
    box.classList.add("open");
    await ensureLoaded();
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
): HTMLElement {
  lineThreads = lineThreads || [];
  stagedLine = stagedLine || [];
  if (diff.tooLarge) {
    return el(
      `<div class="diff-note">File too large to render inline (${diff.oldCount}→${diff.newCount} lines). Open in ADO.</div>`
    );
  }
  const hunks = diff.hunks || [];
  const wrap = el(`<div class="diff-wrap"></div>`);
  if (!hunks.length && !lineThreads.length && !stagedLine.length) {
    wrap.appendChild(el(`<div class="diff-note">No textual changes.</div>`));
    return wrap;
  }

  const table = el(`<table class="diff"></table>`);
  const tbody = document.createElement("tbody");
  const rowByKey = new Map<string, HTMLTableRowElement>(); // "side:line" -> <tr>
  const keyOf = (side: string, line: number | string) => `${side}:${line}`;

  hunks.forEach((hunk: DiffLine[], hi: number) => {
    if (hi > 0) tbody.appendChild(el(`<tr class="gap"><td colspan="5">⋯</td></tr>`));
    for (const ln of hunk) {
      const cls = ln.t === "add" ? "add" : ln.t === "del" ? "del" : "";
      const sign = ln.t === "add" ? "+" : ln.t === "del" ? "-" : "";
      const tr = document.createElement("tr");
      if (cls) tr.className = cls;
      // Anchor: prefer the right (new) side; deleted lines anchor to the left (old) side.
      const cside = ln.nn != null ? "right" : "left";
      const cline = ln.nn != null ? ln.nn : ln.o;
      const canComment = cline != null;
      if (canComment) {
        tr.dataset.line = String(cline);
        tr.dataset.side = cside;
        rowByKey.set(keyOf(cside, cline!), tr);
      }
      tr.innerHTML =
        `<td class="gutter"></td>` +
        `<td class="ln">${ln.o || ""}</td>` +
        `<td class="ln">${ln.nn || ""}</td>` +
        `<td class="sign">${sign}</td>` +
        `<td class="code">${highlightCode(ln.text)}</td>`;
      tbody.appendChild(tr);
    }
  });
  table.appendChild(tbody);
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
      gutter.innerHTML = `<button class="cmt-bubble" tabindex="-1" title="Toggle comments">💬<span class="n"></span></button>`;
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
  // selection toolbar's 💬 action).
  function openComposer(side: string, start: number, end: number): void {
    clearCompose();
    highlight(side, start, end);
    const endTr = rowByKey.get(keyOf(side, end)) || rowByKey.get(keyOf(side, start));
    if (!endTr) return;
    const onDone = (created: Thread) => {
      clearHighlight();
      insertThread(created);
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

  // Highlight text in the diff to reveal a ? (ask Copilot) / 💬 (comment) toolbar.
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

  return wrap;
}
