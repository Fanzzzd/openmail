import type { QueuedSend } from "./mobile-outbox.js";
import type { OptionalService, AuthorizationFeature } from "./optional-services.js";
import type { NamedSignature, NamedSignatureInput, SignatureDefault } from "./signatures.js";
import type { WordIndexState } from "./store-word-index.js";
import type {
  DeleteFolder,
  FolderScope,
  FolderPage,
  FolderListOptions,
  PermanentDeleteBatch,
} from "./folder-actions.js";
import type { DerivedChunk } from "./media.js";
import type { makeSyncHealthStore } from "./store-sync-health.js";
import type { makeSemanticStore } from "./store-semantic.js";
import type { makeMediaStore } from "./store-media.js";
/**
 * Service interfaces inside core. Only `Mailbox` (mailbox.ts) is meant for
 * callers outside core; these are the seams its implementation is built from,
 * each with a live layer and an in-memory layer for tests.
 */
import { Context, type Effect, type Option, type Stream } from "effect";

import type {
  Account,
  AccountSettings,
  AccountPlacement,
  Address,
  AgentWriteMode,
  AuditEntry,
  Actor,
  Command,
  DraftRemote,
  DraftCreateState,
  SendPreparationState,
  InferenceClassification,
  ImapSettings,
  IncomingMessage,
  Label,
  MailOp,
  Message,
  OutgoingMessage,
  Prefs,
  PrefsPatch,
  Profile,
  ProfileInput,
  Proposal,
  Provider,
  QueuedOp,
  Signature,
  Template,
  TemplateInput,
  ThreadQuery,
  ThreadSummary,
} from "./domain.js";
import type {
  FeatureScopeMissing,
  AuthError,
  ClientNotConfigured,
  InvalidInput,
  NotFound,
  ProviderError,
  SettingsScopeMissing,
  ProviderFailure,
  SendUncertain,
} from "./errors.js";
import type {
  InviteResponseRecord,
  CalendarEvent,
  CalendarInvite,
  InviteResponse,
} from "./calendar.js";
import type { ContactSnapshot, ContactGroup, ContactSync } from "./contacts.js";
import type { AttachmentRef } from "./attachments.js";
import type { ImapConnectInput } from "./imap-presets.js";
import type { MarkdownDraftSource } from "./markdown-draft.js";

import type {
  AccountOrganization,
  FilterInput,
  FilterRestoration,
  GmailRuleDefinition,
  LabelChange,
  LabelPreference,
  SendAs,
  ServerFilter,
  Vacation,
} from "./organization.js";

import type { BackfillPage, BackfillState, CacheWindow, CacheWindowInput } from "./cache.js";

// Platform

/**
 * Secrets in the OS keychain: OAuth refresh tokens and IMAP passwords, keyed
 * by account id. Never in the database, config.json or logs.
 */
export class Secrets extends Context.Service<
  Secrets,
  {
    /** None only when the item does not exist; a locked keychain fails with reason "keychain". */
    get(key: string): Effect.Effect<Option.Option<string>, ProviderError>;
    set(key: string, value: string): Effect.Effect<void, ProviderError>;
    remove(key: string): Effect.Effect<void>;
  }
>()("openmail/Secrets") {}

/** OAuth client registrations, per provider. */
export interface ClientConfig {
  google?: { clientId: string; clientSecret: string };
  microsoft?: { clientId: string };
}

/**
 * Where OAuth clients come from. `user` is what the person entered
 * (config.json, mode 600, docs/setup-*.md). `env` is
 * OPENMAIL_GOOGLE_CLIENT_ID/SECRET and OPENMAIL_MICROSOFT_CLIENT_ID at run
 * time. `builtIn` is openmail's own registration, supplied by the host build.
 */
export interface ClientSources {
  user: ClientConfig;
  env: ClientConfig;
  builtIn: ClientConfig;
}

export class AppConfig extends Context.Service<
  AppConfig,
  {
    readonly sources: Effect.Effect<ClientSources>;
    /** Writes the user's clients. Other sources are never written. */
    write(patch: ClientConfig): Effect.Effect<void>;
    /** Removes the user's client for one provider, so new sign-ins fall back to the others. */
    clearUser(provider: keyof ClientConfig): Effect.Effect<void>;
  }
