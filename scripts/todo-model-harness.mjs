// Tests the to-dos' page-free rules (web/src/todoModel.ts): the subtask tree, due dates and how they
// read, the filters and the rows each one shows, how a start splits to-dos across workers, and where
// a move puts a to-do. Run after `npm run build:web`: node scripts/todo-model-harness.mjs
import assert from "node:assert/strict";
import {
  addDays,
  ancestors,
  canMove,
  childrenOf,
  daysBetween,
  depths,
  descendants,
  dueInfo,
  filterCounts,
  inFilter,
  isDayKey,
  isTodoFilter,
  MAX_WORKERS,
  movedTodos,
  movePeers,
  nextMonday,
  priorityName,
  progress,
  shortDay,
  splitBlocked,
  splitGroups,
  todayKey,
  topPicks,
  visibleRows,
} from "../web/todoModel.js";

const todo = (id, text, more = {}) => ({
  id,
  text,
  done: false,
  author: "you",
  createdAt: "2025-05-01T09:00:00.000Z",
  updatedAt: "2025-05-01T09:00:00.000Z",
  doneAt: null,
  parentId: null,
  due: null,
  priority: 0,
  taskId: null,
  ...more,
});

// Wednesday, May 14 2025. The list in the server's order: open top-level by priority, each with its
// subtasks depth first, then the done top-level ones.
const today = "2025-05-14";
const list = [
  todo(1, "Ship the release", { priority: 3, due: "2025-05-14" }),
  todo(2, "Write the notes", { parentId: 1, due: "2025-05-13" }),
  todo(3, "Draft the summary", { parentId: 2, done: true }),
  todo(4, "Tag the build", { parentId: 1 }),
  todo(5, "Review the PR", { priority: 3 }),
  todo(6, "Email Sam", { due: "2025-05-20" }),
  todo(7, "Old chore", { done: true, due: "2025-05-01" }),
];
const ids = (todos) => todos.map((t) => t.id);
const rowIds = (rows) => rows.map((r) => r.todo.id);

// ---- priorities ----
assert.equal(priorityName(3), "High");
assert.equal(priorityName(2), "Medium");
assert.equal(priorityName(1), "Low");
assert.equal(priorityName(0), "", "no priority, no name");
assert.equal(MAX_WORKERS, 8);

// ---- the tree ----
const kids = childrenOf(list);
assert.deepEqual(ids(kids.get(null)), [1, 5, 6, 7]);
assert.deepEqual(ids(kids.get(1)), [2, 4]);
assert.deepEqual(ids(kids.get(2)), [3]);
assert.equal(kids.get(5), undefined);
const orphan = [todo(10, "Lost", { parentId: 99 })];
assert.deepEqual(ids(childrenOf(orphan).get(null)), [10], "a subtask whose parent isn't listed shows at the top");

const depth = depths(list);
assert.deepEqual([1, 2, 3, 4, 5].map((id) => depth.get(id)), [0, 1, 2, 1, 0]);
assert.deepEqual(ancestors(list, 3), [2, 1], "nearest first");
assert.deepEqual(ancestors(list, 1), []);
assert.deepEqual(ids(descendants(list, 1)), [2, 3, 4], "any depth, in list order");
assert.deepEqual(descendants(list, 5), []);

// A parent loop (bad data) never hangs.
const loop = [todo(20, "A", { parentId: 21 }), todo(21, "B", { parentId: 20 })];
assert.deepEqual(ancestors(loop, 20), [21]);
assert.equal(depths(loop).size, 2);

assert.deepEqual(progress(list, 1), { done: 1, total: 3 }, "counts subtasks at every depth");
assert.deepEqual(progress(list, 2), { done: 1, total: 1 });
assert.equal(progress(list, 5), null, "no subtasks, no progress");

assert.deepEqual(ids(topPicks(list, new Set([3, 1, 5]))), [1, 5], "a pick inside another pick folds into it");
assert.deepEqual(ids(topPicks(list, new Set([3, 4]))), [3, 4], "siblings and cousins stay separate");
assert.deepEqual(topPicks(list, new Set()), []);

