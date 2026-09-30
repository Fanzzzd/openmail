#!/usr/bin/env python3
"""Builds the v2 icon options: SVG masters, PNG exports and a contact sheet.

Run: python3 docs/design/icon-options-v2/build.py
Needs rsvg-convert and Pillow. Writes only inside this directory.

Every option uses the same construction, mirroring an Icon Composer file:
  background layer  -> squircle fill, soft top light, thin rim highlight
  glyph layer(s)    -> frosted glass shapes with a tinted drop shadow
  highlight layer   -> specular edge on the glyph, lit from the top
"""
import math
import os
import subprocess

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = HERE
SIZES = (1024, 512, 128, 64, 32)

# macOS grid: 1024 canvas, 824 body at (100,100), continuous corners
# (superellipse n=3.4 over a 260px corner span, straight edges between),
# the same shape as apps/desktop/build/icon.svg.


def squircle(x=100, y=100, w=824, h=824, r=260, n=3.4, steps=32):
    pts = []
    corners = [
        (x + w - r, y + r, 0),  # top right, angle -90..0
        (x + w - r, y + h - r, 1),
        (x + r, y + h - r, 2),
        (x + r, y + r, 3),
    ]
    starts = [-90, 0, 90, 180]
    for (cx, cy, i) in corners:
        a0 = starts[i]
        for s in range(steps + 1):
            a = math.radians(a0 + 90 * s / steps)
            c, si = math.cos(a), math.sin(a)
            px = cx + r * math.copysign(abs(c) ** (2 / n), c)
            py = cy + r * math.copysign(abs(si) ** (2 / n), si)
            pts.append(f"{px:.1f} {py:.1f}")
    return "M" + " L".join(pts) + " Z"


BODY = squircle()


def rounded_poly(points, radii):
    """Closed polygon with each corner rounded by a quadratic curve."""
    if not isinstance(radii, (list, tuple)):
        radii = [radii] * len(points)
    n = len(points)
    out = []
    for i in range(n):
        p0, p1, p2 = points[i - 1], points[i], points[(i + 1) % n]
        r = radii[i]

        def toward(a, b, d):
            dx, dy = b[0] - a[0], b[1] - a[1]
            L = math.hypot(dx, dy)
            d = min(d, L / 2)
            return (a[0] + dx * d / L, a[1] + dy * d / L)

        a = toward(p1, p0, r)
        b = toward(p1, p2, r)
        out.append((a, p1, b))
    d = f"M{out[0][2][0]:.1f} {out[0][2][1]:.1f}"
    for i in range(1, n + 1):
        a, p, b = out[i % n]
        d += f" L{a[0]:.1f} {a[1]:.1f} Q{p[0]:.1f} {p[1]:.1f} {b[0]:.1f} {b[1]:.1f}"
    return d + " Z"


def rrect(x, y, w, h, r):
    return (
        f"M{x+r} {y} H{x+w-r} A{r} {r} 0 0 1 {x+w} {y+r} V{y+h-r} "
        f"A{r} {r} 0 0 1 {x+w-r} {y+h} H{x+r} A{r} {r} 0 0 1 {x} {y+h-r} "
        f"V{y+r} A{r} {r} 0 0 1 {x+r} {y} Z"
    )


def sparkle(cx, cy, R, k=0.22):
    """Four-point star with concave sides (cubic curves)."""
    pts = [(cx, cy - R), (cx + R, cy), (cx, cy + R), (cx - R, cy)]
    d = f"M{pts[0][0]} {pts[0][1]}"
    for i in range(4):
        a, b = pts[i], pts[(i + 1) % 4]
        c1 = (cx + (a[0] - cx) * k, cy + (a[1] - cy) * k)
        c2 = (cx + (b[0] - cx) * k, cy + (b[1] - cy) * k)
        d += f" C{c1[0]:.1f} {c1[1]:.1f} {c2[0]:.1f} {c2[1]:.1f} {b[0]} {b[1]}"
    return d + " Z"


