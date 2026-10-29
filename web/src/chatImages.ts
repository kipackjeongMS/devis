// Images in the chats (the Lead and a task's workers): the ones a message carries,
// the tray of images waiting to go with the next message, pasting, dropping or picking
// them, and a viewer for one at full size. The builders are pure strings, so harnesses can
// import the compiled module; ImageDraft and the wiring touch the DOM and the network.

import { esc } from "./util.js";
import { icon } from "./icons.js";

/** An image the app saved: its id (a hash of its bytes plus its type) and what to call it. */
export interface ChatImage {
  id: string;
  name: string;
}

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** As the service allows: an image's base64 has to fit a 10 MB request. */
export const IMAGE_MAX_BYTES = 7 * 1024 * 1024;
export const IMAGES_PER_MESSAGE = 6;

export const imageUrl = (id: string): string => `/api/jarvis/images/${encodeURIComponent(id)}`;

/** The same images in the same order. */
export function sameImages(a: readonly ChatImage[] | undefined, b: readonly ChatImage[] | undefined): boolean {
  const x = a || [];
  const y = b || [];
  return x.length === y.length && x.every((image, i) => image.id === y[i].id);
}

/** Why a file can't go with the message (`count` already in the tray), or null when it can. */
export function imageProblem(file: { type: string; size: number }, count: number): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return "Only PNG, JPEG, GIF and WebP images can be sent.";
  if (file.size > IMAGE_MAX_BYTES) return `Images can be up to ${IMAGE_MAX_BYTES / 1024 / 1024} MB.`;
  if (count >= IMAGES_PER_MESSAGE) return `A message can carry up to ${IMAGES_PER_MESSAGE} images.`;
  return null;
}

