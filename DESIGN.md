---
name: Devis
description: A glass review console for Azure DevOps pull requests and pipeline chains, with Copilot reviews in the loop.
colors:
  ink: "#050505"
  ink-2: "#101010"
  ink-3: "#1b1b1b"
  pool-key: "rgba(255, 255, 255, .09)"
  pool-rim: "rgba(255, 255, 255, .05)"
  hud-line: "rgba(255, 255, 255, .035)"
  glass: "rgba(16, 16, 16, .6)"
  glass-2: "rgba(42, 42, 42, .48)"
  glass-3: "rgba(56, 56, 56, .56)"
  glass-head: "rgba(12, 12, 12, .84)"
  glass-float: "rgba(16, 16, 16, .88)"
  well: "rgba(0, 0, 0, .42)"
  card: "rgba(255, 255, 255, .04)"
  control: "rgba(255, 255, 255, .05)"
  control-hover: "rgba(255, 255, 255, .075)"
  fill-hover: "rgba(255, 255, 255, .06)"
  fill-selected: "rgba(255, 255, 255, .08)"
  neutral-tint: "rgba(255, 255, 255, .06)"
  edge: "rgba(255, 255, 255, .12)"
  edge-top: "rgba(255, 255, 255, .24)"
  divider: "rgba(255, 255, 255, .07)"
  stroke-input: "rgba(255, 255, 255, .42)"
  text-1: "#f2f2f2"
  text-2: "#cbcbcb"
  text-3: "#959595"
  text-off: "#646464"
  accent: "#4cd6ff"
  accent-hover: "#7be2ff"
  accent-press: "#36b6de"
  accent-text: "#9eeeff"
  accent-tint: "rgba(76, 214, 255, .13)"
  accent-tint-2: "rgba(76, 214, 255, .22)"
  accent-glow: "rgba(76, 214, 255, .55)"
  on-accent: "#02101a"
  focus: "#9eeeff"
  success: "#5ee0a0"
  success-tint: "rgba(94, 224, 160, .13)"
  caution: "#ffd166"
  caution-tint: "rgba(255, 209, 102, .13)"
  critical: "#ff8fa0"
  critical-tint: "rgba(255, 143, 160, .13)"
  sev-critical: "#ff8fa0"
  sev-high: "#d0a8ff"
  sev-medium: "#ffd166"
  sev-low: "#5ee0a0"
  sev-nit: "#959595"
  add-bg: "rgba(94, 224, 160, .1)"
  del-bg: "rgba(255, 143, 160, .1)"
typography:
  display:
    fontFamily: "Segoe UI Variable Display, Segoe UI, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 600
    lineHeight: "38px"
  title:
    fontFamily: "Segoe UI Variable Display, Segoe UI, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: "30px"
  body-strong:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "22px"
  body:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: "22px"
  label:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  caption:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "18px"
  code:
    fontFamily: "Cascadia Mono, Cascadia Code, Consolas, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "18px"
  readout:
    fontFamily: "Cascadia Mono, Cascadia Code, Consolas, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
rounded:
  control: "6px"
  surface: "10px"
  pane: "14px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
  gutter: "8px"
  pane-pad: "24px"
components:
  button:
    backgroundColor: "{colors.control}"
    textColor: "{colors.text-1}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "5px 12px"
    height: "32px"
  button-hover:
    backgroundColor: "{colors.control-hover}"
  button-accent:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.control}"
    padding: "5px 12px"
    height: "32px"
  button-accent-hover:
    backgroundColor: "{colors.accent-hover}"
  button-accent-active:
    backgroundColor: "{colors.accent-press}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-1}"
    rounded: "{rounded.control}"
  button-ghost-hover:
    backgroundColor: "{colors.fill-hover}"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.control}"
    size: "32px"
  text-field:
    backgroundColor: "{colors.control}"
    textColor: "{colors.text-1}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "5px 11px"
    height: "32px"
  badge:
    backgroundColor: "{colors.neutral-tint}"
    textColor: "{colors.text-2}"
    typography: "{typography.caption}"
    rounded: "{rounded.control}"
    padding: "0 6px"
    height: "20px"
  pane:
    backgroundColor: "{colors.glass}"
    textColor: "{colors.text-1}"
    rounded: "{rounded.pane}"
  pane-head:
    backgroundColor: "{colors.glass-head}"
    padding: "16px 24px 0"
  card:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.surface}"
  flyout:
    backgroundColor: "{colors.glass-float}"
    rounded: "{rounded.surface}"
  dialog:
    backgroundColor: "{colors.glass-float}"
    rounded: "{rounded.pane}"
    padding: "20px 24px 24px"
  queue-row-selected:
    backgroundColor: "{colors.accent-tint}"
  pipeline-block:
    backgroundColor: "rgba(24, 24, 24, .92)"
    textColor: "{colors.text-1}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.surface}"
    padding: "12px 14px"
    width: "248px"
    height: "88px"
---

# Design System: Devis

## Overview

**Creative North Star: "The Heads-Up Console"**

Devis is a heads-up review console. Smoked black glass panes hover over a faintly lit black field, and light marks what the machine is attending to: the open pull request, the focused control, a running pipeline. The desk metaphor still holds: the queue sits on the left, the open pull request reads on the right, and commands stay in a frosted head above the content. Only the material changed. Everything floats; the small chrome that opens over content is frosted.

The glass is restrained, because the content is code. Panes carry a smoked tint and a luminous hairline edge; rows, cards and badges inside them do not. Blur is spent only on small sticky and floating chrome. One emissive cyan is the only brand color, and it glows only where it signals state. Diffs, findings, severity and comments keep their own colors and stay the loudest things on screen.

In the desktop shell, a Windows 11 Mica backdrop (22H2 and later) tints the field with the desktop wallpaper, and the app forces the dark theme so the glass always reads as smoked. Mica samples the wallpaper once, so it costs nothing per frame; `ADO_PR_OPS_BACKDROP=acrylic` opts back into the live acrylic blur, and `none` turns the backdrop off. Without a backdrop, the same field renders on solid ink.

The living reference is `web/design-system.html`. It renders the real `web/style.css`, so open it from the preview server to check any component. It is excluded from the packaged app.

**Key Characteristics:**
- Floating glass panes separated by 8px gutters of lit field, never edge-to-edge chrome.
- A faint white light pool top-left and a dimmer one bottom-right, with a faint 32px HUD grid fading out from the top-left. The field, the glass and the text carry no hue.
- Luminous hairline edges with a brighter top edge and an inner top sheen, so every pane catches light from above.
- One emissive cyan, with glow reserved for selection, focus, running state and the primary command.
- Cascadia Mono for every readout: IDs, branches, paths, build numbers and zoom levels.
- One authored motion: an opened pull request rises into the pane.

## Colors

### Primary

**Emissive Cyan** (`accent`) is the only brand color. Spend it on selection, the primary command in a view, focus, the open-row bar, the active tab pill and running state. Accent text uses `accent-text`; selection fills use `accent-tint` and `accent-tint-2`. `accent-glow` is the light it casts: a soft halo on the primary command, the open-row bar, tab pills, a running pipeline block and the selected block. Text on a cyan fill uses the near-black `on-accent`.

### Neutral

