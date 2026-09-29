#!/usr/bin/env bash
# Build the final MP4 from rendered frames + soundtrack.
#   1) python3 audio.py                     -> audio.wav
#   2) node render.cjs frames 3 4           -> out/frames/f_*.png  (NODE_PATH must reach playwright)
#   3) ./make_video.sh [frames_dir]         -> nsoft_nmes_15s.mp4
set -euo pipefail
cd "$(dirname "$0")"
FRAMES=${1:-out/frames}
FF=${FFMPEG:-$(python3 -c "import imageio_ffmpeg as i; print(i.get_ffmpeg_exe())")}
"$FF" -y -loglevel error -framerate 60 -i "$FRAMES/f_%05d.png" -i audio.wav \
  -vf "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p" \
  -c:v libx264 -preset slow -crf 18 -maxrate 24M -bufsize 48M -profile:v high -level 4.2 -g 30 -bf 2 \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -c:a aac -b:a 320k -ar 48000 -shortest -movflags +faststart nsoft_nmes_15s.mp4
echo "wrote nsoft_nmes_15s.mp4"
