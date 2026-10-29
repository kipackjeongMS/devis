import assert from "node:assert/strict";

const m = await import("../web/jarvisModel.js");

const NOW = Date.parse("2026-10-15T15:00:00");
const START = m.dayStart(NOW);
const iso = (offsetMin) => new Date(NOW + offsetMin * 60_000).toISOString();

const worker = (over = {}) => ({
    sessionId: "w" + Math.random(),
    taskId: "t",
    label: "appconfig",
    cwd: "C:\\src\\appconfig",
    model: null,
    state: "idle",
    summary: "",
    autoApprove: false,
    createdAt: iso(-60),
    updatedAt: iso(-30),
    busy: false,
    partial: "",
    activity: "",
    requests: [],
    ...over,
});
const task = (id, over = {}) => ({
    id,
    title: id,
    org: "msazure",
    project: "Azure AppConfig",
    workItem: null,
    status: "open",
    createdAt: iso(-120),
    updatedAt: iso(-120),
    doneAt: null,
    workers: [],
    ...over,
});
const request = (at) => ({ id: "r" + at, kind: "question", title: "?", detail: "", choices: [], allowFreeform: true, at: iso(at) });

// ---- worker state: live data wins ----
assert.equal(m.workerState(worker({ state: "turnDone", requests: [request(-1)] })), "needsInput");
assert.equal(m.workerState(worker({ state: "turnDone", busy: true })), "working");
assert.equal(m.workerState(worker({ state: "needsInput" })), "working", "an answered question returns to working");
assert.equal(m.workerState(worker({ state: "error" })), "error");

// ---- sections ----
const needsOld = task("needs-old", { workers: [worker({ requests: [request(-50)] })] });
const needsNew = task("needs-new", { workers: [worker({ requests: [request(-5)] })] });
const failed = task("failed", { workers: [worker({ state: "error" })] });
const running = task("running", { workers: [worker({ busy: true, state: "working" }), worker({ state: "turnDone" })] });
const fresh = task("fresh");
const finished = task("finished", { workers: [worker({ state: "turnDone", updatedAt: iso(-2) })] });
const doneToday = task("done-today", { status: "done", doneAt: iso(-10) });
const doneYesterday = task("done-yesterday", { status: "done", doneAt: new Date(START - 1000).toISOString() });

assert.equal(m.taskSection(needsOld, START), "needs");
assert.equal(m.taskSection(failed, START), "needs", "a failed worker needs the user");
assert.equal(m.taskSection(running, START), "running");
assert.equal(m.taskSection(fresh, START), "idle");
assert.equal(m.taskSection(finished, START), "idle", "a finished turn waits in Idle");
assert.equal(m.taskSection(doneToday, START), "done");
assert.equal(m.taskSection(doneYesterday, START), null, "done before today drops off Today");
assert.equal(
    m.taskSection({ ...doneYesterday, workers: [worker({ busy: true, requests: [request(-1)] })] }, START),
    "needs",
    "marking a task done never hides a worker's open approval",
);
assert.equal(m.taskSection({ ...doneYesterday, workers: [worker({ busy: true })] }, START), "running");
assert.equal(m.taskSection({ ...doneToday, workers: [worker({ state: "error" })] }, START), "done", "old failures on done tasks stay done");

// ---- where a card sits: needing the user never moves it ----
assert.equal(m.cardSection(needsOld, START), "running", "a worker waiting on you is mid-turn: its card stays under Running");
assert.equal(m.cardSection(failed, START), "idle", "a failed worker's task stays under Open tasks");
assert.equal(m.cardSection(running, START), "running");
assert.equal(m.cardSection(fresh, START), "idle");
assert.equal(m.cardSection(doneToday, START), "done");
assert.equal(m.cardSection(doneYesterday, START), null);
assert.equal(m.cardSection({ ...doneYesterday, workers: [worker({ busy: true, requests: [request(-1)] })] }, START), "running", "a done task still waiting on you stays on the board");
assert.equal(m.needsYou(failed, START), true);
assert.equal(m.needsYou(needsOld, START), true);
assert.equal(m.needsYou(running, START), false);

const groups = m.groupTasks([fresh, needsNew, running, doneToday, finished, needsOld, failed, doneYesterday], START);
assert.deepEqual(groups.needs.map((t) => t.id).slice(0, 2), ["needs-old", "needs-new"], "the longest wait leads");
assert.ok(groups.needs.includes(failed));
assert.deepEqual(groups.running.map((t) => t.id).sort(), ["needs-new", "needs-old", "running"], "waiting tasks stay on the board too");
assert.deepEqual(groups.idle.map((t) => t.id), ["finished", "failed", "fresh"], "tasks with results come before untouched ones");
assert.deepEqual(groups.done.map((t) => t.id), ["done-today"]);

