---
name: ADO PR Ops
description: A Windows 11 desktop review desk for Azure DevOps pull requests, with Copilot reviews in the loop.
colors:
  mica: "#202020"
  layer: "#272727"
  layer-2: "#2d2d2d"
  layer-3: "#343434"
  sunken: "#1b1b1b"
  flyout: "#2c2c2c"
  card: "rgba(255, 255, 255, .05)"
  divider: "rgba(255, 255, 255, .084)"
  text-1: "#f5f5f5"
  text-2: "#cfcfcf"
  text-3: "#a0a0a0"
  text-off: "#6f6f6f"
  accent: "#60cdff"
  accent-text: "#99ebff"
  accent-tint: "rgba(96, 205, 255, .12)"
  on-accent: "#000000"
  success: "#6ccb5f"
  caution: "#f8d84a"
  critical: "#ff99a4"
  sev-critical: "#ff99a4"
  sev-high: "#d0a8ff"
  sev-medium: "#f8d84a"
  sev-low: "#6ccb5f"
  sev-nit: "#a0a0a0"
typography:
  display:
    fontFamily: "Segoe UI Variable Display, Segoe UI, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: "36px"
  title:
    fontFamily: "Segoe UI Variable Display, Segoe UI, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: "28px"
  body-strong:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: "20px"
  body:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  caption:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
  code:
    fontFamily: "Cascadia Mono, Cascadia Code, Consolas, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
rounded:
  control: "4px"
  surface: "8px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
motion:
  ease: "cubic-bezier(0, 0, 0, 1)"
  fast: "83ms"
  normal: "167ms"
  slow: "250ms"
components:
  button:
    backgroundColor: "rgba(255, 255, 255, .061)"
    textColor: "{colors.text-1}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "5px 12px"
  button-accent:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.control}"
    padding: "5px 12px"
  button-subtle:
    backgroundColor: "transparent"
    textColor: "{colors.text-1}"
    rounded: "{rounded.control}"
  badge:
    backgroundColor: "rgba(255, 255, 255, .06)"
    textColor: "{colors.text-2}"
    typography: "{typography.caption}"
    rounded: "{rounded.control}"
    padding: "0 6px"
  card:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.surface}"
  flyout:
    backgroundColor: "{colors.flyout}"
    rounded: "{rounded.surface}"
  dialog:
    backgroundColor: "{colors.layer-2}"
    rounded: "{rounded.surface}"
    padding: "20px 24px 24px"
---

# Design System: ADO PR Ops

## Overview

**Creative North Star: "The Review Desk"**

ADO PR Ops should feel like a native Windows 11 app, not a web page in a frame. It works like Outlook's reading pane for code review. The queue sits on Mica on the left. The open pull request reads on a solid layer on the right. Commands stay in a sticky header above the content.

The system is quiet, so that diffs, findings and comments carry the color. It uses one cyan accent, Fluent's tonal layers, 4px and 8px corners, and Segoe UI Variable. It avoids decorative gradients, glow, oversized cards and anything that competes with the code.

The living reference is `web/design-system.html`. It renders the real `web/style.css`, so open it from the preview server to check any component. It is excluded from the packaged app.

## Layout

- **Title bar (40px):** app identity on the left, and the inbox, refresh and settings on the right. In the desktop shell the native caption buttons are overlaid (`html.wco`), and Mica shows through when the OS supports it (`html.mica`).
- **Queue (`--list-w`, 360–460px):** filters, the Me / Not me / All segmented control and bulk select. My Plate comes first, then the assignment-filtered queue grouped by repository.
- **Reading pane:** a sticky detail head (title, ID, status, severity lights, branch, command bar and section tabs) above a single scrolling column. That column holds the Review, Description, Discussion and Files sections, and the tabs follow the scroll.
- **Below 1100px** (`body.layout-stacked`), the pane stacks over the queue. A back button appears in the detail head, and Esc returns to the originating row.

## Colors

### Surfaces

Surfaces step up in lightness: `mica` → `layer` → `layer-2` / `card` → `flyout`. Separation comes from tone and 1px strokes, never from heavy shadows. Only flyouts and dialogs cast shadows.

### Accent

Cyan `#60cdff` is the only brand color. Spend it on selection, the primary command in a view, focus rings and the open-row bar. Accent text uses `#99ebff`; selection fills use the 12–20% tints.

### Status and severity

Each status pairs a foreground with a 12% tint: success green, caution yellow, critical pink. Severity keeps its own scale, set through `--sev` on `.sev-*` and `.sl-*`: critical pink, high violet, medium yellow, low green, nit gray. Severity is always paired with a text label or count, never conveyed by color alone.

### Named rules

- **One accent per view.** If two things are cyan, one of them is wrong.
- **Color is evidence.** Hue appears only where it carries meaning: a vote, a status, a severity or a diff line.

