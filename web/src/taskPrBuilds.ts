// The build side of the task's PR feedback tab: a PR's failed blocking builds, the worker's
// plan for each one (a fix or a rerun), and the user's call on it. Nothing reruns and no code
// changes until the user accepts; reruns go out now, approved fixes go to the worker.

import { postJSON } from "./api.js";
import { esc } from "./util.js";
import { icon, type IconName } from "./icons.js";
import { toast } from "./toast.js";
import { openActionDialog } from "./prActions.js";
import {
  agoPhrase,
  type BuildDecision,
  type BuildDecisionAction,
  type BuildProposal,
  type BuildProposalItem,
  type BuildReviewState,
  type PrBuildsPr,
  type PrBuildsView,
} from "./jarvisModel.js";

export interface BuildsHost {
  taskId: string;
  open(): boolean;
  workers(): number;
  auto(): boolean;
  paint(): void;
  /** Throw away what's painted and load again. */
  reload(): void;
  /** Toast, then reload the panel and Today. */
  after(message?: string): Promise<void>;
  withButton(button: HTMLElement | null, run: () => Promise<unknown>): Promise<void>;
}

export interface BuildsPart {
  /** The PR has failed builds, a review or a fix to show. */
  shows(pr: PrBuildsPr): boolean;
  state(pr: PrBuildsPr): { label: string; tone: string };
  html(pr: PrBuildsPr): string;
  onClick(node: HTMLElement, pr: PrBuildsPr): void;
  /** True when the event was for a builds field. */
  onChange(t: HTMLElement, pr: PrBuildsPr): boolean;
  onInput(t: HTMLElement, pr: PrBuildsPr): boolean;
  prune(view: PrBuildsView): void;
  /** This task's drafts, for the panel's paint signature. */
  drafts(): unknown;
}

const svg = (name: IconName): string => icon(name);

const STATE: Record<BuildReviewState, { label: string; tone: string }> = {
  watching: { label: "Waiting on builds", tone: "run" },
  failed: { label: "Failed", tone: "bad" },
  auditing: { label: "Reviewing", tone: "run" },
  awaiting: { label: "Plan ready", tone: "warn" },
  applying: { label: "Fixing", tone: "run" },
  error: { label: "Went wrong", tone: "bad" },
};

const CONFIDENCE: Record<BuildProposalItem["confidence"], string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

const ACTION_LABEL: Record<BuildDecisionAction, string> = {
  fix: "Make the fix",
  rerun: "Rerun the build",
  skip: "Leave it",
};

interface Draft {
  action?: BuildDecisionAction;
  choice?: string;
  note?: string;
}

interface Decided {
  action: BuildDecisionAction;
  choice: string;
  note: string;
}

/** Decisions in progress, by task, PR, proposal and build; they outlive closing the task sheet. */
const drafts = new Map<string, Draft>();

