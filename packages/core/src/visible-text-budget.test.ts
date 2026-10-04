import { expect, it } from "vitest";
import { visibleHtmlText, messageModelText } from "./visible-text.js";
import { htmlToText } from "./mime.js";
import { createVisibleTextTrace } from "./visible-text-diagnostics.js";
const budgetCases = [
  {
    name: "budget exhaustion returns all text and an explicit flag instead of an empty body",
    run: () => {
      const css = ".message{display:none}".repeat(6000);
      const input = `<style>${css}</style><p class="message">Shipment reference</p><p>Last searchable paragraph</p>`;
      expect(visibleHtmlText(input)).toMatchObject({
        text: "Shipment reference\nLast searchable paragraph",
        hidden: false,
        flags: ["budget-exceeded"],
      });
      expect(htmlToText(input)).toBe("Shipment reference\nLast searchable paragraph");
      expect(messageModelText("", input).flags).toContain("budget-exceeded");
    },
  },
  {
    name: "paint alternatives are bounded and do not forward fallback text",
    run: () => {
      const opening =
        '<div style="background-image:linear-gradient(rgba(0,0,0,.5),rgba(255,255,255,.5))">';
      const html = `${opening.repeat(10)}SECRET${"</div>".repeat(10)}`;
      expect(visibleHtmlText(html)).toHaveProperty("flags", ["budget-exceeded"]);
      expect(messageModelText("SECRET", html).text).not.toContain("SECRET");
    },
  },
  {
    name: "CSS budget fallback also honors inline inheritance without restoring model text",
    run: () => {
      const css = "p{color:red}".repeat(5121);
      const html = `<style>${css}</style><div style="font-size:0;visibility:hidden"><p style="font-size:14px;visibility:visible">NewsletterBodyCanary</p><p style="visibility:visible;font-size:1em">PrivateAttackCanary</p></div>`;
      expect(visibleHtmlText(html)).toMatchObject({
        text: "NewsletterBodyCanary",
        hidden: true,
        flags: ["budget-exceeded"],
      });
      expect(messageModelText("NewsletterBodyCanary PrivateAttackCanary", html).text).not.toContain(
        "NewsletterBodyCanary",
      );
      // Search's explicit full-text fallback remains separate from the model's rejection.
      expect(htmlToText(html)).toContain("NewsletterBodyCanary");
    },
  },
  {
    name: "budget exhaustion never restores responsive or hidden text to the model",
    run: () => {
      const html = `<style>${"p{color:red}".repeat(5121)}@media screen{.copy{display:block!important}}</style><p class="copy" style="display:none">PrivateAttackCanary</p>`;
      expect(messageModelText("PrivateAttackCanary", html)).toMatchObject({
        flags: ["budget-exceeded", "hidden-text-removed"],
      });
      expect(messageModelText("PrivateAttackCanary", html).text).not.toContain(
        "PrivateAttackCanary",
      );
    },
  },
  {
    name: "preserves budget fallback and reports its actual inline removals",
    run: () => {
      const html = `<style>${"p{color:red}".repeat(5121)}</style><p hidden>PrivateBudgetCanary</p><p>PrivateVisibleCanary</p>`;
      const trace = createVisibleTextTrace(html);
      const result = visibleHtmlText(html, {
        budgetFallback: "visible",
        diagnostic: trace.diagnostic,
        observer: trace.observer,
      });
      const explanation = trace.finish(result);
      expect(result).toEqual(visibleHtmlText(html));
      expect(explanation.budgetExceeded).toBe(true);
      expect(explanation.cssRuleBudgetHits).toBe(1);
      expect(explanation.removedByRule["hidden-attribute"].textNodes).toBe(1);
      expect(explanation.retainedTextNodes).toBe(1);
      expect(explanation.retainedCharacters).toBe("PrivateVisibleCanary".length);
    },
  },
  {
    name: "declaration budget exhaustion never restores model text",
    run: () => {
      const html = `<style>.x{${"color:black;".repeat(8193)}display:none}</style><p class="x">SECRET</p>`;
      expect(visibleHtmlText(html)).toHaveProperty("flags", ["budget-exceeded"]);
      expect(messageModelText("SECRET", html).text).not.toContain("SECRET");
    },
  },
  {
    name: "scenario expansion is bounded and never forwards fallback text to the model",
    run: () => {
      const groups = Array.from(
        { length: 7 },
        (_, i) => `@media(unknown-feature-${i}:1){.x{color:white;background-color:#333}}`,
      ).join("");
      const html = `<style>${groups}</style><p class="x">SECRET</p>`;
      expect(visibleHtmlText(html)).toHaveProperty("flags", ["budget-exceeded"]);
      expect(messageModelText("SECRET", html).text).not.toContain("SECRET");
    },
  },
  {
    name: "inline budget exhaustion in the painter prepass returns the same bounded fallback",
    run: () => {
      const html = `<p style="${"color:black;".repeat(8193)}">SECRET</p>`;
      expect(visibleHtmlText(html)).toHaveProperty("flags", ["budget-exceeded"]);
    },
  },
];
it.each(budgetCases)("$name", ({ run }) => run());
