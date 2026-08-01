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
import { revealFinding } from "./reveal.js";
import type { PR, Finding } from "./types.js";

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

/** Unposted findings only — the lights are a triage queue that empties as you post. */
function stagedFindings(pr: PR): Finding[] {
  const review = state.reviews[String(pr.id)];
  return ((review && review.findingsList) || []).filter((f) => f && !f.posted);
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

  const byLevel = new Map<string, Finding[]>();
  for (const f of stagedFindings(pr)) {
    const k = bucket(f.severity);
    const list = byLevel.get(k);
    if (list) list.push(f);
    else byLevel.set(k, [f]);
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
               title="${items.length} ${esc(lvl.label)} comment${plural}"
               aria-label="${items.length} ${esc(lvl.label)} comment${plural}">
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
    const drawer = dying.querySelector(".sl-drawer") as HTMLElement | null;
    if (drawer) drawer.style.maxHeight = "0px";
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
  items: Finding[]
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
         <div class="sl-head">${esc(lvl.label)} · ${items.length} comment${plural}</div>
         <div class="sl-list"></div>
       </div>
     </div>`
  );
  const list = node.querySelector(".sl-list") as HTMLElement;
  for (const f of items) list.appendChild(buildRow(f));
  bar.appendChild(node);
  pop = node;

  positionUnder(bar, light, node);

  const drawer = node.querySelector(".sl-drawer") as HTMLElement;
  // Next frame so the transition runs from the collapsed state rather than
  // snapping straight to the open one.
  requestAnimationFrame(() => {
    node.classList.add("open");
    drawer.style.maxHeight = drawer.scrollHeight + "px";
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

/** Hang the drawer off its own light, clamped so it can't overflow the bar. */
function positionUnder(bar: HTMLElement, light: HTMLElement, node: HTMLElement): void {
  const center = light.offsetLeft + light.offsetWidth / 2;
  const width = node.offsetWidth;
  const edge = 8;
  const left = Math.max(edge, Math.min(center - width / 2, bar.clientWidth - width - edge));
  node.style.left = left + "px";
  (node.querySelector(".sl-caret") as HTMLElement).style.left = center - left + "px";
}

function buildRow(f: Finding): HTMLElement {
  const base = f.file ? f.file.split("/").pop() || f.file : "General";
  const loc = f.line != null ? `${base}:${f.line}` : base;
  const title = (f.title || f.comment || "").split("\n")[0].trim();
  const row = el<HTMLButtonElement>(
    `<button type="button" class="sl-item">
       <span class="sl-item-title">${esc(title)}</span>
       <span class="sl-item-loc">${esc(loc)}</span>
     </button>`
  );
  row.addEventListener("click", async () => {
    closeDrawer();
    if (!(await revealFinding(f))) toast("Could not locate that comment in the diff", "err");
  });
  return row;
}
