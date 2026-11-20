// S360: the KPI action items assigned to you, or whose action owner you are. In the Workspace's
// drawer it's a list beside a detail: out of SLA first, then approaching, the rest open, and what
// S360 closed lately folded under them; picked, an item's SLA, due date, who has it, its status, and
// where to act on it. The rail shows the open ones, the latest SLA first. The service reads S360 once
// a day (s360.mts).

import { esc } from "./util.js";
import { icon, type IconName } from "./icons.js";
import { setupActionHtml, setupStatusHtml } from "./setupActions.js";
import { s360Date, s360Groups, s360Roles, s360TodoKey, s360Why, slaChip, type S360Group, type S360Item, type S360Status } from "./s360Model.js";
import type { Todo } from "./jarvisModel.js";

export interface S360View {
  /** Null until they're read. */
  items: S360Item[] | null;
  status: S360Status | null;
  error: string;
  /** A read asked for from the drawer is under way. */
  scanning: boolean;
}

const svg = (name: IconName): string => icon(name);

/** How many open items the rail shows before "All". */
const RAIL_ITEMS = 4;

/** The item shown in the detail; null picks the first open one. */
let selected: string | null = null;
/** Groups opened or folded by hand; otherwise all are open but Closed lately. */
const groupOpen = new Map<string, boolean>();

const groupOf = (item: S360Item): S360Group["key"] => {
  if (item.resolvedAt) return "closed";
  const why = s360Why(item);
  return why === "late" ? "late" : why === "soon" ? "soon" : "open";
};
const isOpen = (key: string): boolean => groupOpen.get(key) ?? key !== "closed";

/** Pick an item, opening its group. */
export function selectS360(key: string, items: S360Item[] | null): void {
  selected = key;
  const item = items?.find((i) => i.key === key);
  if (item) groupOpen.set(groupOf(item), true);
}

export function toggleS360Group(key: string): void {
  groupOpen.set(key, !isOpen(key));
}

/** Forget what's no longer listed (the page runs for days). */
export function pruneS360State(items: S360Item[]): void {
  if (selected && !items.some((i) => i.key === selected)) selected = null;
}

/** The to-do made from an item, an open one first. */
function todoOf(todos: Todo[] | undefined, item: S360Item): Todo | undefined {
  const key = s360TodoKey(item);
  const made = (todos || []).filter((t) => t.source?.key === key);
  return made.find((t) => !t.done) || made[0];
}

/** Only https links leave the page (the service checks them too). */
const safe = (url: string): string => (/^https:\/\//i.test(url) ? url : "");

/** A cheap signature of what the drawer shows, so polling only repaints on change. */
export function s360Sig(view: S360View, todos: Todo[] | undefined, now: number): string {
  const s = view.status;
  return JSON.stringify([
    view.items?.map((i) => [i.key, i.title, i.sla, i.due, i.eta, i.status, i.statusBy, i.assignedTo, i.owner, i.roles, i.link, i.resolvedAt, i.need, i.dismissed]),
    s ? [s.enabled, s.agency, s.scanning, s.alias, s.readAt, s.nextAt, s.last && [s.last.at, s.last.ok, s.last.throttled, s.last.error]] : null,
    view.error,
    view.scanning,
    selected,
    [...groupOpen],
    (todos || []).filter((t) => t.source?.key.startsWith("need:s360:")).map((t) => [t.source!.key, t.done]),
    Math.floor(now / 60_000),
  ]);
}

/** When, short: the time today, else the day. */
function when(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!t) return "";
  return new Date(t).toDateString() === new Date(now).toDateString()
    ? new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : s360Date(iso, now);
}

