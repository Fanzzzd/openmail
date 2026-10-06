import { MAX_MEDIA_WIDTH, MAX_ALTERNATIVES, EFFECT_PROPERTIES } from "./visible-text-constants.js";
import {
  parse,
  generate,
  ident,
  lexer,
  walk,
  type CssNode,
  type EnterOrLeaveFn,
} from "./css-tree-browser.js";
import {
  alwaysMedia,
  andCoverage,
  referenceMedia,
  BASE_MEDIA_ENVIRONMENT,
  groupMedia,
  type MediaEnvironment,
  type MediaCoverage,
  type ReaderWidth,
  type BandSpan,
  MAX_REVEAL_INTERVALS,
  mergeBand,
} from "./visible-text-media.js";
export {
  REFERENCE_READER_WIDTHS,
  referenceMedia,
  type MediaCoverage,
  type ReaderWidth,
} from "./visible-text-media.js";
import { READER_ATTRIBUTES } from "./reader-sanitize.js";
import { resolveFont, INITIAL_TEXT_STYLE } from "./visible-text-inheritance.js";
import {
  subtreeStyleRemovalRule,
  tinyLength,
  REMOVAL_PROPERTIES,
  styleEffects,
  backgroundLonghands,
  outlineLonghands,
  marginLonghands,
} from "./visible-text-style.js";
import type { VisibleRemovalSource, VisibleRemovalRule } from "./visible-text-diagnostics.js";

