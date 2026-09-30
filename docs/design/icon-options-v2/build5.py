#!/usr/bin/env python3
"""Round 5: marks that read as mail AND as openmail.

Run: python3 docs/design/icon-options-v2/build5.py   (needs Xcode 26 and shapely)

Reference: opencode's app icon. One letterform (a square o) is the whole
mark; sharp, bold geometry; monochrome; one small detail inside the counter
carries the meaning. Here the same discipline is applied to mail: every
mark combines a mail sign (flap, envelope, postmark, stamp, @) with the o.

Geometry is built with shapely (unions, differences, buffered strokes) and
written as flat SVG layers; Apple's ictool adds the Liquid Glass material.
"""
import math
import os

from PIL import Image
from shapely import affinity
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union

from build3 import group, ictool, layer, on_grid, solid, vgrad, write_bundle

HERE = os.path.dirname(os.path.abspath(__file__))
SIZES = (1024, 512, 128, 64, 32)

INK = "#141416"
PAPER = "#FFFFFF"
CORAL = "#FF5A3C"

MITRE, ROUND = 2, 1


def path_of(geom):
    def ring(coords):
        return "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in list(coords)[:-1]) + " Z"
    polys = getattr(geom, "geoms", [geom])
    out = []
    for p in polys:
        if p.is_empty:
            continue
        out.append(ring(p.exterior.coords))
        out.extend(ring(i.coords) for i in p.interiors)
    return " ".join(out)


def svg_of(geom):
    return ('<svg width="1024" height="1024" viewBox="0 0 1024 1024" '
            'xmlns="http://www.w3.org/2000/svg">'
            f'<path d="{path_of(geom)}" fill="#fff" fill-rule="evenodd"/></svg>')


def stroke(points, w, join=ROUND, cap=ROUND):
    return LineString(points).buffer(w / 2, join_style=join, cap_style=cap, quad_segs=24,
                                      mitre_limit=10)


def rbox(x0, y0, x1, y1, r):
    return box(x0 + r, y0 + r, x1 - r, y1 - r).buffer(r, quad_segs=24)


def disc(cx, cy, r):
    return Point(cx, cy).buffer(r, quad_segs=64)


def ring(cx, cy, r, w):
    return disc(cx, cy, r + w / 2).difference(disc(cx, cy, r - w / 2))


# Palettes. Light options keep a black mark but flip it to white in the dark
# rendition, so the mark never disappears on the dark Dock tile.
def on_dark(fill_top="#26272C", fill_bottom="#0E0E11"):
    return vgrad(fill_top, fill_bottom), solid(PAPER), None


def on_light():
    return vgrad("#FFFFFF", "#EFEFF3"), solid(INK), solid("#F4F4F6")


def on_colour(top, bottom):
    return vgrad(top, bottom), solid(PAPER), None


OPTIONS = []


def option(slug, name, idea):
    def wrap(fn):
        OPTIONS.append((slug, name, idea, fn))
        return fn
    return wrap


def simple(mark, palette, accent=None, accent_fill=None, glass_t=0.1):
    """One mark layer, optional accent layer on top."""
    fill, mark_fill, mark_dark = palette
    groups, shapes = [], {}
    if accent is not None:
        shapes["accent"] = svg_of(accent)
        groups.append(group("accent", [layer("accent", accent_fill)], shadow="layer-color",
                            shadow_a=0.4))
    shapes["mark"] = svg_of(mark)
    groups.append(group("mark", [layer("mark", mark_fill, dark_fill=mark_dark)], shadow_a=0.4,
                        translucency=glass_t))
    return {"fill": fill, "groups": groups}, shapes


# ---------------------------------------------------------------------------

@option("r5-01-flap-o", "Flap o",
        "opencode 式的方形 o，内洞顶边折成 V。o 的内洞就是一只信封。")
def flap_o():
    outer = box(197, 237, 827, 787)
    counter = Polygon([(337, 377), (512, 497), (687, 377), (687, 647), (337, 647)])
    return simple(outer.difference(counter), on_dark())


@option("r5-04-talk-mail", "Talk mail",
        "信封形状的对话气泡，左下角带一个尾巴。邮件加 AI 对话。")
