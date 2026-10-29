// The task sheet's drag handle: the share it sets stays within both panels' minimums, the keys
// move it in steps, and only a real share is ever read back from storage.
import assert from "node:assert/strict";

const s = await import("../web/splitter.js");

// ---- limits ----
assert.equal(s.clampShare(0.5, 1000, 340, 380), 0.5);
assert.equal(s.clampShare(0.1, 1000, 340, 380), 0.34, "the task panel keeps its minimum");
assert.equal(s.clampShare(0.9, 1000, 340, 380), 0.62, "and so does the chat");
assert.equal(s.clampShare(0.5, 600, 340, 380), 340 / 600, "too narrow for both: the task panel's minimum wins");
assert.equal(s.clampShare(1.4, 0, 340, 380), 1, "unmeasured: just kept within 0–1");
assert.equal(s.clampShare(-1, 0, 340, 380), 0);

// ---- keys ----
assert.equal(s.shareForKey(0.5, "ArrowLeft", false), 0.5 - s.SPLIT_STEP);
assert.equal(s.shareForKey(0.5, "ArrowRight", false), 0.5 + s.SPLIT_STEP);
assert.equal(s.shareForKey(0.5, "ArrowRight", true), 0.5 + s.SPLIT_STEP_LARGE, "Shift moves further");
assert.equal(s.shareForKey(0.5, "Home", false), 0, "Home: as narrow as the task panel goes (clamped after)");
assert.equal(s.shareForKey(0.5, "End", false), 1);
assert.equal(s.shareForKey(0.5, "a", false), null, "other keys don't move it");
assert.equal(s.shareForKey(0.5, "ArrowUp", false), null);

// ---- what's saved ----
assert.equal(s.parseShare("0.4200"), 0.42);
for (const bad of [null, "", "0", "1", "1.2", "-0.1", "abc", "NaN"]) assert.equal(s.parseShare(bad), null, `not a share: ${bad}`);

console.log("splitter harness: ok");
