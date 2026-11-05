# M-C1 — native h4 cursor on m4shlab

Scope: native CSS cursor cascade only. No JS overlay, no changes to mosh,
merge, codec, audio, drag behaviour, touch targets, layout or theme.

Measured on 2026-11-05 with the local server and headless Chrome (Node 26.13.0).
The "before" values come from `git show HEAD:styles.css` at `d3a829d`; the
M-C1 stylesheet was disabled and the HEAD sheet injected for the measurement
(see `inventory.json`). The "after" values are computed from the committed
token cascade.

## Assets

The artwork is the h4ngelic cursor (`public/assets/h4ngelic-cursor.svg`,
viewBox `350 124 615 1006`, black fill plus white outline). The geometry,
path data, fill and stroke are unchanged. Only the SVG `width`/`height`
attributes were scaled so every file stays inside Firefox's 32 px cursor
budget; the PNGs were rasterised from the same SVG with transparent RGBA.

| File | Intrinsic size | Format | Hotspot | Origin |
| --- | --- | --- | --- | --- |
| `assets/cursor/m4-cursor.svg` | 19.7 × 29.6 | SVG | 8 2 | h4ngelic base cursor, scaled |
| `assets/cursor/m4-cursor.png` | 20 × 30 | PNG RGBA | 8 2 | raster of base SVG |
| `assets/cursor/m4-cursor-interactive.svg` | 20.88 × 31.38 | SVG | 8 2 | h4ngelic base × 1.06 (interactive) |
| `assets/cursor/m4-cursor-interactive.png` | 21 × 31 | PNG RGBA | 8 2 | raster of interactive SVG |
| `assets/cursor/m4-cursor-pressed.svg` | 21.28 × 31.97 | SVG | 8 2 | interactive × 1.02 (≈1.08 total) |
| `assets/cursor/m4-cursor-pressed.png` | 21 × 32 | PNG RGBA | 8 2 | raster of pressed SVG |

Notes:

- The h4ngelic original is 23.26 × 34.88 and uses hotspot `9 2`. The brief
  requires hotspot `8 2` and a 32 px maximum, so m4shlab uses the brief's
  hotspot and the scaled sizes above. This is the only deliberate deviation
  from a byte-for-byte asset copy.
- SVG is first in every token; the PNG is the fallback for renderers without
  SVG cursor support. All six files are in the service-worker precache.

## Interactive-surface inventory

`pointer-events` is unchanged for every row. "draggable" reflects the
measured DOM state at 1440 px with a fine pointer and two imported clips.

| Surface | Selector | Cursor before | pointer-events | draggable | Cursor after |
| --- | --- | --- | --- | --- | --- |
| `header` | `header` | `auto` | auto | no | base URL |
| `wordmark` | `header h1` | `auto` | auto | no | base URL |
| `importLabel` | `header label.button` | `pointer` | auto | no | interactive URL |
| `player` | `#preview-video` | `auto` | auto | no | interactive URL |
| `previewMeta` | `.preview-meta` | `auto` | auto | no | base URL |
| `soundLabel` | `.sound-toggle` | `pointer` | auto | no | interactive URL |
| `soundCheckbox` | `#sound-toggle` | `default` | auto | no | interactive URL |
| `exportButton` | `#export-button` | `pointer` | auto | no | interactive URL |
| `assembleButton` | `#assemble-preview` | `pointer` | auto | no | interactive URL |
| `undo` | `#undo-button` | `pointer` | auto | no | interactive URL |
| `redo` | `#redo-button` | `not-allowed` | auto | no | interactive URL |
| `projectSummary` | `#project-menu summary` | `pointer` | auto | no | interactive URL |
| `sequenceHeading` | `#source-heading` | `auto` | auto | no | base URL |
| `clipCard` | `.clip-card` | `grab` | auto | yes | interactive URL |
| `clipThumb` | `.clip-thumb` | `grab` | auto | no | base URL |
| `lookSelect` | `.clip-look select` | `default` | auto | no | interactive URL |
| `speedSlider` | `.clip-speed input[type="range"]` | `default` | auto | no | interactive URL |
| `speedReset` | `.clip-speed button` | `wait` | auto | no | interactive URL |
| `trimButton` | `.clip-trim-button` | `pointer` | auto | no | interactive URL |
| `reorderButton` | `.clip-controls button[aria-label^="Move"]` | `not-allowed` | auto | no | interactive URL |
| `connector` | `.connector` | `pointer` | auto | no | interactive URL |
| `dropZone` | `#drop-zone` | `auto` | auto | no | base URL |
| `footer` | `footer` | `auto` | auto | no | base URL |
| `bitstreamSummary` | `#bitstream-report summary` | `pointer` | auto | no | interactive URL |
| `transitionDialog` | `#transition-dialog` | `auto` | auto | no | base URL |
| `transitionMethod` | `#transition-method` | `default` | auto | no | interactive URL |
| `transitionDuration` | `#transition-duration` | `default` | auto | no | interactive URL |
| `transitionEnding` | `#transition-ending` | `default` | auto | no | interactive URL |
| `transitionRandomize` | `#transition-randomize` | `pointer` | auto | no | interactive URL |
| `seed` | `#transition-seed` | `text` | auto | no | interactive URL |
| `apply` | `#transition-apply` | `pointer` | auto | no | interactive URL |

