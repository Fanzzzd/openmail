import { color, gradientColours, paintLengths, shadowPaints } from "./visible-text-style.js";
import { alwaysLoadedImage, legacyColour, type PaintedBackground } from "./visible-text-paint.js";

export interface SiblingPaint {
  readonly papers: readonly PaintedBackground[];
  readonly replaced: boolean;
  readonly behind: boolean;
}
const nonzero = (value: string | undefined) => paintLengths(value).some((n) => n !== 0);
const margins = [
  "margin",
  "margin-left",
  "margin-right",
  "margin-top",
  "margin-bottom",
  "margin-inline-start",
  "margin-inline-end",
  "margin-block-start",
  "margin-block-end",
];
const offsets = ["top", "left", "right", "bottom", "inset", "inset-inline", "inset-block"];
const paper = (token: string, ink: string): PaintedBackground => {
  const rgb = color(token === "currentcolor" ? ink : token);
  return rgb ? { kind: "known", rgb } : { kind: "unknown" };
};

const large = (value: string | undefined, extent: number | null) => {
  if (!value) return false;
  const percent = /^([\d.]+)%$/.exec(value);
  if (percent) return Number(percent[1]) >= 50;
  const length = declaredExtent(value);
  return extent !== null && length !== null && length >= extent * 0.5;
};

/** Conservative paint reach within one containing block, independent of DOM order. */
export function siblingPaint(
  css: ReadonlyMap<string, string>,
  tag: string,
  attrs: Readonly<Record<string, string>>,
  ink: string,
  uncertain = false,
  containingSize: { readonly width: number | null; readonly height: number | null } = {
    width: null,
    height: null,
  },
): SiblingPaint | null {
  const position = css.get("position") ?? "static";
  const absolute = position === "absolute" || position === "fixed";
  const shifted =
    ["relative", "sticky"].includes(position) && offsets.some((key) => nonzero(css.get(key)));
  const transformed = ["transform", "translate", "scale"].some(
    (key) => css.has(key) && !/^(none|initial|unset)$/.test(css.get(key) ?? ""),
  );
  const negativeMargin = margins.some((key) => paintLengths(css.get(key)).some((n) => n <= -10));
  const outlineWidth = css.get("outline-width");
  const outlineSize = /^(thin|medium|thick)$/.test(outlineWidth ?? "")
    ? 3
    : Math.max(0, ...paintLengths(outlineWidth));
  const outline = outlineSize > 0 && !/^(none|hidden)$/.test(css.get("outline-style") ?? "none");
  const shadows = shadowPaints(css.get("box-shadow")).filter(
    (shadow) =>
      !shadow.inset &&
      (shadow.lengths[0] !== 0 || shadow.lengths[1] !== 0 || (shadow.lengths[3] ?? 0) !== 0),
  );
  if (!absolute && !shifted && !transformed && !negativeMargin && !outline && !shadows.length)
    return null;
  const replaced = ["img", "video", "svg"].includes(tag);
  if (replaced) {
    const inset = paintLengths(css.get("inset"));
    const fills = inset.length > 0 && inset.every((n) => n === 0);
    const sized =
      large(css.get("width") ?? attrs.width, containingSize.width) &&
      large(css.get("height") ?? attrs.height, containingSize.height);
    if (!(absolute || transformed) || !(fills || sized)) return null;
  }
  const local = alwaysLoadedImage(
    css.get("background-image"),
    css.has("background-image") ? undefined : attrs.background,
  );
  const papers: PaintedBackground[] = [];
  if (replaced || local || uncertain) papers.push({ kind: "unknown" });
  const background = css.get("background-color") ?? legacyColour(attrs.bgcolor);
  if (background) papers.push(paper(background, ink));
  papers.push(...gradientColours(css.get("background-image")).map((stop) => paper(stop, ink)));
  if (outline) papers.push(paper(css.get("outline-color") ?? "currentcolor", ink));
  papers.push(...shadows.map((shadow) => paper(shadow.colour, ink)));
  const visiblePapers = papers.filter((paint) => paint.kind === "unknown" || paint.rgb[3] > 0.1);
  if (!visiblePapers.length) return null;
  return { papers: visiblePapers, replaced, behind: Number(css.get("z-index")) < 0 };
}

/** Only explicit absolute lengths establish a containing block's declared size. */
export function declaredExtent(value: string | undefined): number | null {
  if (!value || value.includes("%") || /^(auto|none|initial|inherit|unset)$/.test(value))
    return null;
  const sizes = paintLengths(value);
  return sizes.length === 1 && sizes[0] !== undefined && sizes[0] > 0 ? sizes[0] : null;
}
