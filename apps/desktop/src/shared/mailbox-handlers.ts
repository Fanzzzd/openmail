import { Effect } from "effect";
import type { Mailbox } from "@openmail/core/portable";
import { inspectAttachment, InvalidInput } from "@openmail/core/schema";
import type { MailRpcs } from "./rpc";

const USER = { kind: "user", surface: "app" } as const;

type MailboxService = Mailbox["Service"];

/**
 * Sync dies only when another process holds the write lock past the busy timeout. The app's
 * timer syncs again soon, so a button press or a reconnect leaves it to that run.
 */
const syncOrRetryLater = (m: MailboxService) =>
  m.sync.sync().pipe(Effect.catchDefect(() => Effect.succeed([])));

/** A held discard never outlives a minute, whatever the caller asks. */
const MAX_DISCARD_HOLD_MS = 60_000;

/** Where contact suggestions, groups and photos come from. */
export interface ContactsBackend {
  suggest(
    query: string,
    options: { exclude?: string; accountIds?: readonly string[] },
  ): ReturnType<MailboxService["contacts"]["suggestContacts"]>;
  alternatives(address: string): ReturnType<MailboxService["contacts"]["contactAlternatives"]>;
  groups(
    query: string,
    accountIds?: readonly string[],
  ): ReturnType<MailboxService["contacts"]["contactGroups"]>;
  photo(accountId: string, address: string): ReturnType<MailboxService["contacts"]["contactPhoto"]>;
  knownSenders(
    accountId: string,
    addresses: readonly string[],
  ): ReturnType<MailboxService["reading"]["knownSenders"]>;
}

/** Contacts from the mail accounts alone, without Apple Contacts. */
export const accountContacts = (m: MailboxService): ContactsBackend => ({
  suggest: (query, options) => m.contacts.suggestContacts(query, options),
  alternatives: (address) => m.contacts.contactAlternatives(address),
  groups: (query, accountIds) => m.contacts.contactGroups(query, accountIds),
  photo: (accountId, address) =>
    Effect.flatMap(m.app.prefs, (prefs) =>
      prefs.contactPhotos ? m.contacts.contactPhoto(accountId, address) : Effect.succeed(null),
    ),
  knownSenders: (accountId, addresses) => m.reading.knownSenders(accountId, addresses),
});

export interface MailboxHandlerOptions {
  /** Defaults to the mail accounts' own contacts. */
  contacts?: ContactsBackend;
  /** Prefixes the RPC client id in undo-send owners, so clients don't share waiting sends. */
  ownerPrefix?: string;
}

