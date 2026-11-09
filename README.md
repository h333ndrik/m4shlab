# m4shlab

**m4shlab v1.2** — H.264 bitstream moshing in the browser, fully client-side with no server and no upload.

[Side-by-side comparison with h4moshlab](COMPARISON.md)

## Release feature overview

- **Timeline editor:** import and arrange up to 12 clips, reorder by dragging cards on fine-pointer devices or with the arrow buttons, remove clips, and undo/redo timeline edits. Click any card to preview that clip, or use **Assemble preview** for the complete chained result.
- **Seven transition methods:** Cut plus six mosh variants: m4sh (internal key `classic-mosh`); Melt Original; Melt Gentler; Loop Release Original; Loop Release Gentler; Reset Pulse. Every mosh variant exposes frame-quantized duration and Restore/Continue ending controls.
- **Gentler cadence:** Melt bounds donor advances to two frames before its release point and uses consecutive donors for the final quarter. Loop Release bridges the 3×→2× and release-tail jumps with donor advances of at most two frames while preserving the repeated block wraps. Both keep the selected window, video frame count, and audio timeline exact.
- **Per-clip trim:** the ✂ button on a clip card opens a **Trim** dialog with in/out frame inputs, two sliders, a live `frames · seconds at source fps · seconds at 30 fps` readout, Preview in/out on the existing preview, Reset and Apply. The selection is `[start_frame, end_frame)` on the imported frames; trim, look, speed and scaling run in one WebCodecs pass, audio follows the trimmed range, and a trim that shrinks the mosh budget shows up as `clamped` in the dialog, on the connector and in the bitstream report.
- **Per-clip speed:** every timeline entry has an independent 0.1×–4.0× control in 0.1× steps and Reset. Speed uses one WebCodecs frame-mapping/normalization pass at 30 fps; audio follows through a chained ffmpeg.wasm `atempo` path with pitch preserved and an exact sample count.
- **Per-clip looks:** Original, Black & white, B&W negative, and Color negative are independent timeline-entry settings. Non-Original looks are applied to decoded RGBA pixels before the same WebCodecs encode pass and remain visible in preview and export.
- **Seeded Randomize:** the editable 16-hex seed deterministically selects a valid method, duration, ending, repeat/group size, and Reset interval for m4sh, Melt, Loop Release, or Reset Pulse. The same seed and clips reproduce the same variant; copy support makes a good variant reusable, and manual edits clear the seed.
- **Settings files:** the **Project** menu saves a `.m4settings` JSON file with project name, sound state, clip count, per-clip speed/look, transition settings and seeds. Loading validates the complete file first and changes only settings for an identical timeline; media is never included or relinked.
- **Bitstream report:** a collapsed **BITSTREAM REPORT** disclosure below the sequence shows the completed merge JSON in a bounded scroll area. It is never streamed during normalization.
- **Universal import and acceleration:** conventional H.264 MP4/MOV parses natively. Conventional HEVC MOV/MP4 uses native WebCodecs decode when available; other supported inputs use the lazy ffmpeg.wasm path. Incompatible sequence members are normalized automatically to one shared target.
- **Audio:** merged exports use the first audio track from each original source, aligned to the normalized video timeline at 48 kHz stereo and encoded as AAC-LC. Audio follows the timeline but is not moshed.
- **Sound and preview readout:** a persistent **Sound on** toggle controls preview muting and whether the merged export includes AAC audio. The preview row shows live `current / total s` time plus filename-specific or assembled-sequence labels.
- **PWA:** m4shlab is installable and its cached app shell starts offline after the first successful load.

Automatic sequence normalization starts when native compatibility fails. All clips are converted to one shared target capped at **720 pixels on the long side**, using WebCodecs first and ffmpeg.wasm as fallback, then compatibility is checked again on the converted bytes. Conversions can run in parallel.

## Run it

```sh
npm start
```

Open `http://127.0.0.1:4173`, choose up to 12 clips with **+ Import videos**, or drop them onto the timeline. Use the card arrows or drag a card onto the left/right half of another card (fine pointer only) to reorder, the remove buttons to edit the sequence, the per-card look selector, the speed slider for 0.1×–4.0×, and undo/redo for timeline and look changes. The transition dialog can generate a reproducible seeded random mosh variant. Click each dashed connector to open the **Transition** dialog and choose a method from the **Method** select. Every non-Cut method exposes duration and ending controls; Melt adds a repeat factor and Original/Gentler movement selector, Loop Release a group length, and Reset Pulse its interval and P-repeat. Click any clip card to restore its single-clip preview, or use **Assemble preview** for the full sequence. The preview row shows its live time and the **Sound on** toggle controls preview audio and merged-export audio. Validation and normalization happen in the background, and only a blocking error is surfaced. Play from the start for the clearest result. Export downloads `m4shlab-merge.mp4` with the full sequence and source audio when available.

The Phase A single-clip transfer remains available through `mosh.js` and its unchanged test chain.

The app has no package dependencies and no build step. `npm start` only serves the local static files; video never leaves the browser. WebCodecs normalization stays in browser memory. When the fallback is needed, the pinned ffmpeg.wasm core is fetched from jsDelivr on demand; only the local wasm worker receives the file bytes.

## Install (PWA)

Service workers require HTTPS or `localhost`; GitHub Pages provides HTTPS automatically.

- **iOS / iPadOS Safari:** tap **Share** → **Add to Home Screen**.
- **Android Chrome:** use the install banner when offered, or open the browser menu → **Install app** / **Add to Home screen**.
- **Desktop Chrome/Edge:** use the install icon in the address bar, or the browser menu → **Install m4shlab**.

Import expects a standard browser: restricted in-app browsers, such as the embedded views inside messaging apps, may refuse to open the file picker, so open m4shlab directly in Safari or Chrome.

The first load must reach the network so the manifest and versioned app shell can be cached. After that the UI starts offline. Import, m4sh, preview, and export are local operations and continue to work without a network. New-format conversion needs the ffmpeg.wasm core; the first conversion downloads it, then `converter-worker.js`, `ffmpeg-core.js`, and `ffmpeg-core.wasm` stay in the runtime cache. The OS may evict that cache under storage pressure, in which case conversion needs network again.

The current cache version is the `VERSION` in `sw.js` (`m4shlab-<VERSION>` plus `m4shlab-runtime-<VERSION>`). Bump `VERSION` in `sw.js` whenever app-shell or conversion-worker files change. Activation deletes older versioned caches, including the old runtime cache, so the worker cannot run stale code.

## Shell consistency and element contract

