// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement as h, createRef, useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { setupI18n, i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { AsyncResult } from "effect/reactivity";
import { Effect } from "effect";
import {
  DEFAULT_PREFS,
  EMPTY_QUOTE_HISTORY,
  type Account,
  type Message,
  type Proposal,
  type ThreadSummary,
  type CalendarInvite,
} from "@openmail/core/schema";
import { emptyDraft } from "./draft";

const fixture = vi.hoisted(() => {
  vi.resetModules();
  return { values: new Map<string, unknown>(), decide: vi.fn() };
});
vi.mock("@effect/atom-react", async (original) => {
  const actual = await original<typeof import("@effect/atom-react")>();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    useAtomValue: (atom: string) =>
      AsyncResult.success(
        fixture.values.get(atom) ??
          (atom === "nativeCompose" ? { photos: false, continuity: false, grammar: false } : []),
      ),
    // Mocked queries and mutations are strings; local UI atoms keep their real state.
    useAtom: (atom: unknown) =>
      Atom.isAtom(atom) && Atom.isWritable(atom)
        ? actual.useAtom(atom)
        : [AsyncResult.initial(), fixture.decide],
    useAtomSet: () => fixture.decide,
    useAtomRefresh: () => fixture.decide,
  };
});
vi.mock("./state/queries", () => ({
  nativeComposeCapabilitiesAtom: "nativeCompose",
  accountsAtom: "accountsAtom",
  profilesAtom: "profilesAtom",
  unreadCountsAtom: "unreadCountsAtom",
  labelsAtom: () => "labelsAtom",
  unreadByLabelAtom: () => "unreadByLabelAtom",
  unreadInboxAtom: () => "unreadInboxAtom",
  threadAtom: () => "threadAtom",
  proposalsAtom: "proposalsAtom",
  auditAtom: "auditAtom",
  agentModeAtom: "agentModeAtom",
  clientSetupAtom: "clientSetupAtom",
  imapPresetsAtom: "imapPresetsAtom",
  prefsAtom: "prefsAtom",
  namedSignaturesAtom: "namedSignaturesAtom",
  signatureDefaultsAtom: "signatureDefaultsAtom",
  signaturesAtom: "signaturesAtom",
  templatesAtom: "templatesAtom",
  contactAlternativesAtom: () => "contactAlternativesAtom",
  draftStatusAtom: () => "draftStatusAtom",
  hiddenContactsAtom: "hiddenContactsAtom",
  imageSendersAtom: "imageSendersAtom",
  inlineImagesAtom: () => "inlineImagesAtom",
  rawMessageAtom: () => "rawMessageAtom",
  knownSendersAtom: () => "knownSendersAtom",
  suggestionsAtom: () => "suggestionsAtom",
  labelPreferencesAtom: "labelPreferencesAtom",
  organizationAtom: "organizationAtom",
  sendAsAtom: "sendAsAtom",
  filtersListAtom: () => "filtersListAtom",
  vacationAtom: () => "vacationAtom",
  indexingProgressAtom: "indexingProgressAtom",
  mediaImageAtom: () => "mediaImageAtom",
  invitationsAtom: () => "invitationsAtom",
  contactSyncAtom: "contactSyncAtom",
  cacheWindowsAtom: "cacheWindowsAtom",
  backfillStateAtom: "backfillStateAtom",
  updateTokenConfiguredAtom: "updateTokenConfiguredAtom",
  contactGroupsAtom: () => "contactGroupsAtom",
  contactPhotoAtom: () => "contactPhotoAtom",
  calendarEventsAtom: () => "calendarEventsAtom",
  detectedEventsAtom: () => "detectedEventsAtom",
  updateStateAtom: "updateStateAtom",
  appleContactIdentifierAtom: () => "appleContactIdentifierAtom",
  appleContactsStatusAtom: "appleContactsStatusAtom",
}));
vi.mock("./state/mutations", () => ({
  setAgentModeAtom: "setAgentModeAtom",
  deleteProfileAtom: "deleteProfileAtom",
  setAccountSettingsAtom: () => "setAccountSettingsAtom",
  moveAccountAtom: "moveAccountAtom",
  setAppleContactsAtom: "setAppleContactsAtom",
  setPrefsAtom: "setPrefsAtom",
  saveNamedSignatureAtom: "saveNamedSignatureAtom",
  deleteNamedSignatureAtom: "deleteNamedSignatureAtom",
  setSignatureDefaultAtom: "setSignatureDefaultAtom",
  saveTemplateAtom: "saveTemplateAtom",
  deleteTemplateAtom: "deleteTemplateAtom",
  setContactHiddenAtom: "setContactHiddenAtom",
  setImageSenderAtom: "setImageSenderAtom",
  saveDraftAtom: () => "saveDraftAtom",
  connectAtom: () => "connectAtom",
  saveClientAtom: "saveClientAtom",
  reauthAtom: () => "reauthAtom",
  authorizePermanentDeleteAtom: () => "authorizePermanentDeleteAtom",
  removeAccountAtom: () => "removeAccountAtom",
  decideAtom: () => "decideAtom",
  saveProfileAtom: "saveProfileAtom",
  changeLabelAtom: "changeLabelAtom",
  setLabelPreferenceAtom: "setLabelPreferenceAtom",
  setOrganizationAtom: "setOrganizationAtom",
  snoozeAtom: "snoozeAtom",
  updateFilterAtom: "updateFilterAtom",
  restoreFilterAtom: "restoreFilterAtom",
  prepareFilterRestorationAtom: "prepareFilterRestorationAtom",
  discardFilterRestorationAtom: "discardFilterRestorationAtom",
  applyFilterAtom: "applyFilterAtom",
  prepareFilterAtom: "prepareFilterAtom",
  createLabelAndApplyAtom: "createLabelAndApplyAtom",
  createFilterAtom: "createFilterAtom",
  deleteFilterAtom: "deleteFilterAtom",
  setVacationAtom: "setVacationAtom",
  syncSendAsAtom: "syncSendAsAtom",
  respondInviteAtom: "respondInviteAtom",
  refreshContactsAtom: "refreshContactsAtom",
  setCacheWindowAtom: "setCacheWindowAtom",
  pauseBackfillAtom: "pauseBackfillAtom",
  setUpdateTokenAtom: "setUpdateTokenAtom",
  createCalendarEventAtom: "createCalendarEventAtom",
}));
vi.mock("./rpc", () => ({
  MailClient: { query: (tag: string) => tag, mutation: (tag: string) => tag },
  submitAiKey: () => Effect.void,
}));
vi.mock("./state/mail", () => ({
  useRunMail: () => Effect.runSync,
  withMail: (body: (call: (tag: string, payload?: unknown) => unknown) => unknown) =>
    body((tag) =>
      Effect.succeed(
        tag === "ReaderAttachments"
          ? (fixture.values.get("ReaderAttachments") ?? [])
          : tag === "NotificationActionCapabilities"
            ? { buttons: true, selection: true }
            : tag === "NotificationPermission"
              ? "authorized"
              : tag === "AttachmentCapabilities"
                ? { share: true }
                : tag === "AttachmentAction"
                  ? { count: 1, failures: [] }
                  : undefined,
      ),
    ),
  syncNow: Effect.void,
  openDraft: () => Effect.void,
  draftStatus: () => Effect.succeed(null),
  openThreadWindow: () => Effect.void,
  openMessageWindow: () => Effect.void,
  printThread: () => Effect.void,
}));
import { MessageList } from "./components/MessageList";
import { Reader, ThreadView } from "./components/Reader";
import { ThreadActions } from "./components/ThreadActions";
import { Sidebar } from "./components/Sidebar";
import { Composer } from "./components/Composer";
import { Settings } from "./components/Settings";
import { Assistant, AiOutput } from "./components/AiPanel";
import { Proposals } from "./components/Proposals";
import { Toast } from "./components/Toast";
import { Dialog, Alert, AlertCancel } from "./components/ui/Dialog";
import { TriageChip } from "./components/TriageChip";
import { DetectedCalendarEvents } from "./components/CalendarEvents";
import { AttachmentList } from "./components/Attachments";
import { useLayoutMode } from "./responsive-layout";
import { ComposeToolbar } from "./components/ComposeToolbar";
import { RecipientField } from "./components/RecipientField";
import { GoToFolder } from "./components/GoToFolder";
import { PickerPopover } from "./components/ui/Picker";
import { LinkConfirmDialog } from "./components/LinkConfirmDialog";
import { EmailFrame } from "./components/EmailFrame";
import { AddAccountDialog } from "./components/AddAccountDialog";
import { SnoozeDialog } from "./components/SnoozeDialog";
import { LabelEditor } from "./components/OrganizationSettings";

