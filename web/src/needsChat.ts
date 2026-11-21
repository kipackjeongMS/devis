// Needs you in Devis's chat. Every ask waiting on the user shows in the Lead's thread as a message
// from Devis, placed at the time the ask came in. The page writes these from Today's data. They
// never go through the Lead's session, so Devis sees one only when the user asks about it, which
// attaches the item to the message. A handled ask leaves a one-line receipt where it was, kept for
// the day. Pure rules, no DOM, so harnesses can import the compiled module directly.
import {
  askerWhere,
  askersLine,
  commsNeedTitle,
  commsNeedWhere,
  commsNeedWho,
  dayStart,
  firstRequest,
  needTodo,
  oneLine,
  type NeedItem,
} from "./jarvisModel.js";
import { s360Roles, s360Why } from "./s360Model.js";

/** A notice's line in Devis's words: plain text, with names in bold and titles in italics. */
export type NoticePart = string | { strong: string } | { em: string };

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** A notice's lead line: who needs you, for what, and where. */
export function noticeLine(n: NeedItem): NoticePart[] {
  if (n.kind === "teams") {
    const a = n.ask;
    const where = a.askers[0] ? ` ${askerWhere(a.askers[0])}` : "";
    const pr = a.title ? [{ em: a.title }, ` (PR ${a.prId})${where}.`] : [`PR ${a.prId}${where}.`];
    return [{ strong: askersLine(a.askers) }, " asked you to review ", ...pr];
  }
  if (n.kind === "comms") {
    const c = n.need;
    const who = { strong: commsNeedWho(c) };
    if (c.source === "mail") return [who, " is waiting on you by email about ", { em: c.title || "(no subject)" }, "."];
    return [who, ` is waiting on you ${commsNeedWhere(c)}.`];
  }
  if (n.kind === "s360") {
    const item = n.need.item;
    const why = s360Why(item);
    const title = { em: item.title };
    if (why === "late") return ["The S360 item ", title, " is ", { strong: "out of SLA" }, "."];
    if (why === "soon") return ["The S360 item ", title, " is ", { strong: "approaching its SLA" }, "."];
    return ["S360 has a new item for you: ", title, "."];
  }
  const title = { em: n.task.title };
  if (n.kind === "failed") return [{ strong: n.worker.label }, "'s turn failed on ", title, ". A message to it tries again."];
  if (n.kind === "validation") {
    const name = { em: n.need.name };
    return n.need.what === "proposal"
      ? [{ strong: n.who }, n.need.chainId ? " proposed a change to the validation chain " : " proposed a new validation chain, ", name, ", on ", title, "."]
      : ["The validation run of ", name, n.who !== "Validation" ? ` (run by ${n.who})` : "", " failed on ", title, "."];
  }
  if (n.kind === "prComments") {
    return n.pr.attention === "proposal"
      ? ["On ", title, ", ", { strong: n.who }, ` has a plan for PR ${n.pr.prId}'s review comments.`]
      : ["On ", title, `, the review comments on PR ${n.pr.prId} need you.`];
  }
  if (n.kind === "prBuilds") {
    return n.pr.attention === "proposal"
      ? ["On ", title, ", ", { strong: n.who }, ` has a plan for PR ${n.pr.prId}'s failed builds.`]
      : ["On ", title, `, the failed builds on PR ${n.pr.prId} need you.`];
  }
  const who = { strong: n.worker.label };
  const more = n.worker.requests.length;
  if (more > 1) return [who, ` has ${more} things for you on `, title, "."];
  const r = firstRequest(n.worker.requests);
  if (r.kind === "permission") return [who, " needs your OK on ", title, "."];
  if (r.kind === "repos") return [who, " wants you to confirm its repositories for ", title, "."];
  if (r.kind === "ship") return [who, " is ready to ship its change for ", title, "."];
  return [who, " has a question on ", title, "."];
}

