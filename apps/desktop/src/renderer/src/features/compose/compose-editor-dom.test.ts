import { parseHTML } from "linkedom";
import { afterEach, expect, it, vi } from "vitest";
import { composeEditorText, composeMatches, richComposeBody } from "@openmail/core/schema";
import {
  composeEditorHtml,
  editorMatchPoints,
  replaceEditorMatches,
  editorStartsParagraph,
} from "./compose-editor-dom";

afterEach(() => vi.unstubAllGlobals());

function editor(html: string) {
  const { document, window } = parseHTML(`<div id="editor">${html}</div>`);
  vi.stubGlobal("HTMLDivElement", window.HTMLDivElement);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("Node", window.Node);
  vi.stubGlobal("HTMLTextAreaElement", window.HTMLTextAreaElement);
  const element = document.querySelector("div");
  if (!element) throw new Error("Missing editor");
  return element;
}

it("rich find maps inline marks, block breaks, BR and UTF-16 offsets to exact DOM ranges", () => {
  const body = richComposeBody("<div>😀 <b>hello</b> <i>world</i></div><div>hello<br>world</div>");
  const element = editor(body.html);
  const text = composeEditorText(body);
  expect(text).toBe("😀 hello world\nhello\nworld");
  const matches = composeMatches(text, "hello");
  for (const match of matches) {
    const range = editorMatchPoints(element, match.start, match.end);
    expect(range?.first.node.textContent?.slice(range.first.offset, range.first.offset + 5)).toBe(
      "hello",
    );
  }
  const across = composeMatches(text, "world\nhello")[0];
  if (!across) throw new Error("Missing multiline match");
  const points = editorMatchPoints(element, across.start, across.end);
  expect(points?.first.node.textContent?.slice(points.first.offset)).toBe("world");
  expect(points?.last.node.textContent?.slice(0, points.last.offset)).toBe("hello");
});

it("plain/Markdown Replace All executes one native insertText and can be undone", () => {
  const { document, window } = parseHTML("<textarea>cat cat tail</textarea>");
  const element = document.querySelector("textarea");
  if (!element) throw new Error("Missing textarea");
  vi.stubGlobal("HTMLTextAreaElement", window.HTMLTextAreaElement);
  const history: string[] = [];
  const execute = vi.fn((command: string, _ui: boolean, text: string) => {
    if (command === "undo") {
      element.value = history.pop() ?? element.value;
      return true;
    }
    history.push(element.value);
    element.value =
      element.value.slice(0, element.selectionStart) +
      text +
      element.value.slice(element.selectionEnd);
    return true;
  });
  Object.assign(element, {
    focus: vi.fn(),
    setSelectionRange: (start: number, end: number) => {
      element.selectionStart = start;
      element.selectionEnd = end;
    },
  });
  Object.defineProperty(document, "execCommand", { value: execute });
  vi.stubGlobal("document", document);
  replaceEditorMatches(element, composeMatches(element.value, "cat"), "dog");
  expect(element.value).toBe("dog dog tail");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledWith("insertText", false, "dog dog");
  execute("undo", false, "");
  expect(element.value).toBe("cat cat tail");
});

it("rich Replace All edits a detached copy and commits one command while preserving marks and escaping text", () => {
  const element = editor("<b>cat cat suffix</b><i>tail</i>");
  const document = element.ownerDocument;
  const execute = vi.fn(() => true);
  const selection = { removeAllRanges: vi.fn(), addRange: vi.fn() };
  const range = () => {
    let node: Node | null = null;
    let start = 0;
    let end = 0;
    return {
      commonAncestorContainer: element,
      setStart(next: Node, offset: number) {
        node = next;
        start = offset;
      },
      setEnd(next: Node, offset: number) {
        if (node !== next) throw new Error("Expected a single text node in this fixture");
        end = offset;
      },
      deleteContents() {
        if (node)
          node.textContent =
            (node.textContent ?? "").slice(0, start) + (node.textContent ?? "").slice(end);
      },
      insertNode(fragment: Node) {
        if (!node?.parentNode) throw new Error("Missing range node");
        const suffix = document.createTextNode((node.textContent ?? "").slice(start));
        node.textContent = (node.textContent ?? "").slice(0, start);
        node.parentNode.insertBefore(suffix, node.nextSibling);
        node.parentNode.insertBefore(fragment, suffix);
      },
      selectNodeContents: vi.fn(),
    };
  };
  Object.assign(element, { focus: vi.fn() });
  Object.defineProperty(document, "createRange", { value: range });
  Object.defineProperty(document, "execCommand", { value: execute });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { getSelection: () => selection });
  expect(replaceEditorMatches(element, composeMatches("cat cat", "cat"), "<dog>")).toBe(true);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.calls[0]).toEqual([
    "insertHTML",
    false,
    "<b>&lt;dog&gt; &lt;dog&gt; suffix</b><i>tail</i>",
  ]);
  expect(element.innerHTML).toBe("<b>cat cat suffix</b><i>tail</i>");
});

it("blob previews never enter saved compose HTML and CID images retain surrounding marks", () => {
  const element = editor(
    '<b>before</b><img src="blob:local" data-compose-cid="part@openmail" alt="image"><i>after</i>',
  );
  const html = composeEditorHtml(element);
  expect(html).toContain('src="cid:part@openmail"');
  expect(html).not.toMatch(/blob:|data-compose-cid/);
  expect(richComposeBody(html).html).toContain("<strong>before</strong>");
  expect(richComposeBody(html).html).toContain("<em>after</em>");
  expect(element.innerHTML).toContain("blob:local");
});

it("smart list prefixes respect paragraph boundaries through inline marks", () => {
  for (const [html, expected] of [
    ["<div><strong>* </strong></div>", true],
    ["<div>hello <strong>* </strong></div>", false],
    ["<div><span>hello</span><strong>* </strong></div>", false],
    ["<div>previous</div><div><strong>* </strong></div>", true],
  ] as const) {
    const element = editor(html);
    const target = element.querySelector("strong")?.firstChild;
    if (!target) throw new Error("Missing prefix");
    const range = element.ownerDocument.createRange();
    Object.assign(range, { startContainer: target });
    expect(editorStartsParagraph(element, range)).toBe(expected);
  }
});
