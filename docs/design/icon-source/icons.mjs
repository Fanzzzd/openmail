#!/usr/bin/env node
// Writes OpenMail's app icon sources from one geometry. No dependencies; every layer is SVG.
//
//   node docs/design/icon-source/icons.mjs [--out <dir>]
//
// Writes to apps/desktop/build (or <dir>):
//   icon.icon          production: the Flap o in two glass pieces on graphite
//   icon-small.icon    heavier geometry for the 16 and 32 px icns slots
//   icon-dev.icon      development: white drafting paper, the mark in black ink
//   icon-preview.icon  preview: Xcode's blueprint blue with Apple's icon grid
//   icon.svg           flat vector version on the macOS grid
// Without --out it also copies icon.svg to the docs site (apps/docs/app/icon.svg and
// apps/docs/public/logo.svg). apps/desktop/build/render-icons.sh then renders the PNGs and icns.
// Construction notes: docs/design/icons.md.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..", "..");
const outArg = process.argv.indexOf("--out");
const OUT = outArg > 0 ? resolve(process.argv[outArg + 1]) : join(ROOT, "apps/desktop/build");
const SIZE = 1024;

// ---------------------------------------------------------------- the mark

/** Production geometry. w: outer width on the 1024 canvas; stroke and v are fractions. */
const MARK = { w: 604, stroke: 0.17, v: 0.46, gap: 10 };
/** The 16 and 32 px slots: a heavier stroke, a deeper V, a larger o and a wider gap. */
const MARK_SMALL = { w: 676, stroke: 0.23, v: 0.54, gap: 22 };

const num = (n) => String(Math.round(n * 100) / 100);

/**
 * The Flap o on a full-bleed 1024 canvas: a square o (ring) and the V fold (flap) hanging from the
 * counter's top edge. `gap` shrinks the flap: the tip rises by gap / cos(slope) and the top
 * corners move in by 1.2 times that, so the flap reads as its own glass piece.
 */
function flapO({ w, stroke, v, gap }) {
  const h = Math.round(w * 0.873);
  const x0 = SIZE / 2 - w / 2;
  const y0 = SIZE / 2 - h / 2 + 4;
  const s = Math.round(w * stroke);
  const [ix0, iy0, iw, ih] = [x0 + s, y0 + s, w - 2 * s, h - 2 * s];
  const vy = iy0 + ih * v;
  const k = gap / Math.cos(Math.atan((vy - iy0) / (iw / 2)));
  const ring = `M${num(x0)} ${num(y0)}h${w}v${h}h${-w}Z M${num(ix0)} ${num(iy0)}v${ih}h${iw}v${-ih}Z`;
  const flap = `M${num(ix0 + k * 1.2)} ${num(iy0)}L${num(ix0 + iw - k * 1.2)} ${num(iy0)}L${SIZE / 2} ${num(vy - k)}Z`;
  return { ring, flap };
}

const layerSvg = (d, extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}"><path d="${d}" fill="#fff"${extra}/></svg>\n`;

// ---------------------------------------------------------------- Icon Composer JSON

const srgb = (hex) =>
  `srgb:${[1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(5)).join(",")},1.00000`;
const gradient = ([from, to]) => ({
  "linear-gradient": [srgb(from), srgb(to)],
  orientation: { start: { x: 0.5, y: 0 }, stop: { x: 0.5, y: 1 } },
});
const fills = (light, dark) => [
  { value: gradient(light) },
  { appearance: "dark", value: gradient(dark) },
];

/** Graphite field: light appearance, then the system's dark appearance. */
const FIELD = { light: { fill: ["#34363D", "#111215"] }, dark: { fill: ["#1A1B1F", "#050506"] } };
const WHITE = "#FFFFFF";
const INK = "#1C1C1E";
const GLASS = {
  shadow: { kind: "neutral", opacity: 0.5 },
  specular: true,
  translucency: { enabled: true, value: 0.1 },
};

/**
 * The mark's two groups, flap on top. `ink` draws the mark in ink in the light appearance and
 * keeps it white in dark, clear and tinted.
 */
