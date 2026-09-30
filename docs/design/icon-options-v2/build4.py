#!/usr/bin/env python3
"""Round 4: an ownable openmail mark instead of a generic envelope.

Run: python3 docs/design/icon-options-v2/build4.py   (needs Xcode 26)

Benchmarks: Plany, Notion, Tailscale. What they share: a brand mark rather
than a metaphor, a glyph 65-75% of the body width, one or two colours, and
geometry simple enough to read at 32px. Every option here is built on the
letter o, rendered through Apple's ictool like round 3.
"""
import math
import os

from PIL import Image

from build3 import group, ictool, layer, on_grid, solid, vgrad, write_bundle

HERE = os.path.dirname(os.path.abspath(__file__))
SIZES = (1024, 512, 128, 64, 32)


def svg_raw(body):
    return ('<svg width="1024" height="1024" viewBox="0 0 1024 1024" '
            f'xmlns="http://www.w3.org/2000/svg">{body}</svg>')


def arc_band(cx, cy, r, w, a0, a1):
    """Filled ring segment from angle a0 to a1 (degrees, clockwise from +x),
    with round caps. Returned as a closed path so glass sees one shape."""
    ro, ri = r + w / 2, r - w / 2
    large = 1 if (a1 - a0) % 360 > 180 else 0
    p = lambda rad, a: (cx + rad * math.cos(math.radians(a)), cy + rad * math.sin(math.radians(a)))
    o0, o1 = p(ro, a0), p(ro, a1)
    i1, i0 = p(ri, a1), p(ri, a0)
    cap = w / 2
    return (
        f"M{o0[0]:.1f} {o0[1]:.1f} A{ro} {ro} 0 {large} 1 {o1[0]:.1f} {o1[1]:.1f} "
        f"A{cap} {cap} 0 0 1 {i1[0]:.1f} {i1[1]:.1f} "
        f"A{ri} {ri} 0 {large} 0 {i0[0]:.1f} {i0[1]:.1f} "
        f"A{cap} {cap} 0 0 1 {o0[0]:.1f} {o0[1]:.1f} Z"
    )


def circle(cx, cy, r):
    return f"M{cx - r} {cy} A{r} {r} 0 1 1 {cx + r} {cy} A{r} {r} 0 1 1 {cx - r} {cy} Z"


OPTIONS = []


def option(slug, name):
    def wrap(fn):
        OPTIONS.append((slug, name, fn))
        return fn
    return wrap


# The badge o: a heavy o, open at the top right, with a dot sitting in the gap.
# Reads as the letter o and as an unread badge. Shared geometry.
CX, CY, R, W = 494, 530, 250, 160
GAP_CENTER, GAP = -45, 104
BADGE = (CX + R * math.cos(math.radians(GAP_CENTER)), CY + R * math.sin(math.radians(GAP_CENTER)))
BADGE_R = 86


def badge_o_shapes():
    a0 = GAP_CENTER + GAP / 2
    a1 = GAP_CENTER - GAP / 2 + 360
    return {
        "dot": svg_raw(f'<path d="{circle(BADGE[0], BADGE[1], BADGE_R)}" fill="#fff"/>'),
        "ring": svg_raw(f'<path d="{arc_band(CX, CY, R, W, a0, a1)}" fill="#fff"/>'),
    }


@option("r4-01-badge-o", "Badge o")
def badge_o_light():
    """Plany/Notion register: black o on white, the unread badge in coral."""
    manifest = {
        "fill": vgrad("#FFFFFF", "#F1F1F4"),
        "groups": [
            group("dot", [layer("dot", solid("#FF4F3A"))], shadow="layer-color", shadow_a=0.4),
            group("ring", [layer("ring", solid("#141416"), dark_fill=solid("#F4F4F6"))], shadow_a=0.35),
        ],
    }
    return manifest, badge_o_shapes()