/** Shared by Electron, the remote server and the in-process flow harness. */
export function mailboxHandlers(m: MailboxService, options: MailboxHandlerOptions = {}) {
  const contacts = options.contacts ?? accountContacts(m);
  const ownerPrefix = options.ownerPrefix ?? "";
  return {
    ClientSetup: () => m.accounts.clientSetup,
    SetGoogleClient: ({ clientId, clientSecret }) =>
      m.accounts.setClient({
        google: { clientId: clientId.trim(), clientSecret: clientSecret.trim() },
      }),
    SetMicrosoftClient: ({ clientId }) =>
      m.accounts.setClient({ microsoft: { clientId: clientId.trim() } }),
    ClearClient: ({ provider }) =>
      m.accounts.clearClient(provider === "gmail" ? "google" : "microsoft"),
    OptionalServices: ({ accountId }) => m.accounts.optionalServices(accountId),
    SetServiceEnabled: ({ accountId, service, enabled }) =>
      m.accounts.setServiceEnabled(accountId, service, enabled),
    SyncHealth: ({ accountId }) => m.sync.syncHealth(accountId),
    Accounts: () => m.accounts.accounts,
    SetAccountSettings: ({ accountId, input }) => m.accounts.setAccountSettings(accountId, input),
    MoveAccount: ({ accountId, input }) => m.accounts.moveAccount(accountId, input),
    RemoveAccount: ({ accountId }) =>
      m.organize.perform({ kind: "removeAccount", accountId }, USER),

    CalendarEvents: ({ messageId, key }) => m.calendar.calendarEvents(messageId, key),
    DetectedEvents: ({ messageId }) => m.calendar.detectedEvents(messageId),
    CreateCalendarEvent: ({ messageId, key, edits }) =>
      m.calendar.createCalendarEvent(messageId, key, USER, edits),
    Invitations: ({ messageId }) => m.calendar.invitations(messageId),
    RespondInvite: ({ messageId, key, response, label }) =>
      m.calendar.respondInvite(messageId, key, response, USER, label),
    ContactSync: () => m.contacts.contactSync,
    ImageFromUrl: ({ url }) => m.compose.imageFromUrl(url),
    ImageFromFile: ({ file }) => m.compose.imageFromFile(file),
    SuggestSender: ({ current, recipients, accountIds }) =>
      m.compose.suggestSender(current, recipients, accountIds),
    RefreshContacts: ({ accountId }) => m.contacts.refreshContacts(accountId),

    Threads: ({ query }) => m.reading.threads(query),
    ThreadCount: ({ query }) => m.reading.threadCount(query),
    Thread: ({ id }) => m.reading.readerThread(id),
    RawMessage: ({ id }) => m.reading.rawMessage(id),
    KnownSenders: ({ accountId, addresses }) => contacts.knownSenders(accountId, addresses),
    SuggestContacts: ({ query, exclude, accountIds }) =>
      contacts.suggest(query, {
        ...(exclude === undefined ? {} : { exclude }),
        ...(accountIds === undefined ? {} : { accountIds }),
      }),
    ContactAlternatives: ({ address }) => contacts.alternatives(address),
    ContactGroups: ({ query, accountIds }) => contacts.groups(query, accountIds),
    ContactPhoto: ({ accountId, address }) => contacts.photo(accountId, address),
    IndexingProgress: () => m.ai.indexingProgress,
    SetModelsEnabled: ({ enabled }) => m.ai.setModelsEnabled(enabled),
    SetIndexingPaused: ({ paused }) => m.ai.setIndexingPaused(paused),
    MediaImage: ({ chunk }) => m.ai.mediaImage(chunk),
    InlineImages: ({ id }) => m.reading.inlineImages(id),
    ImageSenders: () => m.reading.imageSenders,
    SetImageSender: ({ entry, allowed }) => m.reading.setImageSender(entry, allowed),
    ReaderAttachments: ({ messageId }) => m.reading.readerAttachments(messageId),
    InspectAttachment: ({ messageId, path }) =>
      m.reading.attachmentPart(messageId, path).pipe(
        Effect.flatMap((content) => {
          const inspection = inspectAttachment(content);
          return inspection
            ? Effect.succeed(inspection)
            : Effect.fail(new InvalidInput({ message: "This attachment cannot be imported" }));
        }),
      ),
    ImportCalendarAttachment: ({ messageId, path, key }) =>
      m.calendar.importCalendarAttachment(messageId, path, key, USER),
    SetClassificationOverride: ({ messageId, classifyAs }) =>
      m.organize.setClassificationOverride(messageId, classifyAs),
    Unsubscribe: ({ messageId }) => m.organize.unsubscribe(messageId, USER),
    EmbeddedMessage: ({ messageId, path }) => m.reading.embeddedMessage(messageId, path),
    MarkUnreadFrom: ({ id }) => m.organize.markUnreadFrom(id),
    Labels: ({ accountIds }) => m.reading.labels(accountIds),
    UnreadCounts: () => m.reading.unreadCounts,
    UnreadByLabel: ({ accountIds, within, conversations }) =>
      m.reading.unreadByLabel(accountIds, within, conversations),

    BackfillState: () => m.sync.backfillState,
    PauseBackfill: ({ accountId, paused }) => m.sync.pauseBackfill(accountId, paused),
    FetchOlder: ({ query }) => m.sync.fetchOlder(query),
    CacheDatabaseSize: () => m.sync.cacheDatabaseSize,
    CompactCache: () => m.sync.compactCache,
    CacheWindows: () => m.sync.cacheWindows,
    SetCacheWindow: ({ input }) => m.sync.setCacheWindow(input),
    SearchServer: ({ query }) => m.reading.searchServer(query),
    ChangeLabel: ({ accountId, change }) => m.organize.changeLabel(accountId, change),
    ReorderFavorites: ({ order }) => m.organize.reorderFavorites(order),
    LabelPreferences: () => m.organize.labelPreferences,
    SetLabelPreference: ({ input }) => m.organize.setLabelPreference(input),
    Organization: () => m.organize.organization,
    SetOrganization: ({ input }) => m.organize.setOrganization(input),
    Snooze: ({ threads, due }) => m.organize.snoozeWithUndo(threads, due),
    Filters: ({ accountId }) => m.organize.filters(accountId),
    PreviewFilter: ({ accountId, criteria }) => m.organize.previewFilter(accountId, criteria),
    PrepareFilter: ({ accountId, input }) => m.organize.prepareFilter(accountId, input),
    FilterRestorations: ({ accountId }) => m.organize.filterRestorations(accountId),
    PrepareFilterRestoration: ({ accountId, id }) =>
      m.organize.prepareFilterRestoration(accountId, id),
    DiscardFilterRestoration: ({ accountId, id, confirmed }) =>
      m.organize.discardFilterRestoration(accountId, id, confirmed),
    RestoreFilter: ({ accountId, id, token, queryDeletionConfirmed }) =>
      m.organize.restoreFilter(accountId, id, token, queryDeletionConfirmed),
    UpdateFilter: ({ accountId, id, input, token }) =>
      m.organize.updateFilter(accountId, id, input, token),
    ApplyFilter: ({ accountId, input, token }) => m.organize.applyFilter(accountId, input, token),
    CreateLabelAndApply: ({ accountId, name, parentId, threads, move, removeLabelId, flat }) =>
      m.organize.createLabelAndApply(accountId, name, parentId, threads, move, removeLabelId, flat),
    CreateFilter: ({ accountId, input, token }) => m.organize.createFilter(accountId, input, token),
    DeleteFilter: ({ accountId, id, confirmed }) =>
      m.organize.deleteFilter(accountId, id, confirmed),
    Vacation: ({ accountId }) => m.organize.vacation(accountId),
    SetVacation: ({ accountId, input }) => m.organize.setVacation(accountId, input),
    SendAs: () => m.organize.sendAs,
    SyncSendAs: ({ accountId }) => m.organize.syncSendAs(accountId),

    Profiles: () => m.accounts.profiles,
    CreateProfile: ({ input }) => m.accounts.createProfile(input),
    UpdateProfile: ({ id, input }) => m.accounts.updateProfile(id, input),
    DeleteProfile: ({ id }) => m.accounts.deleteProfile(id),
    AssignProfile: ({ accountId, profileId }) => m.accounts.assignProfile(accountId, profileId),

    PermanentlyDelete: ({ threads, flat, folder, confirmed }) =>
      m.organize.permanentlyDelete(threads, flat, folder, confirmed),
    EmptyFolder: ({ folder, confirmed }) => m.organize.emptyFolder(folder, confirmed),
    MarkFolderRead: ({ folder }) => m.organize.markFolderRead(folder),
    ResetFavorites: ({ accountIds }) => m.organize.resetFavorites(accountIds),
    Modify: ({ threads, op }) => m.organize.perform({ kind: "modify", threads, op }, USER),
    ModifyWithUndo: ({ threads, op, flat }) => m.organize.modifyWithUndo(threads, op, flat),
    UndoHistory: () => m.organize.undoHistory,
    UndoBatch: ({ undoId }) => m.organize.undoBatch(undoId),
    Send: ({ accountId, message, draftId, archive, confirmResend }) =>
      m.organize.perform(
        {
          kind: "send",
          accountId,
          message,
          ...(draftId === undefined ? {} : { draftId }),
          ...(confirmResend ? { confirmResend: true } : {}),
          ...(archive === undefined ? {} : { archive }),
        },
        USER,
      ),

    QueueUndoSend: ({ draft, due, archive, confirmResend }, { client }) =>
      m.outbox.queueUndoSend(draft, due, {
        archive,
        confirmResend,
        owner: `${ownerPrefix}${client.id}`,
      }),
    AwaitUndoSend: ({ id }) => m.outbox.awaitUndoSend(id),
    CancelWaitingSend: ({ id }) => m.outbox.cancelWaitingSend(id),
    ComposeAttachments: ({ id }) => m.compose.composeAttachments(id),
    SendAgain: ({ id }) => m.outbox.sendAgain(id),
    RecoverDraft: ({ id, action, draft }) => m.compose.recoverDraft(id, action, draft),
    OpenDraft: ({ id }) => m.compose.openDraft(id),
    DraftStatus: ({ id }) => m.compose.draftStatus(id),
    SaveDraft: ({ draft }) => m.compose.saveDraft(draft),
    DiscardDraft: ({ id, holdMs }) =>
      holdMs && holdMs > 0
        ? m.compose.discardDraftLater(id, Math.min(holdMs, MAX_DISCARD_HOLD_MS))
        : m.compose.discardDraft(id).pipe(Effect.as(false)),
    RestoreDraft: ({ id }) => m.compose.restoreDraft(id),

    CacheSize: () => m.sync.cacheSize,
    ClearCache: ({ accountId }) => m.sync.clearCache(accountId),
    InitializeProfiles: ({ accept, names }) => m.accounts.initializeProfiles(accept, names),
    Prefs: () => m.app.prefs,
    NamedSignatures: () => m.compose.namedSignatures,
    SignatureDefaults: () => m.compose.signatureDefaults,
    SaveNamedSignature: ({ input, id }) => m.compose.saveNamedSignature(input, id),
    DeleteNamedSignature: ({ id }) => m.compose.deleteNamedSignature(id),
    SetSignatureDefault: ({ setting }) => m.compose.setSignatureDefault(setting),
    Signatures: () => m.compose.signatures,
    Templates: () => m.compose.templates,
    SaveTemplate: ({ input, id }) => m.compose.saveTemplate(input, id),
    DeleteTemplate: ({ id }) => m.compose.deleteTemplate(id),
    HiddenContacts: () => m.contacts.hiddenContacts,
    SetContactHidden: ({ address, hidden }) => m.contacts.setContactHidden(address, hidden),
    PrepareRejectedResend: ({ noticeId }) => m.compose.prepareRejectedResend(noticeId),
    FailedOps: () => m.proposals.listFailedOps,
    AcknowledgeFailedOps: ({ ids }) => m.proposals.acknowledgeFailedOps(ids),
    Audit: ({ limit }) => m.proposals.audit(limit),
    Proposals: () => m.proposals.proposals,
    DecideProposal: ({ id, approve }) => m.proposals.decideProposal(id, approve, "app"),
    AiSettings: () => m.ai.aiSettings,
    SetAiKey: ({ key }) => m.ai.setAiKey(key),
    SetAiAccount: ({ input }) => m.ai.setAiAccount(input),
    SetAiModel: ({ model }) => m.ai.setAiModel(model),
    AiSummary: ({ id, locale }) => m.ai.aiSummary(id, locale),
    Summarize: ({ id, locale }) => m.ai.summarize(id, locale),
    AskAi: ({ input }) => m.ai.askAi(input),
    ComposeAi: ({ input }) => m.ai.composeAi(input),
    AiTriage: ({ id }) => m.ai.aiTriage(id),
    DecideAiTriage: ({ id, accept }) => m.ai.decideAiTriage(id, accept, "app"),
    AgentWriteMode: () => m.proposals.agentWriteMode,
    SetAgentWriteMode: ({ mode }) => m.proposals.setAgentWriteMode(mode),

    Sync: () => m.sync.resetConnectivity().pipe(Effect.andThen(syncOrRetryLater(m))),
    NetworkChanged: () =>
      m.sync.resetConnectivity().pipe(Effect.andThen(syncOrRetryLater(m)), Effect.asVoid),
    SyncState: () => m.sync.syncState,
    Events: () => m.app.events,
  } satisfies Partial<Parameters<typeof MailRpcs.of>[0]>;
}
