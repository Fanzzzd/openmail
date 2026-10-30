import type { ModelThread } from "../ai/model-thread.js";
import type { QueuedSend } from "./mobile-outbox.js";
import type {
  OptionalService,
  AuthorizationFeature,
  ServiceGrant,
} from "../providers/optional-services.js";
import type {
  AiSettings,
  AiAccountSettings,
  AiModelName,
  AiSummary,
  AiEvent,
  AiQuestion,
  AiComposeRequest,
  AiTriage,
} from "../ai/ai.js";
import type {
  NamedSignature,
  NamedSignatureInput,
  SignatureDefault,
} from "../compose/signatures.js";
import type { ReaderAttachment, EmbeddedMessage } from "../mime/attachment-view.js";
import type { FolderScope, DeleteFolder } from "../domain/folder-actions.js";
import type { DerivedChunk, IndexingProgress } from "../ai/media.js";
/**
 * Mailbox: the one interface desktop, CLI, MCP and the assistant use. Reading,
 * changing and syncing mail all go through here, so policy, audit and the
 * change queue hold for every caller.
 */
import { Context, type Effect, Schema, type Stream } from "effect";

import { SyncProgress as SyncProgressSchema } from "../domain/sync-status.js";
import type {
  Account,
  AccountSettings,
  AccountPlacement,
  Label,
  Profile,
  ProfileInput,
} from "../domain/account.js";
import type {
  BatchResult,
  UndoHistoryEntry,
  Actor,
  AgentWriteMode,
  AuditEntry,
  AgentActivity,
  Command,
  Outcome,
  Proposal,
} from "../domain/command.js";
import type { MailOp, Draft, DraftInput, OutgoingAttachment } from "../domain/changes.js";
import type {
  Address,
  InferenceClassification,
  Message,
  ThreadQuery,
  ThreadSummary,
} from "../domain/message.js";
import type { Prefs, PrefsPatch, Signature, Template, TemplateInput } from "../domain/prefs.js";
import type { SyncResult } from "../domain/sync-status.js";
import type {
  FeatureScopeMissing,
  AuthError,
  ClientNotConfigured,
  DatabaseBusy,
  DraftConflict,
  IndexNotReady,
  InvalidInput,
  NotFound,
  PermanentError,
  ProviderError,
  SendUncertain,
  SettingsScopeMissing,
} from "../domain/errors.js";
import type {
  CalendarEvent,
  CalendarEventEdits,
  CalendarInvite,
  InviteResponse,
} from "../calendar/calendar.js";
import type { ContactSync, ContactGroup } from "../contacts/contacts.js";
import type { ClientConfig } from "../platform/auth.js";
import type { ConnectInput } from "../providers/adapter.js";

import type {
  AccountOrganization,
  FilterCriteria,
  FilterPreview,
  FilterInput,
  FilterRestoration,
  FilterRestorationPreview,
  LabelChange,
  LabelPreference,
  SearchResult,
  SendAs,
  ServerFilter,
  Vacation,
} from "../domain/organization.js";

import type { BackfillState, CacheWindow, CacheWindowInput } from "../domain/cache.js";

import type { UpdateClient } from "../app/updates.js";

export const SyncState = Schema.Struct({
  running: Schema.Boolean,
  lastFinishedAt: Schema.NullOr(Schema.Number),
  errors: Schema.Array(Schema.String),
});
export type SyncState = typeof SyncState.Type;

export const MailboxEvent = Schema.Union([
  Schema.TaggedStruct("SyncState", { state: SyncState }),
  Schema.TaggedStruct("SyncProgress", { progress: SyncProgressSchema }),
  /** Newly observed unread inbox mail, after it is committed. First sync is silent. */
  Schema.TaggedStruct("NewMail", { accountId: Schema.String, ids: Schema.Array(Schema.String) }),
  /** Due reminders restored to Inbox, after the local transaction commits. */
  Schema.TaggedStruct("SnoozeDue", {
    accountId: Schema.String,
    ids: Schema.Array(Schema.String),
    wokenAt: Schema.Number,
  }),
  Schema.TaggedStruct("BackfillProgress", {}),
  Schema.TaggedStruct("UpdateSettingsChanged", { resetState: Schema.Boolean }),
  /** Local mail, accounts, proposals or settings changed; views should refetch. */
  Schema.TaggedStruct("Changed", {}),
  /**
   * Only window layout prefs changed (sidebar, toolbar, reading pane). Views refetch the prefs
   * alone; no mail, count or list depends on them.
   */
  Schema.TaggedStruct("PrefsChanged", {}),
]);
export type MailboxEvent = typeof MailboxEvent.Type;

