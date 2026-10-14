// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { type Account, type SyncProgress, type SyncState } from "@openmail/core/schema";
import { builtPalette } from "../test-support/test-styles";
import { avatarColor } from "../lib/format";
import { MessageList } from "../features/mail-list/MessageList";
import { ThreadView } from "../features/reader/ThreadView";
import { Sidebar } from "../features/sidebar/Sidebar";
import { MailStatusNotice } from "../features/sync-status/MailStatusNotice";
import { BatchActions } from "../features/mail-list/BatchActions";
import {
  fixture,
  account,
  message,
  thread,
  localized,
  listProps,
  registerAccessibilityHooks,
} from "../test-support/accessibility-fixtures";

vi.hoisted(() => {
  vi.resetModules();
});
vi.mock("@effect/atom-react", async (original) =>
  (await import("../test-support/accessibility-fixtures")).atomReactMock(await original()),
);
vi.mock(
  "../state/queries",
  async () => (await import("../test-support/accessibility-fixtures")).queriesMock,
);
vi.mock(
  "../state/mutations",
  async () => (await import("../test-support/accessibility-fixtures")).mutationsMock,
);
vi.mock("../state/downloads", async () =>
  (await import("../test-support/accessibility-fixtures")).downloadsMock(),
);
vi.mock("../state/remote-access", async () =>
  (await import("../test-support/accessibility-fixtures")).remoteAccessMock(),
);
vi.mock(
  "../state/rpc",
  async () => (await import("../test-support/accessibility-fixtures")).rpcMock,
);
vi.mock(
  "../state/mail",
  async () => (await import("../test-support/accessibility-fixtures")).mailMock,
);

registerAccessibilityHooks(import.meta.url);

it("marks the selected row and the active message at 3:1 non-text contrast in both themes", () => {
  const palette = builtPalette();
  render(
    localized(
      h(
        "main",
        null,
        h(MessageList, listProps({ selectedId: thread.id, selectedIds: new Set([thread.id]) })),
        h(ThreadView, {
          messages: [message, { ...message, id: `${message.id}-2`, date: message.date + 1 }],
          selectedId: message.id,
          single: false,
          notify: vi.fn(),
        }),
      ),
    ),
  );
  const bar = document.querySelector("[data-selection-bar]");
  const active = screen.getByRole("article", { name: /^Selected message/ });
  expect(bar).toBeTruthy();
  for (const theme of ["light", "dark"] as const) {
    expect(palette.indicator(bar!, "background-color", theme), theme).toBeGreaterThanOrEqual(3);
    expect(palette.indicator(active, "border-color", theme), theme).toBeGreaterThanOrEqual(3);
  }
});