const account: Account = {
  id: "gmail:me",
  provider: "gmail",
  email: "me@example.com",
  createdAt: 0,
  lastSyncedAt: null,
  lastSyncError: null,
  profileId: null,
  needsReauth: false,
};
const message: Message = {
  id: "gmail:me/m1",
  threadId: "gmail:me/t1",
  accountId: account.id,
  subject: "Meeting agenda",
  date: 1,
  from: { name: "Alice", address: "alice@example.com" },
  to: [{ name: "Me", address: account.email }],
  cc: [],
  replyTo: [],
  labels: ["INBOX"],
  bodyText: "Agenda for our next meeting.",
  bodyHtml: "",
  snippet: "Agenda for our next meeting.",
  attachments: [],
  isUnread: false,
  isStarred: false,
  hasAttachments: false,
};
const thread: ThreadSummary = { ...message, participants: [message.from], threadCount: 1 };
const proposal: Proposal = {
  id: 1,
  createdAt: 0,
  status: "pending",
  actor: { kind: "agent", surface: "mcp", name: "Assistant" },
  command: { kind: "modify", threads: [message.id], op: { kind: "archive" } },
};
const localized = (node: ReactNode) =>
  h(I18nProvider, { i18n: setupI18n({ locale: "en", messages: { en: {} } }) }, node);
