import { parse, generate, ident, walk, type CssNode } from "./css-tree-browser.js";
export interface MediaEnvironment {
  readonly values: ReadonlyMap<string, string>;
  readonly pixelRatio: number;
}
export const BASE_MEDIA_ENVIRONMENT: MediaEnvironment = {
  values: new Map([
    ["prefers-color-scheme", "light"],
    ["hover", "hover"],
    ["pointer", "fine"],
    ["orientation", "landscape"],
  ]),
  pixelRatio: 1,
};
const DISCRETE_FEATURES = new Map<string, readonly string[]>([
  ["prefers-color-scheme", ["light", "dark"]],
  ["hover", ["hover", "none"]],
  ["pointer", ["fine", "coarse", "none"]],
  ["orientation", ["landscape", "portrait"]],
]);
const opaqueFeature = (node: CssNode) => `feature:${generate(node)}`;
const environmentCondition = (environment: MediaEnvironment, key: string): MediaCoverage => {
  const value = environment.values.get(key);
  return value === "on" ? alwaysMedia : value === "off" ? never : unknownMedia;
};
export const groupConditionKey = (name: string, prelude: CssNode | null) =>
  `group:${name}:${prelude ? generate(prelude) : ""}`;
export const groupMedia = (name: string, prelude: CssNode | null, environment: MediaEnvironment) =>
  environmentCondition(environment, groupConditionKey(name, prelude));
// Keep environments separate until the walker intersects visibility by DOM text node.
export const REFERENCE_READER_WIDTHS = [720, 1080] as const;
export type ReaderWidth = (typeof REFERENCE_READER_WIDTHS)[number];
export interface MediaCoverage {
  possible: readonly ReaderWidth[];
  certain: readonly ReaderWidth[];
  possibleBand: readonly BandSpan[];
  certainBand: readonly BandSpan[];
}
export interface BandSpan {
  lo: number;
  hi: number;
}
export const MAX_REVEAL_INTERVALS = 256;
const band: readonly BandSpan[] = [{ lo: 0, hi: 8000 }];
const full = REFERENCE_READER_WIDTHS;
export const alwaysMedia: MediaCoverage = {
  possible: full,
  certain: full,
  possibleBand: band,
  certainBand: band,
};
const never: MediaCoverage = { possible: [], certain: [], possibleBand: [], certainBand: [] };
export const unknownMedia: MediaCoverage = {
  possible: full,
  certain: [],
  possibleBand: band,
  certainBand: [],
};
const intersection = (a: readonly ReaderWidth[], b: readonly ReaderWidth[]) =>
  a.filter((width) => b.includes(width));
const union = (a: readonly ReaderWidth[], b: readonly ReaderWidth[]) =>
  full.filter((width) => a.includes(width) || b.includes(width));
