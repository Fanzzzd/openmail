import { createElement, type ReactNode, type ComponentProps } from "react";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { AsyncResult } from "effect/reactivity";
import { DEFAULT_PREFS } from "@openmail/core/schema";
import { afterAll, expect, it, vi } from "vitest";
import { testDom } from "../../test-support/test-dom";

const rows = vi.hoisted(() => {
  vi.resetModules();
  return { rendered: 0 };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => AsyncResult.success(DEFAULT_PREFS) }));
vi.mock("../../state/queries", () => ({ prefsAtom: "prefs" }));
vi.mock("./message-swipe-hook", () => ({
  useMessageSwipe: () => {
    rows.rendered++;
    return { distance: 0, action: "none" };
  },
}));
vi.mock("../../ui/Menu", () => ({
  ContextMenuRoot: ({ children }: { children: ReactNode }) => children,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));
vi.mock("../../ui/Tip", () => ({
  Tip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../organize/ThreadActions", () => ({ ThreadMenuItems: () => null }));
vi.mock("./AccountBadge", () => ({ AccountBadge: () => null }));
vi.mock("../ai/TriageChip", () => ({ TriageChip: () => null }));
vi.mock("@base-ui/react/toggle", () => ({
  Toggle: ({ children }: { children: ReactNode }) => createElement("button", null, children),
}));
import { MessageList } from "./MessageList";
afterAll(() => {
  for (const module of [
    "@effect/atom-react",
    "../../state/queries",
    "./message-swipe-hook",
    "../../ui/Menu",
    "../../ui/Tip",
    "../organize/ThreadActions",
    "./AccountBadge",
    "../ai/TriageChip",
    "@base-ui/react/toggle",
  ])
    vi.doUnmock(module);
  vi.resetModules();
});

it("selection renders only changed visible rows and calls the latest parent handler", () => {
  const dom = testDom();
  vi.stubGlobal("getComputedStyle", () => ({ fontSize: "16px" }));
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("removeEventListener", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  const noop = vi.fn();
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  const props: ComponentProps<typeof MessageList> = {
    title: "Inbox",
    loading: false,
    showAccount: false,
    searching: false,
    searchingServer: false,
    searchTruncated: false,
    searchErrorAccounts: [],
    searchReauthAccounts: [],
    searchInputInvalid: false,
    searchIgnored: [],
    threads: Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`,
      accountId: "gmail:test",
      threadId: `t${i}`,
      subject: `Message ${i}`,
      from: { name: "Alice", address: "alice@example.com" },
      date: 1,
      snippet: "Report",
      labels: [],
      isUnread: false,
      isStarred: false,
      hasAttachments: false,
      threadCount: 1,
      participants: [],
    })),
    filters: { enabled: false, unread: false, starred: false, important: false, inInbox: false },
    inLabel: false,
    folderActions: null,
    onFilters: noop,
    labels: new Map(),
    selectedId: "m0",
    selectedIds: new Set(["m0"]),
    listRef: { current: null },
    selectionSource: "mouse",
    onSelect: noop,
    onEndReached: noop,
    rowActions: {
      mailbox: "inbox",
      labels: [],
      stateOf: () => null,
      onOp: noop,
      onSwipeOp: noop,
      onCompose: noop,
      onOpenWindow: noop,
      onSnooze: noop,
      onFilter: noop,
    },
  };
  try {
    dom.render(createElement(I18nProvider, { i18n }, createElement(MessageList, props)));
    const initial = rows.rendered;
    const selected = vi.fn();
    dom.render(
      createElement(
        I18nProvider,
        { i18n },
        createElement(MessageList, {
          ...props,
          selectedId: "m1",
          selectedIds: new Set(["m1"]),
          onSelect: selected,
          rowActions: { ...props.rowActions },
        }),
      ),
    );
    const changed = rows.rendered - initial;
    expect(initial).toBeGreaterThan(8);
    expect(changed).toBeLessThanOrEqual(3);
    const row = dom.element.querySelector<HTMLButtonElement>('[data-id="m5"]');
    row?.dispatchEvent(
      Object.assign(new dom.window.Event("click", { bubbles: true }), {
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
      }),
    );
    expect(selected).toHaveBeenCalledWith("m5", { toggle: false, range: false });
  } finally {
    dom.dispose();
  }
});
