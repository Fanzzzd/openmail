import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { DomUtils, parseDocument } from "htmlparser2";
import { sanitizeReaderHtml, sanitizeReaderCss } from "./reader-sanitize.js";
import { stripMobileForms } from "./platform/react-native/reader-html.js";
import { visibleHtmlText, messageModelText } from "./visible-text.js";
import { htmlToText } from "./mime.js";
import { stripActiveContent } from "./print.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/reader/${name}.html`, import.meta.url), "utf8");
const element = (html: string, name: string) =>
  DomUtils.findAll((node) => node.name === name, parseDocument(html).children)[0];

it("Outlook/Word CDO and CDC wrappers do not change the first paragraph selector", () => {
  const clean = sanitizeReaderHtml(fixture("outlook-word"));
  const style = element(clean, "style");
  expect(style && DomUtils.textContent(style)).toMatch(/^\s*p\.MsoNormal\{/);
  expect(clean).toContain("font-family:Arial");
  expect(clean).not.toMatch(/\\3c|<!--|-->/);
  expect(element(clean, "a")?.attribs.href).toBe("https://reports.example.test/q3");
});

it("Mailchimp hero colours and newsletter text survive blocking background images", () => {
  const input = fixture("mailchimp-newsletter");
  for (const sanitize of [sanitizeReaderHtml, stripActiveContent]) {
    const clean = sanitize(input);
    const hero = DomUtils.findAll(
      (node) => node.attribs.class === "hero",
      parseDocument(clean).children,
    )[0];
    expect(hero?.attribs.style).toContain("background:#123456 none no-repeat center");
    expect(hero?.attribs.bgcolor).toBe("#123456");
    expect(hero?.attribs.nowrap).toBeDefined();
    expect(clean).toContain("Your October update");
    expect(clean).toContain("Manage your preferences at any time.");
    expect(clean).not.toContain("October member newsletter");
    expect(clean).not.toContain("images.example.test");
  }
});

it("presentational tags, fonts, maps, table and image spacing attributes survive", () => {
  const clean = sanitizeReaderHtml(fixture("presentational"));
  for (const name of [
    "main",
    "nav",
    "aside",
    "figure",
    "figcaption",
    "del",
    "ins",
    "small",
    "big",
    "tt",
    "kbd",
    "mark",
    "abbr",
    "cite",
    "q",
    "var",
    "samp",
    "dfn",
    "bdi",
    "bdo",
  ])
    expect(element(clean, name)).toBeDefined();
  expect(element(clean, "font")?.attribs).toMatchObject({
    face: "Georgia",
    size: "4",
    color: "#334455",
  });
  expect(element(clean, "img")?.attribs).toMatchObject({
    src: "data:image/jpeg;base64,AQID",
    hspace: "8",
    vspace: "4",
    usemap: "#navigation",
  });
  expect(element(clean, "map")?.attribs).toMatchObject({ name: "navigation", id: "navigation" });
  expect(element(clean, "area")?.attribs).toMatchObject({
    href: "https://news.example.test/",
    shape: "rect",
    coords: "0,0,80,80",
  });
  expect(element(clean, "table")?.attribs).toMatchObject({ rules: "rows", frame: "box" });
  expect(element(clean, "colgroup")?.attribs.span).toBe("2");
  expect(element(clean, "td")?.attribs).toMatchObject({ nowrap: "", colspan: "2", rowspan: "1" });
  expect(clean).not.toContain("fallback must not appear");
  expect(clean).toContain("Delivery is Friday.");
});

it("140-deep reply chains keep the original message in reader, mobile preparation, print and search", () => {
  const input = `${"<blockquote><p>Reply</p>".repeat(140)}<p>Original shipment reference 12345</p>${"</blockquote>".repeat(140)}`;
  for (const html of [
    sanitizeReaderHtml(input),
    stripMobileForms(input),
    stripActiveContent(input),
  ])
    expect(html).toContain("Original shipment reference 12345");
  expect(visibleHtmlText(input).text).toContain("Original shipment reference 12345");
  expect(htmlToText(input)).toContain("Original shipment reference 12345");
});

it("content beyond 512 levels is flattened instead of lost", () => {
  const input = `${"<div>".repeat(10_000)}<p>Deep reference</p><img src="https://evil.test/x" onerror="alert(1)">${"</div>".repeat(10_000)}`;
  for (const html of [
    sanitizeReaderHtml(input),
    stripMobileForms(input),
    stripActiveContent(input),
  ])
    expect(html).toContain("Deep reference");
  expect(sanitizeReaderHtml(input)).not.toContain("evil.test");
  expect(sanitizeReaderHtml(input)).not.toContain("onerror");
  expect(htmlToText(input)).toBe("Deep reference");
});

it("ASCII whitespace around links is trimmed while encoded dangerous schemes remain blocked", () => {
  expect(sanitizeReaderHtml('<a href="\n https://example.test/a \t">Open</a>')).toContain(
    'href="https://example.test/a"',
  );
  for (const scheme of ["java&#x09;script:alert(1)", "vbscript:alert(1)", "data:text/html,x"])
    expect(sanitizeReaderHtml(`<a href=" \n${scheme} ">Open</a>`)).toBe("<a>Open</a>");
});

it("blocked CSS Url tokens leave fallback colours, sizes and image position intact", () => {
  expect(
    sanitizeReaderCss(
      'background:#123456 url("https://evil.test/x") center/cover no-repeat',
      false,
      true,
    ),
  ).toBe("background:#123456 none center/cover no-repeat");
  expect(
    sanitizeReaderCss('background:#123456 url("https://example.test/x") center', true, true),
  ).toContain("url(https://example.test/x)");
});

it("raster data image aliases and formats are accepted while SVG stays excluded", () => {
  for (const [type, expected] of [
    ["jpg", "jpeg"],
    ["x-png", "png"],
    ["png", "png"],
    ["tiff", "tiff"],
    ["bmp", "bmp"],
    ["avif", "avif"],
    ["webp", "webp"],
    ["gif", "gif"],
    ["heic", "heic"],
    ["ico", "ico"],
    ["x-icon", "x-icon"],
  ])
    expect(sanitizeReaderHtml(`<img src="data:image/${type};base64,AQID">`)).toContain(
      `src="data:image/${expected};base64,AQID"`,
    );
  expect(sanitizeReaderHtml('<img src="data:image/svg+xml;base64,AQID">')).toBe("<img>");
});

it("non-matching and invalid selectors do not spend the matching-selector budget", () => {
  const css = Array.from({ length: 6000 }, (_, i) => `.unused${i}{display:none}`).join("");
  expect(visibleHtmlText(`<style>${css}</style><p>Searchable shipment reference</p>`)).toEqual({
    text: "Searchable shipment reference",
    hidden: false,
  });
});

it("budget exhaustion returns all text and an explicit flag instead of an empty body", () => {
  const css = ".message{display:none}".repeat(6000);
  const input = `<style>${css}</style><p class="message">Shipment reference</p><p>Last searchable paragraph</p>`;
  expect(visibleHtmlText(input)).toMatchObject({
    text: "Shipment reference\nLast searchable paragraph",
    hidden: false,
    flags: ["budget-exceeded"],
  });
  expect(htmlToText(input)).toBe("Shipment reference\nLast searchable paragraph");
  expect(messageModelText("", input).flags).toContain("budget-exceeded");
});

it("matching-budget exhaustion keeps the final paragraph for search indexing", () => {
  const css = "p{color:navy}".repeat(1300);
  const input = `<style>${css}</style>${"<p>Shipment reference</p>".repeat(2000)}<p hidden>Last searchable paragraph</p>`;
  const result = visibleHtmlText(input);
  expect(result).toMatchObject({ hidden: true, flags: ["budget-exceeded"] });
  expect(result.text.split("\n")).toHaveLength(2000);
  expect(htmlToText(input)).toContain("Last searchable paragraph");
});
