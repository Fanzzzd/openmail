/** Collects the CSS rules that apply to each element of the document. */

import {
  candidates,
  type HtmlNode,
  type RuleList,
  type VisibleContext,
} from "./visible-text-context.js";
import {
  referenceMedia,
  visibleStylesheetRules,
  type VisibleStyleRule,
} from "./visible-text-css.js";
import { referenceEnvironments } from "./visible-text-media.js";
import { MAX_SELECTOR_LENGTH } from "./visible-text-constants.js";
import { compile } from "css-select";

function appendRule(
  ctx: VisibleContext,
  previous: RuleList,
  rule: VisibleStyleRule,
  id: number,
): RuleList {
  const { interned } = ctx;

  let transitions = interned.get(previous.id);
  if (!transitions) {
    transitions = new Map();
    interned.set(previous.id, transitions);
  }
  const cached = transitions.get(id);
  if (cached) return cached;
  const result = { id: ctx.nextListId++, previous, rule };
  transitions.set(id, result);
  return result;
}

export function rulesFor(
  ctx: VisibleContext,
  node: HtmlNode,
  scenario: number,
): readonly VisibleStyleRule[] {
  const { styles, emptyRules, materialized } = ctx;

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
}

export function collectRules(ctx: VisibleContext): boolean {
  try {
    ctx.environments = referenceEnvironments(ctx.stylesheets, ctx.declarationParser);
  } catch {
    ctx.scenarioBudgetExceeded = true;
  }
  ctx.styles = ctx.environments.map(() => new Map<HtmlNode, RuleList>());
  const {
    scenarioBudgetExceeded,
    environments,
    styles,
    stylesheets,
    declarationParser,
    selectorMatches,
    diagnostic,
    initialList,
  } = ctx;

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
          if (decoded.length > MAX_SELECTOR_LENGTH) return true;
          try {
            let matched = selectorMatches.get(decoded);
            if (!matched) {
              const targets = candidates(ctx, decoded);
              if (!targets.length) {
                selectorMatches.set(decoded, []);
                continue;
              }
              const match = compile(decoded);
              matched = [];
              for (const node of targets) {
                if (--ctx.matchesRemaining < 0) return true;
                if (match(node)) matched.push(node);
              }
              selectorMatches.set(decoded, matched);
            }
            if (!matched.length) continue;
            if (--ctx.ruleBudget < 0) {
              diagnostic?.("css-rule-budget");
              return true;
            }
            const ruleId = ctx.nextRuleId++;
            for (const node of matched)
              scenarioStyles.set(
                node,
                appendRule(ctx, scenarioStyles.get(node) ?? initialList, rule, ruleId),
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
}
