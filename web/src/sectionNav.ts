// Section tabs in the sticky PR head: each tab scrolls the reading pane to its
// section, and the active tab follows the reader as they scroll (rAF-throttled).
// Tabs whose section is hidden (the review panel before a review exists) hide too.
import { el } from "./dom.js";
import { esc } from "./util.js";
import { activeSectionIndex } from "./shellModel.js";

export interface PaneSection {
  label: string;
  count?: number;
  target: HTMLElement;
}

const mounted = new WeakMap<HTMLElement, AbortController>();

const reducedMotion = (): boolean =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function topWithin(target: HTMLElement, scroller: HTMLElement): number {
  return target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

/** Append the tab row to `head` (already inside a `.pane-scroll`). */
export function mountSectionNav(head: HTMLElement, sections: PaneSection[]): HTMLElement | null {
  const scroller = head.closest<HTMLElement>(".pane-scroll");
  if (!scroller || !sections.length) return null;
  mounted.get(scroller)?.abort(); // a reload rebuilds the head inside the same scroller
  const abort = new AbortController();
  mounted.set(scroller, abort);

  const nav = el(`<nav class="detail-tabs" aria-label="Pull request sections"></nav>`);
  const tabs = sections.map((section) => {
    const count = section.count != null ? `<span class="detail-tab-n">${section.count}</span>` : "";
    const tab = el<HTMLButtonElement>(
      `<button type="button" class="detail-tab"><span class="detail-tab-label">${esc(section.label)}</span>${count}</button>`
    );
    tab.addEventListener("click", () => {
      const top = topWithin(section.target, scroller) - head.offsetHeight - 12;
      scroller.scrollTo({ top: Math.max(0, top), behavior: reducedMotion() ? "auto" : "smooth" });
    });
    nav.appendChild(tab);
    return tab;
  });
  head.appendChild(nav);

  let frame = 0;
  const spy = (): void => {
    frame = 0;
    if (!head.isConnected) return;
    const visible = sections.map((s, i) => ({ s, i })).filter(({ s }) => !s.target.hidden);
    const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    const index = activeSectionIndex(
      visible.map(({ s }) => topWithin(s.target, scroller)),
      scroller.scrollTop,
      head.offsetHeight + 16,
      atEnd
    );
    const active = index < 0 ? -1 : visible[index].i;
    tabs.forEach((tab, i) => {
      if (i === active) tab.setAttribute("aria-current", "true");
      else tab.removeAttribute("aria-current");
    });
  };
  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(spy);
  };

  const syncHidden = (): void => {
    sections.forEach((section, i) => (tabs[i].hidden = section.target.hidden));
    schedule();
  };
  const hiddenWatch = new MutationObserver(syncHidden);
  for (const section of sections) hiddenWatch.observe(section.target, { attributes: true, attributeFilter: ["hidden"] });
  const resize = new ResizeObserver(() => {
    scroller.style.setProperty("--detail-head-h", head.offsetHeight + "px");
    schedule();
  });
  resize.observe(head);
  scroller.addEventListener("scroll", schedule, { passive: true, signal: abort.signal });
  abort.signal.addEventListener("abort", () => {
    hiddenWatch.disconnect();
    resize.disconnect();
    if (frame) cancelAnimationFrame(frame);
  });

  syncHidden();
  return nav;
}
