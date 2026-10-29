import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "jarvis-prs-"));
process.env.ADO_PR_OPS_DB_PATH = join(root, "data", "reviews.db");
process.env.ADO_PR_OPS_JARVIS_DIR = join(root, "jarvis");

const store = await import("../jarvis-store.mjs");
const prs = await import("../jarvis-prs.mjs");
const today = await import("../jarvis-today.mjs");
const { closeDb } = await import("../store.mjs");

// ---- a fake ADO and git -------------------------------------------------------------
const ME = { id: "me-1", name: "Kipack" };
const OTHER = { id: "other-1", displayName: "Someone Else" };
const PROJECT = { name: "Azure AppConfig", id: "proj-guid" };
const REPO = { name: "Azconfig.GenevaActions", id: "repo-guid" };
const raws = new Map();
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
function addPr(id, over = {}) {
    const raw = {
        pullRequestId: id,
        title: `PR ${id} title`,
        status: "active",
        isDraft: false,
        createdBy: { id: ME.id, displayName: ME.name },
        creationDate: iso(0),
        closedDate: null,
        sourceRefName: "refs/heads/kjeong/feature",
        targetRefName: "refs/heads/dev",
        mergeStatus: "succeeded",
        reviewers: [],
        repository: { name: REPO.name, id: REPO.id, project: { ...PROJECT } },
        ...over,
    };
    raws.set(id, raw);
    return raw;
}
const calls = { getPr: 0, branchPrs: 0, checks: 0, unresolved: 0, workItem: 0 };
const workItems = new Map();
const folders = new Map();
let checksResult = { passed: 1, failed: 1, running: 0, total: 2, failing: ["Build"] };
const matches = (value, entity) => value === entity.name || value === entity.id;
prs.setPrsRuntime({
    now: () => Date.now(),
    me: async () => ME,
    getPr: async (org, project, repo, prId) => {
        calls.getPr++;
        assert.equal(org, "msazure", "the org is spelled as in Settings");
        const raw = raws.get(prId);
        if (!raw || !matches(project, raw.repository.project) || !matches(repo, raw.repository)) return null;
        return structuredClone(raw);
    },
    workItem: async (org, id) => {
        calls.workItem++;
        return workItems.get(id) ?? null;
    },
    branchPrs: async (org, project, repo, branch, creatorId) => {
        calls.branchPrs++;
        return [...raws.values()].filter((r) => r.sourceRefName === `refs/heads/${branch}` && r.createdBy.id === creatorId).map((r) => structuredClone(r));
    },
    checks: async () => {
        calls.checks++;
        return checksResult;
    },
    unresolved: async () => {
        calls.unresolved++;
        return 3;
    },
    git: async (cwd, args) => {
        const f = folders.get(cwd);
        if (!f) return null;
        if (args[0] === "rev-parse") return f.branch;
        if (args[0] === "remote") return f.remote;
        return null;
    },
    orgs: async () => ["msazure"],
});
const webUrl = (id) => `https://dev.azure.com/msazure/Azure%20AppConfig/_git/${REPO.name}/pullrequest/${id}`;
const eventsOf = async (taskId) => (await store.listEvents({ taskId, kinds: ["task.pr"] })).map((e) => e.text);

