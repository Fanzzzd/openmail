/**
 * Mailbox: the one interface desktop, CLI, MCP and the assistant use. Reading,
 * changing and syncing mail all go through here, so policy, audit and the
 * change queue hold for every caller.
 */
import { Context, type Effect, Schema, type Stream } from "effect";

import { SyncProgress as SyncProgressSchema } from "./domain.js";
import type {
  Account,
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
  AuthError,
  ClientNotConfigured,
  InvalidInput,
  NotFound,
  PermanentError,
  ProviderError,
} from "./errors.js";
import type { ClientConfig, ConnectInput } from "./services.js";

export const SyncState = Schema.Struct({
  running: Schema.Boolean,
  lastFinishedAt: Schema.NullOr(Schema.Number),
  errors: Schema.Array(Schema.String),
});
export type SyncState = typeof SyncState.Type;

export const MailboxEvent = Schema.Union([
  Schema.TaggedStruct("SyncState", { state: SyncState }),
  Schema.TaggedStruct("SyncProgress", { progress: SyncProgressSchema }),
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

export type SignInError = AuthError | ProviderError | ClientNotConfigured | InvalidInput;
/** What performing a command can fail with. Policy denials are an Outcome, not an error. */
export type PerformError = NotFound | InvalidInput | AuthError | PermanentError | ProviderError;

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

    // Reading
    threads(q: ThreadQuery): Effect.Effect<ThreadSummary[]>;
    thread(id: string): Effect.Effect<Message[], NotFound>;
    threadForModel(id: string, maxChars?: number): Effect.Effect<ModelThread, NotFound>;
    labels(accountIds?: readonly string[]): Effect.Effect<Label[]>;
    readonly unreadCounts: Effect.Effect<Record<string, number>>;
    unreadByLabel(
      accountIds?: readonly string[],
      within?: string,
    ): Effect.Effect<Record<string, number>>;

    // Profiles (spaces)
    readonly profiles: Effect.Effect<Profile[]>;
    createProfile(input: ProfileInput): Effect.Effect<Profile>;
    updateProfile(id: string, input: ProfileInput): Effect.Effect<void>;
    deleteProfile(id: string): Effect.Effect<void>;
    assignProfile(accountId: string, profileId: string | null): Effect.Effect<void>;

    // Changes. Every one is checked against policy and audited.
    perform(command: Command, actor: Actor): Effect.Effect<Outcome, PerformError>;
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
    readonly prefs: Effect.Effect<Prefs>;
    setPrefs(patch: Partial<Prefs>): Effect.Effect<void>;
    /** Local signatures. Provider signatures (Gmail sendAs) are a later source behind this. */
    readonly signatures: Effect.Effect<Signature[]>;
    setSignature(signature: Signature): Effect.Effect<void>;
    readonly templates: Effect.Effect<Template[]>;
    /** Creates a template, or updates the one with `id`. */
    saveTemplate(input: TemplateInput, id?: string): Effect.Effect<Template, NotFound>;
    deleteTemplate(id: string): Effect.Effect<void>;

    // Recipients
    /**
     * Addresses for the To, Cc and Bcc fields, from local mail history: people
     * written to and heard from, ranked by frequency and recency. Provider
     * contacts (Google, Outlook) are a later source behind this call.
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

    // Sync
    /** Pushes queued changes, then pulls. One sync runs at a time; a second call joins it. */
    sync(accountId?: string): Effect.Effect<SyncResult[]>;
    readonly syncState: Effect.Effect<SyncState>;
    readonly events: Stream.Stream<MailboxEvent>;
  }
>()("openmail/Mailbox") {}
