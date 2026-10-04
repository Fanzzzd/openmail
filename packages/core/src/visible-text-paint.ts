import { color, gradientColours, shadowPaints, type Rgba } from "./visible-text-style.js";
import { parse, walk } from "./css-tree-browser.js";

export type PaintedBackground =
  | { readonly kind: "known"; readonly rgb: Rgba }
  | { readonly kind: "unknown" };
export const WHITE_PAPER: PaintedBackground = { kind: "known", rgb: [255, 255, 255, 1] };
export const composite = (ink: Rgba, paper: Rgba): Rgba => [
  ink[0] * ink[3] + paper[0] * (1 - ink[3]),
  ink[1] * ink[3] + paper[1] * (1 - ink[3]),
  ink[2] * ink[3] + paper[2] * (1 - ink[3]),
  1,
];

/** WHATWG legacy colour parsing, used only for HTML presentational attributes. */
export function legacyColour(input: string | undefined): string | null {
  if (!input) return null;
  let value = input.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "").toLowerCase();
  if (value === "transparent") return null;
  if (/^[a-z]+$/.test(value) && color(value)) return value;
  if (/^#[\da-f]{3}$/.test(value)) return value;
  value = Array.from(value, (char) => ((char.codePointAt(0) ?? 0) > 0xffff ? "00" : char))
    .join("")
    .slice(0, 128);
  value = value.replace(/^#/, "").replace(/[^\da-f]/g, "0");
  while (!value.length || value.length % 3) value += "0";
  let length = value.length / 3;
  let parts = [value.slice(0, length), value.slice(length, 2 * length), value.slice(2 * length)];
  if (length > 8) {
    parts = parts.map((part) => part.slice(length - 8));
    length = 8;
  }
  while (length > 2 && parts.every((part) => part.startsWith("0"))) {
    parts = parts.map((part) => part.slice(1));
    length--;
  }
  const channels = parts.map((part) => Number.parseInt(part.slice(0, 2), 16));
  return `rgb(${channels.join(",")})`;
}
/** Bound inherited alternatives and avoid multiplying identical opaque paints. */
export function distinctBackgrounds(
  papers: readonly PaintedBackground[],
): readonly PaintedBackground[] {
  const unique = new Map<string, PaintedBackground>();
  for (const paper of papers) {
    unique.set(paper.kind === "known" ? paper.rgb.join(",") : "unknown", paper);
    if (unique.size > 256) throw new RangeError("Paint alternatives budget");
  }
  return [...unique.values()];
}
const keywords = /^(initial|unset|revert|revert-layer)$/;
const paint = (
  value: string,
  parent: readonly PaintedBackground[],
  ink: string,
): readonly PaintedBackground[] => {
  if (value === "inherit") return [...parent];
  const rgb = color(value === "currentcolor" ? ink : keywords.test(value) ? "transparent" : value);
  if (!rgb) return [{ kind: "unknown" }];
  if (rgb[3] === 0) return parent;
  if (rgb[3] === 1) return [{ kind: "known", rgb }];
  return distinctBackgrounds(
    parent.map((paper): PaintedBackground => {
      return paper.kind === "known" ? { kind: "known", rgb: composite(rgb, paper.rgb) } : paper;
    }),
  );
};

/** URL images use their blocked-image fallback; every gradient stop can conceal ink. */
export function paintedBackgrounds(
  css: ReadonlyMap<string, string>,
  parent: readonly PaintedBackground[],
  ink: string,
  bgcolor?: string,
  legacyBackground?: string,
): readonly PaintedBackground[] {
  const base = paint(
    css.get("background-color") ?? legacyColour(bgcolor) ?? "transparent",
    parent,
    ink,
  );
  const image = css.get("background-image");
  if (alwaysLoadedImage(image, css.has("background-image") ? undefined : legacyBackground))
    return [{ kind: "unknown" }];
  const shadows = shadowPaints(css.get("box-shadow")).filter((shadow) => shadow.inset);
  if (shadows.length)
    return distinctBackgrounds(shadows.flatMap((shadow) => paint(shadow.colour, base, ink)));
  const stops = gradientColours(image);
  if (stops.length) return distinctBackgrounds(stops.flatMap((stop) => paint(stop, base, ink)));
  if (image && !/^(none|initial|unset|inherit|revert)$/.test(image) && !/url\(/.test(image))
    return [{ kind: "unknown" }];
  return base;
}

/** data/cid paints survive the reader's default CSP and cannot use a remote fallback. */
export function alwaysLoadedImage(value: string | undefined, legacy?: string): boolean {
  if (legacy && /^(data|cid):/i.test(legacy.trim())) return true;
  if (!value) return false;
  const ast = parse(value, { context: "value" });
  let local = false;
  walk(ast, (node) => {
    if (node.type === "Url" && /^(data|cid):/i.test(node.value.trim())) local = true;
  });
  return local;
}
