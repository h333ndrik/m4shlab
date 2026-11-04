# m4shlab state

Updated: 2026-11-04

## Release v1.1

**State: release candidate complete — `m4shlab-v1.1`.** The v1.0 tag remains immutable at `2aa8ee5536474581c05f4fe5ca30635597a0c526`. v1.1 adds the post-release parity work: per-clip looks, sound/export control, and live preview metadata. The final automated baseline is **80 Node / 33 WebCodecs / 6 PWA** checks passing.

m4shlab is a fully client-side, installable H.264 bitstream editor with a 12-clip timeline, seven transition methods, frame-quantized duration/ending controls, per-clip speed and looks, merged AAC audio, universal local import, seeded Randomize, and an offline app shell. No feature work remains; physical-device acceptance testing is pending.

## Release summary

| Commit | Feature | Tests recorded at commit |
| --- | --- | --- |
| `b9fa9b6` | Phase A single-clip Classic Mosh | 8 Node |
| `3a7540d` | Phase B compatible A→B merge | 17 Node |
| `bf64130` | Universal import and lazy ffmpeg.wasm conversion | 23 Node |
| `841a1eb` | Phase C WebCodecs normalization | 25 Node |
| `77c1798` | Multi-GOP Phase B repair | 27 Node |
| `4de1e45` | Auto-normalization, 720 px cap, parallel conversion | 27 Node |
| `aa150f8` | Safari POC type 0 merge fix | 30 Node |
| `f085228` | h4moshlab layout; compatibility panel removed | 30 Node |
| `69aab54` | Multi-clip timeline and chained Classic Mosh | 35 Node |
| `666cd8c` | Installable offline PWA shell | 35 Node |
| `c8843c3` | Final h4moshlab editor layout | 35 Node |
| `39495cf` | Classic Mosh duration and ending | 43 Node |
| `3f247ba` | Multi-slice Phase A boundary fix | 45 Node |
| `3a41cd5` | NAL-level Melt and Loop | 50 Node |
| `8f23e91` | Timeline-aligned AAC audio | 57 Node |
| `8964248` | Loop Release 3×/2× scheduling | 61 Node |
| `18b7d78` | Reset Pulse transition | 65 Node |
| `2729803` | Duration/ending for Melt and Loop | 70 Node |
| `edd658e` | Gentler cadence for Melt | 72 Node |
| `f8c7286` | Per-clip speed with pitch-preserving audio | 74 Node |
| `4b563d0` | m4 wordmark and PWA icon system | 74 Node |
| `76531be` | Reproducible seeded Randomize | 75 Node |
| `1664a4a` | Native WebCodecs HEVC import | 76 Node |
| `52b00e3` | Gentler cadence for Loop Release | 77 Node |
| `ccc6c30` | Per-clip Original/B&W/B&W-negative/color-negative looks | 79 Node / 27 WebCodecs / 6 PWA |
| `98a2ac9` | Sound/export toggle and live preview time/labels | 79 Node / 30 WebCodecs / 6 PWA |
| `fcf24e9` | h4moshlab side-by-side comparison evidence | 79 Node / 30 WebCodecs / 6 PWA |

Browser and PWA counts are emitted PASS records. The deployment-only `201d418`/`fb80db1` CNAME create/delete pair is excluded. v1.1 release documentation and the `v14` cache bump are recorded in the final release commit.

## Transition methods

| # | Method | Parameters | Direct automated coverage |
| ---: | --- | --- | --- |
| 1 | Cut | — | Byte-identical Phase A/B/Cut controls, mixed chains, chained Loop→Cut |
| 2 | Classic Mosh | Duration, Restore/Continue | Single-clip, pair and three-clip removal, GOP alignment, clamping, restore positions, full decode |
| 3 | Melt · Original | Duration, ending, repeat 2–12 | Repeat schedules, byte identity, explicit window, restore/continue, audio invariants, full decode |
| 4 | Melt · Gentler | Duration, ending, repeat 2–12 | Bounded donor movement, final-quarter schedule, restore, full decode |
| 5 | Loop Release · Original | Duration, ending, group 2–48 | 3×/2×/tail schedule, duration scaling, restore, chained decode, audio alignment |
| 6 | Loop Release · Gentler | Duration, ending, group 2–48 | Bridge schedule, preserved wraps, tail join, byte-identical regression, audio invariants |
| 7 | Reset Pulse | Duration, ending, interval 4–48, repeat 2–12 | Interval schedule, IDR anchors, POC type 0, endpoints, clamping, chained decode |

