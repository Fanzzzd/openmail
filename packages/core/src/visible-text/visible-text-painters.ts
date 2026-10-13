/** Sibling elements that paint over text, and the text they hide. */

import {
  OMIT,
  PAINTER_STYLE_PATTERN,
  adjacent,
  inkMatchesPaint,
  type CoveredRange,
  type HtmlNode,
  type Painter,
  type RenderStyle,
  type VisibleContext,
} from "./visible-text-context.js";
import { adapter } from "parse5-htmlparser2-tree-adapter";
import { REFERENCE_READER_WIDTHS } from "./visible-text-css.js";
import { INITIAL_TEXT_STYLE } from "./visible-text-inheritance.js";
import { READER_COLOURS } from "../reader/reader-style.js";
import { WHITE_PAPER, composite, legacyColour, resolveInk } from "./visible-text-paint.js";
import { styleEffects } from "./visible-text-style.js";
import { rulesFor } from "./visible-text-rules.js";
import { horizontalInlineCoverage, opaqueCoverage } from "./visible-text-cover.js";
import { constantLength, siblingPaint } from "./visible-text-overlap.js";
import type { VisibleRemovalRule } from "./visible-text-diagnostics.js";

export function hasText(node: HtmlNode): boolean {
  const pending = [node];
  while (pending.length) {
    const current = pending.pop();
    if (!current) continue;
    if (adapter.isTextNode(current) && current.data.trim()) return true;
    if ("children" in current) for (const child of current.children) pending.push(child);
  }
  return false;
}

export function buildPainters(ctx: VisibleContext): boolean {
  ctx.siblingGroups = ctx.environments.map(() => new Map());
  ctx.coverageRanges = ctx.environments.map(() => new Map());
  const {
    environments,
    dom,
    elements,
    stylesheets,
    cascadeStyle,
    nodeOrder,
    nodeEnd,
    siblingGroups,
    coverageRanges,
  } = ctx;
  ctx.initialStyles = environments.flatMap((_, scenario) =>
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
  const { initialStyles } = ctx;
  // Precompute each scenario's containing blocks and painters. The text walk
  // then sees before/after siblings without mixing media colours or DOM order.
  const hasPainters =
    elements.some(
      (node) => "attribs" in node && PAINTER_STYLE_PATTERN.test(node.attribs.style ?? ""),
    ) || stylesheets.some((sheet) => PAINTER_STYLE_PATTERN.test(sheet.css));
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
            rulesFor(ctx, node, environment.scenario),
            node.attribs.style ?? "",
            environment.width,
          );
          const css = cascade.values;
          const horizontal = horizontalInlineCoverage(css, node.name, node.attribs);
          const width = constantLength(css.get("width") ?? node.attribs.width);
          const height = constantLength(css.get("height") ?? node.attribs.height);
          declaredSizes.set(node, {
            width: width !== null && width > 0 ? width : null,
            height: height !== null && height > 0 ? height : null,
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
          const ink = resolveInk(value, parentInk);
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
                    rulesFor(ctx, neighbour, environment.scenario),
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
      return false;
    }
  }

  return true;
}

export function siblingRemoval(
  ctx: VisibleContext,
  node: HtmlNode,
  environment: RenderStyle,
  inks: readonly string[],
): VisibleRemovalRule | null {
  const { nodeOrder, coverageRanges, siblingGroups } = ctx;

  const order = nodeOrder.get(node) ?? -1;
  for (const range of coverageRanges[environment.scenario]?.get(environment.width) ?? []) {
    if (--ctx.paintChecksRemaining < 0) throw new RangeError("Opaque coverage budget");
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
      if (--ctx.paintChecksRemaining < 0) throw new RangeError("Sibling paint budget");
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
            if (inkMatchesPaint(ink, rgb, environment.opacity * environment.scale))
              return "positioned-overlay";
        }
      }
    }
  }
  return null;
}
