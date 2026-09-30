#!/usr/bin/env python3
"""Round 6: variants of R5-01 Flap o.

Run: python3 docs/design/icon-options-v2/build6.py   (needs Xcode 26, shapely, Pillow)

The mark: an opencode-style square o whose counter is an envelope, the V
fold hanging from the counter's top edge. One parametric generator, varied
along five axes: colour, geometry, size, pixel vs vector, small detail.
Writes r6-*.icon, png/r6-*.png and contact-sheet-r6.png.
"""
import os

from PIL import Image, ImageDraw, ImageFont
from shapely.geometry import Polygon, box
from shapely.ops import unary_union

from build3 import color, ictool, on_grid, solid, vgrad, write_bundle
from build5 import svg_of

HERE = os.path.dirname(os.path.abspath(__file__))
SIZES = (1024, 512, 128, 64, 32)
INK, PAPER, CORAL = "#141416", "#FFFFFF", "#FF5A3C"


def rounded(g, r):
    """Round every convex and concave corner of a shape by r."""
    if r <= 0:
        return g
    return g.buffer(r, join_style=1, quad_segs=16).buffer(-2 * r, join_style=1, quad_segs=16) \
            .buffer(r, join_style=1, quad_segs=16)


def flap_o(size=0.615, aspect=0.873, weight=0.222, dip=0.40, radius=0.0, pixel=0,
           counter_w=1.0, cy=512):
    """Returns (frame, wedge): the square o without the flap, and the flap wedge.

    size: outer width as a fraction of the 1024 body
    aspect: outer height / outer width
    weight: stroke thickness as a fraction of outer width
    dip: V depth as a fraction of the counter height
    radius: outer corner radius as a fraction of outer width
    pixel: stair step in px for the V (0 = smooth)
    counter_w: widen the counter (and the o) horizontally
    """
    w = 1024 * size * counter_w
    h = 1024 * size * aspect
    t = 1024 * size * weight
    x0, y0 = 512 - w / 2, cy - h / 2
    x1, y1 = x0 + w, y0 + h
    ix0, iy0, ix1, iy1 = x0 + t, y0 + t, x1 - t, y1 - t
    depth = (iy1 - iy0) * dip
    outer = box(x0, y0, x1, y1)
    counter = box(ix0, iy0, ix1, iy1)
    if pixel:
        cols = []
        u = pixel
        n = int((ix1 - ix0) // u)
        n -= n % 2
        left = ix0 + ((ix1 - ix0) - n * u) / 2
        cols.append(box(ix0, iy0, left, iy0 + u))
        for i in range(n):
            cxm = left + (i + 0.5) * u
            d = depth * (1 - abs(cxm - (ix0 + ix1) / 2) / ((ix1 - ix0) / 2))
            d = max(u, round(d / u) * u)
            cols.append(box(left + i * u, iy0, left + (i + 1) * u, iy0 + d))
        cols.append(box(left + n * u, iy0, ix1, iy0 + u))
        wedge = unary_union(cols).intersection(counter)
    else:
        wedge = Polygon([(ix0, iy0), (ix1, iy0), ((ix0 + ix1) / 2, iy0 + depth)])
    frame = outer.difference(counter)
    if radius:
        r_out = w * radius
        r_in = max(r_out - t, r_out * 0.25)
        frame = rounded(outer, r_out).difference(rounded(counter, r_in))
        wedge = rounded(wedge, min(r_in, depth * 0.18)).intersection(rounded(counter, r_in))
    return frame, wedge


# Palettes: (background fill, mark colour, mark colour in dark rendition)
PAL = {
    "white-on-black": (vgrad("#26272C", "#0E0E11"), PAPER, None),
    "black-on-white": (vgrad("#FFFFFF", "#EFEFF3"), INK, "#F4F4F6"),
    "white-on-coral": (vgrad("#FF7A55", "#EE3F2C"), PAPER, None),
    "white-on-indigo": (vgrad("#4B4DF5", "#221AAE"), PAPER, None),
}


def layer(name, hexs, dark=None, glass=True):
    specs = [{"value": solid(hexs)}]
    if dark:
        specs.append({"appearance": "dark", "value": solid(dark)})
    return {"name": name, "image-name": f"{name}.svg", "glass": glass, "fill-specializations": specs}


def grp(name, layers, glass=True, shadow_kind="neutral"):
    g = {"name": name, "layers": layers}
    if glass:
        g.update({"shadow": {"kind": shadow_kind, "opacity": 0.4}, "specular": True,
                  "translucency": {"enabled": True, "value": 0.08}})
    else:
        g.update({"shadow": {"kind": "none", "opacity": 0}, "specular": False})
    return g


def build(palette="white-on-black", glass=True, wedge_hex=None, detail=None, **geo):
    fill, mark, mark_dark = PAL[palette]
    frame, wedge = flap_o(**geo)
    shapes, groups = {}, []
    if detail is not None:
        shapes["detail"] = svg_of(detail(frame, wedge))
        groups.append(grp("detail", [layer("detail", CORAL, glass=glass)], glass, "layer-color"))
    if wedge_hex:
        shapes["frame"] = svg_of(frame)
        shapes["wedge"] = svg_of(wedge)
        groups.append(grp("wedge", [layer("wedge", wedge_hex, glass=glass)], glass, "layer-color"))
        groups.append(grp("frame", [layer("frame", mark, mark_dark, glass=glass)], glass))
    else:
        shapes["mark"] = svg_of(unary_union([frame, wedge]))
        groups.append(grp("mark", [layer("mark", mark, mark_dark, glass=glass)], glass))
    return {"fill": fill, "groups": groups}, shapes


def cursor_block(frame, wedge):
    """opencode's cursor: a small block in the counter's lower right."""
    minx, miny, maxx, maxy = frame.bounds
    t = (maxx - minx) * 0.222
    ix1, iy1 = maxx - t, maxy - t
    u = t * 0.42
    return box(ix1 - u * 1.9, iy1 - u * 2.2, ix1 - u * 0.9, iy1 - u * 0.5)


def unread_corner(frame, wedge):
    """A coral square on the outer top-right corner, like an unread badge."""
    minx, miny, maxx, maxy = frame.bounds
    s = (maxx - minx) * 0.2
    return box(maxx - s * 0.62, miny - s * 0.38, maxx + s * 0.38, miny + s * 0.62)


# (slug, axis, name, one line, kwargs)
OPTIONS = [
    # Colour and material
    ("r6-01-base", "颜色与材质", "Base", "R5-01 原样：白色标记，近黑底，Liquid Glass。", {}),
    ("r6-02-ink", "颜色与材质", "Ink", "白底黑标，Plany 和 Notion 的调子。", {"palette": "black-on-white"}),
    ("r6-03-coral", "颜色与材质", "Coral", "白标反白在珊瑚色底上，珊瑚色作品牌色。", {"palette": "white-on-coral"}),
    ("r6-04-indigo", "颜色与材质", "Indigo", "白标在深靛蓝底上。", {"palette": "white-on-indigo"}),
    ("r6-05-coral-fold", "颜色与材质", "Coral fold", "白底黑框，只有 V 折线是珊瑚色。", {"palette": "black-on-white", "wedge_hex": CORAL}),
    ("r6-06-coral-fold-night", "颜色与材质", "Coral fold, night", "近黑底白框，V 折线是珊瑚色。", {"wedge_hex": CORAL}),
    ("r6-07-flat", "颜色与材质", "Flat", "和 Base 同形，不加玻璃，纯平面。", {"glass": False}),
    ("r6-08-flat-ink", "颜色与材质", "Flat ink", "白底黑标，纯平面，最接近 opencode 和 Notion。", {"palette": "black-on-white", "glass": False}),
    # Geometry
    ("r6-09-heavy", "几何", "Heavy", "笔画加粗到 28%，内洞变小，折线更短更有力。", {"weight": 0.28}),
    ("r6-10-light", "几何", "Light", "笔画减到 17%，内洞更大，更像一只信封。", {"weight": 0.17}),
    ("r6-11-soft", "几何", "Soft", "外角 8% 圆角，内洞跟着圆。", {"radius": 0.08}),
    ("r6-12-round", "几何", "Round", "外角 18% 圆角，接近 macOS 自己的圆角语言。", {"radius": 0.18}),
    ("r6-13-deep-v", "几何", "Deep V", "V 深到内洞的 58%。", {"dip": 0.58}),
    ("r6-14-wide", "几何", "Wide", "横向加宽 12%，内洞更像信封的比例。", {"counter_w": 1.12, "aspect": 0.78}),
    # Size
    ("r6-15-size-65", "尺寸", "Size 65%", "标记宽度占 body 的 65%。", {"size": 0.65}),
    ("r6-16-size-72", "尺寸", "Size 72%", "标记宽度占 body 的 72%。", {"size": 0.72}),
    ("r6-17-size-80", "尺寸", "Size 80%", "标记宽度占 body 的 80%。", {"size": 0.80}),
    # Pixel vs vector
    ("r6-18-pixel", "像素与矢量", "Pixel", "V 折线做成像素台阶，opencode 的像素语言。", {"pixel": 22, "dip": 0.5}),
    # Detail
    ("r6-19-unread", "小细节", "Unread", "外框右上角一块珊瑚色方块，读作未读标记。", {"detail": unread_corner}),
]


def contact_sheet(items):
    font_path = "/System/Library/Fonts/Helvetica.ttc"
    try:
        f_head = ImageFont.truetype("/System/Library/Fonts/Hiragino Sans GB.ttc", 28)
        f_name = ImageFont.truetype(font_path, 20)
    except OSError:
        f_head = f_name = ImageFont.load_default()
    axes = []
    for it in items:
        if it[1] not in axes:
            axes.append(it[1])
    cell, cols = 240, 8
    rows_per_axis = {a: (sum(1 for it in items if it[1] == a) + cols - 1) // cols for a in axes}
    height = sum(60 + r * (cell + 70) for r in rows_per_axis.values()) + 20
    sheet = Image.new("RGBA", (cols * cell + 40, height), (242, 242, 246, 255))
    d = ImageDraw.Draw(sheet)
    y = 20
    for a in axes:
        d.text((20, y), a, font=f_head, fill=(29, 29, 31))
        y += 50
        group_items = [it for it in items if it[1] == a]
        for i, (slug, _, name, _, _) in enumerate(group_items):
            x = 20 + (i % cols) * cell
            yy = y + (i // cols) * (cell + 70)
            big = Image.open(os.path.join(HERE, "png", f"{slug}-512.png")).resize((200, 200), Image.LANCZOS)
            sheet.alpha_composite(big, (x + 10, yy))
            sheet.alpha_composite(Image.open(os.path.join(HERE, "png", f"{slug}-32.png")), (x + 40, yy + 206))
            sheet.alpha_composite(Image.open(os.path.join(HERE, "png", f"{slug}-dark-64.png")), (x + 110, yy + 190))
            d.text((x + 10, yy + 256), name, font=f_name, fill=(80, 80, 86))
        y += rows_per_axis[a] * (cell + 70) + 10
    sheet.save(os.path.join(HERE, "contact-sheet-r6.png"))


# Final icon (R6-10 Light, V deepened to 44% after the size check).
# The small variant feeds the 16 and 32 px icns slots, where a 17% stroke
# and a shallow V turn into a plain box.
FINAL = {"weight": 0.17, "dip": 0.44}
FINAL_SMALL = {"weight": 0.23, "dip": 0.5, "size": 0.66}
APP_BUILD = os.path.abspath(os.path.join(HERE, "..", "..", "..", "apps", "desktop", "build"))


def flat_svg(geo):
    """Flat vector version of the icon on the macOS grid, for places that
    cannot use the .icon bundle (README, web)."""
    from build import BODY
    frame, wedge = flap_o(**geo)
    mark = svg_of(unary_union([frame, wedge]))
    d = mark.split(' d="')[1].split('"')[0]
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">\n'
        "  <!-- OpenMail app icon, flat version. The shipping icon is build/icon.icon\n"
        "       (Liquid Glass); this file is generated by\n"
        "       docs/design/icon-options-v2/build6.py with the final flag. -->\n"
        "  <defs>\n"
        f'    <path id="body" d="{BODY}"/>\n'
        '    <linearGradient id="bg" x1="0" y1="100" x2="0" y2="924" gradientUnits="userSpaceOnUse">\n'
        '      <stop offset="0" stop-color="#26272C"/><stop offset="1" stop-color="#0E0E11"/>\n'
        "    </linearGradient>\n"
        "  </defs>\n"
        '  <use href="#body" fill="url(#bg)"/>\n'
        f'  <path d="{d}" fill="#FFFFFF" fill-rule="evenodd" transform="translate(100 100) scale(0.8046875)"/>\n'
        "</svg>\n"
    )


def write_final():
    import shutil
    for name, geo in (("icon", FINAL), ("icon-small", FINAL_SMALL)):
        manifest, shapes = build(**geo)
        bundle = write_bundle(f"_{name}", manifest, shapes)
        target = os.path.join(APP_BUILD, f"{name}.icon")
        shutil.rmtree(target, ignore_errors=True)
        shutil.move(bundle, target)
    with open(os.path.join(APP_BUILD, "icon.svg"), "w") as f:
        f.write(flat_svg(FINAL))
    print("wrote", APP_BUILD, "icon.icon, icon-small.icon, icon.svg")


def main():
    import sys
    if "--final" in sys.argv:
        write_final()
        return
    os.makedirs(os.path.join(HERE, "png"), exist_ok=True)
    tmp = "/tmp/openmail-r6"
    os.makedirs(tmp, exist_ok=True)
    for slug, axis, name, line, kw in OPTIONS:
        manifest, shapes = build(**kw)
        bundle = write_bundle(slug, manifest, shapes)
        for rendition, suffix in (("Default", ""), ("Dark", "-dark")):
            raw = os.path.join(tmp, f"{slug}{suffix}.png")
            ictool(bundle, raw, rendition)
            icon = on_grid(Image.open(raw))
            for s in SIZES:
                icon.resize((s, s), Image.LANCZOS).save(os.path.join(HERE, "png", f"{slug}{suffix}-{s}.png"))
        print("rendered", slug)
    contact_sheet(OPTIONS)


if __name__ == "__main__":
    main()