## Release baseline

- Phase A: sample-based Classic single-clip IDR removal with multi-slice handling.
- Phase B: compatible H.264 A→B merge, retained later IDRs, first-GOP `frame_num`/POC-LSB alignment, and a byte-safe RBSP/EBSP patcher.
- Universal import: hardened MP4/MOV parsing, conventional HEVC `hvcC` demuxing, lazy ffmpeg.wasm conversion, and WebCodecs/ffmpeg.wasm path reporting.
- Phase C: automatic WebCodecs normalization to one shared target capped at 720 px, with ffmpeg.wasm fallback and parallel conversion.
- Multi-clip timeline: up to 12 clips, seven transition methods, drag-and-drop/arrow reorder and remove with undo/redo, chained preview and export.
- Effect controls: all six mosh variants have frame-quantized duration and Restore/Continue endings; Melt and Loop Release expose Original/Gentler cadence.
- Audio: the first audio track of each original source is aligned to the merged video timeline at 48 kHz stereo and exported as AAC-LC. Audio is not moshed; Sound off skips the audio mux entirely.
- Speed: entry-specific 0.1×–4.0× frame mapping with pitch-preserving `atempo` audio.
- Looks: Original, Black & white, B&W negative, and Color negative applied in the same WebCodecs encode pass as speed and scaling.
- Randomize: reproducible 16-hex seeds, validated same-stream resampling, seed clearing on manual edits, and `random_seed` reports.
- PWA: standalone install, light splash/theme, maskable m4 icons, service worker `v16`, 27 precached shell assets, runtime-cached ffmpeg.wasm, and offline app-shell startup.
- Preview: persistent sound state, live current/total time, and filename or assembled-sequence labels. The zero-clip state shows `0.00 / 0.00 s`; the export action has an explicit neutral disabled treatment; the timeline heading is title-case `Sequence` in markup and uppercase through the shared section-label style.
- Branding and UI: m4 wordmark in the h4moshlab typographic system; h4moshlab-style light layout, dark preview well, horizontal timeline, and no visible compatibility panel.

## Multi-clip implementation

