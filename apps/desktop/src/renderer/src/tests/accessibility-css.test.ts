import { builtStyles } from "../test-support/test-styles";
import { AtRule, type ChildNode, type Node } from "postcss";
import { expect, it } from "vitest";

function layers(node: ChildNode) {
  const names: string[] = [];
  for (let parent: Node | undefined = node.parent; parent; parent = parent.parent) {
    if (parent instanceof AtRule && parent.name === "layer") names.push(parent.params);
  }
  return names;
}

it("keeps built accessibility defaults in layers so component utilities win", () => {
  let defaults = 0;
  const css = builtStyles();
  css.walkRules((rule) => {
    rule.walkDecls((decl) => {
      if (!decl.value.includes("var(--a11y-") && !decl.prop.startsWith("--a11y-")) return;
      expect(layers(rule), rule.selector).not.toHaveLength(0);
      if (decl.prop === "outline") {
        expect(rule.selector).toContain(":not(input)");
        expect(rule.selector).toContain(":not(textarea)");
        expect(rule.selector).toContain(":not([contenteditable])");
      }
      if (
        rule.selector.includes(":where") ||
        rule.selector.includes("data-id") ||
        rule.selector === "::placeholder"
      ) {
        defaults++;
        expect(layers(rule), rule.selector).toContain("base");
        expect(decl.important, rule.selector).toBeFalsy();
      }
    });
    if (rule.selector.includes(":where(button")) {
      rule.walkDecls(/^(?:height|min-height)$/, () => {
        throw new Error(`Global button height in built CSS: ${rule.selector}`);
      });
    }
    if (/\[role=["']?dialog/.test(rule.selector) && !rule.selector.startsWith(".")) {
      expect(rule.selector).toContain(":not([data-full-window])");
    }
  });
  expect(defaults).toBeGreaterThan(0);
});
