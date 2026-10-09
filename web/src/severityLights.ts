// The sticky severity-lights bar on the PR detail view.
//
// One glowing orb per severity that actually has staged AI findings (a level
// with zero is simply absent), each capped with its count. Clicking an orb
// draws a drawer down from it listing that level's findings; clicking a row
// jumps to the real comment in the diff below.
import { el } from "./dom.js";
import { esc } from "./util.js";
import { state } from "./state.js";
import { toast } from "./toast.js";
import { revealFinding, revealSemanticFinding } from "./reveal.js";
import { reviewStateKey } from "./reviewKey.js";
import type { PR, Finding, SemanticFinding } from "./types.js";

/** Rendered left-to-right, most severe first. */
const LEVELS = [
  { key: "critical", label: "Critical" },
  { key: "high", label: "High" },
  { key: "medium", label: "Medium" },
  { key: "low", label: "Low" },
  { key: "nit", label: "NIT" },
] as const;

const ALIASES: Record<string, string> = {
  critical: "critical", blocker: "critical", severe: "critical",
  high: "high", major: "high", important: "high",
  medium: "medium", moderate: "medium", med: "medium",
  low: "low", minor: "low",
  nit: "nit", nitpick: "nit", note: "nit", info: "nit", style: "nit",
};

/** Map a free-text severity onto a level; anything unrecognised is a nit. */
function bucket(severity?: string | null): string {
  return ALIASES[String(severity || "").trim().toLowerCase()] || "nit";
}

type SeverityItem =
  | { kind: "inline"; finding: Finding }
  | { kind: "semantic"; finding: SemanticFinding };

/** Unposted findings only — the lights are a triage queue that empties as you post. */
function stagedFindings(pr: PR): SeverityItem[] {
  const review = state.reviews[reviewStateKey(pr)];
  if (!review) return [];
  return [
    ...(review.findingsList || [])
      .filter((finding) => finding && !finding.posted)
      .map((finding) => ({ kind: "inline" as const, finding })),
    ...(review.semanticFindingsList || [])
      .filter((finding) => finding && !finding.posted)
      .map((finding) => ({ kind: "semantic" as const, finding })),
  ];
}

// ---- the single mounted bar + its drawer -------------------------------------

let mounted: { bar: HTMLElement; pr: PR } | null = null;
let pop: HTMLElement | null = null;
let activeLight: HTMLButtonElement | null = null;
let onOutside: ((e: MouseEvent) => void) | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;

const reducedMotion = (): boolean =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Build the bar for a PR and make it the one the refresh helpers target. */
export function mountSeverityLights(pr: PR): HTMLElement {
  const bar = el(`<div class="sev-lights" hidden></div>`);
  mounted = { bar, pr };
  render();
  return bar;
}

/** Re-render from the current review result (call when findings change). */
export function refreshSeverityLights(): void {
  if (mounted && !mounted.bar.isConnected) mounted = null;
  render();
}

/** Tear down on detail close, so the document-level listeners don't leak. */
export function unmountSeverityLights(): void {
  closeDrawer();
  mounted = null;
}

function render(): void {
  closeDrawer();
  if (!mounted) return;
  const { bar, pr } = mounted;

  const byLevel = new Map<string, SeverityItem[]>();
  for (const item of stagedFindings(pr)) {
    const k = bucket(item.finding.severity);
    const list = byLevel.get(k);
    if (list) list.push(item);
    else byLevel.set(k, [item]);
  }

  bar.innerHTML = "";
  const present = LEVELS.filter((l) => (byLevel.get(l.key) || []).length > 0);
  bar.hidden = present.length === 0;
  if (!present.length) return;

  const row = el(`<div class="sl-row"></div>`);
  for (const lvl of present) {
    const items = byLevel.get(lvl.key)!;
    const plural = items.length === 1 ? "" : "s";
    const light = el<HTMLButtonElement>(
      `<button type="button" class="sl-light sl-${lvl.key}" aria-expanded="false"
               title="${items.length} ${esc(lvl.label)} finding${plural}"
               aria-label="${items.length} ${esc(lvl.label)} finding${plural}">
         <span class="sl-count">${items.length}</span>
         <span class="sl-orb"></span>
       </button>`
    );
    light.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDrawer(bar, light, lvl, items);
    });
    row.appendChild(light);
  }
  bar.appendChild(row);
}

