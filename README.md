# m4shlab

H.264 bitstream moshing in the browser — fully client-side, no server, no upload.

Phase A MVP: one H.264 clip, IDR removal produces visible moshing in the preview, export decodes.

Phase B MVP: two compatible H.264 clips, Classic A→B merge in the browser, export decodes as video.

Multi-clip timeline: import up to 12 clips, arrange them on one horizontal timeline, choose Cut, Classic Mosh, Melt or Loop Release at every boundary, and export the complete chained sequence. The two-clip flow remains the N=2 case.

Classic Mosh duration + ending: each boundary has a frame-quantized duration and an ending mode. **Restore clear image** re-inserts the original boundary IDR after the effect window; **Continue motion** preserves the previous full-length IDR-free chain.

Melt and Loop Release: Melt repeats every non-IDR sample after the incoming first GOP boundary, with a repeat factor from 2 to 12. Loop Release takes a 2–48-frame group, repeats it 3×, repeats a second timeline-aligned group 2× when space permits, then rejoins the donor timeline for the chronological tail. Both methods retain later IDRs and patch fresh `frame_num` and type-0 POC-LSB values per emitted sample.

Phase D PWA shell: m4shlab is installable and its app shell works offline after the first successful load. ffmpeg.wasm is cached on first use, not precached.

Universal import: conventional H.264 MP4/MOV parses natively; other formats are converted locally with lazily loaded ffmpeg.wasm.

Phase C normalization: incompatible native H.264 sequence members are decoded and re-encoded locally with WebCodecs when the browser supports H.264 encode/decode. ffmpeg.wasm remains the fallback.

Merged audio: each source clip's first audio track is decoded locally to 48 kHz stereo PCM, aligned exactly to its normalized video timeline, concatenated in sequence order, encoded as AAC-LC, and muxed into the merged MP4. If no source has audio, the export remains video-only.

Automatic sequence normalization starts as soon as native compatibility fails. If any boundary differs, every clip is converted to one shared target capped at 720 pixels on the long side, using WebCodecs or ffmpeg.wasm, then compatibility is checked again on the converted bytes. Conversions can run in parallel, and HEVC-style ffmpeg.wasm decodes use WebCodecs for H.264 encoding when available.

## Run it

```sh
npm start
```

Open `http://127.0.0.1:4173`, choose up to 12 clips with **Import clips**, or drop them onto the timeline. Use the card arrows to reorder, the remove buttons to edit the sequence, and undo/redo for timeline changes. Click each dashed connector to choose **Cut**, **Classic Mosh**, **Melt** or **Loop Release**. Classic Mosh exposes duration and ending controls; Melt exposes a repeat factor and Loop Release a group length. Switch between the first-clip cut and the full merged sequence; validation and normalization happen in the background, and only a blocking error is surfaced. Play from the start for the clearest result. Export downloads `m4shlab-merge.mp4` with the full sequence and source audio when available.

The Phase A single-clip transfer remains available through `mosh.js` and its unchanged test chain.

The app has no package dependencies and no build step. `npm start` only serves the local static files; video never leaves the browser. WebCodecs normalization stays in browser memory. When the fallback is needed, the pinned ffmpeg.wasm core is fetched from jsDelivr on demand; only the local wasm worker receives the file bytes.

## Install (PWA)

Service workers require HTTPS or `localhost`; GitHub Pages provides HTTPS automatically.

- **iOS / iPadOS Safari:** tap **Share** → **Add to Home Screen**.
- **Android Chrome:** use the install banner when offered, or open the browser menu → **Install app** / **Add to Home screen**.
- **Desktop Chrome/Edge:** use the install icon in the address bar, or the browser menu → **Install m4shlab**.

The first load must reach the network so the manifest and versioned app shell can be cached. After that the UI starts offline. Import, Classic Mosh, preview, and export are local operations and continue to work without a network. New-format conversion needs the ffmpeg.wasm core; the first conversion downloads it, then `converter-worker.js`, `ffmpeg-core.js`, and `ffmpeg-core.wasm` stay in the runtime cache. The OS may evict that cache under storage pressure, in which case conversion needs network again.

