# m4shlab

H.264 bitstream moshing in the browser — fully client-side, no server, no upload.

Phase A MVP: one H.264 clip, IDR removal produces visible moshing in the preview, export decodes.

Phase B MVP: two compatible H.264 clips, Classic A→B merge in the browser, export decodes as video.

Universal import: conventional H.264 MP4/MOV parses natively; other formats are converted locally with lazily loaded ffmpeg.wasm.

Phase C normalization: incompatible native H.264 pairs are decoded and re-encoded locally with WebCodecs when the browser supports H.264 encode/decode. ffmpeg.wasm remains the fallback.

Automatic pair normalization now starts as soon as native compatibility fails. Both clips are converted to one shared target capped at 720 pixels on the long side, using WebCodecs or ffmpeg.wasm, then compatibility is checked again on the converted bytes. Conversions can run in parallel, and HEVC-style ffmpeg.wasm decodes use WebCodecs for H.264 encoding when available.

## Run it

```sh
npm start
```

Open `http://127.0.0.1:4173`, choose **Clip A (base)** and **Clip B (incoming)** from the header import control, then switch between **A cut** and **merged A→B**. Validation and normalization happen in the background; only a blocking error is surfaced. Play from the start for the clearest result. Export downloads `m4shlab-merge.mp4`.

The Phase A single-clip transfer remains available through `mosh.js` and its unchanged test chain.

The app has no package dependencies and no build step. `npm start` only serves the local static files; video never leaves the browser. WebCodecs normalization stays in browser memory. When the fallback is needed, the pinned ffmpeg.wasm core is fetched from jsDelivr on demand; only the local wasm worker receives the file bytes.

## Supported formats

| Tier | Inputs | Behavior |
| --- | --- | --- |
| 1 — native parse | Conventional non-fragmented MP4/MOV with an H.264 `avc1`/`avc3` video track, including top-level size-zero `mdat`, 64-bit box sizes, and QuickTime `wide` placeholders | Parsed directly; compatible pairs merge without re-encoding. Audio remains available to the Phase A single-clip flow and is omitted by Phase B merge |
| 2a — WebCodecs normalization | Native H.264 pairs whose SPS/timing details are incompatible, when `VideoDecoder` and `VideoEncoder` can handle the required H.264 profile and size | Decoded and re-encoded locally to a shared H.264 target, then processed by the unchanged Phase B compatibility check and merge |
| 2b — ffmpeg.wasm fallback | HEVC (`hvc1`/`hev1`), VP9 WebM (verified), fragmented MP4, other supported containers/codecs, and browsers or H.264 configurations without a usable WebCodecs path | Decoded locally by ffmpeg.wasm. The H.264 encode runs in WebCodecs when available, otherwise fully in the pinned WASM worker |
| Not supported | DRM/encrypted media, unavailable ffmpeg.wasm assets, conversion input over 100 MB, or conversions that exceed browser wasm memory | Actionable error; no broken merge is emitted |

Normalization produces conventional faststart MP4 with H.264 baseline or main profile, `yuv420p` limited range, 30 fps, a requested keyframe every 30 frames, no B-frames, and no audio. Encoders may insert additional recovery IDRs. The common target is capped at **720 pixels on the long side**. Same-aspect inputs are purely scaled; different aspects are scaled proportionally and letterboxed into the shared box. The mosh effect is resolution-independent, and this cap is much faster than full-resolution software encoding, mirroring h4moshlab's deliberate 640×480 normalization.

Native Tier-1 clips may contain B-frames; their `ctts` composition offsets are preserved during merge. Converted clips deliberately have no B-frames.

## Interface

The page follows the h4moshlab visual language: a light radial-gradient background, centered 1000px layout, compact bordered controls, a large dark preview well, and a horizontal A→B clip timeline. Clip cards show a thumbnail, filename, duration, format status, order-arrow affordances, and a remove affordance; Phase B keeps the pair fixed at A→B, so these controls are intentionally disabled in this design-only block. The dashed connector names the Classic Mosh transition and shows the incoming clip duration. Compatibility criteria, badges, and SPS/PPS hashes are not rendered. Under 600px the header and preview actions stack and touch controls meet the 44px target.

## What it does

### Universal import

1. Tier 1 walks conventional MP4/MOV boxes and H.264 sample tables. Fragmented MP4 and unsupported codecs produce explicit errors.
2. A native H.264 pair that fails compatibility enters a visible **normalizing clips…** state instead of showing a final incompatibility verdict. Both clips are normalized in parallel to the shared capped target.
3. Native H.264 normalization reuses parsed samples and `avcC`, decodes with `VideoDecoder`, scales/letterboxes through a canvas, converts to limited-range I420, and encodes with `VideoEncoder`.
4. HEVC, WebM, fragmented MP4, and unsupported H.264 configurations use ffmpeg.wasm for decode. If WebCodecs H.264 encoding is available, ffmpeg.wasm emits a capped Y4M stream and WebCodecs performs the encode; otherwise the complete encode stays in the WASM worker.
5. The UI and JSON report name decode path, encode path, target, parallel execution, fallback reason, and duration. Compatibility is checked again on the converted bytes before preview and merge, without rendering a criteria table.