const auditedFixtures = new Set<string>();
const audit = async () => {
  // jsdom has no layout/canvas. Contrast is verified separately against theme tokens.
  let violations: axe.Result[] = [];
  await act(async () => {
    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    violations = result.violations;
  });
  expect(
    violations
      .filter((issue) => issue.impact === "serious" || issue.impact === "critical")
      .map((issue) => ({ id: issue.id, nodes: issue.nodes.map((node) => node.html) })),
  ).toEqual([]);
  const fixtureName = expect.getState().currentTestName;
  if (!fixtureName) throw new Error("Accessibility audit requires a named fixture");
  auditedFixtures.add(fixtureName);
  const allowed = moderateAllowlist.filter((entry) => entry.fixture === fixtureName);
  for (const entry of allowed) expect(entry.reason.trim()).not.toBe("");
  expect(
    violations
      .filter((issue) => issue.impact === "moderate")
      .map((issue) => ({ rule: issue.id, targets: issue.nodes.map((node) => node.target) })),
  ).toEqual(allowed.map(({ rule, targets }) => ({ rule, targets })));
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.values.clear();
  fixture.decide.mockReset();
  i18n.load("en", {});
  i18n.activate("en");
  fixture.values.set("NotificationState", {
    permission: "authorized",
    capabilities: { buttons: true, reply: true },
  });
  fixture.values.set("prefsAtom", DEFAULT_PREFS);
  fixture.values.set("threadAtom", [message]);
  fixture.values.set("accountsAtom", [account]);
  fixture.values.set("unreadByLabelAtom", {});
  fixture.values.set("inlineImagesAtom", {});
  fixture.values.set("knownSendersAtom", []);
  fixture.values.set("SpellcheckLanguages", { automatic: true, languages: ["en-US"] });
  fixture.values.set("contactPhotoAtom", null);
  fixture.values.set("appleContactsStatusAtom", { status: "off", revision: 0 });
  fixture.values.set("appleContactIdentifierAtom", null);
  fixture.values.set("agentModeAtom", "off");
  fixture.values.set("AiSettings", {
    keyConfigured: true,
    accounts: [{ accountId: account.id, allowed: true }],
  });
  fixture.values.set("AiTriage", null);
  fixture.values.set("AiSummary", null);
  fixture.values.set("updateStateAtom", { status: "idle" });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  HTMLElement.prototype.scrollIntoView = vi.fn();
  document.documentElement.lang = "en";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
  expect(options[0]?.getAttribute("aria-label")).toMatch(
    /^Alice, Meeting agenda, .+, Unread, Starred$/,
  );
  expect(options[0]?.getAttribute("aria-label")).not.toContain(message.snippet);
  expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual([
    "true",
    "false",
    "false",
  ]);
  expect(screen.getByRole("heading", { level: 3, name: message.subject })).toBeTruthy();
  await audit();
  options[0]?.focus();
  fireEvent.keyDown(options[0] ?? document.body, { key: "F10", shiftKey: true });
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
  await audit();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(options[0]));
});

