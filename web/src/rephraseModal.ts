// "Review & post": clicking Post to ADO on a staged review finding opens this
// confirmation modal with the generated human-like comment ready to edit. Rephrase
// is optional and uses the recorded reviewer session when one is available.
// Reuses the .ask-* dialog styles so it stacks above the PR-detail slide-over.
import { el } from "./dom.js";
import { esc } from "./util.js";
import { postJSON } from "./api.js";

interface RephraseOptions {
  title?: string;
  comment: string;
  findingId?: string;
  semanticFindingId?: string;
  initialText?: string;
  loc: string; // header location text (e.g. "file:42 · right")
  model?: string; // preferred model (state.config.reviewModel)
  /**
   * PR whose recorded reviewer session should produce the rewrite, if it has one.
   * The client names the PR, never the session — the server resolves it.
   */
  prId?: string | number;
  org?: string;
  project?: string;
  repoId?: string;
  onHumanized?: (text: string) => void;
  onPost: (text: string) => Promise<void>; // performs the real ADO post + card swap
}

export function openRephraseModal(opts: RephraseOptions): void {
  const overlay = el(`<div class="ask-overlay"></div>`);
  const dialog = el(`<div class="ask-dialog" role="dialog" aria-modal="true" tabindex="-1"></div>`);
  const original = (opts.title ? opts.title + "\n\n" : "") + opts.comment;
  dialog.innerHTML =
    `<div class="ask-head">` +
    `<span class="ask-title">Review &amp; post</span>` +
    `<span class="ask-loc">${esc(opts.loc)}</span>` +
    `<button class="ask-close" title="Close (Esc)" aria-label="Close">✕</button>` +
    `</div>` +
    `<div class="rp-label">Copilot review</div>` +
    `<pre class="ask-snippet prose"><code>${esc(original)}</code></pre>` +
    `<div class="rp-label">Comment to post (editable)</div>` +
    `<textarea class="ask-q rp-text" rows="5" placeholder="Edit the comment before posting…"></textarea>` +
    `<div class="ask-answer loading-ans rp-status" hidden></div>` +
    `<div class="ask-actions">` +
    `<button class="btn ghost sm rp-regen">Rephrase</button>` +
    `<button class="btn ghost sm rp-cancel">Cancel</button>` +
    `<button class="btn sm rp-post" disabled>Post to ADO</button>` +
    `</div>`;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const ta = dialog.querySelector(".rp-text") as HTMLTextAreaElement;
  const status = dialog.querySelector(".rp-status") as HTMLElement;
  const regenBtn = dialog.querySelector(".rp-regen") as HTMLButtonElement;
  const cancelBtn = dialog.querySelector(".rp-cancel") as HTMLButtonElement;
  const postBtn = dialog.querySelector(".rp-post") as HTMLButtonElement;
  const closeBtn = dialog.querySelector(".ask-close") as HTMLButtonElement;

  let closed = false;
  let generating = false;
  function close(): void {
    closed = true;
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
  }
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  cancelBtn.addEventListener("click", close);
  closeBtn.addEventListener("click", close);

  function setGenerating(on: boolean): void {
    generating = on;
    ta.disabled = on;
    regenBtn.disabled = on;
    postBtn.disabled = on || !ta.value.trim();
    if (on) {
      status.hidden = false;
      status.className = "ask-answer loading-ans rp-status";
      status.innerHTML = '<span class="spinner"></span> Rephrasing… this can take ~30s.';
    } else {
      status.hidden = true;
    }
  }

  function showError(msg: string, allowManualPost: boolean): void {
    generating = false;
    status.hidden = false;
    status.className = "ask-answer err-ans rp-status";
    status.textContent = msg;
    ta.disabled = false;
    regenBtn.disabled = false;
    postBtn.disabled = !allowManualPost || !ta.value.trim();
  }

  async function generate(): Promise<void> {
    setGenerating(true);
    try {
      const res = await postJSON("/api/rephrase", {
        comment: ta.value.trim() || opts.comment,
        title: opts.title || "",
        findingId: opts.findingId || "",
        semanticFindingId: opts.semanticFindingId || "",
        model: opts.model || "",
        prId: opts.prId ?? "",
        org: opts.org || "",
        project: opts.project || "",
        repoId: opts.repoId || "",
      });
      if (closed) return;
      ta.value = (res && res.text) || "";
      if (opts.onHumanized) opts.onHumanized(ta.value);
      setGenerating(false);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    } catch (e: any) {
      if (closed) return;
      // Generation failed, but the user can still type a comment manually and post.
      showError("Rephrase failed: " + (e?.message || "unknown error") + ". You can edit manually and still post.", true);
    }
  }

  regenBtn.addEventListener("click", () => void generate());
  ta.addEventListener("input", () => {
    if (!generating) postBtn.disabled = !ta.value.trim();
  });

  postBtn.addEventListener("click", async () => {
    const text = ta.value.trim();
    if (!text) {
      ta.focus();
      return;
    }
    postBtn.disabled = true;
    regenBtn.disabled = true;
    ta.disabled = true;
    postBtn.textContent = "Posting…";
    try {
      await opts.onPost(text);
      close();
    } catch (e: any) {
      if (closed) return;
      showError("Post failed: " + (e?.message || "unknown error"), true);
      postBtn.textContent = "Post to ADO";
    }
  });

  dialog.focus();
  ta.value = opts.initialText?.trim() ? opts.initialText : opts.comment;
  setGenerating(false);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}
