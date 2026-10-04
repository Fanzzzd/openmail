import { compile } from "css-select";
import { parse as parseHtml5 } from "parse5";
import { adapter } from "parse5-htmlparser2-tree-adapter";
import { sanitizeReaderHtml, READER_DROP } from "./reader-sanitize.js";
import { prepareMessageHtml } from "./reader-html.js";
import { parse, ident } from "./css-tree-browser.js";
import { flattenHtmlChildren, MAX_HTML_DEPTH } from "./html-depth.js";
import {
  makeVisibleStyleCascade,
  REFERENCE_READER_WIDTHS,
  visibleStylesheetRules,
  referenceMedia,
  makeDeclarationParser,
  type VisibleStyleRule,
} from "./visible-text-css.js";
import {
  referenceEnvironments,
  BASE_MEDIA_ENVIRONMENT,
  type MediaEnvironment,
} from "./visible-text-media.js";
import {
  subtreeTextCounts,
  type VisibleRemovalRule,
  type VisibleRemovalSource,
  type VisibleTextObserver,
} from "./visible-text-diagnostics.js";
import {
  INITIAL_TEXT_STYLE,
  resolveTextStyle,
  resolveFont,
  inheritedTextRemoval,
  type InheritedTextStyle,
} from "./visible-text-inheritance.js";
import {
  REMOVAL_PROPERTIES,
  color,
  type Rgba,
  styleEffects,
  subtreeStyleRemovalRule,
} from "./visible-text-style.js";
import {
  composite,
  legacyColour,
  paintedBackgrounds,
  WHITE_PAPER,
  distinctBackgrounds,
  type PaintedBackground,
} from "./visible-text-paint.js";
import { READER_COLOUR_CSS, READER_COLOURS } from "./reader-style.js";
import { declaredExtent, siblingPaint, type SiblingPaint } from "./visible-text-overlap.js";
import { horizontalInlineCoverage, opaqueCoverage } from "./visible-text-cover.js";
import type { ModelThread } from "./mailbox.js";

export type ModelTextFlag = NonNullable<ModelThread["messages"][number]["flags"]>[number];
type VisibleText =
  | { text: string; hidden: boolean }
  | { text: string; hidden: boolean; flags: readonly ["budget-exceeded"] };