class Icon:
    def __init__(self):
        self.defs = []
        self.layers = []
        self.n = 0

    def uid(self, p):
        self.n += 1
        return f"{p}{self.n}"

    def grad(self, stops, x1=0, y1=100, x2=0, y2=924):
        gid = self.uid("g")
        s = "".join(
            f'<stop offset="{o}" stop-color="{c}" stop-opacity="{a}"/>' for o, c, a in stops
        )
        self.defs.append(
            f'<linearGradient id="{gid}" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" '
            f'gradientUnits="userSpaceOnUse">{s}</linearGradient>'
        )
        return f"url(#{gid})"

    def radial(self, stops, cx, cy, r, fx=None, fy=None):
        gid = self.uid("r")
        s = "".join(
            f'<stop offset="{o}" stop-color="{c}" stop-opacity="{a}"/>' for o, c, a in stops
        )
        self.defs.append(
            f'<radialGradient id="{gid}" cx="{cx}" cy="{cy}" r="{r}" fx="{fx or cx}" '
            f'fy="{fy or cy}" gradientUnits="userSpaceOnUse">{s}</radialGradient>'
        )
        return f"url(#{gid})"

    def clip(self, d):
        cid = self.uid("c")
        self.defs.append(f'<clipPath id="{cid}"><path d="{d}"/></clipPath>')
        return f"url(#{cid})"

    def blur(self, sd):
        fid = self.uid("f")
        self.defs.append(
            f'<filter id="{fid}" x="-50%" y="-50%" width="200%" height="200%">'
            f'<feGaussianBlur stdDeviation="{sd}"/></filter>'
        )
        return f"url(#{fid})"

    def add(self, s):
        self.layers.append(s)

    # --- layers -----------------------------------------------------------
    def background(self, stops, glow=None, rim=0.35, dark_edge=0.0):
        # Icon drop shadow on the desktop.
        self.add(
            f'<path d="{BODY}" fill="#000" opacity="0.28" transform="translate(0 12)" '
            f'filter="{self.blur(14)}"/>'
        )
        self.add(f'<path d="{BODY}" fill="{self.grad(stops)}"/>')
        body = self.clip(BODY)
        if glow:
            color, a, cx, cy, r = glow
            self.add(
                f'<g clip-path="{body}"><circle cx="{cx}" cy="{cy}" r="{r}" '
                f'fill="{self.radial([(0, color, a), (1, color, 0)], cx, cy, r)}"/></g>'
            )
        if dark_edge:
            self.add(
                f'<g clip-path="{body}"><path d="{BODY}" fill="none" stroke="#000" '
                f'stroke-opacity="{dark_edge}" stroke-width="40" filter="{self.blur(16)}"/></g>'
            )
        # Rim light: inner edge, bright at top, fading down.
        self.add(
            f'<g clip-path="{body}"><path d="{BODY}" fill="none" stroke-width="7" '
            f'stroke="{self.grad([(0, "#fff", rim), (0.35, "#fff", rim * 0.25), (0.8, "#fff", 0.0), (1, "#fff", rim * 0.3)])}"/></g>'
        )

    def shadow(self, d, color="#000", a=0.3, dy=18, sd=20):
        self.add(
            f'<path d="{d}" fill="{color}" opacity="{a}" transform="translate(0 {dy})" '
            f'filter="{self.blur(sd)}"/>'
        )

    def glass(self, d, top="#fff", bottom="#fff", a_top=0.97, a_bot=0.82, y0=300, y1=720,
              rim=0.9, rim_w=8, spec=0.55, spec_at=None, shade=None, extra=""):
        cid = self.clip(d)
        fill = self.grad([(0, top, a_top), (1, bottom, a_bot)], 0, y0, 0, y1)
        self.add(f'<path d="{d}" fill="{fill}" {extra}/>')
        if shade:
            color, a = shade
            self.add(
                f'<g clip-path="{cid}"><rect x="0" y="0" width="1024" height="1024" '
                f'fill="{self.grad([(0, color, 0), (0.55, color, 0), (1, color, a)], 0, y0, 0, y1)}"/></g>'
            )
        if spec and spec_at:
            sx, sy, rx, ry = spec_at
            self.add(
                f'<g clip-path="{cid}"><ellipse cx="{sx}" cy="{sy}" rx="{rx}" ry="{ry}" '
                f'fill="#fff" opacity="{spec}" filter="{self.blur(28)}"/></g>'
            )
        if rim:
            self.add(
                f'<g clip-path="{cid}"><path d="{d}" fill="none" stroke-width="{rim_w * 2}" '
                f'stroke-linejoin="round" stroke="{self.grad([(0, "#fff", rim), (0.5, "#fff", rim * 0.25), (1, "#fff", rim * 0.5)], 0, y0, 0, y1)}"/></g>'
            )

    def svg(self):
        return (
            '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" '
            'viewBox="0 0 1024 1024">\n<defs>\n'
            + "\n".join(self.defs)
            + "\n</defs>\n"
            + "\n".join(self.layers)
            + "\n</svg>\n"
        )


