// The rows of a diff: gutter, old and new line numbers, sign, and highlighted code.
// Shared by PR review, which adds threads on top, and the worker code window.
import { highlightCode } from "./highlight.js";
import type { DiffLine } from "./types.js";

export interface DiffTable {
  table: HTMLTableElement;
  tbody: HTMLTableSectionElement;
  /** "side:line" to its row. Deleted lines use the left side, the rest the right. */
  rowByKey: Map<string, HTMLTableRowElement>;
}

export const diffRowKey = (side: string, line: number | string): string => `${side}:${line}`;

export function diffTable(hunks: DiffLine[][]): DiffTable {
  const table = document.createElement("table");
  table.className = "diff";
  const tbody = document.createElement("tbody");
  const rowByKey = new Map<string, HTMLTableRowElement>();
  hunks.forEach((hunk, hi) => {
    if (hi > 0) {
      const gap = document.createElement("tr");
      gap.className = "gap";
      gap.innerHTML = `<td colspan="5">⋯</td>`;
      tbody.appendChild(gap);
    }
    for (const ln of hunk) {
      const cls = ln.t === "add" ? "add" : ln.t === "del" ? "del" : "";
      const sign = ln.t === "add" ? "+" : ln.t === "del" ? "-" : "";
      const tr = document.createElement("tr");
      if (cls) tr.className = cls;
      const side = ln.nn != null ? "right" : "left";
      const line = ln.nn != null ? ln.nn : ln.o;
      if (line != null) {
        tr.dataset.line = String(line);
        tr.dataset.side = side;
        rowByKey.set(diffRowKey(side, line), tr);
      }
      tr.innerHTML =
        `<td class="gutter"></td>` +
        `<td class="ln">${ln.o || ""}</td>` +
        `<td class="ln">${ln.nn || ""}</td>` +
        `<td class="sign">${sign}</td>` +
        `<td class="code">${highlightCode(ln.text)}</td>`;
      tbody.appendChild(tr);
    }
  });
  table.appendChild(tbody);
  return { table, tbody, rowByKey };
}