it("keeps list notices, the batch count badge, empty list text and search marks at WCAG AA", () => {
  const palette = builtPalette();
  const readable = (element: Element, name: string) => {
    for (const theme of ["light", "dark"] as const)
      expect(palette.contrast(element, theme), `${name} (${theme})`).toBeGreaterThanOrEqual(4.5);
  };
  const failing = { running: false, errors: [`${account.id}: Forbidden`], lastFinishedAt: 1 };
  render(
    localized(
      h(
        MessageList,
        listProps({
          notice: h(MailStatusNotice, {
            accounts: [account],
            space: [account],
            online: false,
            syncState: failing,
            accountIssues: true,
            onReauth: vi.fn(),
            onFocusList: vi.fn(),
          }),
          selectionBar: h(BatchActions, {
            rows: [thread, { ...thread, id: "second" }],
            accounts: [account],
            labels: [],
            mailbox: "inbox",
            onOp: vi.fn(),
            labelPicker: false,
            onLabelPicker: vi.fn(),
            canLoadMore: false,
            moreNotLoaded: null,
          }),
        }),
      ),
    ),
  );
  readable(
    screen.getByText("You're offline. Mail syncs again when you reconnect.", { selector: "p" }),
    "offline notice",
  );
  readable(screen.getByText("Couldn't sync me@example.com.", { selector: "p" }), "sync failure");
  readable(screen.getByRole("button", { name: "Try again" }), "Try again");
  readable(screen.getByText("2", { exact: true }), "batch count badge");
  cleanup();

  render(
    localized(
      h(
        MessageList,
        listProps({
          threads: [],
          emptyActions: {
            onClearSearch: vi.fn(),
            onCompose: vi.fn(),
            onSync: vi.fn(),
            syncing: false,
          },
        }),
      ),
    ),
  );
  readable(screen.getByText("You're all caught up. Your Inbox is empty."), "empty list text");
  readable(screen.getByRole("button", { name: "Sync now" }), "Sync now");
  cleanup();

  const match = {
    source: "attachment" as const,
    messageId: message.id,
    attachmentName: "agenda.pdf",
    attachmentIndex: 0,
    snippet: "budget review",
    highlights: [{ start: 0, end: 6 }],
  };
  render(
    localized(
      h(
        MessageList,
        listProps({ searching: true, threads: [{ ...thread, searchMatches: [match] }] }),
      ),
    ),
  );
  const mark = screen.getByRole("option").querySelector("mark");
  if (!mark) throw new Error("Missing search mark");
  readable(mark, "search mark");
  cleanup();

  // The reader text's focus ring is drawn inside its scroll box, where it stays visible.
  render(
    localized(
      h(ThreadView, { messages: [message], selectedId: message.id, single: true, notify: vi.fn() }),
    ),
  );
  const ring = "focus-visible:-outline-offset-2";
  expect(document.querySelector("[data-reader-text]")?.classList.contains(ring)).toBe(true);
  expect(
    palette.declarations(ring).some((decl) => /^outline-offset: calc\(.*-1\)/.test(decl)),
  ).toBe(true);
});

it("keeps every sidebar text at WCAG AA in light and dark themes", () => {
  // jsdom cannot run axe's color-contrast rule, so this reads the shipped CSS instead.
  const palette = builtPalette();
  // One account per avatar color, so every initials badge is measured.
  const colors = new Map<string, Account>();
  for (let index = 0; colors.size < 9 && index < 1000; index++) {
    const email = `person${index}@example.com`;
    colors.set(avatarColor(email), {
      ...account,
      id: `gmail:${email}`,
      email,
      needsReauth: index === 0,
    });
  }
  const accounts = [...colors.values()];
  expect(accounts).toHaveLength(9);
  fixture.values.set("labelsAtom", [
    { accountId: accounts[0]?.id ?? "", id: "Label_work", name: "Work", color: "#16a765" },
    { accountId: accounts[0]?.id ?? "", id: "Label_plain", name: "Receipts", color: null },
  ]);
  const sidebar = (syncState: SyncState, progress: SyncProgress | null) =>
    localized(
      h(Sidebar, {
        view: { space: "all", mailbox: "inbox" },
        onView: vi.fn(),
        onSpace: vi.fn(),
        onEditProfile: vi.fn(),
        accounts,
        profiles: [{ id: "work", name: "Work", icon: "W", color: "blue", position: 0 }],
        unread: Object.fromEntries(accounts.map((item, index) => [item.id, index + 1])),
        syncState,
        progress,
        proposals: 2,
        onAddAccount: vi.fn(),
        onCompose: vi.fn(),
        onReauth: vi.fn(),
        onProposals: vi.fn(),
        onSettings: vi.fn(),
      }),
    );
  const view = render(
    sidebar({ running: false, errors: [`${accounts[0]?.id}: Offline`], lastFinishedAt: 1 }, null),
  );
  const failures = () => {
    const found: string[] = [];
    for (const element of view.container.querySelectorAll("*")) {
      const text = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join("")
        .trim();
      if (!text) continue;
      for (const theme of ["light", "dark"] as const) {
        const ratio = palette.contrast(element, theme);
        if (ratio < 4.5) found.push(`${theme} ${ratio.toFixed(2)} "${text}" ${element.className}`);
      }
    }
    return found;
  };
  expect(failures()).toEqual([]);
  view.rerender(
    sidebar(
      { running: true, errors: [], lastFinishedAt: 1 },
      { accountId: accounts[1]?.id ?? "", fetched: 40, total: 100 },
    ),
  );
  expect(failures()).toEqual([]);
});
