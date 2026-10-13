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
import { emptyDraft } from "../features/compose/draft";
import { builtPalette } from "../test-support/test-styles";

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
vi.mock("../state/queries", () => ({
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
  aiClientsAtom: "aiClientsAtom",
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
  privateUpdateFeedAtom: "privateUpdateFeedAtom",
  contactGroupsAtom: () => "contactGroupsAtom",
  contactPhotoAtom: () => "contactPhotoAtom",
  calendarEventsAtom: () => "calendarEventsAtom",
  detectedEventsAtom: () => "detectedEventsAtom",
  updateStateAtom: "updateStateAtom",
  appleContactIdentifierAtom: () => "appleContactIdentifierAtom",
  appleContactsStatusAtom: "appleContactsStatusAtom",
}));
vi.mock("../state/mutations", () => ({
  setAgentModeAtom: "setAgentModeAtom",
  deleteProfileAtom: "deleteProfileAtom",
  setAccountSettingsAtom: () => "setAccountSettingsAtom",
  moveAccountAtom: "moveAccountAtom",
  setAppleContactsAtom: "setAppleContactsAtom",
  setPrefsAtom: "setPrefsAtom",
  chooseAttachmentFolderAtom: "chooseAttachmentFolderAtom",
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
  clearClientAtom: "clearClientAtom",
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
vi.mock("../state/downloads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    downloadsAtom: Atom.make([]),
    downloadsOpenAtom: Atom.make(false),
    downloadsFeedAtom: "downloadsFeed",
  };
});
vi.mock("../state/remote-access", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    remoteAccessAtom: Atom.make(null),
    remoteAccessFeedAtom: "remoteAccessFeed",
    refreshRemoteAccessAtom: "RefreshRemoteAccess",
    setRemoteAccessAtom: "SetRemoteAccess",
    setRemoteAllowlistAtom: "SetRemoteAllowlist",
    setRemoteServiceAtom: "SetRemoteService",
    disconnectRemoteSessionAtom: "DisconnectRemoteSession",
  };
});
vi.mock("../state/rpc", () => ({
  MailClient: { query: (tag: string) => tag, mutation: (tag: string) => tag },
  submitAiKey: () => Effect.void,
}));
vi.mock("../state/mail", () => ({
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
                  : tag === "AttachmentApps"
                    ? [{ application: "/Applications/Preview.app", label: "Preview" }]
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
import { MessageList } from "../features/mail-list/MessageList";
import { Reader } from "../features/reader/Reader";
import { ThreadView } from "../features/reader/ThreadView";
import { ThreadActions } from "../features/organize/ThreadActions";
import { Sidebar } from "../features/sidebar/Sidebar";
import { MailStatusNotice } from "../features/sync-status/MailStatusNotice";
import { BatchActions } from "../features/mail-list/BatchActions";
import { Composer } from "../features/compose/components/Composer";
import { Settings } from "../features/settings/Settings";
import { ShortcutHelp } from "../features/settings/sections/SystemSettings";
import { Assistant, AiOutput } from "../features/ai/AiPanel";
import { Proposals } from "../features/ai/Proposals";
import { Toast } from "../ui/Toast";
import { Dialog, Alert, AlertCancel } from "../ui/Dialog";
import { TriageChip } from "../features/ai/TriageChip";
import { DetectedCalendarEvents } from "../features/calendar/CalendarEvents";
import { AttachmentList } from "../features/reader/attachments/Attachments";
import { useLayoutMode } from "../lib/responsive-layout";
import { ComposeToolbar } from "../features/compose/components/ComposeToolbar";
import { RecipientField } from "../features/compose/components/RecipientField";
import { GoToFolder } from "../features/organize/GoToFolder";
import { PickerPopover } from "../ui/Picker";
import { LinkConfirmDialog } from "../features/reader/frame/LinkConfirmDialog";
import { EmailFrame } from "../features/reader/frame/EmailFrame";
import { AddAccountDialog, FirstRunDone } from "../features/accounts/AddAccountDialog";
import { SnoozeDialog } from "../features/organize/SnoozeDialog";
import { LabelEditor } from "../features/organize/OrganizationSettings";
import { RemoteImagesPrompt } from "../features/reader/RemoteImagesPrompt";

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
  const launch = {
    command: "/Applications/OpenMail.app/Contents/MacOS/OpenMail",
    args: ["--mcp"],
    env: {},
  };
  const client = {
    installed: true,
    method: "cli",
    cliPath: "/Users/me/.local/bin/claude",
    configPath: "/Users/me/.claude.json",
    problem: null,
    manual: "claude mcp add --scope user --transport stdio openmail -- OpenMail --mcp",
  };
  fixture.values.set("aiClientsAtom", {
    launch,
    launchProblem: null,
    clients: [
      { ...client, id: "claude-code", state: "connected", entry: launch, proposalTools: false },
      {
        ...client,
        id: "codex",
        state: "stale",
        entry: { ...launch, command: "/old" },
        proposalTools: false,
      },
      {
        ...client,
        id: "claude-desktop",
        method: "file",
        cliPath: null,
        state: "unreadable",
        entry: null,
        proposalTools: false,
        problem: "Unexpected token",
      },
      {
        ...client,
        id: "cursor",
        installed: false,
        method: "file",
        cliPath: null,
        state: "notConnected",
        entry: null,
        proposalTools: false,
      },
    ],
    activity: [{ at: 0, client: "claude-code", tool: "search", ok: true }],
  });
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

it("groups the keyboard shortcuts with Triage first and filters them by name or key", async () => {
  render(localized(h(ShortcutHelp, { onClose: vi.fn() })));
  const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
  expect(
    within(dialog)
      .getAllByRole("heading", { level: 3 })
      .map((e) => e.textContent),
  ).toEqual(["Triage", "Navigation", "Reading", "Compose", "Formatting", "Window"]);
  const triage = within(dialog).getByRole("region", { name: "Triage" });
  expect(within(triage).getAllByRole("row")[0]?.textContent).toMatch(/^Archive/);
  const filter = within(dialog).getByRole("searchbox", { name: "Filter shortcuts" });
  fireEvent.change(filter, { target: { value: "reply" } });
  expect(
    within(dialog)
      .getAllByRole("heading", { level: 3 })
      .map((e) => e.textContent),
  ).toEqual(["Compose"]);
  expect(
    within(dialog)
      .getAllByRole("row")
      .map((row) => row.querySelector("td")?.textContent),
  ).toEqual(["Reply", "Reply all"]);
  // A key matches too.
  fireEvent.change(filter, { target: { value: "⌘B" } });
  expect(
    within(dialog)
      .getAllByRole("row")
      .map((row) => row.querySelector("td")?.textContent),
  ).toContain("Bold");
  fireEvent.change(filter, { target: { value: "no such shortcut" } });
  expect(within(dialog).getByRole("status").textContent).toBe("No shortcuts match.");
  await audit();
});

it("shows the GitHub token field only for a build with a private update feed", () => {
  const general = () =>
    render(
      localized(
        h(Settings, {
          initialTab: "general",
          accounts: [account],
          onClose: vi.fn(),
          onAddAccount: vi.fn(),
        }),
      ),
    );
  fixture.values.set("privateUpdateFeedAtom", false);
  const view = general();
  expect(screen.getByRole("button", { name: "Check for updates" })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "GitHub access token" })).toBeNull();
  expect(document.body.textContent).not.toContain("GitHub access token");
  view.unmount();
  fixture.values.set("privateUpdateFeedAtom", true);
  general();
  expect(screen.getByLabelText("GitHub access token")).toBeTruthy();
});

it("audits a custom attachment folder shown read-only with a picker button", async () => {
  fixture.values.set("prefsAtom", {
    ...DEFAULT_PREFS,
    attachmentSaveFolder: { kind: "custom", path: "/Users/me/Mail attachments" },
  });
  render(
    localized(
      h(Settings, {
        initialTab: "reading",
        accounts: [account],
        onClose: vi.fn(),
        onAddAccount: vi.fn(),
      }),
    ),
  );
  const field = screen.getByRole("textbox", { name: "Folder path" });
  expect(field).toHaveProperty("readOnly", true);
  expect(field).toHaveProperty("value", "/Users/me/Mail attachments");
  expect(screen.getByRole("button", { name: "Choose…" })).toBeTruthy();
  await audit();
});

it("asks once how remote images load; closing it stores Always", async () => {
  const prompt = () => render(localized(h(RemoteImagesPrompt, { hasAccounts: true })));
  const saved = () => fixture.decide.mock.lastCall?.[0]?.payload?.patch;

  const first = prompt();
  const region = screen.getByRole("region", { name: "Load images in messages?" });
  // A floating card over the panes; it leaves focus where it was.
  expect(region.className).toContain("fixed");
  expect(region.contains(document.activeElement)).toBe(false);
  const always = screen.getByRole("radio", {
    name: "Always, block trackers",
    description: "Recommended. Known tracking pixels stay blocked.",
  });
  expect(always.getAttribute("aria-checked")).toBe("true");
  expect(
    screen.getByRole("radio", {
      name: "Ask each time",
      description: "Click Load images on each message.",
    }),
  ).toBeTruthy();
  expect(screen.getByRole("radiogroup", { name: "Remote images" })).toBeTruthy();
  await audit();
  // Arrow keys move the selection inside the group.
  always.focus();
  await userEvent.setup().keyboard("{ArrowDown}");
  expect(
    screen.getByRole("radio", { name: "From people I know" }).getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("radio", { name: "Ask each time" }));
  fireEvent.click(screen.getByRole("radio", { name: "From people I know" }));
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(saved()).toEqual({ remoteImages: "known" });
  expect(screen.queryByRole("region", { name: "Load images in messages?" })).toBeNull();
  first.unmount();

  const second = prompt();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(saved()).toEqual({ remoteImages: "always" });
  expect(screen.queryByRole("region")).toBeNull();
  second.unmount();

  // A stored choice, from this prompt or Settings, keeps it hidden on every later launch.
  fixture.values.set("prefsAtom", {
    ...DEFAULT_PREFS,
    remoteImages: "ask",
    remoteImagesChosen: true,
  });
  const calls = fixture.decide.mock.calls.length;
  const chosen = prompt();
  expect(chosen.container.textContent).toBe("");
  expect(fixture.decide.mock.calls.length).toBe(calls);
  chosen.unmount();

  fixture.values.set("prefsAtom", DEFAULT_PREFS);
  expect(
    render(localized(h(RemoteImagesPrompt, { hasAccounts: false }))).container.textContent,
  ).toBe("");
});

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
    error: null,
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
  const openWith = await screen.findByRole("menuitem", { name: "Open with" });
  expect(openWith.getAttribute("aria-haspopup")).toBe("menu");
  await audit();
  openWith.focus();
  await user.keyboard("{ArrowRight}");
  // The submenu lists the apps the main process found, as a React menu, not a native popup.
  const app = await screen.findByRole("menuitem", { name: "Preview" });
  await waitFor(() => expect(document.activeElement).toBe(app));
  await audit();
  await user.keyboard("{ArrowLeft}");
  await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Preview" })).toBeNull());
  expect(document.activeElement).toBe(openWith);
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
    "../state/rpc",
    "../state/queries",
    "../state/mutations",
    "../state/downloads",
    "../state/mail",
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
  expect(shown("Could not sync work@example.com.")).toBeTruthy();
  view.rerender(notice(["gmail:me: Forbidden"]));
  expect(shown("Sync failed")).toBeTruthy();
  // Offline joins the account notices instead of hiding them.
  view.rerender(notice(["gmail:work: Forbidden"], false));
  expect(shown("You're offline. Mail syncs again when you reconnect.")).toBeTruthy();
  expect(shown("Could not sync work@example.com.")).toBeTruthy();
  // Failures are polite statuses, never assertive alerts.
  expect(screen.queryByRole("alert")).toBeNull();
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

const NO_CLIENTS = {
  googleClient: "none",
  microsoftClient: "none",
  googleBuiltIn: false,
  microsoftBuiltIn: false,
} as const;
const BUILT_IN_CLIENTS = {
  googleClient: "builtIn",
  microsoftClient: "builtIn",
  googleBuiltIn: true,
  microsoftBuiltIn: true,
} as const;

it("existing accounts without an OAuth registration show the configuration state", () => {
  fixture.values.set("clientSetupAtom", NO_CLIENTS);
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
    fixture.values.set("clientSetupAtom", NO_CLIENTS);
    render(localized(h(AddAccountDialog, { onClose: vi.fn(), onAdded: vi.fn() })));
    if (choice) fireEvent.click(screen.getByRole("button", { name: choice }));
    await audit();
  });
}

