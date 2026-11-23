// The light theme's contracts, without a window: the shell's pref and frame colors, the theme
// shell request, the page's pref resolution, that every color token has a light value, and that
// every page sets the theme before it paints. theme-ui-harness.mjs covers the live switch.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

// ---- shell ----
const shellTheme = await import("../theme.mjs");
assert.equal(shellTheme.themePrefOf("light"), "light");
assert.equal(shellTheme.themePrefOf("system"), "system");
assert.equal(shellTheme.themePrefOf("dark"), "dark");
for (const junk of [undefined, null, "", "Light", "blue", 1]) assert.equal(shellTheme.themePrefOf(junk), "dark", `unknown pref ${junk} falls back to dark`);
assert.deepEqual(shellTheme.frameColors(true, false), { background: "#050505", overlay: "#050505", symbol: "#f2f2f2" });
assert.deepEqual(shellTheme.frameColors(false, false), { background: "#ebebeb", overlay: "#ebebeb", symbol: "#1b1b1b" });
assert.deepEqual(shellTheme.frameColors(false, true), { background: "#00000000", overlay: "#00000000", symbol: "#1b1b1b" }, "glass keeps the frame clear");
assert.match(shellTheme.themeScript("light"), /^window\.dispatchEvent\(new CustomEvent\("devis:theme", \{ detail: "light" \}\)\)$/);

const { shellRequest } = await import("../shell-request.mjs");
const origin = "http://127.0.0.1:4321";
assert.deepEqual(shellRequest(`${origin}/?shell-request=theme&value=light`, origin), { kind: "theme", value: "light" });
assert.deepEqual(shellRequest(`${origin}/?shell-request=theme&value=system`, origin), { kind: "theme", value: "system" });
assert.equal(shellRequest(`${origin}/?shell-request=theme&value=neon`, origin), null, "an unknown theme isn't a request");
assert.equal(shellRequest(`${origin}/?shell-request=theme`, origin), null);
assert.equal(shellRequest(`https://evil.example/?shell-request=theme&value=light`, origin), null);

const main = await read("../src/main.mts");
assert.match(main, /searchParams\.set\("theme", themePref\)/, "every page loads with the shell's pref");
assert.match(main, /request\.kind === "theme"\) setTheme\(request\.value\)/);
assert.match(main, /theme\.json/, "the pref is saved with the shell, not in per-port page storage");
assert.match(main, /nativeTheme\.on\("updated"/, "the frame repaints when Windows changes theme");

// ---- page ----
const page = await import("../web/theme.js");
assert.deepEqual(page.THEME_PREFS.map((p) => p.value), ["dark", "light", "system"]);
assert.equal(page.THEME_PREFS[2].label, "Use Windows setting");
assert.equal(page.resolveTheme("dark", true), "dark");
assert.equal(page.resolveTheme("light", false), "light");
assert.equal(page.resolveTheme("system", true), "light");
assert.equal(page.resolveTheme("system", false), "dark");
assert.equal(page.themePrefOf("nope"), "dark");

const { mermaidThemeFor } = await import("../web/mermaid.js");
assert.equal(mermaidThemeFor("dark"), "dark");
assert.equal(mermaidThemeFor("light"), "neutral");

const boot = await read("../web/themeBoot.js");
assert.doesNotMatch(boot, /^\s*(import|export)\b/m, "themeBoot.js is a classic script");

for (const name of ["index", "code", "todos", "artifacts", "design-system"]) {
    const html = await read(`../web/${name}.html`);
    const head = html.slice(0, html.indexOf("</head>"));
    assert.match(head, /<meta name="color-scheme" content="dark"\s*\/?>/, `${name}.html declares its color scheme`);
    assert.match(head, /<script src="themeBoot\.js"><\/script>/, `${name}.html sets the theme before it paints`);
}

// ---- tokens ----
const css = await read("../web/style.css");
const block = (selector) => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, `${selector} exists`);
    return css.slice(start, css.indexOf("\n}", start));
};
const props = (text) => new Map([...text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const dark = props(block(":root"));
const light = props(block(':root[data-theme="light"]'));
const colorish = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|color-mix|^\d+ \d+ \d+$|brightness|var\(--/i;
// Shared on purpose: it points at --ink, which light redefines.
const SHARED = new Set(["--field-base"]);
const missing = [...dark].filter(([name, value]) => colorish.test(value) && !light.has(name) && !SHARED.has(name)).map(([name]) => name);
assert.deepEqual(missing, [], `color tokens without a light value: ${missing.join(", ")}`);
for (const name of light.keys()) assert.ok(dark.has(name), `${name} has a dark value in :root too`);
assert.equal(light.get("--text-1"), "#1b1b1b");
assert.equal(light.get("--accent"), "#0078a8");
assert.equal(light.get("--hi"), "0 0 0");
assert.match(css, /html\.lean\[data-theme="light"\]\s*\{/, "the lean renderer gets opaque light chrome");
assert.match(css, /prefers-reduced-transparency: reduce\)\s*\{[\s\S]*?:root\[data-theme="light"\]\s*\{/, "reduced transparency has an opaque light set");

// Colors come from tokens, so the light block reaches them; only the accent buttons' white top edges stay literal.
const outsideTokens = css.replace(/(^|\n):root[^{]*\{[\s\S]*?\n\}/g, "");
assert.doesNotMatch(outsideTokens, /76\s*,\s*214\s*,\s*255/, "the dark accent's rgb isn't hard-coded outside its token");
const whites = [...outsideTokens.matchAll(/^([^\n{]*)\{[^}]*rgba?\(\s*255\s*,\s*255\s*,\s*255/gm)].map((m) => m[1].trim());
assert.deepEqual(whites.sort(), [".chain-block-action", ".cw-askpill", ".rev-chat-send"], `white literals outside tokens: ${whites.join(", ")}`);
const responsive = await read("../web/responsive.css");
assert.doesNotMatch(responsive, /#[0-9a-f]{6}\b/i, "responsive.css uses tokens");

console.log("theme-harness: ok");
