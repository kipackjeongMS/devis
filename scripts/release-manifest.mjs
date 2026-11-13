// Write out/installer/latest.json for a release, next to the Setup that `npm run installer` built:
// the version, the Setup's file name, size and SHA-512, the commit and the channel. install.ps1 and
// Devis' updater only run a Setup that matches it.
//
//   node scripts/release-manifest.mjs --channel stable|preview
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const i = process.argv.indexOf("--channel");
const channel = i >= 0 ? process.argv[i + 1] : "stable";
if (channel !== "stable" && channel !== "preview") throw new Error("--channel is stable or preview.");

const file = `Devis-Setup-${pkg.version}.exe`;
const path = join(root, "out", "installer", file);
if (!existsSync(path)) throw new Error(`${path} isn't there. Run npm run installer first.`);

let commit = null;
try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
} catch {
    /* not a checkout */
}

const manifest = {
    version: pkg.version,
    channel,
    file,
    size: statSync(path).size,
    sha512: createHash("sha512").update(readFileSync(path)).digest("hex"),
    commit,
    publishedAt: new Date().toISOString(),
};
const out = join(root, "out", "installer", "latest.json");
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`${out}: ${manifest.file}, ${manifest.size} bytes, sha512 ${manifest.sha512.slice(0, 16)}…`);
