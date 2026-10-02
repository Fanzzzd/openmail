import { expect, it, vi } from "vitest";
import { moveMailPaneFocus } from "./pane-navigation";
import { testDom } from "./test-dom";

it("moves focus across sidebar/list/reader, returns to the selected row and stops at the edges", () => {
  const dom = testDom();
  try {
    dom.element.innerHTML = `<div data-mail-pane="sidebar"><nav><button>Inbox</button><button aria-current="page">Sent</button></nav></div>
      <div data-mail-pane="list"><div role="listbox" tabindex="-1"><button data-id="first">First</button><button data-id='quoted&quot;id'>Selected</button></div></div>
      <div data-mail-pane="reader" tabindex="-1"><article data-reader-text tabindex="-1">Message</article></div>`;
    const elements = [
      ...dom.element.querySelectorAll<HTMLElement>(
        "[data-mail-pane],button,article,[role=listbox]",
      ),
    ];
    let active: Element | null = null;
    Object.defineProperty(dom.window.document, "activeElement", {
      configurable: true,
      get: () => active,
    });
    for (const element of elements)
      element.focus = vi.fn(() => {
        active = element;
      });
    const inbox = dom.element.querySelector("button");
    const selected = elements.find((element) => element.dataset.id === 'quoted"id');
    const reader = dom.element.querySelector("article");
    const sent = dom.element.querySelector("[aria-current]");
    active = inbox;
    expect(moveMailPaneFocus(dom.window.document, "left", 'quoted"id')).toBe(false);
    expect(moveMailPaneFocus(dom.window.document, "right", 'quoted"id')).toBe(true);
    expect(active).toBe(selected);
    expect(moveMailPaneFocus(dom.window.document, "right", 'quoted"id')).toBe(true);
    expect(active).toBe(reader);
    expect(moveMailPaneFocus(dom.window.document, "right", 'quoted"id')).toBe(false);
    expect(moveMailPaneFocus(dom.window.document, "left", 'quoted"id')).toBe(true);
    expect(active).toBe(selected);
    expect(moveMailPaneFocus(dom.window.document, "left", 'quoted"id')).toBe(true);
    expect(active).toBe(sent);
    active = selected ?? null;
    reader?.remove();
    expect(moveMailPaneFocus(dom.window.document, "right", null)).toBe(true);
    expect(active).toBe(dom.element.querySelector('[data-mail-pane="reader"]'));
  } finally {
    dom.dispose();
  }
});

it("preserves text cursors, iframe focus and menu/toolbar navigation", () => {
  const dom = testDom();
  try {
    dom.element.innerHTML = `<div data-mail-pane="list">
      <input><textarea></textarea><select></select><div contenteditable="true"><span>Text</span></div>
      <iframe></iframe><div role="menu"><button>Menu</button></div><div role="dialog"><button>Dialog</button></div>
      <div role="toolbar"><button>Toolbar</button></div><div role="combobox"><button>Chip</button></div>
      </div><div data-mail-pane="reader" tabindex="-1"></div>`;
    let active: Element | null = null;
    Object.defineProperty(dom.window.document, "activeElement", {
      configurable: true,
      get: () => active,
    });
    for (const element of dom.element.querySelectorAll(
      "input,textarea,select,span,iframe,button",
    )) {
      active = element;
      expect(moveMailPaneFocus(dom.window.document, "right", null)).toBe(false);
      expect(active).toBe(element);
    }
    active = dom.element;
    expect(moveMailPaneFocus(dom.window.document, "right", null)).toBe(false);
  } finally {
    dom.dispose();
  }
});
