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
