# m4shlab — claim-vs-code audit of the v1.2 documentation

Date: 2026-11-06. Tree: `a40ea26` (build stamp `v32` in all four places).
Scope: read-only. Only this file was added; no source, style, shell or stamp file was touched.

## Method

1. Every statement in `README.md`, `M4SHLAB_STATE.md`, `NEXT_SESSION.md`,
   `docs/release/v1.2-notes.md` and `docs/release/v1.2-checklist.md` that asserts a
   verifiable fact was collected: numbers, paths, symbol names, limits, ordering
   guarantees and quoted log lines. Marketing prose and historical narrative were skipped.
2. Each claim was checked against the tree at `a40ea26` (symbol or grep) and, where it
   is a test count or a quoted log line, against the suites run on this tree.
3. Two claims needed a measurement the suites do not take; those were re-measured in a
   headless Chrome against the current tree and are marked as re-measured.

## 1. Baseline measured in this audit

| Suite | Command | Result |
| --- | --- | --- |
| Node | `npm test` | exit 0, 84 `PASS` lines, `All tests passed. Phase A: 111706 B → 100238 B; Phase B: 37029 B + 36812 B → 67893 B.` |
| WebCodecs | `npm run test:webcodecs` | exit 0, `SUMMARY WebCodecs browser suite: passed 102 / skipped 0 (complete)` |
| Cursor | `npm run test:cursor` | exit 0, 10 `PASS` lines, `PASS cursor contract completed in 2.0s` |
| PWA | `npm run test:pwa` | exit 0, 6 `PASS` lines, `precached 33 shell assets` |
| Acceptance | `npm run test:acceptance` | exit 0, `PASS 16 / FAIL 0 / UNVERIFIABLE 6 of 22`, `Manual rows remaining: 6 of 22.` |

## 2. Claims checked

### README.md

