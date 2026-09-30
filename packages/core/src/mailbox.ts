import type { DerivedChunk, IndexingProgress } from "./media.js";
/**
 * Mailbox: the one interface desktop, CLI, MCP and the assistant use. Reading,
 * changing and syncing mail all go through here, so policy, audit and the
 * change queue hold for every caller.
 */
import { Context, type Effect, Schema, type Stream } from "effect";

import { SyncProgress as SyncProgressSchema } from "./domain.js";
import type {
  Account,
  BatchResult,
  MailOp,
  Actor,
  Address,
  AgentWriteMode,
  AuditEntry,
  Command,
  Draft,
  DraftInput,
  Label,
  Message,
  Outcome,
  Prefs,
  Profile,
  ProfileInput,
  Proposal,
  Signature,
  SyncResult,
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
  PermanentError,
  ProviderError,
  SettingsScopeMissing,
} from "./errors.js";
import type { CalendarInvite, InviteResponse } from "./calendar.js";
import type { ContactSync } from "./contacts.js";
import type { ClientConfig, ConnectInput } from "./services.js";

import type {
  AccountOrganization,
  FilterCriteria,
  FilterInput,
  LabelChange,
  LabelPreference,
  SearchResult,
  SendAs,
  ServerFilter,
  Vacation,
} from "./organization.js";

import type { BackfillState, CacheWindow, CacheWindowInput } from "./cache.js";

import type { UpdateClient } from "./updates.js";

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
  Schema.TaggedStruct("BackfillProgress", {}),
  Schema.TaggedStruct("UpdateSettingsChanged", {}),
  /** Local mail, accounts, proposals or settings changed; views should refetch. */
  Schema.TaggedStruct("Changed", {}),
]);
export type MailboxEvent = typeof MailboxEvent.Type;

/** A thread shaped for a language model: plain text, quotes and signatures cut, ids kept for citing. */
export const ModelThread = Schema.Struct({
  threadId: Schema.String,
  accountId: Schema.String,
  subject: Schema.String,
  labels: Schema.Array(Schema.String),
  messages: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      from: Schema.String,
      to: Schema.Array(Schema.String),
      cc: Schema.Array(Schema.String),
      date: Schema.String,
      text: Schema.String,
      attachments: Schema.Array(Schema.String),
    }),
  ),
  /** Characters dropped to fit the budget. 0 when nothing was cut. */
  truncated: Schema.Number,
});
export type ModelThread = typeof ModelThread.Type;

/** An attachment's content, fetched from the provider. */
export interface AttachmentContent {
  readonly filename: string;
  readonly mimeType: string;
  readonly data: Uint8Array;
}

export type SignInError = AuthError | ProviderError | ClientNotConfigured | InvalidInput;
/** What performing a command can fail with. Policy denials are an Outcome, not an error. */
export type PerformError =
  | NotFound
  | InvalidInput
  | AuthError
  | PermanentError
  | ProviderError
  | SettingsScopeMissing
  | FeatureScopeMissing;

