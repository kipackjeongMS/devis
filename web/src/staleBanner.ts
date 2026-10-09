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
    `${icon("warning")}<span>ADO PR Ops lost its connection to the local server.</span>` +
    `<b>Restart the app to reconnect.</b>`;
  document.body.prepend(bar);
}