const complement = (a: readonly ReaderWidth[]) => full.filter((width) => !a.includes(width));
export function mergeBand(ranges: readonly BandSpan[]): BandSpan[] | null {
  const result: BandSpan[] = [];
  for (const span of ranges.toSorted((a, b) => a.lo - b.lo)) {
    const last = result.at(-1);
    if (last && span.lo <= last.hi + 1) last.hi = Math.max(last.hi, span.hi);
    else {
      result.push({ ...span });
      if (result.length > MAX_REVEAL_INTERVALS) return null;
    }
  }
  return result;
}
function intersectBand(a: readonly BandSpan[], b: readonly BandSpan[]): BandSpan[] | null {
  const result: BandSpan[] = [];
  let i = 0,
    j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i],
      y = b[j];
    if (!x || !y) break;
    const lo = Math.max(x.lo, y.lo),
      hi = Math.min(x.hi, y.hi);
    if (lo <= hi) result.push({ lo, hi });
    if (result.length > MAX_REVEAL_INTERVALS) return null;
    if (x.hi < y.hi) i++;
    else j++;
  }
  return result;
}
function complementBand(ranges: readonly BandSpan[]): BandSpan[] {
  const result: BandSpan[] = [];
  let lo = 0;
  for (const span of ranges) {
    if (lo < span.lo) result.push({ lo, hi: span.lo - 1 });
    lo = span.hi + 1;
  }
  if (lo <= 8000) result.push({ lo, hi: 8000 });
  return result;
}
export const andCoverage = (a: MediaCoverage, b: MediaCoverage): MediaCoverage => ({
  possible: intersection(a.possible, b.possible),
  certain: intersection(a.certain, b.certain),
  possibleBand: intersectBand(a.possibleBand, b.possibleBand) ?? band,
  certainBand: intersectBand(a.certainBand, b.certainBand) ?? [],
});
const orCoverage = (a: MediaCoverage, b: MediaCoverage): MediaCoverage => ({
  possible: union(a.possible, b.possible),
  certain: union(a.certain, b.certain),
  possibleBand: mergeBand([...a.possibleBand, ...b.possibleBand]) ?? band,
  certainBand: mergeBand([...a.certainBand, ...b.certainBand]) ?? [],
});
const notCoverage = (a: MediaCoverage): MediaCoverage => ({
  possible: complement(a.certain),
  certain: complement(a.possible),
  possibleBand: complementBand(a.certainBand),
  certainBand: complementBand(a.possibleBand),
});
function mediaLength(node: CssNode | null): number | null {
  if (!node || (node.type !== "Dimension" && node.type !== "Number")) return null;
  const value = Number(node.value);
  if (!Number.isFinite(value) || value < 0) return null;
  if (node.type === "Number") return value === 0 ? 0 : null;
  switch (ident.decode(node.unit).toLowerCase()) {
    case "px":
      return value;
    case "em":
    case "rem":
      return null;
    case "pt":
      return (value * 96) / 72;
    case "in":
      return value * 96;
    case "cm":
      return (value * 96) / 2.54;
    case "mm":
      return (value * 96) / 25.4;
    default:
      return null;
  }
}
function widthComparison(operator: string, value: number | null): MediaCoverage {
  if (value === null) return unknownMedia;
  const matches = (width: ReaderWidth) => {
    switch (operator) {
      case "=":
        return width === value;
      case "<":
        return width < value;
      case "<=":
        return width <= value;
      case ">":
        return width > value;
      case ">=":
        return width >= value;
      default:
        return true;
    }
  };
  if (!["=", "<", "<=", ">", ">="].includes(operator)) return unknownMedia;
  const widths = full.filter(matches);
  const lo =
    operator === ">"
      ? Math.floor(value) + 1
      : operator === ">=" || operator === "="
        ? Math.ceil(value)
        : 0;
  const hi =
    operator === "<"
      ? Math.ceil(value) - 1
      : operator === "<=" || operator === "="
        ? Math.floor(value)
        : 8000;
  const ranges =
    lo <= hi && hi >= 0 && lo <= 8000 ? [{ lo: Math.max(0, lo), hi: Math.min(8000, hi) }] : [];
  return { possible: widths, certain: widths, possibleBand: ranges, certainBand: ranges };
}
const isWidth = (node: CssNode) =>
  node.type === "Identifier" && ident.decode(node.name).toLowerCase() === "width";
