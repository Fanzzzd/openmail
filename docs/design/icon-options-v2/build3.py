#!/usr/bin/env python3
"""Round 3: real Liquid Glass icons built as Icon Composer bundles.

Run: python3 docs/design/icon-options-v2/build3.py
Needs Xcode 26 (Icon Composer's ictool) and Pillow.

Each option is an .icon bundle (icon.json + flat SVG layers). Apple's own
renderer (ictool) adds the glass, specular light, translucency and shadows,
so the output matches how macOS 26 draws system icons. The script renders
Default and Dark, then places the full-bleed render on the macOS grid
(824 body at 100,100 on a 1024 canvas) with the standard drop shadow.
"""
import json
import os
import shutil
import subprocess

from PIL import Image, ImageFilter

from build import rounded_poly, rrect, sparkle

HERE = os.path.dirname(os.path.abspath(__file__))
ICTOOL = "/Applications/Icon Composer.app/Contents/Executables/ictool"
SIZES = (1024, 512, 128, 64, 32)


def color(hexs, a=1.0):
    h = hexs.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return f"srgb:{r:.5f},{g:.5f},{b:.5f},{a:.5f}"


def vgrad(top, bottom, x0=0.5, y0=0.0, x1=0.5, y1=1.0):
    return {
        "linear-gradient": [color(top), color(bottom)],
        "orientation": {"start": {"x": x0, "y": y0}, "stop": {"x": x1, "y": y1}},
    }


def solid(hexs):
    return {"solid": color(hexs)}


def envelope_back(x, y, w, h, r):
    return rrect(x, y, w, h, r)


def envelope_flap(x, y, w, h, r, depth=0.56, tip_r=70):
    """Flap that shares the body's top corners, so it never sticks out."""
    cx, ty = x + w / 2, y + h * depth
    # Tip rounded with a quadratic; legs start where the corner arcs end.
    import math
    lx, ly = x, y + r
    rx, ry = x + w, y + r
    def toward(a, b, d):
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy)
        return (a[0] + dx * d / L, a[1] + dy * d / L)
    t1 = toward((cx, ty), (rx, ry), tip_r)
    t2 = toward((cx, ty), (lx, ly), tip_r)
    return (
        f"M{x + r} {y} H{x + w - r} A{r} {r} 0 0 1 {rx} {ry} "
        f"L{t1[0]:.1f} {t1[1]:.1f} Q{cx} {ty} {t2[0]:.1f} {t2[1]:.1f} "
        f"L{lx} {ly} A{r} {r} 0 0 1 {x + r} {y} Z"
    )


def svg(d, fill="#FFFFFF", extra=""):
    return (
        '<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">'
        f'<path d="{d}" fill="{fill}" {extra}/></svg>'
    )


def group(name, layers, shadow="neutral", shadow_a=0.5, translucency=None, specular=True,
          opacity=None, blur=None, lighting=None):
    g = {
        "name": name,
        "layers": layers,
        "shadow": {"kind": shadow, "opacity": shadow_a},
        "specular": specular,
    }
    if translucency is not None:
        g["translucency"] = {"enabled": True, "value": translucency}
    if opacity is not None:
        g["opacity"] = opacity
    if blur is not None:
        g["blur-material"] = blur
    if lighting:
        g["lighting"] = lighting
    return g


def layer(name, fill=None, glass=True, opacity=None, dark_fill=None, blend=None):
    l = {"name": name, "image-name": f"{name}.svg", "glass": glass}
    specs = []
    if fill is not None:
        specs.append({"value": fill})
    if dark_fill is not None:
        specs.append({"appearance": "dark", "value": dark_fill})
    if specs:
        l["fill-specializations"] = specs
    if opacity is not None:
        l["opacity"] = opacity
    if blend:
        l["blend-mode"] = blend
    return l


OPTIONS = []


def option(slug, name):
    def wrap(fn):
        OPTIONS.append((slug, name, fn))
        return fn
    return wrap


