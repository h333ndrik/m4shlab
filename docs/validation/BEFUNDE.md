# m4shlab validation findings

| ID | Ort | Befund | Status | Commit | Evidence | Verifiziert durch |
| --- | --- | --- | --- | --- | --- | --- |
| M-H1 | Shell-Header (`index.html` `<header>`, `styles.css` Header-Block) | Wortzeichen zu klein (15 px bei 1440), Header-Größen als feste px-Werte an drei Stellen verteilt, kein `env(safe-area-inset-top)` | implemented — Wartet auf User-Sichtprüfung 1440/390 | `415b00c`, `b18db06`, `602c0ab`, `0b50e4c` | `docs/validation/M-H1-HEADER/` | `npm run test:header`, `npm test`, `npm run test:pwa` |

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
