import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
    parseVote,
    parseThreadStatus,
    parseLifecycleAction,
    buildLifecyclePatch,
} from "../pr-actions.mjs";
import {
    isThreadResolved,
    nextThreadStatus,
    threadStatusLabel,
    decisionMenuItems,
    lifecycleMenuItems,
    defaultMergeMessage,
} from "../web/prActionModel.js";

// ---- backend validation ----
assert.equal(parseVote(10), 10);
assert.equal(parseVote("5"), 5);
assert.equal(parseVote(0), 0);
assert.throws(() => parseVote(-10), /vote/);
assert.equal(parseThreadStatus("fixed"), "fixed");
assert.equal(parseThreadStatus("active"), "active");
assert.throws(() => parseThreadStatus("closed"), /status/);
assert.throws(() => parseLifecycleAction("delete"), /action/);

const opts = { mergeStrategy: "squash", deleteSourceBranch: true, transitionWorkItems: false, mergeCommitMessage: "Merged PR 1: x" };
assert.deepEqual(buildLifecyclePatch("complete", { options: opts, lastMergeSourceCommit: "abc", meId: "me" }), {
    status: "completed",
    lastMergeSourceCommit: { commitId: "abc" },
    completionOptions: { ...opts, bypassPolicy: false },
});
assert.throws(() => buildLifecyclePatch("complete", { options: opts, meId: "me" }), /source commit/);
assert.throws(
    () => buildLifecyclePatch("complete", { options: { ...opts, mergeStrategy: "ff" }, lastMergeSourceCommit: "abc", meId: "me" }),
    /merge strategy/,
);
assert.deepEqual(buildLifecyclePatch("autoComplete", { options: opts, meId: "me" }), {
    autoCompleteSetBy: { id: "me" },
    completionOptions: { ...opts, bypassPolicy: false },
});
assert.deepEqual(buildLifecyclePatch("cancelAutoComplete", { meId: "me" }), {
    autoCompleteSetBy: { id: "00000000-0000-0000-0000-000000000000" },
});
assert.deepEqual(buildLifecyclePatch("draft", { meId: "me" }), { isDraft: true });
assert.deepEqual(buildLifecyclePatch("publish", { meId: "me" }), { isDraft: false });
assert.deepEqual(buildLifecyclePatch("abandon", { meId: "me" }), { status: "abandoned" });
assert.deepEqual(buildLifecyclePatch("reactivate", { meId: "me" }), { status: "active" });
// Rebase leaves no merge commit, so no message is sent.
assert.equal(
    buildLifecyclePatch("complete", { options: { ...opts, mergeStrategy: "rebase" }, lastMergeSourceCommit: "abc", meId: "me" })
        .completionOptions.mergeCommitMessage,
    undefined,
);

// ---- frontend model ----
assert.equal(isThreadResolved("fixed"), true);
assert.equal(isThreadResolved("byDesign"), true);
assert.equal(isThreadResolved("active"), false);
assert.equal(isThreadResolved("pending"), false);
assert.equal(nextThreadStatus("active"), "fixed");
assert.equal(nextThreadStatus("wontFix"), "active");
assert.equal(threadStatusLabel("fixed"), "Resolved");
assert.equal(threadStatusLabel("wontFix"), "Won't fix");

const decisions = decisionMenuItems({ status: "active", myVote: 10 });
assert.deepEqual(decisions.map((d) => d.label), ["Approve", "Approve with suggestions", "Reset feedback"]);
assert.equal(decisions[0].checked, true);
assert.equal(decisionMenuItems({ status: "active", myVote: 0 })[2].disabled, true);
assert.ok(decisionMenuItems({ status: "completed", myVote: 0 }).every((d) => d.disabled));

const ids = (d) => lifecycleMenuItems(d).filter((i) => !i.disabled).map((i) => i.action);
assert.deepEqual(ids({ status: "active", isDraft: false }), ["complete", "autoComplete", "draft", "abandon"]);
assert.deepEqual(ids({ status: "active", isDraft: false, autoCompleteSetBy: "Me" }), ["complete", "cancelAutoComplete", "draft", "abandon"]);
assert.deepEqual(ids({ status: "active", isDraft: true }), ["publish", "abandon"]);
assert.deepEqual(ids({ status: "abandoned" }), ["reactivate"]);
assert.deepEqual(ids({ status: "completed" }), []);
assert.equal(defaultMergeMessage(42, "Fix bug"), "Merged PR 42: Fix bug");

// ---- wiring ----
const [detail, threads, drawer, api] = await Promise.all([
    readFile(new URL("../web/src/detail.ts", import.meta.url), "utf8"),
    readFile(new URL("../web/src/threads.ts", import.meta.url), "utf8"),
    readFile(new URL("../web/src/prComments.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/api.mts", import.meta.url), "utf8"),
]);
const group = detail.slice(detail.indexOf('const actions = el(`<span class="detail-sub-actions">'), detail.indexOf("sub.appendChild(actions);"));
assert.ok(group.indexOf("actions.appendChild(decisionBtn)") >= 0);
assert.ok(group.indexOf("actions.appendChild(decisionBtn)") < group.indexOf("actions.appendChild(lifecycleBtn)"));
assert.ok(group.indexOf("actions.appendChild(lifecycleBtn)") < group.indexOf("actions.appendChild(sendAll)"));
assert.match(threads, /threadStatusToggle\(pr, thread\)/);
assert.match(drawer, /threadStatusToggle\(/);
for (const route of ["/api/thread-status", "/api/pr-vote", "/api/pr-lifecycle"]) {
    assert.match(api, new RegExp(`p === "${route}" && req\\.method === "POST"`));
}

console.log("PR actions harness passed");