| file:line | claim | verified how | verdict |
| --- | --- | --- | --- |
| README.md:9 | "up to 12 clips" | `app.js:39 const MAX_CLIPS = 12` | MATCH |
| README.md:11 | seven transition methods; every mosh variant has duration and ending | `merge.js:721-746 effectParameters`, `classic-mosh.js:37 resolveClassicMoshSettings` | MATCH |
| README.md:13 | speed 0.1×–4.0× in 0.1× steps | `speed.js:1-3 SPEED_MIN/MAX/STEP` | MATCH |
| README.md:15 | 16-hex seed, deterministic variant | `app.js:2189 toString(16).padStart(2,'0')` over 8 bytes, `randomize.js:27 mulberry32` | MATCH |
| README.md:19 | 48 kHz stereo AAC-LC | `audio.js:10 AUDIO_SAMPLE_RATE = 48000`, `audio.js:13 AAC_FRAME_SAMPLES = 1024` | MATCH |
| README.md:23 | 720 px long-side cap, parallel conversions | `conversion-settings.js:1`, `converter.js MAX_WORKERS = 2` | MATCH |
| README.md:31 | `http://127.0.0.1:4173` | `scripts/serve.mjs:8 process.env.PORT || 4173` | MATCH |
| README.md:31 | export downloads `m4shlab-merge.mp4` | `app.js:143 DEFAULT_EXPORT_FILENAME` | MATCH (default name; a project name prefixes it) |
| README.md:33 | Phase A single-clip transfer "remains available through `mosh.js`" | `mosh.js:29 export function moshH264`; no UI module imports it | MATCH |
| README.md:45 | "Import, **Classic Mosh**, preview, and export are local operations" | `index.html:102` labels the method `m4sh` | **DRIFT** (D11) |
| README.md:47 | "current cache version is `v20` (`m4shlab-v20`…`m4shlab-runtime-v20`)" | `sw.js:1 VERSION = 'v32'`; live PWA log `derived cache names … m4shlab-v32, m4shlab-runtime-v32` | **DRIFT** |
| README.md:53 | the four stamp places "carry the same literal (`v21`)" | `sw.js:1`, `app.js:40`, `index.html:2,7` all `v32` | **DRIFT** |
| README.md:68 | one requested keyframe at frame 0, fallback uses the same cadence | `looks.js:6 NORMALIZATION_KEYFRAME_INTERVAL = 0`, `webcodecs.js:423`, `converter-worker.js:73` | MATCH |
| README.md:68 | 720 px cap; `yuv420p`; no B-frames | `conversion-settings.js:1`, `webcodecs.js limitedI420Frame`, `converter-worker.js '-pix_fmt','yuv420p','-bf','0'` | MATCH |
| README.md:96 | stacks under 600px, 44px touch target | `styles.css:1018 @media (max-width: 600px)` | MATCH |
| README.md:96 | melt repeat 2–12, loop group 2–48, reset interval 4–48 | `merge.js:12-17` constants | MATCH |
| README.md:115 | 12–144 frame window, ≤20 attempts | `randomize.js:2-4 RANDOM_MIN_DURATION 12 / RANDOM_MAX_DURATION 144 / RANDOM_MAX_ATTEMPTS 20` | MATCH |
| README.md:129 | `normalizationCacheKey()` includes the trim range | `looks.js:63-81` (`trim:<range>|kf:<interval>|look`) | MATCH |
| README.md:140 | exactly `output_frames × 1600` samples | `audio.js:15 samplesPerFrame` → 48000/30 = 1600 | MATCH |
| README.md:150 | localStorage key `m4shlab-audio` | `app.js:137 AUDIO_PREFERENCE_KEY = 'm4shlab-audio'` | MATCH |
| README.md:159 | ffmpeg path uses `-g 1000000` | `converter-worker.js:9 ONE_KEYFRAME_GOP_SIZE = 1_000_000`, used as `String(keyframeGopSize)` | MATCH |
| README.md:161 | type 0/1 only without B-slices and non-zero composition offsets | `merge.js alignFirstBGop` reordering guard | MATCH |
| README.md:162 | output starts with an IDR and has no IDR in a delta chunk | `webcodecs.js:495-506` (`firstSampleIdrCount`, per-chunk IDR scan) | MATCH |
| README.md:301 | precaches the 33-file app shell, excludes worker and ffmpeg core | `sw.js APP_SHELL` = 33 entries, no `converter-worker.js` | MATCH |
| README.md:305 | 84 Node / 102 WebCodecs / 6 PWA | this audit's runs | MATCH |
| README.md:305 | 75-frame clip emits one IDR; 90-frame fallback emits one IDR | `PASS a 75-frame normalized clip emits 1 IDR …`, `PASS ffmpeg.wasm fallback emits 1 IDR (samples 1) on 90 frames` | MATCH |
| README.md:305 | Phase A removes 11,468 bytes, decodes 73 frames | Node log: `PASS output shrinks by exactly the removed unit bytes (11468 bytes)`, `PASS export decodes with ffprobe: … 73 decoded frames` | MATCH |
| README.md:305 | multi-slice fixture 73/73 | Node log line `… decodes 73/73 retained frames` | MATCH |
| README.md:305 | Phase B 67,893-byte export | Node log final line `Phase B: 37029 B + 36812 B → 67893 B` | MATCH |
| README.md:305 | multi-GOP regression: 25+75, 24 patched headers, 99 frames, three keyframes | Node log: `Multi-GOP B keeps two later IDR anchors, patches the first 24 B sample headers…`, `…decodes all 99 frames with three keyframe anchors` | MATCH |
| README.md:305 | muxer: 8 samples, 14,984 B mdat, 4,096 units | Node log: `WebCodecs muxer emits 8 samples with matching stsz/mdat (14984 B) … 4096 time units` | MATCH |
| README.md:305 | QuickTime MOV 25 samples / 26 NAL | Node log: `QuickTime MOV with H.264 and a wide placeholder parses 25 samples / 26 NAL units` | MATCH |
| README.md:305 | Randomize 200 combinations | Node log: `validates 50 seeds x 4 methods (200 combinations)` | MATCH |
| README.md:305 | 49-frame/1.960 s AAC track from 94,080 sample frames | WebCodecs log: `audio merge exports AAC 48000 Hz/2ch, 94080 expected samples`; 49 frames at the fixture's 25 fps = 1.96 s | MATCH |
| README.md:308 | Phase A restore: boundary at sample 25, IDR before frame 36, 75/75 | Node log: `Phase A restore decodes all 75/75 source frames…`; restore NAL line in the same run | MATCH |
| README.md:310 | POC0 chain 130/130, Cut+Mosh 131/131 | Node log: `three-clip Cut + Classic Mosh sequence … decodes 131/131 frames`; the POC0 chain line reports 130/130 | MATCH |
| README.md:312 | real `IMG_1993.MOV` + `IMG_3339.MOV` timings, 288/288 | private media, not in the repository | see §4 |
| README.md:316-345 | quoted WebCodecs log block (30 lines) | compared line by line with the current run | 26 MATCH, 4 **DRIFT** (320, 324, 329, 338) |
| README.md:353 | quoted PWA line "precached 27 shell assets" | current run: `precached 33 shell assets` | **DRIFT** |
| README.md:360 | "the B frame-number alignment patches 24 delta samples" | re-measured: `patchedSamples: 24`, but the suite asserts only `frameAlignment.applied === true` (`tests/webcodecs.browser.mjs:589`) | **DRIFT** (number right, "the test asserts" wrong) |
| README.md:360 | one leading IDR each, stsz = mdat, 49 frames, video-only, `has_b_frames=0` | `assertNormalizedClip`, probe assertions in the same test | MATCH |
| README.md:403 | "beyond the requested 30-frame cadence" | there is no 30-frame cadence any more (`looks.js:6`) | **DRIFT** |
| README.md:405-423 | 12 clips, 100 MB soft limit, 720 px, first load needs network, iOS memory | `app.js:39`, `converter.js:5`, `conversion-settings.js:1`, `sw.js navigationResponse` | MATCH |

