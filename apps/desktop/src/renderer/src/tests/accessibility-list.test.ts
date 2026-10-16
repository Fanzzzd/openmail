// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createElement as h, createRef, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Account } from "@openmail/core/schema";
import { MessageList } from "../features/mail-list/MessageList";
import { Overview } from "../features/overview/Overview";
import { Sidebar } from "../features/sidebar/Sidebar";
import { MailStatusNotice } from "../features/sync-status/MailStatusNotice";
import { BatchActions } from "../features/mail-list/BatchActions";
import { I18nProvider } from "@lingui/react";
import { catalogI18n } from "../test-support/catalog-i18n";
import { UndoHistory } from "../features/undo/UndoHistory";
import {
  fixture,
  account,
  message,
  thread,
  localized,
  audit,
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

it("names a row's label chips and AI suggestion, keeps the chip out of the tab order and decides it from the menu", async () => {
  fixture.values.set("AiSettings", {
    keyConfigured: true,
    accounts: [{ accountId: account.id, allowed: true, autoTriage: true }],
  });
  fixture.values.set("AiTriage", {
    status: "pending",
    action: { kind: "archive" },
    reason: "No action needed",
    model: "Test model",
  });
  const work = { accountId: account.id, id: "Label_work", name: "Work", color: null };
  render(
    localized(
      h(
        "main",
        null,
        h(
          MessageList,
          listProps({
            threads: [{ ...thread, labels: ["INBOX", "Label_work"] }],
            labels: new Map([[`${account.id}/Label_work`, work]]),
          }),
        ),
      ),
    ),
  );
  const option = screen.getByRole("option");
  expect(option.textContent).toContain("Work");
  expect(screen.getByRole("option", { name: /, Work, AI suggestion: Archive$/ })).toBe(option);
  const chip = option.parentElement?.querySelector("button:not([role])");
  expect(chip?.getAttribute("tabindex")).toBe("-1");
  await audit();
  option.focus();
  fireEvent.keyDown(option, { key: "F10", shiftKey: true });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Accept AI suggestion: Archive" }));
  expect(fixture.decide).toHaveBeenCalledWith(
    expect.objectContaining({ payload: { id: thread.id, accept: true } }),
  );
  fixture.values.set("AiTriage", null);
  fixture.values.delete("AiSettings");
});

it("names a row's message count, attachments and account, with the account initial on screen", async () => {
  render(
    localized(
      h(MessageList, {
        title: "All Mail",
        threads: [{ ...thread, threadCount: 3, hasAttachments: true }],
        loading: false,
        exhausted: true,
        showAccount: true,
        searching: false,
        searchingServer: false,
        searchTruncated: false,
        searchErrorAccounts: [],
        searchReauthAccounts: [],
        searchInputInvalid: false,
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
        onFilters: vi.fn(),
        labels: new Map(),
        selectedId: null,
        selectedIds: new Set<string>(),
        listRef: createRef<HTMLDivElement>(),
        selectionSource: "mouse",
        onSelect: vi.fn(),
        onEndReached: vi.fn(),
        rowActions: {
          mailbox: "all",
          labels: [],
          stateOf: () => null,
          onOp: vi.fn(),
          onSwipeOp: vi.fn(),
          onCompose: vi.fn(),
          onOpenWindow: vi.fn(),
          onSnooze: vi.fn(),
          onFilter: vi.fn(),
        },
      }),
    ),
  );
  const row = screen.getByRole("option", {
    name: /^Alice, Meeting agenda, .+, 3 messages, Has attachments, me@example\.com$/,
  });
  // The account colour carries its initial, and the full address on hover.
  expect(within(row).getByTitle(account.email).textContent).toBe("M");
  await audit();
});

it("keeps a keyboard entry into the virtual list when selection is outside the visible window", () => {
  render(
    localized(
      h(MessageList, {
        title: "Inbox",
        threads: Array.from({ length: 100 }, (_, index) => ({ ...thread, id: `message-${index}` })),
        loading: false,
        exhausted: true,
        showAccount: false,
        searching: false,
        searchingServer: false,
        searchTruncated: false,
        searchErrorAccounts: [],
        searchReauthAccounts: [],
        searchInputInvalid: false,
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
        onFilters: vi.fn(),
        labels: new Map(),
        selectedId: "message-99",
        selectedIds: new Set(["message-99"]),
        listRef: createRef<HTMLDivElement>(),
        selectionSource: "mouse",
        onSelect: vi.fn(),
        onEndReached: vi.fn(),
        rowActions: {
          mailbox: "inbox",
          labels: [],
          stateOf: () => ({
            provider: "gmail" as const,
            isUnread: false,
            isStarred: false,
            isImportant: false,
            labels: ["INBOX"],
          }),
          onOp: vi.fn(),
          onSwipeOp: vi.fn(),
          onCompose: vi.fn(),
          onOpenWindow: vi.fn(),
          onSnooze: vi.fn(),
          onFilter: vi.fn(),
        },
      }),
    ),
  );
  const options = screen.getAllByRole("option");
  expect(options.length).toBeLessThan(100);
  expect(options.filter((option) => option.tabIndex === 0)).toHaveLength(1);
  expect(options[0]?.getAttribute("aria-setsize")).toBe("100");
});

it("only announces entering and clearing sync failure, with a stable status role", () => {
  const sidebar = (syncState: Parameters<typeof Sidebar>[0]["syncState"]) =>
    localized(
      h(Sidebar, {
        view: { space: "all", mailbox: "inbox" },
        onView: vi.fn(),
        onSpace: vi.fn(),
        onEditProfile: vi.fn(),
        accounts: [account],
        profiles: [],
        unread: {},
        syncState,
        progress: null,
        proposals: 0,
        onAddAccount: vi.fn(),
        onCompose: vi.fn(),
        onReauth: vi.fn(),
        onProposals: vi.fn(),
        onSettings: vi.fn(),
      }),
    );
  const view = render(sidebar({ running: false, errors: [], lastFinishedAt: 1000 }));
  const footer = view.container.querySelector("footer");
  if (!footer) throw new Error("Missing sidebar footer");
  const status = within(footer).getByRole("status");
  expect(status.textContent).toBe("");
  view.rerender(sidebar({ running: true, errors: [], lastFinishedAt: 1000 }));
  view.rerender(sidebar({ running: false, errors: [], lastFinishedAt: 121000 }));
  expect(status.textContent).toBe("");
  view.rerender(sidebar({ running: false, errors: ["Offline"], lastFinishedAt: 121000 }));
  expect(within(footer).getByRole("status")).toBe(status);
  expect(status.textContent).toBe("Sync failed");
  view.rerender(sidebar({ running: true, errors: ["Offline", "Offline"], lastFinishedAt: 121000 }));
  expect(status.textContent).toBe("Sync failed");
  view.rerender(sidebar({ running: false, errors: [], lastFinishedAt: 241000 }));
  expect(status.textContent).toBe("Syncing normally");
  view.rerender(sidebar({ running: false, errors: [], lastFinishedAt: 361000 }));
  expect(status.textContent).toBe("Syncing normally");
  expect(within(footer).queryByRole("alert")).toBeNull();
});

it("the list notice counts every account's sync errors but names only the open space's", () => {
  const work: Account = { ...account, id: "gmail:work", email: "work@example.com", profileId: "w" };
  const expiredElsewhere: Account = {
    ...work,
    id: "gmail:old",
    email: "old@example.com",
    needsReauth: true,
  };
  const notice = (errors: string[], online = true) =>
    localized(
      h(MailStatusNotice, {
        accounts: [work, expiredElsewhere, account],
        space: [work],
        online,
        syncState: { running: false, lastFinishedAt: 1, errors },
        accountIssues: true,
        onReauth: vi.fn(),
        onFocusList: vi.fn(),
      }),
    );
  // An expired account in another space is its own notice there, not a sync failure here.
  const view = render(notice(["gmail:old: Sign in again"]));
  expect(view.container.textContent).toBe("");
  // Visible text only: the status regions also hold "Sync failed".
  const shown = (text: string) => screen.getByText(text, { selector: "p" });
  view.rerender(notice(["gmail:old: Sign in again", "gmail:work: Forbidden"]));
  expect(shown("Couldn't sync work@example.com.")).toBeTruthy();
  view.rerender(notice(["gmail:me: Forbidden"]));
  expect(shown("Sync failed")).toBeTruthy();
  // Offline joins the account notices instead of hiding them.
  view.rerender(notice(["gmail:work: Forbidden"], false));
  expect(shown("You're offline. Mail syncs again when you reconnect.")).toBeTruthy();
  expect(shown("Couldn't sync work@example.com.")).toBeTruthy();
  // Failures are polite statuses, never assertive alerts.
  expect(screen.queryByRole("alert")).toBeNull();
});

it("audits the narrow batch bar, whose count badge leaves the full count to screen readers", async () => {
  const user = userEvent.setup();
  const onOp = vi.fn();
  function Harness() {
    const [picker, setPicker] = useState(false);
    return localized(
      h(
        "main",
        null,
        h(BatchActions, {
          rows: [thread, { ...thread, id: "second", isUnread: true }],
          accounts: [account],
          labels: [],
          mailbox: "inbox",
          onOp,
          labelPicker: picker,
          onLabelPicker: setPicker,
          canLoadMore: true,
          moreNotLoaded: 3,
          everyLoaded: true,
        }),
      ),
    );
  }
  render(h(Harness));
  const badge = screen.getByText("2", { exact: true });
  expect(badge.getAttribute("aria-hidden")).toBe("true");
  expect(screen.getByText("2 selected (loaded)")).toBeTruthy();
  expect(screen.getByText("3 more not loaded")).toBeTruthy();
  for (const name of ["Archive", "Delete", "Mark as read", "Star", "Batch actions"])
    expect(screen.getByRole("button", { name })).toBeTruthy();
  await audit();
  const menuButton = screen.getByRole("button", { name: "Batch actions" });
  menuButton.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("menuitem", { name: /^Archive/ });
  await audit();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(menuButton));
});