// ---- due dates ----
assert.equal(todayKey(new Date(2025, 4, 14, 23, 59)), "2025-05-14", "the user's own calendar day");
assert.equal(todayKey(new Date(2025, 0, 2, 0, 1)), "2025-01-02");
assert.equal(isDayKey("2025-05-14"), true);
assert.equal(isDayKey("2025-5-14"), false);
assert.equal(isDayKey("2025-05-14T00:00"), false);
assert.equal(isDayKey(null), false);
assert.equal(addDays(today, 1), "2025-05-15");
assert.equal(addDays("2025-02-28", 1), "2025-03-01");
assert.equal(addDays("2024-12-31", 1), "2025-01-01");
assert.equal(addDays("2025-03-01", -1), "2025-02-28");
assert.equal(nextMonday(today), "2025-05-19", "Wednesday to the coming Monday");
assert.equal(nextMonday("2025-05-18"), "2025-05-19", "Sunday to tomorrow");
assert.equal(nextMonday("2025-05-19"), "2025-05-26", "a Monday to the one a week on");
assert.equal(daysBetween(today, "2025-05-13"), -1);
assert.equal(daysBetween(today, "2025-06-14"), 31);
assert.equal(daysBetween("2025-03-08", "2025-03-10"), 2, "whole days across a daylight-saving change");
assert.equal(daysBetween("2025-10-25", "2025-10-27"), 2);
assert.equal(shortDay("2025-05-21", today), "May 21");
assert.equal(shortDay("2026-01-02", today), "Jan 2, 2026", "another year shows the year");

const due = (d, done = false) => dueInfo(d, today, done);
assert.deepEqual(due(today), { label: "Today", tone: "today", title: "Due Wednesday, May 14" });
assert.deepEqual([due("2025-05-15").label, due("2025-05-15").tone], ["Tomorrow", "soon"]);
assert.deepEqual(due("2025-05-13"), { label: "Yesterday", tone: "over", title: "Overdue: was due Tuesday, May 13" });
assert.deepEqual([due("2025-05-11").label, due("2025-05-11").tone], ["3 days ago", "over"]);
assert.equal(due("2025-05-08").label, "6 days ago");
assert.equal(due("2025-05-07").label, "May 7", "a week or more back reads as a date");
assert.deepEqual([due("2025-05-16").label, due("2025-05-16").tone], ["Friday", "soon"]);
assert.deepEqual([due("2025-05-20").label, due("2025-05-20").tone], ["Tuesday", "soon"]);
assert.deepEqual([due("2025-05-21").label, due("2025-05-21").tone], ["May 21", "later"], "a week or more on reads as a date");
assert.deepEqual(due("2025-05-13", true), { label: "Yesterday", tone: "done", title: "Was due Tuesday, May 13" }, "a done one's date is a record");

// ---- filters ----
assert.equal(isTodoFilter("overdue"), true);
assert.equal(isTodoFilter("soon"), false);
assert.equal(inFilter(list[0], "today", today), true);
assert.equal(inFilter(list[1], "overdue", today), true);
assert.equal(inFilter(list[5], "upcoming", today), true);
assert.equal(inFilter(list[4], "upcoming", today), false, "no date, not upcoming");
assert.equal(inFilter(list[6], "overdue", today), false, "a done one is never overdue");
assert.equal(inFilter(list[6], "all", today), false, "All is the open ones");
assert.deepEqual(filterCounts(list, today), { all: 5, today: 1, overdue: 1, upcoming: 1, done: 2 });

const view = (more = {}) => ({ filter: "all", query: "", folded: new Set(), today, ...more });

let rows = visibleRows(list, view());
assert.deepEqual(rowIds(rows.open), [1, 2, 3, 4, 5, 6], "the open tree keeps a done subtask in place");
assert.deepEqual(rowIds(rows.done), [7]);
assert.deepEqual(rows.open.map((r) => r.depth), [0, 1, 2, 1, 0, 0]);
assert.deepEqual(rows.open.map((r) => r.parent), [true, true, false, false, false, false]);
assert.ok(rows.open.every((r) => !r.context && !r.folded));

rows = visibleRows(list, view({ folded: new Set([1]) }));
assert.deepEqual(rowIds(rows.open), [1, 5, 6], "folding hides the subtasks at every depth");
assert.equal(rows.open[0].folded, true);
rows = visibleRows(list, view({ folded: new Set([2]) }));
assert.deepEqual(rowIds(rows.open), [1, 2, 4, 5, 6]);
rows = visibleRows(list, view({ folded: new Set([5]) }));
assert.equal(rows.open.find((r) => r.todo.id === 5).folded, false, "nothing to fold, not folded");

rows = visibleRows(list, view({ filter: "overdue", folded: new Set([1]) }));
assert.deepEqual(rowIds(rows.open), [1, 2], "a match shows under its parent, even folded");
assert.deepEqual(rows.open.map((r) => r.context), [true, false], "the parent is context, not a match");
assert.ok(rows.open.every((r) => !r.folded), "folds are off while filtered");
assert.deepEqual(rows.done, []);

