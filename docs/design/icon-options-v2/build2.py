#!/usr/bin/env python3
"""Round 2 icon options, each benchmarked against one reference icon.

Run: python3 docs/design/icon-options-v2/build2.py
Reuses the grid and helpers from build.py. Writes r2-*.svg and png/r2-*.png.

What changed from round 1, after studying the macOS 26 system icons:
  - glyph is larger (about 70-80% of the body)
  - glyph glass is milky white at the top and lets the background through
    at the bottom, with a bright refraction line on the lower edge
  - glyph shadows are faint and tinted; depth comes from the glass
  - backgrounds use saturated system-grade colours
"""
import os

from PIL import Image

import build
from build import BODY, Icon, render, rounded_poly, rrect, sparkle

HERE = os.path.dirname(os.path.abspath(__file__))
SIZES = (1024, 512, 128, 64, 32)


def milk(ic, d, y0, y1, bottom_a=0.5, tint="#fff", shadow=("#000", 0.18), extra="",
         top_rim=0.95, bottom_rim=0.7, spec=None):
    """Messages-style glass: opaque white top, translucent bottom."""
    color, a = shadow
    if a:
        ic.shadow(d, color, a, dy=14, sd=22)
    cid = ic.clip(d)
    fill = ic.grad([(0, "#fff", 0.98), (0.45, "#fff", 0.9), (1, tint, bottom_a)], 0, y0, 0, y1)
    ic.add(f'<path d="{d}" fill="{fill}" {extra}/>')
    if spec:
        sx, sy, rx, ry, sa = spec
        ic.add(
            f'<g clip-path="{cid}"><ellipse cx="{sx}" cy="{sy}" rx="{rx}" ry="{ry}" fill="#fff" '
            f'opacity="{sa}" filter="{ic.blur(30)}"/></g>'
        )
    ic.add(
        f'<g clip-path="{cid}"><path d="{d}" fill="none" stroke-width="10" '
        f'stroke="{ic.grad([(0, "#fff", top_rim), (0.3, "#fff", 0.15), (0.7, "#fff", 0.0), (1, "#fff", bottom_rim)], 0, y0, 0, y1)}"/></g>'
    )


def vivid_bg(ic, top, bottom, rim=0.5, glow=0.35):
    ic.background([(0, top, 1), (1, bottom, 1)], glow=("#FFFFFF", glow, 360, 120, 560), rim=rim)


OPTIONS = []


def option(slug, name):
    def wrap(fn):
        OPTIONS.append((slug, name, fn))
        return fn

    return wrap


def envelope(x, y, w, h, r=84):
    body = rrect(x, y, w, h, r)
    flap = rounded_poly([(x + 14, y + 18), (x + w - 14, y + 18), (x + w / 2, y + h * 0.62)],
                        [r * 0.9, r * 0.9, r * 0.9])
    return body, flap


@option("r2-01-o-seal", "o seal")
def o_seal():
    """Benchmark Messages / Games: one big milky glyph on a vivid field.
    The fold ends in a ring, the o of openmail, where a seal would sit."""
    ic = Icon()
    vivid_bg(ic, "#8F6BFF", "#5B2BE0")
    x, y, w, h = 176, 290, 672, 460
    body = rrect(x, y, w, h, 96)
    milk(ic, body, y, y + h, bottom_a=0.55, tint="#E9E2FF", shadow=("#2A0E8C", 0.25),
         spec=(400, y + 20, 260, 50, 0.5))
    cx, cy, R = 512, y + 262, 62
    fold = (f"M{x + 86} {y + 92} L{cx - R * 0.8:.0f} {cy - R * 0.6:.0f} "
            f"M{x + w - 86} {y + 92} L{cx + R * 0.8:.0f} {cy - R * 0.6:.0f}")
    stroke = ic.grad([(0, "#7C55F5", 1), (1, "#5B2BE0", 1)], 0, y + 80, 0, cy + R)
    ic.add(f'<path d="{fold}" fill="none" stroke="{stroke}" stroke-width="38" stroke-linecap="round"/>')
    ic.add(f'<circle cx="{cx}" cy="{cy}" r="{R}" fill="none" stroke="{stroke}" stroke-width="38"/>')
    return ic.svg()


