// Who opened a PR, for the detail head — no DOM, so harnesses can import it.
import { esc, timeAgo } from "./util.js";

// "Ada Lovelace" -> "AL"; ADO prefixes such as "[org]\" are ignored.
export function initials(name: string): string {
  const words = name.replace(/^\[[^\]]*\]\\?/, "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = words[0][0] || "";
  const last = words.length > 1 ? words[words.length - 1][0] || "" : "";
  return (first + last).toUpperCase();
}

/** Author chip for the detail meta line ("[AL] Ada Lovelace opened 3d ago"); "" when unknown. */
export function prAuthorMarkup(author: string | undefined, created: string | undefined): string {
  const name = (author || "").trim();
  if (!name) return "";
  const date = created ? new Date(created) : null;
  const dated = !!date && !isNaN(date.getTime());
  const title = dated ? `Opened by ${name} on ${date!.toLocaleString()}` : `Opened by ${name}`;
  const when = dated
    ? `<span class="detail-author-when">opened ${esc(timeAgo(created))}</span>`
    : `<span class="visually-hidden">, author</span>`;
  return (
    `<span class="detail-author" title="${esc(title)}">` +
    `<span class="persona" aria-hidden="true">${esc(initials(name))}</span>` +
    `<span class="detail-author-name">${esc(name)}</span>${when}</span>`
  );
}