/** An attachment's content, fetched from the provider. */
export interface AttachmentContent {
  readonly filename: string;
  readonly mimeType: string;
  readonly data: Uint8Array;
}

export type AttachmentPartResult =
  | { readonly kind: "file"; readonly path: readonly number[]; readonly content: AttachmentContent }
  | {
      readonly kind: "failed";
      readonly path: readonly number[];
      readonly filename: string;
      readonly error: PerformError;
    };

export type SignInError = AuthError | ProviderError | ClientNotConfigured | InvalidInput;
/** What performing a command can fail with. Policy denials are an Outcome, not an error. */
export type PerformError =
  | NotFound
  | InvalidInput
  | AuthError
  | PermanentError
  | ProviderError
  | SettingsScopeMissing
  | FeatureScopeMissing
  | SendUncertain
  | DraftConflict;

/** Local reads and provider fetches for one message or thread. Part: mailbox-reading.ts. */
export interface MailboxReading {
  threads(q: ThreadQuery): Effect.Effect<ThreadSummary[], InvalidInput>;
  /** Local read: no writes or provider requests (CLI/MCP default). */
  privateMailLink(id: string, kind: "message" | "thread"): Effect.Effect<string, NotFound>;
  resolveMailLink(id: string): Effect.Effect<string, PerformError>;
  thread(id: string): Effect.Effect<Message[], NotFound>;
  thread(id: string, view: "model", tokenBudget?: number): Effect.Effect<ModelThread, NotFound>;
  /** Explicit reader hydration. Failed bodies retain their headers. */
  readerThread(id: string): Effect.Effect<Message[], PerformError>;
  threadForModel(
    id: string,
    maxChars?: number,
  ): Effect.Effect<ModelThread, NotFound | InvalidInput>;
  /** The message's original source (RFC 5322) from the provider, as text. */
  rawMessage(id: string): Effect.Effect<string, PerformError>;
  /** Original bytes for lossless EML export. */
  rawMessageBytes(id: string): Effect.Effect<Uint8Array, PerformError>;
  /** A validated official web URL; hydrates old Outlook caches on explicit request. */
  messageWebUrl(id: string): Effect.Effect<string, PerformError>;
  knownSenders(accountId: string, addresses: readonly string[]): Effect.Effect<string[]>;
  /** One attachment of a message, by its position in `Message.attachments`. */
  attachment(messageId: string, index: number): Effect.Effect<AttachmentContent, PerformError>;
  attachmentPart(
    messageId: string,
    path: readonly number[],
  ): Effect.Effect<AttachmentContent, PerformError>;
  attachmentParts(
    messageId: string,
    paths: readonly (readonly number[])[],
  ): Effect.Effect<AttachmentPartResult[], PerformError>;
  readerAttachments(messageId: string): Effect.Effect<ReaderAttachment[], PerformError>;
  embeddedMessage(
    messageId: string,
    path: readonly number[],
  ): Effect.Effect<EmbeddedMessage, PerformError>;
  /** The message's inline images (cid: parts) as data: URLs keyed by Content-ID. */
  inlineImages(messageId: string): Effect.Effect<Record<string, string>, PerformError>;
  /** Addresses and domains whose mail loads remote images without asking. */
  readonly imageSenders: Effect.Effect<string[]>;
  /** Adds (allowed) or removes an address ("news@shop.com") or domain ("shop.com"). */
  setImageSender(entry: string, allowed: boolean): Effect.Effect<void>;
  labels(accountIds?: readonly string[]): Effect.Effect<Label[]>;
  readonly unreadCounts: Effect.Effect<Record<string, number>>;
  unreadByLabel(
    accountIds?: readonly string[],
    within?: string,
    conversations?: boolean,
  ): Effect.Effect<Record<string, number>>;

