# m4shlab state

Updated: 2026-11-03

## Current baseline

- Phase A: Classic single-clip IDR removal (`b9fa9b6`).
- Phase B: compatible H.264 A→B merge (`3a7540d`).
- Universal import: hardened MP4/MOV parsing plus lazy ffmpeg.wasm conversion (`bf64130`).
- Phase C: WebCodecs normalization with ffmpeg.wasm fallback.
- Phase B multi-GOP repair: retain later B IDR anchors and align the first B GOP's `frame_num`.
- Automatic incompatible-pair normalization, capped pair targets, parallel workers, and ffmpeg.wasm decode plus WebCodecs encode.
- h4moshlab-style interface with a dark preview well, header import control, and horizontal A→B clip timeline. The visible compatibility panel, criterion table, badges, and SPS/PPS hashes are removed; validation remains in the background.

## Phase C implementation

- `conversion-settings.js` defines `MAX_TARGET_LONG_SIDE = 720`. Native and WASM normalization targets are proportional, even, and capped on the long side; the limit can be changed in one constant.
- `webcodecs.js` decodes parsed H.264 samples with `VideoDecoder`, scales or letterboxes frames to the shared capped target, converts to BT.709 limited-range I420, and encodes H.264 at 30 fps with a requested keyframe every 30 frames and no B-frames.
- `webcodecs-muxer.js` writes a conventional faststart MP4 with `stts`, `stss`, `stsc`, `stsz`, and `stco`/`co64`.
- B's first-GOP non-key slices are aligned to continue A's `frame_num`. This is required because separately encoded clips restart at zero and decoders otherwise discard early B frames after its first IDR is removed.
- Classic Phase B now removes only B's first IDR sample. Later B IDR samples stay as reference anchors, and the first B GOP's slice headers are patched modulo `2^log2_max_frame_num`. Emulation-prevention bytes are regenerated through RBSP unescape/re-escape.
- Safari WebCodecs output with `pic_order_cnt_type=0` is accepted for multi-GOP merge when B has no B-slices and `ctts` has no non-zero composition offsets. Both `frame_num` and type-0 `pic_order_cnt_lsb` are aligned; genuinely reordered streams remain rejected.
- `app.js` shows the normalizing state immediately when a native pair fails compatibility. It normalizes both clips, re-checks the converted bytes, and surfaces only short blocking errors. No compatibility table or badges are rendered; the internal report records `autoNormalized`, `parallel`, the shared target, decode path, encode path, and fallback details.
- The timeline renders two clip cards with thumbnails, names, durations, format status, order-arrow affordances, remove affordances, and a dashed Classic Mosh connector. Phase B remains fixed at A→B, so reorder/remove controls stay disabled in this design-only block. The layout is responsive below 600px and uses 44px touch controls on coarse pointers.
- Native H.264 pairs normalize in parallel with two WebCodecs jobs. Codec/container failures fall back to two concurrent ffmpeg.wasm workers when possible.
- `converter-worker.js` can emit a capped `yuv420p` Y4M stream. `hybrid-encoder.js` then encodes those frames with WebCodecs and muxes with the existing MP4 writer; the full WASM encoder remains the fallback.
- HEVC, WebM, fragmented MP4, and other containers still use ffmpeg.wasm because the current native demuxer is H.264-only.

## Verification

- `npm test`: 30 checks passed.
- Phase A: 111,706 B → 100,238 B, 73 decoded frames.
- Phase B: 37,029 B + 36,812 B → 67,893 B, 49 decoded frames.
- Multi-GOP B: 25 A + 75 B samples → 99 samples and 99 decoded frames; two later B IDRs remain, 24 slice headers are aligned, and three keyframes decode.
- `npm run test:webcodecs`:
  - normalized clips: 53,018 B and 52,775 B, exactly one leading IDR sample each;
  - the 75-frame fixture produced keyframes at samples 1, 31, and 61; its merge retained two later IDRs and decoded all 149 frames;
  - a Safari-style POC type 0 multi-GOP pair merged with POC-LSB alignment and decoded 99/99 frames; the browser test also cleared a deliberately stale error;
  - POC type 0 with true B-frame reordering was rejected with an explicit picture-reordering message;
  - the mobile layout stacked under 600px while import and clip controls retained 44px touch targets;
  - blocking merge errors stayed short and rendered no compatibility panel;
  - a 1440×1920 + 768×1024 native pair showed `normalizing clips…`, normalized both clips to 540×720 with WebCodecs, re-checked compatibility, and merged 49 samples;
  - the browser DOM contained no compatibility panel, status badge, criterion table, or SPS/PPS hash display;
  - merged export: 49 frames, H.264 320×240, `yuv420p`/`tv`, `has_b_frames=0`, video-only;
  - merged SHA-256: `b4bb6c4827b2f7a8fe6d93777ff63f4491dd0b8eb497148dd3b2d07da1666bef`;
  - ffmpeg.wasm decode plus WebCodecs encode completed both progress bars and produced a decodable export;
  - forced fallback: WebCodecs stubbed unavailable, ffmpeg.wasm path ran and was named in the report.

## Real-clip measurements

- `IMG_1993.MOV` + `IMG_3339.MOV`: HEVC sources normalized to H.264 at 540×720 through ffmpeg.wasm decode plus WebCodecs encode.
- Pair conversion took 5.7 s and 5.8 s, versus 5.3 s / 9.1 s for capped full-WASM and 19.8 s / 33.6 s for earlier full-resolution WASM runs.
- 112 + 177 source samples merged to 288 samples; strict decode returned 288/288 frames.
- Later B IDRs were retained, the first B GOP received 32 slice patches across 16 samples, and strict decode exited 0.
- Export SHA-256: `cc72b2c54e63045159bc5ada461469217e527aa7cf152ba7a7347bd8ec89ff5d`.

## Limits / next work

- WebCodecs does not guarantee hardware acceleration or support for every profile/resolution.
- WebCodecs normalization currently requires natively parseable H.264 because the demuxer does not expose HEVC samples.
- The 720-pixel cap is lossy for larger sources and may place the first B recovery IDR earlier than requested because some encoders insert extra keyframes.
- Two parallel WASM workers reduce wall time but increase peak memory; very large inputs may still fail on iPhone or other memory-constrained devices.
- Multi-GOP alignment supports type 2 and non-reordered type 0/1 streams. Type 0/1 requires no B-slices and no non-zero composition offsets; reordered B fails explicitly rather than silently losing frames.
- The reported iPhone `IMG_4767.mov` / `final_0.mov` pair was not present locally; automated coverage uses a generated Safari-shaped POC type 0 fixture, so a physical-device retest is still required.
- The 100 MB limit is a soft limit; available device memory can still be exceeded.
- Merged exports remain video-only. Audio, PWA, multi-clip timelines, and general-codec WebCodecs demuxing remain out of scope for this block.
