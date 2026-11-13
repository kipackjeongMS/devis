// Settings' "Updates" card: the Devis that runs, where releases come from (GitHub, through the
// GitHub CLI's sign-in), the channel, whether an update installs on its own once the workers are
// done or waits to be asked, the last check, what's out, and the installs so far (updates.mts).

import { getJSON, postJSON } from "./api.js";
import { esc } from "./util.js";
import { icon } from "./icons.js";
import { toast } from "./toast.js";
import { onSetupJob, setupActionHtml, setupStatusHtml } from "./setupActions.js";
import { ago } from "./jarvisModel.js";

type CardFactory = (name: Parameters<typeof icon>[0], title: string, descHtml: string, titleId: string, stacked?: boolean) => HTMLElement;

export interface UpdateRelease {
  tag: string;
  version: string;
  prerelease: boolean;
  name: string | null;
  publishedAt: string | null;
  url: string;
}

export interface UpdateRecord {
  version: string;
  tag: string;
  url: string;
  from: string | null;
  state: "installing" | "live" | "rolled-back" | "failed";
  mode: "idle" | "now";
  note: string | null;
  log: string | null;
  startedAt: string;
  settledAt: string | null;
  retry?: boolean;
}

export interface UpdatesStatus {
  repo: string;
  running: { version: string | null; commit: string | null; release: boolean };
  channel: "stable" | "preview";
  install: "idle" | "ask";
  lastChecked: string | null;
  checking: boolean;
  downloading: string | null;
  problem: { kind: "missing" | "signed-out" | "no-access" | "no-releases" | "error"; text: string } | null;
  available: UpdateRelease | null;
  ready: string | null;
  paused: { reason: "source" | "ships"; ships: number } | null;
  installing: UpdateRecord | null;
  history: UpdateRecord[];
}

const STATE: Record<UpdateRecord["state"], { text: string; tone: string }> = {
  installing: { text: "installing", tone: "accent" },
  live: { text: "live", tone: "ok" },
  "rolled-back": { text: "rolled back", tone: "bad" },
  failed: { text: "didn't install", tone: "bad" },
};

const segHtml = (name: string, label: string, options: Array<[string, string]>, value: string): string =>
  `<div class="up-seg" role="radiogroup" aria-label="${esc(label)}">${options
    .map(
      ([v, text]) =>
        `<button type="button" role="radio" data-up-${name}="${esc(v)}" aria-checked="${v === value}" tabindex="${v === value ? 0 : -1}">${esc(text)}</button>`
    )
    .join("")}</div>`;

/** The last check, in a line: when, and what it found. */
export function lastCheckedText(u: UpdatesStatus, now: number): string {
  if (u.checking) return "Checking now…";
  if (!u.lastChecked) return "Not checked yet.";
  const when = ago(u.lastChecked, now);
  const at = when === "now" ? "Just now" : `${when} ago`;
  if (u.problem && u.problem.kind !== "no-releases") return `${at} · couldn't check`;
  if (u.downloading) return `${at} · downloading ${u.downloading}`;
  if (u.available) return `${at} · ${u.available.version} is out`;
  if (u.problem?.kind === "no-releases") return `${at} · no releases yet`;
  return `${at} · up to date`;
}

/** What's out, and what you can do about it. */
function availableHtml(u: UpdatesStatus): string {
  const rel = u.available;
  if (!rel) return "";
  const title = `<b>Devis ${esc(rel.version)}</b>${rel.prerelease ? ` <span class="dv-chip">preview</span>` : ""}${rel.name ? ` <span class="up-name">${esc(rel.name)}</span>` : ""}`;
  const whatsNew = `<a class="btn sm ghost" href="${esc(rel.url)}" target="_blank" rel="noopener">What's new${icon("external")}</a>`;
  let body = "";
  if (u.installing) {
    body = `<p class="teams-line">${u.installing.mode === "now" ? "Installing now. Devis restarts in a moment." : "Installs once the workers are done, then Devis restarts."}</p>`;
  } else if (u.paused) {
    const why =
      u.paused.reason === "ships"
        ? `Your ${u.paused.ships === 1 ? "ship is" : `${u.paused.ships} ships are`} in this Devis, and a release would undo ${u.paused.ships === 1 ? "it" : "them"}, so it doesn't install on its own. A worker can bring ${esc(rel.version)} into your source instead, and it ships like any change.`
        : `This Devis was built from your source, so releases don't install over it on their own. A worker can bring ${esc(rel.version)} into your source, and it ships like any change. Or install it anyway to go back to releases.`;
    body = `<p class="teams-line">${why}</p>
      <div class="up-actions">
        <button type="button" class="btn sm accent" data-up-act="bring">Bring it into your source</button>
        <button type="button" class="btn sm ghost" data-up-act="force">Install anyway</button>
      </div>`;
  } else {
    const ready = u.ready === rel.version ? "Downloaded and checked." : u.downloading === rel.version ? "Downloading…" : "";
    body = `${ready ? `<p class="teams-line">${ready}</p>` : ""}
      <div class="up-actions">
        <button type="button" class="btn sm accent" data-up-act="idle">Install when workers are done</button>
        <button type="button" class="btn sm" data-up-act="now">Restart now</button>
      </div>`;
  }
  return `<div class="up-avail"><div class="up-avail-h">${icon("download")}<span>${title}</span><span class="up-sp"></span>${whatsNew}</div>${body}</div>`;
}