  /** Desktop already runs local search separately; includeLocal=false avoids doing it twice. */
  searchServer(
    query: ThreadQuery,
    options?: { readonly includeLocal?: boolean },
  ): Effect.Effect<SearchResult, InvalidInput>;
  /**
   * Whether the word index covers every message. Until it does (after an upgrade rebuilds it),
   * search is approximate: AROUND matches as AND, and words also match inside longer words.
   */
  readonly searchIndexReady: Effect.Effect<boolean>;
  /**
   * Builds the rest of the word index now, in short committed batches, and says whether it is
   * ready. False when another process holds the write lock. The app builds it in the
   * background; one-shot CLI commands and agent search call this before they search.
   */
  readonly finishSearchIndex: Effect.Effect<boolean>;

  threadCount(query: ThreadQuery): Effect.Effect<number, InvalidInput>;
  /** Which account each message id belongs to, without loading the messages. Unknown ids are missing. */
  messageAccounts(ids: readonly string[]): Effect.Effect<ReadonlyMap<string, string>>;
}

/**
 * Changes to mail, labels, filters and folders. Every change writes an audit row; message ops
 * from `perform` and the undo batch path go through `applyMailOp` (mail-change.ts) after
 * `decide`. Parts: mailbox-apply.ts, mailbox-batch.ts, mailbox-organization.ts,
 * mailbox-filters.ts, mailbox-folders.ts.
 */
export interface MailboxOrganize {
  unsubscribe(messageId: string, actor: Actor): Effect.Effect<void, PerformError>;
  setClassificationOverride(
    messageId: string,
    classifyAs: InferenceClassification,
  ): Effect.Effect<void, PerformError>;
  changeLabel(accountId: string, change: LabelChange): Effect.Effect<void, PerformError>;
  readonly labelPreferences: Effect.Effect<LabelPreference[]>;
  reorderFavorites(
    order: readonly Pick<LabelPreference, "accountId" | "id">[],
  ): Effect.Effect<void, PerformError>;
  setLabelPreference(input: LabelPreference): Effect.Effect<void, PerformError>;
  readonly organization: Effect.Effect<AccountOrganization[]>;
  setOrganization(input: AccountOrganization): Effect.Effect<void, NotFound>;
  snoozeWithUndo(threads: readonly string[], due: number): Effect.Effect<BatchResult, PerformError>;
  snooze(threads: readonly string[], due: number): Effect.Effect<void, PerformError>;
  wakeSnoozed(): Effect.Effect<void>;
  filters(accountId: string): Effect.Effect<ServerFilter[], PerformError>;
  filterRestorations(accountId: string): Effect.Effect<FilterRestoration[], PerformError>;
  prepareFilterRestoration(
    accountId: string,
    id: string,
  ): Effect.Effect<FilterRestorationPreview, PerformError>;
  discardFilterRestoration(
    accountId: string,
    id: string,
    confirmed: boolean,
  ): Effect.Effect<void, PerformError>;
  restoreFilter(
    accountId: string,
    id: string,
    token: string,
    queryDeletionConfirmed?: true,
  ): Effect.Effect<ServerFilter, PerformError>;
  previewFilter(
    accountId: string,
    criteria: FilterCriteria,
  ): Effect.Effect<ThreadSummary[], PerformError>;
  prepareFilter(accountId: string, input: FilterInput): Effect.Effect<FilterPreview, PerformError>;
  updateFilter(
    accountId: string,
    id: string,
    input: FilterInput,
    token: string,
  ): Effect.Effect<ServerFilter, PerformError>;
  applyFilter(
    accountId: string,
    input: FilterInput,
    token: string,
  ): Effect.Effect<number, PerformError>;
  createLabelAndApply(
    accountId: string,
    name: string,
    parentId: string | null,
    threads: readonly string[],
    move: boolean,
    removeLabelId: string | null,
    flat: boolean,
  ): Effect.Effect<BatchResult, PerformError>;
  createFilter(
    accountId: string,
    input: FilterInput,
    token?: string,
  ): Effect.Effect<ServerFilter, PerformError>;
  deleteFilter(
    accountId: string,
    id: string,
    confirmed?: boolean,
  ): Effect.Effect<void, PerformError>;
  vacation(accountId: string): Effect.Effect<Vacation, PerformError>;
  setVacation(accountId: string, input: Vacation): Effect.Effect<void, PerformError>;
  readonly sendAs: Effect.Effect<SendAs[]>;
  syncSendAs(accountId: string): Effect.Effect<void, PerformError>;

