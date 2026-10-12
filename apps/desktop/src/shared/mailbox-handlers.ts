import { Effect } from "effect";
import type { Mailbox } from "@openmail/core/portable";
import { inspectAttachment, InvalidInput } from "@openmail/core/schema";
import type { MailRpcs } from "./rpc";

const USER = { kind: "user", surface: "app" } as const;

type MailboxService = Mailbox["Service"];

/** Where contact suggestions, groups and photos come from. */
export interface ContactsBackend {
  suggest(
    query: string,
    options: { exclude?: string; accountIds?: readonly string[] },
  ): ReturnType<MailboxService["suggestContacts"]>;
  alternatives(address: string): ReturnType<MailboxService["contactAlternatives"]>;
  groups(
    query: string,
    accountIds?: readonly string[],
  ): ReturnType<MailboxService["contactGroups"]>;
  photo(accountId: string, address: string): ReturnType<MailboxService["contactPhoto"]>;
  knownSenders(
    accountId: string,
    addresses: readonly string[],
  ): ReturnType<MailboxService["knownSenders"]>;
}

/** Contacts from the mail accounts alone, without Apple Contacts. */
export const accountContacts = (m: MailboxService): ContactsBackend => ({
  suggest: (query, options) => m.suggestContacts(query, options),
  alternatives: (address) => m.contactAlternatives(address),
  groups: (query, accountIds) => m.contactGroups(query, accountIds),
  photo: (accountId, address) =>
    Effect.flatMap(m.prefs, (prefs) =>
      prefs.contactPhotos ? m.contactPhoto(accountId, address) : Effect.succeed(null),
    ),
  knownSenders: (accountId, addresses) => m.knownSenders(accountId, addresses),
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

    CalendarEvents: ({ messageId, key }) => m.calendarEvents(messageId, key),
    DetectedEvents: ({ messageId }) => m.detectedEvents(messageId),
    CreateCalendarEvent: ({ messageId, key, edits }) =>
      m.createCalendarEvent(messageId, key, USER, edits),
    Invitations: ({ messageId }) => m.invitations(messageId),
    RespondInvite: ({ messageId, key, response }) =>
      m.respondInvite(messageId, key, response, USER),
    ContactSync: () => m.contactSync,
    ImageFromUrl: ({ url }) => m.imageFromUrl(url),
    ImageFromFile: ({ file }) => m.imageFromFile(file),
    SuggestSender: ({ current, recipients, accountIds }) =>
      m.suggestSender(current, recipients, accountIds),
    RefreshContacts: ({ accountId }) => m.refreshContacts(accountId),

    Threads: ({ query }) => m.threads(query),
    ThreadCount: ({ query }) => m.threadCount(query),
    Thread: ({ id }) => m.readerThread(id),
    RawMessage: ({ id }) => m.rawMessage(id),
    KnownSenders: ({ accountId, addresses }) => contacts.knownSenders(accountId, addresses),
    SuggestContacts: ({ query, exclude, accountIds }) =>
      contacts.suggest(query, {
        ...(exclude === undefined ? {} : { exclude }),
        ...(accountIds === undefined ? {} : { accountIds }),
      }),
    ContactAlternatives: ({ address }) => contacts.alternatives(address),
    ContactGroups: ({ query, accountIds }) => contacts.groups(query, accountIds),
    ContactPhoto: ({ accountId, address }) => contacts.photo(accountId, address),
    IndexingProgress: () => m.indexingProgress,
    SetModelsEnabled: ({ enabled }) => m.setModelsEnabled(enabled),
    SetIndexingPaused: ({ paused }) => m.setIndexingPaused(paused),
    MediaImage: ({ chunk }) => m.mediaImage(chunk),
    InlineImages: ({ id }) => m.inlineImages(id),
    ImageSenders: () => m.imageSenders,
    SetImageSender: ({ entry, allowed }) => m.setImageSender(entry, allowed),
    ReaderAttachments: ({ messageId }) => m.readerAttachments(messageId),
    InspectAttachment: ({ messageId, path }) =>
      m.attachmentPart(messageId, path).pipe(
        Effect.flatMap((content) => {
          const inspection = inspectAttachment(content);
          return inspection
            ? Effect.succeed(inspection)
            : Effect.fail(new InvalidInput({ message: "This attachment cannot be imported" }));
        }),
      ),
    ImportCalendarAttachment: ({ messageId, path, key }) =>
      m.importCalendarAttachment(messageId, path, key, USER),
    SetClassificationOverride: ({ messageId, classifyAs }) =>
      m.setClassificationOverride(messageId, classifyAs),
    Unsubscribe: ({ messageId }) => m.unsubscribe(messageId, USER),
    EmbeddedMessage: ({ messageId, path }) => m.embeddedMessage(messageId, path),
    MarkUnreadFrom: ({ id }) => m.markUnreadFrom(id),
    Labels: ({ accountIds }) => m.labels(accountIds),
    UnreadCounts: () => m.unreadCounts,
    UnreadByLabel: ({ accountIds, within, conversations }) =>
      m.unreadByLabel(accountIds, within, conversations),

    UpdateTokenConfigured: () => m.updateTokenConfigured,
    SetUpdateToken: ({ token }) => m.setUpdateToken(token),
    BackfillState: () => m.backfillState,
    PauseBackfill: ({ accountId, paused }) => m.pauseBackfill(accountId, paused),
    FetchOlder: ({ query }) => m.fetchOlder(query),
    CacheDatabaseSize: () => m.cacheDatabaseSize,
    CompactCache: () => m.compactCache,
    CacheWindows: () => m.cacheWindows,
    SetCacheWindow: ({ input }) => m.setCacheWindow(input),
    SearchServer: ({ query }) => m.searchServer(query),
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
      m.queueUndoSend(draft, due, {
        archive,
        confirmResend,
        owner: `${ownerPrefix}${client.id}`,
      }),
    AwaitUndoSend: ({ id }) => m.awaitUndoSend(id),
    CancelWaitingSend: ({ id }) => m.cancelWaitingSend(id),
    ComposeAttachments: ({ id }) => m.composeAttachments(id),
    SendAgain: ({ id }) => m.sendAgain(id),
    RecoverDraft: ({ id, action, draft }) => m.recoverDraft(id, action, draft),
    OpenDraft: ({ id }) => m.openDraft(id),
    DraftStatus: ({ id }) => m.draftStatus(id),
    SaveDraft: ({ draft }) => m.saveDraft(draft),
    DiscardDraft: ({ id }) => m.discardDraft(id),

    CacheSize: () => m.cacheSize,
    ClearCache: ({ accountId }) => m.clearCache(accountId),
    InitializeProfiles: ({ accept, names }) => m.initializeProfiles(accept, names),
    Prefs: () => m.prefs,
    NamedSignatures: () => m.namedSignatures,
    SignatureDefaults: () => m.signatureDefaults,
    SaveNamedSignature: ({ input, id }) => m.saveNamedSignature(input, id),
    DeleteNamedSignature: ({ id }) => m.deleteNamedSignature(id),
    SetSignatureDefault: ({ setting }) => m.setSignatureDefault(setting),
    Signatures: () => m.signatures,
    Templates: () => m.templates,
    SaveTemplate: ({ input, id }) => m.saveTemplate(input, id),
    DeleteTemplate: ({ id }) => m.deleteTemplate(id),
    HiddenContacts: () => m.hiddenContacts,
    SetContactHidden: ({ address, hidden }) => m.setContactHidden(address, hidden),
    PrepareRejectedResend: ({ noticeId }) => m.prepareRejectedResend(noticeId),
    FailedOps: () => m.listFailedOps,
    AcknowledgeFailedOps: ({ ids }) => m.acknowledgeFailedOps(ids),
    Audit: ({ limit }) => m.audit(limit),
    Proposals: () => m.proposals,
    DecideProposal: ({ id, approve }) => m.decideProposal(id, approve, "app"),
    AiSettings: () => m.aiSettings,
    SetAiKey: ({ key }) => m.setAiKey(key),
    SetAiAccount: ({ input }) => m.setAiAccount(input),
    SetAiModel: ({ model }) => m.setAiModel(model),
    AiSummary: ({ id }) => m.aiSummary(id),
    Summarize: ({ id }) => m.summarize(id),
    AskAi: ({ input }) => m.askAi(input),
    ComposeAi: ({ input }) => m.composeAi(input),
    AiTriage: ({ id }) => m.aiTriage(id),
    DecideAiTriage: ({ id, accept }) => m.decideAiTriage(id, accept, "app"),
    AgentWriteMode: () => m.agentWriteMode,
    SetAgentWriteMode: ({ mode }) => m.setAgentWriteMode(mode),

    Sync: () => m.resetConnectivity().pipe(Effect.andThen(m.sync())),
    NetworkChanged: () => m.resetConnectivity().pipe(Effect.andThen(m.sync()), Effect.asVoid),
    SyncState: () => m.syncState,
    Events: () => m.events,
  } satisfies Partial<Parameters<typeof MailRpcs.of>[0]>;
}