const prKey = (pr: { org: string; prId: number }): string => `${pr.org.toLowerCase()}|${pr.prId}`;
const shortBranch = (ref: string): string => ref.replace(/^refs\/heads\//, "");
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function verdictOf(item: BuildProposalItem): { label: string; tone: string } {
  if (item.verdict === "fix") return item.options?.length ? { label: "Pick a fix", tone: "warn" } : { label: "Fix ready", tone: "ok" };
  if (item.verdict === "rerun") return { label: "Rerun it", tone: "idle" };
  return { label: "Your call", tone: "warn" };
}

const allowed = (item: BuildProposalItem): BuildDecisionAction[] => (item.verdict === "fix" ? ["fix", "rerun", "skip"] : ["rerun", "skip"]);

/** What the user has decided for a build so far, with the plan's defaults filled in. */
function decided(item: BuildProposalItem, d: Draft): Decided {
  const fallback: BuildDecisionAction = item.verdict === "fix" ? "fix" : item.verdict === "rerun" ? "rerun" : "skip";
  return {
    action: d.action && allowed(item).includes(d.action) ? d.action : fallback,
    choice: d.choice ?? item.recommended ?? item.options?.[0]?.id ?? "",
    note: d.note ?? "",
  };
}

function planText(item: BuildProposalItem, d: Decided): string {
  const pick = item.options?.find((o) => o.id === d.choice);
  return pick ? `${pick.label}: ${pick.plan}` : item.plan;
}

export function createBuildsPart(host: BuildsHost): BuildsPart {
  const draftKey = (pr: { org: string; prId: number }, proposalId: string, evaluationId: string): string =>
    `${host.taskId}|${prKey(pr)}|${proposalId}|${evaluationId}`;

  const draftOf = (pr: PrBuildsPr, p: BuildProposal, item: BuildProposalItem): Decided =>
    decided(item, drafts.get(draftKey(pr, p.id, item.evaluationId)) ?? {});

  function clearDrafts(pr: { org: string; prId: number }, proposalId: string | undefined): void {
    if (!proposalId) return;
    const prefix = `${host.taskId}|${prKey(pr)}|${proposalId}|`;
    for (const k of [...drafts.keys()]) if (k.startsWith(prefix)) drafts.delete(k);
  }

  function prune(v: PrBuildsView): void {
    const live = v.prs.filter((p) => p.proposal).map((p) => `${host.taskId}|${prKey(p)}|${p.proposal!.id}|`);
    for (const k of [...drafts.keys()]) {
      if (k.startsWith(`${host.taskId}|`) && !live.some((prefix) => k.startsWith(prefix))) drafts.delete(k);
    }
  }

  function shows(pr: PrBuildsPr): boolean {
    if (pr.state !== "watching") return true;
    return !!pr.proposal || (pr.failures.length > 0 && pr.pending.length > 0);
  }

  const state = (pr: PrBuildsPr) => STATE[pr.state];

  // ---- paint ----------------------------------------------------------------------------

  function auditButton(label: string, primary = false): string {
    const off = !host.open() ? "The task is done" : !host.workers() ? "Start a worker first" : "";
    return `<button type="button" class="btn sm${primary ? " accent" : " ghost"}" data-bact="audit"${off ? ` disabled title="${off}"` : ""}>${svg("sparkle")}<span>${label}</span></button>`;
  }

  function failuresHtml(pr: PrBuildsPr): string {
    if (!pr.failures.length) return "";
    return `<ul class="tpb-fails">${pr.failures
      .map((f) => {
        const name = f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a>` : esc(f.name);
        const how = f.status === "broken" ? "couldn't run" : "failed";
        return `<li data-key="f:${esc(f.evaluationId)}">${name} · ${how}${f.manual ? " · reruns only when queued" : ""}</li>`;
      })
      .join("")}</ul>`;
  }

  function html(pr: PrBuildsPr): string {
    const who = pr.proposal?.by || pr.worker || "The worker";
    switch (pr.state) {
      case "watching": {
        if (pr.proposal) return proposalHtml(pr, pr.proposal);
        const names = clip(pr.pending.join(", "), 160);
        const then = host.auto() ? "The failures are reviewed once they finish." : "Review the failures once they finish.";
        return `<p class="tpc-line"><span class="spinner"></span> ${esc(`${plural(pr.pending.length, "blocking build is", "blocking builds are")} still running (${names}). ${then}`)}</p>${failuresHtml(pr)}`;
      }
      case "auditing":
        return `<p class="tpc-line"><span class="spinner"></span> ${esc(who)} is reading the build logs and the code. Nothing reruns or changes until you accept.</p>${failuresHtml(pr)}`;
      case "awaiting":
        return pr.proposal ? proposalHtml(pr, pr.proposal) : `<p class="tpc-line"><span class="spinner"></span> Updating the plan…</p>`;
      case "applying":
        return applyingHtml(pr, who);
      case "error": {
        const alert = `<div class="tv-alert tone-bad">${svg("warning")}<span>${esc(pr.note || "Something went wrong with the build review.")}</span></div>`;
        if (pr.apply?.commit) {
          return `${alert}
            <p class="tpc-line">Pushed as <code>${esc(pr.apply.commit.slice(0, 8))}</code>. Check the commit and the builds, then review again or dismiss this.</p>
            <div class="tv-actions">${auditButton("Review again")}<button type="button" class="btn sm ghost" data-bact="dismiss">Dismiss</button></div>`;
        }
        if (pr.proposal) return alert + proposalHtml(pr, pr.proposal);
        return `${alert}${failuresHtml(pr)}<div class="tv-actions">${auditButton("Review again")}<button type="button" class="btn sm ghost" data-bact="dismiss">Leave them</button></div>`;
      }
      default: {
        const line = pr.note
          ? `<div class="tv-alert tone-bad">${svg("warning")}<span>${esc(pr.note)}</span></div>`
          : `<p class="tpc-line tm-muted">${esc(
              pr.handled
                ? "You've dealt with these failures. The worker looks again when the builds change."
                : !host.auto()
                  ? "Automatic review is off. Review them to get a fix or a rerun proposed."
                  : !host.workers()
                    ? "Start a worker to have these reviewed."
                    : `${who} reviews these once it's free.`
            )}</p>`;
        const leave = !pr.handled ? `<button type="button" class="btn sm ghost" data-bact="dismiss">Leave them</button>` : "";
        return `${failuresHtml(pr)}${line}<div class="tv-actions">${auditButton("Review now", true)}${leave}</div>`;
      }
    }
  }

  function applyingHtml(pr: PrBuildsPr, who: string): string {
    const a = pr.apply;
    const line = a?.sentAt ? `${who} is making the fixes. The builds rerun once it pushes.` : `${who} gets the fixes when its current turn ends.`;
    const items = a?.items.length
      ? `<ul class="tpc-applying">${a.items.map((i) => `<li data-key="a:${esc(i.evaluationId)}"><strong>${esc(i.name)}</strong> · ${esc(i.plan)}</li>`).join("")}</ul>`
      : "";
    const reruns = (a?.requeue || []).filter((q) => !a!.items.some((i) => i.evaluationId === q.evaluationId)).map((q) => q.name);
    return `
      <p class="tpc-line"><span class="spinner"></span> ${esc(line)}</p>
      ${items}
      ${reruns.length ? `<p class="tpc-line tm-muted">${esc(`Then reruns ${reruns.join(", ")}.`)}</p>` : ""}
      <div class="tv-actions"><button type="button" class="btn sm ghost" data-bact="cancel">${svg("stop")}<span>Cancel the fixes</span></button></div>`;
  }

  function proposalHtml(pr: PrBuildsPr, p: BuildProposal): string {
    const fixing = p.items.some((item) => draftOf(pr, p, item).action === "fix");
    const done = pr.apply?.proposalId === p.id ? pr.apply.requeued.length : 0;
    return `
      <div class="tpc-proposal" data-key="bp:${esc(p.id)}">
        <p class="tv-sub">${esc(p.by)}'s plan · ${esc(agoPhrase(p.at, Date.now()))}</p>
        ${p.summary ? `<p class="tv-summary">${esc(p.summary)}</p>` : ""}
        ${done ? `<p class="tpc-line">${esc(`${plural(done, "build was", "builds were")} rerun already. Accept again to rerun the rest.`)}</p>` : ""}
        <ul class="tpc-items">${p.items.map((item) => itemHtml(pr, p, item, fixing)).join("")}</ul>
        <p class="tpc-line tm-muted">Nothing reruns and no code changes until you accept.</p>
        <div class="tv-actions">
          <button type="button" class="btn sm accent" data-bact="accept"${host.open() ? "" : " disabled"}>${svg("check")}<span>Accept</span></button>
          ${auditButton("Review again")}
          <button type="button" class="btn sm ghost" data-bact="dismiss">Dismiss</button>
        </div>
      </div>`;
  }

  function hint(pr: PrBuildsPr, item: BuildProposalItem, d: Decided, who: string, fixing: boolean): string {
    const manual = pr.failures.find((f) => f.evaluationId === item.evaluationId)?.manual;
    switch (d.action) {
      case "fix":
        return `${who} makes the change, runs the tests and pushes. ${manual ? "The app reruns this build after the push." : "The push reruns the build."}`;
      case "rerun":
        return fixing ? "Reruns once the fixes are pushed." : "Reruns now, with no code change.";
      default:
        return "Stays failed. The worker looks again when the builds change.";
    }
  }

  function itemHtml(pr: PrBuildsPr, p: BuildProposal, item: BuildProposalItem, fixing: boolean): string {
    const d = draftOf(pr, p, item);
    const v = verdictOf(item);
    const url = pr.failures.find((f) => f.evaluationId === item.evaluationId)?.url || "";
    const radio = `tpb-c-${prKey(pr)}-${item.evaluationId}`;
    const options =
      item.verdict === "fix" && item.options?.length
        ? `<div class="tpc-options" role="radiogroup" aria-label="Fixes">${item.options
            .map(
              (o) => `
              <label class="tpc-option"><input type="radio" name="${esc(radio)}" value="${esc(o.id)}" data-bfield="choice"${o.id === d.choice ? " checked" : ""}>
                <span><strong>${esc(o.label)}</strong>${o.id === item.recommended ? ` <em class="tpc-rec">recommended</em>` : ""}<span class="tpc-option-plan">${esc(o.plan)}</span></span>
              </label>`
            )
            .join("")}</div>`
        : "";
    const plan = item.verdict === "fix" && !item.options?.length && item.plan ? `<p class="tpc-plan"><strong>Fix:</strong> ${esc(item.plan)}</p>` : "";
    const files = item.verdict === "fix" && item.files.length ? `<p class="tv-block-meta tpc-files">${svg("file")}<span>${item.files.map(esc).join(", ")}</span></p>` : "";
    const note =
      d.action === "fix"
        ? `<input type="text" class="tpc-note" maxlength="1000" data-bfield="note" aria-label="Note for the worker" placeholder="Note for ${esc(p.by)} (optional)" value="${esc(d.note)}">`
        : "";
    return `
      <li class="tv-block tpc-item tone-${v.tone}" data-key="b:${esc(item.evaluationId)}" data-eval="${esc(item.evaluationId)}">
        <div class="tv-block-top">
          <p class="tv-block-name" title="${esc(item.name)}">${esc(item.name)}</p>
          <span class="tm-pr-state tone-${v.tone}">${v.label}</span>
        </div>
        <p class="tv-block-meta"><span class="tpc-conf conf-${item.confidence}">${CONFIDENCE[item.confidence]}</span>${
          url ? ` · <a href="${esc(url)}" target="_blank" rel="noopener">Open the build</a>` : ""
        }</p>
        <p class="tpc-ask"><strong>Why it failed:</strong> ${esc(item.cause)}</p>
        ${item.reason ? `<p class="tv-block-why">${esc(item.reason)}</p>` : ""}
        ${plan}${options}${files}
        <div class="tpc-decide">
          <select class="filter-select" data-bfield="action" aria-label="What to do with this build">${allowed(item)
            .map((a) => `<option value="${a}"${a === d.action ? " selected" : ""}>${ACTION_LABEL[a]}</option>`)
            .join("")}</select>
          <span class="tpc-hint">${esc(hint(pr, item, d, p.by, fixing))}</span>
        </div>
        ${note}
      </li>`;
  }

  // ---- actions -----------------------------------------------------------------------------

  const post = (action: string, body: Record<string, unknown>) => postJSON(`/api/jarvis/pr-builds/${action}`, { id: host.taskId, ...body });

  function confirmAccept(pr: PrBuildsPr): void {
    const p = pr.proposal;
    if (!p) return;
    const list = p.items.map((item) => ({ item, d: draftOf(pr, p, item) }));
    const fixes = list.filter((x) => x.d.action === "fix");
    const reruns = list.filter((x) => x.d.action === "rerun");
    if (!fixes.length && !reruns.length) {
      toast("Pick a fix or a rerun for at least one build, or dismiss the plan.", "err");
      return;
    }
    const skipped = list.length - fixes.length - reruns.length;
    const body = [
      fixes.length
        ? `<p class="tv-sub">${esc(p.by)} fixes, on ${esc(shortBranch(pr.branch) || "the PR's branch")}</p><ol class="tv-confirm-list">${fixes
            .map((x) => `<li><strong>${esc(x.item.name)}</strong> · ${esc(clip(planText(x.item, x.d), 200))}</li>`)
            .join("")}</ol><p class="pa-note">It builds, runs the tests, commits and pushes. The push reruns the builds.</p>`
        : "",
      reruns.length
        ? `<p class="tv-sub">${fixes.length ? "Reruns after the push" : "Reruns now"}</p><ol class="tv-confirm-list">${reruns
            .map((x) => `<li><strong>${esc(x.item.name)}</strong>${x.item.cause ? ` · ${esc(clip(x.item.cause, 160))}` : ""}</li>`)
            .join("")}</ol>`
        : "",
      skipped ? `<p class="pa-note">${plural(skipped, "build stays", "builds stay")} failed until the builds change.</p>` : "",
    ].join("");
    openActionDialog({
      title: "Accept the plan",
      loc: `PR ${pr.prId} · ${pr.title}`,
      body,
      confirmLabel: fixes.length ? "Accept and start" : "Rerun",
      onConfirm: async () => {
        const decisions: BuildDecision[] = list.map(({ item, d }) => ({
          evaluationId: item.evaluationId,
          action: d.action,
          ...(d.action === "fix" && item.options?.length ? { choice: d.choice } : {}),
          ...(d.action === "fix" && d.note.trim() ? { note: d.note.trim() } : {}),
        }));
        try {
          const res: { rerun: number; applying: number } = await post("accept", { org: pr.org, prId: pr.prId, proposalId: p.id, decisions });
          clearDrafts(pr, p.id);
          const parts = res.applying
            ? [`${plural(res.applying, "fix", "fixes")} sent to ${p.by}`, res.rerun ? `${plural(res.rerun, "rerun", "reruns")} after the push` : ""]
            : [`${plural(res.rerun, "build", "builds")} rerunning`];
          await host.after(parts.filter(Boolean).join(", "));
        } catch (err) {
          // The builds or the plan may have moved under the user: show what's there now.
          host.reload();
          throw err;
        }
      },
    });
  }

  function onClick(node: HTMLElement, pr: PrBuildsPr): void {
    const ref = { org: pr.org, prId: pr.prId };
    const who = pr.proposal?.by || pr.worker || "The worker";
    const where = `PR ${pr.prId} · ${pr.title}`;
    switch (node.dataset.bact) {
      case "accept":
        return confirmAccept(pr);
      case "audit":
        return void host.withButton(node, async () => {
          await post("audit", ref);
          await host.after(`Reviewing the failed builds on PR ${pr.prId}`);
        });
      case "dismiss": {
        const proposalId = pr.proposal?.id;
        const what = pr.proposal ? "Dismiss the plan" : "Leave the builds failed";
        return void openActionDialog({
          title: what,
          loc: where,
          body: `<p class="pa-note">Nothing reruns and no code changes. ${esc(who)} doesn't look at these failures again until the builds change.</p>`,
          confirmLabel: pr.proposal ? "Dismiss" : "Leave them",
          onConfirm: async () => {
            await post("dismiss", { ...ref, proposalId });
            clearDrafts(pr, proposalId);
            await host.after(pr.proposal ? "Plan dismissed" : "Builds left as they are");
          },
        });
      }
      case "cancel": {
        const proposalId = pr.apply?.proposalId || pr.proposal?.id;
        return void openActionDialog({
          title: "Cancel the fixes",
          loc: where,
          body: `<p class="pa-note">${esc(who)} is told to stop. Anything it already pushed stays on the branch, and nothing more is rerun.</p>`,
          confirmLabel: "Cancel the fixes",
          danger: true,
          onConfirm: async () => {
            await post("dismiss", { ...ref, proposalId });
            await host.after("Fixes cancelled");
          },
        });
      }
    }
  }

  function draftRef(t: HTMLElement, pr: PrBuildsPr): string | null {
    const li = t.closest<HTMLElement>("[data-eval]");
    if (!pr.proposal || !li) return null;
    return draftKey(pr, pr.proposal.id, li.dataset.eval || "");
  }

  function onChange(t: HTMLElement, pr: PrBuildsPr): boolean {
    const field = t.dataset?.bfield;
    if (!field) return false;
    if (field !== "action" && field !== "choice") return true;
    const key = draftRef(t, pr);
    if (!key) return true;
    const value = (t as HTMLInputElement | HTMLSelectElement).value;
    drafts.set(key, { ...(drafts.get(key) ?? {}), ...(field === "action" ? { action: value as BuildDecisionAction } : { choice: value }) });
    host.paint();
    return true;
  }

  function onInput(t: HTMLElement, pr: PrBuildsPr): boolean {
    if (t.dataset?.bfield !== "note") return !!t.dataset?.bfield;
    const key = draftRef(t, pr);
    if (key) drafts.set(key, { ...(drafts.get(key) ?? {}), note: (t as HTMLInputElement).value });
    return true;
  }

  const mine = (): unknown => [...drafts].filter(([k]) => k.startsWith(`${host.taskId}|`));

  return { shows, state, html, onClick, onChange, onInput, prune, drafts: mine };
}