- `merge.js` keeps the existing pair APIs and adds `appendCutH264` plus `mergeSequenceH264`. The sequence processor runs left to right, so each incoming mosh boundary is aligned against the already merged running stream rather than the original clip 1.
- Every Cut boundary appends all incoming samples. Every Classic Mosh boundary skips only the incoming first IDR sample and retained SPS/PPS/SEI units in that sample; later IDRs remain reference anchors.
- First-GOP slices receive RBSP-safe `frame_num` and type-0 POC-LSB patches. Each boundary rebuilds `stsz`, `stsc`, `stco`/`co64`, `stts`, `ctts`, track durations, and movie duration.
- The sequence report records clip count, methods, source/merged samples, expected decoded frames, boundary alignment details, normalization paths, per-source audio preparation, merged-audio segments, encode/mux engines, encoder delay, and exact presentation timing.
- Each clip card has a 0.1×–4.0× slider in 0.1× steps and Reset. Speed is clip metadata, so duplicate imports can differ, and undo/redo restores both speed and prepared media. Source reports contain `speed`, `input_frames`, `output_frames`, and `speedReport`; boundary reports repeat the incoming speed/frame counts.
- `app.js` imports multiple files or dropped files, caps the timeline at 12, and normalizes every clip to one shared target when any boundary differs or any speed changes. Native H.264 uses WebCodecs first; tier-2 or WebCodecs-failing inputs use ffmpeg.wasm with the hybrid WebCodecs encoder when available. Speed always uses the WebCodecs path because frame selection/repetition must share the decode/encode pass.
- Clip cards have active reorder/remove controls. Fine-pointer cards use HTML5 drag-and-drop with left/right-half insertion, while touch devices keep non-draggable cards and the arrow controls. Undo/redo snapshots cover import, drag/arrow reorder, removal, and transition changes without revoking media needed by an older snapshot.
- Each dashed connector opens a dialog with Cut, Classic Mosh, Melt, Loop Release and Reset Pulse. Every non-Cut method exposes duration/ending controls; Melt adds repeat 2–12 plus Original/Gentler movement, Loop Release a 2–48-frame group, and Reset Pulse a 4–48-frame interval plus repeat 2–12. Transition settings follow the incoming clip when cards are reordered.
- The preview shows clip 1 untouched or the full merged chain. Export downloads the complete sequence as `m4shlab-merge.mp4`; source audio is muxed automatically when any source track exists.
- Melt schedules non-IDR donors through an explicit output-frame window, then continues from the next unused donor or restores B's original first IDR. Gentler starts from the same hold plan, bounds each pre-release donor advance to two frames, and makes the final quarter consecutive. Loop Release scales its 3×/2× blocks into the window and joins the chronological tail at the next donor. Reset Pulse starts every interval with B's original first IDR sample, then repeats consecutive P donors until the interval is full. All three reject reordered inputs and renumber emitted slice headers through the RBSP/EBSP-safe patcher. API calls without a duration retain the legacy full schedules; the UI always supplies an explicit window.
- `classic-mosh.js` owns nominal fps detection, frame quantization, duration clamping, `ValueError`, and picture-sample counting. `mosh.js` and `merge.js` use the same settings so Phase A and boundary merges agree.
- `parser/hevc.js` validates `hvcC`, derives the WebCodecs HEVC codec string, and demuxes HEVC NAL length prefixes independently of the H.264 NAL parser. `parseMp4(bytes, {allowHevc: true})` exposes the codec family and samples while the default parser keeps its original action-guiding HEVC error.
- `webcodecs.js` selects an exact `hvc1`/`hev1` decoder configuration from `hvcC`, feeds IRAP-tagged HEVC samples to `VideoDecoder`, and then reuses the unchanged H.264 encoder and MP4 writer. Import reports the original HEVC decode engine even if a later sequence-normalization pass re-encodes the H.264 intermediate.
- `merge.js` builds the Loop Release donor plan as a base schedule plus explicit bridge records. Gentler replaces the leading donor slots at forward block changes until the next donor is within two frames, leaving internal repeated-block wraps intact and the output length unchanged. The UI stores Gentler separately as `loopSmooth`.
- `randomize.js` owns 16-hex seed validation, the mulberry32-style stream, technical constraint validation, and bounded same-stream resampling for Randomize. The dialog stores the seed on the incoming clip, clears it on manual control edits, and includes it in the boundary report.
- `speed.js` owns 0.1× step validation, time-aware output frame counts, Bresenham-style donor mapping, and the multiplicative `atempo` stage chain. Normalization encodes the mapped 30 fps frames; ffmpeg.wasm applies the same chain to PCM and trims/pads to `output_frames × 1600` samples.
- `looks.js` owns look validation, exact RGBA transforms, and the source/target/speed/look normalization cache key. `webcodecs.js` applies the selected transform after canvas readback and before I420 frame construction.
- Restore removes IDRs only inside the selected window, inserts the original first-IDR sample before frame N+1, and preserves remaining samples plus later IDR anchors. Continue ignores the shorter window and remains byte-identical to the old full-length output. Default full duration plus restore preserves legacy exports.

## PWA implementation

- `manifest.json` declares standalone display, light `#f5f5f3` theme/background, `./` start/scope, SVG icon, 192px any icon, and 512px maskable PNG icon.
- `favicon.svg` and `icon.svg` use Arial/Helvetica Bold 700 `m4` lettering on `#f5f5f3`; the favicon adapts the sibling h4 tile proportions, while the 512px PWA master keeps the wordmark within the maskable safe area. `favicon-32.png`, `icon-180.png`, `icon-192.png`, and `icon-512.png` are committed raster fallbacks.
- `index.html` links the manifest, SVG and 32px PNG tab icons, sized 180px Apple touch icon, theme color, and Apple standalone metadata.
- `sw.js` derives both `m4shlab-v16` and `m4shlab-runtime-v16` from one `VERSION` constant. Install precaches 27 app-shell files, including both favicon assets, `parser/hevc.js`, `classic-mosh.js`, `speed.js`, `looks.js`, `randomize.js`, and `audio.js`, skips `converter-worker.js` and ffmpeg.wasm, calls `skipWaiting()`, and activate deletes old versioned caches before `clients.claim()`.
- Static shell requests are cache-first. Navigation requests fall back to the cached `index.html`. Runtime cache-first applies only to `converter-worker.js` and the pinned jsDelivr ffmpeg core JS/WASM URLs.
- `app.js` changes only by registering `./sw.js` after `load`; registration failures such as `file://` are swallowed so normal browser operation is unchanged.
- Bump `VERSION` in `sw.js` whenever a shell or conversion-worker asset changes. Runtime cache separation keeps the 31 MB ffmpeg core out of shell precache; a version bump intentionally invalidates stale worker code too.

