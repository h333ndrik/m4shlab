# m4shlab vs supermosh — capability comparison

Date: 2026-11-06. m4shlab tree: `cdd6a35`, build stamp `v32`.
supermosh: `github.com/supermosh/supermosh.github.io`, branch `main`, files fetched 2026-11-06.
Read-only research: no m4shlab code was changed and no supermosh code was copied.

## Summary

| Class | Count | Items |
| --- | --- | --- |
| Already closed | 2 | one keyframe per clip (supermosh `-g 99999999`, m4shlab `NORMALIZATION_KEYFRAME_INTERVAL = 0`), no B-frames on the mosh path |
| Real capability gaps | 6 | quality target, resolution ceiling, decoder acceleration control, segment/`repeat` timeline model, image input, a "this export contains no glitch" guard |
| Stylistic only | 3 | 480p/720p/1080p preset buttons vs a computed single target, free W×H vs one even target, tabbed `<Section>` layout vs the timeline editor |

Nothing below was measured visually. Wherever a number appears it is a measured
setting or a local ffmpeg measurement, not a claim that one output looks better.

## Sources read

All paths resolve in the supermosh tree (`GET /repos/supermosh/supermosh.github.io/git/trees/main?recursive=1`):

| Path | Lines | Used for |
| --- | --- | --- |
| `src/lib.ts` | 143 | encode arguments, chunk extraction, decode/record loop |
| `src/types.ts` | 23 | `Vid`, `Segment`, `Settings` |
| `src/Rendering.tsx` | 178 | render size, hardware acceleration, guards, repeat expansion |
| `src/Timeline.tsx` | 139 | segment editing, clamps, `fixFroms` |
| `src/FilesEditor.tsx` | 140 | import, preprocessing, reprocess guard |
| `src/Studio.tsx` | 69 | default 640×480, ffmpeg load gate |
| `src/Home.tsx` | 172 | product description only (no editor logic) |
| `src/NumberInput.tsx` | 35, `src/SelectInput.tsx` 15, `src/RangePreview.tsx` 11, `src/components/Section.tsx` 16 | small UI primitives |

## 1. Quality target

supermosh re-encodes the source at the render size with `-crf 15` and no bitrate
cap: `src/lib.ts:37-41` runs
`-i <in> -vf scale=W:H -vcodec libx264 -g 99999999 -bf 0 -flags:v +cgop -pix_fmt yuv420p -movflags faststart -crf 15 <out>`.
m4shlab asks WebCodecs for a resolution-derived bitrate,
`bitrateFor(width, height) = clamp(width * height * 3, 500 kbit/s, 20 Mbit/s)`
(`webcodecs.js:48-50`), with `bitrateMode: 'variable'` and
`latencyMode: 'realtime'` (`webcodecs.js:53-60`). For 720p that target is
1280 × 720 × 3 = 2,764,800 bit/s ≈ 2.76 Mbit/s.

Measured in this block with local ffmpeg on the same 3-second 1280×720 source
(`testsrc2`, 30 fps):

| Encode | Bitrate | Size | PSNR-Y vs source |
| --- | --- | --- | --- |
| supermosh settings (`-crf 15 -g 99999999 -bf 0`) | 5.61 Mbit/s | 2,103,670 B | 52.53 dB |
| m4shlab 720p target (2,764,800 bit/s, libx264 medium as a proxy) | 2.90 Mbit/s | 1,089,284 B | 43.59 dB |

So at 720p supermosh spends roughly **1.9× the bitrate (≈ 2.7 Mbit/s more)** and
lands about **9 dB higher PSNR** on this synthetic source. The proxy is not the
browser encoder: `latencyMode: 'realtime'` and the device encoder can land
anywhere near the target, and real footage compresses differently from
`testsrc2`. m4shlab has no CRF mode at all — the only knob is resolution.

Matter for m4shlab: **yes** — because the encode quality decides how much detail
survives inside the corrupted window, but it does not change the length of the
prediction chain, so this is fidelity, not mosh strength.

