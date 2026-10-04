import { expect, it } from "vitest";
import { visibleHtmlText } from "./visible-text.js";
import { sanitizeReaderHtml } from "./reader-sanitize.js";

it.each([
  '<div style="background:#fff url(data:image/png;base64,iVBORw0KGgo=)"><span style="color:#000">SECRET</span></div>',
  '<table><tr><td background="data:image/png;base64,iVBORw0KGgo="><font color="#000">SECRET</font></td></tr></table>',
  '<span style="color:#000;-webkit-filter:invert(1)">SECRET</span>',
  '<div style="position:relative"><div style="position:absolute;inset:0;background:#fff"></div><span>SECRET</span></div>',
  '<div style="position:relative"><span>SECRET</span><img src="data:image/png;base64,iVBORw0KGgo=" style="position:absolute;top:0;left:0;width:100%;height:100%"></div>',
  '<p>SECRET</p><div style="position:relative;margin-top:-40px;height:40px;background:#fff"></div>',
  '<p>SECRET</p><div style="position:relative;transform:translateY(-40px);height:40px;background:#fff"></div>',
  '<div style="background:#2563eb"><a href="https://x.test">SECRET</a></div>',
  "<style>p::first-line{color:#fff}</style><p>SECRET</p>",
  '<div style="height:1px;outline:60px solid #fff"></div><p>SECRET</p>',
  '<p style="color:#000;box-shadow:inset 0 0 0 200px #000">SECRET</p>',
  '<p style="color:#000;backdrop-filter:invert(1)">SECRET</p>',
  '<mark style="color:#ff0">SECRET</mark>',
])("reader paint remains hidden: %s", (html) => {
  expect(visibleHtmlText(sanitizeReaderHtml(html)).text).toBe("");
});
it.each([
  '<a href="https://x.test">VISIBLE</a>',
  "<mark>VISIBLE</mark>",
  '<div style="position:relative"><span>VISIBLE</span><span style="position:absolute;left:0;top:0;width:12px;height:12px;background:red"></span></div>',
  '<div style="position:relative"><span style="position:absolute;left:0;top:0;width:12px;height:12px;background:red"></span><span>VISIBLE</span></div>',
])("contrasting reader content remains visible: %s", (html) => {
  expect(visibleHtmlText(sanitizeReaderHtml(html)).text).toBe("VISIBLE");
});