## Verification

Current v1.1 baseline on 2026-11-04 with Node 26.13.0, FFmpeg 9.0.2, and Chrome 156:

- `npm test`: **80/80 PASS**.
- `npm run test:webcodecs`: **33/33 PASS**.
- `npm run test:pwa`: **6/6 PASS**.
- `node --check` for all JavaScript and `git diff --check`: PASS.
- Released v1.0 service worker: `v11`, SHA-256 `a177914d77bc094949cc24fef38d8086306121434b67e6bf7fe674cbe473a50e`. Current v1.1 shell is `v16`.
- PWA precache: 27 shell assets including `looks.js`; manifest/installability and offline reload pass.
- Melt repeat=4: 315/315 decoded samples, with all non-header RBSP bits byte-identical. Melt duration=12/repeat=2: exact 12-frame window, Continue tail at donor 7, 105/105 decoded; Restore inserts the byte-identical incoming IDR at merged sample 37 and decodes 106/106. Gentler Melt uses source donors [1,1,2,2,3,3,4,6,8,10,11,12], caps each pre-release step at two, and decodes 99/99; Gentler Restore adds the anchor. Loop Release group=4: 99/99 decoded samples with blocks at donors 1/13 and release tail at 21; duration=12 scales to donors [1,2] 3× plus a chronological window and rejoins at donor 13. Reset Pulse interval=6/repeat=2: 99/99 with reset IDRs at merged samples 25/31, donor tables [1,1,2,2,3], and tail donor 13; Restore decodes 100/100; the default window matches an explicit full window byte-for-byte, and sub-frame durations raise `ValueError`. POC type 0 Melt: 171/171. POC type 0 Reset Pulse: 99/99 with segment frame_num/POC starts at 1. Chained Melt→Loop Release: 195/195; Loop Release→Cut: 124/124; Reset Pulse→Cut: 124/124; Reset Pulse→Classic Mosh: 123/123.
- Native B-frame Melt/Loop Release/Reset Pulse rejects loudly; browser tests confirm native B-frame sources auto-normalize with WebCodecs before the effect runs.
- Gentler Loop duration=12/group=4 uses donor positions [0,1,0,1,0,1,3,5,7,9,10,11], keeps block wraps at outputs 2/4, reports a three-frame tail bridge from donor 1 to 7, decodes 99/99, and preserves a 99×1920-sample audio timeline. Original Loop cadence remained byte-identical at SHA-256 `a2654bb53026dcf11cb040c05aecdffd2299a387fb4f0693c3a8da9635541fe3`.
- HEVC demux: 25 samples, 320×240, `hvc1.1.6.L60.90`, four-byte NAL lengths, 25 HEVC units, and an IRAP first sample; the default parser still returns the exact H.264 conversion guidance.
- Software-rendered headless Chrome selected ffmpeg.wasm HEVC decode plus WebCodecs H.264 encode and named the fallback in the conversion panel, clip detail, and normalization engine report. A separate GPU-enabled Chrome run accepted `hvc1.1.6.L60.90`, decoded HEVC with WebCodecs, and merged 49/49 samples. Forced unavailable WebCodecs also produced a playable HEVC-derived H.264 clip.
- Randomize reproduces identical settings for the same seed and validates all 200 combinations across 50 seeds × four mosh methods. Browser UI generates a 16-hex seed, clears it after a manual edit, and reports the applied value as `random_seed`.
- Speed frame plans produce 30/120/60/35 frames for 60 source frames at 2×/0.5×/1×/1.7×. Speed 1.0× keeps the original 60/60 frame path; out-of-range values and non-0.1 steps fail loudly.
- Chained atempo at 2×, 0.5×, and 1.7× preserves a 440 Hz tone (spectral estimate) and emits exactly 48,000/192,000/56,000 samples. Every stage is within 0.5–2.0×.
- Classic audio assembly drops exactly the first incoming frame and preserves the remaining second-frame PCM; a silent clip contributes exact stereo silence; explicit-window Melt starts one frame in and pads extra picture frames with silence, while the legacy duration-less API keeps its original full audio segment.
- Audio/video sample mismatches raise `RuntimeError`; WAV and ADTS headers have exact sizes; the retiming test preserves a 1,024-sample encoder delay while presenting exactly 48,000 samples and refuses requests beyond the encoded packet coverage.
- Audio fixture source hashes remain unchanged.
- Multi-slice Phase A: the second IDR sample is the boundary; both initial access-unit IDR slices remain byte-identical, all four later IDR slices are removed, and 73/73 retained frames decode.
- Phase A: 111,706 B → 100,238 B, 73 decoded frames.
- Phase B: 37,029 B + 36,812 B → 67,893 B, 49 decoded frames.
- Multi-GOP B: 25 A + 75 B samples → 99 samples and 99 decoded frames; two later B IDRs remain, 24 slice headers are aligned, and three keyframes decode.
- Three-clip Classic Mosh: 25 + 75 + 32 = 132 source samples → 130 merged samples and 130/130 decoded frames. B/C IDRs remain at merged samples 49, 74, and 123. 48 first-GOP slices are intentionally patched; 83 other retained NALs are byte-identical.
- Three-clip Cut + Classic Mosh: 132 source samples → 131 merged samples and 131/131 decoded frames. All A/B NALs remain byte-identical and the later C IDR remains.
- Loud failure: a genuinely reordered POC type 0 multi-GOP sequence is rejected before any output file is produced.
- Normalization target coverage: 1440×1920 + 768×1024 + 320×240 selects one shared 540×720 target.
- Classic Mosh restore: Phase A 10-frame window exact NAL sequence, byte-identical IDR reinsertion, 75/75 decoded source frames; Phase B 50/50 decoded frames; continue byte-identical to full-length output.
- Duration 1 accepted; overlong windows clamp and report; durations below one frame raise `ValueError`; chained boundaries retain independent settings.
- PWA browser test: manifest valid with resolving icons and exact favicon links; service worker v16 active and controlling; 27 shell assets cached; old cache removed; runtime cache contains three ffmpeg entries; offline reload works; offline HEVC conversion and merge produce a 120,718-byte, 59-frame H.264 export.
- PWA export SHA-256: `47a7fcc6972956e34b9147fead68159350bf16d5f339098436dc5cd8dd25c7b9`.

