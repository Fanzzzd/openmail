import { createElement } from "react";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { SearchMatch } from "@openmail/core/schema";
import { expect, it } from "vitest";
import { distinctAttachmentMatches, SearchSnippet } from "./components/SearchSnippet";
import { testDom } from "./test-dom";

const context = "ITINERARY AIRLINE PNR: E64KZJ GDS PNR: ";
const hit = (attachmentIndex: number | null, attachmentName = "ticket.pdf"): SearchMatch => ({
  source: "attachment",
  messageId: "outlook:me/m",
  attachmentIndex,
  attachmentName,
  snippet: `${context}SKUCEQ GU/HANGQI`,
  highlights: [{ start: context.length, end: context.length + 6 }],
});

function renderSnippet(match: SearchMatch, lead?: number) {
  const dom = testDom();
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  dom.render(createElement(I18nProvider, { i18n }, createElement(SearchSnippet, { match, lead })));
  return dom;
}

it("keeps the mark near the start of a one-line row", () => {
  const dom = renderSnippet(hit(0), 12);
  try {
    expect(dom.element.textContent).toBe("In attachment ticket.pdf:…GDS PNR: SKUCEQ GU/HANGQI");
    expect(dom.element.querySelector("mark")?.textContent).toBe("SKUCEQ");
  } finally {
    dom.dispose();
  }
});

it("cuts unspaced text between characters", () => {
  const snippet = `${"预定编码".repeat(6)}SKUCEQ`;
  const dom = renderSnippet({ ...hit(0), snippet, highlights: [{ start: 24, end: 30 }] }, 4);
  try {
    expect(dom.element.textContent).toBe("In attachment ticket.pdf:…预定编码SKUCEQ");
    expect(dom.element.querySelector("mark")?.textContent).toBe("SKUCEQ");
  } finally {
    dom.dispose();
  }
});

it("shows the whole snippet without a lead limit", () => {
  const dom = renderSnippet(hit(0));
  try {
    expect(dom.element.textContent).toContain(context);
    expect(dom.element.querySelector("mark")?.textContent).toBe("SKUCEQ");
  } finally {
    dom.dispose();
  }
});

it("lists the same attachment text once per thread row", () => {
  const forwarded = { ...hit(0), messageId: "outlook:me/forwarded" };
  const other = { ...hit(1, "copy.pdf"), messageId: "outlook:me/forwarded" };
  expect(distinctAttachmentMatches([hit(0), forwarded, other])).toEqual([hit(0), other]);
});