it("the batch bar says more messages are not loaded when the local count has none left", () => {
  render(
    localized(
      h(BatchActions, {
        rows: [thread, { ...thread, id: "second" }],
        accounts: [account],
        labels: [],
        mailbox: "inbox",
        onOp: vi.fn(),
        labelPicker: false,
        onLabelPicker: vi.fn(),
        canLoadMore: true,
        moreNotLoaded: 0,
        everyLoaded: true,
      }),
    ),
  );
  expect(screen.getByText("More messages not loaded")).toBeTruthy();
  expect(screen.queryByText(/more not loaded/)).toBeNull();
});

// In Russian the note ran on after the count in one truncated line and was cut to "…За…".
it("the batch bar puts the not-loaded note on its own line with the full text in a title", async () => {
  const { i18n } = await catalogI18n("ru");
  render(
    h(
      I18nProvider,
      { i18n },
      h(BatchActions, {
        rows: [thread, { ...thread, id: "second" }],
        accounts: [account],
        labels: [],
        mailbox: "inbox",
        onOp: vi.fn(),
        labelPicker: false,
        onLabelPicker: vi.fn(),
        canLoadMore: true,
        moreNotLoaded: 0,
        everyLoaded: true,
      }),
    ),
  );
  const note = screen.getByText("Загружены не все сообщения");
  const summary = note.parentElement;
  const count = summary?.firstElementChild;
  // Two lines, each truncating on its own.
  expect(count).not.toBe(note);
  expect(count?.contains(note)).toBe(false);
  expect(summary?.className).toContain("flex-col");
  expect(note.className).toContain("truncate");
  expect(count?.className).toContain("truncate");
  expect(summary?.getAttribute("title")).toBe(
    `${count?.textContent ?? ""}\nЗагружены не все сообщения`,
  );
});

