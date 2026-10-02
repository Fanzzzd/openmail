import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { AsyncResult } from "effect/reactivity";
import { DEFAULT_PREFS, LIST_DENSITIES, type Prefs } from "@openmail/core/schema";
import { expect, it, vi } from "vitest";
import type { ThreadSummary } from "../../shared/api";
const state = vi.hoisted((): { density: Prefs["messageListDensity"] } => ({ density: "default" }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => AsyncResult.success({ ...DEFAULT_PREFS, messageListDensity: state.density }),
}));
vi.mock("./state/queries", () => ({ prefsAtom: "prefs" }));
vi.mock("./components/ui/Menu", () => ({
  ContextMenuRoot: ({ children }: { children: ReactNode }) => children,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));
vi.mock("./components/ui/Tip", () => ({
  Tip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./components/ThreadActions", () => ({ ThreadMenuItems: () => null }));
vi.mock("./components/AccountBadge", () => ({ AccountBadge: () => null }));
vi.mock("./components/TriageChip", () => ({ TriageChip: () => null }));
import { MessageList } from "./components/MessageList";

it("each density renders its own height, preview lines and attachment indicator", () => {
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
          searchErrors: [],
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
          searchErrors: [],
          searchIgnored: ["label:work"],
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
    expect(markup).toContain("label:work");
    expect(markup).toContain("Some server predicates were omitted");
  }
});
