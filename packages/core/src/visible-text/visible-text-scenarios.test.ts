import { expect, it } from "vitest";
import { visibleHtmlText, messageModelText } from "./visible-text.js";
import { sanitizeReaderHtml } from "../reader/reader-sanitize.js";
it.each(["data-ogsc", "data-ogsb"])(
  "sanitizer-only attribute %s matches no reader element",
  (attribute) => {
    const html = `<style>.paper{background-color:white}.text{color:black}[${attribute}] .text{color:white!important}</style><div ${attribute} class="paper"><p class="text">VISIBLE</p></div>`;
    expect(sanitizeReaderHtml(html)).not.toContain(`<div ${attribute}`);
    expect(visibleHtmlText(html).text).toBe("VISIBLE");
  },
);
it.each(["background:black", "background-image:linear-gradient(black,black)"])(
  "ancestor %s establishes a colour match",
  (background) => {
    expect(
      visibleHtmlText(`<div style="${background}"><p style="color:black">SECRET</p></div>`).text,
    ).toBe("");
  },
);
it("nearest painted ancestor overrides an earlier painted ancestor", () => {
  const html =
    '<div style="background-color:black"><section bgcolor="white"><p style="color:black">VISIBLE</p></section></div>';
  expect(visibleHtmlText(html).text).toBe("VISIBLE");
});

it("blocked URL backgrounds retain text contrasting with the fallback colour", () => {
  expect(
    visibleHtmlText(
      '<div style="background:white url(https://images.invalid/background.png)"><p style="color:black">VISIBLE</p></div>',
    ).text,
  ).toBe("VISIBLE");
});

const effectsHidden = (html: string) => {
  expect(visibleHtmlText(html).text).not.toContain("SECRET");
  expect(messageModelText("SECRET", html).text).not.toContain("SECRET");
  expect(visibleHtmlText(sanitizeReaderHtml(html)).text).not.toContain("SECRET");
};
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
  effectsHidden(`<p style="${css}">SECRET</p>`);
  effectsHidden(`<style>.x{${css}}</style><p class="x">SECRET</p>`);
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
  effectsHidden(`<div style="${parent}"><p style="${child}">SECRET</p></div>`),
);

it("unparseable foreground cannot establish contrast on a known background", () => {
  expect(
    visibleHtmlText('<p style="color:oklch(50% 0 0);background-color:white">SECRET</p>').text,
  ).toBe("");
});

it("CSS opacity is clamped before multiplying through descendants", () =>
  effectsHidden(
    '<div style="opacity:2"><div style="opacity:.3"><p style="opacity:.3">SECRET</p></div></div>',
  ));
