// One-time persistent banner shown when this window's connection to the app's
// local server has gone stale (the server was restarted on a new port). A plain
// reload won't fix this — the app must be restarted so the window loads the
// current server URL.
import { icon } from "./icons.js";
import { onSetupJob, setupActionHtml, setupStatusHtml } from "./setupActions.js";

export function showStaleBanner(): void {
  if (document.getElementById("staleBanner")) return;
  const bar = document.createElement("div");
  bar.id = "staleBanner";
  bar.className = "stale-banner";
  bar.innerHTML =
    `${icon("warning")}<span>Devis lost its connection to the local server.</span>` +
    `<b>Restart the app to reconnect.</b>`;
  document.body.prepend(bar);
}

/** A notice that stays until dismissed: Copilot is running without Agency. */
export function showAgencyBanner(warning: string): void {
  if (document.getElementById("agencyBanner")) return;
  const bar = document.createElement("div");
  bar.id = "agencyBanner";
  bar.className = "stale-banner caution";
  bar.setAttribute("role", "status");
  bar.innerHTML = `${icon("warning")}<b>Copilot is running without Agency.</b>`;
  const text = document.createElement("span");
  text.textContent = warning;
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "btn sm ghost";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => bar.remove());
  bar.append(text);
  bar.insertAdjacentHTML("beforeend", setupActionHtml("agency-install", "Install Agency", { tone: "accent" }));
  bar.append(dismiss);
  bar.insertAdjacentHTML("beforeend", setupStatusHtml("agency-install"));
  document.body.prepend(bar);
}

/**
 * Azure DevOps stopped answering because the CLI is signed out (or missing). Sign in from here,
 * and `onFixed` runs once it's done so the list loads again. Gone once Azure answers.
 */
export function showAzureBanner(missing: boolean, onFixed: () => void): void {
  const action = missing ? "azure-install" : "azure-signin";
  let bar = document.getElementById("azureBanner");
  if (bar?.dataset.action === action) return;
  hideAzureBanner();
  bar = document.createElement("div");
  bar.id = "azureBanner";
  bar.dataset.action = action;
  bar.className = "stale-banner caution";
  bar.setAttribute("role", "status");
  bar.innerHTML =
    `${icon("warning")}<b>${missing ? "Azure DevOps needs the Azure CLI." : "Azure DevOps needs you to sign in again."}</b>` +
    `<span>${missing ? "Devis installs it for you, then you sign in." : "Pull requests and reviews start where they stopped."}</span>` +
    setupActionHtml(action, missing ? "Install" : "Sign in", { tone: "accent" }) +
    setupStatusHtml(action);
  document.body.prepend(bar);
  azureOff = onSetupJob((job, before) => {
    if (job.action !== action || job.state !== "done" || before?.state === "done") return;
    onFixed();
  });
}

let azureOff: (() => void) | null = null;

/** Azure answered again. */
export function hideAzureBanner(): void {
  azureOff?.();
  azureOff = null;
  document.getElementById("azureBanner")?.remove();
}
