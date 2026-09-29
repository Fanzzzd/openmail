#!/usr/bin/env python3
"""Generates the icon option SVGs, renders PNGs and the contact sheet.

Run from anywhere: python3 docs/design/icon-options/build.py
Needs rsvg-convert. The squircle body path is copied from
apps/desktop/build/icon.svg so every option uses the same macOS grid.
"""
import math
import os
import re
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
MASTER = os.path.join(ROOT, "apps", "desktop", "build", "icon.svg")

with open(MASTER) as f:
    BODY = re.search(r'<path id="body" d="([^"]+)"', f.read()).group(1)


def icon(bg_top, bg_bottom, content, defs="", sheen=0.14):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <path id="body" d="{BODY}"/>
    <clipPath id="clip"><use href="#body"/></clipPath>
    <linearGradient id="bg" x1="0" y1="100" x2="0" y2="924" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="{bg_top}"/>
      <stop offset="1" stop-color="{bg_bottom}"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="100" x2="0" y2="520" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="{sheen}"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <filter id="iconShadow" x="-10%" y="-10%" width="120%" height="130%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="10"/>
      <feOffset dy="10"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.3"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="150%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="12"/>
      <feOffset dy="12"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.25"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
{defs}
  </defs>
  <g filter="url(#iconShadow)"><use href="#body" fill="url(#bg)"/></g>
  <use href="#body" fill="url(#sheen)"/>
  <g clip-path="url(#clip)">
{content}
  </g>
</svg>
"""


OPTIONS = []


def option(slug, name):
    def wrap(fn):
        OPTIONS.append((slug, name, fn))
        return fn
    return wrap


# 01. The envelope opened: flap swung up, yellow lining showing. The
# silhouette is a house outline, so "open" and "home/local" in one shape.
@option("01-open-flap", "Open flap")
def open_flap():
    return icon("#2E3480", "#181B4E", """
    <g filter="url(#soft)">
      <path d="M250 452 L512 236 L774 452 Z" fill="#FFC53D" stroke="#FFC53D" stroke-width="36" stroke-linejoin="round"/>
      <rect x="232" y="440" width="560" height="340" rx="40" fill="#FFFFFF"/>
    </g>
    <path d="M262 470 L512 646 L762 470" fill="none" stroke="#D5D9E6" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>
""")


# 02. The back of a letter closed with a wax seal. The seal is the human
# approval step; agents can draft, only you seal and send.
@option("02-wax-seal", "Wax seal")
def wax_seal():
    # Irregular wax blob: circle with 9 soft lobes.
    pts = []
    for i in range(72):
        a = 2 * math.pi * i / 72
        r = 150 + 12 * math.sin(9 * a) + 6 * math.sin(4 * a + 1)
        pts.append(f"{512 + r * math.cos(a):.1f} {560 + r * math.sin(a):.1f}")
    blob = "M" + " L".join(pts) + " Z"
    return icon("#F7F8FA", "#DCE0E8", f"""
    <g filter="url(#soft)">
      <rect x="200" y="300" width="624" height="440" rx="36" fill="#FFFFFF"/>
    </g>
    <path d="M222 322 L512 560 L802 322" fill="none" stroke="#C9CFDA" stroke-width="22" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="M222 718 L430 540 M802 718 L594 540" fill="none" stroke="#C9CFDA" stroke-width="22" stroke-linecap="round"/>
    <g filter="url(#soft)">
      <path d="{blob}" fill="#C0162F"/>
    </g>
    <ellipse cx="512" cy="566" rx="58" ry="52" fill="none" stroke="#8E0D20" stroke-width="36"/>
    <path d="M430 480 A120 120 0 0 1 560 452" fill="none" stroke="#E4495E" stroke-width="16" stroke-linecap="round"/>