# Envelope proportions shared by several options (full-bleed 1024 canvas).
EX, EY, EW, EH, ER = 182, 292, 660, 450, 104


@option("r3-01-violet", "Violet")
def violet():
    """The envelope, done the way Apple draws Mail, but violet and with a deeper flap."""
    shapes = {
        "flap": svg(envelope_flap(EX, EY, EW, EH, ER, 0.6, 80)),
        "body": svg(envelope_back(EX, EY, EW, EH, ER)),
    }
    manifest = {
        "fill": vgrad("#9B7BFF", "#5A2EE6"),
        "groups": [
            group("flap", [layer("flap", solid("#FFFFFF"))], translucency=0.1),
            group("body", [layer("body", vgrad("#E4DAFF", "#B9A4FF"))], translucency=0.35),
        ],
    }
    return manifest, shapes


@option("r3-02-seal", "Seal")
def seal():
    """White glass envelope closed with a coral glass seal: the o of openmail,
    and the human sign-off before anything is sent."""
    depth = 0.6
    cx, cy = 512, EY + EH * depth - 6
    R = 92
    circle = f"M{cx - R} {cy} A{R} {R} 0 1 1 {cx + R} {cy} A{R} {R} 0 1 1 {cx - R} {cy} Z"
    shapes = {
        "seal": svg(circle),
        "flap": svg(envelope_flap(EX, EY, EW, EH, ER, depth, 80)),
        "body": svg(envelope_back(EX, EY, EW, EH, ER)),
    }
    manifest = {
        "fill": vgrad("#3E46B8", "#171A5C"),
        "groups": [
            group("seal", [layer("seal", vgrad("#FF9A6B", "#FF4D6D"))], shadow="layer-color", translucency=0.1),
            group("flap", [layer("flap", solid("#FFFFFF"))], translucency=0.1),
            group("body", [layer("body", vgrad("#E3E6FF", "#B3BAF5"))], translucency=0.3),
        ],
    }
    return manifest, shapes


@option("r3-03-spark-letter", "Spark letter")
def spark_letter():
    """White glass envelope on a light field, with an Apple Intelligence-coloured spark."""
    x, y, w, h, r = 170, 340, 620, 424, 100
    shapes = {
        "spark": svg(sparkle(760, 322, 170, 0.28)),
        "flap": svg(envelope_flap(x, y, w, h, r, 0.58, 76)),
        "body": svg(envelope_back(x, y, w, h, r)),
    }
    manifest = {
        "fill": vgrad("#FFFFFF", "#E7E9F2"),
        "groups": [
            group("spark", [layer("spark", vgrad("#FF9A3D", "#E63FA8", 0.2, 0.0, 0.8, 1.0))],
                  shadow="layer-color", translucency=0.15),
            group("flap", [layer("flap", vgrad("#FFFFFF", "#E6DEFF"))], translucency=0.1),
            group("body", [layer("body", vgrad("#A18BFF", "#6A4BFF"))], translucency=0.3),
        ],
    }
    return manifest, shapes


@option("r3-04-pocket", "Pocket")
def pocket():
    """A letter sliding out of a clear glass envelope. The paper shows through the pocket."""
    lx, ly, lw, lh = 262, 178, 500, 470
    line = lambda yy, ww: rrect(lx + 70, yy, ww, 38, 19)
    lines = " ".join([line(ly + 80, 300), line(ly + 150, 360), line(ly + 220, 250)])
    px, py, pw, ph, pr = 172, 420, 680, 440, 100
    pocket_d = (
        f"M{px} {py + pr} A{pr} {pr} 0 0 1 {px + pr} {py} "
        f"L{512 - 60} {py + 170} Q512 {py + 214} {512 + 60} {py + 170} "
        f"L{px + pw - pr} {py} A{pr} {pr} 0 0 1 {px + pw} {py + pr} "
        f"V{py + ph - pr} A{pr} {pr} 0 0 1 {px + pw - pr} {py + ph} H{px + pr} "
        f"A{pr} {pr} 0 0 1 {px} {py + ph - pr} Z"
    )
    shapes = {
        "pocket": svg(pocket_d),
        "lines": svg(lines),
        "letter": svg(rrect(lx, ly, lw, lh, 64)),
    }
    manifest = {
        "fill": vgrad("#FFB25C", "#FF5E3A"),
        "groups": [
            group("pocket", [layer("pocket", solid("#FFFFFF"))], translucency=0.55, blur=0.5),
            group("letter", [layer("lines", solid("#FF8A4C"), glass=False),
                             layer("letter", solid("#FFFFFF"))], translucency=0.1),
        ],
    }
    return manifest, shapes


