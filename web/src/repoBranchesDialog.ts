// A pipeline block's repository branches, in a dialog: the branch each repository its YAML
// takes templates from or checks out is read from, instead of the ref the YAML names.
// The task sheet's Validation tab and the Pipelines inspector both open it. It reads the
// YAML and lists its repositories; when the YAML can't be read (often: it compiles only
// with these branches, and none are set yet), the user names each repository by alias.

import { getJSON } from "./api.js";
import { esc } from "./util.js";
import { icon, type IconName } from "./icons.js";
import { openActionDialog } from "./prActions.js";
import { repoSignature, type DefinitionInfo, type RepositoryResource } from "./pipelineModel.js";

const svg = (name: IconName): string => icon(name);

/** "main" for refs/heads/main; "Default branch" for none. */
export const branchLabel = (b: string): string => b.trim().replace(/^refs\/heads\//, "") || "Default branch";

/** What a repository row's branch does. `yamlRef` is "" when the YAML's own ref isn't known. */
export const repoHint = (value: string, yamlRef: string): string =>
  value.trim()
    ? yamlRef
      ? `Instead of ${yamlRef}, the ref in the YAML.`
      : "Instead of the ref in the YAML."
    : yamlRef
      ? `Uses ${yamlRef}, the ref in the YAML.`
      : "Uses the ref in the YAML.";

// Mirror the server's limits (pipeline-graph.mts), so a problem shows on its row before Save.
export const MAX_REPO_BRANCHES = 20;
const REPO_ALIAS = /^[A-Za-z0-9_.-]{1,100}$/;

export type RepoRow = [alias: string, branch: string];
export type RepoCheck =
  | { ok: true; repos: Record<string, string> | undefined }
  | { ok: false; index: number; field: "alias" | "branch"; message: string };

/** Alias/branch rows as a block's repository branches, or the first row that's wrong. A row without a branch is left out. */
export function checkRepoRows(rows: RepoRow[]): RepoCheck {
  const seen = new Set<string>();
  const kept: RepoRow[] = [];
  for (let index = 0; index < rows.length; index++) {
    const alias = rows[index][0].trim();
    const branch = rows[index][1].trim();
    if (!branch) continue;
    const bad = (field: "alias" | "branch", message: string): RepoCheck => ({ ok: false, index, field, message });
    if (!alias) return bad("alias", `Name the repository for ${branchLabel(branch)} by its alias in the YAML.`);
    if (!REPO_ALIAS.test(alias)) return bad("alias", `"${alias.slice(0, 100)}" isn't an alias. Aliases use letters, digits, ".", "_" and "-".`);
    if (alias.toLowerCase() === "self") return bad("alias", "self is the pipeline's own repository. It builds the block's branch.");
    if (seen.has(alias.toLowerCase())) return bad("alias", `${alias} is listed twice.`);
    if (branch.length > 256) return bad("branch", `The branch for ${alias} is too long.`);
    if (kept.length === MAX_REPO_BRANCHES) return bad("alias", `A block can set at most ${MAX_REPO_BRANCHES} repository branches.`);
    seen.add(alias.toLowerCase());
    kept.push([alias, branch]);
  }
  return { ok: true, repos: kept.length ? (Object.fromEntries(kept) as Record<string, string>) : undefined };
}

/** The block the dialog edits: a Pipelines chain node or a task's validation block. */
export interface RepoBranchesBlock {
  org: string;
  project: string;
  definitionId: number;
  name: string;
  params?: Record<string, string>;
  repoBranches?: Record<string, string>;
  branchFrom?: { org: string; prId: number };
}

export interface RepoBranchesDialogOptions {
  block: RepoBranchesBlock;
  /** The branch its YAML is read from ("" for the default); null when it follows a PR whose branch isn't known here. */
  branch: string | null;
  /** Store the branches (undefined clears them). `was` is the signature of the ones the dialog opened with. Throw to keep the dialog open. */
  onSave(repos: Record<string, string> | undefined, was: string): Promise<void>;
}

/** Open the dialog. Save checks each row, then hands the branches to `onSave`; nothing changed closes it. */
export function openRepoBranchesDialog({ block: n, branch, onSave }: RepoBranchesDialogOptions): void {
  const was = repoSignature(n.repoBranches);
  // What's typed, kept across reads (a read re-renders the rows).
  let draft: RepoRow[] = Object.entries(n.repoBranches ?? {});
  // The branches the latest read compiled the YAML with.
  let readWith: Record<string, string> | undefined;
  let gen = 0;
  let ready = false;
  let saving = false;
  const unknownPr =
    branch === null && n.branchFrom
      ? `<p class="pa-note">PR ${n.branchFrom.prId}'s branch isn't known here, so this reads the pipeline's default branch. Runs read the PR's branch.</p>`
      : "";
  const dialog = openActionDialog({
    title: "Repository branches",
    loc: n.name,
    body: `<p class="pa-note">The repositories its YAML takes templates from or checks out. A branch set here is used instead of the ref the YAML names, on every run of this block.</p>${unknownPr}<div class="tv-repo-main"></div>`,
    confirmLabel: "Save",
    onConfirm: save,
  });
  const main = dialog.querySelector<HTMLElement>(".tv-repo-main")!;
  const confirm = dialog.querySelector<HTMLButtonElement>(".pa-confirm")!;
  const errorBox = dialog.querySelector<HTMLElement>(".pa-error")!;
  confirm.disabled = true;

  const where = (info: DefinitionInfo): string => esc(branchLabel(branch || info.defaultBranch));
  const warnHtml = (messages: string[]): string =>
    messages.map((msg) => `<p class="insp-warn">${svg("warning")}<span>${esc(msg)}</span></p>`).join("");
  const footHtml = (hint: string, label = "Reload"): string =>
    `<div class="insp-params-foot"><span class="insp-hint">${hint}</span><button type="button" class="btn sm insp-params-btn" data-repo-reload title="Read the YAML again">${svg("sync")}${label}</button></div>`;
  const valueFor = (alias: string): string => draft.find(([a]) => a.trim().toLowerCase() === alias.toLowerCase())?.[1] ?? "";
  const staleNote = (count: number): string =>
    `${count === 1 ? "This branch is for a repository" : "These branches are for repositories"} the pipeline doesn't use. Runs fail to queue until you remove ${count === 1 ? "it" : "them"}.`;

  function fieldHtml(r: RepositoryResource, value: string, refUnknown: boolean, i: number): string {
    const id = `tv-repo-${i}`;
    // Read with an override, the listed ref is the override, not the YAML's.
    const yamlRef = refUnknown ? "" : r.ref ? branchLabel(r.ref) : "its default branch";
    const placeholder = refUnknown ? "The YAML's ref" : r.ref ? branchLabel(r.ref) : "Default branch";
    const repoWhere = [r.name.toLowerCase() !== r.alias.toLowerCase() ? r.name : "", r.project || "", r.type && r.type.toLowerCase() !== "tfsgit" ? r.type : ""]
      .filter(Boolean)
      .join(" · ");
    return `<div class="repo-field${value.trim() ? " is-changed" : ""}">
        <div class="repo-field-head"><label class="repo-alias" for="${id}">${esc(r.alias)}</label>${repoWhere ? `<span class="repo-where" title="${esc(repoWhere)}">${esc(repoWhere)}</span>` : ""}</div>
        <span class="insp-input">${svg("branch")}<input id="${id}" class="repo-branch" data-repo="${esc(r.alias)}" data-yaml-ref="${esc(yamlRef)}" value="${esc(value)}"
          placeholder="${esc(placeholder)}" spellcheck="false" autocomplete="off" aria-describedby="${id}-hint"></span>
        <span class="insp-hint" id="${id}-hint">${esc(repoHint(value, yamlRef))}</span>
      </div>`;
  }

  function staleHtml(entries: RepoRow[]): string {
    if (!entries.length) return "";
    return `<div class="insp-stale">
        <p class="insp-run-note">${staleNote(entries.length)}</p>
        <ul>${entries
          .map(
            ([alias, b]) => `<li data-stale-alias="${esc(alias)}" data-branch="${esc(b)}"><code class="param-name">${esc(alias)}</code><span class="insp-stale-value">${esc(branchLabel(b))}</span><button type="button" class="icon-btn sm"
              data-repo-stale title="Remove" aria-label="Remove the branch for ${esc(alias)}">${svg("dismiss")}</button></li>`
          )
          .join("")}</ul>
      </div>`;
  }

  function freeRowHtml([alias, b]: RepoRow, i: number): string {
    return `<div class="tv-repo-row">
        <input class="repo-alias-input" data-free-alias value="${esc(alias)}" placeholder="e.g. templates" aria-label="Alias, row ${i + 1}" spellcheck="false" autocomplete="off">
        <span class="insp-input">${svg("branch")}<input class="repo-branch" data-free-branch value="${esc(b)}" placeholder="e.g. main" aria-label="Branch, row ${i + 1}" spellcheck="false" autocomplete="off"></span>
        <button type="button" class="icon-btn sm" data-repo-del title="Remove" aria-label="Remove row ${i + 1}">${svg("dismiss")}</button>
      </div>`;
  }

  /** The YAML couldn't be read: the user names each repository by alias, and Save checks them. */
  function fallbackHtml(messages: string[], retry = "Reload"): string {
    const rows: RepoRow[] = draft.length ? draft : [["", ""]];
    return `${warnHtml(messages)}
      <p class="pa-note">So its repositories can't be listed. Name each one by its alias in the YAML (<code>resources.repositories</code>), spelled as it is there, with the branch to use; Save checks the YAML compiles with them.</p>
      <div class="tv-repo-rows" role="group" aria-label="Repository branches">
        <div class="tv-repo-head" aria-hidden="true"><span>Alias</span><span>Branch</span><span></span></div>
        ${rows.map(freeRowHtml).join("")}
      </div>
      <button type="button" class="btn sm ghost tv-repo-add" data-repo-add${rows.length >= MAX_REPO_BRANCHES ? " disabled" : ""}>${svg("add")}Add repository</button>
      ${footHtml("Reload reads the YAML again with the branches above.", retry)}`;
  }

  function infoHtml(info: DefinitionInfo): string {
    const set = draft.filter(([, b]) => b.trim());
    if (!info.yaml) return `<p class="insp-muted">Classic pipelines don't have repository resources.</p>${staleHtml(set)}${footHtml("")}`;
    if (info.rejected) return fallbackHtml([info.rejected]);
    const repos = info.repositories ?? [];
    if (repos.length) {
      const known = new Set(repos.map((r) => r.alias.toLowerCase()));
      const sent = new Set(Object.keys(readWith ?? {}).map((a) => a.toLowerCase()));
      const fields = repos.map((r, i) => fieldHtml(r, valueFor(r.alias), !!info.previewed && sent.has(r.alias.toLowerCase()), i)).join("");
      return `${warnHtml(info.errors ?? [])}${
        info.previewed ? `<p class="insp-note">${svg("branch")}<span>Its YAML doesn't compile without these branches, so it was read with them.</span></p>` : ""
      }<div class="repo-fields">${fields}</div>${staleHtml(set.filter(([a]) => !known.has(a.trim().toLowerCase())))}${footHtml(
        `From the YAML on ${where(info)}. Leave a branch empty to use the ref the YAML names.`
      )}`;
    }
    if (info.errors?.length) return fallbackHtml(info.errors);
    return `<p class="insp-muted">Its YAML uses no other repositories. Its own repository builds ${where(info)}.</p>${staleHtml(set)}${footHtml(`From the YAML on ${where(info)}.`)}`;
  }

  type DomRow = { alias: string; branch: string; free: boolean; aliasEl?: HTMLElement; branchEl: HTMLElement };
  /** Every row on screen, in order: the YAML's repositories, branches it doesn't use, and typed rows. */
  function domRows(): DomRow[] {
    const rows: DomRow[] = [];
    main.querySelectorAll<HTMLElement>("input[data-repo], li[data-stale-alias], .tv-repo-row").forEach((el) => {
      if (el instanceof HTMLInputElement) rows.push({ alias: el.dataset.repo || "", branch: el.value, free: false, branchEl: el });
      else if (el.tagName === "LI") rows.push({ alias: el.dataset.staleAlias || "", branch: el.dataset.branch || "", free: false, branchEl: el.querySelector("button") || el });
      else {
        const a = el.querySelector<HTMLInputElement>("[data-free-alias]")!;
        const b = el.querySelector<HTMLInputElement>("[data-free-branch]")!;
        rows.push({ alias: a.value, branch: b.value, free: true, aliasEl: a, branchEl: b });
      }
    });
    return rows;
  }

  function focusFirst(): void {
    const target =
      main.querySelector<HTMLElement>("input") ?? main.querySelector<HTMLElement>("[data-repo-stale]") ?? (confirm.disabled ? null : confirm) ?? dialog;
    target.focus();
  }

  /** The rows on screen as branches. When one is wrong, it's marked and focused. */
  function checkScreen(): RepoCheck {
    const rows = domRows();
    const check = checkRepoRows(rows.map((r): RepoRow => [r.alias, r.branch]));
    if (!check.ok) {
      const row = rows[check.index];
      const target = (check.field === "alias" && row.aliasEl) || row.branchEl;
      if (target instanceof HTMLInputElement) target.setAttribute("aria-invalid", "true");
      target.focus();
    }
    return check;
  }

  async function read(refresh: boolean): Promise<void> {
    const mine = ++gen;
    if (ready) draft = domRows().filter((r) => r.branch.trim() || (r.free && r.alias.trim())).map((r) => [r.alias, r.branch]);
    if (main.contains(document.activeElement)) dialog.focus();
    ready = false;
    confirm.disabled = true;
    errorBox.hidden = true;
    main.setAttribute("aria-busy", "true");
    main.innerHTML = `<p class="insp-muted insp-params-loading"><span class="spinner" aria-hidden="true"></span>Reading the pipeline's YAML…</p>`;
    const check = checkRepoRows(draft);
    readWith = check.ok ? check.repos : n.repoBranches;
    const q = new URLSearchParams({ org: n.org, project: n.project, id: String(n.definitionId) });
    if (branch) q.set("branch", branch);
    // Parameters only matter to a read that compiles the YAML, so they go only with repository branches.
    if (readWith && Object.keys(readWith).length) {
      q.set("repos", JSON.stringify(readWith));
      if (n.params && Object.keys(n.params).length) q.set("params", JSON.stringify(n.params));
    }
    if (refresh) q.set("refresh", "1");
    let html: string;
    try {
      html = infoHtml(await getJSON(`/api/pipeline-definition-info?${q}`));
    } catch (e) {
      html = fallbackHtml([`Couldn't read the pipeline: ${(e as Error).message || "the request failed"}`], "Try again");
    }
    // A newer read, or the dialog closed: this one is stale.
    if (mine !== gen || !dialog.isConnected) return;
    main.innerHTML = html;
    main.removeAttribute("aria-busy");
    ready = true;
    if (!saving) confirm.disabled = false;
    const active = document.activeElement;
    if (active === dialog || !dialog.contains(active)) {
      const reload = refresh ? main.querySelector<HTMLElement>("[data-repo-reload]") : null;
      if (reload) reload.focus();
      else focusFirst();
    }
  }

  function syncFreeRows(): void {
    const rows = [...main.querySelectorAll<HTMLElement>(".tv-repo-row")];
    rows.forEach((row, i) => {
      row.querySelector("[data-free-alias]")?.setAttribute("aria-label", `Alias, row ${i + 1}`);
      row.querySelector("[data-free-branch]")?.setAttribute("aria-label", `Branch, row ${i + 1}`);
      row.querySelector("[data-repo-del]")?.setAttribute("aria-label", `Remove row ${i + 1}`);
    });
    const add = main.querySelector<HTMLButtonElement>("[data-repo-add]");
    if (add) add.disabled = rows.length >= MAX_REPO_BRANCHES;
  }

  function addRow(): void {
    const list = main.querySelector<HTMLElement>(".tv-repo-rows");
    const count = main.querySelectorAll(".tv-repo-row").length;
    if (!list || count >= MAX_REPO_BRANCHES) return;
    list.insertAdjacentHTML("beforeend", freeRowHtml(["", ""], count));
    syncFreeRows();
    list.querySelector<HTMLInputElement>(".tv-repo-row:last-child [data-free-alias]")?.focus();
  }

  function deleteRow(row: HTMLElement): void {
    const rows = [...main.querySelectorAll<HTMLElement>(".tv-repo-row")];
    const index = rows.indexOf(row);
    // There's always a row to type in: the last one is cleared, not removed.
    if (rows.length === 1) {
      row.querySelectorAll("input").forEach((input) => {
        input.value = "";
        input.removeAttribute("aria-invalid");
      });
    } else row.remove();
    syncFreeRows();
    const left = [...main.querySelectorAll<HTMLElement>(".tv-repo-row")];
    left[Math.min(index, left.length - 1)]?.querySelector<HTMLElement>("[data-free-alias]")?.focus();
  }

  function removeStale(li: HTMLElement): void {
    const box = li.closest<HTMLElement>(".insp-stale");
    const buttons = [...main.querySelectorAll<HTMLElement>("[data-repo-stale]")];
    const index = buttons.findIndex((b) => li.contains(b));
    li.remove();
    const left = box?.querySelectorAll("li").length ?? 0;
    if (box && !left) box.remove();
    else {
      const note = box?.querySelector(".insp-run-note");
      if (note) note.textContent = staleNote(left);
    }
    const next = buttons[index + 1] ?? buttons[index - 1];
    if (next?.isConnected) next.focus();
    else focusFirst();
  }

  dialog.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-repo-reload], [data-repo-add], [data-repo-del], [data-repo-stale]");
    if (saving || !target || !main.contains(target)) return;
    if (target.hasAttribute("data-repo-reload")) {
      // Read with what's typed; a wrong row is shown, not silently swapped for the saved branches.
      const check = ready ? checkScreen() : null;
      if (check && !check.ok) {
        errorBox.textContent = check.message;
        errorBox.hidden = false;
        return;
      }
      return void read(true);
    }
    if (target.hasAttribute("data-repo-add")) return addRow();
    if (target.hasAttribute("data-repo-del")) return deleteRow(target.closest<HTMLElement>(".tv-repo-row")!);
    removeStale(target.closest<HTMLElement>("li")!);
  });
  dialog.addEventListener("input", (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement)) return;
    input.removeAttribute("aria-invalid");
    if (input.dataset.repo === undefined) return;
    const row = input.closest<HTMLElement>(".repo-field");
    row?.classList.toggle("is-changed", !!input.value.trim());
    const hint = row?.querySelector<HTMLElement>(".insp-hint");
    if (hint) hint.textContent = repoHint(input.value, input.dataset.yamlRef || "");
  });
  // Enter in a field saves, as in a form.
  dialog.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing || !(e.target instanceof HTMLInputElement) || confirm.disabled) return;
    e.preventDefault();
    confirm.click();
  });
  // After the dialog's own first focus (Save, still disabled while the YAML is read).
  requestAnimationFrame(() => {
    if (ready) focusFirst();
    else if (!dialog.contains(document.activeElement)) dialog.focus();
  });
  void read(false);

  async function save(): Promise<void> {
    if (!ready) throw new Error("Still reading the pipeline…");
    saving = true;
    try {
      const check = checkScreen();
      if (!check.ok) throw new Error(check.message);
      // Unless the YAML was read from another branch than runs use, it's known not to use these.
      const stale = branch === null ? null : main.querySelector<HTMLElement>("li[data-stale-alias]");
      if (stale) {
        stale.querySelector("button")?.focus();
        throw new Error(`Remove the branch for ${stale.dataset.staleAlias}: the pipeline doesn't use that repository.`);
      }
      if (repoSignature(check.repos) === was) return;
      await onSave(check.repos, was);
    } finally {
      saving = false;
    }
  }
}