""", sheen=0.5)


# 03. Spaces: a fan of account cards, each its own colour, with the mail on
# top. Mirrors the Arc-style space switcher.
@option("03-spaces", "Spaces")
def spaces():
    card = 'x="-270" y="-180" width="540" height="360" rx="44"'
    return icon("#2B303B", "#181B22", f"""
    <g transform="translate(512 410) rotate(-15)" filter="url(#soft)"><rect {card} fill="#7C5CFF"/></g>
    <g transform="translate(512 490) rotate(-6)" filter="url(#soft)"><rect {card} fill="#13BFA0"/></g>
    <g transform="translate(512 590) rotate(3)" filter="url(#soft)">
      <rect {card} fill="#FFFFFF"/>
      <path d="M-236 -150 L0 20 L236 -150" fill="none" stroke="#FFB21E" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
""")


# 04. Monogram: a lowercase "o" stretched into an envelope. Type first, mail
# second. Works as a one-colour glyph for the tray and the web.
@option("04-o-envelope", "o envelope")
def o_envelope():
    return icon("#FFFFFF", "#E7EAF0", """
    <g filter="url(#soft)">
      <rect x="222" y="322" width="580" height="380" rx="190" fill="none" stroke="#161A24" stroke-width="96"/>
    </g>
    <path d="M338 420 L512 540 L686 420" fill="none" stroke="#3D5BFF" stroke-width="56" stroke-linecap="round" stroke-linejoin="round"/>
""", sheen=0.6)


# 05. Pigeonholes: the sorting cabinet in a post room. Each cubby is an
# account; the mail sits on your own shelf, not in someone's cloud.
@option("05-pigeonholes", "Pigeonholes")
def pigeonholes():
    cells = []
    xs, ys = (262, 522), (270, 530)
    letters = {(0, 0): "#FFFFFF", (1, 0): "#FFFFFF", (1, 1): "#FFFFFF"}
    for j, y in enumerate(ys):
        for i, x in enumerate(xs):
            cells.append(f'<rect x="{x}" y="{y}" width="240" height="224" rx="26" fill="#5A3A16"/>')
            if (i, j) in letters:
                ly = y + 92
                cells.append(
                    f'<rect x="{x + 22}" y="{ly}" width="196" height="132" rx="14" fill="#FFFFFF"/>'
                    f'<path d="M{x + 40} {ly + 18} L{x + 120} {ly + 70} L{x + 200} {ly + 18}" fill="none" '
                    f'stroke="#E0A93A" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>'
                )
    return icon("#F6BD4F", "#E0901C", f"""
    <g filter="url(#soft)">
      <rect x="226" y="234" width="572" height="556" rx="52" fill="#3A250D"/>
    </g>
    {''.join(cells)}
""")


# 06. Local store: a database cylinder whose lid is an envelope. Mail kept in
# a database on your machine.
@option("06-local-store", "Local store")
def local_store():
    cx, rx, ry = 512, 250, 92
    def band(y, h, fill):
        return (f'<path d="M{cx - rx} {y} L{cx - rx} {y + h} A{rx} {ry} 0 0 0 {cx + rx} {y + h} '
                f'L{cx + rx} {y} A{rx} {ry} 0 0 1 {cx - rx} {y} Z" fill="{fill}"/>')
    return icon("#7B4DFF", "#4A1FC4", f"""
    <g filter="url(#soft)">
      {band(596, 120, "#FFFFFF")}
      {band(446, 120, "#FFFFFF")}
    </g>
    <path d="M{cx - rx} 446 A{rx} {ry} 0 0 0 {cx + rx} 446" fill="none" stroke="#D9CCFF" stroke-width="22"/>
    <path d="M{cx - rx} 596 A{rx} {ry} 0 0 0 {cx + rx} 596" fill="none" stroke="#D9CCFF" stroke-width="22"/>
    <g filter="url(#soft)">
      <ellipse cx="{cx}" cy="330" rx="{rx}" ry="{ry}" fill="#FFFFFF"/>
      {band(330, 86, "#FFFFFF")}
    </g>
    <path d="M{cx - 190} 300 L{cx} 372 L{cx + 190} 300" fill="none" stroke="#7B4DFF" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/>
