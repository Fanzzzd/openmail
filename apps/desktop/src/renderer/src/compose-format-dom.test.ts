import { parseHTML } from "linkedom";
import { afterEach, expect, it, vi } from "vitest";
import { composeReplacement, richComposeBody } from "@openmail/core/schema";
import { formatEditor, styleEditor, replaceMarkdownEditor } from "./compose-format-dom";
import type { FormatAction } from "./compose-format-dom";

afterEach(() => vi.unstubAllGlobals());
function fixture(html: string) {
  const { document, window } = parseHTML(`<div id="editor">${html}</div>`);
  for (const key of ["HTMLElement", "Node", "Element"] as const) vi.stubGlobal(key, window[key]);
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  const root = document.getElementById("editor");
  if (!root) throw new Error("Missing editor");
  let start: Node = root;
  let end: Node = root;
  let startOffset = 0;
  let endOffset = 0;
  let collapsed = true;
  class SelectionRange {
    startContainer = start;
    endContainer = end;
    startOffset = startOffset;
    endOffset = endOffset;
    collapsed = collapsed;
    commonAncestorContainer = root;
    whole: Node | null = null;
    setStart(node: Node, offset: number) {
      this.startContainer = node;
      this.startOffset = offset;
    }
    setEnd(node: Node, offset: number) {
      this.endContainer = node;
      this.endOffset = offset;
    }
    selectNodeContents(node: Node) {
      this.whole = node;
      this.startContainer = node;
      this.startOffset = 0;
      this.collapsed = false;
    }
    collapse() {
      this.collapsed = true;
    }
    intersectsNode(node: Node) {
      return node.contains(this.startContainer) || node.contains(this.endContainer);
    }
    cloneRange() {
      const copy = new SelectionRange();
      Object.assign(copy, this);
      return copy;
    }
    cloneContents() {
      const fragment = document.createDocumentFragment();
      if (this.whole)
        for (const child of this.whole.childNodes) fragment.append(child.cloneNode(true));
      else
        fragment.append(
          document.createTextNode(
            (this.startContainer.textContent ?? "").slice(this.startOffset, this.endOffset),
          ),
        );
      Object.defineProperty(fragment, "textContent", {
        get: () => [...fragment.childNodes].map((node) => node.textContent).join(""),
      });
      return fragment;
    }
    extractContents() {
      const fragment = this.cloneContents();
      if (this.whole) this.whole.textContent = "";
      else
        this.startContainer.textContent =
          (this.startContainer.textContent ?? "").slice(0, this.startOffset) +
          (this.startContainer.textContent ?? "").slice(this.endOffset);
      return fragment;
    }
    insertNode(node: Node) {
      if (this.whole) this.whole.appendChild(node);
      else {
        const parent = this.startContainer.parentNode;
        if (!parent) throw new Error("Missing range parent");
        const suffix = document.createTextNode(
          (this.startContainer.textContent ?? "").slice(this.startOffset),
        );
        this.startContainer.textContent = (this.startContainer.textContent ?? "").slice(
          0,
          this.startOffset,
        );
        parent.insertBefore(suffix, this.startContainer.nextSibling);
        parent.insertBefore(node, suffix);
      }
    }
  }
  let selected = new SelectionRange();
  Object.defineProperty(document, "createRange", { value: () => new SelectionRange() });
  vi.stubGlobal("getSelection", () => ({
    rangeCount: 1,
    getRangeAt: () => selected,
    removeAllRanges: vi.fn(),
    addRange: (range: SelectionRange) => (selected = range),
    anchorNode: selected.startContainer,
  }));
  const history: string[] = [];
  const command = vi.fn((name: string, _ui: boolean, value?: string) => {
    if (name === "undo") {
      root.innerHTML = history.pop() ?? "";
      return true;
    }
    history.push(root.innerHTML);
    if (name === "insertHTML") {
      if (selected.whole === root) root.innerHTML = value ?? "";
      else {
        selected.extractContents();
        const span = document.createElement("span");
        span.innerHTML = value ?? "";
        const fragment = document.createDocumentFragment();
        while (span.firstChild) fragment.append(span.firstChild);
        selected.insertNode(fragment);
      }
    } else if (name === "delete") selected.extractContents();
    return true;
  });
  Object.defineProperty(document, "execCommand", { value: command });
  Object.assign(root, { focus: vi.fn() });
  const select = (selector: string, from = 0, to = from) => {
    const element = root.querySelector(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    start = element.firstChild ?? element;
    end = start;
    startOffset = from;
    endOffset = to;
    collapsed = from === to;
    selected = new SelectionRange();
  };
  const apply = (action: FormatAction, copied = "") =>
    formatEditor(root, document.createRange(), action, copied);
  return { root, command, select, apply, document, range: () => document.createRange() };
}
it("paragraph formatting commits sanitized markup once and native undo restores the original", () => {
  const dom = fixture("<div>one</div><div>two</div>");
  dom.select("div", 1);
  dom.apply("alignJustify");
  expect(dom.root.innerHTML).toBe('<div style="text-align:justify">one</div><div>two</div>');
  expect(dom.command).toHaveBeenCalledTimes(1);
  dom.document.execCommand("undo", false);
  expect(dom.root.innerHTML).toBe("<div>one</div><div>two</div>");
  dom.select("div", 1);
  dom.apply("directionRtl");
  expect(dom.root.innerHTML).toContain('dir="rtl"');
  dom.select("div", 1);
  dom.apply("directionAuto");
  expect(dom.root.innerHTML).toContain('dir="auto"');
  expect(dom.root.innerHTML).not.toContain("direction:rtl");
  for (let i = 0; i < 15; i++) {
    dom.select("div");
    dom.apply("indentParagraph");
  }
  expect(dom.root.innerHTML).toContain("margin-left:240px");
  dom.select("div");
  dom.apply("outdentParagraph");
  expect(dom.root.innerHTML).toContain("margin-left:216px");
});
it("rich lists can change type, nest under a preceding item and outdent", () => {
  const dom = fixture("<ul><li>one</li><li>two</li></ul>");
  dom.select("li:nth-child(2)");
  dom.apply("dashList");
  expect(dom.root.innerHTML).toBe('<ul type="dash"><li>one</li><li>two</li></ul>');
  dom.select("li:nth-child(2)");
  dom.apply("indentList");
  expect(dom.root.innerHTML).toBe(
    '<ul type="dash"><li>one<ul type="dash"><li>two</li></ul></li></ul>',
  );
  dom.select("li li");
  dom.apply("outdentList");
  expect(dom.root.innerHTML).toBe('<ul type="dash"><li>one</li><li>two</li></ul>');
  dom.select("li:nth-child(2)");
  dom.apply("numberList");
  expect(dom.root.innerHTML).toContain('<ol type="1">');
});
it("quote increase/decrease and code blocks retain plain text and indentation", () => {
  const dom = fixture("<div>one</div>");
  dom.select("div");
  dom.apply("quoteIncrease");
  dom.select("div");
  dom.apply("quoteIncrease");
  expect(richComposeBody(dom.root.innerHTML).text).toBe("> > one");
  dom.select("div");
  dom.apply("quoteDecrease");
  expect(richComposeBody(dom.root.innerHTML).text).toBe("> one");
  dom.select("div");
  dom.apply("blockCode");
  expect(dom.root.innerHTML).toContain("<pre>one</pre>");
});
it("inline code, script position, color and style copying apply to selected text", () => {
  const dom = fixture("<div>hello world</div>");
  dom.select("div", 0, 5);
  dom.apply("inlineCode");
  expect(dom.root.innerHTML).toBe("<div><code>hello</code> world</div>");
  dom.select("code", 0, 5);
  dom.apply("superscript");
  expect(dom.root.innerHTML).toContain("<sup>hello</sup>");
  dom.select("sup", 0, 5);
  styleEditor(dom.root, dom.range(), "color", "#abc");
  expect(dom.root.innerHTML).toContain('style="color:#abc"');
  dom.select("span", 0, 5);
  const copied = dom.apply("copyStyle");
  expect(copied).toContain("color:#abc");
  dom.select("span", 0, 5);
  dom.apply("clearFormatting");
  expect(dom.root.innerHTML).not.toContain("color:#abc");
});
it("Markdown inline replacement emits escaped HTML and native undo returns literal delimiters", () => {
  const dom = fixture("<div>**a &lt; b**</div>");
  const replacement = composeReplacement("**a < b**", true, true);
  if (!replacement) throw new Error("Missing replacement");
  const paragraph = dom.root.querySelector("div");
  if (!paragraph) throw new Error("Missing paragraph");
  paragraph.textContent = "**a < b**";
  dom.select("div", 9);
  replaceMarkdownEditor(dom.root, dom.range(), replacement);
  expect(richComposeBody(dom.root.innerHTML).html).toBe("<div><strong>a &lt; b</strong></div>");
  dom.document.execCommand("undo", false);
  expect(dom.root.innerHTML).toBe("<div>**a &lt; b**</div>");
});
it("quote decrease affects the selected paragraph and clear removes paragraph/list formatting", () => {
  const dom = fixture("<blockquote><div>one</div><div>two</div></blockquote>");
  dom.select("div");
  dom.apply("quoteDecrease");
  expect(dom.root.innerHTML).toBe("<div>one</div><blockquote><div>two</div></blockquote>");
  dom.root.innerHTML =
    '<blockquote><ul><li style="margin-left:24px">one</li><li>two</li></ul></blockquote>';
  dom.select("li");
  dom.apply("clearFormatting");
  expect(dom.root.innerHTML).toBe("<div>one</div><blockquote><ul><li>two</li></ul></blockquote>");
});
it("changing a paragraph style overrides previous nested values and paste replaces the selected style", () => {
  const dom = fixture(
    '<div><span style="font-family:Georgia;font-size:18px;color:#123">hello</span></div>',
  );
  dom.select("span");
  styleEditor(dom.root, dom.range(), "font-family", "Arial");
  expect(dom.root.innerHTML).toContain("font-family:Arial");
  expect(dom.root.innerHTML).not.toContain("font-family:Georgia");
  expect(dom.root.innerHTML).toContain("font-size:18px");
  dom.select("span span", 0, 5);
  dom.apply("pasteStyle", "font-family:Verdana;color:#abc;__bold");
  expect(dom.root.innerHTML).toContain("font-family:Verdana;color:#abc");
  expect(dom.root.innerHTML).toContain("<strong>hello</strong>");
  expect(dom.root.innerHTML).not.toContain("color:#123");
});
