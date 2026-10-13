import type { ModelThread } from "../ai/model-thread.js";
import {
  BLOCK,
  OMIT,
  createContext,
  endLink,
  indexDocument,
  inkRemovalRule,
  linkText,
  normalize,
  normalizeHtmlText,
  recordRemoval,
  startLink,
  type HtmlDocument,
  type HtmlElement,
  type HtmlNode,
  type Rejection,
  type RenderStyle,
  type VisibleContext,
  type VisibleHtmlTextOptions,
  type VisibleLink,
  type VisibleText,
} from "./visible-text-context.js";
import {
  INITIAL_TEXT_STYLE,
  inheritedTextRemoval,
  resolveFont,
  resolveTextStyle,
  type InheritedTextStyle,
} from "./visible-text-inheritance.js";
import { adapter } from "parse5-htmlparser2-tree-adapter";
import { REMOVAL_PROPERTIES, subtreeStyleRemovalRule } from "./visible-text-style.js";
import type { VisibleRemovalRule, VisibleRemovalSource } from "./visible-text-diagnostics.js";
import { buildPainters, hasText, siblingRemoval } from "./visible-text-painters.js";
import { collectRules, rulesFor } from "./visible-text-rules.js";
import {
  distinctBackgrounds,
  legacyColour,
  paintedBackgrounds,
  resolveInk,
} from "./visible-text-paint.js";
import { parse } from "../reader/css-tree-browser.js";
import { EFFECT_PROPERTIES, MIN_VISIBLE_ALPHA, tinyQuantity } from "./visible-text-constants.js";
import { MAX_HTML_DEPTH, flattenHtmlChildren } from "../reader/html-depth.js";
import { DomUtils } from "htmlparser2";

export type ModelTextFlag = NonNullable<ModelThread["messages"][number]["flags"]>[number];

function budgetFallbackText(ctx: VisibleContext): VisibleText {
  const { dom, budgetFallback, sanitizedRemoval, observer, cascadeStyle, emptyRules } = ctx;

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
      linkText(ctx, "\n");
      continue;
    }
    if (frame.kind === "link-end") {
      endLink(ctx, frame.link);
      continue;
    }
    const node = frame.node;
    if (adapter.isTextNode(node)) {
      const rejection = budgetFallback === "visible" ? inheritedTextRemoval(frame.textStyle) : null;
      if (rejection) {
        recordRemoval(ctx, node, rejection.rule, rejection.source);
        if (node.data.trim()) removed = true;
        continue;
      }
      observer?.retained(node.data.length);
      linkText(ctx, node.data);
      out.push(node.data);
      continue;
    }
    if (!("name" in node)) continue;
    if (OMIT.has(node.name)) {
      recordRemoval(ctx, node, "omit-tag", "omit-tag");
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
        ctx,
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
    const link = startLink(ctx, node);
    if (link) pending.push({ kind: "link-end", link });
    if (BLOCK.test(node.name)) {
      out.push("\n");
      linkText(ctx, "\n");
      pending.push({ kind: "line" });
    }
    if ("children" in node)
      for (const child of node.children.toReversed())
        pending.push({ kind: "node", node: child, textStyle });
  }
  return { text: normalizeHtmlText(out.join("")), hidden: removed, flags: ["budget-exceeded"] };
}

function textRejection(
  ctx: VisibleContext,
  node: HtmlNode,
  inherited: readonly RenderStyle[],
): Rejection | null {
  let rejection: { rule: VisibleRemovalRule; source: VisibleRemovalSource } | null = null;
  for (const environment of inherited) {
    rejection ??= inheritedTextRemoval(environment);
    const inks =
      environment.textFill &&
      !/^(currentcolor|initial|revert|revert-layer)$/.test(environment.textFill)
        ? [environment.textFill]
        : environment.colours;
    const overlap = siblingRemoval(ctx, node, environment, inks);
    if (!rejection && overlap) rejection = { rule: overlap, source: "inherited" };
    for (const ink of inks)
      for (const paper of environment.backgrounds) {
        const rule =
          paper.kind === "unknown"
            ? "uncertain-paint"
            : inkRemovalRule(ink, paper.rgb, environment.opacity, environment.scale);
        if (!rejection && rule) rejection = { rule, source: "inherited" };
      }
    if (rejection) break;
  }

  return rejection;
}

