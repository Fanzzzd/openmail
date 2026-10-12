import { parseHTML } from "linkedom";
import { afterEach, expect, it, vi } from "vitest";
import {
  jumpDocumentSelection,
  jumpReaderSelection,
  jumpTextareaSelection,
} from "./jump-selection";

it("selection jump scrolls the chosen reader's selection without replacing it", () => {
  const { document } = parseHTML(
    '<div data-message-id="one"><p>Hello</p></div><div data-message-id="two"></div>',
  );
  const target = document.querySelector("p");
  if (!target?.firstChild) throw new Error("Missing selection");
  const scroll = vi.fn();
  Object.assign(target, { scrollIntoView: scroll });
  Object.defineProperty(document, "getSelection", {
    value: () => ({ rangeCount: 1, getRangeAt: () => ({ startContainer: target.firstChild }) }),
  });
  expect(jumpReaderSelection(document, "two")).toBe(false);
  expect(scroll).not.toHaveBeenCalled();
  expect(jumpReaderSelection(document, "one")).toBe(true);
  expect(scroll).toHaveBeenCalledWith({ block: "center", inline: "nearest" });
  expect(jumpDocumentSelection(document)).toBe(true);
});

it("a focused scriptless frame owns selection jump; empty or unfocused selections are ignored", () => {
  const { document } = parseHTML('<div data-message-id="one"><iframe></iframe></div>');
  const { document: content } = parseHTML("<p>Selected</p>");
  const frame = document.querySelector("iframe");
  const target = content.querySelector("p");
  if (!frame || !target?.firstChild) throw new Error("Missing frame fixture");
  const scroll = vi.fn();
  Object.assign(target, { scrollIntoView: scroll });
  let focused = true;
  Object.defineProperty(content, "hasFocus", { value: () => focused });
  Object.defineProperty(content, "getSelection", {
    value: () => ({ rangeCount: 1, getRangeAt: () => ({ startContainer: target.firstChild }) }),
  });
  Object.defineProperty(frame, "contentDocument", { value: content });
  Object.defineProperty(document, "getSelection", { value: () => null });
  expect(jumpReaderSelection(document, "one")).toBe(true);
  focused = false;
  expect(jumpReaderSelection(document, "one")).toBe(false);
  expect(scroll).toHaveBeenCalledOnce();
  expect(jumpDocumentSelection(document)).toBe(false);
});

afterEach(() => vi.unstubAllGlobals());
it("plain/Markdown selection jump measures wrapped text, retains the range and removes the mirror", () => {
  const { document, window } = parseHTML("<html><body><textarea></textarea></body></html>");
  const textarea = document.querySelector("textarea");
  if (!textarea) throw new Error("Missing textarea");
  Object.assign(textarea, {
    value: "one\ntwo\nthree",
    selectionStart: 8,
    selectionEnd: 13,
    focus: vi.fn(),
  });
  Object.defineProperties(textarea, { clientWidth: { value: 300 }, clientHeight: { value: 100 } });
  const create = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((name, options) => {
    const element = create(name, options);
    if (name === "span") Object.defineProperty(element, "offsetTop", { value: 250 });
    return element;
  });
  vi.stubGlobal("window", window);
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "14px" }));
  jumpTextareaSelection(textarea);
  expect(textarea.scrollTop).toBe(200);
  expect(textarea.selectionStart).toBe(8);
  expect(textarea.selectionEnd).toBe(13);
  expect(document.body.childElementCount).toBe(1);
});