/** What a notice is, in a few words, for its receipt and Ask Devis: "Nova's question". */
export function noticeLabel(n: NeedItem): string {
  if (n.kind === "teams") {
    const names = [...new Set(n.ask.askers.map((a) => a.name))];
    return names.length === 1 ? `${names[0]}'s ask to review PR ${n.ask.prId}` : `the asks to review PR ${n.ask.prId}`;
  }
  if (n.kind === "comms") {
    const c = n.need;
    if (c.source === "mail") return `the email “${oneLine(c.title || "(no subject)", 80)}”`;
    return c.kind === "oneOnOne" ? `your chat with ${c.title}` : oneLine(commsNeedTitle(c), 80);
  }
  if (n.kind === "s360") return `the S360 item “${oneLine(n.need.item.title, 80)}”`;
  if (n.kind === "failed") return `${n.worker.label}'s failed turn`;
  if (n.kind === "validation") return n.need.what === "proposal" ? `${n.who}'s validation plan` : "the failed validation run";
  if (n.kind === "prComments") return n.pr.attention === "proposal" ? `${n.who}'s plan for PR ${n.pr.prId}'s comments` : `the review comments on PR ${n.pr.prId}`;
  if (n.kind === "prBuilds") return n.pr.attention === "proposal" ? `${n.who}'s plan for PR ${n.pr.prId}'s builds` : `the failed builds on PR ${n.pr.prId}`;
  if (n.worker.requests.length > 1) return `${n.worker.label}'s requests`;
  const r = firstRequest(n.worker.requests);
  if (r.kind === "permission") return `${n.worker.label}'s request`;
  if (r.kind === "repos") return `${n.worker.label}'s repositories`;
  if (r.kind === "ship") return `${n.worker.label}'s ship`;
  return `${n.worker.label}'s question`;
}

// ---- when ----------------------------------------------------------------------------

const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** When a notice came in, as a chat shows it: "2:14 PM", "Yesterday 2:14 PM", "Mon 2:14 PM", "Nov 12". */
export function noticeTime(at: number, now: number): string {
  const today = dayStart(now);
  if (at >= today) return clock(at);
  if (at >= dayStart(today - 1)) return `Yesterday ${clock(at)}`;
  if (at >= today - 6 * 86_400_000) return `${new Date(at).toLocaleDateString([], { weekday: "short" })} ${clock(at)}`;
  return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
}

// ---- placing them in the thread --------------------------------------------------------

/**
 * The thread: the Lead's messages with notices and receipts placed by time. Each goes before the
 * first message after it; a message without a time takes the one before it.
 */
export function interleave<M extends { timestamp?: string }, X extends { at: number }>(messages: readonly M[], extras: readonly X[]): Array<{ message: M } | { extra: X }> {
  const sorted = [...extras].sort((a, b) => a.at - b.at);
  const out: Array<{ message: M } | { extra: X }> = [];
  let i = 0;
  let last = -Infinity;
  for (const message of messages) {
    const t = Date.parse(message.timestamp || "");
    if (Number.isFinite(t)) last = Math.max(last, t);
    while (i < sorted.length && sorted[i]!.at < last) out.push({ extra: sorted[i++]! });
    out.push({ message });
  }
  while (i < sorted.length) out.push({ extra: sorted[i++]! });
  return out;
}

// ---- receipts --------------------------------------------------------------------------

/** What became of an ask: "You answered Nova: “Its own column”". `dropped` for a dismissal or a no. */
export interface NoticeOutcome {
  text: string;
  dropped?: boolean;
}

/** An ask the thread has shown, by its source: open, or gone today with what became of it. */
export interface NoticeTrace {
  at: number;
  label: string;
  goneAt?: number;
  outcome?: string;
  dropped?: boolean;
}
export type NoticeLedger = Record<string, NoticeTrace>;

const KEEP_UNSURE_MS = 30 * 86_400_000;

/**
 * The ledger after a Today poll. Open asks are recorded; one that left since gets what the user did
 * about it here (`outcomes`), or "Moved to your to-dos" when a to-do took it (`taken`), or "doesn't
 * need you anymore". `unsure` keeps an ask whose source couldn't be read this time as it was.
 * Receipts last until the day ends.
 */
export function trackNotices(
  ledger: NoticeLedger,
  open: ReadonlyArray<{ source: string; at: number; label: string }>,
  now: number,
  o: { outcomes?: ReadonlyMap<string, NoticeOutcome>; taken?: ReadonlySet<string>; unsure?: (source: string) => boolean } = {}
): NoticeLedger {
  const next: NoticeLedger = {};
  for (const n of open) next[n.source] = { at: n.at, label: n.label };
  const today = dayStart(now);
  for (const [source, t] of Object.entries(ledger)) {
    if (next[source]) continue;
    if (t.goneAt !== undefined) {
      if (t.goneAt >= today) next[source] = t;
      continue;
    }
    if (o.unsure?.(source)) {
      if (now - t.at < KEEP_UNSURE_MS) next[source] = t;
      continue;
    }
    const outcome = o.outcomes?.get(source) ?? (o.taken?.has(source) ? { text: `Moved ${t.label} to your to-dos` } : { text: `${cap(t.label)} doesn't need you anymore` });
    next[source] = { ...t, goneAt: now, outcome: outcome.text, ...(outcome.dropped ? { dropped: true } : {}) };
  }
  return next;
}

