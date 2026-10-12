import { afterEach, assert, beforeEach, describe, it, vi } from "@effect/vitest";
import {
  imagesAllowed,
  imageSenderKey,
  markReadAfter,
  orderThread,
  remoteImageMode,
  shouldLoadRemote,
  splitRawMessage,
} from "./reading.js";
import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { DomUtils, parseDocument } from "htmlparser2";
import { sanitizeReaderHtml, sanitizeReaderCss } from "./reader-sanitize.js";
import { stripMobileForms } from "./platform/react-native/reader-html.js";
import { visibleHtmlText } from "./visible-text.js";
import { htmlToText } from "./mime.js";
import { stripActiveContent } from "./print.js";
import { prepareMessageHtml } from "./reader-html.js";
{
  describe("markReadAfter", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("marks right away at 0 and never when manual", () => {
      const marked: string[] = [];
      markReadAfter(0, () => marked.push("now"));
      markReadAfter("manual", () => marked.push("manual"));
      vi.advanceTimersByTime(60_000);
      assert.deepStrictEqual(marked, ["now"]);
    });

    it("waits the delay, and moving on before it cancels", () => {
      const marked: string[] = [];
      markReadAfter(3, () => marked.push("a"));
      const cancel = markReadAfter(3, () => marked.push("b"));
      vi.advanceTimersByTime(2_999);
      assert.deepStrictEqual(marked, []);
      cancel();
      vi.advanceTimersByTime(1);
      assert.deepStrictEqual(marked, ["a"]);
    });
  });

  describe("shouldLoadRemote", () => {
    const signed = {
      from: { address: "Friend@Example.org" },
      security: { dmarc: "pass" as const },
    };
    const forged = {
      from: { address: "friend@example.org" },
      security: { dmarc: "fail" as const },
    };
    const unchecked = { from: { address: "friend@example.org" } };
    const prefs = { remoteImages: "ask" as const, imageSenders: [], knownSender: false };

    it("asks in ask mode, even for known senders", () => {
      assert.isFalse(shouldLoadRemote(signed, { ...prefs, knownSender: true }));
    });

    it("loads for authenticated known senders only", () => {
      const known = { ...prefs, remoteImages: "known" as const, knownSender: true };
      assert.isTrue(shouldLoadRemote(signed, known));
      assert.isFalse(shouldLoadRemote(forged, known));
      assert.isFalse(shouldLoadRemote(unchecked, known));
      assert.isFalse(shouldLoadRemote(signed, { ...known, knownSender: false }));
    });

    it("loads for an authenticated allowlist entry in any mode", () => {
      const listed = { ...prefs, imageSenders: ["example.org"] };
      assert.isTrue(shouldLoadRemote(signed, listed));
      assert.isFalse(shouldLoadRemote(forged, listed));
    });

    it("fails closed while prefs load and lets mobile keep asking until a mode is picked", () => {
      assert.strictEqual(remoteImageMode(null), "ask");
      const unset = { remoteImages: "always" as const, remoteImagesChosen: false };
      assert.strictEqual(remoteImageMode(unset), "always");
      assert.strictEqual(remoteImageMode(unset, "ask"), "ask");
      const picked = { remoteImages: "always" as const, remoteImagesChosen: true };
      assert.strictEqual(remoteImageMode(picked, "ask"), "always");
    });

    it("always loads when set to always", () => {
      assert.isTrue(shouldLoadRemote(forged, { ...prefs, remoteImages: "always" }));
    });
  });

  describe("imagesAllowed", () => {
    const list = ["news@shop.com", "example.org", "@Brand.CO"];

    it("matches whole addresses exactly", () => {
      assert.isTrue(imagesAllowed("News@Shop.com", list));
      assert.isFalse(imagesAllowed("other@shop.com", list));
    });

    it("matches a domain and its subdomains, not look-alikes", () => {
      assert.isTrue(imagesAllowed("a@example.org", list));
      assert.isTrue(imagesAllowed("a@mail.example.org", list));
      assert.isTrue(imagesAllowed("a@brand.co", list));
      assert.isFalse(imagesAllowed("a@badexample.org", list));
      assert.isFalse(imagesAllowed("", list));
    });

    it("normalizes entries", () => {
      assert.strictEqual(imageSenderKey("  @Shop.COM "), "shop.com");
      assert.strictEqual(imageSenderKey("News@Shop.com"), "news@shop.com");
    });
  });

  describe("orderThread", () => {
    it("sorts oldest or newest first without changing the input", () => {
      const input = [{ date: 2 }, { date: 1 }, { date: 3 }];
      assert.deepStrictEqual(
        orderThread(input, "oldest").map((m) => m.date),
        [1, 2, 3],
      );
      assert.deepStrictEqual(
        orderThread(input, "newest").map((m) => m.date),
        [3, 2, 1],
      );
      assert.deepStrictEqual(
        input.map((m) => m.date),
        [2, 1, 3],
      );
    });
  });

  describe("splitRawMessage", () => {
    it("splits at the first empty line, CRLF or LF", () => {
      assert.deepStrictEqual(
        splitRawMessage("Subject: a\r\n b\r\nFrom: x\r\n\r\nbody\r\n\r\nmore"),
        {
          headers: "Subject: a\r\n b\r\nFrom: x",
          body: "body\r\n\r\nmore",
        },
      );
      assert.deepStrictEqual(splitRawMessage("Subject: a\n\nbody"), {
        headers: "Subject: a",
        body: "body",
      });
      assert.deepStrictEqual(splitRawMessage("Subject: only"), {
        headers: "Subject: only",
        body: "",
      });
    });
  });
}

