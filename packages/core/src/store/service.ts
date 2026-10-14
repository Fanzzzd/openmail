/**
 * The Store port: every SQL read and write in core goes through it. Only
 * `Mailbox` (mailbox/mailbox.ts) is meant for callers outside core; Store is
 * one of the seams its implementation is built from.
 */

import type {
  Account,
  AccountPlacement,
  AccountSettings,
  ImapSettings,
  Label,
  Profile,
  ProfileInput,
  Provider,
} from "../domain/account.js";
import type {
  Actor,
  AgentActivity,
  AgentWriteMode,
  AuditEntry,
  Command,
  Proposal,
} from "../domain/command.js";
import type {
  Address,
  IncomingMessage,
  Message,
  ThreadQuery,
  ThreadSummary,
} from "../domain/message.js";
import type {
  DraftCreateState,
  DraftRemote,
  MailOp,
  OutgoingMessage,
  QueuedOp,
  SendPreparationState,
} from "../domain/changes.js";
import type { Prefs, PrefsPatch, Signature, Template, TemplateInput } from "../domain/prefs.js";
import { Context, type Effect, type Option } from "effect";
import type { makeSemanticStore } from "./store-semantic.js";
import type { makeMediaStore } from "./store-media.js";
import type { AuthError, InvalidInput, NotFound, ProviderError } from "../domain/errors.js";
import type { makeSyncHealthStore } from "./store-sync-health.js";
import type { OptionalService } from "../providers/optional-services.js";
import type { ImapFolderIdentity, ProviderIdMapping } from "../providers/adapter.js";
import type { WordIndexState } from "./store-word-index.js";
import type { DerivedChunk } from "../ai/media.js";
import type { CalendarInvite, InviteResponseRecord } from "../calendar/calendar.js";
import type { BackfillState, CacheWindow, CacheWindowInput } from "../domain/cache.js";
import type {
  AccountOrganization,
  FilterRestoration,
  LabelPreference,
  SendAs,
} from "../domain/organization.js";
import type { QueuedSend } from "../mailbox/mobile-outbox.js";
import type {
  NamedSignature,
  NamedSignatureInput,
  SignatureDefault,
} from "../compose/signatures.js";
import type { ContactGroup, ContactSnapshot, ContactSync } from "../contacts/contacts.js";

export interface PendingOp {
  id: number;
  accountId: string;
  /** The message a MailOp changes; the draft id or remote id for draft ops. */
  providerId: string;
  op: QueuedOp;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  retryAt: number;
  rfcMessageId: string | null;
  progress: readonly string[];
  appendedMessageId: string | null;
}

/** A draft as the store keeps it, with where the provider has its copy. */
/** A discard the person asked for: held until `discardAt`, or done (`discarded`) at that time. */
export interface DraftDiscard {
  readonly id: string;
  readonly discardAt: number;
  readonly discarded: boolean;
}

export interface StoredDraft {
  id: string;
  accountId: string;
  message: OutgoingMessage;
  updatedAt: number;
  proposalId: number | null;
  /** Null until a push lands. */
  remote: DraftRemote | null;
  /** attachmentsKey() of the attachments last pushed. */
  pushedAttachments: string | null;
  pushedOrganization: string | null;
  syncError: string | null;
  localOnly: boolean;
  /** Bumped by every local save. */
  revision: number;
  /** The editor session of the last save, or null when core or an agent wrote it. */
  editor: string | null;
}

/**
 * The only module that runs SQL. Rows are decoded with the domain schemas.
 * SQL and decode failures are defects: they mean a bug or a corrupt file,
 * not something a caller can handle.
 */
/** Local reminder state changed as a side effect of read/move operations. */
export interface ReminderSnapshot {
  accountId: string;
  threadId: string;
  dueAt: number | null;
  wokenAt: number | null;
  wakePending: boolean;
  members: readonly { providerId: string; wakePending: boolean }[];
}