## 2. Resolution

supermosh has no cap: `src/Rendering.tsx:48-60` offers 480p, 720p and 1080p
presets, and `src/Rendering.tsx:34-46` accepts any width/height in steps of 4
(minimum 4 px). Files are pre-scaled to that size before chunk extraction
(`src/FilesEditor.tsx:71-78`), which is why changing the size forces a reprocess
(`src/Rendering.tsx:92-96`).

m4shlab caps the long side at 720 px for the *conversion* target
(`conversion-settings.js:1 MAX_TARGET_LONG_SIDE = 720`). That cap only applies
to clips that go through normalization or conversion. A sequence whose members
are natively compatible is merged without re-encoding and keeps the resolution of
clip A, because the merged track is rebuilt from A's sample description
(`merge.js:1658 buildMergedTrack` → `rebuildMoov(inputA, parsedA, …)`); nothing
in that path scales. A 1080p native pair therefore exports at 1080p, above the
720 px normalization cap.

Matter for m4shlab: **yes for large or high-detail sources** — because a 720 px
cap throws away detail before the glitch, while a native 1080p pair keeps it —
but the cap is also the main reason large conversions still fit in iOS memory.

## 3. Bake-in vs bitstream

supermosh never exports an edited bitstream. It decodes the prepared chunks with
`setInterval(…, 1000 / FPS)` (`src/lib.ts:127-142`), paints each frame onto a
canvas (`src/lib.ts:106-113`), records `canvas.captureStream()` with
`MediaRecorder` (`src/lib.ts:115-116`) and hands back a Blob URL (`src/lib.ts:117-122`).

Gains: the output is a fresh, ordinary MP4/WebM that any player opens; frame
timing is uniform; the corruption is frozen into pixels, so playback does not
depend on how a decoder handles a broken reference chain.

Losses: it is a second generation encode (additional loss on top of the CRF-15
pass), the result depends on `MediaRecorder` support and on the chosen mime type
(`src/Rendering.tsx:114-116` falls back to WebM), there is no audio track at all
(the recorded stream is the canvas), and a slow decode simply drops frames
because the interval does not wait for the decoder.

m4shlab does the opposite: it edits NAL units and keeps every retained payload
byte-identical, which is why the same file can look different on different
devices — the documented tradeoff in `README.md` ("Honest limits").

Matter for m4shlab: **no** — because bake-in would replace the product's core
claim (real bitstream editing) with a re-encode; the device dependency is the
price of that claim, not an oversight.

## 4. Segment / `repeat` model

A supermosh segment is `{name, from, to, repeat}` on a chunk index range
(`src/types.ts:13-18`), edited in `src/Timeline.tsx` and expanded at render time
by `segments.flatMap(s => repeat × chunks.slice(s.from, s.to))`
(`src/Rendering.tsx:105-113`). Segments are freely reorderable and several can
point at the same file.

m4shlab attaches one transition method to each boundary between clips
(`merge.js:721-746 effectParameters`), with a frame-quantized window, an ending
and method-specific parameters; each clip also carries a trim range, speed and
look.

Concrete capability supermosh has and m4shlab does not: play an arbitrary chunk
range **again N times** as a building block — e.g. take frames 40-52 of one clip
and repeat that block five times in the middle of the timeline. m4shlab's Loop
Release repeats a group only inside one boundary window, and Melt repeats single
donors by count, so the same result needs a duplicated clip plus a hand-tuned
window.

Matter for m4shlab: **unknown** — because it is a workflow capability, not a
strength lever; it cannot be judged without trying the workflow on real projects.

## 5. Decoder control

supermosh exposes `hardwareAcceleration` with the default `'prefer-software'`
(`src/Rendering.tsx:27-28`), a three-way selector Auto/CPU/GPU
(`src/Rendering.tsx:69-81`), and passes it into `decoder.configure({...config, hardwareAcceleration})`
(`src/lib.ts:113`). m4shlab sets only `optimizeForLatency: true`
(`webcodecs.js:83`, `webcodecs.js:97`) and lets the browser decide.