function closeDrawer(): void {
  if (activeLight) {
    activeLight.classList.remove("on");
    activeLight.setAttribute("aria-expanded", "false");
    activeLight = null;
  }
  if (pop) {
    const dying = pop;
    pop = null;
    dying.classList.remove("open");
    if (reducedMotion()) dying.remove();
    else setTimeout(() => dying.remove(), 260);
  }
  if (onOutside) {
    document.removeEventListener("mousedown", onOutside, true);
    onOutside = null;
  }
  if (onKey) {
    document.removeEventListener("keydown", onKey, true);
    onKey = null;
  }
}

function toggleDrawer(
  bar: HTMLElement,
  light: HTMLButtonElement,
  lvl: { key: string; label: string },
  items: SeverityItem[]
): void {
  const reopening = activeLight === light;
  closeDrawer();
  if (reopening) return; // clicking the lit orb again just closes

  activeLight = light;
  light.classList.add("on");
  light.setAttribute("aria-expanded", "true");

  const plural = items.length === 1 ? "" : "s";
  const node = el(
    `<div class="sl-pop sl-${lvl.key}">
       <span class="sl-caret"></span>
       <div class="sl-drawer">
         <div class="sl-head">${esc(lvl.label)} · ${items.length} finding${plural}</div>
         <div class="sl-list"></div>
       </div>
     </div>`
  );
  const list = node.querySelector(".sl-list") as HTMLElement;
  for (const item of items) list.appendChild(buildRow(item));
  const host = bar.closest<HTMLElement>(".detail-head") || bar;
  host.appendChild(node);
  pop = node;

  positionUnder(host, light, node);

  // Next frame so the transition runs from the hidden state.
  requestAnimationFrame(() => {
    node.classList.add("open");
  });

  onOutside = (e: MouseEvent) => {
    const t = e.target as Node;
    if (!node.contains(t) && !light.contains(t)) closeDrawer();
  };
  document.addEventListener("mousedown", onOutside, true);

  // Capture phase + stopPropagation: the detail modal also listens for Escape,
  // and without this the first Esc would close the whole PR instead of the drawer.
  onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    e.preventDefault();
    closeDrawer();
    light.focus();
  };
  document.addEventListener("keydown", onKey, true);
}

/** Hang the drawer off its own light, clamped to the full sticky heading. */
function positionUnder(host: HTMLElement, light: HTMLElement, node: HTMLElement): void {
  const hostRect = host.getBoundingClientRect();
  const lightRect = light.getBoundingClientRect();
  const center = lightRect.left - hostRect.left + lightRect.width / 2;
  const width = node.offsetWidth;
  const edge = 8;
  const left = Math.max(edge, Math.min(center - width / 2, host.clientWidth - width - edge));
  node.style.left = left + "px";
  (node.querySelector(".sl-caret") as HTMLElement).style.left = center - left + "px";
}

function buildRow(item: SeverityItem): HTMLElement {
  let loc: string;
  if (item.kind === "semantic") {
    const category = item.finding.category.replace(/^\w/, (value) => value.toUpperCase());
    loc = `${category} · PR-level`;
  } else {
    const finding = item.finding;
    const base = finding.file ? finding.file.split("/").pop() || finding.file : "General";
    loc = finding.line != null ? `${base}:${finding.line}` : base;
  }
  const f = item.finding;
  const title = (f.title || f.comment || "").split("\n")[0].trim();
  const row = el<HTMLButtonElement>(
    `<button type="button" class="sl-item">
       <span class="sl-item-title">${esc(title)}</span>
       <span class="sl-item-loc">${esc(loc)}</span>
     </button>`
  );
  row.addEventListener("click", async () => {
    closeDrawer();
    const revealed = item.kind === "semantic"
      ? revealSemanticFinding(item.finding)
      : await revealFinding(item.finding);
    if (!revealed) toast("Could not locate that finding", "err");
  });
  return row;
}