@option("r2-02-glass-flap", "Glass flap")
def glass_flap():
    """Benchmark Shortcuts: two coloured glass layers, colours mix where they overlap."""
    ic = Icon()
    ic.background([(0, "#2A2466", 1), (0.6, "#1B1646", 1), (1, "#120E30", 1)],
                  glow=("#7E6BFF", 0.35, 360, 140, 560), rim=0.35)
    x, y, w, h = 190, 330, 644, 440
    body = rrect(x, y, w, h, 96)
    flap = rounded_poly([(x, y), (x + w, y), (512, y + 300)], [96, 96, 90])
    ic.shadow(body, "#05030F", 0.45, dy=24, sd=28)
    ic.add(f'<path d="{body}" fill="{ic.grad([(0, "#3FA2FF", 0.95), (1, "#3A5BFF", 0.95)], 0, y, 0, y + h)}"/>')
    # Flap: pink glass, translucent so the blue shows through and turns violet.
    ic.shadow(flap, "#05030F", 0.18, dy=10, sd=14)
    ic.add(f'<path d="{flap}" fill="{ic.grad([(0, "#FF9BD2", 0.9), (1, "#FF4FB0", 0.6)], 0, y, 0, y + 300)}"/>')
    for d, y0, y1 in ((body, y, y + h), (flap, y, y + 300)):
        cid = ic.clip(d)
        ic.add(
            f'<g clip-path="{cid}"><path d="{d}" fill="none" stroke-width="10" '
            f'stroke="{ic.grad([(0, "#fff", 0.85), (0.4, "#fff", 0.1), (1, "#fff", 0.45)], 0, y0, 0, y1)}"/></g>'
        )
    cid = ic.clip(flap)
    ic.add(f'<g clip-path="{cid}"><ellipse cx="420" cy="{y + 10}" rx="240" ry="50" fill="#fff" '
           f'opacity="0.45" filter="{ic.blur(30)}"/></g>')
    return ic.svg()


@option("r2-03-lens", "Lens")
def lens():
    """Benchmark Image Playground: a clear glass lens with a coloured rim, holding a letter.
    On-device AI that reads your mail."""
    ic = Icon()
    ic.background([(0, "#2B2C33", 1), (0.5, "#17181D", 1), (1, "#0B0B0E", 1)], rim=0.45)
    cx, cy, R = 512, 512, 318
    disc = f"M{cx - R} {cy} A{R} {R} 0 1 1 {cx + R} {cy} A{R} {R} 0 1 1 {cx - R} {cy} Z"
    dclip = ic.clip(disc)
    ic.add(f'<path d="{disc}" fill="#000" opacity="0.5" transform="translate(0 20)" filter="{ic.blur(26)}"/>')
    ic.add(f'<path d="{disc}" fill="{ic.radial([(0, "#3A3D4E", 1), (0.75, "#22232E", 1), (1, "#3A3550", 1)], cx, cy - 60, R + 60)}"/>')
    # Coloured refraction around the rim: blurred arcs inside the disc.
    arcs = [("#FF7A45", -150, -60), ("#FF4FA3", -60, 20), ("#8B5CF6", 20, 110), ("#3AA0FF", 110, 200)]
    import math
    for color, a0, a1 in arcs:
        p0 = (cx + R * math.cos(math.radians(a0)), cy + R * math.sin(math.radians(a0)))
        p1 = (cx + R * math.cos(math.radians(a1)), cy + R * math.sin(math.radians(a1)))
        ic.add(
            f'<g clip-path="{dclip}"><path d="M{p0[0]:.1f} {p0[1]:.1f} A{R} {R} 0 0 1 {p1[0]:.1f} {p1[1]:.1f}" '
            f'fill="none" stroke="{color}" stroke-width="90" stroke-linecap="round" opacity="0.9" filter="{ic.blur(26)}"/></g>'
        )
    # Letter inside, magnified.
    x, y, w, h = 292, 372, 440, 296
    body = rrect(x, y, w, h, 64)
    milk(ic, body, y, y + h, bottom_a=0.7, tint="#EDE7FF", shadow=("#000", 0.35), top_rim=0.9, bottom_rim=0.6)
    fold = f"M{x + 62} {y + 70} L512 {y + 184} L{x + w - 62} {y + 70}"
    ic.add(f'<path d="{fold}" fill="none" stroke="#6D4AE8" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>')
    # Glass surface: rim line and a top-left specular crescent.
    ic.add(f'<g clip-path="{dclip}"><path d="{disc}" fill="none" stroke-width="10" '
           f'stroke="{ic.grad([(0, "#fff", 0.9), (0.5, "#fff", 0.2), (1, "#fff", 0.6)], 0, cy - R, 0, cy + R)}"/></g>')
    ic.add(f'<g clip-path="{dclip}"><ellipse cx="{cx - 90}" cy="{cy - R + 60}" rx="200" ry="56" fill="#fff" '
           f'opacity="0.28" filter="{ic.blur(22)}"/></g>')
    return ic.svg()


@option("r2-04-bleed", "Bleed")
def bleed():
    """Benchmark Bear: one oversized glyph cropped by the icon edge. Confident, no frame."""
    ic = Icon()
    vivid_bg(ic, "#FF8A3D", "#F2432E", glow=0.3)
    clipb = ic.clip(BODY)
    x, y, w, h = 150, 318, 724, 700
    body = rrect(x, y, w, h, 120)
    ic.add(f'<g clip-path="{clipb}"><g>')
    milk(ic, body, y, y + h, bottom_a=0.6, tint="#FFE6DC", shadow=("#9A1B10", 0.3),
         spec=(420, y + 30, 300, 60, 0.5))
    fold = f"M{x + 110} {y + 120} L{x + w / 2} {y + 360} L{x + w - 110} {y + 120}"
    ic.add(f'<path d="{fold}" fill="none" stroke="{ic.grad([(0, "#FF7A3A", 1), (1, "#F2432E", 1)], 0, y, 0, y + 380)}" '
           f'stroke-width="54" stroke-linecap="round" stroke-linejoin="round"/>')
    ic.add('</g></g>')
    return ic.svg()