Exposing it would make the corruption reproducible across machines, because a
software H.264 decoder conceals a broken reference chain the same way everywhere,
while hardware decoders differ per GPU/driver. The cost is real: the option is
only a preference, browsers may ignore it, and Safari on iOS often has no
software H.264 path at all — the value can throw `NotSupportedError` or silently
fall back, and a software decode of a long clip is much slower and more memory
hungry, which is exactly where iOS already struggles.

Matter for m4shlab: **yes for reproducibility** — because two users exporting
the same project on different machines currently get different glitches with no
way to tell why.

## 6. Guards and validation

Every precondition before a supermosh render:

| Guard | Where | What it catches |
| --- | --- | --- |
| decoder config must exist, at least one segment | `src/Rendering.tsx:83-84` | render before any file was processed |
| refuse when every referenced source has exactly one chunk | `src/Rendering.tsx:85-91` | an export that is only still images and would show no glitch |
| render size must equal the size the files were preprocessed at | `src/Rendering.tsx:92-96`, reprocess action `src/FilesEditor.tsx:97-128` | rendering chunks that were scaled for a different size |
| first segment starts at chunk 0, no later segment starts at chunk 0 | `src/Timeline.tsx:24-29` (`fixFroms`) | re-inserting the keyframe chunk and killing the glitch |
| `from`/`to`/`repeat` clamped on edit and on source switch | `src/Timeline.tsx:55-56`, `:70-71`, `:83-84`, `:94` | out-of-range indices |
| unique file names on import | `src/FilesEditor.tsx:62-70` | two files collapsing onto one `name` key |
| render mime type falls back to WebM | `src/Rendering.tsx:114-116` | unsupported `video/mp4` in MediaRecorder |
| ffmpeg must be loaded before the studio renders | `src/Studio.tsx:44-45` | acting on a missing wasm core |

Which would catch a bug m4shlab ships silently: the **no-glitch guard**. A
m4shlab sequence whose boundaries are all Cut exports a merged file with no
effect and no warning; a user can wait through a conversion for a result that
does nothing. The guard is cheap to add. Note also that the supermosh check is
imprecise — `src/Rendering.tsx:85-91` tests the *source's* chunk count, not
`to - from`, so a one-frame segment of a long clip slips through. Copy the idea,
not the implementation.

The "settings differ" guard has no m4shlab analogue and is not needed: m4shlab
rebuilds the normalization when the target changes, and the target is part of
`normalizationCacheKey()` (`looks.js:63-81`).

Matter for m4shlab: **yes** — because the all-Cut case is a silent no-op today.

## 7. Anything else

- **Image input.** supermosh accepts `video/*,image/*` (`src/FilesEditor.tsx:53`)
  and treats an image as a one-chunk source. m4shlab is video-only.
- **Rotation.** `src/Rendering.tsx:61-67` flips width and height. m4shlab has no
  rotate/flip control.
- **No limits.** supermosh has no clip-count or file-size limit; m4shlab caps at
  12 clips (`app.js:39`) and 100 MB per input (`converter.js:5`,
  `webcodecs.js:14`). Those caps exist for iOS memory and should stay.
- **m4shlab-only capabilities** worth remembering in both directions: audio
  (supermosh records the canvas, so its output is silent), trim, speed, looks,
  seeded Randomize, settings files, the JSON report, and offline PWA use. A
  comparison that only looks at glitch strength ignores that m4shlab is a
  different product.
- **Frame pacing.** supermosh drives the decoder off a wall-clock interval
  (`src/lib.ts:127-142`); m4shlab's merge keeps an exact sample table. Not a
  gap in supermosh's favour.

Matter for m4shlab: **no** for pacing and limits, **unknown** for image input
and rotation — because neither is a strength lever, and neither has been
requested.

## Ranked candidates

