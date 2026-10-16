import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { AsyncResult } from "effect/reactivity";
import { DEFAULT_LIST_FILTERS, DEFAULT_PREFS } from "@openmail/core/schema";
import { expect, it, vi } from "vitest";
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

const noop = vi.fn();
const render = (searchErrorAccounts: readonly string[]) =>
  renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n: setupI18n({ locale: "en", messages: { en: {} } }) },
      createElement(MessageList, {
        title: "Search",
        threads: [],
        loading: false,
        showAccount: true,
        searching: true,
        searchingServer: false,
        searchTruncated: false,
        searchErrorAccounts,
        searchReauthAccounts: [],
        searchInputInvalid: false,
        searchIgnored: [
          { accountId: "Work", operators: ["has:drive"] },
          { accountId: "Home", operators: ["has:drive"] },
        ],
        filters: DEFAULT_LIST_FILTERS,
        inLabel: false,
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
const skipped = (account: string) =>
  `${account}: the server can&#x27;t search with has:drive. OpenMail searched the server without it`;

// A failed server search has no server results, so saying the server skipped an operator
// right above "couldn't search the server" contradicts the failure.
it("drops the skipped-operator notice for an account whose server search failed", () => {
  const ok = render([]);
  expect(ok).toContain(skipped("Work"));
  expect(ok).toContain(skipped("Home"));
  const oneFailed = render(["Work"]);
  expect(oneFailed).toContain("Work couldn&#x27;t search the server.");
  expect(oneFailed).not.toContain(skipped("Work"));
  expect(oneFailed).toContain(skipped("Home"));
  const allFailed = render(["Work", "Home"]);
  expect(allFailed).not.toContain("searched the server without");
  expect(allFailed).not.toMatch(/<output[^>]*text-orange[^>]*><\/output>/);
});