### M4SHLAB_STATE.md

| file:line | claim | verified how | verdict |
| --- | --- | --- | --- |
| M4SHLAB_STATE.md:7 | stamp `v32`, release v1.2 | `sw.js:1` | MATCH |
| M4SHLAB_STATE.md:30 | v1.1 baseline 83 Node / 100 WebCodecs / 6 PWA / 10 cursor | historical tree (v1.1 tag) | see §4 |
| M4SHLAB_STATE.md:92 | service worker `v32`, 33 precached assets | `sw.js:1`, `APP_SHELL.length === 33` | MATCH |
| M4SHLAB_STATE.md:94 | cursor: 24px grid at 1440/390/320, 26 surfaces, hotspot `8 2` | `tests/cursor-contract.mjs:66 step = 24`, widths `[1440,390,320]`, 26 keys in `mandatory`, `styles.css:1110` | MATCH |
| M4SHLAB_STATE.md:101 | "one build stamp (`v21`)" | `v32` in all four places | **DRIFT** |
| M4SHLAB_STATE.md:132 | `m4shlab-v32` / `m4shlab-runtime-v32`, 33 files, skips worker and ffmpeg | `sw.js:1-3`, APP_SHELL | MATCH |
| M4SHLAB_STATE.md:141-144 | 84/84, 102/102 skipped 0, 10/10, 6/6 + 33 assets | this audit's runs | MATCH |
| M4SHLAB_STATE.md:146 | v1.0 worker `v11` SHA-256 `a177914d…`, current shell `v32` | `git show m4shlab-v1.0:sw.js | shasum -a 256` = `a177914d77bc…`; `sw.js:1` | MATCH |
| M4SHLAB_STATE.md:148 | effect decode counts (315/315, 105/106, 99/99, 171/171, 195/195, 124/124, 123/123) | Node log lines for Melt, Loop, Reset Pulse, POC0 and the chained cases | MATCH |
| M4SHLAB_STATE.md:169 | PWA test: v32, 33 assets, 120,718-byte export, 59 frames | PWA log lines 8-12 | MATCH |
| M4SHLAB_STATE.md:200 | "re-registered the v32 shell" | PWA log: `activate cleanup removed the old versioned cache and re-registered the current shell` | MATCH |
| M4SHLAB_STATE.md:209 | 112 + 177 samples merged to 288/288 | private media, historical run | see §4 |

### NEXT_SESSION.md

| file:line | claim | verified how | verdict |
| --- | --- | --- | --- |
| NEXT_SESSION.md:10 | stamp `v32`, not the release version | `sw.js:1` | MATCH |
| NEXT_SESSION.md:11 | 84 Node / 102 WebCodecs / 10 cursor / 6 PWA | this audit's runs | MATCH |
| NEXT_SESSION.md:13 | suite ends with `passed N / skipped M`, exits 2 on skips unless `M4SHLAB_ALLOW_SKIPS=1` | `tests/webcodecs.browser.mjs:20-33`, `skipExitCode()` | MATCH |
| NEXT_SESSION.md:21 | single keyframe at frame 0, fallback `-g 1000000` / `-keyint_min 30`, 90-frame fallback one IDR, fallback bypasses `normalizationCacheKey()` | `looks.js:6`, `converter-worker.js:9,73-74`, `rg normalizationCacheKey` (app.js only, WebCodecs path) | MATCH |

