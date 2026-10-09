#!/usr/bin/env python3
"""Round 7: the dev icon. The prod mark on Apple-style blueprint paper.

Run: python3 docs/design/icon-options-v2/build7.py [--final]
Needs Xcode 26 (Icon Composer's ictool), shapely and Pillow.

Unpackaged runs show this icon in the Dock, so a dev instance never looks
like the installed app. The mark and its glass settings are the prod ones
from build6.py. Only the paper changes: a blue gradient with a thin grid,
like Xcode's and the Developer app's blueprint backdrop. No text: the
blueprint itself says "dev".

Without flags it renders the variants to /tmp/om-icon2/v-*.png. With
--final it writes apps/desktop/build/icon-dev.icon, which render-icons.sh
renders to icon-dev.png.
"""
import os
import shutil
import sys

from PIL import Image
from shapely.geometry import Point, box
from shapely.ops import unary_union

from build3 import ictool, on_grid, solid, vgrad, write_bundle
from build5 import svg_of
from build6 import FINAL, flap_o, grp, layer

HERE = os.path.dirname(os.path.abspath(__file__))
APP_BUILD = os.path.abspath(os.path.join(HERE, "..", "..", "..", "apps", "desktop", "build"))
OUT = "/tmp/om-icon2"


def grid(cells, major_every, minor_w, major_w):
    """Grid lines on the full-bleed 1024 canvas, centred on 512.

    Returns (minor, major) so each set can get its own opacity. Lines are
    filled boxes because Icon Composer layers are filled shapes."""
    step = 1024 / cells
    minor, major = [], []
    for i in range(cells + 1):
        p = i * step
        is_major = (i - cells // 2) % major_every == 0
        w = major_w if is_major else minor_w
        lines = (box(p - w / 2, 0, p + w / 2, 1024), box(0, p - w / 2, 1024, p + w / 2))
        (major if is_major else minor).extend(lines)
    major_u = unary_union(major)
    return unary_union(minor).difference(major_u), major_u


def construction(w=2.5):
    """Faint drafting marks: one circle around the mark, and a dimension
    line with end and centre ticks along the top and left edges."""
    r = 400
    circle = Point(512, 512).buffer(r + w / 2, quad_segs=64).difference(
        Point(512, 512).buffer(r - w / 2, quad_segs=64))
    a, b, at, tick = 220, 804, 96, 22
    parts = [
        circle,
        box(a, at - w / 2, b, at + w / 2),
        box(at - w / 2, a, at + w / 2, b),
    ]
    for p, t in ((a, tick), (b, tick), (512, tick * 0.6)):
        parts.append(box(p - w / 2, at - t, p + w / 2, at + t))
        parts.append(box(at - t, p - w / 2, at + t, p + w / 2))
    # Minor ticks every 1/8 between the ends.
    for i in range(1, 8):
        if i == 4:
            continue
        p = a + (b - a) * i / 8
        parts.append(box(p - w / 2, at - tick * 0.35, p + w / 2, at + tick * 0.35))
        parts.append(box(at - tick * 0.35, p - w / 2, at + tick * 0.35, p + w / 2))
    return unary_union(parts)


def flat_layer(name, opacity):
    return {"name": name, "image-name": f"{name}.svg", "glass": False,
            "opacity": opacity, "fill-specializations": [{"value": solid("#E8F0FF")}]}


def build(top, bottom, cells, major_every, minor_a, major_a, marks_a=0.0,
          minor_w=2.0, major_w=3.2):
    minor, major = grid(cells, major_every, minor_w, major_w)
    shapes = {"minor": svg_of(minor), "major": svg_of(major)}
    paper = [flat_layer("major", major_a), flat_layer("minor", minor_a)]
    if marks_a:
        shapes["marks"] = svg_of(construction())
        paper.insert(0, flat_layer("marks", marks_a))
    frame, wedge = flap_o(**FINAL)
    shapes["mark"] = svg_of(unary_union([frame, wedge]))
    # Same mark group as prod's icon.icon; the paper group sits under it
    # without glass, shadow or specular so the lines stay thin and flat.
    groups = [
        grp("mark", [layer("mark", "#FFFFFF")]),
        grp("paper", paper, glass=False),
    ]
    return {"fill": vgrad(top, bottom), "groups": groups}, shapes


VARIANTS = {
    # Deep blue from the brief, fine 32-cell grid, major every 4.
    "a-deep-fine": dict(top="#1E5BD8", bottom="#123E9C", cells=32, major_every=4,
                        minor_a=0.10, major_a=0.22),
    # Xcode-like brighter blue, coarse 16-cell grid, construction marks.
    "b-bright-coarse-marks": dict(top="#2B8CF5", bottom="#1656D6", cells=16, major_every=4,
                                  minor_a=0.14, major_a=0.26, marks_a=0.16),
    # Deep blue, 20-cell grid, major every 5, construction marks.
    "c-deep-20-marks": dict(top="#1E5BD8", bottom="#123E9C", cells=20, major_every=5,
                            minor_a=0.12, major_a=0.24, marks_a=0.16),
    # C refined: ictool's lighting washes the fill toward periwinkle, so the
    # input blue is deeper and more saturated, with a stronger gradient. The
    # minor grid drops back so the major lines carry the hierarchy.
    "d-refined": dict(top="#0B57E6", bottom="#062C8C", cells=20, major_every=5,
                      minor_a=0.10, major_a=0.26, marks_a=0.18),
}

# Chosen after the comparison sheets: C's paper, refined as D.
FINAL_DEV = VARIANTS["d-refined"]


def render(slug, spec, out):
    manifest, shapes = build(**spec)
    bundle = write_bundle(f"_{slug}", manifest, shapes)
    raw = os.path.join(OUT, f"_{slug}-raw.png")
    ictool(bundle, raw, "Default")
    on_grid(Image.open(raw)).save(out)
    shutil.rmtree(bundle)
    os.remove(raw)


def write_final():
    manifest, shapes = build(**FINAL_DEV)
    bundle = write_bundle("_icon-dev", manifest, shapes)
    target = os.path.join(APP_BUILD, "icon-dev.icon")
    shutil.rmtree(target, ignore_errors=True)
    shutil.move(bundle, target)
    # oxfmt wants the trailing newline that json.dump leaves out.
    with open(os.path.join(target, "icon.json"), "a") as f:
        f.write("\n")
    print("wrote", target)


def main():
    if "--final" in sys.argv:
        write_final()
        return
    os.makedirs(OUT, exist_ok=True)
    for slug, spec in VARIANTS.items():
        render(slug, spec, os.path.join(OUT, f"v-{slug}.png"))
        print("rendered", slug)


if __name__ == "__main__":
    main()
