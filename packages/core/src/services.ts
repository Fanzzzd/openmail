/**
 * Service interfaces inside core. Only `Mailbox` (mailbox.ts) is meant for
 * callers outside core; these are the seams its implementation is built from,
 * each with a live layer and an in-memory layer for tests.
 */
import { Context, type Effect, type Option, type Stream } from "effect";

import type {
  Account,
  AgentWriteMode,
  AuditEntry,
  Actor,
  Command,
  ImapSettings,
  IncomingMessage,
  Label,
  MailOp,
  Message,
  OutgoingMessage,
  Profile,
  ProfileInput,
  Proposal,
  Provider,
  ThreadQuery,
  ThreadSummary,
} from "./domain.js";
import type {
  AuthError,
  ClientNotConfigured,
  InvalidInput,
  NotFound,
  ProviderError,
  ProviderFailure,
} from "./errors.js";
import type { ImapConnectInput } from "./imap-presets.js";

// Platform

/**
 * Secrets in the OS keychain: OAuth refresh tokens and IMAP passwords, keyed
 * by account id. Never in the database, config.json or logs.
 */
export class Secrets extends Context.Service<
  Secrets,
  {
    get(key: string): Effect.Effect<Option.Option<string>>;
    set(key: string, value: string): Effect.Effect<void>;
    remove(key: string): Effect.Effect<void>;
  }
>()("openmail/Secrets") {}

/** OAuth client registrations the person made (docs/setup-*.md). Stored in config.json, mode 600. */
export interface ClientConfig {
  google?: { clientId: string; clientSecret: string };
  microsoft?: { clientId: string };
}

export class AppConfig extends Context.Service<
  AppConfig,
  {
    readonly read: Effect.Effect<ClientConfig>;
    write(patch: ClientConfig): Effect.Effect<void>;
  }
>()("openmail/AppConfig") {}

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
  accessToken: string;
  refreshToken: Option.Option<string>;
  /** Seconds. */
  expiresIn: number;
}

/**
 * Authorization-code flow with PKCE (RFC 8252). Desktop and CLI use a
 * loopback redirect; mobile will use an app URL scheme behind the same
 * interface. `refresh` maps invalid_grant to AuthError.
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
  providerId: string;
  op: MailOp;
  attempts: number;
  lastError: string | null;
}

/**
 * The only module that runs SQL. Rows are decoded with the domain schemas.
 * SQL and decode failures are defects: they mean a bug or a corrupt file,
 * not something a caller can handle.
 */