// ---- Needs you: one compact item per ask ----
{
    const asker = worker({ sessionId: "s-ask", label: "api", requests: [request(-40), { ...request(-35), kind: "permission", title: "Run npm test" }] });
    const broken = worker({ sessionId: "s-bad", label: "ui", state: "error", summary: "boom", updatedAt: iso(-10) });
    const both = task("both", { workers: [asker, broken] });
    const proposed = task("proposed", {
        validation: { chainId: null, name: null, blocks: 0, run: null, proposal: { by: "api", at: iso(-60), blocks: 2 }, attention: "proposal" },
    });
    const failedRun = task("failed-run", {
        updatedAt: iso(-1),
        validation: { chainId: "c", name: "V", blocks: 2, run: { runId: "r", status: "failed", startedAt: iso(-30), finishedAt: iso(-5), done: 1, total: 2, current: null, failed: "Deploy" }, proposal: null, attention: "failed" },
    });
    const doneBroken = task("done-broken", { status: "done", doneAt: iso(-3), workers: [worker({ state: "error" })] });
    const items = m.needsItems([doneBroken, failedRun, both, proposed, fresh]);
    assert.deepEqual(items.map((n) => [n.kind, n.key, n.task.id]), [
        ["validation", "val:proposed", "proposed"],
        ["request", "req:s-ask", "both"],
        ["failed", "fail:s-bad", "both"],
        ["validation", "val:failed-run", "failed-run"],
    ], "every ask, the longest wait first; a done task's old failure isn't one");
    assert.equal(items[0].who, "api", "a proposal names who proposed it");
    assert.equal(items[3].who, "Validation");
    assert.equal(items[3].at, Date.parse(iso(-5)), "a failed run waits from when it failed");
    assert.equal(m.needLine(items[1]), "api: ? (+1 more)");
    assert.equal(m.needLine(items[2]), "ui failed");
    assert.equal(m.needLine(items[0]), "api proposed a validation chain of 2 pipelines");
    const repos = m.needsItems([task("r", { workers: [worker({ label: "w1", requests: [{ ...request(-1), kind: "repos", title: "Pick" }] })] })]);
    assert.equal(m.needLine(repos[0]), "w1: confirm its repositories");
    assert.deepEqual(m.needsItems([fresh, running, doneToday]), []);
    const doneAsking = task("done-asking", { status: "done", doneAt: iso(-3), workers: [worker({ sessionId: "s-q", requests: [request(-2)] }), worker({ sessionId: "s-old", state: "error" })] });
    assert.deepEqual(m.needsItems([doneAsking]).map((n) => n.key), ["req:s-q"], "a done task's open question is listed; its old failure isn't");
    // A marked card always has an ask to jump to, and every ask's card is marked.
    for (const t of [needsOld, needsNew, failed, running, fresh, finished, doneToday, doneYesterday, both, proposed, failedRun, doneBroken, doneAsking]) {
        assert.equal(m.needsItems([t]).length > 0, m.needsYou(t, START), `asks and the card's mark agree: ${t.id}`);
    }

    // ---- an ask taken on as a to-do ----
    assert.deepEqual(items.map((n) => n.source), [
        `need:val:proposed:proposal:${iso(-60)}`,
        "need:req:s-ask:r-40",
        `need:fail:s-bad:${iso(-10)}`,
        "need:val:failed-run:failed:r",
    ], "each names its exact ask: a worker's oldest request, its failure, the proposal or the failed run");
    assert.deepEqual(items.map((n) => m.needTodo(n).text), [
        "Review the validation chain api proposed",
        "Answer api: ?",
        "See why ui's turn failed",
        "Look at the failed validation run",
    ]);
    assert.deepEqual(m.needTodo(items[1]).source, { key: "need:req:s-ask:r-40", taskId: "both", taskTitle: "both", who: "api" });
    assert.equal(m.needTodo(repos[0]).text, "Confirm w1's repositories");
    const asksFirst = m.needsItems([task("p", { workers: [worker({ label: "api", requests: [request(-1), { ...request(-50), kind: "permission", title: "Run   npm\ntest" }] })] })]);
    assert.equal(m.needTodo(asksFirst[0]).text, "Allow or deny api: Run npm test", "the oldest ask, in one line");
    const long = m.needsItems([task("l", { workers: [worker({ label: "api", requests: [{ ...request(-1), title: "x".repeat(400) }] })] })]);
    assert.ok(m.needTodo(long[0]).text.length <= 200 && m.needTodo(long[0]).text.endsWith("…"));
    // An open to-do made from an ask takes it out of Needs you; a done one doesn't.
    const todo = (key, done = false) => ({ id: 1, text: "t", done, author: "you", createdAt: iso(-1), updatedAt: iso(-1), doneAt: null, source: { key, taskId: "x", taskTitle: "x", who: "x" } });
    assert.deepEqual(m.visibleNeeds(items, [todo("need:req:s-ask:r-40")]).map((n) => n.key), ["val:proposed", "fail:s-bad", "val:failed-run"]);
    assert.equal(m.visibleNeeds(items, [todo("need:req:s-ask:r-40", true)]).length, 4);
    assert.equal(m.visibleNeeds(items, [{ ...todo("x"), source: null }]).length, 4);
    assert.equal(m.visibleNeeds(items, undefined).length, 4);
    // A worker's next question is a new ask: the to-do for the first doesn't hide it.
    const nextAsk = m.needsItems([task("both", { workers: [{ ...asker, requests: [request(-20)] }] })]);
    assert.equal(m.visibleNeeds(nextAsk, [todo("need:req:s-ask:r-40")]).length, 1);
    // A failed turn is known by when it failed: switching the worker's model (updatedAt) keeps the same ask.
    const failedAt = worker({ sessionId: "s-f", state: "error", stateAt: iso(-20), updatedAt: iso(-1) });
    assert.equal(m.needsItems([task("f", { workers: [failedAt] })])[0].source, `need:fail:s-f:${iso(-20)}`);

    // The server ticks those to-dos by the same keys (src/jarvis-needs.mts).
    const { needKeys } = await import("../jarvis-needs.mjs");
    const all = [doneBroken, failedRun, both, proposed, fresh, doneAsking, needsOld, failed, running, doneToday, task("r", repos[0].task), task("f", { workers: [failedAt] })];
    assert.deepEqual([...needKeys(all)].sort(), m.needsItems(all).map((n) => n.source).sort(), "server and page agree on every ask's key");

    // ---- PR reviews asked for in Teams ----
    const teamsAsker = (name, over = {}) => ({
        name, chatKind: "oneOnOne", chatTopic: "", messageId: name, at: iso(-30), snippet: "please", audience: "direct",
        link: `https://teams.microsoft.com/l/message/19%3Ax%40unq.gbl.spaces/${name}?context=%7B%7D`, ...over,
    });
    const ask = (id, prId, askers, over = {}) => ({
        id, org: "msazure", prId, project: "Azure AppConfig", repo: "R", repoId: "r", title: `Fix ${prId}`, author: "Dana", created: iso(-300),
        isDraft: false, url: `https://dev.azure.com/msazure/Azure%20AppConfig/_git/R/pullrequest/${prId}`, audience: "direct",
        openedAt: iso(-45), updatedAt: iso(-30), askers, ...over,
    });
    const asks = [ask(7, 70, [teamsAsker("Dana")]), ask(8, 80, [teamsAsker("Lee", { chatKind: "group", chatTopic: "Release crew", audience: "broad" }), teamsAsker("Sam"), teamsAsker("Lee")], { openedAt: iso(-200) })];
    const withTeams = m.needsItems(all, asks);
    assert.deepEqual([...needKeys(all, asks)].sort(), withTeams.map((n) => n.source).sort(), "server and page agree on Teams asks' keys too");
    assert.deepEqual(withTeams.filter((n) => n.kind === "teams").map((n) => n.source), ["need:teams:8", "need:teams:7"], "the longest wait first, with the rest");
    assert.deepEqual(m.taskNeeds(all).map((n) => n.source), m.needsItems(all).map((n) => n.source), "a task's asks are the same without Teams");
    const teamsItem = withTeams.find((n) => n.source === "need:teams:7");
    assert.deepEqual(m.needTodo(teamsItem), {
        text: "Review PR 70: Fix 70 (Dana asked)",
        source: { key: "need:teams:7", taskId: "", taskTitle: "PR 70: Fix 70", who: "Dana in Teams", link: asks[0].askers[0].link },
    });
    assert.equal(m.needLine(withTeams.find((n) => n.source === "need:teams:8")), "Lee and Sam asked you to review PR 80");
    assert.equal(m.askersLine([teamsAsker("Dana")]), "Dana");
    assert.equal(m.askersLine([teamsAsker("Dana"), teamsAsker("Lee"), teamsAsker("Dana")]), "Dana and Lee", "each name once");
    assert.equal(m.askersLine([teamsAsker("A"), teamsAsker("B"), teamsAsker("C")]), "A and 2 others");
    assert.equal(m.askerWhere(teamsAsker("x")), "in a 1:1 chat");
    assert.equal(m.askerWhere(teamsAsker("x", { chatKind: "group", chatTopic: "  Release   crew " })), "in Release crew");
    assert.equal(m.askerWhere(teamsAsker("x", { chatKind: "meeting" })), "in a meeting chat");
    assert.equal(m.askerWhere(teamsAsker("x", { chatKind: "group" })), "in a group chat");
    assert.ok(m.askerWhere(teamsAsker("x", { chatKind: "group", chatTopic: "y".repeat(90) })).endsWith("…"));
    assert.equal(m.askFor(asks, { org: "MSAzure", id: 80 })?.id, 8, "a PR's ask, whatever the org's case");
    assert.equal(m.askFor(asks, { org: "msazure", id: 81 }), undefined);
    assert.equal(m.askFor(undefined, { org: "msazure", id: 80 }), undefined);
    const listed = { ...pr0(80), org: "MSAzure" };
    assert.equal(m.askPr(asks[1], [listed]), listed, "the PR from the user's list when it's there");
    const built = m.askPr(asks[0], []);
    assert.equal(built.id, 70);
    assert.equal(built.repoId, "r");
    assert.equal(built.title, "Fix 70");
    assert.equal(m.askPr(ask(9, 90, [teamsAsker("x")], { repoId: "" }), []), null, "not enough to open it here until ADO filled it in");
    assert.equal(m.visibleNeeds(withTeams, [todo("need:teams:7")]).filter((n) => n.kind === "teams").length, 1, "a to-do takes a Teams ask out too");

    // ---- chats and email threads waiting on the user ----
    const need = (key, over = {}) => ({
        key, source: "chat", id: "19:x@unq.gbl.spaces", day: "2026-10-28", title: "Dana Lee", kind: "oneOnOne", people: ["Dana Lee"],
        needsYou: "confirm the canary date", summary: "Dana asked about the canary.", lastAt: iso(-100), link: "https://teams.microsoft.com/l/chat/19%3Ax/0", ...over,
    });
    const chatNeed = need("need:chat:0123456789abcdef");
    const mailNeed = need("need:mail:fedcba9876543210", { source: "mail", id: "AAQk==", title: "Canary plan", kind: "cc", people: ["Ann Lu", "Bo", "Cy"], needsYou: "approve the plan", lastAt: iso(-10), link: "https://outlook.office365.com/owa/?ItemID=1" });
    const withComms = m.needsItems(all, asks, [mailNeed, chatNeed]);
    assert.deepEqual([...needKeys(all, asks, [chatNeed, mailNeed])].sort(), withComms.map((n) => n.source).sort(), "server and page agree on their keys");
    assert.deepEqual(withComms.filter((n) => n.kind === "comms").map((n) => n.source), [chatNeed.key, mailNeed.key], "the longest wait first");
    assert.deepEqual(m.taskNeeds(all).length, m.needsItems(all).length, "never a task's");
    const chatItem = withComms.find((n) => n.source === chatNeed.key);
    const mailItem = withComms.find((n) => n.source === mailNeed.key);
    assert.deepEqual(m.needTodo(chatItem), {
        text: "Confirm the canary date (Dana Lee in Teams)",
        source: { key: chatNeed.key, taskId: "", taskTitle: "Chat with Dana Lee", who: "Dana Lee in Teams", link: chatNeed.link },
    });
    assert.deepEqual(m.needTodo(mailItem), {
        text: "Approve the plan (Ann Lu and 2 others by email)",
        source: { key: mailNeed.key, taskId: "", taskTitle: "Canary plan", who: "Ann Lu and 2 others by email", link: mailNeed.link },
    });
    assert.equal(m.needTodo({ ...mailItem, need: { ...mailNeed, link: "" } }).source.link, undefined, "no link, none kept");
    assert.equal(m.needLine(chatItem), "Dana Lee: confirm the canary date");
    assert.equal(m.commsNeedWhere(chatNeed), "in a 1:1 chat");
    assert.equal(m.commsNeedWhere({ ...chatNeed, kind: "group", title: "Release crew" }), "in Release crew");
    assert.equal(m.commsNeedWhere(mailNeed), "by email (cc)");
    assert.equal(m.commsNeedWhere({ ...mailNeed, kind: "you" }), "by email");
    assert.equal(m.commsNeedWhere({ ...mailNeed, kind: "list" }), "by email to a list");
    assert.equal(m.commsNeedTitle({ ...chatNeed, kind: "group", title: "Release crew" }), "Release crew");
    assert.equal(m.commsNeedTitle({ ...mailNeed, title: "" }), "(no subject)");
    assert.equal(m.commsNeedWho({ ...chatNeed, people: [] }), "Dana Lee", "a 1:1 is with its title's person");
    assert.equal(m.commsNeedWho({ ...mailNeed, people: [] }), "Someone");
    assert.equal(m.commsNeedWho({ ...mailNeed, people: ["A", "B"] }), "A and B");
    assert.equal(m.visibleNeeds(withComms, [todo(mailNeed.key)]).some((n) => n.source === mailNeed.key), false, "a to-do takes it out too");
    const base = { tasks: [], reviewed: [], folders: [], organizations: [], comms: { asks: [], needs: [chatNeed] } };
    assert.notEqual(m.todayFingerprint(base, ""), m.todayFingerprint({ ...base, comms: { asks: [], needs: [{ ...chatNeed, needsYou: "other" }] } }, ""), "a changed ask repaints");
}