// A hand-picked selection said "(loaded)" and listed the messages not loaded, as if every
// loaded conversation were selected.
it("the batch bar counts a hand-picked selection without the loaded notes", () => {
  render(
    localized(
      h(BatchActions, {
        rows: [thread, { ...thread, id: "second" }],
        accounts: [account],
        labels: [],
        mailbox: "inbox",
        onOp: vi.fn(),
        labelPicker: false,
        onLabelPicker: vi.fn(),
        canLoadMore: true,
        moreNotLoaded: 3,
        everyLoaded: false,
      }),
    ),
  );
  expect(screen.getByText("2 selected")).toBeTruthy();
  expect(screen.queryByText(/loaded/)).toBeNull();
});

it("moves focus from Sync now to the syncing status in an empty list", async () => {
  const user = userEvent.setup();
  const onSync = vi.fn();
  const emptyActions = {
    onClearSearch: vi.fn(),
    onCompose: vi.fn(),
    onSync,
    syncing: false,
  };
  const view = render(
    localized(h("main", null, h(MessageList, listProps({ threads: [], emptyActions })))),
  );
  const sync = screen.getByRole("button", { name: "Sync now" });
  sync.focus();
  await user.keyboard("{Enter}");
  expect(onSync).toHaveBeenCalledTimes(1);
  view.rerender(
    localized(
      h(
        "main",
        null,
        h(
          MessageList,
          listProps({ threads: [], emptyActions: { ...emptyActions, syncing: true } }),
        ),
      ),
    ),
  );
  expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
  const status = screen.getByText("Syncing mail…");
  await waitFor(() => expect(document.activeElement).toBe(status));
  await audit();
});

