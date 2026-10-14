import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { AsyncResult } from "effect/reactivity";
import { DEFAULT_LIST_FILTERS, DEFAULT_PREFS } from "@openmail/core/schema";
import { describe, expect, it, vi } from "vitest";
import type { Filters } from "../../lib/view";
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => AsyncResult.success(DEFAULT_PREFS) }));
vi.mock("../../state/queries", () => ({ prefsAtom: "prefs" }));
vi.mock("../../ui/Menu", () => ({
  ContextMenuRoot: ({ children }: { children: ReactNode }) => children,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));
// The tooltip text becomes an attribute, so the test can read it from the markup.
vi.mock("../../ui/Tip", () => ({
  Tip: ({ children, label }: { children: ReactNode; label: string }) =>
    createElement("span", { "data-tip": label }, children),
}));
vi.mock("../organize/ThreadActions", () => ({ ThreadMenuItems: () => null }));
vi.mock("./AccountBadge", () => ({ AccountBadge: () => null, useAccountName: () => "" }));
vi.mock("../ai/TriageChip", () => ({
  TriageChip: () => null,
  TriageSummary: () => null,
  TriageMenuItems: () => null,
}));
import { MessageList } from "./MessageList";
import { pressQuickFilter, quickFilterOn } from "./quick-filters";

const chosen: Filters = { ...DEFAULT_LIST_FILTERS, unread: true, starred: true, inInbox: true };

describe("quick filters", () => {
  it("sub-chips only count as on while the switch is on", () => {
    expect(quickFilterOn({ ...chosen, enabled: true }, "unread")).toBe(true);
    expect(quickFilterOn({ ...chosen, enabled: false }, "unread")).toBe(false);
    expect(quickFilterOn({ ...chosen, enabled: true }, "important")).toBe(false);
  });

  it("a press with the switch off turns it on with only the pressed chip", () => {
    expect(pressQuickFilter({ ...chosen, enabled: false }, "important", true)).toEqual({
      enabled: true,
      unread: false,
      starred: false,
      important: true,
      inInbox: false,
    });
  });

  it("a press with the switch on toggles that chip and keeps the rest", () => {
    expect(pressQuickFilter({ ...chosen, enabled: true }, "unread", false)).toEqual({
      ...chosen,
      enabled: true,
      unread: false,
    });
  });

  it("the chips render the state the list uses", () => {
    const i18n = setupI18n({ locale: "en", messages: { en: {} } });
    const noop = vi.fn();
    const render = (filters: Filters) =>
      renderToStaticMarkup(
        createElement(
          I18nProvider,
          { i18n },
          createElement(MessageList, {
            title: "Inbox",
            threads: [],
            loading: true,
            showAccount: false,
            searching: false,
            searchingServer: false,
            searchTruncated: false,
            searchErrorAccounts: [],
            searchReauthAccounts: [],
            searchInputInvalid: false,
            searchIgnored: [],
            filters,
            inLabel: true,
            folderActions: null,
            onFilters: noop,
            labels: new Map(),
            selectedId: null,
            selectedIds: new Set<string>(),
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
          }),
        ),
      );
    const pressed = (markup: string) =>
      [...markup.matchAll(/aria-pressed="true"[^>]*>([^<]+)</g)].map((match) => match[1]);
    const off = render({ ...chosen, enabled: false });
    expect(pressed(off)).toEqual([]);
    expect(off).toContain('data-tip="Turn on quick filters"');
    const on = render({ ...chosen, enabled: true });
    expect(pressed(on)).toEqual(["Quick filters", "Unread", "Starred", "In Inbox"]);
    expect(on).toContain('data-tip="Turn off quick filters"');
  });
});
