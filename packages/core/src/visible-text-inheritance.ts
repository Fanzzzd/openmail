import type { CssNode } from "./css-tree-browser.js";
import type { VisibleRemovalRule, VisibleRemovalSource } from "./visible-text-diagnostics.js";
import type { VisibleCascade } from "./visible-text-css.js";

type FontUnit = "px" | "pt" | "vw" | "vh" | "vmin" | "vmax";
interface FontSize {
  readonly value: number;
  readonly unit: FontUnit;
}
type Visibility = "visible" | "hidden" | "collapse";
export interface InheritedTextStyle {
  readonly size: FontSize;
  readonly rootSize: FontSize;
  readonly visibility: Visibility;
  readonly sizeSource: VisibleRemovalSource;
  readonly visibilitySource: VisibleRemovalSource;
  readonly lineHeight: number | null;
  readonly textFill: string | null;
}
const INITIAL_FONT: FontSize = { value: 14, unit: "px" };
export const INITIAL_TEXT_STYLE: InheritedTextStyle = {
  size: INITIAL_FONT,
  rootSize: INITIAL_FONT,
  visibility: "visible",
  sizeSource: "inherited",
  visibilitySource: "inherited",
  lineHeight: null,
  textFill: null,
};
interface Quantity {
  value: number;
  unit: FontUnit | "number";
}
function numericToken(node: CssNode, parent: InheritedTextStyle): Quantity | null {
  if (node.type !== "Dimension" && node.type !== "Percentage" && node.type !== "Number")
    return null;
  const value = Number(node.value);
  if (!Number.isFinite(value)) return null;
  const unit =
    node.type === "Dimension"
      ? node.unit.toLowerCase()
      : node.type === "Percentage"
        ? "%"
        : "number";
  if (unit === "number") return { value, unit };
  if (unit === "em" || unit === "%" || unit === "rem") {
    const font = unit === "rem" ? parent.rootSize : parent.size;
    return { value: (font.value * value) / (unit === "%" ? 100 : 1), unit: font.unit };
  }
  if (
    unit === "px" ||
    unit === "pt" ||
    unit === "vw" ||
    unit === "vh" ||
    unit === "vmin" ||
    unit === "vmax"
  )
    return { value, unit };
  return null;
}
function sameUnits(a: Quantity, b: Quantity): [Quantity, Quantity] | null {
  if (a.unit === b.unit) return [a, b];
  if (a.value === 0 && a.unit === "number") return [{ ...a, unit: b.unit }, b];
  if (b.value === 0 && b.unit === "number") return [a, { ...b, unit: a.unit }];
  if ((a.unit === "px" || a.unit === "pt") && (b.unit === "px" || b.unit === "pt"))
    return [
      { value: a.value * (a.unit === "pt" ? 4 / 3 : 1), unit: "px" },
      { value: b.value * (b.unit === "pt" ? 4 / 3 : 1), unit: "px" },
    ];
  return null;
}
function mathExpression(
  nodes: readonly CssNode[],
  parent: InheritedTextStyle,
  depth: number,
): Quantity | null {
  let total: Quantity | null = null,
    term: Quantity | null = null,
    sign = 1,
    operator = "*";
  for (const node of nodes) {
    if (node.type === "Operator") {
      if (node.value === "+" || node.value === "-") {
        if (!term) return null;
        const signed = { ...term, value: term.value * sign };
        if (total) {
          const pair = sameUnits(total, signed);
          if (!pair) return null;
          total = { ...pair[0], value: pair[0].value + pair[1].value };
        } else total = signed;
        term = null;
        sign = node.value === "-" ? -1 : 1;
        operator = "*";
      } else if (node.value === "*" || node.value === "/") operator = node.value;
      else return null;
      continue;
    }
    const next = evaluateQuantity(node, parent, depth + 1);
    if (!next) return null;
    if (!term) term = next;
    else if (operator === "*" && (term.unit === "number" || next.unit === "number"))
      term = {
        value: term.value * next.value,
        unit: term.unit === "number" ? next.unit : term.unit,
      };
    else if (operator === "/" && next.unit === "number" && next.value !== 0)
      term = { unit: term.unit, value: term.value / next.value };
    else return null;
  }
  if (!term) return null;
  const signed = { ...term, value: term.value * sign };
  if (!total) return signed;
  const pair = sameUnits(total, signed);
  return pair ? { ...pair[0], value: pair[0].value + pair[1].value } : null;
}
export function evaluateQuantity(
  node: CssNode,
  parent: InheritedTextStyle,
  depth = 0,
): Quantity | null {
  if (depth > 32) return null;
  const numeric = numericToken(node, parent);
  if (numeric) return numeric;
  if (node.type === "Value" || node.type === "Parentheses")
    return mathExpression(node.children.toArray(), parent, depth);
  if (node.type !== "Function") return null;
  const name = node.name.toLowerCase();
  if (name === "calc") return mathExpression(node.children.toArray(), parent, depth);
  if (name !== "min" && name !== "max" && name !== "clamp") return null;
  const args: CssNode[][] = [[]];
  for (const child of node.children) {
    if (child.type === "Operator" && child.value === ",") args.push([]);
    else args.at(-1)?.push(child);
  }
  const values: Quantity[] = [];
  for (const arg of args) {
    const value = mathExpression(arg, parent, depth + 1);
    if (!value) return null;
    values.push(value);
  }
  const first = values[0];
  if (!first) return null;
  const numbers: number[] = [];
  for (const value of values) {
    const pair = sameUnits(first, value);
    if (!pair || pair[0].unit !== first.unit) return null;
    numbers.push(pair[1].value);
  }
  const value =
    name === "min"
      ? Math.min(...numbers)
      : name === "max"
        ? Math.max(...numbers)
        : numbers.length === 3
          ? Math.max(numbers[0] ?? 0, Math.min(numbers[1] ?? 0, numbers[2] ?? 0))
          : NaN;
  return Number.isFinite(value) ? { value, unit: first.unit } : null;
}
export function resolveFont(node: CssNode, parent: InheritedTextStyle): FontSize | null {
  if (node.type === "Value" && node.children.size === 1 && node.children.first)
    return resolveFont(node.children.first, parent);
  if (node.type === "Identifier") {
    if (node.name === "initial" || node.name === "medium") return INITIAL_FONT;
    if (["inherit", "unset", "revert", "revert-layer"].includes(node.name)) return parent.size;
    return null;
  }
  const result = evaluateQuantity(node, parent);
  if (!result || !Number.isFinite(result.value)) return null;
  if (result.unit === "number") return result.value === 0 ? { value: 0, unit: "px" } : null;
  return { value: Math.max(0, result.value), unit: result.unit };
}
export function resolveTextStyle(
  cascade: VisibleCascade,
  parent: InheritedTextStyle,
  rootElement = false,
): InheritedTextStyle {
  const font = cascade.nodes.get("font-size"),
    keyword = cascade.values.get("font-size");
  const size = font ? (resolveFont(font, parent) ?? { value: 0, unit: "px" }) : parent.size;
  const visibility = cascade.values.get("visibility");
  const visible: Visibility =
    visibility === "hidden" || visibility === "collapse"
      ? visibility
      : visibility === "visible" || visibility === "initial"
        ? "visible"
        : parent.visibility;
  const line = cascade.nodes.get("line-height");
  const lineValue = line ? evaluateQuantity(line, { ...parent, size }, 0) : null;
  const fill = cascade.values.get("-webkit-text-fill-color");
  return {
    size,
    rootSize: rootElement ? size : parent.rootSize,
    visibility: visible,
    sizeSource:
      font && !["inherit", "unset", "revert", "revert-layer"].includes(keyword ?? "")
        ? (cascade.sources.get("font-size") ?? "inherited")
        : parent.sizeSource,
    visibilitySource:
      visibility && !["inherit", "unset", "revert", "revert-layer"].includes(visibility)
        ? (cascade.sources.get("visibility") ?? "inherited")
        : parent.visibilitySource,
    lineHeight: line ? (lineValue?.value ?? null) : parent.lineHeight,
    textFill: fill && fill !== "inherit" && fill !== "unset" ? fill : parent.textFill,
  };
}
export function inheritedTextRemoval(
  style: InheritedTextStyle,
): { rule: VisibleRemovalRule; source: VisibleRemovalSource } | null {
  if (style.visibility !== "visible") return { rule: "visibility", source: style.visibilitySource };
  const threshold = style.size.unit === "px" || style.size.unit === "pt" ? 2 : 0.2;
  if (style.size.value > threshold) return null;
  return {
    rule: style.size.value === 0 ? "font-size-zero" : "font-size-small",
    source: style.sizeSource,
  };
}