function pr0(id) {
    return { id, title: `PR ${id}`, org: "msazure", project: "Azure AppConfig", repo: "R", repoId: "r", author: "A", created: "", isDraft: false, mine: true, sourceRef: "", targetRef: "", url: "" };
}

// ---- PR reviews: the feed's "Needs your review" lane ----
const pr = (id, over = {}) => ({
    id, title: `PR ${id}`, org: "msazure", project: "Azure AppConfig", repo: "R", repoId: "r", author: "A",
    created: iso(-id * 60), isDraft: false, mine: true, authoredByMe: false, myVote: 0, iCommented: false,
    plateDismissed: false, sourceRef: "", targetRef: "", url: "", ...over,
});
const prs = [pr(1), pr(5), pr(3, { isDraft: true }), pr(4, { authoredByMe: true }), pr(6, { myVote: 10 }), pr(7, { iCommented: true }), pr(8, { mine: false }), pr(9, { plateDismissed: true })];
assert.deepEqual(m.reviewQueue(prs, () => null).map((p) => p.id), [1, 5, 3], "published first, newest first, drafts last");
assert.deepEqual(m.reviewQueue([pr(2, { mine: false })], () => "done").map((p) => p.id), [], "Copilot-reviewed PRs not assigned to you stay out");

// ---- the Copilot review button on each PR row ----
assert.deepEqual(m.copilotReviewControl(null), {
    label: "Copilot review", title: "Queue a Copilot review of this PR.", disabled: false, chip: null,
});
const active = m.copilotReviewControl("active");
assert.equal(active.disabled, true, "no second request while one is queued or running");
assert.equal(active.chip, null, "the disabled button already says it is reviewing");
assert.deepEqual(m.copilotReviewControl("done").chip, { label: "Copilot reviewed", tone: "ok" });
assert.equal(m.copilotReviewControl("done").disabled, false, "a finished review can run again");
assert.deepEqual(m.copilotReviewControl("error").chip, { label: "Copilot review failed", tone: "bad" });
assert.equal(m.copilotReviewControl("error").disabled, false);