### Phase C: WebCodecs normalization

1. Feature-detect `VideoDecoder`, `VideoEncoder`, and `VideoFrame`; select an H.264 encoder configuration supported by the current browser.
2. Decode the source in sample order, draw each frame into one common even-sized canvas capped at 720 pixels on the long side, and preserve or letterbox aspect ratio as needed.
3. Convert the canvas to explicit BT.709 limited-range I420 and encode H.264 with a keyframe every 30 frames, starting at frame 0. The output is video-only.
4. Mux encoded chunks into `ftyp`/`moov`/`mdat` faststart MP4 with `stts`, `stss`, `stsc`, `stsz`, and `stco`/`co64`.
5. Align B's first-GOP non-key H.264 `frame_num` values so they continue after A. Without this, a decoder can discard early B frames after the removed IDR because separately encoded clips both start at frame number zero. Later B GOPs keep their local numbering and recover at their retained IDRs.
6. Validate that the normalized output parses, starts with an IDR frame, and contains no IDR in a delta chunk before running the unchanged Phase B merge.

### Hybrid and parallel conversion

1. Pair conversion uses two ffmpeg.wasm workers when native-incompatible clips are converted through WASM. The UI exposes separate A and B progress bars.
2. ffmpeg.wasm decode writes capped `yuv420p` Y4M frames locally. WebCodecs encodes those frames as H.264 and the existing MP4 muxer assembles the result, avoiding full-resolution software x264 work.
3. If WebCodecs encoding is unavailable or fails, the same file is retried entirely in the ffmpeg.wasm encoder. The report records `encodeEngine: "WebCodecs"` or `"ffmpeg.wasm"` and any hybrid fallback reason.

### Phase A: single-clip Classic Mosh

1. Walks the MP4 boxes and resolves the video track's sample table (`stsz`/`stz2`, `stsc`, `stco`/`co64`).
2. Reads length-prefixed H.264 NAL units using the length size declared by `avcC`.
3. Preserves the first GOP. From the second IDR onward, removes each IDR NAL unit and nothing else.
4. Rewrites only the affected sample sizes, chunk offsets, mdat size, and the removed NAL bytes. All retained NAL payloads remain byte-identical and in order.
5. Plays the modified MP4 as a Blob through the browser's native decoder and exports the same bytes as a download.

`Cut` is retained by the transform as a byte-for-byte copy of the source.

### Phase B: compatible A→B Classic Merge

1. Parses SPS and PPS from each `avcC` and compares the payload bytes. It also parses profile, constraints, level, chroma format, bit depth, and coded resolution from SPS.
2. Requires matching resolution, profile, level, chroma, bit depth, NAL length size, PPS, and video `mdhd` timescale. A differing SPS is accepted only when those core fields match; the report marks it as a warning and the merge uses A's parameters.
3. Keeps A's sample description, samples, and timing as the base. It skips B's initial IDR sample and removes SPS/PPS/SEI units from later samples, but preserves B's later IDR samples as reference anchors.
4. For a multi-GOP B whose first frame after the removed IDR cannot continue A's `frame_num`, it parses the first B-GOP slice headers and patches `frame_num` modulo `2^log2_max_frame_num`. Type 2 POC streams are always eligible. Type 0/1 streams are accepted only when B has no B-slices and its `ctts` has no non-zero composition offsets; for type 0, `pic_order_cnt_lsb` is aligned as well.
5. The patcher unescapes emulation-prevention bytes to RBSP, changes the fixed-width `frame_num` and optional POC bits, then regenerates the EBSP. It therefore remains safe if the original or patched bits span positions where an emulation-prevention byte was present.
6. Appends B's remaining crop of samples and rebuilds the video sample tables, composition offsets, chunk offsets, and container durations. Later B IDRs reset `frame_num` normally and need no patch.
7. Reports every compatibility criterion, the removed B units, output duration, sample counts, retained B IDRs, the frame-number patch, and the leading IDR frame. Incompatible pairs are blocked loudly instead of producing a broken file.

The **A cut** preview is the untouched input A. The merged export is video-only in Phase B.

## Verification

The committed test chain includes `testmedia/generate.sh`; generated media is ignored and never committed.

```sh
npm test
npm run test:webcodecs
```

`npm test` requires Node and `ffmpeg`/`ffprobe`. If fixtures are missing, it runs `testmedia/generate.sh`, which creates local, ignored test media:

- a 3-second 320×240 Phase A clip with IDRs at samples 0, 25, and 50;
- matching 1-second 320×240 A/B clips with identical High-profile settings and timescale;
- a 256×240 resolution mismatch;
- a 320×240 clip with a different `mdhd` timescale;
- a matching 25-frame A plus 75-frame multi-GOP B with B IDRs at samples 0, 25, and 50;
- Safari-style POC type 0 multi-GOP clips with IDRs at samples 0, 25, and 50 and no B-frames;
- native H.264 clips at 1440×1920 and 768×1024 for the capped auto-normalization path;
- a QuickTime H.264 MOV with a `wide` placeholder;
- HEVC MOV fixtures, including a different-resolution pair;
- a fragmented MP4.

The tests assert:

- the known Phase A NAL/GOP layout and exact single-clip IDR removal;
- retained Phase A NAL bytes and SPS/PPS preservation;
- Phase B compatibility acceptance and actionable rejection messages;
- the merged NAL sequence is A plus B after its first IDR;
- every retained merge NAL is byte-identical to its source;
- `stsz` sum equals mdat content, sample offsets are monotonic, and timing/durations agree;
- the merged stream starts with an IDR frame and retains B's later IDR anchors;
- a multi-GOP B keeps its later IDR anchors, aligns the first B GOP with a safe RBSP/EBSP frame-number patch, and decodes as many frames as its sample table declares;
- a POC type 0, no-B-frame multi-GOP pair merges with frame-number and POC-LSB alignment and decodes all 99 frames;
- POC type 0 with true B-frame reordering remains rejected with an explicit message;
- Cut is byte-identical to A;
- both exports decode with `ffprobe`;
- the truncated Phase A file is rejected;
- QuickTime MOV, top-level size-zero `mdat`, `wide`, and 64-bit box headings parse correctly;
- HEVC and fragmented MP4 return their documented actionable errors.
- the WebCodecs muxer's `stsz`/`mdat` sizes, sample offsets, `stss`, and `stts` duration agree;
- normalization chooses one identical even target from differently sized pair members.
- the 1440×1920 + 768×1024 native pair auto-normalizes to 540×720, exposes `normalizing clips…`, re-checks compatibility, and merges;
- ffmpeg.wasm decode + WebCodecs encode and the full-WASM fallback both name the encoder that ran.
- the browser has no compatibility panel, status badge, table, or SPS/PPS hash display;
- blocking merge errors render as a short alert rather than a compatibility panel.

Current local results (2026-11-03, Node 26.13.0, FFmpeg 9.0.2, Google Chrome 156): all 30 Node checks pass. Phase A removes 11,468 bytes and decodes 73 frames. Phase B merges 25 A samples plus 24 retained B samples, decodes 49 frames, and produces the same 67,893-byte export. The multi-GOP regression merges 25 A + 75 B samples, retains two later B IDRs, patches 24 first-GOP slice headers, and decodes all 99 expected frames with three keyframes. A Safari-shaped POC type 0 pair also merges with POC-LSB alignment and decodes 99/99 frames; a genuinely reordered type 0 multi-GOP stream remains rejected. The WebCodecs muxer test emits 8 samples with a 14,984-byte mdat payload and 4,096 duration units. Tier-1 fixtures additionally verify a QuickTime H.264 MOV (25 samples / 26 NALs), a size-zero mdat, standalone `wide`, a 64-bit mdat, the exact HEVC error, and the exact fragmented-MP4 error.

The real `IMG_1993.MOV` + `IMG_3339.MOV` verification converted both HEVC originals with ffmpeg.wasm decode plus WebCodecs encode to 540×720. Conversion took 5.7 s and 5.8 s versus 19.8 s and 33.6 s for the earlier full-resolution WASM run. The 112 + 177 source samples merged to 288/288 decoded frames. All later B IDRs were retained, the first B GOP required 32 slice patches across 16 samples, and strict decode exited 0.

`npm run test:webcodecs` uses Chrome's DevTools Protocol directly and has no Node package dependency. It exits with a clear skip if Chrome or a usable H.264 WebCodecs encoder is unavailable. The committed run produced:

```text
PASS WebCodecs decoded and normalized both clips with one leading IDR each; 53018 B / 52775 B
PASS WebCodecs emitted keyframes at samples 1, 31, and 61; the multi-GOP merge retained two later IDRs and decoded all 149 frames
PASS Safari-style POC type 0 multi-GOP pair merges in the browser and clears stale errors
PASS mobile layout stacks under 600px and keeps 44px touch targets on the scrolling timeline
PASS blocking merge errors stay short and do not render a compatibility panel
PASS large native mismatch auto-normalized to 540x720; UI showed the normalizing state and merge produced 49 samples
PASS WebCodecs pair merged in the browser: 49 samples, one leading IDR, preview 320x240
PASS merged export decodes: 49 frames, H.264 320x240 yuv420p/tv, SHA-256 b4bb6c4827b2f7a8fe6d93777ff63f4491dd0b8eb497148dd3b2d07da1666bef
PASS ffmpeg.wasm decode + WebCodecs encode: 320x240, both progress bars completed, export decoded
PASS WebCodecs stubbed unavailable: ffmpeg.wasm fallback ran and the report identifies it
```

