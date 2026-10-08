// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { Effect } from "effect";
import { AsyncResult } from "effect/reactivity";
import { DEFAULT_PREFS } from "@openmail/core/schema";
import type { Message, MailOp } from "../../shared/api";
import { readerThreadKey } from "./reader-selection";
import { testDom } from "./test-dom";

const calls = vi.hoisted(() => {
  const frameKey: (event: KeyboardEvent) => void = vi.fn();
  return {
    modify: vi.fn(),
    unread: vi.fn(),
    web: vi.fn(),
    prefs: {},
    frameKey,
  };
});
vi.mock("@effect/atom-react", async (original) => {
  const actual = await original<typeof import("@effect/atom-react")>();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    // Mocked queries are strings; local UI atoms keep their real state.
    useAtom: (atom: unknown) =>
      Atom.isAtom(atom) && Atom.isWritable(atom) ? actual.useAtom(atom) : [null, vi.fn()],
    useAtomSet: () => vi.fn(),
    useAtomValue: (atom: string) => {
      if (atom === "apple-status") return AsyncResult.success({ status: "off", revision: 0 });
      if (atom === "apple-id") return AsyncResult.success(null);
      if (atom === "prefs")
        return AsyncResult.success({ ...DEFAULT_PREFS, shortcutSet: "mimestream" });
      if (atom === "accounts") return AsyncResult.success([{ id: "gmail:one", provider: "gmail" }]);
      return AsyncResult.success([]);
    },
  };
});
vi.mock("./state/queries", () => ({
  appleContactsStatusAtom: "apple-status",
  appleContactIdentifierAtom: () => "apple-id",
  prefsAtom: "prefs",
  accountsAtom: "accounts",
  knownSendersAtom: () => "known",
  contactPhotoAtom: () => "photo",
  imageSendersAtom: "images",
  inlineImagesAtom: () => "inline",
  threadAtom: () => "thread",
}));
vi.mock("./state/mail", () => ({
  useRunMail: () => Effect.runSync,
  modifyMessages: (ids: readonly string[], op: MailOp) => {
    calls.modify(ids, op);
    return Effect.succeed({ undoId: op.kind });
  },
  markUnreadFrom: (id: string) => {
    calls.unread(id);
    return Effect.succeed({ undoId: "suffix" });
  },
  withMail: (
    f: (call: (tag: string, payload: unknown) => Effect.Effect<void>) => Effect.Effect<void>,
  ) => f((tag, payload) => Effect.sync(() => calls.web(tag, payload))),
  openMessageWindow: vi.fn(),
  openThreadWindow: vi.fn(),
  printThread: vi.fn(),
}));
vi.mock("./components/EmailFrame", () => ({
  EmailFrame: ({ onKeyDown }: { onKeyDown: (event: KeyboardEvent) => void }) => {
    calls.frameKey = onKeyDown;
    return null;
  },
}));
vi.mock("./components/AiPanel", () => ({ ThreadSummary: () => null, Assistant: () => null }));
vi.mock("./components/TriageChip", () => ({ TriageChip: () => null }));
vi.mock("./components/Attachments", () => ({ Attachments: () => null }));
vi.mock("./components/InviteBanner", () => ({ InviteBanner: () => null }));
vi.mock("./components/MeetingLinks", () => ({ MeetingLinks: () => null }));
vi.mock("./components/reader-actions", () => ({ useSaveMessage: () => vi.fn() }));
vi.mock("./components/ui/Menu", () => ({
  DropdownMenu: ({ trigger, children }: { trigger: ReactNode; children: ReactNode }) =>
    createElement("div", null, trigger, children),
  MenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) =>
    createElement("button", { onClick }, children),
  MenuSeparator: () => null,
}));
import { ThreadView } from "./components/Reader";

