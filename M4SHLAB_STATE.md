# m4shlab state

Updated: 2026-11-03

## Current baseline

- Phase A: Classic single-clip IDR removal (`b9fa9b6`).
- Phase B: compatible H.264 A→B merge (`3a7540d`).
- Universal import: hardened MP4/MOV parsing plus lazy ffmpeg.wasm conversion (`bf64130`).
- Phase C: WebCodecs normalization with ffmpeg.wasm fallback (this block).

## Phase C implementation

- `webcodecs.js` decodes parsed H.264 samples with `VideoDecoder`, letterboxes frames to one shared even target, converts to BT.709 limited-range I420, and encodes H.264 at 30 fps with a 30-frame closed GOP and no B-frames.
- `webcodecs-muxer.js` writes a conventional faststart MP4 with `stts`, `stss`, `stsc`, `stsz`, and `stco`/`co64`.
- B's non-key slices are aligned to absolute `frame_num` positions before merge. This is required because separately encoded clips restart at zero and decoders otherwise discard most of B after its first IDR is removed.
- `app.js` prefers WebCodecs for incompatible native H.264 pairs and reports `normalized via WebCodecs`. If WebCodecs is unavailable or cannot handle the configuration, it runs the existing ffmpeg.wasm normalization and reports `normalized via ffmpeg.wasm`.
- HEVC, WebM, fragmented MP4, and other containers still use ffmpeg.wasm because the current native demuxer is H.264-only.

## Verification

- `npm test`: 25 checks passed.
- Phase A: 111,706 B → 100,238 B, 73 decoded frames.
- Phase B: 37,029 B + 36,812 B → 67,893 B, 49 decoded frames.
- `npm run test:webcodecs`:
  - normalized clips: 53,018 B and 52,775 B, exactly one leading IDR each;
  - the 75-frame fixture produced keyframes at samples 1, 31, and 61;
  - merged export: 49 frames, H.264 320×240, `yuv420p`/`tv`, `has_b_frames=0`, video-only;
  - merged SHA-256: `b4bb6c4827b2f7a8fe6d93777ff63f4491dd0b8eb497148dd3b2d07da1666bef`;
  - forced fallback: WebCodecs stubbed unavailable, ffmpeg.wasm path ran and was named in the report.

## Limits / next work

- WebCodecs does not guarantee hardware acceleration or support for every profile/resolution.
- WebCodecs normalization currently requires natively parseable H.264 because the demuxer does not expose HEVC samples.
- The 100 MB limit is a soft limit; available device memory can still be exceeded.
- Merged exports remain video-only. Audio, PWA, multi-clip timelines, and general-codec WebCodecs demuxing remain out of scope for this block.
