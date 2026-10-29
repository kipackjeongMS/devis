// The task sheet's Validation tab: the task's own pipeline chain, its runs, and a
// worker's proposal to review. The chain is edited in the Pipelines tab; here the
// user sees why each pipeline is there, runs it, and decides on proposals.

import { getJSON, postJSON } from "./api.js";
import { esc } from "./util.js";
import { icon, type IconName } from "./icons.js";
import { patchHtml } from "./patch.js";
import { toast } from "./toast.js";
import { openActionDialog } from "./prActions.js";
import { statusLabel, statusTone } from "./pipelineModel.js";
import {
  agoPhrase,
  chainStages,
  validationChip,
  type ProposedBlock,
  type TodayTask,
  type ValidationEvidence,
  type ValidationNode,
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

const svg = (name: IconName): string => icon(name);

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

export function createValidationPanel(host: ValidationHost): ValidationPanel {
  let view: ValidationView | null = null;
  let error = "";
  let token = 0;
  let loadedAt = 0;
  let todaySig = "";
  let dismissing = false;
  let dismissText = "";
  let templatePick = "";
  let workers = 0;
  let paintedSig = "";

  host.panel.addEventListener("click", onClick);
  host.panel.addEventListener("submit", onSubmit);
  host.panel.addEventListener("change", onChange);
  host.panel.addEventListener("input", (e) => {
    const field = e.target as HTMLElement;
    if (field instanceof HTMLTextAreaElement && field.closest(".tv-dismiss")) dismissText = field.value;
  });

  async function load(): Promise<void> {
    const mine = ++token;
    loadedAt = Date.now();
    try {
      const next: ValidationView = await getJSON(`/api/jarvis/validation?id=${encodeURIComponent(host.taskId)}`);
      if (mine !== token) return;
      view = next;
      error = "";
    } catch (e) {
      if (mine !== token) return;
      error = (e as Error).message;
    }
    paint();
  }

  function sync(task: TodayTask): void {
    workers = task.workers.length;
    const v = task.validation;
    const chip = validationChip(v);
    host.badge.className = `tm-ltab-dot tm-val-dot${chip ? ` tone-${chip.tone}` : ""}`;
    host.badge.hidden = !chip;
    host.badge.title = chip?.text || "";
    if (!host.visible()) return;
    const sig = JSON.stringify([v?.chainId, v?.blocks, v?.attention, v?.proposal?.at, v?.run && [v.run.runId, v.run.status, v.run.done, v.run.current], task.status, workers]);
    const age = Date.now() - loadedAt;
    const running = view?.run?.status === "running";
    if (!loadedAt || sig !== todaySig || age > 60_000 || (running && age > 5_000)) {
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
    dismissing = false;
    dismissText = "";
    paintedSig = "";
    paint();
    host.panel.querySelector<HTMLElement>("[data-vact='dismiss']")?.focus();
  }

  // ---- paint ----------------------------------------------------------------------------

  function paint(): void {
    const minute = Math.floor(Date.now() / 60_000);
    const sig = JSON.stringify([view, error, dismissing, dismissText, templatePick, workers, minute]);
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
    if (v.proposal) parts.push(proposalHtml(v));
    if (v.chain) parts.push(chainHtml(v));
    else if (!v.proposal) parts.push(emptyHtml(v));
    patchHtml(host.panel, parts.join(""));
    const reason = host.panel.querySelector<HTMLTextAreaElement>(".tv-dismiss textarea");
    if (reason && dismissing && document.activeElement !== reason && !reason.dataset.focused) {
      reason.dataset.focused = "1";
      reason.focus();
    }
  }

  function prLabel(org: string, prId: number): string {
    const pr = view?.prs.find((p) => p.org.toLowerCase() === org.toLowerCase() && p.prId === prId);
    return pr ? `PR ${prId} · ${pr.sourceRef}` : `PR ${prId}`;
  }

  function branchText(n: { branch: string; branchFrom?: { org: string; prId: number } }): string {
    if (n.branchFrom) return `Follows ${prLabel(n.branchFrom.org, n.branchFrom.prId)}`;
    return n.branch ? n.branch : "Default branch";
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

  function proposalHtml(v: ValidationView): string {
    const p = v.proposal!;
    const now = Date.now();
    const ids = new Map(p.blocks.map((b, i) => [b.key, `p${i}`]));
    const nodes = p.blocks.map((b) => ({ ...b, id: ids.get(b.key)! }));
    const edges = p.blocks.flatMap((b) => b.after.filter((k) => ids.has(k)).map((k) => ({ from: ids.get(k)!, to: ids.get(b.key)! })));
    const stages = chainStages(nodes, edges);
    const block = (b: ProposedBlock) => `
      <li class="tv-block" data-key="pb:${esc(b.key)}">
        <p class="tv-block-name" title="${esc(b.path ? `${b.path}\\${b.name}` : b.name)}">${esc(b.name)}</p>
        <p class="tv-block-meta">${esc(b.project)}${b.params ? ` · ${Object.keys(b.params).length} parameter${Object.keys(b.params).length === 1 ? "" : "s"} changed` : ""}</p>
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
        ${
          b.repoBranches
            ? `<p class="tv-block-params">${Object.entries(b.repoBranches)
                .map(([alias, br]) => `<code>${esc(alias)}</code> on <code>${esc(br)}</code>`)
                .join(" · ")}</p>`
            : ""
        }
      </li>`;
    return `
      <section class="tv-card tv-proposal" data-key="proposal" aria-label="Proposed validation">
        <div class="tm-dv-bar">
          <h4 class="tm-dv-h">Proposed</h4>
          <span class="tm-dv-fresh">by ${esc(p.by)} · ${esc(agoPhrase(p.at, now))}</span>
        </div>
        ${p.summary ? `<p class="tv-summary">${esc(p.summary)}</p>` : ""}
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
        ${v.chain ? `<p class="tv-note">${svg("warning")}<span>Accepting replaces the task's current chain.</span></p>` : ""}
        ${
          dismissing
            ? `<form class="tv-dismiss" data-form="v-dismiss">
                 <textarea rows="2" maxlength="1000" placeholder="Why not? ${esc(p.by)} reads this. (optional)" aria-label="Why you're dismissing it">${esc(dismissText)}</textarea>
                 <div class="tv-actions">
                   <button type="submit" class="btn sm">Dismiss</button>
                   <button type="button" class="btn sm ghost" data-vact="dismiss-cancel">Cancel</button>
                 </div>
               </form>`
            : `<div class="tv-actions">
                 <button type="button" class="btn sm accent" data-vact="accept"${v.taskStatus === "done" ? " disabled" : ""}>Accept</button>
                 <button type="button" class="btn sm" data-vact="accept-run"${v.taskStatus === "done" ? " disabled" : ""}>${svg("play")}<span>Accept and run</span></button>
                 <button type="button" class="btn sm ghost" data-vact="accept-edit"${v.taskStatus === "done" ? " disabled" : ""}>Accept and edit in Pipelines</button>
                 <button type="button" class="btn sm ghost" data-vact="dismiss">Dismiss</button>
               </div>`
        }
      </section>`;
  }

  function chainHtml(v: ValidationView): string {
    const c = v.chain!;
    const run = v.run;
    const now = Date.now();
    const running = run?.status === "running";
    const stages = chainStages(c.graph.nodes, c.graph.edges);
    const followsPr = c.graph.nodes.some((n) => n.branchFrom);
    const node = (n: ValidationNode) => {
      const st = run?.states[n.id];
      const status = st?.status || (run ? "skipped" : "");
      const tone = status ? statusTone(status) : "idle";
      const why = v.evidence[`${n.org.toLowerCase()}/${n.project.toLowerCase()}/${n.definitionId}`];
      return `
        <li class="tv-block tone-${tone}" data-key="n:${esc(n.id)}">
          <div class="tv-block-top">
            <p class="tv-block-name" title="${esc(n.path ? `${n.path}\\${n.name}` : n.name)}">${esc(n.name)}</p>
            ${status ? `<span class="tm-pr-state tone-${tone}">${esc(statusLabel(status))}</span>` : ""}
          </div>
          <p class="tv-block-meta">${esc(n.project)}</p>
          <p class="tv-block-meta tv-block-branch">${svg("branch")}<span>${esc(st?.branch ? `Built ${st.branch.replace(/^refs\/heads\//, "")}` : branchText(n))}</span></p>
          ${st?.buildNumber ? `<p class="tv-block-meta">${st.url ? `<a href="${esc(st.url)}" target="_blank" rel="noopener">Build ${esc(st.buildNumber)}</a>` : `Build ${esc(st.buildNumber)}`}</p>` : ""}
          ${st?.error ? `<p class="tv-block-err">${esc(st.error)}</p>` : ""}
          ${why ? `<p class="tv-block-why">${esc(why.reason)}</p>${evidenceHtml(why.evidence)}` : ""}
        </li>`;
    };
    const failedUnseen = run?.status === "failed" && v.ackedRunId !== run.runId;
    const runButton = running
      ? `<button type="button" class="btn sm" data-vact="stop"${run?.cancelRequested ? " disabled" : ""}>${svg("stop")}<span>${run?.cancelRequested ? "Stopping…" : "Stop"}</span></button>`
      : `<button type="button" class="btn sm accent" data-vact="run"${v.taskStatus === "done" || !c.graph.nodes.length ? " disabled" : ""}>${svg("play")}<span>Run</span></button>`;
    return `
      <section class="tv-card" data-key="chain" aria-label="Validation chain">
        <div class="tm-dv-bar">
          <h4 class="tm-dv-h">Validation chain</h4>
          <span class="tm-dv-fresh" title="${esc(c.name)}">${c.graph.nodes.length} pipeline${c.graph.nodes.length === 1 ? "" : "s"}${
            v.acceptedBy && v.acceptedBy !== "you" ? ` · proposed by ${esc(v.acceptedBy)}` : ""
          }</span>
          <button type="button" class="btn sm ghost" data-vact="open">${svg("external")}<span>Open in Pipelines</span></button>
          ${runButton}
        </div>
        ${
          failedUnseen
            ? `<div class="tv-alert tone-bad" data-key="failed">${svg("warning")}<span>${esc(v.runs[0]?.text || "Validation failed")}</span>
                 <button type="button" class="btn sm ghost" data-vact="ack">Got it</button></div>`
            : ""
        }
        ${
          c.graph.nodes.length
            ? `<div class="tv-stages">${stages
                .map(
                  (col, i) => `<div class="tv-stage" data-key="s:${i}">
                    <p class="tv-stage-h">Stage ${i + 1}</p>
                    <ul class="tv-blocks">${col.map(node).join("")}</ul>
                  </div>`
                )
                .join("")}</div>`
            : `<p class="tm-muted">No pipelines yet. Add them in Pipelines, or ask a worker to propose some.</p>`
        }
        ${
          v.runs.length
            ? `<p class="tv-sub">Runs</p><ul class="tv-runs">${v.runs
                .map(
                  (r) =>
                    `<li data-key="r:${esc(r.runId)}"><span class="tm-sig tone-${r.status === "succeeded" ? "ok" : r.status === "running" ? "run" : r.status === "failed" ? "bad" : "off"}">${esc(r.text)}</span><time datetime="${esc(r.createdAt)}">${esc(agoPhrase(r.createdAt, now))}</time></li>`
                )
                .join("")}</ul>`
            : `<p class="tm-muted">It hasn't run yet.</p>`
        }
        <div class="tv-options">
          <label class="tv-opt"><input type="checkbox" data-vopt="notifyWorker"${v.notifyWorker ? " checked" : ""}><span>Tell the task's worker what failed, with the build's failed steps</span></label>
          <label class="tv-opt${followsPr ? "" : " is-off"}" title="${followsPr ? "" : "No pipeline here follows a PR's branch."}"><input type="checkbox" data-vopt="rerunOnCommit"${v.rerunOnCommit ? " checked" : ""}${followsPr ? "" : " disabled"}><span>Run again when a followed PR gets new commits</span></label>
        </div>
        <div class="tv-actions tv-foot">
          <button type="button" class="btn sm ghost" data-vact="reusable"${c.graph.nodes.length ? "" : " disabled"}>${svg("copy")}<span>Save as a reusable chain</span></button>
          ${!v.proposal && v.taskStatus === "open" ? `<button type="button" class="btn sm ghost" data-vact="ask"${workers ? "" : " disabled title=\"Start a worker first\""}>${svg("sparkle")}<span>Ask a worker to propose changes</span></button>` : ""}
          <button type="button" class="btn sm ghost tv-remove" data-vact="remove"${running ? ' disabled title="Stop the run first"' : ""}>${svg("trash")}<span>Remove</span></button>
        </div>
      </section>`;
  }

  function emptyHtml(v: ValidationView): string {
    const open = v.taskStatus === "open";
    return `
      <section class="tv-card tv-empty" data-key="empty" aria-label="Validation">
        <p class="tv-lead">A validation chain runs Azure DevOps pipelines in order to prove this task's change works: build the PR's branch, deploy it to a test environment, run the tests.</p>
        <div class="tv-way">
          <p class="tv-sub">Let a worker find them</p>
          <p class="tm-muted">It looks at the builds the task's PRs must pass, the pipelines that use those builds, and chains you ran before, and proposes a chain with a reason for each pipeline. You review it here.</p>
          <div class="tv-actions"><button type="button" class="btn sm accent" data-vact="ask"${open && workers ? "" : " disabled"}>${svg("sparkle")}<span>Ask a worker to propose</span></button>${
            open && !workers ? `<span class="tm-muted">Start a worker on this task first.</span>` : ""
          }</div>
        </div>
        <div class="tv-way">
          <p class="tv-sub">Or build it yourself</p>
          <div class="tv-actions">
            ${
              v.templates.length
                ? `<select class="filter-select tv-template" aria-label="Saved chain to copy">${v.templates
                    .map((t) => `<option value="${esc(t.id)}"${t.id === templatePick ? " selected" : ""}>${esc(t.name)} (${t.nodeCount})</option>`)
                    .join("")}</select>
                   <button type="button" class="btn sm" data-vact="copy"${open ? "" : " disabled"}>${svg("copy")}<span>Copy into this task</span></button>`
                : ""
            }
            <button type="button" class="btn sm ghost" data-vact="blank"${open ? "" : " disabled"}>${svg("add")}<span>Empty chain in Pipelines</span></button>
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

  function runList(nodes: Array<{ name: string; branch: string; branchFrom?: { org: string; prId: number } }>): string {
    return `<ol class="tv-confirm-list">${nodes.map((n) => `<li><strong>${esc(n.name)}</strong> · ${esc(branchText(n))}</li>`).join("")}</ol>`;
  }

  function confirmRun(nodes: Array<{ name: string; branch: string; branchFrom?: { org: string; prId: number } }>, label: string, go: () => Promise<void>): void {
    openActionDialog({
      title: "Run validation",
      loc: `${nodes.length} pipeline${nodes.length === 1 ? "" : "s"}`,
      body: `<p class="pa-note">Queues these pipelines in Azure DevOps, each after the ones it depends on. They run as you, and may deploy to the environments they target.</p>${runList(nodes)}`,
      confirmLabel: label,
      onConfirm: go,
    });
  }

  function onClick(e: MouseEvent): void {
    const node = (e.target as HTMLElement).closest<HTMLElement>("[data-vact]");
    if (!node || !view) return;
    const v = view;
    switch (node.dataset.vact) {
      case "open":
        return void (v.chain && goToPipelines(v.chain.id));
      case "run":
        return void (v.chain && confirmRun(v.chain.graph.nodes, "Run", async () => {
          await post("run");
          await after("Validation started");
        }));
      case "stop":
        return void withButton(node, async () => {
          await post("stop");
          await after("Stopping the run");
        });
      case "ack":
        return void withButton(node, async () => {
          await post("ack", { runId: v.run?.runId });
          await after();
        });
      case "reusable":
        return void withButton(node, async () => {
          const res: { chain: { name: string } } = await post("reusable");
          await after(`Saved "${res.chain.name}" to your chains`);
        });
      case "remove":
        return void openActionDialog({
          title: "Remove validation",
          loc: v.chain?.name || "",
          body: `<p class="pa-note">Deletes this task's validation chain and its run history. Pipelines already queued in Azure DevOps aren't affected.</p>`,
          confirmLabel: "Remove",
          danger: true,
          onConfirm: async () => {
            await post("remove");
            await after("Validation removed");
          },
        });
      case "ask":
        return void withButton(node, async () => {
          const res: { message: string } = await post("ask");
          await after(res.message);
        });
      case "copy": {
        const from = host.panel.querySelector<HTMLSelectElement>(".tv-template")?.value;
        return void withButton(node, async () => {
          await post("attach", { from });
          await after("Chain copied into this task");
        });
      }
      case "blank":
        return void withButton(node, async () => {
          const res: { chain: { id: string } } = await post("attach");
          await after();
          goToPipelines(res.chain.id);
        });
      case "accept":
        return void (v.proposal && withButton(node, async () => {
          await post("accept", { proposalId: v.proposal!.id });
          await after("Validation accepted");
        }));
      case "accept-edit":
        return void (v.proposal && withButton(node, async () => {
          const res: { chain: { id: string } } = await post("accept", { proposalId: v.proposal!.id });
          await after();
          goToPipelines(res.chain.id);
        }));
      case "accept-run": {
        const p = v.proposal;
        if (!p) return;
        // The run goes ahead only for the proposal this dialog lists.
        return confirmRun(p.blocks, "Accept and run", async () => {
          await post("accept", { proposalId: p.id, run: true });
          await after("Validation accepted and started");
        });
      }
      case "dismiss":
        dismissing = true;
        paintedSig = "";
        return paint();
      case "dismiss-cancel":
        return cancelDismiss();
    }
  }

  function onSubmit(e: SubmitEvent): void {
    const form = e.target as HTMLFormElement;
    if (form.dataset.form !== "v-dismiss") return;
    e.preventDefault();
    const reason = form.querySelector("textarea")?.value || "";
    const proposalId = view?.proposal?.id;
    if (!proposalId) return;
    void withButton(form.querySelector("button[type=submit]"), async () => {
      await post("dismiss", { reason, proposalId });
      dismissing = false;
      dismissText = "";
      await after("Proposal dismissed");
    });
  }

  function onChange(e: Event): void {
    if (e.target instanceof HTMLSelectElement && e.target.classList.contains("tv-template")) {
      templatePick = e.target.value;
      return;
    }
    const box = e.target as HTMLInputElement;
    const opt = box.dataset?.vopt;
    if (!opt) return;
    const on = box.checked;
    void withButton(box as unknown as HTMLElement, async () => {
      try {
        if (opt === "auto") await postJSON("/api/jarvis/validation/auto", { on });
        else await post("options", { [opt]: on });
        await after();
      } catch (err) {
        box.checked = !on;
        throw err;
      }
    });
  }

  return { sync, shown, escape };
}
