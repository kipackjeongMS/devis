// Images the user pastes into a chat (the Lead or a worker). Each is saved once under
// the Workspace's folder (data\jarvis), named by a hash of its bytes, and goes to the session as a file
// attachment: the runtime reads and resizes it, and the session's history keeps the path, so
// the chat can show the image again after a reload. The runtime also keeps its own copy of
// the bytes, so pruning old files only costs the chat its thumbnails, never the session.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ServerResponse } from "node:http";
import type { MessageOptions } from "@github/copilot-sdk";
import { IMAGE_ID, type ChatImage } from "./chat-transcript.mjs";
import { JarvisError, jarvisDir } from "./jarvis-store.mjs";

export type { ChatImage } from "./chat-transcript.mjs";

/** The types a chat takes, by what the file's first bytes say it is. */
const TYPES: Record<string, { ext: string; mime: string }> = {
    png: { ext: "png", mime: "image/png" },
    jpg: { ext: "jpg", mime: "image/jpeg" },
    gif: { ext: "gif", mime: "image/gif" },
    webp: { ext: "webp", mime: "image/webp" },
};

export const IMAGE_LIMITS = {
    /** The largest image, as bytes. Its base64 has to fit the API's 10 MB request. */
    maxBytes: 7 * 1024 * 1024,
    /** Images in one message. */
    perMessage: 6,
    /** Saved images go after this long without being sent again. */
    keepDays: 30,
    /** A half-written file (a failed save) goes after this long. */
    partialMs: 60 * 60_000,
};

const NAME_MAX = 80;

export function imagesDir(): string {
    return join(jarvisDir(), "images");
}

export function imagePath(id: string): string {
    return join(imagesDir(), id);
}

/** The image type the bytes start with, or null for anything else. */
export function sniffImage(bytes: Uint8Array): (typeof TYPES)[string] | null {
    const at = (offset: number, sig: number[]) => sig.every((b, i) => bytes[offset + i] === b);
    if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return TYPES.png;
    if (at(0, [0xff, 0xd8, 0xff])) return TYPES.jpg;
    if (at(0, [0x47, 0x49, 0x46, 0x38])) return TYPES.gif;
    if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return TYPES.webp;
    return null;
}

/** A name fit to show and to hand the runtime: no folders, no control characters, not too long. */
export function cleanImageName(value: unknown, fallback: string): string {
    const raw = typeof value === "string" ? value : "";
    const base = raw.split(/[\\/]/).pop() || "";
    // eslint-disable-next-line no-control-regex
    const name = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").replace(/\s+/g, " ").trim();
    return (name || fallback).slice(0, NAME_MAX);
}

export interface SavedImage extends ChatImage {
    mimeType: string;
    size: number;
}

/**
 * Save a pasted image: `data` is its base64 (a data URL works too). The file's own bytes decide
 * its type; the same image pasted twice is one file.
 */
export async function saveImage(body: { data?: unknown; name?: unknown } | null | undefined): Promise<SavedImage> {
    const raw = typeof body?.data === "string" ? body.data : "";
    const base64 = raw.startsWith("data:") ? raw.slice(raw.indexOf(",") + 1) : raw;
    if (!base64.trim()) throw new JarvisError("No image came with the request.");
    if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) throw new JarvisError("That image isn't valid base64.");
    const bytes = Buffer.from(base64, "base64");
    if (!bytes.length) throw new JarvisError("That image is empty.");
    if (bytes.length > IMAGE_LIMITS.maxBytes) throw new JarvisError(`Images can be up to ${IMAGE_LIMITS.maxBytes / 1024 / 1024} MB.`, 413);
    const type = sniffImage(bytes);
    if (!type) throw new JarvisError("Only PNG, JPEG, GIF and WebP images can be sent.", 415);
    const id = `${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.${type.ext}`;
    const name = cleanImageName(body?.name, `image.${type.ext}`);
    const path = imagePath(id);
    await mkdir(imagesDir(), { recursive: true });
    const now = new Date();
    try {
        // Already saved: pasting it again keeps it from being pruned.
        await utimes(path, now, now);
    } catch {
        const partial = `${path}.${process.pid}.${Date.now()}.part`;
        await writeFile(partial, bytes);
        await rename(partial, path).catch(async (error) => {
            await rm(partial, { force: true });
            throw error;
        });
    }
    return { id, name, mimeType: type.mime, size: bytes.length };
}

/**
 * The images a request names, checked: each id names a saved image, and there aren't too many.
 * Anything not a list is no images.
 */
export async function requestImages(value: unknown): Promise<ChatImage[]> {
    if (value == null) return [];
    if (!Array.isArray(value)) throw new JarvisError("Images must be a list.");
    if (value.length > IMAGE_LIMITS.perMessage) throw new JarvisError(`A message can carry up to ${IMAGE_LIMITS.perMessage} images.`);
    const images: ChatImage[] = [];
    for (const item of value as Array<Record<string, unknown>>) {
        const id = typeof item?.id === "string" ? item.id : "";
        if (!IMAGE_ID.test(id)) throw new JarvisError("That image isn't one the app saved. Paste it again.");
        try {
            if (!(await stat(imagePath(id))).isFile()) throw new Error("not a file");
        } catch {
            throw new JarvisError("An image in the message is gone. Paste it again.", 410);
        }
        // Sent now: it stays as long as one pasted today.
        const now = new Date();
        await utimes(imagePath(id), now, now).catch(() => undefined);
        images.push({ id, name: cleanImageName(item.name, id) });
    }
    return images;
}

/** How a message's images go to the session: as files, which the runtime reads and resizes. */
export function imageAttachments(images: readonly ChatImage[]): NonNullable<MessageOptions["attachments"]> {
    return images.map((image) => ({ type: "file" as const, path: imagePath(image.id), displayName: image.name }));
}

/** Send a saved image. Its name is a hash of its bytes, so it never changes and caches forever. */
export async function serveImage(res: ServerResponse, id: string): Promise<void> {
    const type = IMAGE_ID.test(id) ? TYPES[id.slice(id.lastIndexOf(".") + 1)] : undefined;
    const info = type ? await stat(imagePath(id)).catch(() => null) : null;
    if (!type || !info?.isFile()) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "That image is no longer kept." }));
        return;
    }
    res.writeHead(200, {
        "Content-Type": type.mime,
        "Content-Length": info.size,
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
    });
    // pipeline closes the file when the page cancels the download (an image removed mid-load).
    await pipeline(createReadStream(imagePath(id)), res).catch(() => undefined);
}

/** Remove images not pasted for `keepDays`, and half-written files. Returns how many went. */
export async function pruneImages(now = Date.now()): Promise<number> {
    let names: string[];
    try {
        names = await readdir(imagesDir());
    } catch {
        return 0;
    }
    let removed = 0;
    for (const name of names) {
        const kept = IMAGE_ID.test(name);
        if (!kept && !name.endsWith(".part")) continue;
        const path = join(imagesDir(), name);
        const info = await stat(path).catch(() => null);
        if (!info?.isFile()) continue;
        const age = now - info.mtimeMs;
        if (age < (kept ? IMAGE_LIMITS.keepDays * 86_400_000 : IMAGE_LIMITS.partialMs)) continue;
        await rm(path, { force: true }).then(
            () => removed++,
            () => undefined,
        );
    }
    return removed;
}