function markGroups(ink) {
  const layer = (name, opacity) => ({
    name,
    "image-name": `${name}.svg`,
    glass: true,
    ...(opacity === undefined ? {} : { opacity }),
    "fill-specializations": [
      { value: { solid: srgb(ink ? INK : WHITE) } },
      { appearance: "dark", value: { solid: srgb(WHITE) } },
      ...(ink ? [{ appearance: "tinted", value: { solid: srgb(WHITE) } }] : []),
    ],
  });
  return [
    { name: "flap", layers: [layer("flap", 0.94)], ...GLASS },
    { name: "o", layers: [layer("o")], ...GLASS },
  ];
}

const paperGroup = {
  name: "Paper",
  layers: [
    {
      name: "paper",
      "image-name-specializations": [
        { value: "paper.svg" },
        { appearance: "dark", value: "paper-dark.svg" },
        { appearance: "tinted", value: "paper-mono.svg" },
      ],
      glass: false,
    },
  ],
  shadow: { kind: "none", opacity: 0.5 },
  translucency: { enabled: false, value: 0.5 },
  specular: false,
};

// ---------------------------------------------------------------- drafting paper

/**
 * One paper per appearance. fill: top-to-bottom gradient. line: [rgb, fine, major] opacities of
 * the 32 px and 128 px paper lines. grid: Apple's icon grid colour and opacity. mono is the paper
 * for clear and tinted, which keep only luminance, so the two styles differ there by texture and
 * brightness: preview keeps dense bright lines, development a dark wash with the grid alone.
 */
const PAPERS = {
  /**
   * Xcode.app's own blueprint colours, sampled from its 1024 px icon, in the layout of the Figma
   * "Debug icon kit (blueprint)": fine and major lines plus Apple's grid.
   */
  preview: {
    light: { fill: ["#0CC0FB", "#196EFA"], line: ["255,255,255", 0.1, 0.22], grid: [WHITE, 0.4] },
    dark: { fill: ["#0A5FA8", "#0B3A8C"], line: ["255,255,255", 0.08, 0.18], grid: [WHITE, 0.3] },
    mono: { line: ["255,255,255", 0.2, 0.42], grid: [WHITE, 0.6] },
    ink: false,
  },
  /** White drafting paper with black lines; the mark is drawn in ink in the light appearance. */
  dev: {
    light: {
      fill: ["#FFFFFF", "#F2F3F5"],
      line: ["0,0,0", 0.06, 0.14],
      grid: ["#000000", 0.32],
      width: 4,
    },
    dark: {
      fill: ["#2A2C31", "#1A1B1F"],
      line: ["255,255,255", 0.07, 0.16],
      grid: [WHITE, 0.4],
      width: 4,
    },
    mono: { wash: ["#000000", 0.34], grid: [WHITE, 0.6], width: 8 },
    ink: true,
  },
};

