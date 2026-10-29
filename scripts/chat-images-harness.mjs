// Images pasted into the chats: how the service saves, checks, serves and prunes them; how a
// session's history gives them back; and the web side's pure parts (the tray, the bubbles,
// the pending message).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, request } from "node:http";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "chat-images-"));
process.env.ADO_PR_OPS_DB_PATH = join(root, "data", "reviews.db");
process.env.ADO_PR_OPS_JARVIS_DIR = join(root, "jarvis");

const img = await import("../chat-images.mjs");
const tx = await import("../chat-transcript.mjs");
const { MessageQueue, steer } = await import("../chat-queue.mjs");
const web = await import("../web/chatImages.js");
const pane = await import("../web/chatPane.js");
const model = await import("../web/taskChatModel.js");

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const bytes = (head, seed = 0, size = 64) => {
    const b = Buffer.alloc(size, seed);
    Buffer.from(head).copy(b);
    return b;
};
const b64 = (b) => b.toString("base64");

/** A server that serves saved images like the API does; `served` settles when a response is done. */
async function imageServer() {
    let served = [];
    const server = createServer((req, res) => {
        served.push(img.serveImage(res, decodeURIComponent(req.url.slice(1))));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const get = (id) =>
        new Promise((resolve, reject) => {
            request({ host: "127.0.0.1", port, path: "/" + encodeURIComponent(id) }, (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
            })
                .on("error", reject)
                .end();
        });
    /** Start a download and drop it after the first chunk, as a page does when an image is removed mid-load. */
    const abort = (id) =>
        new Promise((resolve) => {
            const req = request({ host: "127.0.0.1", port, path: "/" + encodeURIComponent(id) }, (res) => {
                res.once("data", () => {
                    req.destroy();
                    resolve();
                });
            });
            req.on("error", () => undefined);
            req.end();
        });
    return { get, abort, served: () => served, close: () => new Promise((r) => server.close(r)) };
}

try {
    // ---- saving ----
    const a = await img.saveImage({ data: b64(bytes(PNG, 1)), name: "shot.png" });
    assert.match(a.id, /^[a-f0-9]{32}\.png$/, "named by a hash of its bytes, typed by its bytes");
    assert.deepEqual([a.name, a.mimeType, a.size], ["shot.png", "image/png", 64]);
    assert.ok(statSync(img.imagePath(a.id)).isFile());
    const again = await img.saveImage({ data: `data:image/png;base64,${b64(bytes(PNG, 1))}`, name: "again.png" });
    assert.equal(again.id, a.id, "the same image pasted twice is one file (a data URL works too)");
    const jpg = await img.saveImage({ data: b64(bytes([0xff, 0xd8, 0xff, 0xe0], 2)) });
    assert.deepEqual([jpg.id.endsWith(".jpg"), jpg.mimeType, jpg.name], [true, "image/jpeg", "image.jpg"], "no name: one from its type");
    const gif = await img.saveImage({ data: b64(bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 3)) });
    assert.ok(gif.id.endsWith(".gif"));
    const webp = bytes([0x52, 0x49, 0x46, 0x46], 4);
    Buffer.from("WEBP").copy(webp, 8);
    assert.ok((await img.saveImage({ data: b64(webp) })).id.endsWith(".webp"));
    // The bytes decide: a PNG called .jpg is a PNG, and text is refused whatever it claims.
    assert.ok((await img.saveImage({ data: b64(bytes(PNG, 5)), name: "fake.jpg" })).id.endsWith(".png"));
    await assert.rejects(img.saveImage({ data: b64(Buffer.from("hello, not an image")) }), /Only PNG, JPEG, GIF and WebP/);
    await assert.rejects(img.saveImage({ data: "" }), /No image came/);
    await assert.rejects(img.saveImage({ data: "!!not base64!!" }), /isn't valid base64/);
    await assert.rejects(img.saveImage(null), /No image came/);
    const big = bytes(PNG, 6, img.IMAGE_LIMITS.maxBytes + 1);
    await assert.rejects(img.saveImage({ data: b64(big) }), (e) => e.status === 413 && /up to 7 MB/.test(e.message));
    // Names: no folders, no control or reserved characters, not too long.
    assert.equal(img.cleanImageName("C:\\Users\\me\\Desktop\\bug.png", "x"), "bug.png");
    assert.equal(img.cleanImageName("../../etc/passwd", "x"), "passwd");
    assert.equal(img.cleanImageName("a\u0000b<c>:d.png", "x"), "abcd.png");
    assert.equal(img.cleanImageName("   ", "fallback.png"), "fallback.png");
    assert.equal(img.cleanImageName("n".repeat(200), "x").length, 80);

    // ---- what a message may name ----
    assert.deepEqual(await img.requestImages(undefined), []);
    assert.deepEqual(await img.requestImages(null), []);
    assert.deepEqual(await img.requestImages([{ id: a.id, name: "C:\\x\\shot.png" }]), [{ id: a.id, name: "shot.png" }]);
    await assert.rejects(img.requestImages("x"), /must be a list/);
    await assert.rejects(img.requestImages([{ id: "..\\..\\reviews.db" }]), /isn't one the app saved/, "no paths, only saved ids");
    await assert.rejects(img.requestImages([{ id: "a".repeat(32) + ".exe" }]), /isn't one the app saved/);
    await assert.rejects(img.requestImages([{ id: "b".repeat(32) + ".png" }]), (e) => e.status === 410, "a pruned image is gone");
    await assert.rejects(img.requestImages(Array.from({ length: 7 }, () => ({ id: a.id }))), /up to 6 images/);
    assert.deepEqual(img.imageAttachments([{ id: a.id, name: "shot.png" }]), [{ type: "file", path: img.imagePath(a.id), displayName: "shot.png" }]);
    // Sending an image again keeps it from being pruned.
    const old = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(img.imagePath(a.id), old, old);
    await img.requestImages([{ id: a.id, name: "shot.png" }]);
    assert.ok(Date.now() - statSync(img.imagePath(a.id)).mtimeMs < 60_000);

    // ---- serving ----
    const web1 = await imageServer();
    let res = await web1.get(a.id);
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "image/png");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.match(res.headers["cache-control"], /immutable/);
    assert.deepEqual([...res.body], [...bytes(PNG, 1)]);
    for (const id of ["c".repeat(32) + ".png", "../reviews.db", "..\\reviews.db", ""]) {
        res = await web1.get(id);
        assert.equal(res.status, 404, `nothing served for ${JSON.stringify(id)}`);
    }
    // A download the page drops halfway still finishes on the service's side (its file is closed).
    const large = await img.saveImage({ data: b64(bytes(PNG, 11, 6 * 1024 * 1024)) });
    const before = web1.served().length;
    await web1.abort(large.id);
    const settled = await Promise.race([web1.served()[before].then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
    assert.equal(settled, true, "an aborted download doesn't leave its file open");
    await web1.close();

    // ---- pruning ----
    const stale = await img.saveImage({ data: b64(bytes(PNG, 9)) });
    utimesSync(img.imagePath(stale.id), old, old);
    const partial = join(img.imagesDir(), `${a.id}.123.456.part`);
    writeFileSync(partial, "half");
    utimesSync(partial, old, old);
    const stranger = join(img.imagesDir(), "notes.txt");
    writeFileSync(stranger, "keep");
    utimesSync(stranger, old, old);
    assert.equal(await img.pruneImages(), 2);
    assert.deepEqual([existsSync(img.imagePath(stale.id)), existsSync(partial), existsSync(stranger), existsSync(img.imagePath(a.id))], [false, false, true, true]);

    // ---- the session's history gives the images back ----
    const path = img.imagePath(a.id);
    const events = [
        { id: "u1", type: "user.message", data: { content: "what's this?", attachments: [{ type: "file", path, displayName: "shot.png", assetId: "sha256:x" }] } },
        { id: "a1", type: "assistant.message", data: { messageId: "a1", content: "A screenshot." } },
        { id: "u2", type: "user.message", data: { content: tx.imageOnlyPrompt(1), attachments: [{ type: "file", path: path.replace(/\\/g, "/"), displayName: "" }] } },
        { id: "u3", type: "user.message", data: { content: "see file", attachments: [{ type: "file", path: "C:\\repo\\src\\a.ts" }, { type: "blob", mimeType: "image/png" }] } },
        { id: "u4", type: "user.message", data: { content: tx.imageOnlyPrompt(1) } },
    ];
    const messages = tx.chatMessagesFromEvents(events);
    assert.deepEqual(
        messages.map((m) => [m.id, m.content, m.images?.map((i) => [i.id, i.name])]),
        [
            ["u1", "what's this?", [[a.id, "shot.png"]]],
            ["a1", "A screenshot.", undefined],
            ["u2", "", [[a.id, a.id]]],
            ["u3", "see file", undefined],
            ["u4", tx.imageOnlyPrompt(1), undefined],
        ],
        "only the app's images come back; an image-only message keeps its images, not the placeholder"
    );
    assert.equal(tx.promptFor("  hi ", []), "hi");
    assert.equal(tx.promptFor("", [{ id: "x", name: "x" }]), tx.imageOnlyPrompt(1));
    assert.equal(tx.promptFor(" ", [{ id: "x", name: "x" }, { id: "y", name: "y" }]), tx.imageOnlyPrompt(2));
    assert.equal(tx.promptFor("words win", [{ id: "x", name: "x" }]), "words win");
    assert.ok(tx.sameImages([{ id: "1" }], [{ id: "1", name: "other" }]) && !tx.sameImages([{ id: "1" }], [{ id: "2" }]) && tx.sameImages(undefined, []));

    // ---- queued and steered messages carry their images ----
    const q = new MessageQueue();
    const item = q.add("", [{ id: a.id, name: "shot.png" }]);
    q.add("plain");
    const view = q.view();
    assert.deepEqual(view.queue.map((m) => [m.text, m.images]), [["", [{ id: a.id, name: "shot.png" }]], ["plain", undefined]]);
    view.queue[0].images[0].name = "changed";
    assert.equal(q.find(item.id).images[0].name, "shot.png", "the view is a copy");
    const sends = [];
    await steer({ send: async (o) => sends.push(o) }, "p", [{ type: "file", path, displayName: "shot.png" }]);
    await steer({ send: async (o) => sends.push(o) }, "q", []);
    assert.deepEqual(sends, [
        { prompt: "p", mode: "immediate", attachments: [{ type: "file", path, displayName: "shot.png" }] },
        { prompt: "q", mode: "immediate" },
    ]);

    // ---- web: what can go, and what a paste carries ----
    assert.equal(web.imageProblem({ type: "image/png", size: 10 }, 0), null);
    assert.match(web.imageProblem({ type: "image/svg+xml", size: 10 }, 0), /Only PNG/);
    assert.match(web.imageProblem({ type: "image/png", size: web.IMAGE_MAX_BYTES + 1 }, 0), /up to 7 MB/);
    assert.match(web.imageProblem({ type: "image/png", size: 1 }, web.IMAGES_PER_MESSAGE), /up to 6 images/);
    const shotItem = { kind: "file", type: "image/png", getAsFile: () => ({ name: "image.png" }) };
    const textItem = { kind: "string", type: "text/plain", getAsFile: () => null };
    assert.equal(web.pastedImages([shotItem], "").length, 1, "a screenshot pastes as an image");
    assert.equal(web.pastedImages([textItem, shotItem], "A1\tB1").length, 0, "an Office copy with text pastes as text");
    assert.equal(web.pastedImages([{ kind: "file", type: "application/pdf", getAsFile: () => ({}) }], "").length, 0);

    // ---- web: bubbles, tray, hint ----
    const html = web.messageImagesHtml([{ id: a.id, name: 'x"><script>' }]);
    assert.match(html, new RegExp(`src="/api/jarvis/images/${a.id}"`));
    assert.ok(!html.includes("<script>"), "names are escaped");
    assert.equal(web.messageImagesHtml([]), "");
    const onlyImages = pane.messageHtml({ id: "u2", role: "user", content: "", images: [{ id: a.id, name: "shot.png" }] });
    assert.ok(onlyImages.includes("chat-imgs") && !onlyImages.includes("<p>"), "an image-only bubble has no empty paragraph");
    assert.match(onlyImages, /data-v="0\.1"/, "the images count pins the bubble");
    assert.match(pane.messageHtml({ id: "m", role: "user", content: "hi" }), /data-v="2"/, "no images: pinned by length as before");
    // Sending images alone still shows the bubble until the transcript has it.
    const tail = pane.chatLogParts({ items: [], sending: "", sendingImages: [{ id: a.id, name: "shot.png" }] }).tail;
    assert.ok(tail.includes("chat-msg user sending") && tail.includes(a.id));
    const base = { items: [], sending: "", sendingImages: [{ id: a.id, name: "s" }] };
    assert.notEqual(pane.chatLogSig(base), pane.chatLogSig({ ...base, sendingImages: [{ id: jpg.id, name: "s" }] }), "other images repaint");
    assert.notEqual(
        pane.chatLogSig({ items: [{ type: "message", message: { id: "u", role: "user", content: "" } }] }),
        pane.chatLogSig({ items: [{ type: "message", message: { id: "u", role: "user", content: "", images: [{ id: a.id, name: "s" }] } }] })
    );
    const queued = pane.queueHtml({ queued: [{ id: "q1", text: "", images: [{ id: a.id, name: "s" }] }], busy: true, canSteer: true });
    assert.ok(queued.includes("chat-imgs small") && !queued.includes("<p></p>"));
    assert.ok(pane.steeredHtml({ id: "s1", text: "look", images: [{ id: a.id, name: "s" }] }).includes("chat-imgs"));
    const tray = web.trayHtml([
        { key: "d1", name: "a.png", preview: "blob:1", state: "uploading" },
        { key: "d2", name: "b.png", preview: "blob:2", state: "ready", id: a.id },
        { key: "d3", name: "c.png", preview: "blob:3", state: "failed", error: "too big" },
    ]);
    assert.ok(tray.includes('data-att-remove="d1"') && tray.includes("spinner") && tray.includes("c.png: too big"));
    assert.match(tray, /data-key="att:d2" data-v="ready"/, "a state change repaints the item");
    assert.equal(web.trayNote([{ state: "uploading" }, { state: "failed" }]), "Uploading the image…");
    assert.match(web.trayNote([{ state: "failed" }]), /couldn't be saved/);
    assert.equal(web.trayNote([{ state: "ready" }]), null);

    // ---- web: the tray uploads each image and hands the ready ones to a message ----
    const urls = [];
    globalThis.URL.createObjectURL = () => `blob:${urls.length}`;
    globalThis.URL.revokeObjectURL = (u) => urls.push(u);
    let changed = 0;
    const gates = [];
    const draft = new web.ImageDraft(
        (file, name) =>
            new Promise((resolve, reject) => gates.push({ ok: () => resolve({ id: `${file.tag}.png`, name }), fail: (m) => reject(new Error(m)) })),
        () => changed++
    );
    const problems = draft.add([
        { name: "image.png", type: "image/png", size: 10, tag: "one" },
        { name: "doc.pdf", type: "application/pdf", size: 10, tag: "x" },
        { name: "two.jpg", type: "image/jpeg", size: 10, tag: "two" },
    ]);
    assert.deepEqual(problems, ["Only PNG, JPEG, GIF and WebP images can be sent."]);
    assert.deepEqual(draft.items.map((d) => [d.name, d.state]), [["pasted-image.png", "uploading"], ["two.jpg", "uploading"]], "a clipboard image gets a better name");
    assert.equal(draft.uploading, true);
    gates[0].ok();
    gates[1].fail("too big");
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(draft.items.map((d) => d.state), ["ready", "failed"]);
    assert.deepEqual(draft.ready, [{ id: "one.png", name: "pasted-image.png" }]);
    const taken = draft.take();
    assert.deepEqual([taken.length, draft.items.length], [1, 1], "the failed one stays to be removed");
    draft.restore(taken);
    assert.deepEqual(draft.items.map((d) => d.state), ["ready", "failed"], "a failed send gives the images back, in front");
    draft.remove(draft.items[1].key);
    assert.equal(draft.items.length, 1);
    draft.release(draft.take());
    assert.ok(changed >= 5);
    // The tray holds six at most, counting ones still uploading.
    const full = new web.ImageDraft(() => new Promise(() => {}), () => undefined);
    assert.deepEqual(full.add(Array.from({ length: 7 }, (_, i) => ({ name: `${i}.png`, type: "image/png", size: 1 }))), ["A message can carry up to 6 images."]);
    assert.equal(full.items.length, 6);
    // Two chats share one tray element in the task sheet: their images' keys never collide.
    const trayA = new web.ImageDraft(() => new Promise(() => {}), () => undefined);
    const trayB = new web.ImageDraft(() => new Promise(() => {}), () => undefined);
    trayA.add([{ name: "x.png", type: "image/png", size: 1 }]);
    trayB.add([{ name: "y.png", type: "image/png", size: 1 }]);
    assert.notEqual(trayA.items[0].key, trayB.items[0].key, "each image's key is unique across trays");

    // ---- web: a pending message is shown until the transcript has the same words and images ----
    const at = Date.parse("2026-10-26T10:00:00Z");
    const sent = { text: "", at, images: [{ id: a.id, name: "s" }] };
    const read = (images) => [{ id: "u", role: "user", content: "", timestamp: "2026-10-26T10:00:01Z", ...(images ? { images } : {}) }];
    assert.equal(model.pendingShown(read([{ id: a.id, name: "s" }]), sent), false, "the transcript has it");
    assert.equal(model.pendingShown(read(undefined), sent), true, "not without its images");
    assert.equal(model.pendingShown(read([{ id: jpg.id, name: "s" }]), sent), true, "not with other images");
    assert.equal(model.pendingShown([{ id: "u", role: "user", content: "hi", timestamp: "2026-10-26T10:00:01Z" }], { text: "hi", at }), false, "text-only as before");

    console.log("chat-images harness: ok");
} finally {
    rmSync(root, { recursive: true, force: true });
}