The current cache version is `v5` (`m4shlab-v5` plus `m4shlab-runtime-v5`). Bump `VERSION` in `sw.js` whenever app-shell or conversion-worker files change. Activation deletes older versioned caches, including the old runtime cache, so the worker cannot run stale code.

## Supported formats

| Tier | Inputs | Behavior |
| --- | --- | --- |
| 1 — native parse | Conventional non-fragmented MP4/MOV with an H.264 `avc1`/`avc3` video track, including top-level size-zero `mdat`, 64-bit box sizes, and QuickTime `wide` placeholders | Parsed directly; compatible sequence members merge without re-encoding. The first audio track is decoded from the original source, aligned to the normalized video timeline, and muxed into the merged export |
| 2a — WebCodecs normalization | Native H.264 sequences whose SPS/timing details differ, when `VideoDecoder` and `VideoEncoder` can handle the required H.264 profile and size | Every clip is decoded and re-encoded locally to one shared H.264 target, then processed by the unchanged compatibility check and chained merge |
| 2b — ffmpeg.wasm fallback | HEVC (`hvc1`/`hev1`), VP9 WebM (verified), fragmented MP4, other supported containers/codecs, and browsers or H.264 configurations without a usable WebCodecs path | Decoded locally by ffmpeg.wasm. The H.264 encode runs in WebCodecs when available, otherwise fully in the pinned WASM worker |
| Not supported | DRM/encrypted media, unavailable ffmpeg.wasm assets, conversion input over 100 MB, or conversions that exceed browser wasm memory | Actionable error; no broken merge is emitted |

Normalization produces conventional faststart MP4 with H.264 baseline or main profile, `yuv420p` limited range, 30 fps, a requested keyframe every 30 frames, no B-frames, and no audio. That video-only normalization output feeds the unchanged merge pipeline; the original soundtrack is extracted separately and muxed after the final video is built. Encoders may insert additional recovery IDRs. The common target is capped at **720 pixels on the long side**. Same-aspect inputs are purely scaled; different aspects are scaled proportionally and letterboxed into the shared box. The mosh effect is resolution-independent, and this cap is much faster than full-resolution software encoding, mirroring h4moshlab's deliberate 640×480 normalization.

Native Tier-1 clips may contain B-frames; their `ctts` composition offsets are preserved during merge. Converted clips deliberately have no B-frames.

## Interface

The page follows the h4moshlab visual language: a light radial-gradient background, centered 1000px layout, compact bordered controls, a large dark preview well, and a horizontal clip timeline. Clip cards show a thumbnail, filename, duration, format status, active reorder arrows, and a remove button; undo/redo restores timeline edits. Each dashed connector names its boundary method and opens a dialog with **Cut**, **Classic Mosh**, **Melt** and **Loop Release**. Classic Mosh adds duration and ending controls; Melt adds a 2–12 repeat slider and Loop Release a 2–48-frame group slider. The first card is the preview cut; the export is the full chained result. Compatibility criteria, badges, and SPS/PPS hashes are not rendered. Under 600px the header and preview actions stack and touch controls meet the 44px target.

## What it does

### Universal import and sequence preparation

1. Tier 1 walks conventional MP4/MOV boxes and H.264 sample tables. Fragmented MP4 and unsupported codecs produce explicit errors.
2. A native sequence with any incompatible or differing boundary enters a visible **normalizing clips…** state instead of showing a final incompatibility verdict. All clips are normalized to the shared capped target and checked again.
3. Native H.264 normalization reuses parsed samples and `avcC`, decodes with `VideoDecoder`, scales/letterboxes through a canvas, converts to limited-range I420, and encodes every sequence member with `VideoEncoder` using identical settings.
4. HEVC, WebM, fragmented MP4, and unsupported H.264 configurations use ffmpeg.wasm for decode. If WebCodecs H.264 encoding is available, ffmpeg.wasm emits a capped Y4M stream and WebCodecs performs the encode; otherwise the complete encode stays in the WASM worker.
5. The UI and JSON report name decode path, encode path, target, parallel execution, fallback reason, and duration for every clip. Compatibility is checked again on the converted bytes before preview and chained merge, without rendering a criteria table.

### Phase C: WebCodecs normalization