it("a server search in flight hides No more messages until it finishes", () => {
  const list = (searchingServer: boolean) =>
    localized(h("main", null, h(MessageList, listProps({ searching: true, searchingServer }))));
  const view = render(list(true));
  expect(screen.getByText("Searching server…", { selector: "p" })).toBeTruthy();
  expect(screen.queryByText("No more messages")).toBeNull();
  view.rerender(list(false));
  expect(screen.queryByText("Searching server…")).toBeNull();
  expect(screen.getByText("No more messages")).toBeTruthy();
});

it("an unusable search names its limit instead of asking to simplify", () => {
  const view = render(
    localized(
      h("main", null, h(MessageList, listProps({ searching: true, searchInputInvalid: "terms" }))),
    ),
  );
  expect(screen.getByRole("alert").textContent).toBe(
    "Search can use at most 256 words and operators. Remove some.",
  );
  view.rerender(
    localized(
      h("main", null, h(MessageList, listProps({ searching: true, searchInputInvalid: "depth" }))),
    ),
  );
  expect(screen.getByRole("alert").textContent).toBe(
    "Search groups can nest at most 32 levels deep. Remove some parentheses.",
  );
});

it("an empty server search shows no empty state until the server answers", () => {
  const list = (searchingServer: boolean) =>
    localized(
      h("main", null, h(MessageList, listProps({ threads: [], searching: true, searchingServer }))),
    );
  const view = render(list(true));
  expect(screen.queryByText("No matching messages")).toBeNull();
  view.rerender(list(false));
  expect(screen.getByText("No matching messages")).toBeTruthy();
  expect(document.querySelector("output.sr-only[aria-live='polite']")?.textContent).toBe(
    "No results",
  );
});

it("one persistent status region announces search progress and the result count", () => {
  const list = (overrides: Partial<Parameters<typeof MessageList>[0]>) =>
    localized(h("main", null, h(MessageList, listProps(overrides))));
  const view = render(list({ searching: false }));
  const region = document.querySelector("output.sr-only[aria-live='polite']");
  expect(region?.textContent).toBe("");
  view.rerender(list({ searching: true, searchingServer: true }));
  expect(document.querySelector("output.sr-only[aria-live='polite']")).toBe(region);
  expect(region?.textContent).toBe("Searching server…");
  view.rerender(list({ searching: true, threads: [thread, { ...thread, id: "two" }] }));
  expect(region?.textContent).toBe("2 results");
  view.rerender(list({ searching: true, exhausted: false }));
  expect(region?.textContent).toBe("More than 1 result");
});