`index.html`, `app.js`, and `sw.js` are cached as separate files, so they can drift apart. The build stamp is therefore stored four times and checked twice:

- `sw.js` `VERSION`, `app.js` `BUILD`, &lt;meta name="m4shlab-build"&gt;, and &lt;html data-build&gt; carry the same literal (the `VERSION` in `sw.js`).
- `npm test` reads all four and fails if they differ, so a half-finished version bump cannot ship.
- At startup `app.js` compares the meta content and `data-build` against `BUILD`. On a mismatch it prepends a dismissible `#shell-notice` ("This page mixes two m4shlab versions…") with a Reload button; the editor keeps initializing, imports and exports keep working, and the notice never sets `appReady` to false.

`app.js` declares two registries near the top. `REQUIRED_UI` lists the import, timeline, preview, transition, and export controls: if one is missing, startup shows "This editor is incomplete. Reload the page.", logs one console error naming the missing IDs, and deliberately does not wire a half-functional UI. `OPTIONAL_UI` lists the project menu, seed field, bitstream report, and clip counter: every access to those is null-safe, and the WebCodecs suite removes each optional ID (and all of them at once), then proves the picker and drag-and-drop imports still work.

## Supported formats

| Tier | Inputs | Behavior |
| --- | --- | --- |
| 1 — native parse | Conventional non-fragmented MP4/MOV with an H.264 `avc1`/`avc3` video track, including top-level size-zero `mdat`, 64-bit box sizes, and QuickTime `wide` placeholders | Parsed directly; compatible sequence members merge without re-encoding. The first audio track is decoded from the original source, aligned to the normalized video timeline, and muxed into the merged export |
| 2a — WebCodecs fast path | Native H.264 sequences whose SPS/timing details differ, plus H.264 or HEVC sources when `VideoDecoder` and `VideoEncoder` can handle the source decode and H.264 encode at the required size | Every clip is decoded and re-encoded locally to one shared H.264 target, then processed by the unchanged compatibility check and chained merge. HEVC uses the parsed `hvcC` configuration and reports `decoded via WebCodecs (HEVC)` |
| 2b — ffmpeg.wasm fallback | HEVC (`hvc1`/`hev1`) when native WebCodecs HEVC decode is unavailable, VP9 WebM (verified), fragmented MP4, other supported containers/codecs, and H.264 configurations without a usable WebCodecs path | Decoded locally by ffmpeg.wasm and named as `decoded via ffmpeg.wasm`. The H.264 encode runs in WebCodecs when available, otherwise fully in the pinned WASM worker |
| Not supported | DRM/encrypted media, unavailable ffmpeg.wasm assets, conversion input over 100 MB, or conversions that exceed browser wasm memory | Actionable error; no broken merge is emitted |

Normalization produces a conventional faststart H.264 MP4 at 30 fps, with `yuv420p` limited range, a single requested keyframe at frame 0, no B-frames, and no audio track. One IDR per prepared clip is the point: the prediction chain runs to the clip end instead of resetting every second, and the ffmpeg.wasm fallback uses the same cadence. This video-only normalization intermediate feeds the unchanged merge pipeline; the original soundtrack is extracted separately and muxed into the final merged export. Encoders may insert additional recovery IDRs. The common target is capped at **720 pixels on the long side**. Same-aspect inputs are purely scaled; different aspects are scaled proportionally and letterboxed into the shared box. The mosh effect is resolution-independent, and this cap is much faster than full-resolution software encoding, mirroring h4moshlab's deliberate 640×480 normalization.

Speed changes always use this WebCodecs normalization path, including native Tier-1 clips. Frame selection/repetition and resolution scaling happen in the same decode/encode pass. A clip at speed 1.0× that does not need normalization stays on the original byte-identical Tier-1 path.

Native Tier-1 clips may contain B-frames; their `ctts` composition offsets are preserved during merge. Converted clips deliberately have no B-frames.

### Boundary methods

| # | Method | Parameters | Behavior |
| ---: | --- | --- | --- |
| 1 | Cut | — | Append the incoming clip completely and byte-identically. |
| 2 | Classic Mosh | Duration, Restore/Continue | Remove only the incoming first IDR, align the first GOP, and optionally restore an IDR after the frame-quantized window. |
| 3 | Melt · Original | Duration, ending, repeat 2–12 | Hold each consecutive non-IDR donor for the repeat count inside the effect window. |
| 4 | Melt · Gentler | Duration, ending, repeat 2–12 | Bound donor advances to two frames before the release point, then use consecutive donors for the final quarter. |
| 5 | Loop Release · Original | Duration, ending, group 2–48 | Scale the 3×/2× release pattern into the window, retain internal block wraps, then rejoin the chronological donor timeline. |
| 6 | Loop Release · Gentler | Duration, ending, group 2–48 | Bridge block-boundary jumps with donor advances of at most two frames while preserving the internal repeated-block wraps. |
| 7 | Reset Pulse | Duration, ending, interval 4–48, repeat 2–12 | Re-insert the incoming original first IDR every interval and fill each pulse with repeated consecutive P-samples. |

Restore re-inserts the incoming clip's original first IDR byte-identically at the effect exit; Continue appends the chronological tail and retains the prediction chain. All emitted slices are renumbered through the RBSP/EBSP-safe `frame_num` and type-0 POC-LSB path where the schedule requires it.

## Interface

### Branding

The `m4` wordmark follows the sibling h4moshlab typographic system: Arial/Helvetica Bold 700, dark `#242424` text on `#f5f5f3`, negative tracking, and a compact rounded favicon tile. The scalable favicon, 32px tab fallback, PWA icons, and 180px Apple touch icon use new “m4” lettering rather than the h4 letterforms. The 512px maskable icon keeps the wordmark inside the central safe area. The separate h4 cursor brand is unchanged.

The timeline heading uses title-case `Sequence` in markup; shared section-label CSS presents it in uppercase. The empty state keeps the explicit `0.00 / 0.00 s` readout and renders the disabled primary export button as a high-contrast neutral control rather than a faint action.

The page follows the h4moshlab visual language: a light radial-gradient background, centered 1000px layout, compact bordered controls, a large dark preview well, and a horizontal clip timeline. Clip cards show a thumbnail, filename, duration, a per-entry look selector, a 0.1×–4.0× speed slider with Reset, active reorder arrows, HTML5 drag-and-drop reordering on fine-pointer devices, and a remove button; undo/redo restores timeline, look, and speed edits. Each dashed connector shows the method, duration in seconds, and the supported ending or interval/group shorthand, and opens the **Transition** dialog with a **Method** select. All non-Cut methods share duration and ending controls; Melt adds a 2–12 repeat slider, Loop Release a 2–48-frame group slider, and both expose an Original/Gentler movement selector; Reset Pulse has 4–48-frame interval plus 2–12 P-repeat sliders. Clicking a card previews that clip; **Assemble preview** shows the full chained result. Compatibility criteria, badges, and SPS/PPS hashes are not rendered. Under 600px the header and preview actions stack and touch controls meet the 44px target.