OPTIONS = []


def option(slug, name):
    def wrap(fn):
        OPTIONS.append((slug, name, fn))
        return fn

    return wrap


# Envelope geometry shared by several options.
EX, EY, EW, EH = 202, 302, 620, 430


@option("01-sunrise-glass", "Sunrise glass")
def sunrise():
    """Two frosted layers, the letter and its flap, on a warm gradient."""
    ic = Icon()
    ic.background(
        [(0, "#FFC56E", 1), (0.5, "#FF7B57", 1), (1, "#E0386B", 1)],
        glow=("#FFF4CF", 0.6, 290, 130, 560),
    )
    body = rrect(EX, EY, EW, EH, 78)
    flap = rounded_poly([(EX + 12, EY + 20), (EX + EW - 12, EY + 20), (512, EY + 280)], [74, 74, 70])
    ic.shadow(body, "#8A1238", 0.4, dy=24, sd=26)
    # Backdrop blur: the gradient behind the glass, softened and lifted.
    ic.glass(body, "#FFFFFF", "#FFF4F0", 0.86, 0.74, EY, EY + EH, rim=1.0, spec=0.0,
             shade=("#E0386B", 0.16))
    ic.shadow(flap, "#C0305A", 0.3, dy=16, sd=14)
    ic.glass(flap, "#FFFFFF", "#FFFFFF", 1, 0.94, EY, EY + 280, rim=1.0,
             spec=0.7, spec_at=(400, EY + 50, 200, 50))
    return ic.svg()


@option("02-spark-letter", "Spark letter")
def spark_letter():
    """Pearl background; a violet glass envelope with an AI spark on its corner."""
    ic = Icon()
    ic.background(
        [(0, "#FFFFFF", 1), (1, "#E4E7F1", 1)],
        glow=("#FFFFFF", 0.9, 360, 160, 520), rim=0.9,
    )
    x, y, w, h = 190, 352, 600, 400
    body = rrect(x, y, w, h, 76)
    ic.shadow(body, "#3B2A99", 0.35, dy=28, sd=28)
    ic.glass(body, "#8E7DFF", "#4B3FE0", 1, 1, y, y + h, rim=0.75, rim_w=6,
             spec=0.4, spec_at=(380, y + 40, 240, 50))
    fold = f"M{x + 74} {y + 96} L{x + w / 2} {y + 250} L{x + w - 74} {y + 96}"
    ic.add(
        f'<path d="{fold}" fill="none" stroke="#fff" stroke-opacity="0.96" stroke-width="44" '
        f'stroke-linecap="round" stroke-linejoin="round"/>'
    )
    sp = sparkle(772, 322, 150, 0.24)
    ic.shadow(sp, "#B0550E", 0.35, dy=14, sd=14)
    ic.glass(sp, "#FFD972", "#FF7E3A", 1, 1, 172, 472, rim=0.9, rim_w=5,
             spec=0.6, spec_at=(750, 280, 40, 70))
    return ic.svg()


def card(cx, cy, w, h, r, deg):
    return f'transform="rotate({deg} {cx} {cy})"', rrect(cx - w / 2, cy - h / 2, w, h, r)