it("audits list notices, announces offline and sync failure once and keeps focus after Try again", async () => {
  const user = userEvent.setup();
  const notice = (
    online: boolean,
    syncState: Parameters<typeof MailStatusNotice>[0]["syncState"],
  ) =>
    localized(
      h(
        "main",
        null,
        h(
          "section",
          { "aria-label": "Inbox" },
          h(MailStatusNotice, {
            accounts: [account],
            space: [account],
            online,
            syncState,
            accountIssues: true,
            onReauth: vi.fn(),
            onFocusList: () => screen.getByRole("option").focus(),
          }),
          h(
            "div",
            { role: "listbox", tabIndex: -1, "aria-label": "Inbox" },
            h("div", { role: "option", tabIndex: 0, "aria-selected": true }, "Meeting agenda"),
          ),
        ),
      ),
    );
  const statuses = () => screen.getAllByRole("status").map((status) => status.textContent);
  const ok = { running: false, errors: [], lastFinishedAt: 1 };
  const failing = { running: false, errors: [`${account.id}: Forbidden`], lastFinishedAt: 1 };
  const view = render(notice(true, ok));
  expect(statuses()).toEqual(["", ""]);
  view.rerender(notice(false, failing));
  expect(statuses()).toEqual([
    "You're offline. Mail syncs again when you reconnect.",
    "Sync failed",
  ]);
  expect(screen.queryByRole("alert")).toBeNull();
  await audit();
  // Each sync cycle hides and shows the failure again; the announcement does not change.
  const regions = screen.getAllByRole("status");
  view.rerender(notice(false, { ...failing, running: true }));
  view.rerender(notice(false, failing));
  expect(screen.getAllByRole("status")).toEqual(regions);
  expect(statuses()).toEqual([
    "You're offline. Mail syncs again when you reconnect.",
    "Sync failed",
  ]);
  // A remount, as on every search or view change, stays silent.
  cleanup();
  const remounted = render(notice(false, failing));
  expect(statuses()).toEqual(["", ""]);
  // Try again leaves while the sync runs; the list takes focus instead of the page.
  const retry = screen.getByRole("button", { name: "Try again" });
  retry.focus();
  await user.keyboard("{Enter}");
  remounted.rerender(notice(true, { ...failing, running: true }));
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("option"));
  remounted.rerender(notice(true, ok));
  expect(statuses()).toEqual(["", "Syncing normally"]);
});

it("describes search result rows by their attachment matches and audits the marks", async () => {
  const match = {
    source: "attachment" as const,
    messageId: message.id,
    attachmentName: "agenda.pdf",
    attachmentIndex: 0,
    snippet: "the quarterly budget review",
    highlights: [{ start: 14, end: 20 }],
  };
  render(
    localized(
      h(
        "main",
        null,
        h(
          MessageList,
          listProps({
            searching: true,
            threads: [{ ...thread, searchMatches: [match] }],
          }),
        ),
      ),
    ),
  );
  const option = screen.getByRole("option");
  const description = (option.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent)
    .join(" | ");
  expect(description).toMatch(/^Attachment text: .* \| In attachment agenda\.pdf:.*budget/);
  const mark = option.querySelector("mark");
  expect(mark?.textContent).toBe("budget");
  expect(mark?.className).toContain("text-neutral-950");
  await audit();
});