/** The drawer's sub line: what's open, and when S360 was last read. */
export function s360Sub(view: S360View, now: number): string {
  if (view.status && !view.status.enabled) return "S360 is off";
  const parts: string[] = [];
  if (view.items) {
    const open = view.items.filter((i) => !i.resolvedAt);
    const late = open.filter((i) => s360Why(i) === "late").length;
    const soon = open.filter((i) => s360Why(i) === "soon").length;
    const more = [late ? `${late} out of SLA` : "", soon ? `${soon} approaching` : ""].filter(Boolean).join(", ");
    parts.push(open.length ? `${open.length} open${more ? ` (${more})` : ""}` : "Nothing open");
  }
  if (view.scanning || view.status?.scanning) parts.push("reading…");
  else if (view.status?.readAt) parts.push(`read ${when(view.status.readAt, now)}`);
  return parts.join(" · ");
}

/** The picked item, or the first one open, else the first. */
function current(view: S360View): S360Item | null {
  const all = view.items || [];
  return (selected ? all.find((i) => i.key === selected) : undefined) || all.find((i) => !i.resolvedAt) || all[0] || null;
}

/** What the last read left to say: S360 slowed it down, it didn't finish, or it got only part. */
function readNote(status: S360Status | null): string {
  const last = status?.last;
  if (!last?.error) return "";
  if (last.throttled) return "S360 asked to slow down; the next read waits a little longer.";
  if (!last.ok) return `The last read didn't finish: ${last.error}`;
  return last.error;
}

/** The list half of the drawer: the items by where they stand. */
export function s360ListHtml(view: S360View, todos: Todo[] | undefined, now: number): string {
  const html: string[] = [];
  const status = view.status;
  if (view.error) html.push(`<div class="today-note err" data-key="s360-err">Couldn't load S360. ${esc(view.error)}</div>`);
  if (status && !status.enabled) {
    html.push(`
      <div class="today-start" data-key="s360-off">
        <p class="today-start-title">S360 is off</p>
        <p>Turn it on to see the S360 action items assigned to you, or whose action owner you are. Devis reads them once a day, and those out of SLA, approaching it, or new show under Needs you.</p>
        <button type="button" class="btn sm accent" data-act="s360-settings">${svg("settings")}<span>Settings</span></button>
      </div>`);
  } else if (status?.agency === false) {
    html.push(`<div class="today-note warn has-act" data-key="s360-agency"><span>S360 is waiting on Agency, which isn't installed. Once it is, the next read picks up within 5 minutes.</span>${setupActionHtml("agency-install", "Install Agency", { tone: "accent" })}${setupStatusHtml("agency-install")}</div>`);
  } else {
    const note = readNote(status);
    if (note) html.push(`<div class="today-note warn" data-key="s360-warn">${esc(note)}</div>`);
  }
  if (!view.items) {
    html.push(view.error ? "" : `<div class="loading" data-key="s360-loading"><span class="spinner"></span> Loading S360…</div>`);
    return html.join("");
  }
  const pick = current(view)?.key || "";
  for (const group of s360Groups(view.items)) html.push(groupHtml(group, pick, todos, now));
  if (!view.items.length && status?.enabled !== false) {
    html.push(`<p class="today-empty" data-key="s360-none">${status?.readAt ? "No S360 action items for you." : "S360 hasn't been read yet."}</p>`);
  }
  return html.join("");
}

function groupHtml(group: S360Group, pick: string, todos: Todo[] | undefined, now: number): string {
  const open = isOpen(group.key);
  const head = `
    <button type="button" class="ld-day" data-key="head" data-act="s360-group" data-group="${group.key}" aria-expanded="${open}">
      ${svg("chevron")}<span class="ld-day-t">${esc(group.label)}</span><span class="ld-day-n">${group.items.length}</span>
    </button>`;
  const body = open ? group.items.map((i) => itemHtml(i, pick, todos, now)).join("") : "";
  return `<section class="ld-group${open ? " open" : ""}" data-key="grp:${group.key}">${head}${body}</section>`;
}