function rangeComparison(a: CssNode, operator: string, b: CssNode): MediaCoverage {
  if (isWidth(a)) return widthComparison(operator, mediaLength(b));
  if (isWidth(b)) {
    const reversed =
      operator === "<"
        ? ">"
        : operator === "<="
          ? ">="
          : operator === ">"
            ? "<"
            : operator === ">="
              ? "<="
              : operator;
    return widthComparison(reversed, mediaLength(a));
  }
  return unknownMedia;
}
function mediaCondition(node: CssNode, environment: MediaEnvironment, depth = 0): MediaCoverage {
  if (depth > 64) return unknownMedia;
  if (node.type === "Feature") {
    const name = ident.decode(node.name).toLowerCase();
    if (!node.value && name === "width") return alwaysMedia;
    if (DISCRETE_FEATURES.has(name)) {
      const actual = environment.values.get(name);
      const wanted =
        node.value?.type === "Identifier" ? ident.decode(node.value.name).toLowerCase() : null;
      if (actual && wanted) return actual === wanted ? alwaysMedia : never;
      if (actual && !node.value) return actual === "none" ? never : alwaysMedia;
    }
    if (
      name === "-webkit-min-device-pixel-ratio" ||
      name === "-webkit-max-device-pixel-ratio" ||
      name === "-webkit-device-pixel-ratio"
    ) {
      if (environment.values.get("webkit-support") === "off") return never;
      const ratio = node.value?.type === "Number" ? Number(node.value.value) : null;
      if (ratio !== null && Number.isFinite(ratio)) {
        const matches =
          name === "-webkit-min-device-pixel-ratio"
            ? environment.pixelRatio >= ratio
            : name === "-webkit-max-device-pixel-ratio"
              ? environment.pixelRatio <= ratio
              : environment.pixelRatio === ratio;
        return matches ? alwaysMedia : never;
      }
    }
    if (name === "width" && mediaLength(node.value) !== null)
      return widthComparison("=", mediaLength(node.value));
    if (name === "min-width" && mediaLength(node.value) !== null)
      return widthComparison(">=", mediaLength(node.value));
    if (name === "max-width" && mediaLength(node.value) !== null)
      return widthComparison("<=", mediaLength(node.value));
    return environmentCondition(environment, opaqueFeature(node));
  }
  if (node.type === "FeatureRange") {
    const left = rangeComparison(node.left, node.leftComparison, node.middle);
    return node.right && node.rightComparison
      ? andCoverage(left, rangeComparison(node.middle, node.rightComparison, node.right))
      : left;
  }
  if (node.type !== "Condition")
    return environmentCondition(environment, `condition:${generate(node)}`);
  const children = node.children.toArray(),
    first = children[0];
  if (!first) return unknownMedia;
  if (first.type === "Identifier" && ident.decode(first.name).toLowerCase() === "not") {
    const operand = children[1];
    return children.length === 2 && operand
      ? notCoverage(mediaCondition(operand, environment, depth + 1))
      : unknownMedia;
  }
  let result = mediaCondition(first, environment, depth + 1),
    operator: string | null = null;
  for (let i = 1; i < children.length; i += 2) {
    const op = children[i],
      operand = children[i + 1];
    if (op?.type !== "Identifier" || !operand) return unknownMedia;
    const name = ident.decode(op.name).toLowerCase();
    if (name !== "and" && name !== "or") return unknownMedia;
    if (operator && operator !== name) return unknownMedia;
    operator = name;
    const next = mediaCondition(operand, environment, depth + 1);
    result = name === "and" ? andCoverage(result, next) : orCoverage(result, next);
  }
  return result;
}
function mediaQuery(node: CssNode, environment: MediaEnvironment): MediaCoverage {
  if (node.type !== "MediaQuery") return unknownMedia;
  const type = node.mediaType === null ? "all" : ident.decode(node.mediaType).toLowerCase();
  const modifier = node.modifier === null ? "" : ident.decode(node.modifier).toLowerCase();
  if (modifier !== "" && modifier !== "only" && modifier !== "not") return unknownMedia;
  const typeMatch =
    type === "screen" || type === "all"
      ? alwaysMedia
      : type === "print"
        ? never
        : environmentCondition(environment, `type:${type}`);
  const result = andCoverage(
    typeMatch,
    node.condition ? mediaCondition(node.condition, environment) : alwaysMedia,
  );
  return modifier === "not" ? notCoverage(result) : result;
}
export function referenceMedia(
  query: CssNode | string,
  environment: MediaEnvironment = BASE_MEDIA_ENVIRONMENT,
): MediaCoverage {
  try {
    const ast = typeof query === "string" ? parse(query, { context: "mediaQueryList" }) : query;
    if (ast.type === "AtrulePrelude")
      return ast.children.first ? referenceMedia(ast.children.first, environment) : unknownMedia;
    if (ast.type !== "MediaQueryList")
      return environmentCondition(environment, `query:${generate(ast)}`);
    let result = never;
    for (const child of ast.children) result = orCoverage(result, mediaQuery(child, environment));
    return result;
  } catch {
    return unknownMedia;
  }
}

