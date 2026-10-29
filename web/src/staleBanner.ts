// One-time persistent banner shown when this window's connection to the app's
// local server has gone stale (the server was restarted on a new port). A plain
// reload won't fix this — the app must be restarted so the window loads the
// current server URL.
import { icon } from "./icons.js";

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
  bar.append(text, dismiss);
  document.body.prepend(bar);
}