>()("openmail/AppConfig") {}

/**
 * The OAuth client ID that issued each account's refresh token
 * (`accounts.oauth_client_id`). Provider adapters read it on refresh.
 */
export class OAuthIssuers extends Context.Service<
  OAuthIssuers,
  {
    get(accountId: string): Effect.Effect<Option.Option<string>>;
    set(accountId: string, clientId: string): Effect.Effect<void>;
    /** When the stored refresh token was issued by a sign-in (`accounts.oauth_issued_at`). */
    issuedAt(accountId: string): Effect.Effect<Option.Option<number>>;
    setIssuedAt(accountId: string, at: number): Effect.Effect<void>;
  }
>()("openmail/OAuthIssuers") {}

/** Opens a URL in the system browser. Consent pages must never open in an embedded webview. */
export class Browser extends Context.Service<Browser, { open(url: string): Effect.Effect<void> }>()(
  "openmail/Browser",
) {}

export interface AuthorizeRequest {
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scopes: readonly string[];
  extraParams?: Record<string, string>;
  /** Host written into the loopback redirect URI ("localhost" for Azure). The server binds 127.0.0.1. */
  redirectHost?: string;
}

export interface TokenResponse {
  /** Actual grants reported by the authorization server, never inferred from requested scopes. */
  scopes?: readonly string[];
  accessToken: string;
  refreshToken: Option.Option<string>;
  /** Seconds. */
  expiresIn: number;
}

/**
 * Authorization-code flow with PKCE (RFC 8252). Desktop and CLI use a
 * loopback redirect; mobile will use an app URL scheme behind the same
 * interface. `refresh` maps the definitive OAuth error codes to AuthError (reauth.ts).
 */
export class OAuth extends Context.Service<
  OAuth,
  {
    authorize(req: AuthorizeRequest): Effect.Effect<TokenResponse, AuthError | ProviderError>;
    refresh(
      accountId: string,
      req: { tokenUrl: string; clientId: string; clientSecret?: string; refreshToken: string },
    ): Effect.Effect<TokenResponse, AuthError | ProviderError>;
  }
>()("openmail/OAuth") {}

// Storage

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
      actions: import("./domain.js").Prefs["notificationActions"],
    ): Effect.Effect<void>;
    notificationActions(
      id: string,
    ): Effect.Effect<import("./domain.js").Prefs["notificationActions"]>;
    readonly syncHealthLabels: ReturnType<typeof makeSyncHealthStore>["syncHealthLabels"];
    readonly syncHealthLocal: ReturnType<typeof makeSyncHealthStore>["syncHealthLocal"];
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
    saveSyncCursor(id: string, cursor: string, stamp?: boolean): Effect.Effect<void>;

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
      change: import("./sync-reset.js").ResetChange,
    ): Effect.Effect<{
      local: number;
      candidates: readonly import("./sync-reset.js").ResetCandidate[];
    }>;
    pendingResetCandidates(
      accountId: string,
    ): Effect.Effect<readonly import("./sync-reset.js").ResetCandidate[]>;
    saveResetCandidates(
      accountId: string,
      candidates: readonly import("./sync-reset.js").ResetCandidate[],
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
    readonly cacheDatabaseSize: Effect.Effect<import("./cache.js").DatabasePages>;
    compactCache(readOnly: boolean): Effect.Effect<import("./cache.js").CacheCompactionResult>;
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

    // Profiles
    readonly listProfiles: Effect.Effect<Profile[]>;
    createProfile(input: ProfileInput): Effect.Effect<Profile>;
    updateProfile(id: string, input: ProfileInput): Effect.Effect<void>;
    deleteProfile(id: string): Effect.Effect<void>;

    undoHistory: ReturnType<typeof import("./undo-journal.js").makeUndoStore>["undoHistory"];
    undoJournal: ReturnType<typeof import("./undo-journal.js").makeUndoStore>["undoJournal"];
    saveUndoJournal: ReturnType<
      typeof import("./undo-journal.js").makeUndoStore
    >["saveUndoJournal"];
    deleteUndoJournal: ReturnType<
      typeof import("./undo-journal.js").makeUndoStore
    >["deleteUndoJournal"];

    sendUncertain(id: string): Effect.Effect<boolean>;
    setSendUncertain(id: string, value: boolean): Effect.Effect<void>;
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
    readonly listFailedOps: Effect.Effect<readonly import("./domain.js").FailedOp[]>;
    recordFailedOp(
      entry: Pick<
        import("./domain.js").FailedOp,
        "accountId" | "providerId" | "kind" | "reason"
      > & { subject?: string | null; sender?: string | null; rejected?: readonly string[] },
    ): Effect.Effect<void>;
    getFailedOp(
      id: number,
    ): Effect.Effect<
      { notice: import("./domain.js").FailedOp; rejected: readonly string[] },
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
    takeNotifications(now: number): Effect.Effect<import("./domain.js").NotificationBatch[]>;
    readonly prefs: Effect.Effect<Prefs>;
    setPrefs(patch: PrefsPatch): Effect.Effect<void>;
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
    ): Effect.Effect<import("./compose-sender.js").SenderHistory[]>;
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
      exclude?: string,
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
    agentWriteMode(name: string): Effect.Effect<AgentWriteMode>;
    setAgentWriteMode(name: string, mode: AgentWriteMode): Effect.Effect<void>;
    insertProposal(actor: Actor, command: Command): Effect.Effect<number>;
    listProposals(status: Proposal["status"]): Effect.Effect<Proposal[]>;
    getProposal(id: number): Effect.Effect<Proposal, NotFound>;
    setProposalStatus(id: number, status: "approved" | "rejected"): Effect.Effect<void>;
  }