interface MediaSource {
  readonly css: string;
  readonly media: string | undefined;
}
interface MediaSyntax {
  readonly stylesheet: (css: string) => CssNode;
  readonly media: (query: string) => CssNode;
}
/** Enumerate only variables used by this message, preserving correlated declarations. */
export function referenceEnvironments(
  sources: readonly MediaSource[],
  syntax: MediaSyntax,
): readonly MediaEnvironment[] {
  const domains = new Map<string, readonly string[]>();
  const ratios = new Set<number>();
  const query = (text: string) => {
    const ast = syntax.media(text);
    if (ast.type !== "MediaQueryList") {
      domains.set(`query:${generate(ast)}`, ["off", "on"]);
      return;
    }
    walk(ast, (node) => {
      if (node.type === "MediaQuery") {
        const kind = node.mediaType ? ident.decode(node.mediaType).toLowerCase() : "all";
        if (!["all", "screen", "print"].includes(kind)) domains.set(`type:${kind}`, ["off", "on"]);
      }
      if (node.type !== "Feature") return;
      const name = ident.decode(node.name).toLowerCase();
      const known = DISCRETE_FEATURES.get(name);
      if (known) {
        domains.set(name, known);
        return;
      }
      if (
        ["width", "min-width", "max-width"].includes(name) &&
        (!node.value || mediaLength(node.value) !== null)
      )
        return;
      if (
        [
          "-webkit-device-pixel-ratio",
          "-webkit-min-device-pixel-ratio",
          "-webkit-max-device-pixel-ratio",
        ].includes(name) &&
        node.value?.type === "Number"
      ) {
        const ratio = Number(node.value.value);
        if (Number.isFinite(ratio) && ratio >= 0) {
          ratios.add(ratio);
          return;
        }
      }
      domains.set(opaqueFeature(node), ["off", "on"]);
    });
  };
  for (const source of sources) {
    if (source.media) query(source.media);
    walk(syntax.stylesheet(source.css), (node) => {
      if (node.type !== "Atrule" || !node.block) return;
      const name = ident.decode(node.name).toLowerCase();
      if (name === "media" && node.prelude)
        query(node.prelude.type === "Raw" ? node.prelude.value : generate(node.prelude));
      else if (["supports", "layer", "container"].includes(name))
        domains.set(groupConditionKey(name, node.prelude), ["off", "on"]);
    });
  }
  if (ratios.size) domains.set("webkit-support", ["off", "on"]);
  let result: MediaEnvironment[] = [BASE_MEDIA_ENVIRONMENT];
  for (const [feature, values] of domains) {
    if (result.length * values.length > 64) throw new RangeError("Media scenario budget");
    result = result.flatMap((environment) =>
      values.map((value) => ({
        ...environment,
        values: new Map([...environment.values, [feature, value]]),
      })),
    );
  }
  if (ratios.size) {
    const candidates = new Set<number>([1]);
    for (const ratio of ratios)
      for (const value of [ratio, ratio - 0.001, ratio + 0.001])
        if (value > 0) candidates.add(value);
    if (result.length * candidates.size > 64) throw new RangeError("Media scenario budget");
    result = result.flatMap((environment) =>
      [...candidates].map((pixelRatio) => ({ ...environment, pixelRatio })),
    );
  }
  return result;
}