The same test asserts the normalized A/B streams parse via `parser/nal.js` with exactly one leading IDR each, the B frame-number alignment patches 24 delta samples, the merged `stsz` sum equals mdat content, all 49 frames decode, there is no audio, and `has_b_frames=0`. With `VideoDecoder`/`VideoEncoder` stubbed unavailable, the report switches to `normalized via ffmpeg.wasm`.

`npm run test:conversion` remains the optional Playwright test for the HEVC ffmpeg.wasm path. It exits with a clear skip when Playwright or the CDN is unavailable.

Verification includes synthetic fixtures, two real iPhone MOVs, and headless Chrome. A physical iPhone acceptance run is still separate: Safari/WebCodecs behavior, thermal throttling, and device memory cannot be inferred from desktop Chrome.

The reported `IMG_4767.mov` and `final_0.mov` were not available in this workspace, so the Safari encoder shape is covered by a generated POC type 0 fixture. The actual pair still needs a final iPhone retest.

## Honest limits

Phase A and Phase B edit H.264 NAL units without blending frames. Phase C decodes and re-encodes pixels only to normalize an incompatible pair; it does not add crossfades or hold frames as a visual effect. Observable moshing is produced by the device decoder reacting to missing references.

The effect depends on the source GOP structure. Decode behavior is device-dependent: some sources may refuse to play after IDR removal, show black frames, or hold the last decodable frame, especially when seeking directly into a modified GOP. Different browsers and hardware decoders can show different results. This is expected behavior, not a bug.

Phase A handles a single H.264 video track in a conventional (non-fragmented) MP4. Interleaved audio sample offsets are adjusted when present. On multi-GOP sources, removing later IDRs can make the decoder discard dependent pictures, so the decoded frame count can be lower than the MP4 sample/packet count; that is the intended mosh behavior, not a parse failure.

WebCodecs availability does not guarantee hardware acceleration, a particular profile, or support at every resolution; the browser chooses the implementation. If its H.264 decoder/encoder configuration, I420 frame construction, or frame-number alignment is unsupported, the app falls back to ffmpeg.wasm. Current normalizing support is limited to natively parsed H.264 sources because the demuxer is H.264-only; HEVC and other codecs go directly to ffmpeg.wasm.

The 720-pixel long-side cap is intentional and lossy for larger sources. It substantially reduces encode time and memory, and does not reduce the visible mosh effect because bitstream reference loss is resolution-independent. WebCodecs encoders may inject extra IDRs beyond the requested 30-frame cadence; B therefore recovers at its first encoder-provided IDR, which can shorten the affected first GOP.

The ffmpeg.wasm fallback depends on downloading the pinned core from jsDelivr. Parallel pair conversion deliberately starts up to two WASM workers, so peak memory is higher than a single-worker run even though each target is capped. It may still exhaust memory or fail on iOS Safari with large inputs. The 100 MB limit is a soft product limit for both paths, not a guarantee that a file below it will fit available device memory. No conversion is attempted for encrypted media.

Phase B's direct merge supports compatible pairs only. Resolution, profile, level, chroma, bit depth, PPS, and video timescale must match; differing SPS payloads require equivalent parsed core fields. Phase C can normalize native H.264 mismatches to a common target first. The merged A→B export still has no audio; audio is not part of this phase. Normalized clips also drop audio before moshing. Multi-GOP B is supported: the mosh targets B's first GOP, then the retained B IDRs act as clean recovery anchors, so later B GOPs should play normally after the intended boundary corruption. Type 0/1 POC alignment is limited to streams with no B-slices and no composition reordering; genuinely reordered multi-GOP streams fail explicitly instead of silently producing a short decode. WebCodecs normalization is video-only and intentionally removes B-frames; it is not a general-purpose transcoder.

Native parsing is not HEVC, fragmented-MP4, encrypted-media, or multi-video-track capable; those unsupported local files must go through Tier 2 conversion where applicable.

## Attribution

The approach was studied from [supermosh](https://github.com/supermosh/supermosh.github.io), which is GPLv3. m4shlab is an independent implementation from the Phase A and Phase B specifications; no supermosh source code was copied or reused. The sibling h4moshlab project was treated as conceptual reference only.

## License

MIT. See [LICENSE](LICENSE).
