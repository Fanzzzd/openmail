import { parse, generate, type CssNode } from "./css-tree-browser.js";
import { INITIAL_TEXT_STYLE, evaluateQuantity } from "./visible-text-inheritance.js";
import { color, gradientColours, paintLengths } from "./visible-text-style.js";
import { legacyColour } from "./visible-text-paint.js";

export type OpaqueCoverage = "containing-block" | "previous-sibling" | "adjacent-siblings";
const zeroInset = (value: string | undefined) => {
  const lengths = paintLengths(value);
  return lengths.length > 0 && lengths.every((n) => n === 0);
};
const constantLength = (value: string | undefined): number | null => {
  if (!value || value.includes("%")) return null;
  const lengths = paintLengths(value);
  return lengths.length === 1 ? (lengths[0] ?? null) : null;
};
function translationY(value: string | undefined): number | null {
  if (!value) return null;
  const ast = parse(value, { context: "value" });
  if (ast.type !== "Value") return null;
  let total = 0;
  for (const fn of ast.children) {
    if (fn.type !== "Function" || !["translate", "translatey", "translate3d"].includes(fn.name))
      return null;
    const groups: CssNode[][] = [[]];
    for (const child of fn.children) {
      if (child.type === "Operator" && child.value === ",") groups.push([]);
      else groups.at(-1)?.push(child);
    }
    const argument = groups[fn.name === "translatey" ? 0 : 1];
    if (!argument) continue;
    const quantity = evaluateQuantity(
      parse(argument.map((node) => generate(node)).join(" "), { context: "value" }),
      INITIAL_TEXT_STYLE,
    );
    if (!quantity || !["px", "pt", "number"].includes(quantity.unit)) return null;
    total += quantity.value * (quantity.unit === "pt" ? 4 / 3 : 1);
  }
  return total;
}

/** Explicit opaque rectangles and thick outlines are separate from colour-match painters. */
export function opaqueCoverage(
  css: ReadonlyMap<string, string>,
  tag: string,
  attrs: Readonly<Record<string, string>>,
  ink: string,
): OpaqueCoverage | null {
  if (["img", "video", "svg"].includes(tag)) return null;
  const fill = color(css.get("background-color") ?? legacyColour(attrs.bgcolor) ?? "transparent");
  const stops = gradientColours(css.get("background-image"));
  const opaque =
    fill?.[3] === 1 || (stops.length > 0 && stops.every((stop) => color(stop)?.[3] === 1));
  const position = css.get("position");
  const absolute = position === "absolute" || position === "fixed";
  if (Number(css.get("z-index")) < 0) return null;
  const stretch =
    zeroInset(css.get("inset")) &&
    ["width", "height"].every((key) => !css.has(key) || /^(auto|100%)$/.test(css.get(key) ?? ""));
  if (
    opaque &&
    absolute &&
    (stretch || (css.get("width") === "100%" && css.get("height") === "100%"))
  )
    return "containing-block";
  const block =
    /^(div|p|table|section|article|header|footer|main|aside)$/.test(tag) ||
    /^(block|table|flex|grid)$/.test(css.get("display") ?? "");
  const wide = css.get("width") === "100%" || (!css.has("width") && block);
  if (!wide) return null;
  const height = constantLength(css.get("height"));
  // Require enough reach for a line of reader text and an explicit opaque height.
  const lineReach = INITIAL_TEXT_STYLE.size.value * 2;
  const up = Math.min(
    0,
    constantLength(css.get("margin-top")) ?? 0,
    translationY(css.get("transform")) ?? 0,
  );
  if (opaque && !absolute && height !== null && up <= -lineReach && height >= -up)
    return "previous-sibling";
  const outline = color(
    css.get("outline-color") === "currentcolor" ? ink : (css.get("outline-color") ?? ink),
  );
  const width = constantLength(css.get("outline-width"));
  if (
    outline?.[3] === 1 &&
    width !== null &&
    width >= lineReach &&
    !/^(none|hidden)$/.test(css.get("outline-style") ?? "none")
  )
    return "adjacent-siblings";
  return null;
}

export type InlineCoverage = "opaque" | "replaced";
/** Horizontal overpainting stays restricted to the immediately preceding inline sibling. */
export function horizontalInlineCoverage(
  css: ReadonlyMap<string, string>,
  tag: string,
  attrs: Readonly<Record<string, string>>,
): InlineCoverage | null {
  const replaced = ["img", "video", "svg"].includes(tag);
  if (["absolute", "fixed"].includes(css.get("position") ?? "")) return null;
  const display = css.get("display");
  if (display !== "inline-block" && !(replaced && (!display || display === "inline"))) return null;
  if (Number(css.get("z-index")) < 0) return null;
  const horizontal = Math.min(
    0,
    ...["margin-left", "margin-right", "margin-inline-start", "margin-inline-end"].flatMap((key) =>
      paintLengths(css.get(key)),
    ),
  );
  if (horizontal > -10) return null;
  const width = constantLength(css.get("width") ?? attrs.width);
  const height = constantLength(css.get("height") ?? attrs.height);
  if (
    width === null ||
    height === null ||
    width < -horizontal ||
    height < INITIAL_TEXT_STYLE.size.value * 1.6
  )
    return null;
  if (replaced) return "replaced";
  const fill = color(css.get("background-color") ?? legacyColour(attrs.bgcolor) ?? "transparent");
  const stops = gradientColours(css.get("background-image"));
  return fill?.[3] === 1 || (stops.length > 0 && stops.every((stop) => color(stop)?.[3] === 1))
    ? "opaque"
    : null;
}
