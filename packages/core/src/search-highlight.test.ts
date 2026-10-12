import { describe, expect, it } from "vitest";
import { DomUtils, parseDocument } from "htmlparser2";
import { sanitizeReaderHtml } from "./reader-sanitize.js";
import { SEARCH_HIT_CLASS } from "./search-highlight.js";
import { searchHighlightTerms } from "./search-snippets.js";

const marks = (html: string) =>
  DomUtils.findAll((element) => element.name === "mark", parseDocument(html).children);
const terms = (search: string) => searchHighlightTerms({ search });

describe("reader search highlights", () => {
  it("marks words in text only, never in attributes, URLs or styles", () => {
    const html = sanitizeReaderHtml(
      `<style>.invoice{color:red}</style><p title="invoice">Your <b>Invoice</b> is ready.</p>
       <a href="https://example.com/invoice?x=1">Pay the invoice</a><img alt="invoice" src="data:,">`,
      false,
      undefined,
      terms("invoice"),
    );
    expect(marks(html).map((mark) => DomUtils.textContent(mark))).toEqual(["Invoice", "invoice"]);
    expect(html).toContain('title="invoice"');
    expect(html).toContain('href="https://example.com/invoice?x=1"');
    expect(html).toContain('alt="invoice"');
    expect(html).toContain(".invoice{color:red}");
    for (const mark of marks(html)) expect(mark.attribs).toEqual({ class: SEARCH_HIT_CLASS });
  });

  it("query text cannot inject markup", () => {
    for (const search of [
      '"<img src=x onerror=alert(1)>"',
      '"</mark><script>alert(1)</script>"',
      '"\\" onmouseover=\\"alert(1)"',
      "<svg/onload=alert(1)>",
    ]) {
      const html = sanitizeReaderHtml(
        `<p>&lt;img src=x onerror=alert(1)&gt; &lt;/mark&gt;&lt;script&gt;alert(1)&lt;/script&gt; " onmouseover="alert(1) &lt;svg/onload=alert(1)&gt;</p>`,
        false,
        undefined,
        terms(search),
      );
      const document = parseDocument(html);
      expect(marks(html).length).toBeGreaterThan(0);
      const elements = DomUtils.findAll(() => true, document.children);
      expect(elements.map((element) => element.name).toSorted()).toEqual([
        ...marks(html).map(() => "mark"),
        "p",
      ]);
      for (const element of elements)
        expect(Object.keys(element.attribs).filter((name) => name !== "class")).toEqual([]);
      expect(html).not.toMatch(/<(img|script|svg)/i);
    }
  });

  it("a sender cannot add fake hits with the reserved class", () => {
    const html = sanitizeReaderHtml(
      `<mark class="openmail-search-hit">fake</mark><span class="x openmail-search-hit">also</span><p>real</p>`,
      false,
      undefined,
      terms("real"),
    );
    expect(
      DomUtils.findAll(
        (element) => element.attribs.class?.split(" ").includes(SEARCH_HIT_CLASS) ?? false,
        parseDocument(html).children,
      ).map((element) => DomUtils.textContent(element)),
    ).toEqual(["real"]);
    expect(html).toContain('class="x"');
  });

  it("marks hoisted body text and falls back to literal text for partial words", () => {
    const html = sanitizeReaderHtml(
      "<html><body><p>Invoices attached</p></body></html>",
      false,
      undefined,
      terms("invoice"),
    );
    expect(marks(html).map((mark) => DomUtils.textContent(mark))).toEqual(["Invoice"]);
    expect(sanitizeReaderHtml("<p>text</p>", false, undefined, [])).toBe("<p>text</p>");
  });
});

describe("plain-text search hits", () => {
  it("use word ranges first and literal text only when no word matches", async () => {
    const { plainSearchHits } = await import("./search-highlight.js");
    const text = "Invoices and the invoice";
    expect(
      plainSearchHits(text, ["invoice"]).map(({ start, end }) => text.slice(start, end)),
    ).toEqual(["invoice"]);
    expect(
      plainSearchHits("Invoices due", ["invoice"]).map(({ start, end }) =>
        "Invoices due".slice(start, end),
      ),
    ).toEqual(["Invoice"]);
    expect(plainSearchHits("other", ["th"])).toEqual([]);
  });
});