it.each(["data:image/png;base64,iVBORw0KGgo=", "cid:tile"])(
  "local background %s is unknown in CSS and legacy attributes",
  (url) => {
    for (const html of [
      `<div style="background-image:url(${url})">SECRET</div>`,
      `<style>.x{background:#fff url(${url})}</style><p class="x">SECRET</p>`,
      ...["table", "td", "th", "tr"].map((tag) =>
        tag === "table"
          ? `<table background="${url}"><tr><td>SECRET</td></tr></table>`
          : tag === "tr"
            ? `<table><tr background="${url}"><td>SECRET</td></tr></table>`
            : `<table><tr><${tag} background="${url}">SECRET</${tag}></tr></table>`,
      ),
      `<body background="${url}">SECRET</body>`,
    ])
      expect(visibleHtmlText(sanitizeReaderHtml(html)).text).toBe("");
  },
);
it.each(["-webkit-", "-moz-"])("vendor %s aliases use the standard cascade", (prefix) => {
  for (const css of [
    `${prefix}filter:invert(1)`,
    `${prefix}backdrop-filter:invert(1)`,
    `${prefix}mix-blend-mode:screen`,
    `${prefix}text-fill-color:transparent`,
    `${prefix}mask-image:linear-gradient(transparent,transparent)`,
    `${prefix}mask:linear-gradient(transparent,transparent)`,
  ])
    expect(visibleHtmlText(`<span style="${css}">SECRET</span>`).text).toBe("");
  expect(
    visibleHtmlText(`<span style="filter:none!important;${prefix}filter:invert(1)">VISIBLE</span>`)
      .text,
  ).toBe("VISIBLE");
  expect(
    visibleHtmlText(`<span style="${prefix}filter:invert(1)!important;filter:none">SECRET</span>`)
      .text,
  ).toBe("");
});
it.each(["first-line", "first-letter"])(
  "text pseudo %s is uncertain in both selector syntaxes",
  (name) => {
    for (const colons of [":", "::"])
      expect(
        visibleHtmlText(`<style>p${colons}${name}{color:#fff}</style><p>SECRET</p>`).text,
      ).toBe("");
    expect(visibleHtmlText(`<style>p:${name}{color:red}</style><p>SECRET</p>`).text).toBe("");
    expect(visibleHtmlText(`<style>p::${name}{font-size:0}</style><p>SECRET</p>`).text).toBe("");
  },
);
it.each([
  "position:relative;top:-1px",
  "position:sticky;left:1px",
  "transform:translateX(1px)",
  "margin-top:-10px",
  "outline:1px solid black",
  "box-shadow:1px 0 black",
  "box-shadow:0 0 0 1px black",
])("a same-colour sibling can hide in either DOM order: %s", (css) => {
  const paint = `<div style="${css};width:12px;height:12px;background:black"></div>`;
  const text = '<span style="color:black">SECRET</span>';
  for (const children of [paint + text, text + paint])
    expect(visibleHtmlText(`<div style="position:relative">${children}</div>`).text).toBe("");
});
it("a negative z-index painter contributes background colour rather than glyph coverage", () => {
  const painter = '<div style="position:absolute;inset:0;z-index:-1;background:white"></div>';
  expect(
    visibleHtmlText(
      `<div style="position:relative">${painter}<span style="color:black">VISIBLE</span></div>`,
    ).text,
  ).toBe("VISIBLE");
  expect(
    visibleHtmlText(
      `<div style="position:relative">${painter}<span style="color:white">SECRET</span></div>`,
    ).text,
  ).toBe("");
});
it("transparent or non-painting outlines and shadows cannot conceal siblings", () => {
  for (const css of [
    "background:transparent;position:absolute;width:12px;height:12px",
    "outline:0 solid black",
    "outline:12px none black",
    "box-shadow:none",
  ])
    expect(
      visibleHtmlText(
        `<div style="position:relative"><div style="${css}"></div><span>VISIBLE</span></div>`,
      ).text,
    ).toBe("VISIBLE");
  expect(
    visibleHtmlText(
      '<div style="position:relative"><div style="position:absolute;width:12px;height:12px;background:rgba(0,0,0,.2)"></div><span style="color:black">VISIBLE</span></div>',
    ).text,
  ).toBe("VISIBLE");
});
it("inset shadows on ancestors count at any spread", () => {
  for (const spread of [0, 1, 200])
    expect(
      visibleHtmlText(
        `<div style="box-shadow:inset 0 0 0 ${spread}px #000"><span style="color:black">SECRET</span></div>`,
      ).text,
    ).toBe("");
});
it("reader defaults participate in the mail cascade with stable specificity", () => {
  expect(
    visibleHtmlText(
      '<style>*{color:red}</style><div style="background:#2563eb"><a href="https://x.test">SECRET</a></div>',
    ).text,
  ).toBe("");
  expect(
    visibleHtmlText(
      '<style>a{color:red}</style><div style="background:#2563eb"><a href="https://x.test">VISIBLE</a></div>',
    ).text,
  ).toBe("VISIBLE");
  expect(
    visibleHtmlText("<style>*{color:red;background:white}</style><mark>VISIBLE</mark>").text,
  ).toBe("VISIBLE");
});

it("non-replaced unresolved paint without known coverage does not discard adjacent text", () => {
  const html =
    '<div style="position:relative"><span>SECRET</span><div style="position:absolute;background:var(--paper)"></div></div>';
  expect(visibleHtmlText(html).text).toBe("SECRET");
});