## What it does

### Universal import and sequence preparation

1. Tier 1 walks conventional MP4/MOV boxes and H.264 sample tables. Fragmented MP4 and unsupported codecs produce explicit errors.
2. A native sequence with any incompatible or differing boundary enters a visible **normalizing clips…** state instead of showing a final incompatibility verdict. All clips are normalized to the shared capped target and checked again.
3. Native H.264 normalization reuses parsed samples and `avcC`, decodes with `VideoDecoder`, scales/letterboxes through a canvas, converts to limited-range I420, and encodes every sequence member with `VideoEncoder` using identical settings.
4. HEVC first tries a native `VideoDecoder` path using parsed `hvcC`; other codecs and unsupported HEVC configurations use ffmpeg.wasm for decode. If WebCodecs H.264 encoding is available, ffmpeg.wasm emits a capped Y4M stream and WebCodecs performs the encode; otherwise the complete encode stays in the WASM worker. Reports distinguish `decoded via WebCodecs (HEVC)` from `decoded via ffmpeg.wasm`.
5. The JSON report names decode path, encode path, target, parallel execution, fallback reason, and duration for every clip. The main UI shows only a compact `normalizing clips… n of m` line with one indeterminate bar while work is active; it disappears when conversion finishes. Clip cards show duration only, never codec-path text. Compatibility is checked again on the converted bytes before preview and chained merge, without rendering a criteria table.
6. Every picked or dropped file gets a dashed skeleton card at its appending position while preparation runs. At most two files prepare concurrently; queued cards show `waiting`, active cards show `converting… N %`, and the normalizing count remains visible. The thumbnail shimmer is CSS-only and becomes a static placeholder under reduced motion; prepared cards replace the skeletons in import order and their thumbnails fade in over 150 ms.

### HEVC decode path

Conventional MOV/MP4 files with `hvc1` or `hev1` video sample entries are demuxed from their `hvcC` configuration and length-prefixed HEVC NAL units without sending those NALs through the H.264 NAL parser. When the browser's `VideoDecoder` accepts the HEVC codec configuration, the existing decode/scale/encode pass writes the same capped, 30 fps, B-frame-free H.264 normalization output and marks the source as `decoded via WebCodecs (HEVC)`. If HEVC decode is unsupported or the H.264 encode configuration fails, the same file goes through ffmpeg.wasm and is marked `decoded via ffmpeg.wasm`. The converted bytes then follow the unchanged compatibility and chained-merge pipeline.

### Randomize

Every mosh boundary has a **Randomize** action for Classic Mosh, Melt, Loop Release and Reset Pulse; Cut disables it. Each click creates a 16-character hexadecimal seed with `crypto.getRandomValues`. A mulberry32-style generator derives the method, frame-quantized duration, ending and method-specific repeat/loop/interval values from that seed, so the same seed and clip constraints reproduce the same variant. Generated values obey the 12–144 frame duration range, the 0.5-second aligned-effect minimum, Loop frames shorter than the duration, and Reset intervals shorter than the duration. Invalid candidates are redrawn from the same seeded stream for at most 20 attempts.

The seed is stored as `randomSeed` on the timeline entry, survives undo/redo and reorder, and is reported as `random_seed` on the boundary. Editing any transition control manually clears the seed. Randomize does not modify audio-follow behavior.

### Gentler Loop Release

Loop Release keeps m4shlab's Block G 3×/2×/tail schedule in **Original** mode. **Gentler** mode bridges forward donor jumps at the 3×→2× and release-tail boundaries using steps of at most two source frames. The wrap-around inside each repeated block remains intact, and bridged output frames replace the leading slots at the affected boundary so the duration window, merged frame count, and linear audio timeline remain exact. Repeated payloads stay byte-identical; frame_num and type-0 POC-LSB values are renumbered through the existing RBSP/EBSP-safe path. Later IDRs remain natural reset points.

h4moshlab deliberately does not offer Gentler cadence on Loop Release. This is an m4shlab extension and must be judged visually on the intended source; it is not interpolation or a smoothness guarantee.

### Per-clip trim

1. Every clip carries `start_frame` / `end_frame` (integer, exclusive end) over the imported frames. The pipeline order for one clip is fixed: select `[start_frame, end_frame)` → apply look → speed map → scale to the target → encode. Trim always reads the clip's base imported bytes, so trimming after a speed change never stacks re-encodes.
2. `trimSpeedPlan()` in `speed.js` plans from `trimmedFrames`, computes donors over the trimmed count and adds `start_frame`, so every donor index stays inside the selection. `speedOutputFrameCount(trimmedFrames, fps, speed)` sets the output length.
3. `normalizationCacheKey()` includes the trim range, so two trims of one source never share a prepared copy while the same trim reuses one.
4. The mosh budget follows the trimmed clip: `moshSettingsForClip()` clamps an explicit duration to the new maximum and reports `requestedFrames`, `effective_frames` and `clamped`. The connector, the dialog mode and `report.transitions[i]` all expose the clamp.
5. Audio is sliced to the trimmed frame range before the atempo stage, so the assembled PCM length still equals `merged video frames × (48000 / fps)`; silent or audio-less clips contribute exact silence and a mismatch still raises before export.
6. `.m4settings` stores `start_frame` / `end_frame` per clip. Files without those fields load as full-clip trims, and a trim beyond the current clip length is rejected before anything is applied.

### Per-clip speed

1. Speed is entry-specific clip metadata from 0.1× to 4.0× in 0.1× steps; duplicate imports may use different speeds. Undo/redo and the JSON source/boundary reports retain `speed`, `input_frames`, `output_frames`, and the applied donor mapping.
2. A speed change uses the clip's base imported bytes, not an already speed-adjusted copy, so repeated changes and Reset do not stack re-encodes. Native and converted H.264 bases both enter the same WebCodecs pass.
3. For speeds other than 1.0×, output frame `j` selects source frame `floor(j × speed × source_fps / 30)`. Output length is `round(source_frames × 30 / (source_fps × speed))`; the mapping repeats frames below 1×, drops them above 1×, and handles fractional speeds without accumulating rounding drift.
4. All emitted frames use the constant 30 fps grid and identical H.264 normalization settings. Resolution scaling to the shared 720px target happens inside that same pass.
5. Audio follows the same speed through a product-equivalent chain of ffmpeg.wasm `atempo` stages, each between 0.5× and 2.0×. `atempo` changes duration without changing tonal pitch. The result is resampled to 48 kHz stereo, then padded/trimmed to exactly `output_frames × 1600` samples. A mismatch is a loud `RuntimeError`.
6. Speed audio needs the lazily loaded ffmpeg.wasm core unless the result is silent. The first speed change may therefore show a conversion delay of about 31 MB download plus WASM processing.

