// A task's Artifacts window, page side: the URL that asks the desktop shell for the task's window (the shell
// builds and keeps one per task, src/artifacts-window.mts), the hash that names its file, and the channel
// that tells the Workspace when a file changed in that window. artifacts.ts is the window itself.

const CHANNEL = "devis-artifacts";

/** `#file=…` (and `&edit=1`), or "" without a file. Same shape as the shell's. */
export function artifactsHash(file: string | null, edit = false): string {
  if (!file) return "";
  const params = new URLSearchParams({ file });
  if (edit) params.set("edit", "1");
  return `#${params.toString()}`;
}

export function readArtifactsHash(hash: string): { file: string | null; edit: boolean } {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const file = (params.get("file") || "").trim();
  return { file: file || null, edit: !!file && params.get("edit") === "1" };
}

export function artifactsWindowPath(taskId: string, file: string | null = null, edit = false): string {
  return `/artifacts.html?task=${encodeURIComponent(taskId)}${artifactsHash(file, edit)}`;
}

/**
 * Open the task's Artifacts window on a file (in the editor with `edit`). The shell keeps one per task and
 * brings it forward on that file; in a browser the window's name does the same, and only the hash changes.
 */
export function openArtifactsWindow(taskId: string, file: string | null = null, edit = false): void {
  const win = window.open(artifactsWindowPath(taskId, file, edit), `devis-artifacts-${taskId}`);
  win?.focus?.();
}

/** The window saved, made or deleted a file: the Workspace's Artifacts tab reads its list again. */
export function announceArtifactsChanged(taskId: string): void {
  if (typeof BroadcastChannel !== "function") return;
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage({ type: "changed", taskId });
  channel.close();
}

export function onArtifactsChanged(listener: (taskId: string) => void): void {
  if (typeof BroadcastChannel !== "function") return;
  new BroadcastChannel(CHANNEL).addEventListener("message", (e: MessageEvent) => {
    if (e.data?.type === "changed" && typeof e.data.taskId === "string") listener(e.data.taskId);
  });
}
