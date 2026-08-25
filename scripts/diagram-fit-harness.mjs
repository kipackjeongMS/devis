import assert from "node:assert/strict";
import { fitDiagramScale } from "../web/mermaid.js";

assert.equal(fitDiagramScale(1200, 600, 600, 500), 0.5, "wide diagrams should fit the pane width");
assert.equal(fitDiagramScale(400, 1200, 800, 600), 0.5, "tall diagrams should fit the pane height");
assert.equal(fitDiagramScale(400, 300, 800, 600), 1, "fit should not enlarge small diagrams");
assert.ok(
  fitDiagramScale(10000, 5000, 500, 400) < 0.25,
  "fit should shrink very large diagrams below the manual zoom limit",
);
assert.equal(fitDiagramScale(0, 300, 800, 600), 1, "invalid intrinsic dimensions should stay at 100%");
assert.equal(fitDiagramScale(400, 300, 0, 600), 1, "invalid viewport dimensions should stay at 100%");

console.log("Diagram fit harness passed");
