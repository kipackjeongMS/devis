// Entry for artifacts.html: a task's Artifacts window. The desktop shell opens one per task with ?task=<id>, and
// #file=<name> (with &edit=1 for the editor) names the file to show; the task's Artifacts tab opens it, and a second
// open brings it forward on that file (src/artifacts-window.mts). The task's files are on the left, the open file on
// the right, read as Markdown and edited in place. Changes made here tell the Workspace (artifactsWindow.ts).
import { applyShellClasses } from "./shell.js";
import { bindIdentity, getJSON, postJSON, type ApiError } from "./api.js";
import { esc } from "./util.js";
import { icon } from "./icons.js";
import { renderMarkdown } from "./markdown.js";
import { renderMermaid } from "./mermaid.js";
import { patchHtml } from "./patch.js";
import { toast } from "./toast.js";
import { openActionDialog } from "./prActions.js";
import {
  NOTE_NAME,
  RECAP_NAME,
  agoPhrase,
  artifactRole,
  formatBytes,
  isMarkdownName,
  newArtifactText,
  nextArtifactName,
  type Artifact,
  type ArtifactInfo,
} from "./jarvisModel.js";
import { announceArtifactsChanged, artifactsHash, readArtifactsHash } from "./artifactsWindow.js";

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLL_MS = 10_000;
const PLAIN_TITLE = "Artifacts \u00b7 Devis";

const params = new URLSearchParams(location.search);
applyShellClasses(params);

const root = document.getElementById("arts") as HTMLElement;
const titleEl = document.getElementById("artsTitle") as HTMLElement;
const rawTask = (params.get("task") || "").trim();
const taskId = TASK_ID.test(rawTask) ? rawTask.toLowerCase() : "";

/** "edit" and "new" hold what's typed: polls and other files wait until it's saved or cancelled. */
type Mode = "view" | "edit" | "new";

let list: ArtifactInfo[] | null = null;
let dir = "";
let listError = "";
let listToken = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
/** The task was removed: the window says so and stops asking. */
let gone = false;

/** The file on the right. */
let open = NOTE_NAME;
let file: Artifact | null = null;
let fileError = "";
let fileToken = 0;
let mode: Mode = "view";
/** The text the editor started from, so a worker's newer write isn't overwritten. */
let editBase = "";
/** What the editor showed when it opened: Escape drops the edit only while nothing was typed. */
let editStart = "";
let saving = false;

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const mainEl = () => root.querySelector<HTMLElement>(".aw-main");
const errorText = (e: unknown) => (e as Error)?.message || String(e);

// ---- the frame ----------------------------------------------------------------------

function mount(): void {
  root.innerHTML = `
    <aside class="aw-side" aria-label="Files">
      <div class="aw-side-head">
        <span class="aw-side-title">Files<span class="aw-count"></span></span>
        <button type="button" class="icon-btn" data-act="aw-folder" title="Open the Artifacts folder in File Explorer" aria-label="Open the Artifacts folder in File Explorer">${icon("folder")}</button>
        <button type="button" class="btn sm ghost" data-act="aw-new" aria-label="New note" title="New note">${icon("add")}<span>New note</span></button>
      </div>
      <ul class="aw-files" aria-label="Artifacts"></ul>
      <p class="tm-path aw-dir" hidden></p>
    </aside>
    <section class="aw-main" aria-label="File"></section>`;
}

function setTitle(title: string): void {
  const page = title ? `${title} \u00b7 Artifacts` : PLAIN_TITLE;
  if (document.title !== page) document.title = page;
  const brand = title ? `Artifacts \u00b7 ${title}` : "Artifacts";
  if (titleEl.textContent !== brand) {
    titleEl.textContent = brand;
    titleEl.title = brand;
  }
}

function stateHtml(tone: string, ic: "warning" | "file", title: string, text: string, actions = ""): string {
  return (
    `<div class="cw-state ${tone}"><span class="cw-state-ic">${icon(ic)}</span>` +
    `<p class="cw-state-title">${esc(title)}</p><p class="cw-state-text">${esc(text)}</p>` +
    (actions ? `<div class="cw-state-acts">${actions}</div>` : "") +
    `</div>`
  );
}

function paintNoTask(): void {
  root.innerHTML = `<div class="cw-gone">${stateHtml("bad", "warning", "This window needs a task", "Open it from a task's Artifacts tab.")}</div>`;
}