>()("openmail/Store") {}

// Providers

export type ProviderPushResult = void | readonly ProviderIdMapping[] | { readonly reconcile: true };
export interface ProviderPushContext {
  readonly messageIds: ReadonlyMap<string, string>;
  readonly progress?: ReadonlySet<string>;
  readonly beforeCopy?: (
    destination: string,
    providerIds: readonly string[],
  ) => Effect.Effect<void, ProviderError>;
  readonly afterCopy?: (
    destination: string,
    providerIds: readonly string[],
  ) => Effect.Effect<void, ProviderError>;
  readonly clearCopy?: (
    destination: string,
    providerIds: readonly string[],
  ) => Effect.Effect<void, ProviderError>;
  readonly beforeAppendDraft?: (messageId: string) => Effect.Effect<void, ProviderError>;
  readonly appendedDraftMessageId?: string;
}

/**
 * What a provider's pull yields, in order. The sync loop applies each change
 * to the store as it arrives; a `Cursor` is a checkpoint: everything before
 * it has landed, so a sync cut short resumes from there.
 */
export interface ProviderIdMapping {
  readonly from: string;
  readonly to: string;
}
export interface ImapFolderIdentity {
  readonly path: string;
  readonly uidValidity: string;
}
export type Change =
  | { readonly _tag: "InvalidateFolder"; readonly previous: ImapFolderIdentity }
  | {
      readonly _tag: "RebuildFolder";
      readonly previous: ImapFolderIdentity;
      readonly keep: readonly string[];
      readonly since?: number;
      readonly partial?: boolean;
      /** A window sweep only reconciles explicitly scanned ids. */
      readonly candidates?: readonly string[];
    }
  | {
      readonly _tag: "Remap";
      readonly message: IncomingMessage;
      readonly previous: ImapFolderIdentity;
    }
  | {
      readonly _tag: "MessageLabels";
      readonly providerId: string;
      readonly labels: readonly string[];
    }
  /** Ambiguous provider locations must be resolved by the durable verification queue. */
  | { readonly _tag: "VerifyCandidates"; readonly providerIds: readonly string[] }
  | { readonly _tag: "FetchLater"; readonly providerId: string }
  | { readonly _tag: "Upsert"; readonly message: IncomingMessage }
  | { readonly _tag: "Delete"; readonly providerId: string }
  /** Only the read and starred state changed; cheaper than an Upsert of the whole message. */
  | {
      readonly _tag: "Flags";
      readonly providerId: string;
      readonly isUnread: boolean;
      readonly isStarred: boolean;
    }
  /** Drop local messages carrying this label, preserving IDs delivered by a completed restart. */
  | {
      readonly _tag: "DeleteLabel";
      readonly label: string;
      readonly keep?: readonly string[];
      readonly since?: number;
      readonly partial?: boolean;
    }
  /** Drop local account messages, preserving IDs delivered by a completed reset. */
  | {
      readonly _tag: "Reset";
      readonly keep?: readonly string[];
      readonly since?: number;
      readonly partial?: boolean;
    }
  | { readonly _tag: "BackfillReset" }
  | { readonly _tag: "Labels"; readonly labels: readonly Omit<Label, "accountId">[] }
  | { readonly _tag: "Progress"; readonly fetched: number; readonly total: number }
  | { readonly _tag: "Cursor"; readonly cursor: string };