for (const standalone of [false, true]) {
  it(`audits the ${standalone ? "full-window" : "floating"} composer and its recipient controls`, async () => {
    render(
      localized(
        h(Composer, {
          standalone,
          draft: {
            ...emptyDraft(account.id),
            to: "alice@example.com",
            cc: "bob@example.com",
            bcc: "carol@example.com",
            attachments: [
              { filename: "agenda.pdf", mimeType: "application/pdf", content: "YWdlbmRh" },
              { filename: "notes.txt", mimeType: "text/plain", content: "bm90ZXM=" },
            ],
          },
          accounts: [account],
          signatureFor: vi.fn(),
          onClose: vi.fn(),
          onDiscard: vi.fn(),
          onSend: vi.fn(),
        }),
      ),
    );
    expect(screen.getByRole("dialog").hasAttribute("data-full-window")).toBe(standalone);
    expect(screen.getByRole("button", { name: "Remove agenda.pdf" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move notes.txt earlier" }).tabIndex).toBe(0);
    await audit();
  });
}

for (const tab of [
  "general",
  "labs",
  "interactions",
  "accounts",
  "profiles",
  "cache",
  "notifications",
  "shortcuts",
  "signatures",
  "reading",
  "compose",
  "organize",
  "server",
  "ai",
  "log",
] as const) {
  it(`audits the ${tab} settings page`, async () => {
    render(
      localized(
        h(Settings, {
          initialTab: tab,
          accounts: [account],
          onClose: vi.fn(),
          onAddAccount: vi.fn(),
        }),
      ),
    );
    await audit();
  });
}

it("audits the mail assistant", async () => {
  render(
    localized(h(Assistant, { accounts: [account], proposals: [proposal], onOpenDraft: vi.fn() })),
  );
  fireEvent.keyDown(window, { key: "j", ctrlKey: true });
  expect(screen.getByRole("dialog", { name: "Mail assistant" })).toBeTruthy();
  await audit();
});

it("audits proposals and approves/rejects with the keyboard", async () => {
  const user = userEvent.setup();
  render(
    localized(
      h(Proposals, {
        accounts: [account],
        proposals: [proposal],
        onClose: vi.fn(),
        onOpenDraft: vi.fn(),
      }),
    ),
  );
  await audit();
  screen.getByRole("button", { name: "Approve" }).focus();
  await user.keyboard("{Enter}");
  expect(fixture.decide).toHaveBeenCalledWith(true);
  screen.getByRole("button", { name: "Reject" }).focus();
  await user.keyboard("{Enter}");
  expect(fixture.decide).toHaveBeenCalledWith(false);
});

it("traps dialog focus, focuses the first control, closes on Escape and restores focus", async () => {
  const user = userEvent.setup();
  function Harness() {
    const [open, setOpen] = useState(false);
    return h(
      "div",
      null,
      h("button", { onClick: () => setOpen(true) }, "Open"),
      open &&
        h(Dialog, {
          "aria-label": "Test",
          onClose: () => setOpen(false),
          children: [
            h("input", { key: "name", "aria-label": "Name" }),
            h("button", { key: "last" }, "Last"),
          ],
        }),
    );
  }
  render(h(Harness));
  await user.click(screen.getByRole("button", { name: "Open" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" })),
  );
  await user.tab({ shift: true });
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" })),
  );
  await user.tab();
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" })),
  );
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open" })),
  );
});

it("roves the one-row format toolbar and moves groups that do not fit into More formatting", async () => {
  const user = userEvent.setup();
  const toolbarAt = () =>
    render(
      localized(
        h(
          "main",
          null,
          h(ComposeToolbar, {
            leading: null,
            formatting: true,
            disabled: false,
            onFormat: vi.fn(),
            onStyle: vi.fn(),
            onCommand: vi.fn(),
            onLink: vi.fn(),
            more: null,
            shortcut: () => "",
          }),
        ),
      ),
    );
  toolbarAt();
  const toolbar = screen.getByRole("toolbar", { name: "Formatting" });
  expect(
    [...toolbar.querySelectorAll("button,input")].filter(
      (control) => control.getAttribute("tabindex") === "0",
    ),
  ).toHaveLength(1);
  await user.tab();
  expect(document.activeElement).toBe(within(toolbar).getByRole("button", { name: "Bold" }));
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(within(toolbar).getByRole("button", { name: "Italic" }));
  await user.keyboard("{End}");
  expect(document.activeElement).toBe(
    within(toolbar).getByRole("button", { name: "More formatting" }),
  );
  expect(within(toolbar).getByRole("button", { name: "Bulleted list" })).toBeTruthy();
  await user.click(within(toolbar).getByRole("button", { name: "Color" }));
  expect(await screen.findByRole("textbox", { name: "Custom hex color" })).toBeTruthy();
  await audit();
  cleanup();

  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(420);
  try {
    toolbarAt();
    const narrow = screen.getByRole("toolbar", { name: "Formatting" });
    expect(within(narrow).getByRole("button", { name: "Underline" })).toBeTruthy();
    expect(within(narrow).queryByRole("button", { name: "Bulleted list" })).toBeNull();
    expect(within(narrow).queryByRole("button", { name: "Alignment" })).toBeNull();
    await user.click(within(narrow).getByRole("button", { name: "More formatting" }));
    expect(await screen.findByRole("menuitem", { name: /^Bulleted list/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /^Align left/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /^Clear formatting/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /^Underline/ })).toBeNull();
  } finally {
    width.mockRestore();
  }
});

it("names recipient actions and exposes removal and moving to keyboard users", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const onMove = vi.fn();
  render(
    localized(
      h(RecipientField, {
        label: "To",
        value: "alice@example.com",
        onChange,
        onMove,
        fieldName: "to",
        from: account.email,
        showFullAddresses: true,
      }),
    ),
  );
  const remove = screen.getByRole("button", { name: "Remove alice@example.com" });
  expect(remove.tabIndex).toBe(-1);
  screen.getByRole("button", { name: "Actions for alice@example.com" }).focus();
  await user.keyboard("{Enter}");
  screen.getByRole("menuitem", { name: "Move to Cc" }).focus();
  await user.keyboard("{Enter}");
  expect(onMove).toHaveBeenCalledWith(0, "cc");
  remove.focus();
  await user.keyboard("{Enter}");
  expect(onChange).toHaveBeenCalledWith("");
});

it("announces undo politely and errors assertively", () => {
  const view = render(
    h(Toast, {
      toast: { id: 1, text: "Archived", action: { label: "Undo", run: vi.fn() } },
      onDone: vi.fn(),
    }),
  );
  expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  view.rerender(
    h(Toast, { toast: { id: 2, text: "Sync failed", tone: "error" }, onDone: vi.fn() }),
  );
  expect(screen.getByRole("alert").getAttribute("aria-live")).toBe("assertive");
});

it("announces AI state changes without putting streamed text in a live region", () => {
  const result = {
    text: "First token",
    sources: [],
    model: "",
    truncated: false,
    status: "running",
    start: vi.fn(),
    cancel: vi.fn(),
  } satisfies Parameters<typeof AiOutput>[0]["result"];
  const view = render(localized(h(AiOutput, { result, openSource: vi.fn() })));
  const status = screen.getByRole("status");
  view.rerender(
    localized(h(AiOutput, { result: { ...result, text: "More tokens" }, openSource: vi.fn() })),
  );
  expect(screen.getByRole("status").textContent).toBe(status.textContent);
  expect(screen.getByText("More tokens").closest('[aria-live],[role="status"]')).toBeNull();
  view.rerender(
    localized(h(AiOutput, { result: { ...result, status: "done" }, openSource: vi.fn() })),
  );
  expect(screen.getByRole("status").textContent).toBe("Generation complete");
});

it("opens triage review from the keyboard and announces the dialog", async () => {
  const user = userEvent.setup();
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
  render(localized(h(TriageChip, { id: message.id, accountId: account.id, labels: ["INBOX"] })));
  await user.tab();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("dialog", { name: "AI suggestion" })).toBeTruthy();
  await audit();
  screen.getByRole("button", { name: "Accept" }).focus();
  await user.keyboard("{Enter}");
  expect(fixture.decide).toHaveBeenCalledWith(
    expect.objectContaining({ payload: { id: message.id, accept: true } }),
  );
});