function paintGone(): void {
  setTitle("");
  root.innerHTML = `<div class="cw-gone">${stateHtml(
    "bad",
    "warning",
    "This task is gone",
    "It was removed from your Workspace.",
    `<button type="button" class="btn sm ghost" data-act="aw-close">Close window</button>`
  )}</div>`;
  root.querySelector<HTMLElement>('[data-act="aw-close"]')?.focus();
}

/** The task was removed. An open editor stays, so its text can still be copied; it closes into the notice. */
function markGone(): void {
  if (gone) return;
  gone = true;
  clearTimeout(pollTimer);
  if (mode === "edit") toast("This task was removed, so the edit can't be saved. Copy the text if you need it.", "err");
  else paintGone();
}

// ---- the file list --------------------------------------------------------------------

/** The task's files; the shared note is always there to read and write, even before anyone wrote it. */
function entries(): ArtifactInfo[] {
  if (!list) return [];
  if (list.some((i) => sameName(i.name, NOTE_NAME))) return list;
  return [{ name: NOTE_NAME, size: 0, modifiedAt: "" }, ...list];
}

function paintList(): void {
  const filesEl = root.querySelector<HTMLElement>(".aw-files");
  if (!filesEl) return;
  let html: string;
  if (!list) {
    html = listError
      ? `<li class="aw-files-note err">Couldn't read the artifacts: ${esc(listError)}</li>`
      : `<li class="aw-files-note"><span class="spinner"></span> Loading…</li>`;
  } else {
    const now = Date.now();
    html = entries()
      .map((i) => {
        const role = artifactRole(i.name);
        const size = i.modifiedAt ? `${formatBytes(i.size)} \u00b7 ${agoPhrase(i.modifiedAt, now)}` : "Empty";
        const meta = role ? `${role} \u00b7 ${size}` : size;
        const current = sameName(i.name, open) ? ' aria-current="true"' : "";
        return (
          `<li data-key="${esc(i.name.toLowerCase())}"><button type="button" class="aw-file" data-act="aw-open" data-name="${esc(i.name)}" title="${esc(i.name)}"${current}>` +
          `<span class="aw-file-icon">${icon(sameName(i.name, RECAP_NAME) ? "sparkle" : "file")}</span>` +
          `<span class="aw-file-name">${esc(i.name)}</span>` +
          `<span class="aw-file-meta">${esc(meta)}</span>` +
          `</button></li>`
        );
      })
      .join("");
  }
  patchHtml(filesEl, html);
  const count = root.querySelector<HTMLElement>(".aw-count");
  const text = list ? ` ${entries().length}` : "";
  if (count && count.textContent !== text) count.textContent = text;
  const dirEl = root.querySelector<HTMLElement>(".aw-dir");
  if (dirEl && dirEl.textContent !== dir) {
    dirEl.textContent = dir;
    dirEl.title = dir;
    dirEl.hidden = !dir;
  }
}

async function loadList(): Promise<void> {
  if (gone) return;
  clearTimeout(pollTimer);
  const token = ++listToken;
  try {
    const res = await getJSON(`/api/jarvis/artifacts?id=${encodeURIComponent(taskId)}`);
    if (token !== listToken || gone) return;
    list = Array.isArray(res?.artifacts) ? res.artifacts : [];
    dir = typeof res?.dir === "string" ? res.dir : "";
    listError = "";
    setTitle(typeof res?.title === "string" ? res.title : "");
    paintList();
    followList();
  } catch (e) {
    if (token !== listToken || gone) return;
    if ((e as ApiError).status === 404) return markGone();
    // With a list on screen, a missed read waits for the next one.
    if (!list) {
      listError = errorText(e);
      paintList();
    }
  } finally {
    if (token === listToken && !gone && !document.hidden) pollTimer = setTimeout(() => void loadList(), POLL_MS);
  }
}

/** The open file was deleted, or a worker wrote it since it was read: follow the list. */
function followList(): void {
  if (mode !== "view" || !list || !file) return;
  const info = list.find((i) => sameName(i.name, open));
  if (!info) {
    if (sameName(open, NOTE_NAME)) return;
    toast(`${open} was deleted.`, "warn");
    void openFile(NOTE_NAME);
  } else if (info.modifiedAt !== file.modifiedAt) {
    void openFile(open);
  }
}

// ---- the open file --------------------------------------------------------------------