### Per-clip looks

Every timeline entry has its own look selector. **Original** leaves decoded pixels unchanged and keeps the native Tier-1 fast path when no other preparation is needed. **Black & white** sets each RGB channel to `round(0.299R + 0.587G + 0.114B)`; **B&W negative** uses `255 - luma`; **Color negative** uses `255 - channel` for red, green, and blue. Alpha is preserved in the RGBA transform.

A non-Original look forces WebCodecs preparation from the clip's base imported bytes, even for native H.264. The transform is applied after the decoded frame is drawn into the shared canvas and before I420 conversion, so look, speed mapping, scaling, and encoding share one pass. The preparation report records `look`, `preparedLook`, the source/target/speed/look cache key, and `encodePasses: 1`. Duplicate imports retain independent look settings, and undo/redo restores the look along with the rest of the timeline entry. This does not alter the preview or export outside the selected source frames.

### Sound, time, and preview labels

The preview-meta row has a **Sound on** checkbox, checked by default. Its state is stored under the localStorage key `m4shlab-audio`; unchecking mutes the preview video and skips audio preparation and the AAC mux step entirely. The merged export is then video-only, and `merge.audio` / the top-level report carry `included: false`, `enabled: false`, and the reason. Re-enabling sound rebuilds the merged file with the existing timeline-aligned AAC path.

A `0.00 / 0.00 s` readout follows `timeupdate`, `durationchange`, and metadata events for whichever preview is active. Clicking a clip card selects it and labels the preview `Clip preview · <filename>`. **Assemble preview** switches to the chained result and labels it `Assembled preview · all clips and transitions`; clicking a card returns to that clip.

### Software preview

The **Software preview** checkbox sits next to the time readout, is off by default, and is remembered under the localStorage key `m4shlab-software-preview`. With it on, the preview no longer plays the blob through a `<video>` element: the edited stream is decoded with `VideoDecoder` and painted into a canvas in the same well, one frame at a time (decode → draw → `frame.close()`, about 1.5 s of lookahead, canvas capped at 720 px on the long side). This is the same decode path an export reviewer uses, so it shows the reference-loss artefacts even on hardware decoders that quietly repeat the last picture instead of showing them. Playback is click-to-play/pause; seeking restarts from frame 0. Audio is not played in software preview — the toggle's tooltip says so, and export audio is unaffected. If the decode of the edited stream throws, the app names the reason, switches the toggle off and returns to `<video>` playback instead of leaving a blank canvas.

### Phase C: WebCodecs normalization

1. Feature-detect `VideoDecoder`, `VideoEncoder`, and `VideoFrame`; select an H.264 encoder configuration supported by the current browser.
2. Decode the source in sample order, draw each frame into one common even-sized canvas capped at 720 pixels on the long side, and preserve or letterbox aspect ratio as needed.
3. Convert the canvas to explicit BT.709 limited-range I420 and encode H.264 with a single requested keyframe at frame 0 and no periodic refresh. The output is video-only. The ffmpeg.wasm encode path uses the same value (`-g 1000000`, the explicit "one keyframe" cap) so both paths behave identically.
4. Mux encoded chunks into `ftyp`/`moov`/`mdat` faststart MP4 with `stts`, `stss`, `stsc`, `stsz`, and `stco`/`co64`.
5. Align B's first-GOP non-key H.264 `frame_num` values so they continue after A. Without this, a decoder can discard early B frames after the removed IDR because separately encoded clips both start at frame number zero. Later B GOPs keep their local numbering and recover at their retained IDRs.
6. Validate that the normalized output parses, starts with an IDR frame, and contains no IDR in a delta chunk before running the unchanged Phase B merge.

### Hybrid and parallel conversion

1. Sequence conversion starts up to two ffmpeg.wasm workers when incompatible clips are converted through WASM. The UI shows one compact normalizing count and one indeterminate bar; the JSON report lists every converted clip and path.
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
4. **Melt** and **Loop Release** fill the selected output-frame window with their donor schedules, then append the chronological tail from the next unused donor. Continue performs no reference reset; Restore inserts B's original first IDR sample byte-identically at that exit. **Melt** repeats consecutive non-IDR donors 2–12 times. Its Gentler schedule starts from the same requested holds, caps donor advances at two frames before `duration - max(1, floor(duration/4))`, and uses consecutive donors for that final quarter. **Loop Release** repeats its first 2–48-frame group three times and a second timeline-aligned group twice when the window has room. Donor frames are skipped where repeated blocks consumed output time. **Reset Pulse** fills each 4–48-frame interval with a byte-identical reinsertion of B's original first IDR sample followed by consecutive non-IDR donors, each repeated 2–12 times.
5. Melt/Loop Release/Reset Pulse reschedule complete samples, then renumber non-IDR slice headers sequentially with RBSP/EBSP-safe writes. `frame_num` resets after retained IDRs; type-0 POC-LSB values advance per emitted sample and avoid a POC collision at restart.
6. Later IDRs in every appended clip remain as reference anchors and reset local GOP numbering naturally. Melt, Loop Release and Reset Pulse require both adjacent clips to be free of B-frame reordering; the app normalizes native B-frame sources first.
7. The sample table is rebuilt once per boundary from the running sequence. `stsz`, `stco`, `stsc`, `stts`, `ctts`, and track/movie durations describe the final chain.
8. The report records clip count, per-boundary methods, effect schedules, duration frames, ending, clamped values, reinserted IDR positions, source and merged sample counts, expected decoded frames, retained NAL identity, and normalization paths. Clicking a card previews that source; **Assemble preview** and the export contain the full sequence.

### Audio in merged exports

