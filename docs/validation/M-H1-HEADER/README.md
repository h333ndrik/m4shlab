# M-H1 — header scale evidence

Scope: m4shlab shell header (`index.html` `<header>`, `styles.css` header block).
Status: implemented, automated contract green, awaiting user visual check at 1440 and 390.

## Premise check (difference from the briefing)

The briefing describes a header with an SVG wordmark **and a tagline**. This tree has:

- `<h1>m4shlab</h1>` — plain text wordmark, no SVG;
- the `+ Import videos` control as the only other header element;
- **no tagline element** (removed in `c8843c3`; `document.querySelector('header p') === null`).

The tagline token `--header-tagline-size` therefore exists for a future tagline but
has no consumer today. The decoupling assertion covers the elements that do exist:
changing `--header-wordmark-size` must not resize the neighbouring control text.

Stacking: the header is `display: flex; justify-content: space-between` at every
width; under 600 px it stays a row with `min-height: 44px`, `align-items: flex-start`
and the import control pushed right by `margin-left: auto`. That behaviour is
unchanged; the briefing's "stacking" refers to this row layout.

## Before / after (measured with headless Chrome, `deviceScaleFactor: 1`)

| Width | Metric | Before | After |
| --- | --- | --- | --- |
| 1440 | wordmark font-size | 15 px | **20.88 px (+39.2 %)** |
| 1440 | wordmark line box | 17 px (`line-height: normal`) | 24 px (`1.15`) |
| 1440 | header padding block | 0 px | 10 px top / 10 px bottom |
| 1440 | header height | 34 px | 54 px |
| 1440 | header margin-bottom / gap to content | 30 px | 30 px |
| 1024 | wordmark font-size | 15 px | 18 px (+20 %) |
| 1024 | header padding block | 0 px | 8.19 px |
| 1024 | header height | 34 px | 50.38 px |
| 1024 | header margin-bottom / gap to content | 30 px | 30 px |
| 390 | wordmark font-size | 15 px | 18 px (+20 %) |
| 390 | header padding block | 0 px | 4 px |
| 390 | header height | 44 px (`min-height`) | 44 px (`min-height` still governs) |
| 390 | header margin-bottom / gap to content | 24 px | 24 px |
| 320 | wordmark font-size | 15 px | 18 px (+20 %) |
| 320 | header height | 44 px | 44 px |
| 320 | scrollWidth / clientWidth | 320 / 320 | 320 / 320 |

Import control: 34 px tall and 112.38 px wide at all widths with a fine pointer
(unchanged); 44 px tall under `(pointer: coarse)` (unchanged).

## Where the values live

Before:

- `styles.css:54` `header { margin-bottom: 30px; }`
- `styles.css:56-62` `h1 { font-size: 15px; ... }`
- `styles.css:1009-1014` `@media (max-width: 600px) header { min-height: 44px; margin-bottom: 24px; }`

After — tokens in `:root` (`styles.css:13-25`), consumed only here:

| Token | Value | Consumer |
| --- | --- | --- |
| `--header-wordmark-size` | `clamp(18px, 1.45vw, 21px)` | `h1 { font-size }` |
| `--header-wordmark-line` | `1.15` | `h1 { line-height }` |
| `--header-tagline-size` | `clamp(12px, 1.1vw, 13px)` | `header p { font-size }` (no tagline today) |
| `--header-pad-block` | `clamp(4px, 0.8vw, 10px)` | `header { padding-block }` |
| `--header-gap` | `clamp(12px, 1vw, 16px)` | `header { gap }` |
| `--header-margin-block` | `30px`, `24px` under 600 px | `header { margin-bottom }` |

`safe-area`: `main` now reserves `padding-top: max(24px, env(safe-area-inset-top))`
in the `(pointer: coarse)` block, next to the existing left/right/bottom insets, so a
taller header cannot slide under a notch or Dynamic Island in standalone mode.

## Adjustment guide

1. Wordmark too small/large? Change only the `clamp()` in `--header-wordmark-size`
   (`styles.css` `:root`). Keep the 1440 value between 18.75 px and 21 px if the
   125–140 % corridor must hold; the contract test enforces it.
2. Header feels cramped or too airy? Change `--header-pad-block`.
3. Wordmark and import control too close? Change `--header-gap`.
4. Tagline (if one is ever added) has its own `--header-tagline-size`; it never
   follows the wordmark token.
5. After any change: `npm run test:header`, then `npm test` (the stamp check) and
   `npm run test:pwa` if shell files changed.

## Layout shift

CLS and pre/post-font-load header height are asserted on every width by
`tests/header-contract.mjs` (budget 0.1, height tolerance 2 px). Measured run:
`1440px/54.00px 1024px/50.38px 390px/44.00px 320px/44.00px`, CLS 0 on every width,
`scrollWidth === clientWidth` on every width.

## Service worker

Cache names moved `m4shlab-v25` / `m4shlab-runtime-v25` →
`m4shlab-v26` / `m4shlab-runtime-v26`; the stamp is identical in `sw.js` `VERSION`,
`app.js` `BUILD`, the `m4shlab-build` meta and `<html data-build>` (Node check
`PASS build stamp v26 ...`). Precache list stays at 27 assets.

## Screenshots

- `header-1440.png`, `header-1024.png`, `header-390.png`, `header-320.png`
- `header-390-standalone.png` — same viewport; note that CDP cannot emulate
  `display-mode: standalone` (`matchMedia('(display-mode: standalone)').matches`
  stayed `false`), so safe-area behaviour is guaranteed by the CSS `env()` guard and
  must be confirmed on a real device.
- `measurements.json` — the raw numbers captured with the screenshots.

## Grep proof: no fixed header typography values

```
$ sed -n '/^header {/,/^}/p;/^h1 {/,/^}/p;/^header p {/,/^}/p' styles.css \
  | grep -nE 'font-size:[[:space:]]*[0-9]|padding[^:]*:[[:space:]]*[0-9]'
$ echo $?
1
```

Exit code 1 means no match: the `header`, `h1` and `header p` rules contain only
token references for `font-size`, `padding-block`, `line-height`, `gap` and
`margin-bottom`. The shared `header, .section-label, .preview-meta { gap: 16px }`
rule still exists for the other two selectors; the header overrides it with
`gap: var(--header-gap)` in its own rule.