/** Show a file, read again from disk; the hash names it, so the shell can reopen the window on it. */
async function openFile(name: string, edit = false): Promise<void> {
  if (gone) return;
  const same = sameName(name, open);
  open = name;
  if (!same) file = null;
  fileError = "";
  history.replaceState(history.state, "", artifactsHash(name));
  paintList();
  if (!same) paintMain();
  const token = ++fileToken;
  try {
    const res = await getJSON(`/api/jarvis/artifact?id=${encodeURIComponent(taskId)}&name=${encodeURIComponent(name)}`);
    if (token !== fileToken || gone) return;
    file = res.artifact as Artifact;
    if (edit && mode === "view") startEdit(true);
    else paintMain();
  } catch (e) {
    if (token !== fileToken || gone) return;
    const status = (e as ApiError).status;
    if (!sameName(name, NOTE_NAME) && (status === 404 || status === 400)) {
      toast(status === 404 ? `${name} isn't in this task's Artifacts anymore.` : errorText(e), "warn");
      return openFile(NOTE_NAME);
    }
    // The note always reads; a 404 for it means the task is gone, which the list confirms.
    if (status === 404) void loadList();
    // A failed re-read of the file on screen leaves it there; the next poll tries again.
    fileError = errorText(e);
    paintMain();
  }
}

/** The file, as read; a repaint of the same file keeps its scroll and the focused button. */
function paintMain(): void {
  const main = mainEl();
  if (!main || mode !== "view") return;
  const name = file?.name || open;
  const isNote = sameName(name, NOTE_NAME);
  const prevBody = main.querySelector<HTMLElement>(".aw-body");
  const keepScroll = prevBody && main.dataset.file === name.toLowerCase() ? prevBody.scrollTop : 0;
  const bodyFocused = !!prevBody && document.activeElement === prevBody;
  const focused = main.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.act : undefined;
  let body: string;
  if (fileError && !file) {
    body = stateHtml("bad", "warning", `Couldn't read ${name}`, fileError, `<button type="button" class="btn sm ghost" data-act="aw-retry">Try again</button>`);
  } else if (!file) {
    body = `<p class="aw-muted"><span class="spinner"></span> Loading ${esc(name)}…</p>`;
  } else if (!file.content.trim()) {
    body = `<p class="aw-muted">${isNote ? "Empty. You and the task's workers share this note: decisions, findings, open questions." : "Empty."}</p>`;
  } else if (isMarkdownName(name)) {
    body = `<div class="md aw-md">${renderMarkdown(file.content)}</div>`;
  } else {
    body = `<pre class="aw-pre">${esc(file.content)}</pre>`;
  }
  main.dataset.file = name.toLowerCase();
  main.innerHTML = `
    <div class="aw-head">
      <span class="aw-crumb" title="${esc(name)}">${esc(name)}</span>
      ${file ? `<button type="button" class="btn sm ghost" data-act="aw-edit">${icon("edit")}<span>Edit</span></button>` : ""}
      ${
        isNote
          ? ""
          : `<button type="button" class="icon-btn" data-act="aw-delete" title="Delete ${esc(name)}" aria-label="Delete ${esc(name)}">${icon("trash")}</button>`
      }
    </div>
    <div class="aw-body" tabindex="0" role="region" aria-label="${esc(name)}">${body}</div>
    ${file ? `<p class="tm-path aw-path" title="${esc(file.path)}">${esc(file.path)}</p>` : ""}`;
  const nextBody = main.querySelector<HTMLElement>(".aw-body")!;
  if (keepScroll) nextBody.scrollTop = keepScroll;
  if (bodyFocused) nextBody.focus({ preventScroll: true });
  else if (focused) main.querySelector<HTMLElement>(`[data-act="${focused}"]`)?.focus();
  void renderMermaid(main.querySelector<HTMLElement>(".aw-md"), true);
}

function focusAct(act: string): void {
  root.querySelector<HTMLElement>(`[data-act="${act}"]`)?.focus();
}

function focusListItem(name: string): void {
  const item = [...root.querySelectorAll<HTMLElement>('[data-act="aw-open"]')].find((n) => sameName(n.dataset.name || "", name));
  (item || root.querySelector<HTMLElement>('[data-act="aw-new"]'))?.focus();
}

/** A file picked here, or asked for by the Workspace. An open editor keeps it; the new-note form gives way. */
function pick(name: string, edit = false): void {
  if (!name || gone) return;
  if (mode === "edit") {
    if (file && !sameName(name, file.name)) toast(`Save or cancel your edit to ${file.name} first.`, "warn");
    history.replaceState(history.state, "", artifactsHash(open));
    mainEl()?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    return;
  }
  if (mode === "new") {
    mode = "view";
    paintMain();
  }
  void openFile(name, edit);
}

// ---- editing --------------------------------------------------------------------------