const message = (id: string, date: number): Message => ({
  id,
  date,
  threadId: "shared",
  accountId: "gmail:one",
  subject: id,
  from: { name: id, address: `${id}@example.com` },
  to: [],
  cc: [],
  replyTo: [],
  labels: ["INBOX"],
  bodyText: `${id} original body`,
  bodyHtml: "",
  snippet: id,
  attachments: [],
  isUnread: false,
  isStarred: false,
  hasAttachments: false,
});

it("sync preserves selected reply/find/expansion; forward/web keep their shortcuts and actions deliver undo IDs", () => {
  const dom = testDom();
  vi.stubGlobal("Element", dom.window.Element);
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  const older = message("old", 1);
  const newer = message("new", 2);
  const latest = message("latest", 3);
  const select = vi.fn();
  const compose = vi.fn();
  const done = vi.fn();
  const notify = vi.fn();
  const render = (messages: Message[], selectedId: string) =>
    dom.render(
      createElement(
        I18nProvider,
        { i18n },
        createElement(ThreadView, {
          key: readerThreadKey(messages[0]),
          messages,
          selectedId,
          single: false,
          onSelectMessage: select,
          onComposeMessage: compose,
          onActionDone: done,
          notify,
        }),
      ),
    );
  const click = (root: Element, text: string) => {
    const button = [...root.querySelectorAll("button")].find((button) =>
      button.textContent.includes(text),
    );
    if (!button) throw new Error(`Missing button: ${text}`);
    act(() => button.click());
  };
  const selected = () => {
    const article = dom.element.querySelector('article[aria-label="Selected message"]');
    if (!article) throw new Error("Missing selected message");
    return article;
  };
  const key = (target: Element, key: string, shiftKey = false) => {
    const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "isTrusted", { value: true });
    Object.assign(event, { key, metaKey: true, ctrlKey: false, altKey: false, shiftKey });
    act(() => {
      target.dispatchEvent(event);
    });
  };
  try {
    render([older, newer], newer.id);
    click(dom.element, "old@example.com");
    expect(select.mock.calls.at(-1)).toEqual([older.id]);
    key(selected(), "f");
    expect(dom.element.querySelector('input[aria-label="Find in message"]')).not.toBeNull();
    render([older, newer, latest], latest.id);
    expect(select.mock.calls.at(-1)).toEqual([older.id]);
    expect(selected().textContent).toContain("old original body");
    expect(dom.element.querySelector('input[aria-label="Find in message"]')).not.toBeNull();
    key(selected(), "F", true);
    expect(compose.mock.calls.at(-1)).toEqual([older.id, "forward", false]);
    key(selected(), "G", true);
    expect(calls.web.mock.calls.at(-1)).toEqual(["OpenMessageWeb", { id: older.id }]);
    const findInput = dom.element.querySelector('input[aria-label="Find in message"]');
    if (!findInput) throw new Error("Missing find input");
    key(findInput, "F", true);
    expect(compose.mock.calls.at(-1)).toEqual([older.id, "forward", false]);
    key(findInput, "G", true);
    expect(calls.web.mock.calls.at(-1)).toEqual(["OpenMessageWeb", { id: older.id }]);
    for (const [label, kind] of [
      ["Archive message", "archive"],
      ["Move message to Trash", "trash"],
      ["Star message", "star"],
      ["Mark message unread", "read"],
    ]) {
      click(selected(), label ?? "");
      expect(done.mock.calls.at(-1)?.[0]).toMatchObject({
        result: { undoId: kind },
        ids: [older.id],
      });
      expect(calls.modify.mock.calls.at(-1)?.[0]).toEqual([older.id]);
    }
    click(selected(), "Mark unread from this message");
    expect(done.mock.calls.at(-1)?.[0]).toMatchObject({
      result: { undoId: "suffix" },
      ids: [older.id],
    });
    expect(calls.unread).toHaveBeenLastCalledWith(older.id);
    const otherArticle = dom.element.querySelector('[data-message-id="new"]');
    if (!otherArticle) throw new Error("Missing other message");
    act(() => {
      otherArticle.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
    });
    expect(select.mock.calls.at(-1)).toEqual([older.id]);
    key(otherArticle, "r");
    expect(compose.mock.calls.at(-1)).toEqual([newer.id, "reply", false]);
    key(dom.element.querySelector('[data-message-id="old"]') ?? selected(), "r");
    expect(compose.mock.calls.at(-1)).toEqual([older.id, "reply", false]);
    render([newer, latest], latest.id);
    expect(select.mock.calls.at(-1)).toEqual([latest.id]);
    expect(selected().textContent).toContain("latest original body");
    expect(dom.element.querySelector('input[aria-label="Find in message"]')).toBeNull();
    render([{ ...latest, bodyHtml: "<p>body</p>" }], latest.id);
    for (const [key, shiftKey, tag] of [
      ["n", false, "ComposeNew"],
      ["N", true, "NewWindow"],
      [",", false, "OpenSettings"],
    ] as const) {
      const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
      const frameEvent = Object.assign(event, {
        key,
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey,
        view: null,
        detail: 0,
        which: 0,
        initUIEvent: vi.fn(),
        charCode: 0,
        code: "",
        isComposing: false,
        keyCode: 0,
        location: 0,
        repeat: false,
        DOM_KEY_LOCATION_STANDARD: 0,
        DOM_KEY_LOCATION_LEFT: 1,
        DOM_KEY_LOCATION_RIGHT: 2,
        DOM_KEY_LOCATION_NUMPAD: 3,
        getModifierState: () => false,
        initKeyboardEvent: vi.fn(),
      } satisfies Omit<KeyboardEvent, keyof Event>);
      act(() => {
        calls.frameKey(frameEvent);
      });
      expect(event.defaultPrevented).toBe(true);
      expect(calls.web.mock.calls.at(-1)).toEqual([tag, undefined]);
    }
  } finally {
    dom.dispose();
  }
});