/** Where an item stands with the user, in a few words: under Needs you, in the to-dos, dismissed. */
function standing(item: S360Item, todos: Todo[] | undefined): string {
  if (item.resolvedAt) return "";
  const todo = todoOf(todos, item);
  if (todo && !todo.done) return "In your to-dos";
  if (item.need) return "Needs you";
  if (item.dismissed) return "Dismissed";
  return "";
}

function itemHtml(item: S360Item, pick: string, todos: Todo[] | undefined, now: number): string {
  const chip = slaChip(item, now);
  const sel = item.key === pick;
  const due = item.resolvedAt ? `Closed ${s360Date(item.resolvedAt, now)}` : item.due ? `Due ${s360Date(item.due, now)}` : "";
  const line = [chip.text, standing(item, todos), item.service].filter(Boolean).join(" · ");
  return `
    <button type="button" class="ld-item tone-${chip.tone}${sel ? " sel" : ""}" data-key="s360:${esc(item.key)}" data-s360="${esc(item.key)}" data-act="s360-select" aria-keyshortcuts="Shift+F10" title="${esc(chip.title)}"${sel ? ' aria-current="true"' : ""}>
      <span class="ld-item-h"><b class="ell">${esc(item.title)}</b><span class="ld-tm">${esc(due)}</span></span>
      <span class="ld-item-p"><span class="rdot tone-${chip.tone}"></span><span class="ell">${esc(line)}</span></span>
    </button>`;
}

/** Why an open item is under Needs you, in a sentence. */
function needSentence(item: S360Item, now: number): string {
  const due = item.due ? ` It was due ${s360Date(item.due, now)}.` : "";
  const why = s360Why(item);
  if (why === "late") return `It's past its SLA.${due}`;
  if (why === "soon") return `It's close to its SLA.${item.due ? ` It's due ${s360Date(item.due, now)}.` : ""}`;
  return "It's new to you.";
}

/** The detail half of the drawer: the picked item. */
export function s360DetailHtml(view: S360View, todos: Todo[] | undefined, now: number): string {
  if ((view.status && !view.status.enabled) || !view.items) return "";
  const item = current(view);
  if (!item) return `<p class="today-empty ld-none" data-key="none">No S360 action items to show.</p>`;
  const chip = slaChip(item, now);
  const todo = todoOf(todos, item);
  const stand = standing(item, todos);
  const chips = [
    `<span class="tchip tone-${chip.tone}" title="${esc(chip.title)}">${esc(chip.text)}</span>`,
    stand === "Needs you" ? `<span class="tchip tone-warn">Needs you</span>` : stand ? `<span class="tchip tone-idle">${esc(stand)}</span>` : "",
    item.due && !item.resolvedAt ? `<span>Due ${esc(s360Date(item.due, now))}</span>` : "",
    item.resolvedAt ? `<span>Closed ${esc(s360Date(item.resolvedAt, now))}</span>` : "",
  ].join("");
  const head = `
      <button type="button" class="btn sm ghost ld-back" data-act="ld-back">${svg("back")}<span>All items</span></button>
      <h4 class="ld-h">${esc(item.title)}</h4>
      <p class="ld-meta">${chips}</p>`;
  const needs = item.need && !(todo && !todo.done)
    ? `<p class="ld-needs"><span class="rdot tone-warn"></span><span>${esc(needSentence(item, now))} It's under Needs you until you dismiss it, make it a to-do, or S360 closes it.</span></p>`
    : todo && !todo.done && !item.resolvedAt
      ? `<p class="ld-needs"><span class="rdot tone-idle"></span><span>It's in your to-dos. The to-do ticks itself once S360 closes the item.</span></p>`
      : "";
  const rows: Array<[string, string]> = [
    ["You", s360Roles(item)],
    ["Assigned to", item.assignedTo],
    ["Action owner", item.owner],
    ["Service", item.service],
    ["Kind", [item.kind, item.targetType].filter(Boolean).join(" · ")],
    ["Severity", item.severity],
    ["ETA", item.eta ? s360Date(item.eta, now) : ""],
    ["Published", item.published ? s360Date(item.published, now) : ""],
    ["Updated", item.updated ? s360Date(item.updated, now) : ""],
    ["KPI", item.kpiId],
    ["Item", item.itemId],
  ];
  const facts = `<dl class="ld-kv">${rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
    .join("")}</dl>`;
  const status = item.status
    ? `<h5 class="ld-sh">Status${item.statusBy ? ` from ${esc(item.statusBy)}` : ""}</h5><p class="ld-sum">${esc(item.status)}</p>`
    : "";
  const link = safe(item.link);
  const guide = safe(item.url);
  const ado = safe(item.adoUrl);
  const inTodos = !!todo && !todo.done;
  const acts = [
    link ? `<a class="btn sm accent" href="${esc(link)}" target="_blank" rel="noopener" data-act="s360-portal">${svg("external")}<span>Open in S360</span></a>` : "",
    !item.resolvedAt && !inTodos
      ? `<button type="button" class="btn sm" data-act="s360-todo" title="It ticks itself once S360 closes the item">${svg("checklist")}<span>Add to to-dos</span></button>`
      : "",
    guide ? `<a class="btn sm" href="${esc(guide)}" target="_blank" rel="noopener" data-act="s360-guide">${svg("file")}<span>Guidance</span></a>` : "",
    ado ? `<a class="btn sm" href="${esc(ado)}" target="_blank" rel="noopener" data-act="s360-ado">${svg("azureDevOps")}<span>Work item</span></a>` : "",
    item.need && !inTodos
      ? `<button type="button" class="btn sm ghost" data-act="s360-dismiss" title="It leaves Needs you, and comes back only if it gets worse">${svg("dismiss")}<span>Dismiss</span></button>`
      : "",
  ].join("");
  return `<article class="ld-doc" data-key="doc:${esc(item.key)}" data-s360="${esc(item.key)}">${head}${needs}${status}<h5 class="ld-sh">Details</h5>${facts}${acts ? `<div class="ld-acts">${acts}</div>` : ""}<p class="ld-foot">From S360, read once a day.</p></article>`;
}