@option("03-glass-stack", "Glass stack")
def glass_stack():
    """Two tinted glass letters overlap; where they cross, the colours mix."""
    ic = Icon()
    ic.background(
        [(0, "#2C3160", 1), (0.6, "#1A1C3D", 1), (1, "#101126", 1)],
        glow=("#6C7BFF", 0.35, 330, 150, 560), rim=0.4,
    )
    w, h, r = 540, 370, 72
    t1, back = card(452, 452, w, h, r, -10)
    t2, front = card(540, 610, w, h, r, 0)
    ic.add(f'<g {t1}><path d="{back}" fill="#000" opacity="0.35" transform="translate(0 20)" filter="{ic.blur(22)}"/></g>')
    ic.add(f'<g {t1}><path d="{back}" fill="{ic.grad([(0, "#5EE7FF", 1), (1, "#3B82F6", 1)], 0, 245, 0, 615)}" opacity="0.92"/></g>')
    ic.add(f'<g {t1}><path d="{back}" fill="none" stroke="#fff" stroke-opacity="0.55" stroke-width="5"/></g>')
    ic.shadow(front, "#000", 0.35, dy=22, sd=24)
    ic.glass(front, "#FF8FD0", "#8B5CF6", 0.82, 0.86, 425, 795, rim=0.9, rim_w=5,
             spec=0.45, spec_at=(460, 445, 220, 36))
    x0, y0 = 540 - w / 2, 610 - h / 2
    fold = f"M{x0 + 66} {y0 + 82} L540 {y0 + 222} L{x0 + w - 66} {y0 + 82}"
    ic.add(
        f'<path d="{fold}" fill="none" stroke="#fff" stroke-width="40" '
        f'stroke-linecap="round" stroke-linejoin="round"/>'
    )
    return ic.svg()


@option("04-home-tray", "Home tray")
def home_tray():
    """A letter settling into a clear glass tray: mail that lands on your machine."""
    ic = Icon()
    ic.background(
        [(0, "#3BDDB6", 1), (0.5, "#12A58C", 1), (1, "#0A5A60", 1)],
        glow=("#DDFFF3", 0.5, 320, 150, 520),
    )
    lx, ly, lw, lh = 272, 250, 480, 400
    letter = rrect(lx, ly, lw, lh, 52)
    fold = f"M{lx + 62} {ly + 74} L512 {ly + 220} L{lx + lw - 62} {ly + 74}"
    ic.shadow(letter, "#063C3E", 0.35, dy=18, sd=18)
    ic.glass(letter, "#FFFFFF", "#F0FFF9", 1, 0.97, ly, ly + lh, rim=0.8, spec=0)
    ic.add(
        f'<path d="{fold}" fill="none" stroke="#10A088" stroke-width="40" '
        f'stroke-linecap="round" stroke-linejoin="round"/>'
    )
    tray = rounded_poly(
        [(160, 606), (864, 606), (814, 822), (210, 822)],
        [48, 48, 90, 90],
    )
    ic.shadow(tray, "#063C3E", 0.35, dy=24, sd=26)
    # Backdrop: the letter seen through the tray, blurred and tinted.
    tclip = ic.clip(tray)
    ic.add(
        f'<g clip-path="{tclip}" filter="{ic.blur(18)}">'
        f'<path d="{letter}" fill="#fff" opacity="0.9"/></g>'
    )
    ic.glass(tray, "#FFFFFF", "#C8F3E6", 0.5, 0.36, 606, 822, rim=1.0,
             spec=0.6, spec_at=(512, 610, 320, 26), shade=("#0A5A60", 0.25))
    return ic.svg()


@option("05-fold-planes", "Fold planes")
def fold_planes():
    """The squircle is the envelope: a lit flap plane over a deep body plane."""
    ic = Icon()
    ic.background([(0, "#3A7BFF", 1), (1, "#2A2BB0", 1)], rim=0.45)
    clipb = ic.clip(BODY)
    vy = 600
    flap = rounded_poly([(20, 20), (1004, 20), (1004, 120), (512, vy), (20, 120)], [0, 0, 0, 110, 0])
    ic.add(
        f'<g clip-path="{clipb}"><path d="{flap}" fill="#0D0F5C" opacity="0.55" '
        f'transform="translate(0 30)" filter="{ic.blur(28)}"/></g>'
    )
    ic.add(
        f'<g clip-path="{clipb}"><path d="{flap}" '
        f'fill="{ic.grad([(0, "#B4DCFF", 1), (0.6, "#78A6FF", 1), (1, "#5F7DFF", 1)], 0, 100, 0, vy)}"/>'
        f'<ellipse cx="360" cy="140" rx="340" ry="100" fill="#fff" opacity="0.5" filter="{ic.blur(44)}"/>'
        f'</g>'
    )
    # Specular lip along the fold edge, inside the flap.
    fclip = ic.clip(flap)
    ic.add(
        f'<g clip-path="{clipb}"><g clip-path="{fclip}"><path d="{flap}" fill="none" '
        f'stroke="#fff" stroke-opacity="0.6" stroke-width="10"/></g></g>'
    )
    cx, cy = 512, 762
    ic.add(
        f'<circle cx="{cx}" cy="{cy}" r="150" fill="{ic.radial([(0, "#FFFFFF", 0.4), (1, "#FFFFFF", 0)], cx, cy, 150)}"/>'
    )
    sp = sparkle(cx, cy, 96, 0.2)
    ic.shadow(sp, "#0D0F5C", 0.35, dy=10, sd=10)
    ic.glass(sp, "#FFFFFF", "#E1E9FF", 1, 1, cy - 96, cy + 96, rim=0, spec=0)
    return ic.svg()