1. Feature-detect `VideoDecoder`, `VideoEncoder`, and `VideoFrame`; select an H.264 encoder configuration supported by the current browser.
2. Decode the source in sample order, draw each frame into one common even-sized canvas capped at 720 pixels on the long side, and preserve or letterbox aspect ratio as needed.
3. Convert the canvas to explicit BT.709 limited-range I420 and encode H.264 with a keyframe every 30 frames, starting at frame 0. The output is video-only.
4. Mux encoded chunks into `ftyp`/`moov`/`mdat` faststart MP4 with `stts`, `stss`, `stsc`, `stsz`, and `stco`/`co64`.
5. Align B's first-GOP non-key H.264 `frame_num` values so they continue after A. Without this, a decoder can discard early B frames after the removed IDR because separately encoded clips both start at frame number zero. Later B GOPs keep their local numbering and recover at their retained IDRs.
6. Validate that the normalized output parses, starts with an IDR frame, and contains no IDR in a delta chunk before running the unchanged Phase B merge.

### Hybrid and parallel conversion

1. Sequence conversion starts up to two ffmpeg.wasm workers when incompatible clips are converted through WASM. The pair UI exposes separate A and B progress bars; the report lists every converted clip and path.
2. ffmpeg.wasm decode writes capped `yuv420p` Y4M frames locally. WebCodecs encodes those frames as H.264 and the existing MP4 muxer assembles the result, avoiding full-resolution software x264 work.
3. If WebCodecs encoding is unavailable or fails, the same file is retried entirely in the ffmpeg.wasm encoder. The report records `encodeEngine: "WebCodecs"` or `"ffmpeg.wasm"` and any hybrid fallback reason.

### Phase A: single-clip Classic Mosh

1. Walks the MP4 boxes and resolves the video track's sample table (`stsz`/`stz2`, `stsc`, `stco`/`co64`).
2. Reads length-prefixed H.264 NAL units using the length size declared by `avcC`.
3. Preserves the first GOP, then starts the mosh window at the next IDR. Duration is expressed in source frames, quantized from seconds at the clip's nominal fps.
4. **Continue motion** removes all IDRs from the boundary onward, matching the previous full-length output byte-for-byte.
5. **Restore clear image** removes IDRs only inside the selected window and inserts the original boundary IDR sample before frame N+1. Its payload is byte-identical; subsequent samples and later IDR anchors remain otherwise unchanged. The default is the full available window, which leaves legacy output unchanged.
6. Rewrites sample sizes/offsets for full-length mode or rebuilds the video sample table for a short restore window. All retained NAL payloads remain byte-identical.
7. Plays the modified MP4 as a Blob through the browser's native decoder and exports the same bytes as a download.

`Cut` is retained by the transform as a byte-for-byte copy of the source.

### Phase B: compatible A→B Classic Merge

1. Parses SPS and PPS from each `avcC` and compares the payload bytes. It also parses profile, constraints, level, chroma format, bit depth, and coded resolution from SPS.
2. Requires matching resolution, profile, level, chroma, bit depth, NAL length size, PPS, and video `mdhd` timescale. A differing SPS is accepted only when those core fields match; the report marks it as a warning and the merge uses A's parameters.
3. Keeps A's sample description, samples, and timing as the base. It skips B's initial IDR sample and removes SPS/PPS/SEI units from later samples, but preserves B's later IDR samples as reference anchors.
4. For a multi-GOP B whose first frame after the removed IDR cannot continue A's `frame_num`, it parses the first B-GOP slice headers and patches `frame_num` modulo `2^log2_max_frame_num`. Type 2 POC streams are always eligible. Type 0/1 streams are accepted only when B has no B-slices and its `ctts` has no non-zero composition offsets; for type 0, `pic_order_cnt_lsb` is aligned as well.
5. The patcher unescapes emulation-prevention bytes to RBSP, changes the fixed-width `frame_num` and optional POC bits, then regenerates the EBSP. It therefore remains safe if the original or patched bits span positions where an emulation-prevention byte was present.
6. Appends B's remaining crop of samples and rebuilds the video sample tables, composition offsets, chunk offsets, and container durations. Later B IDRs reset `frame_num` normally and need no patch.
7. With **Restore clear image**, stops the IDR-free window after the selected duration and inserts B's original first IDR sample before frame N+1. The restore IDR is a normal recovery anchor; no extra frame-number patch is applied at insertion. **Continue motion** ignores the shortened window and remains byte-identical to the previous full-length merge.
8. Reports every compatibility criterion, duration frames, ending, clamped/requested values, reinserted IDR positions, removed units, output duration, sample counts, retained B IDRs, frame-number alignment, and the leading IDR frame. Incompatible or invalid pairs are blocked loudly instead of producing a broken file.

