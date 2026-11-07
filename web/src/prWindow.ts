// The pull request window: every "open this PR" in the Workspace lands in one detached window, which
// the desktop shell (src/pr-window.mts) creates once, re-targets on each open and recreates after it
// is closed. This file is the page's side of it: the URL to ask for, and the channel that tells the
// Workspace when a change was made to a PR in that window.
import type { PR } from "./types.js";

/** The page URL that renders this PR's detail alone (the same address app.ts reads at boot). */
export function prWindowPath(pr: Pick<PR, "org" | "project" | "repoId" | "id">): string {
  return (
    `/?org=${encodeURIComponent(pr.org)}&project=${encodeURIComponent(pr.project)}` +
    `&repoId=${encodeURIComponent(pr.repoId)}&prId=${encodeURIComponent(String(pr.id))}`
  );
}

/**
 * Open the PR in the PR window. The shell intercepts the open and reuses its one window; in a
 * browser the shared window name does the same. No `noopener`: that would make the name a new window each time.
 */
export function openPrWindow(pr: Pick<PR, "org" | "project" | "repoId" | "id">): void {
  const win = window.open(prWindowPath(pr), "devis-pr");
  win?.focus?.();
}

const CHANNEL = "devis-pr";

/** The PR window tells the Workspace a PR changed (approved, completed, commented…), so its list can refresh. */
export function announcePrUpdated(): void {
  if (typeof BroadcastChannel !== "function") return;
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage({ type: "pr-updated" });
  channel.close();
}

export function onPrUpdatedElsewhere(listener: () => void): void {
  if (typeof BroadcastChannel !== "function") return;
  new BroadcastChannel(CHANNEL).addEventListener("message", (e: MessageEvent) => {
    if (e.data?.type === "pr-updated") listener();
  });
}
