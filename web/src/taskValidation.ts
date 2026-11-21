// The task sheet's Validation tab: the task's validation chains, shared by its workers.
//
// Master and detail. The list holds each chain (how it last went, who used it last), the
// proposals waiting for review, and "New chain". The detail shows the selected chain's
// stages for one run, its runs and queue (each labeled with who started it and whose code it
// built), and its settings. Chains are edited in Pipelines; here the user sees why each
// pipeline is there, runs chains (for a worker's branch or a PR, when a chain builds whoever
// runs it), and decides on proposals. Each block's repository branches can be set here too,
// in the shared dialog (repoBranchesDialog.ts), which the server checks compile with the YAML
// before saving.

import { getJSON, postJSON } from "./api.js";
import { esc } from "./util.js";
import { icon, type IconName } from "./icons.js";
import { patchHtml } from "./patch.js";
import { toast } from "./toast.js";
import { openActionDialog } from "./prActions.js";
import { openContextMenu, type ContextMenuEntry } from "./contextMenu.js";
import { branchLabel, openRepoBranchesDialog } from "./repoBranchesDialog.js";
import { normalizeBranch, statusLabel, statusTone } from "./pipelineModel.js";
import {
  agoPhrase,
  chainStages,
  validationChip,
  type ProposedBlock,
  type Concurrency,
  type QueueView,
  type RunTarget,
  type RunTrigger,
  type RunView,
  type TodayTask,
  type ValidationChainView,
  type ValidationEvidence,
  type ValidationNode,
  type ValidationProposal,
  type ValidationView,
} from "./jarvisModel.js";

export interface ValidationHost {
  taskId: string;
  panel: HTMLElement;
  /** The tab's badge. */
  badge: HTMLElement;
  /** Reload Today now. */
  refresh(): Promise<void>;
  /** Close the task sheet (before going to Pipelines). */
  close(): void;
  visible(): boolean;
}

export interface ValidationPanel {
  sync(task: TodayTask): void;
  /** The tab was just selected. */
  shown(task: TodayTask): void;
  /** Escape inside the panel: true when it closed something of its own. */
  escape(target: HTMLElement): boolean;
}

/** How one chain of a run request went (jarvis-validation.mts RunOutcome). */
interface RunOutcome {
  chainId: string;
  name: string;
  status: "started" | "queued" | "already" | "refused";
  message: string;
}

const svg = (name: IconName): string => icon(name);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const RUNS_SHOWN = 20;
const MAX_PURPOSE = 300;

/** A block's repository branches, on one line under it. */
function repoLineHtml(repos: Record<string, string> | undefined): string {
  const set = Object.entries(repos ?? {}).filter(([, b]) => b.trim());
  if (!set.length) return "";
  return `<p class="tv-block-params" title="Repository branches">${set
    .map(([alias, b]) => `<code>${esc(alias)}</code> on <code>${esc(branchLabel(b))}</code>`)
    .join(" · ")}</p>`;
}

const EVIDENCE_LABEL: Record<ValidationEvidence["kind"], string> = {
  prCheck: "PR check",
  consumes: "Uses a build",
  history: "Ran before",
  docs: "Docs",
  agent: "Worker's judgment",
  production: "Production",
};

/** Ask Pipelines to show a chain; app.ts switches tabs. */
export function openChainInPipelines(chainId: string): void {
  window.dispatchEvent(new CustomEvent("ado-open-chain", { detail: { chainId } }));
}

// Where a task's Validation tab opens next: "proposal:<id>" or "chain:<chainId>[:<runId>]".
// Needs you sets it just before opening the task, so its button lands on what it's about.
const focusHints = new Map<string, string>();

export function focusValidation(taskId: string, focus: string | undefined): void {
  if (focus) focusHints.set(taskId, focus);
  else focusHints.delete(taskId);
}

/** How a run went, as a glyph, a word and a tone (the glyph is never the only signal). */
function runState(status: string, stopping = false): { tone: string; glyph: string; text: string } {
  switch (status) {
    case "running":
      return { tone: "run", glyph: `<span class="spinner" aria-hidden="true"></span>`, text: stopping ? "Stopping" : "Running" };
    case "succeeded":
      return { tone: "ok", glyph: svg("check"), text: "Passed" };
    case "partiallySucceeded":
      return { tone: "warn", glyph: svg("warning"), text: "Partly passed" };
    case "failed":
      return { tone: "bad", glyph: svg("dismiss"), text: "Failed" };
    case "canceled":
      return { tone: "off", glyph: svg("stop"), text: "Stopped" };
    case "error":
      return { tone: "bad", glyph: svg("warning"), text: "Error" };
    default:
      return { tone: "idle", glyph: svg("circle"), text: statusLabel(status) };
  }
}

/** How a chain stands, for its row: an unseen failure first, then what's running or waiting, then its newest run. */
function chainState(c: ValidationChainView): { tone: string; glyph: string; text: string } {
  const failed = c.summary.failures.length;
  if (failed) return { tone: "bad", glyph: svg("dismiss"), text: failed > 1 ? `${failed} failed` : "Failed" };
  if (c.summary.running) return { tone: "run", glyph: `<span class="spinner" aria-hidden="true"></span>`, text: `${c.summary.running} running` };
  if (c.queue.length) return { tone: "warn", glyph: svg("queue"), text: `${c.queue.length} waiting` };
  const r = c.runs[0];
  return r ? runState(r.status) : { tone: "idle", glyph: svg("circle"), text: "Not run" };
}

