// The task sheet's Pull requests tab: every PR linked to the task, each with its state in Azure
// DevOps and what it needs, then its failed blocking builds (taskPrBuilds.ts) and its review
// comments, the worker's plan for each one, and the user's call on it. Nothing is posted, rerun
// or changed until the user accepts; replies and reruns go out now, approved changes go to the
// worker. The tab's head (freshness, refresh, Link PR) is jarvisTask.ts's.

import { getJSON, postJSON } from "./api.js";
import { esc } from "./util.js";
import { icon, type IconName } from "./icons.js";
import { patchHtml } from "./patch.js";
import { toast } from "./toast.js";
import { openActionDialog } from "./prActions.js";
import { createBuildsPart } from "./taskPrBuilds.js";
import {
  agoPhrase,
  groupTaskPrs,
  prBuildsChip,
  prCommentsChip,
  prSignals,
  prSourceText,
  prState,
  type PrBuildsPr,
  type PrBuildsView,
  type PrCommentProposal,
  type PrCommentsPr,
  type PrCommentsView,
  type PrDecision,
  type PrDecisionAction,
  type PrProposalItem,
  type PrReviewState,
  type PrThreadStatus,
  type TaskPr,
  type TodayTask,
} from "./jarvisModel.js";

/** The task's PRs as Azure DevOps last showed them; null while they're first read. */
export interface LinkedPrs {
  prs: TaskPr[] | null;
  showFinished: boolean;
  /** The task has a work item, so its PRs in Azure DevOps show here too. */
  workItem: boolean;
}

export interface PrCommentsHost {
  taskId: string;
  panel: HTMLElement;
  /** The tab's badge. */
  badge: HTMLElement;
  /** Reload Today now. */
  refresh(): Promise<void>;
  visible(): boolean;
  linked(): LinkedPrs;
}

export interface PrCommentsPanel {
  sync(task: TodayTask): void;
  /** The tab was just selected. */
  shown(task: TodayTask): void;
  /** The linked PRs changed: draw them again. */
  repaint(): void;
  /** Escape inside the panel: true when it closed something of its own. */
  escape(target: HTMLElement): boolean;
}

type Feedback = { c?: PrCommentsPr; b?: PrBuildsPr };

const svg = (name: IconName): string => icon(name);

const STATE: Record<PrReviewState, { label: string; tone: string }> = {
  watching: { label: "Watching", tone: "idle" },
  collecting: { label: "New comments", tone: "idle" },
  auditing: { label: "Reviewing", tone: "run" },
  awaiting: { label: "Plan ready", tone: "warn" },
  applying: { label: "Applying fixes", tone: "run" },
  error: { label: "Went wrong", tone: "bad" },
};

const VERDICT: Record<PrProposalItem["verdict"], { label: string; tone: string }> = {
  ready: { label: "Fix ready", tone: "ok" },
  choice: { label: "Your call", tone: "warn" },
  unclear: { label: "Needs a question back", tone: "warn" },
  nochange: { label: "Reply only", tone: "idle" },
};

const CONFIDENCE: Record<PrProposalItem["confidence"], string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

const STATUS_LABEL: Record<PrThreadStatus, string> = {
  fixed: "Resolved",
  wontFix: "Won't fix",
  byDesign: "By design",
  closed: "Closed",
  active: "Active",
};

interface Draft {
  action?: PrDecisionAction;
  choice?: string;
  reply?: string;
  note?: string;
}

interface Decided {
  action: PrDecisionAction;
  choice: string;
  reply: string;
  note: string;
}

/** Decisions in progress, by task, PR, proposal and thread; they outlive closing the task sheet. */
const drafts = new Map<string, Draft>();

