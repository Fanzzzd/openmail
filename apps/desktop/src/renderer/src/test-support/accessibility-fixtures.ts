import { afterAll, afterEach, beforeEach, expect, vi, type Mock } from "vitest";
import { act, createElement as h, createRef, type ReactNode } from "react";
import { cleanup } from "@testing-library/react";
import axe from "axe-core";
import { setupI18n, i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { AsyncResult } from "effect/reactivity";
import { Effect } from "effect";
import {
  DEFAULT_PREFS,
  type Account,
  type Message,
  type Proposal,
  type ThreadSummary,
} from "@openmail/core/schema";
import type { MessageList } from "../features/mail-list/MessageList";

/** What the mocked atoms and mail calls return, and the spy every mocked mutation calls. */
export const fixture: { values: Map<string, unknown>; decide: Mock } = {
  values: new Map<string, unknown>(),
  decide: vi.fn(),
};

/** The `@effect/atom-react` mock: plain atoms read the fixture, local UI atoms keep their state. */
export const atomReactMock = async (
  actual: typeof import("@effect/atom-react"),
): Promise<Record<string, unknown>> => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    // Plain atoms read a fixed value; mocked queries are strings resolved from the fixture.
    useAtomValue: (atom: string) =>
      atom === "keychainItemLeftAtom"
        ? false
        : AsyncResult.success(
            // A value set to null stays null: a query that found nothing, like no summary.
            fixture.values.has(atom)
              ? fixture.values.get(atom)
              : atom === "nativeCompose"
                ? { photos: false, continuity: false, grammar: false }
                : [],
          ),
    // Mocked queries and mutations are strings; local UI atoms keep their real state.
    useAtom: (atom: unknown) =>
      Atom.isAtom(atom) && Atom.isWritable(atom)
        ? actual.useAtom(atom)
        : [AsyncResult.initial(), fixture.decide],
    useAtomSet: () => fixture.decide,
    useAtomRefresh: () => fixture.decide,
  };
};

export const queriesMock = {
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
  contactGroupsAtom: () => "contactGroupsAtom",
  contactPhotoAtom: () => "contactPhotoAtom",
  calendarEventsAtom: () => "calendarEventsAtom",
  detectedEventsAtom: () => "detectedEventsAtom",
  updateStateAtom: "updateStateAtom",
  appleContactIdentifierAtom: () => "appleContactIdentifierAtom",
  appleContactsStatusAtom: "appleContactsStatusAtom",
};

export const mutationsMock = {
  keychainItemLeftAtom: "keychainItemLeftAtom",
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
  createCalendarEventAtom: "createCalendarEventAtom",
};

export const downloadsMock = async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    downloadsAtom: Atom.make([]),
    downloadsOpenAtom: Atom.make(false),
    downloadsFeedAtom: "downloadsFeed",
  };
};

export const remoteAccessMock = async () => {
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
};

export const rpcMock = {
  MailClient: { query: (tag: string) => tag, mutation: (tag: string) => tag },
  submitAiKey: () => Effect.void,
};

export const mailMock = {
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
  saveDraft: () => Effect.void,
  draftStatus: () => Effect.succeed(null),
  openThreadWindow: () => Effect.void,
  openMessageWindow: () => Effect.void,
  printThread: () => Effect.void,
};

export const account: Account = {
  id: "gmail:me",
  provider: "gmail",
  email: "me@example.com",
  createdAt: 0,
  lastSyncedAt: null,
  lastSyncError: null,
  profileId: null,
  needsReauth: false,
};

export const message: Message = {
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

export const thread: ThreadSummary = { ...message, participants: [message.from], threadCount: 1 };

export const proposal: Proposal = {
  id: 1,
  createdAt: 0,
  status: "pending",
  actor: { kind: "agent", surface: "mcp", name: "Assistant" },
  command: { kind: "modify", threads: [message.id], op: { kind: "archive" } },
};

export const localized = (node: ReactNode) =>
  h(I18nProvider, { i18n: setupI18n({ locale: "en", messages: { en: {} } }) }, node);

export const auditedFixtures = new Set<string>();

export const audit = async () => {
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

/**
 * Registers the shared setup and teardown in the calling test file. `file` is its
 * `import.meta.url`; the allowlist check covers only that file's entries.
 */
export function registerAccessibilityHooks(file: string) {
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
  afterAll(() => {
    for (const entry of moderateAllowlist.filter((item) => file.endsWith(`/${item.file}`)))
      expect(auditedFixtures.has(entry.fixture)).toBe(true);
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
}

export const NO_CLIENTS = {
  googleClient: "none",
  microsoftClient: "none",
  googleBuiltIn: false,
  microsoftBuiltIn: false,
} as const;

export const BUILT_IN_CLIENTS = {
  googleClient: "builtIn",
  microsoftClient: "builtIn",
  googleBuiltIn: true,
  microsoftBuiltIn: true,
} as const;

export const listProps = (
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

/**
 * Snapshot of reviewed moderate axe findings. Match file, fixture, rule and targets,
 * and explain each exception here. Serious/critical findings are never allowed.
 * Empty because the audited fixtures currently have no moderate violations.
 */
export const moderateAllowlist: readonly {
  /** The test file that audits the fixture, such as "accessibility-reader.test.ts". */
  file: string;
  fixture: string;
  rule: string;
  targets: readonly (readonly string[])[];
  reason: string;
}[] = [];
