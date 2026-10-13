// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { normalizeQuote } from "@openmail/core/schema";
import { highlightBody, presentBody, repeatedQuoteElements } from "./body-text";

function body(html: string) {
  document.body.innerHTML = html;
  return document.body;
}

/** jsdom has no CSS Custom Highlight API; this registry records what was painted. */
const registry = new Map<string, Set<Range>>();
Object.assign(window, { Highlight: class extends Set<Range> {} });
Object.defineProperty(window, "CSS", { value: { highlights: registry }, configurable: true });
const painted = (name: string) => [...(registry.get(name) ?? [])].map(String);
afterEach(() => registry.clear());

it("finds across inline elements and navigates whole matches without touching the DOM", () => {
  const root = body(
    '<p>A hello <b>world</b> and HELLO <a href="https://example.com">WORLD</a>.</p>',
  );
  const original = root.innerHTML;
  const found = highlightBody(root, "hello world");
  expect(found.count).toBe(2);
  expect(found.ranges.map(String)).toEqual(["hello world", "HELLO WORLD"]);
  expect(painted("openmail-find-hit")).toEqual(["hello world", "HELLO WORLD"]);
  found.select(1);
  expect(painted("openmail-find-active")).toEqual(["HELLO WORLD"]);
  found.select(0);
  expect(painted("openmail-find-active")).toEqual(["hello world"]);
  // No element, class or attribute was added for the find.
  expect(root.innerHTML).toBe(original);
  found.dispose();
  expect(painted("openmail-find-hit")).toEqual([]);
  expect(painted("openmail-find-active")).toEqual([]);
  const again = highlightBody(root, "world");
  expect(again.count).toBe(2);
  again.dispose();
  expect(root.innerHTML).toBe(original);
});

it("literal, Unicode and plain-text matches exclude hidden content, fields, scripts and styles", () => {
  const root = body(
    "<p>a+b 中文 İ test</p><script>a+b</script><style>a+b</style><div hidden>a+b</div><textarea>a+b</textarea><p>a+b</p>",
  );
  const found = highlightBody(root, "a+b");
  expect(found.count).toBe(2);
  found.dispose();
  const unicode = highlightBody(root, "test");
  expect(unicode.count).toBe(1);
  expect(unicode.ranges.map(String)).toEqual(["test"]);
  unicode.dispose();
  const empty = highlightBody(root, "");
  expect(empty.count).toBe(0);
  empty.dispose();
});

it("does not join unrelated paragraphs or match attribute values", () => {
  const root = body('<p title="hello world">hello </p><p>world</p>');
  const found = highlightBody(root, "hello world");
  expect(found.count).toBe(0);
  found.dispose();
});

it("collapses repeated HTML quotes once, preserving novel quotations and original DOM", () => {
  const old = "The original message has enough text to compare.";
  const root = body(
    `<p>New response</p><div class="gmail_quote"><blockquote>${old}</blockquote></div><blockquote>New unique quote that must stay visible.</blockquote>`,
  );
  const quotes = repeatedQuoteElements(root, { bodies: [normalizeQuote(old)], before: 1 });
  expect(quotes).toHaveLength(1);
  expect(quotes[0]?.className).toBe("gmail_quote");
  expect(root.textContent).toContain("New unique quote");
  expect(repeatedQuoteElements(root, { bodies: [], before: 0 })).toEqual([]);
});

it("quote toggles and searching restore sender styles and keep original hidden content hidden", async () => {
  const old = "The original message has enough text to compare.";
  const root = body(
    `<p>New response</p><blockquote style="color:blue">${old}</blockquote><blockquote hidden>${old}</blockquote>`,
  );
  const original = root.innerHTML;
  const collapsed = presentBody(
    root,
    repeatedQuoteElements(root, { bodies: [normalizeQuote(old)], before: 1 }),
    false,
    "",
  );
  expect(collapsed.hasQuotes).toBe(true);
  expect(root.querySelector("blockquote")?.hasAttribute("hidden")).toBe(true);
  collapsed.dispose();
  expect(root.innerHTML).toBe(original);
  const expanded = presentBody(
    root,
    repeatedQuoteElements(root, { bodies: [normalizeQuote(old)], before: 1 }),
    true,
    "",
  );
  expect(root.querySelector("blockquote")?.hasAttribute("hidden")).toBe(false);
  expanded.dispose();
  const searched = presentBody(
    root,
    repeatedQuoteElements(root, { bodies: [normalizeQuote(old)], before: 1 }),
    false,
    "original message",
  );
  expect(searched.count).toBe(1);
  searched.dispose();
  expect(root.innerHTML).toBe(original);
});

it("recognizes Outlook's repeated tail without hiding a new response after the separator", () => {
  const old = "The original message has enough text to compare.";
  const root = body(`<p>Reply</p><div id="divRplyFwdMsg">From: Alice</div><div>${old}</div>`);
  expect(repeatedQuoteElements(root, { bodies: [normalizeQuote(old)], before: 1 })).toHaveLength(2);
  root.append(root.ownerDocument.createElement("p"));
  const last = root.lastElementChild;
  if (last) last.textContent = "Another new comment";
  const quotes = repeatedQuoteElements(root, { bodies: [normalizeQuote(old)], before: 1 });
  expect(quotes).toHaveLength(1);
  expect(quotes[0]?.textContent).toBe(old);
});

it("malformed sender CSS cannot swallow the collapse property; show restores the exact style", () => {
  const old = "The original message has enough text to compare.";
  for (const style of [
    "color:red; /*",
    'font-family: "unterminated',
    "background-image:url(",
    "display:block!important",
  ]) {
    const root = body(
      `<style>[hidden]{display:block!important}</style><blockquote>${old}</blockquote>`,
    );
    const quote = root.querySelector("blockquote");
    if (!quote) throw new Error("Missing quote");
    quote.setAttribute("style", style);
    const original = root.innerHTML;
    const collapsed = presentBody(
      root,
      repeatedQuoteElements(root, { bodies: [normalizeQuote(old)], before: 1 }),
      false,
      "",
    );
    expect(quote.style.getPropertyValue("display")).toBe("none");
    collapsed.dispose();
    expect(root.innerHTML).toBe(original);
    expect(quote.getAttribute("style")).toBe(style);
  }
});

it("deep repeated quote nesting checks the top container once instead of rechecking ancestors", () => {
  const old = "The original message has enough text to compare.";
  const root = body(`${"<blockquote>".repeat(200)}${old}${"</blockquote>".repeat(200)}`);
  let reads = 0;
  for (const quote of root.querySelectorAll("blockquote")) {
    Object.defineProperty(quote, "textContent", {
      get: () => {
        reads++;
        return old;
      },
    });
  }
  expect(repeatedQuoteElements(root, { bodies: [normalizeQuote(old)], before: 1 })).toHaveLength(1);
  expect(reads).toBe(1);
});
