import { parseHTML } from "linkedom";
import { expect, it } from "vitest";
import { readerSelectedText, quoteChoice } from "./quote-selection";

it("quote preference asks only for a nonempty selection", () => {
  expect(quoteChoice("ask", "selected")).toBe("ask");
  expect(quoteChoice("always", "selected")).toBe("selection");
  expect(quoteChoice("never", "selected")).toBe("whole");
  for (const preference of ["ask", "always", "never"] as const) {
    expect(quoteChoice(preference, undefined)).toBe("whole");
    expect(quoteChoice(preference, " \n ")).toBe("whole");
  }
});

it("only the chosen reader message's iframe selection is quoted", () => {
  const { document } = parseHTML(
    '<div data-message-id="older"><iframe></iframe></div><div data-message-id="newer"><iframe></iframe></div>',
  );
  for (const [index, frame] of [...document.querySelectorAll("iframe")].entries())
    Object.defineProperty(frame, "contentDocument", {
      value: {
        hasFocus: () => true,
        getSelection: () => ({
          toString: () => (index === 0 ? "Older selection" : "Newer selection"),
        }),
      },
    });
  expect(readerSelectedText(document, "older")).toBe("Older selection");
  expect(readerSelectedText(document, "newer")).toBe("Newer selection");
  expect(readerSelectedText(document, "missing")).toBeUndefined();
});

it("plain reader selections are restricted to the chosen message", () => {
  const { document } = parseHTML(
    '<div data-message-id="one"><p>selected</p></div><div data-message-id="two"></div>',
  );
  Object.defineProperty(document, "getSelection", {
    value: () => ({
      rangeCount: 1,
      getRangeAt: () => ({ commonAncestorContainer: document.querySelector("p") }),
      toString: () => "selected",
    }),
  });
  expect(readerSelectedText(document, "one")).toBe("selected");
  expect(readerSelectedText(document, "two")).toBeUndefined();
});

it("a stale selection in an unfocused iframe does not replace a whole-message quote", () => {
  const { document } = parseHTML(
    '<div data-message-id="one"><iframe></iframe></div><button>Reply</button>',
  );
  const frame = document.querySelector("iframe");
  if (!frame) throw new Error("Missing frame");
  Object.defineProperty(frame, "contentDocument", {
    value: {
      hasFocus: () => false,
      getSelection: () => ({ toString: () => "Stale selection" }),
    },
  });
  Object.defineProperty(document, "getSelection", { value: () => null });
  Object.defineProperty(document, "activeElement", { value: document.querySelector("button") });
  expect(readerSelectedText(document, "one")).toBeUndefined();
});
