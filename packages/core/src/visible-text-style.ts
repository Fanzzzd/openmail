import { MIN_VISIBLE_ALPHA, POINT_TO_PIXEL, tinyQuantity } from "./visible-text-constants.js";
import colorString from "color-string";
import {
  parse,
  generate,
  lexer,
  walk,
  type CssNode,
  type EnterOrLeaveFn,
} from "./css-tree-browser.js";
import { evaluateQuantity, INITIAL_TEXT_STYLE } from "./visible-text-inheritance.js";
import type { VisibleRemovalRule } from "./visible-text-diagnostics.js";

export type Rgba = readonly [number, number, number, number];
export function parseColour(value: string): Rgba | null {
  const parsed = colorString.get(value.trim());
  if (!parsed) return null;
  const [a, b, c, alpha] = parsed.value;
  if (a === undefined || b === undefined || c === undefined || alpha === undefined) return null;
  if (parsed.model === "rgb") return [a, b, c, alpha];
  if (parsed.model === "hsl") {
    const saturation = b / 100,
      light = c / 100;
    const amplitude = saturation * Math.min(light, 1 - light);
    const channel = (n: number) => {
      const k = (n + a / 30) % 12;
      return 255 * (light - amplitude * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
    };
    return [channel(0), channel(8), channel(4), alpha];
  }
  // HWB uses a fully saturated hue, mixed with white and black.
  const base = parseColour(`hsl(${a},100%,50%)`);
  if (!base) return null;
  const white = b / 100,
    black = c / 100;
  const channel = (component: number) =>
    white + black >= 1
      ? (255 * white) / (white + black)
      : component * (1 - white - black) + 255 * white;
  return [channel(base[0]), channel(base[1]), channel(base[2]), alpha];
}

export const REMOVAL_PROPERTIES = [
  "display",
  "content-visibility",
  "all",
  "opacity",
  "filter",
  "backdrop-filter",
  "mix-blend-mode",
  "transform",
  "scale",
  "zoom",
  "translate",
  "text-indent",
  "left",
  "right",
  "top",
  "bottom",
  "inset",
  "margin",
  "margin-left",
  "margin-right",
  "margin-top",
  "margin-bottom",
  "margin-inline-start",
  "clip",
  "clip-path",
  "-webkit-clip-path",
  "overflow",
  "overflow-x",
  "overflow-y",
  "contain",
  "height",
  "max-height",
  "width",
  "max-width",
  "line-height",
  "mask-image",
  "-webkit-mask-image",
] as const;
const parsedValue = (value: string) => {
  try {
    return parse(value, { context: "value" });
  } catch {
    return null;
  }
};
const quantity = (value: string) => {
  const ast = parsedValue(value);
  return ast ? evaluateQuantity(ast, INITIAL_TEXT_STYLE) : null;
};
const scalar = (value: string): number | null => {
  const match = /^([+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?)(%)?$/.exec(value);
  if (match) return Number(match[1]) / (match[2] ? 100 : 1);
  const q = quantity(value);
  return q?.unit === "number"
    ? q.value
    : q && value.includes("%")
      ? q.value / INITIAL_TEXT_STYLE.size.value
      : null;
};
const opacityValue = (value: string | undefined): number => {
  if (!value || /^(normal|none|initial|inherit|unset)$/.test(value)) return 1;
  const n = scalar(value);
  return n === null || !Number.isFinite(n) ? 0 : Math.min(1, Math.max(0, n));
};
export const tinyLength = (value: string | undefined): boolean => {
  if (!value) return false;
  const simple = /^([+-]?(?:\d*\.)?\d+)\s*(px|pt|em|rem|%|vw|vh|vmin|vmax)?$/.exec(value);
  if (simple) {
    const unit = simple[2];
    return (
      Number(simple[1]) <=
      (unit === "%" ? 15 : unit === "em" || unit === "rem" ? 0.15 : unit?.startsWith("v") ? 0.2 : 2)
    );
  }
  const q = quantity(value);
  return Boolean(q && tinyQuantity(q));
};
type FunctionNode = Extract<CssNode, { type: "Function" }>;
const functions = (value: string | undefined): FunctionNode[] => {
  if (!value) return [];
  const ast = parsedValue(value);
  const result: FunctionNode[] = [];
  if (ast)
    walk(ast, (node) => {
      if (node.type === "Function") result.push(node);
    });
  return result;
};
const argument = (node: FunctionNode): string => generate(node).slice(node.name.length + 1, -1);
const numericParts = (value: string): number[] => {
  const ast = parsedValue(value);
  if (ast?.type !== "Value") return [];
  return ast.children.toArray().flatMap((node) => {
    if (node.type === "Operator") return [];
    const text = generate(node);
    const n = scalar(text);
    return n === null || !Number.isFinite(n) ? [] : [n];
  });
};
export function styleEffects(css: ReadonlyMap<string, string>) {
  let filterOpacity = 1,
    scale = 1;
  const filter = css.get("filter");
  const filterAst = filter ? parsedValue(filter) : null;
  const plainOpacity =
    filterAst?.type === "Value" &&
    filterAst.children.size > 0 &&
    filterAst.children
      .toArray()
      .every((node) => node.type === "Function" && node.name === "opacity");
  const blend = css.get("mix-blend-mode");
  const backdrop = css.get("backdrop-filter");
  const destructiveFilter = Boolean(
    (filter && !/^(none|initial|unset|inherit)$/.test(filter) && !plainOpacity) ||
    (blend && !/^(normal|initial|unset)$/.test(blend)) ||
    (backdrop && !/^(none|initial|unset)$/.test(backdrop)),
  );
  if (filterAst?.type === "Value")
    for (const fn of filterAst.children) {
      if (fn.type === "Function" && fn.name === "opacity")
        filterOpacity *= opacityValue(argument(fn));
    }
  for (const fn of functions(css.get("transform"))) {
    const parts = numericParts(argument(fn));
    if (["scale", "scalex", "scaley", "scale3d"].includes(fn.name))
      scale *= Math.min(...parts.slice(0, 2).map(Math.abs), 1);
    if (["rotatex", "rotatey"].includes(fn.name)) {
      const m = /^([+-]?[\d.]+)(deg|rad|turn|grad)$/.exec(argument(fn));
      if (m) {
        const radians =
          Number(m[1]) *
          (m[2] === "rad"
            ? 1
            : m[2] === "turn"
              ? 2 * Math.PI
              : m[2] === "grad"
                ? Math.PI / 200
                : Math.PI / 180);
        scale *= Math.abs(Math.cos(radians));
      }
    }
    if (fn.name === "matrix" && parts.length === 6)
      scale *= Math.min(
        1,
        Math.sqrt(Math.abs((parts[0] ?? 0) * (parts[3] ?? 0) - (parts[1] ?? 0) * (parts[2] ?? 0))),
      );
    if (fn.name === "matrix3d" && parts.length === 16)
      scale *= Math.min(
        1,
        Math.sqrt(Math.abs((parts[0] ?? 0) * (parts[5] ?? 0) - (parts[1] ?? 0) * (parts[4] ?? 0))),
      );
  }
  const transformScale = scale;
  let scaleValue = 1;
  const independentScale = css.get("scale");
  if (independentScale && independentScale !== "none")
    scaleValue = Math.min(...numericParts(independentScale).map(Math.abs), 1);
  scale *= scaleValue;
  return {
    opacity: opacityValue(css.get("opacity")),
    filterOpacity,
    scale,
    transformScale,
    scaleValue,
    zoom: css.has("zoom") ? Math.max(0, scalar(css.get("zoom") ?? "") ?? 1) : 1,
    destructiveFilter,
  };
}
const offscreen = (value: string | undefined, positive = false): boolean => {
  if (!value) return false;
  if (/^-\d+(?:\.\d+)?%$/.test(value) && Number(value.slice(0, -1)) <= -100) return true;
  const ast = parsedValue(value);
  if (ast?.type !== "Value") return false;
  return ast.children.toArray().some((node) => {
    const q = evaluateQuantity(node, INITIAL_TEXT_STYLE);
    return Boolean(
      q &&
      q.unit !== "number" &&
      (q.value <=
        (q.unit === "vw" || q.unit === "vh" || q.unit === "vmin" || q.unit === "vmax"
          ? -50
          : q.unit === "pt"
            ? -75
            : -100) ||
        (positive && q.value * (q.unit === "pt" ? POINT_TO_PIXEL : 1) >= 9999)),
    );
  });
};
/** Colour tokens from gradients, shorthands and shadows. */
function colourTokens(value: string | undefined): string[] {
  if (!value) return [];
  const ast = parsedValue(value);
  if (!ast) return [];
  const result: string[] = [];
  const collect: EnterOrLeaveFn = function (node) {
    if (node.type === "Identifier" || node.type === "Hash" || node.type === "Function") {
      try {
        if (lexer.matchType("color", node).matched) {
          result.push(generate(node));
          return this.skip;
        }
      } catch {
        /* A non-colour token contributes no colour. */
      }
    }
    return null;
  };
  walk(ast, { enter: collect });
  return result;
}
function backgroundColour(value: string | undefined): string | null {
  if (!value) return null;
  const ast = parsedValue(value);
  if (ast?.type !== "Value") return null;
  for (const node of ast.children.toArray().toReversed()) {
    if (!["Identifier", "Hash", "Function"].includes(node.type)) continue;
    try {
      if (lexer.matchType("color", node).matched) return generate(node);
    } catch {
      /* Not a colour. */
    }
  }
  return null;
}
export interface ShadowPaint {
  readonly inset: boolean;
  readonly colour: string;
  readonly lengths: readonly number[];
}
export function shadowPaints(value: string | undefined): readonly ShadowPaint[] {
  const ast = value ? parsedValue(value) : null;
  if (ast?.type !== "Value") return [];
  const groups: CssNode[][] = [[]];
  for (const node of ast.children) {
    if (node.type === "Operator" && node.value === ",") groups.push([]);
    else groups.at(-1)?.push(node);
  }
  return groups.flatMap((nodes) => {
    const text = nodes.map((node) => generate(node)).join(" ");
    const lengths = nodes.flatMap((node) => {
      const q = evaluateQuantity(node, INITIAL_TEXT_STYLE);
      return q ? [q.value * (q.unit === "pt" ? POINT_TO_PIXEL : 1)] : [];
    });
    if (lengths.length < 2) return [];
    return [
      {
        inset: nodes.some((node) => node.type === "Identifier" && node.name === "inset"),
        colour: colourTokens(text).at(-1) ?? "currentcolor",
        lengths,
      },
    ];
  });
}
/** Constant lengths used for conservative reach, including calc/em/percent. */
export function paintLengths(value: string | undefined): readonly number[] {
  if (!value) return [];
  // Margins and declared sizes usually contain plain lengths. Avoid building
  // the same tiny AST for every element, width and media environment.
  const simple: number[] = [];
  for (const part of value.trim().split(/\s+/)) {
    const token = /^([+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?)(px|pt|em|rem|%)?$/i.exec(part);
    const number = token ? Number(token[1]) : NaN;
    if (!token || !Number.isFinite(number)) {
      simple.length = 0;
      break;
    }
    const unit = token[2]?.toLowerCase();
    simple.push(
      unit === "pt"
        ? number * POINT_TO_PIXEL
        : unit === "em" || unit === "rem"
          ? number *
            (unit === "rem" ? INITIAL_TEXT_STYLE.rootSize.value : INITIAL_TEXT_STYLE.size.value)
          : unit === "%"
            ? (number * INITIAL_TEXT_STYLE.size.value) / 100
            : number,
    );
  }
  if (simple.length) return simple;
  const ast = parsedValue(value);
  if (ast?.type !== "Value") return [];
  return ast.children.toArray().flatMap((node) => {
    const q = evaluateQuantity(node, INITIAL_TEXT_STYLE);
    return q ? [q.value * (q.unit === "pt" ? POINT_TO_PIXEL : 1)] : [];
  });
}
const transparentMask = (value: string | undefined) =>
  functions(value).some((fn) => {
    if (!fn.name.endsWith("gradient")) return false;
    const colours = colourTokens(argument(fn));
    return (
      colours.length >= 2 &&
      colours.every((token) => {
        const parsed = parseColour(token);
        if (parsed) return parsed[3] <= MIN_VISIBLE_ALPHA;
        return /\/\s*0(?:\.0+)?%?\s*\)$/.test(token);
      })
    );
  });
export function subtreeStyleRemovalRule(
  css: ReadonlyMap<string, string>,
  effects = styleEffects(css),
): VisibleRemovalRule | null {
  if (css.get("display") === "none") return "display-none";
  if (css.get("content-visibility") === "hidden") return "content-visibility";
  if (effects.opacity <= MIN_VISIBLE_ALPHA) return "opacity";
  if (effects.filterOpacity <= MIN_VISIBLE_ALPHA) return "filter-opacity";
  if (effects.scale <= MIN_VISIBLE_ALPHA) return "scale";
  if (effects.zoom <= MIN_VISIBLE_ALPHA) return "zoom";
  if (effects.opacity * effects.filterOpacity * effects.scale * effects.zoom <= MIN_VISIBLE_ALPHA)
    return "opacity";
  if (effects.destructiveFilter) return "uncertain-paint";
  if (
    [
      "text-indent",
      "left",
      "top",
      "margin",
      "margin-left",
      "margin-right",
      "margin-top",
      "margin-bottom",
    ].some((key) => offscreen(css.get(key))) ||
    ["right", "bottom", "inset", "margin-inline-start", "translate"].some((key) =>
      offscreen(css.get(key), true),
    )
  )
    return "off-screen";
  for (const fn of functions(css.get("transform"))) {
    if (fn.name.startsWith("translate") && offscreen(argument(fn).replaceAll(",", " "), true))
      return "off-screen";
    const parts = numericParts(argument(fn));
    if (
      (fn.name === "matrix" && parts.slice(4).some((n) => Math.abs(n) >= 9999)) ||
      (fn.name === "matrix3d" && parts.slice(12, 14).some((n) => Math.abs(n) >= 9999))
    )
      return "off-screen";
  }
  const overflow = ["overflow", "overflow-x", "overflow-y"].some((key) =>
    /\b(hidden|clip)\b/.test(css.get(key) ?? ""),
  );
  const paint = /\b(paint|strict|content)\b/.test(css.get("contain") ?? "");
  if (
    (css.has("clip") && css.get("clip") !== "auto") ||
    ["clip-path", "-webkit-clip-path"].some((key) => css.has(key) && css.get(key) !== "none") ||
    ["mask-image", "-webkit-mask-image"].some((key) => transparentMask(css.get(key))) ||
    ((overflow || paint) &&
      (["height", "max-height", "width", "max-width"].some((key) => tinyLength(css.get(key))) ||
        quantity(css.get("line-height") ?? "")?.value === 0))
  )
    return "clipping";
  return null;
}

/** Expand the painted longhands so shorthand/longhand precedence is shared. */
export function backgroundLonghands(node: CssNode): readonly [CssNode, CssNode] {
  if (node.type !== "Value") return [node, node];
  const tokens = node.children.toArray();
  if (
    tokens.length === 1 &&
    tokens[0]?.type === "Identifier" &&
    /^(initial|inherit|unset|revert|revert-layer)$/.test(tokens[0].name)
  )
    return [node, node];
  const colour = backgroundColour(generate(node)) ?? "transparent";
  const images = tokens.filter((token) => {
    try {
      return Boolean(lexer.matchType("image", token).matched);
    } catch {
      return false;
    }
  });
  return [
    parse(colour, { context: "value" }),
    parse(images.length ? images.map((image) => generate(image)).join(",") : "none", {
      context: "value",
    }),
  ];
}
export function gradientColours(value: string | undefined): readonly string[] {
  return functions(value)
    .filter((fn) => fn.name.endsWith("gradient"))
    .flatMap((fn) => colourTokens(argument(fn)));
}

export function outlineLonghands(node: CssNode): readonly (readonly [string, CssNode])[] {
  if (node.type !== "Value") return [];
  const tokens = node.children.toArray();
  if (
    tokens.length === 1 &&
    tokens[0]?.type === "Identifier" &&
    /^(initial|inherit|unset|revert|revert-layer)$/.test(tokens[0].name)
  )
    return ["outline-width", "outline-style", "outline-color"].map((key) => [key, node]);
  return ["outline-width", "outline-style", "outline-color"].map((key) => {
    const token = tokens.find((part) => {
      try {
        return Boolean(lexer.matchProperty(key, part).matched);
      } catch {
        return false;
      }
    });
    return [
      key,
      token ??
        parse(
          key === "outline-width" ? "medium" : key === "outline-style" ? "none" : "currentcolor",
          { context: "value" },
        ),
    ];
  });
}

/** Expand margins before comparing longhand/shorthand cascade precedence. */
export function marginLonghands(
  property: string,
  node: CssNode,
): readonly (readonly [string, CssNode])[] {
  const keys =
    property === "margin"
      ? ["margin-top", "margin-right", "margin-bottom", "margin-left"]
      : property === "margin-inline"
        ? ["margin-inline-start", "margin-inline-end"]
        : ["margin-block-start", "margin-block-end"];
  if (node.type !== "Value") return keys.map((key) => [key, node]);
  const tokens = node.children.toArray();
  const first = tokens[0];
  if (!first) return [];
  const values =
    keys.length === 4
      ? [first, tokens[1] ?? first, tokens[2] ?? first, tokens[3] ?? tokens[1] ?? first]
      : [first, tokens[1] ?? first];
  return keys.flatMap((key, index) => {
    const value = values[index];
    return value ? [[key, value]] : [];
  });
}