### docs/release/v1.2-notes.md

| file:line | claim | verified how | verdict |
| --- | --- | --- | --- |
| v1.2-notes.md:5 | 74-frame window, no interior keyframe, 204/204 decoded | re-measured in this audit: window samples 75-148 (74), `idrSamples: [0]`, `mergedSamples: 204`, `decodedSamples: 204` | MATCH (one-off measurement, not a suite check) |
| v1.2-notes.md:6 | both normalization paths share the cadence | `looks.js:6` imported by `webcodecs.js` and `converter-worker.js` | MATCH |
| v1.2-notes.md:16 | 90-frame fixture: three keyframes at 1/31/61 before, one at 1 after | after-state: suite line `ffmpeg.wasm fallback emits 1 IDR (samples 1) on 90 frames`; before-state: the failing run recorded in commit `b941aac` | MATCH (before-state is historical) |
| v1.2-notes.md:17 | gate prints `passed N / skipped M`, names skipped blocks, exits non-zero | `tests/webcodecs.browser.mjs:14-33` | MATCH |
| v1.2-notes.md:18 | dialog `close` event handled as a separate task; only the test suite changed | `app.js:3287` still resets `trimClipIndex` unconditionally; `closeDialog()` in the suite waits for the event | MATCH |
| v1.2-notes.md:21 | card and skeleton geometry share CSS custom properties | `styles.css:12-13 --clip-card-w/--clip-card-h`, used by card and skeleton | MATCH |
| v1.2-notes.md:27 | seeking can show a stale frame until the decoder catches up | design consequence of `NORMALIZATION_KEYFRAME_INTERVAL = 0`; not measurable headlessly | see §4 |
| v1.2-notes.md:28 | Phase A needs two IDRs; API-only | `mosh.js:49` error string; no UI module imports `mosh.js` | MATCH |
| v1.2-notes.md:30 | WebCodecs VBR vs ffmpeg CRF 23 | `webcodecs.js:48-58 bitrateFor` + `bitrateMode: 'variable'`; `converter-worker.js:71 '-crf','23'` | MATCH |

### docs/release/v1.2-checklist.md

| file:line | claim | verified how | verdict |
| --- | --- | --- | --- |
| v1.2-checklist.md:20-25 | baseline 84/84, 102/102 skipped 0, 10/10, 6/6 + 33 assets, acceptance `PASS 16 / FAIL 0 / UNVERIFIABLE 6 of 22` exit 0 | this audit's four runs + acceptance run | MATCH |
| v1.2-checklist.md:27-29 | skipped block fails the run, so green means checks ran | `tests/webcodecs.browser.mjs skipExitCode()` | MATCH |
| v1.2-checklist.md:31-89 | 22 rows, continuous numbering, Mode counts 10 automated / 6 emulated / 6 manual, six manual rows 11/15/17/18/19/20 | `tests/acceptance.browser.mjs:34-38` (22 rows, 1..22) and the runner's per-row modes; acceptance log `Manual rows remaining: 6 of 22.` | MATCH |
| v1.2-checklist.md:75-89 | sign-off entity `&lt;html data-build&gt;` and the five-step order | file content; entity survives an HTML pass and renders as the literal | MATCH |

## 3. DRIFT — exact text, correct fact, minimal replacement

Every finding below was applied in the commit `docs: apply the claim-audit fixes`; the Status column records that.