// ---- service filter ----
const custom = task("custom", { org: null, project: null });
const other = task("other", { org: "contoso", project: "Web" });
assert.deepEqual(m.serviceOptions([custom, other, fresh], [pr(1)]), ["contoso/Web", "msazure/Azure AppConfig"]);
assert.equal(m.inService(custom, m.ALL_SERVICES), true);
assert.equal(m.inService(custom, "contoso/Web"), false, "custom tasks without a service only show under All");
assert.equal(m.inService(other, "contoso/Web"), true);

// ---- wording ----
assert.equal(m.ago(iso(-0.2), NOW), "now");
assert.equal(m.ago(iso(-5), NOW), "5m");
assert.equal(m.ago(iso(-180), NOW), "3h");
assert.equal(m.ago(iso(-60 * 48), NOW), "2d");
assert.equal(m.ago("", NOW), "");
assert.equal(m.agoPhrase(iso(-0.2), NOW), "just now");
assert.equal(m.agoPhrase(iso(-5), NOW), "5m ago");
assert.equal(
    m.taskMeta(task("x", { workItem: { id: 2841124, type: "Task", state: "Active", url: "", parent: { id: 2841117, type: "User Story", title: "Pin upstream artifacts" } } })),
    "Azure AppConfig · #2841124 · Task · Active · under User Story #2841117 Pin upstream artifacts",
);
assert.equal(m.taskMeta(custom), "custom task");
assert.equal(m.todaySummary({ needs: 1, reviews: 2, running: 0, done: 1 }), "1 needs you · 1 done today · 2 PRs to review");
assert.equal(m.todaySummary({}), "Nothing in Tasks yet");
assert.equal(m.SECTIONS.map((s) => s.id).join(), "needs,running,idle,done,reviews", "pull request reviews come last");

