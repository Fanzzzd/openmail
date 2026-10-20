// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createElement as h, createRef } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_PREFS, EMPTY_QUOTE_HISTORY, type CalendarInvite } from "@openmail/core/schema";
import { MessageList } from "../features/mail-list/MessageList";
import { Reader } from "../features/reader/Reader";
import { ThreadView } from "../features/reader/ThreadView";
import { ThreadActions } from "../features/organize/ThreadActions";
import { Sidebar } from "../features/sidebar/Sidebar";
import { DetectedCalendarEvents } from "../features/calendar/CalendarEvents";
import { EmailFrame } from "../features/reader/frame/EmailFrame";
import {
  fixture,
  account,
  message,
  thread,
  localized,
  audit,
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

it("audits the main sidebar, virtual list and reader with fixture messages", async () => {
  render(
    localized(
      h(
        "div",
        null,
        h(Sidebar, {
          view: { space: "all", mailbox: "inbox" },
          onView: vi.fn(),
          onSpace: vi.fn(),
          onEditProfile: vi.fn(),
          accounts: [account],
          profiles: [],
          unread: {},
          syncState: { running: false, errors: [], lastFinishedAt: null },
          progress: null,
          proposals: 0,
          onAddAccount: vi.fn(),
          onCompose: vi.fn(),
          onReauth: vi.fn(),
          onProposals: vi.fn(),
          onSettings: vi.fn(),
        }),
        h(MessageList, {
          title: "Inbox",
          threads: [
            { ...thread, isUnread: true, isStarred: true },
            { ...thread, id: "second", subject: "Second message", isUnread: true },
            { ...thread, id: "third", subject: "Third message", isStarred: true },
          ],
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
          selectedId: message.id,
          selectedIds: new Set([message.id]),
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
        h(Reader, {
          renderToolbar: () =>
            h(ThreadActions, {
              state: {
                provider: "gmail",
                isUnread: false,
                isStarred: false,
                isImportant: false,
                labels: ["INBOX"],
              },
              mailbox: "inbox",
              labels: [],
              onOp: vi.fn(),
              onCompose: vi.fn(),
              onSnooze: vi.fn(),
              labelPicker: false,
              onLabelPicker: vi.fn(),
            }),
          messageId: message.id,
          threadKey: message.threadId,
          query: "",
          onQuery: vi.fn(),
          onEnterResults: vi.fn(),
          searchRef: createRef<HTMLInputElement>(),
          onEditDraft: vi.fn(),
          notify: vi.fn(),
          onSelectMessage: vi.fn(),
          onMarkUnread: vi.fn(),
          onActionDone: vi.fn(),
          onComposeMessage: vi.fn(),
        }),
      ),
    ),
  );
  expect(screen.getByRole("navigation", { name: "Mailboxes" })).toBeTruthy();
  const options = screen.getAllByRole("option");
  expect(screen.getByRole("listbox").getAttribute("aria-multiselectable")).toBe("true");
  expect(options[0]?.getAttribute("aria-posinset")).toBe("1");
  expect(options[0]?.getAttribute("aria-setsize")).toBe("3");
  // The name leads with the sender and subject shown on screen; the preview stays out of it.
  expect(options[0]?.hasAttribute("aria-label")).toBe(false);
  expect(
    screen.getByRole("option", {
      name: (name) =>
        /^Alice, Meeting agenda, .+, Unread, Starred$/.test(name) &&
        !name.includes(message.snippet),
    }),
  ).toBe(options[0]);
  expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual([
    "true",
    "false",
    "false",
  ]);
  // The subject heads the thread; each message is headed by sender and time.
  expect(screen.getByRole("heading", { level: 2, name: message.subject })).toBeTruthy();
  expect(
    screen.getByRole("heading", { level: 3, name: new RegExp(`^${message.from.name}, `) }),
  ).toBeTruthy();
  await audit();
  options[0]?.focus();
  fireEvent.keyDown(options[0] ?? document.body, { key: "F10", shiftKey: true });
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
  await audit();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(options[0]));
});

it("gives collapsed messages a heading and an expanded state", () => {
  render(
    localized(
      h(ThreadView, {
        messages: [message, { ...message, id: `${message.id}-2`, date: message.date + 1 }],
        selectedId: `${message.id}-2`,
        single: false,
        notify: vi.fn(),
      }),
    ),
  );
  const collapsed = document.querySelector(`[data-message-id="${message.id}"]`);
  expect(collapsed?.getAttribute("aria-expanded")).toBe("false");
  expect(collapsed?.parentElement?.tagName).toBe("H3");
  expect(
    screen.getByRole("button", { name: "Collapse message" }).getAttribute("aria-expanded"),
  ).toBe("true");
  expect(screen.getByRole("article", { name: /^Selected message from Alice, / })).toBeTruthy();
});

it("a failed body refresh preserves the reader and cached preview with a non-blocking status", () => {
  fixture.values.set("threadAtom", [
    {
      ...message,
      bodyText: "",
      bodyHtml: "",
      bodyCached: false,
      bodyRefresh: "failed",
      snippet: "Cached preview while offline",
    },
  ]);
  render(
    localized(
      h(Reader, {
        renderToolbar: () => null,
        messageId: message.id,
        threadKey: message.threadId,
        query: "",
        onQuery: vi.fn(),
        onEnterResults: vi.fn(),
        searchRef: createRef<HTMLInputElement>(),
        onEditDraft: vi.fn(),
        notify: vi.fn(),
        onSelectMessage: vi.fn(),
        onMarkUnread: vi.fn(),
        onActionDone: vi.fn(),
        onComposeMessage: vi.fn(),
      }),
    ),
  );
  expect(screen.getByRole("article", { name: /^Selected message/ }).textContent).toContain(
    "Cached preview while offline",
  );
  expect(
    screen.getByText("Message text couldn't be refreshed. Showing the cached version.").tagName,
  ).toBe("OUTPUT");
});

it("audits reader attachments, invitation and sender authentication warnings", async () => {
  const file = { filename: "agenda.pdf", mimeType: "application/pdf", size: 128 };
  fixture.values.set("ReaderAttachments", [
    { ...file, path: [0], embedded: false, decodeError: false },
  ]);
  fixture.values.set("invitationsAtom", [
    {
      key: "invite",
      uid: "invite",
      sequence: 0,
      method: "REQUEST",
      cancelled: false,
      title: "Planning",
      start: { kind: "date", value: "2026-10-05" },
      end: { kind: "date", value: "2026-10-06" },
      location: "Office",
      organizer: message.from,
      attendees: [{ name: "Me", address: account.email, status: "NEEDS-ACTION", optional: false }],
      recurrence: [],
      recurrenceId: null,
      organizerMismatch: true,
    } satisfies CalendarInvite,
  ]);
  render(
    localized(
      h(
        "main",
        null,
        h("h1", null, "Mail"),
        h(ThreadView, {
          messages: [
            {
              ...message,
              hasCalendar: true,
              attachments: [file],
              security: { dmarc: "fail", spf: "fail", dkim: "fail" },
            },
          ],
          selectedId: message.id,
          single: false,
          notify: vi.fn(),
        }),
      ),
    ),
  );
  await screen.findByRole("region", { name: "Calendar invitation" });
  expect(screen.getByText("Sender authentication failed (DMARC)")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Actions for agenda.pdf" })).toBeTruthy();
  expect(
    screen
      .getAllByRole("alert")
      .map((alert) => alert.textContent)
      .join(" "),
  ).toContain("organizer differs");
  await audit();
});

it("announces selected messages without repeating message text on background refresh", () => {
  const props = { messages: [message], selectedId: message.id, single: false, notify: vi.fn() };
  const view = render(localized(h(ThreadView, props)));
  const status = screen.getByText("Selected message: Alice, Meeting agenda");
  expect(status.getAttribute("aria-live")).toBe("polite");
  view.rerender(
    localized(
      h(ThreadView, { ...props, messages: [{ ...message, bodyText: "Refreshed message text" }] }),
    ),
  );
  expect(status.textContent).toBe("Selected message: Alice, Meeting agenda");
  const next = {
    ...message,
    id: "next",
    threadId: "next",
    subject: "Next subject",
    from: { name: "Bob", address: "bob@example.com" },
  };
  view.rerender(localized(h(ThreadView, { ...props, messages: [next], selectedId: next.id })));
  expect(status.textContent).toBe("Selected message: Bob, Next subject");
});

it("sets automatic direction for plain and HTML message text without enabling scripts", () => {
  const plain = render(
    localized(
      h(ThreadView, {
        messages: [{ ...message, bodyText: "مرحبا بالعالم" }],
        selectedId: message.id,
        single: true,
        notify: vi.fn(),
      }),
    ),
  );
  expect(plain.container.querySelector("pre")?.dir).toBe("auto");
  cleanup();
  const html = render(
    localized(
      h(
        "main",
        null,
        h(EmailFrame, {
          html: "<p>مرحبا بالعالم</p>",
          remote: false,
          background: "light",
          zoom: 100,
          onActivate: vi.fn(),
          previous: EMPTY_QUOTE_HISTORY,
          findQuery: "",
          findIndex: 0,
          onMatches: undefined,
        }),
      ),
    ),
  );
  const iframe = html.container.querySelector("iframe");
  expect(iframe?.title).toBe("Message");
  expect(iframe?.getAttribute("sandbox")).toBe("allow-same-origin");
  expect(iframe?.srcdoc).toContain('<html lang="en">');
  expect(iframe?.srcdoc).toContain('<body dir="auto">');
  expect(iframe?.srcdoc).toContain("prefers-reduced-motion: reduce");
});

it("audits the reader actions menu by keyboard, with folded shortcuts and focus return", async () => {
  const user = userEvent.setup();
  render(
    localized(
      h(
        "main",
        null,
        h(ThreadActions, {
          state: {
            provider: "gmail",
            isUnread: false,
            isStarred: true,
            isImportant: false,
            labels: ["INBOX"],
          },
          mailbox: "inbox",
          labels: [],
          onOp: vi.fn(),
          onCompose: vi.fn(),
          onSnooze: vi.fn(),
          labelPicker: false,
          onLabelPicker: vi.fn(),
        }),
      ),
    ),
  );
  const toolbar = screen.getByRole("toolbar", { name: "Conversation actions" });
  for (const button of within(toolbar).getAllByRole("button"))
    expect(button.getAttribute("aria-label")).toBeTruthy();
  // A toggle keeps its name; aria-pressed carries the state.
  expect(within(toolbar).getByRole("button", { name: "Star" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  const more = within(toolbar).getByRole("button", { name: "Conversation actions" });
  more.focus();
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu");
  await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
  const first = document.activeElement;
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement).not.toBe(first);
  expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
  // A folded action keeps its name and its shortcut in the menu.
  const unstar = within(menu).getByRole("menuitem", { name: /^Unstar/ });
  expect(unstar.querySelector("kbd")?.textContent).toBeTruthy();
  await audit();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(more));
});

it("opens the dates found menu by keyboard, audits it and returns focus", async () => {
  const user = userEvent.setup();
  fixture.values.set("prefsAtom", {
    ...DEFAULT_PREFS,
    labs: { ...DEFAULT_PREFS.labs, calendarDetection: true },
  });
  const prose = (key: string, value: string) => ({
    key,
    title: "Planning",
    start: { kind: "date", value },
    end: { kind: "date", value },
    location: "",
    description: "",
    recurrence: [],
    dateInput: value,
  });
  fixture.values.set("detectedEventsAtom", [
    prose("one", "2026-10-05"),
    prose("two", "2026-10-06"),
  ]);
  render(localized(h("main", null, h(DetectedCalendarEvents, { message }))));
  const trigger = screen.getByRole("button", { name: "2 dates found" });
  trigger.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findAllByRole("menuitem")).toHaveLength(2);
  await audit();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

// Chips truncated to "from:NO…" in a 320 px field while the header had room to spare. With no message
// selected the toolbar has no actions, so only 8rem is reserved.
it("lets reader search with a query grow toward 520 px beside the toolbar", () => {
  render(
    localized(
      h(Reader, {
        renderToolbar: () => null,
        messageId: null,
        threadKey: null,
        query: "from:nora label:travel",
        onQuery: vi.fn(),
        onEnterResults: vi.fn(),
        searchRef: createRef<HTMLInputElement>(),
        onEditDraft: vi.fn(),
        notify: vi.fn(),
        onSelectMessage: vi.fn(),
        onMarkUnread: vi.fn(),
        onActionDone: vi.fn(),
        onComposeMessage: vi.fn(),
      }),
    ),
  );
  const slot = document.querySelector("[data-search-slot]");
  expect(slot?.closest("header")?.className).toContain("@container/bar");
  expect(slot?.className).toContain("basis-[clamp(20rem,100cqw_-_8rem,32.5rem)]!");
  expect(slot?.className).toContain("flex-[0_1_14rem]");
});