it("opens the calendar confirmation by keyboard, traps focus and returns to its button", async () => {
  const user = userEvent.setup();
  fixture.values.set("prefsAtom", {
    ...DEFAULT_PREFS,
    labs: { ...DEFAULT_PREFS.labs, calendarDetection: true },
  });
  fixture.values.set("detectedEventsAtom", [
    {
      key: "meeting",
      title: "Planning",
      start: { kind: "date", value: "2026-10-05" },
      end: { kind: "date", value: "2026-10-06" },
      location: "Office",
      description: "Planning session",
      recurrence: [],
    },
  ]);
  render(
    localized(
      h(DetectedCalendarEvents, { message: { ...message, bodyText: "Meeting on 2026-10-05" } }),
    ),
  );
  await user.tab();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("dialog", { name: "Add this event to your calendar?" })).toBeTruthy();
  await audit();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add to calendar" })),
  );
});

it("offers Open With in the keyboard accessible attachment menu", async () => {
  const user = userEvent.setup();
  render(
    localized(
      h(
        "main",
        null,
        h(AttachmentList, {
          messageId: message.id,
          files: [
            {
              path: [0],
              filename: "agenda.pdf",
              mimeType: "application/pdf",
              size: 128,
              embedded: false,
              decodeError: false,
            },
          ],
          notify: vi.fn(),
        }),
      ),
    ),
  );
  screen.getByRole("button", { name: "Actions for agenda.pdf" }).focus();
  await user.keyboard("{Enter}");
  const openWith = await screen.findByRole("menuitem", { name: "Open With…" });
  await audit();
  openWith.focus();
  await user.keyboard("{Enter}");
});