  /** App-only destructive operations. Confirmation is mandatory, outside MailOp/MCP. */
  permanentlyDelete(
    threads: readonly string[],
    flat: boolean,
    folder: DeleteFolder,
    confirmed: boolean,
  ): Effect.Effect<number, PerformError>;
  emptyFolder(folder: FolderScope, confirmed: boolean): Effect.Effect<number, PerformError>;
  markFolderRead(folder: FolderScope): Effect.Effect<number, PerformError>;
  resetFavorites(accountIds: readonly string[]): Effect.Effect<void, PerformError>;
  perform(command: Command, actor: Actor): Effect.Effect<Outcome, PerformError>;
  /** App-only batch operations with exact per-message undo. They run `decide` and audit as the app user. */
  modifyWithUndo(
    threads: readonly string[],
    op: MailOp,
    flat?: boolean,
  ): Effect.Effect<BatchResult, PerformError>;
  markUnreadFrom(id: string): Effect.Effect<BatchResult, PerformError>;
  readonly undoHistory: Effect.Effect<readonly UndoHistoryEntry[]>;
  undoBatch(undoId: string): Effect.Effect<void, PerformError>;
}

/** Agent proposals, write modes, failed changes and the audit log. Part: mailbox-apply.ts. */
export interface MailboxProposals {
  /** A person approves or rejects an agent's proposal. Approved modify commands run as that person. */
  decideProposal(
    id: number,
    approve: boolean,
    surface: "app" | "cli",
  ): Effect.Effect<Outcome, PerformError>;
  readonly proposals: Effect.Effect<Proposal[]>;
  /** One proposal, whatever its status; decided ones have no command payload. */
  proposal(id: number): Effect.Effect<Proposal, NotFound>;
  readonly listFailedOps: Effect.Effect<readonly import("../domain/sync-status.js").FailedOp[]>;
  acknowledgeFailedOps(ids: readonly number[]): Effect.Effect<void>;
  audit(limit: number): Effect.Effect<AuditEntry[]>;
  /** The last MCP tool calls, newest first: tool names and outcomes only. */
  agentActivity(limit: number): Effect.Effect<AgentActivity[]>;
  /**
   * Fails with DatabaseBusy when another process keeps the write lock past a short wait, or at
   * once with `waitForLock: false`. `at` is when the call ended, so a row written later keeps
   * its time.
   */
  recordAgentActivity(
    entry: {
      client: string;
      tool: string;
      ok: boolean;
      at: number;
    },
    options?: { readonly waitForLock?: boolean },
  ): Effect.Effect<void, DatabaseBusy>;
  /** OPENMAIL_READ_ONLY=1: no remote writes in this process. */
  readonly readOnlySession: boolean;
  /** Write mode for one agent: its own policy, else the default. */
  agentWriteModeFor(name: string): Effect.Effect<AgentWriteMode>;
  /** Default write mode for agents without their own policy. */
  readonly agentWriteMode: Effect.Effect<AgentWriteMode>;
  setAgentWriteMode(mode: AgentWriteMode): Effect.Effect<void>;
}

/**
 * The person's own drafts, signatures and templates. Agents write their drafts
 * through `organize.perform({ kind: "draft" })`. Parts: mailbox-drafts.ts, mailbox-outbox.ts
 * (held discards), mailbox-compose.ts, mailbox-features.ts.
 */