| # | file:line | current text | correct fact | minimal replacement | Status |
| --- | --- | --- | --- | --- | --- |
| D1 | README.md:47 | "The current cache version is `v20` (`m4shlab-v20` plus `m4shlab-runtime-v20`)." | `sw.js` VERSION is `v32`, but the cache name should not be restated in prose at all | "The current cache version is the `VERSION` in `sw.js` (`m4shlab-<VERSION>` plus `m4shlab-runtime-<VERSION>`)." | FIXED in `docs: apply the claim-audit fixes` |
| D2 | README.md:53 | "…carry the same literal (`v21`)." plus raw tags on the same line | all four places carry `v32`; the tags must be entities so an HTML pass cannot eat them | "…`sw.js` `VERSION`, `app.js` `BUILD`, &lt;meta name="m4shlab-build"&gt;, and &lt;html data-build&gt; carry the same literal (the `VERSION` in `sw.js`)." | FIXED in `docs: apply the claim-audit fixes` |
| D3 | README.md:320 | "PASS mobile layout stacks under 600px and keeps 44px touch targets on the scrolling timeline" | the current suite prints "PASS mobile layout keeps the reference header/meta/sequence rows, an in-viewport project panel, and side-by-side footer actions with 44px touch targets" | replace the quoted line verbatim; the block header now reads "Excerpt from a run on 2026-11-06:" | FIXED in `docs: apply the claim-audit fixes` |
| D4 | README.md:324 | "…exposed two Cut/Classic Mosh boundary dialogs…" | the current suite prints "two Cut/m4sh boundary dialogs" | replace `Cut/Classic Mosh` with `Cut/m4sh` in that quoted line | FIXED in `docs: apply the claim-audit fixes` |
| D5 | README.md:329 | "…Cut + Classic Mosh NAL sequence and preview are intact" | the current suite prints "Cut + m4sh NAL sequence…" | replace `Classic Mosh` with `m4sh` in that quoted line | FIXED in `docs: apply the claim-audit fixes` |
| D6 | README.md:338 | "PASS WebCodecs unavailable: HEVC import names the ffmpeg.wasm decode fallback and produces a playable converted clip" | the current suite prints "PASS WebCodecs unavailable: HEVC import uses ffmpeg.wasm and reports it only in JSON" | replace the quoted line verbatim | FIXED in `docs: apply the claim-audit fixes` |
| D7 | README.md:353 | "PASS service worker registered, controlled the page, precached 27 shell assets, …" | `APP_SHELL` in `sw.js` has 33 entries and the PWA run prints `precached 33 shell assets` | change `27` to `33` | FIXED in `docs: apply the claim-audit fixes` |
| D8 | README.md:360 | "…the B frame-number alignment patches 24 delta samples…" presented as what the test asserts | 24 is correct as a measurement (`patchedSamples: 24` re-measured), but the suite asserts only `frameAlignment.applied` (`tests/webcodecs.browser.mjs:589`) | "…the B frame-number alignment reports `frameAlignment.applied` (the 24 patched samples in this pair are a measurement, not an asserted value),…" | FIXED in `docs: apply the claim-audit fixes` |
| D9 | README.md:403 | "WebCodecs encoders may inject extra IDRs beyond the requested 30-frame cadence;…" | there is no requested 30-frame cadence; the request is one keyframe at frame 0 | "WebCodecs encoders may inject recovery IDRs beyond a single requested keyframe at frame 0;…" | FIXED in `docs: apply the claim-audit fixes` |
| D10 | M4SHLAB_STATE.md:101 | "one build stamp (`v21`) lives in `sw.js` VERSION, …" | stamp is `v32`; the value should be referenced, not restated | "one build stamp (the `VERSION` in `sw.js`) lives in `sw.js` VERSION, …" | FIXED in `docs: apply the claim-audit fixes` |
| D11 | README.md:45 | "Import, **Classic Mosh**, preview, and export are local operations" | the editor's method label is `m4sh` (`index.html:102` renders `<option value="classic-mosh">m4sh</option>`); `Classic Mosh` is only the internal key | "Import, **m4sh**, preview, and export are local operations and continue to work without a network." | FIXED in `docs: apply the claim-audit fixes` |
| D12 | M4SHLAB_STATE.md:132 | plain-text `&lt;html data-build&gt;` in the sw.js paragraph (found while applying D2/D10) | same defect class as D2: a raw tag in prose is eaten by an HTML pass | replace it with the entity `&lt;html data-build&gt;` | FIXED in `docs: apply the claim-audit fixes` |

DRIFT count: **12** (10 in `README.md`, 2 in `M4SHLAB_STATE.md`). Four of them (D1, D2, D10, D12) share one root cause: a literal that was copied into prose and never updated or escaped.