it("says which fields matched, marks the words, and marks nothing on a related result", async () => {
  const body = {
    source: "body" as const,
    messageId: message.id,
    snippet: "…the quarterly budget review is on Monday",
    highlights: [{ start: 15, end: 21 }],
  };
  const subject = {
    source: "subject" as const,
    messageId: message.id,
    snippet: thread.subject,
    highlights: [{ start: 0, end: 3 }],
  };
  const sender = {
    source: "sender" as const,
    messageId: message.id,
    snippet: "Alice <alice@example.com>",
    highlights: [{ start: 0, end: 5 }],
  };
  render(
    localized(
      h(
        "main",
        null,
        h(
          MessageList,
          listProps({
            searching: true,
            threads: [
              { ...thread, searchMatches: [subject, sender, body] },
              {
                ...thread,
                id: `${thread.id}-related`,
                threadId: `${thread.threadId}-related`,
                snippet: "Plans for the trip",
                related: true,
              },
            ],
          }),
        ),
      ),
    ),
  );
  const [hit, related] = screen.getAllByRole("option");
  const describe = (option: HTMLElement | undefined) =>
    (option?.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join(" | ");
  // The matched fields stay in the description but leave the screen: the marks show them.
  expect(describe(hit)).toMatch(/^Subject, Sender, Message body: .*budget review/);
  expect([...(hit?.querySelectorAll(".sr-only") ?? [])].map((node) => node.textContent)).toContain(
    "Subject, Sender, Message body: ",
  );
  expect([...(hit?.querySelectorAll("mark") ?? [])].map((mark) => mark.textContent)).toEqual([
    thread.subject.slice(0, 3),
    "budget",
  ]);
  expect(describe(related)).toBe("Related Plans for the trip");
  expect(related?.querySelector("mark")).toBeNull();
  await audit();
});

for (const entries of [[], [{ undoId: "u1", createdAt: Date.UTC(2026, 9, 14, 9, 30) }]]) {
  it(`Undo history is a valid menu with ${entries.length ? "an operation" : "nothing to undo"}`, async () => {
    const onUndo = vi.fn();
    render(localized(h(UndoHistory, { entries, onUndo })));
    fireEvent.click(screen.getByRole("button", { name: "Undo history" }));
    const menu = await waitFor(() =>
      screen.getByRole("menu", {
        description:
          "Operations from the last 24 hours. Restores labels, folders and flags after checking current state.",
      }),
    );
    const items = within(menu).getAllByRole("menuitem");
    expect(items).toHaveLength(1);
    if (entries.length) {
      fireEvent.click(items[0] ?? menu);
      expect(onUndo).toHaveBeenCalledWith("u1");
    } else {
      expect(items[0]?.textContent).toBe("No operations to undo");
      expect(items[0]?.getAttribute("aria-disabled")).toBe("true");
    }
    await audit();
  });
}

// In Russian the full status text pushed the account name down to "ale…" on two failed accounts.
it("the overview keeps each failed account's name readable and moves the status to an icon", async () => {
  const { i18n } = await catalogI18n("ru");
  const failed = (id: string) => ({
    ...account,
    id,
    email: `${id}@example.com`,
    lastSyncError: "boom",
  });
  render(
    h(
      I18nProvider,
      { i18n },
      h(Overview, {
        accounts: [failed("alexander"), failed("alexandra")],
        profiles: [],
        unread: {},
        syncState: { running: false, lastFinishedAt: null, errors: [] },
        onOpen: vi.fn(),
        onEditProfile: vi.fn(),
      }),
    ),
  );
  for (const name of ["alexander@example.com", "alexandra@example.com"]) {
    const row = screen.getByText(name).closest("li")!;
    const status = within(row).getByText("Не удалось синхронизировать");
    expect(status.className).toContain("sr-only");
    expect(status.closest("[title]")?.getAttribute("title")).toBeTruthy();
  }
  await audit();
});

// In Russian the one card's title read "Все учётные зап…" with ~900 px empty beside the card.
it("the overview gives a lone space the row's width and its title room to wrap", async () => {
  const { i18n } = await catalogI18n("ru");
  render(
    h(
      I18nProvider,
      { i18n },
      h(Overview, {
        accounts: [account],
        profiles: [],
        unread: { [account.id]: 1234 },
        syncState: { running: false, lastFinishedAt: null, errors: [] },
        onOpen: vi.fn(),
        onEditProfile: vi.fn(),
      }),
    ),
  );
  const title = screen.getByRole("button", { name: "Все учётные записи" });
  expect(title.getAttribute("title")).toBe("Все учётные записи");
  expect(title.className).not.toContain("truncate");
  expect(title.className).toContain("line-clamp-2");
  const grid = title.closest("section")!.parentElement!;
  expect(grid.className).toContain("repeat(auto-fit,");
  expect(grid.className).not.toContain("auto-fill");
  const count = within(title.closest("header")!).getByText(/1\s?234/);
  expect(count.closest("span.shrink-0")).toBeTruthy();
  await audit();
});