it("keys typed into a form field inside the message frame do not run reader shortcuts", () => {
  // A jsdom iframe is another realm: its elements fail the app's `instanceof Element`.
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin");
  document.body.append(frame);
  const frameDoc = frame.contentDocument;
  if (!frameDoc) throw new Error("Missing message frame");
  const dom = testDom();
  vi.stubGlobal("Element", dom.window.Element);
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  frameDoc.body.innerHTML = "<p>Body</p><input>";
  const input = frameDoc.querySelector("input");
  if (!input) throw new Error("Missing frame input");
  expect(input instanceof Element).toBe(false);
  // EmailFrame forwards the frame document's keydown events to the reader.
  frameDoc.addEventListener("keydown", (event) => calls.frameKey(event));
  const compose = vi.fn();
  const press = (target: EventTarget, key: string) => {
    const event = new KeyboardEvent("keydown", {
      key,
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  };
  try {
    dom.render(
      createElement(
        I18nProvider,
        { i18n: setupI18n({ locale: "en", messages: { en: {} } }) },
        createElement(ThreadView, {
          messages: [{ ...message("only", 1), bodyHtml: "<p>Body</p>" }],
          selectedId: "only",
          single: false,
          onSelectMessage: vi.fn(),
          onComposeMessage: compose,
          onActionDone: vi.fn(),
          notify: vi.fn(),
        }),
      ),
    );
    expect(press(input, "r").defaultPrevented).toBe(false);
    expect(press(input, "f").defaultPrevented).toBe(false);
    expect(compose).not.toHaveBeenCalled();
    expect(dom.element.querySelector('input[aria-label="Find in message"]')).toBeNull();
    expect(press(frameDoc.body, "r").defaultPrevented).toBe(true);
    expect(compose).toHaveBeenLastCalledWith("only", "reply", false);
  } finally {
    dom.dispose();
    frame.remove();
  }
});