@option("r3-05-stack", "Stack")
def stack():
    """Three envelopes stacked in depth, one per account; the front one is the one you read."""
    def env(i):
        s = [0.74, 0.87, 1.0][i]
        w, h = 620 * s, 420 * s
        x, y = 512 - w / 2, [236, 322, 420][i]
        r = 92 * s
        return envelope_back(x, y, w, h, r), envelope_flap(x, y, w, h, r, 0.58, 70 * s)
    b0, _ = env(0)
    b1, _ = env(1)
    b2, f2 = env(2)
    shapes = {"front-flap": svg(f2), "front": svg(b2), "middle": svg(b1), "back": svg(b0)}
    manifest = {
        "fill": vgrad("#35D0FF", "#1E5BFF"),
        "groups": [
            group("front", [layer("front-flap", solid("#FFFFFF")), layer("front", vgrad("#DDEBFF", "#AFCBFF"))], translucency=0.25),
            group("middle", [layer("middle")], translucency=0.5, opacity=0.8),
            group("back", [layer("back")], translucency=0.5, opacity=0.55),
        ],
    }
    return manifest, shapes


@option("r3-06-aurora", "Aurora")
def aurora():
    """Dark premium: a glass envelope filled with an aurora gradient, a white flap on top."""
    shapes = {
        "flap": svg(envelope_flap(EX, EY, EW, EH, ER, 0.6, 80)),
        "body": svg(envelope_back(EX, EY, EW, EH, ER)),
    }
    manifest = {
        "fill": vgrad("#23242B", "#0B0B0E"),
        "groups": [
            group("flap", [layer("flap", solid("#FFFFFF"))], translucency=0.2),
            group("body", [layer("body", vgrad("#FF8A3D", "#7B4DFF", 0.0, 0.0, 1.0, 1.0))],
                  shadow="layer-color", translucency=0.15),
        ],
    }
    return manifest, shapes


def write_bundle(slug, manifest, shapes):
    path = os.path.join(HERE, f"{slug}.icon")
    shutil.rmtree(path, ignore_errors=True)
    os.makedirs(os.path.join(path, "Assets"))
    for name, content in shapes.items():
        with open(os.path.join(path, "Assets", f"{name}.svg"), "w") as f:
            f.write(content)
    manifest["supported-platforms"] = {"squares": "shared"}
    with open(os.path.join(path, "icon.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    return path


def ictool(bundle, out, rendition, size=1024):
    subprocess.run(
        [ICTOOL, bundle, "--export-image", "--output-file", out, "--platform", "macOS",
         "--rendition", rendition, "--width", str(size), "--height", str(size), "--scale", "1"],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def on_grid(full):
    """Place a full-bleed render on the macOS 1024 grid with the Dock shadow."""
    body = full.convert("RGBA").resize((824, 824), Image.LANCZOS)
    canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    alpha = body.split()[3]
    shadow = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    sh = Image.new("RGBA", (824, 824), (0, 0, 0, 90))
    sh.putalpha(alpha.point(lambda a: a * 90 // 255))
    shadow.alpha_composite(sh, (100, 112))
    shadow = shadow.filter(ImageFilter.GaussianBlur(14))
    canvas.alpha_composite(shadow)
    canvas.alpha_composite(body, (100, 100))
    return canvas


def main():
    os.makedirs(os.path.join(HERE, "png"), exist_ok=True)
    tmp = os.path.join("/tmp", "openmail-r3")
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