## Typography

Segoe UI Variable Text sets interface text at 14/20. Segoe UI Variable Display sets titles at 20/28, and the queue heading at 28/36. Captions are 12/16 in `text-3`. Cascadia Mono is for IDs, branches, paths and code at 12/16.

- File heads lead with the file name in mono semibold. The directory follows in `text-3` and loses its head first, so the nearest folders stay readable.
- Queue rows truncate the branch before the author.
- "General" thread labels use the interface font, because they are not paths.

## Shape, depth and motion

- Controls have 4px corners and surfaces have 8px corners. Pills are reserved for chips (reviewers, projects), severity lights and counts.
- Shadows exist only for flyouts (`0 8px 16px`) and dialogs (a 32/64 layered shadow over a 30% black smoke).
- Motion uses Fluent's decelerate curve `cubic-bezier(0,0,0,1)` at 83, 167 and 250ms. Use fades and short translations only; never bounce. `prefers-reduced-motion` collapses transitions and animations, keeping only slowed busy spinners so progress stays visible.

## Components

### Commands

- `.btn` is the standard button. `.btn.accent` is the primary command, and the dialog confirm, send and bulk-review buttons share that style. `.btn.ghost` is subtle and `.btn.sm` is compact.
- `.icon-btn` is used in the title bar and `.detail-icon-btn` in the command bar. Their outline icons are `svg.ic`, 16px strokes on `currentColor`.
- **Copilot review** is the only filled command in the detail head.
- Every button must carry a base class (`.btn`, `.icon-btn` or `.detail-icon-btn`). A bare `<button>` falls back to the browser's gray default.

### Badges

All badges share one shape: 20px high, 4px radius, a 12px label and a tinted fill. The badge types are:
- `.st-badge` for PR status, shown only when it isn't Published;
- `.my-act` for my vote or comment;
- `.tally` for reviewer counts;
- `.rev-badge` for Copilot review state;
- `.chg` for change type;
- `.sev-badge` for severity.

### Queue row

`.pr-card` holds a full-width `.pr-open` button, with a selection checkbox beside it. The row shows:
- a two-line title;
- a meta line with the mono ID, author, age and branch;
- a badge line.

The open row gets `fill-selected` and a 3px accent bar, and selected rows get the accent tint.

### Detail head

The detail head shows:
- the title, then the ID, status, severity lights, author and branch → target. The author is a 20px persona avatar with the name and when the PR was opened; hovering shows the exact date;
- the command bar, made up of Decision, Lifecycle, Copilot review, Refresh, Open in ADO and the comments drawer;
- the section tabs, with an accent underline that follows the scroll.

Severity lights open a flyout listing that severity's findings.

### Reviewer strip

Each reviewer is a persona chip: an accent-tinted 24px avatar with initials, plus a 13px presence badge whose color is the vote. "Required" is set off by a divider. My own action leads the strip.

### Review, threads and files

- The Copilot review is a collapsible card containing the semantic story, the findings and a staged-comment hint.
- Diagrams in the review render in a fixed-height frame (`.mmd-viewport`), sized once from the fitted diagram. Drag to pan, and use Ctrl+scroll, the − / + buttons or the keys `+`, `-` and `0` to zoom inside the frame. The frame never resizes, and Fit re-centres the diagram. A plain scroll still scrolls the page.
- Staged AI comments render inline in the diff as accent-edged cards with Post, Elaborate and Dismiss actions.
- Threads collapse from a location header that carries a status badge.
- Notification previews are flattened to plain text with `plainSnippet`, so raw ADO HTML never shows.

### Flyouts and dialogs

- Menus, the inbox and the comments drawer are flyouts: `flyout` background, 8px radius and a flyout shadow, with fade and slide.
- Dialogs are centered over smoke and focus their first field. Esc closes the topmost layer and returns focus to the invoker.

## Accessibility

- Focus rings are a 2px white outline at a 1px offset, inset on full-width rows and tabs. They are never removed.
- Every icon-only control has an `aria-label`.
- The section tabs are buttons in a labelled `nav`, and the active one carries `aria-current`. The reviewers are a labelled `list`.
- In forced-colors mode, selection bars and tab underlines use `Highlight`, and the severity and unread dots keep their colors. Coarse pointers get 40px targets.

## Do's and Don'ts

### Do

- Use the tokens; add a token before adding a raw value.
- Keep one accent per view, and let severity and diff colors carry meaning.
- Check new components in `web/design-system.html` and at 1440px and below 1100px.

### Don't

- Don't use gradients, glows, glassmorphism beyond Mica, or radii above 8px on surfaces.
- Don't use emoji as icons; use `icon()` from `web/src/icons.ts`.
- Don't put a `<button>` on the page without a base class.
- Don't show raw HTML or Markdown in previews.