export interface MailboxCompose {
  imageFromUrl(url: string): Effect.Effect<OutgoingAttachment, InvalidInput | ProviderError>;
  imageFromFile(file: OutgoingAttachment): Effect.Effect<OutgoingAttachment, InvalidInput>;
  suggestSender(
    current: Pick<import("../compose/compose-sender.js").SuggestedSender, "accountId" | "address">,
    recipients: readonly string[],
    accountIds: readonly string[],
  ): Effect.Effect<import("../compose/compose-sender.js").SuggestedSender | null>;
  prepareRejectedResend(noticeId: number): Effect.Effect<DraftInput, NotFound | InvalidInput>;
  /** Attachments for a new editable copy of a sent message. */
  composeAttachments(id: string): Effect.Effect<readonly OutgoingAttachment[], PerformError>;
  /**
   * The draft to edit, by local draft id, by the id of a draft message in
   * the Drafts list (one written in another client is fetched from the
   * provider and kept locally), or as "proposal:<id>" for an agent's draft.
   */
  openDraft(id: string): Effect.Effect<Draft, PerformError>;
  /** Optional local save status; null for a new or removed draft. No message import. */
  draftStatus(id: string): Effect.Effect<Draft | null>;
  /** Saves locally right away; the provider's copy follows through the change queue. */
  saveDraft(input: DraftInput): Effect.Effect<Draft, NotFound | InvalidInput | DraftConflict>;
  recoverDraft(
    id: string,
    action: "retry" | "local",
    latest?: DraftInput,
  ): Effect.Effect<Draft, NotFound | InvalidInput | DraftConflict>;
  /** Deletes the draft here and on the provider. An agent's draft rejects its proposal. */
  discardDraft(id: string): Effect.Effect<void>;
  /**
   * Discards the draft after `holdMs` unless `restoreDraft` runs first. Nothing leaves this
   * Mac or the provider until then; closing the mailbox discards held drafts at once. An
   * agent's draft is discarded at once, and the result is false.
   */
  discardDraftLater(id: string, holdMs: number): Effect.Effect<boolean>;
  /** Cancels a held discard and returns the draft as it was. Fails once the hold has ended. */
  restoreDraft(id: string): Effect.Effect<Draft, InvalidInput>;
  /** Local signatures take precedence over synced Gmail send-as signatures. */
  readonly signatures: Effect.Effect<Signature[]>;
  readonly namedSignatures: Effect.Effect<NamedSignature[]>;
  readonly signatureDefaults: Effect.Effect<readonly SignatureDefault[]>;
  saveNamedSignature(
    input: NamedSignatureInput,
    id?: string,
  ): Effect.Effect<NamedSignature, NotFound | InvalidInput>;
  deleteNamedSignature(id: string): Effect.Effect<void>;
  setSignatureDefault(setting: SignatureDefault): Effect.Effect<void, InvalidInput>;
  setSignature(signature: Signature): Effect.Effect<void>;
  readonly templates: Effect.Effect<Template[]>;
  /** Creates a template, or updates the one with `id`. */
  saveTemplate(input: TemplateInput, id?: string): Effect.Effect<Template, NotFound>;
  deleteTemplate(id: string): Effect.Effect<void>;
}

/**
 * Recipient suggestions, hidden addresses, contact groups and photos, and the server contacts of
 * the optional contacts service. Part: mailbox-contacts.ts.
 */
export interface MailboxContacts {
  /**
   * Addresses for the To, Cc and Bcc fields, from local mail history: people
   * written to and heard from, ranked by frequency and recency, merged with
   * cached Google and Outlook contacts. Suggestions never require network.
   * `exclude` is the address the message is written from; the person's
   * other accounts are suggested like anyone else when `accountIds` is omitted.
   * `accountIds` limits both local history and saved contacts to those accounts.
   */
  suggestContacts(
    query: string,
    options?: {
      readonly limit?: number;
      /** One address or a list. */
      readonly exclude?: string | readonly string[];
      readonly accountIds?: readonly string[];
    },
  ): Effect.Effect<Address[]>;
  contactAlternatives(address: string): Effect.Effect<readonly Address[]>;
  readonly hiddenContacts: Effect.Effect<string[]>;
  /** Hides an address from suggestions, or shows it again. */
  setContactHidden(address: string, hidden: boolean): Effect.Effect<void>;
  contactGroups(query: string, accountIds?: readonly string[]): Effect.Effect<ContactGroup[]>;
  contactPhoto(accountId: string, address: string): Effect.Effect<string | null>;
  readonly contactSync: Effect.Effect<ContactSync[]>;
  refreshContacts(accountId: string, force?: boolean): Effect.Effect<void, PerformError>;
}