### Multi-clip chain

1. Clip 1 contributes every sample. Each **Cut** boundary appends the complete incoming clip with byte-identical sample/NAL data.
2. Each **Classic Mosh** boundary removes the incoming first IDR sample and retained SPS/PPS/SEI units, then aligns the first incoming GOP's `frame_num` and type-0 POC LSB against the already merged stream. Alignment therefore continues from the running chain position, not from the original first clip.
3. **Restore clear image** ends that boundary after its own duration by inserting the original first IDR before frame N+1. **Continue motion** keeps the full-length chain. Settings travel with each boundary through reorder/undo and are reported independently.
4. **Melt** skips the incoming first IDR sample, repeats every non-IDR sample 2–12 times, and keeps later IDRs as single recovery anchors. **Loop Release** repeats its first 2–48-frame group three times, repeats a second timeline-aligned group twice if the first half has room, then continues with consecutive donor samples from the release index. Donor frames are skipped where the repeated blocks consumed output time, so the stream rejoins the original timeline without a new IDR.
5. Melt/Loop Release reschedule complete samples, then renumber non-IDR slice headers sequentially with RBSP/EBSP-safe writes. `frame_num` resets after retained IDRs; type-0 POC-LSB values advance per emitted sample and avoid a POC collision at restart.
6. Later IDRs in every appended clip remain as reference anchors and reset local GOP numbering naturally. Melt and Loop Release require both adjacent clips to be free of B-frame reordering; the app normalizes native B-frame sources first.
7. The sample table is rebuilt once per boundary from the running sequence. `stsz`, `stco`, `stsc`, `stts`, `ctts`, and track/movie durations describe the final chain.
8. The report records clip count, per-boundary methods, effect schedules, duration frames, ending, clamped values, reinserted IDR positions, source and merged sample counts, expected decoded frames, retained NAL identity, and normalization paths. The preview cut shows clip 1 only; the merged preview and export contain the full sequence.

### Audio in merged exports

1. The first audio track of every original source file is decoded locally to PCM. Web Audio resamples and pads/trims it to 48 kHz stereo on the clip's normalized video timeline; ffmpeg.wasm is the fallback when Web Audio cannot decode the format.
2. Audio segments follow timeline order. Classic Mosh and Loop Release start the incoming audio one video frame late, mirroring the removed first IDR sample. Cut keeps the full segment. Melt uses the linear picture timeline and pads extra picture-only frames with exact silence.
3. The assembled PCM length must equal `merged video frames × (48000 / fps)` exactly. A mismatch raises `RuntimeError` before export instead of writing a misaligned file.
4. WebCodecs `AudioEncoder` produces AAC-LC at 48 kHz stereo when available; ffmpeg.wasm encodes the same PCM as the fallback. ffmpeg.wasm muxes the AAC and merged video, and the report names both the encode and mux paths.
5. AAC packets are 1024-sample units, so the MP4 edit list preserves encoder delay and trims the presentation duration to the exact merged sample count. This is container timing, not audio moshing.
6. If every source is silent or has no audio track, no audio stream is added and the report says so. Crossfades and multi-clip audio mixing are not implemented.

## Verification

The committed test chain includes `testmedia/generate.sh`; generated media is ignored and never committed.

```sh
npm test
npm run test:webcodecs
npm run test:pwa
```

`npm test` requires Node and `ffmpeg`/`ffprobe`. `npm run test:pwa` requires Chrome/Chromium and network access for its first ffmpeg.wasm conversion; it tests the resulting offline cache. If fixtures are missing, it runs `testmedia/generate.sh`, which creates local, ignored test media:

