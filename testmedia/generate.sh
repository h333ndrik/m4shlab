#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$root/testmedia"

encode() {
  local output="$1"
  local size="$2"
  local seconds="$3"
  local source="$4"
  local timescale="${5:-}"
  local args=(
    -hide_banner -loglevel error -y
    -f lavfi -i "$source"
    -t "$seconds"
    -c:v libx264 -preset medium -profile:v high -pix_fmt yuv420p
    -g 25 -keyint_min 25 -sc_threshold 0 -bf 2
    -movflags +faststart -an
  )
  if [[ -n "$timescale" ]]; then
    args+=(-video_track_timescale "$timescale")
  fi
  ffmpeg "${args[@]}" "$root/testmedia/$output"
  printf 'Generated %s\n' "$root/testmedia/$output"
}

encode synthetic-h264.mp4 320x240 3 "testsrc2=size=320x240:rate=25"
encode synthetic-b-a.mp4 320x240 1 "testsrc2=size=320x240:rate=25"
encode synthetic-b-b.mp4 320x240 1 "testsrc2=size=320x240:rate=25,hue=h=90"
encode synthetic-b-mismatch.mp4 256x240 1 "testsrc2=size=256x240:rate=25"
encode synthetic-b-timescale.mp4 320x240 1 "testsrc2=size=320x240:rate=25,hue=h=180" 25600
encode synthetic-native-large-a.mp4 1440x1920 1 "testsrc2=size=1440x1920:rate=25"
encode synthetic-native-large-b.mp4 768x1024 1 "testsrc2=size=768x1024:rate=25,hue=h=90"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=320x240:rate=25" \
  -t 3 \
  -c:v libx264 -preset medium -profile:v high -pix_fmt yuv420p \
  -g 25 -keyint_min 25 -sc_threshold 0 -bf 2 \
  -x264-params slices=2 \
  -movflags +faststart -an \
  "$root/testmedia/synthetic-multislice-idr.mp4"
printf 'Generated %s\n' "$root/testmedia/synthetic-multislice-idr.mp4"

encode_multigop() {
  local output="$1"
  local size="$2"
  local seconds="$3"
  local source="$4"
  local coder="${5:-cabac}"
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "$source" \
    -t "$seconds" \
    -c:v libx264 -preset medium -profile:v high -pix_fmt yuv420p \
    -g 25 -keyint_min 25 -sc_threshold 0 -bf 0 -coder "$coder" \
    -video_track_timescale 12800 \
    -movflags +faststart -an \
    "$root/testmedia/$output"
  printf 'Generated %s\n' "$root/testmedia/$output"
}

encode_multigop synthetic-multigop-a.mp4 320x240 1 "testsrc2=size=320x240:rate=25"
encode_multigop synthetic-multigop-b.mp4 320x240 3 "testsrc2=size=320x240:rate=25,hue=h=90"
encode_multigop synthetic-multigop-poc0-source-a.mp4 320x240 1 "testsrc2=size=320x240:rate=25" vlc
encode_multigop synthetic-multigop-poc0-source-b.mp4 320x240 3 "testsrc2=size=320x240:rate=25,hue=h=90" vlc
encode_multigop synthetic-multigop-poc0-source-c.mp4 320x240 1.28 "testsrc2=size=320x240:rate=25,hue=h=180" vlc
node "$root/testmedia/generate-poc0-fixture.mjs" "$root/testmedia/synthetic-multigop-poc0-source-a.mp4" "$root/testmedia/synthetic-multigop-poc0-a.mp4"
node "$root/testmedia/generate-poc0-fixture.mjs" "$root/testmedia/synthetic-multigop-poc0-source-b.mp4" "$root/testmedia/synthetic-multigop-poc0-b.mp4"
node "$root/testmedia/generate-poc0-fixture.mjs" "$root/testmedia/synthetic-multigop-poc0-source-c.mp4" "$root/testmedia/synthetic-multigop-poc0-c.mp4"
printf 'Generated %s\n' "$root/testmedia/synthetic-multigop-poc0-a.mp4" "$root/testmedia/synthetic-multigop-poc0-b.mp4" "$root/testmedia/synthetic-multigop-poc0-c.mp4"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=320x240:rate=25" \
  -t 1 \
  -c:v libx264 -preset medium -profile:v high -pix_fmt yuv420p \
  -g 25 -keyint_min 25 -sc_threshold 0 -bf 2 \
  -f mov -movflags +faststart -an \
  "$root/testmedia/synthetic-quicktime.mov"
printf 'Generated %s\n' "$root/testmedia/synthetic-quicktime.mov"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=320x240:rate=25" \
  -t 1 \
  -c:v libx265 -preset ultrafast -pix_fmt yuv420p -tag:v hvc1 \
  -f mov -movflags +faststart -an \
  "$root/testmedia/synthetic-hevc.mov"
printf 'Generated %s\n' "$root/testmedia/synthetic-hevc.mov"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=256x240:rate=25,hue=h=120" \
  -t 1 \
  -c:v libx265 -preset ultrafast -pix_fmt yuv420p -tag:v hvc1 \
  -f mov -movflags +faststart -an \
  "$root/testmedia/synthetic-hevc-small.mov"
printf 'Generated %s\n' "$root/testmedia/synthetic-hevc-small.mov"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=320x240:rate=25" \
  -t 1 \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 25 -bf 0 \
  -movflags +frag_keyframe+empty_moov+default_base_moof -an \
  "$root/testmedia/synthetic-fragmented.mp4"
printf 'Generated %s\n' "$root/testmedia/synthetic-fragmented.mp4"
