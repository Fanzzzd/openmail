import { Effect } from "effect";
import type { Mailbox } from "@openmail/core/portable";
import { inspectAttachment, InvalidInput } from "@openmail/core/schema";
import type { MailRpcs } from "./rpc";

const USER = { kind: "user", surface: "app" } as const;

type MailboxService = Mailbox["Service"];

/** A held discard never outlives a minute, whatever the caller asks. */
const MAX_DISCARD_HOLD_MS = 60_000;

/** Where contact suggestions, groups and photos come from. */
export interface ContactsBackend {
  suggest(
    query: string,
    options: { exclude?: string; accountIds?: readonly string[] },
  ): ReturnType<MailboxService["compose"]["suggestContacts"]>;
  alternatives(address: string): ReturnType<MailboxService["compose"]["contactAlternatives"]>;
  groups(
    query: string,
    accountIds?: readonly string[],
  ): ReturnType<MailboxService["compose"]["contactGroups"]>;
  photo(accountId: string, address: string): ReturnType<MailboxService["calendar"]["contactPhoto"]>;
  knownSenders(
    accountId: string,
    addresses: readonly string[],
  ): ReturnType<MailboxService["reading"]["knownSenders"]>;
}

/** Contacts from the mail accounts alone, without Apple Contacts. */
export const accountContacts = (m: MailboxService): ContactsBackend => ({
  suggest: (query, options) => m.compose.suggestContacts(query, options),
  alternatives: (address) => m.compose.contactAlternatives(address),
  groups: (query, accountIds) => m.compose.contactGroups(query, accountIds),
  photo: (accountId, address) =>
    Effect.flatMap(m.app.prefs, (prefs) =>
      prefs.contactPhotos ? m.calendar.contactPhoto(accountId, address) : Effect.succeed(null),
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
    ClientSetup: () => m.clientSetup,
    SetGoogleClient: ({ clientId, clientSecret }) =>
      m.setClient({ google: { clientId: clientId.trim(), clientSecret: clientSecret.trim() } }),
    SetMicrosoftClient: ({ clientId }) => m.setClient({ microsoft: { clientId: clientId.trim() } }),
    ClearClient: ({ provider }) => m.clearClient(provider === "gmail" ? "google" : "microsoft"),
    OptionalServices: ({ accountId }) => m.optionalServices(accountId),
    SetServiceEnabled: ({ accountId, service, enabled }) =>
      m.setServiceEnabled(accountId, service, enabled),
    SyncHealth: ({ accountId }) => m.syncHealth(accountId),
    Accounts: () => m.accounts,
    SetAccountSettings: ({ accountId, input }) => m.setAccountSettings(accountId, input),
    MoveAccount: ({ accountId, input }) => m.moveAccount(accountId, input),
    RemoveAccount: ({ accountId }) => m.perform({ kind: "removeAccount", accountId }, USER),

    CalendarEvents: ({ messageId, key }) => m.calendar.calendarEvents(messageId, key),
    DetectedEvents: ({ messageId }) => m.calendar.detectedEvents(messageId),
    CreateCalendarEvent: ({ messageId, key, edits }) =>
      m.calendar.createCalendarEvent(messageId, key, USER, edits),
    Invitations: ({ messageId }) => m.calendar.invitations(messageId),
    RespondInvite: ({ messageId, key, response, label }) =>
      m.calendar.respondInvite(messageId, key, response, USER, label),
    ContactSync: () => m.calendar.contactSync,
    ImageFromUrl: ({ url }) => m.compose.imageFromUrl(url),
    ImageFromFile: ({ file }) => m.compose.imageFromFile(file),
    SuggestSender: ({ current, recipients, accountIds }) =>
      m.compose.suggestSender(current, recipients, accountIds),
    RefreshContacts: ({ accountId }) => m.calendar.refreshContacts(accountId),

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
      m.setClassificationOverride(messageId, classifyAs),
    Unsubscribe: ({ messageId }) => m.unsubscribe(messageId, USER),
    EmbeddedMessage: ({ messageId, path }) => m.reading.embeddedMessage(messageId, path),
    MarkUnreadFrom: ({ id }) => m.markUnreadFrom(id),
    Labels: ({ accountIds }) => m.reading.labels(accountIds),
    UnreadCounts: () => m.reading.unreadCounts,
    UnreadByLabel: ({ accountIds, within, conversations }) =>
      m.reading.unreadByLabel(accountIds, within, conversations),

    BackfillState: () => m.backfillState,
    PauseBackfill: ({ accountId, paused }) => m.pauseBackfill(accountId, paused),
    FetchOlder: ({ query }) => m.fetchOlder(query),
    CacheDatabaseSize: () => m.cacheDatabaseSize,
    CompactCache: () => m.compactCache,
    CacheWindows: () => m.cacheWindows,
    SetCacheWindow: ({ input }) => m.setCacheWindow(input),
    SearchServer: ({ query }) => m.reading.searchServer(query),
    ChangeLabel: ({ accountId, change }) => m.changeLabel(accountId, change),
    ReorderFavorites: ({ order }) => m.reorderFavorites(order),
    LabelPreferences: () => m.labelPreferences,
    SetLabelPreference: ({ input }) => m.setLabelPreference(input),
    Organization: () => m.organization,
    SetOrganization: ({ input }) => m.setOrganization(input),
    Snooze: ({ threads, due }) => m.snoozeWithUndo(threads, due),
    Filters: ({ accountId }) => m.filters(accountId),
    PreviewFilter: ({ accountId, criteria }) => m.previewFilter(accountId, criteria),
    PrepareFilter: ({ accountId, input }) => m.prepareFilter(accountId, input),
    FilterRestorations: ({ accountId }) => m.filterRestorations(accountId),
    PrepareFilterRestoration: ({ accountId, id }) => m.prepareFilterRestoration(accountId, id),
    DiscardFilterRestoration: ({ accountId, id, confirmed }) =>
      m.discardFilterRestoration(accountId, id, confirmed),
    RestoreFilter: ({ accountId, id, token, queryDeletionConfirmed }) =>
      m.restoreFilter(accountId, id, token, queryDeletionConfirmed),
    UpdateFilter: ({ accountId, id, input, token }) => m.updateFilter(accountId, id, input, token),
    ApplyFilter: ({ accountId, input, token }) => m.applyFilter(accountId, input, token),
    CreateLabelAndApply: ({ accountId, name, parentId, threads, move, removeLabelId, flat }) =>
      m.createLabelAndApply(accountId, name, parentId, threads, move, removeLabelId, flat),
    CreateFilter: ({ accountId, input, token }) => m.createFilter(accountId, input, token),
    DeleteFilter: ({ accountId, id, confirmed }) => m.deleteFilter(accountId, id, confirmed),
    Vacation: ({ accountId }) => m.vacation(accountId),
    SetVacation: ({ accountId, input }) => m.setVacation(accountId, input),
    SendAs: () => m.sendAs,
    SyncSendAs: ({ accountId }) => m.syncSendAs(accountId),

    Profiles: () => m.profiles,
    CreateProfile: ({ input }) => m.createProfile(input),
    UpdateProfile: ({ id, input }) => m.updateProfile(id, input),
    DeleteProfile: ({ id }) => m.deleteProfile(id),
    AssignProfile: ({ accountId, profileId }) => m.assignProfile(accountId, profileId),

    PermanentlyDelete: ({ threads, flat, folder, confirmed }) =>
      m.permanentlyDelete(threads, flat, folder, confirmed),
    EmptyFolder: ({ folder, confirmed }) => m.emptyFolder(folder, confirmed),
    MarkFolderRead: ({ folder }) => m.markFolderRead(folder),
    ResetFavorites: ({ accountIds }) => m.resetFavorites(accountIds),
    Modify: ({ threads, op }) => m.perform({ kind: "modify", threads, op }, USER),
    ModifyWithUndo: ({ threads, op, flat }) => m.modifyWithUndo(threads, op, flat),
    UndoHistory: () => m.undoHistory,
    UndoBatch: ({ undoId }) => m.undoBatch(undoId),
    Send: ({ accountId, message, draftId, archive, confirmResend }) =>
      m.perform(
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

    CacheSize: () => m.cacheSize,
    ClearCache: ({ accountId }) => m.clearCache(accountId),
    InitializeProfiles: ({ accept, names }) => m.initializeProfiles(accept, names),
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
    HiddenContacts: () => m.compose.hiddenContacts,
    SetContactHidden: ({ address, hidden }) => m.compose.setContactHidden(address, hidden),
    PrepareRejectedResend: ({ noticeId }) => m.compose.prepareRejectedResend(noticeId),
    FailedOps: () => m.listFailedOps,
    AcknowledgeFailedOps: ({ ids }) => m.acknowledgeFailedOps(ids),
    Audit: ({ limit }) => m.audit(limit),
    Proposals: () => m.proposals,
    DecideProposal: ({ id, approve }) => m.decideProposal(id, approve, "app"),
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
    AgentWriteMode: () => m.agentWriteMode,
    SetAgentWriteMode: ({ mode }) => m.setAgentWriteMode(mode),

    Sync: () => m.resetConnectivity().pipe(Effect.andThen(m.sync())),
    NetworkChanged: () => m.resetConnectivity().pipe(Effect.andThen(m.sync()), Effect.asVoid),
    SyncState: () => m.syncState,
    Events: () => m.app.events,
  } satisfies Partial<Parameters<typeof MailRpcs.of>[0]>;
}
