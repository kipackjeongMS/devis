// Entry for code.html: the per-worker code window. The desktop shell opens it with
// ?worker=<sessionId>, plus the same shell params the main window gets.
import { applyShellClasses } from "./shell.js";
import { mountWorkerChanges } from "./workerChanges.js";

const WORKER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const params = new URLSearchParams(location.search);
applyShellClasses(params);

const root = document.getElementById("code") as HTMLElement;
const titleEl = document.getElementById("codeTitle");
const worker = params.get("worker") || "";

if (!WORKER_ID.test(worker)) {
  root.innerHTML =
    `<div class="cw-gone"><div class="cw-state bad">` +
    `<p class="cw-state-title">This window needs a worker</p>` +
    `<p class="cw-state-text">Open it from a task's View changes button.</p>` +
    `</div></div>`;
} else {
  mountWorkerChanges(root, {
    worker,
    onTitle(name, task) {
      const title = task ? `${name} \u00b7 ${task}` : name;
      document.title = `${title} \u00b7 Changes`;
      if (titleEl) titleEl.textContent = title;
    },
  });
}