{
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

  it("the reader turns viewport-height units into px; other callers keep them", () => {
    const html =
      "<style>body{min-height:100vh} .a{height:calc(110dvh - 2svh)} @media (max-height:50lvh){p{margin:1vmin}}</style>" +
      '<div style="height:100VH;width:50vw;max-height:12.5vmax">x</div><body style="padding:1vb">y</body>';
    const fixed = sanitizeReaderHtml(html, false, undefined, [], 800);
    for (const value of [
      "min-height:800px",
      "calc(880px - 16px)",
      "@media (not (width>=0px))",
      "margin:min(1vw,8px)",
      "height:800px",
      "max-height:max(12.5vw,100px)",
      "padding:8px",
    ])
      expect(fixed).toContain(value);
    // Width units follow the frame's width, which the frame's height never changes.
    expect(fixed).toContain("width:50vw");
    expect(fixed).not.toMatch(/\d(?:[sld]?v(?:h|b|min|max))\b/i);
    expect(sanitizeReaderHtml(html)).toContain("min-height:100vh");
    expect(sanitizeReaderCss("height:100vh", false, true)).toBe("height:100vh");
  });

  it("the reader reads vmin and vmax as the smaller or larger of the width and its height", () => {
    const fixed = (css: string) => sanitizeReaderCss(css, false, true, 800);
    expect(fixed("width:50vmin")).toBe("width:min(50vw,400px)");
    expect(fixed("height:10VMAX")).toBe("height:max(10vw,80px)");
    expect(fixed("margin:calc(2svmin + 1px) 3dvmax")).toBe(
      "margin:calc(min(2svw,16px) + 1px) max(3dvw,24px)",
    );
    expect(sanitizeReaderCss("width:50vmin", false, true)).toBe("width:50vmin");
    // A media feature has no slot for min()/max(); the rest of the sheet must survive.
    const media = sanitizeReaderCss(
      "@media (min-width:50vmin){a{color:red}} @media (width > 50vmax){i{color:green}} b{color:blue}",
      false,
      false,
      800,
    );
    expect(media).toContain("b{color:blue}");
    expect(media).toContain("a{color:red}");
    expect(media).not.toMatch(/vm(?:in|ax)/i);
  });

  it("the reader evaluates height media queries at its viewport height; width ones stay live", () => {
    const media = (query: string) =>
      sanitizeReaderCss(`@media ${query}{p{color:red}}`, false, false, 800).replace(/\{.*$/, "");
    const always = "@media (width>=0px)";
    const never = "@media (not (width>=0px))";
    expect(media("(min-height:100px)")).toBe(always);
    expect(media("(max-height:100px)")).toBe(never);
    expect(media("(height:800px)")).toBe(always);
    expect(media("(height)")).toBe(always);
    expect(media("(min-height:50em)")).toBe(always);
    expect(media("(max-height:50vh)")).toBe(never);
    expect(media("(min-device-height:900px)")).toBe(never);
    // Range syntax, either way round, and with two bounds.
    expect(media("(height >= 100px)")).toBe(always);
    expect(media("(900px < height)")).toBe(never);
    expect(media("(100px < height <= 800px)")).toBe(always);
    // Heights that need more than the viewport height count as false.
    expect(media("(min-height:10vw)")).toBe(never);
    expect(media("(min-height:calc(1px + 2px))")).toBe(never);
    // Combined with width features, which keep following the frame.
    expect(media("screen and (min-height:100px) and (max-width:600px)")).toBe(
      "@media screen and (width>=0px) and (max-width:600px)",
    );
    expect(media("not all and (max-height:100px), (min-width:300px)")).toBe(
      "@media not all and (not (width>=0px)),(min-width:300px)",
    );
    expect(media("(max-width:600px)")).toBe("@media (max-width:600px)");
    // Aspect ratio and orientation become the width they imply at 800 px tall.
    expect(media("(min-aspect-ratio:1/1)")).toBe("@media (width>=800px)");
    expect(media("(aspect-ratio:16/9)")).toBe("@media (width:1422.22px)");
    expect(media("(1/2 < aspect-ratio < 2)")).toBe("@media ((width>400px) and (width<1600px))");
    expect(media("(max-device-aspect-ratio:1.5)")).toBe("@media (device-width<=1200px)");
    expect(media("(orientation:portrait)")).toBe("@media (width<=800px)");
    expect(media("(orientation:landscape)")).toBe("@media (width>800px)");
    // Nested in other rules and in a style element's media attribute.
    expect(
      sanitizeReaderCss(
        "@supports (display:grid){@media (min-height:1px){p{color:red}}}",
        false,
        false,
        800,
      ),
    ).toContain("@media (width>=0px)");
    expect(
      sanitizeReaderHtml(
        '<style media="(max-height:100px)">p{color:red}</style>',
        false,
        undefined,
        [],
        800,
      ),
    ).toContain('media="(not (width&gt;=0px))"');
    // Other callers keep the live query.
    expect(sanitizeReaderCss("@media (min-height:100px){p{color:red}}", false)).toContain(
      "(min-height:100px)",
    );
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

  it("repeated selectors share matching work and exclude the hidden final paragraph", () => {
    const css = "p{color:navy}".repeat(1300);
    const input = `<style>${css}</style>${"<p>Shipment reference</p>".repeat(2000)}<p hidden>Last searchable paragraph</p>`;
    const result = visibleHtmlText(input);
    expect(result).toMatchObject({ hidden: true });
    expect(result).not.toHaveProperty("flags");
    expect(result.text.split("\n")).toHaveLength(2000);
    expect(htmlToText(input)).not.toContain("Last searchable paragraph");
  });
}

{
  it("blocks prefetch links and tracker CSS imports and image-set strings", () => {
    const prepared = prepareMessageHtml(
      '<link rel="dns-prefetch" href="//evil.example"><link rel="preconnect" href="https://evil.example"><link rel="stylesheet" href="https://safe.example/style.css"><style>@import "https://www.google-analytics.com/tracker.css"; .a { background:image-set("https://www.google-analytics.com/a.png" 1x,"https://safe.example/b.png" 2x) }</style>',
    );
    expect(prepared.html).not.toContain("dns-prefetch");
    expect(prepared.html).not.toContain("preconnect");
    expect(prepared.html).toContain('rel="stylesheet"');
    expect(prepared.html).not.toContain("google-analytics.com");
    expect(prepared.trackers).toContain("Google Analytics");
    expect(prepared.hasRemote).toBe(true);
  });

  it("rewrites image-set URL strings with parentheses and ignores nested type strings", () => {
    const prepared = prepareMessageHtml(
      '<style>.a { background: image-set("https://google-analytics.com/a(1).png" 1x type("image/png"), "https://safe.example/b.png" 2x); }</style>',
    );
    expect(prepared.html).not.toContain("google-analytics.com");
    expect(prepared.html).toContain('type("image/png")');
  });
}
