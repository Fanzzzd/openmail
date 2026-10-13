// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement, useEffect } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { constVoid } from "effect/Function";
import { searchHighlightTerms } from "@openmail/core/schema";
import { EmailFrame } from "../reader/frame/EmailFrame";
import { presentSearchHits, SearchHitsContext, useSearchHits } from "./search-hits";

vi.mock("../../state/mail", () => ({ useRunMail: () => constVoid, withMail: constVoid }));
const scrolls: string[] = [];
vi.mock(import("./text-highlights"), async (original) => ({
  ...(await original()),
  // jsdom has no layout; record which hit would be scrolled to.
  scrollRangeIntoView: (range: Range) => {
    scrolls.push(String(range));
  },
}));

/** jsdom has no CSS Custom Highlight API; this registry records what was painted. */
const installHighlights = (view: Window & typeof globalThis) => {
  const registry = new Map<string, Set<Range>>();
  Object.assign(view, { Highlight: class extends Set<Range> {} });
  Object.defineProperty(view, "CSS", { value: { highlights: registry }, configurable: true });
  // jsdom has no layout, so every element would otherwise report itself invisible.
  view.Element.prototype.checkVisibility = () => true;
  return (name: string) => [...(registry.get(name) ?? [])].map(String);
};

afterEach(() => {
  cleanup();
  scrolls.length = 0;
});

const frameFor = (html: string, search: string) => {
  render(
    createElement(
      I18nProvider,
      { i18n: setupI18n({ locale: "en", messages: {} }) },
      createElement(
        SearchHitsContext,
        { value: { terms: searchHighlightTerms({ search }), index: 0 } },
        createElement(EmailFrame, {
          html,
          remote: false,
          background: "light",
          zoom: 100,
          onActivate: constVoid,
          previous: { bodies: [], before: 0 },
          findQuery: "",
          findIndex: 0,
          onMatches: undefined,
        }),
      ),
    ),
  );
  const frame = screen.getByTitle("Message");
  if (!(frame instanceof HTMLIFrameElement) || !frame.contentDocument)
    throw new Error("Missing message frame");
  // jsdom does not load srcdoc; write the component's page into its frame document.
  frame.contentDocument.open();
  frame.contentDocument.write(frame.srcdoc);
  frame.contentDocument.close();
  return { frame, doc: frame.contentDocument };
};

it("highlights search words in the sandboxed body and adds nothing to its DOM", () => {
  const { frame, doc } = frameFor(
    `<p>Your <b>invoice</b> &lt;img src=x onerror=alert(1)&gt;</p>
     <a href="https://example.com/invoice" title="invoice">Pay invoice</a>
     <mark class="openmail-search-hit">fake</mark>`,
    '"<img src=x onerror=alert(1)>" invoice',
  );
  const view = doc.defaultView;
  if (!view) throw new Error("Missing frame window");
  const painted = installHighlights(view);
  expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
  expect(frame.srcdoc).not.toMatch(/<script|<img[^>]*onerror/i);
  // The srcdoc carries the mail as sent: no marks or classes for the search.
  expect(frame.srcdoc.match(/<mark/g)).toHaveLength(1);
  const before = doc.body.innerHTML;
  const hits = presentSearchHits(
    doc.body,
    searchHighlightTerms({ search: '"<img src=x onerror=alert(1)>" invoice' }),
    1,
  );
  // The quoted query is one phrase hit; the sender's own mark is not a hit.
  expect(hits.count).toBe(3);
  expect(painted("openmail-search-hit")).toEqual(["invoice", "invoice"]);
  expect(painted("openmail-search-active")).toEqual(["img src=x onerror=alert(1"]);
  expect(scrolls).toEqual(["img src=x onerror=alert(1"]);
  expect(doc.body.innerHTML).toBe(before);
  hits.dispose();
  expect(painted("openmail-search-hit")).toEqual([]);
  expect(painted("openmail-search-active")).toEqual([]);
});

it("a plain-text body is highlighted without new nodes and skips collapsed quotes", () => {
  const painted = installHighlights(window);
  const root = document.createElement("pre");
  root.textContent = "Invoice <script>alert('invoice')</script>";
  const quote = document.createElement("blockquote");
  quote.hidden = true;
  quote.textContent = "invoice";
  root.append(quote);
  const before = root.innerHTML;
  const hits = presentSearchHits(root, ["invoice"], 0);
  expect(root.querySelector("script")).toBeNull();
  expect(root.innerHTML).toBe(before);
  expect(hits.count).toBe(2);
  expect(painted("openmail-search-active")).toEqual(["Invoice"]);
  expect(painted("openmail-search-hit")).toEqual(["invoice"]);
  hits.dispose();
});

it("a related result has no words, so the body has no highlights", () => {
  const { doc } = frameFor("<p>Trip to Lisbon</p>", "");
  const view = doc.defaultView;
  if (!view) throw new Error("Missing frame window");
  const painted = installHighlights(view);
  expect(presentSearchHits(doc.body, [], 0).count).toBe(0);
  expect(painted("openmail-search-hit")).toEqual([]);
  expect(doc.querySelector("mark")).toBeNull();
});

it("closing find or re-presenting the same hit does not scroll again", () => {
  const painted = installHighlights(window);
  const root = document.createElement("div");
  root.innerHTML = "<p>a</p><p>b</p>";
  document.body.append(root);
  const Body = () => {
    const { present } = useSearchHits();
    // Every render presents again, as a quote toggle or find change does.
    useEffect(() => present(root));
    return null;
  };
  const view = (index: number) =>
    createElement(SearchHitsContext, { value: { terms: ["a", "b"], index } }, createElement(Body));
  const { rerender } = render(view(0));
  rerender(view(0));
  rerender(view(-1));
  rerender(view(0));
  rerender(view(1));
  expect(scrolls).toEqual(["a", "b"]);
  expect(painted("openmail-search-active")).toEqual(["b"]);
  expect(painted("openmail-search-hit")).toEqual(["a"]);
});
