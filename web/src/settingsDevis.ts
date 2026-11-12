// Settings' "Change Devis itself" card: whether the Lead may hand workers changes to
// Devis' own source, the folder that source lives in, and the history of ships with
// their state, log and Undo. It applies at once, apart from Save, like the Teams card.

import { getJSON, postJSON } from "./api.js";
import { esc } from "./util.js";
import { icon } from "./icons.js";
import { toast } from "./toast.js";
import { inDesktopShell, onSetupJob, pickFolder, setupActionHtml, setupJob, setupStatusHtml } from "./setupActions.js";
import { ago, type DevisOverview, type DevisShip } from "./jarvisModel.js";

type CardFactory = (name: Parameters<typeof icon>[0], title: string, descHtml: string, titleId: string, stacked?: boolean) => HTMLElement;

const STATE: Record<DevisShip["state"], { text: string; tone: string }> = {
  deploying: { text: "deploying", tone: "accent" },
  live: { text: "live", tone: "ok" },
  "rolled-back": { text: "rolled back", tone: "bad" },
  failed: { text: "didn't ship", tone: "bad" },
};

/** The card's status line: the build that's running, and what's under way. */
export function devisStatusLine(d: DevisOverview | null): string {
  if (!d) return "Couldn't read Devis' updates.";
  const running = d.commit ? `Running ${d.commit.slice(0, 8)}.` : "Running a build with no commit stamp.";
  if (!d.enabled) return `Off. ${running}`;
  const deploying = d.ships.find((s) => s.state === "deploying");
  if (deploying) return `Updating to ship ${deploying.n}: ${deploying.title}. Devis restarts when it's ready.`;
  if (d.checking) return `${running} Checking ${d.checking.label}: ${d.checking.step}…`;
  return running;
}

/** One ship in the history. */
export function shipRowHtml(s: DevisShip, d: Pick<DevisOverview, "commit" | "enabled">, now: number): string {
  const st = STATE[s.state];
  const running = s.state === "live" && !!d.commit && !!s.commit && s.commit.startsWith(d.commit.slice(0, 8));
  const chips = [
    `<span class="dv-chip tone-${st.tone}">${esc(st.text)}</span>`,
    running ? `<span class="dv-chip">running</span>` : "",
    s.revertedBy ? `<span class="dv-chip">undone by ship ${s.revertedBy}</span>` : "",
  ].join("");
  const files = s.files.length ? `${s.files.length} file${s.files.length === 1 ? "" : "s"}` : "";
  const meta = [ago(s.settledAt || s.shippedAt, now), s.commit ? s.commit.slice(0, 8) : "", files, s.worker].filter(Boolean).join(" · ");
  let action = "";
  if (s.state === "live" && !s.revertedBy) {
    action = s.undoTaskId
      ? `<span class="dv-undoing">Undo under way</span>`
      : `<button type="button" class="btn sm ghost" data-dv-undo="${s.n}"${d.enabled ? "" : " disabled title=\"Turn on changing Devis itself first\""}>Undo</button>`;
  }
  const note = s.note ? `<p class="dv-note">${esc(s.note)}</p>` : "";
  const log = s.log ? `<details class="dv-log"><summary>Log</summary><pre>${esc(s.log)}</pre></details>` : "";
  const fileList = s.files.length
    ? `<details class="dv-files"><summary>Files</summary><ul>${s.files
        .map((f) => `<li${f.sensitive ? ' class="sensitive"' : ""}><code>${esc(f.path)}</code>${f.added === null ? " binary" : ` +${f.added} −${f.removed}`}</li>`)
        .join("")}</ul></details>`
    : "";
  return `<li class="dv-ship" data-n="${s.n}">
    <span class="dv-dot tone-${st.tone}"></span>
    <div class="dv-m">
      <div class="dv-l1"><b>ship ${s.n}</b><span class="dv-title" title="${esc(s.summary || s.title)}">${esc(s.title)}</span>${chips}</div>
      <div class="dv-l2">${esc(meta)}</div>
      ${note}${log}${fileList}
    </div>
    ${action}
  </li>`;
}