const BLOCK = /^(p|div|br|tr|li|h[1-6]|section|article|blockquote|table)$/;
const OMIT = new Set([
  ...READER_DROP,
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
const inkRemovalRule = (
  foreground: string,
  background: Rgba,
  opacity: number,
): VisibleRemovalRule | null => {
  const ink = color(foreground);
  if (!ink) return "uncertain-paint";
  if (ink[3] * opacity <= 0.1) return "opacity";
  const visible = composite(ink, background);
  return [0, 1, 2].every((i) => Math.abs((visible[i] ?? 0) - (background[i] ?? 0)) <= 16)
    ? "colour-match"
    : null;
};
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
  diagnostic?: (kind: "css-rule-budget" | "nesting-depth-limit") => void,
  observer?: VisibleTextObserver,
  linkObserver?: (href: string, label: string) => void,
): VisibleText {
  let sanitizedRemoval = false;
  const clean = sanitizeReaderHtml(prepareMessageHtml(html).html, false, (node) => {
    const counts = subtreeTextCounts(node);
    observer?.removed("omit-tag", "omit-tag", counts);
    sanitizedRemoval ||= counts.characters > 0;
  });
  const dom = parseHtml5(
    `<!doctype html><html lang="en"><head></head><body dir="auto">${clean}</body></html>`,
    { treeAdapter: adapter, scriptingEnabled: false },
  );
  const declarationParser = makeDeclarationParser();
  const cascadeStyle = makeVisibleStyleCascade(declarationParser);
  const emptyRules: readonly VisibleStyleRule[] = [];
  type HtmlNode = (typeof dom.children)[number];
  const recordRemoval = (node: HtmlNode, rule: VisibleRemovalRule, source: VisibleRemovalSource) =>
    observer?.removed(rule, source, subtreeTextCounts(node));
  type VisibleLink = { href: string; text: string[] };
  const activeLinks: VisibleLink[] = [];
  const linkText = (text: string) => {
    for (const link of activeLinks) link.text.push(text);
  };
  const startLink = (node: HtmlNode): VisibleLink | null => {
    if (
      !linkObserver ||
      !("name" in node) ||
      node.name !== "a" ||
      !("attribs" in node) ||
      !node.attribs.href
    )
      return null;
    const link = { href: node.attribs.href, text: [] };
    activeLinks.push(link);
    return link;
  };
  const endLink = (link: VisibleLink) => {
    activeLinks.pop();
    linkObserver?.(link.href, normalizeHtmlText(link.text.join("")));
  };
  const elements: HtmlNode[] = [];
  const nodeOrder = new Map<HtmlNode, number>();
  const nodeEnd = new Map<HtmlNode, number>();
  const classes = new Map<string, HtmlNode[]>();
  const ids = new Map<string, HtmlNode[]>();
  const tags = new Map<string, HtmlNode[]>();
  const stylesheets: { css: string; media: string | undefined }[] = [];
  const index = (map: Map<string, HtmlNode[]>, key: string, node: HtmlNode) => {
    const nodes = map.get(key);
    if (nodes) nodes.push(node);
    else map.set(key, [node]);
  };
  const indexedNodes = dom.children.toReversed();
  while (indexedNodes.length) {
    const node = indexedNodes.pop();
    if (!node) continue;
    nodeOrder.set(node, nodeOrder.size);
    if ("name" in node && "attribs" in node) {
      elements.push(node);
      index(tags, node.name, node);
      if (node.attribs.id) index(ids, node.attribs.id, node);
      for (const name of new Set((node.attribs.class ?? "").split(/\s+/).filter(Boolean)))
        index(classes, name, node);
      if (node.name === "style") {
        stylesheets.push({
          css: node.children
            .flatMap((child) => (adapter.isTextNode(child) ? [child.data] : []))
            .join(""),
          media: node.attribs.media,
        });
        continue;
      }
    }
    if ("children" in node)
      for (const child of node.children.toReversed()) indexedNodes.push(child);
  }
  for (const node of [...nodeOrder.keys()].toReversed()) {
    const end = "children" in node ? node.children.at(-1) : undefined;
    nodeEnd.set(
      node,
      end ? (nodeEnd.get(end) ?? (nodeOrder.get(node) ?? 0) + 1) : (nodeOrder.get(node) ?? 0) + 1,
    );
  }
  stylesheets.unshift({ css: READER_COLOUR_CSS, media: undefined });
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
  let environments: readonly MediaEnvironment[] = [BASE_MEDIA_ENVIRONMENT];
  let scenarioBudgetExceeded = false;
  try {
    environments = referenceEnvironments(stylesheets, declarationParser);
  } catch {
    scenarioBudgetExceeded = true;
  }
  interface RuleList {
    readonly id: number;
    readonly previous: RuleList | null;
    readonly rule: VisibleStyleRule | null;
  }
  const initialList: RuleList = { id: 0, previous: null, rule: null };
  const styles = environments.map(() => new Map<HtmlNode, RuleList>());
  const interned = new Map<number, Map<number, RuleList>>();
  const materialized = new WeakMap<RuleList, readonly VisibleStyleRule[]>();
  const selectorMatches = new Map<string, HtmlNode[]>();
  let nextRuleId = 0,
    nextListId = 1;
  const appendRule = (previous: RuleList, rule: VisibleStyleRule, id: number): RuleList => {
    let transitions = interned.get(previous.id);
    if (!transitions) {
      transitions = new Map();
      interned.set(previous.id, transitions);
    }
    const cached = transitions.get(id);
    if (cached) return cached;
    const result = { id: nextListId++, previous, rule };
    transitions.set(id, result);
    return result;
  };
  const rulesFor = (node: HtmlNode, scenario: number): readonly VisibleStyleRule[] => {
    const list = styles[scenario]?.get(node);
    if (!list) return emptyRules;
    const cached = materialized.get(list);
    if (cached) return cached;
    const reverse: VisibleStyleRule[] = [];
    for (let entry: RuleList | null = list; entry; entry = entry.previous)
      if (entry.rule) reverse.push(entry.rule);
    const result = reverse.toReversed();
    materialized.set(list, result);
    return result;
  };
  let ruleBudget = 5120;
  let matchesRemaining = 2_500_000;
  const collect = (): boolean => {
    if (scenarioBudgetExceeded) return true;
    try {
      for (const [scenario, mediaEnvironment] of environments.entries()) {
        const scenarioStyles = styles[scenario];
        if (!scenarioStyles) continue;
        for (const stylesheet of stylesheets) {
          for (const rule of visibleStylesheetRules(
            stylesheet.css,
            declarationParser,
            stylesheet.media === undefined
              ? undefined
              : referenceMedia(declarationParser.media(stylesheet.media), mediaEnvironment),
            mediaEnvironment,
          )) {
            const decoded = rule.selector;
            // Empty/invalid selectors are ignored, rather than charged as matches.
            if (!decoded) continue;
            if (decoded.length > 20_480) return true;
            try {
              let matched = selectorMatches.get(decoded);
              if (!matched) {
                const targets = candidates(decoded);
                if (!targets.length) {
                  selectorMatches.set(decoded, []);
                  continue;
                }
                const match = compile(decoded);
                matched = [];
                for (const node of targets) {
                  if (--matchesRemaining < 0) return true;
                  if (match(node)) matched.push(node);
                }
                selectorMatches.set(decoded, matched);
              }
              if (!matched.length) continue;
              if (--ruleBudget < 0) {
                diagnostic?.("css-rule-budget");
                return true;
              }
              const ruleId = nextRuleId++;
              for (const node of matched)
                scenarioStyles.set(
                  node,
                  appendRule(scenarioStyles.get(node) ?? initialList, rule, ruleId),
                );
            } catch {
              /* Invalid selectors do not match. */
            }
          }
        }
      }
    } catch {
      // An uninspectable stylesheet must not silently produce trusted model text.
      return true;
    }
    return false;
  };
  const fallback = (): VisibleText => {
    type Frame =
      | { kind: "node"; node: HtmlNode; textStyle: InheritedTextStyle }
      | { kind: "line" }
      | { kind: "link-end"; link: VisibleLink };
    const pending: Frame[] = dom.children
      .toReversed()
      .map((node) => ({ kind: "node", node, textStyle: INITIAL_TEXT_STYLE }));
    const out: string[] = [];
    let removed = sanitizedRemoval;
    while (pending.length) {
      const frame = pending.pop();
      if (!frame) continue;
      if (frame.kind === "line") {
        out.push("\n");
        linkText("\n");
        continue;
      }
      if (frame.kind === "link-end") {
        endLink(frame.link);
        continue;
      }
      const node = frame.node;
      if (adapter.isTextNode(node)) {
        const rejection =
          budgetFallback === "visible" ? inheritedTextRemoval(frame.textStyle) : null;
        if (rejection) {
          recordRemoval(node, rejection.rule, rejection.source);
          if (node.data.trim()) removed = true;
          continue;
        }
        observer?.retained(node.data.length);
        linkText(node.data);
        out.push(node.data);
        continue;
      }
      if (!("name" in node)) continue;
      if (OMIT.has(node.name)) {
        recordRemoval(node, "omit-tag", "omit-tag");
        continue;
      }
      const attrs = "attribs" in node ? node.attribs : {};
      const cascade = cascadeStyle(emptyRules, attrs.style ?? "");
      const rejection =
        "hidden" in attrs
          ? "hidden-attribute"
          : attrs["aria-hidden"]?.toLowerCase() === "true"
            ? "aria-hidden"
            : cascade.uncertain
              ? "uncertain-css"
              : subtreeStyleRemovalRule(cascade.values);
      if (budgetFallback === "visible" && rejection) {
        recordRemoval(
          node,
          rejection,
          rejection === "hidden-attribute" || rejection === "aria-hidden"
            ? "html-attribute"
            : "inline-style",
        );
        removed = true;
        continue;
      }
      const textStyle = resolveTextStyle(cascade, frame.textStyle, node.name === "html");
      const link = startLink(node);
      if (link) pending.push({ kind: "link-end", link });
      if (BLOCK.test(node.name)) {
        out.push("\n");
        linkText("\n");
        pending.push({ kind: "line" });
      }
      if ("children" in node)
        for (const child of node.children.toReversed())
          pending.push({ kind: "node", node: child, textStyle });
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
      if (adapter.isTextNode(current) && current.data.trim()) return true;
      if ("children" in current) for (const child of current.children) pending.push(child);
    }
    return false;
  };
  let hidden = sanitizedRemoval;
  const out: string[] = [];
  type RenderStyle = InheritedTextStyle & {
    width: (typeof REFERENCE_READER_WIDTHS)[number];
    scenario: number;
    color: string;
    opacity: number;
    scale: number;
    colours: readonly string[];
    backgrounds: readonly PaintedBackground[];
    ownEffects: ReturnType<typeof styleEffects>;
  };
  const initialStyles: readonly RenderStyle[] = environments.flatMap((_, scenario) =>
    REFERENCE_READER_WIDTHS.map((width): RenderStyle => ({
      ...INITIAL_TEXT_STYLE,
      width,
      scenario,
      color: READER_COLOURS.ink,
      opacity: 1,
      scale: 1,
      colours: [READER_COLOURS.ink],
      backgrounds: [WHITE_PAPER],
      ownEffects: styleEffects(new Map()),
    })),
  );
  type Painter = SiblingPaint & { readonly start: number; readonly end: number };
  const siblingGroups = environments.map(
    () => new Map<(typeof REFERENCE_READER_WIDTHS)[number], Map<HtmlNode, Painter[]>>(),
  );
  type CoveredRange = {
    start: number;
    end: number;
    excludedStart: number;
    excludedEnd: number;
    rule: VisibleRemovalRule;
  };
  const coverageRanges = environments.map(
    () => new Map<(typeof REFERENCE_READER_WIDTHS)[number], CoveredRange[]>(),
  );
  const adjacent = (node: HtmlNode, direction: "previous" | "next"): HtmlNode | null => {
    let sibling = direction === "previous" ? node.prev : node.next;
    while (sibling) {
      if (
        adapter.isTextNode(sibling)
          ? Boolean(sibling.data.trim())
          : "name" in sibling && !OMIT.has(sibling.name)
      )
        return sibling;
      sibling = direction === "previous" ? sibling.prev : sibling.next;
    }
    return null;
  };
  // Precompute each scenario's containing blocks and painters. The text walk
  // then sees before/after siblings without mixing media colours or DOM order.
  const hasPainters =
    elements.some(
      (node) =>
        "attribs" in node &&
        /position|transform|translate|scale|margin|outline|shadow|\\/i.test(
          node.attribs.style ?? "",
        ),
    ) ||
    stylesheets.some((sheet) =>
      /position|transform|translate|scale|margin|outline|shadow|\\/i.test(sheet.css),
    );
  if (hasPainters) {
    try {
      for (const environment of initialStyles) {
        const groups = new Map<HtmlNode, Painter[]>();
        const covered: CoveredRange[] = [];
        coverageRanges[environment.scenario]?.set(environment.width, covered);
        siblingGroups[environment.scenario]?.set(environment.width, groups);
        const containers = new Map<HtmlNode, HtmlNode>();
        const declaredSizes = new Map<HtmlNode, { width: number | null; height: number | null }>();
        const colours = new Map<HtmlNode, string>();
        const omitted = new Set<HtmlNode>();
        for (const node of elements) {
          if (!("attribs" in node) || !("name" in node)) continue;
          const parent = node.parent;
          const cascade = cascadeStyle(
            rulesFor(node, environment.scenario),
            node.attribs.style ?? "",
            environment.width,
          );
          const css = cascade.values;
          const horizontal = horizontalInlineCoverage(css, node.name, node.attribs);
          declaredSizes.set(node, {
            width: declaredExtent(css.get("width") ?? node.attribs.width),
            height: declaredExtent(css.get("height") ?? node.attribs.height),
          });
          if (
            (parent && omitted.has(parent)) ||
            OMIT.has(node.name) ||
            "hidden" in node.attribs ||
            node.attribs["aria-hidden"] === "true" ||
            (cascade.barrier &&
              !["uncertain-css", "uncertain-paint"].includes(cascade.barrier) &&
              !(cascade.barrier === "off-screen" && horizontal))
          ) {
            omitted.add(node);
            continue;
          }
          const parentInk = parent
            ? (colours.get(parent) ?? READER_COLOURS.ink)
            : READER_COLOURS.ink;
          const value = css.get("color") ?? legacyColour(node.attribs.color) ?? parentInk;
          const ink = /^(inherit|unset|revert|currentcolor)$/.test(value)
            ? parentInk
            : value === "initial"
              ? READER_COLOURS.ink
              : value;
          colours.set(node, ink);
          const position = css.get("position") ?? "static";
          const containing = parent ? containers.get(parent) : undefined;
          const block =
            position === "fixed"
              ? dom.children.find((child) => "name" in child && child.name === "html")
              : containing;
          const coverage = horizontal
            ? "previous-sibling"
            : opaqueCoverage(css, node.name, node.attribs, ink);
          if (coverage && block) {
            const exclude: Pick<CoveredRange, "excludedStart" | "excludedEnd" | "rule"> = {
              excludedStart: nodeOrder.get(node) ?? 0,
              excludedEnd: nodeEnd.get(node) ?? 0,
              rule:
                horizontal === "replaced"
                  ? "uncertain-paint"
                  : horizontal === "opaque"
                    ? "colour-match"
                    : "positioned-overlay",
            };
            if (coverage === "containing-block")
              covered.push({
                start: (nodeOrder.get(block) ?? 0) + 1,
                end: nodeEnd.get(block) ?? 0,
                ...exclude,
              });
            else {
              const neighbours =
                coverage === "previous-sibling"
                  ? [adjacent(node, "previous")]
                  : [adjacent(node, "previous"), adjacent(node, "next")];
              for (const neighbour of neighbours) {
                if (!neighbour) continue;
                if (horizontal && "name" in neighbour && "attribs" in neighbour) {
                  const neighbourDisplay = cascadeStyle(
                    rulesFor(neighbour, environment.scenario),
                    neighbour.attribs.style ?? "",
                    environment.width,
                  ).values.get("display");
                  const inline = neighbourDisplay
                    ? /^(inline|inline-block|inline-flex|inline-grid)$/.test(neighbourDisplay)
                    : !/^(p|div|table|tr|td|th|li|h[1-6]|section|article|blockquote|header|footer|main|aside|ul|ol|pre)$/.test(
                        neighbour.name,
                      );
                  if (!inline) continue;
                }
                covered.push({
                  start: nodeOrder.get(neighbour) ?? 0,
                  end: nodeEnd.get(neighbour) ?? 0,
                  ...exclude,
                });
              }
            }
          }
          const paint = siblingPaint(
            css,
            node.name,
            node.attribs,
            ink,
            cascade.uncertain || cascade.effects.destructiveFilter,
            block ? declaredSizes.get(block) : undefined,
          );
          if (paint && block) {
            const group = groups.get(block) ?? [];
            group.push({ ...paint, start: nodeOrder.get(node) ?? 0, end: nodeEnd.get(node) ?? 0 });
            groups.set(block, group);
          }
          containers.set(
            node,
            position !== "static" ||
              node.name === "html" ||
              (css.has("transform") && css.get("transform") !== "none")
              ? node
              : (containing ?? node),
          );
        }
      }
    } catch {
      return { text: "", hidden: true, flags: ["budget-exceeded"] };
    }
  }
  let paintChecksRemaining = 2_500_000;
  const siblingRemoval = (
    node: HtmlNode,
    environment: RenderStyle,
    inks: readonly string[],
  ): VisibleRemovalRule | null => {
    const order = nodeOrder.get(node) ?? -1;
    for (const range of coverageRanges[environment.scenario]?.get(environment.width) ?? []) {
      if (--paintChecksRemaining < 0) throw new RangeError("Opaque coverage budget");
      if (
        order >= range.start &&
        order < range.end &&
        !(order >= range.excludedStart && order < range.excludedEnd)
      )
        return range.rule;
    }
    const groups = siblingGroups[environment.scenario]?.get(environment.width);
    if (!groups?.size) return null;
    for (let parent = node.parent; parent; parent = parent.parent) {
      for (const painter of groups.get(parent) ?? []) {
        if (--paintChecksRemaining < 0) throw new RangeError("Sibling paint budget");
        if (order >= painter.start && order < painter.end) continue;
        for (const paper of painter.papers) {
          if (paper.kind === "unknown") {
            if (painter.replaced) return "positioned-overlay";
            continue;
          }
          for (const backdrop of environment.backgrounds) {
            if (backdrop.kind === "unknown") continue;
            const rgb = composite(paper.rgb, backdrop.rgb);
            for (const ink of inks)
              if (
                inkRemovalRule(ink, rgb, environment.opacity * environment.scale) === "colour-match"
              )
                return "positioned-overlay";
          }
        }
      }
    }
    return null;
  };
  const walk = (
    parent: Pick<typeof dom, "children">,
    inherited: readonly RenderStyle[] = initialStyles,
    depth = 0,
  ): void => {
    if (depth >= MAX_HTML_DEPTH + 2) {
      diagnostic?.("nesting-depth-limit");
      parent.children = flattenHtmlChildren(parent.children, (node) => {
        const omit = "name" in node && OMIT.has(node.name);
        if (omit) recordRemoval(node, "omit-tag", "omit-tag");
        return omit;
      });
    }
    for (const node of parent.children) {
      if (adapter.isTextNode(node)) {
        let rejection: { rule: VisibleRemovalRule; source: VisibleRemovalSource } | null = null;
        for (const environment of inherited) {
          rejection ??= inheritedTextRemoval(environment);
          const inks =
            environment.textFill &&
            !/^(currentcolor|initial|revert|revert-layer)$/.test(environment.textFill)
              ? [environment.textFill]
              : environment.colours;
          const overlap = siblingRemoval(node, environment, inks);
          if (!rejection && overlap) rejection = { rule: overlap, source: "inherited" };
          for (const ink of inks)
            for (const paper of environment.backgrounds) {
              const rule =
                paper.kind === "unknown"
                  ? "uncertain-paint"
                  : inkRemovalRule(ink, paper.rgb, environment.opacity * environment.scale);
              if (!rejection && rule) rejection = { rule, source: "inherited" };
            }
          if (rejection) break;
        }
        if (rejection) {
          recordRemoval(node, rejection.rule, rejection.source);
          if (node.data.trim()) hidden = true;
          continue;
        }
        observer?.retained(node.data.length);
        linkText(node.data);
        out.push(node.data);
        continue;
      }
      if (!("name" in node) || !("attribs" in node)) continue;
      if (OMIT.has(node.name)) {
        recordRemoval(node, "omit-tag", "omit-tag");
        if (!["head", "style"].includes(node.name) && hasText(node)) hidden = true;
        continue;
      }
      const attrs = node.attribs;
      const nextStyles: RenderStyle[] = [];
      let rejection: { rule: VisibleRemovalRule; source: VisibleRemovalSource } | null = null;
      for (const environment of inherited) {
        const cascade = cascadeStyle(
          rulesFor(node, environment.scenario),
          attrs.style ?? "",
          environment.width,
        );
        const css = cascade.values;
        const ink = css.get("color") ?? legacyColour(attrs.color) ?? environment.color;
        const foreground =
          ink === "initial"
            ? READER_COLOURS.ink
            : /^(inherit|unset|revert|currentcolor)$/.test(ink)
              ? environment.color
              : ink;
        const colourAlternatives = cascade.alternatives.get("color");
        const colours = colourAlternatives
          ? [
              ...new Set(
                colourAlternatives.flatMap((value) =>
                  value === "inherit" ? environment.colours : [value],
                ),
              ),
            ]
          : (css.has("color") && !/^(inherit|unset|revert|currentcolor)$/.test(ink)) || attrs.color
            ? [foreground]
            : environment.colours;
        const baseBackgrounds = paintedBackgrounds(
          css,
          environment.backgrounds,
          foreground,
          attrs.bgcolor,
          attrs.background,
        );
        const backgrounds = [...baseBackgrounds];
        for (const key of ["background-color", "background-image", "box-shadow"]) {
          for (const value of cascade.alternatives.get(key) ?? []) {
            const variant = new Map(css);
            variant.set(key, value);
            backgrounds.push(
              ...paintedBackgrounds(
                variant,
                environment.backgrounds,
                foreground,
                attrs.bgcolor,
                attrs.background,
              ),
            );
          }
        }
        const ownEffects = { ...cascade.effects };
        if (css.get("opacity") === "inherit") ownEffects.opacity = environment.ownEffects.opacity;
        if (css.get("filter") === "inherit")
          ownEffects.filterOpacity = environment.ownEffects.filterOpacity;
        if (css.get("transform") === "inherit")
          ownEffects.transformScale = environment.ownEffects.transformScale;
        if (css.get("scale") === "inherit")
          ownEffects.scaleValue = environment.ownEffects.scaleValue;
        if (css.get("zoom") === "inherit") ownEffects.zoom = environment.ownEffects.zoom;
        if (css.get("transform") === "inherit" || css.get("scale") === "inherit")
          ownEffects.scale = ownEffects.transformScale * ownEffects.scaleValue;
        const opacity = environment.opacity * ownEffects.opacity * ownEffects.filterOpacity;
        const scale = environment.scale * ownEffects.scale * ownEffects.zoom;
        let textStyle = resolveTextStyle(cascade, environment, node.name === "html");
        if (node.name === "body" && !css.has("font-size"))
          textStyle = { ...textStyle, size: INITIAL_TEXT_STYLE.size, sizeSource: "inherited" };
        for (const value of cascade.alternatives.get("font-size") ?? []) {
          const alternative =
            value === "inherit"
              ? environment.size
              : resolveFont(parse(value, { context: "value" }), environment);
          if (
            alternative &&
            alternative.value <= (alternative.unit === "px" || alternative.unit === "pt" ? 2 : 0.2)
          )
            textStyle = { ...textStyle, size: alternative };
        }
        if (
          cascade.alternatives
            .get("line-height")
            ?.some((value) =>
              value === "inherit"
                ? environment.lineHeight === 0
                : /^(0|calc\(0(?:px)?\))$/.test(value),
            )
        )
          textStyle = { ...textStyle, lineHeight: 0 };
        const clipped =
          css.get("overflow") === "hidden" &&
          textStyle.lineHeight !== null &&
          textStyle.lineHeight <= 0;
        const origin = (properties: readonly string[]): VisibleRemovalSource =>
          properties
            .map((property) => cascade.sources.get(property))
            .find((source) => source !== undefined) ?? "inherited";
        if ("hidden" in attrs) rejection = { rule: "hidden-attribute", source: "html-attribute" };
        else if (attrs["aria-hidden"]?.toLowerCase() === "true")
          rejection = { rule: "aria-hidden", source: "html-attribute" };
        else if (cascade.uncertain)
          rejection = { rule: "uncertain-css", source: origin([...css.keys()]) };
        else if (opacity * scale <= 0.1)
          rejection = {
            rule:
              cascade.effects.filterOpacity < 1
                ? "filter-opacity"
                : scale < 1
                  ? ownEffects.zoom < 1
                    ? "zoom"
                    : "scale"
                  : "opacity",
            source: origin(["opacity", "filter", "transform", "scale", "zoom"]),
          };
        else if (clipped)
          rejection = { rule: "clipping", source: origin(["overflow", "line-height"]) };
        else {
          const rule = cascade.barrier;
          if (rule)
            rejection = {
              rule,
              source: origin(REMOVAL_PROPERTIES),
            };
        }
        if (rejection) break;
        nextStyles.push({
          ...textStyle,
          width: environment.width,
          scenario: environment.scenario,
          color: foreground,
          opacity,
          scale,
          colours,
          backgrounds: distinctBackgrounds(backgrounds),
          ownEffects,
        });
      }
      if (rejection) {
        recordRemoval(node, rejection.rule, rejection.source);
        if (hasText(node)) hidden = true;
        continue;
      }
      const link = startLink(node);
      if (BLOCK.test(node.name)) {
        out.push("\n");
        linkText("\n");
      }
      walk(node, nextStyles, depth + 1);
      if (BLOCK.test(node.name)) {
        out.push("\n");
        linkText("\n");
      }
      if (link) endLink(link);
    }
  };
  try {
    walk(dom);
  } catch {
    return { text: "", hidden: true, flags: ["budget-exceeded"] };
  }
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