- a 3-second 320×240 Phase A clip with IDRs at samples 0, 25, and 50;
- matching 1-second 320×240 A/B clips with identical High-profile settings and timescale;
- a 256×240 resolution mismatch;
- a 320×240 clip with a different `mdhd` timescale;
- a matching 25-frame A plus 75-frame multi-GOP B with B IDRs at samples 0, 25, and 50;
- Safari-style POC type 0 multi-GOP clips with IDRs at samples 0, 25, and 50 and no B-frames, plus a 32-frame C fixture;
- native H.264 clips at 1440×1920 and 768×1024 for the capped auto-normalization path;
- a QuickTime H.264 MOV with a `wide` placeholder;
- a 75-sample H.264 fixture with two IDR slices per access unit;
- HEVC MOV fixtures, including a different-resolution pair;
- a fragmented MP4;
- matching 320×240 H.264/AAC tone clips at 25 fps for merged-audio timing and a video-only silent B clip for mixed silence tests.

The tests assert:

- the known Phase A NAL/GOP layout and exact single-clip IDR removal;
- Phase A selects the next IDR sample as the boundary, keeps both slices of the initial access unit, and removes every slice in later IDR samples;
- retained Phase A NAL bytes and SPS/PPS preservation;
- Phase B compatibility acceptance and actionable rejection messages;
- the merged NAL sequence is A plus B after its first IDR;
- every retained merge NAL is byte-identical to its source;
- `stsz` sum equals mdat content, sample offsets are monotonic, and timing/durations agree;
- the merged stream starts with an IDR frame and retains B's later IDR anchors;
- a multi-GOP B keeps its later IDR anchors, aligns the first B GOP with a safe RBSP/EBSP frame-number patch, and decodes as many frames as its sample table declares;
- a POC type 0, no-B-frame multi-GOP pair merges with frame-number and POC-LSB alignment and decodes all 99 frames;
- Classic Mosh restore at 10 frames removes only IDs inside the window, inserts the exact original boundary sample at frame 11, and preserves later IDR anchors;
- restore decodes 75/75 Phase A frames and 50/50 Phase B frames; continue with a duration set is byte-identical to the previous full-length output;
- duration 1 is accepted, values beyond the available window clamp with a report note, and durations below one frame raise `ValueError`;
- chained rendering carries independent restore/continue settings at each Classic Mosh boundary;
- Melt repeat=4 emits 315 samples and decodes 315/315, with only frame/POC header bits changing outside otherwise identical slice payloads;
- Loop Release loop_frames=4 emits [1,2,3,4] three times, [13,14,15,16] twice, then donors 21–74, and decodes 99/99;
- POC type 0 Melt repeat=2 renumbers both counters and decodes 171/171; a three-clip Melt→Loop Release chain decodes 195/195 and a Loop Release→Cut chain decodes 124/124;
- native B-frame inputs reject Melt/Loop Release loudly, while the browser normalizes native B-frame clips before retrying automatically;
- Classic Mosh and Loop Release drop exactly the first incoming frame while preserving the remaining PCM; a silent clip contributes exact stereo silence; Melt uses linear audio plus sample-exact silence for extra picture frames;
- malformed PCM lengths and audio/video sample mismatches raise `RuntimeError`; WAV and ADTS headers have exact sizes; muxed AAC preserves encoder delay while the edit list presents the exact requested sample count;
- original audio fixture hashes remain unchanged after timeline, WAV, ADTS, and retiming operations;
- a three-clip Classic Mosh chain keeps later B/C IDRs, aligns both first GOPs against the running chain, preserves all unpatched NAL bytes, and decodes 130/130 expected frames;
- a three-clip Cut + Classic Mosh chain preserves A/B NALs byte-for-byte and decodes 131/131 frames;
- POC type 0 with true B-frame reordering remains rejected with an explicit message, including in a chained merge;
- Cut is byte-identical to A;
- both exports decode with `ffprobe`;
- the truncated Phase A file is rejected;
- QuickTime MOV, top-level size-zero `mdat`, `wide`, and 64-bit box headings parse correctly;
- HEVC and fragmented MP4 return their documented actionable errors.
- the WebCodecs muxer's `stsz`/`mdat` sizes, sample offsets, `stss`, and `stts` duration agree;
- normalization chooses one identical even target from differently sized sequence members; 1440×1920 + 768×1024 + 320×240 becomes 540×720;
- the 1440×1920 + 768×1024 native pair auto-normalizes to 540×720, exposes `normalizing clips…`, re-checks compatibility, and merges;
- a three-file mixed-resolution browser import normalizes all cards to 540×720, exposes all four boundary methods, supports reorder/remove/undo, and exports the full 74-frame Cut + Mosh sequence;
- ffmpeg.wasm decode + WebCodecs encode and the full-WASM fallback both name the encoder that ran.
- the browser has no compatibility panel, status badge, table, or SPS/PPS hash display;
- blocking merge errors render as a short alert rather than a compatibility panel;
- the manifest has standalone display, the light theme, SVG/192/512/maskable icons, and a 180px Apple touch icon;
- the service worker activates, controls the page, precaches the 21-file app shell, and excludes the conversion worker and ffmpeg core from precache;
- Chrome reports no manifest or installability errors, activates `beforeinstallprompt`, and the activate handler removes an older versioned cache;
- an offline reload serves the complete shell, after which previously cached ffmpeg.wasm converts and merges HEVC inputs locally and the exported MP4 decodes.