type Specificity = readonly [number, number, number];
const zero: Specificity = [0, 0, 0];
function compareSpecificity(a: Specificity, b: Specificity): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
const add = (a: Specificity, b: Specificity): Specificity => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
function specificity(node: CssNode, depth = 0): Specificity {
  if (depth > 64) throw new RangeError("Selector nesting budget");
  switch (node.type) {
    case "IdSelector":
      return [1, 0, 0];
    case "ClassSelector":
    case "AttributeSelector":
      return [0, 1, 0];
    case "TypeSelector":
      return node.name.split("|").at(-1) === "*" ? zero : [0, 0, 1];
    case "PseudoElementSelector":
      return [0, 0, 1];
    case "Selector": {
      let result = zero;
      for (const child of node.children) result = add(result, specificity(child, depth + 1));
      return result;
    }
    case "SelectorList": {
      let result = zero;
      for (const child of node.children) {
        const next = specificity(child, depth + 1);
        if (compareSpecificity(next, result) > 0) result = next;
      }
      return result;
    }
    case "PseudoClassSelector": {
      const name = ident.decode(node.name).toLowerCase();
      if (name === "where") return zero;
      let argumentsSpecificity = zero;
      for (const child of node.children ?? [])
        argumentsSpecificity = add(argumentsSpecificity, specificity(child, depth + 1));
      return ["is", "not", "has"].includes(name)
        ? argumentsSpecificity
        : add([0, 1, 0], argumentsSpecificity);
    }
    case "Nth":
      return node.selector ? specificity(node.selector, depth + 1) : zero;
    default:
      return zero;
  }
}
export interface Declaration {
  readonly property: string;
  readonly value: string;
  readonly node: CssNode;
  readonly important: boolean;
  readonly uncertain: boolean;
}
export interface ParsedStyle {
  readonly declarations: readonly Declaration[];
  readonly barrier: VisibleRemovalRule | null;
}
export interface VisibleStyleRule {
  readonly selector: string;
  readonly reveal: boolean;
  readonly specificity: Specificity;
  readonly style: ParsedStyle;
  readonly media: MediaCoverage;
}
export interface VisibleCascade {
  readonly values: ReadonlyMap<string, string>;
  readonly sources: ReadonlyMap<string, VisibleRemovalSource>;
  readonly nodes: ReadonlyMap<string, CssNode>;
  readonly uncertain: boolean;
  readonly barrier: VisibleRemovalRule | null;
  readonly effects: ReturnType<typeof styleEffects>;
  readonly alternatives: ReadonlyMap<string, readonly string[]>;
}
const properties = new Set<string>([
  ...REMOVAL_PROPERTIES,
  "visibility",
  "font",
  "font-size",
  "color",
  "-webkit-text-fill-color",
  "background",
  "background-color",
  "background-image",
  "box-shadow",
  "position",
  "z-index",
  "outline",
  "outline-width",
  "outline-style",
  "outline-color",
  "outline-offset",
  "mask",
  "margin-inline",
  "margin-block",
  "margin-inline-end",
  "margin-block-start",
  "margin-block-end",
  "inset-inline",
  "inset-block",
]);
const MAX_DECLARATIONS = 8192;
function normalizeValue(value: CssNode): boolean {
  let uncertain = false;
  walk(value, (node) => {
    if (node.type === "Identifier" || node.type === "Function")
      node.name = ident.decode(node.name).toLowerCase();
    if (node.type === "Dimension") node.unit = ident.decode(node.unit).toLowerCase();
    if (
      (node.type === "Function" && ["var", "env", "attr"].includes(node.name)) ||
      (node.type === "Identifier" && node.name === "revert-layer")
    )
      uncertain = true;
  });
  return uncertain;
}
function validDeclaration(property: string, node: CssNode): boolean {
  // New browser colour spaces may precede css-tree's grammar. They cannot
  // establish contrast, but must not silently fall back to readable default ink.
  if (
    (property === "color" ||
      property === "-webkit-text-fill-color" ||
      property === "background-color") &&
    node.type === "Value" &&
    node.children.size === 1 &&
    node.children.first?.type === "Function" &&
    ["lab", "lch", "oklab", "oklch", "color", "color-mix", "light-dark"].includes(
      node.children.first.name,
    )
  )
    return true;
  try {
    return Boolean(
      lexer.matchProperty(property === "-webkit-text-fill-color" ? "color" : property, node)
        .matched,
    );
  } catch {
    return false;
  }
}
function hiding(declaration: Declaration): boolean {
  const { property, value, node, uncertain } = declaration;
  if (
    uncertain ||
    [
      "position",
      "z-index",
      "transform",
      "translate",
      "box-shadow",
      "outline",
      "outline-color",
      "outline-width",
      "outline-style",
      "mask",
    ].includes(property) ||
    property.startsWith("margin") ||
    ["top", "left", "right", "bottom", "inset"].includes(property)
  )
    return true;
  if (property === "opacity" || property === "zoom")
    return (
      styleEffects(new Map([[property, value]])).opacity < 1 ||
      styleEffects(new Map([[property, value]])).zoom < 1
    );
  if (["filter", "backdrop-filter", "mix-blend-mode", "transform", "scale"].includes(property)) {
    const effects = styleEffects(new Map([[property, value]]));
    if (effects.filterOpacity * effects.scale < 1 || effects.destructiveFilter) return true;
  }
  if (property === "visibility") return value === "hidden" || value === "collapse";
  if (property === "font-size") {
    const font = resolveFont(node, INITIAL_TEXT_STYLE);
    return (
      !font ||
      font.value <= (font.unit === "px" || font.unit === "pt" ? 2 : 0.2) ||
      /em|%|inherit|unset|revert/.test(value)
    );
  }
  // Colour/background/line metrics can hide in combinations; uncertainty cannot reveal.
  if (
    [
      "color",
      "background",
      "background-color",
      "background-image",
      "-webkit-text-fill-color",
      "line-height",
    ].includes(property)
  )
    return true;
  return (
    subtreeStyleRemovalRule(new Map([[property, value]])) !== null ||
    (property === "overflow" && value === "hidden") ||
    (["height", "max-height", "width", "max-width"].includes(property) && tinyLength(value))
  );
}
/** Validate before last-wins/important compaction, for inline and stylesheet blocks. */
function parseDeclarations(nodes: Iterable<CssNode>): ParsedStyle {
  const selected = new Map<string, Declaration>();
  let count = 0;
  const addDeclaration = (
    property: string,
    node: CssNode,
    important: boolean,
    uncertain: boolean,
  ) => {
    const old = selected.get(property);
    if (!old || important || !old.important)
      selected.set(property, {
        property,
        value: generate(node).toLowerCase(),
        node,
        important,
        uncertain,
      });
  };
  for (const declaration of nodes) {
    if (++count > MAX_DECLARATIONS) throw new RangeError("Declaration budget");
    if (
      declaration.type !== "Declaration" ||
      declaration.value.type !== "Value" ||
      typeof declaration.important === "string"
    )
      continue;
    const decodedProperty = ident.decode(declaration.property).toLowerCase();
    const standard = decodedProperty.replace(/^-(webkit|moz)-/, "");
    const property = standard === "text-fill-color" ? "-webkit-text-fill-color" : standard;
    if (!properties.has(property)) continue;
    const uncertain = normalizeValue(declaration.value) || property === "all";
    if (!uncertain && !validDeclaration(property, declaration.value)) continue;
    const important = declaration.important;
    if (property === "font") {
      const tokens = declaration.value.children.toArray();
      const match = lexer.matchProperty("font", declaration.value);
      const index = tokens.findIndex((node) => match.isProperty(node, "font-size"));
      const size = tokens[index];
      if (size) {
        addDeclaration("font-size", size, important, uncertain);
        const slash = tokens[index + 1],
          line = tokens[index + 2];
        addDeclaration(
          "line-height",
          slash?.type === "Operator" && slash.value === "/" && line
            ? line
            : { type: "Identifier", name: "normal" },
          important,
          uncertain,
        );
      } else {
        const keyword = tokens[0];
        if (tokens.length === 1 && keyword?.type === "Identifier") {
          addDeclaration("font-size", keyword, important, uncertain);
          addDeclaration("line-height", keyword, important, uncertain);
        } else if (uncertain) addDeclaration("font-size", declaration.value, important, true);
      }
    } else if (["margin", "margin-inline", "margin-block"].includes(property)) {
      for (const [key, value] of marginLonghands(property, declaration.value))
        addDeclaration(key, value, important, uncertain);
    } else if (property === "outline") {
      for (const [key, value] of outlineLonghands(declaration.value))
        addDeclaration(key, value, important, uncertain);
    } else if (property === "mask") {
      const [, image] = backgroundLonghands(declaration.value);
      addDeclaration("mask-image", image, important, uncertain);
    } else if (property === "background") {
      const [colour, image] = backgroundLonghands(declaration.value);
      addDeclaration("background-color", colour, important, uncertain);
      addDeclaration("background-image", image, important, uncertain);
    } else addDeclaration(property, declaration.value, important, uncertain);
  }
  const declarations = [...selected.values()];
  const barrierValues = new Map(
    declarations
      .filter((d) => !["display", "font-size", "visibility"].includes(d.property))
      .map((d) => [d.property, d.value]),
  );
  return {
    declarations,
    barrier: declarations.some(
      (d) => d.uncertain && !["font-size", "visibility"].includes(d.property),
    )
      ? "uncertain-css"
      : subtreeStyleRemovalRule(barrierValues),
  };
}
export function makeDeclarationParser() {
  const sheets = new Map<string, CssNode>(),
    queries = new Map<string, CssNode>();
  const stylesheet = (css: string) => {
    const old = sheets.get(css);
    if (old) return old;
    const ast = parse(css, {
      parseValue: false,
      parseRulePrelude: false,
      parseAtrulePrelude: false,
    });
    sheets.set(css, ast);
    return ast;
  };
  const media = (query: string): CssNode => {
    const old = queries.get(query);
    if (old) return old;
    let ast: CssNode;
    try {
      ast = parse(query, { context: "mediaQueryList" });
    } catch {
      ast = { type: "Raw", value: query };
    }
    queries.set(query, ast);
    return ast;
  };
  const cache = new Map<string, ParsedStyle>();
  const parseInline = (css: string): ParsedStyle => {
    const cached = cache.get(css);
    if (cached) return cached;
    const ast = parse(css, { context: "declarationList" });
    const style = parseDeclarations(ast.type === "DeclarationList" ? ast.children : []);
    cache.set(css, style);
    return style;
  };
  return { parseInline, stylesheet, media };
}
const isTextPseudo = (node: CssNode): boolean =>
  (node.type === "PseudoElementSelector" || node.type === "PseudoClassSelector") &&
  ["first-line", "first-letter"].includes(ident.decode(node.name).toLowerCase());