| Candidate | Expected effect on mosh strength | Cost (files, tests, risk) | iOS risk | Recommended order |
| --- | --- | --- | --- | --- |
| C1 — raise the normalization quality target (bitrate multiplier or CRF-style quality, e.g. 2× current bitrate) | none on chain length; more detail survives inside the corrupted window (measured 2.9 → 5.6 Mbit/s, PSNR 43.6 → 52.5 dB on the synthetic clip) | `webcodecs.js` (`bitrateFor`), `hybrid-encoder.js`, encoder config tests; bigger exports, longer encodes | medium: more memory/CPU per clip, slower Safari renders | 1 |
| C2 — expose decoder `hardwareAcceleration` plus the chosen decoder in the JSON report | none directly; makes results reproducible across devices | `webcodecs.js` (decoder config + report field), settings file + UI select, browser test; small | high: Safari may reject `prefer-software` or be very slow | 2 |
| C3 — guard "this export contains no glitch" (all boundaries Cut) | none; prevents a silent no-op export | `app.js` + one browser test; very small | none | 3 |
| C4 — record decoder/encoder identity and cadence in the report | none; makes A/B comparisons and bug reports possible | `webcodecs.js`, `app.js` report, test; small | none | 4 |
| C5 — allow a higher normalization target (1080p option) | none on chain length; more detail for large sources | `conversion-settings.js`, muxer target selection, UI, several tests; large | high: conversion memory on iPhone | 5 |
| C6 — segment/`repeat` timeline model | none on chain length; new editing capability | new timeline data model, merge entry points, persistence, many tests; very large | medium | 6 |
| C7 — image input (single-frame source) | none; still frames cannot be moshed, only repeated | import + conversion path, UI, tests; medium | low | 7 |
| C8 — rotate/flip action | none | CSS/canvas at export time, one test; small | none | 8 |

## Do not do this

- **Do not bake the glitch into pixels.** It would delete the product's premise
  (real H.264 editing with byte-identical retained NALs) and add a second
  generation of loss.
- **Do not drop audio.** supermosh has no audio track because it records a canvas
  stream; m4shlab's AAC path is a feature, not overhead.
- **Do not require a reprocess when the output size changes.** m4shlab's
  normalization target is part of the cache key; copying supermosh's
  reprocess-everything model would be a regression.
- **Do not drive frame output from a wall-clock interval.** `setInterval` at
  30 fps drops frames whenever a decode is slow; m4shlab's sample table is exact.
- **Do not copy the "one chunk" guard literally.** It inspects the source's chunk
  count instead of the segment length; add the equivalent guard on m4shlab's own
  terms (no mosh boundary in the sequence).
- **Do not lift the 12-clip and 100 MB limits** to match supermosh's unbounded
  input; those limits are the iOS memory guardrail.

## Measurement proposal for the top two

**C1 — quality target.** One 10-second real clip, one Melt boundary with a
60-frame window, everything else default.

1. Export twice on the same machine and browser: (a) current `bitrateFor`, (b)
   the same code with the bitrate doubled (2× `width * height * 3`).
2. Compare: exported size and bitrate (`ffprobe`), decoded frame count (must stay
   identical), PSNR/SSIM of the mosh window against the source frames, and the
   wall-clock export time.
3. Human A/B: same window, same frame numbers, blind. Record which one keeps
   detail; a visual verdict is required before changing the default.

**C2 — decoder acceleration.** Same clip and window, in Chrome first.

1. Merge twice from the same normalized bytes, once with
   `hardwareAcceleration: 'prefer-software'` and once with the current config.
2. Compare output SHA-256, per-frame pixel hashes of the merged window, and the
   report's decoder identity. Equal bytes mean the option changed nothing on
   this machine; different bytes mean the decoder choice is observable.
3. Repeat in Safari on iOS and record whether `prefer-software` is accepted, how
   long the render takes, and whether memory pressure appears. If iOS rejects
   the value, C2 must be a desktop-only setting with a visible note.