// ---- the quick note: an edit and what an agent added meanwhile ----
const appended = "Standup at 10.\n\n[Jarvis, Oct 15, 3:00 PM] Canary is green.";
assert.equal(m.mergeQuickNote("Standup at 10.", "Standup at 10.\nAsk about rollout.", appended),
    "Standup at 10.\nAsk about rollout.\n\n[Jarvis, Oct 15, 3:00 PM] Canary is green.", "the added part goes below the user's edit");
assert.equal(m.mergeQuickNote("Standup at 10.\n\n", "Standup at 10. Moved to 11.", appended),
    "Standup at 10. Moved to 11.\n\n[Jarvis, Oct 15, 3:00 PM] Canary is green.", "trailing space on the base doesn't matter");
assert.equal(m.mergeQuickNote("", "First line", "[w1, Oct 15] Added"), "First line\n\n[w1, Oct 15] Added", "an empty base merges too");
assert.equal(m.mergeQuickNote("", "", "[w1, Oct 15] Added"), "[w1, Oct 15] Added");
assert.equal(m.mergeQuickNote("Same", "Mine", "Same"), "Mine", "nothing added: the edit stands");
assert.equal(m.mergeQuickNote("Standup at 10.", "Mine", "Rewritten elsewhere"), null, "changed some other way: the user chooses");
assert.equal(m.mergeQuickNote("Standup at 10.", "Mine", "Standup at 10.5"), null, "text run onto the last line is an edit, not an append");

// ---- reconciling an unsaved edit: the user's own saved words are never an addition ----
const J = "[Jarvis, Oct 15, 3:00 PM] call Bob";
// The save sent on the way out landed, then the Lead appended: it's all there.
assert.deepEqual(m.reconcileNote("X", "X\nbuy milk", `X\nbuy milk\n\n${J}`, "X\nbuy milk"), { kind: "landed" });
// The new page read the note before that save landed, and then it did.
assert.deepEqual(m.reconcileNote("X", "X\nbuy milk", "X\nbuy milk", "X\nbuy milk"), { kind: "landed" });
// A save was in flight with more typed after it (on the same line); it landed, then the Lead appended.
assert.deepEqual(m.reconcileNote("X", "X\nbuy milk", `X\nbuy\n\n${J}`, "X\nbuy"), { kind: "draft", text: `X\nbuy milk\n\n${J}`, added: true });
// …and the user deleted part of what that save sent: the deletion stands.
assert.deepEqual(m.reconcileNote("X", "X", `X\nbuy\n\n${J}`, "X\nbuy"), { kind: "draft", text: `X\n\n${J}`, added: true });
// Without knowing the saves, the same note would have counted the user's own words as added.
assert.equal(m.mergeQuickNote("X", "X\nbuy milk", `X\nbuy milk\n\n${J}`), `X\nbuy milk\n\nbuy milk\n\n${J}`);
// The saved note is still the base: nothing to fold in.
assert.deepEqual(m.reconcileNote("X", "X\nbuy milk", "X"), { kind: "draft", text: "X\nbuy milk", added: false });
assert.deepEqual(m.reconcileNote("X", "X\nbuy milk", "Rewritten"), { kind: "conflict" });

// ---- repaint only on change ----
const data = { tasks: [running], reviewed: [], folders: [], organizations: [] };
const a = m.todayFingerprint(data, "x");
assert.equal(m.todayFingerprint(structuredClone(data), "x"), a);
const streamed = structuredClone(data);
streamed.tasks[0].workers[0].partial = "Writing…";
assert.notEqual(m.todayFingerprint(streamed, "x"), a, "streaming text repaints");
assert.notEqual(m.todayFingerprint(data, "y"), a);
const posted = structuredClone(data);
posted.tasks[0].updates = { latest: { id: 9, text: "x", at: iso(-1) }, today: [{ id: 9 }] };
assert.notEqual(m.todayFingerprint(posted, "x"), a, "a new status update repaints");
const written = structuredClone(data);
written.overview = { phase: "fresh", text: "x", at: iso(-1), stale: false, error: null, model: null };
assert.notEqual(m.todayFingerprint(written, "x"), a, "a new overview repaints");

// ---- the overview: its folded line, and whether there's anything to write about ----
const update = (id, text, at, author = "appconfig-api") => ({ id, taskId: "t", at: iso(at), author, sessionId: null, text });
const withUpdates = (t, latest, today = latest ? [latest] : []) => ({ ...t, updates: { latest, today } });
const factTasks = [
    withUpdates(task("Idle old", { updatedAt: iso(-200) }), update(1, "Docs drafted", -120)),
    withUpdates(task("Idle fresh"), update(2, "Setup guide rewritten", -10)),
    withUpdates(task("Asking", { workers: [worker({ requests: [request(-30)], label: "appconfig-tests" })] }), update(3, "Blocked on regions", -3)),
    withUpdates(task("Asking longer", { workers: [worker({ requests: [request(-90)] })] }), null),
    withUpdates(task("Broken", { workers: [worker({ state: "error", label: "appconfig-ui", updatedAt: iso(-5) })] }), update(4, "Half done", -60)),
    withUpdates(task("Running quiet", { workers: [worker({ busy: true, state: "working", label: "appconfig-api", updatedAt: iso(-2) })] }), null),
    withUpdates(task("Finished", { status: "done", doneAt: iso(-20) }), null),
    withUpdates(task("Untouched"), null),
];
assert.equal(m.overviewSummary(factTasks, START), "3 need you · 1 moving · 3 open · 1 done", "a task waiting on you counts there only");
assert.equal(m.overviewSummary([factTasks[2]], START), "1 needs you", "never \"0 moving\" for a task that's only waiting on you");
assert.equal(m.overviewSummary([], START), "Nothing on Today yet");
assert.equal(m.todayHasTasks(factTasks, START), true);
assert.equal(m.todayHasTasks([doneYesterday], START), false, "only what Today shows counts");
assert.equal("overviewFacts" in m, false, "the per-task lines are gone from Today so far: each task's card has them");

