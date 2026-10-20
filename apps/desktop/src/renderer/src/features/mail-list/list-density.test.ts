import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { AsyncResult } from "effect/reactivity";
import { DEFAULT_PREFS, LIST_DENSITIES, type Prefs } from "@openmail/core/schema";
import { expect, it, vi } from "vitest";
import type { ThreadSummary } from "../../../../shared/api";
const state = vi.hoisted((): { density: Prefs["messageListDensity"] } => ({ density: "default" }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => AsyncResult.success({ ...DEFAULT_PREFS, messageListDensity: state.density }),
}));
vi.mock("../../state/queries", () => ({ prefsAtom: "prefs" }));
vi.mock("../../ui/Menu", () => ({
  ContextMenuRoot: ({ children }: { children: ReactNode }) => children,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
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
import { MessageList } from "./MessageList";

it("each density keeps local results and shows search-specific errors", () => {
  const thread: ThreadSummary = {
    id: "one",
    accountId: "gmail:me",
    threadId: "thread",
    subject: "Subject",
    from: { name: "Sender", address: "sender@example.com" },
    date: 0,
    snippet: "Unique preview body",
    labels: [],
    isUnread: true,
    isStarred: false,
    hasAttachments: true,
    attachmentNames: ["visible.pdf"],
    threadCount: 1,
    participants: [],
  };
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  const noop = vi.fn();
  for (const density of ["dense", "compact", "default", "expanded"] as const) {
    state.density = density;
    const markup = renderToStaticMarkup(
      createElement(
        I18nProvider,
        { i18n },
        createElement(MessageList, {
          title: "Inbox",
          threads: [thread],
          loading: false,
          showAccount: false,
          searching: false,
          searchingServer: false,
          searchTruncated: false,
          searchErrorAccounts: ["outlook:me"],
          searchInputInvalid: false,
          searchReauthAccounts: density === "dense" ? ["outlook:me"] : [],
          searchIgnored: [],
          filters: {
            enabled: false,
            unread: false,
            starred: false,
            important: false,
            inInbox: false,
          },
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
    expect(markup).toContain(`height:${LIST_DENSITIES[density].height}px`);
    expect(markup).toContain("Subject");
    expect(markup).toContain(
      density === "dense"
        ? "Showing results from this Mac. outlook:me must sign in again to search the server."
        : "Showing results from this Mac. outlook:me couldn&#x27;t search the server.",
    );
    expect(markup).not.toContain("The server rejected this change.");
    expect(markup.includes("Unique preview body")).toBe(LIST_DENSITIES[density].previewLines > 0);
    expect(markup.includes("visible.pdf")).toBe(LIST_DENSITIES[density].attachments);
    expect(markup.includes("lucide-paperclip")).toBe(true);
    expect(markup.includes("line-clamp-2")).toBe(density === "expanded");
  }
});

it("unknown-size notices only appear for real size conditions, while omitted operators remain visible", () => {
  state.density = "default";
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  const noop = vi.fn();
  for (const [search, sizeNotice] of [
    ["label:work", false],
    ['subject:"larger:1M"', false],
    ['"smaller:1M"', false],
    ["larger:1M", true],
    ["smaller:1M", true],
    ["-(from:bob larger:1M)", true],
    [Array.from({ length: 1000 }, () => "larger:1M").join(" OR "), false],
  ] satisfies [string, boolean][]) {
    const markup = renderToStaticMarkup(
      createElement(
        I18nProvider,
        { i18n },
        createElement(MessageList, {
          title: "Inbox",
          threads: [],
          loading: false,
          showAccount: false,
          searching: true,
          searchingServer: false,
          searchTruncated: false,
          searchErrorAccounts: [],
          searchReauthAccounts: [],
          searchInputInvalid: false,
          searchIgnored: [{ accountId: "a1", operators: ["label:work"] }],
          accountLabel: (id: string) => (id === "a1" ? "Work Gmail" : id),
          searchQuery: { search },
          filters: {
            enabled: false,
            unread: false,
            starred: false,
            important: false,
            inInbox: false,
          },
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
    expect(markup.includes("Unknown message sizes are left unfiltered.")).toBe(sizeNotice);
    expect(markup).toContain(
      "Work Gmail: the server can&#x27;t search with label:work. OpenMail searched the server without it and applied it to the results here.",
    );
  }
});

it("an attachment chip on a selected row keeps 4.5:1 contrast in dark mode", () => {
  state.density = "default";
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  const noop = vi.fn();
  const thread: ThreadSummary = {
    id: "one",
    accountId: "gmail:me",
    threadId: "thread",
    subject: "Invite",
    from: { name: "Sender", address: "sender@example.com" },
    date: 0,
    snippet: "",
    labels: [],
    isUnread: false,
    isStarred: false,
    hasAttachments: true,
    attachmentNames: ["invite.ics"],
    threadCount: 1,
    participants: [],
  };
  const chip = (selected: boolean) => {
    const markup = renderToStaticMarkup(
      createElement(
        I18nProvider,
        { i18n },
        createElement(MessageList, {
          title: "Inbox",
          threads: [thread],
          loading: false,
          showAccount: false,
          searching: false,
          searchingServer: false,
          searchTruncated: false,
          searchErrorAccounts: [],
          searchInputInvalid: false,
          searchReauthAccounts: [],
          searchIgnored: [],
          filters: {
            enabled: false,
            unread: false,
            starred: false,
            important: false,
            inInbox: false,
          },
          inLabel: false,
          folderActions: null,
          onFilters: noop,
          labels: new Map(),
          selectedId: selected ? "one" : null,
          selectedIds: new Set<string>(selected ? ["one"] : []),
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
    return /<span class="([^"]*)">invite\.ics<\/span>/.exec(markup)?.[1] ?? "";
  };
  // Dark mode: #a3a3a3 on the chip's #3f3f3f over a selected row is 4.17:1; neutral-300 is 7:1.
  expect(chip(true)).toContain("dark:text-neutral-300");
  expect(chip(false)).not.toContain("dark:text-neutral-300");
});
