import type { DesktopEvent } from "../../shared/desktop";
import { act, createElement } from "react";
import { afterAll, expect, it, vi } from "vitest";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { AsyncResult } from "effect/reactivity";
import { Effect } from "effect";
import { DEFAULT_PREFS } from "@openmail/core/schema";
import { testDom } from "./test-dom";
const calls = vi.hoisted(() => {
  vi.resetModules();
  const desktop: { receive?: (event: DesktopEvent) => void } = {};
  return { rpc: vi.fn(), modify: vi.fn(), deleteAction: "trash", desktop };
});
vi.mock("@effect/atom-react", () => ({
  useAtomMount: vi.fn(),
  useAtomValue: (atom: string) =>
    AsyncResult.success(
      atom === "prefs" ? { ...DEFAULT_PREFS, deleteKeyAction: calls.deleteAction } : [],
    ),
}));
vi.mock("./state/queries", () => ({
  prefsAtom: "prefs",
  accountsAtom: "accounts",
  labelsAtom: () => "labels",
  threadAtom: () => "thread",
}));
vi.mock("./state/desktop", () => ({
  useDesktopLabels: vi.fn(),
  useDesktopEvents: (receive: (event: DesktopEvent) => void) => {
    calls.desktop.receive = receive;
  },
}));
vi.mock("./state/events", () => ({ liveUpdatesAtom: "live" }));
vi.mock("./rpc", () => ({ MailClient: { runtime: "runtime" } }));
vi.mock("./state/undo", () => ({
  useBatchUndo: () => ({ undoRef: { current: vi.fn() }, showUndo: vi.fn() }),
}));
vi.mock("./state/mail", () => ({
  useRunMail: () => Effect.runSync,
  withMail: (callback: (call: (tag: string) => Effect.Effect<void>) => Effect.Effect<void>) =>
    callback((tag) => Effect.sync(() => calls.rpc(tag))),
  modifyThreads: () => Effect.sync(() => calls.modify()),
  modifyMessages: () => Effect.sync(() => calls.modify()),
}));
vi.mock("./components/Reader", () => ({ ThreadView: () => null, useThreadPrint: () => vi.fn() }));
vi.mock("./components/ThreadActions", () => ({ ThreadActions: () => null }));
vi.mock("./components/Toast", () => ({
  Toast: ({ toast }: { toast: { text: string } | null }) =>
    toast ? createElement("div", { role: "status" }, toast.text) : null,
}));
vi.mock("./components/SystemSettings", () => ({ ShortcutHelp: () => null }));
vi.mock("./components/Settings", () => ({
  Settings: () => createElement("div", { "data-settings": true }),
}));
vi.mock("./components/AddAccountDialog", () => ({ AddAccountDialog: () => null }));
vi.mock("./components/ui/Dialog", () => ({
  Alert: () => null,
  AlertCancel: () => null,
  alertButton: "",
}));
import { WindowKeys } from "./components/WindowKeys";
import { ThreadWindow } from "./ThreadWindow";
afterAll(() => {
  for (const module of [
    "@effect/atom-react",
    "./state/queries",
    "./state/desktop",
    "./state/events",
    "./rpc",
    "./state/undo",
    "./state/mail",
    "./components/Reader",
    "./components/ThreadActions",
    "./components/Toast",
    "./components/SystemSettings",
    "./components/Settings",
    "./components/AddAccountDialog",
    "./components/ui/Dialog",
  ])
    vi.doUnmock(module);
  vi.resetModules();
});
it("reader windows handle compose/new-window/settings rather than losing their accelerators", () => {
  const dom = testDom();
  vi.stubGlobal("Element", dom.window.Element);
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  try {
    dom.render(
      createElement(I18nProvider, { i18n }, createElement(ThreadWindow, { id: "message" })),
    );
    const key = (value: string, shiftKey = false) => {
      const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
      Object.assign(event, { key: value, metaKey: true, ctrlKey: false, altKey: false, shiftKey });
      act(() => {
        dom.window.dispatchEvent(event);
      });
      return event;
    };
    expect(key("n").defaultPrevented).toBe(true);
    expect(calls.rpc).toHaveBeenLastCalledWith("ComposeNew");
    expect(key("N", true).defaultPrevented).toBe(true);
    expect(calls.rpc).toHaveBeenLastCalledWith("NewWindow");
    expect(key(",").defaultPrevented).toBe(true);
    expect(dom.element.querySelector("[data-settings]")).not.toBeNull();
  } finally {
    dom.dispose();
  }
});

it("window shortcut registration never disables native menu shortcuts on focus changes", () => {
  const dom = testDom();
  vi.stubGlobal("Element", dom.window.Element);
  calls.rpc.mockClear();
  try {
    dom.render(createElement(WindowKeys));
    const input = dom.window.document.createElement("input");
    dom.window.document.body.append(input);
    for (const type of ["focusin", "focusout"])
      act(() => {
        input.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
      });
    for (const key of ["c", "v", "x", "a", "z", "w", "q"]) {
      const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
      Object.assign(event, { key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false });
      act(() => {
        dom.window.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(calls.rpc).not.toHaveBeenCalled();
  } finally {
    dom.dispose();
  }
});

it("removeLabel without a window label trashes but keeps its explanation visible", () => {
  const dom = testDom();
  vi.stubGlobal("Element", dom.window.Element);
  const close = vi.fn();
  dom.window.close = close;
  calls.deleteAction = "removeLabel";
  calls.modify.mockClear();
  try {
    dom.render(
      createElement(
        I18nProvider,
        { i18n: setupI18n({ locale: "en", messages: { en: {} } }) },
        createElement(ThreadWindow, { id: "message" }),
      ),
    );
    const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
    Object.assign(event, {
      key: "Backspace",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });
    act(() => {
      dom.window.dispatchEvent(event);
    });
    expect(calls.modify).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(dom.element.querySelector('[role="status"]')?.textContent).toBe(
      "No current label applies. Moving to Trash.",
    );
  } finally {
    calls.deleteAction = "trash";
    dom.dispose();
  }
});

it("reader native accelerators do not reply or delete while an editable field is focused", () => {
  const dom = testDom();
  vi.stubGlobal("Element", dom.window.Element);
  try {
    dom.render(
      createElement(
        I18nProvider,
        { i18n: setupI18n({ locale: "en", messages: { en: {} } }) },
        createElement(ThreadWindow, { id: "message" }),
      ),
    );
    const input = dom.window.document.createElement("input");
    dom.window.document.body.append(input);
    Object.defineProperty(dom.window.document, "activeElement", {
      configurable: true,
      value: input,
    });
    calls.rpc.mockClear();
    calls.modify.mockClear();
    act(() => {
      calls.desktop.receive?.({
        _tag: "NativeAction",
        action: "reply",
        triggeredByAccelerator: true,
      });
      calls.desktop.receive?.({
        _tag: "NativeAction",
        action: "trash",
        triggeredByAccelerator: true,
      });
    });
    expect(calls.rpc).not.toHaveBeenCalled();
    expect(calls.modify).not.toHaveBeenCalled();
    act(() =>
      calls.desktop.receive?.({
        _tag: "NativeAction",
        action: "reply",
        triggeredByAccelerator: false,
      }),
    );
    expect(calls.rpc).toHaveBeenCalledWith("ComposeMessage");
  } finally {
    dom.dispose();
  }
});