`npm run test:webcodecs` produced:

- normalized source clips: 53,018 B / 52,775 B with one leading IDR sample each;
- the 75-frame fixture produced keyframes at samples 1, 31, and 61; its merge retained two later IDRs and decoded 149/149 frames;
- Safari-shaped POC type 0 multi-GOP pair merged with POC-LSB alignment and cleared stale errors;
- POC type 0 with true B-frame reordering was rejected with an explicit picture-reordering message;
- mobile layout stacked under 600px and kept 44px touch targets;
- the Classic Mosh dialog exposed a frame-quantized duration, seconds/frame feedback, Restore/Continue options, and hid those controls for Cut;
- blocking merge errors stayed short with no compatibility panel;
- a native large pair and a three-file mixed-resolution sequence normalized to 540×720 and showed the normalizing state;
- the three-clip browser flow exposed two Cut/Classic Mosh connectors, changed the first boundary to Cut, verified drag/self-drop/arrow reorder plus remove/undo, previewed 540×720, and exported 74 decoded frames;
- the preserved two-clip path still merged 49 samples, previewed 320×240, and exported a decodable video;
- the preserved export SHA-256 is `b4bb6c4827b2f7a8fe6d93777ff63f4491dd0b8eb497148dd3b2d07da1666bef`;
- browser Gentler Loop bridged the tail jump with ≤2 donor advances and produced a 99-sample decodable sequence;
- browser Melt/Gentler Melt/Loop Release/Reset Pulse controls emitted 105-, 99-, 99-, and 99-sample duration-window sequences with fresh slice numbering and decodable previews; native B-frame sources normalized before the effect ran;
- browser speed controls merged a 2× and a 0.5× copy of the 60-frame fixture into 150/150 decoded frames with 240,000 exact audio samples and a decodable AAC soundtrack;
- fractional 1.7× produced 35 preview-decodable frames and a 35-frame audio timeline; Reset returned the clip to 1.0× with 60/60 frames;
- a single 1440×1920 clip at 2× normalized to 540×720 and 15 output frames in one WebCodecs pass;
- the audio merge exported AAC-LC at 48 kHz stereo with 94,080 expected sample frames, a 1.960 s runtime match, WebCodecs encode, ffmpeg.wasm mux, and strict audio decode;
- with `AudioEncoder` unavailable, the same 94,080-sample timeline encoded through ffmpeg.wasm and reported its 1,024-sample encoder delay;
- ffmpeg.wasm decode plus WebCodecs encode completed both pair progress bars, and forced fallback named ffmpeg.wasm.