// ---- narrative mentions ----
const known = [{ id: "t1", title: "Parameter editor" }];
assert.deepEqual(m.narrativeParts("[[parameter editor]] is moving; [[Gone task]] finished.", known), [
    { text: "parameter editor", mention: true, taskId: "t1" },
    { text: " is moving; " },
    { text: "Gone task", mention: true, taskId: undefined },
    { text: " finished." },
]);
assert.deepEqual(m.narrativeParts("No mentions.", known), [{ text: "No mentions." }]);
assert.deepEqual(
    m.narrativeParts("[[[AppConfig] Fix export]] waits on [[Fix]].", [
        { id: "t2", title: "[AppConfig] Fix export" },
        { id: "t3", title: "Fix" },
    ]),
    [
        { text: "[AppConfig] Fix export", mention: true, taskId: "t2" },
        { text: " waits on " },
        { text: "Fix", mention: true, taskId: "t3" },
        { text: "." },
    ],
    "titles with brackets are matched whole, longest first",
);
assert.deepEqual(m.narrativeParts("[[Gone]] only.", []), [{ text: "Gone", mention: true, taskId: undefined }, { text: " only." }]);
assert.deepEqual(
    m.narrativeParts("[[[Old] task]] and [[Fix [v2]]] are done.", []),
    [
        { text: "[Old] task", mention: true, taskId: undefined },
        { text: " and " },
        { text: "Fix [v2]", mention: true, taskId: undefined },
        { text: " are done." },
    ],
    "a gone task with brackets still reads as a name",
);

// ---- narrative points ----
const points = (text, tasks = known) => m.narrativeLines(text, tasks);
assert.deepEqual(points("- [[Parameter editor]] is moving.\n- 3 PRs wait on you\n"), [
    [{ text: "Parameter editor", mention: true, taskId: "t1" }, { text: " is moving." }],
    [{ text: "3 PRs wait on you" }],
]);
assert.deepEqual(
    points("32 pull requests await your review. [[Canary v1.2]] is waiting on runs.  Nothing approved today.", [{ id: "t9", title: "Canary v1.2" }]),
    [
        [{ text: "32 pull requests await your review." }],
        [{ text: "Canary v1.2", mention: true, taskId: "t9" }, { text: " is waiting on runs." }],
        [{ text: "Nothing approved today." }],
    ],
    "an older prose write-up shows a sentence per point; a title's period doesn't split",
);
assert.deepEqual(points("", known), []);
assert.deepEqual(points("Just one line"), [[{ text: "Just one line" }]]);

// ---- a task's artifacts ----
assert.equal(m.formatBytes(0), "0 B");
assert.equal(m.formatBytes(1023), "1023 B");
assert.equal(m.formatBytes(1536), "1.5 KB");
assert.equal(m.formatBytes(20 * 1024), "20 KB");
assert.equal(m.nextArtifactName(["note.md", "recap.md"]), "notes.md");
assert.equal(m.nextArtifactName(["Notes.md", "notes-2.md"]), "notes-3.md", "taken names compare case-insensitively");
assert.equal(m.newArtifactText("design-review_notes.md"), "# Design review notes\n\n");
assert.equal(m.newArtifactText("data.json"), "", "only Markdown gets a heading");
assert.equal(m.artifactRole("NOTE.md"), "Shared note");
assert.equal(m.artifactRole("recap.md"), "Recap");
assert.equal(m.artifactRole("design.md"), "");
assert.ok(m.isMarkdownName("a.MD") && !m.isMarkdownName("a.txt"));

// ---- a task's timeline over its life, by day ----
const at = (y, mo, d, h) => new Date(y, mo, d, h).toISOString();
const NOW_DAY = new Date(2026, 9, 15, 20).getTime();
const st = (id, iso) => ({ id, taskId: "t", at: iso, author: "w", sessionId: null, text: `s${id}` });
const days = m.statusDays([st(9, at(2026, 9, 15, 18)), st(8, at(2026, 9, 15, 9)), st(7, at(2026, 9, 14, 17)), st(5, at(2026, 9, 10, 12)), st(2, at(2025, 11, 30, 12))], NOW_DAY);
assert.deepEqual(days.map((d) => [d.label.replace(/\s+/g, " "), d.items.map((s) => s.id)]).slice(0, 2), [["Today", [9, 8]], ["Yesterday", [7]]]);
assert.equal(days.length, 4);
assert.match(days[2].label, /Oct/);
assert.doesNotMatch(days[2].label, /2026/, "this year's dates leave the year out");
assert.match(days[3].label, /2025/, "older years say so");
assert.deepEqual(m.statusDays([], NOW_DAY), []);
assert.deepEqual(m.mergeStatuses([st(5, "a"), st(3, "a")], [st(4, "a"), st(5, "b")]).map((s) => [s.id, s.at]), [[5, "b"], [4, "a"], [3, "a"]], "pages join newest first, each once");
assert.equal(m.activityLine(""), "Thinking…");
assert.equal(m.activityLine("view"), "Using view…");
assert.equal(m.activityLine("Writing the recap"), "Writing the recap…", "a phrase isn't a tool name");
const rtask = (over) => ({ status: "done", workers: [{}], recap: null, ...over });
assert.equal(m.recapLine(rtask({ status: "open" }), false), null, "an open task says nothing about a recap");
assert.equal(m.recapLine(rtask({}), true), null, "a done task with its recap says nothing");
assert.deepEqual(m.recapLine(rtask({}), false), { text: "No recap yet.", tone: "idle", busy: false, action: "Write recap" });
assert.equal(m.recapLine(rtask({ workers: [] }), false), null, "no workers, nobody to write one");
assert.deepEqual(m.recapLine(rtask({ recap: { state: "writing", by: "appconfig" } }), false), {
    text: "appconfig is writing the recap…",
    tone: "run",
    busy: true,
    action: null,
});
assert.equal(m.recapLine(rtask({ recap: { state: "waiting" } }), false).busy, true);
assert.deepEqual(m.recapLine(rtask({ recap: { state: "failed", error: "gone: its reply had no recap." } }), true), {
    text: "Recap not written: gone: its reply had no recap.",
    tone: "warn",
    busy: false,
    action: "Try again",
});