def talk_mail():
    body = rbox(172, 232, 852, 712, 96)
    tail = Polygon([(262, 650), (400, 690), (230, 842)]).buffer(18, quad_segs=12)
    fold = stroke([(190, 262), (512, 520), (834, 262)], 64)
    return simple(unary_union([body, tail]).difference(fold), on_colour("#FF7A55", "#EE3F2C"))


@option("r5-06-seal-line", "Seal line",
        "实心信封，折线的尖端收成一个圆环。折线加 o，封口处就是品牌。")
def seal_line():
    body = rbox(162, 262, 862, 762, 92)
    cx, cy, r = 512, 552, 74
    legs = unary_union([stroke([(150, 250), (cx - r * 0.72, cy - r * 0.72)], 60, cap=2),
                        stroke([(874, 250), (cx + r * 0.72, cy - r * 0.72)], 60, cap=2)])
    cut = unary_union([legs, ring(cx, cy, r, 60)])
    return simple(body.difference(cut), on_colour("#3552FF", "#1B2AB8"))


@option("r5-08-pixel-mail", "Pixel mail",
        "8-bit 像素信封，折线是台阶。opencode 的像素语言直接用在信封上。")
def pixel_mail():
    u = 62
    x0, y0 = 512 - 5.5 * u, 512 - 4 * u
    cells = []
    cols, rows = 11, 8
    for c in range(cols):
        cells.append((c, 0))
        cells.append((c, rows - 1))
    for r in range(rows):
        cells.append((0, r))
        cells.append((cols - 1, r))
    for i in range(1, 5):
        cells.append((i, i))
        cells.append((cols - 1 - i, i))
    cells.append((5, 5))
    g = unary_union([box(x0 + c * u, y0 + r * u, x0 + (c + 1) * u, y0 + (r + 1) * u)
                     for c, r in set(cells)])
    return simple(g, on_dark())


@option("r5-10-postmark", "Postmark",
        "邮戳：一个圆环加三道波浪线。圆环是 o，邮戳是只有邮件才有的记号。")
def postmark():
    o = ring(372, 512, 150, 92)
    waves = []
    for dy in (-110, 0, 110):
        pts = []
        for i in range(61):
            x = 470 + i * (380 / 60)
            pts.append((x, 512 + dy + 26 * math.sin((x - 470) / 380 * 2 * math.pi * 1.5)))
        waves.append(stroke(pts, 50))
    waves = unary_union(waves).difference(disc(372, 512, 200))
    return simple(unary_union([o, waves]), on_light())


@option("r5-11-stamp", "Stamp",
        "邮票：珊瑚色齿孔方块，中间镂空一个 Flap o 标记。")
def stamp():
    x0, y0, x1, y1 = 202, 202, 822, 822
    s = box(x0, y0, x1, y1)
    holes = []
    n = 9
    for i in range(n + 1):
        t = x0 + (x1 - x0) * i / n
        for (cx, cy) in ((t, y0), (t, y1), (x0, t), (x1, t)):
            holes.append(disc(cx, cy, 26))
    s = s.difference(unary_union(holes))
    outer = box(342, 362, 682, 662)
    counter = Polygon([(412, 432), (512, 500), (612, 432), (612, 592), (412, 592)])
    o = outer.difference(counter)
    return (
        {"fill": vgrad("#FFFFFF", "#EFEFF3"),
         "groups": [group("stamp", [layer("stamp", solid(CORAL))], shadow="layer-color", shadow_a=0.4,
                          translucency=0.1)]},
        {"stamp": svg_of(s.difference(o))})


@option("r5-14-draft-cursor", "Draft cursor",
        "像素信封，右下角一个珊瑚色光标方块：AI 在帮你起草。")
def draft_cursor():
    u = 62
    x0, y0 = 512 - 5.5 * u, 512 - 4 * u
    cols, rows = 11, 8
    cells = set()
    for c in range(cols):
        cells |= {(c, 0), (c, rows - 1)}
    for r in range(rows):
        cells |= {(0, r), (cols - 1, r)}
    for i in range(1, 5):
        cells |= {(i, i), (cols - 1 - i, i)}
    cells.add((5, 5))
    g = unary_union([box(x0 + c * u, y0 + r * u, x0 + (c + 1) * u, y0 + (r + 1) * u) for c, r in cells])
    cur = box(x0 + 8 * u, y0 + 5 * u, x0 + 9 * u, y0 + 7 * u)
    return simple(g, on_dark(), accent=cur, accent_fill=solid(CORAL))