`npm run test:pwa` produced:

- manifest/installability: PASS, including `beforeinstallprompt observed=true`;
- service worker active and controlling, 27 shell assets precached off a fresh profile;
- activation removed the previous cache and re-registered the v16 shell;
- runtime cache: `converter-worker.js`, `ffmpeg-core.js`, `ffmpeg-core.wasm`;
- fully offline HEVC conversion, merge, preview, and export: 59/59 decoded frames.

## Real-clip measurements

- `IMG_1993.MOV` + `IMG_3339.MOV`: HEVC sources normalized to H.264 at 540×720 through ffmpeg.wasm decode plus WebCodecs encode.
- Follow-up Phase A on the converted `IMG_1993` clip selects sample 19, preserves both initial IDR slices byte-identically, removes 10 later IDR slices (80,862 bytes), and decodes 32 frames instead of the earlier zero.
- Pair conversion took 5.7 s and 5.8 s, versus 5.3 s / 9.1 s for capped full-WASM and 19.8 s / 33.6 s for earlier full-resolution WASM runs.
- 112 + 177 source samples merged to 288 samples; strict decode returned 288/288 frames.
- Later B IDRs were retained, the first B GOP received 32 slice patches across 16 samples, and strict decode exited 0.
- Export SHA-256: `cc72b2c54e63045159bc5ada461469217e527aa7cf152ba7a7347bd8ec89ff5d`.

## Limits / next work

- WebCodecs does not guarantee hardware acceleration or support for every profile/resolution.
- WebCodecs normalization supports native H.264 through the H.264 sample path and conventional HEVC through the dedicated `hvcC` path. Other containers/codecs use ffmpeg.wasm; fragmented MP4 still requires conversion.
- The 720-pixel cap is lossy for larger sources and may place the first recovery IDR earlier than requested because some encoders insert extra keyframes.
- Sequence conversion starts at most two WASM workers; additional clips wait, and peak memory can still exhaust iPhone Safari on large inputs.
- Multi-GOP alignment supports type 2 and non-reordered type 0/1 streams. Type 0/1 requires no B-slices and no non-zero composition offsets; reordered B fails explicitly.
- The 100 MB limit is a soft limit; available device memory can still be exceeded.
- Classic Mosh duration is bounded by frames after the incoming first GOP boundary. Restore is a hard reference reset, not a blend; the visible recovery jump is intentional. Continue ignores the shortened duration and keeps the full chain.
- Melt, Loop Release and Reset Pulse are decode-order effects, not pixel blending. Device decoders may render repeated reference chains differently; these methods require B-frame-free, non-reordered inputs. Melt/Loop duration is the effect window, not the following chronological tail, so total contribution can differ from the selected window. Gentler Melt only bounds donor movement; it does not interpolate and does not guarantee perceptual smoothness.
- Timeline maximum is 12 clips. Merged audio follows the clip timeline but is not audio moshing: Classic Mosh, Loop Release, Reset Pulse, and explicit-window Melt drop one incoming frame; extra picture frames receive silence. Only the first source audio track is used, normalized to 48 kHz stereo and exported as AAC-LC. Crossfades, multi-track mixing, servers, uploads, and general-codec WebCodecs demuxing remain out of scope.
- Speed above 1× drops source frames and below 1× repeats them, so extreme values lose temporal detail; fractional mapping is deterministic, not interpolation. Speed video requires WebCodecs, and non-silent speed audio requires the lazily loaded ffmpeg.wasm core. Audio pitch is preserved by `atempo`; audio is not moshed.
- Looks require WebCodecs decode/canvas/encode and are applied after normalization downscaling; they are pixel effects, not bitstream filters, and the selected look is embedded in the exported video.
- PWA first load requires network. The OS may evict Cache Storage, `file://` cannot register the worker, and a very large wasm conversion may still exceed iOS memory. iOS Home Screen/standalone behavior still needs a physical-device check.
- The reported iPhone `IMG_4767.mov` / `final_0.mov` pair was not present locally; automated coverage uses a generated Safari-shaped POC type 0 fixture, so a physical-device retest is still required.
