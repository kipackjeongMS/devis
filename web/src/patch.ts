// Patch a container to new HTML, keeping every node that didn't change.
//
// Polling views (Today, the Lead, a task's chat) used to replace innerHTML on
// every change. That rebuilds the whole subtree, so the browser restyles,
// re-lays out and repaints all of it, and hover, text selection and inner
// scroll positions reset each time. Patching touches only what differs.
//
// Children pair up by `data-key` when the new node has one, otherwise by
// position among unkeyed siblings of the same kind. When old and new carry the
// same `data-v`, the old node is kept untouched: use it for content whose key
// and version already say it can't have changed (a chat message's id and length).
//
// Form controls end up with the value the HTML describes, as innerHTML would
// leave them, but only change when that differs, so typing and the caret are
// left alone while the rendered value matches what's typed.

export function patchHtml(target: Element, html: string): void {
  const template = document.createElement("template");
  template.innerHTML = html;
  patchChildren(target, template.content);
}

function keyOf(node: Node): string | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element).getAttribute("data-key") : null;
}

function sameKind(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== Node.ELEMENT_NODE) return true;
  const ea = a as Element;
  const eb = b as Element;
  if (ea.namespaceURI !== eb.namespaceURI || ea.tagName !== eb.tagName) return false;
  // An input can't change type in place without surprises (value, checkedness).
  return ea.tagName !== "INPUT" || (ea as HTMLInputElement).type === (eb as HTMLInputElement).type;
}

function patchChildren(parent: Node, next: Node): void {
  const wanted = new Map<string, number>();
  for (let child = next.firstChild; child; child = child.nextSibling) {
    const key = keyOf(child);
    if (key !== null) wanted.set(key, (wanted.get(key) || 0) + 1);
  }
  // Keyed nodes that are gone go first, so every keyed node left gets claimed. A key that
  // repeats pairs up in order, and any extra copies go too.
  const keyed = new Map<string, Node[]>();
  for (let child = parent.firstChild; child; ) {
    const after: ChildNode | null = child.nextSibling;
    const key = keyOf(child);
    if (key !== null) {
      const list = keyed.get(key) || [];
      if (list.length >= (wanted.get(key) || 0)) parent.removeChild(child);
      else keyed.set(key, [...list, child]);
    }
    child = after;
  }
  // Everything before `cursor` is placed; what's left from `cursor` on is unclaimed.
  let cursor: ChildNode | null = parent.firstChild;
  for (let child = next.firstChild; child; ) {
    const following: ChildNode | null = child.nextSibling;
    const key = keyOf(child);
    let match: Node | null = null;
    if (key !== null) {
      const list = keyed.get(key);
      if (list?.length && sameKind(list[0], child)) match = list.shift()!;
    } else if (cursor && keyOf(cursor) === null && sameKind(cursor, child)) {
      // Unkeyed nodes match in order; a keyed node is only ever claimed by its key.
      match = cursor;
    }
    if (match) {
      if (match === cursor) cursor = cursor.nextSibling;
      else parent.insertBefore(match, cursor);
      patchNode(match, child);
    } else {
      parent.insertBefore(child, cursor);
    }
    child = following;
  }
  while (cursor) {
    const after: ChildNode | null = cursor.nextSibling;
    parent.removeChild(cursor);
    cursor = after;
  }
}

function patchNode(old: Node, next: Node): void {
  if (old.nodeType !== Node.ELEMENT_NODE) {
    if (old.nodeValue !== next.nodeValue) old.nodeValue = next.nodeValue;
    return;
  }
  const el = old as Element;
  const to = next as Element;
  const version = to.getAttribute("data-v");
  if (version !== null && el.getAttribute("data-v") === version) return;
  if (el.isEqualNode(to)) {
    // Same markup, but a control's live value can still differ from it (typed, then the draft was cleared).
    syncControl(el, to);
    syncControlsWithin(el, to);
    return;
  }
  for (const a of [...el.attributes]) if (!to.hasAttributeNS(a.namespaceURI, a.localName)) el.removeAttributeNS(a.namespaceURI, a.localName);
  for (const a of [...to.attributes]) if (el.getAttributeNS(a.namespaceURI, a.localName) !== a.value) el.setAttributeNS(a.namespaceURI, a.name, a.value);
  // Read what the control should hold first: patching the children moves new <option>s out of `to`.
  const want = wanted(to);
  if (el.tagName === "TEXTAREA") {
    const area = el as HTMLTextAreaElement;
    const text = (to as HTMLTextAreaElement).defaultValue;
    if (area.defaultValue !== text) area.defaultValue = text;
  } else {
    patchChildren(el, to);
  }
  apply(el, want);
}

const CONTROLS = "textarea, input, select";

/** Pair up the controls of two equal subtrees in order; content pinned by `data-v` is left alone. */
function syncControlsWithin(el: Element, to: Element): void {
  const have = el.querySelectorAll(CONTROLS);
  if (!have.length) return;
  const want = to.querySelectorAll(CONTROLS);
  for (let i = 0; i < have.length && i < want.length; i++) {
    const pinned = have[i].closest("[data-v]");
    if (pinned && el.contains(pinned)) continue;
    syncControl(have[i], want[i]);
  }
}

type Wanted = { checked: boolean } | { value: string } | null;

/** What a control in the new HTML holds, as innerHTML would leave it. */
function wanted(to: Element): Wanted {
  if (to.tagName === "TEXTAREA") return { value: (to as HTMLTextAreaElement).defaultValue };
  if (to.tagName === "INPUT") {
    const input = to as HTMLInputElement;
    if (input.type === "checkbox" || input.type === "radio") return { checked: input.defaultChecked };
    return input.type === "file" ? null : { value: input.defaultValue };
  }
  if (to.tagName === "SELECT") {
    const select = to as HTMLSelectElement;
    if (select.multiple) return null;
    // A single select shows its last option marked selected, or else its first.
    const options = [...select.options];
    const pick = options.filter((o) => o.defaultSelected).pop() ?? options[0];
    return pick ? { value: pick.value } : null;
  }
  return null;
}

/** Set a control to what it should hold, touching it only when that differs. */
function apply(el: Element, want: Wanted): void {
  if (!want) return;
  const control = el as HTMLInputElement;
  if ("checked" in want) {
    if (control.checked !== want.checked) control.checked = want.checked;
  } else if (control.value !== want.value) {
    control.value = want.value;
  }
}

/** Leave a control holding the value the HTML describes. */
function syncControl(el: Element, to: Element): void {
  apply(el, wanted(to));
}
