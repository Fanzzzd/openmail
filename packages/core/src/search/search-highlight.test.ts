import { describe, expect, it } from "vitest";
import { sanitizeReaderCss, sanitizeReaderHtml } from "../reader/reader-sanitize.js";
import { textSearchHits } from "./search-highlight.js";
import { searchHighlightTerms } from "./search-snippets.js";

const terms = (search: string) => searchHighlightTerms({ search });
const hitText = (texts: readonly string[], search: string) =>
  textSearchHits(texts, terms(search)).map(({ node, start, end }) => [
    node,
    texts[node]?.slice(start, end),
  ]);

describe("reader search hits", () => {
  it("finds words per text node, in document order", () => {
    expect(hitText(["Your ", "Invoice", " is ready. Pay the invoice"], "invoice")).toEqual([
      [1, "Invoice"],
      [2, "invoice"],
    ]);
    // Literal text only when no node has the word.
    expect(hitText(["Invoices ", "attached"], "invoice")).toEqual([[0, "Invoice"]]);
    expect(hitText(["Invoices and the invoice"], "invoice")).toEqual([[0, "invoice"]]);
    expect(textSearchHits(["text"], [])).toEqual([]);
  });

  it("stops at 500 hits", () => {
    expect(
      textSearchHits(
        Array.from({ length: 300 }, () => "a a"),
        ["a"],
      ),
    ).toHaveLength(500);
  });

  it("the sanitizer adds nothing to the mail for a search", () => {
    const html = `<style>.invoice{color:red}</style><p title="invoice">Your <b>Invoice</b> is ready.</p>`;
    expect(sanitizeReaderHtml(html)).not.toContain("<mark");
    expect(sanitizeReaderHtml(html)).not.toContain("openmail-search-hit");
  });
});

describe("relational selectors in mail CSS", () => {
  it("drops :has() selectors and keeps the rest of each rule", () => {
    const css = sanitizeReaderCss(
      `body:has(.openmail-search-hit){background:red}
       p, div:has(> mark){color:blue}
       :is(:has(span)) b{color:green}
       @media (min-width:1px){ td:HAS(img){color:red} td{padding:2px} }
       .x{color:black}`,
      true,
    );
    expect(css).not.toMatch(/has\(/i);
    expect(css).toContain("p{color:blue}");
    expect(css).toContain("td{padding:2px}");
    expect(css).toContain(".x{color:black}");
    expect(css).not.toContain("background:red");
    expect(css).not.toContain("color:green");
  });
});