function startEdit(caretAtEnd = false): void {
  const main = mainEl();
  if (!main || !file || mode !== "view" || gone) return;
  mode = "edit";
  editBase = file.content;
  editStart = file.content;
  main.innerHTML = `
    <div class="aw-head">
      <span class="aw-crumb" title="${esc(file.name)}">Editing ${esc(file.name)}</span>
      <button type="button" class="btn sm ghost" data-act="aw-cancel">Cancel</button>
      <button type="button" class="btn sm accent" data-act="aw-save" title="Save (Ctrl+S)" aria-keyshortcuts="Control+S">Save</button>
    </div>
    <textarea class="ask-q aw-text" spellcheck="true" aria-label="Edit ${esc(file.name)}"></textarea>`;
  const area = main.querySelector<HTMLTextAreaElement>("textarea")!;
  area.value = file.content;
  area.focus();
  const at = caretAtEnd ? area.value.length : 0;
  area.setSelectionRange(at, at);
  if (!caretAtEnd) area.scrollTop = 0;
}

function cancelEdit(): void {
  if (mode !== "edit" || saving) return;
  mode = "view";
  if (gone) return paintGone();
  paintMain();
  focusAct("aw-edit");
  // A worker may have written it meanwhile.
  void openFile(open);
}

async function saveEdit(): Promise<void> {
  const main = mainEl();
  if (mode !== "edit" || !file || saving || !main) return;
  const area = main.querySelector<HTMLTextAreaElement>("textarea");
  const buttons = [...main.querySelectorAll<HTMLButtonElement>('[data-act="aw-save"], [data-act="aw-cancel"]')];
  if (!area) return;
  const name = file.name;
  saving = true;
  for (const b of buttons) b.disabled = true;
  try {
    const res = await postJSON("/api/jarvis/artifact", { id: taskId, name, content: area.value, base: editBase });
    // A read that left before the save would bring back the older text.
    ++fileToken;
    file = res.artifact as Artifact;
    open = file.name;
    mode = "view";
    saving = false;
    paintMain();
    focusAct("aw-edit");
    toast(`Saved ${name}`, "ok");
    announceArtifactsChanged(taskId);
    void loadList();
  } catch (e) {
    const message = errorText(e);
    if (/changed while you were editing/.test(message)) {
      // Keep the user's text; the next Save replaces the newer copy on purpose.
      try {
        const res = await getJSON(`/api/jarvis/artifact?id=${encodeURIComponent(taskId)}&name=${encodeURIComponent(name)}`);
        editBase = (res.artifact as Artifact).content;
        file = res.artifact as Artifact;
      } catch {
        /* the next Save reports it */
      }
      toast(`${name} changed while you edited it, likely a worker's entry. Your text is kept. Save again to replace it, or Cancel to see the new version.`, "err");
    } else {
      toast(message, "err");
    }
  } finally {
    saving = false;
    for (const b of buttons) if (b.isConnected) b.disabled = false;
    // Disabling the focused Save dropped focus to the page; after a failed save, it goes back to the text.
    if (mode === "edit" && area.isConnected && !root.contains(document.activeElement)) area.focus();
  }
}

// ---- new, delete, folder ----------------------------------------------------------------

function startNew(): void {
  const main = mainEl();
  if (!main || gone) return;
  if (mode === "edit") {
    toast(`Save or cancel your edit to ${file?.name || open} first.`, "warn");
    return;
  }
  const name = nextArtifactName(entries().map((i) => i.name));
  mode = "new";
  main.innerHTML = `
    <form class="aw-new" data-form="aw-new">
      <label class="rp-label" for="aw-new-name">New note</label>
      <input id="aw-new-name" class="ask-q jv-field" value="${esc(name)}" maxlength="80" spellcheck="false" autocomplete="off">
      <p class="aw-muted">A file in this task's Artifacts, like design.md or findings.md. Workers can read it too.</p>
      <div class="tm-note-actions">
        <button type="button" class="btn sm ghost" data-act="aw-new-cancel">Cancel</button>
        <button type="submit" class="btn sm accent">Create</button>
      </div>
    </form>`;
  const input = main.querySelector<HTMLInputElement>("input")!;
  input.focus();
  input.setSelectionRange(0, name.lastIndexOf("."));
}

function cancelNew(): void {
  if (mode !== "new") return;
  mode = "view";
  paintMain();
  focusAct("aw-new");
}

