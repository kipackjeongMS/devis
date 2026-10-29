import { icon } from "./icons.js";
import { esc } from "./util.js";

interface IdePickerOptions {
  id: string;
  action: string;
  workspace?: string;
  opening?: ReadonlySet<string>;
}

/** Native popovers stay open through polling and launch requests, above clipped panes. */
export function idePickerHtml({ id, action, workspace, opening }: IdePickerOptions): string {
  const choices = [
    { ide: "vscode", name: "VS Code" },
    { ide: "vscode-insiders", name: "VS Code Insiders" },
  ];
  return `<div class="ide-picker" data-key="${esc(id)}">
    <button type="button" class="btn sm ghost ide-trigger" popovertarget="${esc(id)}" aria-controls="${esc(id)}">
      <span>Open in</span>${icon("down")}
    </button>
    <div id="${esc(id)}" class="ide-panel" popover="auto" role="group" aria-label="Open workspace in an IDE">
      ${choices.map(({ ide, name }, i) => `<button type="button" class="icon-btn ide-option" data-act="${esc(action)}" data-ide="${ide}"
        aria-label="Open in ${name}" title="${esc(workspace ? `Open ${workspace} in ${name}` : `Open in ${name}`)}"${i === 0 ? " autofocus" : ""}${opening?.has(ide) ? ' disabled aria-busy="true"' : ""}>
        <img src="./assets/ide-icons/${ide}.png" width="24" height="24" alt="" draggable="false">
      </button>`).join("")}
    </div>
  </div>`;
}

/** Let Escape dismiss the picker before its containing task or code view handles it. */
export function closeIdePicker(root: ParentNode, restoreFocus = false): boolean {
  const panel = root.querySelector<HTMLElement>(".ide-panel:popover-open");
  if (!panel) return false;
  panel.hidePopover();
  if (restoreFocus) root.querySelector<HTMLButtonElement>(`[popovertarget="${CSS.escape(panel.id)}"]`)?.focus();
  return true;
}