export class Store extends Context.Service<
  Store,
  {
    /** Runs `effect` in one SQLite transaction. */
    transaction<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;

    // Accounts
    readonly listAccounts: Effect.Effect<Account[]>;
    getAccount(id: string): Effect.Effect<Account, NotFound>;
    /** Inserts or returns the existing account `${provider}:${email}`. */
    upsertAccount(provider: Provider, email: string): Effect.Effect<Account>;
    removeAccount(id: string): Effect.Effect<void>;
    setAccountProfile(id: string, profileId: string | null): Effect.Effect<void>;
    setImapSettings(id: string, settings: ImapSettings): Effect.Effect<void>;
    setNeedsReauth(id: string, value: boolean): Effect.Effect<void>;
    setSyncError(id: string, error: string | null): Effect.Effect<void>;
    getSyncCursor(id: string): Effect.Effect<Option.Option<string>>;
    /** Also stamps last_synced_at. */
    saveSyncCursor(id: string, cursor: string): Effect.Effect<void>;

    // Messages. Writes keep rowids stable for the FTS index (ON CONFLICT DO UPDATE).
    upsertMessage(accountId: string, m: IncomingMessage): Effect.Effect<void>;
    deleteMessage(accountId: string, providerId: string): Effect.Effect<void>;
    /** Read and starred state only; the rest of the message stays as stored. */
    setFlags(
      accountId: string,
      providerId: string,
      flags: { isUnread: boolean; isStarred: boolean },
    ): Effect.Effect<void>;
    deleteMessagesWithLabel(accountId: string, label: string): Effect.Effect<void>;
    deleteAccountMessages(accountId: string): Effect.Effect<void>;
    /** Threads collapsed to their newest message, or full-text results when `search` is set. */
    listThreads(q: ThreadQuery): Effect.Effect<ThreadSummary[]>;
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
    ): Effect.Effect<Record<string, number>>;

    // Labels
    replaceLabels(
      accountId: string,
      labels: readonly Omit<Label, "accountId">[],
    ): Effect.Effect<void>;
    listLabels(accountIds?: readonly string[]): Effect.Effect<Label[]>;

    // Profiles
    readonly listProfiles: Effect.Effect<Profile[]>;
    createProfile(input: ProfileInput): Effect.Effect<Profile>;
    updateProfile(id: string, input: ProfileInput): Effect.Effect<void>;
    deleteProfile(id: string): Effect.Effect<void>;

    // Outgoing change queue
    enqueueOp(accountId: string, providerId: string, op: MailOp): Effect.Effect<void>;
    readonly listPendingOps: Effect.Effect<PendingOp[]>;
    removePendingOp(id: number): Effect.Effect<void>;
    failPendingOp(id: number, error: string): Effect.Effect<void>;

    // Audit, agent policy, proposals
    audit(entry: {
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

/**
 * What a provider's pull yields, in order. The sync loop applies each change
 * to the store as it arrives; a `Cursor` is a checkpoint: everything before
 * it has landed, so a sync cut short resumes from there.
 */
export type Change =
  | { readonly _tag: "Upsert"; readonly message: IncomingMessage }
  | { readonly _tag: "Delete"; readonly providerId: string }
  /** Only the read and starred state changed; cheaper than an Upsert of the whole message. */
  | {
      readonly _tag: "Flags";
      readonly providerId: string;
      readonly isUnread: boolean;
      readonly isStarred: boolean;
    }
  /** Drop local messages carrying this label (a folder deleted on the server). */
  | { readonly _tag: "DeleteLabel"; readonly label: string }
  /** Drop every local message of the account (the provider's ids changed meaning). */
  | { readonly _tag: "Reset" }
  | { readonly _tag: "Labels"; readonly labels: readonly Omit<Label, "accountId">[] }
  | { readonly _tag: "Progress"; readonly fetched: number; readonly total: number }
  | { readonly _tag: "Cursor"; readonly cursor: string };

/** `loginHint` names the account to sign in as, so the consent page does not pick another one. */
export type ConnectInput =
  | { readonly provider: "gmail"; readonly loginHint?: string }
  | { readonly provider: "outlook"; readonly loginHint?: string }
  | { readonly provider: "imap"; readonly input: ImapConnectInput };

/** What a successful sign-in hands back. The secret goes to the keychain, the rest to the store. */
export interface Connected {
  email: string;
  secret: string;
  imap?: ImapSettings;
}

/**
 * One provider's network side. Adapters never touch the store: they read
 * credentials through Secrets and report what changed. Their own
 * dependencies (HttpClient, OAuth, AppConfig, Secrets) are captured when the
 * layer builds them, so the methods need nothing further.
 */
export interface ProviderAdapter {
  connect(
    input: ConnectInput,
  ): Effect.Effect<Connected, AuthError | ProviderError | ClientNotConfigured | InvalidInput>;
  pull(account: Account, cursor: Option.Option<string>): Stream.Stream<Change, ProviderFailure>;
  push(account: Account, providerId: string, op: MailOp): Effect.Effect<void, ProviderFailure>;
  /**
   * `original` is the message replied to or forwarded, when there is one. The
   * adapter fetches its threading headers from the provider.
   */
  send(
    account: Account,
    message: OutgoingMessage,
    original: Option.Option<{ providerId: string; threadId: string }>,
  ): Effect.Effect<void, ProviderFailure>;
}

export class Providers extends Context.Service<
  Providers,
  { get(provider: Provider): ProviderAdapter }
>()("openmail/Providers") {}
