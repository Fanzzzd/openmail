import colorString from "color-string";
import { compile } from "css-select";
import { ElementType, parseDocument } from "htmlparser2";
import { decodeCssEscapes, prepareMessageHtml } from "./reader-html.js";
import { parse, ident } from "./css-tree-browser.js";
import { flattenHtmlChildren, MAX_HTML_DEPTH } from "./html-depth.js";
import type { ModelThread } from "./mailbox.js";

export type ModelTextFlag = NonNullable<ModelThread["messages"][number]["flags"]>[number];
type VisibleText =
  | { text: string; hidden: boolean }
  | { text: string; hidden: boolean; flags: readonly ["budget-exceeded"] };
const BLOCK = /^(p|div|br|tr|li|h[1-6]|section|article|blockquote|table)$/;
const OMIT = new Set([
  "head",
  "style",
  "script",
  "template",
  "noscript",
  "iframe",
  "object",
  "title",
  "desc",
  "video",
  "audio",
  "canvas",
  "datalist",
]);
const declarations = (style: string) =>
  new Map(
    decodeCssEscapes(style)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .toLowerCase()
      .split(";")
      .flatMap((part) => {
        const at = part.indexOf(":");
        return at < 0
          ? []
          : [
              [
                part.slice(0, at).trim(),
                part
                  .slice(at + 1)
                  .replace(/\s*!important\s*$/, "")
                  .trim(),
              ],
            ];
      }),
  );
type Rgba = readonly [number, number, number, number];
function color(value: string): Rgba | null {
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
  const base = color(`hsl(${a},100%,50%)`);
  if (!base) return null;
  const white = b / 100,
    black = c / 100;
  const channel = (component: number) =>
    white + black >= 1
      ? (255 * white) / (white + black)
      : component * (1 - white - black) + 255 * white;
  return [channel(base[0]), channel(base[1]), channel(base[2]), alpha];
}
const composite = (ink: Rgba, paper: Rgba): Rgba => [
  ink[0] * ink[3] + paper[0] * (1 - ink[3]),
  ink[1] * ink[3] + paper[1] * (1 - ink[3]),
  ink[2] * ink[3] + paper[2] * (1 - ink[3]),
  1,
];
function backgroundColor(value: string | undefined): Rgba | null {
  if (!value) return null;
  const source = value.replace(/url\((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^)]*)\)/gi, "");
  const tokens = source.match(/(?:rgba?|hsla?|hwb)\([^)]*\)|#[\da-f]{3,8}\b|\b[a-z]+\b/gi) ?? [];
  for (const token of tokens.toReversed()) {
    const parsed = color(token);
    if (parsed) return parsed;
  }
  return null;
}
const invisibleInk = (foreground: string, background: Rgba, opacity: number) => {
  const ink = color(foreground);
  if (!ink) return false;
  if (ink[3] * opacity <= 0.1) return true;
  const visible = composite(ink, background);
  return [0, 1, 2].every((i) => Math.abs((visible[i] ?? 0) - (background[i] ?? 0)) <= 16);
};
const small = (value: string | undefined) => {
  const match = /^(\d*\.?\d+)\s*(px|pt|em|rem|%|vw|vh|vmin|vmax)?$/.exec(value ?? "");
  if (!match) return false;
  const number = Number(match[1]),
    unit = match[2];
  return (
    number <=
    (unit === "%" ? 15 : unit === "em" || unit === "rem" ? 0.15 : unit?.startsWith("v") ? 0.2 : 2)
  );
};
const opacityValue = (value: string | undefined): number => {
  if (!value) return 1;
  const number = parseFloat(value) / (value.endsWith("%") ? 100 : 1);
  return Number.isFinite(number) ? Math.max(0, number) : 1;
};
const smallScale = (value: string | undefined) =>
  [...(value ?? "").matchAll(/scale(?:x|y|3d)?\(([^)]+)\)/gi)].some((match) =>
    (match[1] ?? "")
      .split(/[,\s]+/)
      .slice(0, 2)
      .some((number) => number !== "" && Math.abs(Number(number)) <= 0.1),
  );
const offscreen = (value: string | undefined) =>
  (value ?? "").split(/\s+/).some((part) => {
    const match = /^(-\d*\.?\d+)(px|pt|em|rem|vw|vh)$/.exec(part);
    if (!match) return false;
    const threshold =
      match[2] === "em" || match[2] === "rem"
        ? -10
        : match[2] === "vw" || match[2] === "vh"
          ? -50
          : match[2] === "pt"
            ? -75
            : -100;
    return Number(match[1]) <= threshold;
  });
const hiddenStyle = (css: Map<string, string>) =>
  css.get("display") === "none" ||
  /^(hidden|collapse)$/.test(css.get("visibility") ?? "") ||
  opacityValue(css.get("opacity")) <= 0.1 ||
  small(css.get("font-size")) ||
  smallScale(css.get("transform")) ||
  [
    "text-indent",
    "left",
    "top",
    "margin",
    "margin-left",
    "margin-right",
    "margin-top",
    "margin-bottom",
  ].some((key) => offscreen(css.get(key)));

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