/** Sends: the undo-send wait, the mobile send queue and send again. Part: mailbox-outbox.ts. */
export interface MailboxOutbox {
  readonly queuedSends: Effect.Effect<QueuedSend[]>;
  queueSend(
    input: DraftInput,
    due: number,
    confirmResend?: boolean,
  ): Effect.Effect<void, NotFound | InvalidInput | SendUncertain | DraftConflict>;
  cancelDesktopUndoSends(owner?: string): Effect.Effect<void>;
  cancelWaitingSend(id: string): Effect.Effect<boolean>;
  /** Remove a mobile failed/waiting intent while keeping its draft; an active send cannot be cancelled. */
  cancelQueuedSend(id: string): Effect.Effect<boolean>;
  flushQueuedSends(canSend?: () => boolean): Effect.Effect<void>;
  /** Main/core owns the wait and send even if the calling renderer disconnects. */
  queueUndoSend(
    input: DraftInput,
    due: number,
    options?: {
      readonly archive?: boolean;
      readonly confirmResend?: boolean;
      readonly owner?: string;
    },
  ): Effect.Effect<void, NotFound | InvalidInput | SendUncertain | DraftConflict>;
  awaitUndoSend(id: string): Effect.Effect<Outcome, PerformError>;
  sendAgain(id: string): Effect.Effect<Draft, PerformError>;
  /** Sends currently executing in core, including provider and cleanup work. */
  readonly pendingSendCount: Effect.Effect<number>;
}

/**
 * Sign-in, account settings, optional services, OAuth clients and profiles (spaces).
 * Parts: mailbox-accounts.ts, mailbox-services.ts.
 */
export interface MailboxAccounts {
  setAccountSettings(
    id: string,
    input: AccountSettings,
  ): Effect.Effect<void, NotFound | InvalidInput>;
  moveAccount(id: string, input: AccountPlacement): Effect.Effect<void, NotFound | InvalidInput>;
  optionalServices(accountId: string): Effect.Effect<ServiceGrant[], NotFound>;
  setServiceEnabled(
    accountId: string,
    service: OptionalService,
    enabled: boolean,
  ): Effect.Effect<void, NotFound | InvalidInput>;
  readonly accounts: Effect.Effect<Account[]>;
  /** Signs in (OAuth consent page or IMAP password) and starts a sync. Re-adding an account signs it in again. */
  connect(input: ConnectInput): Effect.Effect<Account, SignInError>;
  /** Signs an OAuth account in again with its provider. */
  reauth(
    accountId: string,
    feature?: AuthorizationFeature,
  ): Effect.Effect<Account, SignInError | NotFound | FeatureScopeMissing>;
  /** Whether and from where each provider has a client. Never the client values. */
  readonly clientSetup: Effect.Effect<{
    googleClient: "own" | "builtIn" | "none";
    microsoftClient: "own" | "builtIn" | "none";
    googleBuiltIn: boolean;
    microsoftBuiltIn: boolean;
  }>;
  setClient(patch: ClientConfig): Effect.Effect<void>;
  /** Removes the user's own client, so new sign-ins use the built-in one. */
  clearClient(provider: keyof ClientConfig): Effect.Effect<void>;

  // Profiles (spaces)
  readonly profiles: Effect.Effect<Profile[]>;
  /** Fails with InvalidInput when the name is blank, `none` or another space's (any case). */
  createProfile(input: ProfileInput): Effect.Effect<Profile, InvalidInput>;
  updateProfile(id: string, input: ProfileInput): Effect.Effect<void, InvalidInput>;
  deleteProfile(id: string): Effect.Effect<void>;
  assignProfile(accountId: string, profileId: string | null): Effect.Effect<void>;
  initializeProfiles(
    accept: boolean,
    names: { personal: string; work: string },
  ): Effect.Effect<void>;
}