function elementRejection(
  ctx: VisibleContext,
  node: HtmlElement,
  inherited: readonly RenderStyle[],
): { rejection: Rejection | null; nextStyles: RenderStyle[] } {
  const { cascadeStyle } = ctx;
  const attrs = node.attribs;
  const nextStyles: RenderStyle[] = [];
  let rejection: { rule: VisibleRemovalRule; source: VisibleRemovalSource } | null = null;
  for (const environment of inherited) {
    const cascade = cascadeStyle(
      rulesFor(ctx, node, environment.scenario),
      attrs.style ?? "",
      environment.width,
    );
    const css = cascade.values;
    const ink = css.get("color") ?? legacyColour(attrs.color) ?? environment.color;
    const foreground = resolveInk(ink, environment.color);
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
    if (css.get("scale") === "inherit") ownEffects.scaleValue = environment.ownEffects.scaleValue;
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
      if (alternative && tinyQuantity(alternative)) textStyle = { ...textStyle, size: alternative };
    }
    if (
      cascade.alternatives
        .get("line-height")
        ?.some((value) =>
          value === "inherit" ? environment.lineHeight === 0 : /^(0|calc\(0(?:px)?\))$/.test(value),
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
    else if (opacity * scale <= MIN_VISIBLE_ALPHA)
      rejection = {
        rule:
          cascade.effects.filterOpacity < 1
            ? "filter-opacity"
            : scale < 1
              ? ownEffects.zoom < 1
                ? "zoom"
                : "scale"
              : "opacity",
        source: origin(EFFECT_PROPERTIES),
      };
    else if (clipped) rejection = { rule: "clipping", source: origin(["overflow", "line-height"]) };
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

  return { rejection, nextStyles };
}

function walkDocument(
  ctx: VisibleContext,
  parent: Pick<HtmlDocument, "children">,
  inherited: readonly RenderStyle[] = ctx.initialStyles,
  depth = 0,
) {
  const { diagnostic, observer, out } = ctx;

  if (depth >= MAX_HTML_DEPTH + 2) {
    diagnostic?.("nesting-depth-limit");
    parent.children = flattenHtmlChildren(parent.children, (node) => {
      const omit = "name" in node && OMIT.has(node.name);
      if (omit) recordRemoval(ctx, node, "omit-tag", "omit-tag");
      return omit;
    });
  }
  for (const node of parent.children) {
    if (adapter.isTextNode(node)) {
      const rejection = textRejection(ctx, node, inherited);
      if (rejection) {
        recordRemoval(ctx, node, rejection.rule, rejection.source);
        if (node.data.trim()) ctx.hidden = true;
        continue;
      }
      observer?.retained(node.data.length);
      linkText(ctx, node.data);
      out.push(node.data);
      continue;
    }
    if (!("name" in node) || !("attribs" in node)) continue;
    if (OMIT.has(node.name)) {
      recordRemoval(ctx, node, "omit-tag", "omit-tag");
      if (!["head", "style"].includes(node.name) && hasText(node)) ctx.hidden = true;
      continue;
    }
    const { rejection, nextStyles } = elementRejection(ctx, node, inherited);
    if (rejection) {
      recordRemoval(ctx, node, rejection.rule, rejection.source);
      if (hasText(node)) ctx.hidden = true;
      continue;
    }
    const link = startLink(ctx, node);
    if (BLOCK.test(node.name)) {
      out.push("\n");
      linkText(ctx, "\n");
    }
    walkDocument(ctx, node, nextStyles, depth + 1);
    if (BLOCK.test(node.name)) {
      out.push("\n");
      linkText(ctx, "\n");
    }
    if (link) endLink(ctx, link);
  }
}

/** Filter hidden text within a bounded CSS inspection; exhaustion is explicit. */
export function visibleHtmlText(html: string, options: VisibleHtmlTextOptions = {}): VisibleText {
  const ctx = createContext(html, options);
  indexDocument(ctx);
  if (collectRules(ctx)) return budgetFallbackText(ctx);
  if (!buildPainters(ctx)) return { text: "", hidden: true, flags: ["budget-exceeded"] };
  try {
    walkDocument(ctx, ctx.dom);
  } catch {
    return { text: "", hidden: true, flags: ["budget-exceeded"] };
  }
  return { text: normalizeHtmlText(ctx.out.join("")), hidden: ctx.hidden };
}

/** Retain markup only for nodes accepted by the same bounded visibility policy as model text. */
export function visibleHtmlMarkup(html: string, onHiddenText?: () => void): string {
  const ctx = createContext(html, {});
  const removed = new Set<HtmlNode>();
  ctx.removedNodes = removed;
  indexDocument(ctx);
  if (collectRules(ctx) || !buildPainters(ctx)) return "";
  try {
    walkDocument(ctx, ctx.dom);
  } catch {
    return "";
  }
  if (ctx.hidden) onHiddenText?.();
  const prune = (nodes: HtmlNode[]): HtmlNode[] =>
    nodes.filter((node) => {
      if (removed.has(node)) return false;
      if ("children" in node) node.children = prune(node.children);
      return true;
    });
  const body = ctx.elements.find((node) => "name" in node && node.name === "body");
  for (let parent = body; parent; parent = parent.parent ?? undefined)
    if (removed.has(parent)) return "";
  return body && "children" in body
    ? DomUtils.getOuterHTML(prune(body.children), { encodeEntities: "utf8" })
    : "";
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
  const plainWords = normalize(plain),
    visibleWords = normalize(visible.text);
  const words = new Set(visibleWords.split(/\s+/));
  const source = plainWords.split(/\s+/).filter(Boolean);
  const extra = source.filter((word) => !words.has(word)).length;
  const differs =
    !!plainWords &&
    (Math.abs(plainWords.length - visibleWords.length) > Math.max(20, visibleWords.length * 0.2) ||
      extra > Math.max(3, source.length * 0.2) ||
      (plainWords.length >= 5 && extra > 0 && extra / source.length >= 0.5));
  return {
    text: visible.text,
    flags: [
      ...(visible.hidden ? ["hidden-text-removed" as const] : []),
      ...(differs ? ["plain-differs" as const] : []),
    ],
  };
}