export class Mailbox extends Context.Service<
  Mailbox,
  {
    // Accounts
    readonly accounts: Effect.Effect<Account[]>;
    /** Signs in (OAuth consent page or IMAP password) and starts a sync. Re-adding an account signs it in again. */
    connect(input: ConnectInput): Effect.Effect<Account, SignInError>;
    /** Signs an OAuth account in again with its provider. */
    reauth(accountId: string): Effect.Effect<Account, SignInError | NotFound>;
    readonly clientSetup: Effect.Effect<{
      googleConfigured: boolean;
      microsoftConfigured: boolean;
    }>;
    setClient(patch: ClientConfig): Effect.Effect<void>;

    // Calendar invites, fetched from the original MIME including inline parts and .ics files.
    invitations(messageId: string): Effect.Effect<CalendarInvite[], PerformError>;
    respondInvite(
      messageId: string,
      key: string,
      response: InviteResponse,
      actor: Actor,
    ): Effect.Effect<void, PerformError>;
    readonly contactSync: Effect.Effect<ContactSync[]>;
    refreshContacts(accountId: string, force?: boolean): Effect.Effect<void, PerformError>;

    // Reading
    threads(q: ThreadQuery): Effect.Effect<ThreadSummary[]>;
    /** Local read: no writes or provider requests (CLI/MCP default). */
    thread(id: string): Effect.Effect<Message[], NotFound>;
    /** Explicit reader hydration. Failed bodies retain their headers. */
    readerThread(id: string): Effect.Effect<Message[], PerformError>;
    threadForModel(id: string, maxChars?: number): Effect.Effect<ModelThread, NotFound>;
    /** The message's original source (RFC 5322) from the provider, as text. */
    rawMessage(id: string): Effect.Effect<string, PerformError>;
    /** Original bytes for lossless EML export. */
    rawMessageBytes(id: string): Effect.Effect<Uint8Array, PerformError>;
    /** A validated official web URL; hydrates old Outlook caches on explicit request. */
    messageWebUrl(id: string): Effect.Effect<string, PerformError>;
    knownSenders(accountId: string, addresses: readonly string[]): Effect.Effect<string[]>;
    /** One attachment of a message, by its position in `Message.attachments`. */
    attachment(messageId: string, index: number): Effect.Effect<AttachmentContent, PerformError>;
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
    ): Effect.Effect<Record<string, number>>;

    searchServer(query: ThreadQuery): Effect.Effect<SearchResult>;
    changeLabel(accountId: string, change: LabelChange): Effect.Effect<void, PerformError>;
    readonly labelPreferences: Effect.Effect<LabelPreference[]>;
    setLabelPreference(input: LabelPreference): Effect.Effect<void, PerformError>;
    readonly organization: Effect.Effect<AccountOrganization[]>;
    setOrganization(input: AccountOrganization): Effect.Effect<void, NotFound>;
    snooze(threads: readonly string[], due: number): Effect.Effect<void, PerformError>;
    wakeSnoozed(): Effect.Effect<void>;
    filters(accountId: string): Effect.Effect<ServerFilter[], PerformError>;
    previewFilter(
      accountId: string,
      criteria: FilterCriteria,
    ): Effect.Effect<ThreadSummary[], PerformError>;
    createFilter(accountId: string, input: FilterInput): Effect.Effect<ServerFilter, PerformError>;
    deleteFilter(accountId: string, id: string): Effect.Effect<void, PerformError>;
    vacation(accountId: string): Effect.Effect<Vacation, PerformError>;
    setVacation(accountId: string, input: Vacation): Effect.Effect<void, PerformError>;
    readonly sendAs: Effect.Effect<SendAs[]>;
    syncSendAs(accountId: string): Effect.Effect<void, PerformError>;

    // Profiles (spaces)
    readonly profiles: Effect.Effect<Profile[]>;
    createProfile(input: ProfileInput): Effect.Effect<Profile>;
    updateProfile(id: string, input: ProfileInput): Effect.Effect<void>;
    deleteProfile(id: string): Effect.Effect<void>;
    assignProfile(accountId: string, profileId: string | null): Effect.Effect<void>;

    // Changes. Every one is checked against policy and audited.
    threadCount(query: ThreadQuery): Effect.Effect<number>;
    perform(command: Command, actor: Actor): Effect.Effect<Outcome, PerformError>;
    /** App-only batch operations with exact per-message undo. */
    modifyWithUndo(
      threads: readonly string[],
      op: MailOp,
      flat?: boolean,
    ): Effect.Effect<BatchResult, PerformError>;
    undoBatch(undoId: string): Effect.Effect<void, PerformError>;
    /** A person approves or rejects an agent's proposal. Approved modify commands run as that person. */
    decideProposal(
      id: number,
      approve: boolean,
      surface: "app" | "cli",
    ): Effect.Effect<Outcome, PerformError>;
    readonly proposals: Effect.Effect<Proposal[]>;
    audit(limit: number): Effect.Effect<AuditEntry[]>;
    /** Default write mode for agents without their own policy. */
    readonly agentWriteMode: Effect.Effect<AgentWriteMode>;
    setAgentWriteMode(mode: AgentWriteMode): Effect.Effect<void>;

    // Drafts. The person's own drafts; agents write theirs through perform({ kind: "draft" }).
    /**
     * The draft to edit, by local draft id, by the id of a draft message in
     * the Drafts list (one written in another client is fetched from the
     * provider and kept locally), or as "proposal:<id>" for an agent's draft.
     */
    openDraft(id: string): Effect.Effect<Draft, PerformError>;
    /** Saves locally right away; the provider's copy follows through the change queue. */
    saveDraft(input: DraftInput): Effect.Effect<Draft, NotFound>;
    /** Deletes the draft here and on the provider. An agent's draft rejects its proposal. */
    discardDraft(id: string): Effect.Effect<void>;

    // Compose settings
    readonly indexingProgress: Effect.Effect<IndexingProgress>;
    setModelsEnabled(value: boolean): Effect.Effect<void>;
    setIndexingPaused(value: boolean): Effect.Effect<void>;
    derivedChunks(id: string): Effect.Effect<readonly DerivedChunk[]>;
    mediaImage(
      chunk: DerivedChunk,
    ): Effect.Effect<string, NotFound | ProviderError | AuthError | PermanentError>;
    readonly prefs: Effect.Effect<Prefs>;
    setPrefs(patch: Partial<Prefs>): Effect.Effect<void>;
    /** Local signatures take precedence over synced Gmail send-as signatures. */
    readonly signatures: Effect.Effect<Signature[]>;
    setSignature(signature: Signature): Effect.Effect<void>;
    readonly templates: Effect.Effect<Template[]>;
    /** Creates a template, or updates the one with `id`. */
    saveTemplate(input: TemplateInput, id?: string): Effect.Effect<Template, NotFound>;
    deleteTemplate(id: string): Effect.Effect<void>;

    // Recipients
    /**
     * Addresses for the To, Cc and Bcc fields, from local mail history: people
     * written to and heard from, ranked by frequency and recency, merged with
     * cached Google and Outlook contacts. Suggestions never require network.
     * `exclude` is the address the message is written from; the person's
     * other accounts are suggested like anyone else.
     */
    suggestContacts(
      query: string,
      options?: { readonly limit?: number; readonly exclude?: string },
    ): Effect.Effect<Address[]>;
    readonly hiddenContacts: Effect.Effect<string[]>;
    /** Hides an address from suggestions, or shows it again. */
    setContactHidden(address: string, hidden: boolean): Effect.Effect<void>;

    /** Only presence crosses IPC. The token stays in the system keychain. */
    readonly updateTokenConfigured: Effect.Effect<boolean>;
    setUpdateToken(token: string): Effect.Effect<void, InvalidInput>;
    startUpdates(
      client: UpdateClient,
      options: { packaged: boolean; bundle: string },
    ): Effect.Effect<() => void>;
    readonly cacheWindows: Effect.Effect<CacheWindow[]>;
    setCacheWindow(input: CacheWindowInput): Effect.Effect<void, NotFound>;
    readonly backfillState: Effect.Effect<BackfillState[]>;
    pauseBackfill(accountId: string, paused: boolean): Effect.Effect<void>;
    /** Requests one throttled page per scoped account, respecting pause. */
    fetchOlder(query: ThreadQuery): Effect.Effect<void>;

    // Sync
    /** Pushes queued changes, then pulls. One sync runs at a time; a second call joins it. */
    sync(accountId?: string): Effect.Effect<SyncResult[]>;
    /** Desktop's lightweight inbox poll; CLI/MCP do not start a timer. */
    pollInbox(): Effect.Effect<SyncResult[]>;
    readonly syncState: Effect.Effect<SyncState>;
    readonly events: Stream.Stream<MailboxEvent>;
  }
>()("openmail/Mailbox") {}