it("small margin hacks and decorative replaced elements do not become unknown painters", () => {
  for (const style of [
    "margin-top:-1px",
    "margin-top:-9px",
    "outline:2px solid black",
    "position:relative;top:-2px",
    "position:absolute;width:12px;height:12px",
  ])
    expect(
      visibleHtmlText(
        `<div style="position:relative"><img src="data:image/png;base64,iVBORw0KGgo=" style="${style}"><span>VISIBLE</span></div>`,
      ).text,
    ).toBe("VISIBLE");
  expect(
    visibleHtmlText(
      '<div style="position:relative"><div style="margin-top:-9px;background:black;width:12px;height:12px"></div><span style="color:black">VISIBLE</span></div>',
    ).text,
  ).toBe("VISIBLE");
});
it("declared half-block replaced elements require known dimensions on both axes", () => {
  const scope = (width: number, height: number) =>
    `<div style="position:relative;width:200px;height:100px"><img src="data:image/png;base64,iVBORw0KGgo=" style="position:absolute;width:${width}px;height:${height}px"><span>SECRET</span></div>`;
  expect(visibleHtmlText(scope(100, 50)).text).toBe("");
  expect(visibleHtmlText(scope(99, 50)).text).toBe("SECRET");
  expect(visibleHtmlText(scope(100, 49)).text).toBe("SECRET");
});
it("explicit opaque coverage stays local and preserves contrasting content outside it", () => {
  expect(
    visibleHtmlText(
      '<div style="position:relative"><div style="position:absolute;inset:0;background:white"></div><span>SECRET</span></div><p>VISIBLE</p>',
    ).text,
  ).toBe("VISIBLE");
  expect(
    visibleHtmlText(
      '<p>VISIBLE</p><p>SECRET</p><div style="margin-top:-40px;height:40px;background:white"></div><p>AFTER</p>',
    ).text,
  ).toBe("VISIBLE\nAFTER");
  expect(
    visibleHtmlText(
      '<div style="position:relative"><div style="position:absolute;inset:0;z-index:-1;background:white"></div><span>VISIBLE</span></div>',
    ).text,
  ).toBe("VISIBLE");
});
it("a thin or translucent outline does not act as proven opaque coverage", () => {
  for (const style of ["outline:2px solid white", "outline:60px solid rgba(255,255,255,.5)"])
    expect(visibleHtmlText(`<div style="height:1px;${style}"></div><p>VISIBLE</p>`).text).toBe(
      "VISIBLE",
    );
});

it.each([
  '<span>SECRET</span><span style="display:inline-block;margin-left:-200px;width:200px;height:24px;background:#fff"></span>',
  '<span>SECRET</span><img src="data:image/png;base64,iVBORw0KGgo=" width="200" height="24" style="margin-left:-200px">',
])("horizontal inline coverage hides confirmed payload: %s", (html) => {
  expect(visibleHtmlText(sanitizeReaderHtml(html)).text).toBe("");
});
it.each([
  "margin-left:-200px",
  "margin-right:-200px",
  "margin-inline-start:-200px",
  "margin-inline-end:-200px",
  "margin:0 -200px",
  "margin:0 0 0 -200px",
  "margin-inline:-200px 0",
])("horizontal margin %s covers only the preceding inline sibling", (margin) => {
  const previous = "<span>SECRET</span>";
  const after = "<span>AFTER</span>";
  for (const painter of [
    `<span style="display:inline-block;${margin};width:200px;height:24px;background:white"></span>`,
    `<img src="data:image/png;base64,iVBORw0KGgo=" width="200" height="24" style="${margin}">`,
  ])
    expect(visibleHtmlText(sanitizeReaderHtml(`${previous}${painter}${after}`)).text).toBe("AFTER");
});
it("horizontal coverage requires substantial reach, sufficient declared size and inline flow", () => {
  for (const html of [
    '<span>VISIBLE</span><span style="display:inline-block;margin-left:-9px;width:200px;height:24px;background:black"></span>',
    '<span>VISIBLE</span><img src="data:image/png;base64,iVBORw0KGgo=" width="200" height="24" style="margin-left:-9px">',
    '<span>VISIBLE</span><img src="data:image/png;base64,iVBORw0KGgo=" width="12" height="12" style="margin-left:-200px">',
    '<span>VISIBLE</span><span style="display:inline-block;margin-left:-200px;width:200px;height:24px;background:rgba(255,255,255,.5)"></span>',
    '<p>VISIBLE</p><img src="data:image/png;base64,iVBORw0KGgo=" width="200" height="24" style="margin-left:-200px">',
    '<span>VISIBLE</span><img src="data:image/png;base64,iVBORw0KGgo=" width="200" height="24" style="display:block;margin-left:-200px">',
  ])
    expect(visibleHtmlText(sanitizeReaderHtml(html)).text).toBe("VISIBLE");
});
it("margin longhands, shorthands and importance share cascade precedence", () => {
  for (const margin of [
    "margin:0 -200px;margin-left:0;margin-right:0",
    "margin-left:0!important;margin:0 0 0 -200px",
    "margin-left:-200px;margin:0!important",
    "margin-inline:-200px 0;margin-inline-start:0",
  ])
    expect(
      visibleHtmlText(
        `<span>VISIBLE</span><span style="display:inline-block;${margin};width:200px;height:24px;background:white"></span>`,
      ).text,
    ).toBe("VISIBLE");
  expect(
    visibleHtmlText(
      '<span>SECRET</span><span style="display:inline-block;margin:0!important;margin-left:-200px!important;width:200px;height:24px;background:white"></span>',
    ).text,
  ).toBe("");
});
