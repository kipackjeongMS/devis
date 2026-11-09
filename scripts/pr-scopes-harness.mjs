// Repo-scoped PR opt-in: a busy project can be narrowed to picked repos. Checks the stored
// config, where PRs are listed from, the kept list's scope key, and the Settings model.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

const root = mkdtempSync(join(tmpdir(), "pr-scopes-"));
const configPath = join(root, "config.json");
process.env.ADO_PR_OPS_CONFIG_PATH = configPath;
process.env.ADO_PR_OPS_DB_PATH = join(root, "data", "reviews.db");

const config = await import("../config.mjs");
const snap = await import("../pr-snapshot.mjs");

// The Settings model is a plain web module; load it the way the browser would, without the DOM.
const webSource = readFileSync(new URL("../web/src/prScopes.ts", import.meta.url), "utf8");
const webJs = ts.transpileModule(webSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const web = await import(`data:text/javascript,${encodeURIComponent(webJs)}`);

try {
    // ---- stored config ----
    const saved = await config.writeConfig({
        organizations: ["msazure"],
        projects: { msazure: ["One", "Azure AppConfig"] },
        repos: {
            msazure: {
                One: [" ServiceLinker-PortalExtension ", "servicelinker-portalextension", "", "a/b", 7, "Other"],
                "Azure AppConfig": [],
                Gone: ["X"],
            },
            stranger: { P: ["R"] },
        },
    });
    assert.deepEqual(saved.repos, { msazure: { One: ["ServiceLinker-PortalExtension", "7", "Other"] } }, "trimmed, deduped, only configured projects");

    // A save that leaves repos out keeps them; one that sends {} clears them.
    const kept = await config.writeConfig({ organizations: ["msazure"], projects: { msazure: ["One", "Azure AppConfig"] } });
    assert.deepEqual(kept.repos, saved.repos, "omitted repos are kept");
    const dropped = await config.writeConfig({ organizations: ["msazure"], projects: { msazure: ["Azure AppConfig"] } });
    assert.deepEqual(dropped.repos, {}, "a removed project takes its repos with it");
    await config.writeConfig({ organizations: ["msazure"], projects: { msazure: ["One"] }, repos: { msazure: { One: ["R"] } } });
    const cleared = await config.writeConfig({ organizations: ["msazure"], projects: { msazure: ["One"] }, repos: {} });
    assert.deepEqual(cleared.repos, {}, "an explicit empty repos clears them");

    // An older config without repos reads as none; a malformed one is dropped.
    writeFileSync(configPath, JSON.stringify({ organizations: ["msazure"], projects: { msazure: ["One"] } }));
    assert.deepEqual((await config.readConfig()).repos, {});
    writeFileSync(configPath, JSON.stringify({ organizations: ["msazure"], projects: { msazure: ["One"] }, repos: { msazure: ["One"] } }));
    assert.deepEqual((await config.readConfig()).repos, {});

    // ---- where PRs are listed from ----
    const cfg = { projects: { msazure: ["One", "Azure AppConfig"] }, repos: { msazure: { One: ["A", "B"] } } };
    assert.deepEqual(config.prScopes(cfg, "msazure"), [
        { project: "One", repo: "A" },
        { project: "One", repo: "B" },
        { project: "Azure AppConfig" },
    ]);
    assert.deepEqual(config.prScopes({ projects: { msazure: ["One"] } }, "msazure"), [{ project: "One" }], "no repos: whole project");
    assert.deepEqual(config.prScopes(cfg, "other"), [], "no projects: reviewer-only search");

    // ---- the kept list's scope ----
    const base = { organizations: ["msazure"], projects: { msazure: ["One"] } };
    assert.equal(snap.prScopeKey({ ...base, repos: {} }), snap.prScopeKey(base), "no repos: the key a kept list was saved with");
    assert.equal(snap.prScopeKey(base), JSON.stringify([["msazure", ["One"]]]), "the key is unchanged from before repos");
    const narrowed = snap.prScopeKey({ ...base, repos: { msazure: { One: ["B", "a"] } } });
    assert.notEqual(narrowed, snap.prScopeKey(base), "picking repos changes the scope");
    assert.equal(narrowed, snap.prScopeKey({ ...base, repos: { msazure: { One: ["A", "b"] } } }), "repo order and case don't");
    assert.notEqual(narrowed, snap.prScopeKey({ ...base, repos: { msazure: { One: ["A"] } } }), "another repo list does");

    // ---- the Settings model ----
    const projects = [];
    const repos = {};
    assert.equal(web.addScope(projects, repos, "  "), false, "blank");
    assert.equal(web.addScope(projects, repos, "One/"), false, "no repo after the slash");
    assert.equal(web.addScope(projects, repos, "/Repo"), false, "no project before the slash");
    assert.equal(web.addScope(projects, repos, "One/a/b"), false, "a repo never holds a slash");
    assert.deepEqual([projects, repos], [[], {}], "nothing added by bad input");

    assert.equal(web.addScope(projects, repos, "One"), true);
    assert.equal(web.addScope(projects, repos, "one"), false, "already the whole project");
    assert.equal(web.addScope(projects, repos, " one / ServiceLinker-PortalExtension "), true, "narrows the whole project");
    assert.deepEqual([projects, repos], [["One"], { One: ["ServiceLinker-PortalExtension"] }], "keeps the project's casing");
    assert.equal(web.addScope(projects, repos, "One/servicelinker-portalextension"), false, "same repo");
    assert.equal(web.addScope(projects, repos, "One/Other"), true);
    assert.equal(web.addScope(projects, repos, "Azure AppConfig"), true);
    assert.deepEqual(web.scopeChips(projects, repos), [
        { project: "One", repo: "ServiceLinker-PortalExtension" },
        { project: "One", repo: "Other" },
        { project: "Azure AppConfig" },
    ]);

    web.removeScope(projects, repos, { project: "One", repo: "Other" });
    assert.deepEqual([projects, repos], [["One", "Azure AppConfig"], { One: ["ServiceLinker-PortalExtension"] }]);
    web.removeScope(projects, repos, { project: "One", repo: "ServiceLinker-PortalExtension" });
    assert.deepEqual([projects, repos], [["Azure AppConfig"], {}], "the last repo takes the project, never widening it");

    assert.equal(web.addScope(projects, repos, "New/R"), true, "a repo in a new project adds the project");
    assert.equal(web.addScope(projects, repos, "New"), true, "the whole project again");
    assert.deepEqual([projects, repos], [["Azure AppConfig", "New"], {}]);
    web.removeScope(projects, repos, { project: "New" });
    assert.deepEqual(projects, ["Azure AppConfig"]);

    console.log("pr-scopes harness: ok");
} finally {
    rmSync(root, { recursive: true, force: true });
}
