import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { visibleHtmlText } from "../../visible-text/visible-text.js";
import { perfBudget } from "../../../test-support/perf-budget.js";
import {
  makeDeclarationParser,
  visibleStylesheetRules,
} from "../../visible-text/visible-text-css.js";

// Wall-clock budgets are opt-in; the default suite checks output and shared parse results.
const performanceBudgets = process.env.OPENMAIL_PERF === "1";

it("95 KB mail with 5000 declarations retains all 5000 paragraphs", () => {
  visibleHtmlText("<style>p{color:#000}</style><p>visible</p>");
  const html = `<style>p{${"color:#000;".repeat(5000)}}</style>${"<p>x</p>".repeat(5000)}`;
  const start = performance.now();
  const result = visibleHtmlText(html);
  const ms = performance.now() - start;
  expect(result.text.split("\n")).toHaveLength(5000);
  if (performanceBudgets) expect(ms).toBeLessThan(perfBudget(1000));
});
it("20000 media groups share one parsed query and compact declaration body", () => {
  const parser = makeDeclarationParser();
  expect([...visibleStylesheetRules("@media screen{p{color:red}}", parser)]).toHaveLength(1);
  const media = vi.spyOn(parser, "media");
  const styles = new Set<ReturnType<typeof parser.parseInline>>();
  const css = "@media (min-width:320px){p{color:red}}".repeat(20000);
  const start = performance.now();
  let rules = 0,
    maximumDeclarations = 0;
  for (const rule of visibleStylesheetRules(css, parser)) {
    maximumDeclarations = Math.max(maximumDeclarations, rule.style.declarations.length);
    styles.add(rule.style);
    rules++;
  }
  const ms = performance.now() - start;
  expect(rules).toBe(20000);
  expect(maximumDeclarations).toBe(1);
  expect(media).toHaveBeenCalledTimes(1);
  expect(styles.size).toBe(1);
  if (performanceBudgets) expect(ms).toBeLessThan(perfBudget(200));
});

it.each([300, 1000])("%i narrow media rules keep 5000 matching paragraphs hidden", (count) => {
  const rules = Array.from({ length: count }, (_, i) => {
    const n = 500 + i;
    return `@media(min-width:${n}px) and (max-width:${n}.5px){.x{display:block}}`;
  }).join("");
  const html = `<style>.x{display:none}${rules}</style>${"<p class=x>x</p>".repeat(5000)}`;
  const start = performance.now();
  const result = visibleHtmlText(html);
  if (performanceBudgets) expect(performance.now() - start).toBeLessThan(perfBudget(1000));
  expect(result).toEqual({ text: "", hidden: true });
});

it("a 1 MB message text is tokenized once for eight search terms", async () => {
  const { searchTermRanges } = await import("../../search/search-snippets.js");
  const text = "Quarterly invoice review for the Café team, budget approved. ".repeat(17_000);
  const terms = ["invoice", "budget", "cafe", '"team budget"', "review*", "quarterly", "x", "zz"];
  searchTermRanges(text, terms.slice(0, 1));
  const start = performance.now();
  const ranges = searchTermRanges(text, terms);
  const ms = performance.now() - start;
  expect(text.length).toBeGreaterThan(1_000_000);
  // Quarterly, invoice, review, Café, and "team, budget" merged with budget.
  expect(ranges).toHaveLength(17_000 * 5);
  if (performanceBudgets) expect(ms).toBeLessThan(perfBudget(100));
});