1. The first audio track of every original source file is decoded locally to PCM. Web Audio resamples and pads/trims it to 48 kHz stereo on the clip's normalized video timeline; ffmpeg.wasm is the fallback when Web Audio cannot decode the format. Non-1.0× clips then pass that PCM through the pitch-preserving chained `atempo` speed stage.
2. Audio segments follow timeline order. Classic Mosh, Loop Release, Reset Pulse, and explicit-window Melt start the incoming audio one video frame late, mirroring the removed first IDR sample. Cut keeps the full segment. Extra picture-only frames and restore-anchor frames receive sample-exact silence, so effect windows never shift later audio boundaries. API callers using the legacy duration-less Melt path keep the original full audio segment.
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
- Reset Pulse fixtures reuse those clips with a 12-frame effect window, 4–48-frame pulse intervals, and repeat endpoints 2/12;
- Safari-style POC type 0 multi-GOP clips with IDRs at samples 0, 25, and 50 and no B-frames, plus a 32-frame C fixture;
- native H.264 clips at 1440×1920 and 768×1024 for the capped auto-normalization path;
- a QuickTime H.264 MOV with a `wide` placeholder;
- a 75-sample H.264 fixture with two IDR slices per access unit;
- HEVC MOV fixtures, including a different-resolution pair;
- a fragmented MP4;
- matching 320×240 H.264/AAC tone clips at 25 fps for merged-audio timing and a video-only silent B clip for mixed silence tests.
- a 60-frame, 30 fps H.264/AAC 440 Hz tone fixture for speed mapping, merge, frame-count, and pitch-preservation tests.

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
- Melt duration=12/repeat=2 emits an exact 12-frame hold window, continues from donor 7, preserves every repeated payload byte, and decodes 105/105; Restore inserts the byte-identical incoming IDR at merged sample 37 and decodes 106/106;
- Gentler Melt duration=12/repeat=2 bounds every pre-release donor step to at most two frames, ends with donors 10/11/12, preserves payload bytes, and decodes 99/99; its Restore variant keeps the recovery IDR;
- Loop Release duration=12 scales the release blocks into the window, rejoins at donor 13, and decodes 99/99; its Restore variant adds the normal recovery anchor;
- Melt/Loop duration clamps to 74 frames, accepts one frame, rejects zero, and keeps the audio timeline exactly equal to merged video frames × samples per frame;
- speed plans map 60 frames to 30, 120, 60, and 35 output frames at 2×, 0.5×, 1×, and 1.7×; out-of-range values raise `SpeedValueError`;
- look transforms produce exact B&W, B&W-negative, and color-negative RGBA values while preserving alpha, and normalization cache keys include source, target, speed, and look;
- two duplicate browser clips with different looks re-encode in one WebCodecs pass each, retain look metadata through undo/redo, and export a decodable 119-frame result whose B&W half has no visible color-channel spread;
- sound-off exports contain no audio stream, mute the preview, persist as `m4shlab-audio=false`, and restore on/off state across reload; preview labels and the live current/duration readout follow the active source or assembled result;
- the seeded randomizer reproduces identical settings for the same seed and validates 50 seeds × all four mosh methods (200 combinations);
- HEVC parsing validates `hvcC`, length-prefixed NAL demuxing, 25 samples, 320×240 dimensions, and the Main/L60 codec configuration without using the H.264 NAL parser;
- browser HEVC import reports either `decoded via WebCodecs (HEVC)` or the actual ffmpeg.wasm fallback, converts to H.264, and merges;
- with WebCodecs deliberately unavailable, HEVC import names ffmpeg.wasm and produces a playable converted clip;
- the browser Randomize action generates a 16-hex seed, a manual edit clears its display, and the applied seed appears as `random_seed` in the boundary report;
- 2×, 0.5×, and 1.7× atempo chains preserve a 440 Hz tone and emit exactly 48,000, 192,000, and 56,000 samples; each stage is within 0.5–2.0×;
- the browser merges a 2× clip plus a 0.5× clip into 150 frames with 240,000 audio samples, decodes 150/150 frames, and exports at 30 fps;
- fractional 1.7× produces 35 decodable frames and a 35-frame audio timeline; Reset restores 1.0× and 60 input/output frames;
- a single 1440×1920 clip at 2× normalizes to 540×720 and 15 output frames in one WebCodecs pass;
- Gentler Loop duration=12/group=4 emits donor positions [0,1,0,1,0,1,3,5,7,9,10,11], preserves wraps at outputs 2/4, bridges the tail jump with advances ≤2, keeps the 12-frame window, and decodes 99/99; the original cadence output SHA-256 remains `a2654bb53026dcf11cb040c05aecdffd2299a387fb4f0693c3a8da9635541fe3`;
- Reset Pulse interval=6/repeat=2 emits IDRs at merged samples 25/31, donor tables [1,1,2,2,3] per interval, tail donor 13, and decodes 99/99; interval 4, repeats 2/12, Restore tail IDR, duration clamping, the full-window default, sub-frame rejection, and interval >= duration rejection are covered;
- Reset Pulse POC type 0 restarts frame_num and POC-LSB at 1 per pulse segment and decodes 99/99; Reset Pulse→Cut and Reset Pulse→Classic Mosh decode 124/124 and 123/123;
- browser drag-and-drop reorders cards before or after another card, ignores self-drops, keeps connectors in sync, supports undo, and leaves file drag-and-drop import working; touch cards stay non-draggable while the arrows still reorder;
- POC type 0 Melt repeat=2 renumbers both counters and decodes 171/171; a three-clip Melt→Loop Release chain decodes 195/195 and a Loop Release→Cut chain decodes 124/124;
- native B-frame inputs reject Melt/Loop Release/Reset Pulse loudly, while the browser normalizes native B-frame clips before retrying automatically;
- Classic Mosh, Loop Release, Reset Pulse, and explicit-window Melt drop exactly the first incoming frame while preserving the remaining PCM; a silent clip contributes exact stereo silence; extra picture frames receive sample-exact silence;
- malformed PCM lengths and audio/video sample mismatches raise `RuntimeError`; WAV and ADTS headers have exact sizes; muxed AAC preserves encoder delay while the edit list presents the exact requested sample count;
- original audio fixture hashes remain unchanged after timeline, WAV, ADTS, and retiming operations;
- a three-clip Classic Mosh chain keeps later B/C IDRs, aligns both first GOPs against the running chain, preserves all unpatched NAL bytes, and decodes 130/130 expected frames;
- a three-clip Cut + Classic Mosh chain preserves A/B NALs byte-for-byte and decodes 131/131 frames;
- POC type 0 with true B-frame reordering remains rejected with an explicit message, including in a chained merge;
- Cut is byte-identical to A;
- both exports decode with `ffprobe`;
- the truncated Phase A file is rejected;
- QuickTime MOV, top-level size-zero `mdat`, `wide`, and 64-bit box headings parse correctly;
- HEVC parses through an explicit `allowHevc` path into hvcC plus HEVC samples; the default Tier-1 parser still returns its documented H.264 conversion error.
- fragmented MP4 returns its documented actionable error.
- the WebCodecs muxer's `stsz`/`mdat` sizes, sample offsets, `stss`, and `stts` duration agree;
- normalization chooses one identical even target from differently sized sequence members; 1440×1920 + 768×1024 + 320×240 becomes 540×720;
- the 1440×1920 + 768×1024 native pair auto-normalizes to 540×720, exposes `normalizing clips…`, re-checks compatibility, and merges;
- a three-file mixed-resolution browser import normalizes all cards to 540×720, exposes all four boundary methods, supports drag/arrow reorder, remove, and undo, and exports the full 74-frame Cut + Mosh sequence;
- ffmpeg.wasm decode + WebCodecs encode and the full-WASM fallback both name the encoder that ran.
- the browser has no compatibility panel, status badge, table, or SPS/PPS hash display;
- blocking merge errors render as a short alert rather than a compatibility panel;
- the manifest has standalone display, the light theme, SVG/192/512/maskable icons, and a 180px Apple touch icon;
- the service worker activates, controls the page, precaches the 33-file app shell, and excludes the conversion worker and ffmpeg core from precache;
- Chrome reports no manifest or installability errors, activates `beforeinstallprompt`, and the activate handler removes an older versioned cache;
- an offline reload serves the complete shell, after which previously cached ffmpeg.wasm converts and merges HEVC inputs locally and the exported MP4 decodes.