@option("r5-15-airmail-o", "Airmail o",
        "方形 o 的边框画成航空信封的红蓝斜条纹。条纹是邮件，形状是 o。")
def airmail_o():
    frame = box(212, 212, 812, 812).difference(box(362, 362, 662, 662))
    stripes_red, stripes_blue = [], []
    step = 92
    for i in range(-12, 14):
        x = i * step
        band = Polygon([(x, 0), (x + step / 2, 0), (x + step / 2 - 1024, 1024), (x - 1024, 1024)])
        band = affinity.translate(band, 512, 0)
        (stripes_red if i % 2 == 0 else stripes_blue).append(band)
    red = frame.intersection(unary_union(stripes_red))
    blue = frame.intersection(unary_union(stripes_blue))
    return ({"fill": vgrad("#FFFFFF", "#EFEFF3"),
             "groups": [group("stripes", [layer("red", solid(CORAL)), layer("blue", solid("#2F4BFF"))],
                              shadow_a=0.35, translucency=0.05)]},
            {"red": svg_of(red), "blue": svg_of(blue)})


def pixels(rows, u, cx=512, cy=512):
    h, w = len(rows), len(rows[0])
    x0, y0 = cx - w * u / 2, cy - h * u / 2
    return unary_union([box(x0 + c * u, y0 + r * u, x0 + (c + 1) * u, y0 + (r + 1) * u)
                        for r, row in enumerate(rows) for c, ch in enumerate(row) if ch == "#"])


def flap_o_geom(x0, y0, x1, y1, t, dip):
    outer = box(x0, y0, x1, y1)
    ix0, iy0, ix1, iy1 = x0 + t, y0 + t, x1 - t, y1 - t
    counter = Polygon([(ix0, iy0), ((ix0 + ix1) / 2, iy0 + dip), (ix1, iy0), (ix1, iy1), (ix0, iy1)])
    return outer.difference(counter)


@option("r5-18-flap-o-coral", "Flap o, coral",
        "Flap o 反白在珊瑚色底上，珊瑚色作为品牌色。")
def flap_o_coral():
    return simple(flap_o_geom(197, 237, 827, 787, 140, 120), on_colour("#FF7A55", "#EE3F2C"))


@option("r5-19-pixel-at", "Pixel @",
        "opencode 的像素字体写一个 @。@ 是邮件本身的符号，像素让它有 open 家族的气质。")
def pixel_at():
    rows = [".######.",
            "#......#",
            "#..###.#",
            "#.#..#.#",
            "#.#..#.#",
            "#..####.",
            "#.......",
            ".######."]
    return simple(pixels(rows, 84), on_dark())


@option("r5-20-pixel-talk", "Pixel talk",
        "像素对话气泡，里面一道像素折线。邮件加 AI 对话，像素语言。")
def pixel_talk():
    rows = ["###########",
            "##.......##",
            "#.#.....#.#",
            "#..#...#..#",
            "#...#.#...#",
            "#....#....#",
            "#.........#",
            "###########",
            "..###......",
            "..##.......",
            "..#........"]
    return simple(pixels(rows, 64, cy=520), on_colour("#3552FF", "#1B2AB8"))


@option("r5-21-stamp-night", "Stamp, night",
        "白色齿孔邮票在近黑底上，中间镂空 Flap o。")
def stamp_night():
    x0, y0, x1, y1 = 202, 202, 822, 822
    st = box(x0, y0, x1, y1)
    holes = []
    n = 9
    for i in range(n + 1):
        t = x0 + (x1 - x0) * i / n
        for (cx, cy) in ((t, y0), (t, y1), (x0, t), (x1, t)):
            holes.append(disc(cx, cy, 26))
    st = st.difference(unary_union(holes)).difference(flap_o_geom(342, 362, 682, 662, 70, 68))
    return simple(st, on_dark())


def main():
    os.makedirs(os.path.join(HERE, "png"), exist_ok=True)
    tmp = "/tmp/openmail-r5"
    os.makedirs(tmp, exist_ok=True)
    for slug, name, idea, fn in OPTIONS:
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
