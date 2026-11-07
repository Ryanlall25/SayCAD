#!/bin/sh
# Watch a YouTube video through its storyboard (preview-frame) sheets, served
# from i.ytimg.com — works where the video stream itself (googlevideo.com) is
# blocked or refused. Needs yt-dlp (pip install yt-dlp) and python3.
#
#   sh dev/ytwatch.sh <videoId|url> <outDir>
#
# Writes <outDir>/sheetN.jpg (grids of frames in playback order, ~10 s apart)
# and <outDir>/info.txt (title and duration). Frames are low resolution
# (160x90 to 320x180): enough for on-screen steps, tools and subtitles.
set -e
v=$1; d=$2
[ -n "$v" ] && [ -n "$d" ] || { echo "usage: sh dev/ytwatch.sh <videoId|url> <outDir>"; exit 2; }
mkdir -p "$d"
cd "$d"
yt-dlp --no-playlist --ignore-no-formats-error -f 'sb0/sb1' --extractor-args 'youtube:player_client=mweb,web_safari' \
  --print-to-file '%(title)s | %(duration)s s' info.txt -o 'sb.%(ext)s' "$v" >/dev/null 2>&1 || true
[ -f sb.mhtml ] || { echo "no storyboard for $v"; exit 1; }
python3 -I - <<'EOF'
import email
m = email.message_from_bytes(open('sb.mhtml', 'rb').read())
imgs = [p.get_payload(decode=True) for p in m.walk() if p.get_content_type().startswith('image/')]
for i, b in enumerate(imgs):
    open(f'sheet{i}.jpg', 'wb').write(b)
print(len(imgs), 'sheets')
EOF
cat info.txt
