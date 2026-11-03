# m4shlab

H.264 bitstream moshing in the browser — fully client-side, no server, no upload.

Phase A MVP: one H.264 clip, IDR removal produces visible moshing in the preview, export decodes.

Phase B MVP: two compatible H.264 clips, Classic A→B merge in the browser, export decodes as video.

## Run it

```sh
npm start
```

Open `http://127.0.0.1:4173`, choose **Clip A (base)** and **Clip B (incoming)**, review the compatibility panel, then switch between **A cut** and **merged A→B**. Play from the start for the clearest result. Export downloads `m4shlab-merge.mp4`.

The Phase A single-clip transfer remains available through `mosh.js` and its unchanged test chain.

The app has no runtime dependencies and no build step. `npm start` only serves the local static files; video never leaves the browser.

## What it does

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
```

`npm test` requires Node and `ffmpeg`/`ffprobe`. If fixtures are missing, it runs `testmedia/generate.sh`, which creates local, ignored test media:

- a 3-second 320×240 Phase A clip with IDRs at samples 0, 25, and 50;
- matching 1-second 320×240 A/B clips with identical High-profile settings and timescale;
- a 256×240 resolution mismatch;
- a 320×240 clip with a different `mdhd` timescale.

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
- the truncated Phase A file is rejected.

Current local results (2026-11-03, Node 26.13.0, FFmpeg 9.0.2): Phase A removed 11,468 bytes from 75 samples and decoded 73 frames. Phase B merged 25 A samples plus 24 retained B samples into 49 samples and 25,088 timescale units (1.96 seconds), decoded exactly 49 frames, and produced a 67,893-byte video-only MP4. The retained 50 NAL units were byte-identical. Headless Chrome 156 rendered the compatibility table, played the merged Blob without a media error, and downloaded a 67,893-byte export whose SHA-256 matched Node at `4c15b7602ef7d78b01cddc6324b3f84bdef2ef9be5b5c19cb8b8e04f1690427c`. A 320×240 versus 256×240 pair disabled merge/export and displayed the actionable mismatch message.

This is **synthetic and headless-browser verification**, not a real phone-pair/device acceptance check. No physical phone media or physical device was supplied or used.

## Honest limits

This project edits H.264 NAL units; it does not decode pixels, blend frames, add crossfades, or hold frames as a visual effect. Observable moshing is produced by the device decoder reacting to missing references.

The effect depends on the source GOP structure. Decode behavior is device-dependent: some sources may refuse to play after IDR removal, show black frames, or hold the last decodable frame, especially when seeking directly into a modified GOP. Different browsers and hardware decoders can show different results. This is expected behavior, not a bug.

Phase A handles a single H.264 video track in a conventional (non-fragmented) MP4. Interleaved audio sample offsets are adjusted when present.

Phase B supports compatible pairs only. Resolution, profile, level, chroma, bit depth, PPS, and video timescale must match; differing SPS payloads require equivalent parsed core fields. Arbitrary A/B pairs need a future normalization phase. The merged A→B export has no audio yet; audio arrives with normalization. If B contains repeated GOPs, their later IDR/parameter/SEI units are removed and any sample left empty is skipped, so B's emitted sample count can be lower than the simple one-IDR fixture case.

It is not an HEVC, fragmented-MP4, encrypted-media, or multi-video-track editor.

## Attribution

The approach was studied from [supermosh](https://github.com/supermosh/supermosh.github.io), which is GPLv3. m4shlab is an independent implementation from the Phase A and Phase B specifications; no supermosh source code was copied or reused. The sibling h4moshlab project was treated as conceptual reference only.

## License

MIT. See [LICENSE](LICENSE).
