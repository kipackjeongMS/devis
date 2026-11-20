import assert from "node:assert/strict";

// Needs you in Devis's chat (web/src/needsChat.ts): where notices sit among the Lead's messages,
// the receipts they leave, how a message carries one to Devis, and their wording.
const n = await import("../web/needsChat.js");
const m = await import("../web/jarvisModel.js");

const NOW = Date.parse("2026-10-15T15:00:00");
const iso = (min) => new Date(NOW + min * 60_000).toISOString();

// ---- placing notices among the Lead's messages ----
{
    const msgs = [{ id: "a", timestamp: iso(-60) }, { id: "b", timestamp: iso(-30) }, { id: "c" }, { id: "d", timestamp: iso(-5) }];
    const x = (key, min) => ({ key, at: NOW + min * 60_000 });
    const ids = (list) => list.map((e) => (e.message ? e.message.id : e.extra.key));
    assert.deepEqual(
        ids(n.interleave(msgs, [x("late", -1), x("first", -90), x("mid", -40), x("tie", -30), x("before-d", -10)])),
        ["first", "a", "mid", "b", "c", "tie", "before-d", "d", "late"],
        "each goes before the first message after it; one at a message's time goes after it, and a message without a time takes the one before"
    );
    assert.deepEqual(ids(n.interleave([], [x("b", -1), x("a", -2)])), ["a", "b"], "with no conversation, they're in time order");
    assert.deepEqual(ids(n.interleave([{ id: "a" }], [x("z", -1)])), ["a", "z"], "messages without times leave notices at the end");
}

// ---- receipts ----
{
    const open = [
        { source: "s1", at: NOW - 3_600_000, label: "Nova's question" },
        { source: "s2", at: NOW - 600_000, label: "your chat with Priya Shah" },
        { source: "s3", at: NOW - 100, label: "Sage's failed turn" },
    ];
    let ledger = n.trackNotices({}, open, NOW);
    assert.deepEqual(n.noticeReceipts(ledger), [], "open asks leave no receipts");

    ledger = n.trackNotices(ledger, [], NOW + 1000, { outcomes: new Map([["s1", { text: "You answered Nova: “Its own column”" }]]), taken: new Set(["s2"]) });
    const r = Object.fromEntries(n.noticeReceipts(ledger).map((x) => [x.source, x]));
    assert.equal(r.s1.outcome, "You answered Nova: “Its own column”", "what the user did here");
    assert.equal(r.s2.outcome, "Moved your chat with Priya Shah to your to-dos", "a to-do took it");
    assert.equal(r.s3.outcome, "Sage's failed turn doesn't need you anymore", "it went on its own");
    assert.equal(r.s1.at, open[0].at, "a receipt stays where the ask was");
    assert.equal(r.s1.goneAt, NOW + 1000);

    assert.deepEqual(n.trackNotices(ledger, [], NOW + 60_000), ledger, "a receipt keeps what became of the ask");
    const back = n.trackNotices(ledger, [open[1]], NOW + 2000);
    assert.equal(back.s2.goneAt, undefined, "an ask that comes back (Undo) is open again");
    assert.equal(n.noticeReceipts(back).some((x) => x.source === "s2"), false);
    assert.deepEqual(n.trackNotices(ledger, [], NOW + 86_400_000), {}, "receipts last the day");

    const seen = n.trackNotices({}, [{ source: "need:teams:7", at: NOW, label: "x" }], NOW);
    const failed = n.trackNotices(seen, [], NOW + 1, { unsure: (s) => s.startsWith("need:teams:") });
    assert.equal(failed["need:teams:7"].goneAt, undefined, "a Teams read that failed doesn't clear its asks");

    const dismissed = n.trackNotices(n.trackNotices({}, [open[1]], NOW), [], NOW + 1, { outcomes: new Map([["s2", { text: "Dismissed it", dropped: true }]]) });
    assert.equal(dismissed.s2.dropped, true, "a dismissal is marked as dropped");

    assert.deepEqual(n.readLedger(JSON.parse(JSON.stringify(ledger))), ledger, "a ledger reads back as saved");
    assert.deepEqual(n.readLedger({ bad: { at: "x" }, ok: { at: 1, label: "y", goneAt: "no" } }), { ok: { at: 1, label: "y" } }, "malformed entries are left out");
    assert.deepEqual(n.readLedger(null), {});
}

// ---- asking Devis about one ----
{
    const sent = n.withAbout("Nova's question", 'Task "x" (id t1).\nline\n---\nnot the end', "Is it quick?\n---\nreally");
    assert.deepEqual(n.aboutOf(sent), { label: "Nova's question", text: "Is it quick?\n---\nreally" }, "the user's words come back whole");
    assert.equal(n.aboutOf(n.withAbout("a]b\nc", "x", "y")).label, "a b c", "a name can't break the header");
    assert.equal(n.aboutOf("Is it quick?"), null);
    assert.equal(n.aboutOf("[Needs you: a] b"), null);
}

