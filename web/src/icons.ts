// The app's 16px line-icon set (replaces emoji glyphs). Every icon is a stroked
// path drawn with `currentColor`; `svg.ic` scopes fill/stroke in style.css so a
// filled-icon rule on a parent button can never turn these outlines solid.

const PATHS = {
  check: '<path d="M3.5 8.5 6.5 11.5 12.5 4.5"/>',
  dismiss: '<path d="M4 4l8 8M12 4l-8 8"/>',
  clock: '<circle cx="8" cy="8" r="5.75"/><path d="M8 5v3.25l2 1.25"/>',
  chat: '<path d="M2.75 3.25h10.5v7.5H7l-3 2.5v-2.5H2.75z"/>',
  person: '<circle cx="8" cy="5.25" r="2.5"/><path d="M3 13.25c.6-2.4 2.6-3.75 5-3.75s4.4 1.35 5 3.75"/>',
  sync: '<path d="M13.25 3.75V7H10"/><path d="M12.9 7a5 5 0 1 0-1.4 4.55"/>',
  warning: '<path d="M8 2.25 14.25 13.25H1.75z"/><path d="M8 6.5v3M8 11.4v.01"/>',
  reply: '<path d="M6.5 4 3 7.5 6.5 11"/><path d="M3 7.5h6.5a3.5 3.5 0 0 1 3.5 3.5v1"/>',
  circle: '<circle cx="8" cy="8" r="5.5"/>',
  sparkle:
    '<path d="M7 2.5c.45 2.75 1.3 3.6 4 4-2.7.4-3.55 1.25-4 4-.45-2.75-1.3-3.6-4-4 2.7-.4 3.55-1.25 4-4z"/>' +
    '<path d="M12.25 10.25v3M10.75 11.75h3"/>',
  tray: '<path d="M2.5 9.5h3l1 1.5h3l1-1.5h3"/><path d="M4 3.5h8l1.5 6v3h-11v-3z"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-1.5a1 1 0 0 0-1-1h-5.5a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h1.5"/>',
  folder: '<path d="M2.25 4.25a1 1 0 0 1 1-1h3l1.5 1.75h5a1 1 0 0 1 1 1v6.75a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1z"/>',
  chevron: '<path d="M6 3.5 10.5 8 6 12.5"/>',
  back: '<path d="M7 3.5 2.5 8 7 12.5M2.5 8h11"/>',
  add: '<path d="M8 3v10M3 8h10"/>',
  terminal: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 6.5 7 8 5 9.5M8.5 10H11"/>',
  bell: '<path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3z"/><path d="M6.75 14h2.5"/>',
  settings:
    '<circle cx="8" cy="8" r="2"/>' +
    '<path d="M8 1.75l1.1 1.6 1.9-.4.4 1.9 1.6 1.1-1 1.65 1 1.65-1.6 1.1-.4 1.9-1.9-.4L8 14.25l-1.1-1.6-1.9.4-.4-1.9-1.6-1.1 1-1.65-1-1.65 1.6-1.1.4-1.9 1.9.4z"/>',
  pullRequest:
    '<circle cx="4.5" cy="3.75" r="1.5"/><circle cx="4.5" cy="12.25" r="1.5"/><circle cx="11.5" cy="12.25" r="1.5"/>' +
    '<path d="M4.5 5.25v5.5M11.5 10.75V7a2.5 2.5 0 0 0-2.5-2.5H6.5M8 3l-1.5 1.5L8 6"/>',
} as const;

export type IconName = keyof typeof PATHS;

/** Inline SVG markup for a decorative icon; label it on the owning control. */
export function icon(name: IconName): string {
  return (
    `<svg class="ic ic-${name}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">` +
    PATHS[name] +
    "</svg>"
  );
}
