// @vitest-environment jsdom
import * as fc from "fast-check";
import { expect, it } from "vitest";
import { prepareMessageHtml, richComposeBody, inspectAttachment } from "@openmail/core/schema";
import {
  hostileHtml,
  htmlTokens,
  nestedHtml,
} from "../../../../../../packages/core/src/parser-fuzz-corpus.js";
import { sanitizeReaderHtml } from "./reader-html";

const options = {
  seed: 0x520058,
  numRuns: process.env.OPENMAIL_LOW_MEMORY_TESTS === "1" ? 20 : 100,
};
const html = fc
  .array(fc.constantFrom(...htmlTokens), { maxLength: 24 })
  .map((tokens) => tokens.join(""));
function parsed(value: string): HTMLElement {
  return new DOMParser().parseFromString(value, "text/html").body;
}
function assertSafe(value: string) {
  const body = parsed(value);
  expect(body.querySelector("script,svg,math,iframe,object,embed,form,meta,base,link")).toBeNull();
  for (const node of body.querySelectorAll("*")) {
    for (const attr of node.attributes) {
      expect(attr.name).not.toMatch(/^on/i);
      if (["src", "background", "poster", "data", "srcset"].includes(attr.name)) {
        expect(attr.value).toMatch(
          /^(?:data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,|cid:|data:,$)/i,
        );
      }
      if (["href", "src", "xlink:href"].includes(attr.name))
        expect(attr.value).not.toMatch(/^\s*(?:javascript|vbscript):/i);
      if (attr.name === "style")
        expect(attr.value).not.toMatch(/evil\.test|@import|expression\(|behavior\s*:/i);
    }
    if (node.localName === "style")
      expect(node.textContent).not.toMatch(/evil\.test|@import|expression\(/i);
  }
}

it.each(hostileHtml)(
  "reader strips executable markup and blocked resources after browser reparse: %s",
  (input) => {
    const clean = sanitizeReaderHtml(prepareMessageHtml(input).html, false);
    assertSafe(clean);
    expect(sanitizeReaderHtml(clean, false)).toBe(clean);
    expect(parsed(parsed(clean).innerHTML).innerHTML).toBe(parsed(clean).innerHTML);
  },
);

it("seeded mXSS combinations stay safe and stable after parse/serialize/reparse", () => {
  fc.assert(
    fc.property(html, (input) => {
      const clean = sanitizeReaderHtml(prepareMessageHtml(input).html, false);
      assertSafe(clean);
      expect(sanitizeReaderHtml(clean, false)).toBe(clean);
      const serialized = parsed(clean).innerHTML;
      expect(parsed(serialized).innerHTML).toBe(serialized);
      assertSafe(serialized);
      const composed = richComposeBody(input).html;
      assertSafe(composed);
      expect(parsed(parsed(composed).innerHTML).innerHTML).toBe(parsed(composed).innerHTML);
    }),
    options,
  );
});

it("retains safe reader formatting, inline images and opted-in HTTPS resources", () => {
  const input =
    '<style>p{color:red;background:url(https://evil.test/x)}</style><p style="font-weight:bold;background-image:image-set(\'https://evil.test/x\' 1x)"><img src="data:image/png;base64,AQID"><img src="https://evil.test/x"><a href="https://example.test">link</a></p>';
  const blocked = sanitizeReaderHtml(input, false);
  expect(blocked).toContain("color:red");
  expect(blocked).toContain("font-weight:bold");
  expect(blocked).toContain("data:image/png;base64,AQID");
  expect(blocked).toContain('href="https://example.test"');
  assertSafe(blocked);
  expect(sanitizeReaderHtml(input, true)).toContain('src="https://evil.test/x"');
});

it("HTML attachment preview uses the same reader sanitizer", () => {
  const input = '<script>alert(1)</script><img src="https://evil.test/pixel" onerror="alert(1)">';
  const inspected = inspectAttachment({
    filename: "evil.html",
    mimeType: "text/html",
    data: new TextEncoder().encode(input),
  });
  if (inspected?.kind !== "html") throw new Error("Expected an HTML attachment preview");
  const clean = sanitizeReaderHtml(inspected.html, false);
  assertSafe(clean);
  expect(clean).toBe("<img>");
});

it("CSS comments, escapes and nested functions cannot conceal blocked resources", () => {
  for (const css of [
    "background:u\\72l(https://evil.test/x)",
    'background:image-set("https://evil.test/x" 1x)',
    "background:var(--x,url(https://evil.test/x))",
    "background:u/**/rl(https://evil.test/x)",
    "--x:url(https://evil.test/x);background:var(--x)",
  ]) {
    assertSafe(sanitizeReaderHtml(`<style>p{${css}}</style><p style='${css}'>text</p>`, false));
  }
});

it("one MiB text and 10k nested tags obey reader time and output budgets", () => {
  const started = performance.now();
  const text = "x".repeat(1024 * 1024);
  expect(sanitizeReaderHtml(text, false)).toBe(text);
  const deep = sanitizeReaderHtml(nestedHtml(10_000), false);
  assertSafe(deep);
  expect(deep.length).toBeLessThan(150_000);
  expect(performance.now() - started).toBeLessThan(15_000);
}, 20_000);