Current local results (2026-11-06, Node 26.13.0, FFmpeg 9.0.2, Google Chrome 156): all 84 Node checks pass, the WebCodecs suite passes 102 checks, and the PWA suite passes 6 checks. Both encode paths request one keyframe at frame 0: a 75-frame WebCodecs clip emits one IDR (previously three at samples 1, 31, 61) and the ffmpeg.wasm fallback emits one IDR on a 90-frame clip (previously three). Phase A removes 11,468 bytes and decodes 73 frames. The multi-slice fixture keeps both initial IDR slices, starts at sample 25, removes four later slices, and decodes 73/73 retained frames. Phase B merges 25 A samples plus 24 retained B samples, decodes 49 frames, and produces the same 67,893-byte export. Melt repeat=4 emits and decodes 315 samples; Loop Release with a four-frame group emits and decodes 99, with donor blocks starting at source samples 1 and 13 and a release tail at 21. Melt duration=12/repeat=2 emits an exact 12-frame window, continues from donor 7, and decodes 105/105; its Restore form decodes 106/106. Gentler Melt uses the bounded donor schedule and decodes 99/99. Loop duration=12 emits and decodes 99/99. Reset Pulse interval=6/repeat=2 re-inserts the boundary IDR at merged samples 25 and 31, reports donor tables [1,1,2,2,3], and decodes 99/99; its POC type 0 variant also decodes 99/99. Speed plans produce 30/120/60/35 frames at 2×/0.5×/1×/1.7×; chained atempo preserves the 440 Hz tone. The multi-GOP regression merges 25 A + 75 B samples, retains two later B IDRs, patches 24 first-GOP slice headers, and decodes all 99 expected frames with three keyframes. A Safari-shaped POC type 0 pair also merges with POC-LSB alignment and decodes 99/99 frames; a genuinely reordered type 0 multi-GOP stream remains rejected. The WebCodecs muxer test emits 8 samples with a 14,984-byte mdat payload and 4,096 duration units. Tier-1 fixtures additionally verify a QuickTime H.264 MOV (25 samples / 26 NALs), a size-zero mdat, standalone `wide`, a 64-bit mdat, the exact HEVC error, and the exact fragmented-MP4 error. Randomize adds 200 validated method/parameter combinations, and HEVC parsing verifies 25 samples, hvcC Main/L60.90 configuration, and length-prefixed NAL demuxing. The Block F merge produces a 49-frame, 1.960-second AAC-LC track at 48 kHz stereo from 94,080 expected sample frames; the WebCodecs encode plus ffmpeg.wasm mux path preserves the 1,024-sample encoder delay and reports exact presentation timing.

Classic Mosh restore was verified at a 10-frame duration. Phase A removes the sample-25 boundary sample, inserts the byte-identical boundary sample before source frame 36, retains the later sample-50 IDR, and decodes 75/75 source frames without an empty sample entry. The 10-frame Phase B restore inserts B's original IDR at merged sample 35 and decodes 50/50. Continue mode remains byte-identical to the prior full-length joins.

The three-clip POC0 chain uses 25 + 75 + 32 source samples. Two Classic Mosh boundaries retain B/C IDRs at merged samples 49, 74, and 123; 48 first-GOP slice headers are intentionally patched while all other retained NALs stay byte-identical, and strict decode returns 130/130 frames. A Cut + Mosh variant returns 131/131.

The real `IMG_1993.MOV` + `IMG_3339.MOV` verification converted both HEVC originals with ffmpeg.wasm decode plus WebCodecs encode to 540×720. Conversion took 5.7 s and 5.8 s versus 19.8 s and 33.6 s for the earlier full-resolution WASM run. The 112 + 177 source samples merged to 288/288 decoded frames. All later B IDRs were retained, the first B GOP required 32 slice patches across 16 samples, and strict decode exited 0.

`npm run test:webcodecs` uses Chrome's DevTools Protocol directly and has no Node package dependency. It always ends with a `SUMMARY ... passed N / skipped M` line; a run that skipped anything reports `INCOMPLETE` in that last line and exits with status 2 unless `M4SHLAB_ALLOW_SKIPS=1` is set. Excerpt from a run on 2026-11-06:

```text
PASS WebCodecs decoded and normalized both clips with one leading IDR each; 53018 B / 52775 B
PASS a 75-frame normalized clip emits 1 IDR (samples 1; the old cadence emitted 3 at samples 1, 31, 61) and the merged chain decodes 149/149 frames
PASS a 60-frame Melt window (merged samples 75-134) carries 0 IDRs and decodes 194/194 frames
PASS Safari-style POC type 0 multi-GOP pair merges in the browser and clears stale errors
PASS mobile layout keeps the reference header/meta/sequence rows, an in-viewport project panel, and side-by-side footer actions with 44px touch targets
PASS blocking merge errors stay short and do not render a compatibility panel
PASS large native mismatch auto-normalized to 540x720; the compact normalizing line disappeared and merge produced 49 samples
PASS transition dialog exposes Classic/Reset duration, Melt/Loop, and Reset Pulse interval/repeat controls
PASS multi-file import normalized 3 clips to 540x720, exposed two Cut/m4sh boundary dialogs, and merged 74 samples
PASS clip drag-and-drop reorders in both directions, shows CSS feedback, self-drop is inert, and undo restores order
PASS touch cards stay non-draggable while arrow reorder works; desktop drag returns after pointer reset
PASS clip-card and Assemble preview selection replace the removed A cut/merged toggle; time readout and sound defaults remain
PASS timeline reorder, remove, and full undo restores the three-clip order and merged preview
PASS full three-clip export decodes 74 frames at 540x720; Cut + m4sh NAL sequence and preview are intact
PASS browser Gentler Loop bridges to the release tail with <=2 donor advances and decodes 99 samples
PASS browser Melt, Gentler Melt, Loop Release, and Reset Pulse produce 105-, 99-, 99-, and 99-sample decodable sequences
PASS selecting Melt on native B-frame clips auto-normalizes both sources before applying the NAL effect
PASS audio merge exports AAC 48000 Hz/2ch, 94080 expected samples, runtime-matched duration, encode=WebCodecs, mux=ffmpeg.wasm
PASS AudioEncoder unavailable: PCM encoded in ffmpeg.wasm and merged audio reports delay=1024 samples
PASS Randomize creates a 16-hex seed, manual edits clear it, and random_seed persists in the boundary report
PASS HEVC import ran ffmpeg.wasm decode plus WebCodecs H.264 encode at 320x240; the compact conversion status completed and export decoded
PASS native HEVC decoded via WebCodecs and merged 49 samples through the unchanged H.264 path
PASS WebCodecs unavailable: HEVC import uses ffmpeg.wasm and reports it only in JSON
PASS 2× + 0.5× clips merge to 150/150 frames and 240000 exact audio samples at 30 fps
PASS fractional 1.7× produces 35 decodable frames with a 35-frame audio timeline
PASS per-clip Reset restores 1.0× with 60 input and 60 output frames
PASS single clip speed=2 and 720px normalization run in one 540×720 WebCodecs pass
PASS WebCodecs pair merged in the browser: 49 samples, one leading IDR, preview 320x240
PASS merged export decodes: 49 frames, H.264 320x240 yuv420p/tv, SHA-256 b4bb6c4827b2f7a8fe6d93777ff63f4491dd0b8eb497148dd3b2d07da1666bef
PASS WebCodecs stubbed unavailable: ffmpeg.wasm fallback ran and the report identifies it
```

`npm run test:pwa` produced:

```text
PASS manifest is valid with standalone display, light theme, resolving SVG/192/512-maskable icons, and favicon plus 180px Apple links
INFO wordmark geometry: favicon 30.3×25.0 inside 32×32; maskable corner 196.7px <= 204.8px safe radius
PASS service worker registered, controlled the page, precached 33 shell assets, and Chrome reports no manifest/installability errors; beforeinstallprompt observed=true
PASS activate cleanup removed the old versioned cache and re-registered the current shell
PASS first online conversion runtime-cached converter-worker.js, ffmpeg-core.js, and ffmpeg-core.wasm (3 runtime entries)
PASS offline reload served the complete app shell from Cache Storage with no network
PASS previously cached ffmpeg.wasm converted two HEVC clips fully offline; merge preview and 120718-byte export decoded 59 frames, SHA-256 47a7fcc6972956e34b9147fead68159350bf16d5f339098436dc5cd8dd25c7b9
```

The same test asserts the normalized A/B streams parse via `parser/nal.js` with exactly one leading IDR each, the B frame-number alignment reports `frameAlignment.applied` (the 24 patched samples in this pair are a measurement, not an asserted value), the merged `stsz` sum equals mdat content, all 49 frames decode, the non-audio fixture remains video-only, and `has_b_frames=0`. The separate audio fixture run verifies the AAC stream, 48 kHz stereo rate, 1.960 s runtime match, and strict decode. With `VideoDecoder`/`VideoEncoder` stubbed unavailable, the report switches to `normalized via ffmpeg.wasm`.

`npm run test:conversion` remains the optional Playwright test for the HEVC ffmpeg.wasm path. It exits with a clear skip when Playwright or the CDN is unavailable.

Verification includes synthetic fixtures, two real iPhone MOVs, and headless Chrome. A physical iPhone acceptance run is still separate: Safari/WebCodecs behavior, thermal throttling, and device memory cannot be inferred from desktop Chrome.

PWA installation and offline reload are verified in headless Chrome against `localhost`. iOS Home Screen launch, standalone safe-area behavior, and OS cache eviction still need a physical-device check.

The reported `IMG_4767.mov` and `final_0.mov` were not available in this workspace, so the Safari encoder shape is covered by a generated POC type 0 fixture. The actual pair still needs a final iPhone retest.

## Intentional UI elements

- `BITSTREAM REPORT` is an intentional collapsed UI disclosure below the sequence. It renders only the completed merge report and is not live-streamed.

## Technical limits

Normalization keeps the long side at or below 720 pixels. This is intentionally lossy for larger sources, but it substantially reduces memory and encode time without removing the bitstream reference-loss effect. Same-aspect inputs are scaled proportionally; different aspects are letterboxed into one shared target.

WebCodecs is the preferred decode/encode path for supported H.264 and HEVC inputs. The browser selects the implementation, so hardware acceleration and codec/profile support are not guaranteed. ffmpeg.wasm is loaded lazily as the fallback for unsupported codecs or browser configurations. Parallel sequence conversion starts up to two workers; the 100 MB input limit is a soft product limit, not a guarantee that a file fits device memory.

iOS Safari has stricter memory behavior than desktop browsers. Large ffmpeg.wasm conversions can still be terminated under memory pressure, and the OS may evict the runtime cache or PWA storage. The merged audio path uses the first track only, at 48 kHz stereo; it is not audio moshing.

Multi-GOP type 0/1 alignment is accepted only when there are no B-slices and no non-zero composition reordering. Genuinely reordered streams fail explicitly. Video normalization intentionally removes B-frames; it is not a general-purpose transcoder.

## Honest limits

Phase A, Phase B, and the multi-clip chain edit H.264 NAL units without blending frames. Phase C decodes and re-encodes pixels only to normalize incompatible sequence members; it does not add crossfades or hold frames as a visual effect. Observable moshing is produced by the device decoder reacting to missing references.

The effect depends on the source GOP structure. Decode behavior is device-dependent: some sources may refuse to play after IDR removal, show black frames, or hold the last decodable frame, especially when seeking directly into a modified GOP. Different browsers and hardware decoders can show different results. This is expected behavior, not a bug.

