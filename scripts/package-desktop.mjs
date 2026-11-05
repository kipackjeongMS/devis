// Package the built app into out/<name>-win32-x64 with @electron/packager.
// Run `npm run build` first (scripts/deploy-desktop.ps1 does both).
import { packager } from "@electron/packager";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

// The commit this build comes from, so the service can report it (Devis' updater checks a ship went live by it),
// and the source folder it was built from, the default for Settings' self-change source.
const git = (args) => {
    try {
        return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
        return "";
    }
};
await writeFile(
    new URL("../build-info.json", import.meta.url),
    JSON.stringify({
        commit: git(["rev-parse", "HEAD"]) || null,
        dirty: !!git(["status", "--porcelain", "--untracked-files=no"]),
        source: root.replace(/[\\/]+$/, ""),
        builtAt: new Date().toISOString(),
    }) + "\n",
);

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
    // The exe's own icon, which the taskbar and the Start menu shortcut show. Regenerate with scripts/build-icon.mjs.
    icon: fileURLToPath(new URL("../assets/icon.ico", import.meta.url)),
    win32metadata: {
        CompanyName: pkg.productName,
        ProductName: pkg.productName,
        FileDescription: pkg.description,
    },
});
console.log(appPath);
