// A right-click menu pinned at the pointer. One menu at a time; it reuses the
// Decision/Lifecycle flyout look (.detail-menu) and keyboard model.
import { el } from "./dom.js";
import { icon, type IconName } from "./icons.js";
import { esc } from "./util.js";

export interface ContextMenuEntry {
  label: string;
  icon?: IconName;
  run: () => void;
  /** Shown but not available: it stays in the arrow-key order (aria-disabled) and doesn't run. */
  disabled?: boolean;
  /** The entry's reason or detail, as a second line. */
  hint?: string;
}

let closeOpen: (() => void) | null = null;

export function closeContextMenu(): void {
  closeOpen?.();
}

/**
 * Where a context menu opens for a `contextmenu` event on `anchor`. The pointer's own position, or,
 * when the keyboard opened it (Shift+F10, the Menu key: the event reports 0, 0), the anchor's edge.
 */
export function menuPoint(e: MouseEvent, anchor: HTMLElement): { x: number; y: number } {
  if (e.clientX !== 0 || e.clientY !== 0) return { x: e.clientX, y: e.clientY };
  const rect = anchor.getBoundingClientRect();
  return { x: rect.left + 24, y: rect.top + rect.height / 2 };
}

/**
 * Open a menu at viewport point (x, y), clamped to the window. `restoreFocus`
 * runs when the menu closes by Esc, Tab, or choosing an item; `onClose` runs on every close.
 */
export function openContextMenu(
  x: number,
  y: number,
  label: string,
  entries: ContextMenuEntry[],
  restoreFocus?: () => void,
  onClose?: () => void
): void {
  closeContextMenu();
  if (!entries.length) return;

  const menu = el(`<div class="detail-menu ctx-menu" role="menu" aria-label="${esc(label)}"></div>`);
  const items = entries.map((entry) => {
    const item = el<HTMLButtonElement>(
      `<button type="button" class="detail-menu-item" role="menuitem"${entry.disabled ? ' aria-disabled="true"' : ""}>` +
        `<span class="detail-menu-check" aria-hidden="true">${entry.icon ? icon(entry.icon) : ""}</span>` +
        `<span class="detail-menu-text"><span class="detail-menu-label">${esc(entry.label)}</span>${
          entry.hint ? `<span class="detail-menu-hint">${esc(entry.hint)}</span>` : ""
        }</span>` +
        `</button>`
    );
    item.addEventListener("click", () => {
      if (entry.disabled) return;
      close(true);
      entry.run();
    });
    menu.appendChild(item);
    return item;
  });
  document.body.appendChild(menu);

  const edge = 8;
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(edge, Math.min(x, window.innerWidth - box.width - edge))}px`;
  menu.style.top = `${Math.max(edge, Math.min(y, window.innerHeight - box.height - edge))}px`;

  const focusAt = (index: number): void => {
    items[(index + items.length) % items.length]!.focus({ preventScroll: true });
  };
  const onKey = (event: KeyboardEvent): void => {
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation(); // keep the reading pane open
      close(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(current + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(current < 0 ? -1 : current - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusAt(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusAt(-1);
    } else if (event.key === "Tab") {
      close(true);
    }
  };
  const onOutside = (event: MouseEvent): void => {
    if (!menu.contains(event.target as Node)) close(false);
  };
  const dismiss = (): void => close(false);

  function close(restore: boolean): void {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onOutside, true);
    window.removeEventListener("scroll", dismiss, true);
    window.removeEventListener("resize", dismiss);
    window.removeEventListener("blur", dismiss);
    menu.remove();
    closeOpen = null;
    onClose?.();
    if (restore) restoreFocus?.();
  }

  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onOutside, true);
  window.addEventListener("scroll", dismiss, true);
  window.addEventListener("resize", dismiss);
  window.addEventListener("blur", dismiss);
  closeOpen = () => close(false);
  items[0]!.focus({ preventScroll: true });
}
