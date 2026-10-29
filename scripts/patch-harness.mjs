// web/patch.js in a real Chromium (a hidden Electron window): patching a container
// must leave exactly the DOM that innerHTML would, keep every node it can, keep
// typing and focus, and change nothing when patched again with the same HTML.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const electron = (await import("electron")).default;

function inPage() {
  const fails = [];
  const check = (name, cond) => {
    if (!cond) fails.push(name);
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const canon = (node) =>
    [...node.childNodes]
      .map((n) =>
        n.nodeType === 1
          ? `<${n.namespaceURI}:${n.tagName} ${[...n.attributes].map((a) => a.name + "=" + a.value).sort().join(" ")}>${canon(n)}</>`
          : n.nodeType + ":" + n.nodeValue
      )
      .join("");
  const values = (root) => [...root.querySelectorAll("textarea, input, select")].map((e) => (e.type === "checkbox" ? e.checked : e.value));

  // ---- property: random valid trees, and small edits of them (what polling produces) ----
  const property = (seed, iters, edits) => {
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const attrs = () =>
      (rnd() < 0.4 ? ` data-key="k${Math.floor(rnd() * 6)}"` : "") +
      (rnd() < 0.4 ? ` class="${pick(["a", "b", "a b", ""])}"` : "") +
      (rnd() < 0.2 ? ` title="${pick(["t1", "t2"])}"` : "") +
      (rnd() < 0.1 ? " hidden" : "");
    const inline = () => pick(["hello", "world", "x", " ", `<b${attrs()}>${pick(["bold", "b2"])}</b>`, `<span${attrs()}>${pick(["s1", "s2"])}</span>`]);
    const gen = (depth) => {
      let out = "";
      for (let i = Math.floor(rnd() * (depth > 2 ? 2 : 5)); i > 0; i--) {
        const r = rnd();
        if (r < 0.25) out += inline();
        else if (r < 0.3) out += `<!--c${Math.floor(rnd() * 3)}-->`;
        else if (r < 0.38) {
          const id = Math.floor(rnd() * 4);
          out += `<div class="msg" data-key="m:${id}" data-v="${id}"><p>message ${id}</p><pre>code</pre></div>`;
        } else {
          const tag = pick(["div", "section", "article", "p", "button", "textarea", "input", "svg", "select", "ul"]);
          const a = attrs();
          if (tag === "p") out += `<p${a}>${inline()}${inline()}</p>`;
          else if (tag === "button") out += `<button${a}>${pick(["Go", "", "<span>Go</span>"])}</button>`;
          else if (tag === "ul") out += `<ul${a}>${Array.from({ length: Math.floor(rnd() * 4) }, () => `<li${attrs()}>${inline()}</li>`).join("")}</ul>`;
          else if (tag === "input")
            out += `<input type="${pick(["text", "checkbox"])}"${a}${rnd() < 0.5 ? ` value="v${Math.floor(rnd() * 2)}"` : ""}${rnd() < 0.3 ? " checked" : ""}>`;
          else if (tag === "textarea") out += `<textarea${a}>${pick(["", "draft", "other"])}</textarea>`;
          else if (tag === "select") {
            // Options come and go, so a new option can be the selected one.
            const values = [0, 1, 2, 3, 4].filter(() => rnd() < 0.6);
            if (!values.length) values.push(Math.floor(rnd() * 5));
            const s = values[Math.floor(rnd() * values.length)];
            out += `<select${a}>${values.map((o) => `<option value="o${o}"${o === s && rnd() < 0.7 ? " selected" : ""}>o${o}</option>`).join("")}</select>`;
          } else if (tag === "svg") out += `<svg${a} viewBox="0 0 16 16"><path d="${pick(["M1 1", "M2 2"])}"></path>${rnd() < 0.5 ? '<circle r="1"></circle>' : ""}</svg>`;
          else out += `<${tag}${a}>${gen(depth + 1)}</${tag}>`;
        }
      }
      return out;
    };
    const ref = document.createElement("div");
    let reused = 0;
    let total = 0;
    for (let i = 0; i < iters && fails.length < 3; i++) {
      const a = gen(0);
      const b =
        edits && rnd() < 0.7
          ? a.replace(/hello|world/, pick(["hello", "world", "changed"])).replace(/class="a"/, 'class="b"').replace(/>draft</, ">other<")
          : gen(0);
      host.innerHTML = a;
      const old = new Set(host.querySelectorAll("*"));
      for (const e of host.querySelectorAll("textarea, input[type=text]")) e.value = "typed";
      for (const e of host.querySelectorAll("input[type=checkbox]")) e.checked = !e.checked;
      for (const e of host.querySelectorAll("select")) e.selectedIndex = (e.selectedIndex + 1) % e.options.length;
      patchHtml(host, b);
      ref.innerHTML = b;
      for (const n of host.querySelectorAll("*")) {
        total++;
        if (old.has(n)) reused++;
      }
      if (canon(host) !== canon(ref)) fails.push(`same DOM as innerHTML (#${i})\nA=${a}\nB=${b}\nGOT=${host.innerHTML}`);
      else if (JSON.stringify(values(host)) !== JSON.stringify(values(ref))) fails.push(`controls hold the rendered values (#${i})\nB=${b}`);
      else {
        const before = [...host.querySelectorAll("*"), ...host.childNodes];
        patchHtml(host, b);
        const after = [...host.querySelectorAll("*"), ...host.childNodes];
        if (before.length !== after.length || before.some((n, j) => n !== after[j])) fails.push(`patching again changes nothing (#${i})\nB=${b}`);
      }
    }
    return Math.round((reused / total) * 100);
  };
  property(31, 4000, false);
  const reusedOnEdits = property(101, 4000, true);
  check(`small edits keep most nodes (${reusedOnEdits}%)`, reusedOnEdits >= 50);

  // ---- keyed nodes move instead of being rebuilt ----
  host.innerHTML = '<p data-key="a">A</p><p data-key="b">B</p><p data-key="c">C</p>';
  const [pa, pb, pc] = host.children;
  patchHtml(host, '<p data-key="c">C</p><p data-key="a">A2</p><p data-key="b">B</p>');
  check("a reorder keeps the nodes", host.children[0] === pc && host.children[1] === pa && host.children[2] === pb && pa.textContent === "A2");
  patchHtml(host, '<p data-key="a">A2</p><p data-key="d">D</p>');
  check("gone keys go, new keys come", host.children.length === 2 && host.children[0] === pa && host.children[1].textContent === "D" && !pb.isConnected);
  host.innerHTML = '<p data-key="x">1</p><p data-key="x">2</p>';
  const [x1, x2] = host.children;
  patchHtml(host, '<p data-key="x">1</p><p data-key="x">2b</p>');
  check("a repeated key pairs up in order", host.children[0] === x1 && host.children[1] === x2 && x2.textContent === "2b");

  // ---- one changed text, nothing else touched ----
  host.innerHTML = "<div><span>one</span><span>two</span></div>";
  const one = host.querySelector("span");
  const two = host.querySelectorAll("span")[1].firstChild;
  patchHtml(host, "<div><span>one</span><span>three</span></div>");
  check("only the changed text node changes", host.querySelector("span") === one && host.querySelectorAll("span")[1].firstChild === two && two.nodeValue === "three");

  // ---- data-v pins a node ----
  host.innerHTML = '<div data-key="m1" data-v="3">old</div>';
  const pinned = host.firstElementChild;
  pinned.appendChild(document.createElement("em"));
  patchHtml(host, '<div data-key="m1" data-v="3">new</div>');
  check("the same version is left alone", host.firstElementChild === pinned && pinned.querySelector("em"));
  patchHtml(host, '<div data-key="m1" data-v="4">new</div>');
  check("a new version updates it", host.firstElementChild === pinned && pinned.innerHTML === "new");

  // ---- typing, caret and focus ----
  host.innerHTML = '<form><textarea data-draft="d">abc</textarea></form>';
  const area = host.querySelector("textarea");
  area.focus();
  area.value = "abcd";
  area.setSelectionRange(2, 2);
  patchHtml(host, '<form><textarea data-draft="d">abcd</textarea></form>');
  check("typing and the caret survive a matching render", host.querySelector("textarea") === area && area.value === "abcd" && area.selectionStart === 2 && document.activeElement === area);
  host.innerHTML = "<form><textarea></textarea><button>Send</button></form>";
  const sent = host.querySelector("textarea");
  sent.value = "typed but never rendered";
  patchHtml(host, "<form><textarea></textarea><button>Send</button></form>");
  check("a cleared draft clears the box even when the markup is unchanged", sent.value === "");
  host.innerHTML = '<button data-act="x">Go</button>';
  const button = host.firstChild;
  button.focus();
  patchHtml(host, '<button data-act="x" disabled>Going</button>');
  check("a button keeps focus while its label changes", host.firstChild === button && button.textContent === "Going");
  host.innerHTML = '<input type="text">';
  const text = host.firstChild;
  patchHtml(host, '<input type="checkbox">');
  check("an input that changes type is replaced", host.firstChild !== text && host.firstChild.type === "checkbox");
  host.innerHTML = '<select><option value="a">a</option></select>';
  const select = host.firstChild;
  patchHtml(host, '<select><option value="a">a</option><option value="b" selected>b</option></select>');
  check("a select picks a newly added selected option", host.firstChild === select && select.value === "b");
  // The parser drops one newline right after <textarea>: a sacrificial one keeps a leading blank line.
  host.innerHTML = "<textarea data-draft=\"n\">\n\nline</textarea>";
  const leading = host.firstChild;
  leading.focus();
  leading.setSelectionRange(0, 0);
  patchHtml(host, "<textarea data-draft=\"n\">\n\nline</textarea>");
  check("a leading blank line and the caret before it survive a render", host.firstChild === leading && leading.value === "\nline" && leading.selectionStart === 0);

  host.remove();
  return { ok: fails.length === 0, fails };
}

const dir = mkdtempSync(join(tmpdir(), "patch-harness-"));
try {
  const source = readFileSync(join(repo, "web", "patch.js"), "utf8").replace(/^export /gm, "");
  writeFileSync(join(dir, "page.js"), `${source}\n;(${inPage.toString()})()`);
  writeFileSync(
    join(dir, "main.cjs"),
    `const { app, BrowserWindow } = require("electron");
     const { readFileSync } = require("fs");
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
       await win.loadURL("about:blank");
       try {
         const result = await win.webContents.executeJavaScript(readFileSync(${JSON.stringify(join(dir, "page.js"))}, "utf8"));
         process.stdout.write("RESULT " + JSON.stringify(result) + "\\n");
       } catch (error) {
         process.stdout.write("RESULT " + JSON.stringify({ ok: false, fails: [String(error && error.message || error)] }) + "\\n");
       }
       app.exit(0);
     });`
  );
  const run = spawnSync(electron, [join(dir, "main.cjs")], { encoding: "utf8", timeout: 120_000, env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" } });
  const line = (run.stdout || "").split(/\r?\n/).find((l) => l.startsWith("RESULT "));
  assert.ok(line, `Electron ran the page (exit ${run.status}): ${run.stderr || run.stdout}`);
  const result = JSON.parse(line.slice("RESULT ".length));
  assert.deepEqual(result.fails, [], result.fails.join("\n\n"));
  console.log("patch harness: ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
