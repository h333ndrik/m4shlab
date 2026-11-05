# m4shlab v1.1 — user review and device testing pending

## Test-infrastructure rule: capability stubs

A stub that changes a global capability (for example replacing `VideoDecoder`/`VideoEncoder` with `undefined`) must be removed inside the same test's teardown, and the next scenario must run on a freshly navigated page. The WebCodecs stub in `tests/webcodecs.browser.mjs` installs right before the two ffmpeg.wasm fallback checks and is now removed with `Page.removeScriptToEvaluateOnNewDocument` immediately afterwards; a fresh page then asserts `typeof VideoDecoder + '/' + typeof VideoEncoder === 'function/function'`.

Historical note: between `841a1eb` (Phase C) and `5b4cb8b` the stub stayed installed for every later navigation. The shell-guard, optional-element and reload-guard checks that ran during that window import native H.264 fixtures through the Tier-1 path and do not touch WebCodecs, so their assertions were unaffected; the connector-parity check was affected (it normalized through ffmpeg.wasm while claiming the native path) and was fixed by removing the stub and asserting the native constructors before that scenario.

## Status

m4shlab v1.1 is the current complete browser release candidate. The v1.0 tag remains immutable at `2aa8ee5`; v1.1 adds per-clip looks, the persistent sound/export toggle, and live preview time and labels. Automated verification is **83 Node / 100 WebCodecs / 6 PWA** checks passing (the shell guard and settings transactionality block added 1 Node and 18 WebCodecs checks). Physical-device acceptance remains pending.

Do not move or delete either release tag. Record device findings first, reproduce them against a fixture where possible, and propose a scoped fix before changing the release state.

## Manual device checklist

1. Open <https://h333ndrik.github.io/m4shlab/> in Safari on iPhone or iPad and install via **Share → Add to Home Screen**.
2. Launch from the Home Screen and confirm standalone mode without Safari browser chrome.
3. Enable Airplane mode, relaunch, and confirm the complete app shell starts offline.
4. Import a real clip and test m4sh with a shortened duration and both Restore and Continue.
5. Apply Melt Gentler and inspect the release boundary; then test Loop Release Gentler and Reset Pulse on suitable B-frame-free clips.
6. Switch a duplicate clip between Original, Black & white, B&W negative, and Color negative; confirm the look survives reorder and undo/redo.
7. Change clip speed and verify the preview duration, live current/total readout, card-click filename preview, Assemble preview label, and sound on/off behavior.
8. Export with Sound on: confirm AAC-LC 48 kHz stereo, preserved pitch, and audio duration equal to video duration. Export with Sound off: confirm the file has no audio stream.

## Intentional UI elements

- The `BITSTREAM REPORT` disclosure is an intentional, collapsed report view. It is no longer part of the removed-string audit.

## Release limits to verify honestly

- Normalization caps the long side at 720 px; larger sources are intentionally downscaled.
- Transition and normalization effects alter video only. Export audio follows the linear clip timeline and is not moshed.
- Bitstream decode behavior and visual mosh strength depend on source GOP structure and the device decoder.
- Melt, Loop Release, and Reset Pulse require B-frame-free, non-reordered input and trigger normalization for native B-frame sources.
- Type 0/1 multi-GOP alignment requires no B-slices and no non-zero composition offsets; genuinely reordered streams fail loudly.
- The 100 MB input limit is soft, and WebCodecs does not guarantee hardware acceleration. Large iOS conversions can exhaust memory.
- PWA storage and the runtime-cached ffmpeg.wasm assets may be evicted under device storage pressure.
- Looks require WebCodecs and are applied after normalization downscaling; they are pixel effects rather than bitstream filters.

## Result to report back

Record the device and OS/browser version, source parameters, selected method/cadence/duration/ending, look and speed, decoded frame count, export duration, audio presence/pitch, cache version, and any error text. Keep private source media in the gitignored `testmedia/` directory.