const FINE = 32;
const MAJOR = 128;
const page = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${body}</svg>\n`;

/** Paper lines; fine lines skip the major positions so their opacities don't stack. */
function lines([rgb, fine, major]) {
  const rects = { fine: [], major: [] };
  for (let i = 0; i * FINE < SIZE; i += 1) {
    const at = i * FINE;
    rects[i % (MAJOR / FINE) === 0 ? "major" : "fine"].push(
      `<rect x="0" y="${at}" width="${SIZE}" height="2"/><rect x="${at}" y="0" width="2" height="${SIZE}"/>`,
    );
  }
  return (
    `<g fill="rgb(${rgb})" opacity="${fine}">${rects.fine.join("")}</g>` +
    `<g fill="rgb(${rgb})" opacity="${major}">${rects.major.join("")}</g>`
  );
}

/** Apple's icon template grid: three circles, three squares, the diagonals and centre lines. */
function appleGrid([color, opacity], width = 6) {
  const c = SIZE / 2;
  const shapes = [
    ...[420, 260, 160].map((r) => `<circle cx="${c}" cy="${c}" r="${r}"/>`),
    '<rect x="92" y="252" width="840" height="520"/>',
    '<rect x="252" y="92" width="520" height="840"/>',
    '<rect x="162" y="162" width="700" height="700"/>',
    `<path d="M0 0L${SIZE} ${SIZE}M${SIZE} 0L0 ${SIZE}M${c} 0V${SIZE}M0 ${c}H${SIZE}"/>`,
  ];
  return `<g fill="none" stroke="${color}" stroke-width="${width}" opacity="${opacity}">${shapes.join("")}</g>`;
}

const paperSvg = (p) =>
  page(
    (p.wash
      ? `<rect width="${SIZE}" height="${SIZE}" fill="${p.wash[0]}" opacity="${p.wash[1]}"/>`
      : "") +
      (p.line ? lines(p.line) : "") +
      appleGrid(p.grid, p.width),
  );

// ---------------------------------------------------------------- flat icon.svg

/** The macOS body on the 1024 grid: an 824 px squircle at (100, 100). */
function squircle(x = 100, y = 100, w = 824, h = 824, r = 260, n = 3.4, steps = 32) {
  const corners = [
    [x + w - r, y + r, -90],
    [x + w - r, y + h - r, 0],
    [x + r, y + h - r, 90],
    [x + r, y + r, 180],
  ];
  const pts = corners.flatMap(([cx, cy, a0]) =>
    Array.from({ length: steps + 1 }, (_, s) => {
      const a = ((a0 + (90 * s) / steps) * Math.PI) / 180;
      const [c, si] = [Math.cos(a), Math.sin(a)];
      const px = cx + r * Math.sign(c) * Math.abs(c) ** (2 / n);
      const py = cy + r * Math.sign(si) * Math.abs(si) ** (2 / n);
      return `${px.toFixed(1)} ${py.toFixed(1)}`;
    }),
  );
  return `M${pts.join(" L")} Z`;
}

function flatSvg({ ring, flap }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <!-- OpenMail app icon, flat version. The shipping icon is build/icon.icon (Liquid Glass);
       docs/design/icon-source/icons.mjs writes this file. -->
  <defs>
    <path id="body" d="${squircle()}"/>
    <linearGradient id="bg" x1="0" y1="100" x2="0" y2="924" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${FIELD.light.fill[0]}"/><stop offset="1" stop-color="${FIELD.light.fill[1]}"/>
    </linearGradient>
  </defs>
  <use href="#body" fill="url(#bg)"/>
  <g fill="#FFFFFF" transform="translate(100 100) scale(0.8046875)">
    <path d="${ring}" fill-rule="evenodd"/>
    <path d="${flap}" opacity="0.94"/>
  </g>
</svg>
`;
}

// ---------------------------------------------------------------- write

function writeIcon(name, mark, paper) {
  const dir = join(OUT, `${name}.icon`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "Assets"), { recursive: true });
  const asset = (file, body) => writeFileSync(join(dir, "Assets", file), body);
  asset("o.svg", layerSvg(mark.ring, ' fill-rule="evenodd"'));
  asset("flap.svg", layerSvg(mark.flap));
  const groups = markGroups(paper?.ink ?? false);
  if (paper) {
    asset("paper.svg", paperSvg(paper.light));
    asset("paper-dark.svg", paperSvg(paper.dark));
    asset("paper-mono.svg", paperSvg(paper.mono));
    groups.push(paperGroup);
  }
  const field = paper ?? FIELD;
  const json = {
    "fill-specializations": fills(field.light.fill, field.dark.fill),
    groups,
    "supported-platforms": { squares: "shared" },
  };
  writeFileSync(join(dir, "icon.json"), `${JSON.stringify(json, null, 2)}\n`);
  process.stdout.write(`${dir}\n`);
}

const mark = flapO(MARK);
writeIcon("icon", mark);
writeIcon("icon-small", flapO(MARK_SMALL));
writeIcon("icon-dev", mark, PAPERS.dev);
writeIcon("icon-preview", mark, PAPERS.preview);

const flat = flatSvg(mark);
const flatTargets = [join(OUT, "icon.svg")];
if (outArg < 0)
  flatTargets.push(join(ROOT, "apps/docs/app/icon.svg"), join(ROOT, "apps/docs/public/logo.svg"));
for (const file of flatTargets) {
  writeFileSync(file, flat);
  process.stdout.write(`${file}\n`);
}
