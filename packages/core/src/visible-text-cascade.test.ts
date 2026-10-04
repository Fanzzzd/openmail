import { expect, it } from "vitest";
import { visibleHtmlText, messageModelText } from "./visible-text.js";
import { sanitizeReaderHtml } from "./reader-sanitize.js";

const checkHidden = (html: string) => {
  expect(visibleHtmlText(html).text).not.toContain("SECRET");
  expect(messageModelText("SECRET", html).text).not.toContain("SECRET");
  expect(visibleHtmlText(sanitizeReaderHtml(html)).text).not.toContain("SECRET");
};
it.each([
  "@supports (display:grid){.x{display:none}}",
  "@layer a{.x{display:none}}",
  "@media (hover:hover),(hover:none){.x{display:none}}",
  "@media (orientation:portrait),(orientation:landscape){.x{display:none}}",
  "@media screen and (-webkit-min-device-pixel-ratio:0){.x{display:none}}",
  "@media (prefers-color-scheme:light),(prefers-color-scheme:dark){.x{opacity:0}}",
  "@supports (display:grid){.x{visibility:hidden}}",
  "@supports (display:grid){.x{font-size:0}}",
  "@container (min-width:1px){.x{display:none}}",
  "@media not all and (width:800px){.x{display:none}}",
  "@media (max-width:799.9px),(min-width:800.1px){.x{display:none}}",
  ".x{display:none}@media (width:800px){.x{display:block!important}}",
])("conservative hiding: %s", (css) =>
  checkHidden(
    `<style>${css}</style><div style="container-type:inline-size"><p class="x">SECRET</p></div>`,
  ),
);

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

it("responsive reveals at both reference widths retain desktop or mobile text", () => {
  for (const variant of ["desktop", "mobile"]) {
    const html = `<style>.desktop,.mobile{display:none}@media screen and (min-width:0px) and (max-width:8000px){.${variant}{display:block!important}}</style><p class="desktop">DESKTOP</p><p class="mobile">MOBILE</p>`;
    expect(visibleHtmlText(html).text).toBe(variant.toUpperCase());
  }
});
it("complementary media queries on one element can establish a reveal at both reference widths", () => {
  const html =
    '<style>.x{display:none}@media(max-width:800px){.x{display:block!important}}@media(min-width:800px){.x{display:block!important}}</style><p class="x">VISIBLE</p>';
  expect(visibleHtmlText(html).text).toBe("VISIBLE");
});

it.each([
  ".x{display:none}@supports(display:grid){.x{display:block!important}}",
  ".x{display:none}@layer a{.x{display:block!important}}",
  ".x{display:none}@container(min-width:1px){.x{display:block!important}}",
  ".x{font-size:0}@media(max-width:800px){.x{font-size:1em!important}}",
  ".x{color:transparent}@media(max-width:800px){.x{color:black!important}}",
  ".x{display:none}@media(max-width:800px){.x{display:block!important}}.x{display:none!important}@media(min-width:800px){.x{display:block!important}}",
])("uncertain or interrupted reveal stays hidden: %s", (css) =>
  checkHidden(`<style>${css}</style><p class="x">SECRET</p>`),
);

it.each(["400 0/0 a", "bold 0/0 a", "small-caps 0/0 a"])(
  "font shorthand with weight or variant still hides: %s",
  (font) => checkHidden(`<p style="font:${font}">SECRET</p>`),
);
it("readable font shorthand and a later initial reset retain text", () => {
  for (const css of ["font:400 14px Arial", "font:bold 12pt Arial", "font-size:0;font:initial"])
    expect(visibleHtmlText(`<p style="${css}">VISIBLE</p>`).text).toBe("VISIBLE");
});
it("declaration budget exhaustion never restores model text", () => {
  const html = `<style>.x{${"color:black;".repeat(8193)}display:none}</style><p class="x">SECRET</p>`;
  expect(visibleHtmlText(html)).toHaveProperty("flags", ["budget-exceeded"]);
  expect(messageModelText("SECRET", html).text).not.toContain("SECRET");
});
