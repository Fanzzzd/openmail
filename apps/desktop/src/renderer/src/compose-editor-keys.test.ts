import { act, createElement, createRef } from "react";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { afterAll, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { DEFAULT_PREFS, richComposeBody, type ComposeBody } from "@openmail/core/schema";
import type { ReactNode } from "react";
import type { ComposeElement } from "./compose-editor-dom";
import { testDom } from "./test-dom";

const controls = vi.hoisted(() => {
  vi.resetModules();
  return { clipboard: "<img src=x onerror=bad()>\nsecond line" };
});
vi.mock("./state/mail", () => ({
  useRunMail: () => (effect: Effect.Effect<unknown>) => Effect.runSync(effect),
  withMail: (callback: (call: (name: string) => Effect.Effect<string>) => Effect.Effect<unknown>) =>
    callback(() => Effect.succeed(controls.clipboard)),
}));
vi.mock("./components/ui/Select", () => ({ Select: () => null }));
vi.mock("./components/ui/Dialog", () => ({
  Alert: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? createElement("div", null, children) : null,
  AlertCancel: () => null,
  alertButton: "",
  alertPrimary: "",
}));
import { ComposeEditor } from "./components/ComposeEditor";

afterAll(() => {
  vi.doUnmock("./state/mail");
  vi.doUnmock("./components/ui/Select");
  vi.doUnmock("./components/ui/Dialog");
  vi.resetModules();
});

function editor(body: ComposeBody) {
  const dom = testDom();
  for (const name of [
    "Node",
    "Element",
    "HTMLElement",
    "HTMLDivElement",
    "HTMLTextAreaElement",
  ] as const)
    vi.stubGlobal(name, dom.window[name]);
  dom.window.getSelection = () => null;
  const command = vi.fn(() => true);
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
        prefs: DEFAULT_PREFS,
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
    modifiers: { altKey?: boolean; shiftKey?: boolean } = {},
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
      ["x", "strikeThrough", { altKey: true }],
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