/** What a paste carries to attach: its image files, unless it also has text, which pastes as text (an Office copy has both). */
export function pastedImages(items: ReadonlyArray<{ kind: string; type: string; getAsFile(): File | null }>, plainText: string): File[] {
  if (plainText.trim()) return [];
  const files: File[] = [];
  for (const item of items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

/** A message's images, in its bubble: each opens at full size. */
export function messageImagesHtml(images: readonly ChatImage[] | undefined, small = false): string {
  if (!images?.length) return "";
  const items = images
    .map(
      (i) =>
        `<button type="button" class="chat-img" data-image="${esc(i.id)}" data-image-name="${esc(i.name)}" title="${esc(i.name)}" aria-label="Open ${esc(i.name)}"><img src="${esc(imageUrl(i.id))}" alt="${esc(i.name)}" loading="lazy" decoding="async"></button>`
    )
    .join("");
  return `<div class="chat-imgs${small ? " small" : ""}">${items}</div>`;
}

/** An image in the tray over the message box: on its way, ready to send, or refused. */
export interface DraftImage {
  key: string;
  name: string;
  /** A local URL for the picture, until the message goes. */
  preview: string;
  state: "uploading" | "ready" | "failed";
  id?: string;
  error?: string;
}

/** The tray's images, each with a way to take it out. */
export function trayHtml(items: readonly DraftImage[]): string {
  return items
    .map((d) => {
      const mark =
        d.state === "uploading"
          ? `<span class="chat-att-mark" aria-hidden="true"><span class="spinner"></span></span>`
          : d.state === "failed"
            ? `<span class="chat-att-mark fail" aria-hidden="true">${icon("warning")}</span>`
            : "";
      const label = d.state === "failed" ? `${d.name}: ${d.error || "not saved"}` : d.state === "uploading" ? `${d.name} (uploading)` : d.name;
      return `<span class="chat-att ${d.state}" data-key="att:${esc(d.key)}" data-v="${d.state}" title="${esc(label)}">
          <img src="${esc(d.preview)}" alt="${esc(label)}">${mark}
          <button type="button" class="chat-att-x" data-att-remove="${esc(d.key)}" aria-label="Remove ${esc(d.name)}" title="Remove">${icon("dismiss")}</button>
        </span>`;
    })
    .join("");
}

/** What the tray says about itself, for the hint: null when there's nothing to say. */
export function trayNote(items: readonly DraftImage[]): string | null {
  const uploading = items.filter((d) => d.state === "uploading").length;
  const failed = items.filter((d) => d.state === "failed").length;
  if (uploading) return uploading === 1 ? "Uploading the image…" : `Uploading ${uploading} images…`;
  if (failed) return failed === 1 ? "One image couldn't be saved; remove it or paste it again." : `${failed} images couldn't be saved; remove them or paste them again.`;
  return null;
}

// ---- the tray -------------------------------------------------------------------------

export type Upload = (file: Blob, name: string) => Promise<ChatImage>;

const defaultName = (type: string): string => `pasted-image.${type === "image/jpeg" ? "jpg" : type.split("/")[1] || "png"}`;

/** One count for every tray, so an image's key never repeats across chats sharing a tray element. */
let draftSeq = 0;

/** The images waiting to go with the next message in one chat. Each uploads as soon as it's added. */
export class ImageDraft {
  items: DraftImage[] = [];

  constructor(
    private readonly upload: Upload,
    private readonly changed: () => void
  ) {}

  get uploading(): boolean {
    return this.items.some((d) => d.state === "uploading");
  }

  /** The images ready to send, in order. */
  get ready(): ChatImage[] {
    return this.items.filter((d) => d.state === "ready" && d.id).map((d) => ({ id: d.id!, name: d.name }));
  }

  /** Add files. Returns why any were refused. */
  add(files: readonly File[]): string[] {
    const problems: string[] = [];
    for (const file of files) {
      const problem = imageProblem(file, this.items.filter((d) => d.state !== "failed").length);
      if (problem) {
        if (!problems.includes(problem)) problems.push(problem);
        continue;
      }
      const item: DraftImage = {
        key: `d${++draftSeq}`,
        name: file.name && file.name !== "image.png" ? file.name : defaultName(file.type),
        preview: URL.createObjectURL(file),
        state: "uploading",
      };
      this.items.push(item);
      void this.upload(file, item.name).then(
        (image) => {
          item.state = "ready";
          item.id = image.id;
          item.name = image.name;
          if (this.items.includes(item)) this.changed();
        },
        (error: Error) => {
          item.state = "failed";
          item.error = error.message;
          if (this.items.includes(item)) this.changed();
        }
      );
    }
    if (files.length) this.changed();
    return problems;
  }

  remove(key: string): void {
    const item = this.items.find((d) => d.key === key);
    if (!item) return;
    this.items = this.items.filter((d) => d !== item);
    URL.revokeObjectURL(item.preview);
    this.changed();
  }

  /** Take the ready images out to send. Give them back with restore() if the message didn't go. */
  take(): DraftImage[] {
    const sent = this.items.filter((d) => d.state === "ready");
    if (!sent.length) return [];
    this.items = this.items.filter((d) => d.state !== "ready");
    this.changed();
    return sent;
  }

  restore(items: readonly DraftImage[]): void {
    if (!items.length) return;
    this.items = [...items, ...this.items.filter((d) => !items.includes(d))];
    this.changed();
  }

  /** The message went: its previews aren't needed (the chat shows the saved images). */
  release(items: readonly DraftImage[]): void {
    for (const d of items) URL.revokeObjectURL(d.preview);
  }
}

/** Read a file as a data URL. */
function dataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("Couldn't read the image."));
    reader.readAsDataURL(file);
  });
}

/** Save an image with the service; it comes back as one a message can carry. */
export function uploadWith(post: (path: string, body: unknown) => Promise<{ image: ChatImage }>): Upload {
  return async (file, name) => (await post("/api/jarvis/images", { data: await dataUrl(file), name })).image;
}

// ---- wiring a pane --------------------------------------------------------------------

export interface ImagePane {
  root: HTMLElement;
  form: HTMLFormElement;
  input: HTMLTextAreaElement;
  tray: HTMLElement;
  attach: HTMLButtonElement;
  file: HTMLInputElement;
}

