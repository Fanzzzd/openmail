import {
  act,
  cloneElement,
  createElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { AsyncResult } from "effect/reactivity";
import { DEFAULT_PREFS } from "@openmail/core/schema";
import { afterAll, expect, it, vi } from "vitest";
import { testDom } from "../../test-support/test-dom";

vi.hoisted(() => vi.resetModules());
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => AsyncResult.success(DEFAULT_PREFS) }));
vi.mock("../../state/queries", () => ({ prefsAtom: "prefs" }));
vi.mock("../../ui/Menu", () => ({
  ContextMenuRoot: ({ children }: { children: ReactNode }) => children,
  // The list's scroller is the trigger's render element.
  ContextMenuTrigger: ({ children, render }: { children: ReactNode; render: ReactElement }) =>
    cloneElement(render, undefined, children),
}));
vi.mock("../../ui/Tip", () => ({
  Tip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../organize/ThreadActions", () => ({ ThreadMenuItems: () => null }));
vi.mock("./AccountBadge", () => ({ AccountBadge: () => null, useAccountName: () => "" }));
vi.mock("../ai/TriageChip", () => ({
  TriageChip: () => null,
  TriageSummary: () => null,
  TriageMenuItems: () => null,
}));
vi.mock("@base-ui/react/toggle", () => ({
  Toggle: ({ children }: { children: ReactNode }) => createElement("button", null, children),
}));
import { MessageList } from "./MessageList";
afterAll(() => {
  for (const module of [
    "@effect/atom-react",
    "../../state/queries",
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

const noop = vi.fn();
const props = (selectedId: string): ComponentProps<typeof MessageList> => ({
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
  selectedId,
  selectedIds: new Set([selectedId]),
  listRef: { current: null },
  selectionSource: "keyboard",
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
});

/**
 * Renders the list with the selected row at the bottom of a 600 px scroller, then shrinks the
 * scroller by 20 px as the footer's error line does. Returns how far the row's bottom ends up
 * below the scroller's bottom edge, and the scroller's final scrollTop.
 */
function clippedAfterFooterGrows(selectedId: string, scrollTop: (rowBottom: number) => number) {
  const dom = testDom();
  vi.stubGlobal("getComputedStyle", () => ({ fontSize: "16px" }));
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("removeEventListener", vi.fn());
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const resized: (() => void)[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resized.push(callback);
      }
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  let height = 600;
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => height,
  });
  try {
    const list = props(selectedId);
    dom.render(
      createElement(
        I18nProvider,
        { i18n: setupI18n({ locale: "en", messages: { en: {} } }) },
        createElement(MessageList, list),
      ),
    );
    const el = list.listRef.current;
    if (!el) throw new Error("Missing list");
    const rowHeight = parseFloat(
      el.querySelector<HTMLElement>('[data-id="m0"]')?.style.height ?? "0",
    );
    const index = Number(selectedId.slice(1));
    const rowBottom = (index + 1) * rowHeight;
    el.scrollTop = scrollTop(rowBottom);
    height = 580;
    act(() => {
      for (const callback of resized) callback();
    });
    return { clipped: rowBottom - (el.scrollTop + height), scrollTop: el.scrollTop };
  } finally {
    dom.dispose();
  }
}

it("keeps the selected last row in view when the footer's error line shrinks the list", () => {
  // End scrolled the last row into view: its bottom is the scroller's bottom.
  expect(clippedAfterFooterGrows("m39", (bottom) => bottom - 600).clipped).toBe(0);
});

it("leaves the scroll alone when the selected row was out of view", () => {
  // The selected row is far below the 600 px the list shows: shrinking the list moves nothing.
  expect(clippedAfterFooterGrows("m39", () => 0).scrollTop).toBe(0);
});