@option("06-graphite", "Graphite")
def graphite():
    """Dark premium: a machined silver envelope line on graphite, violet rim light."""
    ic = Icon()
    ic.background(
        [(0, "#3B3E48", 1), (0.5, "#1C1E24", 1), (1, "#0C0D10", 1)],
        glow=("#7C6BFF", 0.32, 790, 930, 540), rim=0.55,
    )
    x, y, w, h, sw = 222, 312, 580, 400, 62
    frame = rrect(x, y, w, h, 86)
    fold = f"M{x + 40} {y + 40} L512 {y + 250} L{x + w - 40} {y + 40}"
    frame_clip = ic.clip(rrect(x - 40, y - 40, w + 80, h + 80, 110))
    ic.add(
        f'<g opacity="0.6" transform="translate(0 18)" filter="{ic.blur(18)}">'
        f'<path d="{frame}" fill="none" stroke="#000" stroke-width="{sw}"/>'
        f'<path d="{fold}" fill="none" stroke="#000" stroke-width="{sw}" stroke-linejoin="round" stroke-linecap="round"/></g>'
    )
    metal = ic.grad([(0, "#FFFFFF", 1), (0.3, "#D3D6DF", 1), (0.62, "#8C909C", 1), (1, "#E4E6EE", 1)], 222, 280, 802, 740)
    ic.add(
        f'<g clip-path="{frame_clip}">'
        f'<path d="{frame}" fill="none" stroke="{metal}" stroke-width="{sw}"/>'
        f'<path d="{fold}" fill="none" stroke="{metal}" stroke-width="{sw}" stroke-linejoin="round" stroke-linecap="round"/></g>'
    )
    # Small violet spark: the on-device model.
    sp = sparkle(512, 612, 58, 0.2)
    ic.add(f'<circle cx="512" cy="612" r="110" fill="{ic.radial([(0, "#8C7BFF", 0.55), (1, "#8C7BFF", 0)], 512, 612, 110)}"/>')
    ic.glass(sp, "#E6E0FF", "#A796FF", 1, 1, 554, 670, rim=0, spec=0)
    return ic.svg()


def render(svg_path, png_path, size):
    subprocess.run(
        ["rsvg-convert", "-w", str(size), "-h", str(size), svg_path, "-o", png_path], check=True
    )


def main():
    os.makedirs(os.path.join(OUT, "png"), exist_ok=True)
    sheet_w = 220 * len(OPTIONS)
    sheet = Image.new("RGBA", (sheet_w, 560), (236, 236, 241, 255))
    dark = Image.new("RGBA", (sheet_w, 280), (30, 30, 34, 255))
    sheet.alpha_composite(dark, (0, 280))
    for i, (slug, name, fn) in enumerate(OPTIONS):
        svg_path = os.path.join(OUT, f"{slug}.svg")
        with open(svg_path, "w") as f:
            f.write(fn())
        for s in SIZES:
            render(svg_path, os.path.join(OUT, "png", f"{slug}-{s}.png"), s)
        big = Image.open(os.path.join(OUT, "png", f"{slug}-512.png")).resize((200, 200), Image.LANCZOS)
        small = Image.open(os.path.join(OUT, "png", f"{slug}-32.png"))
        for row in (0, 280):
            sheet.alpha_composite(big, (i * 220 + 10, row + 10))
            sheet.alpha_composite(small, (i * 220 + 94, row + 222))
    sheet.save(os.path.join(OUT, "contact-sheet.png"))
    print("built", len(OPTIONS), "options")


if __name__ == "__main__":
    main()