function problemHtml(u: UpdatesStatus): string {
  const p = u.problem;
  if (!p || p.kind === "no-releases") return "";
  const fix =
    p.kind === "signed-out"
      ? `<div class="up-actions">${setupActionHtml("github-signin", "Sign in to GitHub")}</div>${setupStatusHtml("github-signin")}`
      : "";
  // The text names `winget install GitHub.cli` in backticks: show it as code.
  const text = esc(p.text).replace(/`([^`]+)`/g, "<code>$1</code>");
  return `<div class="up-problem"><p class="dv-problem" role="alert">${text}</p>${fix}</div>`;
}

function historyHtml(u: UpdatesStatus, now: number): string {
  if (!u.history.length) return "";
  return `<ul class="dv-ships up-history" aria-label="Updates installed here">${u.history
    .slice(0, 10)
    .map((r) => {
      const st = STATE[r.state];
      const runningNow = r.state === "live" && r.version === u.running.version;
      const meta = [ago(r.settledAt || r.startedAt, now), r.from ? `from ${r.from}` : "", r.mode === "now" ? "restarted at once" : ""].filter(Boolean).join(" · ");
      const log = r.log ? `<details class="dv-log"><summary>Log</summary><pre>${esc(r.log)}</pre></details>` : "";
      return `<li class="dv-ship">
        <span class="dv-dot tone-${st.tone}"></span>
        <div class="dv-m">
          <div class="dv-l1"><b>${esc(r.version)}</b><span class="dv-chip tone-${st.tone}">${esc(st.text)}</span>${runningNow ? `<span class="dv-chip">running</span>` : ""}${r.retry ? `<span class="dv-chip">tries again</span>` : ""}</div>
          <div class="dv-l2">${esc(meta)}</div>
          ${r.note ? `<p class="dv-note">${esc(r.note)}</p>` : ""}${log}
        </div>
      </li>`;
    })
    .join("")}</ul>`;
}

export function updatesCard(card: CardFactory): HTMLElement {
  const node = card(
    "download",
    "Updates",
    "New versions of Devis come from GitHub releases, through the GitHub CLI's sign-in. Devis checks every 4 hours, downloads a release and checks its SHA-512, then installs it the way a ship does: it waits for the work in flight, restarts, and goes back to the build before when the new one doesn't come up.",
    "settingsUpdates",
    true
  );
  const control = node.querySelector<HTMLElement>(".settings-card-control")!;
  control.classList.add("up-control");
  control.innerHTML = `<div class="up-body"><p class="teams-line" role="status">Checking…</p></div>`;
  const body = control.querySelector<HTMLElement>(".up-body")!;
  let current: UpdatesStatus | null = null;
  let poll: ReturnType<typeof setTimeout> | null = null;

  const paint = (u: UpdatesStatus | null): void => {
    current = u;
    if (!u) {
      body.innerHTML = `<p class="teams-line" role="status">Couldn't read Devis' updates.</p>`;
      return;
    }
    const now = Date.now();
    const running = [u.running.version || "unknown version", u.running.commit ? u.running.commit.slice(0, 8) : ""].filter(Boolean).join(" · ");
    const kind = u.running.release ? "a release" : "built from your source";
    // Keep an open log open across repaints.
    const open = new Set([...body.querySelectorAll<HTMLDetailsElement>(".up-history details[open]")].map((d) => d.closest("li")?.querySelector("b")?.textContent));
    body.innerHTML = `
      <dl class="up-kv">
        <dt>Running</dt><dd>${esc(running)} <span class="up-muted">· ${kind}</span></dd>
        <dt>From</dt><dd><a href="https://github.com/${esc(u.repo)}/releases" target="_blank" rel="noopener">${esc(u.repo)}</a> <span class="up-muted">· GitHub Releases</span></dd>
        <dt>Channel</dt><dd>${segHtml("channel", "Channel", [["stable", "Stable"], ["preview", "Preview"]], u.channel)}</dd>
        <dt>Install updates</dt><dd>${segHtml("install", "Install updates", [["idle", "When workers are done"], ["ask", "Ask me"]], u.install)}</dd>
        <dt>Last checked</dt><dd class="up-checked"><span role="status">${esc(lastCheckedText(u, now))}</span>
          <button type="button" class="btn sm ghost" data-up-act="check"${u.checking ? " disabled aria-busy=\"true\"" : ""}>${icon("sync")}<span>Check now</span></button></dd>
      </dl>
      <p class="teams-line up-hint">Stable gets tagged releases. Preview also gets the build of every change merged to master.</p>
      ${problemHtml(u)}
      ${availableHtml(u)}
      ${historyHtml(u, now)}`;
    for (const d of body.querySelectorAll<HTMLDetailsElement>(".up-history details")) {
      if (open.has(d.closest("li")?.querySelector("b")?.textContent)) d.open = true;
    }
  };

  const load = async (): Promise<void> => {
    let u: UpdatesStatus | null = null;
    try {
      u = await getJSON("/api/jarvis/updates");
    } catch {
      /* painted as unreadable */
    }
    if (!node.isConnected && current) return;
    paint(u);
    if (poll) clearTimeout(poll);
    if (u && (u.checking || u.downloading || u.installing)) poll = setTimeout(() => void (node.isConnected && load()), 3_000);
  };

  const post = async (path: string, payload: object, button?: HTMLButtonElement | null): Promise<UpdatesStatus | null> => {
    if (button) button.disabled = true;
    try {
      const u: UpdatesStatus = await postJSON(path, payload);
      paint(u);
      return u;
    } catch (e) {
      toast((e as Error).message, "err");
      if (button) button.disabled = false;
      return null;
    }
  };

  body.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    const seg = target.closest<HTMLButtonElement>("[data-up-channel], [data-up-install]");
    if (seg) {
      if (seg.getAttribute("aria-checked") === "true") return;
      const focused = document.activeElement === seg;
      const [name, value] = seg.dataset.upChannel ? ["channel", seg.dataset.upChannel] : ["install", seg.dataset.upInstall || ""];
      await post("/api/jarvis/updates/settings", { [name]: value }, seg);
      // The card repainted: keep focus on the option just chosen.
      if (focused) body.querySelector<HTMLButtonElement>(`[data-up-${name}="${value}"]`)?.focus();
      if (name === "channel") void load();
      return;
    }
    const button = target.closest<HTMLButtonElement>("[data-up-act]");
    if (!button || !current) return;
    const act = button.dataset.upAct;
    const version = current.available?.version || "";
    if (act === "check") {
      button.disabled = true;
      button.querySelector("span")!.textContent = "Checking…";
      const u = await post("/api/jarvis/updates/check", {}, button);
      if (u?.problem && u.problem.kind !== "no-releases") toast(u.problem.text.replace(/`/g, ""), "err");
      return;
    }
    if (act === "idle" || act === "now" || act === "force") {
      // Install anyway replaces your build: the first click only arms it.
      if (act === "force" && button.dataset.armed !== "1") {
        button.dataset.armed = "1";
        button.textContent = `Click again: your changes go until you ship them again`;
        setTimeout(() => {
          if (!button.isConnected) return;
          delete button.dataset.armed;
          button.textContent = "Install anyway";
        }, 8_000);
        return;
      }
      const u = await post("/api/jarvis/updates/install", { mode: act === "now" ? "now" : "idle", force: act === "force" }, button);
      if (u) toast(act === "now" ? `Installing Devis ${version}. Devis restarts in a moment.` : `Devis ${version} installs once the workers are done.`, "ok");
      void load();
      return;
    }
    if (act === "bring") {
      button.disabled = true;
      try {
        const res: { workerError?: string | null; updates: UpdatesStatus } = await postJSON("/api/jarvis/updates/bring-in", { version });
        paint(res.updates);
        toast(
          res.workerError
            ? `Added a task to bring Devis ${version} into your source, but its worker didn't start: ${res.workerError}`
            : `A worker is bringing Devis ${version} into your source. It ships like any change, after you click Ship.`,
          res.workerError ? "err" : "ok"
        );
      } catch (err) {
        toast((err as Error).message, "err");
        button.disabled = false;
      }
    }
  });
  // Arrow keys move between a radio group's options, as in any radio group.
  body.addEventListener("keydown", (e) => {
    const radio = (e.target as HTMLElement).closest<HTMLButtonElement>(".up-seg [role='radio']");
    if (!radio || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    const all = [...radio.parentElement!.querySelectorAll<HTMLButtonElement>("[role='radio']")];
    const next = all[(all.indexOf(radio) + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? all.length - 1 : 1)) % all.length];
    e.preventDefault();
    next.focus();
    next.click();
  });
  // A GitHub sign-in that just finished: check again.
  const offSignIn = onSetupJob((job, before) => {
    if (!node.isConnected) return offSignIn();
    if (job.action === "github-signin" && job.state === "done" && before?.state !== "done") void post("/api/jarvis/updates/check", {});
  });

  void load();
  return node;
}