const STATIC_PSEUDOS = new Set(
  "root empty first-child last-child only-child first-of-type last-of-type only-of-type nth-child nth-last-child nth-of-type nth-last-of-type is where not has".split(
    " ",
  ),
);
function dependentPseudo(node: CssNode): boolean {
  let dynamic = false;
  walk(node, (child) => {
    if (
      child.type === "PseudoClassSelector" &&
      !STATIC_PSEUDOS.has(ident.decode(child.name).toLowerCase())
    )
      dynamic = true;
  });
  return dynamic;
}
function selectorInfo(node: CssNode): { selector: string; reveal: boolean } {
  let reveal = true;
  walk(node, (child) => {
    if (
      child.type === "PseudoElementSelector" ||
      (child.type === "AttributeSelector" &&
        !READER_ATTRIBUTES.has(ident.decode(child.name.name).toLowerCase()))
    )
      reveal = false;
  });
  if (dependentPseudo(node)) reveal = false;
  const possible = parse(generate(node), { context: "selector" });
  const broaden: EnterOrLeaveFn = function (child, item, list) {
    if ((child.type === "PseudoClassSelector" && dependentPseudo(child)) || isTextPseudo(child)) {
      if (!item.prev || item.prev.data.type === "Combinator")
        item.data = { type: "TypeSelector", name: "*" };
      else list.remove(item);
      return this.skip;
    }
    return null;
  };
  walk(possible, { enter: broaden });
  const selector = generate(possible);
  return { selector: selector || "*", reveal };
}
const declarationKey = (rule: VisibleStyleRule, d: Declaration) =>
  `${rule.specificity.join(",")}:${d.property}:${d.value}:${d.important}`;
