# m4shlab-v1.0 release complete — user review and device testing

## Status

The v1.0 release is complete at tag `m4shlab-v1.0`. Its automated release baseline is **77 Node / 27 WebCodecs / 6 PWA** checks passing. User review and physical-device testing remain; later main-branch parity work is outside the immutable release tag.

Do not move or delete the release tag. Record any device finding first, diagnose it against a reproducible fixture, and only then propose a follow-up fix.

## Manual device checklist

1. Open <https://h333ndrik.github.io/m4shlab/> in Safari on iPhone or iPad and install via **Share → Add to Home Screen**.
2. Launch from the Home Screen and confirm the app uses standalone mode without Safari browser chrome.
3. Enable Airplane mode, relaunch, and confirm the cached app shell starts offline.
4. Import a real clip, apply Classic Mosh with a shortened duration and both Restore and Continue, then verify preview and export.
5. Import a compatible or auto-normalized pair, select Melt with Gentler cadence, and inspect the boundary corruption and recovery.
6. Export the merged result and confirm that AAC audio is present at 48 kHz stereo, pitch is unchanged, and its duration matches the merged video.

## Release limits to verify honestly

- Normalization caps the long side at 720 px; larger sources are intentionally downscaled.
- Video normalization and transition effects are video-only. Exported audio follows the linear clip timeline and is not moshed.
- Bitstream decode behavior and visual mosh strength depend on source GOP structure and the device decoder.
- Melt, Loop Release, and Reset Pulse require B-frame-free, non-reordered input and trigger normalization for native B-frame sources.
- Type 0/1 multi-GOP alignment requires no B-slices and no non-zero composition offsets; genuinely reordered streams fail loudly.
- The 100 MB input limit is soft, and WebCodecs does not guarantee hardware acceleration. Large iOS conversions can exhaust memory.
- PWA storage and the runtime-cached ffmpeg.wasm assets may be evicted under device storage pressure.

## Result to report back

Record the device and OS/browser version, the source parameters, selected method/cadence/duration/ending, decoded frame count, export duration, audio presence and pitch, and any error text. Keep private source media in the gitignored `testmedia/` directory.