/** AI settings, summaries, questions, triage, semantic search and on-device models. Part: mailbox-ai.ts. */
export interface MailboxAi {
  /** For the Settings UI: consent, model, and whether the keychain holds the API key. */
  readonly aiSettings: Effect.Effect<AiSettings, ProviderError>;
  /** Per-account AI consent from the database. Never reads the keychain, so agent tool calls use it. */
  readonly aiAccounts: Effect.Effect<readonly AiAccountSettings[]>;
  /** Stores the Anthropic API key in the keychain. A blank key fails; it never removes the stored one. */
  setAiKey(key: string): Effect.Effect<void, InvalidInput>;
  /** Deletes the stored Anthropic API key. */
  readonly removeAiKey: Effect.Effect<void, InvalidInput>;
  setAiAccount(input: AiAccountSettings): Effect.Effect<void, NotFound | InvalidInput>;
  setAiModel(model: AiModelName): Effect.Effect<void>;
  /** The cached summary in `locale`, the UI language; summaries are cached per language. */
  aiSummary(id: string, locale?: string): Effect.Effect<AiSummary | null, NotFound | InvalidInput>;
  /** Summarizes in `locale`, the UI language, when given. */
  summarize(
    id: string,
    locale?: string,
  ): Stream.Stream<AiEvent, NotFound | InvalidInput | ProviderError>;
  askAi(input: AiQuestion): Stream.Stream<AiEvent, PerformError>;
  composeAi(input: AiComposeRequest): Stream.Stream<AiEvent, PerformError>;
  aiTriage(id: string): Effect.Effect<AiTriage | null, NotFound | InvalidInput>;
  decideAiTriage(
    id: string,
    accept: boolean,
    surface: "app" | "cli",
  ): Effect.Effect<void, PerformError>;
  /** Fails with IndexNotReady when the on-device index cannot answer, instead of an empty list. */
  semanticSearch(query: ThreadQuery): Effect.Effect<ThreadSummary[], InvalidInput | IndexNotReady>;

  // On-device models and the media index
  readonly indexingProgress: Effect.Effect<IndexingProgress>;
  setModelsEnabled(value: boolean): Effect.Effect<void>;
  setIndexingPaused(value: boolean): Effect.Effect<void>;
  derivedChunks(id: string): Effect.Effect<readonly DerivedChunk[]>;
  mediaImage(
    chunk: DerivedChunk,
  ): Effect.Effect<string, NotFound | ProviderError | AuthError | PermanentError>;
}

/**
 * Sync, polling, connectivity, backfill and the local cache.
 * Parts: mailbox-sync.ts, mailbox-cache.ts, mailbox-storage.ts.
 */
export interface MailboxSync {
  syncHealth(
    accountId: string,
  ): Effect.Effect<import("../sync/sync-health.js").SyncHealth, NotFound>;
  readonly cacheDatabaseSize: Effect.Effect<import("../domain/cache.js").CacheDatabaseSize>;
  readonly compactCache: Effect.Effect<import("../domain/cache.js").CacheCompactionResult>;
  readonly cacheSize: Effect.Effect<import("../domain/cache.js").CacheSize[]>;
  clearCache(accountId?: string): Effect.Effect<void>;
  closeSessions(): Effect.Effect<void>;
  resetConnectivity(): Effect.Effect<void>;
  setSyncPaused(paused: boolean): Effect.Effect<void>;
  readonly cacheWindows: Effect.Effect<CacheWindow[]>;
  setCacheWindow(input: CacheWindowInput): Effect.Effect<void, NotFound>;
  readonly backfillState: Effect.Effect<BackfillState[]>;
  pauseBackfill(accountId: string, paused: boolean): Effect.Effect<void>;
  /** Requests one throttled page per scoped account, respecting pause. */
  fetchOlder(
    query: ThreadQuery,
  ): Effect.Effect<import("../domain/cache.js").OlderResult, PerformError>;