// ---- freshness wording ----
assert.equal(m.overviewFreshness({ phase: "fresh", at: iso(-4) }, NOW), "Updated 4m ago");
assert.equal(m.overviewFreshness({ phase: "fresh", at: iso(-0.1) }, NOW), "Updated just now");
assert.equal(m.overviewFreshness({ phase: "updating" }, NOW), "Updating…");
assert.equal(m.overviewFreshness({ phase: "failed" }, NOW), "Write-up unavailable");
assert.equal(m.overviewFreshness({ phase: "none" }, NOW), "");
assert.equal(m.overviewFreshness(undefined, NOW), "");

// ---- a task's pull requests ----
const rv = (vote, over = {}) => ({ name: "r", vote, isRequired: false, isContainer: false, ...over });
const tpr = (prId, snap = {}, over = {}) => ({
    taskId: "t",
    org: "msazure",
    prId,
    source: "branch",
    linkedAt: "",
    hidden: false,
    snapshot: { status: "active", isDraft: false, mergeStatus: "succeeded", reviewers: [], closed: null, title: `PR ${prId}`, ...snap },
    checks: null,
    unresolved: null,
    refreshedAt: null,
    error: null,
    ...over,
});
assert.deepEqual(m.prState(tpr(1)), { label: "Active", tone: "run" });
assert.deepEqual(m.prState(tpr(1, { isDraft: true })), { label: "Draft", tone: "idle" });
assert.deepEqual(m.prState(tpr(1, { status: "completed" })), { label: "Completed", tone: "ok" });
assert.deepEqual(m.prState(tpr(1, { status: "abandoned" })), { label: "Abandoned", tone: "off" });
assert.deepEqual(m.prState({ snapshot: null }), { label: "Unknown", tone: "off" });
assert.deepEqual(m.prVotes([rv(10), rv(5, { isRequired: true }), rv(0, { isRequired: true, isContainer: true }), rv(10, { isContainer: true }), rv(-10), rv(-5)]), {
    approved: 2,
    required: 2,
    requiredApproved: 1,
    rejected: 1,
    waiting: 1,
});
assert.deepEqual(m.prSignals(tpr(1)).map((s) => s.text), ["No approvals yet"]);
assert.deepEqual(
    m.prSignals(tpr(1, { mergeStatus: "conflicts", reviewers: [rv(-10), rv(10, { isRequired: true }), rv(0, { isRequired: true })] }, {
        checks: { passed: 1, failed: 2, running: 0, total: 3, failing: ["Build", "Lint"] },
        unresolved: 1,
    })).map((s) => [s.text, s.tone]),
    [
        ["Rejected by 1", "warn"],
        ["Build failed (+1)", "warn"],
        ["Merge conflicts", "warn"],
        ["1 of 2 required approvals", "idle"],
        ["1 open comment", "idle"],
    ],
    "the most pressing first",
);
assert.deepEqual(m.prSignals(tpr(1, { reviewers: [rv(10)] }, { checks: { passed: 2, failed: 0, running: 0, total: 2, failing: [] } })).map((s) => s.text), ["1 approval", "Checks passed"]);
assert.deepEqual(m.prSignals(tpr(1, { isDraft: true }, { checks: { passed: 0, failed: 0, running: 1, total: 1, failing: [] } })).map((s) => s.text), ["Checks running"], "a draft isn't asking for votes yet");
assert.deepEqual(m.prSignals(tpr(1, { status: "completed" })), [], "finished PRs need nothing");
assert.ok(m.prNeedsAttention(tpr(1, { mergeStatus: "conflicts" })));
assert.ok(!m.prNeedsAttention(tpr(1)));
const grouped = m.groupTaskPrs([
    tpr(10),
    tpr(11, { status: "completed", closed: "2026-10-01T00:00:00Z" }),
    tpr(12, { mergeStatus: "conflicts" }),
    tpr(13, { status: "abandoned", closed: "2026-10-05T00:00:00Z" }),
    tpr(14),
]);
assert.deepEqual(grouped.open.map((p) => p.prId), [12, 14, 10], "needing attention first, then newest");
assert.deepEqual(grouped.finished.map((p) => p.prId), [13, 11], "latest closed first");
assert.deepEqual(m.cardPrs([tpr(1), tpr(2, { status: "completed" }), tpr(3)]), { shown: [tpr(3), tpr(1)], more: 1 });
assert.deepEqual(m.cardPrs(undefined), { shown: [], more: 0 });
assert.deepEqual(m.prChipText(tpr(17553390, { reviewers: [rv(10, { isRequired: true }), rv(0, { isRequired: true })] })), {
    text: "PR 17553390 · Active · 1 of 2 required approvals",
    tone: "run",
});
assert.deepEqual(m.prChipText(tpr(5, {}, { checks: { passed: 0, failed: 1, running: 0, total: 1, failing: ["Build"] } })), { text: "PR 5 · Active · Build failed", tone: "warn" });
assert.deepEqual(m.prChipText(tpr(5, { status: "completed" })), { text: "PR 5 · Completed", tone: "ok" });
assert.equal(m.prSourceText("workitem"), "Linked to the work item in Azure DevOps");
assert.equal(m.prSourceText("branch"), "From a worker's branch");