const normalizeHtmlText = (text: string) =>
  text
    .replace(/[\t \u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();

/** Filter hidden text within a bounded CSS inspection; exhaustion is explicit. */
export function visibleHtmlText(
  html: string,
  budgetFallback: "visible" | "index-full-text" = "visible",
): VisibleText {
  const dom = parseDocument(prepareMessageHtml(html).html);
  type HtmlNode = (typeof dom.children)[number];
  const elements: HtmlNode[] = [];
  const classes = new Map<string, HtmlNode[]>();
  const ids = new Map<string, HtmlNode[]>();
  const tags = new Map<string, HtmlNode[]>();
  const stylesheets: string[] = [];
  const index = (map: Map<string, HtmlNode[]>, key: string, node: HtmlNode) => {
    const nodes = map.get(key);
    if (nodes) nodes.push(node);
    else map.set(key, [node]);
  };
  const indexedNodes = dom.children.toReversed();
  while (indexedNodes.length) {
    const node = indexedNodes.pop();
    if (!node) continue;
    if ("name" in node && "attribs" in node) {
      elements.push(node);
      index(tags, node.name, node);
      if (node.attribs.id) index(ids, node.attribs.id, node);
      for (const name of new Set((node.attribs.class ?? "").split(/\s+/).filter(Boolean)))
        index(classes, name, node);
      if (node.name === "style") {
        stylesheets.push(
          node.children
            .flatMap((child) => (child.type === ElementType.Text ? [child.data] : []))
            .join(""),
        );
        continue;
      }
    }
    if ("children" in node)
      for (const child of node.children.toReversed()) indexedNodes.push(child);
  }
  // Index only the last compound selector; pseudo-class arguments and ancestor
  // selectors remain the compiler's job. Impossible classes/ids/tags cost no budget.
  const candidates = (selector: string): HtmlNode[] => {
    const ast = parse(selector, { context: "selector" });
    if (ast.type !== "Selector") return elements;
    let selected: HtmlNode[] | undefined;
    for (const token of ast.children) {
      if (token.type === "Combinator") selected = undefined;
      else {
        const name =
          "name" in token && typeof token.name === "string" ? ident.decode(token.name) : "";
        const nodes =
          token.type === "ClassSelector"
            ? (classes.get(name) ?? [])
            : token.type === "IdSelector"
              ? (ids.get(name) ?? [])
              : token.type === "TypeSelector" && name !== "*" && !name.includes("|")
                ? (tags.get(name.toLowerCase()) ?? [])
                : undefined;
        if (nodes && (!selected || nodes.length < selected.length)) selected = nodes;
      }
    }
    return selected ?? elements;
  };
  const styles = new Map<HtmlNode, string[]>();
  let ruleBudget = 5120;
  let matchesRemaining = 2_500_000;
  const collect = (): boolean => {
    for (const stylesheet of stylesheets) {
      for (const rule of stylesheet
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/<!--|-->/g, "")
        .matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        for (const selector of (rule[1] ?? "").split(",")) {
          const decoded = decodeCssEscapes(selector.trim());
          // Empty/invalid selectors are ignored, rather than charged as matches.
          if (!decoded) continue;
          if (decoded.length > 20_480) return true;
          try {
            const targets = candidates(decoded);
            if (!targets.length) continue;
            const match = compile(decoded);
            const matched: HtmlNode[] = [];
            for (const node of targets) {
              if (--matchesRemaining < 0) return true;
              if (match(node)) matched.push(node);
            }
            if (!matched.length) continue;
            if (--ruleBudget < 0) return true;
            for (const node of matched) {
              const previous = styles.get(node);
              if (previous) previous.push(rule[2] ?? "");
              else styles.set(node, [rule[2] ?? ""]);
            }
          } catch {
            /* Invalid selectors do not match. */
          }
        }
      }
    }
    return false;
  };
  const fallback = (): VisibleText => {
    type Frame = { kind: "node"; node: HtmlNode } | { kind: "line" };
    const pending: Frame[] = dom.children.toReversed().map((node) => ({ kind: "node", node }));
    const out: string[] = [];
    let removed = false;
    while (pending.length) {
      const frame = pending.pop();
      if (!frame) continue;
      if (frame.kind === "line") {
        out.push("\n");
        continue;
      }
      const node = frame.node;
      if (node.type === ElementType.Text) {
        out.push(node.data);
        continue;
      }
      if (!("name" in node)) continue;
      if (OMIT.has(node.name)) continue;
      if (
        budgetFallback === "visible" &&
        "attribs" in node &&
        ("hidden" in node.attribs ||
          node.attribs["aria-hidden"]?.toLowerCase() === "true" ||
          hiddenStyle(declarations(node.attribs.style ?? "")))
      ) {
        removed = true;
        continue;
      }
      if (BLOCK.test(node.name)) {
        out.push("\n");
        pending.push({ kind: "line" });
      }
      if ("children" in node)
        for (const child of node.children.toReversed()) pending.push({ kind: "node", node: child });
    }
    return { text: normalizeHtmlText(out.join("")), hidden: removed, flags: ["budget-exceeded"] };
  };
  if (collect()) return fallback();
  // htmlparser2's textContent recursively walks descendants. Hidden sender
  // subtrees can be arbitrarily deep, so inspect text with an explicit stack.
  const hasText = (node: (typeof dom.children)[number]): boolean => {
    const pending = [node];
    while (pending.length) {
      const current = pending.pop();
      if (!current) continue;
      if (current.type === ElementType.Text && current.data.trim()) return true;
      if ("children" in current) for (const child of current.children) pending.push(child);
    }
    return false;
  };
  let hidden = false;
  const out: string[] = [];
  const walk = (
    parent: Pick<typeof dom, "children">,
    inherited: { color: string; background: Rgba; size: string; opacity: number } = {
      color: "#1f1f1f",
      background: [255, 255, 255, 1],
      size: "14px",
      opacity: 1,
    },
    depth = 0,
  ): void => {
    if (depth >= MAX_HTML_DEPTH)
      parent.children = flattenHtmlChildren(
        parent.children,
        (node) => "name" in node && OMIT.has(node.name),
      );
    for (const node of parent.children) {
      if (node.type === ElementType.Text) {
        if (invisibleInk(inherited.color, inherited.background, inherited.opacity)) {
          if (node.data.trim()) hidden = true;
          continue;
        }
        out.push(node.data);
        continue;
      }
      if (!("name" in node) || !("attribs" in node)) continue;
      if (OMIT.has(node.name)) {
        if (!["head", "style"].includes(node.name) && hasText(node)) hidden = true;
        continue;
      }
      const attrs = node.attribs;
      const matching = styles.get(node) ?? [];
      const css = declarations([...matching, attrs.style ?? ""].join(";"));
      const ink = css.get("color") ?? attrs.color ?? inherited.color;
      const foreground = /^(inherit|unset)$/.test(ink) ? inherited.color : ink;
      const backdrop = backgroundColor(
        css.get("background-color") ?? css.get("background") ?? attrs.bgcolor,
      );
      const background = backdrop
        ? composite(backdrop, inherited.background)
        : inherited.background;
      const opacity = inherited.opacity * opacityValue(css.get("opacity"));
      const size = css.get("font-size") ?? inherited.size;
      const clipped =
        (css.has("clip") && css.get("clip") !== "auto") ||
        (css.has("clip-path") && css.get("clip-path") !== "none") ||
        (css.get("overflow") === "hidden" &&
          (small(css.get("height")) ||
            small(css.get("max-height")) ||
            small(css.get("width")) ||
            small(css.get("max-width"))));
      const invisible =
        matching.some((rule) => hiddenStyle(declarations(rule))) ||
        "hidden" in attrs ||
        attrs["aria-hidden"]?.toLowerCase() === "true" ||
        css.get("display") === "none" ||
        /^(hidden|collapse)$/.test(css.get("visibility") ?? "") ||
        opacity <= 0.1 ||
        small(size) ||
        clipped ||
        hiddenStyle(css) ||
        /opacity\(\s*(?:0(?:\.0+)?|0?\.1|[0-9]|10)%?\s*\)/.test(css.get("filter") ?? "");
      if (invisible) {
        if (hasText(node)) hidden = true;
        continue;
      }
      if (BLOCK.test(node.name)) out.push("\n");
      walk(node, { color: foreground, background, size, opacity }, depth + 1);
      if (BLOCK.test(node.name)) out.push("\n");
    }
  };
  walk(dom);
  return {
    text: normalizeHtmlText(out.join("")),
    hidden,
  };
}

export function messageModelText(
  plain: string,
  html: string,
): { text: string; flags: ModelTextFlag[] } {
  if (!html.trim()) return { text: plain, flags: [] };
  const visible = visibleHtmlText(html);
  if ("flags" in visible)
    return {
      // Providers can derive `plain` from this same HTML for HTML-only mail.
      // Without provenance it is not a trustworthy text/plain alternative.
      text: "[Message too complex for AI: message text omitted.]",
      flags: [...visible.flags, ...(visible.hidden ? ["hidden-text-removed" as const] : [])],
    };
  const a = normalize(plain),
    b = normalize(visible.text);
  const words = new Set(b.split(/\s+/));
  const source = a.split(/\s+/).filter(Boolean);
  const extra = source.filter((word) => !words.has(word)).length;
  const differs =
    !!a &&
    (Math.abs(a.length - b.length) > Math.max(20, b.length * 0.2) ||
      extra > Math.max(3, source.length * 0.2) ||
      (a.length >= 5 && extra > 0 && extra / source.length >= 0.5));
  return {
    text: visible.text,
    flags: [
      ...(visible.hidden ? ["hidden-text-removed" as const] : []),
      ...(differs ? ["plain-differs" as const] : []),
    ],
  };
}