@option("r4-02-badge-o-coral", "Badge o, coral")
def badge_o_coral():
    """The same mark reversed out of a signature coral field."""
    manifest = {
        "fill": vgrad("#FF7A52", "#F2402F"),
        "groups": [
            group("dot", [layer("dot", solid("#FFFFFF"))], shadow_a=0.35),
            group("ring", [layer("ring", solid("#FFFFFF"))], shadow_a=0.35, translucency=0.15),
        ],
    }
    return manifest, badge_o_shapes()


@option("r4-03-badge-o-night", "Badge o, night")
def badge_o_night():
    """Tailscale register: white o on near-black, coral badge."""
    manifest = {
        "fill": vgrad("#2A2B30", "#101013"),
        "groups": [
            group("dot", [layer("dot", solid("#FF5A3C"))], shadow="layer-color", shadow_a=0.5),
            group("ring", [layer("ring", solid("#F4F4F6"))], shadow_a=0.5),
        ],
    }
    return manifest, badge_o_shapes()


def at_o_shapes():
    """Minimal @: an open heavy ring (gap at lower right, where @'s tail would be)
    around a solid core."""
    cx, cy, r, w = 512, 512, 262, 150
    a0, a1 = 40, 360 + 0  # gap from 0 to 40 degrees, lower right
    return {
        "core": svg_raw(f'<path d="{circle(cx, cy, 104)}" fill="#fff"/>'),
        "ring": svg_raw(f'<path d="{arc_band(cx, cy, r, w, a0, a1)}" fill="#fff"/>'),
    }


@option("r4-04-at-o", "At o")
def at_o():
    """Indigo field, white ring, coral core."""
    manifest = {
        "fill": vgrad("#5A5CFF", "#2B22BF"),
        "groups": [
            group("core", [layer("core", solid("#FF6A4D"))], shadow="layer-color", shadow_a=0.45),
            group("ring", [layer("ring", solid("#FFFFFF"))], shadow_a=0.4, translucency=0.1),
        ],
    }
    return manifest, at_o_shapes()


@option("r4-05-at-o-light", "At o, light")
def at_o_light():
    """Plany register: black @ on white, coral core."""
    manifest = {
        "fill": vgrad("#FFFFFF", "#F1F1F4"),
        "groups": [
            group("core", [layer("core", solid("#FF4F3A"))], shadow="layer-color", shadow_a=0.4),
            group("ring", [layer("ring", solid("#141416"), dark_fill=solid("#F4F4F6"))], shadow_a=0.35),
        ],
    }
    return manifest, at_o_shapes()


def poly_path(geom):
    """Shapely polygon (with holes) to an SVG path."""
    def ring(coords):
        pts = list(coords)
        return "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in pts) + " Z"
    polys = getattr(geom, "geoms", [geom])
    return " ".join(ring(p.exterior.coords) + " " + " ".join(ring(i.coords) for i in p.interiors)
                    for p in polys)


def fold_o_path(cx=512, cy=540, r=248, w=156, half=40, dip=118):
    """An o whose top dips into a V: the letter and the envelope fold in one stroke."""
    from shapely.geometry import LinearRing
    a_start, a_end = -90 + half, 270 - half
    pts = []
    for i in range(121):
        a = math.radians(a_start + (a_end - a_start) * i / 120)
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    pts.append((cx, cy - r + dip))
    line = LinearRing(pts)
    shape = line.buffer(w / 2, join_style=1, quad_segs=24)
    return poly_path(shape)


def main():
    os.makedirs(os.path.join(HERE, "png"), exist_ok=True)
    tmp = "/tmp/openmail-r4"
    os.makedirs(tmp, exist_ok=True)
    for slug, name, fn in OPTIONS:
        manifest, shapes = fn()
        bundle = write_bundle(slug, manifest, shapes)
        for rendition, suffix in (("Default", ""), ("Dark", "-dark")):
            raw = os.path.join(tmp, f"{slug}{suffix}.png")
            ictool(bundle, raw, rendition)
            icon = on_grid(Image.open(raw))
            for s in SIZES:
                icon.resize((s, s), Image.LANCZOS).save(
                    os.path.join(HERE, "png", f"{slug}{suffix}-{s}.png"))
        print("rendered", slug)


if __name__ == "__main__":
    main()
