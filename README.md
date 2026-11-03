# m4shlab

H.264 bitstream moshing in the browser — fully client-side, no server, no upload.

Phase A MVP: one H.264 clip, IDR removal produces visible moshing in the preview, export decodes.

Phase B MVP: two compatible H.264 clips, Classic A→B merge in the browser, export decodes as video.

Universal import: conventional H.264 MP4/MOV parses natively; other formats are converted locally with lazily loaded ffmpeg.wasm.

Phase C normalization: incompatible native H.264 pairs are decoded and re-encoded locally with WebCodecs when the browser supports H.264 encode/decode. ffmpeg.wasm remains the fallback.

## Run it

```sh
npm start
```

Open `http://127.0.0.1:4173`, choose **Clip A (base)** and **Clip B (incoming)**, review the compatibility panel, then switch between **A cut** and **merged A→B**. Play from the start for the clearest result. Export downloads `m4shlab-merge.mp4`.

The Phase A single-clip transfer remains available through `mosh.js` and its unchanged test chain.

The app has no package dependencies and no build step. `npm start` only serves the local static files; video never leaves the browser. WebCodecs normalization stays in browser memory. When the fallback is needed, the pinned ffmpeg.wasm core is fetched from jsDelivr on demand; only the local wasm worker receives the file bytes.

## Supported formats

| Tier | Inputs | Behavior |
| --- | --- | --- |
| 1 — native parse | Conventional non-fragmented MP4/MOV with an H.264 `avc1`/`avc3` video track, including top-level size-zero `mdat`, 64-bit box sizes, and QuickTime `wide` placeholders | Parsed directly; compatible pairs merge without re-encoding. Audio remains available to the Phase A single-clip flow and is omitted by Phase B merge |
| 2a — WebCodecs normalization | Native H.264 pairs whose SPS/timing details are incompatible, when `VideoDecoder` and `VideoEncoder` can handle the required H.264 profile and size | Decoded and re-encoded locally to a shared H.264 target, then processed by the unchanged Phase B compatibility check and merge |
| 2b — ffmpeg.wasm fallback | HEVC (`hvc1`/`hev1`), VP9 WebM (verified), fragmented MP4, other supported containers/codecs, and browsers or H.264 configurations without a usable WebCodecs path | Converted locally by the pinned ffmpeg.wasm worker to the same Tier-1 target before Phase A/B processing |
| Not supported | DRM/encrypted media, unavailable ffmpeg.wasm assets, conversion input over 100 MB, or conversions that exceed browser wasm memory | Actionable error; no broken merge is emitted |

Normalization produces conventional faststart MP4 with H.264 baseline or main profile, `yuv420p` limited range, 30 fps, a 30-frame closed GOP with an IDR at frame 0, no B-frames, and no audio. Both clips in a pair use the same dimensions and encoder settings. Different dimensions are scaled proportionally and letterboxed to the larger width/height so SPS, PPS, frame rate, and timescale match.

Native Tier-1 clips may contain B-frames; their `ctts` composition offsets are preserved during merge. Converted clips deliberately have no B-frames.

## What it does

### Universal import

1. Tier 1 walks conventional MP4/MOV boxes and H.264 sample tables. Fragmented MP4 and unsupported codecs produce explicit errors.
2. For a native H.264 pair that fails compatibility, Phase C reuses the parsed samples and `avcC`, decodes with `VideoDecoder`, letterboxes through a canvas, converts to limited-range I420, and encodes with `VideoEncoder`. A minimal MP4 muxer writes the encoded chunks.
3. WebCodecs is preferred only for native H.264 input because that is the project's current demuxer and decoder description. HEVC, WebM, fragmented MP4, and unsupported H.264 configurations continue through the existing lazily loaded ffmpeg.wasm worker.
4. The UI and JSON report name the path that actually ran, `normalized via WebCodecs` or `normalized via ffmpeg.wasm`, and include conversion duration. The normalized bytes then follow the normal Phase B compatibility, preview, and merge path unchanged.

### Phase C: WebCodecs normalization

1. Feature-detect `VideoDecoder`, `VideoEncoder`, and `VideoFrame`; select an H.264 encoder configuration supported by the current browser.
2. Decode the source in sample order, draw each frame into one common even-sized canvas, and letterbox without changing aspect ratio.
3. Convert the canvas to explicit BT.709 limited-range I420 and encode H.264 with a keyframe every 30 frames, starting at frame 0. The output is video-only.
4. Mux encoded chunks into `ftyp`/`moov`/`mdat` faststart MP4 with `stts`, `stss`, `stsc`, `stsz`, and `stco`/`co64`.
5. Align B's non-key H.264 `frame_num` values to its absolute merged timestamp position. Without this, a decoder can discard most of B after the removed IDR because separately encoded clips both start at frame number zero.
6. Validate that the normalized output parses, starts with one IDR, and contains no IDR in a delta chunk before running the unchanged Phase B merge.

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
3. Keeps A's sample description, samples, and timing as the base. It skips B's initial IDR sample and removes B's SPS, PPS, SEI, and later IDR units.
4. Appends B's remaining slice data byte-for-byte and rebuilds the video sample tables, composition offsets, chunk offsets, and container durations.
5. Reports every compatibility criterion, the removed B units, output duration, sample counts, and the single leading IDR. Incompatible pairs are blocked loudly instead of producing a broken file.

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
- the merged stream starts with one IDR and retains no B IDR;
- Cut is byte-identical to A;
- both exports decode with `ffprobe`;
- the truncated Phase A file is rejected;
- QuickTime MOV, top-level size-zero `mdat`, `wide`, and 64-bit box headings parse correctly;
- HEVC and fragmented MP4 return their documented actionable errors.
- the WebCodecs muxer's `stsz`/`mdat` sizes, sample offsets, `stss`, and `stts` duration agree;
- normalization chooses one identical even target from differently sized pair members.