""")


# 07. Proposal: a dashed draft letter behind a solid one. The agent proposes
# (dashed), you approve (solid).
@option("07-proposal", "Proposal")
def proposal():
    return icon("#1E8A6E", "#0E5A47", """
    <path d="M186 334 L186 274 A40 40 0 0 1 226 234 L296 234 M576 234 L646 234 A40 40 0 0 1 686 274 L686 334 M186 474 L186 534 A40 40 0 0 0 226 574 L296 574 M386 234 L486 234 M186 392 L186 426" fill="none" stroke="#9FF0D4" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>
    <g filter="url(#soft)">
      <rect x="338" y="420" width="500" height="340" rx="40" fill="#FFFFFF"/>
    </g>
    <path d="M378 458 L588 612 L798 458" fill="none" stroke="#1E8A6E" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/>
""")


def render(svg_path, png_path, size):
    subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), svg_path, "-o", png_path], check=True)


def sheet():
    # Each column: 256, 128, then 32 and 16 at 1:1, then the same 32 and 16
    # renders blown up to 64 so the pixels can be judged.
    n = len(OPTIONS)
    col = 300
    width = col * n + 40
    rows = [("light", "#F2F2F4", "#1C1C1E"), ("dark", "#1E1E20", "#E5E5EA")]
    band_h = 560
    height = band_h * len(rows)
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{width}" height="{height}">']
    for r, (_, bg, fg) in enumerate(rows):
        y0 = r * band_h
        out.append(f'<rect x="0" y="{y0}" width="{width}" height="{band_h}" fill="{bg}"/>')
        for i, (slug, name, _) in enumerate(OPTIONS):
            x = 20 + i * col
            cx = x + col // 2
            out.append(f'<image x="{cx - 128}" y="{y0 + 24}" width="256" height="256" xlink:href="{slug}.png"/>')
            out.append(f'<image x="{cx - 64}" y="{y0 + 296}" width="128" height="128" xlink:href="{slug}.png"/>')
            out.append(f'<image x="{cx - 104}" y="{y0 + 456}" width="32" height="32" xlink:href="build-tmp/{slug}-32.png"/>')
            out.append(f'<image x="{cx - 60}" y="{y0 + 464}" width="16" height="16" xlink:href="build-tmp/{slug}-16.png"/>')
            out.append(f'<image x="{cx - 26}" y="{y0 + 440}" width="64" height="64" xlink:href="build-tmp/{slug}-32.png"/>')
            out.append(f'<image x="{cx + 48}" y="{y0 + 440}" width="64" height="64" xlink:href="build-tmp/{slug}-16.png"/>')
            out.append(f'<text x="{cx}" y="{y0 + 540}" text-anchor="middle" font-family="Helvetica Neue, Helvetica, Arial" font-size="20" fill="{fg}">{slug[:2]}  {name}</text>')
    out.append("</svg>")
    path = os.path.join(HERE, "contact-sheet.svg")
    with open(path, "w") as f:
        f.write("\n".join(out))
    subprocess.run(["rsvg-convert", path, "-o", os.path.join(HERE, "contact-sheet.png")], check=True, cwd=HERE)
    os.remove(path)


def main():
    tmp = os.path.join(HERE, "build-tmp")
    os.makedirs(tmp, exist_ok=True)
    for slug, _, fn in OPTIONS:
        svg = os.path.join(HERE, f"{slug}.svg")
        with open(svg, "w") as f:
            f.write(fn())
        render(svg, os.path.join(HERE, f"{slug}.png"), 1024)
        for s in (32, 16):
            render(svg, os.path.join(tmp, f"{slug}-{s}.png"), s)
    sheet()
    for name in os.listdir(tmp):
        os.remove(os.path.join(tmp, name))
    os.rmdir(tmp)


if __name__ == "__main__":
    main()
