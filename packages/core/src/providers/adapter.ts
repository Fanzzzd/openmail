/** The ProviderAdapter port: what Gmail, Outlook and IMAP adapters implement, and the Change stream they pull. */

import { Context, type Effect, type Option, type Stream } from "effect";
import type {
  AuthError,
  ClientNotConfigured,
  FeatureScopeMissing,
  InvalidInput,
  ProviderError,
  ProviderFailure,
  SendUncertain,
  SettingsScopeMissing,
} from "../domain/errors.js";
import type {
  Account,
  Address,
  DraftCreateState,
  DraftRemote,
  ImapSettings,
  IncomingMessage,
  InferenceClassification,
  Label,
  MailOp,
  OutgoingMessage,
  Provider,
  SendPreparationState,
  ThreadQuery,
} from "../domain/domain.js";
import type { AuthorizationFeature, OptionalService } from "./optional-services.js";
import type { ImapConnectInput } from "./imap/imap-presets.js";
import type { CalendarEvent, CalendarInvite, InviteResponse } from "../calendar/calendar.js";
import type {
  DeleteFolder,
  FolderListOptions,
  FolderPage,
  FolderScope,
  PermanentDeleteBatch,
} from "../domain/folder-actions.js";
import type { ContactSnapshot } from "../contacts/contacts.js";
import type { BackfillPage, BackfillState } from "../domain/cache.js";
import type {
  FilterInput,
  GmailRuleDefinition,
  LabelChange,
  SendAs,
  ServerFilter,
  Vacation,
} from "../domain/organization.js";
import type { MarkdownDraftSource } from "../compose/markdown-draft.js";
import type { AttachmentRef } from "../mime/attachments.js";

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
  /**
   * `checkpoint` marks a cursor saved partway through a full sync so a retry resumes. It does
   * not count as a completed sync and is not copied to the inbox cursor.
   */
  | { readonly _tag: "Cursor"; readonly cursor: string; readonly checkpoint?: boolean };

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
/** The changes that reset a folder or label, which sync verifies before deleting local mail. */
export type ResetChange = Extract<Change, { _tag: "Reset" | "DeleteLabel" | "RebuildFolder" }>;

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
  ): Effect.Effect<readonly import("../sync/sync-records.js").CachedHeaders[], ProviderFailure>;
  /** Counts only; an undercount can be checked against message-ID listings. */
  folderStatus(
    account: Account,
    scope: string,
    recheck?: {
      readonly localTotal: number;
      readonly summary: import("../sync/sync-records.js").FolderStatus;
    },
  ): Effect.Effect<import("../sync/sync-records.js").FolderStatus, ProviderFailure>;
  /** Omitted/failed results remain local and are retried on the next foreground sync. */
  verifyResetCandidates?(
    account: Account,
    candidates: readonly import("../sync/sync-records.js").ResetCandidate[],
  ): Effect.Effect<readonly import("../sync/sync-records.js").ResetVerification[], ProviderFailure>;

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
    /** The given provider IDs already stored for the account, so a resumed first sync skips them. */
    stored?: (providerIds: readonly string[]) => Effect.Effect<ReadonlySet<string>>,
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
