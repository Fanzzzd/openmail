/** The state one visible-text extraction carries: the parsed document, its indexes, links and removal records. */

import { READER_DROP, sanitizeReaderHtml } from "../reader/reader-sanitize.js";
import { parseColour, type Rgba, type styleEffects } from "./visible-text-style.js";
import {
  subtreeTextCounts,
  type VisibleRemovalRule,
  type VisibleRemovalSource,
  type VisibleTextObserver,
} from "./visible-text-diagnostics.js";
import {
  COLOUR_MATCH_TOLERANCE,
  MAX_CSS_RULES,
  MAX_MATCH_CHECKS,
  MIN_TEXT_CONTRAST,
  MIN_VISIBLE_ALPHA,
} from "./visible-text-constants.js";
import { composite, textContrast, type PaintedBackground } from "./visible-text-paint.js";
import { adapter } from "parse5-htmlparser2-tree-adapter";
import type { InheritedTextStyle } from "./visible-text-inheritance.js";
import {
  makeDeclarationParser,
  makeVisibleStyleCascade,
  type REFERENCE_READER_WIDTHS,
  type VisibleStyleRule,
} from "./visible-text-css.js";
import type { SiblingPaint } from "./visible-text-overlap.js";
import { BASE_MEDIA_ENVIRONMENT, type MediaEnvironment } from "./visible-text-media.js";
import { prepareMessageHtml } from "../reader/reader-html.js";
import { parse as parseHtml5 } from "parse5";
import { READER_COLOUR_CSS } from "../reader/reader-style.js";
import { ident, parse } from "../reader/css-tree-browser.js";

export type VisibleText =
  | { text: string; hidden: boolean }
  | { text: string; hidden: boolean; flags: readonly ["budget-exceeded"] };