// ---- a task's validation: the card chip, Needs you, and stages ----
const vs = (over = {}) => ({ chainId: "c1", name: "Validation · x", blocks: 3, run: null, proposal: null, attention: null, ...over });
const vrun = (over = {}) => ({ runId: "r1", status: "running", startedAt: iso(-5), finishedAt: null, done: 1, total: 3, current: "Deploy", failed: null, ...over });
assert.equal(m.validationChip(null), null);
assert.deepEqual(m.validationChip(vs()), { text: "Validation · 3 pipelines · not run", tone: "idle" });
assert.deepEqual(m.validationChip(vs({ run: vrun() })), { text: "Validation · 1 of 3 · Deploy", tone: "run" });
assert.deepEqual(m.validationChip(vs({ run: vrun({ status: "succeeded", done: 3, current: null }) })), { text: "Validation passed", tone: "ok" });
assert.deepEqual(m.validationChip(vs({ run: vrun({ status: "failed", failed: "Deploy" }), attention: "failed" })), { text: "Validation failed · Deploy", tone: "warn" });
assert.deepEqual(m.validationChip(vs({ run: vrun({ status: "failed", failed: "Deploy" }) })), { text: "Validation failed · Deploy", tone: "off" }, "a failure the user saw is quiet");
assert.deepEqual(m.validationChip(vs({ chainId: null, blocks: 0, proposal: { by: "W1", at: iso(-1), blocks: 2 }, attention: "proposal" })), { text: "Validation proposed · 2 pipelines", tone: "warn" });
const proposalTask = task("proposed", { validation: vs({ proposal: { by: "W1", at: iso(-1), blocks: 2 }, attention: "proposal" }) });
assert.equal(m.validationNeed(proposalTask), "W1 proposed a validation chain of 2 pipelines");
assert.equal(m.taskSection(proposalTask, START), "needs", "a proposal to review needs the user");
const failedRun = task("vfailed", { validation: vs({ run: vrun({ status: "failed", failed: "Deploy" }), attention: "failed" }) });
assert.equal(m.validationNeed(failedRun), "Validation failed at Deploy");
assert.equal(m.taskSection(failedRun, START), "needs");
assert.equal(m.taskSection({ ...failedRun, status: "done", doneAt: iso(-1) }, START), "done", "a done task's old failure doesn't need the user");
assert.equal(m.taskSection(task("vok", { validation: vs({ run: vrun({ status: "succeeded" }) }) }), START), "idle");
assert.deepEqual(
    m.chainStages([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }], [{ from: "a", to: "c" }, { from: "b", to: "c" }, { from: "c", to: "d" }]).map((s) => s.map((n) => n.id)),
    [["a", "b"], ["c"], ["d"]],
);
assert.deepEqual(m.chainStages([{ id: "a" }, { id: "b" }], [{ from: "a", to: "b" }, { from: "b", to: "a" }]).flat().length, 2, "a cycle still lists every block");
const fp = (t) => m.todayFingerprint({ tasks: [t], reviewed: [], overview: null }, "");
assert.notEqual(fp(task("x", { validation: vs({ run: vrun({ done: 1 }) }) })), fp(task("x", { validation: vs({ run: vrun({ done: 2 }) }) })), "Today repaints as a run moves on");

// ---- a live read on top of Today's ----
{
    const w = { sessionId: "s1", label: "api", busy: true, partial: "old", activity: "", requests: [], state: "working", summary: "", updatedAt: "t1", queue: [], steered: [] };
    const view = { busy: false, partial: "", partialId: "", activity: "", requests: [], queue: [], queueHeld: false, steered: [], canSteer: false, currentModel: "m", currentEffort: null, state: "turnDone", summary: "Done.", updatedAt: "t2" };
    const live = { sessionId: "s1", view, at: 200 };
    const merged = m.withLive(w, live, 100);
    assert.deepEqual([merged.busy, merged.state, merged.summary, merged.updatedAt, merged.currentModel, merged.label], [false, "turnDone", "Done.", "t2", "m", "api"], "a newer live read wins its fields; the rest is Today's");
    assert.equal(m.withLive(w, live, 300), w, "Today asked for after the live read wins");
    assert.equal(m.withLive(w, live, 300, true).busy, false, "but not while the chat follows the worker: its live read carries the turn with its partial");
    assert.equal(m.withLive(w, { ...live, sessionId: "s2" }, 100, true), w, "another worker's read never applies");
    assert.equal(m.withLive(w, null, 0), w);
    assert.equal(w.busy, true, "Today's copy is left as it was");
    assert.equal(m.withLive(w, { ...live, view: { ...view, partialId: undefined } }, 100).partial, "", "fields the read carries apply even when empty");
    assert.ok(m.LIVE_FIELDS.includes("partialId") && !m.LIVE_FIELDS.includes("label"), "only live fields come from the read");
}

console.log("jarvis-model harness: ok");