- **The field.** `ink` is a neutral near-black base, lit by the white `pool-key` and `pool-rim` and overlaid with the `hud-line` grid. Over the Mica backdrop the ink turns 64% opaque so the wallpaper tint comes through it.
- **Glass.** Tints step up in light: `well` (recessed: diff bodies, code, diagram frames, the pipeline canvas) → `glass` (panes, 60%) → `glass-2` and `glass-3` (raised surfaces inside panes) → `glass-head` (frosted sticky heads, near-opaque so diagrams and code don't ghost through) → `glass-float` (flyouts, menus, toasts, dialogs; near-opaque so they stay legible over anything).
- **Edges.** `edge` is the luminous hairline around glass; `edge-top` is its brighter top edge. `divider` separates content inside a pane. `gloss` is a faint white wash across the top of each pane, so black glass still catches light.
- **Text.** Neutral whites: `text-1` for primary text, `text-2` for secondary, `text-3` for captions and meta, `text-off` for disabled.

### Status and severity

Each status pairs a foreground with a 13% tint: success mint, caution amber, critical rose. Severity keeps its own scale, set through `--sev` on `.sev-*` and `.sl-*`: critical rose, high violet, medium amber, low mint, nit neutral gray. Diff lines use `add-bg` and `del-bg`. Severity is always paired with a text label or count, never conveyed by color alone.

### Named Rules

**The One Light Rule.** Only cyan glows. If two unrelated things on screen are cyan, one of them is wrong.

**The Color Is Evidence Rule.** Hue appears only where it carries meaning: a vote, a status, a severity or a diff line. Glass, edges and text stay neutral black, gray and white.

## Typography

Segoe UI Variable Text sets interface text at 15/22. Segoe UI Variable Display sets titles at 22/30 and the reference page heading at 30/38. Labels (feature tabs, repository heads, compact buttons) are 14/20. Captions are 13/18 in `text-3`. Cascadia Mono sets branches, paths and code at 13 and compact readouts (IDs, counts, zoom levels) at 12.

Every font size comes from one ramp of role tokens in `web/style.css`: `--fs-display` 30, `--fs-title` 22, `--fs-heading` 19, `--fs-subhead` 16, `--fs-body` 15, `--fs-label` 14, `--fs-caption` 13, `--fs-readout` 12, `--fs-micro` 11 and `--fs-pip` 10 (the count inside a comment bubble). The shared leadings are `--lh-display`, `--lh-title`, `--lh-body` and `--lh-caption`. Fixed-height controls keep their own line height. Never write a raw pixel font size; to make the whole app larger or smaller, change the ramp.

### Hierarchy

- Queue lane heads are 15px semibold in `text-1`; repository heads are 14px semibold.
- The detail head title is 22/30 Display semibold; the ID beside it is mono.
- File heads lead with the file name in mono semibold. The directory follows in `text-3` and loses its head first, so the nearest folders stay readable.
- Queue rows keep their meta on one line: the branch drops out first, then the repository truncates, then the author.
- "General" thread labels use the interface font, because they are not paths.

### Named Rules

**The Readout Rule.** Anything a machine produced and a person compares (an ID, a branch, a build number, a duration, a zoom level) is set in Cascadia Mono with tabular figures.

## Layout

- **The field and gutters.** The title bar sits directly on the field. Below it, panes float with an 8px gutter (`gutter`) on every side and between panes.
- **Title bar (40px):** a glowing cyan brand mark and the app name, then the feature tabs (Workspace, Pull requests, Pipelines), and the inbox, refresh and settings on the right. The active feature tab carries a 16×3 cyan pill with a glow. In the desktop shell the native caption buttons are overlaid (`html.wco`); with the backdrop on (`html.glass`) their background is transparent so the field shows behind them.
- **Queue pane (`--list-w`, 360–460px):** the My feed / All tabs, a search field, scope pickers (shown only when there is more than one org or project) and the bulk bar. See [Queue views](#queue-views).
- **Reading pane:** a frosted sticky detail head (title, ID, status, severity lights, author, branch, command bar and section tabs) above a single scrolling column with 24px side padding (`pane-pad`). That column holds the Review, Description, Discussion and Files sections, and the tabs follow the scroll. With nothing open, the pane shows the scanning reticle.
- **Below 1100px** (`body.layout-stacked`), the reading pane floats over the queue as a solid sheet inset by the gutter. A back button appears in the detail head, and Esc returns to the originating row.
- **Pane zoom:** Ctrl+= or Ctrl++ zooms in, Ctrl+− zooms out, and Ctrl+0 resets. Steps run from 50% to 200%, and a toast confirms each one. Only the pane's content zooms; the queue, title bar and pane frame keep their size. The level lasts until the app closes. Electron's whole-window zoom roles are removed from the menu so they don't take these keys.
- **Workspace zoom:** the same keys zoom the Workspace view you're in, each on its own: the Devis, Today and Tasks panes, the task sheet and History. The target is the dialog on top if it's one of these views, else the view with keyboard focus, else the one the pointer was last over, else Tasks. Each view type keeps its level in local storage: every task sheet opens at the level last set on one, and the panes keep theirs across launches. The toast names the view ("Tasks 90%"). The task sheet reads 12.5% larger at 100%, since it's where a task is read.
- **Pipelines:** the catalog pane (`clamp(272px, 24vw, 340px)`) and the chain pane float side by side with the same gutters. The chain pane holds a toolbar, the canvas and a 304px inspector. Below 1100px the inspector floats over the canvas as a solid sheet, only while a block or arrow is selected. Below 760px the catalog stacks above the chain pane.
- **Workspace:** three panes float side by side: Devis, the Lead (`clamp(320px, 26vw, 440px)`), Today (`clamp(300px, 28vw, 460px)`) and Tasks, which takes the rest. Any pane folds to a 40px rail, and the last open pane takes what's left; one always stays open, and the choice is remembered. Below 900px the open panes stack, and folded ones lie across as 38px bars. Cards lay out by their pane's width (container queries), not the window's. See [Workspace](#workspace-devis-today-and-tasks).
- **Coarse pointers** get 40px targets.

## Elevation & Depth

Depth is a stack of light, not a stack of grays: the lit field → floating glass panes → raised glass inside panes → frosted heads → frosted floats → dialogs over smoke. Each tier is more opaque than the one below it. Panes read as glass through their tint, edge and sheen; blur is reserved for the small chrome that sits over content.

- **Panes** are tinted, not blurred (`glass`), with the `edge` hairline, the `edge-top` top edge, an inner top sheen (`inset 0 1px 0 rgba(255,255,255,.08)`), the `gloss` wash and a soft drop shadow. A pane-sized blur re-blurs the field on every scroll frame and costs about half the frame rate.
- **Heads** (the detail head and other sticky heads) frost the pane's own content as it scrolls under them (`blur(24px) saturate(160%)`).
- **Floats** (flyouts, menus, the selection toolbar, toasts and the zoom cluster) use a stronger blur (`blur(32px) saturate(170%)`) and the flyout shadow.
- **Dialogs** add the deep dialog shadow and sit over a 62% ink scrim, never a blur. The scrim covers the whole window, so a blur there redraws everything under it on every frame anything changes: measured on a machine without a GPU, it held the task sheet at 13–23 fps and about 100ms from a keypress to the screen.
- **Sheets** (the stacked reading pane below 1100px and the narrow pipeline inspector) are tall, so they are solid `#151515` with the dialog or flyout shadow instead of a blur.
- **Pipeline blocks** are near-opaque tiles (92%) on the canvas, with no blur, and a short drop shadow. A dragged block borrows the flyout shadow while it's lifted.

### Shadow Vocabulary

- **Pane** (`0 18px 44px -14px rgba(0,0,0,.6)`): every floating pane.
- **Flyout** (`0 16px 36px -8px rgba(0,0,0,.62), 0 2px 8px rgba(0,0,0,.3)`): flyouts, menus, toasts, the zoom cluster, block action pills and a dragged block.
- **Dialog** (`0 40px 80px -16px rgba(0,0,0,.72), 0 4px 24px rgba(0,0,0,.36)`): dialogs and the stacked reading sheet.
- **Glow** (`accent-glow`, 8–26px): emitted light, not elevation. Used only under the One Light Rule.

### Motion

Motion uses the decelerate curve `cubic-bezier(0,0,0,1)` at 83, 167, 250 and 333ms. Use fades and short translations; never bounce. The one authored motion is the pane rising in: an opened pull request fades up 6px over 333ms. It moves only opacity and transform, so the compositor slides the painted pane; a blur in the motion re-rasterized the whole pane every frame. The empty reticle's arc sweeps twice (6 seconds each), then rests, so an idle pane doesn't keep the compositor busy. `prefers-reduced-motion` collapses transitions and animations, stops the reticle, and keeps only slowed busy spinners so progress stays visible.

### Named Rules

**The Glass Budget Rule.** Glass (tint plus edge) belongs only to panes, heads, floats, dialogs and pipeline blocks. Blur belongs only to the detail head, floats, dialogs and the zoom cluster: never to a pane, a sheet or anything repeated (`scripts/perf-guard-harness.mjs` enforces this). Rows, cards, badges and fields inside a pane are tints, never their own glass.

**The Near-Opaque Float Rule.** Anything that opens over content (heads, flyouts, menus, dialogs) is at least 84% opaque. Menus inside the frosted detail head can't blur the content under them, so their opacity is what keeps them legible.

**The Fallback Rule.** Glass must degrade to something solid and clear. Under `prefers-reduced-transparency`, the glass tokens turn opaque, gloss and blur are off, the HUD grid is hidden and the field is plain ink. In forced-colors mode, blur, the field effects and pane shadows are removed and system colors take over. Without a window backdrop, the field renders on solid ink.

**The Lean Rule.** Without GPU compositing (a virtual machine, a remote desktop) Chromium draws every frame on the CPU, so the app draws lean (`html.lean`): nothing frosts (heads and floats turn opaque instead of blurring), and dialogs and the task sheet fade in over 83ms instead of scaling, since a scaling sheet is redrawn whole every frame. The desktop shell picks it from the window's GPU status (`?render=lean`; `ADO_PR_OPS_RENDER=lean|full` overrides it); a browser asks WebGL whether it renders in software. Measured on such a machine, every view then holds the display's full rate, the task sheet included.

## Shapes

- Controls have 6px corners (`control`), surfaces inside panes have 10px corners (`surface`) and floating panes and dialogs have 14px corners (`pane`).
- Pills (`pill`) are reserved for chips (reviewers, projects), severity lights, counts, toggle switches and the block action pill.
- The selection and tab indicators are 3px bars with 2px ends: 16px wide under tabs, 16px tall at the left of the open row.
- The empty reticle is a 72px ring with a dashed outer ring and a sweeping cyan arc.

## Components

### Commands

- `.btn` is the standard button: a faint white tint with a hairline border and a brighter top edge. `.btn.accent` is the primary command: a cyan fill with dark text and a soft glow that strengthens on hover. The dialog confirm, send and bulk-review buttons share that style. `.btn.ghost` is subtle and `.btn.sm` is compact (28px, 13px label).
- `.icon-btn` is used in the title bar and `.detail-icon-btn` in the command bar. Their outline icons are `svg.ic`, 16px strokes on `currentColor`.
- **Copilot review** is the only filled command in the detail head.
- Every button must carry a base class (`.btn`, `.icon-btn` or `.detail-icon-btn`). A bare `<button>` falls back to the browser's gray default.

### Badges

All badges share one shape: 20px high, 6px radius, a 13px label and a tinted fill. The badge types are:
- `.st-badge` for PR status, shown only when it isn't Published;
- `.my-act` for my vote or comment;
- `.tally` for reviewer counts;
- `.rev-badge` for Copilot review state;
- `.chg` for change type;
- `.sev-badge` for severity, tinted from its `--sev` color.

### Inputs

Text fields use the `control` tint with a hairline border and a `stroke-input` bottom edge. On focus they sink into a dark well (`rgba(0, 0, 0, .62)`) and gain a 2px cyan bottom edge with a faint cyan underglow. Placeholders use `text-3`. Combo boxes share the button's tint and top edge, with a chevron.

### Navigation

The feature tabs, the queue tabs and the section tabs share one language: plain labels in `text-2`, `text-1` when active, and a glowing 3px cyan pill or underline that slides in under the active one.

### Queue row

`.pr-card` holds a full-width `.pr-open` button, with a selection checkbox beside it. The row shows:
- a two-line title;
- a meta line with the mono ID, the repository (My feed only, since All already groups by it), the author (dropped in Your pull requests), age and branch;
- a badge line.

The open row is lit: a cyan wash that fades from left to right, a faint cyan ring and a glowing 3px cyan bar at its left edge. Selected rows get `accent-tint`; a row that is open and selected gets `accent-tint-2`.

### Queue views

Two tabs, remembered across launches. Counts in the tabs follow the search and scope.

- **My feed** puts each PR that concerns you in exactly one lane, checked in this order:
  1. **Your pull requests**: you authored it. PRs where a reviewer is waiting on you or rejected float to the top, and drafts fold into a closed "N drafts" group at the bottom of the lane.
  2. **You've weighed in**: you voted or commented.
  3. **Needs your review**: it is assigned to you.
  4. **Copilot reviewed**: a Copilot review is queued, running, done or failed. Reviews in progress lead, then the most recently finished.

  Lanes show in the order Needs your review, Copilot reviewed, You've weighed in, Your pull requests. Inside every lane, drafts sink below published PRs and the newest PR leads. A lane head may add one quiet note: the oldest review waiting, reviews in progress or failed, or PRs waiting on you.
- **All** lists every PR in scope, grouped by repository (folded by default, sorted by name) with an Expand all / Collapse all command.
- **Hide and restore.** Select rows in My feed and choose Hide; they leave the feed but stay in All. A footer counts hidden PRs and can show them in a "Hidden from your feed" lane, where Restore returns them. Queuing a Copilot review restores a PR automatically.
- **Search** (Ctrl+F) filters both views. Terms are ANDed and case-insensitive; free text matches title, #ID, author, repository, project and branches. Qualifiers: `is:draft`, `is:published`, `is:reviewed`, `is:yours`, `is:assigned`, `repo:`, `author:`, `branch:`; a leading `-` negates any term. While searching, every group is open. Esc clears the field, then leaves it.
- **Folds** remember their state per lane and per repository. The tabs, lane heads and repository heads are buttons with `aria-pressed` or `aria-expanded`.
- **Keyboard:** Up and Down move between rows and group heads, Home and End jump to the ends, Right opens a group, and Left closes it or moves to the parent head.
- **Bulk bar:** select-all covers only rows in open groups. At rest it shows a summary of the view; with a selection it shows the count, Hide or Restore (My feed), and Review All.
- **Empty states** name what happened and offer the next step: clear the search, search all PRs, or browse all PRs when the feed is empty.
- **Load failures** stay visible in the queue until the user retries with Refresh. Failed retrieval is never presented as "No open pull requests"; partial results remain usable with a warning, and background review updates cannot replace the error.
- **Loading:** the queue opens on the last list ADO returned (kept for 7 days, and only for the same organizations and projects) while the live one loads, and Refresh swaps rows in place without blanking the list or losing the scroll position. The refresh button spins meanwhile. If ADO can't be reached, the list stays with a notice above it saying how old it is and why, with Retry; with nothing to show, the failure is the error screen.
- **Rendering:** rows off screen skip layout and paint. A rebuilt row keeps the height its previous copy had, so the scroll position lands on the same row.

### Detail head

The detail head is frosted glass (`glass-head`) that stays pinned while the pane scrolls under it. It shows:
- the title, then the ID, status, severity lights, author and branch → target. The author is a 20px persona avatar with the name and when the PR was opened; hovering shows the exact date;
- the command bar, made up of Decision, Lifecycle, Copilot review, Refresh, Open in ADO and the comments drawer;
- the section tabs, with a glowing cyan underline that follows the scroll.

Severity lights are 8px colored orbs in tinted pills; each opens a flyout listing that severity's findings.

### Reviewer strip

Each reviewer is a persona chip: an accent-tinted 24px avatar with initials, plus a 13px presence badge whose color is the vote. "Required" is set off by a divider. My own action leads the strip.

### Review, threads and files

- The Copilot review is a collapsible card containing the semantic story, the findings and a staged-comment hint.
- Diagrams in the review render in a fixed-height recessed frame (`.mmd-viewport`), sized once from the fitted diagram. Drag to pan, and use Ctrl+scroll, the − / + buttons or the keys `+`, `-` and `0` to zoom inside the frame. The frame never resizes, and Fit re-centres the diagram. A plain scroll still scrolls the page.
- Staged AI comments render inline in the diff as cyan-edged cards with Post, Elaborate and Dismiss actions.
- **Review & post:** Post opens a dialog with the Copilot review and the comment to post, ready to edit. Copilot writes those comments in your own voice when you have the `in-my-language` skill (in `~/.copilot/skills`, `~/.agents/skills` or `~/.claude/skills`): the app reads the skill and its linked reference files and puts them in the review prompt and in Rephrase, so it works whether or not the session loads skills. Without the skill, comments are plain, natural English. Reviews written before you added the skill keep their wording until you rephrase them.
- **Rephrase** opens a "How should it change?" box under the comment (optional: "shorter", "softer", "mention the rollout"). Enter or its Rephrase button rewrites the comment with that ask; Shift+Enter adds a line; Escape or × closes just the box. While the box is open, the bar's Rephrase button hides, so there's one at a time. On success the box closes and empties, and the label adds "in your voice" when the skill was used; on failure it stays as typed, so trying again is one click, and you can still edit and post by hand.
- Threads collapse from a location header that carries a status badge.
- Notification previews are flattened to plain text with `plainSnippet`, so raw ADO HTML never shows.

### Flyouts, dialogs and toasts

- Menus, the inbox, the comments drawer, severity flyouts and the selection toolbar are frosted floats: `glass-float`, 10px radius, the luminous edge, the sheen and the flyout shadow, with a fade and a short slide.
- Dialogs are 14px frosted floats centered over smoke, with a brighter top edge and the dialog shadow. They focus their first field. Esc closes the topmost layer and returns focus to the invoker.
- Toasts are frosted floats bottom-center with a glowing status dot.

### Empty state: the scanning reticle

With no pull request open, the reading pane shows a 72px cyan-lit ring around the pull request icon, a dashed outer ring and a cyan arc that sweeps once every 6 seconds, above a 22/30 title and one line of help. It reads as the console idling, waiting for a target.

### Pipeline chain (signature component)

The Pipelines feature chains Azure DevOps build pipelines on a canvas. Each block is one pipeline, and an arrow means "start this one after that one succeeds".

#### Catalog and chain pane

- **Catalog pane:** search, an optional project scope, notes for errors and unscoped orgs, then pipelines grouped by project. Each row shows a status dot for the latest build, the name, the folder path, an "In chain" tag, and a + button. Drag a row onto the canvas, or press +.
- **Chain pane:** a toolbar with the chain picker, New, the inline-editable chain name and the autosave state. On the right are the run chip, Run chain or Stop, and Delete. Below it sit the canvas and the inspector, which is a darker recess of the pane.
- **Task chains:** chains that belong to a Workspace task are listed apart in the picker, under "Task chains". Opening one adds a banner row to the toolbar: whose validation it is, **Open the task** (the task's Validation tab), and **Save as reusable** (a copy of your own, with PR-following blocks set back to the default branch). In the inspector, a task chain's block has **Builds**: a branch you type, or one of the task's PRs to follow; the block shows "PR 8's branch". Deleting a task chain says which task it belongs to; the task carries on without one.

#### Canvas

- The canvas is a recessed `well` with a faint white dot grid, plus faint major lines every five grid steps. The grid pans and scales with the blocks, and it is functional: blocks snap to 8px.
- The zoom cluster is a frosted float at the bottom left: −, the level in mono (click to reset to 100%), +, Fit and Tidy. Tidy lays blocks out in stages from left to right. Drag empty space or scroll to pan; Ctrl+scroll zooms at the pointer. In this view, Ctrl+=, Ctrl+− and Ctrl+0 zoom the canvas instead of the pane.
- The empty state is a dashed 56px mark with a title and one line of help. It lights up cyan while a catalog row is dragged over the canvas.

#### Blocks

- A block is a 248×88 glass tile with a 10px radius, a hairline edge and a sheen. It shows the pipeline name (15/20 semibold), the project, the branch in mono, a settings glyph with the number of parameters it changes (only when it changes any) and, during a run, a status.
- Tone lives in the border: running is cyan with a cyan underglow, succeeded is mint, partially succeeded is amber, failed is rose, and skipped or cancelled sink to a darker tile with dimmed text. A block that is waiting in a run has a dashed border.
- A running block shows a 2px glowing indeterminate bar on its bottom edge. Never use a colored side stripe.
- The output port (a 14px ring on the right edge) appears on hover, focus or selection, and glows on hover. Drag from it onto another block to connect. A valid target turns cyan; a target that would create a cycle or a duplicate arrow turns rose.
- Selection is a cyan border, a 1px cyan ring and a soft cyan halo.

#### Arrows

- Arrows are 1.5px `text-3` curves from the source's right edge to the target's left edge, with a 16px invisible hit area.
- States: hover is `text-1`, selected is cyan at 2.5px, a running downstream path is a cyan dash that flows, done is mint, and skipped is a dimmed 4/4 dash.
- A selected arrow shows a round remove button at its midpoint, a frosted float that keeps its size at every zoom level.

#### Inspector

- With nothing selected, it shows how to build a chain or, once blocks exist, the **run order**: numbered stages on a rail. Each stage lists blocks that start together. It also shows the last run, with its status, duration, per-tone counts and any error.
- With a block selected, it shows the name and project, an Open in Azure DevOps link, the block's action (Run from here, or Stop pipeline while it runs) with a one-line hint, the block's run status, the branch override (blank means the pipeline's default branch), Repositories, Parameters, Consumes, the "Runs after" and "Starts next" chips with an add menu, a facts list, and Remove from chain.
- **Repositories** lists the other repositories the pipeline's YAML pulls in (`resources.repositories`, like a OneBranch templates repo), read from the YAML on the block's branch. Each shows its alias, the repository and project, and a branch field whose placeholder is the ref the YAML names. A blank field keeps that ref; a branch makes the block build against it. The count beside the heading reads like the Parameters count. A branch set for an alias the YAML no longer has is listed to remove, and the block fails to queue until it's removed. Classic pipelines have none. The block's own repository is always its Branch, never a row here. Blocks with repository branches show a folder count on the canvas, and Run chain lists how many each sets.
- With an arrow selected, it says what the arrow means and offers Remove.

#### Running

- Run chain opens a confirmation dialog that lists every stage, block and branch, plus how many parameters and repository branches each block changes. Blocks with parameters or repository branches to fix are named in the note list. Nothing is queued without it.
- The runner lives in the desktop app's main process and is deterministic, not an AI agent. Blocks with no incoming arrows start first. A block starts when **all** of its upstream blocks have succeeded or partially succeeded. If any upstream block fails or is cancelled, everything downstream is skipped. Builds are polled every 10 seconds.
- While a chain runs, it stays editable: add blocks, draw or remove arrows, move blocks, and change branches and parameters. Edits autosave and the runner applies them on its next tick. A new block joins the run only when it comes after a block that is still waiting or running; an edit never starts anything by itself, so a waiting block that an edit makes ready leaves the run instead. A block reads its branch, repository branches and parameters when it queues, so a block that already queued or finished notes that changes apply the next time it runs. Removing a running block, or an arrow out of one, is refused with "Stop it before removing it", and undo, redo and Remove follow the same rule. Stop cancels the running builds and skips the rest.
- Chains advance while the background service runs, and a running chain keeps it running after the window closes. If the service stops, the runner resumes polling the builds it already queued on its next start; a block caught mid-queue is marked as interrupted, so it is never queued twice.
- Chains autosave 600ms after each edit. The toolbar shows Saving…, Saved or an error with Retry.

#### Per-block actions

- The selected block carries one floating pill, pinned 6px above its top-right corner and kept the same size at every zoom: **Run from here** (cyan fill with a glow, play icon) or, while that block's build is queued or running, **Stop** (frosted float, rose stop icon). The inspector repeats the same action as a full-width button with a hint. The pill hides while an arrow is being dragged.
- **Run from here** opens a confirmation listing the block and every block after it, by stage. On an idle chain it starts a new run of just that scope; blocks before it don't run and aren't waited for. While the chain runs, it joins that run instead, because a chain has at most one live run.
- **Fan-in:** a block with several incoming arrows waits for every upstream block that is part of the run and starts once. The confirmation names these extra waits, and names any block that will be skipped because an upstream block in the run didn't pass. Both appear in a caution-tinted note list.
- A triggered block shows "Started from here" in the inspector, because it doesn't wait for its own upstream blocks. While a run is live, blocks outside it fade to 45% until hovered or selected and keep showing their last result; the inspector says "Not part of this run".
- **Stop** opens a danger confirmation that names the build and lists the waiting blocks it will skip. Other branches keep running. The block reads "Stopping…" until Azure DevOps confirms the cancellation.
- The runner refuses Run from here, with a stated reason, when the block is already running or waiting in the run, when a block after it is running, or while the chain is stopping. In those cases the pill is hidden and the inspector button is disabled, with the reason as its hint.
- Both commands go through the runner: the view only queues them, so they never race a status update.

#### Run state per block

- A chain has one live run at a time, and Run from here makes a run of just that block and what follows it. So a block's status never comes from "the latest run" alone: each block shows its state in the newest run if that run has it, otherwise **what it last did in an earlier run**. Running the release alone leaves the build blocks showing their Succeeded status, build number and finish time.
- The inspector labels the source: "This run" for a block in the live run, otherwise "Last run" with how long ago it finished and ", in an earlier run" when that wasn't the newest run. A block that didn't run in a live run says "Not part of this run. Run from here adds it to this run." and is dimmed on the canvas, with the same words in its accessible name.
- The newest run's outcome wins, so a block skipped because an upstream block failed reads as Skipped. A block that only waited, or was skipped, never hides an earlier real result. A live run's Waiting shows while it waits.
- A result belongs to the block and the pipeline it ran: organization, project and pipeline id. Changing a block's branch or arrows keeps its result. Pointing the block at another pipeline drops the old result, and pointing it back brings it back while that run is still kept. Results are per chain, and the Pipelines view forgets them when another chain opens.
- History is kept per chain: the newest 20 finished runs, plus any older run that holds a current block's last result or last passed build. A busy block can't push out the result or the pinned build of a block that ran less recently. A block that was removed or given another pipeline no longer keeps a run alive. The runner is the only writer of run state, and the view reads results from `/api/pipeline-chain-results`.

#### Parameters

- **Parameters** is a disclosure in the inspector. Its summary carries a count badge: neutral for the total, cyan for "N of M changed", and rose for "N to fix". The open state persists across selections.
- The fields are read from the pipeline's YAML on the block's branch, through the same provider Azure DevOps uses for its Run pipeline panel. A list of values renders as a combo box, a boolean as a toggle switch, an object as a mono text area, and anything else as a mono text field.
- Only changed values are stored and sent; the rest use their defaults. A changed field shows a cyan dot before its label, a Reset link and its default. An invalid value turns the dot and the field's bottom edge rose, with the problem written under the field.
- Values for parameters the YAML no longer declares are listed with Remove buttons, because the run would fail to queue. Classic pipelines show that they take no runtime parameters and offer Clear parameters if any are set. YAML problems appear as caution notes, and Reload reads the YAML again.

#### Consumes

- When a block's YAML declares `resources.pipelines`, **Consumes** lists each alias. If an earlier block in the chain builds that pipeline, the alias is linked: when that block passes earlier in the same run, the runner pins the resource to that exact build instead of the pipeline's latest. The nearest such block wins. Two at the same distance are a tie: the block fails rather than guess, so the inspector shows the tie in a caution note.
- When the earlier block didn't build in the same run (Run from here on the consumer, or a later run), the runner pins that block's last passed build from an earlier run of this chain, on the block's current pipeline and branch. A build from the same run always beats one from an earlier run. The linked alias names that build with a link and its age, or says Azure DevOps uses its default build because this app hasn't built it on that branch yet. Only the chain's kept runs count (see Run state per block).
- An alias that nothing in the chain builds says so, and Azure DevOps picks its default build.
- After a run, the block's run status lists each pinned build ("`alias` uses build 1.0.123 from Build"), with ", built in an earlier run" when it came from one, and how many parameters it queued with.

#### Pipelines accessibility

- Blocks are focusable buttons. Enter selects a block, arrow keys nudge it (Shift for 4× steps), Delete removes the selected block or arrow, and Esc clears the selection. On empty canvas, arrow keys pan.
- Ctrl+F focuses the catalog search, Ctrl+S saves now, and Ctrl+Z / Ctrl+Y undo and redo.
- Status is always written out in the block, the run chip and the inspector, never conveyed by tone alone.
- A visually hidden live region announces run progress.
- Reduced motion freezes the flowing arrows and the running bar; the bar stays as a static full-width line.

### Workspace: Devis, Today and Tasks

The Workspace is the daily home, and its tab comes first. Three panes sit side by side:

- **Devis** is the Lead, one persistent Copilot session that watches the Workspace and keeps its history, so you can ask it what happened instead of reading logs.
- **Today** is your day: Today so far, what needs you, your own to-dos and a quick note.
- **Tasks** is the board: the pull requests waiting for your review, and your tasks with the Copilot workers running on them.

#### Model

- **Task:** one ADO work item (User Story, Task, Bug…), or a custom task with none. A work item task shows its type, state and parent, read from ADO; Refresh reads them again. The same work item can only be in Tasks once. A task has a **description** (yours, or the work item's own) and its own **folder**. See [Task folders and the codebase](#task-folders-and-the-codebase).
- **Worker:** one Copilot session hosted by a task, with your own Copilot setup and skills. It works in its own folder inside the task's folder, with a git worktree of each repository it needs. A task hosts any number of workers. Tasks made before task folders keep running their workers in a folder you choose.
- **Artifacts:** each task has a folder of files that you and its workers share, under the Workspace's folder (`jarvis` in the data folder) at `tasks/<id>/artifacts`. **note.md** is the common note: workers read it before they start and add dated, signed entries with their `task_artifacts` tool, only for what others need (decisions, findings, open questions), never progress. **recap.md** is written when the task ends. Anyone can add more notes, like `design.md`. There is no separate daily note: the Workspace is the dashboard, and your own notes live in the quick note.
- **Status update:** one short, signed, timestamped line about where a task stands. A task's updates build up its timeline for the day.
- **Service:** the ADO org and project, used only as a filter in Tasks. Custom tasks can pick one or none.
- **To-dos and the quick note:** yours, not any task's or day's. They last until you change them. See [To-dos and the quick note](#to-dos-and-the-quick-note).
- **History:** tasks created, done, reopened and removed, recaps, PRs linked and unlinked, validation chains added, proposed, accepted, dismissed and run, status updates, workers started, asking, answered, approved, finished, failed or stopped, and PRs you approved from the app. The Lead and the History dialog read it.

#### Task folders and the codebase

Every new task gets a place on disk, and every worker gets its own copy of the code it needs, so workers never step on each other or on your own checkouts.

- **The codebase:** Settings › Workspace › Codebase. Pick an organization and a project, read live from Azure DevOps, then check its repositories and **Add to codebase**. On Save the app clones each new one once, with no checkout, into `jarvis\codebase\<org>\<project>\<repo>` under the app's data folder, using your `az` login. Each repository shows Cloned, Cloning…, Not cloned yet or Clone failed (hover for why). A clone cut short is retried on the next start. Removing a repository leaves its clone on disk.
- **Task folders:** Settings › Workspace › Task folders is the folder new tasks go in. The New task form has a **Description** and a **Folder** prefilled from Settings, and shows the folder it will make. The task's folder is named after its title in lowercase with dashes for spaces (`Some work needed` → `some-work-needed`), without characters a folder or branch can't hold, and numbered when the name is taken (`some-work-needed-2`). A work item task fills the description from the work item (description, repro steps, acceptance criteria) as you type its number; you can edit it.
- **The first worker:** **Add task** makes the folder and starts a worker in `<task>\<worker>` at once, named from a short list (atlas, birch, cedar…). Its first turn:
  1. It lists the codebase with its `task_workspace` tool and, from the title and description, proposes the repositories the work needs.
  2. You confirm: a card in its chat (and under Needs you) lists every repository with its picks checked. **Make worktrees** gives it the checked ones; **None** gives it none.
  3. The app, not the agent, fetches each clone and adds a worktree at `<task>\<worker>\<repo>` on a new branch `<you>/<task>/<worker>` off origin's default branch, with no upstream, so a plain push can't land on the default branch. `<you>` is your alias from your Azure DevOps account. A branch name already taken, here or on origin, gets a number.
  4. Before it changes anything, it states the goal, scope and what done means and asks you to confirm or correct them, with any questions the description leaves open. Then it starts.
- **More workers:** **+** on the task starts another worker the same way, beside the first, with optional instructions. It can propose again later to add repositories.
- **Where it shows:** the Status tab shows the description, the task's folder and each worker's worktrees and branches. The worker's brief carries the description, its folder and its worktrees, and its skills come from each repository first.
- **Open in an IDE:** **Open in** opens a small panel beside the button, with the official VS Code and VS Code Insiders icons. The choices have tooltips and screen-reader labels, but no visible text. The panel stays open through polling and launches; click **Open in** again, click outside or press Escape to close it. Both choices open that worker's folder, containing its repository worktrees, in a new IDE window. They also work during a turn and don't stop or detach the worker. Older tasks open the worker's chosen folder. A missing folder, IDE or failed launch shows an error. On Windows, the app looks in standard user and system installations and on PATH; restart the app after changing PATH.
- **The Lead:** `devis_create_task` takes a description and uses the Settings folder; without one set, the task has no folder and no worker starts. `devis_start_worker` needs no folder for a task that has its own.

#### A worker's changes

**View changes**, beside **Open in** in a worker's chat, opens what that worker changed in a window of its own. The task sheet keeps its panes as they are, and the code gets the full width. It doesn't edit files: edits happen in the IDE, or you [ask the worker](#asking-the-worker).

- **The window:** one per worker. Opening it again brings it forward. A new one opens where the last one closed, at the same size, and maximized if that one was; with another code window already there, it steps 28px down and right. It can't go below 480 × 360. The title names the worker and the task. Closing the main window closes every code window. A worker on an older task, with no folder of its own, has the button disabled and says why.
- **Compare:** three choices in the toolbar.
  - **Since branching:** from where the worker's branch left its base to the files on disk, with uncommitted and untracked files. The default.
  - **Uncommitted:** from its last commit to the files on disk, with untracked files.
  - **Last commit:** from the commit before it to its last commit. Before the worker commits anything, it says so.
- **The tree:** every repository in the worker's folder, each with its branch, what it branched from, and its file count and +/− totals. Files sit under their folders, with a one-letter status (A, M, D, R, U, T) and their own +/−. A repository that fails (not a git repository, a base it can't find) shows the error and Retry, and the rest still load. Past 2,000 files a repository shows the first 2,000 and says how many it left out.
- **The diff:** the picked file's unified diff, with the same table as a PR's files. Binary files, files over 2 MB and sides over 6,000 lines say so instead, with **Open in**. The toolbar has the same IDE panel at every width. Prev and Next (or Alt+↑ and Alt+↓) step through the files. The comparison, repository and file are kept in the window's address, so a reload, or the service coming back on a new port, opens the same file.
- **Keeping up:** the window reads the list every 10 seconds while the worker is working and every 30 when it's idle, once more just after a turn ends, and on focus. F5 or Ctrl+R reads it now. The toolbar says when it last read ("Updated just now"). A read that fails keeps what's shown, dimmed, and retries, from 3 seconds up to 15. A removed worker leaves the window open, saying so, with **Close window**.
- **The splitter:** drag the line between the tree and the diff, or focus it and use the arrow keys (Shift for bigger steps, Home and End). The tree is 200px to half the window, 300px by default, and double-click resets it. The width is kept for the next window.
- **Narrow windows:** under 900px the tree becomes a file picker over the diff, with Prev, Next and a filter box, and the comparison becomes a dropdown. Under 600px the "Updated" time goes and the worker's state shows only as its dot, with the state in the tooltip and for screen readers.

#### Asking the worker

In the code window you collect questions and change requests about what the worker changed, then send them all as one message. The worker gets the whole picture in one turn, instead of one interruption per question.

- **Picking lines:** click a line number, then Shift+click or drag to extend. On touch, tap a second line to extend, and tap a selected line to clear. Selecting code text with the mouse works too. An **Ask atlas** pill sits by the selection.
- **Picking files:** Ctrl+click files in the tree to pick several (the open file comes along, as in VS Code), or Shift+click for a range. Each file's header also has **Ask atlas** for the whole file.
- **The menu:** right-click lines or picked files for **Ask atlas about L12–14…** or **Ask atlas about 3 files…**, plus copying the lines or paths.
- **The ask box:** a small box by the selection that names what it's about. Enter adds the ask to the queue, Shift+Enter starts a new line and Escape cancels.
- **The queue:** **Queue** in the toolbar shows the count and opens the queue beside the diff. Each ask is numbered and shows its lines (an excerpt of up to 12) or its files; click it to jump there, or edit or remove it. Lines with a queued ask are marked in the gutter, and files with one get a dot in the tree. **Preview message** shows exactly what the worker gets. The queue is kept per worker, so closing the window doesn't lose it.
- **Send all:** sends every ask as one message. If the worker is in a turn, it waits for that turn to end. The asks move to **Sent** with their status: waiting for atlas to finish its turn, atlas is on it, Answered, or "Couldn't confirm atlas got this" with **Put back in queue**. When the reply answers the asks by number, each answer shows under its ask, with the full reply below. **Open in worker chat** brings the main window to that worker's chat, and **Dismiss** clears a finished batch.
- **Narrow windows:** under 900px the queue is a bottom sheet. While it's closed with asks in it, a bar at the bottom shows the count and opens it.

#### Today

Covers every service; the service filter belongs to Tasks.

- **Today so far:** see [below](#today-so-far).
- **Needs you:** a worker is asking a question, waiting for an approval, or failed; or a task's validation needs you (a proposal to review, or a run that failed and you haven't looked at). One compact item per ask, longest wait first: the task's title, who asks (the worker, or who proposed the chain), how long it has waited, and the ask itself, answerable right there (the choices and answer box, Allow, Allow all and Deny, the repositories to confirm, Review the proposal, See what failed, or Open the chat for a failed worker). The task's title opens the task. A worker's open request is listed even after its task is marked done, so an approval is never hidden. With Today folded, Needs you moves to the top of Tasks, so it's never out of sight.
- **→ To-do:** every Needs you item has a **To-do** button. It takes the ask on: the item leaves Needs you at once (and the "N need you" count with it), and a to-do takes its place in To-dos, worded from the ask ("Answer api: Which region?", "Allow or deny api: Run npm test", "Confirm api's repositories", "See why ui's turn failed", "Review the validation chain api proposed", "Look at the failed validation run", "Review PR 17701581: Add ARM staging (Dana asked)", "Confirm the canary date (Dana Lee in Teams)", "Approve the plan (Ann Lu by email)"). A toast offers **Undo** for six seconds (longer while the pointer is on it), which puts the ask back. The keyboard moves to the next item's To-do, or to the new to-do. The task's card keeps its warning, since the ask is still open; its label and jump go to the to-do instead.
- **From Teams:** a pull request someone asked you to review in Teams is a Needs you item too (see [Teams: PR review asks](#teams-pr-review-asks)). Its head is the PR's title (two lines at most) with To-do and ✕ (Dismiss); under it, who asked, where ("in a 1:1 chat", "in Release crew") and when, what they wrote, and up to two more people who asked about the same PR. **Review PR** opens it in the Pull requests tab, even a PR not in your list; **Open in Teams** opens the message in the Teams app (the browser when Teams isn't installed). Dismiss takes it out at once.
- **From chats and email:** a Teams chat or email thread whose summary says someone waits on you (see [Communication](#communication)) is a Needs you item too: one per conversation, from its latest day that says so, this week. Its head is the conversation (the email's subject, a group's topic, "Chat with Dana Lee" for a 1:1) with To-do and ✕ (Dismiss); under it, who, where ("in a 1:1 chat", "in Release crew", "by email", "by email (cc)", "by email to a list") and when, and what they need. The head opens it in the Communication tab, opened and in view; **Open in Teams** or **Open in Outlook** opens the chat or the email. It leaves by itself once you write back (the next summary clears it). Dismiss says nobody waits: the conversation stops waiting on you that day and before, in Communication too, until someone asks again. A chat with an open PR review ask from Teams leaves its review line to that ask, which opens the PR.
- **To-dos** and the **Quick note:** see [To-dos and the quick note](#to-dos-and-the-quick-note).
- The head shows the date, how many need you, and how many to-dos are open.

#### Tasks

The third pane's title is three tabs, **Tasks**, **Communication** and **Meetings** (see [Communication](#communication) and [Meetings](#meetings)); the one showing is bright and underlined, Left and Right (Home and End) move between them, and the app remembers which was open. Each tab has its own sub line, tools and body.

Sections in order: Running, Open tasks, Done today, then Pull request reviews last.

- **Running:** a worker is mid-turn, including one waiting on your answer. Its pill names the tool it's using.
- **Open tasks:** open tasks with no running worker, including ones whose worker finished a turn or failed. Finished turns lead, then untouched tasks.
- **Done today:** tasks finished today and PRs you approved today. Earlier work stays in History.
- **Pull request reviews:** the same rule as the PR feed's "Needs your review" lane. Six show by default, newest first, with PRs someone asked for in Teams ahead of the rest; those carry an amber "Asked by Dana" chip that opens the message in Teams. Each row has **Copilot review**, which queues a review through the same queue, runner and review model as the Pull requests page, so the result lands in the PR's review panel. It shows "Reviewing…" while a review is queued or running, and a chip once it is reviewed or failed. **Review** opens the PR in the Pull requests tab.
- **Waiting on you:** a task never moves because something waits on you. Its card stays in its section with an amber border, and its warning icon says what's waiting ("Needs you: api: Run npm test") and, clicked, scrolls to the ask under Needs you and puts the cursor on it. The ask itself is answered there, not on the card.
- Empty sections stay quiet: Pull request reviews says so in one line; Running, Open tasks and Done today hide.
- The head holds the service filter, History and **+ Task**; in a narrow pane the buttons show icons only. The footer sums up the board ("1 needs you · 1 running · 2 PRs to review").
- Clicking a task card, or its title, opens the task.
- A task's pull requests show as chips under its title (`PR 17553390 · Active · 1 of 2 required approvals`), up to two, open ones first, then "+N". A chip turns amber when the PR needs someone: rejected, waiting for its author, a failing check or merge conflicts. Clicking one opens the task's Pull requests tab.

#### To-dos and the quick note

Your own list and scratchpad in the Today pane. They belong to no day and no task, and stay until you change them.

- **To-dos:** type in the box and press Enter; it clears at once for the next one, and comes back if the save fails. Click the box to check one off; done ones fold under "Done · N", newest first, with Clear done. Double-click a to-do, or its edit button, to change it: Enter keeps the change, Escape drops it, clicking away keeps it. Alt+Up and Alt+Down move the focused one; the row's move buttons do the same. A row's tools float over its end on hover or focus, so they never squeeze the text. Changes show at once and roll back if the app refuses them.
- **Limits:** a to-do is one line of up to 500 characters; 500 can be open at once, and the newest 200 done ones are kept. A reopened to-do goes to the end of the list.
- **From Needs you:** a to-do made with **To-do** shows, under its words, the task and who asked; that line opens the task. One made from a Teams ask shows the PR and who asked instead, and that line opens the message in Teams; one from a chat or email thread shows the conversation and who, and opens the chat in Teams or the email in Outlook. It remembers the exact ask (a worker's oldest open request, its failed turn, the validation proposal, the failed run, or the Teams ask), so a worker's next question is a new item, and taking on the same ask twice gives back the same to-do. Once the ask is gone (you answered, the worker ran again, the proposal was accepted or dismissed, the run was looked at or rerun, the task closed, the Teams ask closed or was dismissed, or the chat or thread stopped waiting on you), the to-do ticks itself and reads "Done by itself · no longer waiting on you". It does so once, and only while you haven't checked it off or reopened it yourself: after that it's yours. A failed turn is known by when the worker failed, so switching its model doesn't make it a new ask. The service checks on every Today poll, from the same ask keys Needs you uses (`jarvis-needs.mts` mirrors `needsItems`). When a task's validation, the Teams asks, or the chats and threads waiting on you can't be read on a poll, to-dos from those asks are left alone rather than ticked. Agents see where a to-do came from ("from Needs you: Canary scope").
- **Quick note:** free text, up to 50,000 characters, saved 0.7 seconds after you stop typing, and at once when you leave the box or the tab. The head says "Saving…", "Saved 2m ago", or "Devis added 5m ago". Closing the window mid-edit still saves it, since the background service outlives the window. An edit that couldn't save before the page went away (the service restarted, a conflict was open) is kept in the page's storage and saved on the next start, merged with anything added since, even if the Workspace isn't opened.
- **Edits never collide:** every save names the version it started from. If Devis added to the note while you typed, the save is refused, Devis's paragraph goes below your text, a line says so, and the merged note saves. Your caret stays where you were typing. A note changed some other way (another window) can't be merged safely, so you choose: Keep both, Keep mine, or Use the saved one. A save that fails keeps your text and retries, backing off to once a minute.
- **For agents:** the Lead and every worker can read both when you ask: open to-dos with their ids, the last ten done, and the quick note. The Lead's `devis_notes` can also add a to-do, check one off, and add a dated paragraph signed Devis to the end of the note. A worker's `user_notes` can only read and add a to-do. Neither can edit or delete what you wrote. To-dos an agent adds carry its name as a small badge. The Lead's and the workers' briefs tell them the notes exist, so "check my to-dos" works anywhere.

#### Status updates

- **Who posts:** a worker posts one with its `task_status` tool before it ends each turn. If it forgets, the first real sentence of its reply becomes the update; headings and lead-ins like "Here's what I did:" are skipped. The Lead posts with `devis_post_status` when you ask, and you can post from the task card.
- **Rules:** every path goes through the same check. An update is one plain line of up to 160 characters, with Markdown markers removed. The same line from the same author within 10 minutes counts once. A task takes at most 100 updates a day, so a runaway worker can't flood it.
- **Where it goes:** the database holds the update and a line goes into History. The timeline is the task's progress record, so updates aren't copied into note.md.
- **On the card:** the task's latest update shows on its own line under the task, with the author and age, even if it's from an earlier day. "N updates today" opens the day's timeline with a box to post one and **All updates**, which opens the task's whole timeline; a task with none shows "Post status".

#### Today so far

The first block in the Today pane: a short write-up of where things stand. What each task is doing is on its card in Tasks, and what waits on you is under Needs you.

- **Write-up:** two to four short bullet points, one per task or for the PR queue, written by a short-lived Copilot session with no built-in tools and no custom instructions. Like every session, it has the MCP servers on, but its brief gives it only the Today data and asks for text. Task names in it are links to their cards: they flow with the text however long they are, and Enter or Space follows them. Clicking one scrolls to the task's card and highlights it, unfolding Tasks or clearing its service filter first when the card is hidden. Before the day's first write-up, a line says it comes once there's news. The block shows once Today has a task.
- **When it's written:** the day's first write-up comes once Today has been quiet for 90 seconds. After that, at most one automatic write-up an hour, and only if Today changed: an hour after the last one, it waits for 90 quiet seconds, or 5 minutes if Today keeps changing. Time passing alone isn't a change. Refresh writes one now and restarts the hour. A failed attempt retries after 5 minutes, at most 3 times for the same Today. Automatic write-ups stop at 40 a day; Refresh still works up to 200.
- **Check before showing:** a write-up is dropped if it's empty, too long, has more than four points, has text outside the list, has links or Markdown other than bold (which is removed), or names a task or `#id` that isn't in the Today data. When it's dropped, the head says "Write-up unavailable" with Retry, and today's last good write-up stays dimmed. A reply written as prose is taken a sentence per point, and older prose write-ups show the same way.
- **Freshness:** the head says "Updated 40 min ago". Between write-ups the narrative stays as written; the cards are always current. "Updating…" shows only while a write-up is being written, with the last one dimmed. Only today's write-ups show at all.
- **Collapse:** the block folds to a one-line summary ("1 needs you · 2 moving · 1 done", each task counted once) and remembers that. It covers every service, like the rest of Today.
- **History:** write-ups are kept for 30 days. The Lead reads them with History, so you can ask how a day went.

#### The task

A sheet over the Workspace, nearly the full window: the task on the left and a chat with its workers on the right. The left side takes up to half the width (360–820px) by default, so a validation chain's stages fit side by side. Drag the border between them to resize: the task keeps at least 340px and the chat 380px, also as the window shrinks. With the border focused, the arrow keys move it (Shift for bigger steps), Home and End take it to either limit, and Enter or a double-click puts it back to the default. Every task sheet opens split the way the last one was left. Below 900px wide, the sheet fills the window and stacks, with no border to drag.

- **Left:** four tabs, remembered per task. Arrow keys, Home and End move between them.
  - **Status:** the task's facts on top: the work item (type, state, parent, link) or "None: a custom task", the service and when it was added, the task's folder, each worker's worktrees and branches, and the description. Then the box to post an update, then every update since the task started, not just today's: newest first, grouped by day (Today, Yesterday, then dates), 200 at a time with Show older.
  - **Pull requests:** a card per PR, so each one reads as its own item. The card's head always shows: a chevron, its state in Azure DevOps (Draft, Active, Completed, Abandoned), title, repo, branches and age, then what it needs: rejections, failing checks, merge conflicts, approvals, open comments. A folded card's status line also names what's waiting inside ("Comment plan ready", "Builds failed"), and its title stays on one line. The title opens the PR in the app's own PR view; the arrow opens it in Azure DevOps; anywhere else on the head, or the chevron, folds the card. The body holds the worker's side of the PR: **Builds** (failed blocking builds and what it proposes) and **Comments** (new reviewer comments and its proposal for each), then where the PR came from and **Unlink**, which takes off a PR the app or you linked; one linked to the work item in ADO stays. A side with nothing to decide is one line ("No open comments waiting on you." with **Review now**). Nothing is posted, rerun or changed until you accept. Cards that need you (a plan to review, failed builds, a rejection, conflicts) open by default and the rest stay folded; a lone PR always opens; your choice is remembered per task and PR. With two or more PRs, a bar on top says how many need you, with **Expand all** / **Collapse all**. Open PRs come first, those needing attention on top; finished ones still carrying feedback stay, and the rest fold under "N finished". **Link PR** takes a pasted link. The tab's count is the number of PRs; its dot takes the tone of the PR review that matters most.
  - **Validation:** the task's validation chain. See [A task's validation chain](#a-tasks-validation-chain). The tab's dot takes the tone of the card's validation chip.
  - **Artifacts:** the task's files, note.md first, then recap.md, then the rest, newest first, each with its size and age. Opening one shows it rendered, with Edit, and Delete for anything but note.md. **New note** creates a file (`notes.md`, `notes-2.md`… by default). The list and an open file reload as workers write. A save is refused if the file changed while you edited; your text stays, and Save again replaces the newer copy on purpose. The card's **Artifacts** button opens the task on this tab.
- **Head:** Open in Azure DevOps, Mark done or Reopen, Remove, and Close. Escape closes it; the draft in the chat box stays for next time.
- **Workers:** a tab per worker with its state, and **+** to start another. The chat head shows the folder and the state, with Stop while it works and Remove. The model and effort picker sits over the message box (see [Chatting while it works](#chatting-while-it-works)).
- **Chat:** the worker's conversation, its turn as it happens, and its questions and approvals with the same Allow, Allow all and Deny as Needs you. A message you send shows right away, faded only until the app has it. While the worker works, a message is queued or sent into its turn; see [Chatting while it works](#chatting-while-it-works).
- **Slash commands:** type `/` for a list of the Copilot CLI's commands, then your skills, filtered as you type. Arrow keys move, Tab or Enter picks, Escape closes the list. A skill runs as a turn and shows as you typed it (`/no-ai-slop tighten the intro`), not as its full instructions. Commands that answer with text, like `/usage` or `/mcp`, show their output in the chat, and ones that offer choices show them as chips. Command output isn't saved with the conversation.
- **What's left out:** `/cwd`, `/plan`, `/autopilot`, schedules (`/every`, `/after`), `/remote` and `/sandbox`. They move the worker to another folder or mode, or schedule work the app wouldn't see. Typing one explains why.
- **/model:** the app switches the worker's model itself and keeps the conversation, so your saved CLI default stays as it is. It keeps the reasoning effort when the new model takes it, and runs mid-turn too: the switch applies when the turn ends. With no model named, it lists every model your Copilot can run.
- **Skills:** a worker loads skills from the repo (`.github/skills`, `.agents/skills`, `.claude/skills`), then yours (`~/.copilot/skills`, `~/.agents/skills`, `~/.claude/skills`), then your enabled CLI plugins. Only skill folders: the CLI's full config discovery would also start your Copilot extensions, which ask for access before the worker's first turn.
- A message starting with `/` and a name runs that command. A path like `/src/app is slow` is sent as a message, and `//` sends a message that starts with one slash.

#### A task's pull requests

The app finds them itself instead of asking the worker, and checks each one against ADO before linking it.

- **The work item's links in ADO:** for a work item task, the source of truth. Anyone's PRs, of any age, including ones you opened by hand.
- **A command that created a PR:** `az repos pr create`, a REST POST to `pullrequests`, or the ADO tools' create. The app reads the PR from that call's output. A worker only reading a PR link doesn't count.
- **The worker's branch:** after each turn, and on every sync, the app notes the branch each worker's folder (or each of its worktrees) is on (never `main`, `master`, `dev`, `develop` or `trunk`) and links your PRs from it.
- **`task_link_pr`:** a backup tool for a PR a worker opened another way. It takes a link, or a number when the worker works in one repository.
- **Link PR:** you paste any PR's link.
- **Rules:** what a worker creates, links or branches from counts only if you opened it after the task started (5 minutes of clock slack). Unlinked PRs stay unlinked until you link them again or ADO links them to the work item. Each PR is linked to a task once; the strongest source is kept.
- **Kept current:** opening the task reads its PRs, with checks and open comments, at most once a minute; Refresh reads them now. A background pass every 5 minutes keeps Today's chips current for tasks that can have PRs.
- **Worker instructions:** for a work item task, workers are asked to link the work item when they create a PR (`--work-items`), so ADO stays the source of truth.
- **Elsewhere:** the Lead sees each task's PRs in `devis_today`, the recap prompt lists them, History records links and unlinks, and a removed task's `task.json` names them.

#### A task's validation chain

A task can own one pipeline chain that proves its change works: build the PR's branch, deploy it to a test environment, run the tests. It's an ordinary chain (same canvas, same runner) with an owner.

- **Getting one:** copy a saved chain into the task, start an empty one in Pipelines, or ask a worker to propose one. Nothing is created until you accept a proposal, and nothing runs until you say so.
- **Following a PR:** a block can build one of the task's PRs instead of a fixed branch. It reads the PR's source branch when it queues, so new commits are picked up. If the PR can't be read, the block errors with why instead of building another branch.
- **The tab:** the chain in stages, left to right. Each block shows its status in the last run, the branch it built, its build link, and why it's there (the proposer's reason and the evidence). Then the runs, newest first, two options, and Save as a reusable chain, Ask a worker to propose changes, and Remove. **Run** confirms first with every pipeline and what it builds. A failed run shows a banner with **Got it**; until then it's listed under Needs you.
- **Options:** **Tell the task's worker what failed** (on by default) sends the worker the failed blocks, their failed steps, first errors and log links, and asks it to find out why and ask before running again. **Run again when a followed PR gets new commits** (off by default) starts a run when a followed PR's newest commit changes; turning it on watches from the current commit, and a run in progress isn't restarted.
- **Proposals:** a worker's `task_validation` tool (or the Lead's `devis_task_validation`) lists **candidates** with evidence the app checked: the builds the task's PRs must pass (build policies), pipelines whose YAML uses those builds (two hops), chains you ran with them, and names that look like production. Then it **proposes**: each pipeline, what it runs after, the PR it follows or a branch, changed parameters, branches for its YAML's repository resources, and a one-sentence reason, plus what it left out and why. The app refuses a proposal with every problem listed: a pipeline that doesn't exist or is disabled, an org you don't use, a PR not linked to the task, a branch that doesn't exist (including a repository resource's branch, checked in that repository), a parameter value that doesn't fit, a repository alias the YAML doesn't have, parameters or repository branches on a classic pipeline, a pipeline listed twice, a cycle, or a pipeline that uses a build but doesn't run after the block that makes it. What it can't check (a branch outside Azure Repos) is a warning, not a claim.
- **Reviewing:** the proposal shows its stages, each block's reason and evidence (a check mark when the app verified it), what was left out, and the checks. **Accept**, **Accept and run** (confirms first), **Accept and edit in Pipelines**, or **Dismiss** with an optional reason the proposer hears. Escape closes the reason box, not the sheet. Accepting replaces a chain that isn't running.
- **Automatic proposals:** a setting for every task, off by default: when a task gets a pull request and has a worker but no validation, its worker is asked once to propose one.
- **Rules:** a done task's chain can't run, from the task or from Pipelines; reopening it can. Messages for a busy worker wait until its turn ends. The production flag is only a name match, and says so.
- **The card:** a chip with the chain's state ("Validation · 2 of 4 · Deploy-Test", "Validation failed · Smoke-Tests", "Validation proposed · 3 pipelines") opens the task on this tab. Needs you lists a Validation ask (who proposed it, or "Validation") with Review the proposal or See what failed, and the card takes the amber Needs-you mark.
- **Elsewhere:** runs post a status line by "Validation" and History events; the Lead sees each task's validation in `devis_today`; the recap prompt lists the runs; removing the task stops a running run, deletes the chain once the run stops, and `task.json` records what the chain was and how it last ran.

#### Artifacts and the recap

- **The tool:** a worker's `task_artifacts` lists, reads, appends to and writes the task's artifacts. note.md takes appends only, so nobody wipes the shared note; recap.md is the app's to write. The Lead's `devis_task_artifacts` lists, reads and appends.
- **Files:** Markdown, text, JSON, YAML, CSV, log or Mermaid files, with plain names and no subfolders. Up to 50 per task and 200,000 characters each. Writes land whole: a reader never sees half a file.
- **Recap:** when a task is marked done or removed, one of its workers writes recap.md: the goal, the approach and design, the key decisions and why, the outcome, and what's left open, under 300 words. It skips step-by-step progress. The worker is the freshest one that isn't busy; it gets the status timeline over the task's whole life (the first 50 and latest 150 updates when there are more) and reads note.md and the other artifacts. A recap turn only reads: commands are declined and questions are answered with "the user isn't here".
- **Timing:** marked done mid-turn, the recap waits up to 20 minutes for a worker to finish. Reopened while it waits, there is no recap. A task with no workers gets none.
- **Shown:** the Artifacts tab says who's writing it or why it failed, with Try again. A done task without a recap offers Write recap. The worker's chat shows it as "Write the task's recap (recap.md)."
- **Removing a task:** it comes off Tasks at once. Its running turns are stopped, a worker writes recap.md, its validation chain is retired (a running run is stopped and the chain deleted once it stops), and then the task, its workers, its status lines and their Copilot sessions are deleted. Its folder goes too, with every worker's worktrees and their local branches; branches already pushed stay in Azure DevOps. The confirmation lists any worktree with uncommitted changes or unpushed commits. The Artifacts folder stays on disk with a task.json saying what the task was, its folder and worktrees, its PRs and its validation. Closing the window doesn't interrupt it; if the background service stops midway, the removal finishes on its next start.
- **Removing a worker:** on a task with a folder, its folder, worktrees and local branches are deleted with its session, with the same warning. A worker on an older task leaves the folder you chose as it is.
- **Old notes:** a task.md from an earlier version moves into Artifacts as note.md the first time the task's artifacts are read, without the `Status: …` copies, which the timeline already holds.

#### Workers and approvals

- Reads, the app's own tools, MCP tools and web pages (`web_fetch`) run without asking, and `web_search` is an MCP tool. Shell commands and file edits wait under Needs you with the exact command or file, and Allow, Allow all for this worker, or Deny.
- Questions from `ask_user` show their choices as chips and an answer box. Answering resumes the same turn.
- One turn at a time per worker; what you send meanwhile is queued or steered in (see [Chatting while it works](#chatting-while-it-works)). Stop aborts the turn, including one that is still resuming, and declines whatever was waiting. The turn ends once the runtime reports it isn't processing, or after 10 seconds, even if no event says so: aborting a session that's already idle emits nothing.
- A turn normally ends on the runtime's `session.idle`. That event is never saved or sent again, so if it's lost, every app session (workers, recaps, the Lead, the overview, reviewers, rephrase) also checks the runtime's `isProcessing` every 15 seconds. Two "not processing" answers in a row, with no events in between and nothing waiting on you, end the turn with its last reply, and the service log notes it. "Using <tool>…" lasts as long as that tool call, not until the turn ends.
- Remove stops the worker and deletes its Copilot session; files it changed stay.
- Removing a task first has a worker write its recap, then stops its workers and deletes their Copilot sessions. Its Artifacts stay. The work item in ADO is not touched.
- Closing the window doesn't end a turn or a question: the background service keeps the worker going, and the answer waits for you when you open the app again. If the service itself stops (a forced update, a crash), those workers show Idle with a note on its next start, and the next message resumes the session.

#### The Lead

- A terminal-style console: mono text, a `›` prompt, Markdown replies and a live line naming the tool it is using.
- It reads the Workspace and History through its own `devis_*` tools before answering, and can create or close tasks, add to a task's note.md, read its recap, post a status update, and start, message or stop workers when asked. It reads your to-dos and quick note with `devis_notes` when you ask, and adds to them only when told. With `devis_task_validation` it reads a task's validation, lists candidates and proposes a chain when you ask; it can't run one. It can't approve a worker's permission request; that stays with you.
- It runs with reads, its own tools and every MCP server (Agency's ADO, Bluebird, WorkIQ, mail, calendar, Teams, Kusto, IcM and the rest). Its brief says to change things outside the app, like sending mail, only when you ask. Shell commands and file edits are refused; those are a worker's job.
- **Model:** the model and effort picker over the message box (see [Chatting while it works](#chatting-while-it-works)). A resumed session is held to the chosen model and effort. Copilot only picks its default when a session starts, so going back to Copilot default applies from the next new session, and a toast says so.
- **Stop:** in the chat head while Devis answers. A stopped turn says so in the chat; it isn't shown as a failure.
- The session is kept across launches. A temporary resume failure keeps it; only a session the CLI confirms is gone is replaced. New session starts over with the same history.
- Resuming the session takes a few seconds after a launch, so the console shows the chat as it was last read meanwhile and switches to the live session once it's back. If that resume fails, the next read waits on a fresh one and shows its error.

#### Chatting while it works

The Lead and every worker chat the same way, like the Copilot CLI and app.

- **Model and effort:** the row over the message box reads "✦ model · effort" and both are pickers, each as wide as its choice. The model list is Copilot default plus every model your Copilot can run; with no model chosen, it names what the session runs ("Copilot default · claude-sonnet-5"). Reasoning effort shows only for a chosen model that takes one, with that model's own levels (No reasoning, Low, Medium, High, Extra high, Max) and Default effort. Switching keeps the conversation and keeps the effort when the new model takes it. Mid-turn, the switch applies when the turn ends, and the picker says "after this turn". A worker's Start dialog has the same two fields.
- **The turn as it happens:** while a worker works, its open chat reads it every 250ms (`/api/jarvis/workers/live`, which never resumes a session), and Devis every 400ms. Each finished reply stays in the conversation as the next one streams in below it, and the line under them says what the turn is doing ("Using view…", "Getting started…" until the session has taken the message in; a released session can take a while to wake). A streaming reply flows in: each read is revealed over about the time until the next, faster when more is waiting, and all at once under reduced motion. When the turn ends the saved conversation replaces the live one with the same messages (same ids), so nothing moves. The log repaints only its live tail as text streams, and only a message you just sent pulls it to the bottom, so you can scroll back mid-turn.
- **Queue:** while a turn runs, Enter (or **Queue**, which Send turns into) keeps the message for after it. Queued messages show under the conversation, numbered, each with **Send now** and Remove. They run one at a time, in order, as turns end. You can queue while it waits on your answer, too.
- **Send now:** Ctrl+Enter (or **Send now** beside Queue, or on a queued message) puts the message into the turn that's running, as the CLI's steering does; it shows as "Sent mid-turn" until the worker takes it in at its next step, then sits in the conversation where it read it. It waits while the turn is waiting on your answer: answer first, or queue it. While a turn is still starting (or stopping), Send now queues the message instead and a toast says so.
- **Stop:** a stopped or failed turn holds the queue ("Held · runs after your next message"). The next message you send runs first, then the queue. **Send now** on a held message starts it as a new turn.
- **Lifetime:** the queue lives in the background service: it survives closing the window and a worker's session being released, but not the service stopping. Removing a worker, or starting a new Lead session, drops its queue. A done or removed task's queue doesn't run.
- The Lead's tools and the app's own notices (a failed validation run) never queue: they wait for a free worker, as before.

#### Images in the chats

The Lead and every worker take images, the same way.

- **Adding:** paste one (a screenshot, an image copied from a browser or a file copied in Explorer), drop files on the message box, or pick them with the image button beside Send. A paste that also carries text, like an Office copy, pastes as text. PNG, JPEG, GIF and WebP, up to 7 MB each and 6 per message.
- **The tray:** added images wait over the message box as 64px thumbnails, each with ✕. Each one uploads as soon as it's added (a spinner until it's in, a warning mark if it couldn't be saved). Send waits for uploads: a toast says so. Each worker keeps its own tray, like its typed draft.
- **Sending:** images go with the words, or alone. Alone, the session gets "Take a look at the attached image(s)." and the chat shows just the images. They go as queued and Send now messages too, and the queue shows them. An answer to a worker's question is words only. A `/command` can't carry images.
- **In the chat:** a message's images sit above its words, up to 240 × 180, and open at full size over everything; Escape, ✕ or a click outside closes the viewer and puts focus back on the thumbnail. After a reload they come back from the session's history.
- **Storage:** the service saves each image once in `jarvis\images`, named by a hash of its bytes, and checks that the bytes are an image, whatever the file is called. A message names images by those ids only, never by path. Each goes to the session as a file attachment: the runtime reads it, resizes it and keeps its own copy, so the session stays whole when the file goes. Housekeeping removes images not sent or pasted for 30 days; their thumbnails then show as missing.

#### Teams: PR review asks

The first part of the Teams & Mail bridge: when someone asks you to review a pull request in a Teams chat, it shows under Needs you and on the PR's row. Rules, no AI. Read-only: it never sends, reacts or marks anything read.

- **How it reads:** the service starts the Teams MCP server (`agency mcp teams`) for each scan and closes it after. `ListChats` says which chats moved since the last scan; only those are read (`ListChatMessages`, newest first, up to 3 pages of 20), 1:1 chats first, at most 15 chats a scan. Each chat keeps a read position, its last message's time, which moves only once the chat was read, so a failed or throttled scan loses nothing. A chat seen for the first time is read 2 days back; nothing older than 7 days is read, however long the app was closed. Who you are comes from the m365-user server's `GetMyDetails`, kept for a week. Channels and mail are later parts.
- **When:** 20 seconds after the service starts, then every 30 minutes while it runs; 2 minutes later when chats were left for the next scan; and on **Scan now** in Settings. A scan is about 2 calls when nothing moved. When Teams says to slow down (429), the scan stops where it is and the next waits 1 hour, then 2. Teams chats and the calendar (see [Meetings](#meetings)) keep their own schedules and back-off: one slowing down never holds up the other, and a recap that's due doesn't make Teams be read more often. Teams' quota is shared with your own Copilot sessions.
- **What's an ask:** a message from someone else (not you, not a bot or a system event) with an Azure DevOps PR link that is *direct*: in a 1:1 chat, @mentioning you, or naming you; or *broad*: in a group or meeting chat, asking for a review in so many words ("review", "approve", "take a look", "PTAL", "sign off"), not @mentioning someone else unless it's to the room ("folks", "team", "anyone"). Broad asks count only for PRs in your organizations. One message with several PRs is an ask for each.
- **One ask per PR:** everyone who asked about a PR is on its one open ask, newest first (up to 6); a message read twice changes nothing. An ask about your own PR is dropped, and so are later ones about it.
- **How an ask closes:** on something after it was asked. You vote or comment on the PR in the app (at once), or in Azure DevOps (each scan reads the PR's comments, votes included, at most 10 PRs every 25 minutes, and closes the ask when one of yours is newer than the newest ask); you write in that 1:1 chat after it (a later message in a group chat may be about anything, so it doesn't count); the PR completes or is abandoned; a week passes since the newest ask; or you dismiss it. Your approval standing in Azure DevOps (10 or 5, as each scan reads it) closes it whenever you gave it: "need one more approval" after you approved leaves you nothing to do, and a push that resets votes takes it back to 0. The PR list the page loaded may be hours old, so its votes and comments close nothing ("please re-approve" after a reset must still show). Waiting for author, rejected, or a comment from before says nothing about a newer ask, so "addressed your comments, please take another look" still shows. A closed ask stays closed for what was said before it closed; asking again after opens a new one. Closing doesn't need Teams: a week and Azure DevOps close asks while reading Teams is off or Teams can't be reached, and the timer keeps going while any ask is open. Turning reading back on scans once any tick under way is done.
- **Kept:** who asked, where, when, a 280-character snippet and the links. Never whole messages. Closed asks go after 14 days.
- **Settings:** the Workspace section's **Teams and email** card has a switch for each part: **PR review asks from chats**, **Chat summaries**, **Meeting recaps** and **Email summaries** (all on by default, except Chat summaries follow PR asks turned off until set, and Email summaries either; off keeps what was found). Teams is read when either of the first two is on. Under each, what its last read did ("Last scan 4:26 PM: read 3 chats, 1 new · 2 open asks. Next scan 4:56 PM.", "Last summaries 4:26 PM: 5 conversations.", "Last scan 4:26 PM: 7 meetings yesterday and today, 2 new recaps · 1 waiting for Teams to write one.", "Last read 4:26 PM: 12 new in the inbox, 3 from people in 2 threads.", or why it couldn't read), and **Scan now** for all.
- **Links:** Teams links open in the Teams app (`msteams:`) when it's installed, else in the browser. Only `https://teams.microsoft.com/l/…` links are kept as where a to-do came from, on save and on read.

#### Communication

The Tasks pane's second tab: your Teams chats and email, by day, a line for each conversation that moved and each email thread people sent you.

- **Days:** like Meetings: the latest first, two weeks back; today open and filling in, earlier days folded with a line each ("Yesterday · Mon, Oct 26 · 6 chats · 4 emails · 1 needs you · 2 important"). Each day shows its **Chats**, then its **Email**. The sub line sums up today and when Teams or the inbox was last read; the head has a read-now button for both.
- **A conversation:** its name (a group's topic; for a 1:1, the other person; else who wrote), "1:1" or who else wrote, the time of its last message, and the line about it. What needs you comes first, with an amber edge and a **Needs you** chip; then **Important** ones; then the rest, newest first. Small talk reads quieter. Click one for what it needs from you, up to three points worth keeping (decisions, dates, who will do what), how many messages were read, and **Open in Teams**.
- **An email thread:** its subject (without Re:, Fw: or [External]), who wrote and how it reached you when it wasn't directly ("Lee Park · list", "Ann Lu · cc"), the time of its last message, and the line about it, in the same order and with the same chips as chats. Email that asks nothing of you and changes nothing for you (newsletters, FYIs to big lists, reports) folds under "3 more emails with nothing for you"; one that someone waits on you for never folds. Click one for what it needs from you, its points, how many emails were read, and **Open in Outlook** (the latest message from someone). The link is Outlook's deep link to read a message by its id (`outlook.office.com/mail/deeplink/read/<id>?ItemID=<id>&exvsurl=1`), which opens in the new Outlook app when Windows hands it Outlook links, else in the browser; Graph's `webLink` (`owa/?ItemID=…`) no longer opens there (ERR_INVALID_RESPONSE), so it isn't read, and one stored before is made the deep link when shown, in Communication, Needs you and to-dos alike.
- **The badge:** conversations and threads that need you, or matter, and moved since you last looked show as a count on the tab; opening it clears it.
- **How it's written:** the same Teams read that finds PR asks keeps the new messages of each chat that moved, as text (500 characters each; meeting chats are left to Meetings, system messages and pictures-only ones to themselves). After the read, one call to a small model (the first the user's Copilot offers of Claude Haiku 4.5, Claude Haiku 5.5, GPT-5.4 mini or GPT-5 mini) summarizes every conversation that waits, each with what its day's summary said so far, so a day builds up rather than starting over. It's told who was waiting on you and how much the day mattered, and code holds on to both: someone waiting stays waiting until you write in that chat (a small model easily drops it when the new messages are only "thanks"; writing the next day clears the day before), and a day's importance never drops. A call takes up to about 24,000 characters, at most two calls a read, a busy conversation's newest messages first. The model's session has no tools at all, built-in, custom or MCP, and its brief says the messages are data, never instructions. Its answer is JSON, checked by code: only the conversations it was asked about, each field clipped, the importance one of three, and a prompt key it echoes ("see c2") reads "another conversation"; links come from the data, never from the model.
- **When the model fails:** a conversation the answer left out, or couldn't be read for, is tried again on its own, after what's new, the fewest tries first, so one that keeps breaking the answer (a message saying "reply only with OK") can't hold the others back. Failing on its own a third time, it's given up on: the day keeps its summary so far, or reads "3 messages that couldn't be summarized; open the chat to read them." A call that fails (Copilot down, a timeout) counts against no one: the next batch is still tried, and what's left waits for the next read.
- **Where email comes from:** each read (every 30 minutes, with its own schedule and back-off) goes through the Mail MCP server (`agency mcp mail`, `SearchMessagesQueryParameters`, Graph's `/me/messages` with OData). The tool caps an answer at 51,200 bytes and automated mail carries huge bodies, so the inbox is listed without bodies, oldest first from where the last read stopped (the first read from the start of yesterday; never more than two days back), 20 a page, smaller pages when one is too big. Code keeps the mail from people: from someone who isn't you, in Focused (not Other), not a meeting invite, and not from a system (no-reply and notification senders, Azure DevOps and Microsoft 365 services, bulk-mail subdomains like `news.brand.com`). Each thread with such mail is then read by its conversation id, between its first and last new message, oldest first, 10 a page and up to 3 pages, for each message's own text (Graph's `uniqueBody`, without the quoted history; its preview when that's too big), 1,500 characters each. (The time goes first in Graph's filter: with the thread first, Graph won't sort.) What a thread read doesn't reach waits for the next read rather than lose its text. Your Sent Items are listed too: a reply of yours in a thread already summarized is read, so your answer clears its **Needs you**, and a reply the next morning starts the thread's new day under its subject, with its people and link, and clears the ask on the day before. Up to 12 threads a read; the rest wait, the read position held at the first message left, and the next read comes in 2 minutes, as it does when there was more of the inbox than a read's 5 pages. Nothing is marked read, moved or sent.
- **How email is summarized:** like chats, with the same model, rules, retries and holding on, under an email brief: each message says whether it was sent to you, cc'd, or through a list, and "high" is for someone asking you to do, decide or answer something, a deadline, an incident, or your manager or leadership writing to you.
- **What's kept:** a message's text only until it's summarized, then cleared; its row stays three days so a message read again isn't summarized twice. One never summarized goes after two days. Summaries are kept 14 days.
- **On or off:** chat summaries and email summaries each have their own switch in Settings. Chat summaries, never set, follow PR asks turned off, since both read the same chats: turning Teams off before they existed keeps Teams unread. Email summaries are on by default, except for a user who turned Teams reading or chat summaries off (an update doesn't start reading their mailbox). Turned off, the text of messages still waiting for a summary goes at once, and a read under way keeps nothing and sends nothing to the model; the summaries stay their two weeks.

#### Meetings

The Tasks pane's third tab: what your Teams meetings said, by day.

- **Days:** the latest first, two weeks back. Today is always there and open, and fills in as the day goes; earlier days fold up under it with a line each ("Yesterday · Mon, Oct 26 · 3 meetings · 2 recaps · 1 for you"). Click a day to open or fold it. The tab's sub line sums up today and when the calendar was last read ("Today: 4 meetings · 2 recaps · read 6:36 PM"); its head has a read-now button.
- **Meetings:** every Teams meeting on your calendar that you didn't decline, latest first: time, title, organizer and how many were invited, and a chip for its recap: **Recap**, **Recap pending** (it ended; Teams writes the recap, sometimes hours later), **No recap** (not transcribed, or none 4 hours after it ended), **No access** (Teams won't let you read it, like a big shiproom), **Upcoming** or **In progress**. "2 for you" says how many action items are yours.
- **A recap:** click a meeting to open it. Its action items come first, yours at the top on an amber band, each with who owns it and a **To-do** button; one already on your list says "In your to-dos" (or "Done"). Then the notes, each a title and a line or two, its details folded under "4 details". **Open in Teams** opens the meeting's chat, where Teams keeps the full recap.
- **To-do from an action item:** "Share the rollout plan: Kipack will share the plan by Friday. (from Rollout sync)", with the meeting under it as a link to its chat. Asked again, it gives back the same to-do. It never ticks itself: it's yours.
- **The badge:** recaps that came in since you last looked at the tab show as a count on it ("Meetings 3"); opening the tab clears it.
- **Where it comes from:** each read of the calendar (every 30 minutes, 10 minutes while a recap is due, and just after a meeting ends) takes yesterday's and today's calendar through the Calendar MCP server (`agency mcp calendar`, `ListCalendarView` in UTC), keeps the Teams meetings, and asks `GetOnlineMeetingAiInsights` for the recap of each one that ended: the one Teams' Copilot wrote, with no AI of ours. A recurring meeting has a recap per occurrence, and an occurrence whose transcription was stopped and started again has one per part: every part whose call ended within this occurrence (from 20 minutes before it starts to 4 hours after it ends) is merged, in order, each action item once.
- **Until it's in:** a meeting waiting for its recap is asked about at most every 8 minutes, up to 8 a read, however long the app was closed: a recap that came overnight is found the next morning. Only a look that worked can say there's no recap, once 4 hours have passed; a look that failed changes nothing, and looks that keep failing stop after 3 days. A recap is looked at again hourly until its 4 hours are over, in one call, and picks up a part that came later. A meeting taken off the calendar goes, unless it has its recap. Recaps and meetings are kept 14 days.

#### Workspace accessibility

- Polling keeps focus and typed text across repaints, so an Allow button, an answer box, a to-do being edited, the quick note or the task's chat box never loses the cursor.
- Worker and section status is always written out ("Needs you", "Turn done"), not shown by color alone.
- Enter sends in every message box; Shift+Enter adds a line. The quick note takes Enter as a new line.
- Each pane's fold button names it ("Fold Today"), and its rail reads "Show Today". Folding moves focus to the rail; showing a pane moves focus into it. The last open pane's fold button is hidden.
- A to-do's box is a checkbox (`role="checkbox"`, `aria-checked`) named by its text. Its tools appear when the row has keyboard focus, not only on hover. Moving one with Alt+Up/Down keeps focus on it. The quick note's save state is a live status.
- The task sheet is a modal dialog: Tab stays inside it, Escape closes the `/` list first and then the sheet, and focus returns to the task's card. Repaints put focus back on the same control, or on the sheet, so the keyboard never drops out. The highlighted `/` item is read out through a live region as you move.
- Today, Tasks, the Lead console and the task sheet update only what changed on each poll (`patch.ts`), so hover, text selection, inner scroll and typing survive a reply streaming in. Today and Tasks repaint separately: checking off a to-do doesn't touch the board. A chat message's id and length pin it: once rendered, it isn't rendered again.

### The background service

The window shows the app; a background service does the work. The service runs the local API and the pages it serves, the review and pipeline runners, the Workspace's workers and Lead, and their Copilot sessions.

- **Lifetime:** opening the app starts the service, or reuses the one already running. Closing the window leaves it running while anything is in flight: a worker's turn (including one waiting on you), a recap, the Lead's reply, a reviewer reply, a review running or queued, or a pipeline chain run. Two minutes after the last window closes with nothing in flight, it exits on its own.
- **One per data folder:** the service holds `service.lock` open with an exclusive lock for its whole life, and `service.json` holds its address, build and start time. Windows releases the lock when the process ends, crash included, so a leftover file never blocks a start. A second service for the same folder exits at once; one that finds the holder stopping waits up to 20 seconds for it.
- **States:** a service is starting, running or stopping. A stopping one turns new windows away, and they start its successor.
- **Never the wrong process:** the app only ends a service whose lock is held and whose process started when that service wrote its info. A process that reused the pid started later, so it's left alone, even while a newer service holds the lock. When the start time can't be read, nothing is ended. A stop request that gets no clear answer is never turned into a kill.
- **Hung:** a service that's alive and holds the lock but doesn't answer for 15 seconds is reported when the app opens: End it and start fresh, or Quit. While the window is open, it holds a connection to the service and checks its health every 15 seconds; four missed checks in a row offer Restart it or Keep waiting. Restart only ends the service the window still shows, and only if it still doesn't answer.
- **One address:** each service takes the port the last one used (`service.port`), or any free one when that's taken, so the page keeps its origin and its stored settings (folded panes, filters, an unsaved note) across restarts. The window reloads whenever the service behind it is a new process.
- **Busy checks:** the service asks each part what's in flight before exiting on its own. A part that doesn't answer within 10 seconds counts as busy ("not answering"), so a stuck check can't make it exit mid-work.
- **Losing it:** if the service stops while the window is open, the window starts a new one and reloads onto it. More than three losses in a minute ends with an error naming the log folder.
- **Updates:** a window only uses a service built from the same code. An idle service from an earlier build is replaced; a busy one is the user's call: stop it now (reviews in progress start again; workers continue from the next message), or quit and open the app once it finishes. `deploy-desktop.ps1` waits for work in flight with the window still open, so questions and approvals can be answered, then closes the window, stops the service and installs (`-Force` skips the wait).
- **Names:** the app was ADO PR Ops and the Lead was Jarvis until October 2026. The data folder kept its first name (`%APPDATA%\ADO PR Ops`): it holds the database, settings and the folders worker sessions run in, so nothing moved. The app installs to `%LOCALAPPDATA%\Programs\Devis` as `devis.exe` with a "Devis" Start menu shortcut; deploying closes a window still running from the old install and removes the old folder and shortcut. Internal names stayed (`ADO_PR_OPS_*` settings, `/api/jarvis`, `jarvis_*` tables, the toast identity). What the Lead signed as Jarvis (status lines, to-dos, validation proposals) reads Devis; free-text history keeps the old name. The Lead's brief tells it its old name and tool names, so a resumed conversation still makes sense.
- **Logs:** `%APPDATA%\ADO PR Ops\logs\service.log`, moved to `service.1.log` past 5 MB. `service-boot.log` holds anything printed before the log opens, and the window shows its tail when the service doesn't start.

### Copilot through Agency

Every Copilot call the app makes runs through Agency: background reviews, the reviewer chat, Ask, Elaborate and rephrase, the model list, and the Workspace's Lead, workers, recaps and write-ups. The service starts one shared runtime as `agency copilot` in headless mode (the SDK adds `--headless --stdio`), and Open in terminal runs `agency copilot --resume <id>`.

- **MCP servers:** every session has every server Agency and your Copilot config provide (ADO, Bluebird, WorkIQ, mail, calendar, Teams, Kusto, IcM, Ev2 and the rest), and may call any of their tools, writes included. Servers you turn off in your Copilot settings stay off. PR sessions swap in ADO and Bluebird scoped to the PR's org and project.
- **The web:** the Lead and workers search with `web_search` (from the GitHub MCP server) and read any page with `web_fetch`, without asking. Their briefs say so, so they don't claim to have no web access.
- **Still refused:** PR sessions read other people's PR text, so they can't run shell commands, edit files or fetch URLs. The write-up can't either, and the Lead can't run shell commands or edit files. Workers ask you before shell commands and edits.
- **Startup:** Agency takes about 10 seconds to start its MCP servers, so the service starts the runtime as soon as it starts. The first turn after that waits for the servers to connect (about half a minute); later turns take as long as before.
- **Clean up:** stopping the service stops Agency and everything under it; if the service is killed, Agency's processes exit with it.
- **Without Agency:** Copilot runs on the plain `copilot` CLI, without Agency's MCP servers and plugins. A banner says so until dismissed, and Settings shows how Copilot runs. Agency is looked for in `%APPDATA%\agency\CurrentVersion\agency.exe` (`ADO_PR_OPS_AGENCY_PATH` overrides it); install it and restart the app.

### Housekeeping

The app runs all day, so everything it holds has a limit.

- **Requests:** the local API reads bodies up to 10 MB and answers 413 past that. A refused body drains for 5 seconds at most, then its socket is dropped. Headers must arrive within 30 seconds and a request within 10 minutes. Stopping the service closes idle sockets at once and the rest after 2 seconds.
- **ADO responses:** read up to 64 MB. A file diff costs memory for the changed lines, not the file's size; past 2,000 changed lines it shows the old side removed and the new side added instead of a line-by-line match.
- **Stored history:** every 6 hours, and at start, the app deletes notifications older than 90 days, finished review jobs older than 30 days, Workspace events older than 120 days, chat images not sent or pasted for 30 days, and Teams asks closed over 14 days ago, with the read position of any chat not read in that long, meetings (with their recaps) and chat and email summaries older than 14 days, and chat and email messages' rows three days after they're summarized. Reviews, tasks, status lines and artifacts are kept.
- **Inbox watches:** a watch goes once its PR has been quiet for 30 days of polling, counted back from the org's last complete poll, so a closed app or a failing org never loses one. A new comment on the PR or thread keeps it. A PR that no longer exists (ADO answers 404) is dropped at once instead of failing the org's poll.
- **Workers:** a worker idle for 20 minutes lets go of its Copilot session; the next message resumes it. A failed recap is forgotten after 24 hours. PR checks are only kept for tasks in Tasks.
- **The Lead:** its chat is read once per change and shows the latest 200 messages.
- **Reviewer sessions:** remembered for 10 minutes, at most 500. A chat's state is dropped when its turn ends.
- **The page:** a request gives up after 5 minutes (10 seconds for the ping). Queueing a batch of reviews allows 30 minutes and a rephrase 40, since both wait on Copilot. Pollers never overlap themselves. Drafts, timelines and task-sheet state are dropped once their task leaves the Workspace, a to-do's draft once the to-do is gone, and fired reminders are forgotten after 6 hours.
- Terminals you open with `agency copilot --resume` are yours; the app doesn't close them.

### Accessibility

- Focus rings are a 2px `focus` (pale cyan) outline at a 1px offset, inset on full-width rows and tabs. They are never removed.
- Every icon-only control has an `aria-label`.
- The section tabs are buttons in a labelled `nav`, and the active one carries `aria-current`. The reviewers are a labelled `list`.
- In forced-colors mode, blur, the field effects and pane shadows are removed; selection bars and tab underlines use `Highlight`; the selected block gets a `Highlight` outline; and the severity, unread and status dots keep their colors.
- Under reduced transparency, every glass tier turns opaque and blur is off (see the Fallback Rule).

## Do's and Don'ts

### Do:

- Do use the tokens; add a token before adding a raw value.
- Do keep glass to panes, heads, floats, dialogs and pipeline blocks, and keep everything inside a pane as tints.
- Do keep one emissive cyan per view, and let severity and diff colors carry meaning.
- Do set IDs, branches, build numbers and other readouts in Cascadia Mono.
- Do check new components in `web/design-system.html`, at 1440px and below 1100px, and with reduced transparency on.

### Don't:

- Don't make rows, cards, badges or fields their own glass; nested blur muddies the content and costs frames.
- Don't put a backdrop blur on anything the size of the window (a dialog's scrim, a sheet). It redraws everything under it whenever anything changes; on a machine without a GPU that's the difference between the display's full rate and a stutter.
- Don't let anything other than cyan glow, and don't glow decoratively: glow means selection, focus, running or the primary command.
- Don't drop a float, head or dialog below 84% opacity; code and diagrams must never ghost through.
- Don't add light-theme surfaces; the shell forces dark so the glass always reads as smoked.
- Don't use colored side stripes on blocks, rows or cards.
- Don't use emoji as icons; use `icon()` from `web/src/icons.ts`.
- Don't put a `<button>` on the page without a base class.
- Don't show raw HTML or Markdown in previews.