/** The receipts to show: asks gone today, by source. */
export function noticeReceipts(ledger: NoticeLedger): Array<NoticeTrace & { source: string; goneAt: number }> {
  return Object.entries(ledger)
    .filter((e): e is [string, NoticeTrace & { goneAt: number }] => e[1].goneAt !== undefined)
    .map(([source, t]) => ({ ...t, source }));
}

/** A ledger read back from storage, with anything malformed left out. */
export function readLedger(raw: unknown): NoticeLedger {
  const out: NoticeLedger = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [source, v] of Object.entries(raw as Record<string, unknown>)) {
    const t = v as Partial<NoticeTrace> | null;
    if (!t || typeof t.at !== "number" || typeof t.label !== "string") continue;
    out[source] = {
      at: t.at,
      label: t.label,
      ...(typeof t.goneAt === "number" ? { goneAt: t.goneAt } : {}),
      ...(typeof t.outcome === "string" ? { outcome: t.outcome } : {}),
      ...(t.dropped ? { dropped: true } : {}),
    };
  }
  return out;
}

// ---- asking Devis about one ------------------------------------------------------------

/**
 * What Devis gets with a message about a notice: what the ask is and the ids to act on it.
 * The page shows only the label; Devis reads the rest.
 */
export function noticeContext(n: NeedItem): string {
  const lines: string[] = [`What to do: ${needTodo(n).text}`];
  if (n.kind === "teams") {
    const a = n.ask;
    lines.push(`PR ${a.prId} "${oneLine(a.title, 160)}" in ${a.org}/${a.project}/${a.repo}, by ${a.author}. ${a.url}`.trim());
    for (const x of a.askers.slice(0, 3)) lines.push(`${x.name} asked ${askerWhere(x)} at ${x.at}${x.snippet ? `: "${oneLine(x.snippet, 300)}"` : ""}`);
    return lines.join("\n");
  }
  if (n.kind === "comms") {
    const c = n.need;
    lines.push(`${commsNeedWho(c)} ${commsNeedWhere(c)} (${commsNeedTitle(c)}), last at ${c.lastAt}: ${oneLine(c.needsYou, 300)}`);
    if (c.summary) lines.push(`Summary: ${oneLine(c.summary, 400)}`);
    return lines.join("\n");
  }
  if (n.kind === "s360") {
    const i = n.need.item;
    lines.push(`S360 action item "${oneLine(i.title, 200)}" (KPI ${i.kpiId}, item ${oneLine(i.itemId, 200)}), on ${i.targetType || "?"} ${i.service || i.targetId}.`);
    lines.push(`SLA: ${i.sla || "unknown"}${i.due ? `, due ${i.due}` : ""}${i.eta ? `, ETA ${i.eta}` : ""}. ${s360Roles(i)}${i.owner ? `; action owner ${i.owner}` : ""}.`);
    if (i.status) lines.push(`Latest status${i.statusBy ? ` (${i.statusBy})` : ""}: ${oneLine(i.status, 400)}`);
    for (const [what, url] of [["In S360", i.link], ["Guidance", i.url], ["ADO work item", i.adoUrl]] as const) if (url) lines.push(`${what}: ${url}`);
    return lines.join("\n");
  }
  lines.push(`Task "${oneLine(n.task.title, 160)}" (id ${n.task.id}).`);
  if (n.kind === "request" || n.kind === "failed") lines.push(`Worker ${n.worker.label} (session ${n.worker.sessionId}).`);
  if (n.kind === "failed" && n.worker.summary) lines.push(`Its turn failed: ${oneLine(n.worker.summary, 300)}`);
  if (n.kind === "validation" || n.kind === "prComments" || n.kind === "prBuilds") lines.push(n.text);
  if (n.kind === "request") {
    for (const r of n.worker.requests) {
      lines.push(`${r.kind}: ${oneLine(r.title, 200)}${r.detail ? ` | ${oneLine(r.detail, 400)}` : ""}${r.choices.length ? ` | choices: ${r.choices.join("; ")}` : ""}`);
    }
  }
  return lines.join("\n");
}

const ABOUT = /^\[Needs you: ([^\]\n]{1,200})\]\n[\s\S]*?\n---\n([\s\S]*)$/;

/** A message with a notice attached: its label and context first, then what the user wrote. */
export function withAbout(label: string, context: string, text: string): string {
  const name = label.replace(/[\]\n]/g, " ").trim().slice(0, 200);
  return `[Needs you: ${name}]\n${context.replace(/\n---\n/g, "\n- - -\n")}\n---\n${text}`;
}

/** What a message is about, when a notice was attached to it, and what the user wrote. */
export function aboutOf(content: string): { label: string; text: string } | null {
  const m = ABOUT.exec(content);
  return m ? { label: m[1]!, text: m[2]! } : null;
}