it("defaults confirmations to Cancel and restores the opener on Escape", async () => {
  const user = userEvent.setup();
  function Harness() {
    const [open, setOpen] = useState(false);
    return localized(
      h(
        "div",
        null,
        h("button", { onClick: () => setOpen(true) }, "Delete"),
        h(Alert, {
          open,
          onOpenChange: setOpen,
          title: "Delete message?",
          children: [
            h(AlertCancel, { key: "cancel", children: "Cancel" }),
            h("button", { key: "confirm" }, "Confirm"),
          ],
        }),
      ),
    );
  }
  render(h(Harness));
  await user.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })),
  );
  await audit();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete" })),
  );
});

it("follows CSS pixels, so zoom moves the window between three, two and one pane", () => {
  let changed: (() => void) | undefined;
  vi.stubGlobal("matchMedia", () => ({
    addEventListener: (_name: string, listener: () => void) => {
      changed = listener;
    },
    removeEventListener: vi.fn(),
  }));
  const resize = (width: number) => {
    vi.stubGlobal("innerWidth", width);
    act(() => changed?.());
  };
  vi.stubGlobal("innerWidth", 1056);
  function Harness() {
    return h("output", null, useLayoutMode());
  }
  render(h(Harness));
  expect(screen.getByRole("status").textContent).toBe("wide");
  // 1056 px at 110% zoom.
  resize(960);
  expect(screen.getByRole("status").textContent).toBe("wide");
  resize(873);
  expect(screen.getByRole("status").textContent).toBe("medium");
  resize(639);
  expect(screen.getByRole("status").textContent).toBe("narrow");
});

