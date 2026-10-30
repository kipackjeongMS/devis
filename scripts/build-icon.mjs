// Render assets/icon.svg into the app icon files: assets/icon.png (512 px, the window
// icon) and assets/icon.ico (16–256 px, the exe and Start menu icon).
// Run after editing the SVG: npx electron scripts/build-icon.mjs
import { app, BrowserWindow } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const assets = (name) => fileURLToPath(new URL(`../assets/${name}`, import.meta.url));
const source = readFileSync(assets("icon.svg"), "utf8");
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

/** The script line is drawn for 256 px; small sizes get a heavier line and a tighter glow so the D still reads. */
function tuned(size) {
    const [stroke, glow] = size <= 24 ? [22, 2] : size <= 32 ? [19, 2.5] : size <= 48 ? [16, 3.5] : size <= 64 ? [14, 4] : [12, 5];
    return source.replace('stroke-width="12"', `stroke-width="${stroke}"`).replace('stdDeviation="5"', `stdDeviation="${glow}"`);
}

async function render(window, svg, size) {
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    const dataUrl = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = ${size};
            const ctx = canvas.getContext("2d");
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(img, 0, 0, ${size}, ${size});
            resolve(canvas.toDataURL("image/png"));
        };
        img.onerror = () => reject(new Error("icon.svg failed to load"));
        img.src = ${JSON.stringify(url)};
    })`);
    return Buffer.from(dataUrl.split(",")[1], "base64");
}

/** An ICO holding PNG entries, which Windows reads at every size since Vista. */
function ico(images) {
    const header = Buffer.alloc(6 + 16 * images.length);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);
    let offset = header.length;
    images.forEach(({ size, png }, i) => {
        const entry = 6 + 16 * i;
        header.writeUInt8(size >= 256 ? 0 : size, entry);
        header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
        header.writeUInt16LE(1, entry + 4);
        header.writeUInt16LE(32, entry + 6);
        header.writeUInt32LE(png.length, entry + 8);
        header.writeUInt32LE(offset, entry + 12);
        offset += png.length;
    });
    return Buffer.concat([header, ...images.map((image) => image.png)]);
}

app.whenReady().then(async () => {
    try {
        const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
        await window.loadURL("about:blank");
        const images = [];
        for (const size of ICO_SIZES) images.push({ size, png: await render(window, tuned(size), size) });
        writeFileSync(assets("icon.ico"), ico(images));
        writeFileSync(assets("icon.png"), await render(window, source, 512));
        console.log(`assets/icon.ico (${ICO_SIZES.join(", ")} px), assets/icon.png (512 px)`);
        app.exit(0);
    } catch (error) {
        console.error(error);
        app.exit(1);
    }
});