/** The open items for the rail, the latest SLA first. */
export function s360Rail(view: S360View, todos: Todo[] | undefined, now: number): string {
  const status = view.status;
  if (status && !status.enabled) return `<p class="rs-empty">S360 is off.</p>`;
  if (!view.items) return view.error ? `<p class="rs-empty">Couldn't read S360.</p>` : `<p class="rs-empty"><span class="spinner"></span> Loading…</p>`;
  // The service lists the open ones first, the latest SLA and soonest due at the top.
  const open = view.items.filter((i) => !i.resolvedAt);
  if (!open.length) {
    const empty = status?.agency === false && !status.readAt ? "Waiting on Agency." : status?.readAt ? "Nothing open in S360." : "S360 hasn't been read yet.";
    return `<p class="rs-empty">${empty}</p>${view.items.length ? `<button type="button" class="rs-more" data-key="more" data-act="s360-open">Closed lately</button>` : ""}`;
  }
  return (
    open
      .slice(0, RAIL_ITEMS)
      .map((i) => {
        const chip = slaChip(i, now);
        const line = [chip.text, standing(i, todos), i.service].filter(Boolean).join(" · ");
        return `<button type="button" class="rr2" data-key="s:${esc(i.key)}" data-s360="${esc(i.key)}" data-act="s360-open" aria-keyshortcuts="Shift+F10" title="${esc(chip.title)}">
          <span class="rr-h"><b class="ell">${esc(i.title)}</b><span class="rr-tm">${esc(i.due ? s360Date(i.due, now) : "")}</span></span>
          <span class="rr-p"><span class="rdot tone-${chip.tone}"></span><span class="ell">${esc(line)}</span></span>
        </button>`;
      })
      .join("") + `<button type="button" class="rs-more" data-key="more" data-act="s360-open">${open.length > RAIL_ITEMS ? `All ${open.length}` : "Open"}</button>`
  );
}
