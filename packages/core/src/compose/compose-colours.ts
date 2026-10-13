import { ElementType, parseDocument } from "htmlparser2";
import { compile } from "css-select";
import {
  makeDeclarationParser,
  makeVisibleStyleCascade,
  visibleStylesheetRules,
  referenceMedia,
  REFERENCE_READER_WIDTHS,
  type VisibleStyleRule,
} from "../visible-text-css.js";
import { referenceEnvironments } from "../visible-text-media.js";
import { legacyColour, resolveInk } from "../visible-text-paint.js";
import { parseColour } from "../visible-text-style.js";
import { MAX_CSS_RULES, MAX_MATCH_CHECKS, MAX_SELECTOR_LENGTH } from "../visible-text-constants.js";

type HtmlNode = ReturnType<typeof parseDocument>["children"][number];
type HtmlElement = Extract<HtmlNode, { attribs: Record<string, string> }>;

function paintsBackground(value: string | undefined): boolean {
  if (!value || /^(none|transparent|initial|unset|inherit|revert|revert-layer)$/.test(value))
    return false;
  return parseColour(value)?.[3] !== 0;
}

/** Resolve author colours against all bounded CSS scenarios before changing any declaration. */
export function composeColourContexts(nodes: HtmlNode[]): Map<
  HtmlElement,
  {
    protectedBackground: boolean;
    inheritedDefault: string | undefined;
  }
> {
  const elements: HtmlElement[] = [];
  const stylesheets: { css: string; media: string | undefined }[] = [];
  const root = parseDocument("<html><body></body></html>").children[0];
  const body =
    root && "children" in root
      ? root.children.find((node) => node.type === ElementType.Tag && node.name === "body")
      : undefined;
  const roots = nodes.some((node) => node.type === ElementType.Tag && node.name === "html")
    ? nodes
    : root && root.type === ElementType.Tag
      ? [root]
      : nodes;
  if (roots !== nodes && body && "children" in body) body.children = nodes;
  const pending: { node: HtmlNode; parent: HtmlElement | null }[] = roots
    .toReversed()
    .map((node) => ({ node, parent: null }));
  while (pending.length) {
    const frame = pending.pop();
    if (!frame) continue;
    const { node, parent } = frame;
    if (node.type !== ElementType.Tag && node.type !== ElementType.Style) continue;
    if (parent) node.parent = parent;
    if (elements.length >= 20_000) throw new RangeError("Compose colour node budget");
    elements.push(node);
    if (node.type === ElementType.Style) {
      stylesheets.push({
        css: node.children
          .flatMap((child) => (child.type === ElementType.Text ? [child.data] : []))
          .join(""),
        media: node.attribs.media,
      });
    } else
      for (const child of node.children.toReversed()) pending.push({ node: child, parent: node });
  }
  const parser = makeDeclarationParser();
  const cascadeStyle = makeVisibleStyleCascade(parser);
  const emptyRules: readonly VisibleStyleRule[] = [];
  const contexts = new Map<
    HtmlElement,
    { protectedBackground: boolean; inheritedDefault: string | undefined }
  >();
  let checks = MAX_MATCH_CHECKS;
  let ruleCount = 0;
  let overpaint = false;
  const matches = new Map<string, HtmlElement[]>();
  for (const environment of referenceEnvironments(stylesheets, parser)) {
    const rules = new Map<HtmlElement, VisibleStyleRule[]>();
    for (const stylesheet of stylesheets) {
      for (const rule of visibleStylesheetRules(
        stylesheet.css,
        parser,
        stylesheet.media === undefined
          ? undefined
          : referenceMedia(parser.media(stylesheet.media), environment),
        environment,
      )) {
        if (!rule.selector) continue;
        if (++ruleCount > MAX_CSS_RULES || rule.selector.length > MAX_SELECTOR_LENGTH)
          throw new RangeError("Compose colour rule budget");
        let selected = matches.get(rule.selector);
        if (!selected) {
          selected = [];
          try {
            const match = compile(rule.selector);
            for (const node of elements) {
              if (--checks < 0) throw new RangeError("Compose colour match budget");
              if (match(node)) selected.push(node);
            }
          } catch (error) {
            if (error instanceof RangeError) throw error;
          }
          matches.set(rule.selector, selected);
        }
        for (const node of selected) {
          const previous = rules.get(node) ?? [];
          previous.push(rule);
          rules.set(node, previous);
        }
      }
    }
    for (const width of REFERENCE_READER_WIDTHS) {
      const inherited = new Map<HtmlNode, { background: boolean; colour: string }>();
      for (const node of elements) {
        const parent = node.parent ? inherited.get(node.parent) : undefined;
        const cascade = cascadeStyle(
          rules.get(node) ?? emptyRules,
          node.attribs.style ?? "",
          width,
        );
        const css = cascade.values;
        overpaint ||= [...css].some(
          ([property, value]) =>
            /^(box-shadow|outline(?:-.*)?|position|transform|translate|margin-(?:top|left|right|bottom))$/.test(
              property,
            ) && !/^(none|initial|unset|inherit|revert|revert-layer|static|0(?:px)?)$/.test(value),
        );
        const colour = resolveInk(
          css.get("color") ?? legacyColour(node.attribs.color) ?? parent?.colour ?? "#000",
          parent?.colour ?? "#000",
        );
        const background =
          parent?.background ||
          paintsBackground(
            css.get("background-color") ?? legacyColour(node.attribs.bgcolor) ?? undefined,
          ) ||
          paintsBackground(css.get("background-image")) ||
          [...cascade.alternatives].some(
            ([property, values]) =>
              property.startsWith("background") && values.some(paintsBackground),
          );
        inherited.set(node, { background, colour });
        const context = contexts.get(node) ?? {
          protectedBackground: false,
          inheritedDefault: undefined,
        };
        context.protectedBackground ||= background;
        // An uncoloured element must not inherit the reader's near-black ink on a dark paper.
        if (background && !css.has("color") && !node.attribs.color)
          context.inheritedDefault =
            context.inheritedDefault === undefined || context.inheritedDefault === colour
              ? colour
              : "inherit";
        contexts.set(node, context);
      }
    }
  }
  // A sibling painter can hide ink too; keep its original colour until visibility inspects it.
  if (overpaint) for (const context of contexts.values()) context.protectedBackground = true;
  return contexts;
}