@option("r2-05-spark-fold", "Spark fold")
def spark_fold():
    """Benchmark Reminders / Photos (light field) and Apple Intelligence colours:
    a white icon, the fold drawn as one gradient stroke that ends in a spark."""
    ic = Icon()
    ic.background([(0, "#FFFFFF", 1), (1, "#EEF0F6", 1)], glow=("#FFFFFF", 0.9, 360, 150, 520), rim=0.9)
    x, y, w, h = 196, 318, 632, 440
    body = rrect(x, y, w, h, 96)
    grad = ic.grad([(0, "#FF8A3D", 1), (0.35, "#FF4FA3", 1), (0.7, "#8B5CF6", 1), (1, "#3A7BFF", 1)], x, y, x + w, y + h)
    ic.shadow(body, "#6B4BD8", 0.22, dy=18, sd=26)
    ic.add(f'<path d="{body}" fill="#fff"/>')
    ic.add(f'<path d="{body}" fill="none" stroke="{grad}" stroke-width="44"/>')
    ax, ay, R = 512, y + 250, 96
    fold = f"M{x + 24} {y + 26} L{ax - 62} {ay - 50} M{x + w - 24} {y + 26} L{ax + 62} {ay - 50}"
    ic.add(f'<path d="{fold}" fill="none" stroke="{grad}" stroke-width="44" stroke-linecap="round"/>')
    sp = sparkle(ax, ay, R, 0.3)
    ic.add(f'<path d="{sp}" fill="{ic.grad([(0, "#FF4FA3", 1), (1, "#8B5CF6", 1)], ax - R, ay - R, ax + R, ay + R)}"/>')
    return ic.svg()


@option("r2-06-obsidian", "Obsidian glass")
def obsidian():
    """Benchmark Passwords / Linear / Ghostty: dark field, one lit glass object."""
    ic = Icon()
    ic.background([(0, "#34363F", 1), (0.5, "#1A1B20", 1), (1, "#0C0C0F", 1)],
                  glow=("#9A8CFF", 0.2, 512, 980, 520), rim=0.55)
    x, y, w, h = 186, 300, 652, 450
    body, flap = envelope(x, y, w, h, 96)
    ic.shadow(body, "#000", 0.6, dy=24, sd=26)
    ic.add(f'<path d="{body}" fill="{ic.grad([(0, "#E9E6FF", 0.22), (1, "#8C7BFF", 0.18)], 0, y, 0, y + h)}"/>')
    cid = ic.clip(body)
    ic.add(f'<g clip-path="{cid}"><path d="{body}" fill="none" stroke-width="12" '
           f'stroke="{ic.grad([(0, "#fff", 0.95), (0.4, "#fff", 0.2), (1, "#B7A9FF", 0.8)], 0, y, 0, y + h)}"/></g>')
    ic.shadow(flap, "#000", 0.45, dy=16, sd=16)
    milk(ic, flap, y, y + h * 0.62, bottom_a=0.85, tint="#D9D2FF", shadow=("#000", 0),
         spec=(420, y + 30, 220, 40, 0.6), bottom_rim=0.9)
    return ic.svg()


def main():
    os.makedirs(os.path.join(HERE, "png"), exist_ok=True)
    n = len(OPTIONS)
    sheet = Image.new("RGBA", (220 * n, 560), (236, 236, 241, 255))
    sheet.alpha_composite(Image.new("RGBA", (220 * n, 280), (30, 30, 34, 255)), (0, 280))
    for i, (slug, name, fn) in enumerate(OPTIONS):
        svg_path = os.path.join(HERE, f"{slug}.svg")
        with open(svg_path, "w") as f:
            f.write(fn())
        for s in SIZES:
            render(svg_path, os.path.join(HERE, "png", f"{slug}-{s}.png"), s)
        big = Image.open(os.path.join(HERE, "png", f"{slug}-512.png")).resize((200, 200), Image.LANCZOS)
        small = Image.open(os.path.join(HERE, "png", f"{slug}-32.png"))
        for row in (0, 280):
            sheet.alpha_composite(big, (i * 220 + 10, row + 10))
            sheet.alpha_composite(small, (i * 220 + 94, row + 222))
    sheet.save(os.path.join(HERE, "contact-sheet-r2.png"))
    print("built", n, "round 2 options")


if __name__ == "__main__":
    main()