Current local results (2026-11-03, Node 26.13.0, FFmpeg 9.0.2, Google Chrome 156): all 61 Node checks pass. Phase A removes 11,468 bytes and decodes 73 frames. The multi-slice fixture keeps both initial IDR slices, starts at sample 25, removes four later slices, and decodes 73/73 retained frames. Phase B merges 25 A samples plus 24 retained B samples, decodes 49 frames, and produces the same 67,893-byte export. Melt repeat=4 emits and decodes 315 samples; Loop Release with a four-frame group emits and decodes 99, with donor blocks starting at source samples 1 and 13 and a release tail at 21. The multi-GOP regression merges 25 A + 75 B samples, retains two later B IDRs, patches 24 first-GOP slice headers, and decodes all 99 expected frames with three keyframes. A Safari-shaped POC type 0 pair also merges with POC-LSB alignment and decodes 99/99 frames; a genuinely reordered type 0 multi-GOP stream remains rejected. The WebCodecs muxer test emits 8 samples with a 14,984-byte mdat payload and 4,096 duration units. Tier-1 fixtures additionally verify a QuickTime H.264 MOV (25 samples / 26 NALs), a size-zero mdat, standalone `wide`, a 64-bit mdat, the exact HEVC error, and the exact fragmented-MP4 error. The Block F merge produces a 49-frame, 1.960-second AAC-LC track at 48 kHz stereo from 94,080 expected sample frames; the WebCodecs encode plus ffmpeg.wasm mux path preserves the 1,024-sample encoder delay and reports exact presentation timing.

Classic Mosh restore was verified at a 10-frame duration. Phase A removes the sample-25 boundary sample, inserts the byte-identical boundary sample before source frame 36, retains the later sample-50 IDR, and decodes 75/75 source frames without an empty sample entry. The 10-frame Phase B restore inserts B's original IDR at merged sample 35 and decodes 50/50. Continue mode remains byte-identical to the prior full-length joins.

The three-clip POC0 chain uses 25 + 75 + 32 source samples. Two Classic Mosh boundaries retain B/C IDRs at merged samples 49, 74, and 123; 48 first-GOP slice headers are intentionally patched while all other retained NALs stay byte-identical, and strict decode returns 130/130 frames. A Cut + Mosh variant returns 131/131.

The real `IMG_1993.MOV` + `IMG_3339.MOV` verification converted both HEVC originals with ffmpeg.wasm decode plus WebCodecs encode to 540×720. Conversion took 5.7 s and 5.8 s versus 19.8 s and 33.6 s for the earlier full-resolution WASM run. The 112 + 177 source samples merged to 288/288 decoded frames. All later B IDRs were retained, the first B GOP required 32 slice patches across 16 samples, and strict decode exited 0.

`npm run test:webcodecs` uses Chrome's DevTools Protocol directly and has no Node package dependency. It exits with a clear skip if Chrome or a usable H.264 WebCodecs encoder is unavailable. The committed run produced:

```text
PASS WebCodecs decoded and normalized both clips with one leading IDR each; 53018 B / 52775 B
PASS WebCodecs emitted keyframes at samples 1, 31, and 61; the multi-GOP merge retained two later IDRs and decoded all 149 frames
PASS Safari-style POC type 0 multi-GOP pair merges in the browser and clears stale errors
PASS mobile layout stacks under 600px and keeps 44px touch targets on the scrolling timeline
PASS blocking merge errors stay short and do not render a compatibility panel
PASS large native mismatch auto-normalized to 540x720; UI showed the normalizing state and merge produced 49 samples
PASS transition dialog exposes Classic duration/ending plus bounded Melt and Loop controls, and hides method-specific controls appropriately
PASS multi-file import normalized 3 clips to 540x720, exposed two Cut/Classic Mosh boundary dialogs, and merged 74 samples
PASS timeline reorder, remove, and full undo restores the three-clip order and merged preview
PASS full three-clip export decodes 74 frames at 540x720; Cut + Classic Mosh NAL sequence and preview are intact
PASS browser Melt and Loop Release controls produce 315- and 99-sample sequences with fresh slice numbering and decodable preview
PASS selecting Melt on native B-frame clips auto-normalizes both sources before applying the NAL effect
PASS audio merge exports AAC 48000 Hz/2ch, 94080 expected samples, runtime-matched duration, encode=WebCodecs, mux=ffmpeg.wasm
PASS AudioEncoder unavailable: PCM encoded in ffmpeg.wasm and merged audio reports delay=1024 samples
PASS WebCodecs pair merged in the browser: 49 samples, one leading IDR, preview 320x240
PASS merged export decodes: 49 frames, H.264 320x240 yuv420p/tv, SHA-256 b4bb6c4827b2f7a8fe6d93777ff63f4491dd0b8eb497148dd3b2d07da1666bef
PASS ffmpeg.wasm decode + WebCodecs encode: 320x240, both progress bars completed, export decoded
PASS WebCodecs stubbed unavailable: ffmpeg.wasm fallback ran and the report identifies it
```

`npm run test:pwa` produced:

```text
PASS manifest is valid with standalone display, light theme, SVG/192/512/maskable icons, and a 180px Apple touch icon
PASS service worker registered, controlled the page, precached 21 shell assets, and Chrome reports no manifest/installability errors; beforeinstallprompt observed=true
PASS activate cleanup removed the old versioned cache and re-registered the current shell
PASS first online conversion runtime-cached converter-worker.js, ffmpeg-core.js, and ffmpeg-core.wasm (3 runtime entries)
PASS offline reload served the complete app shell from Cache Storage with no network
PASS previously cached ffmpeg.wasm converted two HEVC clips fully offline; merge preview and 120718-byte export decoded 59 frames, SHA-256 47a7fcc6972956e34b9147fead68159350bf16d5f339098436dc5cd8dd25c7b9
```

The same test asserts the normalized A/B streams parse via `parser/nal.js` with exactly one leading IDR each, the B frame-number alignment patches 24 delta samples, the merged `stsz` sum equals mdat content, all 49 frames decode, the non-audio fixture remains video-only, and `has_b_frames=0`. The separate audio fixture run verifies the AAC stream, 48 kHz stereo rate, 1.960 s runtime match, and strict decode. With `VideoDecoder`/`VideoEncoder` stubbed unavailable, the report switches to `normalized via ffmpeg.wasm`.

`npm run test:conversion` remains the optional Playwright test for the HEVC ffmpeg.wasm path. It exits with a clear skip when Playwright or the CDN is unavailable.

Verification includes synthetic fixtures, two real iPhone MOVs, and headless Chrome. A physical iPhone acceptance run is still separate: Safari/WebCodecs behavior, thermal throttling, and device memory cannot be inferred from desktop Chrome.

PWA installation and offline reload are verified in headless Chrome against `localhost`. iOS Home Screen launch, standalone safe-area behavior, and OS cache eviction still need a physical-device check.

The reported `IMG_4767.mov` and `final_0.mov` were not available in this workspace, so the Safari encoder shape is covered by a generated POC type 0 fixture. The actual pair still needs a final iPhone retest.

## Honest limits

Phase A, Phase B, and the multi-clip chain edit H.264 NAL units without blending frames. Phase C decodes and re-encodes pixels only to normalize incompatible sequence members; it does not add crossfades or hold frames as a visual effect. Observable moshing is produced by the device decoder reacting to missing references.