afterAll(() => {
  for (const entry of moderateAllowlist) expect(auditedFixtures.has(entry.fixture)).toBe(true);
  for (const module of [
    "@effect/atom-react",
    "./rpc",
    "./state/queries",
    "./state/mutations",
    "./state/mail",
  ])
    vi.doUnmock(module);
  vi.resetModules();
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

it("lets Escape and composer shortcuts bubble from recipient chip actions", () => {
  const keys = vi.fn();
  render(
    localized(
      h(
        "div",
        { onKeyDown: keys },
        h(RecipientField, {
          label: "To",
          value: "alice@example.com",
          onChange: vi.fn(),
          fieldName: "to",
          from: account.email,
          showFullAddresses: true,
        }),
      ),
    ),
  );
  const actions = screen.getByRole("button", { name: "Actions for alice@example.com" });
  for (const event of [
    { key: "Escape" },
    { key: "s", metaKey: true },
    { key: "Enter", ctrlKey: true },
    { key: "ArrowLeft", altKey: true },
  ]) {
    fireEvent.keyDown(actions, event);
  }
  expect(keys).toHaveBeenCalledTimes(4);
  for (const key of ["Backspace", "Delete", "ArrowLeft", "ArrowRight"])
    fireEvent.keyDown(actions, { key });
  expect(keys).toHaveBeenCalledTimes(4);
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
  expect(screen.getByRole("article", { name: "Selected message" }).textContent).toContain(
    "Cached preview while offline",
  );
  expect(
    screen.getByText("Message text could not be refreshed. Showing the cached version.").tagName,
  ).toBe("OUTPUT");
});

it("existing accounts without an OAuth registration show the configuration state", () => {
  fixture.values.set("clientSetupAtom", { googleConfigured: false, microsoftConfigured: false });
  render(
    localized(
      h(Settings, {
        initialTab: "accounts",
        accounts: [account],
        onClose: vi.fn(),
        onAddAccount: vi.fn(),
      }),
    ),
  );
  expect(screen.getByText("OAuth client not configured. Set it up before syncing.")).toBeTruthy();
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

it("audits the folder command palette and selects a result with the keyboard", async () => {
  const user = userEvent.setup();
  const onView = vi.fn();
  const onClose = vi.fn();
  render(
    localized(
      h(GoToFolder, {
        labels: [],
        accounts: [account],
        view: { space: "all", mailbox: "inbox" },
        onView,
        onClose,
      }),
    ),
  );
  const input = screen.getByRole("combobox", { name: "Go to folder" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  await user.type(input, "Sent");
  await audit();
  await user.keyboard("{Enter}");
  expect(onView).toHaveBeenCalledWith({ space: "all", mailbox: "sent" });
  expect(onClose).toHaveBeenCalled();
});

it("traps picker focus, audits its controls and returns focus on Escape", async () => {
  const user = userEvent.setup();
  function Harness() {
    const [open, setOpen] = useState(false);
    return localized(
      h(
        "main",
        null,
        h(PickerPopover, {
          "aria-label": "Pick label",
          open,
          onOpenChange: setOpen,
          trigger: h("button", null, "Pick label"),
          children: [
            h("input", { key: "query", "aria-label": "Find label" }),
            h("button", { key: "label" }, "Work"),
          ],
        }),
        h("button", null, "Outside"),
      ),
    );
  }
  render(h(Harness));
  const opener = screen.getByRole("button", { name: "Pick label" });
  await user.click(opener);
  const input = screen.getByRole("textbox", { name: "Find label" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  await audit();
  await user.tab({ shift: true });
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" })),
  );
  await user.tab();
  await waitFor(() => expect(document.activeElement).toBe(input));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

it("audits link confirmation, defaults to Cancel and restores the source link", async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  const linkRef = createRef<HTMLAnchorElement>();
  function Harness() {
    const [open, setOpen] = useState(false);
    return localized(
      h(
        "main",
        null,
        h(
          "a",
          {
            ref: linkRef,
            href: "https://example.com",
            onClick: (event) => {
              event.preventDefault();
              setOpen(true);
            },
          },
          "Displayed link",
        ),
        open &&
          h(LinkConfirmDialog, {
            url: "https://example.com/real",
            onOpen,
            onClose: () => setOpen(false),
            returnFocus: () => linkRef.current,
          }),
      ),
    );
  }
  render(h(Harness));
  await user.tab();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })),
  );
  await audit();
  await user.tab({ shift: true });
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open link" })),
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(linkRef.current));
  expect(onOpen).not.toHaveBeenCalled();
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

it("removes recipient chips using Delete and announces the removed address", async () => {
  const user = userEvent.setup();
  function Harness() {
    const [value, setValue] = useState("alice@example.com");
    return localized(
      h(
        "main",
        null,
        h(RecipientField, {
          label: "To",
          value,
          onChange: setValue,
          from: account.email,
          showFullAddresses: true,
        }),
      ),
    );
  }
  render(h(Harness));
  const input = screen.getByRole("combobox", { name: "To" });
  input.focus();
  await user.keyboard("{ArrowLeft}{Delete}");
  expect(screen.queryByRole("button", { name: "Remove alice@example.com" })).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Removed alice@example.com");
  await audit();
});

it("audits the snooze form and associates invalid reminder input with its error", async () => {
  render(
    localized(h(SnoozeDialog, { threads: [message.id], onClose: vi.fn(), onStart: () => vi.fn() })),
  );
  const input = screen.getByRole("textbox", { name: "Reminder time" });
  fireEvent.change(input, { target: { value: "invalid reminder" } });
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
    "Enter a future reminder time",
  );
  await audit();
});

it("audits a label editor with a server error", async () => {
  render(
    localized(
      h(LabelEditor, {
        label: "new",
        labels: [],
        busy: false,
        error: "Server unavailable",
        onClose: vi.fn(),
        onSave: vi.fn(),
      }),
    ),
  );
  const input = screen.getByRole("textbox", { name: "Name" });
  expect(document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
    "Server unavailable",
  );
  await audit();
});

it("audits composer send validation and associates the error with recipient fields", async () => {
  render(
    localized(
      h(Composer, {
        draft: emptyDraft(account.id),
        accounts: [account],
        signatureFor: vi.fn(),
        onClose: vi.fn(),
        onDiscard: vi.fn(),
        onSend: vi.fn(),
      }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  const alert = screen.getByRole("alert");
  expect(alert.textContent).not.toBe("");
  const recipients = screen.getByRole("combobox", { name: "To" });
  expect(recipients.getAttribute("aria-describedby")).toBe(alert.id);
  await audit();
});

it("audits the composer attachment menu and send confirmation using the keyboard", async () => {
  const user = userEvent.setup();
  fixture.values.set("nativeCompose", { photos: true, continuity: true, grammar: false });
  render(
    localized(
      h(Composer, {
        draft: {
          ...emptyDraft(account.id),
          to: "alice@example.com",
          body: { kind: "plain", text: "Hello" },
        },
        accounts: [account],
        signatureFor: vi.fn(),
        onClose: vi.fn(),
        onDiscard: vi.fn(),
        onSend: vi.fn(),
      }),
    ),
  );
  await audit();
  const attach = screen.getByRole("button", { name: "Attach files" });
  attach.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("menuitem", { name: "Photos" });
  await audit();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(attach));
  screen.getByRole("button", { name: "Send" }).focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("alertdialog");
  await audit();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Send" })),
  );
});

for (const choice of [null, "Other IMAP", "Gmail", "Outlook"] as const) {
  it(`audits the add-account ${choice ?? "provider chooser"} dialog`, async () => {
    fixture.values.set("clientSetupAtom", { googleConfigured: false, microsoftConfigured: false });
    render(localized(h(AddAccountDialog, { onClose: vi.fn(), onAdded: vi.fn() })));
    if (choice) fireEvent.click(screen.getByRole("button", { name: choice }));
    await audit();
  });
}

/**
 * Snapshot of reviewed moderate axe findings. Match fixture, rule and targets,
 * and explain each exception here. Serious/critical findings are never allowed.
 * Empty because the audited fixtures currently have no moderate violations.
 */
const moderateAllowlist: readonly {
  fixture: string;
  rule: string;
  targets: readonly (readonly string[])[];
  reason: string;
}[] = [];
