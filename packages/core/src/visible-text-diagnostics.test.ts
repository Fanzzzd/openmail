import { expect, it } from "vitest";
import { visibleHtmlText } from "./visible-text.js";
import {
  createVisibleTextTrace,
  inspectHtmlStructure,
  type VisibleRemovalRule,
} from "./visible-text-diagnostics.js";

const fixtures: { rule: VisibleRemovalRule; html: string; word: string }[] = [
  { rule: "hidden-attribute", html: "<p hidden>HiddenAttrCanary</p>", word: "HiddenAttrCanary" },
  { rule: "aria-hidden", html: '<p aria-hidden="true">AriaCanary</p>', word: "AriaCanary" },
  {
    rule: "display-none",
    html: '<p style="display:none">DisplayCanary</p>',
    word: "DisplayCanary",
  },
  {
    rule: "visibility",
    html: '<p style="visibility:hidden">VisibilityCanary</p>',
    word: "VisibilityCanary",
  },
  { rule: "opacity", html: '<p style="opacity:0.05">OpacityCanary</p>', word: "OpacityCanary" },
  {
    rule: "font-size-zero",
    html: '<p style="font-size:0px">ZeroFontCanary</p>',
    word: "ZeroFontCanary",
  },
  {
    rule: "font-size-small",
    html: '<p style="font-size:1px">SmallFontCanary</p>',
    word: "SmallFontCanary",
  },
  {
    rule: "colour-match",
    html: '<p style="color:white;background:white">ColourCanary</p>',
    word: "ColourCanary",
  },
  {
    rule: "off-screen",
    html: '<p style="position:absolute;left:-1000px">OffscreenCanary</p>',
    word: "OffscreenCanary",
  },
  { rule: "scale", html: '<p style="transform:scale(0)">ScaleCanary</p>', word: "ScaleCanary" },
  { rule: "clipping", html: '<p style="clip:rect(0,0,0,0)">ClipCanary</p>', word: "ClipCanary" },
  {
    rule: "filter-opacity",
    html: '<p style="filter:opacity(0)">FilterCanary</p>',
    word: "FilterCanary",
  },
  { rule: "omit-tag", html: "<script>ScriptCanary</script>", word: "ScriptCanary" },
  {
    rule: "mso-conditional-comment",
    html: "<!--[if mso]><p>MsoCanary</p><![endif]-->",
    word: "MsoCanary",
  },
  { rule: "comment", html: "<!--<p>CommentCanary</p>-->", word: "CommentCanary" },
];

it.each(fixtures)(
  "traces actual $rule removals without changing visible text or exposing it",
  ({ rule, html, word }) => {
    const trace = createVisibleTextTrace(html);
    const actual = visibleHtmlText(html, "visible", trace.diagnostic, trace.observer);
    expect(actual).toEqual(visibleHtmlText(html));
    const explanation = trace.finish(actual);
    expect(explanation.removedByRule[rule]).toEqual({ textNodes: 1, characters: word.length });
    expect(explanation.visibleCharacters).toBe(0);
    expect(JSON.stringify(explanation).toLowerCase()).not.toContain(word.toLowerCase());
  },
);

it("reports stylesheet origin, selector shapes and custom tags through fixed allowlists", () => {
  const html =
    '<style>@media screen {.PrivateClassCanary:not(#PrivateIdCanary)[title="PrivateAttributeCanary"]{display:none}} :PrivatePseudoCanary{display:block}</style><PrivateTagCanary><p class="PrivateClassCanary" title="PrivateAttributeCanary">PrivateTextCanary</p></PrivateTagCanary>';
  const trace = createVisibleTextTrace(html);
  const result = visibleHtmlText(html, "visible", trace.diagnostic, trace.observer);
  const explanation = trace.finish(result);
  expect(result.text).toBe("");
  expect(explanation.removedByRule["display-none"]).toEqual({
    textNodes: 1,
    characters: "PrivateTextCanary".length,
  });
  expect(explanation.removedBySource["stylesheet-rule"]).toEqual({
    textNodes: 1,
    characters: "PrivateTextCanary".length,
  });
  expect(explanation.structure.tagCounts.other).toBe(1);
  expect(explanation.structure.stylesheetSelectorShapes).toMatchObject({
    "class-selector": 1,
    "id-selector": 1,
    "attribute-selector": 1,
    ":not": 1,
    "@media": 1,
  });
  for (const word of [
    "PrivateClassCanary",
    "PrivateIdCanary",
    "PrivateAttributeCanary",
    "PrivatePseudoCanary",
    "PrivateTagCanary",
    "PrivateTextCanary",
  ])
    expect(JSON.stringify(explanation).toLowerCase()).not.toContain(word.toLowerCase());
});

it("exposes malformed head topology and counts pruned subtrees once", () => {
  const html =
    "<html><head><style>p{color:black}</style><div><p>PrivateOutlookCanary</p></div></head></html>";
  const structure = inspectHtmlStructure(html);
  expect(structure.tagCounts.body).toBe(0);
  expect(structure.textNodesInsideHead).toBe(2);
  const trace = createVisibleTextTrace(html);
  const result = visibleHtmlText(html, "visible", trace.diagnostic, trace.observer);
  const explanation = trace.finish(result);
  expect(result.text).toBe("PrivateOutlookCanary");
  expect(explanation.removedByRule["omit-tag"]).toEqual({
    textNodes: 1,
    characters: "p{color:black}".length,
  });
  expect(JSON.stringify(explanation)).not.toContain("PrivateOutlookCanary");
});

it("preserves budget fallback and reports its actual inline removals", () => {
  const html = `<style>${"p{color:red}".repeat(5121)}</style><p hidden>PrivateBudgetCanary</p><p>PrivateVisibleCanary</p>`;
  const trace = createVisibleTextTrace(html);
  const result = visibleHtmlText(html, "visible", trace.diagnostic, trace.observer);
  const explanation = trace.finish(result);
  expect(result).toEqual(visibleHtmlText(html));
  expect(explanation.budgetExceeded).toBe(true);
  expect(explanation.cssRuleBudgetHits).toBe(1);
  expect(explanation.removedByRule["hidden-attribute"].textNodes).toBe(1);
  expect(explanation.retainedTextNodes).toBe(1);
  expect(explanation.retainedCharacters).toBe("PrivateVisibleCanary".length);
});