export interface ImageHost {
  /** The tray the pane's box adds to now, or null when the box takes no images. */
  draft(): ImageDraft | null;
  /** Some files were refused, and why. */
  refused(problems: string[]): void;
}

const filesOf = (list: FileList | null | undefined): File[] => [...(list || [])].filter((f) => f.type.startsWith("image/"));

/** Paste, drop, or pick images into the pane's tray, take them out again, and open any image in the chat. */
export function wireImages(pane: ImagePane, host: ImageHost): void {
  const add = (files: File[]) => {
    const draft = host.draft();
    if (!draft || !files.length || pane.input.disabled) return;
    const problems = draft.add(files);
    if (problems.length) host.refused(problems);
  };
  pane.input.addEventListener("paste", (e) => {
    const data = e.clipboardData;
    if (!data || !host.draft()) return;
    const files = pastedImages([...data.items], data.getData("text/plain"));
    if (!files.length) return;
    e.preventDefault();
    add(files);
  });
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  pane.form.addEventListener("dragover", (e) => {
    if (!hasFiles(e) || !host.draft() || pane.input.disabled) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "copy";
    pane.form.classList.add("drop");
  });
  pane.form.addEventListener("dragleave", (e) => {
    if (!pane.form.contains(e.relatedTarget as Node | null)) pane.form.classList.remove("drop");
  });
  pane.form.addEventListener("drop", (e) => {
    pane.form.classList.remove("drop");
    if (!hasFiles(e)) return;
    e.preventDefault();
    add(filesOf(e.dataTransfer?.files));
    pane.input.focus();
  });
  pane.attach.addEventListener("click", () => pane.file.click());
  pane.file.addEventListener("change", () => {
    add(filesOf(pane.file.files));
    pane.file.value = "";
    pane.input.focus();
  });
  pane.tray.addEventListener("click", (e) => {
    const x = (e.target as HTMLElement).closest<HTMLElement>("[data-att-remove]");
    if (!x) return;
    host.draft()?.remove(x.dataset.attRemove!);
    pane.input.focus();
  });
  pane.root.addEventListener("click", (e) => {
    const open = (e.target as HTMLElement).closest<HTMLElement>("[data-image]");
    if (open) openImageViewer({ id: open.dataset.image!, name: open.dataset.imageName || "" }, open);
  });
}

/** Paint the tray: hidden while it's empty. */
export function paintTray(tray: HTMLElement, draft: ImageDraft | null, patch: (el: HTMLElement, html: string) => void): void {
  const items = draft?.items || [];
  patch(tray, trayHtml(items));
  tray.hidden = !items.length;
}

// ---- the viewer -----------------------------------------------------------------------

/** One image at full size over everything. Escape, the close button or a click outside it closes it. */
export function openImageViewer(image: ChatImage, opener: HTMLElement): void {
  const overlay = document.createElement("div");
  overlay.className = "img-view";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", image.name || "Image");
  overlay.innerHTML = `
    <figure class="img-view-fig">
      <img src="${esc(imageUrl(image.id))}" alt="${esc(image.name)}">
      <figcaption class="img-view-bar">
        <span class="img-view-name">${esc(image.name)}</span>
        <button type="button" class="icon-btn sm img-view-close" aria-label="Close" title="Close (Esc)">${icon("dismiss")}</button>
      </figcaption>
    </figure>`;
  const close = () => {
    window.removeEventListener("keydown", onKey, true);
    overlay.remove();
    if (opener.isConnected) opener.focus({ preventScroll: true });
  };
  // On the window, ahead of any dialog under it that closes on Escape too.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      e.preventDefault();
      overlay.querySelector<HTMLElement>(".img-view-close")!.focus();
    }
  };
  overlay.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".img-view-fig img")) close();
  });
  window.addEventListener("keydown", onKey, true);
  document.body.appendChild(overlay);
  overlay.querySelector<HTMLElement>(".img-view-close")!.focus();
}
