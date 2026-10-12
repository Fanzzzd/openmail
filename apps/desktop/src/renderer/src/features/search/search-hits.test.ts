// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement, useEffect } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { constVoid } from "effect/Function";
import { searchHighlightTerms } from "@openmail/core/schema";
import { EmailFrame } from "../reader/frame/EmailFrame";
import {
  markPlainSearchHits,
  presentSearchHits,
  SearchHitsContext,
  useSearchHits,
} from "./search-hits";

vi.mock("../../state/mail", () => ({ useRunMail: () => constVoid, withMail: constVoid }));

afterEach(cleanup);

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

it("marks search words in the sandboxed body without scripts or attribute changes", () => {
  const { frame, doc } = frameFor(
    `<p>Your <b>invoice</b> &lt;img src=x onerror=alert(1)&gt;</p>
     <a href="https://example.com/invoice" title="invoice">Pay invoice</a>
     <mark class="openmail-search-hit">fake</mark>`,
    '"<img src=x onerror=alert(1)>" invoice',
  );
  expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
  expect(frame.srcdoc).not.toMatch(/<script|<img[^>]*onerror/i);
  const marks = [...doc.querySelectorAll("mark.openmail-search-hit")].map((m) => m.textContent);
  // The quoted query is one phrase hit; its text stays text.
  expect(marks).toEqual(["invoice", "img src=x onerror=alert(1", "invoice"]);
  expect(doc.querySelector("a")?.getAttribute("href")).toBe("https://example.com/invoice");
  expect(doc.querySelector("a")?.getAttribute("title")).toBe("invoice");
  expect(presentSearchHits(doc.body, 1)).toBe(3);
  const styled = [...doc.querySelectorAll<HTMLElement>("mark.openmail-search-hit")].map((mark) =>
    mark.style.getPropertyValue("background"),
  );
  expect(styled.filter((color) => color === "rgb(251, 146, 60)")).toHaveLength(1);
});

it("a plain-text body gets marks through text only and skips collapsed quotes", () => {
  const root = document.createElement("pre");
  root.textContent = "Invoice <script>alert('invoice')</script>";
  markPlainSearchHits(root, ["invoice"]);
  expect(root.querySelector("script")).toBeNull();
  expect([...root.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual([
    "Invoice",
    "invoice",
  ]);
  const quote = document.createElement("blockquote");
  quote.hidden = true;
  quote.append(root.querySelectorAll("mark")[1] ?? "");
  root.append(quote);
  expect(presentSearchHits(root, 0)).toBe(1);
});

it("a related result has no words, so the body has no marks", () => {
  const { doc } = frameFor("<p>Trip to Lisbon</p>", "");
  expect(doc.querySelector("mark")).toBeNull();
});

it("closing find or re-presenting the same hit does not scroll again", () => {
  const root = document.createElement("div");
  root.innerHTML =
    '<mark class="openmail-search-hit">a</mark><mark class="openmail-search-hit">b</mark>';
  document.body.append(root);
  const scrolls: string[] = [];
  // jsdom has no layout, so every mark would otherwise report itself invisible.
  for (const mark of root.querySelectorAll("mark")) {
    mark.checkVisibility = () => true;
    mark.scrollIntoView = () => scrolls.push(mark.textContent);
  }
  const Body = () => {
    const { present } = useSearchHits();
    // Every render presents again, as a quote toggle or find change does.
    useEffect(() => present(root));
    return null;
  };
  const view = (index: number) =>
    createElement(SearchHitsContext, { value: { terms: ["a"], index } }, createElement(Body));
  const { rerender } = render(view(0));
  rerender(view(0));
  rerender(view(-1));
  rerender(view(0));
  rerender(view(1));
  expect(scrolls).toEqual(["a", "b"]);
  expect(root.querySelector("mark")?.style.getPropertyValue("background")).not.toBe("");
});
