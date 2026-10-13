import { act, createElement, createRef } from "react";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { afterAll, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { Reactivity } from "effect/reactivity";
import { DEFAULT_PREFS, richComposeBody, type ComposeBody } from "@openmail/core/schema";
import type { ReactNode } from "react";
import type { ComposeElement } from "./compose-editor-dom";
import { testDom } from "../../test-support/test-dom";
import { EDITOR_ACTION_EVENT } from "../../../../shared/native-actions";

const controls = vi.hoisted(() => {
  vi.resetModules();
  return {
    clipboard: "<img src=x onerror=bad()>\nsecond line",
    calls: new Array<{ name: string; payload: unknown }>(),
  };
});
vi.mock("../../state/mail", () => ({
  useRunMail: () => (effect: Effect.Effect<unknown, unknown, Reactivity.Reactivity>) =>
    Effect.runSync(Effect.provide(effect, Reactivity.layer)),
  withMail: (
    callback: (
      call: (name: string, payload?: unknown) => Effect.Effect<string>,
    ) => Effect.Effect<unknown>,
  ) =>
    callback((name, payload) => {
      controls.calls.push({ name, payload });
      return Effect.succeed(controls.clipboard);
    }),
}));
vi.mock("../../ui/Select", () => ({ Select: () => null }));
vi.mock("../../ui/Dialog", () => ({
  Alert: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? createElement("div", null, children) : null,
  AlertCancel: () => null,
  alertButton: "",
  alertPrimary: "",
}));
import { ComposeEditor } from "./components/ComposeEditor";

afterAll(() => {
  vi.doUnmock("../../state/mail");
  vi.doUnmock("../../ui/Select");
  vi.doUnmock("../../ui/Dialog");
  vi.resetModules();
});

function editor(body: ComposeBody, prefs = DEFAULT_PREFS) {
  const dom = testDom();
  for (const name of [
    "Node",
    "Element",
    "HTMLElement",
    "HTMLDivElement",
    "HTMLTextAreaElement",
  ] as const)
    vi.stubGlobal(name, dom.window[name]);
  vi.stubGlobal("getSelection", () => null);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  const command = vi.fn((_name: string, _ui?: boolean, _value?: string) => true);
  dom.window.document.execCommand = command;
  const bodyRef = createRef<ComposeElement>();
  const selectionRef = createRef<Range>();
  const change = vi.fn();
  dom.render(
    createElement(
      I18nProvider,
      { i18n: setupI18n({ locale: "en", messages: { en: {} } }) },
      createElement(ComposeEditor, {
        body,
        attachments: [],
        onChange: change,
        bodyRef,
        selectionRef,
        shortcutSet: "mimestream",
        prefs,
        from: undefined,
        onImageSize: vi.fn(),
        onMention: vi.fn(),
        onMentionsChange: vi.fn(),
      }),
    ),
  );
  const element = bodyRef.current;
  if (!element) throw new Error("Missing compose body");
  Object.defineProperty(element, "isContentEditable", { value: body.kind === "rich" });
  const key = (
    target: Element,
    value: string,
    modifiers: { altKey?: boolean; shiftKey?: boolean; ctrlKey?: boolean } = {},
  ) => {
    Object.defineProperty(target, "attachEvent", { value: vi.fn(), configurable: true });
    Object.defineProperty(target, "detachEvent", { value: vi.fn(), configurable: true });
    void act(() => target.dispatchEvent(new dom.window.Event("focusin", { bubbles: true })));
    const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
    Object.assign(event, {
      key: value,
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...modifiers,
    });
    void act(() => target.dispatchEvent(event));
    return event;
  };
  return { ...dom, body: element, command, key, change };
}

it("rich compose style keys invoke editor commands and link opens its form", () => {
  const dom = editor(richComposeBody("Hello"));
  try {
    for (const [key, name, modifiers] of [
      ["b", "bold", {}],
      ["i", "italic", {}],
      ["u", "underline", {}],
      ["x", "strikeThrough", { shiftKey: true }],
    ] as const) {
      expect(dom.key(dom.body, key, modifiers).defaultPrevented).toBe(true);
      expect(dom.command).toHaveBeenLastCalledWith(name, false, undefined);
    }
    expect(dom.key(dom.body, "k").defaultPrevented).toBe(true);
    expect(dom.element.querySelector('[aria-label="Link URL"]')).not.toBeNull();
    const input = dom.element.querySelector('[aria-label="Link URL"]');
    if (!input) throw new Error("Missing link input");
    dom.command.mockClear();
    expect(dom.key(input, "b").defaultPrevented).toBe(false);
    expect(dom.command).not.toHaveBeenCalled();
  } finally {
    dom.dispose();
  }
});

it("paste key set inserts escaped match-style text or a sanitized quote block", () => {
  const dom = editor(richComposeBody("Hello"));
  try {
    expect(dom.key(dom.body, "v", { altKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(dom.command).toHaveBeenLastCalledWith(
      "insertHTML",
      false,
      "&lt;img src=x onerror=bad()&gt;<br>second line",
    );
    expect(dom.key(dom.body, "v", { altKey: true }).defaultPrevented).toBe(true);
    expect(dom.command).toHaveBeenLastCalledWith(
      "insertHTML",
      false,
      "<blockquote>&lt;img src=x onerror=bad()&gt;<br>second line</blockquote>",
    );
  } finally {
    dom.dispose();
  }
});

it("plain compose supports scoped find and leaves rich style keys alone", () => {
  const dom = editor({ kind: "plain", text: "hello hello" });
  try {
    expect(dom.key(dom.body, "b").defaultPrevented).toBe(false);
    expect(dom.command).not.toHaveBeenCalled();
    expect(dom.key(dom.body, "f").defaultPrevented).toBe(true);
    const find = dom.element.querySelector('[aria-label="Find in body"]');
    if (!find) throw new Error("Missing find input");
    expect(dom.key(find, "g").defaultPrevented).toBe(true);
    expect(dom.key(find, "g", { altKey: true }).defaultPrevented).toBe(true);
  } finally {
    dom.dispose();
  }
});

it("Markdown textarea leaves emoji in code untouched and replaces tokens outside code", () => {
  for (const prefix of ["```js\n", "~~~\n", "Use ` ", "`code` "]) {
    const dom = editor({ kind: "markdown", text: `${prefix}:+1:` });
    try {
      const textarea = dom.body;
      if (!(textarea instanceof dom.window.HTMLTextAreaElement))
        throw new Error("Missing textarea");
      dom.key(textarea, "a");
      const next = `${prefix}:+1: `;
      const move = vi.fn();
      Object.assign(textarea, { setSelectionRange: move });
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
      act(() => {
        Reflect.set(dom.window.HTMLTextAreaElement.prototype, "value", next, textarea);
        Object.assign(textarea, { selectionStart: next.length, selectionEnd: next.length });
        textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        textarea.dispatchEvent(new dom.window.Event("keyup", { bubbles: true }));
      });
      expect(dom.change).toHaveBeenLastCalledWith({
        kind: "markdown",
        text: prefix === "`code` " ? `${prefix}👍 ` : next,
      });
      if (prefix === "`code` ") {
        expect(move).toHaveBeenCalledWith(prefix.length + 3, prefix.length + 3);
        expect(dom.key(textarea, "z").defaultPrevented).toBe(true);
        expect(dom.change).toHaveBeenLastCalledWith({ kind: "markdown", text: next });
      } else expect(move).not.toHaveBeenCalled();
    } finally {
      dom.dispose();
    }
  }
});

it("hiding the format bar keeps the toolbar row, persists the preference and keeps style keys", () => {
  const dom = editor(richComposeBody("Hello"));
  try {
    expect(dom.element.querySelector('[aria-label="Bold"]')).not.toBeNull();
    // The Format menu's Hide format bar has no key and arrives as an action event.
    void act(() =>
      dom.body.dispatchEvent(
        new dom.window.CustomEvent(EDITOR_ACTION_EVENT, {
          detail: "toggleFormatBar",
          bubbles: true,
        }),
      ),
    );
    expect(dom.element.querySelector('[aria-label="Bold"]')).toBeNull();
    expect(dom.element.querySelector('[aria-label="More formatting"]')).not.toBeNull();
    expect(controls.calls.at(-1)).toEqual({
      name: "SetPrefs",
      payload: { patch: { composeFormatBar: false } },
    });
    expect(dom.key(dom.body, "b").defaultPrevented).toBe(true);
  } finally {
    dom.dispose();
  }
});

for (const [literal, tag] of [
  ["**bold**", "strong"],
  ["* ", "ul"],
  ["1. ", "ol"],
  ["> ", "blockquote"],
] as const) {
  it(`rich typing replaces ${literal} and Cmd-Z immediately restores the literal with its caret`, () => {
    const dom = editor(richComposeBody(""));
    try {
      dom.body.innerHTML = `<div>${literal.replaceAll(" ", "\u00a0")}</div>`;
      const paragraph = dom.body.firstElementChild;
      const text = paragraph?.firstChild;
      if (!text) throw new Error("Missing typing node");
      let selected: Range;
      const nativeRange = dom.window.document.createRange.bind(dom.window.document);
      const rangeAt = (node: Node, offset: number): Range => {
        const range = nativeRange();
        let start = offset;
        let end = offset;
        Object.assign(range, {
          collapsed: true,
          commonAncestorContainer: node,
          startContainer: node,
          endContainer: node,
          startOffset: offset,
          endOffset: offset,
          cloneRange: () => rangeAt(node, offset),
          selectNodeContents: vi.fn(),
          setStart: (nextNode: Node, value: number) => {
            start = value;
            Object.assign(range, {
              startContainer: nextNode,
              startOffset: value,
              commonAncestorContainer: nextNode,
            });
          },
          setEnd: (_node: Node, value: number) => {
            end = value;
          },
          collapse: vi.fn(),
          cloneContents: () => {
            const fragment = dom.window.document.createDocumentFragment();
            fragment.append(
              dom.window.document.createTextNode((node.textContent ?? "").slice(0, end)),
            );
            Object.defineProperty(fragment, "textContent", {
              get: () => (node.textContent ?? "").slice(0, end),
            });
            return fragment;
          },
        });
        Object.defineProperty(range, "testOffsets", { value: () => ({ start, end }) });
        return range;
      };
      Object.defineProperty(dom.window.document, "createRange", {
        configurable: true,
        value: () => rangeAt(dom.body.firstChild ?? dom.body, 0),
      });
      selected = rangeAt(text, literal.length);
      vi.stubGlobal("getSelection", () => null);
      vi.stubGlobal("getSelection", () => ({
        rangeCount: 1,
        getRangeAt: () => selected,
        removeAllRanges: vi.fn(),
        addRange: (range: Range) => {
          selected = range;
        },
        anchorNode: selected.startContainer,
      }));
      dom.command.mockImplementation((name: string, _ui?: boolean, value?: string) => {
        if (name === "insertHTML") dom.body.innerHTML = `<div>${value ?? ""}</div>`;
        if (name === "delete") dom.body.innerHTML = "<div></div>";
        if (name === "insertUnorderedList" || name === "insertOrderedList")
          dom.body.innerHTML = `<${tag}><li></li></${tag}>`;
        if (name === "formatBlock") dom.body.innerHTML = `<${tag}></${tag}>`;
        const target = dom.body.querySelector("strong,li,blockquote") ?? dom.body;
        if (!target.firstChild) target.append(dom.window.document.createTextNode(""));
        selected = rangeAt(target.firstChild ?? target, target.textContent.length);
        return true;
      });
      const event = new dom.window.Event("input", { bubbles: true });
      Object.assign(event, { inputType: "insertText", isComposing: false });
      void act(() => dom.body.dispatchEvent(event));
      const converted = dom.change.mock.calls.at(-1)?.[0];
      expect(dom.body.getAttribute("dir")).toBe("auto");
      expect(converted?.html).not.toContain('dir="auto"');
      expect(converted?.html).toContain(`<${tag}`);
      expect(dom.key(dom.body, "z").defaultPrevented).toBe(true);
      expect(dom.change).toHaveBeenLastCalledWith(
        richComposeBody(`<div>${literal.replaceAll(" ", "\u00a0")}</div>`),
      );
      expect(dom.body.textContent.replaceAll("\u00a0", " ")).toBe(literal);
    } finally {
      dom.dispose();
    }
  });
}