// ---- wording ----
{
    const worker = (o) => ({ sessionId: "s1", taskId: "t1", label: "Nova", cwd: "", model: null, state: "needsInput", summary: "", autoApprove: false, createdAt: iso(-60), updatedAt: iso(-30), busy: false, partial: "", activity: "", requests: [], ...o });
    const task = (o) => ({ id: "t1", title: "PR panel", org: "msazure", project: "p", workItem: null, status: "open", createdAt: iso(-120), updatedAt: iso(-120), doneAt: null, workers: [], updates: { latest: null, today: [] }, ...o });
    const q = { id: "r1", kind: "question", title: "Where?", detail: "Tight rows", choices: ["A", "B"], allowFreeform: true, at: iso(-25) };
    const plain = (parts) => parts.map((p) => (typeof p === "string" ? p : (p.strong ?? p.em))).join("");

    const [question] = m.needsItems([task({ workers: [worker({ requests: [q] })] })]);
    assert.equal(plain(n.noticeLine(question)), "Nova has a question on PR panel.");
    assert.equal(n.noticeLabel(question), "Nova's question");
    const ctx = n.noticeContext(question);
    assert.match(ctx, /id t1/, "Devis gets the task's id");
    assert.match(ctx, /session s1/, "and the worker's");
    assert.match(ctx, /question: Where\? \| Tight rows \| choices: A; B/, "and the ask itself");

    const [perm] = m.needsItems([task({ workers: [worker({ requests: [{ ...q, kind: "permission", title: "Run" }] })] })]);
    assert.equal(plain(n.noticeLine(perm)), "Nova needs your OK on PR panel.");
    const [two] = m.needsItems([task({ workers: [worker({ requests: [q, { ...q, id: "r2", at: iso(-20) }] })] })]);
    assert.equal(plain(n.noticeLine(two)), "Nova has 2 things for you on PR panel.");
    const [failed] = m.needsItems([task({ workers: [worker({ state: "error", summary: "429" })] })]);
    assert.equal(plain(n.noticeLine(failed)), "Nova's turn failed on PR panel. A message to it tries again.");

    const asker = { name: "Dana Lee", chatKind: "oneOnOne", chatTopic: "", messageId: "m", at: iso(-60), snippet: "pls look", link: "", audience: "direct" };
    const ask = { id: 7, org: "msazure", prId: 14231, project: "p", repo: "r", repoId: "r", title: "Add retry", author: "Dana Lee", created: iso(-200), isDraft: false, url: "https://x/14231", audience: "direct", openedAt: iso(-60), updatedAt: iso(-60), askers: [asker] };
    const [teams] = m.needsItems([], [ask]);
    assert.equal(plain(n.noticeLine(teams)), "Dana Lee asked you to review Add retry (PR 14231) in a 1:1 chat.");
    assert.equal(n.noticeLabel(teams), "Dana Lee's ask to review PR 14231");
    assert.match(n.noticeContext(teams), /Dana Lee asked in a 1:1 chat at .*: "pls look"/);

    const need = { key: "need:mail:1", source: "mail", id: "e", day: "2026-10-15", title: "Q3 review", kind: "you", people: ["Alex Kim"], needsYou: "send numbers", summary: "", lastAt: iso(-180), link: "" };
    const [mail] = m.needsItems([], [], [need]);
    assert.equal(plain(n.noticeLine(mail)), "Alex Kim is waiting on you by email about Q3 review.");
    assert.equal(n.noticeLabel(mail), "the email “Q3 review”");
    const [chat] = m.needsItems([], [], [{ ...need, key: "need:chat:1", source: "chat", kind: "oneOnOne", title: "Priya Shah", people: ["Priya Shah"] }]);
    assert.equal(plain(n.noticeLine(chat)), "Priya Shah is waiting on you in a 1:1 chat.");
    assert.equal(n.noticeLabel(chat), "your chat with Priya Shah");

    const item = {
        key: "0123456789abcdef", kpiId: "kpi-1", itemId: "item-1", targetType: "Service", targetId: "svc", title: "Rotate keys", sla: "OutOfSla",
        due: "2026-10-20T00:00:00.000Z", eta: "", status: "On it", statusBy: "kj", assignedTo: "dana", owner: "kj", service: "AppConfig", kind: "", severity: "",
        url: "https://aka.ms/guide", adoUrl: "", link: "https://s360.msftcloudes.com/blades/security?x=1", published: "", updated: "", roles: ["owner"],
        firstSeen: iso(-60), lastSeen: iso(-1), resolvedAt: null, need: true, dismissed: false,
    };
    const s360 = (over) => m.needsItems([], [], [], [{ key: "need:s360:0123456789abcdef", at: iso(-60), item: { ...item, ...over } }])[0];
    assert.equal(plain(n.noticeLine(s360({}))), "The S360 item Rotate keys is out of SLA.");
    assert.equal(plain(n.noticeLine(s360({ sla: "ApproachingSla" }))), "The S360 item Rotate keys is approaching its SLA.");
    assert.equal(plain(n.noticeLine(s360({ sla: "InSla" }))), "S360 has a new item for you: Rotate keys.");
    assert.equal(n.noticeLabel(s360({})), "the S360 item “Rotate keys”");
    const s360Ctx = n.noticeContext(s360({}));
    assert.match(s360Ctx, /S360 action item "Rotate keys" \(KPI kpi-1, item item-1\), on Service AppConfig\./, "Devis gets what and where");
    assert.match(s360Ctx, /SLA: OutOfSla, due 2026-10-20T00:00:00.000Z\. You're the action owner \(assigned to dana\); action owner kj\./);
    assert.match(s360Ctx, /Latest status \(kj\): On it/);
    assert.match(s360Ctx, /In S360: https:\/\/s360\.msftcloudes\.com\/blades\/security\?x=1\nGuidance: https:\/\/aka\.ms\/guide$/, "and its links, none empty");
}

// ---- when ----
assert.doesNotMatch(n.noticeTime(NOW - 30 * 60_000, NOW), /Yesterday/, "today's show the time");
assert.match(n.noticeTime(m.dayStart(NOW) - 3_600_000, NOW), /^Yesterday /);

console.log("needs-chat harness: ok");
