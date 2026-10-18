#!/bin/sh
# Renders the icon sources in this directory to the files electron-builder and
# the app use.
#
# Sources (written by docs/design/icon-source/icons.mjs):
#   icon.icon         Icon Composer master. electron-builder compiles it to
#                     Assets.car for macOS 26 (Liquid Glass, dark, tinted).
#   icon-small.icon   Heavier variant for the 16 and 32 px icns slots.
#   icon-dev.icon     Development: the mark in ink on white drafting paper,
#                     for unpackaged runs.
#   icon-preview.icon Preview: the mark on blueprint paper, for a future
#                     preview channel. No build uses it yet.
#   trayTemplate.svg  Menu-bar template image.
#
# Outputs: icon.png (1024), icon-dev.png (1024, the Dock and window icon of
# unpackaged runs), icon-preview.png (1024), icon.icns (older macOS and the
# icns fallback), trayTemplate.png and trayTemplate@2x.png, the web build's
# home-screen icons in ../src/renderer/web-public/icons and the docs site's
# apple-icon.png.
#
# `render-icons.sh dev` only rebuilds icon-dev.png and icon-preview.png.
#
# Needs Xcode 26 (Icon Composer's ictool), macOS sips and iconutil, python3
# with Pillow (for the grid drop shadow), and rsvg-convert (brew install librsvg).
set -eu
cd "$(dirname "$0")"

ictool="/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool"
[ -x "$ictool" ] || ictool="/Applications/Icon Composer.app/Contents/Executables/ictool"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# ictool renders the full-bleed body. Place it on the macOS grid (824 body at
# 100,100 on a 1024 canvas) with the standard soft drop shadow.
render() { # source.icon output.png
  "$ictool" "$1" --export-image --output-file "$tmp/raw.png" --platform macOS \
    --rendition Default --width 1024 --height 1024 --scale 1 >/dev/null
  python3 - "$tmp/raw.png" "$2" <<'PY'
import sys
from PIL import Image, ImageFilter
body = Image.open(sys.argv[1]).convert("RGBA").resize((824, 824), Image.LANCZOS)
canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
shadow = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
sh = Image.new("RGBA", (824, 824), (0, 0, 0, 0))
sh.putalpha(body.split()[3].point(lambda a: a * 90 // 255))
shadow.alpha_composite(sh, (100, 112))
canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(14)))
canvas.alpha_composite(body, (100, 100))
canvas.save(sys.argv[2])
PY
}

render icon-dev.icon icon-dev.png
render icon-preview.icon icon-preview.png
[ "${1-}" = dev ] && exit 0

render icon.icon icon.png
render icon-small.icon "$tmp/small.png"

iconset="$tmp/icon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  double=$((size * 2))
  # 16 and 32 px slots use the small-size variant; everything larger uses the master.
  src=icon.png
  [ "$size" -le 32 ] && src="$tmp/small.png"
  sips -z "$size" "$size" "$src" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  src2=icon.png
  [ "$double" -le 32 ] && src2="$tmp/small.png"
  sips -z "$double" "$double" "$src2" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o icon.icns

rsvg-convert -w 22 -h 22 trayTemplate.svg -o trayTemplate.png
rsvg-convert -w 44 -h 44 trayTemplate.svg -o trayTemplate@2x.png

# Home-screen icons for the web build and the docs site's touch icon: the
# icon's body, full bleed, opaque, since iOS and Android round the corners
# themselves. iOS fills transparent corners with black.
python3 - icon.png ../src/renderer/web-public/icons ../../docs/app/apple-icon.png <<'PY'
import sys
from PIL import Image
src = Image.open(sys.argv[1]).convert("RGBA")
lo, hi = 100, 924
top, bottom = src.getpixel((512, 200)), src.getpixel((512, 830))
body = src.crop((lo, lo, hi, hi))
n = hi - lo
out = Image.new("RGB", (n, n))
# Around the glyph and its shadow the body is a plain vertical gradient, drawn
# again without the squircle edge. The rendered pixels fade into it over F px
# inside 200..824 of the 1024 canvas, so no seam shows where they meet.
g0, g1, F = 200 - lo, 824 - lo, 40
px, po = body.load(), out.load()
for y in range(n):
    t = (y + lo - 200) / (830 - 200)  # the field is linear between the two samples
    c = tuple(max(0, min(255, round(top[i] * (1 - t) + bottom[i] * t))) for i in range(3))
    for x in range(n):
        w = max(0.0, min(1.0, min(x - g0, g1 - 1 - x, y - g0, g1 - 1 - y) / F))
        if w > 0:
            r, g, b, a = px[x, y]
            k = a / 255 * w
            po[x, y] = tuple(round(v * k + c[i] * (1 - k)) for i, v in enumerate((r, g, b)))
        else:
            po[x, y] = c
for size, name in [(180, "apple-touch-icon.png"), (192, "icon-192.png"), (512, "icon-512.png")]:
    out.resize((size, size), Image.LANCZOS).save(f"{sys.argv[2]}/{name}", optimize=True)
out.resize((180, 180), Image.LANCZOS).save(sys.argv[3], optimize=True)
PY
