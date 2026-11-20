// S360 action items as the page shows them. The service reads them once a day (s360.mts): the
// items assigned to the user, and those whose action owner they are. Pure rules, no DOM, so
// harnesses can import the compiled module directly.

export type S360Role = "assigned" | "owner";

/** One action item (s360.mts S360Item). */
export interface S360Item {
  key: string;
  kpiId: string;
  itemId: string;
  targetType: string;
  targetId: string;
  title: string;
  /** InSla, ApproachingSla or OutOfSla, as S360 says it. */
  sla: string;
  /** ISO; "" when there's none. */
  due: string;
  eta: string;
  status: string;
  statusBy: string;
  assignedTo: string;
  owner: string;
  service: string;
  kind: string;
  severity: string;
  /** The KPI's guidance, the item's ADO work item, and the KPI in the S360 portal; "" when there's none. */
  url: string;
  adoUrl: string;
  link: string;
  published: string;
  updated: string;
  roles: S360Role[];
  firstSeen: string;
  lastSeen: string;
  /** When S360 stopped listing it; null while it's open. */
  resolvedAt: string | null;
  need: boolean;
  dismissed: boolean;
}

/** An item waiting on the user (s360.mts S360Need). */
export interface S360Need {
  /** need:s360:<the item's key>. */
  key: string;
  /** When it came to need the user. */
  at: string;
  item: S360Item;
}

export interface S360ReadInfo {
  at: string;
  ok: boolean;
  calls: number;
  items: number;
  found: number;
  resolved: number;
  throttled: boolean;
  error?: string;
}

export interface S360Status {
  enabled: boolean;
  scanning: boolean;
  agency: boolean;
  alias: string | null;
  last: S360ReadInfo | null;
  /** When S360 was last read whole. */
  readAt: string | null;
  nextAt: string | null;
}

export interface S360Digest {
  version: string;
  enabled: boolean;
  open: number;
  soon: number;
  late: number;
}

/** What Today carries: the digest and what waits on the user; `failed` when it couldn't be read. */
export type S360Today = Partial<S360Digest> & { needs: S360Need[]; failed?: boolean };

const time = (iso: string | null | undefined): number => Date.parse(iso || "") || 0;

/** How far along an item is: in SLA (or unknown) 0, approaching 1, out of SLA 2. */
export function slaRank(sla: string): number {
  const s = sla.toLowerCase();
  if (s === "outofsla") return 2;
  if (s === "approachingsla") return 1;
  return 0;
}

/** A day, short: "Dec 31", with the year when it isn't this one. */
export function s360Date(iso: string, now: number): string {
  const t = time(iso);
  if (!t) return "";
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** What an item's chip says of its SLA, in a word or two, with more in its tooltip. */
export function slaChip(item: Pick<S360Item, "sla" | "due" | "resolvedAt">, now: number): { text: string; tone: string; title: string } {
  const due = item.due ? ` Due ${s360Date(item.due, now)}.` : "";
  if (item.resolvedAt) return { text: "Closed", tone: "idle", title: "S360 no longer lists it." };
  const rank = slaRank(item.sla);
  if (rank === 2) return { text: "Out of SLA", tone: "bad", title: `Past its SLA.${due}` };
  if (rank === 1) return { text: "Approaching SLA", tone: "warn", title: `Close to its SLA.${due}` };
  if (item.sla.toLowerCase() === "insla") return { text: "In SLA", tone: "ok", title: `Within its SLA.${due}` };
  return { text: item.sla || "No SLA", tone: "idle", title: `S360 gives no SLA state.${due}` };
}

/** How the item is the user's: "Assigned to you", "You're the action owner (assigned to dana)". */
export function s360Roles(item: Pick<S360Item, "roles" | "assignedTo">): string {
  const assigned = item.roles.includes("assigned");
  const owner = item.roles.includes("owner");
  if (assigned && owner) return "Assigned to you, and you're the action owner";
  if (owner) return `You're the action owner${item.assignedTo ? ` (assigned to ${item.assignedTo})` : ""}`;
  return "Assigned to you";
}

/** Why an item is in Needs you: past its SLA, close to it, or new. */
export function s360Why(item: Pick<S360Item, "sla">): "late" | "soon" | "new" {
  const rank = slaRank(item.sla);
  return rank === 2 ? "late" : rank === 1 ? "soon" : "new";
}

/** The key of an item's to-do: its Needs you key, so the item gives one to-do wherever it's added from. */
export const s360TodoKey = (item: Pick<S360Item, "key">): string => `need:s360:${item.key}`;

/** An item's ask in a line: "S360: Use Default Deny … is out of SLA". */
export function s360NeedLine(item: Pick<S360Item, "title" | "sla">): string {
  const why = s360Why(item);
  return `S360: ${item.title} ${why === "late" ? "is out of SLA" : why === "soon" ? "is approaching its SLA" : "is new"}`;
}

export interface S360Group {
  key: "late" | "soon" | "open" | "closed";
  label: string;
  items: S360Item[];
}

/** The items by where they stand: out of SLA, approaching, the rest open, closed lately. Empty groups left out. */
export function s360Groups(items: S360Item[]): S360Group[] {
  const groups: S360Group[] = [
    { key: "late", label: "Out of SLA", items: [] },
    { key: "soon", label: "Approaching SLA", items: [] },
    { key: "open", label: "Open", items: [] },
    { key: "closed", label: "Closed lately", items: [] },
  ];
  for (const item of items) {
    const rank = slaRank(item.sla);
    groups[item.resolvedAt ? 3 : rank === 2 ? 0 : rank === 1 ? 1 : 2].items.push(item);
  }
  return groups.filter((g) => g.items.length);
}