/** `loginHint` names the account to sign in as, so the consent page does not pick another one. */
export type ConnectInput =
  | {
      readonly provider: "gmail";
      readonly loginHint?: string;
      readonly feature?: AuthorizationFeature;
      readonly grantedScopes?: readonly string[];
    }
  | {
      readonly provider: "outlook";
      readonly loginHint?: string;
      readonly feature?: OptionalService;
      readonly grantedScopes?: readonly string[];
    }
  | { readonly provider: "imap"; readonly input: ImapConnectInput };

/** What a successful sign-in hands back. The secret goes to the keychain, the rest to the store. */
export interface Connected {
  scopes?: readonly string[];
  email: string;
  secret: string;
  /** The OAuth client that issued `secret`. Refresh must use the same one. */
  clientId?: string;
  imap?: ImapSettings;
}

/**
 * One provider's network side. Adapters never touch the store: they read
 * credentials through Secrets and report what changed. Their own
 * dependencies (HttpClient, OAuth, AppConfig, Secrets) are captured when the
 * layer builds them, so the methods need nothing further.
 */
export interface ProviderSearchPage {
  readonly messages: readonly IncomingMessage[];
  readonly truncated: boolean;
}
export interface ProviderAdapter {
  /** Clear only local outage backoff after wake or network change; retain server Retry-After. */
  resetConnectivity?(): Effect.Effect<void>;
  /**
   * Refreshes the OAuth token when this process has not done so for `maxAge` ms, so an
   * idle refresh token stays in use. True when it refreshed. Not a mailbox read or write.
   */
  keepAlive?(accountId: string, maxAge: number): Effect.Effect<boolean, AuthError | ProviderError>;
  /** Bounded metadata-only reads. Unavailable rows stay for normal verification. */
  fetchCachedHeaders?(
    account: Account,
    ids: readonly string[],
  ): Effect.Effect<readonly import("./header-backfill.js").CachedHeaders[], ProviderFailure>;
  /** Counts only; an undercount can be checked against message-ID listings. */
  folderStatus(
    account: Account,
    scope: string,
    recheck?: {
      readonly localTotal: number;
      readonly summary: import("./sync-health.js").FolderStatus;
    },
  ): Effect.Effect<import("./sync-health.js").FolderStatus, ProviderFailure>;
  /** Omitted/failed results remain local and are retried on the next foreground sync. */
  verifyResetCandidates?(
    account: Account,
    candidates: readonly import("./sync-reset.js").ResetCandidate[],
  ): Effect.Effect<readonly import("./sync-reset.js").ResetVerification[], ProviderFailure>;

  /** One bounded page, used only as positive evidence that a Gmail draft still exists. */
  draftMessageIds?(account: Account): Effect.Effect<readonly string[], ProviderFailure>;

  /** Close local pooled resources on account changes or app background. */
  closeSessions?(accountId?: string): Effect.Effect<void>;
  watchInbox?(
    this: void,
    account: Account,
    signal: AbortSignal,
    changed: () => void,
    ready: () => void,
  ): Effect.Effect<"unsupported" | void, ProviderFailure>;
  calendarEvents?(
    account: Account,
    event: CalendarEvent,
  ): Effect.Effect<CalendarEvent[], ProviderFailure | FeatureScopeMissing | InvalidInput>;
  createCalendarEvent?(
    account: Account,
    event: CalendarEvent,
  ): Effect.Effect<void, ProviderFailure | FeatureScopeMissing | InvalidInput>;

