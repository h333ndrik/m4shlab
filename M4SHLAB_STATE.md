# m4shlab state

Updated: 2026-11-03

## Current baseline

- Phase A: Classic single-clip IDR removal (`b9fa9b6`).
- Phase B: compatible H.264 A→B merge (`3a7540d`).
- Universal import: hardened MP4/MOV parsing plus lazy ffmpeg.wasm conversion (`bf64130`).
- Phase C: WebCodecs normalization with ffmpeg.wasm fallback.
- Phase B multi-GOP repair: retain later B IDR anchors and align the first B GOP's `frame_num`.
- Automatic incompatible-sequence normalization, shared capped targets, parallel workers, and ffmpeg.wasm decode plus WebCodecs encode.
- Multi-clip timeline: up to 12 clips, per-boundary Cut/Classic Mosh methods, reorder/remove with undo/redo, chained preview and export (`f085228` plus this block).
- h4moshlab-style interface with a dark preview well, header import control, horizontal timeline, and no visible compatibility panel.

## Multi-clip implementation

- `merge.js` keeps the existing pair APIs and adds `appendCutH264` plus `mergeSequenceH264`. The sequence processor runs left to right, so each incoming mosh boundary is aligned against the already merged running stream rather than the original clip 1.
- Every Cut boundary appends all incoming samples. Every Classic Mosh boundary skips only the incoming first IDR sample and retained SPS/PPS/SEI units in that sample; later IDRs remain reference anchors.
- First-GOP slices receive RBSP-safe `frame_num` and type-0 POC-LSB patches. Each boundary rebuilds `stsz`, `stsc`, `stco`/`co64`, `stts`, `ctts`, track durations, and movie duration.
- The sequence report records clip count, methods, source/merged samples, expected decoded frames, boundary alignment details, normalization paths, and audio omission.
- `app.js` imports multiple files or dropped files, caps the timeline at 12, and normalizes every clip to one shared target when any boundary differs. Native H.264 uses WebCodecs first; tier-2 or WebCodecs-failing inputs use ffmpeg.wasm with the hybrid WebCodecs encoder when available.
- Clip cards have active reorder/remove controls. Undo/redo snapshots cover import, reorder, removal, and transition changes without revoking media needed by an older snapshot.
- Each dashed connector opens a dialog with exactly Cut and Classic Mosh. Transition methods follow the incoming clip when cards are reordered.
- The preview shows clip 1 untouched or the full merged chain. Export downloads the complete sequence as video-only `m4shlab-merge.mp4`.

## Verification

- `npm test`: 35 checks passed.
- Phase A: 111,706 B → 100,238 B, 73 decoded frames.
- Phase B: 37,029 B + 36,812 B → 67,893 B, 49 decoded frames.
- Multi-GOP B: 25 A + 75 B samples → 99 samples and 99 decoded frames; two later B IDRs remain, 24 slice headers are aligned, and three keyframes decode.
- Three-clip Classic Mosh: 25 + 75 + 32 = 132 source samples → 130 merged samples and 130/130 decoded frames. B/C IDRs remain at merged samples 49, 74, and 123. 48 first-GOP slices are intentionally patched; 83 other retained NALs are byte-identical.
- Three-clip Cut + Classic Mosh: 132 source samples → 131 merged samples and 131/131 decoded frames. All A/B NALs remain byte-identical and the later C IDR remains.
- Loud failure: a genuinely reordered POC type 0 multi-GOP sequence is rejected before any output file is produced.
- Normalization target coverage: 1440×1920 + 768×1024 + 320×240 selects one shared 540×720 target.

`npm run test:webcodecs` produced:

- normalized source clips: 53,018 B / 52,775 B with one leading IDR sample each;
- the 75-frame fixture produced keyframes at samples 1, 31, and 61; its merge retained two later IDRs and decoded 149/149 frames;
- Safari-shaped POC type 0 multi-GOP pair merged with POC-LSB alignment and cleared stale errors;
- POC type 0 with true B-frame reordering was rejected with an explicit picture-reordering message;
- mobile layout stacked under 600px and kept 44px touch targets;
- blocking merge errors stayed short with no compatibility panel;
- a native large pair and a three-file mixed-resolution sequence normalized to 540×720 and showed the normalizing state;
- the three-clip browser flow exposed two Cut/Classic Mosh connectors, changed the first boundary to Cut, completed reorder/remove/undo, previewed 540×720, and exported 74 decoded frames;
- the preserved two-clip path still merged 49 samples, previewed 320×240, and exported a decodable video;
- the preserved export SHA-256 is `b4bb6c4827b2f7a8fe6d93777ff63f4491dd0b8eb497148dd3b2d07da1666bef`;
- ffmpeg.wasm decode plus WebCodecs encode completed both pair progress bars, and forced fallback named ffmpeg.wasm.

## Real-clip measurements

- `IMG_1993.MOV` + `IMG_3339.MOV`: HEVC sources normalized to H.264 at 540×720 through ffmpeg.wasm decode plus WebCodecs encode.
- Pair conversion took 5.7 s and 5.8 s, versus 5.3 s / 9.1 s for capped full-WASM and 19.8 s / 33.6 s for earlier full-resolution WASM runs.
- 112 + 177 source samples merged to 288 samples; strict decode returned 288/288 frames.
- Later B IDRs were retained, the first B GOP received 32 slice patches across 16 samples, and strict decode exited 0.
- Export SHA-256: `cc72b2c54e63045159bc5ada461469217e527aa7cf152ba7a7347bd8ec89ff5d`.

## Limits / next work

- WebCodecs does not guarantee hardware acceleration or support for every profile/resolution.
- WebCodecs normalization currently requires natively parseable H.264 because the demuxer does not expose HEVC samples.
- The 720-pixel cap is lossy for larger sources and may place the first recovery IDR earlier than requested because some encoders insert extra keyframes.
- Sequence conversion starts at most two WASM workers; additional clips wait, and peak memory can still exhaust iPhone Safari on large inputs.
- Multi-GOP alignment supports type 2 and non-reordered type 0/1 streams. Type 0/1 requires no B-slices and no non-zero composition offsets; reordered B fails explicitly.
- The 100 MB limit is a soft limit; available device memory can still be exceeded.
- Timeline maximum is 12 clips. Merged exports remain video-only. Audio, crossfades, PWA, servers, uploads, and general-codec WebCodecs demuxing remain out of scope.
- The reported iPhone `IMG_4767.mov` / `final_0.mov` pair was not present locally; automated coverage uses a generated Safari-shaped POC type 0 fixture, so a physical-device retest is still required.
