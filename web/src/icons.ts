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
  file: '<path d="M3.75 1.75h5.5l3 3v9.5h-8.5z"/><path d="M9.25 1.75v3h3M6 8.5h4M6 11h4"/>',
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
  flow:
    '<rect x="1.75" y="5.75" width="4.5" height="4.5" rx="1"/><rect x="9.75" y="2.25" width="4.5" height="4.5" rx="1"/>' +
    '<rect x="9.75" y="9.25" width="4.5" height="4.5" rx="1"/><path d="M6.25 8h1.5V4.5h2M7.75 8v3.5h2"/>',
  pipeline: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M5.5 6 7.5 8l-2 2M8.5 6l2 2-2 2"/>',
  play: '<path d="M5 3.25v9.5L12.5 8z"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1.5"/>',
  trash: '<path d="M2.75 4.5h10.5M6.25 4.5V3h3.5v1.5M4.25 4.5l.65 8.3a1 1 0 0 0 1 .95h4.2a1 1 0 0 0 1-.95l.65-8.3"/>',
  search: '<circle cx="7" cy="7" r="4.25"/><path d="m10.25 10.25 3.25 3.25"/>',
  minus: '<path d="M3 8h10"/>',
  up: '<path d="M3.5 10 8 5.5l4.5 4.5"/>',
  down: '<path d="M3.5 6 8 10.5 12.5 6"/>',
  edit: '<path d="M10.25 2.75l3 3-7.5 7.5H2.75v-3z"/><path d="M8.75 4.25l3 3"/>',
  panel: '<rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.5"/><path d="M6 2.75v10.5"/>',
  calendar: '<rect x="2.25" y="3.25" width="11.5" height="10.5" rx="1.5"/><path d="M2.25 6.5h11.5M5.5 1.75v3M10.5 1.75v3"/>',
  checklist: '<path d="M2.5 4.25l1.1 1.1 2-2.1M2.5 10.25l1.1 1.1 2-2.1M7.75 4.5h5.75M7.75 10.5h5.75"/>',
  fit: '<path d="M2.75 6V2.75H6M10 2.75h3.25V6M13.25 10v3.25H10M6 13.25H2.75V10"/>',
  tidy:
    '<rect x="1.75" y="2.75" width="4" height="4" rx="1"/><rect x="1.75" y="9.25" width="4" height="4" rx="1"/>' +
    '<rect x="10.25" y="6" width="4" height="4" rx="1"/><path d="M5.75 4.75H8v6.5H5.75M8 8h2.25"/>',
  branch:
    '<circle cx="4.75" cy="3.5" r="1.5"/><circle cx="4.75" cy="12.5" r="1.5"/><circle cx="11.25" cy="5" r="1.5"/>' +
    '<path d="M4.75 5v6M11.25 6.5c0 2.75-2.5 3.5-6.5 4"/>',
  external: '<path d="M9 2.75h4.25V7M13.25 2.75 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>',
  image: '<rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.5"/><circle cx="6" cy="6.25" r="1.25"/><path d="M2.75 12 6.5 8.5 9 10.75l1.75-1.5 2.5 2.25"/>',
  mail: '<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="m2.5 4.5 5.5 4.25 5.5-4.25"/>',
  diff: '<path d="M3.75 1.75h5.5l3 3v9.5h-8.5z"/><path d="M9.25 1.75v3h3M8 5.75v4M6 7.75h4M6 12h4"/>',
  grip: '<circle cx="6" cy="3.75" r=".6"/><circle cx="10" cy="3.75" r=".6"/><circle cx="6" cy="8" r=".6"/><circle cx="10" cy="8" r=".6"/><circle cx="6" cy="12.25" r=".6"/><circle cx="10" cy="12.25" r=".6"/>',
  layout: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M7 3v10M7 8h6.5"/>',
  col: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M8 2.5v11"/>',
  reset: '<path d="M3 8a5 5 0 1 0 1.5-3.5M3 2.5V5h2.5"/>',
  ask: '<path d="M2.75 3.25h10.5v7.5h-6l-3 2.5v-2.5h-1.5z"/><path d="M5.5 6.25h5M5.5 8.25h3"/>',
  queue: '<path d="M5.5 4h8M5.5 8h8M5.5 12h5M2.5 4h.5M2.5 8h.5M2.5 12h.5"/>',
  send: '<path d="M2.5 7.75 13.5 2.5 9.5 13.5 7.5 8.5z"/><path d="M7.5 8.5 13.5 2.5"/>',
  files: '<path d="M5.75 1.75h4.5l2.5 2.5v7.5h-7z"/><path d="M3.25 4.25v10h6.5"/>',
  lines: '<path d="M2.5 4h11M2.5 8h11M2.5 12h7"/>',
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