Mobile hardware decoders are the most tolerant case: several of them repair or conceal a removed IDR by repeating the last reference picture, so a phone's `<video>` can play a mosh sequence cleanly while the same bytes show the effect on desktop. The bytes are not different — the decoder path is. `Software preview` slides along that path in the editor; the exported file is unchanged either way.

Phase A handles a single H.264 video track in a conventional (non-fragmented) MP4. Interleaved audio sample offsets are adjusted when present. On multi-GOP sources, removing later IDRs can make the decoder discard dependent pictures, so the decoded frame count can be lower than the MP4 sample/packet count; that is the intended mosh behavior, not a parse failure.

The release has these explicit limits:

- **Resolution:** normalization caps the long side at 720 px. This is lossy for larger sources, but it keeps browser encoding practical and does not remove the reference-loss effect.
- **Video transformation:** normalization and every transition are video-only. Export audio is a linear, sample-aligned companion track; it is never moshed, crossfaded, mixed across several tracks, or used to hide a visual discontinuity.
- **Decoding:** bitstream effects depend on the source GOP structure and the device decoder. Some clips may hold, black out, drop pictures, or show different corruption around missing references. Melt, Loop Release, and Reset Pulse require B-frame-free, non-reordered inputs and normalize native B-frame sources first.
- **POC constraints:** type 0/1 multi-GOP alignment is accepted only without B-slices and non-zero composition offsets. Genuinely reordered streams fail loudly instead of producing a short or broken file.
- **Device resources:** the 100 MB conversion input limit is soft. WebCodecs does not guarantee hardware acceleration or support for every profile and resolution. iOS Safari can still run out of memory during large wasm conversions; PWA storage and cached wasm assets may be evicted by the OS.
- **Platform verification:** desktop Chrome and headless browser flows are automated. Physical iPhone/iPad standalone launch, memory pressure, and thermal behavior still require the release checklist in `NEXT_SESSION.md`.

WebCodecs availability does not guarantee hardware acceleration, a particular profile, or support at every resolution; the browser chooses the implementation. If an H.264 or HEVC decoder/encoder configuration is unsupported, the app falls back to ffmpeg.wasm. Conventional HEVC MOV/MP4 files have a dedicated `hvcC` demux path; fragmented or otherwise unsupported containers still require conversion.

The 720-pixel long-side cap is intentional and lossy for larger sources. It substantially reduces encode time and memory, and does not reduce the visible mosh effect because bitstream reference loss is resolution-independent. WebCodecs encoders may inject recovery IDRs beyond a single requested keyframe at frame 0; B therefore recovers at its first encoder-provided IDR, which can shorten the affected first GOP.

The ffmpeg.wasm fallback depends on downloading the pinned core from jsDelivr. Parallel sequence conversion deliberately starts up to two WASM workers, so peak memory is higher than a single-worker run even though each target is capped. It may still exhaust memory or fail on iOS Safari with large inputs. The 100 MB limit is a soft product limit for both paths, not a guarantee that a file below it will fit available device memory. No conversion is attempted for encrypted media.

Direct merging supports compatible sequence members only. Resolution, profile, level, chroma, bit depth, PPS, and video timescale must match; differing SPS payloads require equivalent parsed core fields. Phase C can normalize native H.264 mismatches to a common target first. The sequence itself is capped at 12 clips. Merged audio is aligned to the video timeline but is not moshed: Classic Mosh, Loop Release, Reset Pulse, and explicit-window Melt drop one incoming frame; extra picture frames receive silence. Sources without an audio track contribute silence when another source supplies audio. Multi-GOP B is supported: the mosh targets B's first GOP, then the retained B IDRs act as clean recovery anchors, so later B GOPs should play normally after the intended boundary corruption. Type 0/1 POC alignment is limited to streams with no B-slices and no composition reordering; genuinely reordered multi-GOP streams fail explicitly instead of silently producing a short decode. Audio handling is limited to the first track, 48 kHz stereo, and AAC-LC export; very long sequences, memory pressure, or browser codec gaps can still block audio preparation. WebCodecs video normalization is video-only and intentionally removes B-frames; it is not a general-purpose transcoder. Audio is taken from the original files rather than the normalized video.

The default Tier-1 H.264 parser is not a general container parser. Conventional HEVC is handled through its dedicated `hvcC` path; fragmented MP4, encrypted media, and multiple video tracks remain unsupported and must be converted where applicable.

All effect durations are bounded by the frames available after the incoming clip's first GOP boundary. Melt/Loop duration counts the effect window, not the following chronological tail, so the total contribution can differ from the window length. Direct API calls that omit duration keep the legacy full-length schedules; the UI submits an explicit window. Reset Pulse requires its interval to fit inside that duration and uses a hard IDR reset at each interval; repeated P-samples are not a blend or a smoothness guarantee. Restore inserts the original boundary IDR at frame N+1; it does not blend frames or guarantee smooth motion through the recovery jump. Continue deliberately retains the prediction chain. Gentler Melt only bounds donor movement; it is not interpolation or a guarantee of perceptual smoothness, and large source cuts or accumulated prediction corruption can still jump. Melt, Loop Release and Reset Pulse are decode-order bitstream effects: they do not blend pixels beyond the repeated slices and can look different across device decoders.

Speed control is lossy in time: speeds above 1× discard source frames and below 1× repeat frames, so extreme settings lose temporal detail or motion smoothness. Fractional mapping is deterministic but not frame interpolation. Audio is time-stretched with ffmpeg.wasm `atempo` and keeps pitch; it is not audio moshing. Speed requires WebCodecs for the one-pass frame mapping/re-encode, and non-silent speed changes need the ffmpeg.wasm core. Looks also require the WebCodecs decode/canvas/encode path; ffmpeg.wasm conversion does not apply a selected look. The 100 MB input and device-memory limits still apply.

The PWA cache is not a persistence guarantee. First load needs network; a browser may evict Cache Storage, `file://` cannot register a service worker, and iOS may reclaim storage or terminate a large wasm conversion under memory pressure. The service worker deliberately does not cache source media or generated exports outside the page's in-memory Blob URLs.

## Attribution

The approach was studied from [supermosh](https://github.com/supermosh/supermosh.github.io), which is GPLv3. m4shlab is an independent implementation from the Phase A and Phase B specifications; no supermosh source code was copied or reused. The sibling h4moshlab project was treated as conceptual reference only.

## License

MIT. See [LICENSE](LICENSE).