  listFolderMessages(
    account: Account,
    folder: FolderScope,
    cursor: string | null,
    options?: FolderListOptions,
  ): Effect.Effect<FolderPage, ProviderFailure>;
  /** Bounded unread-only action. IMAP groups UIDs; Outlook bounds request concurrency. */
  markReadBatch(account: Account, ids: readonly string[]): Effect.Effect<void, ProviderFailure>;
  /** Verify the current connection can safely delete before any account is mutated. */
  checkPermanentDelete(
    account: Account,
    folder: DeleteFolder,
  ): Effect.Effect<readonly string[], ProviderFailure>;
  /** App-only permanent removal. At most FOLDER_BATCH_LIMIT ids. */
  permanentlyDelete(
    account: Account,
    ids: readonly string[],
    folder: DeleteFolder,
  ): Effect.Effect<PermanentDeleteBatch, ProviderFailure | FeatureScopeMissing | InvalidInput>;
  contactSnapshot?(
    account: Account,
  ): Effect.Effect<ContactSnapshot, ProviderFailure | FeatureScopeMissing | InvalidInput>;
  contacts(
    account: Account,
  ): Effect.Effect<Address[], ProviderFailure | FeatureScopeMissing | InvalidInput>;
  respondInvite(
    account: Account,
    providerId: string,
    invite: CalendarInvite,
    response: InviteResponse,
  ): Effect.Effect<void, ProviderFailure | FeatureScopeMissing | InvalidInput>;

  /** One bounded historical page. Independent of the normal sync cursor. */
  backfill(
    account: Account,
    state: Pick<BackfillState, "cursor" | "before">,
    select?: (ids: readonly string[]) => Effect.Effect<readonly string[]>,
  ): Effect.Effect<BackfillPage, ProviderFailure>;
  /** Fetch one complete body on opening an evicted message. */
  fetchMessage(
    account: Account,
    providerId: string,
  ): Effect.Effect<IncomingMessage, ProviderFailure>;
  search(account: Account, query: ThreadQuery): Effect.Effect<ProviderSearchPage, ProviderFailure>;
  setClassificationOverride?(
    account: Account,
    sender: Address,
    classifyAs: InferenceClassification,
  ): Effect.Effect<void, ProviderFailure>;
  changeLabel(
    account: Account,
    change: LabelChange,
  ): Effect.Effect<readonly Omit<Label, "accountId">[], ProviderFailure>;
  filters(account: Account): Effect.Effect<ServerFilter[], ProviderFailure | SettingsScopeMissing>;
  createFilter(
    account: Account,
    input: FilterInput,
  ): Effect.Effect<ServerFilter, ProviderFailure | SettingsScopeMissing>;
  updateFilter(
    account: Account,
    id: string,
    input: FilterInput,
    onRestoreFailure?: (definition: GmailRuleDefinition) => Effect.Effect<void>,
  ): Effect.Effect<ServerFilter, ProviderFailure | SettingsScopeMissing>;
  restoreFilter?(
    account: Account,
    definition: GmailRuleDefinition,
  ): Effect.Effect<ServerFilter, ProviderFailure | SettingsScopeMissing>;
  deleteFilter(
    account: Account,
    id: string,
  ): Effect.Effect<void, ProviderFailure | SettingsScopeMissing>;
  vacation(account: Account): Effect.Effect<Vacation, ProviderFailure | SettingsScopeMissing>;
  setVacation(
    account: Account,
    input: Vacation,
  ): Effect.Effect<void, ProviderFailure | SettingsScopeMissing>;
  sendAs(account: Account): Effect.Effect<SendAs[], ProviderFailure | SettingsScopeMissing>;

