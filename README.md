# m4shlab

H.264 bitstream moshing in the browser — fully client-side, no server, no upload.

MVP: one H.264 clip, IDR removal produces visible moshing in the preview, export decodes.

## Run it

```sh
npm start
```

Open `http://127.0.0.1:4173`, choose an H.264 MP4, then switch between **original** and **modified**. Play from the start for the clearest result. Export downloads `m4shlab-export.mp4`.

The app has no runtime dependencies and no build step. `npm start` only serves the local static files; video never leaves the browser.

## What it does

1. Walks the MP4 boxes and resolves the video track's sample table (`stsz`/`stz2`, `stsc`, `stco`/`co64`).
2. Reads length-prefixed H.264 NAL units using the length size declared by `avcC`.
3. Preserves the first GOP. From the second IDR onward, removes each IDR NAL unit and nothing else.
4. Rewrites only the affected sample sizes, chunk offsets, mdat size, and the removed NAL bytes. All retained NAL payloads remain byte-identical and in order.
5. Plays the modified MP4 as a Blob through the browser's native decoder and exports the same bytes as a download.

`Cut` is retained by the transform as a byte-for-byte copy of the source. The UI's **original / cut control** view plays that untouched copy.

## Verification

The committed test chain uses a locally generated fixture; media is not committed.

```sh
npm test
```

`npm test` requires Node and `ffmpeg`/`ffprobe`. If the fixture is missing, it runs `testmedia/generate.sh`, which creates a 3-second 320×240 High-profile H.264 clip with B-frames, 25-frame GOPs, and IDRs at samples 0, 25, and 50. The tests assert:

- the known NAL type and GOP layout;
- exactly the later IDR units are removed, in order;
- every retained NAL is byte-identical;
- `avcC` and all in-band SPS/PPS data are preserved;
- output size shrinks by exactly the removed byte count;
- the Cut control equals the source;
- the exported file decodes with `ffprobe`;
- a truncated file is rejected.

Current local results (2026-11-03, Node 26.13.0, FFmpeg 9.0.2): 75 input samples, IDRs at 0/25/50, 2 IDRs removed, 11,468 bytes removed, 74 retained NALs byte-identical, and 73 frames decoded from the 100,238-byte export. Headless Chrome 156 played the modified Blob without a media error, showed a different frame from the original at the same playback time, downloaded an export whose SHA-256 matched the Node transform output, and displayed a loud parse error for a truncated file.

This is still **synthetic and headless-browser verification**, not the real phone-clip/device acceptance check. No physical phone media or physical device was supplied or used.

## Honest limits

This project edits H.264 NAL units; it does not decode pixels, blend frames, add crossfades, or hold frames as a visual effect. Observable moshing is produced by the device decoder reacting to missing references.

The effect depends on the source GOP structure. Decode behavior is device-dependent: some sources may refuse to play after IDR removal, show black frames, or hold the last decodable frame, especially when seeking directly into a modified GOP. Different browsers and hardware decoders can show different results. This is expected behavior, not a bug.

Phase A handles a single H.264 video track in a conventional (non-fragmented) MP4. Interleaved audio sample offsets are adjusted when present. It is not an HEVC, fragmented-MP4, encrypted-media, or multi-video-track editor.

## Attribution

The approach was studied from [supermosh](https://github.com/supermosh/supermosh.github.io), which is GPLv3. m4shlab is an independent implementation from the Phase A specification; no supermosh source code was copied or reused. The sibling h4moshlab project was treated as conceptual reference only.

## License

MIT. See [LICENSE](LICENSE).
