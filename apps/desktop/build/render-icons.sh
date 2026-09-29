#!/bin/sh
# Renders the icon masters in this directory to the files electron-builder and
# the app use. Needs rsvg-convert (brew install librsvg) and macOS iconutil.
set -eu
cd "$(dirname "$0")"

rsvg-convert -w 1024 -h 1024 icon.svg -o icon.png

iconset="$(mktemp -d)/icon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  double=$((size * 2))
  # 16 and 32 px slots use the small-size variant; everything larger uses the master.
  src=icon.svg
  [ "$size" -le 32 ] && src=icon-small.svg
  rsvg-convert -w "$size" -h "$size" "$src" -o "$iconset/icon_${size}x${size}.png"
  src2=icon.svg
  [ "$double" -le 32 ] && src2=icon-small.svg
  rsvg-convert -w "$double" -h "$double" "$src2" -o "$iconset/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$iconset" -o icon.icns
rm -rf "$(dirname "$iconset")"

rsvg-convert -w 16 -h 16 trayTemplate.svg -o trayTemplate.png
rsvg-convert -w 32 -h 32 trayTemplate.svg -o trayTemplate@2x.png