  connect(
    input: ConnectInput,
  ): Effect.Effect<Connected, AuthError | ProviderError | ClientNotConfigured | InvalidInput>;
  /** Inbox polls have their own cursor and skip folder discovery and settings. */
  pull(
    account: Account,
    cursor: Option.Option<string>,
    scope?: "inbox",
    incrementalOnly?: boolean,
  ): Stream.Stream<Change, ProviderFailure>;
  push(
    account: Account,
    providerId: string,
    op: MailOp,
    /** Latest persisted IMAP folder state, also available before the adapter's first pull. */
    cursor?: string,
    context?: ProviderPushContext,
  ): Effect.Effect<ProviderPushResult, ProviderFailure>;
  /** Folder/label operations; callers cap each request at 1000 IDs. */
  pushBatch?(
    this: void,
    account: Account,
    providerIds: readonly string[],
    op: MailOp,
    /** Latest persisted IMAP folder state, also available before the adapter's first pull. */
    cursor?: string,
    context?: ProviderPushContext,
  ): Effect.Effect<ProviderPushResult, ProviderFailure>;
  /**
   * `original` is the message replied to or forwarded, when there is one. The
   * adapter fetches its threading headers from the provider.
   */
  send(
    account: Account,
    message: OutgoingMessage,
    original: Option.Option<{ providerId: string; threadId: string }>,
    preparation?: SendPreparation,
  ): Effect.Effect<
    void | { readonly rejected?: readonly string[]; readonly sentCopyMissing?: boolean },
    ProviderFailure | SendUncertain
  >;
  /**
   * Creates the provider's copy of a draft (`remote` null) or replaces it.
   * Returns where it lives now; Gmail and IMAP give it a new message id on
   * every save. A copy deleted on the server meanwhile is created again.
   */
  saveDraft(
    account: Account,
    draft: DraftPush,
    context?: ProviderPushContext,
  ): Effect.Effect<DraftSaveResult, ProviderFailure>;
  draftVersion?(account: Account, providerId: string): Effect.Effect<DraftVersion, ProviderFailure>;
  getDraftOrganization?(
    account: Account,
    id: string,
  ): Effect.Effect<NonNullable<OutgoingMessage["draftOrganization"]>, ProviderFailure>;
  /** Providers that label the created message separately, after its remote ID is durable. */
  setDraftOrganization?(
    account: Account,
    id: string,
    organization: NonNullable<OutgoingMessage["draftOrganization"]>,
  ): Effect.Effect<void, ProviderFailure>;
  /** Deletes the provider's copy. One that is already gone counts as deleted. */
  deleteDraft(account: Account, remote: DraftRemote): Effect.Effect<void, ProviderFailure>;
  /** Graph preserves editable Markdown source as a draft extended property. */
  draftMarkdownSource?(
    account: Account,
    providerId: string,
  ): Effect.Effect<MarkdownDraftSource | undefined, ProviderFailure>;
  /** The message as raw RFC 5322 bytes: for forwarding as an attachment, opening drafts and View Original. */
  fetchRaw(
    account: Account,
    providerId: string,
    maxBytes?: number,
  ): Effect.Effect<Uint8Array, ProviderFailure>;
  /** One attachment's content, decoded, through the provider's per-part API. */
  fetchAttachment(
    account: Account,
    providerId: string,
    ref: AttachmentRef,
  ): Effect.Effect<Uint8Array, ProviderFailure>;
}

export interface DraftVersion {
  readonly changeKey?: string;
  readonly lastModifiedDateTime?: string;
}

export interface DraftSaveResult extends DraftRemote {
  readonly cleanupMessageIds?: readonly string[];
  readonly cleanupMessageId?: string;
  readonly conflict?: boolean;
  readonly saveError?: ProviderFailure;
  readonly replacedMessageId?: string;
}

export interface DraftPush {
  /** Durable creation journal supplied by the queue; callbacks finish before network writes. */
  readonly creation: {
    readonly begin: () => Effect.Effect<DraftCreateState, ProviderFailure>;
    readonly attempted: (
      messageId: string,
      attempted?: boolean,
    ) => Effect.Effect<void, ProviderFailure>;
    readonly missing: () => Effect.Effect<boolean, ProviderFailure>;
    readonly remember: (remote: DraftRemote) => Effect.Effect<void>;
  };
  readonly remote: DraftRemote | null;
  /** Ready to send: Markdown rendered, a forwarded original attached. */
  readonly message: OutgoingMessage;
  readonly original: Option.Option<{ providerId: string; threadId: string }>;
  /** The attachments changed since the last push (providers that upload them one by one). */
  readonly replaceAttachments: boolean;
}

export interface SendPreparation {
  readonly load: Effect.Effect<Option.Option<SendPreparationState>>;
  readonly save: (state: SendPreparationState | null) => Effect.Effect<void>;
}

export class Providers extends Context.Service<
  Providers,
  { get(provider: Provider): ProviderAdapter }
>()("openmail/Providers") {}
