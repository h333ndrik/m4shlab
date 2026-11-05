# m4shlab validation findings

| ID | Ort | Befund | Status | Commit | Evidence | Verifiziert durch |
| --- | --- | --- | --- | --- | --- | --- |
| M-H1 | Shell-Header (`index.html` `<header>`, `styles.css` Header-Block) | Wortzeichen zu klein (15 px bei 1440), Header-Größen als feste px-Werte an drei Stellen verteilt, kein `env(safe-area-inset-top)` | implemented — Wartet auf User-Sichtprüfung 1440/390 | `415b00c`, `b18db06`, `602c0ab`, `0b50e4c` | `docs/validation/M-H1-HEADER/` | `npm run test:header`, `npm test`, `npm run test:pwa` |
| M-C1 | Cursor (`styles.css`, `assets/cursor/`) | Kein eigener Cursor: 13 verstreute Literale (`pointer`, `wait`, `progress`, `not-allowed`, `grab`), kein Abdeckungsvertrag fuer Player/Timeline/Dialoge | implemented — Wartet auf User-Sichtprüfung Desktop/Mobile | `3ef6f50`, `11cf3f6`, `fcc0678`, `ee7ccea` | `docs/validation/M-C1-CURSOR/` | `npm run test:cursor`, `npm test`, `npm run test:pwa` |

## M-H1 details

- Vorher: Header 34 px (1440/1024) bzw. 44 px (390/320), Wortzeichen 15 px,
  Padding 0, Abstand zum Inhalt 30/30/24/24 px.
- Nachher: Wortzeichen 20,88 px bei 1440 (+39,2 %), 18 px darunter; Header
  54 px / 50,38 px / 44 px / 44 px; Padding 10/8,19/4/4 px; Abstand zum Inhalt
  unverändert.
- Tokens statt fester Werte: `--header-wordmark-size`, `--header-wordmark-line`,
  `--header-tagline-size`, `--header-pad-block`, `--header-gap`,
  `--header-margin-block`.
- Abweichung von der Vorgabe: Dieser Shell-Header hat keine Tagline und kein
  SVG-Wortzeichen (nur `<h1>m4shlab</h1>` + Import-Control). Die
  Entkopplungs-Assertion prüft daher Tagline-Abwesenheit plus unveränderte
  Schriftgröße des Import-Controls bei geändertem Wortzeichen-Token.
- PWA-Standalone: `main` reserviert jetzt `env(safe-area-inset-top)`; eine
  echte Geräteprüfung steht aus (CDP kann `display-mode` nicht emulieren).

## M-C1 details

- Assets: h4ngelic cursor artwork (same viewBox/path/fill/stroke), scaled to
  19.7×29.6 / 20.88×31.38 / 21.28×31.97 SVG plus PNG fallbacks (20×30,
  21×31, 21×32). Hotspot `8 2` as required by the brief; the h4 original
  uses `9 2` and is 23.26×34.88, which exceeds Firefox's 32px cursor limit.
- Cascade: three levels (`base`, `interactive`, `pressed`), all `!important`,
  behind `(any-hover: hover) and (any-pointer: fine)`. Only four `cursor:`
  declarations remain, all `var(--m4-cursor*)`.
- Coverage: 4440/4440 points at 1440, 1184/1184 at 390 and 962/962 at 320
  contain `url(`; 26 mandatory surfaces, both open dialogs, pressed state,
  six assets with HTTP 200, and the 32px budget pass.
- Drag and touch negatives: cards still reorder with a constant cursor;
  coarse pointer keeps the system cursor, cards are not draggable, and the
  import target stays 44px.
- OS limits: native video controls, open `<select>` popups, drag ghosts and
  scrollbars are painted by the browser/OS and are documented, not fixable
  in CSS.
- Service worker: `v26` → `v27`, shell precache 27 → 33. Deployed asset
  proof lives in `docs/validation/M-C1-CURSOR/deployed-network.txt`.
