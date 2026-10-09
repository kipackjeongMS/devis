// Package the built app into out/<name>-win32-x64 with @electron/packager.
// Run `npm run build` first (scripts/deploy-desktop.ps1 does both).
import { packager } from "@electron/packager";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

const ignore = [
    /^\/src($|\/)/,
    /^\/web\/src($|\/)/,
    /^\/web\/design-system\.html$/,
    /^\/scripts($|\/)/,
    /^\/out($|\/)/,
    /^\/data($|\/)/,
    /^\/config\.json$/,
    /^\/tsconfig[^/]*\.json$/,
    /^\/\.(git|github|impeccable|playwright-mcp|vscode)($|\/)/,
    /^\/\.gitignore$/,
    /^\/diff_[^/]*$/,
    /^\/[^/]*\.md$/,
    /\.log$/,
    // The app drives the user's installed Copilot CLI, not the SDK's bundled runtime.
    /^\/node_modules\/@github\/copilot-sdk-[^/]+($|\/)/,
];

const [appPath] = await packager({
    dir: root,
    out: fileURLToPath(new URL("../out", import.meta.url)),
    name: pkg.productName,
    executableName: pkg.name,
    appVersion: pkg.version,
    platform: "win32",
    arch: "x64",
    asar: false,
    prune: true,
    overwrite: true,
    // Stage in place: renaming a temp staging dir into out/ fails with EPERM while
    // Defender is still scanning the fresh executable.
    tmpdir: false,
    quiet: true,
    ignore,
    win32metadata: {
        CompanyName: pkg.productName,
        ProductName: pkg.productName,
        FileDescription: pkg.description,
    },
});
console.log(appPath);
