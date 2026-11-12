// DOM element helpers plus the two long-lived root nodes the app renders into.
import { esc } from "./util.js";
import { azureProblem, initSetupActions, onSetupJob, setupActionHtml, setupStatusHtml } from "./setupActions.js";

/** querySelector shorthand. Callers assume the element exists (guaranteed by index.html). */
export const $ = <T extends Element = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as unknown as T;

/** Build a detached element from an HTML string (returns the first child). */
export function el<T extends HTMLElement = HTMLElement>(html: string): T {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
}

/** The Settings page's content area, the PR window's reading pane, and the shell's two root nodes. */
export const view = $("#view") as HTMLElement;
export const listPane = $("#listPane") as HTMLElement;
export const readingPane = $("#readingPane") as HTMLElement;

/** Switch the shell between the main page and the settings page. */
export function setPage(page: "queue" | "settings"): void {
  document.body.dataset.page = page;
}

/** Replace the view with a full-panel error/empty state; an Azure sign-in problem gets its fix, then reloads. */
export function renderError(msg: string): void {
  setPage("settings");
  const az = azureProblem([msg]);
  const action = az === "missing" ? "azure-install" : "azure-signin";
  const hint = az
    ? `<div class="hint">${az === "missing" ? "Azure DevOps needs the Azure CLI, which Devis can install." : "Azure DevOps needs you to sign in again."}</div>` +
      `<div class="empty-act">${setupActionHtml(action, az === "missing" ? "Install" : "Sign in", { tone: "accent" })}${setupStatusHtml(action)}</div>`
    : "";
  view.innerHTML = `<div class="empty">${esc(msg)}${hint}</div>`;
  if (!az) return;
  initSetupActions();
  const off = onSetupJob((job, before) => {
    if (job.action !== action || job.state !== "done" || before?.state === "done") return;
    off();
    location.reload();
  });
}