async function createNote(form: HTMLFormElement): Promise<void> {
  const input = form.querySelector<HTMLInputElement>("input");
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
  const name = input?.value.trim() || "";
  if (!input || !name || button?.disabled) return input?.focus();
  if (button) button.disabled = true;
  try {
    const res = await postJSON("/api/jarvis/artifact", { id: taskId, name, content: newArtifactText(name), create: true });
    announceArtifactsChanged(taskId);
    void loadList();
    // Cancelled while it was made: the file is in the list, and the view stays.
    if (mode !== "new" || gone) return;
    mode = "view";
    file = res.artifact as Artifact;
    open = file.name;
    fileError = "";
    ++fileToken;
    history.replaceState(history.state, "", artifactsHash(open));
    paintList();
    startEdit(true);
  } catch (e) {
    toast(errorText(e), "err");
    if (input.isConnected) input.focus();
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

function confirmDelete(): void {
  const name = file?.name || open;
  if (mode !== "view" || gone || sameName(name, NOTE_NAME)) return;
  openActionDialog({
    title: "Delete artifact",
    loc: name,
    body: `<p class="pa-note">Deletes <strong>${esc(name)}</strong> from this task's Artifacts. Workers won't see it anymore.</p>`,
    confirmLabel: "Delete",
    danger: true,
    onConfirm: async () => {
      await postJSON("/api/jarvis/artifact/delete", { id: taskId, name });
      toast(`Deleted ${name}`, "ok");
      announceArtifactsChanged(taskId);
      if (list) list = list.filter((i) => !sameName(i.name, name));
      if (sameName(open, name)) void openFile(NOTE_NAME);
      void loadList();
    },
    // Focus went back to the trash button; once the file is gone, so is the button.
    onClose: () => {
      if (!document.activeElement || document.activeElement === document.body) focusListItem(open);
    },
  });
}

async function openFolder(button: HTMLElement): Promise<void> {
  if (button instanceof HTMLButtonElement) button.disabled = true;
  try {
    await postJSON("/api/jarvis/artifacts/open-folder", { id: taskId });
  } catch (e) {
    toast(errorText(e), "err");
  } finally {
    if (button instanceof HTMLButtonElement) button.disabled = false;
  }
}

// ---- events -------------------------------------------------------------------------

root.addEventListener("click", (e) => {
  const node = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!node || !root.contains(node)) return;
  switch (node.dataset.act) {
    case "aw-open":
      return pick(node.dataset.name || "");
    case "aw-new":
      return startNew();
    case "aw-new-cancel":
      return cancelNew();
    case "aw-folder":
      return void openFolder(node);
    case "aw-edit":
      return startEdit();
    case "aw-cancel":
      return cancelEdit();
    case "aw-save":
      return void saveEdit();
    case "aw-delete":
      return confirmDelete();
    case "aw-retry":
      return void openFile(open);
    case "aw-close":
      return window.close();
  }
});

root.addEventListener("submit", (e) => {
  const form = e.target as HTMLFormElement;
  if (form.dataset.form !== "aw-new") return;
  e.preventDefault();
  void createNote(form);
});

document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || gone || !taskId) return;
  // A confirm dialog handles its own keys.
  if (document.querySelector(".ask-overlay")) return;
  const target = e.target as HTMLElement;
  if ((e.key === "s" || e.key === "S") && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    if (mode === "edit") void saveEdit();
    return;
  }
  if (e.key === "Escape") {
    if (mode === "new") {
      e.preventDefault();
      return cancelNew();
    }
    if (mode === "edit" && !saving) {
      e.preventDefault();
      const area = mainEl()?.querySelector<HTMLTextAreaElement>("textarea");
      if (!area || area.value === editStart) return cancelEdit();
      toast("Your edit isn't saved. Save it, or Cancel to drop it.", "warn");
    }
    return;
  }
  // Up and down step through the files.
  const item = target.closest<HTMLElement>('[data-act="aw-open"]');
  if (item && ["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
    const items = [...root.querySelectorAll<HTMLElement>('[data-act="aw-open"]')];
    const at = items.indexOf(item);
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : Math.min(items.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)));
    e.preventDefault();
    items[next]?.focus();
  }
});

// The Workspace (or the shell, bringing this window forward) asks for a file.
window.addEventListener("hashchange", () => {
  if (gone) return;
  void loadList();
  const want = readArtifactsHash(location.hash);
  if (!want.file) {
    history.replaceState(history.state, "", artifactsHash(open));
    return;
  }
  pick(want.file, want.edit);
});

window.addEventListener("focus", () => void loadList());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(pollTimer);
  else void loadList();
});

async function boot(): Promise<void> {
  if (!taskId) return paintNoTask();
  const want = readArtifactsHash(location.hash);
  open = want.file || NOTE_NAME;
  mount();
  paintList();
  paintMain();
  await bindIdentity();
  void loadList();
  await openFile(open, want.edit);
}

void boot();