Additional required surfaces measured while the transition dialog was open:
`#transition-method`, `#transition-duration`, `#transition-ending`,
`#transition-randomize`, `#transition-seed` and `#transition-apply` all moved
from `default`/`text`/`pointer` to the interactive cursor URL; the dialog
surface itself uses the base cursor URL. The trim dialog (`#trim-dialog`,
`#trim-start`, `#trim-end`, `#trim-start-range`, `#trim-preview-in`,
`#trim-reset`, `#trim-apply`) is covered by the same contract suite.

No install banner exists in this shell; the browser owns that UI. It is
covered by the native-UI limits below.

## Token cascade and rule winners

`styles.css` ends with the cascade and every rule uses `!important`:

- Level 1: `html, html *, *::before, *::after` → `--m4-cursor`
- Level 2: `a[href], button, summary, [role="button"], input, select,
  textarea, label, [draggable="true"], [contenteditable], video, canvas`
  → `--m4-cursor-interactive`
- Level 3: the same list with `:active` → `--m4-cursor-pressed`

The media query is `(any-hover: hover) and (any-pointer: fine)`, so hybrid
laptops with a touch screen and a mouse still get the custom cursor.

Rule-winner probe (computed winner, not just a matching value):

| Surface | Winning source | Winning selector | Value |
| --- | --- | --- | --- |
| header, footer, preview-meta, headings, drop zone | `styles.css` | `html, html *, ::before, ::after` | `var(--m4-cursor)` |
| player | `styles.css` | Level 2 list (`video`) | `var(--m4-cursor-interactive)` |
| clip card | `styles.css` | Level 2 list (`[draggable="true"]`) | `var(--m4-cursor-interactive)` |
| connector, export, assemble, undo, redo, trim, randomize | `styles.css` | Level 2 list (`button`) | `var(--m4-cursor-interactive)` |
| speed slider, sound checkbox | `styles.css` | Level 2 list (`input`) | `var(--m4-cursor-interactive)` |
| look select, method, ending | `styles.css` | Level 2 list (`select`) | `var(--m4-cursor-interactive)` |
| import label, sound label, field labels | `styles.css` | Level 2 list (`label`) | `var(--m4-cursor-interactive)` |
| pressed state | `styles.css` | Level 3 list (`button:active` etc.) | `var(--m4-cursor-pressed)` |

The contract asserts that every matching cursor declaration comes from
`styles.css`, is `!important`, and references a `--m4-cursor*` token. A
foreign rule would fail even if its computed value looked correct.

## Coverage results

`npm run test:cursor` (headless Chrome, 1440 / 390 / 320):

- Hit test, 24 px grid over the viewport at both scroll positions:
  - 1440 px: **4440 / 4440** points contain `url(`
  - 390 px: **1184 / 1184** points contain `url(`
  - 320 px: **962 / 962** points contain `url(`
- 26 mandatory surfaces probed directly (player, clip cards, connectors,
  speed slider, look select, sound checkbox, import, drop zone, export,
  assemble, undo/redo, transition dialog open/closed, trim dialog, header,
  footer).
- Press test: pointerdown on a `<summary>` reports
  `m4-cursor-pressed.svg`; pointerup returns to the interactive cursor.
- Asset load test: all six computed cursor URLs (base, interactive, pressed;
  SVG and PNG each) return HTTP 200 and have a non-zero intrinsic size.
- Image budget: all six files are at most 32 px in both dimensions.
- Drag negative test: two cards reorder after HTML5 drop; source and target
  cursors stay on the interactive token throughout.
- Touch negative test at 390 px: `(any-hover: hover) and (any-pointer: fine)`
  is false, the system cursor (`auto`) is used, cards are not draggable, and
  the import target remains 44 px tall.
- Runtime: 2.5 s, under the 90 s budget.

## Service worker

| Item | Before | After |
| --- | --- | --- |
| `sw.js` VERSION | `v26` | `v27` |
| Shell cache | `m4shlab-v26` | `m4shlab-v27` |
| Runtime cache | `m4shlab-runtime-v26` | `m4shlab-runtime-v27` |
| Precached shell files | 27 | 33 (six cursor files added) |

`app.js` `BUILD`, `<meta name="m4shlab-build">` and `<html data-build>` were
bumped with the SW version; `npm test` enforces the four-way stamp match.
`npm run test:pwa` reports 6/6 PASS and 33 precached shell assets.

## OS/browser limits (documented, not solvable in CSS)

- The native fullscreen control bar of the `<video>` element is browser UI.
- An open native `<select>` dropdown is rendered by the OS/browser popup.
- The HTML5 drag ghost is drawn by the browser; `cursor` does not affect it.
- Scrollbars are painted by the browser, not by the page.
- Anything outside the viewport (browser chrome, URL bar, OS menus) is never
  under page cursor control.

## Deployment proof

`https://h333ndrik.github.io/m4shlab/assets/cursor/` — network proof is
recorded in `deployed-network.txt` after the push; all six asset URLs and the
served `sw.js` are checked there.

## Evidence files

- `inventory.json` — raw before/after measurements for 30 surfaces
- `desktop-1440.png`, `mobile-390.png`, `transition-dialog-1440.png`
- `deployed-network.txt` — deployed URL/status/SHA-256 proof