export const PAINTER_STYLE_PATTERN = /position|transform|translate|scale|margin|outline|shadow|\\/i;
export const BLOCK = /^(p|div|br|tr|li|h[1-6]|section|article|blockquote|table)$/;
export const OMIT = new Set([
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
export const inkRemovalRule = (
  foreground: string,
  background: Rgba,
  opacity: number,
  scale: number,
): VisibleRemovalRule | null => {
  const ink = parseColour(foreground);
  if (!ink) return "uncertain-paint";
  if (ink[3] * opacity * scale <= MIN_VISIBLE_ALPHA) return "opacity";
  return textContrast(ink, background, opacity) < MIN_TEXT_CONTRAST ? "colour-match" : null;
};
// Possible sibling paint has no proven coverage; contrast only applies to the actual backdrop.
export function inkMatchesPaint(foreground: string, background: Rgba, opacity: number): boolean {
  const ink = parseColour(foreground);
  if (!ink) return false;
  const visible = composite([ink[0], ink[1], ink[2], ink[3] * opacity], background);
  return [0, 1, 2].every(
    (i) => Math.abs((visible[i] ?? 0) - (background[i] ?? 0)) <= COLOUR_MATCH_TOLERANCE,
  );
}
export const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

export const normalizeHtmlText = (text: string) =>
  text
    .replace(/[\t \u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();

export type HtmlDocument = ReturnType<typeof adapter.createDocument>;
export type HtmlNode = HtmlDocument["children"][number];
export type HtmlElement = Extract<HtmlNode, { name: string; attribs: Record<string, string> }>;
export type VisibleLink = { href: string; text: string[] };
export type Rejection = { rule: VisibleRemovalRule; source: VisibleRemovalSource };
export type RenderStyle = InheritedTextStyle & {
  width: (typeof REFERENCE_READER_WIDTHS)[number];
  scenario: number;
  color: string;
  opacity: number;
  scale: number;
  colours: readonly string[];
  backgrounds: readonly PaintedBackground[];
  ownEffects: ReturnType<typeof styleEffects>;
};
export interface RuleList {
  readonly id: number;
  readonly previous: RuleList | null;
  readonly rule: VisibleStyleRule | null;
}
export type Painter = SiblingPaint & { readonly start: number; readonly end: number };
export type CoveredRange = {
  start: number;
  end: number;
  excludedStart: number;
  excludedEnd: number;
  rule: VisibleRemovalRule;
};
export interface VisibleHtmlTextOptions {
  budgetFallback?: "visible" | "index-full-text";
  diagnostic?: (kind: "css-rule-budget" | "nesting-depth-limit") => void;
  observer?: VisibleTextObserver;
  linkObserver?: (href: string, label: string) => void;
}
export interface VisibleContext {
  removedNodes: Set<HtmlNode> | null;
  dom: HtmlDocument;
  budgetFallback: "visible" | "index-full-text";
  diagnostic: VisibleHtmlTextOptions["diagnostic"];
  observer: VisibleHtmlTextOptions["observer"];
  linkObserver: VisibleHtmlTextOptions["linkObserver"];
  sanitizedRemoval: boolean;
  hidden: boolean;
  out: string[];
  activeLinks: VisibleLink[];
  declarationParser: ReturnType<typeof makeDeclarationParser>;
  cascadeStyle: ReturnType<typeof makeVisibleStyleCascade>;
  emptyRules: readonly VisibleStyleRule[];
  elements: HtmlNode[];
  nodeOrder: Map<HtmlNode, number>;
  nodeEnd: Map<HtmlNode, number>;
  classes: Map<string, HtmlNode[]>;
  ids: Map<string, HtmlNode[]>;
  tags: Map<string, HtmlNode[]>;
  stylesheets: { css: string; media: string | undefined }[];
  environments: readonly MediaEnvironment[];
  scenarioBudgetExceeded: boolean;
  initialList: RuleList;
  styles: Map<HtmlNode, RuleList>[];
  interned: Map<number, Map<number, RuleList>>;
  materialized: WeakMap<RuleList, readonly VisibleStyleRule[]>;
  selectorMatches: Map<string, HtmlNode[]>;
  nextRuleId: number;
  nextListId: number;
  ruleBudget: number;
  matchesRemaining: number;
  initialStyles: readonly RenderStyle[];
  siblingGroups: Map<(typeof REFERENCE_READER_WIDTHS)[number], Map<HtmlNode, Painter[]>>[];
  coverageRanges: Map<(typeof REFERENCE_READER_WIDTHS)[number], CoveredRange[]>[];
  paintChecksRemaining: number;
}

export function recordRemoval(
  ctx: VisibleContext,
  node: HtmlNode,
  rule: VisibleRemovalRule,
  source: VisibleRemovalSource,
) {
  if (!(rule === "omit-tag" && "name" in node && ["style", "head"].includes(node.name)))
    ctx.removedNodes?.add(node);
  ctx.observer?.removed(rule, source, subtreeTextCounts(node));
}
export function linkText(ctx: VisibleContext, text: string) {
  for (const link of ctx.activeLinks) link.text.push(text);
}
export function startLink(ctx: VisibleContext, node: HtmlNode): VisibleLink | null {
  if (
    !ctx.linkObserver ||
    !("name" in node) ||
    node.name !== "a" ||
    !("attribs" in node) ||
    !node.attribs.href
  )
    return null;
  const link = { href: node.attribs.href, text: [] };
  ctx.activeLinks.push(link);
  return link;
}
export function endLink(ctx: VisibleContext, link: VisibleLink) {
  ctx.activeLinks.pop();
  ctx.linkObserver?.(link.href, normalizeHtmlText(link.text.join("")));
}
function index(map: Map<string, HtmlNode[]>, key: string, node: HtmlNode) {
  const nodes = map.get(key);
  if (nodes) nodes.push(node);
  else map.set(key, [node]);
}
export function adjacent(node: HtmlNode, direction: "previous" | "next"): HtmlNode | null {
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
}

export function createContext(html: string, options: VisibleHtmlTextOptions): VisibleContext {
  let sanitizedRemoval = false;
  const clean = sanitizeReaderHtml(prepareMessageHtml(html).html, false, (node) => {
    const counts = subtreeTextCounts(node);
    options.observer?.removed("omit-tag", "omit-tag", counts);
    sanitizedRemoval ||= counts.characters > 0;
  });
  const dom = parseHtml5(
    `<!doctype html><html lang="en"><head></head><body dir="auto">${clean}</body></html>`,
    { treeAdapter: adapter, scriptingEnabled: false },
  );
  const declarationParser = makeDeclarationParser();
  return {
    dom,
    removedNodes: null,
    ...options,
    budgetFallback: options.budgetFallback ?? "visible",
    diagnostic: options.diagnostic,
    observer: options.observer,
    linkObserver: options.linkObserver,
    sanitizedRemoval,
    hidden: sanitizedRemoval,
    out: [],
    activeLinks: [],
    declarationParser,
    cascadeStyle: makeVisibleStyleCascade(declarationParser),
    emptyRules: [],
    elements: [],
    nodeOrder: new Map(),
    nodeEnd: new Map(),
    classes: new Map(),
    ids: new Map(),
    tags: new Map(),
    stylesheets: [],
    environments: [BASE_MEDIA_ENVIRONMENT],
    scenarioBudgetExceeded: false,
    initialList: { id: 0, previous: null, rule: null },
    styles: [],
    interned: new Map(),
    materialized: new WeakMap(),
    selectorMatches: new Map(),
    nextRuleId: 0,
    nextListId: 1,
    ruleBudget: MAX_CSS_RULES,
    matchesRemaining: MAX_MATCH_CHECKS,
    initialStyles: [],
    siblingGroups: [],
    coverageRanges: [],
    paintChecksRemaining: MAX_MATCH_CHECKS,
  };
}

export function indexDocument(ctx: VisibleContext) {
  const { dom, elements, nodeOrder, nodeEnd, classes, ids, tags, stylesheets } = ctx;
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
}

export function candidates(ctx: VisibleContext, selector: string): HtmlNode[] {
  const { elements, classes, ids, tags } = ctx;

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
}
