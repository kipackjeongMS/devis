// Package the built app into out/<name>-win32-x64 with @electron/packager.
// Run `npm run build` first (scripts/deploy-desktop.ps1 does both).
import { packager } from "@electron/packager";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    /^\/build($|\/)/,
    /^\/data($|\/)/,
    /^\/config\.json$/,
    /^\/tsconfig[^/]*\.json$/,
    /^\/\.(git|github|impeccable|playwright-mcp|vscode)($|\/)/,
    /^\/\.gitignore$/,
    /^\/diff_[^/]*$/,
    /^\/[^/]*\.md$/,
    /\.log$/,
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

// Git ships inside Devis, for machines that don't have it: MinGit (Git for Windows' minimal build) in
// resources\git. The service puts it on PATH only when the machine has no Git, or one older than 2.40.
// Pinned and checked against its SHA-256; the download is cached across builds.
const MINGIT = {
    version: "2.56.1",
    url: "https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/MinGit-2.56.1-64-bit.zip",
    sha256: "4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd",
    source: "https://github.com/git-for-windows/git/releases/tag/v2.56.1.windows.1",
};

async function minGitZip() {
    const cache = join(process.env.LOCALAPPDATA || tmpdir(), "devis-build-cache");
    const zip = join(cache, `MinGit-${MINGIT.version}-64-bit.zip`);
    const hash = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
    if (existsSync(zip) && (await hash(zip)) === MINGIT.sha256) return zip;
    await mkdir(cache, { recursive: true });
    const res = await fetch(MINGIT.url);
    if (!res.ok) throw new Error(`MinGit download failed: ${res.status} ${res.statusText}`);
    const partial = `${zip}.download`;
    await writeFile(partial, Buffer.from(await res.arrayBuffer()));
    const got = await hash(partial);
    if (got !== MINGIT.sha256) {
        await rm(partial, { force: true });
        throw new Error(`MinGit download doesn't match its pinned SHA-256 (got ${got})`);
    }
    await rename(partial, zip);
    return zip;
}

const gitDir = join(appPath, "resources", "git");
await rm(gitDir, { recursive: true, force: true });
await mkdir(gitDir, { recursive: true });
// Windows' own tar reads zip files; a Git Bash tar earlier on PATH doesn't.
execFileSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), ["-xf", await minGitZip(), "-C", gitDir], { stdio: "ignore" });
await writeFile(
    join(gitDir, "DEVIS-NOTICE.txt"),
    `This folder is MinGit ${MINGIT.version} from Git for Windows, shipped unmodified with Devis.\r\n` +
        `Git is licensed under the GNU General Public License version 2; see LICENSE.txt and the licenses folder here.\r\n` +
        `Source code: ${MINGIT.source}\r\n`,
);
console.log(appPath);