rows = visibleRows(list, view({ filter: "done" }));
assert.deepEqual(rowIds(rows.open), [1, 2, 3], "a done subtask brings its open parents as context");
assert.deepEqual(rows.open.map((r) => r.context), [true, true, false]);
assert.deepEqual(rowIds(rows.done), [7]);

rows = visibleRows(list, view({ query: "  THE  " }));
assert.deepEqual(rowIds(rows.open), [1, 2, 3, 4, 5], "search ignores case and the spaces round it");
rows = visibleRows(list, view({ query: "draft" }));
assert.deepEqual(rowIds(rows.open), [1, 2, 3], "a search under All finds done ones too, in place");
assert.deepEqual(rows.open.map((r) => r.context), [true, true, false]);
rows = visibleRows(list, view({ query: "chore" }));
assert.deepEqual([rowIds(rows.open), rowIds(rows.done)], [[], [7]]);
rows = visibleRows(list, view({ filter: "today", query: "notes" }));
assert.deepEqual(rowIds(rows.open), [], "a filter and a search both have to match");
rows = visibleRows(list, view({ filter: "today", query: "ship" }));
assert.deepEqual(rowIds(rows.open), [1]);

// ---- starting a task ----
const five = [1, 2, 3, 4, 5];
assert.deepEqual(splitGroups(five, "one"), [five]);
assert.deepEqual(splitGroups(five, "each"), [[1], [2], [3], [4], [5]]);
assert.deepEqual(splitGroups(five, "chunk", 2), [[1, 2], [3, 4], [5]], "n to a worker, the rest to the last");
assert.deepEqual(splitGroups(five, "workers", 2), [[1, 3, 5], [2, 4]], "shared round-robin");
assert.deepEqual(splitGroups(five, "workers", 9), [[1], [2], [3], [4], [5]], "never more workers than to-dos");
assert.deepEqual(splitGroups(five, "chunk", 0), splitGroups(five, "each"), "a bad n counts as 1");
assert.deepEqual(splitGroups(five, "chunk", 2.7), splitGroups(five, "chunk", 2));
assert.deepEqual(splitGroups([], "each"), []);
assert.equal(splitBlocked("one", 100, 1), "");
assert.equal(splitBlocked("each", 8, 2), "", "eight workers is the most");
assert.match(splitBlocked("each", 9, 2), /9 workers; a start can ask for 8 at most/);
assert.match(splitBlocked("chunk", 17, 2), /9 workers/);
assert.equal(splitBlocked("chunk", 16, 2), "");
assert.equal(splitBlocked("workers", 20, 8), "");
assert.match(splitBlocked("workers", 20, 9), /9 workers/);

// ---- moving ----
const byId = (id) => list.find((t) => t.id === id);
assert.deepEqual(ids(movePeers(list, byId(1))), [1, 5], "top-level ones move among their priority");
assert.deepEqual(ids(movePeers(list, byId(4))), [2, 4], "a subtask moves among its siblings");
assert.deepEqual(movePeers(list, byId(7)), [], "a done top-level one keeps its place");
assert.equal(canMove(list, byId(1), "up"), false);
assert.equal(canMove(list, byId(1), "down"), true);
assert.equal(canMove(list, byId(5), "down"), false, "not past a lower priority");
assert.equal(canMove(list, byId(6), "up"), false);
assert.equal(canMove(list, byId(2), "up"), false);
assert.equal(canMove(list, byId(2), "down"), true);
assert.equal(canMove(list, byId(3), "up"), false, "an only child stays");
assert.equal(canMove(list, byId(7), "up"), false);
assert.deepEqual(ids(movedTodos(list, 5, "up")), [5, 1, 2, 3, 4, 6, 7], "a to-do moves with its subtasks");
assert.deepEqual(ids(movedTodos(list, 1, "down")), [5, 1, 2, 3, 4, 6, 7]);
assert.deepEqual(ids(movedTodos(list, 4, "up")), [1, 4, 2, 3, 5, 6, 7], "a subtask swaps with its sibling and its subtree");
const unmoved = movedTodos(list, 6, "up");
assert.deepEqual(ids(unmoved), ids(list), "a move that can't happen changes nothing");
assert.notEqual(unmoved, list, "and still hands back a copy");
assert.deepEqual(ids(movedTodos(list, 99, "up")), ids(list));

console.log("todo-model harness: ok");
