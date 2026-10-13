import { expect, it } from "vitest";
import { visibleHtmlText, messageModelText } from "./visible-text.js";
import { sanitizeReaderHtml } from "../reader/reader-sanitize.js";

const checkHidden = (html: string) => {
  expect(visibleHtmlText(html).text).not.toContain("SECRET");
  expect(messageModelText("SECRET", html).text).not.toContain("SECRET");
  expect(visibleHtmlText(sanitizeReaderHtml(html)).text).not.toContain("SECRET");
};

it("uncertain style media attributes still apply hiding", () =>
  checkHidden(
    '<style media="(hover:hover),(hover:none)">.x{display:none}</style><p class="x">SECRET</p>',
  ));

for (const value of [String.raw`n\one`, String.raw`n\6f ne`]) {
  it(`escaped display keyword ${value} hides inline and stylesheet text`, () => {
    checkHidden(`<p style="display:${value}">SECRET</p>`);
    checkHidden(`<style>.x{display:${value}}</style><p class="x">SECRET</p>`);
  });
}
it("escaped inherited and subtree keywords hide text", () => {
  for (const css of [
    String.raw`visibility:hi\64 den`,
    String.raw`content-visibility:hi\64 den`,
    String.raw`overflow:hi\64 den;line-height:0`,
  ])
    checkHidden(`<p style="${css}">SECRET</p>`);
});
it.each([":root{font-size:0}", "html{font-size:1px}"])(
  "fragment rem uses the synthetic root: %s",
  (css) => checkHidden(`<style>${css}</style><p style="font-size:1rem">SECRET</p>`),
);

it.each([
  "font:0/0 a",
  "line-height:0;overflow:hidden",
  "-webkit-text-fill-color:transparent",
  "zoom:0",
  "zoom:.1",
  "content-visibility:hidden",
  "font-size:calc(0px)",
  "font-size:clamp(0px,1px,2px)",
  "display:var(--d);--d:none",
  "opacity:0;opacity:garbage",
  "text-indent:-9999px;text-indent:garbage",
  "color:transparent;color:garbage",
])("pre-existing hiding path: %s", (css) => {
  checkHidden(`<p style="${css}">SECRET</p>`);
  checkHidden(`<style>.x{${css}}</style><p class="x">SECRET</p>`);
});

it.each(["400 0/0 a", "bold 0/0 a", "small-caps 0/0 a"])(
  "font shorthand with weight or variant still hides: %s",
  (font) => checkHidden(`<p style="font:${font}">SECRET</p>`),
);
it("readable font shorthand and a later initial reset retain text", () => {
  for (const css of ["font:400 14px Arial", "font:bold 12pt Arial", "font-size:0;font:initial"])
    expect(visibleHtmlText(`<p style="${css}">VISIBLE</p>`).text).toBe("VISIBLE");
});

const effectsHidden = (html: string) => {
  expect(visibleHtmlText(html).text).not.toContain("SECRET");
  expect(messageModelText("SECRET", html).text).not.toContain("SECRET");
  expect(visibleHtmlText(sanitizeReaderHtml(html)).text).not.toContain("SECRET");
};
it.each(["ie", "importantx"])("nonstandard important marker !%s cannot reveal", (priority) => {
  effectsHidden(`<p style="display:none!important;display:block!${priority}">SECRET</p>`);
  effectsHidden(
    `<style>.x{display:none!important;display:block!${priority}}</style><p class="x">SECRET</p>`,
  );
});

it.each([
  "font-size:revert-layer",
  "visibility:revert-layer",
  "all:initial",
  "all:revert",
  "all:revert-layer",
])("reset %s remains possibly hiding", (css) => {
  effectsHidden(`<div style="font-size:0;visibility:hidden"><p style="${css}">SECRET</p></div>`);
  effectsHidden(
    `<style>.x{${css}}</style><div style="font-size:0;visibility:hidden"><p class="x">SECRET</p></div>`,
  );
});

it.each([":read-only", ":lang(en)", ":hover", ":visited", ":not(:hover)"])(
  "environment selector %s can hide but cannot reveal",
  (pseudo) => {
    effectsHidden(
      `<style>.x{display:none}.x${pseudo}{display:block!important}</style><p class="x">SECRET</p>`,
    );
    effectsHidden(`<style>.x${pseudo}{display:none}</style><p class="x">SECRET</p>`);
  },
);

it("discarded attributes and style parents cannot reveal reader text", () => {
  effectsHidden(
    '<style>.x{display:none}.x[data-private]{display:block!important}</style><p class="x" data-private="yes">SECRET</p>',
  );
  effectsHidden(
    '<style>.x{display:none}</style><svg><style>.x{display:block!important}</style></svg><p class="x">SECRET</p>',
  );
});

it("HTML5 foster-parenting keeps table-dependent reveals from matching", () =>
  effectsHidden(
    '<style>.x{display:none}table .x{display:block!important}</style><table><p class="x">SECRET</p><tr><td>VISIBLE</td></tr></table>',
  ));

it("reader body wrapper and shell selectors match their rendered locations", () => {
  effectsHidden(
    '<style>.x{display:none}html>head>.x{display:block!important}</style><html><head><p class="x">SECRET</p></head></html>',
  );
  expect(
    visibleHtmlText('<style>body[dir="auto"] .x{display:none}</style><p class="x">SECRET</p>').text,
  ).toBe("");
});

it.each([
  "form",
  "select",
  "option",
  "button",
  "textarea",
  "svg",
  "math",
  "xmp",
  "noembed",
  "noframes",
  "frameset",
  "applet",
  "plaintext",
])("reader drops %s contents", (tag) => effectsHidden(`<${tag}>SECRET</${tag}>`));

it("void embed is removed without swallowing adjacent visible text", () => {
  expect(visibleHtmlText('<embed src="https://evil.invalid/"><p>VISIBLE</p>').text).toBe("VISIBLE");
});