const prKey = (pr: { org: string; prId: number }): string => `${pr.org.toLowerCase()}|${pr.prId}`;
const shortBranch = (ref: string): string => ref.replace(/^refs\/heads\//, "");
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function loc(file: string | null, line?: number | null): string {
  if (!file) return "The whole PR";
  return `${file.replace(/^\//, "")}${line ? `:${line}` : ""}`;
}

function statusPhrase(s: PrThreadStatus): string {
  return s === "active" ? "the thread stays active" : `the thread is set to ${STATUS_LABEL[s]}`;
}

const canApply = (item: PrProposalItem): boolean => item.verdict === "ready" || item.verdict === "choice";

/** What the user has decided for a comment so far, with the plan's defaults filled in. */
function decided(item: PrProposalItem, d: Draft): Decided {
  let action = d.action ?? (canApply(item) ? "apply" : "reply");
  if (action === "apply" && !canApply(item)) action = "reply";
  return {
    action,
    choice: d.choice ?? item.recommended ?? item.options?.[0]?.id ?? "",
    reply: d.reply ?? (action === "decline" ? "" : item.reply),
    note: d.note ?? "",
  };
}

function hint(item: PrProposalItem, d: Decided, who: string): string {
  switch (d.action) {
    case "apply":
      return `${who} makes the change and pushes. Then the reply goes out and ${statusPhrase(item.status || "fixed")}.`;
    case "reply":
      return canApply(item)
        ? "Posts now and the thread stays active. The code doesn't change, so check the reply still fits."
        : `Posts now and ${statusPhrase(item.verdict === "nochange" ? item.status : "active")}.`;
    case "decline":
      return "Posts now and sets the thread to Won't fix.";
    default:
      return "Nothing is posted. It comes back if the reviewer writes again.";
  }
}

function planText(item: PrProposalItem, d: Decided): string {
  if (item.verdict !== "choice") return item.plan || item.ask;
  const pick = item.options?.find((o) => o.id === d.choice);
  return pick ? `${pick.label}: ${pick.plan}` : item.ask;
}

export function createPrCommentsPanel(host: PrCommentsHost): PrCommentsPanel {
  let view: PrCommentsView | null = null;
  let bview: PrBuildsView | null = null;
  let error = "";
  let berror = "";
  let token = 0;
  let loadedAt = 0;
  let todaySig = "";
  let workers = 0;
  let open = true;
  let paintedSig = "";

  host.panel.addEventListener("click", onClick);
  host.panel.addEventListener("change", onChange);
  host.panel.addEventListener("input", onInput);

  const builds = createBuildsPart({
    taskId: host.taskId,
    open: () => open,
    workers: () => workers,
    auto: () => !!(view?.auto ?? bview?.auto),
    paint: () => paint(),
    reload: () => {
      paintedSig = "";
      void load();
    },
    after: (message) => after(message),
    withButton: (button, run) => withButton(button, run),
  });

  const draftKey = (pr: { org: string; prId: number }, proposalId: string, threadId: number): string =>
    `${host.taskId}|${prKey(pr)}|${proposalId}|${threadId}`;

  async function load(): Promise<void> {
    const mine = ++token;
    loadedAt = Date.now();
    const id = encodeURIComponent(host.taskId);
    const [c, b] = await Promise.allSettled([
      getJSON(`/api/jarvis/pr-comments?id=${id}`) as Promise<PrCommentsView>,
      getJSON(`/api/jarvis/pr-builds?id=${id}`) as Promise<PrBuildsView>,
    ]);
    if (mine !== token) return;
    if (c.status === "fulfilled") {
      view = c.value;
      error = "";
      pruneDrafts(c.value);
    } else error = (c.reason as Error).message;
    if (b.status === "fulfilled") {
      bview = b.value;
      berror = "";
      builds.prune(b.value);
    } else berror = (b.reason as Error).message;
    paint();
  }

  /** Drafts for proposals that are gone (accepted elsewhere, replaced, dismissed) go too. */
  function pruneDrafts(v: PrCommentsView): void {
    const live = new Set(v.prs.filter((p) => p.proposal).map((p) => `${host.taskId}|${prKey(p)}|${p.proposal!.id}|`));
    for (const k of [...drafts.keys()]) {
      if (!k.startsWith(`${host.taskId}|`)) continue;
      if (![...live].some((prefix) => k.startsWith(prefix))) drafts.delete(k);
    }
  }

  function clearDrafts(pr: { org: string; prId: number }, proposalId: string | undefined): void {
    if (!proposalId) return;
    const prefix = `${host.taskId}|${prKey(pr)}|${proposalId}|`;
    for (const k of [...drafts.keys()]) if (k.startsWith(prefix)) drafts.delete(k);
  }

  function sync(task: TodayTask): void {
    workers = task.workers.length;
    open = task.status === "open";
    const chips = [prBuildsChip(task.prBuilds), prCommentsChip(task.prComments)].filter((c): c is NonNullable<typeof c> => !!c);
    const rank = (tone: string): number => ["warn", "run", "idle", "ok", "off"].indexOf(tone);
    const chip = chips.slice().sort((a, b) => rank(a.tone) - rank(b.tone))[0];
    host.badge.className = `tm-ltab-dot tm-prc-dot${chip ? ` tone-${chip.tone}` : ""}`;
    host.badge.hidden = !chip;
    host.badge.title = chips.map((c) => c.text).join("\n");
    // Hidden, it still draws the PRs it has, so the tab opens on them; feedback loads when shown.
    if (!host.visible()) return paint();
    const sig = JSON.stringify([
      (task.prComments || []).map((s) => [s.org, s.prId, s.state, s.at, s.attention, s.note]),
      (task.prBuilds || []).map((s) => [s.org, s.prId, s.state, s.at, s.attention, s.note, s.failed]),
      task.status,
      workers,
    ]);
    const age = Date.now() - loadedAt;
    const busy = [...(view?.prs || []), ...(bview?.prs || [])].some((p) => p.state === "auditing" || p.state === "applying");
    if (!loadedAt || sig !== todaySig || age > 60_000 || (busy && age > 5_000)) {
      todaySig = sig;
      void load();
    } else paint();
  }

  function shown(task: TodayTask): void {
    loadedAt = 0;
    sync(task);
  }

  function escape(): boolean {
    return false;
  }

  // ---- paint ----------------------------------------------------------------------------

  /** Each PR once, with its comments and its builds: the comments' order, then any PR only the builds know. */
  function merged(): Feedback[] {
    const rows = new Map<string, Feedback>();
    for (const c of view?.prs || []) rows.set(prKey(c), { c });
    for (const b of bview?.prs || []) {
      const row = rows.get(prKey(b));
      if (row) row.b = b;
      else rows.set(prKey(b), { b });
    }
    return [...rows.values()];
  }

  function paint(): void {
    const minute = Math.floor(Date.now() / 60_000);
    const mine = [...drafts].filter(([k]) => k.startsWith(`${host.taskId}|`));
    const linked = host.linked();
    const sig = JSON.stringify([view, bview, error, berror, workers, open, mine, builds.drafts(), linked, minute]);
    if (sig === paintedSig) return;
    paintedSig = sig;
    const now = Date.now();
    const loaded = !!(view || bview);
    const feedback = merged();
    const byKey = new Map(feedback.map((f) => [prKey((f.c || f.b)!), f]));
    // Open PRs first (needing attention on top), then finished ones still carrying feedback,
    // then any PR only the feedback knows; the rest of the finished ones fold away.
    const { open: openPrs, finished } = groupTaskPrs(linked.prs || []);
    const seen = new Set<string>();
    const cards: string[] = [];
    const folded: TaskPr[] = [];
    for (const p of openPrs) {
      seen.add(prKey(p));
      cards.push(cardHtml(p, byKey.get(prKey(p)), now));
    }
    for (const p of finished) {
      seen.add(prKey(p));
      const f = byKey.get(prKey(p));
      if (f) cards.push(cardHtml(p, f, now));
      else folded.push(p);
    }
    for (const f of feedback) if (!seen.has(prKey((f.c || f.b)!))) cards.push(cardHtml(undefined, f, now));
    const any = cards.length + folded.length > 0;

    if (!linked.prs && !cards.length) {
      patchHtml(host.panel, `<p class="tm-muted" data-key="loading"><span class="spinner"></span> Loading pull requests…</p>`);
      return;
    }
    const parts: string[] = [];
    if (error) parts.push(`<p class="tm-muted err" data-key="err">Couldn't read the comments: ${esc(error)}</p>`);
    if (berror) parts.push(`<p class="tm-muted err" data-key="berr">Couldn't read the builds: ${esc(berror)}</p>`);
    if (!open && any)
      parts.push(
        `<p class="tv-note" data-key="done">${svg("warning")}<span>The task is done, so comments and builds on its PRs aren't reviewed. Reopen it to start again.</span></p>`
      );
    else if (open && !workers && feedback.length)
      parts.push(
        `<p class="tv-note" data-key="noworker">${svg("warning")}<span>Start a worker on this task. It reviews the comments and failed builds and makes the fixes you approve.</span></p>`
      );
    if (!loaded && !error && !berror && cards.length)
      parts.push(`<p class="tm-muted" data-key="reading"><span class="spinner"></span> Reading comments and builds…</p>`);
    if (!any) parts.push(emptyHtml(linked.workItem));
    else if (!cards.length) parts.push(`<p class="tm-muted" data-key="none-open">No open pull requests.</p>`);
    parts.push(...cards);
    if (folded.length) {
      parts.push(
        `<button type="button" class="tm-pr-fold" data-key="fold" data-act="pr-finished" aria-expanded="${linked.showFinished}">${svg("chevron")}<span>${folded.length} finished</span></button>`
      );
      if (linked.showFinished) parts.push(`<div class="tpc-finished" data-key="finished">${folded.map((p) => cardHtml(p, undefined, now)).join("")}</div>`);
    }
    if (loaded) {
      const auto = !!(view?.auto ?? bview?.auto);
      parts.push(
        `<label class="tv-opt tv-auto" data-key="auto"><input type="checkbox" data-copt="auto"${auto ? " checked" : ""}><span>For every task: have the worker review new comments once reviewers have been quiet for 10 minutes, and failed blocking builds once they all finish, then propose what to do</span></label>`
      );
    }
    patchHtml(host.panel, parts.join(""));
  }

  function emptyHtml(workItem: boolean): string {
    return `
      <section class="tv-card tv-empty" data-key="empty" aria-label="Pull requests">
        <p class="tv-lead">No pull requests yet.</p>
        <p class="tm-muted tm-dv-empty">${
          workItem ? "PRs linked to the work item in Azure DevOps show here, and so do the ones this task's workers open." : "PRs this task's workers open show here."
        } You can also link one yourself.</p>
        <p class="tm-muted">When reviewers comment on one of yours or a blocking build fails, the worker reads the comments, the build logs and the code, and proposes what to do. You decide here. Nothing is posted, rerun or changed until you accept.</p>
      </section>`;
  }

  function auditButton(label: string, primary = false): string {
    const off = !open ? "The task is done" : !workers ? "Start a worker first" : "";
    return `<button type="button" class="btn sm${primary ? " accent" : " ghost"}" data-cact="audit"${off ? ` disabled title="${off}"` : ""}>${svg("sparkle")}<span>${label}</span></button>`;
  }

  /**
   * One PR: its state in Azure DevOps and what it needs, then its failed builds and its review
   * comments. `p` is the PR as linked to the task; `f` is what the worker tracks on it. Either
   * can be missing: a PR nobody's watching, or one the worker watches that isn't linked yet.
   */
  function cardHtml(p: TaskPr | undefined, f: Feedback | undefined, now: number): string {
    const c = f?.c;
    const b = f?.b;
    const fb = c || b;
    const org = p?.org ?? fb!.org;
    const prId = p?.prId ?? fb!.prId;
    const s = p?.snapshot ?? null;
    const title = s?.title || fb?.title || `Pull request ${prId}`;
    const url = s?.url || fb?.url || "";
    const meta = s
      ? [
          s.repo,
          `PR ${prId}`,
          s.sourceRef && s.targetRef ? `${shortBranch(s.sourceRef)} → ${shortBranch(s.targetRef)}` : "",
          s.status === "completed" && s.closed
            ? `merged ${agoPhrase(s.closed, now)}`
            : s.status === "abandoned" && s.closed
              ? `abandoned ${agoPhrase(s.closed, now)}`
              : s.created
                ? `opened ${agoPhrase(s.created, now)}${s.author ? ` by ${s.author}` : ""}`
                : "",
        ].filter(Boolean)
      : fb
        ? [fb.repo, `PR ${prId}`, shortBranch(fb.branch)].filter(Boolean)
        : [`${org} · PR ${prId}`];
    const state = p ? prState(p) : null;
    const signals = p
      ? prSignals(p)
          .map((sig) => `<span class="tm-sig tone-${sig.tone}">${esc(sig.text)}</span>`)
          .join("")
      : "";
    const canOpen = !!(s?.project && s.repoId);
    const worker = c?.worker || b?.worker;
    const source = [p ? prSourceText(p.source) : "", worker ? `Worker: ${worker}` : ""].filter(Boolean).join(" · ");
    const unlink = !!p && p.source !== "workitem";
    const part = (key: string, label: string, st: { label: string; tone: string }, body: string): string => `
      <div class="tpc-part" data-key="${key}">
        <div class="tpc-part-h"><p class="tv-sub">${label}</p><span class="tm-pr-state tone-${st.tone}">${st.label}</span></div>
        ${body}
      </div>`;
    let parts = "";
    if (b && (builds.shows(b) || !c)) {
      parts += part("builds", "Builds", builds.state(b), builds.shows(b) ? builds.html(b) : `<p class="tpc-line tm-muted">No failed blocking builds.</p>`);
    }
    if (c) parts += part("comments", "Comments", STATE[c.state], bodyHtml(c));
    const key = esc(JSON.stringify([org, prId]));
    return `
      <section class="tv-card tpc-pr" data-key="pr:${esc(prKey({ org, prId }))}" data-pr-key="${key}" data-org="${esc(org)}" data-pr="${prId}" aria-label="PR ${prId}">
        <div class="tpc-status">
          <div class="tm-pr-top">
            ${state ? `<span class="tm-pr-state tone-${state.tone}">${esc(state.label)}</span>` : ""}
            ${
              canOpen
                ? `<button type="button" class="tm-pr-title" data-act="pr-open" title="Open in the app">${esc(title)}</button>`
                : `<span class="tm-pr-title">${esc(title)}</span>`
            }
            ${url ? `<a class="icon-btn tm-pr-ext" data-act="pr-ext" href="${esc(url)}" target="_blank" rel="noopener" title="Open in Azure DevOps" aria-label="Open PR ${prId} in Azure DevOps">${svg("external")}</a>` : ""}
          </div>
          <p class="tm-pr-meta" title="${esc(meta.join(" · "))}">${esc(meta.join(" · "))}</p>
          ${signals ? `<div class="tm-pr-signals">${signals}</div>` : ""}
          ${p?.error ? `<p class="tm-muted err">${esc(p.error)}</p>` : ""}
          ${
            source || unlink
              ? `<div class="tm-pr-foot">
                  <span class="tm-pr-src">${esc(source)}</span>
                  ${unlink ? `<button type="button" class="btn sm ghost tm-pr-unlink" data-act="pr-unlink" aria-label="Unlink PR ${prId}">Unlink</button>` : ""}
                </div>`
              : ""
          }
        </div>
        ${parts}
      </section>`;
  }

  function bodyHtml(pr: PrCommentsPr): string {
    const who = pr.proposal?.by || pr.worker || "The worker";
    switch (pr.state) {
      case "auditing":
        return `<p class="tpc-line"><span class="spinner"></span> ${esc(who)} is reading the comments and the code. Nothing changes until you accept.</p>`;
      case "applying":
        return applyingHtml(pr, who);
      case "collecting":
        return `
          <p class="tpc-line">${view?.auto ? "New comments are in. The worker reviews them once reviewers have been quiet for 10 minutes." : "New comments are in. Review them when you're ready."}</p>
          <div class="tv-actions">${auditButton("Review now", true)}<button type="button" class="btn sm ghost" data-cact="skip">Skip these comments</button></div>`;
      case "awaiting":
        return pr.proposal ? proposalHtml(pr, pr.proposal) : `<p class="tpc-line"><span class="spinner"></span> Updating the plan…</p>`;
      case "error": {
        const alert = `<div class="tv-alert tone-bad">${svg("warning")}<span>${esc(pr.note || "Something went wrong with the review comments.")}</span></div>`;
        if (pr.apply?.commit) {
          return `${alert}
            <p class="tpc-line">Pushed as <code>${esc(pr.apply.commit.slice(0, 8))}</code>. Check the commit, then post the replies or review again.</p>
            <div class="tv-actions">
              <button type="button" class="btn sm accent" data-cact="post">${svg("reply")}<span>Post the replies anyway</span></button>
              ${auditButton("Review again")}
              <button type="button" class="btn sm ghost" data-cact="dismiss">Dismiss</button>
            </div>`;
        }
        if (pr.proposal) return alert + proposalHtml(pr, pr.proposal);
        return `${alert}<div class="tv-actions">${auditButton("Review again")}<button type="button" class="btn sm ghost" data-cact="skip">Skip these comments</button></div>`;
      }
      default:
        return `<p class="tpc-line tm-muted">No open comments waiting on you.</p><div class="tv-actions">${auditButton("Review now")}</div>`;
    }
  }

  function applyingHtml(pr: PrCommentsPr, who: string): string {
    const a = pr.apply;
    const line = a?.sentAt ? `${who} is making these changes. Replies go out once it pushes.` : `${who} gets these changes when its current turn ends.`;
    const items = a?.items.length
      ? `<ul class="tpc-applying">${a.items.map((i) => `<li data-key="a:${i.threadId}"><strong>${esc(loc(i.file))}</strong> · ${esc(i.plan || i.ask)}</li>`).join("")}</ul>`
      : "";
    return `
      <p class="tpc-line"><span class="spinner"></span> ${esc(line)}</p>
      ${items}
      <div class="tv-actions"><button type="button" class="btn sm ghost" data-cact="cancel">${svg("stop")}<span>Cancel the changes</span></button></div>`;
  }

  function proposalHtml(pr: PrCommentsPr, p: PrCommentProposal): string {
    return `
      <div class="tpc-proposal" data-key="p:${esc(p.id)}">
        <p class="tv-sub">${esc(p.by)}'s plan · ${esc(agoPhrase(p.at, Date.now()))}</p>
        ${p.summary ? `<p class="tv-summary">${esc(p.summary)}</p>` : ""}
        <ul class="tpc-items">${p.items.map((item) => itemHtml(pr, p, item)).join("")}</ul>
        <p class="tpc-line tm-muted">Nothing is posted and no code changes until you accept.</p>
        <div class="tv-actions">
          <button type="button" class="btn sm accent" data-cact="accept"${open ? "" : " disabled"}>${svg("check")}<span>Accept</span></button>
          ${auditButton("Review again")}
          <button type="button" class="btn sm ghost" data-cact="dismiss">Dismiss</button>
        </div>
      </div>`;
  }

  function itemHtml(pr: PrCommentsPr, p: PrCommentProposal, item: PrProposalItem): string {
    const d = decided(item, drafts.get(draftKey(pr, p.id, item.threadId)) ?? {});
    const v = VERDICT[item.verdict];
    const actions: Array<[PrDecisionAction, string]> = [
      ...(canApply(item) ? ([["apply", "Make the change"]] as Array<[PrDecisionAction, string]>) : []),
      ["reply", item.verdict === "unclear" ? "Ask the question" : item.verdict === "nochange" ? "Post the reply" : "Reply only"],
      ["decline", "Decline, with a reason"],
      ["defer", "Skip"],
    ];
    const threadUrl = pr.url ? `${pr.url}${pr.url.includes("?") ? "&" : "?"}discussionId=${item.threadId}` : "";
    const radio = `tpc-c-${prKey(pr)}-${item.threadId}`;
    const options =
      item.verdict === "choice" && item.options?.length
        ? `<div class="tpc-options" role="radiogroup" aria-label="Options">${item.options
            .map(
              (o) => `
              <label class="tpc-option"><input type="radio" name="${esc(radio)}" value="${esc(o.id)}" data-cfield="choice"${o.id === d.choice ? " checked" : ""}>
                <span><strong>${esc(o.label)}</strong>${o.id === item.recommended ? ` <em class="tpc-rec">recommended</em>` : ""}<span class="tpc-option-plan">${esc(o.plan)}</span></span>
              </label>`
            )
            .join("")}</div>`
        : "";
    const plan = item.verdict === "ready" && item.plan ? `<p class="tpc-plan"><strong>Change:</strong> ${esc(item.plan)}</p>` : "";
    const files = canApply(item) && item.files.length ? `<p class="tv-block-meta tpc-files">${svg("file")}<span>${item.files.map(esc).join(", ")}</span></p>` : "";
    const reply =
      d.action === "defer"
        ? ""
        : `<textarea class="tpc-reply" rows="3" maxlength="2000" data-cfield="reply" aria-label="Reply on the thread" placeholder="${
            d.action === "decline" ? "Why you're declining. The reviewer reads this." : "Leave empty to post the suggested reply."
          }">${esc(d.reply)}</textarea>`;
    const note =
      d.action === "apply"
        ? `<input type="text" class="tpc-note" maxlength="1000" data-cfield="note" aria-label="Note for the worker" placeholder="Note for ${esc(p.by)} (optional)" value="${esc(d.note)}">`
        : "";
    return `
      <li class="tv-block tpc-item tone-${v.tone}" data-key="i:${item.threadId}" data-thread="${item.threadId}">
        <div class="tv-block-top">
          <p class="tv-block-name" title="${esc(item.file || "")}">${esc(item.reviewer || "Reviewer")} · ${esc(loc(item.file, item.line))}</p>
          <span class="tm-pr-state tone-${v.tone}">${v.label}</span>
        </div>
        <p class="tv-block-meta"><span class="tpc-conf conf-${item.confidence}">${CONFIDENCE[item.confidence]}</span>${
          threadUrl ? ` · <a href="${esc(threadUrl)}" target="_blank" rel="noopener">Open thread</a>` : ""
        }</p>
        ${item.comment ? `<blockquote class="tpc-quote">${esc(item.comment)}</blockquote>` : ""}
        <p class="tpc-ask"><strong>Asks:</strong> ${esc(item.ask)}</p>
        ${item.reason ? `<p class="tv-block-why">${esc(item.reason)}</p>` : ""}
        ${plan}${options}${files}
        <div class="tpc-decide">
          <select class="filter-select" data-cfield="action" aria-label="What to do with this comment">${actions
            .map(([a, label]) => `<option value="${a}"${a === d.action ? " selected" : ""}>${label}</option>`)
            .join("")}</select>
          <span class="tpc-hint">${esc(hint(item, d, p.by))}</span>
        </div>
        ${reply}${note}
      </li>`;
  }

  // ---- actions -----------------------------------------------------------------------------

  function prOf(el: HTMLElement): PrCommentsPr | null {
    const sec = el.closest<HTMLElement>("[data-pr]");
    if (!sec || !view) return null;
    const org = (sec.dataset.org || "").toLowerCase();
    const prId = Number(sec.dataset.pr);
    return view.prs.find((p) => p.org.toLowerCase() === org && p.prId === prId) ?? null;
  }

  function buildsPrOf(el: HTMLElement): PrBuildsPr | null {
    const sec = el.closest<HTMLElement>("[data-pr]");
    if (!sec || !bview) return null;
    const org = (sec.dataset.org || "").toLowerCase();
    const prId = Number(sec.dataset.pr);
    return bview.prs.find((p) => p.org.toLowerCase() === org && p.prId === prId) ?? null;
  }

  function draftRef(el: HTMLElement): string | null {
    const pr = prOf(el);
    const li = el.closest<HTMLElement>("[data-thread]");
    if (!pr?.proposal || !li) return null;
    return draftKey(pr, pr.proposal.id, Number(li.dataset.thread));
  }

  function fieldOf(pr: PrCommentsPr, threadId: number): HTMLElement | null {
    const sec = [...host.panel.querySelectorAll<HTMLElement>("[data-pr]")].find((s) => prOf(s) === pr);
    return sec?.querySelector<HTMLElement>(`[data-thread="${threadId}"] [data-cfield="reply"]`) ?? null;
  }

  function confirmAccept(pr: PrCommentsPr): void {
    const p = pr.proposal;
    if (!p) return;
    const list = p.items.map((item) => ({ item, d: decided(item, drafts.get(draftKey(pr, p.id, item.threadId)) ?? {}) }));
    const missing = list.find((x) => x.d.action === "decline" && !x.d.reply.trim());
    if (missing) {
      toast(`Write why you're declining the comment from ${missing.item.reviewer || "the reviewer"}.`, "err");
      fieldOf(pr, missing.item.threadId)?.focus();
      return;
    }
    const posts = list.filter((x) => x.d.action === "reply" || x.d.action === "decline");
    const changes = list.filter((x) => x.d.action === "apply");
    const skipped = list.length - posts.length - changes.length;
    const body = [
      posts.length
        ? `<p class="tv-sub">Posts now</p><ol class="tv-confirm-list">${posts
            .map((x) => `<li><strong>${esc(loc(x.item.file, x.item.line))}</strong> · ${esc(clip(x.d.reply.trim() || x.item.reply, 160))}</li>`)
            .join("")}</ol>`
        : "",
      changes.length
        ? `<p class="tv-sub">${esc(p.by)} changes, on ${esc(shortBranch(pr.branch) || "the PR's branch")}</p><ol class="tv-confirm-list">${changes
            .map((x) => `<li><strong>${esc(loc(x.item.file, x.item.line))}</strong> · ${esc(clip(planText(x.item, x.d), 200))}</li>`)
            .join("")}</ol><p class="pa-note">It builds, runs the tests, commits and pushes. The replies for these go out after the push.</p>`
        : "",
      skipped ? `<p class="pa-note">${plural(skipped, "comment is", "comments are")} skipped until the reviewer writes again.</p>` : "",
    ].join("");
    openActionDialog({
      title: "Accept the plan",
      loc: `PR ${pr.prId} · ${pr.title}`,
      body,
      confirmLabel: changes.length ? "Accept and start" : posts.length ? "Post" : "Skip them",
      onConfirm: async () => {
        const decisions: PrDecision[] = list.map(({ item, d }) => ({
          threadId: item.threadId,
          action: d.action,
          ...(d.action !== "defer" ? { reply: d.reply.trim() } : {}),
          ...(d.action === "apply" && item.verdict === "choice" ? { choice: d.choice } : {}),
          ...(d.action === "apply" && d.note.trim() ? { note: d.note.trim() } : {}),
        }));
        try {
          const res: { posted: number; applying: number } = await post("accept", { org: pr.org, prId: pr.prId, proposalId: p.id, decisions });
          clearDrafts(pr, p.id);
          const parts = [
            res.posted ? `${plural(res.posted, "reply", "replies")} posted` : "",
            res.applying ? `${plural(res.applying, "change", "changes")} sent to ${p.by}` : "",
          ].filter(Boolean);
          await after(parts.join(", ") || "Comments skipped");
        } catch (err) {
          // The plan may have changed under the user (new comments, a newer plan): show what's there now.
          paintedSig = "";
          void load();
          throw err;
        }
      },
    });
  }

  function onClick(e: MouseEvent): void {
    const bnode = (e.target as HTMLElement).closest<HTMLElement>("[data-bact]");
    if (bnode) {
      const bpr = buildsPrOf(bnode);
      if (bpr) builds.onClick(bnode, bpr);
      return;
    }
    const node = (e.target as HTMLElement).closest<HTMLElement>("[data-cact]");
    if (!node) return;
    const pr = prOf(node);
    if (!pr) return;
    const ref = { org: pr.org, prId: pr.prId };
    const who = pr.proposal?.by || pr.worker || "The worker";
    const where = `PR ${pr.prId} · ${pr.title}`;
    switch (node.dataset.cact) {
      case "accept":
        return confirmAccept(pr);
      case "audit":
        return void withButton(node, async () => {
          await post("audit", ref);
          await after(`Reviewing the comments on PR ${pr.prId}`);
        });
      case "skip":
        return void openActionDialog({
          title: "Skip these comments",
          loc: where,
          body: `<p class="pa-note">Nothing is posted. The worker doesn't look at these comments again until a reviewer writes on them.</p>`,
          confirmLabel: "Skip",
          onConfirm: async () => {
            await post("dismiss", ref);
            await after("Comments skipped");
          },
        });
      case "dismiss": {
        const proposalId = pr.proposal?.id;
        return void openActionDialog({
          title: "Dismiss the plan",
          loc: where,
          body: `<p class="pa-note">Nothing is posted. ${esc(who)} won't propose anything for these comments until a reviewer writes again.</p>`,
          confirmLabel: "Dismiss",
          onConfirm: async () => {
            await post("dismiss", { ...ref, proposalId });
            clearDrafts(pr, proposalId);
            await after("Plan dismissed");
          },
        });
      }
      case "cancel": {
        const proposalId = pr.apply?.proposalId || pr.proposal?.id;
        return void openActionDialog({
          title: "Cancel the changes",
          loc: where,
          body: `<p class="pa-note">${esc(who)} is told to stop. Anything it already pushed stays on the branch. No more replies are posted, and these comments don't come back until a reviewer writes again.</p>`,
          confirmLabel: "Cancel the changes",
          danger: true,
          onConfirm: async () => {
            await post("dismiss", { ...ref, proposalId });
            await after("Changes cancelled");
          },
        });
      }
      case "post": {
        const commit = (pr.apply?.commit || "").slice(0, 8);
        return void openActionDialog({
          title: "Post the replies",
          loc: `${where} · ${commit}`,
          body: `<p class="pa-note">${esc(who)} pushed <code>${esc(commit)}</code>, which changes files outside the ones you approved. Check the commit first. This posts the replies for the approved changes and sets their threads' status.</p>`,
          confirmLabel: "Post the replies",
          onConfirm: async () => {
            const res: { posted: number } = await post("post", ref);
            await after(`${plural(res.posted, "reply", "replies")} posted`);
          },
        });
      }
    }
  }

  function onChange(e: Event): void {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement && t.dataset.copt === "auto") {
      const on = t.checked;
      void withButton(t, async () => {
        try {
          await postJSON("/api/jarvis/pr-comments/auto", { on });
          await after();
        } catch (err) {
          t.checked = !on;
          throw err;
        }
      });
      return;
    }
    if (t.dataset?.bfield) {
      const bpr = buildsPrOf(t);
      if (bpr) builds.onChange(t, bpr);
      return;
    }
    const field = t.dataset?.cfield;
    if (field !== "action" && field !== "choice") return;
    const key = draftRef(t);
    if (!key) return;
    const value = (t as HTMLInputElement | HTMLSelectElement).value;
    drafts.set(key, { ...(drafts.get(key) ?? {}), ...(field === "action" ? { action: value as PrDecisionAction } : { choice: value }) });
    paint();
  }

  function onInput(e: Event): void {
    const t = e.target as HTMLElement;
    if (t.dataset?.bfield) {
      const bpr = buildsPrOf(t);
      if (bpr) builds.onInput(t, bpr);
      return;
    }
    const field = t.dataset?.cfield;
    if (field !== "reply" && field !== "note") return;
    const key = draftRef(t);
    if (!key) return;
    drafts.set(key, { ...(drafts.get(key) ?? {}), [field]: (t as HTMLInputElement | HTMLTextAreaElement).value });
  }

  async function withButton(button: HTMLElement | null, run: () => Promise<unknown>): Promise<void> {
    if (button instanceof HTMLButtonElement) button.disabled = true;
    try {
      await run();
    } catch (e) {
      toast((e as Error).message, "err");
      paintedSig = "";
      void load();
    } finally {
      if (button instanceof HTMLButtonElement && button.isConnected) button.disabled = false;
    }
  }

  const post = (action: string, body: Record<string, unknown> = {}) => postJSON(`/api/jarvis/pr-comments/${action}`, { id: host.taskId, ...body });

  async function after(message?: string): Promise<void> {
    if (message) toast(message, "ok");
    paintedSig = "";
    await Promise.all([load(), host.refresh()]);
  }

  return { sync, shown, repaint: paint, escape };
}
