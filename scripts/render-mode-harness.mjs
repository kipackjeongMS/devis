// Render mode: the page draws lean (no backdrop blur) without a GPU. The shell's word wins;
// otherwise a WebGL probe decides, and only then.
import assert from "node:assert/strict";

const r = await import("../web/renderMode.js");

for (const renderer of [
    "Google SwiftShader",
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
    "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "llvmpipe (LLVM 15.0.7, 256 bits)",
]) {
    assert.equal(r.isSoftwareRenderer(renderer), true, `software: ${renderer}`);
}
for (const renderer of ["ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)", "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", "Apple M2", ""]) {
    assert.equal(r.isSoftwareRenderer(renderer), false, `hardware: ${renderer || "(unknown)"}`);
}

let probes = 0;
const probe = (answer) => () => {
    probes++;
    return answer;
};
assert.equal(r.pickRenderMode("lean", probe(false)), "lean");
assert.equal(r.pickRenderMode("full", probe(true)), "full");
assert.equal(probes, 0, "the shell's word needs no probe");
assert.equal(r.pickRenderMode(null, probe(true)), "lean");
assert.equal(r.pickRenderMode(null, probe(false)), "full");
assert.equal(r.pickRenderMode("bogus", probe(true)), "lean", "anything else asks the probe");
assert.equal(probes, 3);

console.log("render-mode harness: ok");