try {
    // ---- reading links ----
    assert.deepEqual(prs.parsePrRefs(`see ${webUrl(17553390)} and again ${webUrl(17553390)}?_a=files`), [
        { org: "msazure", project: "Azure AppConfig", repo: REPO.name, prId: 17553390 },
    ], "decoded, and each PR once");
    assert.deepEqual(
        prs.parsePrRefs(
            "https://MSAzure.visualstudio.com/DefaultCollection/One/_git/Repo/pullrequest/12 then " +
                '"url": "https://dev.azure.com/msazure/proj-guid/_apis/git/repositories/repo-guid/pullRequests/34"',
        ),
        [
            { org: "msazure", project: "One", repo: "Repo", prId: 12 },
            { org: "msazure", project: "proj-guid", repo: "repo-guid", prId: 34 },
        ],
        "old hosts and az's API links count",
    );
    assert.deepEqual(prs.parsePrRefs("https://github.com/o/r/pull/5 https://dev.azure.com/o/p/_git/r/pullrequests?_a=mine"), [], "GitHub and list pages don't");
    assert.deepEqual(prs.parseRemote("https://msazure@dev.azure.com/msazure/Azure%20AppConfig/_git/Azconfig.GenevaActions"), {
        org: "msazure",
        project: "Azure AppConfig",
        repo: "Azconfig.GenevaActions",
    });
    assert.deepEqual(prs.parseRemote("git@ssh.dev.azure.com:v3/MSAzure/One/Repo.git"), { org: "msazure", project: "One", repo: "Repo" });
    assert.deepEqual(prs.parseRemote("https://msazure.visualstudio.com/DefaultCollection/One/_git/Repo/"), { org: "msazure", project: "One", repo: "Repo" });
    assert.deepEqual(prs.parseRemote("msazure@vs-ssh.visualstudio.com:v3/msazure/One/Repo"), { org: "msazure", project: "One", repo: "Repo" });
    assert.equal(prs.parseRemote("https://github.com/o/r.git"), null);
    const odd = prs.snapshotOf("msazure", {
        pullRequestId: 9,
        status: "Active",
        mergeStatus: "Conflicts",
        closedDate: "0001-01-01T00:00:00",
        creationDate: "2026-10-16T03:10:12Z",
        repository: { name: "R", id: "r", project: { name: "Azure AppConfig", id: "p" } },
    });
    assert.deepEqual([odd.status, odd.mergeStatus, odd.closed, odd.url], ["active", "conflicts", null, "https://dev.azure.com/msazure/Azure%20AppConfig/_git/R/pullrequest/9"], "ADO's casing and empty dates are evened out");

    // ---- which tool calls create a PR ----
    const shell = (command) => ({ toolName: "powershell", arguments: { command } });
    assert.ok(prs.isPrCreateCall(shell('az repos pr create --title "Fix" --work-items 2841124')));
    assert.ok(!prs.isPrCreateCall(shell("az repos pr list --status active")));
    assert.ok(prs.isPrCreateCall(shell("az devops invoke --area git --resource pullrequests --http-method POST --in-file body.json")));
    assert.ok(prs.isPrCreateCall(shell("Invoke-RestMethod -Method Post -Uri https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests?api-version=7.1")));
    assert.ok(!prs.isPrCreateCall(shell("Invoke-RestMethod -Uri https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests?api-version=7.1")));
    assert.ok(prs.isPrCreateCall({ toolName: "ado-repo_pull_request_write", mcpToolName: "repo_pull_request_write", arguments: { action: "create" } }));
    assert.ok(!prs.isPrCreateCall({ toolName: "ado-repo_pull_request_write", arguments: { action: "vote" } }));
    assert.ok(prs.isPrCreateCall({ toolName: "repo_create_pull_request", arguments: {} }));
    assert.ok(!prs.isPrCreateCall({ toolName: "view", arguments: { path: "pullrequests.md" } }));
    assert.ok(!prs.isPrCreateCall({ toolName: "ado-repo_pull_request_thread_write", mcpToolName: "repo_pull_request_thread_write", arguments: { action: "create" } }), "a comment thread isn't a PR");
    assert.ok(!prs.isPrCreateCall({ toolName: "repo_update_pull_request_reviewers", arguments: { action: "create" } }));
    assert.ok(!prs.isPrCreateCall(shell("curl -X POST https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests/5/threads?api-version=7.1 -d @body.json")), "a POST under a PR isn't one either");
    assert.ok(prs.isPrCreateCall(shell("curl -X POST 'https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests' -d @body.json")));
    assert.deepEqual(prs.callRepo({ arguments: { orgName: "MSAzure", project: "Azure AppConfig", repositoryId: "repo-guid" } }), {
        org: "msazure",
        project: "Azure AppConfig",
        repo: "repo-guid",
    });
    assert.deepEqual(prs.refsFromCreateOutput('{"pullRequestId": 77, "title": "x"}', { org: "msazure", project: "P", repo: "R" }), [
        { org: "msazure", project: "P", repo: "R", prId: 77 },
    ]);
    assert.deepEqual(prs.refsFromCreateOutput('{"pullRequestId": 77}', {}), [], "no repo to read it in, no link");

    // ---- the user links any PR they can see ----
    const { task } = await store.createTask({ title: "Geneva Actions Infra SDP", org: "msazure", project: "Azure AppConfig" });
    addPr(100, { createdBy: OTHER, creationDate: iso(30 * 86_400_000), title: "Someone's older PR" });
    const linked = await prs.linkFromUser(task.id, `Please link ${webUrl(100)}`);
    assert.equal(linked.source, "user");
    assert.equal(linked.snapshot.title, "Someone's older PR");
    assert.equal(linked.snapshot.url, webUrl(100));
    assert.equal(linked.snapshot.projectId, "proj-guid");
    assert.deepEqual(await eventsOf(task.id), ["PR 100 linked to Geneva Actions Infra SDP: Someone's older PR"]);
    await assert.rejects(prs.linkFromUser(task.id, "100"), /Paste the pull request's link/);
    await assert.rejects(prs.linkFromUser(task.id, webUrl(999)), /wasn't found in msazure\/Azure AppConfig/);
    await assert.rejects(prs.linkFromUser("nope", webUrl(100)), /Task not found/);

    // ---- a worker links only PRs you opened since the task started ----
    const repoDir = join(root, "geneva");
    folders.set(repoDir, { branch: "kjeong/feature", remote: "https://msazure@dev.azure.com/msazure/Azure%20AppConfig/_git/Azconfig.GenevaActions" });
    await store.insertWorker({ sessionId: "11111111-1111-4111-8111-111111111111", taskId: task.id, label: "geneva", cwd: repoDir, model: null, state: "idle", summary: "" });
    const W = "11111111-1111-4111-8111-111111111111";
    addPr(201);
    addPr(202, { createdBy: OTHER });
    addPr(203, { creationDate: iso(2 * 86_400_000) });
    assert.equal(await prs.linkFromWorker(W, webUrl(201)), "Linked PR 201 to the task.");
    assert.equal(await prs.linkFromWorker(W, "!201"), "PR 201 is already linked to the task.", "a number works in the folder's repo");
    assert.match(await prs.linkFromWorker(W, webUrl(202)), /^PR 202 not linked: .*opened by Someone Else, not you/);
    assert.match(await prs.linkFromWorker(W, webUrl(203)), /^PR 203 not linked: .*opened before this task started/);
    assert.equal(await prs.linkFromWorker(W, "soon"), "Pass the pull request's link, or its number.");
    assert.equal(await prs.linkFromWorker("not-a-worker", "1"), "This session is not one of the Workspace's workers.");
    folders.set(join(root, "plain"), { branch: null, remote: null });
    await store.insertWorker({ sessionId: "22222222-2222-4222-8222-222222222222", taskId: task.id, label: "plain", cwd: join(root, "plain"), model: null, state: "idle", summary: "" });
    assert.match(await prs.linkFromWorker("22222222-2222-4222-8222-222222222222", "201"), /isn't an Azure DevOps git repository/);

    // ---- what a create call made is linked ----
    addPr(301);
    await prs.notePrCreated(W, `{"url": "https://dev.azure.com/msazure/proj-guid/_apis/git/repositories/repo-guid/pullRequests/301"}`, shell("az repos pr create"));
    addPr(302);
    await prs.notePrCreated(W, '{"pullRequestId": 302}', { toolName: "ado-repo_pull_request_write", arguments: { action: "create", orgName: "msazure", project: "Azure AppConfig", repositoryId: REPO.name } });
    addPr(303);
    await prs.notePrCreated(W, '{"pullRequestId": 303}', shell("az repos pr create"));
    addPr(304, { createdBy: OTHER });
    await prs.notePrCreated(W, webUrl(304), shell("az repos pr create"));
    let rows = await store.listTaskPrs(task.id);
    const sourceOf = (id) => rows.find((r) => r.prId === id)?.source;
    assert.equal(sourceOf(301), "created", "from az's own API link");
    assert.equal(sourceOf(302), "created", "an ADO tool's id, in the repo its arguments name");
    assert.equal(sourceOf(303), "created", "an id alone, in the worker folder's repo");
    assert.equal(sourceOf(304), undefined, "someone else's PR isn't linked");

    // ---- after a turn: the branch, and your PRs from it ----
    addPr(401, { sourceRefName: "refs/heads/kjeong/feature-2" });
    addPr(402, { sourceRefName: "refs/heads/kjeong/feature-2", createdBy: OTHER });
    addPr(403, { sourceRefName: "refs/heads/kjeong/feature-2", creationDate: iso(3 * 86_400_000) });
    folders.get(repoDir).branch = "kjeong/feature-2";
    await prs.noteWorkerTurn(W);
    rows = await store.listTaskPrs(task.id);
    assert.equal(sourceOf(401), "branch");
    assert.equal(sourceOf(402), undefined, "not yours");
    assert.equal(sourceOf(403), undefined, "opened before the task");
    assert.deepEqual((await store.listTaskBranches(task.id)).map((b) => [b.org, b.project, b.repo, b.branch]), [["msazure", "Azure AppConfig", REPO.name, "kjeong/feature-2"]]);
    folders.get(repoDir).branch = "dev";
    await prs.noteWorkerTurn(W);
    folders.get(repoDir).branch = "HEAD";
    await prs.noteWorkerTurn(W);
    assert.equal((await store.listTaskBranches(task.id)).length, 1, "shared and detached branches aren't the task's");
    assert.ok((await store.listTaskBranches(task.id)).every((b) => b.branch !== "kjeong/feature"), "201's branch was never seen after a turn");

    // ---- the strongest source wins; an unlinked PR stays unlinked until you link it ----
    await prs.linkFromUser(task.id, webUrl(401));
    rows = await store.listTaskPrs(task.id);
    assert.equal(sourceOf(401), "user");
    await prs.unlinkPr(task.id, "MSAzure", 303);
    assert.ok(!(await store.listTaskPrs(task.id)).some((r) => r.prId === 303));
    await prs.notePrCreated(W, '{"pullRequestId": 303}', shell("az repos pr create"));
    assert.ok(!(await store.listTaskPrs(task.id)).some((r) => r.prId === 303), "found again, still unlinked");
    await prs.linkFromUser(task.id, webUrl(303));
    assert.ok((await store.listTaskPrs(task.id)).some((r) => r.prId === 303), "you linking it brings it back");
    await assert.rejects(prs.unlinkPr(task.id, "msazure", 5555), /isn't linked/);
    assert.ok((await eventsOf(task.id)).includes("PR 303 unlinked from Geneva Actions Infra SDP."));

    // ---- a work item task: its PR links in ADO ----
    const wi = {
        id: 2841124,
        title: "Canary test scope",
        project: "Azure AppConfig",
        type: "Task",
        state: "Active",
        url: "https://dev.azure.com/msazure/Azure%20AppConfig/_workitems/edit/2841124",
        parent: null,
    };
    const { task: wiTask } = await store.createTask({ org: "msazure", workItem: wi });
    addPr(501, { createdBy: OTHER, creationDate: iso(90 * 86_400_000), title: "Teammate's PR on the work item" });
    workItems.set(2841124, { item: { ...wi, org: "msazure", parentId: null }, prs: [{ projectId: "proj-guid", repoId: "repo-guid", prId: 501 }, { projectId: "proj-guid", repoId: "repo-guid", prId: 9999 }] });
    await prs.syncTaskPrs(wiTask.id);
    let wiRows = await store.listTaskPrs(wiTask.id);
    assert.deepEqual(wiRows.map((r) => [r.prId, r.source]), [[501, "workitem"]], "anyone's, any age; a missing one is skipped");
    await assert.rejects(prs.unlinkPr(wiTask.id, "msazure", 501), /linked to the work item in Azure DevOps/);

    // ---- refreshing: state, checks and comments ----
    raws.get(501).status = "completed";
    raws.get(501).closedDate = iso(0);
    const before = { ...calls };
    const one = prs.syncTaskPrs(task.id, { detail: true });
    const two = prs.syncTaskPrs(task.id, { detail: true });
    assert.equal(one, two, "one pass per task at a time");
    await one;
    rows = await store.listTaskPrs(task.id);
    const pr201 = rows.find((r) => r.prId === 201);
    assert.deepEqual(pr201.checks, checksResult);
    assert.equal(pr201.unresolved, 3);
    assert.ok(calls.checks > before.checks);
    await prs.syncTaskPrs(wiTask.id, { detail: true });
    wiRows = await store.listTaskPrs(wiTask.id);
    assert.equal(wiRows[0].snapshot.status, "completed");
    assert.equal(wiRows[0].checks, null, "checks are read for open PRs only");
    raws.delete(201);
    await prs.syncTaskPrs(task.id);
    assert.equal((await store.listTaskPrs(task.id)).find((r) => r.prId === 201).error, "Not found in Azure DevOps anymore.");

    // ---- a sync also checks the branch each worker is on now (workers from before this feature) ----
    const { task: older } = await store.createTask({ title: "Started before PR tracking" });
    const olderDir = join(root, "older");
    folders.set(olderDir, { branch: "kjeong/backfill", remote: "https://dev.azure.com/msazure/Azure%20AppConfig/_git/Azconfig.GenevaActions" });
    await store.insertWorker({ sessionId: "33333333-3333-4333-8333-333333333333", taskId: older.id, label: "older", cwd: olderDir, model: null, state: "idle", summary: "" });
    addPr(701, { sourceRefName: "refs/heads/kjeong/backfill" });
    await prs.syncTaskPrs(older.id);
    assert.deepEqual((await store.listTaskPrs(older.id)).map((r) => [r.prId, r.source]), [[701, "branch"]]);
    await store.deleteTask(older.id);

    // ---- the view starts a pass when it's due ----
    prs.PRS_LIMITS.freshMs = 0;
    const view = await prs.taskPrsView(task.id);
    assert.equal(view.syncing, true);
    assert.ok(view.prs.length >= 5);
    await prs.prsIdle();
    const after = await prs.taskPrsView(task.id, {});
    assert.ok(after.syncedAt);
    await prs.prsIdle();
    prs.PRS_LIMITS.freshMs = 60_000;

    // ---- the background pass picks tasks that can have PRs ----
    const { task: bare } = await store.createTask({ title: "No PRs at all" });
    prs.resetPrs();
    const wiCalls = calls.workItem;
    await prs.prsTick();
    assert.ok(calls.workItem > wiCalls, "the work item task was read");
    const t1 = calls.getPr;
    await prs.prsTick();
    assert.equal(calls.getPr, t1, "and not again within the pass's interval");
    assert.ok(!(await store.listTaskPrs(bare.id)).length);

    // ---- Today carries each task's PRs ----
    const snap = await today.todaySnapshot();
    assert.deepEqual(snap.tasks.find((t) => t.id === wiTask.id).prs.map((p) => p.prId), [501]);
    assert.deepEqual(snap.tasks.find((t) => t.id === bare.id).prs, []);

    // ---- links removed in ADO come off the task, unless the app also found the PR another way ----
    const wi2 = { ...wi, id: 2841125, title: "Pin upstream artifacts" };
    const { task: wi2Task } = await store.createTask({ org: "msazure", workItem: wi2 });
    addPr(601, { createdBy: OTHER });
    addPr(602, { createdBy: OTHER });
    await prs.linkFromUser(wi2Task.id, webUrl(602));
    const links2 = (ids) => workItems.set(2841125, { item: { ...wi2, org: "msazure", parentId: null }, prs: ids.map((prId) => ({ projectId: "proj-guid", repoId: "repo-guid", prId })) });
    links2([601, 602]);
    await prs.syncTaskPrs(wi2Task.id);
    const wi2Rows = async () => (await store.listTaskPrs(wi2Task.id)).map((r) => [r.prId, r.source]);
    assert.deepEqual(await wi2Rows(), [[602, "workitem"], [601, "workitem"]], "ADO's link outranks yours while it lasts");
    await assert.rejects(prs.unlinkPr(wi2Task.id, "msazure", 602), /linked to the work item/);
    links2([]);
    await prs.syncTaskPrs(wi2Task.id);
    assert.deepEqual(await wi2Rows(), [[602, "user"]], "ADO dropped both: 601 goes, 602 is yours again");
    assert.ok((await eventsOf(wi2Task.id)).some((t) => /PR 601 is no longer linked to .*work item, so it was unlinked/.test(t)));
    await prs.unlinkPr(wi2Task.id, "msazure", 602);
    links2([601]);
    await prs.syncTaskPrs(wi2Task.id);
    assert.deepEqual(await wi2Rows(), [[601, "workitem"]], "ADO linking it again brings it back");
    await store.deleteTask(wi2Task.id);

    // ---- removing a task drops its links and records its PRs in task.json ----
    await store.deleteTask(wiTask.id);
    assert.deepEqual(await store.listTaskPrs(wiTask.id, { includeHidden: true }), []);
    const record = JSON.parse(readFileSync(join(store.taskDir(wiTask.id), "task.json"), "utf8"));
    assert.deepEqual(record.pullRequests.map((p) => [p.id, p.status]), [[501, "completed"]]);
    await store.deleteTask(task.id);
    assert.deepEqual(await store.listTaskBranches(task.id), []);
    assert.ok(existsSync(store.artifactsDir(task.id)));

    await prs.stopPrsRunner();
    console.log("jarvis-prs harness: ok");
} finally {
    prs.resetPrs();
    closeDb();
    rmSync(root, { recursive: true, force: true });
}