The effect depends on the source GOP structure. Decode behavior is device-dependent: some sources may refuse to play after IDR removal, show black frames, or hold the last decodable frame, especially when seeking directly into a modified GOP. Different browsers and hardware decoders can show different results. This is expected behavior, not a bug.

Phase A handles a single H.264 video track in a conventional (non-fragmented) MP4. Interleaved audio sample offsets are adjusted when present. On multi-GOP sources, removing later IDRs can make the decoder discard dependent pictures, so the decoded frame count can be lower than the MP4 sample/packet count; that is the intended mosh behavior, not a parse failure.

WebCodecs availability does not guarantee hardware acceleration, a particular profile, or support at every resolution; the browser chooses the implementation. If its H.264 decoder/encoder configuration, I420 frame construction, or frame-number alignment is unsupported, the app falls back to ffmpeg.wasm. Current normalizing support is limited to natively parsed H.264 sources because the demuxer is H.264-only; HEVC and other codecs go directly to ffmpeg.wasm.

The 720-pixel long-side cap is intentional and lossy for larger sources. It substantially reduces encode time and memory, and does not reduce the visible mosh effect because bitstream reference loss is resolution-independent. WebCodecs encoders may inject extra IDRs beyond the requested 30-frame cadence; B therefore recovers at its first encoder-provided IDR, which can shorten the affected first GOP.

The ffmpeg.wasm fallback depends on downloading the pinned core from jsDelivr. Parallel sequence conversion deliberately starts up to two WASM workers, so peak memory is higher than a single-worker run even though each target is capped. It may still exhaust memory or fail on iOS Safari with large inputs. The 100 MB limit is a soft product limit for both paths, not a guarantee that a file below it will fit available device memory. No conversion is attempted for encrypted media.

Direct merging supports compatible sequence members only. Resolution, profile, level, chroma, bit depth, PPS, and video timescale must match; differing SPS payloads require equivalent parsed core fields. Phase C can normalize native H.264 mismatches to a common target first. The sequence itself is capped at 12 clips. Merged audio is aligned to the video timeline but is not moshed: Classic Mosh drops one incoming frame, while Loop Release drops one incoming audio frame; Melt adds silence for extra picture frames. Sources without an audio track contribute silence when another source supplies audio. Multi-GOP B is supported: the mosh targets B's first GOP, then the retained B IDRs act as clean recovery anchors, so later B GOPs should play normally after the intended boundary corruption. Type 0/1 POC alignment is limited to streams with no B-slices and no composition reordering; genuinely reordered multi-GOP streams fail explicitly instead of silently producing a short decode. Audio handling is limited to the first track, 48 kHz stereo, and AAC-LC export; very long sequences, memory pressure, or browser codec gaps can still block audio preparation. WebCodecs video normalization is video-only and intentionally removes B-frames; it is not a general-purpose transcoder. Audio is taken from the original files rather than the normalized video.

Native parsing is not HEVC, fragmented-MP4, encrypted-media, or multi-video-track capable; those unsupported local files must go through Tier 2 conversion where applicable.

Classic Mosh duration is bounded by the frames available after the incoming clip's first GOP boundary. Restore inserts the original boundary IDR at frame N+1; it does not blend frames or guarantee smooth motion through the recovery jump. Continue deliberately ignores the shortened window and retains the full prediction chain. Full-length defaults preserve legacy output behavior. Melt and Loop Release are decode-order bitstream effects: they do not blend pixels beyond the repeated slices and can look different across device decoders.

The PWA cache is not a persistence guarantee. First load needs network; a browser may evict Cache Storage, `file://` cannot register a service worker, and iOS may reclaim storage or terminate a large wasm conversion under memory pressure. The service worker deliberately does not cache source media or generated exports outside the page's in-memory Blob URLs.

## Attribution

The approach was studied from [supermosh](https://github.com/supermosh/supermosh.github.io), which is GPLv3. m4shlab is an independent implementation from the Phase A and Phase B specifications; no supermosh source code was copied or reused. The sibling h4moshlab project was treated as conceptual reference only.

## License

MIT. See [LICENSE](LICENSE).