it("after the first account, a short skippable step lists three shortcuts", async () => {
  const onClose = vi.fn();
  render(localized(h(FirstRunDone, { onClose })));
  const dialog = screen.getByRole("dialog", { name: "You're set" });
  expect(
    within(dialog)
      .getAllByRole("term")
      .map((term) => term.textContent),
  ).toEqual(["New message", "Reply", "Archive"]);
  expect(
    within(dialog)
      .getAllByRole("definition")
      .map((keys) => keys.textContent),
  ).toEqual(["⌘N", "⌘R", "⌃⌘A"]);
  expect(dialog.textContent).toContain("Press ? for all shortcuts.");
  await waitFor(() =>
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Done" })),
  );
  await audit();
  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("without a built-in or saved client, adding Gmail asks for the user's own client", () => {
  fixture.values.set("clientSetupAtom", NO_CLIENTS);
  render(localized(h(AddAccountDialog, { onClose: vi.fn(), onAdded: vi.fn() })));
  fireEvent.click(screen.getByRole("button", { name: "Gmail" }));
  const form = screen.getByRole("form", { name: "Google client" });
  expect(within(form).getByLabelText("Client ID")).toBeTruthy();
  expect(within(form).getByLabelText("Client secret")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Sign in with Google" })).toBeNull();
  expect(screen.queryByText("Use your own OAuth client")).toBeNull();
});

for (const [choice, name] of [
  ["Gmail", "Google"],
  ["Outlook", "Microsoft"],
] as const) {
  it(`with a built-in client, adding ${choice} signs in directly and keeps own clients behind a disclosure`, async () => {
    fixture.values.set("clientSetupAtom", BUILT_IN_CLIENTS);
    render(localized(h(AddAccountDialog, { onClose: vi.fn(), onAdded: vi.fn() })));
    fireEvent.click(screen.getByRole("button", { name: choice }));
    expect(screen.getByRole("button", { name: `Sign in with ${name}` })).toBeTruthy();
    expect(screen.getByText("New sign-ins use OpenMail's built-in client.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use the built-in client" })).toBeNull();
    const summary = screen.getByRole("button", { name: "Use your own OAuth client" });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("form", { name: `${name} client` })).toBeNull();
    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(summary.getAttribute("aria-controls") ?? "");
    expect(within(panel!).getByRole("form", { name: `${name} client` })).toBeTruthy();
    await audit();
  });
}

it("with the user's own client active, the dialog says so and offers the built-in client", async () => {
  fixture.decide.mockClear();
  fixture.values.set("clientSetupAtom", { ...BUILT_IN_CLIENTS, googleClient: "own" });
  render(localized(h(AddAccountDialog, { onClose: vi.fn(), onAdded: vi.fn() })));
  fireEvent.click(screen.getByRole("button", { name: "Gmail" }));
  expect(screen.getByText("New sign-ins use your own OAuth client.")).toBeTruthy();
  expect(
    screen.getByText("Accounts you already added keep the client they signed in with."),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Use the built-in client" }));
  expect(fixture.decide).toHaveBeenCalledWith("gmail");
  await audit();
});

it("with only the user's own client, the disclosure offers to change it, not a built-in one", () => {
  fixture.values.set("clientSetupAtom", {
    ...NO_CLIENTS,
    googleClient: "own",
  });
  render(localized(h(AddAccountDialog, { onClose: vi.fn(), onAdded: vi.fn() })));
  fireEvent.click(screen.getByRole("button", { name: "Gmail" }));
  expect(screen.getByText("Change your OAuth client")).toBeTruthy();
  expect(screen.queryByText("Use your own OAuth client")).toBeNull();
  expect(screen.queryByRole("button", { name: "Use the built-in client" })).toBeNull();
  expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeTruthy();
});

const listProps = (
  overrides: Partial<Parameters<typeof MessageList>[0]> = {},
): Parameters<typeof MessageList>[0] => ({
  title: "Inbox",
  threads: [thread],
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
  filters: { enabled: false, unread: false, starred: false, important: false, inInbox: false },
  inLabel: false,
  folderActions: null,
  onFilters: vi.fn(),
  labels: new Map(),
  selectedId: null,
  selectedIds: new Set(),
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
  ...overrides,
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
  expect(screen.getByText("Searching server…")).toBeTruthy();
  expect(screen.queryByText("No more messages")).toBeNull();
  view.rerender(list(false));
  expect(screen.queryByText("Searching server…")).toBeNull();
  expect(screen.getByText("No more messages")).toBeTruthy();
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
  readable(screen.getByText("Could not sync me@example.com.", { selector: "p" }), "sync failure");
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
  readable(screen.getByText("No messages here"), "empty list text");
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

it("audits the settings tabs as a horizontal row in a narrow window", async () => {
  vi.stubGlobal("innerWidth", 520);
  render(
    localized(
      h(Settings, {
        initialTab: "general",
        accounts: [account],
        onClose: vi.fn(),
        onAddAccount: vi.fn(),
      }),
    ),
  );
  expect(screen.getByRole("tablist").getAttribute("data-orientation")).toBe("horizontal");
  await audit();
});

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