  /**
   * Syncs provider changes and the queue. IMAP validates UIDs before pushing; concurrent calls
   * join. A failing account is an error row. When another process holds the write lock past the
   * busy timeout it dies with the lock timeout (`isLockTimeout`), so callers report busy once.
   */
  sync(accountId?: string): Effect.Effect<SyncResult[]>;
  /** Desktop's lightweight inbox poll; CLI/MCP do not start a timer. */
  pollInbox(accountIds?: readonly string[], incrementalOnly?: boolean): Effect.Effect<SyncResult[]>;
  readonly syncState: Effect.Effect<SyncState>;
  /**
   * Refreshes planner statistics, waiting at most 250 ms for another process's write lock.
   * The app does this hourly; `openmail sync` calls it after fetching.
   */
  readonly refreshPlannerStats: Effect.Effect<void>;
}

/** Calendar invites and events. Parts: mailbox-features.ts, mailbox-apply.ts. */
export interface MailboxCalendar {
  importCalendarAttachment(
    messageId: string,
    path: readonly number[],
    key: string,
    actor: Actor,
  ): Effect.Effect<void, PerformError>;

  // Calendar invites, fetched from the original MIME including inline parts and .ics files.
  calendarEvents(messageId: string, key: string): Effect.Effect<CalendarEvent[], PerformError>;
  detectedEvents(messageId: string): Effect.Effect<CalendarEvent[], PerformError>;
  createCalendarEvent(
    messageId: string,
    key: string,
    actor: Actor,
    edits?: CalendarEventEdits,
  ): Effect.Effect<void, PerformError>;
  invitations(messageId: string): Effect.Effect<CalendarInvite[], PerformError>;
  /** `label` names the response in an IMAP reply's subject and text; see `inviteReply`. */
  respondInvite(
    messageId: string,
    key: string,
    response: InviteResponse,
    actor: Actor,
    label?: string,
  ): Effect.Effect<void, PerformError>;
}

/** App settings, notifications, diagnostics, updates, remote access and the event stream. Part: mailbox-app.ts. */
export interface MailboxApp {
  rememberNotificationActions(
    id: string,
    actions: Prefs["notificationActions"],
  ): Effect.Effect<void>;
  notificationActions(id: string): Effect.Effect<Prefs["notificationActions"]>;
  /** Counts and enums per account for the diagnostics file; no addresses or error text. */
  readonly diagnosticsState: Effect.Effect<
    import("../domain/diagnostics-state.js").DiagnosticsState
  >;
  /** Atomically consumes eligible arrivals; muted arrivals wait for a Profile digest. */
  readonly takeNotifications: Effect.Effect<import("../domain/prefs.js").NotificationBatch[]>;
  readonly prefs: Effect.Effect<Prefs>;
  setPrefs(patch: PrefsPatch): Effect.Effect<void>;

  checkUpdates(
    client: UpdateClient,
    options: import("../app/updates.js").UpdateOptions,
  ): Effect.Effect<import("../app/updates.js").ManualUpdateResult>;
  /** Main process only; no RPC exposes these. */
  readonly remoteAccess: Effect.Effect<import("../app/remote-access.js").RemoteAccessSettings>;
  setRemoteAccess(
    settings: import("../app/remote-access.js").RemoteAccessSettings,
  ): Effect.Effect<import("../app/remote-access.js").RemoteAccessSettings, InvalidInput>;
  startUpdates(
    client: UpdateClient,
    options: import("../app/updates.js").UpdateOptions,
  ): Effect.Effect<() => void>;
  readonly events: Stream.Stream<MailboxEvent>;
  /** The machine's time zone, from the platform Layer. Agent tools write local times with it. */
  readonly host: import("../platform/host.js").Host;
}

/**
 * One service, eleven groups. Each group is a namespace typed by its interface above and
 * built by its part files; there is one tag and one layer (`MailboxLive`).
 */
export class Mailbox extends Context.Service<
  Mailbox,
  {
    readonly reading: MailboxReading;
    readonly organize: MailboxOrganize;
    readonly proposals: MailboxProposals;
    readonly compose: MailboxCompose;
    readonly contacts: MailboxContacts;
    readonly outbox: MailboxOutbox;
    readonly accounts: MailboxAccounts;
    readonly ai: MailboxAi;
    readonly sync: MailboxSync;
    readonly calendar: MailboxCalendar;
    readonly app: MailboxApp;
  }
>()("openmail/Mailbox") {}