/** Once per interned list: sort then merge spans, refusing over-budget proof keys. */
function revealProof(rules: readonly VisibleStyleRule[]): ReadonlySet<string> {
  const coverageByProperty = new Map<string, { value: string; groups: Map<string, BandSpan[]> }>();
  const capped = new Set<string>();
  for (const rule of rules)
    for (const d of rule.style.declarations) {
      let entry = coverageByProperty.get(d.property);
      if (!entry || entry.value !== d.value) {
        entry = { value: d.value, groups: new Map() };
        coverageByProperty.set(d.property, entry);
      }
      if (!rule.reveal || d.uncertain) continue;
      const key = declarationKey(rule, d);
      const ranges = entry.groups.get(key) ?? [];
      if (ranges.length + rule.media.certainBand.length > MAX_REVEAL_INTERVALS) {
        capped.add(key);
        continue;
      }
      ranges.push(...rule.media.certainBand);
      entry.groups.set(key, ranges);
    }
  const whole = new Set<string>();
  for (const entry of coverageByProperty.values())
    for (const [key, ranges] of entry.groups) {
      if (capped.has(key)) continue;
      const merged = mergeBand(ranges);
      const first = merged?.at(0);
      if (merged?.length === 1 && first?.lo === 0 && first.hi === MAX_MEDIA_WIDTH) whole.add(key);
    }
  return whole;
}
/** Parse bodies once, retaining potential hiding under unknown groups. */
export function* visibleStylesheetRules(
  css: string,
  parser: ReturnType<typeof makeDeclarationParser>,
  outer: MediaCoverage = alwaysMedia,
  environment: MediaEnvironment = BASE_MEDIA_ENVIRONMENT,
): Generator<VisibleStyleRule> {
  // Keep repeated preludes raw; their AST and specificity are cached below.
  const ast = parser.stylesheet(css);
  if (ast.type !== "StyleSheet") return;
  const mediaCache = new Map<string, MediaCoverage>();
  const combinedMediaCache = new WeakMap<MediaCoverage, WeakMap<MediaCoverage, MediaCoverage>>();
  const selectorCache = new Map<
    string,
    readonly { selector: string; reveal: boolean; specificity: Specificity; textPseudo: boolean }[]
  >();
  const selectors = (prelude: CssNode) => {
    const key = prelude.type === "Raw" ? prelude.value : generate(prelude);
    const cached = selectorCache.get(key);
    if (cached) return cached;
    const compiled: {
      selector: string;
      reveal: boolean;
      specificity: Specificity;
      textPseudo: boolean;
    }[] = [];
    try {
      const list = parse(key, { context: "selectorList" });
      if (list.type === "SelectorList")
        for (const selector of list.children)
          if (selector.type === "Selector") {
            const recolours: CssNode[] = [];
            walk(selector, (child) => {
              if (isTextPseudo(child)) recolours.push(child);
            });
            compiled.push({
              ...selectorInfo(selector),
              specificity: specificity(selector),
              textPseudo: recolours.length > 0,
            });
          }
    } catch {
      // Invalid selectors do not match; never turn their raw text into a selector.
    }
    selectorCache.set(key, compiled);
    return compiled;
  };
  const pending = ast.children
    .toArray()
    .toReversed()
    .map((node) => ({ node, depth: 0, media: outer }));
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) continue;
    const { node, depth, media } = entry;
    if (depth > 64) throw new RangeError("Stylesheet nesting budget");
    if (node.type === "Atrule" && node.block) {
      const name = ident.decode(node.name).toLowerCase();
      // Layer order, supports and container environment are not proven by static matching.
      let condition = groupMedia(name, node.prelude, environment);
      if (name === "media" && node.prelude) {
        const key = node.prelude.type === "Raw" ? node.prelude.value : generate(node.prelude);
        condition = mediaCache.get(key) ?? referenceMedia(parser.media(key), environment);
        mediaCache.set(key, condition);
      }
      let combinations = combinedMediaCache.get(media);
      if (!combinations) {
        combinations = new WeakMap();
        combinedMediaCache.set(media, combinations);
      }
      const next = combinations.get(condition) ?? andCoverage(media, condition);
      combinations.set(condition, next);
      if (next.possibleBand.length)
        for (const child of node.block.children.toArray().toReversed())
          pending.push({ node: child, depth: depth + 1, media: next });
    } else if (node.type === "Rule" && media.possibleBand.length) {
      const compiled = selectors(node.prelude);
      if (!compiled.length) continue;
      // A nested rule can paint any descendant selected relative to this parent.
      // Until flattened, the parent's matched subtree cannot establish visibility.
      const nested = node.block.children
        .toArray()
        .some((child) => child.type === "Rule" || child.type === "Atrule");
      const style = nested
        ? parser.parseInline("all:var(--openmail-unresolved-nesting)!important")
        : parser.parseInline(generate(node.block).slice(1, -1));
      if (!style.declarations.length) continue;
      for (const selector of compiled)
        yield {
          ...selector,
          style: selector.textPseudo
            ? parser.parseInline("all:var(--openmail-unresolved-text-pseudo)!important")
            : style,
          media,
        };
    }
  }
}
export function makeVisibleStyleCascade(parser: ReturnType<typeof makeDeclarationParser>) {
  const proofs = new WeakMap<readonly VisibleStyleRule[], ReadonlySet<string>>();
  const cache = new WeakMap<
    readonly VisibleStyleRule[],
    Map<string, Map<ReaderWidth, VisibleCascade>>
  >();
  return (
    rules: readonly VisibleStyleRule[],
    inline: string,
    width: ReaderWidth = 720,
  ): VisibleCascade => {
    const cached = cache.get(rules)?.get(inline)?.get(width);
    if (cached) return cached;
    const sorted = rules.toSorted((a, b) => compareSpecificity(a.specificity, b.specificity));
    const proof = proofs.get(rules) ?? revealProof(sorted);
    proofs.set(rules, proof);
    const alternatives = new Map<string, readonly string[]>();
    const winners = new Map<string, Declaration & { source: VisibleRemovalSource }>();
    const apply = (style: ParsedStyle, source: VisibleRemovalSource, rule?: VisibleStyleRule) => {
      for (const d of style.declarations) {
        if (
          rule &&
          (!rule.media.possible.includes(width) ||
            (!(
              rule.media.certain.includes(width) &&
              rule.reveal &&
              proof.has(declarationKey(rule, d))
            ) &&
              !hiding(d)))
        )
          continue;
        const previous = winners.get(d.property);
        // Context-dependent values may hide, but must not become a partial reveal.
        const partial = rule && (!rule.media.certain.includes(width) || !rule.reveal);
        const restricted = rule && !proof.has(declarationKey(rule, d));
        let alternativeOverflow = false;
        if (
          restricted &&
          [
            "color",
            "background",
            "background-color",
            "background-image",
            "box-shadow",
            "font-size",
            "-webkit-text-fill-color",
            "line-height",
            ...EFFECT_PROPERTIES,
          ].includes(d.property)
        ) {
          const old = alternatives.get(d.property) ?? [
            previous?.value ??
              (EFFECT_PROPERTIES.some((key) => key === d.property) ? "initial" : "inherit"),
          ];
          if (!old.includes(d.value) && old.length < MAX_ALTERNATIVES)
            alternatives.set(d.property, [...old, d.value]);
          else {
            alternatives.set(d.property, old);
            alternativeOverflow = !old.includes(d.value);
          }
        } else if (!partial) alternatives.delete(d.property);
        let effective = d;
        if (partial && d.property === "font-size") {
          effective = { ...d, value: "0", node: { type: "Number", value: "0" } };
        }
        if (alternativeOverflow) effective = { ...effective, uncertain: true };
        if (!previous || d.important || !previous.important)
          winners.set(d.property, { ...effective, source });
      }
    };
    for (const rule of sorted) apply(rule.style, "stylesheet-rule", rule);
    apply(parser.parseInline(inline), "inline-style");
    const values = new Map<string, string>(),
      sources = new Map<string, VisibleRemovalSource>(),
      nodes = new Map<string, CssNode>();
    let uncertain = false;
    for (const [property, d] of winners) {
      values.set(property, d.value);
      sources.set(property, d.source);
      nodes.set(property, d.node);
      uncertain ||= d.uncertain;
      if (d.uncertain && property === "font-size") {
        values.set(property, "0");
        nodes.set(property, { type: "Number", value: "0" });
      }
      if (d.uncertain && property === "visibility") values.set(property, "hidden");
    }
    const onlyRule = rules[0];
    const barrier =
      onlyRule && rules.length === 1 && !inline && onlyRule.media.certain.includes(width)
        ? values.get("display") === "none"
          ? "display-none"
          : onlyRule.style.barrier
        : subtreeStyleRemovalRule(values);
    const effects = styleEffects(values);
    let potentialBarrier = barrier;
    for (const [property, candidates] of alternatives)
      for (const value of candidates) {
        const variant = new Map(values);
        variant.set(property, value);
        const candidate = styleEffects(variant);
        effects.opacity = Math.min(effects.opacity, candidate.opacity);
        effects.filterOpacity = Math.min(effects.filterOpacity, candidate.filterOpacity);
        effects.scale = Math.min(effects.scale, candidate.scale);
        effects.zoom = Math.min(effects.zoom, candidate.zoom);
        if (REMOVAL_PROPERTIES.some((key) => key === property))
          potentialBarrier ??= subtreeStyleRemovalRule(variant, candidate);
      }
    const result: VisibleCascade = {
      values,
      sources,
      nodes,
      uncertain,
      barrier: potentialBarrier,
      effects,
      alternatives,
    };
    let perInline = cache.get(rules);
    if (!perInline) {
      perInline = new Map();
      cache.set(rules, perInline);
    }
    let perWidth = perInline.get(inline);
    if (!perWidth) {
      perWidth = new Map();
      perInline.set(inline, perWidth);
    }
    perWidth.set(width, result);
    return result;
  };
}