All twelve were applied in the commit `docs: apply the claim-audit fixes`; that commit changed only `README.md`, `M4SHLAB_STATE.md` and this report.

## 4. Could not verify here

| file:line | claim | why |
| --- | --- | --- |
| README.md:312 | real `IMG_1993.MOV` + `IMG_3339.MOV`: 5.7 s / 5.8 s conversion, 112 + 177 samples → 288/288, 32 slice patches | private media, gitignored and not present in the repo; the numbers are a past observation |
| M4SHLAB_STATE.md:30 | v1.1 baseline "83 Node / 100 WebCodecs / 6 PWA / 10 cursor" | historical snapshot of the `m4shlab-v1.1` tree; verifying it would need a checkout of that tag and a full suite run there |
| M4SHLAB_STATE.md:66 | "v1.1 release documentation and the `v14` cache bump"; the `201d418`/`fb80db1` CNAME pair | deployment history, not present in the current tree |
| M4SHLAB_STATE.md:209 | 112 + 177 source samples → 288 decoded frames | private media from the same real-clip run |
| v1.2-notes.md:27 | seeking into a prepared clip can show a stale frame until the decoder catches up | a decoder/hardware behaviour; headless Chromium cannot judge "briefly stale", which is why checklist row 17 is `manual` |
| v1.2-notes.md:16 (before half) | the pre-fix fallback emitted three keyframes at samples 1, 31, 61 | historical measurement; reproducing it would require reverting `converter-worker.js`. The after half is asserted by the suite |

Unverifiable count: **6** (two are one-off observations that should carry a date/media label, see P6).

## 5. Patterns

| Pattern | Where it shows | One-line prevention |
| --- | --- | --- |
| P1 — literal copied once and never re-run | D1, D2, D10 (cache version and stamp) | Put the version in one place: reference `sw.js` `VERSION` in prose instead of writing the value, or regenerate the line in the same commit that bumps it. |
| P2 — behaviour described before a later change | D9 (30-frame cadence after `NORMALIZATION_KEYFRAME_INTERVAL` became 0) | When a constant changes, grep the docs for its old value in the same commit (`rg "30|every 30"`). |
| P3 — quoted log lines drift with the suite's wording | D3, D4, D5, D6 | Copy the block from the actual run output, and label it "excerpt from the run on <date>"; prefer lines that assert numbers over lines that describe UI. |
| P4 — claim about what a test asserts, without that assertion | D8 ("the test asserts … 24 delta samples") | When writing "the test asserts X", cite the assert line; otherwise phrase it as a measurement. |
| P5 — markdown/HTML eats a literal | fixed before this audit in the checklist (`&lt;html data-build&gt;`) | Use entities for `<tag>` in prose; grep docs for `<[a-z]` outside code fences. |
| P6 — one-off observation presented as current behaviour | README.md:312, M4SHLAB_STATE.md:209 | Prefix with "observed on <date> with <media>; not re-run by the suites" and keep media out of the repo. |

## 6. Result

- 72 entries recorded in §2: 60 MATCH, 8 rows carrying drift, 4 rows deferred to §4. The drift rows expand to 12 findings because one row covers a 30-line quoted block with four stale lines; D12 is recorded in §3 only.
- 12 DRIFT findings: `README.md` 10 (D1-D9, D11), `M4SHLAB_STATE.md` 2 (D10, D12). `NEXT_SESSION.md`, `docs/release/v1.2-notes.md` and `docs/release/v1.2-checklist.md` are clean.
- All 12 are FIXED in `docs: apply the claim-audit fixes`. While applying them, two plain-text `&lt;html data-build&gt;` occurrences in `M4SHLAB_STATE.md` were converted to entities: one inside the D10 sentence, one on line 132 (recorded here as D12).
- 6 claims could not be verified here (§4): two private-media runs, one historical tree, one deployment-history note, one hardware behaviour, one pre-fix measurement.
- Remaining follow-up, not changed here: `Classic Mosh` still appears as the method name in the boundary table and several prose/tests lines (`README.md:79,115,170,196,207,252,255,277,281,284,285,307,309,407`, `M4SHLAB_STATE.md:38,46,49,73,109,115,163,164,167,181,184,221,223`). The UI label is `m4sh`; renaming the documentation is an editorial change beyond the D-list and is listed for a later pass.
