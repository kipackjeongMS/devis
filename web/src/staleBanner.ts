// One-time persistent banner shown when this panel's connection to the
// extension's server has gone stale (the extension process was reloaded and
// a new server replaced the one this page loaded against). A plain reload
// won't fix this — the canvas panel must be closed and reopened so the host
// re-runs the extension's open() handler and hands back the *current* URL.
export function showStaleBanner(): void {
  if (document.getElementById("staleBanner")) return;
  const bar = document.createElement("div");
  bar.id = "staleBanner";
  bar.className = "stale-banner";
  bar.innerHTML =
    `<span>⚠ This extension was reloaded — this panel lost its connection.</span>` +
    `<b>Close and reopen the canvas panel to reconnect.</b>`;
  document.body.prepend(bar);
}
