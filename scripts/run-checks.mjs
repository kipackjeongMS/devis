// Run every scripts/*-harness.mjs the way Devis' self-change checks do: a harness that fails here
// only counts when it passes at --baseline (that commit, built in a detached worktree), so one
// that was already failing doesn't block. GitHub Actions runs this on pull requests and before a
// release; run it yourself with `npm run checks` after `npm run build`.
//
//   node scripts/run-checks.mjs [--baseline <git ref>]
//
// An empty or all-zero ref (a branch's first push) means HEAD~1. Exit 0 when nothing new fails.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const HARNESS_MS = 5 * 60_000;
const BUILD_MS = 10 * 60_000;

const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] ?? "" : null;
};
let baselineRef = arg("--baseline");
if (baselineRef !== null && (!baselineRef.trim() || /^0+$/.test(baselineRef.trim()))) baselineRef = "HEAD~1";

// Harnesses must not see a running Devis' data or Electron mode.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ADO_PR_OPS_|DEVIS_|ELECTRON_)/i.test(key)));

const tail = (text, max = 2000) => {
    const t = String(text || "").replace(/\r\n/g, "\n").trim();
    return t.length > max ? "…" + t.slice(t.length - max + 1) : t;
};

const harnesses = (dir) => {
    try {
        return readdirSync(join(dir, "scripts")).filter((n) => /-harness\.mjs$/.test(n)).sort();
    } catch {
        return [];
    }
};

function run(dir, name) {
    const started = Date.now();
    const r = spawnSync(process.execPath, [join("scripts", name)], { cwd: dir, env, encoding: "utf8", timeout: HARNESS_MS, maxBuffer: 32 * 1024 * 1024 });
    const ok = r.status === 0;
    const why = r.error?.code === "ETIMEDOUT" ? "Took longer than 5 minutes." : tail(`${r.stdout || ""}\n${r.stderr || ""}`);
    return { ok, ms: Date.now() - started, output: ok ? "" : why };
}

const git = (args, cwd = root) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** The baseline, built in a detached worktree with this checkout's node_modules; null when it can't be. */
function baseline(ref) {
    let sha;
    try {
        sha = git(["rev-parse", "--verify", `${ref}^{commit}`]);
    } catch {
        console.log(`The baseline ${ref} isn't in this checkout, so every failure counts.`);
        return null;
    }
    const dir = mkdtempSync(join(tmpdir(), "devis-baseline-"));
    rmSync(dir, { recursive: true, force: true });
    try {
        git(["worktree", "add", "--detach", dir, sha]);
        symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "junction");
        for (const config of ["tsconfig.backend.json", "tsconfig.web.json"]) {
            execFileSync(process.execPath, [join("node_modules", "typescript", "bin", "tsc"), "-p", config], { cwd: dir, env, stdio: "pipe", timeout: BUILD_MS });
        }
        return { dir, sha };
    } catch (error) {
        console.log(`The baseline ${sha.slice(0, 8)} didn't build, so every failure counts: ${tail(error.stderr || error.message, 400)}`);
        cleanup(dir);
        return null;
    }
}

function cleanup(dir) {
    const link = join(dir, "node_modules");
    try {
        unlinkSync(link);
    } catch {
        try {
            rmdirSync(link);
        } catch {
            /* not there */
        }
    }
    try {
        git(["worktree", "remove", "--force", dir]);
    } catch {
        rmSync(dir, { recursive: true, force: true });
        try {
            git(["worktree", "prune"]);
        } catch {
            /* nothing to prune */
        }
    }
}

const names = harnesses(root);
const failing = [];
for (const name of names) {
    const r = run(root, name);
    console.log(`${r.ok ? "ok  " : "FAIL"} ${name} (${Math.round(r.ms / 1000)} s)`);
    if (!r.ok) failing.push({ name, output: r.output });
}

const preexisting = [];
if (failing.length && baselineRef !== null) {
    const base = baseline(baselineRef);
    if (base) {
        try {
            for (const f of failing) {
                if (!existsSync(join(base.dir, "scripts", f.name))) continue;
                const r = run(base.dir, f.name);
                if (!r.ok) preexisting.push(f.name);
            }
        } finally {
            cleanup(base.dir);
        }
    }
}

const failures = failing.filter((f) => !preexisting.includes(f.name));
for (const f of failures) console.log(`\n---- ${f.name} ----\n${f.output}`);
const summary = [
    `${names.length - failing.length} of ${names.length} harnesses passed.`,
    preexisting.length ? `Failing at the baseline too, so they don't block: ${preexisting.join(", ")}.` : "",
    failures.length ? `New failures: ${failures.map((f) => f.name).join(", ")}.` : "Nothing new fails.",
]
    .filter(Boolean)
    .join("\n");
console.log(`\n${summary}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Harnesses\n\n${summary.replace(/\n/g, "\n\n")}\n`);
process.exit(failures.length ? 1 : 0);