export function devisCard(card: CardFactory): HTMLElement {
  const node = card(
    "sparkle",
    "Change Devis itself",
    "Lets you ask Devis, the Lead, to change Devis: a worker makes the change on a branch of Devis' source and runs its checks, then waits for you. Nothing ships until you click Ship on its card. Shipping merges into master, builds and installs the new Devis, and restarts it; if the new build doesn't come up healthy, it rolls back to the one before on its own. Local only: nothing is pushed.",
    "settingsDevis",
    true
  );
  const control = node.querySelector<HTMLElement>(".settings-card-control")!;
  control.classList.add("dv-control");
  control.innerHTML = `
    <label class="teams-switch"><input type="checkbox" role="switch" class="param-switch dv-on" disabled><span>Let Devis change its own code</span></label>
    <div class="dv-source">
      <input type="text" class="settings-folder-input dv-path" aria-label="Devis' source folder" placeholder="e.g. C:\\src\\devis" />
      <button type="button" class="btn sm dv-save" disabled>Use this folder</button>
    </div>
    <details class="dv-get">
      <summary>Don't have the source? Get it</summary>
      <p class="teams-line">Devis clones its source from GitHub into a <code>devis</code> folder inside this one, installs its packages and uses it. It needs your GitHub access to the repo, and Node.js to build.</p>
      <div class="dv-source">
        <input type="text" id="dvGetFolder" class="settings-folder-input" aria-label="Folder to put Devis' source in" placeholder="e.g. C:\\src" />
        ${inDesktopShell() ? `<button type="button" class="btn sm ghost dv-browse">${icon("folder")}<span>Browse</span></button>` : ""}
        ${setupActionHtml("devis-source", "Get the source", { inputId: "dvGetFolder" })}
      </div>
      ${setupStatusHtml("devis-source")}
    </details>
    <p class="dv-problem" role="alert" hidden></p>
    <p class="teams-line dv-line" role="status">Checking…</p>
    <ul class="dv-ships" aria-label="Devis updates"></ul>`;
  const on = control.querySelector<HTMLInputElement>(".dv-on")!;
  const path = control.querySelector<HTMLInputElement>(".dv-path")!;
  const save = control.querySelector<HTMLButtonElement>(".dv-save")!;
  const problem = control.querySelector<HTMLElement>(".dv-problem")!;
  const line = control.querySelector<HTMLElement>(".dv-line")!;
  const list = control.querySelector<HTMLUListElement>(".dv-ships")!;
  const getSource = control.querySelector<HTMLDetailsElement>(".dv-get")!;
  const getFolder = control.querySelector<HTMLInputElement>("#dvGetFolder")!;
  control.querySelector<HTMLButtonElement>(".dv-browse")?.addEventListener("click", async () => {
    const picked = await pickFolder();
    if (picked) getFolder.value = picked;
  });
  // The job saves the clone as the source; the card shows it once it's done.
  const offSource = onSetupJob((job, before) => {
    if (!node.isConnected) return offSource();
    if (job.action === "devis-source" && job.state === "done" && before?.state !== "done") {
      editing = false;
      void load();
    }
  });

  let current: DevisOverview | null = null;
  let poll: ReturnType<typeof setTimeout> | null = null;
  let editing = false;

  const paint = (d: DevisOverview | null): void => {
    current = d;
    on.disabled = !d;
    on.checked = !!d?.enabled;
    if (d && !editing) path.value = d.source;
    save.disabled = !d || path.value.trim() === (d?.source || "");
    problem.textContent = d?.sourceProblem || "";
    problem.hidden = !d?.sourceProblem;
    // Open while there's no source to use, or a clone is under way.
    if (d && (!d.source || d.sourceProblem || setupJob("devis-source"))) getSource.open = true;
    line.textContent = devisStatusLine(d);
    const now = Date.now();
    // Keep an open log or file list open across repaints.
    const open = new Set([...list.querySelectorAll<HTMLDetailsElement>("details[open]")].map((x) => `${x.closest<HTMLElement>(".dv-ship")?.dataset.n}:${x.className}`));
    list.innerHTML = d?.ships.length
      ? d.ships.map((s) => shipRowHtml(s, d, now)).join("")
      : `<li class="dv-empty">${d ? "No ships yet. Ask Devis for a change to Devis to start one." : ""}</li>`;
    for (const x of list.querySelectorAll<HTMLDetailsElement>("details")) {
      if (open.has(`${x.closest<HTMLElement>(".dv-ship")?.dataset.n}:${x.className}`)) x.open = true;
    }
  };

  const load = async (): Promise<void> => {
    let d: DevisOverview | null = null;
    try {
      d = await getJSON("/api/jarvis/devis");
    } catch {
      /* painted as unreadable */
    }
    if (!node.isConnected && current) return;
    paint(d);
    if (poll) clearTimeout(poll);
    if (d && (d.busy || d.checking || d.ships.some((s) => s.state === "deploying"))) poll = setTimeout(() => void (node.isConnected && load()), 3_000);
  };

  const post = async (body: { enabled?: boolean; source?: string }): Promise<boolean> => {
    try {
      paint(await postJSON("/api/jarvis/devis/settings", body));
      return true;
    } catch (e) {
      toast((e as Error).message, "err");
      return false;
    }
  };

  on.addEventListener("change", async () => {
    const want = on.checked;
    on.disabled = true;
    // A folder typed but not yet used goes in first, so turning on checks the folder you see.
    if (want && current && path.value.trim() !== current.source && !(await post({ source: path.value }))) {
      on.checked = false;
      on.disabled = false;
      return;
    }
    editing = false;
    if (!(await post({ enabled: want }))) {
      on.checked = !want;
      on.disabled = false;
    }
  });
  path.addEventListener("input", () => {
    editing = true;
    save.disabled = !current || path.value.trim() === current.source;
  });
  path.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !save.disabled) save.click();
  });
  save.addEventListener("click", async () => {
    save.disabled = true;
    editing = false;
    if (!(await post({ source: path.value }))) {
      editing = true;
      save.disabled = false;
    }
  });
  list.addEventListener("click", async (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-dv-undo]");
    if (!button) return;
    const n = Number(button.dataset.dvUndo);
    button.disabled = true;
    try {
      const res: { workerError?: string | null; devis: DevisOverview } = await postJSON("/api/jarvis/devis/undo", { n });
      paint(res.devis);
      toast(
        res.workerError ? `Added a task to undo ship ${n}, but its worker didn't start: ${res.workerError}` : `A worker is undoing ship ${n}. It ships like any change, after you click Ship.`,
        res.workerError ? "err" : "ok"
      );
    } catch (err) {
      toast((err as Error).message, "err");
      button.disabled = false;
    }
  });

  void load();
  return node;
}