/** A send SMTP accepted whose Sent copy is not filed yet. */
export interface SmtpAcceptedSend {
  readonly draftId: string;
  readonly accountId: string;
  readonly raw: Uint8Array;
  readonly at: number;
  /** Failed attempts to file the Sent copy. */
  readonly tries: number;
  readonly subject: string | undefined;
  readonly sender: string | undefined;
}

export class Store extends Context.Service<
  Store,
  {
    /** Runs `effect` in one SQLite transaction. */
    transaction<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;

    readonly ai: ReturnType<typeof import("./store-ai.js").makeAiStore>;
    readonly semantics: ReturnType<typeof makeSemanticStore>;
    readonly media: ReturnType<typeof makeMediaStore>;

    // Accounts
    setAccountSettings(
      id: string,
      input: AccountSettings,
    ): Effect.Effect<void, NotFound | InvalidInput>;
    moveAccount(id: string, input: AccountPlacement): Effect.Effect<void, NotFound | InvalidInput>;
    rememberNotificationActions(
      id: string,
      actions: import("../domain/prefs.js").Prefs["notificationActions"],
    ): Effect.Effect<void>;
    notificationActions(
      id: string,
    ): Effect.Effect<import("../domain/prefs.js").Prefs["notificationActions"]>;
    readonly syncHealthLabels: ReturnType<typeof makeSyncHealthStore>["syncHealthLabels"];
    readonly syncHealthLocal: ReturnType<typeof makeSyncHealthStore>["syncHealthLocal"];
    readonly diagnosticCounts: ReturnType<
      typeof import("./store-diagnostics.js").makeDiagnosticsStore
    >["diagnosticCounts"];
    /** Runs `PRAGMA optimize` so the query planner has statistics on a growing mailbox. */
    readonly refreshPlannerStats: Effect.Effect<void>;
    readonly listAccounts: Effect.Effect<Account[]>;
    getAccount(id: string): Effect.Effect<Account, NotFound>;
    /** Inserts or returns the existing account `${provider}:${email}`. */
    upsertAccount(provider: Provider, email: string): Effect.Effect<Account>;
    removeAccount(id: string): Effect.Effect<void>;
    purgeAccountProposals(
      accountId: string,
      removeDraft?: (draft: StoredDraft) => Effect.Effect<void>,
    ): Effect.Effect<void>;
    setAccountProfile(id: string, profileId: string | null): Effect.Effect<void>;
    setImapSettings(id: string, settings: ImapSettings): Effect.Effect<void>;
    /** Pauses the account until a new sign-in and records why, once per change, in diagnostics. */
    markReauth(id: string, error: AuthError): Effect.Effect<void>;
    /** A successful sign-in clears the mark and its reason. */
    clearReauth(id: string): Effect.Effect<void>;
    disabledServices(id: string): Effect.Effect<readonly OptionalService[]>;
    /** Services the person turned on or connected; untouched ones are not listed. */
    enabledServices(id: string): Effect.Effect<readonly OptionalService[]>;
    setServiceEnabled(id: string, service: OptionalService, enabled: boolean): Effect.Effect<void>;
    grantedScopes(id: string): Effect.Effect<readonly string[]>;
    setGrantedScopes(id: string, scopes: readonly string[]): Effect.Effect<void>;
    setSyncError(id: string, error: string | null): Effect.Effect<void>;
    getSyncCursor(id: string): Effect.Effect<Option.Option<string>>;
    /** Also stamps last_synced_at. */
    saveSyncCursor(
      id: string,
      cursor: string,
      stamp?: boolean,
      /** When the pull that produced `cursor` started; defaults to now. */
      syncedAt?: number,
    ): Effect.Effect<void>;

    // Messages. Writes keep rowids stable for the FTS index (ON CONFLICT DO UPDATE).
    upsertMessage(accountId: string, m: IncomingMessage): Effect.Effect<void>;
    readonly headerBackfillState: ReturnType<
      typeof import("./store-header-backfill.js").makeHeaderBackfillStore
    >["headerBackfillState"];
    readonly saveHeaderBackfillState: ReturnType<
      typeof import("./store-header-backfill.js").makeHeaderBackfillStore
    >["saveHeaderBackfillState"];
    readonly headerBackfillCandidates: ReturnType<
      typeof import("./store-header-backfill.js").makeHeaderBackfillStore
    >["headerBackfillCandidates"];
    readonly updateCachedHeaders: ReturnType<
      typeof import("./store-header-backfill.js").makeHeaderBackfillStore
    >["updateCachedHeaders"];
    setMessageWebLink(id: string, url: string): Effect.Effect<void>;
    knownSenders(accountId: string, addresses: readonly string[]): Effect.Effect<string[]>;
    rememberMailedAddresses(accountId: string, addresses: readonly string[]): Effect.Effect<void>;
    deleteMessage(accountId: string, providerId: string): Effect.Effect<void>;
    /** Read and starred state only; the rest of the message stays as stored. */
    setFlags(
      accountId: string,
      providerId: string,
      flags: { isUnread: boolean; isStarred: boolean },
    ): Effect.Effect<void>;
    readonly claimStaleSweep: ReturnType<
      typeof import("./store-sync-reset.js").makeSyncResetStore
    >["claimStaleSweep"];
    readonly saveStaleSweepPosition: ReturnType<
      typeof import("./store-sync-reset.js").makeSyncResetStore
    >["saveStaleSweepPosition"];
    readonly saveStaleSweepVerified: ReturnType<
      typeof import("./store-sync-reset.js").makeSyncResetStore
    >["saveStaleSweepVerified"];
    readonly staleCandidates: ReturnType<
      typeof import("./store-sync-reset.js").makeSyncResetStore
    >["staleCandidates"];
    resetCandidates(
      accountId: string,
      change: import("../providers/adapter.js").ResetChange,
    ): Effect.Effect<{
      local: number;
      candidates: readonly import("../sync/sync-records.js").ResetCandidate[];
    }>;
    pendingResetCandidates(
      accountId: string,
    ): Effect.Effect<readonly import("../sync/sync-records.js").ResetCandidate[]>;
    saveResetCandidates(
      accountId: string,
      candidates: readonly import("../sync/sync-records.js").ResetCandidate[],
    ): Effect.Effect<void>;
    deleteMessagesWithLabel(
      accountId: string,
      label: string,
      keep?: readonly string[],
    ): Effect.Effect<void>;
    deleteAccountMessages(
      accountId: string,
      keep?: readonly string[],
      since?: number,
    ): Effect.Effect<void>;
    remapProviderIds(
      accountId: string,
      mappings: readonly ProviderIdMapping[],
    ): Effect.Effect<void, ProviderError>;
    messageIdForProvider(accountId: string, providerId: string): Effect.Effect<string | null>;
    readonly checkpoint: Effect.Effect<void>;
    invalidateImapFolder(
      accountId: string,
      previous: ImapFolderIdentity,
    ): Effect.Effect<readonly string[]>;
    deleteImapFolder(
      accountId: string,
      previous: ImapFolderIdentity,
      keep: readonly string[],
    ): Effect.Effect<void>;
    /** Threads collapsed to their newest message, or full-text results when `search` is set. */
    readonly wordIndexReady: Effect.Effect<WordIndexState>;
    backfillWordIndex(batchSize?: number): Effect.Effect<{ processed: number; ready: boolean }>;
    backfillSearchFlags(batchSize?: number): Effect.Effect<{ processed: number; ready: boolean }>;
    /** Indexes queued rows for one- and two-character CJK search; `ready` when the queue is empty. */
    indexBigrams(batchSize?: number): Effect.Effect<{ processed: number; ready: boolean }>;
    listThreads(q: ThreadQuery): Effect.Effect<ThreadSummary[], InvalidInput>;
    /** Cached matches without page cursors; counts rows, not conversation members. */
    countThreads(q: ThreadQuery): Effect.Effect<number, InvalidInput>;
    vectorThreads(
      q: ThreadQuery,
      hits: readonly DerivedChunk[],
    ): Effect.Effect<ThreadSummary[], InvalidInput>;
    inviteResponse(
      key: Pick<InviteResponseRecord, "accountId" | "uid" | "organizer" | "recurrenceId">,
    ): Effect.Effect<InviteResponseRecord | null>;
    recordInviteResponse(record: InviteResponseRecord): Effect.Effect<void>;
    cacheInvites(messageId: string, invites: readonly CalendarInvite[]): Effect.Effect<void>;
    cachedInvites(accountId: string, uid: string): Effect.Effect<readonly CalendarInvite[]>;
    inviteSiblingIds(
      accountId: string,
      uid: string,
      messageId: string,
    ): Effect.Effect<readonly string[]>;
    findMessageByRfcId(
      accountId: string,
      messageId: string,
      folder?: ImapFolderIdentity,
    ): Effect.Effect<string | null>;
    getMessage(id: string): Effect.Effect<Message, NotFound>;
    /** Every message of the thread `id` belongs to, oldest first. */
    getThread(id: string): Effect.Effect<Message[], NotFound>;
    messageRef(id: string): Effect.Effect<{ accountId: string; providerId: string }, NotFound>;
    threadMessageIds(id: string): Effect.Effect<string[]>;
    /** Message id to account id, one primary-key lookup per id; unknown ids are missing. */
    messageAccounts(ids: readonly string[]): Effect.Effect<ReadonlyMap<string, string>>;
    messageLabels(accountId: string, providerId: string): Effect.Effect<string[]>;
    /** Applies the op to the local labels and flags, following the account's provider model. */
    applyLocalOp(id: string, op: MailOp): Effect.Effect<void>;
    readonly unreadCounts: Effect.Effect<Record<string, number>>;
    unreadByLabel(
      accountIds?: readonly string[],
      within?: string,
      conversations?: boolean,
    ): Effect.Effect<Record<string, number>>;

    readonly cacheDatabaseFile: Effect.Effect<string>;
    readonly cacheNeedsVacuum: Effect.Effect<boolean>;
    readonly cacheDatabaseSize: Effect.Effect<import("../domain/cache.js").DatabasePages>;
    compactCache(
      readOnly: boolean,
    ): Effect.Effect<import("../domain/cache.js").CacheCompactionResult>;
    readonly reclaimCachePages: Effect.Effect<void>;
    readonly cachedBodyBytes: Effect.Effect<number>;
    readonly bodySizes: Effect.Effect<{ accountId: string; bytes: number }[]>;
    clearBodies(accountId: string): Effect.Effect<void>;
    readonly cacheWindows: Effect.Effect<CacheWindow[]>;
    setCacheWindow(input: CacheWindowInput): Effect.Effect<void>;
    /** Evicts bodies through UPDATE triggers, preserving rowids and header FTS. */
    evictBodyBudget(maxBytes: number, force?: boolean, enabled?: boolean): Effect.Effect<number>;
    evictBodies(accountId: string, now: number, force?: boolean): Effect.Effect<number>;
    touchBody(id: string, now: number): Effect.Effect<void>;
    backfillCandidates(
      accountId: string,
      providerIds: readonly string[],
    ): Effect.Effect<readonly string[]>;
    readonly backfillStates: Effect.Effect<BackfillState[]>;
    getBackfillState(accountId: string): Effect.Effect<BackfillState>;
    saveBackfillState(state: BackfillState): Effect.Effect<void>;
    resetBackfill(accountId: string): Effect.Effect<void>;
    setBackfillPaused(accountId: string, paused: boolean): Effect.Effect<void>;

    // Labels
    replaceLabels(
      accountId: string,
      labels: readonly Omit<Label, "accountId">[],
    ): Effect.Effect<void>;
    listLabels(accountIds?: readonly string[]): Effect.Effect<Label[]>;

    readonly labelPreferences: Effect.Effect<LabelPreference[]>;
    filterRestorations(accountId: string): Effect.Effect<FilterRestoration[]>;
    saveFilterRestoration(backup: FilterRestoration): Effect.Effect<void>;
    deleteFilterRestoration(accountId: string, id: string): Effect.Effect<void>;
    setLabelPreference(input: LabelPreference): Effect.Effect<void>;
    moveLabelPreference(accountId: string, from: string, to: string | null): Effect.Effect<void>;
    readonly organization: Effect.Effect<AccountOrganization[]>;
    setOrganization(input: AccountOrganization): Effect.Effect<void>;
    replaceSendAs(accountId: string, aliases: readonly SendAs[]): Effect.Effect<void>;
    readonly sendAs: Effect.Effect<SendAs[]>;
    snooze(id: string, due: number): Effect.Effect<void, NotFound | InvalidInput>;
    reminderSnapshot(id: string): Effect.Effect<Option.Option<ReminderSnapshot>, NotFound>;
    restoreReminder(snapshot: ReminderSnapshot): Effect.Effect<void>;
    wakeSnoozed(now: number): Effect.Effect<string[]>;
    /** Makes active snoozes on these threads due now; returns the threads it changed. */
    endSnoozeOnReply(
      accountId: string,
      threadIds: readonly string[],
      now: number,
    ): Effect.Effect<string[]>;

    // Profiles
    readonly listProfiles: Effect.Effect<Profile[]>;
    createProfile(input: ProfileInput): Effect.Effect<Profile>;
    updateProfile(id: string, input: ProfileInput): Effect.Effect<void>;
    deleteProfile(id: string): Effect.Effect<void>;

    undoHistory: ReturnType<
      typeof import("../mailbox/undo-journal.js").makeUndoStore
    >["undoHistory"];
    undoJournal: ReturnType<
      typeof import("../mailbox/undo-journal.js").makeUndoStore
    >["undoJournal"];
    saveUndoJournal: ReturnType<
      typeof import("../mailbox/undo-journal.js").makeUndoStore
    >["saveUndoJournal"];
    deleteUndoJournal: ReturnType<
      typeof import("../mailbox/undo-journal.js").makeUndoStore
    >["deleteUndoJournal"];

    sendUncertain(id: string): Effect.Effect<boolean>;
    setSendUncertain(id: string, value: boolean): Effect.Effect<void>;
    /**
     * Sends SMTP accepted whose Sent copy may not be filed yet: the outbox writes one right after
     * SMTP 250 and clears it when the send finishes, so a crash in between leaves it behind. A
     * record stays while filing the copy fails; `tries` counts those failures, and `subject` and
     * `sender` are kept for the notice once the draft is gone.
     */
    readonly smtpAccepted: Effect.Effect<readonly SmtpAcceptedSend[]>;
    /** `claim` marks the record as owned by the live send that wrote it. */
    markSmtpAccepted(
      draftId: string,
      accountId: string,
      raw: Uint8Array,
      claim?: string,
    ): Effect.Effect<void>;
    /**
     * Takes the record for `token` when no process holds a live claim on it, so a retry never
     * files a Sent copy while the send that wrote it (here or in another process) still runs.
     */
    claimSmtpAccepted(draftId: string, token: string): Effect.Effect<boolean>;
    /** Keeps `token`'s claim on the record alive. */
    renewSmtpAccepted(draftId: string, token: string): Effect.Effect<void>;
    /** Gives `token`'s claim back, so the next retry can take the record at once. */
    releaseSmtpAccepted(draftId: string, token: string): Effect.Effect<void>;
    clearSmtpAccepted(draftId: string): Effect.Effect<void>;
    /**
     * Counts a failed Sent copy filing, keeps the first subject and sender it was given, and
     * releases the claim.
     */
    noteSentCopyFailure(
      draftId: string,
      message: { subject: string; sender: string },
    ): Effect.Effect<void>;
    readonly queuedSends: Effect.Effect<QueuedSend[]>;
    putQueuedSend(item: QueuedSend): Effect.Effect<void>;
    deleteQueuedSend(id: string): Effect.Effect<void>;

    // Outgoing change queue
    enqueueOp(accountId: string, providerId: string, op: QueuedOp): Effect.Effect<void>;
    readonly listPendingOps: Effect.Effect<PendingOp[]>;
    /** Only queued operations affecting this incoming batch, in queue order. */
    pendingOpsForMessages(
      accountId: string,
      providerIds: readonly string[],
    ): Effect.Effect<PendingOp[]>;
    /**
     * Marks the op as being pushed. False when another process (app, CLI, MCP)
     * holds a live claim on it, so no op is pushed twice at once.
     */
    claimPendingOp(id: number, token: string): Effect.Effect<boolean>;
    /** Gives the claim back without counting an attempt (the account needs a new sign-in). */
    releasePendingOp(id: number, token?: string): Effect.Effect<void>;
    removePendingOp(id: number, token?: string): Effect.Effect<void>;
    /** Counts a failed attempt and releases the claim. */
    /** `offline`: the push failed on connectivity, so a reconnect may retry it early. */
    failPendingOp(
      id: number,
      error: string,
      token?: string,
      offline?: boolean,
    ): Effect.Effect<void>;
    /** Makes ops that failed offline due now without resetting their attempt count. */
    retryPendingOpsNow(): Effect.Effect<void>;

    renewPendingOp(id: number, token: string): Effect.Effect<boolean>;
    ownsPendingOp(id: number, token: string): Effect.Effect<boolean>;
    readonly listFailedOps: Effect.Effect<readonly import("../domain/sync-status.js").FailedOp[]>;
    recordFailedOp(
      entry: Pick<
        import("../domain/sync-status.js").FailedOp,
        "accountId" | "providerId" | "kind" | "reason"
      > & { subject?: string | null; sender?: string | null; rejected?: readonly string[] },
    ): Effect.Effect<void>;
    getFailedOp(
      id: number,
    ): Effect.Effect<
      { notice: import("../domain/sync-status.js").FailedOp; rejected: readonly string[] },
      NotFound
    >;
    recordCopyProgress(
      id: number,
      token: string,
      destination: string,
      providerId: string,
      phase: "issued" | "accepted" | "clear",
    ): Effect.Effect<void, ProviderError>;
    recordAppendedMessageId(
      id: number,
      token: string,
      messageId: string,
    ): Effect.Effect<void, ProviderError>;
    acknowledgeFailedOps(ids: readonly number[]): Effect.Effect<void>;

    // Drafts
    getDraft(id: string): Effect.Effect<Option.Option<StoredDraft>>;
    draftByRemoteMessage(
      accountId: string,
      messageId: string,
    ): Effect.Effect<Option.Option<StoredDraft>>;
    draftByProposal(proposalId: number): Effect.Effect<Option.Option<StoredDraft>>;
    /** Inserts the draft or replaces its content. Where the provider keeps it stays as is. */
    putDraft(draft: {
      id: string;
      accountId: string;
      message: OutgoingMessage;
      proposalId?: number | null;
      /** The editor session saving it; omitted when core or an agent writes it. */
      editor?: string | null;
    }): Effect.Effect<StoredDraft>;
    /** Records the provider's copy. False when the draft was deleted locally meanwhile. */
    setDraftRemote(
      id: string,
      remote: DraftRemote | null,
      pushedAttachments: string | null,
      accountId?: string,
      claim?: { readonly id: number; readonly token: string },
    ): Effect.Effect<boolean>;
    setDraftOrganizationKey(id: string, key: string | null): Effect.Effect<void>;
    draftSaveState(
      id: string,
    ): Effect.Effect<{ readonly pending: boolean; readonly retrying: boolean }>;
    setDraftSyncError(id: string, error: string | null): Effect.Effect<void>;
    setDraftLocalOnly(id: string, localOnly: boolean): Effect.Effect<void>;
    draftCreateState(id: string): Effect.Effect<Option.Option<DraftCreateState>>;
    setDraftCreateState(id: string, state: DraftCreateState | null): Effect.Effect<void>;
    /** Persists the fingerprint of a draft update before it is sent. */
    setDraftWriteNonce(id: string, nonce: string): Effect.Effect<void>;
    sendPreparationState(id: string): Effect.Effect<Option.Option<SendPreparationState>>;
    setSendPreparationState(id: string, state: SendPreparationState | null): Effect.Effect<void>;
    /** Deletes the draft and its queued saves that are not being pushed. */
    deleteDraft(id: string): Effect.Effect<void>;
    /** Queues a push of the draft unless one is already waiting. */
    enqueueDraftSave(accountId: string, draftId: string): Effect.Effect<void>;
    /**
     * Deletes drafts whose provider copy is gone (the message, or every message
     * of the account when `messageId` is unset), unless a push is queued.
     */
    dropSyncedDrafts(accountId: string, messageId?: string): Effect.Effect<void>;
    /** Holds a discard of the draft until `discardAt`; survives a restart. */
    holdDraftDiscard(id: string, discardAt: number): Effect.Effect<void>;
    /** Takes a held discard back. True when one was held. */
    releaseDraftDiscard(id: string): Effect.Effect<boolean>;
    /** Records that the draft was discarded, so a late save of its id fails. */
    markDraftDiscarded(id: string): Effect.Effect<void>;
    draftDiscard(id: string): Effect.Effect<Option.Option<DraftDiscard>>;
    readonly draftDiscards: Effect.Effect<readonly DraftDiscard[]>;
    /** Forgets finished discards recorded before `before`. */
    pruneDraftDiscards(before: number): Effect.Effect<void>;

    // Compose settings
    /** Indexed incoming-message bookkeeping, cascaded with the account. */
    hasMessage(id: string): Effect.Effect<boolean>;
    getInboxError(accountId: string): Effect.Effect<string | null>;
    setInboxError(accountId: string, error: string | null): Effect.Effect<void>;
    beginInitialSync(accountId: string): Effect.Effect<void>;
    finishInitialSync(accountId: string): Effect.Effect<void>;
    notificationsReady(accountId: string): Effect.Effect<boolean>;
    getInboxCursor(accountId: string): Effect.Effect<Option.Option<string>>;
    saveInboxCursor(accountId: string, cursor: string): Effect.Effect<void>;
    /** Atomically remembers an id, including read/suppressed mail. True only once. */
    observeIncoming(accountId: string, identity: string): Effect.Effect<boolean>;
    enqueueNotification(id: string, digest: boolean): Effect.Effect<void>;
    takeNotifications(now: number): Effect.Effect<import("../domain/prefs.js").NotificationBatch[]>;
    readonly prefs: Effect.Effect<Prefs>;
    setPrefs(patch: PrefsPatch): Effect.Effect<void>;
    /** True only the first time a one-off upgrade step claims this marker. */
    claimOnce(marker: string): Effect.Effect<boolean>;
    readonly remoteAccess: Effect.Effect<import("../app/remote-access.js").RemoteAccessSettings>;
    setRemoteAccess(
      settings: import("../app/remote-access.js").RemoteAccessSettings,
    ): Effect.Effect<void>;
    readonly signatures: Effect.Effect<Signature[]>;
    readonly namedSignatures: Effect.Effect<NamedSignature[]>;
    readonly signatureDefaults: Effect.Effect<readonly SignatureDefault[]>;
    saveNamedSignature(
      input: NamedSignatureInput,
      id?: string,
    ): Effect.Effect<NamedSignature, NotFound | InvalidInput>;
    deleteNamedSignature(id: string): Effect.Effect<void>;
    setSignatureDefault(setting: SignatureDefault): Effect.Effect<void, InvalidInput>;
    /** Empty text removes the signature. */
    setSignature(signature: Signature): Effect.Effect<void>;
    readonly templates: Effect.Effect<Template[]>;
    /** Creates a template when `id` is null. */
    saveTemplate(id: string | null, input: TemplateInput): Effect.Effect<Template, NotFound>;
    deleteTemplate(id: string): Effect.Effect<void>;

    // Remote images
    /** Addresses and domains whose mail loads remote images without asking. */
    readonly imageSenders: Effect.Effect<string[]>;
    /** Adds (allowed) or removes an address or domain. Entries are stored lower case. */
    setImageSender(entry: string, allowed: boolean): Effect.Effect<void>;

    // Contacts
    replaceContactExtras(
      accountId: string,
      snapshot: Pick<ContactSnapshot, "groups" | "photos">,
    ): Effect.Effect<void>;
    contactGroups(query: string, accountIds?: readonly string[]): Effect.Effect<ContactGroup[]>;
    contactPhotoSource(
      accountId: string,
      address: string,
    ): Effect.Effect<{ url: string; dataUrl: string | null } | null>;
    cacheContactPhoto(
      accountId: string,
      address: string,
      url: string,
      dataUrl: string,
    ): Effect.Effect<void>;
    senderHistory(
      recipients: readonly string[],
    ): Effect.Effect<import("../compose/compose-sender.js").SenderHistory[]>;
    replaceServerContacts(
      accountId: string,
      contacts: readonly Address[],
      now: number,
    ): Effect.Effect<void>;
    readonly contactSync: Effect.Effect<ContactSync[]>;
    setContactSyncError(
      accountId: string,
      now: number,
      error: string,
      scopeMissing: boolean,
    ): Effect.Effect<void>;
    /**
     * People from local mail history, best first, hidden ones and `exclude`
     * (the address being written from) left out. The person's other
     * accounts stay in when no account scope is supplied.
     */
    suggestContacts(
      query: string,
      limit: number,
      exclude?: string | readonly string[],
      accountIds?: readonly string[],
    ): Effect.Effect<Address[]>;
    contactAlternatives(address: string): Effect.Effect<readonly Address[]>;
    readonly hiddenContacts: Effect.Effect<string[]>;
    setContactHidden(address: string, hidden: boolean): Effect.Effect<void>;

    // Audit, agent policy, proposals
    appendAudit(entry: {
      actor: Actor;
      accountId?: string;
      action: string;
      detail: unknown;
    }): Effect.Effect<void>;
    listAudit(limit: number): Effect.Effect<AuditEntry[]>;
    appendAgentActivity(entry: { client: string; tool: string; ok: boolean }): Effect.Effect<void>;
    listAgentActivity(limit: number): Effect.Effect<AgentActivity[]>;
    agentWriteMode(name: string): Effect.Effect<AgentWriteMode>;
    setAgentWriteMode(name: string, mode: AgentWriteMode): Effect.Effect<void>;
    /** Fails with InvalidInput (too_many_proposals) when an agent's pending limits are full. */
    insertProposal(actor: Actor, command: Command): Effect.Effect<number, InvalidInput>;
    listProposals(status: Proposal["status"]): Effect.Effect<Proposal[]>;
    getProposal(id: number): Effect.Effect<Proposal, NotFound>;
    setProposalStatus(id: number, status: "approved" | "rejected"): Effect.Effect<void>;
  }
>()("openmail/Store") {}