Current local results (2026-11-03, Node 26.13.0, FFmpeg 9.0.2, Google Chrome 156): all 25 Node checks pass. Phase A removes 11,468 bytes and decodes 73 frames. Phase B merges 25 A samples plus 24 retained B samples, decodes 49 frames, and produces the same 67,893-byte export. The WebCodecs muxer test emits 8 samples with a 14,984-byte mdat payload and 4,096 duration units. Tier-1 fixtures additionally verify a QuickTime H.264 MOV (25 samples / 26 NALs), a size-zero mdat, standalone `wide`, a 64-bit mdat, the exact HEVC error, and the exact fragmented-MP4 error.

The browser conversion run loaded two HEVC MOVs (320×240 and 256×240), normalized both to H.264 High profile at 320×240 / 30 fps / 15,360 timescale, merged 59 samples into a 1.97-second video-only file, and downloaded a 65,228-byte MP4. A VP9 WebM also converted and merged successfully with an HEVC MOV. Chrome played the merged Blob without a media error. Probe results: H.264, 320×240, 30/1 fps, `has_b_frames=0`, 47 decodable frames after the intended IDR removal; strict FFmpeg decode exited 0. The report marked both sources as Tier 2 `converted via ffmpeg.wasm`.

`npm run test:webcodecs` uses Chrome's DevTools Protocol directly and has no Node package dependency. It exits with a clear skip if Chrome or a usable H.264 WebCodecs encoder is unavailable. The committed run produced:

```text
PASS WebCodecs decoded and normalized both clips with one leading IDR each; 53018 B / 52775 B
PASS WebCodecs emitted keyframes at samples 1, 31, and 61 for a 75-frame clip (30-frame closed GOP)
PASS WebCodecs pair merged in the browser: 49 samples, one leading IDR, preview 320x240
PASS merged export decodes: 49 frames, H.264 320x240 yuv420p/tv, SHA-256 b4bb6c4827b2f7a8fe6d93777ff63f4491dd0b8eb497148dd3b2d07da1666bef
PASS WebCodecs stubbed unavailable: ffmpeg.wasm fallback ran and the report identifies it
```

The same test asserts the normalized A/B streams parse via `parser/nal.js` with exactly one leading IDR each, the B frame-number alignment patches 24 delta samples, the merged `stsz` sum equals mdat content, all 49 frames decode, there is no audio, and `has_b_frames=0`. With `VideoDecoder`/`VideoEncoder` stubbed unavailable, the report switches to `normalized via ffmpeg.wasm`.

`npm run test:conversion` remains the optional Playwright test for the HEVC ffmpeg.wasm path. It exits with a clear skip when Playwright or the CDN is unavailable.

This is **synthetic and headless-browser verification**, not a real phone-pair/device acceptance check. No physical phone media or physical device was supplied or used.

## Honest limits

Phase A and Phase B edit H.264 NAL units without blending frames. Phase C decodes and re-encodes pixels only to normalize an incompatible pair; it does not add crossfades or hold frames as a visual effect. Observable moshing is produced by the device decoder reacting to missing references.

The effect depends on the source GOP structure. Decode behavior is device-dependent: some sources may refuse to play after IDR removal, show black frames, or hold the last decodable frame, especially when seeking directly into a modified GOP. Different browsers and hardware decoders can show different results. This is expected behavior, not a bug.

Phase A handles a single H.264 video track in a conventional (non-fragmented) MP4. Interleaved audio sample offsets are adjusted when present.

WebCodecs availability does not guarantee hardware acceleration, a particular profile, or support at every resolution; the browser chooses the implementation. If its H.264 decoder/encoder configuration, I420 frame construction, or frame-number alignment is unsupported, the app falls back to ffmpeg.wasm. Current normalizing support is limited to natively parsed H.264 sources because the demuxer is H.264-only; HEVC and other codecs go directly to ffmpeg.wasm.

The ffmpeg.wasm fallback depends on downloading the pinned core from jsDelivr. It is slow on large files, may exhaust wasm memory, and can still fail on iOS Safari with very large inputs. The 100 MB limit is a soft product limit for both paths, not a guarantee that a file below it will fit available device memory. No conversion is attempted for encrypted media.

Phase B's direct merge supports compatible pairs only. Resolution, profile, level, chroma, bit depth, PPS, and video timescale must match; differing SPS payloads require equivalent parsed core fields. Phase C can normalize native H.264 mismatches to a common target first. The merged A→B export still has no audio; audio is not part of this phase. Normalized clips also drop audio before moshing. If B contains repeated GOPs, their later IDR/parameter/SEI units are removed and any sample left empty is skipped, so B's emitted sample count can be lower than the simple one-IDR fixture case. WebCodecs normalization is also video-only and intentionally removes B-frames; it is not a general-purpose transcoder.

Native parsing is not HEVC, fragmented-MP4, encrypted-media, or multi-video-track capable; those unsupported local files must go through Tier 2 conversion where applicable.

## Attribution

The approach was studied from [supermosh](https://github.com/supermosh/supermosh.github.io), which is GPLv3. m4shlab is an independent implementation from the Phase A and Phase B specifications; no supermosh source code was copied or reused. The sibling h4moshlab project was treated as conceptual reference only.

## License

MIT. See [LICENSE](LICENSE).