/** "18m 04s", "42s", "1h 05m". */
function duration(from: string, to: string | null, now: number): string {
  const ms = (to ? Date.parse(to) : now) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Whose run it is, for the filters and latest-per-runner: whose code it built, else who started it. */
const runnerLabel = (r: { trigger: RunTrigger | null; target: RunTarget | null }): string => r.target?.label ?? r.trigger?.label ?? "Not recorded";

/** A stable hue per worker, so the same worker reads the same color everywhere in the tab. */
function hue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** "aks-rbac-worker-2" → "W2"; another name → its first letter. */
function workerMark(label: string): string {
  const n = /worker-(\d+)$/i.exec(label);
  return n ? `W${n[1]}` : label.replace(/[^a-z0-9]/gi, "").slice(0, 1).toUpperCase() || "?";
}

/** A list option's DOM id, from the task and its selection key. */
const optionId = (taskId: string, key: string): string => `tvo-${taskId}-${key}`.replace(/[^a-z0-9_-]/gi, "_");

export function createValidationPanel(host: ValidationHost): ValidationPanel {
  let view: ValidationView | null = null;
  let error = "";
  let token = 0;
  let loadedAt = 0;
  let todaySig = "";
  let paintedSig = "";
  let workers = 0;
  /** The task's workers now, to mark runs by a removed one. */
  let workerIds = new Set<string>();
  let workerLabels = new Set<string>();
  /** The selected list item: "chain:<id>", "proposal:<id>" or "new". */
  let sel = "";
  let pendingFocus = "";
  /** Per chain, the run its stages show (else its newest running, else its newest). */
  const runPick = new Map<string, string>();
  /** Per chain, the runner whose runs the list shows ("" for all). */
  const runFilter = new Map<string, string>();
  /** Chains whose Settings are open. */
  const settingsOpen = new Set<string>();
  /** What's typed and not saved, by field: "name:<chainId>", "purpose:<chainId>", "new:name", "new:purpose", "dismiss:<proposalId>". */
  const drafts = new Map<string, string>();
  let dismissing = "";
  let templatePick = "";
  /** The last run statuses seen, to announce changes to screen readers. */
  let seenStatus = new Map<string, string>();
  let live = "";

  host.panel.addEventListener("click", onClick);
  host.panel.addEventListener("submit", onSubmit);
  host.panel.addEventListener("change", onChange);
  host.panel.addEventListener("keydown", onKeydown);
  host.panel.addEventListener("input", onInput);
  // <details> toggle doesn't bubble.
  host.panel.addEventListener("toggle", onToggle, true);

  async function load(): Promise<void> {
    const mine = ++token;
    loadedAt = Date.now();
    try {
      const next: ValidationView = await getJSON(`/api/jarvis/validation?id=${encodeURIComponent(host.taskId)}`);
      if (mine !== token) return;
      announce(next);
      view = next;
      error = "";
    } catch (e) {
      if (mine !== token) return;
      error = (e as Error).message;
    }
    paint();
  }

  /** Tell screen readers when a run starts or finishes; nothing else in the tab is live. */
  function announce(next: ValidationView): void {
    const status = new Map<string, string>();
    const said: string[] = [];
    for (const c of next.chains) {
      for (const r of c.runs) {
        status.set(r.runId, r.status);
        if (!view) continue;
        const was = seenStatus.get(r.runId);
        if (was === r.status) continue;
        const who = runnerLabel(r);
        if (!was && r.status === "running") said.push(`${c.chain.name}: ${who}'s run started.`);
        else if (was === "running") said.push(`${c.chain.name}: ${who}'s run ${runState(r.status).text.toLowerCase()}.`);
      }
    }
    seenStatus = status;
    if (said.length) live = said.join(" ");
  }

  function sync(task: TodayTask): void {
    workers = task.workers.length;
    workerIds = new Set(task.workers.map((w) => w.sessionId));
    workerLabels = new Set(task.workers.map((w) => w.label));
    const v = task.validation;
    const chip = validationChip(v);
    host.badge.className = `tm-ltab-dot tm-val-dot${chip ? ` tone-${chip.tone}` : ""}`;
    host.badge.hidden = !chip;
    host.badge.title = chip?.text || "";
    const hint = focusHints.get(host.taskId);
    if (hint && host.visible()) {
      focusHints.delete(host.taskId);
      pendingFocus = hint;
    }
    if (!host.visible()) return;
    const sig = JSON.stringify([v, task.status, workers]);
    const age = Date.now() - loadedAt;
    const busy = !!view && (view.running > 0 || view.chains.some((c) => c.queue.length));
    if (!loadedAt || sig !== todaySig || age > 60_000 || (busy && age > 5_000)) {
      todaySig = sig;
      void load();
    } else paint();
  }

  function shown(task: TodayTask): void {
    loadedAt = 0;
    sync(task);
  }

  function escape(target: HTMLElement): boolean {
    if (!dismissing || !target.closest(".tv-dismiss")) return false;
    cancelDismiss();
    return true;
  }

  function cancelDismiss(): void {
    drafts.delete(`dismiss:${dismissing}`);
    dismissing = "";
    paintedSig = "";
    paint();
    host.panel.querySelector<HTMLElement>("[data-vact='dismiss']")?.focus();
  }

  // ---- selection --------------------------------------------------------------------------

  /** Every list item's key, in list order. */
  function listKeys(v: ValidationView): string[] {
    return [...v.chains.map((c) => `chain:${c.chain.id}`), ...v.proposals.map((p) => `proposal:${p.id}`), "new"];
  }

  /** What to show with nothing picked: a chain that failed, a proposal, a running chain, the first chain. */
  function defaultSel(v: ValidationView): string {
    const failing = v.chains.find((c) => c.summary.failures.length);
    if (failing) return `chain:${failing.chain.id}`;
    if (v.proposals[0]) return `proposal:${v.proposals[0].id}`;
    const running = v.chains.find((c) => c.summary.running);
    return `chain:${(running ?? v.chains[0])?.chain.id ?? ""}`.replace(/^chain:$/, "new");
  }

  function settle(v: ValidationView): void {
    if (pendingFocus) {
      const f = pendingFocus;
      pendingFocus = "";
      if (f.startsWith("proposal:") && v.proposals.some((p) => `proposal:${p.id}` === f)) sel = f;
      else if (f.startsWith("chain:")) {
        const [chainId, runId] = f.slice("chain:".length).split(":");
        if (v.chains.some((c) => c.chain.id === chainId)) {
          sel = `chain:${chainId}`;
          if (runId) runPick.set(chainId, runId);
        }
      }
    }
    if (!listKeys(v).includes(sel)) sel = defaultSel(v);
  }

  function select(key: string, focusList = false): void {
    if (key === sel) return;
    sel = key;
    dismissing = "";
    paintedSig = "";
    paint();
    if (focusList) host.panel.querySelector<HTMLElement>(".tv-list")?.focus();
    host.panel.querySelector(`#${optionId(host.taskId, key)}`)?.scrollIntoView({ block: "nearest" });
  }

  const selectedChain = (v: ValidationView): ValidationChainView | undefined => (sel.startsWith("chain:") ? v.chains.find((c) => c.chain.id === sel.slice(6)) : undefined);
  const selectedProposal = (v: ValidationView): ValidationProposal | undefined =>
    sel.startsWith("proposal:") ? v.proposals.find((p) => p.id === sel.slice(9)) : undefined;

  /** The run a chain's stages show. */
  function shownRun(c: ValidationChainView): RunView | null {
    const picked = runPick.get(c.chain.id);
    return c.runs.find((r) => r.runId === picked) ?? c.runs.find((r) => r.status === "running") ?? c.runs[0] ?? null;
  }

  // ---- paint ----------------------------------------------------------------------------

  function paint(): void {
    if (view) settle(view);
    const minute = Math.floor(Date.now() / 60_000);
    const sig = JSON.stringify([
      view,
      error,
      sel,
      [...runPick],
      [...runFilter],
      [...settingsOpen],
      dismissing,
      templatePick,
      workers,
      [...workerIds],
      live,
      minute,
    ]);
    if (sig === paintedSig) return;
    paintedSig = sig;
    if (!view) {
      patchHtml(host.panel, error ? `<p class="tm-muted err">${esc(error)}</p>` : `<p class="tm-muted"><span class="spinner"></span> Loading validation…</p>`);
      return;
    }
    const v = view;
    const parts: string[] = [];
    if (error) parts.push(`<p class="tm-muted err" data-key="err">${esc(error)}</p>`);
    if (v.taskStatus === "done") parts.push(`<p class="tv-note" data-key="done">${svg("warning")}<span>The task is done, so its validation can't run. Reopen the task to run it.</span></p>`);
    parts.push(
      v.chains.length + v.proposals.length
        ? `<div class="tv-wrap has-list" data-key="wrap">${listHtml(v)}${detailHtml(v)}</div>`
        : `<div class="tv-wrap" data-key="wrap-new">${newHtml(v)}</div>`
    );
    parts.push(`<p class="visually-hidden" aria-live="polite" data-key="live">${esc(live)}</p>`);
    patchHtml(host.panel, parts.join(""));
    const reason = host.panel.querySelector<HTMLTextAreaElement>(".tv-dismiss textarea");
    if (reason && dismissing && document.activeElement !== reason && !reason.dataset.focused) {
      reason.dataset.focused = "1";
      reason.focus();
    }
  }

  function prLabel(org: string, prId: number): string {
    const pr = view?.prs.find((p) => p.org.toLowerCase() === org.toLowerCase() && p.prId === prId);
    return pr ? `PR ${prId} · ${branchLabel(pr.sourceRef)}` : `PR ${prId}`;
  }

  function branchText(n: { branch: string; branchFrom?: { org: string; prId: number }; followRunner?: true }): string {
    if (n.followRunner) return "Builds whoever runs it";
    if (n.branchFrom) return `Follows ${prLabel(n.branchFrom.org, n.branchFrom.prId)}`;
    return n.branch ? branchLabel(n.branch) : "Default branch";
  }

  function evidenceHtml(list: ValidationEvidence[]): string {
    if (!list.length) return "";
    return `<div class="tv-evidence">${list
      .map(
        (e) =>
          `<span class="tv-ev ${e.kind === "production" ? "tone-bad" : e.verified ? "tone-ok" : "tone-idle"}" title="${esc(
            `${EVIDENCE_LABEL[e.kind] || e.kind}. ${e.verified ? "Checked by the app" : "The worker's reading"}${e.detail ? `: ${e.detail}` : ""}`
          )}">${e.verified ? svg("check") : ""}<span>${esc(e.label || EVIDENCE_LABEL[e.kind] || e.kind)}</span></span>`
      )
      .join("")}</div>`;
  }

  /** "Your", else "worker-2's". */
  const possessive = (who: string): string => (who === "You" ? "Your" : `${who}'s`);

  /**
   * Who started a run, or whose code it built: a mark in the worker's own hue and its name. A
   * worker no longer on the task is struck through, and says so to screen readers.
   */
  function whoHtml(label: string, kind: string, sessionId?: string): string {
    const removed = kind === "worker" && (sessionId ? !workerIds.has(sessionId) : !workerLabels.has(label));
    const mark =
      kind === "you" ? svg("person") : kind === "auto" ? svg("sync") : kind === "pr" ? svg("pullRequest") : kind === "lead" ? "L" : esc(workerMark(label));
    return `<span class="tv-who is-${esc(kind)}${removed ? " is-removed" : ""}" style="--who-h:${hue(label)}" title="${esc(
      removed ? `${label}, no longer on the task` : label
    )}"><span class="tv-who-mark" aria-hidden="true">${mark}</span><span class="tv-who-name">${esc(label)}</span>${
      removed ? `<span class="visually-hidden"> (no longer on the task)</span>` : ""
    }</span>`;
  }

  /** A run target's kind, for its mark. */
  const targetKind = (t: RunTarget): string => (t.pr ? "pr" : "worker");

  // ---- the list -------------------------------------------------------------------------------

  function listHtml(v: ValidationView): string {
    const now = Date.now();
    const option = (key: string, cls: string, glyph: string, tone: string, name: string, meta: string, state: string, title: string): string => {
      const on = key === sel;
      return `<li role="option" id="${optionId(host.taskId, key)}" class="tv-item${cls}${on ? " is-sel" : ""}" aria-selected="${on}" data-vsel="${esc(key)}" data-key="o:${esc(
        key
      )}"${title ? ` title="${esc(title)}"` : ""}>
          <span class="tv-item-glyph tone-${tone}" aria-hidden="true">${glyph}</span>
          <span class="tv-item-body"><span class="tv-item-name">${esc(name)}</span><span class="tv-item-meta">${esc(meta)}</span></span>
          ${state ? `<span class="tv-item-state tone-${tone}">${esc(state)}</span>` : ""}
        </li>`;
    };
    const chains = v.chains.map((c) => {
      const s = chainState(c);
      const used = c.summary.lastUsed;
      const meta = used ? `${used.by} · ${agoPhrase(used.at, now)}` : `${plural(c.chain.graph.nodes.length, "pipeline")} · not run yet`;
      const title = [c.purpose, used ? `Last run by ${used.by}, ${agoPhrase(used.at, now)}` : ""].filter(Boolean).join("\n");
      return option(`chain:${c.chain.id}`, "", s.glyph, s.tone, c.chain.name, meta, s.text, title);
    });
    const proposals = v.proposals.map((p, i) => {
      const revises = p.chainId ? v.chains.find((c) => c.chain.id === p.chainId) : undefined;
      const name = revises ? `Changes to ${revises.chain.name}` : p.name || "New chain";
      return option(`proposal:${p.id}`, `${i === 0 ? " sep-before" : ""} is-proposal`, svg("sparkle"), "warn", name, `${p.by} · ${agoPhrase(p.at, now)}`, "Review", p.summary);
    });
    const full = v.chains.length >= v.limits.chains;
    const add = option("new", " sep-before is-new", svg("add"), "idle", "New chain", full ? `The most a task can have is ${v.limits.chains}` : "Ask a worker, or build one", "", "");
    const counts = [plural(v.chains.length, "chain"), v.running ? `${v.running} running` : ""].filter(Boolean).join(" · ");
    return `<nav class="tv-master" data-key="master" aria-label="Validation chains">
        <p class="tv-master-h"><span>Chains</span><span class="tm-muted">${esc(counts)}</span></p>
        <ul class="tv-list" role="listbox" tabindex="0" aria-label="Chains and proposals" aria-activedescendant="${optionId(host.taskId, sel)}">${[
          ...chains,
          ...proposals,
          add,
        ].join("")}</ul>
      </nav>`;
  }

  function detailHtml(v: ValidationView): string {
    const c = selectedChain(v);
    if (c) return chainHtml(v, c);
    const p = selectedProposal(v);
    if (p) return proposalHtml(v, p);
    return newHtml(v);
  }

  // ---- a chain ---------------------------------------------------------------------------------

  function chainHtml(v: ValidationView, c: ValidationChainView): string {
    const id = c.chain.id;
    const nodes = c.chain.graph.nodes;
    const now = Date.now();
    const open = v.taskStatus === "open";
    const run = shownRun(c);
    const busy = c.runs.some((r) => r.status === "running") || c.queue.length > 0;
    const runOff = !open ? ` disabled title="The task is done"` : !nodes.length ? ` disabled title="Add pipelines to it first"` : "";

    const head = `<div class="tv-d-head">
        <h4 class="tv-d-name" tabindex="-1" data-vfocus>${esc(c.chain.name)}</h4>
        <div class="tv-d-tools">
          <button type="button" class="btn sm ghost" data-vact="open">${svg("external")}<span>Open in Pipelines</span></button>
          <span class="tv-split">
            <button type="button" class="btn sm accent" data-vact="run"${runOff}>${svg("play")}<span>Run</span></button>
            <button type="button" class="btn sm accent tv-split-more" data-vact="run-menu" aria-haspopup="menu" aria-label="More ways to run ${esc(c.chain.name)}"${runOff}>${svg(
              "down"
            )}</button>
          </span>
        </div>
      </div>`;

    const purpose = c.purpose
      ? `<p class="tv-purpose">${esc(c.purpose)}</p>`
      : `<p class="tv-purpose is-empty"><span>No purpose yet. Workers pick a chain by its purpose.</span>${
          open ? ` <button type="button" class="btn sm ghost" data-vact="edit-meta">${svg("edit")}<span>Add one</span></button>` : ""
        }</p>`;

    const badges: Array<[IconName, string, string]> = [];
    if (c.mode === "one") {
      badges.push(["queue", c.deploys && c.concurrency === "auto" ? `One at a time · ${c.deploys} deploys` : "One at a time", "One run at a time. Later runs wait their turn."]);
    } else {
      badges.push([
        "flow",
        `Parallel · up to ${c.maxActive}`,
        c.deploys ? `${c.deploys} reads like a deployment, but you set it to run in parallel.` : `Up to ${c.maxActive} runs at once. Later runs wait their turn.`,
      ]);
    }
    badges.push(
      c.workersMayRunNow
        ? ["person", "Workers run it without asking", "A worker's run starts right away."]
        : ["person", c.deploys ? "Workers ask you first · it deploys" : "Workers ask you first", "A worker's run waits for your OK in What needs you."]
    );
    const pr = nodes.find((n) => n.branchFrom)?.branchFrom;
    if (c.followsRunner) badges.push(["branch", "Builds whoever runs it", "Pipelines marked so build the branch of the worker or PR the run is for."]);
    else if (pr) badges.push(["pullRequest", `Follows ${prLabel(pr.org, pr.prId)}`, ""]);
    if (c.acceptedBy && c.acceptedBy.toLowerCase() !== "you") {
      badges.push(["sparkle", `Proposed by ${c.acceptedBy}`, c.acceptedAt ? `Accepted ${agoPhrase(c.acceptedAt, now)}` : ""]);
    }
    const badgesHtml = `<ul class="tv-badges" aria-label="How it runs">${badges
      .map(([i, text, title]) => `<li class="tv-badge"${title ? ` title="${esc(title)}"` : ""}>${svg(i)}<span>${esc(text)}</span></li>`)
      .join("")}</ul>`;

    const alerts = c.summary.failures
      .map((f) => {
        const who = f.for || f.by;
        return `<div class="tv-alert tone-bad" data-key="fail:${esc(f.runId)}">${svg("warning")}
          <span>${who ? esc(possessive(who)) : "A"} run failed${f.failed ? ` at <strong>${esc(f.failed)}</strong>` : ""} · ${esc(agoPhrase(f.finishedAt || f.startedAt, now))}</span>
          <button type="button" class="btn sm ghost" data-vact="show-run" data-run="${esc(f.runId)}"${f.runId === run?.runId ? ` aria-pressed="true"` : ""}>Show</button>
          <button type="button" class="btn sm ghost" data-vact="ack" data-run="${esc(f.runId)}">Got it</button>
        </div>`;
      })
      .join("");

    // Stages, for one run.
    const pickable = c.runs.slice(0, RUNS_SHOWN);
    if (run && !pickable.includes(run)) pickable.push(run);
    const stageHead = `<div class="tv-sec-h"><p class="tv-sub">Stages</p>${
      run
        ? `<label class="tv-showing"><span>Showing</span><select class="filter-select" data-vrun="${esc(id)}">${pickable
            .map(
              (r) =>
                `<option value="${esc(r.runId)}"${r.runId === run.runId ? " selected" : ""}>${esc(
                  `${runState(r.status, r.cancelRequested).text} · ${runnerLabel(r)} · ${agoPhrase(r.startedAt, now)}`
                )}</option>`
            )
            .join("")}</select></label>`
        : ""
    }</div>`;
    const node = (n: ValidationNode): string => {
      const st = run?.blocks.find((b) => b.id === n.id);
      const missing = !!run && !st;
      const tone = st ? statusTone(st.status) : "idle";
      const label = missing ? "Not in this run" : st ? statusLabel(st.status) : "";
      const why = c.evidence[`${n.org.toLowerCase()}/${n.project.toLowerCase()}/${n.definitionId}`];
      return `
        <li class="tv-block tone-${tone}${missing ? " is-absent" : ""}" data-key="n:${esc(n.id)}">
          <div class="tv-block-top">
            <p class="tv-block-name" title="${esc(n.path ? `${n.path}\\${n.name}` : n.name)}">${esc(n.name)}</p>
            ${label ? `<span class="tm-pr-state tone-${tone}">${esc(label)}</span>` : ""}
          </div>
          <p class="tv-block-meta">${esc(n.project)}</p>
          <p class="tv-block-meta tv-block-branch">${svg("branch")}<span>${esc(st?.branch ? `Built ${branchLabel(st.branch)}` : branchText(n))}</span></p>
          ${
            st?.buildNumber
              ? `<p class="tv-block-meta">${st.url ? `<a href="${esc(st.url)}" target="_blank" rel="noopener">Build ${esc(st.buildNumber)}</a>` : `Build ${esc(st.buildNumber)}`}</p>`
              : ""
          }
          ${st?.error ? `<p class="tv-block-err">${esc(st.error)}</p>` : ""}
          ${why ? `<p class="tv-block-why">${esc(why.reason)}</p>${evidenceHtml(why.evidence)}` : ""}
          ${repoLineHtml(n.repoBranches)}
          <div class="tv-block-actions">
            <button type="button" class="btn sm ghost" data-vact="repos" data-node="${esc(n.id)}" aria-label="Repository branches of ${esc(n.name)}"${
              open ? "" : ` disabled title="The task is done"`
            }>${svg("branch")}<span>Repository branches</span></button>
          </div>
        </li>`;
    };
    const stages = chainStages(nodes, c.chain.graph.edges);
    const stagesHtml = nodes.length
      ? `<div class="tv-stages" data-key="stages">${stages
          .map(
            (col, i) => `<div class="tv-stage" data-key="s:${i}">
              <p class="tv-stage-h">Stage ${i + 1}</p>
              <ul class="tv-blocks">${col.map(node).join("")}</ul>
            </div>`
          )
          .join("")}</div>`
      : `<p class="tm-muted">No pipelines yet. Add them in Pipelines, or ask a worker to propose some.</p>`;

    // Runs and the queue, by runner.
    let filter = runFilter.get(id) || "";
    if (filter && !c.latest.some((l) => l.label === filter)) {
      runFilter.delete(id);
      filter = "";
    }
    const filters =
      c.latest.length > 1
        ? `<div class="tv-filters" role="group" aria-label="Show runs by">
            <button type="button" class="tv-chip" data-vact="filter" data-who="" aria-pressed="${!filter}">All</button>
            ${c.latest
              .map((l) => {
                const s = runState(l.status);
                return `<button type="button" class="tv-chip" data-vact="filter" data-who="${esc(l.label)}" aria-pressed="${filter === l.label}" title="${esc(
                  `${possessive(l.label)} latest run: ${s.text.toLowerCase()}, ${agoPhrase(l.at, now)}`
                )}">${whoHtml(l.label, l.kind)}<span class="tv-chip-st tone-${s.tone}" aria-hidden="true">${s.glyph}</span><span class="visually-hidden">, latest ${esc(
                  s.text.toLowerCase()
                )}</span></button>`;
              })
              .join("")}
          </div>`
        : "";
    const forHtml = (target: RunTarget | null, by: string | undefined): string =>
      target && target.label !== by ? `<span class="tv-run-for">for ${whoHtml(target.label, targetKind(target), target.sessionId)}</span>` : "";
    const queueRow = (q: QueueView): string => `
      <li class="tv-run tv-queued tone-idle" data-key="q:${esc(q.id)}">
        <div class="tv-run-main">
          <span class="tv-run-st tone-idle">${svg("queue")}<span>Waiting · #${q.position}</span></span>
          <span class="tv-run-who">${whoHtml(q.trigger.label, q.trigger.kind, q.trigger.sessionId)}${forHtml(q.target, q.trigger.label)}</span>
          <span class="tv-run-progress">${esc(q.waitingFor)}</span>
          <time class="tv-run-at" datetime="${esc(q.at)}">${esc(agoPhrase(q.at, now))}</time>
        </div>
        <span class="tv-run-acts"><button type="button" class="btn sm ghost" data-vact="cancel-queued" data-queue="${esc(q.id)}" aria-label="Cancel ${esc(
          possessive(q.target?.label ?? q.trigger.label)
        )} waiting run">Cancel</button></span>
      </li>`;
    const runRow = (r: RunView): string => {
      const s = runState(r.status, r.cancelRequested);
      const shown = r.runId === run?.runId;
      const t = r.trigger;
      const by = t ? whoHtml(t.label, t.kind, t.sessionId) : `<span class="tv-who is-unknown"><span class="tv-who-name">Not recorded</span></span>`;
      const progress =
        r.status === "running" ? `${r.done} of ${r.total}${r.current ? ` · ${r.current}` : ""}` : r.failed ? `at ${r.failed}` : r.status === "succeeded" ? plural(r.total, "pipeline") : "";
      const took = duration(r.startedAt, r.finishedAt, now);
      return `
        <li class="tv-run tone-${s.tone}${shown ? " is-shown" : ""}" data-key="r:${esc(r.runId)}">
          <button type="button" class="tv-run-main" data-vact="show-run" data-run="${esc(r.runId)}" aria-pressed="${shown}" title="Show this run's stages">
            <span class="tv-run-st tone-${s.tone}">${s.glyph}<span>${esc(s.text)}</span></span>
            <span class="tv-run-who">${by}${forHtml(r.target, t?.label)}</span>
            <span class="tv-run-progress">${esc(progress)}</span>
            <time class="tv-run-at" datetime="${esc(r.startedAt)}" title="${esc(new Date(r.startedAt).toLocaleString())}">${esc(agoPhrase(r.startedAt, now))}${
              took ? ` · ${took}` : ""
            }</time>
          </button>
          <span class="tv-run-acts">${
            r.status === "running"
              ? `<button type="button" class="btn sm ghost" data-vact="stop" data-run="${esc(r.runId)}"${r.cancelRequested ? " disabled" : ""} aria-label="Stop ${esc(
                  possessive(runnerLabel(r))
                )} run">${svg("stop")}<span>${r.cancelRequested ? "Stopping…" : "Stop"}</span></button>`
              : r.status === "failed" && !r.acked
                ? `<button type="button" class="btn sm ghost" data-vact="ack" data-run="${esc(r.runId)}">Got it</button>`
                : ""
          }</span>
        </li>`;
    };
    const runs = filter ? c.runs.filter((r) => runnerLabel(r) === filter) : c.runs;
    const queue = filter ? c.queue.filter((q) => (q.target?.label ?? q.trigger.label) === filter) : c.queue;
    const counts = [
      c.summary.running ? `${c.summary.running} of ${c.maxActive} running` : "",
      c.queue.length ? `${c.queue.length} waiting` : "",
      !c.summary.running && !c.queue.length && c.runs.length ? plural(c.runs.length, "run") : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const runsHtml =
      runs.length || queue.length
        ? `<ul class="tv-runs" aria-label="Runs of ${esc(c.chain.name)}">${queue.map(queueRow).join("")}${runs.slice(0, RUNS_SHOWN).map(runRow).join("")}</ul>${
            runs.length > RUNS_SHOWN ? `<p class="tm-muted tv-more">The newest ${RUNS_SHOWN} of ${runs.length}.</p>` : ""
          }`
        : `<p class="tm-muted">${filter ? `No runs by ${esc(filter)}.` : "It hasn't run yet. Run it here, or a worker runs it when its change is ready."}</p>`;

    // Settings.
    const nameDraft = drafts.get(`name:${id}`) ?? c.chain.name;
    const purposeDraft = drafts.get(`purpose:${id}`) ?? c.purpose;
    const changed = nameDraft.trim() !== c.chain.name || purposeDraft.trim() !== c.purpose;
    const canRerun = c.followsRunner || nodes.some((n) => n.branchFrom);
    const conc = (value: Concurrency, label: string): string => `<option value="${value}"${c.concurrency === value ? " selected" : ""}>${esc(label)}</option>`;
    const off = open ? "" : " disabled";
    const settings = `<details class="tv-settings" data-key="settings" data-chain="${esc(id)}"${settingsOpen.has(id) ? " open" : ""}>
        <summary>${svg("settings")}<span>Settings</span></summary>
        <div class="tv-settings-body">
          <form class="tv-meta" data-form="v-meta" data-chain="${esc(id)}">
            <label class="tv-field"><span>Name</span><input type="text" class="tv-input" maxlength="120" required value="${esc(nameDraft)}" data-draft="name:${esc(id)}"${off}></label>
            <label class="tv-field"><span>Purpose</span><textarea class="tv-input" rows="2" maxlength="${MAX_PURPOSE}" data-draft="purpose:${esc(
              id
            )}" placeholder="When to use it. For example: a quick check that the PR builds, or deploy to the test ring and run the E2E tests."${off}>${esc(purposeDraft)}</textarea></label>
            <div class="tv-actions"><button type="submit" class="btn sm" data-save${changed && open ? "" : " disabled"}>Save</button></div>
          </form>
          <label class="tv-field tv-field-row"><span>Runs at once</span><select class="filter-select" data-vconc="${esc(id)}"${off}>
            ${conc("auto", c.deploys ? `Automatic: one at a time (${c.deploys} deploys)` : `Automatic: in parallel, up to ${v.limits.perChain}`)}
            ${conc("one", "One at a time")}
            ${conc("parallel", c.deploys ? `In parallel, up to ${v.limits.perChain} (careful: it deploys)` : `In parallel, up to ${v.limits.perChain}`)}
          </select></label>
          <label class="tv-opt${c.deploys ? " is-off" : ""}"${
            c.deploys ? ` title="${esc(`${c.deploys} reads like a deployment, so workers always ask you first.`)}"` : ""
          }><input type="checkbox" data-vopt="workersMayRun" data-chain="${esc(id)}"${c.workersMayRun && !c.deploys ? " checked" : ""}${
            c.deploys ? " disabled" : off
          }><span>Workers can run it without asking you${c.deploys ? ` <span class="tm-muted">(not while ${esc(c.deploys)} deploys)</span>` : ""}</span></label>
          <label class="tv-opt"><input type="checkbox" data-vopt="notifyWorker" data-chain="${esc(id)}"${c.notifyWorker ? " checked" : ""}${off}><span>When a run fails, tell the worker it was for what failed, with the build's failed steps</span></label>
          <label class="tv-opt${canRerun ? "" : " is-off"}"${canRerun ? "" : ` title="No pipeline here builds a worker's branch or follows a PR."`}><input type="checkbox" data-vopt="rerunOnCommit" data-chain="${esc(
            id
          )}"${c.rerunOnCommit ? " checked" : ""}${canRerun ? off : " disabled"}><span>Run again when the branch it built gets new commits</span></label>
        </div>
      </details>`;

    const foot = `<div class="tv-actions tv-foot">
        <button type="button" class="btn sm ghost" data-vact="reusable"${nodes.length ? "" : " disabled"}>${svg("copy")}<span>Save as a reusable chain</span></button>
        <button type="button" class="btn sm ghost tv-remove" data-vact="remove"${busy ? ` disabled title="Stop its runs and clear its queue first"` : ""}>${svg(
          "trash"
        )}<span>Remove chain</span></button>
      </div>`;

    return `<section class="tv-detail tv-card" data-key="d:${esc(sel)}" aria-label="${esc(c.chain.name)}">
        ${head}${purpose}${badgesHtml}${alerts}
        ${stageHead}${run?.error ? `<p class="tv-block-err">${esc(run.error)}</p>` : ""}${stagesHtml}
        <div class="tv-sec-h"><p class="tv-sub">Runs</p>${counts ? `<span class="tm-muted">${esc(counts)}</span>` : ""}</div>
        ${filters}${runsHtml}
        ${settings}${foot}
      </section>`;
  }

  // ---- a proposal ------------------------------------------------------------------------------

  const nodeKey = (n: { org: string; project: string; definitionId: number }): string => `${n.org}/${n.project}/${n.definitionId}`.toLowerCase();

  /** A revision's chain has runs going: accepting it is refused until they finish. */
  const chainBusy = (c: ValidationChainView | undefined): boolean => !!c && c.runs.some((r) => r.status === "running");

  function proposalHtml(v: ValidationView, p: ValidationProposal): string {
    const now = Date.now();
    const open = v.taskStatus === "open";
    const revises = p.chainId ? v.chains.find((c) => c.chain.id === p.chainId) : undefined;
    const had = new Set((revises?.chain.graph.nodes ?? []).map(nodeKey));
    const keys = new Set(p.blocks.map((b) => b.key.toLowerCase()));
    const isNew = (b: ProposedBlock): boolean => !!revises && !had.has(b.key.toLowerCase());
    const ids = new Map(p.blocks.map((b, i) => [b.key, `p${i}`]));
    const nodes = p.blocks.map((b) => ({ ...b, id: ids.get(b.key)! }));
    const edges = p.blocks.flatMap((b) => b.after.filter((k) => ids.has(k)).map((k) => ({ from: ids.get(k)!, to: ids.get(b.key)! })));
    const stages = chainStages(nodes, edges);
    const block = (b: ProposedBlock): string => `
      <li class="tv-block${isNew(b) ? " is-new" : ""}" data-key="pb:${esc(b.key)}">
        <div class="tv-block-top">
          <p class="tv-block-name" title="${esc(b.path ? `${b.path}\\${b.name}` : b.name)}">${esc(b.name)}</p>
          ${isNew(b) ? `<span class="tm-pr-state tone-run">New</span>` : ""}
        </div>
        <p class="tv-block-meta">${esc(b.project)}${b.params ? ` · ${plural(Object.keys(b.params).length, "parameter")} changed` : ""}</p>
        <p class="tv-block-meta tv-block-branch">${svg("branch")}<span>${esc(branchText(b))}</span></p>
        <p class="tv-block-why">${esc(b.reason)}</p>
        ${evidenceHtml(b.evidence)}
        ${
          b.params
            ? `<p class="tv-block-params">${Object.entries(b.params)
                .map(([k, val]) => `<code>${esc(k)}</code> = <code>${esc(val)}</code>`)
                .join(" · ")}</p>`
            : ""
        }
        ${repoLineHtml(b.repoBranches)}
      </li>`;

    let diff = "";
    if (revises) {
      const added = p.blocks.filter(isNew).map((b) => b.name);
      const dropped = revises.chain.graph.nodes.filter((n) => !keys.has(nodeKey(n))).map((n) => n.name);
      const kept = p.blocks.length - added.length;
      diff = `<p class="tv-diff">${[
        added.length ? `<span class="tv-diff-add">Adds ${esc(added.join(", "))}</span>` : "",
        dropped.length ? `<span class="tv-diff-drop">Drops ${esc(dropped.join(", "))}</span>` : "",
        `<span>Keeps ${kept}</span>`,
      ]
        .filter(Boolean)
        .join(" · ")}</p>`;
    }
    const gone = !!p.chainId && !revises;
    const busy = chainBusy(revises);
    const off = !open ? ` disabled title="The task is done"` : busy ? ` disabled title="${esc(`${revises!.chain.name} is running`)}"` : "";
    const actions =
      dismissing === p.id
        ? `<form class="tv-dismiss" data-form="v-dismiss" data-proposal="${esc(p.id)}">
             <textarea rows="2" maxlength="1000" data-draft="dismiss:${esc(p.id)}" placeholder="Why not? ${esc(p.by)} reads this. (optional)" aria-label="Why you're dismissing it">${esc(
               drafts.get(`dismiss:${p.id}`) ?? ""
             )}</textarea>
             <div class="tv-actions">
               <button type="submit" class="btn sm">Dismiss</button>
               <button type="button" class="btn sm ghost" data-vact="dismiss-cancel">Cancel</button>
             </div>
           </form>`
        : `<div class="tv-actions">
             <button type="button" class="btn sm accent" data-vact="accept"${off}>${svg("check")}<span>Accept</span></button>
             <button type="button" class="btn sm" data-vact="accept-run"${off}>${svg("play")}<span>Accept and run</span></button>
             <button type="button" class="btn sm ghost" data-vact="accept-edit"${off}>Accept and edit in Pipelines</button>
             <button type="button" class="btn sm ghost" data-vact="dismiss">Dismiss</button>
           </div>
           ${busy ? `<p class="tm-muted">${esc(revises!.chain.name)} has runs going. Accept this when they finish, or stop them.</p>` : ""}`;

    return `<section class="tv-detail tv-card tv-proposal" data-key="d:${esc(sel)}" aria-label="Proposal: ${esc(p.name || "New chain")}">
        <div class="tv-d-head">
          <h4 class="tv-d-name" tabindex="-1" data-vfocus>${esc(p.name || revises?.chain.name || "New chain")}</h4>
          <span class="tm-pr-state tone-warn">${revises ? "Changes a chain" : "New chain"}</span>
        </div>
        <p class="tv-d-by">${svg("sparkle")}<span>Proposed by ${esc(p.by)} · ${esc(agoPhrase(p.at, now))}${
          revises ? ` · changes ` : ""
        }</span>${revises ? `<button type="button" class="tv-link" data-vact="goto" data-to="chain:${esc(revises.chain.id)}">${esc(revises.chain.name)}</button>` : ""}</p>
        ${p.purpose ? `<p class="tv-purpose">${esc(p.purpose)}</p>` : ""}
        ${p.summary ? `<p class="tv-summary">${esc(p.summary)}</p>` : ""}
        ${diff}
        <div class="tv-stages">${stages
          .map(
            (col, i) => `<div class="tv-stage" data-key="ps:${i}">
              <p class="tv-stage-h">Stage ${i + 1}</p>
              <ul class="tv-blocks">${col.map(block).join("")}</ul>
            </div>`
          )
          .join("")}</div>
        ${
          p.leftOut.length
            ? `<div class="tv-left-out"><p class="tv-sub">Left out</p><ul>${p.leftOut
                .map((l) => `<li><strong>${esc(l.name)}</strong> · ${esc(l.reason)}</li>`)
                .join("")}</ul></div>`
            : ""
        }
        <ul class="tv-checks">${p.checks.map((c) => `<li class="tm-sig tone-${c.tone}">${esc(c.text)}</li>`).join("")}</ul>
        ${
          revises
            ? `<p class="tv-note">${svg("warning")}<span>Accepting replaces the pipelines of ${esc(revises.chain.name)}. Its runs and settings stay.</span></p>`
            : gone
              ? `<p class="tv-note">${svg("warning")}<span>The chain it changes was removed. Accepting adds it as a new chain.</span></p>`
              : ""
        }
        ${actions}
      </section>`;
  }

  // ---- a new chain ----------------------------------------------------------------------------

  function newHtml(v: ValidationView): string {
    const open = v.taskStatus === "open";
    const listed = v.chains.length + v.proposals.length > 0;
    const full = v.chains.length >= v.limits.chains;
    const can = open && !full;
    const templates = v.templates.length
      ? `<select class="filter-select tv-template" aria-label="Saved chain to copy"${can ? "" : " disabled"}>${v.templates
          .map((t) => `<option value="${esc(t.id)}"${t.id === templatePick ? " selected" : ""}>${esc(t.name)} (${t.nodeCount})</option>`)
          .join("")}</select>
         <button type="button" class="btn sm" data-vact="copy"${can ? "" : " disabled"}>${svg("copy")}<span>Copy into this task</span></button>`
      : "";
    return `<section class="tv-detail tv-card tv-empty" data-key="d:new" aria-label="New validation chain">
        ${listed ? `<h4 class="tv-d-name" tabindex="-1" data-vfocus>New chain</h4>` : ""}
        ${
          v.chains.length
            ? ""
            : `<p class="tv-lead">A validation chain runs Azure DevOps pipelines in order to prove this task's change works: build the branch, deploy it to a test environment, run the tests.</p>`
        }
        <p class="tm-muted">A task can have several chains, each with its own purpose: a quick build check and a full deploy-and-test, for example. The task's workers share them and pick the one that fits.</p>
        ${full ? `<p class="tv-note">${svg("warning")}<span>This task has ${v.limits.chains} chains, the most it can have. Remove one to add another.</span></p>` : ""}
        <div class="tv-way">
          <p class="tv-sub">Let a worker find them</p>
          <p class="tm-muted">It looks at the builds the task's PRs must pass, the pipelines that use those builds, and chains you ran before, and proposes a chain with a reason for each pipeline${
            v.chains.length ? ", or a change to one of the chains here" : ""
          }. You review it here.</p>
          <div class="tv-actions"><button type="button" class="btn sm accent" data-vact="ask"${open && workers ? "" : " disabled"}>${svg("sparkle")}<span>Ask a worker to propose</span></button>${
            open && !workers ? `<span class="tm-muted">Start a worker on this task first.</span>` : ""
          }</div>
        </div>
        <div class="tv-way">
          <p class="tv-sub">Or build it yourself</p>
          <label class="tv-field"><span>Name</span><input type="text" class="tv-input" maxlength="120" data-draft="new:name" value="${esc(
            drafts.get("new:name") ?? ""
          )}" placeholder="Optional. For example: Build check"${can ? "" : " disabled"}></label>
          <label class="tv-field"><span>Purpose</span><textarea class="tv-input" rows="2" maxlength="${MAX_PURPOSE}" data-draft="new:purpose" placeholder="When to use it, so workers pick the right chain."${
            can ? "" : " disabled"
          }>${esc(drafts.get("new:purpose") ?? "")}</textarea></label>
          <div class="tv-actions">
            ${templates}
            <button type="button" class="btn sm ghost" data-vact="blank"${can ? "" : " disabled"}>${svg("add")}<span>Empty chain in Pipelines</span></button>
          </div>
        </div>
        <label class="tv-opt tv-auto"><input type="checkbox" data-vopt="auto"${v.autoPropose ? " checked" : ""}><span>For every task: when it gets a pull request, ask its worker to propose validation</span></label>
      </section>`;
  }

  // ---- actions -----------------------------------------------------------------------------

  async function withButton(button: HTMLElement | null, run: () => Promise<unknown>): Promise<void> {
    if (button instanceof HTMLButtonElement) button.disabled = true;
    try {
      await run();
    } catch (e) {
      toast((e as Error).message, "err");
      // What was on screen may be out of date (a newer proposal, a run that started): show what's there now.
      paintedSig = "";
      void load();
    } finally {
      if (button instanceof HTMLButtonElement && button.isConnected) button.disabled = false;
    }
  }

  const post = (action: string, body: Record<string, unknown> = {}) => postJSON(`/api/jarvis/validation/${action}`, { id: host.taskId, ...body });

  async function after(message?: string): Promise<void> {
    if (message) toast(message, "ok");
    paintedSig = "";
    await Promise.all([load(), host.refresh()]);
  }

  function goToPipelines(chainId: string): void {
    host.close();
    openChainInPipelines(chainId);
  }

  /** One toast for what a run request did, chain by chain. */
  function report(runs: RunOutcome[]): void {
    if (!runs.length) return;
    const bad = runs.filter((r) => r.status === "refused");
    if (runs.length === 1) return toast(runs[0].message, bad.length ? "warn" : "ok");
    const count = (s: RunOutcome["status"]) => runs.filter((r) => r.status === s).length;
    const parts = [
      count("started") ? `${count("started")} started` : "",
      count("queued") ? `${count("queued")} waiting their turn` : "",
      count("already") ? `${count("already")} already running for that` : "",
      bad.length ? `${bad.length} not run` : "",
    ].filter(Boolean);
    toast(`${parts.join(", ")}.${bad.length ? ` ${bad.map((r) => r.message).join(" ")}` : ""}`, bad.length ? "warn" : "ok");
  }

  /** The "whose code" picker for runs of chains that build whoever runs them. */
  function targetPickHtml(v: ValidationView, pre?: string): string {
    const ready = v.targets.filter((t) => t.ready);
    const pick = pre && ready.some((t) => t.id === pre) ? pre : ready[0]?.id;
    if (!v.targets.length) return `<p class="pa-note">${svg("warning")} No worker has a branch yet and the task has no open PR, so there's nothing for it to build.</p>`;
    const group = (kind: "worker" | "pr", label: string): string => {
      const list = v.targets.filter((t) => t.kind === kind);
      return list.length
        ? `<optgroup label="${label}">${list
            .map((t) => `<option value="${esc(t.id)}"${t.id === pick ? " selected" : ""}${t.ready ? "" : " disabled"}>${esc(`${t.label} · ${t.detail}`)}</option>`)
            .join("")}</optgroup>`
        : "";
    };
    return `<label class="tv-field tv-target-pick"><span>Build whose code</span><select class="filter-select" data-target-pick>${group("worker", "Workers")}${group(
      "pr",
      "Pull requests"
    )}</select></label>`;
  }

  function pickedTarget(dialog: HTMLElement, needed: boolean): string | undefined {
    const value = dialog.querySelector<HTMLSelectElement>("[data-target-pick]")?.value || undefined;
    if (needed && !value) throw new Error("Pick whose code to build.");
    return value;
  }

  /** Why a run would wait, so the dialog says so before it's queued. */
  function waitNotes(v: ValidationView, chains: ValidationChainView[]): string {
    const notes = chains
      .filter((c) => c.summary.running >= c.maxActive)
      .map((c) => `${c.chain.name} has ${plural(c.summary.running, "run")} going, so this one waits its turn.`);
    if (v.running >= v.limits.perTask) notes.push(`The task has ${v.running} runs going, the most at once. New runs wait their turn.`);
    return notes.map((n) => `<p class="pa-note">${svg("queue")} ${esc(n)}</p>`).join("");
  }

  function openRun(chains: ValidationChainView[], pre?: string): void {
    const v = view;
    if (!v || !chains.length) return;
    const one = chains.length === 1 ? chains[0] : null;
    const follows = chains.some((c) => c.followsRunner);
    const list = one
      ? `<ol class="tv-confirm-list">${one.chain.graph.nodes.map((n) => `<li><strong>${esc(n.name)}</strong> · ${esc(branchText(n))}</li>`).join("")}</ol>`
      : `<ul class="tv-confirm-list">${chains
          .map((c) => `<li><strong>${esc(c.chain.name)}</strong> · ${plural(c.chain.graph.nodes.length, "pipeline")}${c.followsRunner ? " · builds whoever runs it" : ""}</li>`)
          .join("")}</ul>`;
    const pick = follows
      ? `${targetPickHtml(v, pre)}${one ? "" : `<p class="pa-note">Only the chains that build whoever runs them use it. The others build the branches they name.</p>`}`
      : "";
    openActionDialog({
      title: one ? "Run validation" : `Run ${chains.length} chains`,
      loc: one ? one.chain.name : plural(chains.reduce((n, c) => n + c.chain.graph.nodes.length, 0), "pipeline"),
      body: `<p class="pa-note">Queues these pipelines in Azure DevOps, each after the ones it depends on. They run as you, and may deploy to the environments they target.</p>${list}${pick}${waitNotes(
        v,
        chains
      )}`,
      confirmLabel: "Run",
      onConfirm: async (dialog) => {
        const target = pickedTarget(dialog, follows);
        const res: { runs: RunOutcome[] } = await post("run", { chainIds: chains.map((c) => c.chain.id), target });
        report(res.runs);
        if (one) runPick.delete(one.chain.id);
        await after();
      },
    });
  }

  function openAcceptRun(p: ValidationProposal): void {
    const v = view;
    if (!v) return;
    const follows = p.blocks.some((b) => b.followRunner);
    openActionDialog({
      title: "Accept and run",
      loc: p.name || "New chain",
      body: `<p class="pa-note">Saves the chain to the task, then queues these pipelines in Azure DevOps, each after the ones it depends on. They run as you, and may deploy to the environments they target.</p>
        <ol class="tv-confirm-list">${p.blocks.map((b) => `<li><strong>${esc(b.name)}</strong> · ${esc(branchText(b))}</li>`).join("")}</ol>${follows ? targetPickHtml(v) : ""}`,
      confirmLabel: "Accept and run",
      onConfirm: async (dialog) => {
        const target = pickedTarget(dialog, follows);
        // The run goes ahead only for the proposal this dialog lists.
        const res: { chain: { id: string }; runs?: RunOutcome[] } = await post("accept", { proposalId: p.id, run: true, target });
        sel = `chain:${res.chain.id}`;
        if (res.runs) report(res.runs);
        await after(res.runs ? undefined : "Chain accepted");
      },
    });
  }

  function runMenu(anchor: HTMLElement, c: ValidationChainView): void {
    const v = view;
    if (!v) return;
    const entries: ContextMenuEntry[] = [];
    if (c.followsRunner && v.targets.length) {
      for (const t of v.targets) {
        entries.push({ label: `Run for ${t.label}`, icon: t.kind === "pr" ? "pullRequest" : "person", hint: t.detail, disabled: !t.ready, run: () => openRun([c], t.id) });
      }
    } else entries.push({ label: "Run", icon: "play", run: () => openRun([c]) });
    const runnable = v.chains.filter((x) => x.chain.graph.nodes.length);
    if (v.chains.length > 1) {
      entries.push({ label: `Run all ${runnable.length} chains…`, icon: "flow", sepBefore: true, disabled: runnable.length < 2, run: () => openRun(runnable) });
    }
    const r = anchor.getBoundingClientRect();
    openContextMenu(r.left, r.bottom + 4, `Ways to run ${c.chain.name}`, entries, () => anchor.focus());
  }

  /** The branch a block's YAML is read from: its PR's when it follows one (null when that isn't known here), the default when it builds whoever runs it, else its own. */
  function readBranch(n: ValidationNode): string | null {
    if (n.followRunner) return "";
    if (!n.branchFrom) return normalizeBranch(n.branch);
    const { org, prId } = n.branchFrom;
    const pr = view?.prs.find((p) => p.org.toLowerCase() === org.toLowerCase() && p.prId === prId);
    return pr?.sourceRef ? normalizeBranch(pr.sourceRef) : null;
  }

  function newChainFields(): { name?: string; purpose?: string } {
    const name = (drafts.get("new:name") ?? "").trim();
    const purpose = (drafts.get("new:purpose") ?? "").trim();
    return { ...(name ? { name } : {}), ...(purpose ? { purpose } : {}) };
  }

  function clearNewDrafts(): void {
    drafts.delete("new:name");
    drafts.delete("new:purpose");
  }

  function showRun(chainId: string, runId: string): void {
    runPick.set(chainId, runId);
    paintedSig = "";
    paint();
    host.panel.querySelector(".tv-stages")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (!view) return;
    const option = target.closest<HTMLElement>("[data-vsel]");
    if (option) return select(option.dataset.vsel || "", true);
    const node = target.closest<HTMLElement>("[data-vact]");
    if (!node) return;
    const v = view;
    const c = selectedChain(v);
    const p = selectedProposal(v);
    switch (node.dataset.vact) {
      case "open":
        return void (c && goToPipelines(c.chain.id));
      case "run":
        return void (c && openRun([c]));
      case "run-menu":
        return void (c && runMenu(node, c));
      case "show-run":
        return void (c && node.dataset.run && showRun(c.chain.id, node.dataset.run));
      case "filter": {
        if (!c) return;
        const who = node.dataset.who || "";
        if (who) runFilter.set(c.chain.id, who);
        else runFilter.delete(c.chain.id);
        paintedSig = "";
        return paint();
      }
      case "stop":
        return void withButton(node, async () => {
          await post("stop", { runId: node.dataset.run });
          await after("Stopping the run");
        });
      case "cancel-queued":
        return void (c && withButton(node, async () => {
          await post("stop", { queueId: node.dataset.queue, chainId: c.chain.id });
          await after("Taken off the queue");
        }));
      case "ack":
        return void withButton(node, async () => {
          await post("ack", { runId: node.dataset.run });
          await after();
        });
      case "edit-meta": {
        if (!c) return;
        settingsOpen.add(c.chain.id);
        paintedSig = "";
        paint();
        return void host.panel.querySelector<HTMLElement>(`[data-draft="purpose:${CSS.escape(c.chain.id)}"]`)?.focus();
      }
      case "goto":
        return select(node.dataset.to || "");
      case "reusable":
        return void (c && withButton(node, async () => {
          const res: { chain: { name: string } } = await post("reusable", { chainId: c.chain.id });
          await after(`Saved "${res.chain.name}" to your chains`);
        }));
      case "remove":
        return void (c && openActionDialog({
          title: "Remove chain",
          loc: c.chain.name,
          body: `<p class="pa-note">Deletes this chain and its run history from the task, and its workers can't run it anymore. Pipelines already queued in Azure DevOps aren't affected.</p>`,
          confirmLabel: "Remove",
          danger: true,
          onConfirm: async () => {
            await post("remove", { chainId: c.chain.id });
            for (const map of [runPick, runFilter]) map.delete(c.chain.id);
            settingsOpen.delete(c.chain.id);
            drafts.delete(`name:${c.chain.id}`);
            drafts.delete(`purpose:${c.chain.id}`);
            sel = "";
            await after(`Removed ${c.chain.name}`);
          },
        }));
      case "ask":
        return void withButton(node, async () => {
          const res: { message: string } = await post("ask");
          await after(res.message);
        });
      case "copy": {
        const from = templatePick || v.templates[0]?.id;
        return void withButton(node, async () => {
          const res: { chain: { id: string } } = await post("attach", { from, ...newChainFields() });
          clearNewDrafts();
          sel = `chain:${res.chain.id}`;
          await after("Chain copied into this task");
        });
      }
      case "blank":
        return void withButton(node, async () => {
          const res: { chain: { id: string } } = await post("attach", newChainFields());
          clearNewDrafts();
          sel = `chain:${res.chain.id}`;
          await after();
          goToPipelines(res.chain.id);
        });
      case "accept":
        return void (p && withButton(node, async () => {
          const res: { chain: { id: string } } = await post("accept", { proposalId: p.id });
          sel = `chain:${res.chain.id}`;
          await after("Chain accepted");
        }));
      case "accept-edit":
        return void (p && withButton(node, async () => {
          const res: { chain: { id: string } } = await post("accept", { proposalId: p.id });
          sel = `chain:${res.chain.id}`;
          await after();
          goToPipelines(res.chain.id);
        }));
      case "accept-run":
        return void (p && openAcceptRun(p));
      case "repos": {
        const block = c?.chain.graph.nodes.find((n) => n.id === node.dataset.node);
        if (!c || !block) return;
        return openRepoBranchesDialog({
          block,
          branch: readBranch(block),
          onSave: async (repos, was) => {
            const res: { warnings?: string[] } = await post("repos", { chainId: c.chain.id, nodeId: block.id, repoBranches: repos ?? null, was });
            if (res.warnings?.length) toast(`Saved. ${res.warnings.join(" ")}`, "warn");
            else toast(repos ? "Repository branches saved" : "Repository branches cleared", "ok");
            void after();
          },
        });
      }
      case "dismiss":
        if (!p) return;
        dismissing = p.id;
        paintedSig = "";
        return paint();
      case "dismiss-cancel":
        return cancelDismiss();
    }
  }

  function onSubmit(e: SubmitEvent): void {
    const form = e.target as HTMLFormElement;
    const kind = form.dataset.form;
    if (kind !== "v-meta" && kind !== "v-dismiss") return;
    e.preventDefault();
    const button = form.querySelector<HTMLElement>("button[type=submit]");
    if (kind === "v-dismiss") {
      const proposalId = form.dataset.proposal || "";
      return void withButton(button, async () => {
        await post("dismiss", { reason: drafts.get(`dismiss:${proposalId}`) ?? "", proposalId });
        drafts.delete(`dismiss:${proposalId}`);
        dismissing = "";
        sel = "";
        await after("Proposal dismissed");
      });
    }
    const chainId = form.dataset.chain || "";
    const c = view?.chains.find((x) => x.chain.id === chainId);
    if (!c) return;
    const name = (drafts.get(`name:${chainId}`) ?? c.chain.name).trim();
    const purpose = (drafts.get(`purpose:${chainId}`) ?? c.purpose).trim();
    if (!name) return toast("Give the chain a name.", "warn");
    void withButton(button, async () => {
      await post("options", { chainId, name, purpose });
      drafts.delete(`name:${chainId}`);
      drafts.delete(`purpose:${chainId}`);
      await after("Saved");
    });
  }

  function onInput(e: Event): void {
    const field = e.target as HTMLInputElement | HTMLTextAreaElement;
    const key = field.dataset?.draft;
    if (!key) return;
    drafts.set(key, field.value);
    // Save turns on once the name or purpose differs from what's saved.
    const form = field.closest<HTMLFormElement>("form[data-form='v-meta']");
    const c = form && view?.chains.find((x) => x.chain.id === form.dataset.chain);
    const save = form?.querySelector<HTMLButtonElement>("[data-save]");
    if (!c || !save) return;
    const name = (drafts.get(`name:${c.chain.id}`) ?? c.chain.name).trim();
    const purpose = (drafts.get(`purpose:${c.chain.id}`) ?? c.purpose).trim();
    save.disabled = name === c.chain.name && purpose === c.purpose;
  }

  function onChange(e: Event): void {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLSelectElement) {
      if (t.classList.contains("tv-template")) {
        templatePick = t.value;
        return;
      }
      if (t.dataset.vrun) return showRun(t.dataset.vrun, t.value);
      const chainId = t.dataset.vconc;
      if (!chainId) return;
      const was = view?.chains.find((x) => x.chain.id === chainId)?.concurrency;
      const value = t.value;
      return void withButton(t, async () => {
        try {
          await post("options", { chainId, concurrency: value });
          await after();
        } catch (err) {
          if (was) t.value = was;
          throw err;
        }
      });
    }
    const box = t as HTMLInputElement;
    const opt = box.dataset?.vopt;
    if (!opt) return;
    const on = box.checked;
    void withButton(box, async () => {
      try {
        if (opt === "auto") await postJSON("/api/jarvis/validation/auto", { on });
        else await post("options", { chainId: box.dataset.chain, [opt]: on });
        await after();
      } catch (err) {
        box.checked = !on;
        throw err;
      }
    });
  }

  /** The list is one tab stop: arrows, Home and End move the selection; Enter goes to what's selected. */
  function onKeydown(e: KeyboardEvent): void {
    const list = e.target as HTMLElement;
    if (!view || !list.classList?.contains("tv-list")) return;
    const keys = listKeys(view);
    const i = Math.max(0, keys.indexOf(sel));
    let next: number;
    switch (e.key) {
      case "ArrowDown":
        next = Math.min(keys.length - 1, i + 1);
        break;
      case "ArrowUp":
        next = Math.max(0, i - 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = keys.length - 1;
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        host.panel.querySelector<HTMLElement>(".tv-detail [data-vfocus]")?.focus();
        return;
      default:
        return;
    }
    e.preventDefault();
    select(keys[next], true);
  }

  function onToggle(e: Event): void {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.classList.contains("tv-settings")) return;
    const id = d.dataset.chain || "";
    if (d.open) settingsOpen.add(id);
    else settingsOpen.delete(id);
  }

  return { sync, shown, escape };
}
