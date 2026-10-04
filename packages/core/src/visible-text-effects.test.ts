import { expect, it } from "vitest";
import { visibleHtmlText, messageModelText } from "./visible-text.js";
import { sanitizeReaderHtml } from "./reader-sanitize.js";

const hidden = (html: string) => {
  expect(visibleHtmlText(html).text).not.toContain("SECRET");
  expect(messageModelText("SECRET", html).text).not.toContain("SECRET");
  expect(visibleHtmlText(sanitizeReaderHtml(html)).text).not.toContain("SECRET");
};
it.each(["ie", "importantx"])("nonstandard important marker !%s cannot reveal", (priority) => {
  hidden(`<p style="display:none!important;display:block!${priority}">SECRET</p>`);
  hidden(
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
  hidden(`<div style="font-size:0;visibility:hidden"><p style="${css}">SECRET</p></div>`);
  hidden(
    `<style>.x{${css}}</style><div style="font-size:0;visibility:hidden"><p class="x">SECRET</p></div>`,
  );
});
it.each(["(min-width:320px)", "(max-width:1920px)", "(min-width:20em)"])(
  "partial reveal condition %s cannot restore text",
  (query) => {
    hidden(
      `<style>.x{display:none}@media${query}{.x{display:block!important}}</style><p class="x">SECRET</p>`,
    );
  },
);
it("complementary max-600/min-601 reveals cover the safety range", () => {
  expect(
    visibleHtmlText(
      '<style>.x{display:none}@media(max-width:600px){.x{display:block!important}}@media(min-width:601px){.x{display:block!important}}</style><p class="x">VISIBLE</p>',
    ).text,
  ).toBe("VISIBLE");
});
it.each([":read-only", ":lang(en)", ":hover", ":visited", ":not(:hover)"])(
  "environment selector %s can hide but cannot reveal",
  (pseudo) => {
    hidden(
      `<style>.x{display:none}.x${pseudo}{display:block!important}</style><p class="x">SECRET</p>`,
    );
    hidden(`<style>.x${pseudo}{display:none}</style><p class="x">SECRET</p>`);
  },
);
it("discarded attributes and style parents cannot reveal reader text", () => {
  hidden(
    '<style>.x{display:none}.x[data-private]{display:block!important}</style><p class="x" data-private="yes">SECRET</p>',
  );
  hidden(
    '<style>.x{display:none}</style><svg><style>.x{display:block!important}</style></svg><p class="x">SECRET</p>',
  );
});
it("HTML5 foster-parenting keeps table-dependent reveals from matching", () =>
  hidden(
    '<style>.x{display:none}table .x{display:block!important}</style><table><p class="x">SECRET</p><tr><td>VISIBLE</td></tr></table>',
  ));
it("reader body wrapper and shell selectors match their rendered locations", () => {
  hidden(
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
])("reader drops %s contents", (tag) => hidden(`<${tag}>SECRET</${tag}>`));
it.each([
  "opacity:calc(0)",
  "filter:opacity(0.05)",
  "filter:opacity(5.5%)",
  "scale:0",
  "translate:-99999px",
  "transform:translate(-99999px)",
  "transform:rotateX(90deg)",
  "transform:matrix(0,0,0,0,0,0)",
  "right:99999px",
  "bottom:99999px",
  "inset:99999px",
  "margin-inline-start:99999px",
  "text-indent:calc(-99999px)",
  "text-indent:-100%",
  "height:0;overflow:clip",
  "height:calc(0px);overflow-x:hidden",
  "height:0;overflow-y:clip",
  "height:0;contain:paint",
  "mask-image:linear-gradient(transparent,transparent)",
  "mask-image:linear-gradient(rgba(255,0,0,0),rgba(0,255,0,0))",
  "-webkit-mask-image:linear-gradient(transparent,transparent)",
  "-webkit-clip-path:inset(50%)",
  "color:oklch(50% 0 0);background-color:oklch(50% 0 0)",
  "color:lab(50% 0 0);background-color:lab(50% 0 0)",
  "color:color-mix(in srgb,white,black);background-color:color-mix(in srgb,white,black)",
  "color:Canvas;background-color:Canvas",
  "color:black;background-image:linear-gradient(black,black)",
  "color:black;background-image:linear-gradient(black,#000)",
  "color:black;box-shadow:inset 0 0 0 99999px black",
  "filter:contrast(0)",
  "filter:blur(20px)",
])("deterministic hiding %s", (css) => {
  hidden(`<p style="${css}">SECRET</p>`);
  hidden(`<style>.x{${css}}</style><p class="x">SECRET</p>`);
});
it.each([
  ["opacity:.3", "opacity:.3"],
  ["filter:opacity(.3)", "filter:opacity(.3)"],
  ["transform:scale(.3)", "transform:scale(.3)"],
  ["zoom:.3", "zoom:.3"],
  ["opacity:.3", "opacity:inherit"],
  ["filter:opacity(.3)", "filter:inherit"],
  ["transform:scale(.3)", "transform:inherit"],
  ["scale:.3", "scale:inherit"],
  ["zoom:.3", "zoom:inherit"],
  ["opacity:.3", "transform:scale(.3)"],
])("attenuation multiplies through ancestor %s and child %s", (parent, child) =>
  hidden(`<div style="${parent}"><p style="${child}">SECRET</p></div>`),
);
it("unparseable foreground cannot establish contrast on a known background", () => {
  expect(
    visibleHtmlText('<p style="color:oklch(50% 0 0);background-color:white">SECRET</p>').text,
  ).toBe("");
});

it("void embed is removed without swallowing adjacent visible text", () => {
  expect(visibleHtmlText('<embed src="https://evil.invalid/"><p>VISIBLE</p>').text).toBe("VISIBLE");
});

it("partial colour changes preserve inherited hiding alternatives through descendants", () => {
  hidden(
    '<style>.x{color:transparent}@media(min-width:320px){.x{color:black}}</style><div class="x"><span>SECRET</span></div>',
  );
  hidden(
    '<style>.x{background-color:black;color:black}@media(min-width:320px){.x{background-color:white}}</style><div class="x"><span>SECRET</span></div>',
  );
});
it("CSS opacity is clamped before multiplying through descendants", () =>
  hidden(
    '<div style="opacity:2"><div style="opacity:.3"><p style="opacity:.3">SECRET</p></div></div>',
  ));
it("an uncertain ordinary colour alone does not discard readable descendants", () => {
  expect(
    visibleHtmlText(
      '<style>@media(hover:hover){.x{color:red}}</style><div class="x"><span>VISIBLE</span></div>',
    ).text,
  ).toBe("VISIBLE");
});
