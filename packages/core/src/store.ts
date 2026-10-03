import { makeSyncHealthStore } from "./store-sync-health.js";
import { logSyncReset } from "./sync-reset.js";
import { makeServiceStore } from "./store-services.js";
import {
  MessageSecurity,
  NotificationActions,
  type Account,
  type AccountSettings,
  type AccountPlacement,
  Actor,
  FailedOp,
  actorLabel,
  Address,
  AgentWriteMode,
  Attachment,
  type AttachmentType,
  type SearchCondition,
  Command,
  ImapSettings,
  type IncomingMessage,
  type Label,
  type MailOp,
  type MailboxView,
  type Message,
  type MessageSummary,
  type NotificationBatch,
  Profile,
  type ProfileInput,
  type Proposal,
  Provider,
  QueuedOp,
  type ThreadQuery,
  type ThreadSummary,
} from "./domain.js";
import { cleanDisplayName } from "./message-security.js";
import { decodeProviderId } from "./imap-cursor.js";
import { PlatformCrypto } from "./platform/crypto.js";
import { categoryKey } from "./categories.js";
import { makeSyncResetStore } from "./store-sync-reset.js";
import { makeAiStore } from "./store-ai.js";
import { makeWordIndexStore } from "./store-word-index.js";
import { makeInviteStatusStore } from "./store-invite-status.js";
import { attachmentFilename } from "./attachment-filename.js";
import { applyOpToLabels } from "./mail-ops.js";
export { applyOpToLabels, folderTarget } from "./mail-ops.js";
import { makeSemanticStore } from "./store-semantic.js";
import { DatabaseCapabilities } from "./db.js";
import { makeMediaStore } from "./store-media.js";
import { DerivedChunk } from "./media.js";
/**
 * The Store service over SQLite. The only module that runs SQL. Rows are
 * decoded with schemas built from the domain types (this is the IO boundary);
 * SQL and decode failures die, since they mean a bug or a corrupt file.
 */
import { Cause, Clock, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { isSqlError } from "effect/sql/SqlError";
import type { Fragment } from "effect/sql/Statement";

import { InvalidInput, NotFound, ProviderError } from "./errors.js";
import { type PendingOp, Store } from "./services.js";
import { all, first, run } from "./sql-rows.js";
import {
  ATTACHMENT_TYPES,
  ftsSearchTerm,
  usesSubstringSearch,
  quoteSearchValue,
  searchQueryError,
  expressionHasSize,
  searchIncludesSpecialFolders,
  typedDrivePath,
  parseSearchExpression,
  hasSearchExpression,
  type SearchExpression,
  wordTokens,
  parseSearchQuery,
  searchWords,
  unquoteSearchValue,
  reciprocalRankFusion,
} from "./search.js";
import { makeOrganizationStore } from "./store-organization.js";
import { makeContactStore } from "./store-contacts.js";
import { makeCacheStore } from "./store-cache.js";
import { makeUndoStore } from "./undo-journal.js";
import { makeSignatureStore } from "./store-signatures.js";
import { makeComposeStore } from "./store-compose.js";
import { notificationEligible, profileNotificationsActive } from "./system.js";

// Row shapes as SQLite returns them. JSON columns and 0/1 flags decode here,
// so the mapping functions below only rename fields.

const AccountRow = Schema.Struct({
  id: Schema.String,
  provider: Provider,
  email: Schema.String,
  created_at: Schema.Number,
  last_synced_at: Schema.NullOr(Schema.Number),
  last_sync_error: Schema.NullOr(Schema.String),
  profile_id: Schema.NullOr(Schema.String),
  settings_json: Schema.NullOr(Schema.fromJsonString(ImapSettings)),
  needs_reauth: Schema.BooleanFromBit,
  enabled: Schema.BooleanFromBit,
  description: Schema.String,
  color: Schema.NullOr(Schema.String),
  position: Schema.Int,
});

const summaryRowFields = {
  id: Schema.String,
  account_id: Schema.String,
  thread_id: Schema.String,
  subject: Schema.String,
  from_name: Schema.String,
  from_addr: Schema.String,
  date: Schema.Number,
  snippet: Schema.String,
  labels_json: Schema.fromJsonString(Schema.Array(Schema.String)),
  attachments_json: Schema.fromJsonString(Schema.Array(Attachment)),
  is_unread: Schema.BooleanFromBit,
  is_starred: Schema.BooleanFromBit,
};
const SummaryRow = Schema.Struct(summaryRowFields);

const MessageRow = Schema.Struct({
  ...summaryRowFields,
  to_json: Schema.fromJsonString(Schema.Array(Address)),
  cc_json: Schema.fromJsonString(Schema.Array(Address)),
  bcc_json: Schema.fromJsonString(Schema.Array(Address)),
  headers_json: Schema.NullOr(
    Schema.fromJsonString(
      Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
    ),
  ),
  rfc_message_id: Schema.NullOr(Schema.String),
  message_size: Schema.NullOr(Schema.Number),
  reply_to_json: Schema.NullOr(Schema.fromJsonString(Schema.Array(Address))),
  body_text: Schema.String,
  body_html: Schema.String,
  security_json: Schema.NullOr(Schema.fromJsonString(MessageSecurity)),
  web_link: Schema.NullOr(Schema.String),
  draft_id: Schema.NullOr(Schema.String),
  calendar_hint: Schema.NullOr(Schema.BooleanFromBit),
  body_cached: Schema.BooleanFromBit,
});

/** Messages with the local draft each one is a copy of, for MessageRow. */
const MESSAGE_COLUMNS = `m.*, (SELECT d.id FROM drafts d
  WHERE d.account_id = m.account_id AND d.remote_message_id = m.provider_id) AS draft_id`;

const ThreadRow = Schema.Struct({
  ...summaryRowFields,
  any_unread: Schema.BooleanFromBit,
  any_starred: Schema.BooleanFromBit,
  thread_count: Schema.Number,
  participants_json: Schema.fromJsonString(Schema.Array(Address)),
});

const LabelRow = Schema.Struct({
  account_id: Schema.String,
  id: Schema.String,
  name: Schema.String,
  color: Schema.NullOr(Schema.String),
  label_list_visibility: Schema.NullOr(
    Schema.Literals(["labelShow", "labelShowIfUnread", "labelHide"]),
  ),
  message_list_visibility: Schema.NullOr(Schema.Literals(["show", "hide"])),
});

const PendingOpRow = Schema.Struct({
  id: Schema.Number,
  account_id: Schema.String,
  provider_id: Schema.String,
  op_json: Schema.fromJsonString(QueuedOp),
  attempts: Schema.Number,
  last_error: Schema.NullOr(Schema.String),
  created_at: Schema.Number,
  retry_at: Schema.Number,
  rfc_message_id: Schema.NullOr(Schema.String),
  progress_json: Schema.fromJsonString(Schema.Array(Schema.String)),
  appended_message_id: Schema.NullOr(Schema.String),
});

const AuditRow = Schema.Struct({
  at: Schema.Number,
  actor: Schema.String,
  account_id: Schema.NullOr(Schema.String),
  action: Schema.String,
  detail_json: Schema.fromJsonString(Schema.Unknown),
});

const ProposalRow = Schema.Struct({
  id: Schema.Number,
  created_at: Schema.Number,
  actor_json: Schema.fromJsonString(Actor),
  command_json: Schema.fromJsonString(Command),
  status: Schema.Literals(["pending", "approved", "rejected"]),
});

const Count = Schema.Struct({ key: Schema.String, n: Schema.Number });
const counts = (rows: ReadonlyArray<typeof Count.Type>): Record<string, number> =>
  Object.fromEntries(rows.map((r) => [r.key, r.n]));
const Id = Schema.Struct({ id: Schema.Number });
const MessageId = Schema.Struct({ id: Schema.String });
const Ref = Schema.Struct({ account_id: Schema.String, provider_id: Schema.String });
const ThreadKey = Schema.Struct({ account_id: Schema.String, thread_id: Schema.String });
const Labels = Schema.Struct({ labels_json: SummaryRow.fields.labels_json });
const LabelsAndProvider = Schema.Struct({
  labels_json: SummaryRow.fields.labels_json,
  provider: Provider,
});
const Cursor = Schema.Struct({ sync_cursor: Schema.NullOr(Schema.String) });
const Mode = Schema.Struct({ modify: AgentWriteMode });
const Next = Schema.Struct({ next: Schema.Number });

/** A claim on a queued op older than this belongs to a process that died mid-push. */
const CLAIM_TTL = 2 * 60_000;

/** CLI sync also discovers arrivals; bound storage without requiring a desktop consumer. */
const NOTIFICATION_RETENTION = 7 * 86_400_000;
const MAX_PENDING_NOTIFICATIONS = 1000;
const IMMEDIATE_NOTIFICATION_AGE = 5 * 60_000;

function toAccount(r: typeof AccountRow.Type): Account {
  return {
    id: r.id,
    provider: r.provider,
    email: r.email,
    createdAt: r.created_at,
    lastSyncedAt: r.last_synced_at,
    lastSyncError: r.last_sync_error,
    profileId: r.profile_id,
    needsReauth: r.needs_reauth,
    enabled: r.enabled,
    description: r.description,
    color: r.color,
    position: r.position,
    ...(r.settings_json ? { imap: r.settings_json } : {}),
  };
}

function toSummary(r: typeof SummaryRow.Type): MessageSummary {
  return {
    id: r.id,
    accountId: r.account_id,
    threadId: r.thread_id,
    subject: r.subject,
    from: { name: cleanDisplayName(r.from_name), address: r.from_addr },
    date: r.date,
    snippet: r.snippet,
    labels: r.labels_json,
    isUnread: r.is_unread,
    isStarred: r.is_starred,
    hasAttachments: r.attachments_json.length > 0,
  };
}

function toMessage(r: typeof MessageRow.Type): Message {
  return {
    ...toSummary(r),
    to: r.to_json,
    cc: r.cc_json,
    bcc: r.bcc_json,
    ...(r.headers_json === null ? {} : { headers: r.headers_json }),
    ...(r.rfc_message_id === null ? {} : { rfcMessageId: r.rfc_message_id }),
    ...(r.message_size === null ? {} : { size: r.message_size }),
    ...(r.reply_to_json === null ? {} : { replyTo: r.reply_to_json }),
    bodyText: r.body_text,
    bodyHtml: r.body_html,
    ...(r.security_json === null ? {} : { security: r.security_json }),
    ...(r.web_link === null ? {} : { webLink: r.web_link }),
    bodyCached: r.body_cached,
    attachments: r.attachments_json,
    ...(r.calendar_hint === null ? {} : { hasCalendar: r.calendar_hint }),
    ...(r.draft_id === null ? {} : { draftId: r.draft_id }),
  };
}

function toProposal(r: typeof ProposalRow.Type): Proposal {
  return {
    id: r.id,
    createdAt: r.created_at,
    actor: r.actor_json,
    command: r.command_json,
    status: r.status,
  };
}

export function accountId(provider: Provider, email: string): string {
  return `${provider}:${email.toLowerCase()}`;
}

/** Gmail system label behind each mailbox. Outlook and IMAP folders are mapped onto the same names. */
const expressionMedia = (text: string) =>
  hasSearchExpression(text) || searchWords(text).some((term) => term.startsWith("-"));

const MAILBOX_LABEL: Record<Exclude<MailboxView, "all">, string> = {
  inbox: "INBOX",
  snoozed: "SNOOZED",
  important: "IMPORTANT",
  starred: "STARRED",
  sent: "SENT",
  drafts: "DRAFT",
  spam: "SPAM",
  trash: "TRASH",
};

const EFFECTIVE_DATE = "m.list_date";
const SUMMARY_COLUMNS = `m.id, m.account_id, m.thread_id, m.subject, m.from_name, m.from_addr,
  ${EFFECTIVE_DATE} AS date,
  m.snippet, m.labels_json, m.attachments_json, m.is_unread, m.is_starred`;

/** Labels that are flags on every provider; the rest name a folder on Outlook and IMAP. */
const literalLike = (value: string) =>
  `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;

const imapEpochKey = (account: string, folder: import("./services.js").ImapFolderIdentity) =>
  `imap-epoch:${JSON.stringify([account, folder.path, folder.uidValidity])}`;
const progressFailure = (cause: Cause.Cause<unknown>) =>
  Cause.hasInterrupts(cause)
    ? Effect.interrupt
    : Effect.fail(
        new ProviderError({
          message: "Could not save operation progress. The change will be retried.",
        }),
      );

export const StoreLive: Layer.Layer<Store, never, SqlClient.SqlClient> = Layer.effect(
  Store,
  Effect.gen(function* () {
    const crypto = yield* PlatformCrypto;
    const sql = yield* SqlClient.SqlClient;
    const cache = makeCacheStore(sql);
    const compose = makeComposeStore(sql, crypto);
    const signatureLibrary = makeSignatureStore(sql, crypto);
    const capabilities = yield* Effect.serviceOption(DatabaseCapabilities);
    const vectors = Option.isSome(capabilities) && capabilities.value.vectors;
    const media = makeMediaStore(sql, vectors, "derived_jobs", crypto);
    const semantics = makeSemanticStore(
      sql,
      vectors,
      (q) => {
        const { attachmentText: _scope, ...criteria } = q.criteria ?? {};
        return listFilter({ ...q, search: "", criteria });
      },
      crypto,
    );
    const contacts = makeContactStore(sql);
    const organization = makeOrganizationStore(sql);

    const hasLabel = (label: string) =>
      sql`EXISTS (SELECT 1 FROM json_each(m.labels_json) WHERE value = ${label})`;

    // An empty profile matches nothing rather than everything.
    const inAccounts = (ids: readonly string[]) =>
      ids.length === 0 ? sql.literal("0") : sql`m.account_id IN ${sql.in(ids)}`;

    // Accounts

    const accountRows = all(AccountRow);
    const ACCOUNT_COLUMNS = sql.literal(`id, provider, email, created_at, last_synced_at,
      COALESCE(last_sync_error,(SELECT poll_error FROM incoming_state WHERE account_id=accounts.id)) AS last_sync_error, profile_id, settings_json, needs_reauth, enabled, description, color, position`);

    const listAccounts = accountRows(
      sql`SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY position, created_at, id`,
    ).pipe(
      Effect.map((rows) => rows.map(toAccount)),
      Effect.withSpan("Store.listAccounts"),
    );

    const getAccount = Effect.fn("Store.getAccount")(function* (
      id: string,
    ): Effect.fn.Return<Account, NotFound> {
      const row = yield* first(AccountRow)(
        sql`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ${id}`,
      );
      if (Option.isNone(row)) return yield* new NotFound({ what: "account", id });
      return toAccount(row.value);
    });

    const upsertAccount = Effect.fn("Store.upsertAccount")(function* (
      provider: Provider,
      email: string,
    ) {
      const id = accountId(provider, email);
      const now = yield* Clock.currentTimeMillis;
      yield* run(sql`INSERT INTO accounts (id, provider, email, created_at, position)
        VALUES (${id}, ${provider}, ${email}, ${now}, (SELECT COALESCE(MAX(position), -1) + 1 FROM accounts)) ON CONFLICT(id) DO NOTHING`);
      return yield* Effect.orDie(getAccount(id));
    });

    const removeAccount = Effect.fn("Store.removeAccount")((id: string) =>
      media.deleteVectorsForMessages(sql`m.account_id=${id}`).pipe(
        Effect.andThen(
          sql
            .withTransaction(
              Effect.gen(function* () {
                yield* run(
                  sql`DELETE FROM undo_batches WHERE EXISTS (SELECT 1 FROM json_each(payload,'$.expected') e WHERE json_extract(e.value,'$.accountId')=${id})`,
                );
                const epochs = `imap-epoch:${JSON.stringify([id]).slice(0, -1)},`;
                yield* run(sql`DELETE FROM prefs WHERE substr(key,1,${epochs.length})=${epochs}`);
                yield* run(
                  sql`DELETE FROM prefs WHERE key IN (${`sync-reset:${id}`},${`sync-stale:${id}`})`,
                );
                yield* run(sql`DELETE FROM accounts WHERE id=${id}`);
              }),
            )
            .pipe(Effect.orDie),
        ),
      ),
    );

    const setAccountProfile = Effect.fn("Store.setAccountProfile")(
      (id: string, profileId: string | null) =>
        run(sql`UPDATE accounts SET profile_id = ${profileId} WHERE id = ${id}`),
    );

    const setAccountSettings = Effect.fn("Store.setAccountSettings")(function* (
      id: string,
      input: AccountSettings,
    ) {
      const account = yield* getAccount(id);
      if (input.imapAuthservId !== undefined) {
        if (!account.imap)
          return yield* new InvalidInput({
            message: "Authentication service trust is only available for IMAP accounts",
          });
        const authservId = input.imapAuthservId?.toLowerCase() ?? null;
        if ((account.imap.authservId ?? null) !== authservId) {
          yield* run(
            sql`UPDATE accounts SET settings_json=${JSON.stringify({ ...account.imap, authservId })} WHERE id=${id}`,
          );
          // Existing results must not survive a change to the trust boundary.
          yield* run(sql`UPDATE messages SET security_json=NULL WHERE account_id=${id}`);
        }
      }
      yield* run(
        sql`UPDATE accounts SET enabled=${input.enabled ? 1 : 0}, description=${input.description.trim()}, color=${input.color} WHERE id=${id}`,
      );
      if (!input.enabled)
        yield* run(
          sql`DELETE FROM pending_notifications WHERE message_id IN (SELECT id FROM messages WHERE account_id=${id})`,
        );
      return yield* Effect.void;
    });
    const moveAccount = Effect.fn("Store.moveAccount")(function* (
      id: string,
      input: AccountPlacement,
    ) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* getAccount(id);
            if (input.profileId !== null) {
              const profile = yield* first(Profile)(
                sql`SELECT id, name, icon, color, position FROM profiles WHERE id=${input.profileId}`,
              );
              if (Option.isNone(profile))
                return yield* new NotFound({ what: "profile", id: input.profileId });
            }
            const accounts = (yield* listAccounts).filter((a) => a.id !== id);
            if (
              input.beforeId !== null &&
              !accounts.some((a) => a.id === input.beforeId && a.profileId === input.profileId)
            )
              return yield* new InvalidInput({
                message: "The destination account must belong to the target space",
              });
            const before =
              input.beforeId === null
                ? accounts.length
                : accounts.findIndex((a) => a.id === input.beforeId);
            const ordered = accounts.map((a) => a.id);
            ordered.splice(before, 0, id);
            yield* run(sql`UPDATE accounts SET profile_id=${input.profileId} WHERE id=${id}`);
            for (const [position, orderedId] of ordered.entries())
              yield* run(sql`UPDATE accounts SET position=${position} WHERE id=${orderedId}`);
            return yield* Effect.void;
          }),
        )
        .pipe(Effect.catchIf(isSqlError, (error) => Effect.die(error)));
    });

    const setImapSettings = Effect.fn("Store.setImapSettings")(
      (id: string, settings: ImapSettings) =>
        run(sql`UPDATE accounts SET settings_json = ${JSON.stringify(settings)} WHERE id = ${id}`),
    );

    const setNeedsReauth = Effect.fn("Store.setNeedsReauth")((id: string, value: boolean) =>
      run(sql`UPDATE accounts SET needs_reauth = ${value ? 1 : 0} WHERE id = ${id}`),
    );

    const setSyncError = Effect.fn("Store.setSyncError")((id: string, error: string | null) =>
      run(sql`UPDATE accounts SET last_sync_error = ${error} WHERE id = ${id}`),
    );

    const getSyncCursor = Effect.fn("Store.getSyncCursor")(function* (id: string) {
      const row = yield* first(Cursor)(sql`SELECT sync_cursor FROM accounts WHERE id = ${id}`);
      return Option.flatMap(row, (r) => Option.fromNullishOr(r.sync_cursor));
    });

    const saveSyncCursor = Effect.fn("Store.saveSyncCursor")(function* (
      id: string,
      cursor: string,
      stamp = true,
    ) {
      const now = yield* Clock.currentTimeMillis;
      yield* run(
        sql`UPDATE accounts SET sync_cursor = ${cursor}, last_synced_at = CASE WHEN ${stamp ? 1 : 0} THEN ${now} ELSE last_synced_at END WHERE id = ${id}`,
      );
    });

    const initialSyncState = (id: string, complete: boolean) =>
      run(sql`INSERT INTO incoming_state(account_id,initial_sync_complete) VALUES (${id}, ${complete ? 1 : 0})
        ON CONFLICT(account_id) DO UPDATE SET initial_sync_complete=excluded.initial_sync_complete`);
    const notificationsReady = Effect.fn("Store.notificationsReady")(function* (id: string) {
      const row = yield* first(Schema.Struct({ complete: Schema.BooleanFromBit }))(
        sql`SELECT initial_sync_complete AS complete FROM incoming_state WHERE account_id=${id}`,
      );
      if (Option.isSome(row)) return row.value.complete;
      return (yield* getAccount(id).pipe(Effect.orDie)).lastSyncedAt !== null;
    });
    const getInboxCursor = (id: string) =>
      first(Schema.Struct({ cursor: Schema.NullOr(Schema.String) }))(
        sql`SELECT inbox_cursor AS cursor FROM incoming_state WHERE account_id=${id}`,
      ).pipe(Effect.map((row) => Option.flatMap(row, (r) => Option.fromNullishOr(r.cursor))));
    const saveInboxCursor = (id: string, cursor: string) =>
      run(sql`INSERT INTO incoming_state(account_id,inbox_cursor) VALUES (${id},${cursor})
        ON CONFLICT(account_id) DO UPDATE SET inbox_cursor=excluded.inbox_cursor`);
    const getInboxError = (id: string) =>
      first(Schema.Struct({ error: Schema.NullOr(Schema.String) }))(
        sql`SELECT poll_error AS error FROM incoming_state WHERE account_id=${id}`,
      ).pipe(
        Effect.map((row) => Option.match(row, { onNone: () => null, onSome: (r) => r.error })),
      );
    const setInboxError = (id: string, error: string | null) =>
      run(sql`INSERT INTO incoming_state(account_id,poll_error) VALUES (${id},${error})
        ON CONFLICT(account_id) DO UPDATE SET poll_error=excluded.poll_error`);
    const observeIncoming = (id: string, identity: string) =>
      first(Schema.Struct({ present: Schema.Number }))(
        sql`INSERT INTO seen_incoming(account_id,identity) VALUES (${id},${identity})
        ON CONFLICT(account_id,identity) DO NOTHING RETURNING 1 AS present`,
      ).pipe(Effect.map(Option.isSome));
    const hasMessage = (id: string) =>
      first(Schema.Struct({ present: Schema.Number }))(
        sql`SELECT 1 AS present FROM messages WHERE id=${id}`,
      ).pipe(Effect.map(Option.isSome));

    // Messages

    const imapFolder = (
      folder: import("./services.js").ImapFolderIdentity,
      column = sql.literal("m.provider_id"),
    ) =>
      sql`${column}>=${`${folder.uidValidity}:`} AND ${column}<${`${folder.uidValidity};`} AND substr(${column}, instr(${column}, ':') + instr(substr(${column}, instr(${column}, ':') + 1), ':') + 1)=${folder.path}`;
    const syncResets = makeSyncResetStore(sql, hasLabel, imapFolder);
    const invalidateImapFolder = (
      account: string,
      previous: import("./services.js").ImapFolderIdentity,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const ids = (yield* all(MessageId)(
              sql`SELECT m.id FROM messages AS m WHERE m.account_id=${account} AND ${imapFolder(previous)}`,
            )).map((row) => row.id);
            const snapshot = yield* syncResets.resetCandidates(account, {
              _tag: "RebuildFolder",
              previous,
              keep: [],
            });
            const generation = crypto.randomUUID();
            const now = yield* Clock.currentTimeMillis;
            yield* logSyncReset(yield* getAccount(account).pipe(Effect.orDie), previous.path, {
              phase: "reset",
              listed: 0,
              kept: 0,
              local: snapshot.local,
              candidates: snapshot.candidates.length,
              verified: 0,
              incomplete: 0,
              deferred: snapshot.candidates.length,
            });
            // Persist the generation before deleting rows; stale handles must never name refetched mail.
            yield* run(
              sql`INSERT INTO prefs(key,value_json) VALUES(${imapEpochKey(account, previous)},${JSON.stringify(generation)}) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`,
            );
            yield* run(
              sql`DELETE FROM undo_batches WHERE EXISTS(SELECT 1 FROM json_tree(payload) e WHERE e.key='id' AND e.value IN (SELECT value FROM json_each(${JSON.stringify(ids)})))`,
            );
            yield* run(
              sql`UPDATE proposals SET status='rejected',decided_at=${now} WHERE status='pending' AND (EXISTS(SELECT 1 FROM json_each(command_json,'$.threads') t WHERE t.value IN (SELECT value FROM json_each(${JSON.stringify(ids)}))) OR json_extract(command_json,'$.message.inReplyTo') IN (SELECT value FROM json_each(${JSON.stringify(ids)})))`,
            );
            // The server reused UIDs without changing UIDVALIDITY. None of the old references are safe.
            yield* run(
              sql`UPDATE pending_ops AS m SET provider_id='unmapped:' || provider_id || ':' || id, op_json=${JSON.stringify({ kind: "reconcile" })}, claimed_at=NULL, attempts=0, last_error='IMAP UID namespace reset' WHERE m.account_id=${account} AND ${imapFolder(previous)}`,
            );
            yield* run(
              sql`DELETE FROM snoozed_messages AS m WHERE m.account_id=${account} AND ${imapFolder(previous)}`,
            );
            yield* run(
              sql`DELETE FROM thread_reminders WHERE account_id=${account} AND NOT EXISTS(SELECT 1 FROM snoozed_messages s WHERE s.account_id=thread_reminders.account_id AND s.thread_id=thread_reminders.thread_id)`,
            );
            yield* run(
              sql`UPDATE drafts SET remote_message_id=NULL, remote_draft_id=NULL WHERE account_id=${account} AND (${imapFolder(previous, sql.literal("remote_message_id"))} OR ${imapFolder(previous, sql.literal("remote_draft_id"))})`,
            );
            const pending = yield* syncResets.pendingResetCandidates(account);
            const originals = new Set(snapshot.candidates.map((candidate) => candidate.providerId));
            const detached = snapshot.candidates.map((candidate) => ({
              ...candidate,
              resetProviderId: candidate.providerId,
              providerId: `unmapped:${candidate.providerId}:reset:${generation}`,
            }));
            for (const candidate of detached)
              yield* run(
                sql`UPDATE messages SET provider_id=${candidate.providerId} WHERE account_id=${account} AND provider_id=${candidate.resetProviderId}`,
              );
            yield* syncResets.saveResetCandidates(account, [
              ...pending.filter((candidate) => !originals.has(candidate.providerId)),
              ...detached,
            ]);
            return ids;
          }),
        )
        .pipe(Effect.catchIf(isSqlError, (error) => Effect.die(error)));
    let lastTruncate = yield* Clock.currentTimeMillis;
    const messageIdForProvider = (account: string, providerId: string) =>
      first(MessageId)(
        sql`SELECT id FROM messages WHERE account_id=${account} AND provider_id=${providerId} ORDER BY date DESC,id LIMIT 1`,
      ).pipe(Effect.map((row) => (Option.isSome(row) ? row.value.id : null)));
    const remapProviderIds = (
      account: string,
      mappings: readonly import("./services.js").ProviderIdMapping[],
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            for (const mapping of mappings) {
              if (mapping.from === mapping.to) continue;
              const source = yield* messageIdForProvider(account, mapping.from);
              if (source) {
                const sameMessage = sql`m.rfc_message_id IS NOT NULL AND m.rfc_message_id=(SELECT rfc_message_id FROM messages WHERE id=${source})`;
                yield* media.deleteVectorsForMessages(
                  sql`m.account_id=${account} AND m.provider_id=${mapping.to} AND m.id<>${source} AND ${sameMessage}`,
                );
                yield* run(
                  sql`DELETE FROM messages AS m WHERE m.account_id=${account} AND m.provider_id=${mapping.to} AND m.id<>${source} AND ${sameMessage}`,
                );
                // Keep an unrelated cached target, but never bind its queued mutations to the moved mail.
                if (yield* messageIdForProvider(account, mapping.to)) {
                  const detached = `unmapped:${crypto.randomUUID()}`;
                  yield* run(
                    sql`UPDATE pending_ops SET provider_id=${detached}, op_json=${JSON.stringify({ kind: "reconcile" })}, claimed_at=NULL WHERE account_id=${account} AND provider_id=${mapping.to}`,
                  );
                  yield* run(
                    sql`UPDATE messages SET provider_id=${detached} WHERE account_id=${account} AND provider_id=${mapping.to} AND id<>${source}`,
                  );
                  const now = yield* Clock.currentTimeMillis;
                  yield* run(
                    sql`INSERT INTO pending_ops(account_id,provider_id,op_json,created_at) SELECT ${account},${detached},${JSON.stringify({ kind: "reconcile" })},${now} WHERE NOT EXISTS(SELECT 1 FROM pending_ops WHERE account_id=${account} AND provider_id=${detached})`,
                  );
                  yield* run(
                    sql`DELETE FROM snoozed_messages WHERE account_id=${account} AND provider_id=${mapping.to}`,
                  );
                  yield* run(
                    sql`UPDATE drafts SET remote_message_id=NULL,remote_draft_id=NULL WHERE account_id=${account} AND remote_message_id=${mapping.to}`,
                  );
                }
                yield* run(sql`UPDATE messages SET provider_id=${mapping.to} WHERE id=${source}`);
              }
              yield* run(
                sql`UPDATE pending_ops SET provider_id=${mapping.to} WHERE account_id=${account} AND provider_id=${mapping.from}`,
              );
              yield* run(
                sql`DELETE FROM snoozed_messages WHERE account_id=${account} AND provider_id=${mapping.to} AND EXISTS(SELECT 1 FROM snoozed_messages WHERE account_id=${account} AND provider_id=${mapping.from})`,
              );
              yield* run(
                sql`INSERT OR IGNORE INTO snoozed_messages(account_id,thread_id,provider_id,wake_pending) SELECT account_id,thread_id,${mapping.to},wake_pending FROM snoozed_messages WHERE account_id=${account} AND provider_id=${mapping.from}`,
              );
              yield* run(
                sql`DELETE FROM snoozed_messages WHERE account_id=${account} AND provider_id=${mapping.from}`,
              );
              yield* run(
                sql`UPDATE drafts SET remote_message_id=${mapping.to}, remote_draft_id=CASE WHEN remote_draft_id=${mapping.from} THEN ${mapping.to} ELSE remote_draft_id END WHERE account_id=${account} AND remote_message_id=${mapping.from}`,
              );
            }
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.fail(
                  new ProviderError({
                    message:
                      "Could not update local message identities. The change will be retried.",
                  }),
                ),
          ),
        );
    const Reminder = Schema.Struct({
      due_at: Schema.NullOr(Schema.Number),
      woken_at: Schema.NullOr(Schema.Number),
      wake_pending: Schema.BooleanFromBit,
    });
    const upsertMessage = Effect.fn("Store.upsertMessage")(function* (
      account: string,
      incoming: IncomingMessage,
    ) {
      if (incoming.labels.some((l) => ["DRAFT", "TRASH", "SPAM"].includes(l)))
        yield* run(
          sql`DELETE FROM snoozed_messages WHERE account_id=${account} AND provider_id=${incoming.providerId}`,
        );
      const reminder = yield* first(Reminder)(
        sql`SELECT r.due_at, r.woken_at, s.wake_pending FROM thread_reminders r JOIN snoozed_messages s ON s.account_id=r.account_id AND s.thread_id=r.thread_id WHERE s.account_id=${account} AND s.provider_id=${incoming.providerId}`,
      );
      let localId = yield* messageIdForProvider(account, incoming.providerId);
      if (localId === null) {
        const ref = decodeProviderId(incoming.providerId);
        const epoch = Option.isSome(ref)
          ? yield* first(Schema.Struct({ epoch: Schema.fromJsonString(Schema.String) }))(
              sql`SELECT value_json AS epoch FROM prefs WHERE key=${imapEpochKey(account, ref.value)}`,
            )
          : Option.none();
        const candidate = Option.isSome(epoch)
          ? `${account}/epoch:${epoch.value.epoch}/${incoming.providerId}`
          : `${account}/${incoming.providerId}`;
        const existing = yield* first(Schema.Struct({ provider_id: Schema.String }))(
          sql`SELECT provider_id FROM messages WHERE id=${candidate}`,
        );
        localId =
          Option.isSome(existing) && existing.value.provider_id !== incoming.providerId
            ? `${account}/local:${crypto.randomUUID()}`
            : candidate;
      }
      let m = incoming;
      if (incoming.parentRfcMessageId) {
        const parent = yield* first(Schema.Struct({ thread_id: Schema.String }))(
          sql`SELECT thread_id FROM messages WHERE account_id=${account} AND trim(rfc_message_id, '<>')=${incoming.parentRfcMessageId.replace(/^<|>$/g, "")} ORDER BY date DESC LIMIT 1`,
        );
        if (Option.isSome(parent)) m = { ...m, threadId: parent.value.thread_id };
        else {
          const existing = yield* first(Schema.Struct({ thread_id: Schema.String }))(
            sql`SELECT thread_id FROM messages WHERE id=${localId}`,
          );
          if (Option.isSome(existing)) m = { ...m, threadId: existing.value.thread_id };
        }
      }
      if (incoming.labels.includes("DRAFT")) {
        const owner = yield* getAccount(account).pipe(Effect.orDie);
        if (owner.provider === "gmail") {
          const draft = yield* compose.draftByRemoteMessage(account, incoming.providerId);
          const draftOrganization = Option.isSome(draft)
            ? draft.value.message.draftOrganization
            : undefined;
          if (draftOrganization)
            m = {
              ...incoming,
              labels: [
                "DRAFT",
                ...draftOrganization.labels,
                ...(draftOrganization.starred ? ["STARRED"] : []),
              ],
              isStarred: draftOrganization.starred,
            };
        }
      }
      if (Option.isSome(reminder) && reminder.value.due_at !== null) {
        const owner = yield* getAccount(account).pipe(Effect.orDie);
        m = {
          ...m,
          labels: [...applyOpToLabels(m.labels, { kind: "archive" }, owner.provider), "SNOOZED"],
        };
      }
      if (
        Option.isSome(reminder) &&
        reminder.value.wake_pending &&
        reminder.value.due_at === null
      ) {
        if (m.labels.includes("INBOX") && m.isUnread)
          yield* run(
            sql`UPDATE snoozed_messages SET wake_pending=0 WHERE account_id=${account} AND provider_id=${m.providerId}`,
          );
        else {
          const owner = yield* getAccount(account).pipe(Effect.orDie);
          m = {
            ...m,
            labels: applyOpToLabels(
              applyOpToLabels(m.labels, { kind: "inbox" }, owner.provider),
              { kind: "read", value: false },
              owner.provider,
            ),
            isUnread: true,
          };
        }
      }
      yield* media.deleteVectorsForMessages(sql`m.id=${localId} AND
        (m.body_text!=${m.bodyText} OR m.body_html!=${m.bodyHtml} OR m.attachments_json!=${JSON.stringify(m.attachments)})`);
      yield* (
        // ON CONFLICT DO UPDATE keeps the rowid stable, which the external-content
        // FTS table is keyed on. INSERT OR REPLACE would orphan index rows.
        run(sql`INSERT INTO messages (id, account_id, provider_id, thread_id, subject, from_name,
            from_addr, to_json, cc_json, reply_to_json, date, snippet, body_text, body_html, labels_json,
            attachments_json, is_unread, is_starred, calendar_hint, body_cached, list_date, web_link, bcc_json, rfc_message_id, message_size, headers_json, security_json)
          VALUES (${localId}, ${account}, ${m.providerId}, ${m.threadId},
            ${m.subject}, ${cleanDisplayName(m.from.name)}, ${m.from.address}, ${JSON.stringify(m.to)},
            ${JSON.stringify(m.cc)}, ${JSON.stringify(m.replyTo ?? [])}, ${m.date}, ${m.snippet}, ${m.bodyText}, ${m.bodyHtml},
            ${JSON.stringify(m.labels)}, ${JSON.stringify(m.attachments)}, ${m.isUnread ? 1 : 0},
            ${m.isStarred ? 1 : 0}, ${m.hasCalendar || m.bodyText.trimStart().startsWith("BEGIN:VCALENDAR") || m.attachments.some((a) => a.mimeType === "text/calendar" || /\.ics$/i.test(a.filename)) ? 1 : 0}, ${m.bodyCached === false ? 0 : 1}, ${Math.max(m.date, Option.isSome(reminder) ? (reminder.value.woken_at ?? 0) : 0)}, ${m.webLink ?? null}, ${JSON.stringify(m.bcc ?? [])}, ${m.rfcMessageId ?? null}, ${m.size ?? null}, ${m.headers ? JSON.stringify(m.headers) : null}, ${m.security ? JSON.stringify(m.security) : null})
          ON CONFLICT(id) DO UPDATE SET
            headers_json=COALESCE(excluded.headers_json,messages.headers_json),
            security_json=COALESCE(excluded.security_json,messages.security_json),
            bcc_json=excluded.bcc_json, rfc_message_id=COALESCE(excluded.rfc_message_id,messages.rfc_message_id), message_size=COALESCE(excluded.message_size,messages.message_size),
            thread_id = excluded.thread_id, subject = excluded.subject,
            from_name = excluded.from_name, from_addr = excluded.from_addr,
            to_json = excluded.to_json, cc_json = excluded.cc_json, reply_to_json = excluded.reply_to_json, date = excluded.date,
            snippet = excluded.snippet, body_text = excluded.body_text,
            body_html = excluded.body_html, labels_json = excluded.labels_json,
            attachments_json = excluded.attachments_json, is_unread = excluded.is_unread,
            is_starred = excluded.is_starred, calendar_hint = excluded.calendar_hint, body_cached = excluded.body_cached, list_date = excluded.list_date,
            web_link = COALESCE(excluded.web_link, messages.web_link)
          WHERE messages.security_json IS NOT COALESCE(excluded.security_json,messages.security_json) OR messages.thread_id IS NOT excluded.thread_id OR messages.subject IS NOT excluded.subject
            OR messages.from_name IS NOT excluded.from_name OR messages.from_addr IS NOT excluded.from_addr
            OR messages.to_json IS NOT excluded.to_json OR messages.cc_json IS NOT excluded.cc_json
            OR messages.reply_to_json IS NOT excluded.reply_to_json OR messages.bcc_json IS NOT excluded.bcc_json
            OR messages.date IS NOT excluded.date OR messages.snippet IS NOT excluded.snippet
            OR messages.body_text IS NOT excluded.body_text OR messages.body_html IS NOT excluded.body_html
            OR messages.labels_json IS NOT excluded.labels_json OR messages.attachments_json IS NOT excluded.attachments_json
            OR messages.is_unread IS NOT excluded.is_unread OR messages.is_starred IS NOT excluded.is_starred
            OR messages.calendar_hint IS NOT excluded.calendar_hint OR messages.body_cached IS NOT excluded.body_cached
            OR messages.list_date IS NOT excluded.list_date
            OR messages.headers_json IS NOT COALESCE(excluded.headers_json,messages.headers_json)
            OR messages.rfc_message_id IS NOT COALESCE(excluded.rfc_message_id,messages.rfc_message_id)
            OR messages.message_size IS NOT COALESCE(excluded.message_size,messages.message_size)
            OR messages.web_link IS NOT COALESCE(excluded.web_link,messages.web_link)`)
      );
      if (m.labels.includes("SENT"))
        yield* contacts.rememberMailedAddresses(
          account,
          [...m.to, ...m.cc].map((recipient) => recipient.address),
        );
    });

    const deleteMessage = Effect.fn("Store.deleteMessage")((account: string, providerId: string) =>
      media
        .deleteVectorsForMessages(sql`m.account_id=${account} AND m.provider_id=${providerId}`)
        .pipe(
          Effect.andThen(
            run(
              sql`DELETE FROM messages WHERE account_id=${account} AND provider_id=${providerId}`,
            ),
          ),
        ),
    );
    const outsideKeep = (keep?: readonly string[]) =>
      keep?.length
        ? sql`m.provider_id NOT IN (SELECT value FROM json_each(${JSON.stringify(keep)}))`
        : sql.literal("1");
    const deleteMessagesWithLabel = Effect.fn("Store.deleteMessagesWithLabel")(
      (account: string, label: string, keep?: readonly string[]) =>
        media
          .deleteVectorsForMessages(
            sql`m.account_id=${account} AND ${hasLabel(label)} AND ${outsideKeep(keep)}`,
          )
          .pipe(
            Effect.andThen(
              run(
                sql`DELETE FROM messages AS m WHERE m.account_id=${account} AND ${hasLabel(label)} AND ${outsideKeep(keep)}`,
              ),
            ),
          ),
    );
    const deleteAccountMessages = Effect.fn("Store.deleteAccountMessages")(
      (account: string, keep?: readonly string[], since?: number) =>
        media
          .deleteVectorsForMessages(
            sql`m.account_id=${account} AND ${outsideKeep(keep)} AND (${since ?? null} IS NULL OR m.date>=${since ?? null})`,
          )
          .pipe(
            Effect.andThen(
              run(
                sql`DELETE FROM messages AS m WHERE m.account_id=${account} AND ${outsideKeep(keep)} AND (${since ?? null} IS NULL OR m.date>=${since ?? null})`,
              ),
            ),
          ),
    );

    const wordIndex = makeWordIndexStore(sql);
    type LocalQuery = ThreadQuery & {
      wordIndexReady?: boolean;
      derivedWordIndexReady?: boolean;
      rowBoundText?: boolean;
      textPage?: { index: "messages_words" | "messages_fts"; match: string };
    };
    const textFilter = (
      value: string,
      derived: boolean,
      ready: boolean,
      subjectOnly = false,
      rowBound = false,
    ): Fragment => {
      const match = ftsSearchTerm(value);
      if (!match) return sql.literal("1");
      const text = unquoteSearchValue(value.endsWith("*") ? value.slice(0, -1) : value);
      if (ready && !usesSubstringSearch(text)) {
        if (rowBound)
          return derived
            ? sql`EXISTS (SELECT 1 FROM derived_words WHERE rowid=d.id AND derived_words MATCH ${match})`
            : sql`EXISTS (SELECT 1 FROM messages_words WHERE rowid=m.rowid AND messages_words MATCH ${subjectOnly ? `subject : ${match}` : match})`;
        return derived
          ? sql`d.id IN (SELECT rowid FROM derived_words WHERE derived_words MATCH ${match})`
          : sql`m.rowid IN (SELECT rowid FROM messages_words WHERE messages_words MATCH ${subjectOnly ? `subject : ${match}` : match})`;
      }
      if (Array.from(text).length >= 3) {
        const literal = ftsSearchTerm(quoteSearchValue(text));
        if (rowBound)
          return derived
            ? sql`EXISTS (SELECT 1 FROM derived_fts WHERE rowid=d.id AND derived_fts MATCH ${literal})`
            : sql`EXISTS (SELECT 1 FROM messages_fts WHERE rowid=m.rowid AND messages_fts MATCH ${subjectOnly ? `subject : ${literal}` : literal})`;
        return derived
          ? sql`d.id IN (SELECT rowid FROM derived_fts WHERE derived_fts MATCH ${literal})`
          : sql`m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${subjectOnly ? `subject : ${literal}` : literal})`;
      }
      const like = literalLike(text);
      return derived
        ? sql`d.text LIKE ${like} ESCAPE '\\'`
        : subjectOnly
          ? sql`m.subject LIKE ${like} ESCAPE '\\'`
          : sql`(m.subject LIKE ${like} ESCAPE '\\' OR m.from_name LIKE ${like} ESCAPE '\\' OR m.from_addr LIKE ${like} ESCAPE '\\' OR m.body_text LIKE ${like} ESCAPE '\\')`;
    };

    const attachmentTypeFilter = (type: AttachmentType): Fragment => {
      const spec = ATTACHMENT_TYPES[type];
      const mime = sql`lower(trim(substr(json_extract(a.value,'$.mimeType'), 1, instr(json_extract(a.value,'$.mimeType') || ';', ';') - 1)))`;
      const drivePath = typedDrivePath(type);
      const attachment = sql`EXISTS (SELECT 1 FROM json_each(m.attachments_json) a WHERE ${sql.or([
        ...(type === "image" ? [sql`${mime} LIKE 'image/%'`] : []),
        sql`${mime} IN (SELECT value FROM json_each(${JSON.stringify(spec.mimeTypes)}))`,
        ...spec.extensions.map(
          (ext) => sql`lower(json_extract(a.value,'$.filename')) LIKE ${`%.${ext}`}`,
        ),
      ])})`;
      return drivePath
        ? sql`(${attachment} OR m.body_text LIKE ${`%https://docs.google.com/${drivePath}/%`} OR m.body_html LIKE ${`%https://docs.google.com/${drivePath}/%`})`
        : attachment;
    };
    const proximityFilter = (
      p: NonNullable<SearchCondition["proximity"]>,
      derived = false,
      ready = true,
    ): Fragment => {
      const left = wordTokens(p.left),
        right = wordTokens(p.right);
      if (!left.length || !right.length) return sql.literal("0");
      if (!ready)
        return sql.and([
          textFilter(quoteSearchValue(p.left), derived, false),
          textFilter(quoteSearchValue(p.right), derived, false),
        ]);
      const index = sql.literal(derived ? "derived_words" : "messages_words");
      const table = sql.literal(derived ? "derived_word_positions" : "messages_word_positions");
      const near = `NEAR(${quoteSearchValue(left.join(" "))} ${quoteSearchValue(right.join(" "))}, ${p.distance})`;
      const samePhrase = (words: string[], alias: "a" | "b") =>
        words.slice(1).map((word, i) => {
          const ref = sql.literal(alias);
          return sql`EXISTS (SELECT 1 FROM positions w WHERE w.doc=${ref}.doc AND w.col=${ref}.col AND w.offset=${ref}.offset+${i + 1} AND w.term=${word})`;
        });
      const forward = sql`b.offset>=a.offset+${left.length} AND b.offset-a.offset-${left.length}<=${p.distance}`;
      const reverse = sql`a.offset>=b.offset+${right.length} AND a.offset-b.offset-${right.length}<=${p.distance}`;
      // These materialized sets have no outer-row references: FTS and each term's
      // instance stream are read once, not once per candidate message/chunk.
      return sql`${derived ? sql.literal("d.id") : sql.literal("m.rowid")} IN (
        WITH candidates AS MATERIALIZED (SELECT rowid FROM ${index} WHERE ${index} MATCH ${near}),
        positions AS MATERIALIZED (SELECT term,doc,col,offset FROM ${table} WHERE term IN (SELECT value FROM json_each(${JSON.stringify([...new Set([...left, ...right])])})) AND doc IN (SELECT rowid FROM candidates))
        SELECT DISTINCT a.doc FROM positions a JOIN positions b ON b.doc=a.doc AND b.col=a.col
        WHERE a.term=${left[0]} AND b.term=${right[0]} AND (${p.ordered ? forward : sql`(${forward}) OR (${reverse})`}) AND ${sql.and([...samePhrase(left, "a"), ...samePhrase(right, "b")])}
      )`;
    };

    const searchConditionFilter = (
      c: SearchCondition,
      ready = false,
      rowBound = false,
    ): Fragment => {
      const where: Fragment[] = [];
      if (c.unread !== undefined) where.push(sql`m.is_unread=${c.unread ? 1 : 0}`);
      if (c.starred !== undefined) where.push(sql`m.is_starred=${c.starred ? 1 : 0}`);
      if (c.bcc)
        where.push(
          sql`EXISTS (SELECT 1 FROM json_each(m.bcc_json) WHERE json_extract(value,'$.address') LIKE ${literalLike(c.bcc)} ESCAPE '\\' OR json_extract(value,'$.name') LIKE ${literalLike(c.bcc)} ESCAPE '\\')`,
        );
      if (c.proximity) where.push(proximityFilter(c.proximity, false, ready));
      if (c.subjectContains)
        where.push(sql`m.subject LIKE ${literalLike(c.subjectContains)} ESCAPE '\\'`);
      if (c.mailingList)
        where.push(
          sql`EXISTS (SELECT 1 FROM json_each(m.headers_json) h WHERE lower(json_extract(h.value,'$.name')) IN ('list-id','list-post') AND (json_extract(h.value,'$.value') LIKE ${literalLike(c.mailingList)} ESCAPE '\\' OR (lower(json_extract(h.value,'$.name'))='list-id' AND json_extract(h.value,'$.value') LIKE ${literalLike(c.mailingList.replace("@", "."))} ESCAPE '\\'))) `,
        );
      if (c.header)
        where.push(
          sql`EXISTS (SELECT 1 FROM json_each(m.headers_json) h WHERE lower(json_extract(h.value,'$.name'))=${c.header.name.toLowerCase()} AND json_extract(h.value,'$.value') LIKE ${literalLike(c.header.value)} ESCAPE '\\')`,
        );
      if (c.userLabels !== undefined) {
        const labeled = sql`EXISTS (SELECT 1 FROM json_each(m.labels_json) j JOIN labels l ON l.account_id=m.account_id AND l.id=j.value WHERE j.value NOT LIKE 'CATEGORY_%' AND j.value NOT LIKE 'category:%')`;
        where.push(c.userLabels ? labeled : sql`NOT (${labeled})`);
      }
      if (c.rfcMessageId)
        where.push(sql`trim(m.rfc_message_id, '<>')=${c.rfcMessageId.replace(/^<|>$/g, "")}`);
      if (c.sizeLarger !== undefined)
        where.push(sql`(m.message_size IS NULL OR m.message_size > ${c.sizeLarger})`);
      if (c.sizeSmaller !== undefined)
        where.push(sql`(m.message_size IS NULL OR m.message_size < ${c.sizeSmaller})`);
      if (c.drive)
        where.push(
          sql`(m.body_text LIKE '%https://drive.google.com/%' OR m.body_html LIKE '%https://drive.google.com/%' OR m.body_text LIKE '%https://docs.google.com/%' OR m.body_html LIKE '%https://docs.google.com/%')`,
        );
      if (c.cc)
        where.push(
          sql`EXISTS (SELECT 1 FROM json_each(m.cc_json) WHERE json_extract(value,'$.address') LIKE ${literalLike(c.cc)} ESCAPE '\\' OR json_extract(value,'$.name') LIKE ${literalLike(c.cc)} ESCAPE '\\')`,
        );
      for (const type of c.attachmentTypes ?? []) where.push(attachmentTypeFilter(type));
      if (c.from)
        where.push(
          sql`(m.from_addr LIKE ${literalLike(c.from)} ESCAPE '\\' OR m.from_name LIKE ${literalLike(c.from)} ESCAPE '\\')`,
        );
      if (c.to)
        where.push(
          sql`EXISTS (SELECT 1 FROM json_each(m.to_json) WHERE json_extract(value, '$.address') LIKE ${literalLike(c.to)} ESCAPE '\\' OR json_extract(value, '$.name') LIKE ${literalLike(c.to)} ESCAPE '\\')`,
        );
      if (c.subject) where.push(textFilter(c.subject, false, ready, true, rowBound));
      if (c.important) where.push(hasLabel("IMPORTANT"));
      if (c.attachmentText)
        where.push(sql`EXISTS(SELECT 1 FROM derived_chunks d WHERE d.message_id=m.id)`);
      if (c.image) where.push(sql`(${attachmentTypeFilter("image")} OR m.body_html LIKE '%cid:%')`);
      if (c.attachment !== undefined)
        where.push(
          c.attachment
            ? sql`json_array_length(m.attachments_json)>0`
            : sql`json_array_length(m.attachments_json)=0`,
        );
      if (c.filename)
        where.push(
          sql`EXISTS (SELECT 1 FROM json_each(m.attachments_json) WHERE json_extract(value, '$.filename') LIKE ${literalLike(c.filename)} ESCAPE '\\')`,
        );
      if (c.dateBefore !== undefined) where.push(sql`m.date < ${c.dateBefore}`);
      if (c.dateAfter !== undefined) where.push(sql`m.date >= ${c.dateAfter}`);
      for (const label of c.labels ?? [])
        where.push(
          sql`EXISTS (SELECT 1 FROM json_each(m.labels_json) j WHERE j.value=${label} OR j.value IN (SELECT id FROM labels WHERE account_id=m.account_id AND name=${label}))`,
        );
      return sql.and(where);
    };

    type ExpressionContext = {
      messagesReady: boolean;
      derivedReady: boolean;
      media: boolean;
      attachmentOnly: boolean;
      rowBound: boolean;
    };
    const expressionFilter = (node: SearchExpression, context: ExpressionContext): Fragment => {
      switch (node.kind) {
        case "and": {
          const scoped =
            context.attachmentOnly ||
            node.children.some(
              (child) =>
                child.kind === "term" &&
                parseSearchQuery({ search: child.value }).criteria?.attachmentText === true,
            );
          return sql`(${sql.and(node.children.map((child) => expressionFilter(child, { ...context, attachmentOnly: scoped })))})`;
        }
        case "or":
          return sql`(${sql.or(node.children.map((child) => expressionFilter(child, context)))})`;
        case "not":
          return expressionHasSize(node.child)
            ? sql`(m.message_size IS NULL OR NOT (${expressionFilter(node.child, context)}))`
            : sql`NOT (${expressionFilter(node.child, context)})`;
        case "term": {
          const q = parseSearchQuery({ search: node.value });
          const conditions = [
            searchConditionFilter(q.criteria ?? {}, context.messagesReady, context.rowBound),
          ];
          if (q.criteria?.proximity) {
            const body = conditions.pop() ?? sql.literal("1");
            const derived = sql`EXISTS (SELECT 1 FROM derived_chunks d WHERE d.message_id=m.id AND ${proximityFilter(q.criteria.proximity, true, context.derivedReady)})`;
            conditions.push(
              context.attachmentOnly
                ? derived
                : context.media
                  ? sql`(${body} OR ${derived})`
                  : body,
            );
          }
          if (q.unreadOnly) conditions.push(sql`m.is_unread=1`);
          if (q.starredOnly) conditions.push(sql`m.is_starred=1`);
          if (q.search) {
            const body = textFilter(
              q.search,
              false,
              context.messagesReady,
              false,
              context.rowBound,
            );
            const derived = sql`EXISTS(SELECT 1 FROM derived_chunks d WHERE d.message_id=m.id AND ${textFilter(q.search, true, context.derivedReady, false, context.rowBound)})`;
            conditions.push(
              context.attachmentOnly
                ? derived
                : context.media
                  ? sql`(${body} OR ${derived})`
                  : body,
            );
          }
          return sql`(${sql.and(conditions)})`;
        }
        default: {
          const exhaustive: never = node;
          return exhaustive;
        }
      }
    };

    /** WHERE clauses of a thread list. Paging (`before`) is applied after collapsing threads. */
    const listFilter = (q: LocalQuery) => {
      const where: Fragment[] = [sql`m.account_id IN (SELECT id FROM accounts WHERE enabled=1)`];
      const mailbox =
        q.search !== undefined && q.searchScope !== "folder" ? "all" : (q.mailbox ?? "inbox");
      if (mailbox === "all") {
        if (q.messageIds === undefined && !searchIncludesSpecialFolders(q))
          where.push(sql`NOT ${hasLabel("SPAM")}`, sql`NOT ${hasLabel("TRASH")}`);
      } else where.push(hasLabel(MAILBOX_LABEL[mailbox]));
      if (mailbox === "inbox")
        where.push(
          sql`NOT EXISTS (SELECT 1 FROM thread_reminders r WHERE r.account_id=m.account_id AND r.thread_id=m.thread_id AND r.due_at IS NOT NULL)`,
        );
      if (q.label !== undefined && (q.search === undefined || q.searchScope === "folder"))
        where.push(hasLabel(q.label));
      if (q.accountIds) where.push(inAccounts(q.accountIds));
      if (q.messageIds)
        where.push(sql`m.id IN (SELECT value FROM json_each(${JSON.stringify(q.messageIds)}))`);
      if (q.unreadOnly) where.push(sql`m.is_unread = 1`);
      if (q.starredOnly) where.push(sql`m.is_starred = 1`);
      const filters = q.listFilters;
      if (filters?.enabled) {
        const flags: Fragment[] = [];
        if (filters.unread) flags.push(sql`m.is_unread = 1`);
        if (filters.starred) flags.push(sql`m.is_starred = 1`);
        if (filters.important) flags.push(hasLabel("IMPORTANT"));
        if (flags.length) where.push(sql`(${sql.or(flags)})`);
        if (filters.inInbox) where.push(hasLabel("INBOX"));
      }
      where.push(
        searchConditionFilter(q.criteria ?? {}, q.wordIndexReady ?? false, q.rowBoundText),
      );
      for (const condition of q.criteria?.excluded ?? [])
        where.push(
          condition.sizeLarger !== undefined || condition.sizeSmaller !== undefined
            ? sql`(m.message_size IS NULL OR NOT (${searchConditionFilter(condition, q.wordIndexReady ?? false, q.rowBoundText)}))`
            : sql`NOT (${searchConditionFilter(condition, q.wordIndexReady ?? false, q.rowBoundText)})`,
        );
      where.push(
        expressionFilter(parseSearchExpression(q.search ?? ""), {
          messagesReady: q.wordIndexReady ?? false,
          derivedReady: q.derivedWordIndexReady ?? false,
          media: expressionMedia(q.search ?? ""),
          attachmentOnly: q.criteria?.attachmentText ?? false,
          rowBound: q.rowBoundText ?? false,
        }),
      );
      return sql.and(where);
    };

    const countThreads = Effect.fn("Store.countThreads")(function* (raw: ThreadQuery) {
      const invalid = searchQueryError(raw);
      if (invalid) return yield* invalid;
      const readiness = yield* wordIndex.wordIndexReady;
      const query = yield* planTextPage({
        ...(raw.search === undefined ? raw : parseSearchQuery(raw)),
        wordIndexReady: readiness.messages,
        derivedWordIndexReady: readiness.derived,
      });
      if (
        query.textPage &&
        query.searchScope !== "folder" &&
        !query.messageIds &&
        !query.unreadOnly &&
        !query.starredOnly &&
        !query.listFilters?.enabled
      ) {
        const table = sql.literal(query.textPage.index);
        const filter = sql.and([
          sql`s.eligible=1`,
          sql`s.row_id IN (SELECT rowid FROM ${table} WHERE ${table} MATCH ${query.textPage.match})`,
        ]);
        const scope = sql.and([
          sql`a.enabled=1`,
          query.accountIds === undefined
            ? sql.literal("1")
            : query.accountIds.length
              ? sql`a.id IN ${sql.in(query.accountIds)}`
              : sql.literal("0"),
        ]);
        return yield* all(Schema.Struct({ n: Schema.Number }))(
          sql`SELECT COALESCE(SUM((SELECT COUNT(*) FROM (
            SELECT ${query.flat ? sql.literal("s.row_id") : sql.literal("s.thread_id")} FROM message_search_meta s INDEXED BY message_search_meta_threads
            WHERE s.account_id=a.id AND ${filter} ${query.flat ? sql.literal("") : sql.literal("GROUP BY s.thread_id")}
          ))),0) AS n FROM accounts a WHERE ${scope}`,
        ).pipe(Effect.map((rows) => rows[0]?.n ?? 0));
      }
      return yield* all(Schema.Struct({ n: Schema.Number }))(
        query.flat
          ? sql`SELECT COUNT(*) AS n FROM messages m WHERE ${listFilter(query)}`
          : sql`SELECT COUNT(*) AS n FROM (SELECT m.account_id,m.thread_id FROM messages m WHERE ${listFilter(query)} GROUP BY m.account_id,m.thread_id)`,
      ).pipe(Effect.map((rows) => rows[0]?.n ?? 0));
    });

    // Stream the date/id index and resolve only selected conversations. The
    // CTE is inlined, so a 100k-thread inbox does not rank 100k rows per page.
    const listSource = (q: LocalQuery) =>
      // Across accounts SQLite otherwise sorts the entire inbox using the
      // account/date index. Walk the global date index and stop at the limit.
      // Search keeps the planner free to start from its selective FTS rowids.
      q.textPage && q.messageIds === undefined && q.accountIds?.length === 1
        ? sql.literal("messages m INDEXED BY messages_account_list_date_id")
        : (q.textPage || q.search === undefined) &&
            q.messageIds === undefined &&
            q.accountIds?.length !== 1
          ? sql.literal("messages m INDEXED BY messages_list_date_id")
          : sql.literal("messages m");
    const threadList = Effect.fn("Store.threadList")(function* (q: LocalQuery, limit: number) {
      const materialize = !!q.criteria?.proximity || /\bAROUND\s+\d+\b/.test(q.search ?? "");
      // Proximity positions are computed once; only compact matching metadata is materialized.
      const grouped = sql`
        WITH matches AS MATERIALIZED (
          SELECT m.id,m.account_id,m.thread_id,m.list_date AS date,m.is_unread,m.is_starred
          FROM messages m INDEXED BY messages_list_date_id WHERE ${listFilter({ ...q, rowBoundText: false })}
        ), heads AS (
          SELECT account_id,thread_id,MAX(date) AS date,MAX(is_unread) AS any_unread,MAX(is_starred) AS any_starred
          FROM matches GROUP BY account_id,thread_id
        ), resolved AS (
          SELECT h.*,(SELECT MAX(c.id) FROM matches c WHERE c.account_id=h.account_id AND c.thread_id=h.thread_id AND c.date=h.date) AS id FROM heads h
        ), page AS (
          SELECT * FROM resolved c WHERE ${q.before === undefined ? sql.literal("1") : sql`(c.date < ${q.before} ${q.beforeId === undefined ? sql.literal("") : sql`OR (c.date = ${q.before} AND c.id < ${q.beforeId})`})`}
          ORDER BY c.date DESC,c.id DESC LIMIT ${limit}
        )
        SELECT ${sql.literal(SUMMARY_COLUMNS)},c.any_unread,c.any_starred,
          (SELECT COUNT(*) FROM messages t WHERE t.account_id=c.account_id AND t.thread_id=c.thread_id) AS thread_count,
          (SELECT json_group_array(json_object('name',p.from_name,'address',p.from_addr))
            FROM (SELECT from_name,from_addr,MIN(date) AS first FROM messages t
              WHERE t.account_id=c.account_id AND t.thread_id=c.thread_id GROUP BY from_addr ORDER BY first) p) AS participants_json
        FROM page c JOIN messages m ON m.id=c.id ORDER BY c.date DESC,c.id DESC`;
      const rows = yield* all(ThreadRow)(
        materialize
          ? grouped
          : sql`
        WITH candidates AS NOT MATERIALIZED (SELECT ${sql.literal(SUMMARY_COLUMNS)} FROM messages m WHERE ${listFilter({ ...q, rowBoundText: false })}),
        page AS (
          SELECT ${sql.literal(SUMMARY_COLUMNS)} FROM ${listSource(q)}
          WHERE NOT EXISTS (SELECT 1 FROM candidates n WHERE n.account_id=m.account_id AND n.thread_id=m.thread_id
              AND n.date>=m.list_date AND (n.date > m.list_date OR (n.date=m.list_date AND n.id>m.id)))
            AND ${listFilter(q)}
            AND ${q.before === undefined ? sql.literal("1") : sql`(m.list_date < ${q.before} ${q.beforeId === undefined ? sql.literal("") : sql`OR (m.list_date = ${q.before} AND m.id < ${q.beforeId})`})`}
          ORDER BY m.list_date DESC,m.id DESC LIMIT ${limit}
        )
        SELECT c.*,
          (SELECT MAX(v.is_unread) FROM candidates v WHERE v.account_id=c.account_id AND v.thread_id=c.thread_id) AS any_unread,
          (SELECT MAX(v.is_starred) FROM candidates v WHERE v.account_id=c.account_id AND v.thread_id=c.thread_id) AS any_starred,
          (SELECT COUNT(*) FROM messages t WHERE t.account_id=c.account_id AND t.thread_id=c.thread_id) AS thread_count,
          (SELECT json_group_array(json_object('name',p.from_name,'address',p.from_addr))
            FROM (SELECT from_name,from_addr,MIN(date) AS first FROM messages t
              WHERE t.account_id=c.account_id AND t.thread_id=c.thread_id GROUP BY from_addr ORDER BY first) p) AS participants_json
        FROM page c ORDER BY c.date DESC,c.id DESC`,
      );
      return rows.map((r): ThreadSummary => ({
        ...toSummary(r),
        ...(r.attachments_json.length
          ? {
              attachmentNames: r.attachments_json
                .slice(0, 2)
                .map((a) => attachmentFilename(a.filename)),
            }
          : {}),
        isUnread: r.any_unread,
        isStarred: r.any_starred,
        threadCount: r.thread_count,
        participants: r.participants_json,
      }));
    });

    /** Conversation grouping off: each message in the view is its own row, newest first. */
    const messageList = (q: LocalQuery, limit: number) =>
      all(SummaryRow)(sql`SELECT ${sql.literal(SUMMARY_COLUMNS)} FROM ${listSource(q)}
        WHERE ${listFilter(q)} ${q.before === undefined ? sql.literal("") : sql`AND (${sql.literal(EFFECTIVE_DATE)} < ${q.before} ${q.beforeId === undefined ? sql.literal("") : sql`OR (${sql.literal(EFFECTIVE_DATE)} = ${q.before} AND m.id < ${q.beforeId})`})`}
        ORDER BY date DESC, m.id DESC LIMIT ${limit}`).pipe(
        Effect.map((rows) =>
          rows.map((r): ThreadSummary => {
            const summary = toSummary(r);
            return {
              ...summary,
              ...(r.attachments_json.length
                ? {
                    attachmentNames: r.attachments_json
                      .slice(0, 2)
                      .map((a) => attachmentFilename(a.filename)),
                  }
                : {}),
              threadCount: 1,
              participants: [summary.from],
            };
          }),
        ),
      );

    const planTextPage = Effect.fnUntraced(function* (q: LocalQuery) {
      const words = searchWords(q.search ?? "");
      if (
        words.length !== 1 ||
        expressionMedia(q.search ?? "") ||
        hasSearchExpression(q.search ?? "") ||
        Object.keys(q.criteria ?? {}).length ||
        q.messageIds ||
        (q.label && q.searchScope === "folder")
      )
        return q;
      const word = words[0];
      if (!word || word.startsWith("-")) return q;
      const text = unquoteSearchValue(word.endsWith("*") ? word.slice(0, -1) : word);
      const ready = q.wordIndexReady && !usesSubstringSearch(text);
      if (!ready && Array.from(text).length < 3) return q;
      const match = ftsSearchTerm(ready ? word : quoteSearchValue(text));
      if (!match) return q;
      const table = sql.literal(ready ? "messages_words" : "messages_fts");
      const rows = yield* all(Schema.Struct({ n: Schema.Number }))(sql`SELECT COUNT(*) AS n FROM (
        SELECT rowid FROM ${table} WHERE ${table} MATCH ${match} LIMIT 2049)`);
      // A bounded probe distinguishes rare terms from common ones. Common
      // terms walk the date index, probing FTS by rowid only for recent rows.
      return (rows[0]?.n ?? 0) > 2048
        ? ({
            ...q,
            textPage: { index: ready ? "messages_words" : "messages_fts", match },
            rowBoundText: true,
          } satisfies LocalQuery)
        : q;
    });
    const listThreads = Effect.fn("Store.listThreads")(function* (raw: ThreadQuery) {
      const invalid = searchQueryError(raw);
      if (invalid) return yield* invalid;
      if (raw.search !== undefined && !raw.search.trim()) return [];
      const readiness = yield* wordIndex.wordIndexReady;
      const q = yield* planTextPage({
        ...(raw.search === undefined ? raw : parseSearchQuery(raw)),
        wordIndexReady: readiness.messages,
        derivedWordIndexReady: readiness.derived,
      });
      const mediaExpression = expressionMedia(q.search ?? "");
      const limit = mediaExpression ? Math.min(q.limit ?? 50, 1024) : (q.limit ?? 50);
      const listing = q.flat ? messageList : threadList;
      const terms = searchWords(q.search ?? "").map(unquoteSearchValue);
      let threads =
        q.criteria?.attachmentText && terms.length && !mediaExpression
          ? []
          : yield* listing(q, limit);
      if (
        terms.length &&
        !hasSearchExpression(q.search ?? "") &&
        !searchWords(q.search ?? "").some((term) => term.startsWith("-"))
      ) {
        const predicates = searchWords(q.search ?? "").map((term) =>
          textFilter(term, true, readiness.derived),
        );
        const long = searchWords(q.search ?? "")
          .map(ftsSearchTerm)
          .filter((term) => term !== null);
        const ranking =
          readiness.derived && !usesSubstringSearch(q.search ?? "")
            ? sql`(SELECT rank FROM derived_words WHERE rowid=d.id AND derived_words MATCH ${long.join(" AND ")})`
            : sql.literal("m.date DESC");
        const { attachmentText: _scope, ...criteria } = q.criteria ?? {};
        const matches = yield* all(
          Schema.Struct({
            account_id: Schema.String,
            thread_id: Schema.String,
            provenance_json: Schema.fromJsonString(DerivedChunk),
          }),
        )(
          sql`SELECT m.account_id,m.thread_id,d.provenance_json FROM derived_chunks d JOIN messages m ON m.id=d.message_id
          WHERE ${listFilter({ ...q, search: "", criteria })} AND ${sql.and(predicates)}
          ${q.before === undefined ? sql.literal("") : sql`AND m.date < ${q.before}`}
          ORDER BY ${long.length ? ranking : sql.literal("m.date DESC")},d.id LIMIT ${Math.min(Math.max(limit * 20, 200), 4096)}`,
        );
        const chunks = matches.map((row) => row.provenance_json);
        const ids = [...new Set(chunks.map((chunk) => chunk.messageId))].slice(0, 1024);
        const candidates = ids.length
          ? yield* listing({ ...q, search: "", criteria, messageIds: ids }, ids.length)
          : [];
        const grouped = new Map<string, DerivedChunk[]>();
        const ranks = new Map<string, number>();
        for (const [rank, match] of matches.entries()) {
          const key = q.flat
            ? match.provenance_json.messageId
            : `${match.account_id}/${match.thread_id}`;
          const group = grouped.get(key) ?? [];
          if (group.length < 20) group.push(match.provenance_json);
          grouped.set(key, group);
          if (!ranks.has(key)) ranks.set(key, rank);
        }
        const keyOf = (thread: ThreadSummary) =>
          q.flat ? thread.id : `${thread.accountId}/${thread.threadId}`;
        const derived = candidates
          .map((thread) => ({ ...thread, derivedMatches: grouped.get(keyOf(thread)) ?? [] }))
          .toSorted(
            (a, b) => (ranks.get(keyOf(a)) ?? Infinity) - (ranks.get(keyOf(b)) ?? Infinity),
          );
        threads = reciprocalRankFusion(threads, derived, q.flat).slice(0, limit);
      }
      // The Drafts list also shows drafts the provider has no copy of yet.
      const filters = q.listFilters;
      const filtered =
        filters?.enabled &&
        (filters.unread || filters.starred || filters.important || filters.inInbox);
      const plain = q.label === undefined && !q.unreadOnly && !q.starredOnly && !filtered;
      if (q.mailbox !== "drafts" || !plain) return threads;
      const local = yield* compose.localDrafts(q, limit);
      return [...threads, ...local]
        .toSorted((a, b) => b.date - a.date || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        .slice(0, limit);
    });

    const vectorThreads = Effect.fn("Store.vectorThreads")(function* (
      raw: ThreadQuery,
      hits: readonly DerivedChunk[],
    ) {
      const invalid = searchQueryError(raw);
      if (invalid) return yield* invalid;
      const parsed = parseSearchQuery(raw);
      const { attachmentText: _scope, ...criteria } = parsed.criteria ?? {};
      const q = { ...parsed, criteria };
      const sourceHits = hits.filter(
        (hit) => !parsed.criteria?.attachmentText || hit.source.kind !== "body",
      );
      const ids = [...new Set(sourceHits.map((hit) => hit.messageId))].slice(0, 200);
      if (!ids.length) return [];
      const candidates = yield* (q.flat ? messageList : threadList)(
        { ...q, search: "", messageIds: ids },
        ids.length,
      );
      const keys = yield* all(
        Schema.Struct({ id: Schema.String, account_id: Schema.String, thread_id: Schema.String }),
      )(
        sql`SELECT id,account_id,thread_id FROM messages WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
      );
      const matched = new Map<string, DerivedChunk[]>();
      const ranks = new Map<string, number>();
      for (const [rank, hit] of sourceHits.entries()) {
        const message = keys.find((key) => key.id === hit.messageId);
        if (!message) continue;
        const key = q.flat ? hit.messageId : `${message.account_id}/${message.thread_id}`;
        const group = matched.get(key) ?? [];
        if (group.length < 20) group.push(hit);
        matched.set(key, group);
        if (!ranks.has(key)) ranks.set(key, rank);
      }
      const keyOf = (thread: ThreadSummary) =>
        q.flat ? thread.id : `${thread.accountId}/${thread.threadId}`;
      return candidates
        .map((thread) => ({ ...thread, derivedMatches: matched.get(keyOf(thread)) ?? [] }))
        .toSorted((a, b) => (ranks.get(keyOf(a)) ?? Infinity) - (ranks.get(keyOf(b)) ?? Infinity));
    });

    const getMessage = Effect.fn("Store.getMessage")(function* (
      id: string,
    ): Effect.fn.Return<Message, NotFound> {
      const row = yield* first(MessageRow)(
        sql`SELECT ${sql.literal(MESSAGE_COLUMNS)} FROM messages m WHERE m.id = ${id}`,
      );
      if (Option.isNone(row)) return yield* new NotFound({ what: "message", id });
      return toMessage(row.value);
    });

    const getThread = Effect.fn("Store.getThread")(function* (
      id: string,
    ): Effect.fn.Return<Message[], NotFound> {
      const key = yield* first(ThreadKey)(
        sql`SELECT account_id, thread_id FROM messages WHERE id = ${id}`,
      );
      if (Option.isNone(key)) return yield* new NotFound({ what: "message", id });
      const rows = yield* all(MessageRow)(sql`SELECT ${sql.literal(MESSAGE_COLUMNS)} FROM messages m
        WHERE account_id = ${key.value.account_id} AND thread_id = ${key.value.thread_id}
        ORDER BY date`);
      return rows.map(toMessage);
    });

    const messageRef = Effect.fn("Store.messageRef")(function* (id: string) {
      const row = yield* first(Ref)(
        sql`SELECT account_id, provider_id FROM messages WHERE id = ${id}`,
      );
      if (Option.isNone(row)) return yield* new NotFound({ what: "message", id });
      return { accountId: row.value.account_id, providerId: row.value.provider_id };
    });

    const threadMessageIds = Effect.fn("Store.threadMessageIds")(function* (id: string) {
      const rows = yield* all(MessageId)(sql`SELECT t.id FROM messages t
        JOIN messages m ON t.account_id = m.account_id AND t.thread_id = m.thread_id
        WHERE m.id = ${id} ORDER BY t.date`);
      return rows.map((r) => r.id);
    });

    const messageLabels = Effect.fn("Store.messageLabels")(function* (
      account: string,
      providerId: string,
    ) {
      const row = yield* first(Labels)(sql`SELECT labels_json FROM messages
        WHERE account_id = ${account} AND provider_id = ${providerId}`);
      return Option.match(row, { onNone: () => [], onSome: (r) => [...r.labels_json] });
    });

    /**
     * Sets the read and starred state a provider reported without refetching
     * the message. Unknown messages are ignored: their next Upsert brings them.
     */
    const setFlags = Effect.fn("Store.setFlags")(function* (
      account: string,
      providerId: string,
      flags: { isUnread: boolean; isStarred: boolean },
    ) {
      const labels = new Set(yield* messageLabels(account, providerId));
      const wake = yield* first(Reminder)(
        sql`SELECT r.due_at, r.woken_at, s.wake_pending FROM thread_reminders r JOIN snoozed_messages s ON s.account_id=r.account_id AND s.thread_id=r.thread_id WHERE s.account_id=${account} AND s.provider_id=${providerId}`,
      );
      const isUnread = flags.isUnread || (Option.isSome(wake) && wake.value.wake_pending);
      if (isUnread) labels.add("UNREAD");
      else labels.delete("UNREAD");
      if (flags.isStarred) labels.add("STARRED");
      else labels.delete("STARRED");
      yield* run(sql`UPDATE messages SET labels_json = ${JSON.stringify([...labels])},
          is_unread = ${isUnread ? 1 : 0}, is_starred = ${flags.isStarred ? 1 : 0}
        WHERE account_id=${account} AND provider_id=${providerId}`);
    });

    /**
     * Applies an op to the local copy so the UI updates before the provider
     * answers. Pulls replay queued changes until the provider accepts them.
     */
    const applyLocalOp = Effect.fn("Store.applyLocalOp")(function* (id: string, op: MailOp) {
      const row = yield* first(LabelsAndProvider)(sql`SELECT m.labels_json, a.provider
        FROM messages m JOIN accounts a ON a.id = m.account_id WHERE m.id = ${id}`);
      if (Option.isNone(row)) return;
      if (op.kind === "read" && op.value)
        yield* run(
          sql`UPDATE snoozed_messages SET wake_pending=0 WHERE (account_id, provider_id) IN (SELECT account_id, provider_id FROM messages WHERE id=${id})`,
        );
      if (
        ["inbox", "archive", "trash", "spam", "move"].includes(op.kind) ||
        (op.kind === "label" && op.value && row.value.provider !== "gmail")
      )
        yield* run(
          sql`UPDATE thread_reminders SET due_at=NULL, wake_pending=CASE WHEN ${op.kind} = 'inbox' THEN wake_pending ELSE 0 END WHERE (account_id, thread_id) IN (SELECT account_id, thread_id FROM messages WHERE id=${id})`,
        );
      if (
        ["archive", "trash", "spam", "move"].includes(op.kind) ||
        (op.kind === "label" && op.value && row.value.provider !== "gmail")
      )
        yield* run(
          sql`DELETE FROM snoozed_messages WHERE (account_id, provider_id) IN (SELECT account_id, provider_id FROM messages WHERE id=${id})`,
        );
      const labels = applyOpToLabels(row.value.labels_json, op, row.value.provider);
      yield* run(sql`UPDATE messages SET labels_json = ${JSON.stringify(labels)},
        is_unread = ${labels.includes("UNREAD") ? 1 : 0},
        is_starred = ${labels.includes("STARRED") ? 1 : 0}
        WHERE id = ${id}`);
    });

    /** Sidebar/account badge units follow the conversation preference. */
    const unreadCounts = Effect.gen(function* () {
      const prefs = yield* compose.prefs;
      const rows = yield* all(
        Count,
      )(sql`SELECT account_id AS key, ${prefs.threadGrouping ? sql`COUNT(DISTINCT thread_id)` : sql`COUNT(*)`} AS n FROM messages m
        WHERE m.account_id IN (SELECT id FROM accounts WHERE enabled=1) AND is_unread=1 AND ${hasLabel("INBOX")} AND NOT EXISTS (SELECT 1 FROM thread_reminders r WHERE r.account_id=m.account_id AND r.thread_id=m.thread_id AND r.due_at IS NOT NULL) GROUP BY account_id`);
      return counts(rows);
    }).pipe(Effect.withSpan("Store.unreadCounts"));

    /**
     * Unread messages per label id, across the given accounts (all when omitted).
     * Keys are system labels (INBOX, SPAM, CATEGORY_*) and user label ids alike.
     * `within` counts only messages that also carry that label, e.g. INBOX for
     * category badges.
     */
    const unreadByLabel = Effect.fn("Store.unreadByLabel")(function* (
      accountIds?: readonly string[],
      within?: string,
      conversations = false,
    ) {
      const where: Fragment[] = [sql`b.account_id IN (SELECT id FROM accounts WHERE enabled=1)`];
      if (accountIds)
        where.push(
          accountIds.length ? sql`b.account_id IN ${sql.in(accountIds)}` : sql.literal("0"),
        );
      if (within === "INBOX") where.push(sql`b.in_inbox=1`);
      else if (within !== undefined)
        where.push(
          sql`EXISTS (SELECT 1 FROM messages m WHERE m.id=b.message_id AND ${hasLabel(within)})`,
        );
      where.push(
        sql`(b.label != 'INBOX' OR NOT EXISTS(SELECT 1 FROM thread_reminders r WHERE r.account_id=b.account_id AND r.thread_id=b.thread_id AND r.due_at IS NOT NULL))`,
      );
      const rows = yield* all(Count)(
        conversations
          ? sql`SELECT key,SUM(n) AS n FROM (
            SELECT b.label AS key,b.account_id,COUNT(DISTINCT b.thread_id) AS n
            FROM message_badges b
            WHERE ${sql.and(where)} GROUP BY b.label,b.account_id
          ) GROUP BY key`
          : sql`SELECT b.label AS key,COUNT(*) AS n
            FROM message_badges b
            WHERE ${sql.and(where)} GROUP BY b.label`,
      );
      const result = counts(rows);
      if (within === undefined || within === "DRAFT") {
        const local = yield* compose.countLocalDrafts(accountIds);
        if (local) result["DRAFT"] = (result["DRAFT"] ?? 0) + local;
      }
      return result;
    });

    // Labels

    /** Replaces an account's label list with what the provider reports now. */
    const replaceLabels = Effect.fn("Store.replaceLabels")(
      (account: string, labels: readonly Omit<Label, "accountId">[]) =>
        Effect.orDie(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM labels WHERE account_id = ${account}`;
              for (const l of labels) {
                yield* sql`INSERT INTO labels (account_id, id, name, color, label_list_visibility, message_list_visibility)
                  VALUES (${account}, ${l.id}, ${l.name}, ${l.color}, ${l.labelListVisibility ?? null}, ${l.messageListVisibility ?? null})`;
              }
            }),
          ),
        ),
    );

    const listLabels = Effect.fn("Store.listLabels")(function* (accountIds?: readonly string[]) {
      const rows = yield* all(
        LabelRow,
      )(sql`SELECT account_id, id, name, color, label_list_visibility, message_list_visibility FROM labels m
        WHERE m.account_id IN (SELECT id FROM accounts WHERE enabled=1) AND ${accountIds ? inAccounts(accountIds) : sql.literal("1")}
        ORDER BY account_id, name`);
      const categories = yield* all(
        Schema.Struct({
          accountId: Schema.String,
          id: Schema.String,
          name: Schema.String,
          color: Schema.NullOr(Schema.String),
        }),
      )(sql`
        SELECT DISTINCT m.account_id AS accountId, j.value AS id, substr(j.value,10) AS name, NULL AS color
        FROM messages m JOIN accounts a ON a.id=m.account_id, json_each(m.labels_json) j
        WHERE a.enabled=1 AND a.provider='outlook' AND j.value LIKE 'category:%' AND ${accountIds ? inAccounts(accountIds) : sql.literal("1")}`);
      return [
        ...new Map(
          categories.map((category) => [
            `${category.accountId}/${categoryKey(category.id.slice(9))}`,
            category,
          ]),
        ).values(),
        ...rows.map((r) => ({
          accountId: r.account_id,
          id: r.id,
          name: r.name,
          color: r.color,
          ...(r.label_list_visibility ? { labelListVisibility: r.label_list_visibility } : {}),
          ...(r.message_list_visibility
            ? { messageListVisibility: r.message_list_visibility }
            : {}),
        })),
      ];
    });

    // Profiles

    const listProfiles = all(Profile)(
      sql`SELECT id, name, icon, color, position FROM profiles ORDER BY position, name`,
    ).pipe(
      Effect.map((rows) => [...rows]),
      Effect.withSpan("Store.listProfiles"),
    );

    const createProfile = Effect.fn("Store.createProfile")(function* (input: ProfileInput) {
      const id = crypto.randomUUID();
      const next = yield* first(Next)(
        sql`SELECT COALESCE(MAX(position), -1) + 1 AS next FROM profiles`,
      );
      const position = Option.match(next, { onNone: () => 0, onSome: (r) => r.next });
      yield* run(sql`INSERT INTO profiles (id, name, icon, color, position)
        VALUES (${id}, ${input.name}, ${input.icon}, ${input.color}, ${position})`);
      return { id, name: input.name, icon: input.icon, color: input.color, position };
    });

    const updateProfile = Effect.fn("Store.updateProfile")((id: string, input: ProfileInput) =>
      run(sql`UPDATE profiles SET name = ${input.name}, icon = ${input.icon},
        color = ${input.color} WHERE id = ${id}`),
    );

    /** Deletes the profile. Its accounts stay and become ungrouped (ON DELETE SET NULL). */
    const deleteProfile = Effect.fn("Store.deleteProfile")((id: string) =>
      run(sql`DELETE FROM profiles WHERE id = ${id}`),
    );

    // Outgoing change queue

    const enqueueOp = Effect.fn("Store.enqueueOp")(function* (
      account: string,
      providerId: string,
      op: QueuedOp,
    ) {
      const now = yield* Clock.currentTimeMillis;
      yield* run(sql`INSERT INTO pending_ops (account_id, provider_id, op_json, created_at, rfc_message_id)
        VALUES (${account}, ${providerId}, ${JSON.stringify(op)}, ${now}, (SELECT rfc_message_id FROM messages WHERE account_id=${account} AND provider_id=${providerId} ORDER BY date DESC LIMIT 1))`);
    });

    const toPendingOps = (rows: readonly (typeof PendingOpRow.Type)[]) =>
      rows.map((r): PendingOp => ({
        id: r.id,
        accountId: r.account_id,
        providerId: r.provider_id,
        op: r.op_json,
        attempts: r.attempts,
        lastError: r.last_error,
        createdAt: r.created_at,
        retryAt: r.retry_at,
        rfcMessageId: r.rfc_message_id,
        progress: r.progress_json,
        appendedMessageId: r.appended_message_id,
      }));
    const listPendingOps = all(PendingOpRow)(
      sql`SELECT id, account_id, provider_id, op_json, attempts, last_error, created_at, retry_at, rfc_message_id, progress_json, appended_message_id
        FROM pending_ops ORDER BY id`,
    ).pipe(Effect.map(toPendingOps), Effect.withSpan("Store.listPendingOps"));
    const pendingOpsForMessages: Store["Service"]["pendingOpsForMessages"] = (
      ownerId,
      providerIds,
    ) =>
      providerIds.length === 0
        ? Effect.succeed([])
        : all(PendingOpRow)(
            sql`SELECT id, account_id, provider_id, op_json, attempts, last_error, created_at, retry_at, rfc_message_id, progress_json, appended_message_id
          FROM pending_ops WHERE account_id=${ownerId} AND provider_id IN ${sql.in(providerIds)} ORDER BY id`,
          ).pipe(Effect.map(toPendingOps), Effect.withSpan("Store.pendingOpsForMessages"));

    const claimPendingOp = Effect.fn("Store.claimPendingOp")(function* (
      id: number,
      token = crypto.randomUUID(),
    ) {
      const now = yield* Clock.currentTimeMillis;
      const row = yield* first(
        Id,
      )(sql`UPDATE pending_ops SET claimed_at=${now}, claim_token=${token}
        WHERE id=${id} AND retry_at <= ${now} AND (claimed_at IS NULL OR claimed_at < ${now - CLAIM_TTL}) RETURNING id`);
      return Option.isSome(row);
    });
    const ownsPendingOp = (id: number, token: string) =>
      first(Id)(sql`SELECT id FROM pending_ops WHERE id=${id} AND claim_token=${token}`).pipe(
        Effect.map(Option.isSome),
      );
    const renewPendingOp = Effect.fn("Store.renewPendingOp")(function* (id: number, token: string) {
      const now = yield* Clock.currentTimeMillis;
      return Option.isSome(
        yield* first(Id)(
          sql`UPDATE pending_ops SET claimed_at=${now} WHERE id=${id} AND claim_token=${token} RETURNING id`,
        ),
      );
    });
    const claimCondition = (token?: string) =>
      token === undefined ? sql.literal("AND claim_token IS NULL") : sql`AND claim_token=${token}`;
    const removePendingOp = Effect.fn("Store.removePendingOp")((id: number, token?: string) =>
      run(sql`DELETE FROM pending_ops WHERE id=${id} ${claimCondition(token)}`),
    );
    const releasePendingOp = Effect.fn("Store.releasePendingOp")((id: number, token?: string) =>
      run(
        sql`UPDATE pending_ops SET claimed_at=NULL, claim_token=NULL WHERE id=${id} ${claimCondition(token)}`,
      ),
    );
    const failPendingOp = Effect.fn("Store.failPendingOp")(function* (
      id: number,
      error: string,
      token?: string,
    ) {
      const now = yield* Clock.currentTimeMillis;
      yield* run(
        sql`UPDATE pending_ops SET retry_at=${now} + MIN(3600000, 5000 * (1 << MIN(attempts, 10))), attempts=attempts+1, last_error=${error}, claimed_at=NULL, claim_token=NULL WHERE id=${id} ${claimCondition(token)}`,
      );
    });
    const recordCopyProgress: Store["Service"]["recordCopyProgress"] = (
      id,
      token,
      destination,
      providerId,
      phase,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const row = yield* first(
              Schema.Struct({ progress_json: Schema.fromJsonString(Schema.Array(Schema.String)) }),
            )(sql`SELECT progress_json FROM pending_ops WHERE id=${id} AND claim_token=${token}`);
            const saved = yield* Option.match(row, {
              onNone: () =>
                Effect.fail(
                  new ProviderError({
                    message: "The queued operation is no longer owned by this worker",
                  }),
                ),
              onSome: (current) => Effect.succeed(current.progress_json),
            });
            const issued = JSON.stringify([providerId, destination]);
            const accepted = JSON.stringify([providerId, destination, "accepted"]);
            const progress = new Set(saved);
            if (phase === "clear") {
              progress.delete(issued);
              progress.delete(accepted);
            } else {
              progress.add(issued);
              if (phase === "accepted") progress.add(accepted);
            }
            yield* run(
              sql`UPDATE pending_ops SET progress_json=${JSON.stringify([...progress])} WHERE id=${id} AND claim_token=${token}`,
            );
          }),
        )
        .pipe(Effect.catchCause(progressFailure));
    const recordAppendedMessageId: Store["Service"]["recordAppendedMessageId"] = (
      id,
      token,
      messageId,
    ) =>
      first(Id)(
        sql`UPDATE pending_ops SET appended_message_id=${messageId} WHERE id=${id} AND claim_token=${token} RETURNING id`,
      ).pipe(
        Effect.flatMap((row) =>
          Option.isSome(row)
            ? Effect.void
            : Effect.fail(
                new ProviderError({
                  message: "The queued draft is no longer owned by this worker",
                }),
              ),
        ),
        Effect.catchCause(progressFailure),
      );
    const recordFailedOp: Store["Service"]["recordFailedOp"] = Effect.fn("Store.recordFailedOp")(
      function* (entry) {
        const now = yield* Clock.currentTimeMillis;
        yield* run(sql`INSERT INTO failed_ops(account_id,provider_id,at,kind,reason,subject,sender,rejected_json)
        VALUES (${entry.accountId},${entry.providerId},${now},${entry.kind},${entry.reason},
          COALESCE(${entry.subject ?? null},(SELECT subject FROM messages WHERE account_id=${entry.accountId} AND provider_id=${entry.providerId} ORDER BY date DESC LIMIT 1),(SELECT json_extract(message_json,'$.subject') FROM drafts WHERE account_id=${entry.accountId} AND id=${entry.providerId})),
          COALESCE(${entry.sender ?? null},(SELECT from_addr FROM messages WHERE account_id=${entry.accountId} AND provider_id=${entry.providerId} ORDER BY date DESC LIMIT 1),(SELECT email FROM accounts WHERE id=${entry.accountId})),
          ${JSON.stringify(entry.rejected ?? [])})`);
      },
    );
    const FAILED_COLUMNS = sql.literal(
      "id,account_id AS accountId,provider_id AS providerId,at,kind,reason,subject,sender",
    );
    const listFailedOps = all(FailedOp)(
      sql`SELECT ${FAILED_COLUMNS} FROM failed_ops ORDER BY id DESC`,
    );
    const getFailedOp = Effect.fn("Store.getFailedOp")(function* (id: number) {
      const row = yield* first(
        Schema.Struct({
          ...FailedOp.fields,
          rejected_json: Schema.fromJsonString(Schema.Array(Schema.String)),
        }),
      )(sql`SELECT ${FAILED_COLUMNS},rejected_json FROM failed_ops WHERE id=${id}`);
      if (Option.isNone(row)) return yield* new NotFound({ what: "draft", id: String(id) });
      const { rejected_json, ...notice } = row.value;
      return { notice, rejected: rejected_json };
    });
    const acknowledgeFailedOps = (ids: readonly number[]) =>
      ids.length ? run(sql`DELETE FROM failed_ops WHERE id IN ${sql.in(ids)}`) : Effect.void;

    // Audit, agent policy, proposals

    const audit = Effect.fn("Store.audit")(function* (entry: {
      actor: Actor;
      accountId?: string;
      action: string;
      detail: unknown;
    }) {
      const now = yield* Clock.currentTimeMillis;
      yield* run(sql`INSERT INTO audit_log (at, actor, account_id, action, detail_json)
        VALUES (${now}, ${actorLabel(entry.actor)}, ${entry.accountId ?? null}, ${entry.action},
          ${JSON.stringify(entry.detail ?? null)})`);
    });

    const listAudit = Effect.fn("Store.listAudit")(function* (limit: number) {
      const rows = yield* all(AuditRow)(sql`SELECT at, actor, account_id, action, detail_json
        FROM audit_log ORDER BY id DESC LIMIT ${limit}`);
      return rows.map((r) => ({
        at: r.at,
        actor: r.actor,
        accountId: r.account_id,
        action: r.action,
        detail: r.detail_json,
      }));
    });

    /** The agent's own row, else the '*' default, else off. */
    const agentWriteMode = Effect.fn("Store.agentWriteMode")(function* (name: string) {
      const row = yield* first(Mode)(sql`SELECT modify FROM agent_policies
        WHERE name IN (${name}, '*') ORDER BY name = '*' LIMIT 1`);
      return Option.match(row, { onNone: (): AgentWriteMode => "off", onSome: (r) => r.modify });
    });

    const setAgentWriteMode = Effect.fn("Store.setAgentWriteMode")(
      (name: string, mode: AgentWriteMode) =>
        run(sql`INSERT INTO agent_policies (name, modify) VALUES (${name}, ${mode})
          ON CONFLICT(name) DO UPDATE SET modify = excluded.modify`),
    );

    const insertProposal = Effect.fn("Store.insertProposal")(function* (
      actor: Actor,
      command: Command,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const row = yield* first(Id)(sql`INSERT INTO proposals (created_at, actor_json, command_json)
        VALUES (${now}, ${JSON.stringify(actor)}, ${JSON.stringify(command)}) RETURNING id`);
      if (Option.isNone(row)) return yield* Effect.die("INSERT ... RETURNING returned no row");
      return row.value.id;
    });

    const PROPOSAL_COLUMNS = sql.literal("id, created_at, actor_json, command_json, status");

    const listProposals = Effect.fn("Store.listProposals")(function* (status: Proposal["status"]) {
      const rows = yield* all(ProposalRow)(sql`SELECT ${PROPOSAL_COLUMNS} FROM proposals
        WHERE status = ${status} ORDER BY created_at, id`);
      return rows.map(toProposal);
    });

    const getProposal = Effect.fn("Store.getProposal")(function* (
      id: number,
    ): Effect.fn.Return<Proposal, NotFound> {
      const row = yield* first(ProposalRow)(
        sql`SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE id = ${id}`,
      );
      if (Option.isNone(row)) return yield* new NotFound({ what: "proposal", id: String(id) });
      return toProposal(row.value);
    });

    /** Decides a pending proposal. A decided one keeps its first decision. */
    const setProposalStatus = Effect.fn("Store.setProposalStatus")(function* (
      id: number,
      status: "approved" | "rejected",
    ) {
      const now = yield* Clock.currentTimeMillis;
      yield* run(sql`UPDATE proposals SET status = ${status}, decided_at = ${now}
        WHERE id = ${id} AND status = 'pending'`);
    });

    const snooze = Effect.fn("Store.snooze")(function* (id: string, due: number) {
      const message = yield* getMessage(id);
      const previous = yield* all(Schema.Struct({ id: Schema.String }))(
        sql`SELECT m.id FROM snoozed_messages s JOIN messages m ON m.account_id=s.account_id AND m.provider_id=s.provider_id WHERE s.account_id=${message.accountId} AND s.thread_id=${message.threadId}`,
      );
      const targets = (yield* getThread(id)).filter(
        (member) =>
          !member.labels.some((l) => ["DRAFT", "TRASH", "SPAM"].includes(l)) &&
          (member.labels.includes("INBOX") ||
            (member.labels.includes("SNOOZED") && previous.some((p) => member.id === p.id))),
      );
      if (!targets.length)
        yield* new InvalidInput({ message: "Only inbox messages can be snoozed" });
      yield* run(sql`INSERT INTO thread_reminders (account_id, thread_id, due_at, woken_at)
        VALUES (${message.accountId}, ${message.threadId}, ${due}, NULL)
        ON CONFLICT(account_id, thread_id) DO UPDATE SET due_at=excluded.due_at, woken_at=NULL, wake_pending=0`);
      yield* run(
        sql`DELETE FROM snoozed_messages WHERE account_id=${message.accountId} AND thread_id=${message.threadId}`,
      );
      const owner = yield* getAccount(message.accountId);
      for (const member of targets) {
        const { providerId } = yield* messageRef(member.id);
        yield* run(
          sql`INSERT INTO snoozed_messages (account_id, thread_id, provider_id) VALUES (${message.accountId}, ${message.threadId}, ${providerId})`,
        );
        const labels = [
          ...applyOpToLabels(
            member.labels.filter((l) => l !== "SNOOZED"),
            { kind: "archive" },
            owner.provider,
          ),
          "SNOOZED",
        ];
        yield* run(
          sql`UPDATE messages SET labels_json=${JSON.stringify(labels)} WHERE id=${member.id}`,
        );
      }
    });

    const reminderSnapshot: Store["Service"]["reminderSnapshot"] = (id) =>
      Effect.gen(function* () {
        const message = yield* getMessage(id);
        const reminder = yield* first(
          Schema.Struct({
            due_at: Schema.NullOr(Schema.Number),
            woken_at: Schema.NullOr(Schema.Number),
            wake_pending: Schema.BooleanFromBit,
          }),
        )(
          sql`SELECT due_at,woken_at,wake_pending FROM thread_reminders WHERE account_id=${message.accountId} AND thread_id=${message.threadId}`,
        );
        if (Option.isNone(reminder)) return Option.none();
        const members = yield* all(
          Schema.Struct({ provider_id: Schema.String, wake_pending: Schema.BooleanFromBit }),
        )(
          sql`SELECT provider_id,wake_pending FROM snoozed_messages WHERE account_id=${message.accountId} AND thread_id=${message.threadId}`,
        );
        return Option.some({
          accountId: message.accountId,
          threadId: message.threadId,
          dueAt: reminder.value.due_at,
          wokenAt: reminder.value.woken_at,
          wakePending: reminder.value.wake_pending,
          members: members.map((member) => ({
            providerId: member.provider_id,
            wakePending: member.wake_pending,
          })),
        });
      });
    const restoreReminder: Store["Service"]["restoreReminder"] = (snapshot) =>
      Effect.gen(function* () {
        yield* run(sql`INSERT INTO thread_reminders (account_id,thread_id,due_at,woken_at,wake_pending)
        VALUES (${snapshot.accountId},${snapshot.threadId},${snapshot.dueAt},${snapshot.wokenAt},${snapshot.wakePending ? 1 : 0})
        ON CONFLICT(account_id,thread_id) DO UPDATE SET due_at=excluded.due_at,woken_at=excluded.woken_at,wake_pending=excluded.wake_pending`);
        yield* run(
          sql`DELETE FROM snoozed_messages WHERE account_id=${snapshot.accountId} AND thread_id=${snapshot.threadId}`,
        );
        for (const member of snapshot.members) {
          yield* run(sql`INSERT INTO snoozed_messages (account_id,thread_id,provider_id,wake_pending)
          VALUES (${snapshot.accountId},${snapshot.threadId},${member.providerId},${member.wakePending ? 1 : 0})`);
          if (snapshot.dueAt !== null)
            yield* run(sql`UPDATE messages AS m SET labels_json=json_insert(labels_json,'$[#]','SNOOZED')
          WHERE account_id=${snapshot.accountId} AND provider_id=${member.providerId} AND NOT ${hasLabel("SNOOZED")}`);
        }
      });

    const pruneNotifications = (now: number) =>
      Effect.gen(function* () {
        yield* run(
          sql`DELETE FROM pending_notifications WHERE enqueued_at < ${now - NOTIFICATION_RETENTION}`,
        );
        yield* run(sql`DELETE FROM pending_notifications WHERE message_id IN (
        SELECT message_id FROM pending_notifications ORDER BY enqueued_at DESC,rowid DESC
        LIMIT -1 OFFSET ${MAX_PENDING_NOTIFICATIONS})`);
      });
    const enqueueNotification = (id: string, digest: boolean) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            yield* run(sql`INSERT INTO pending_notifications (message_id,digest,enqueued_at)
          VALUES (${id},${digest ? 1 : 0},${now}) ON CONFLICT(message_id) DO NOTHING`);
            yield* pruneNotifications(now);
          }),
        )
        .pipe(Effect.catchIf(isSqlError, (error) => Effect.die(error)));
    const takeNotifications = (now: number) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* pruneNotifications(now);
            const pending = yield* all(
              Schema.Struct({
                ...summaryRowFields,
                digest: Schema.BooleanFromBit,
                enqueued_at: Schema.Number,
              }),
            )(sql`SELECT ${sql.literal(SUMMARY_COLUMNS)},n.digest,n.enqueued_at FROM pending_notifications n
              JOIN messages m ON m.id=n.message_id ORDER BY n.rowid`);
            const accounts = yield* listAccounts;
            const prefs = yield* compose.prefs;
            const batches = new Map<
              string,
              {
                kind: NotificationBatch["kind"];
                profileId: string | null;
                messages: MessageSummary[];
              }
            >();
            for (const entry of pending) {
              const message = toSummary(entry);
              const account = accounts.find((a) => a.id === message.accountId);
              if (account && notificationEligible(account, message, prefs)) {
                if (!profileNotificationsActive(account, prefs, new Date(now))) {
                  if (!entry.digest)
                    yield* run(
                      sql`UPDATE pending_notifications SET digest=1 WHERE message_id=${message.id} AND digest=0`,
                    );
                  continue;
                }
                const digest =
                  entry.digest || now - entry.enqueued_at >= IMMEDIATE_NOTIFICATION_AGE;
                const kind = digest ? "digest" : "immediate";
                // A digest spans the Profile, including its multiple accounts.
                const key = JSON.stringify([kind, digest ? account.profileId : account.id]);
                const batch = batches.get(key) ?? {
                  kind,
                  profileId: account.profileId,
                  messages: [],
                };
                batch.messages.push(message);
                batches.set(key, batch);
              }
              // Read, archived, disabled or delivered arrivals must never notify later.
              yield* run(sql`DELETE FROM pending_notifications WHERE message_id=${message.id}`);
            }
            return [...batches.values()];
          }),
        )
        .pipe(Effect.catchIf(isSqlError, (error) => Effect.die(error)));

    return Store.of({
      ai: makeAiStore(sql),
      rememberNotificationActions: (id, actions) =>
        run(sql`INSERT INTO notification_buttons(message_id,actions_json)
        SELECT id, ${JSON.stringify(actions)} FROM messages WHERE id=${id}
        ON CONFLICT(message_id) DO UPDATE SET actions_json=excluded.actions_json`),
      notificationActions: (id) =>
        first(Schema.Struct({ actions: Schema.fromJsonString(NotificationActions) }))(
          sql`SELECT actions_json AS actions FROM notification_buttons WHERE message_id=${id}`,
        ).pipe(
          Effect.map((row) =>
            Option.match(row, { onSome: (r) => r.actions, onNone: () => ["archive", "trash"] }),
          ),
        ),
      ...cache,
      ...organization,
      snooze,
      reminderSnapshot,
      restoreReminder,
      transaction: (effect) =>
        sql.withTransaction(effect).pipe(Effect.catchIf(isSqlError, (e) => Effect.die(e))),
      ...makeSyncHealthStore(sql),
      listAccounts,
      getAccount,
      upsertAccount,
      removeAccount,
      setAccountProfile,
      setAccountSettings,
      moveAccount,
      setImapSettings,
      setNeedsReauth,
      ...makeServiceStore(sql),
      setGrantedScopes: (id, scopes) =>
        run(sql`INSERT INTO account_oauth_scopes (account_id, scopes_json)
        VALUES (${id}, ${JSON.stringify([...new Set(scopes)])}) ON CONFLICT(account_id) DO UPDATE SET scopes_json=excluded.scopes_json`),
      setSyncError,
      getSyncCursor,
      beginInitialSync: (id) => initialSyncState(id, false),
      finishInitialSync: (id) => initialSyncState(id, true),
      notificationsReady,
      getInboxCursor,
      getInboxError,
      setInboxError,
      hasMessage,
      saveInboxCursor,
      observeIncoming,
      enqueueNotification,
      takeNotifications,
      saveSyncCursor,
      media,
      semantics,
      upsertMessage,
      setFlags,
      deleteMessage,
      ...syncResets,
      deleteMessagesWithLabel,
      deleteAccountMessages,
      listThreads,
      countThreads,
      vectorThreads,
      getMessage,
      ...wordIndex,
      ...makeInviteStatusStore(sql),
      getThread,
      findMessageByRfcId: (ownerId, messageId, folder) =>
        first(MessageId)(
          sql`SELECT id FROM messages AS m WHERE m.account_id=${ownerId} AND m.account_id IN (SELECT id FROM accounts WHERE enabled=1) AND trim(m.rfc_message_id, '<>')=${messageId.replace(/^<|>$/g, "")} ${folder ? sql`AND ${imapFolder(folder)}` : sql.literal("")} ORDER BY date DESC,id LIMIT 1`,
        ).pipe(Effect.map((row) => (Option.isSome(row) ? row.value.id : null))),
      deleteImapFolder: (account, previous, keep) =>
        media
          .deleteVectorsForMessages(
            sql`m.account_id=${account} AND ${imapFolder(previous)} AND ${outsideKeep(keep)}`,
          )
          .pipe(
            Effect.andThen(
              run(
                sql`DELETE FROM messages AS m WHERE m.account_id=${account} AND ${imapFolder(previous)} AND ${outsideKeep(keep)}`,
              ),
            ),
          ),
      invalidateImapFolder,
      messageRef,
      messageIdForProvider,
      remapProviderIds,
      checkpoint: run(sql`PRAGMA wal_checkpoint(PASSIVE)`).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            if (now - lastTruncate >= 24 * 60 * 60 * 1000) {
              const pages = yield* all(
                Schema.Struct({
                  busy: Schema.Number,
                  log: Schema.Number,
                  checkpointed: Schema.Number,
                }),
              )(sql`PRAGMA wal_checkpoint(PASSIVE)`);
              if (pages.every((page) => page.busy === 0 && page.log === page.checkpointed)) {
                yield* run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
                lastTruncate = now;
              }
            }
          }),
        ),
      ),
      threadMessageIds,
      messageLabels,
      applyLocalOp,
      unreadCounts,
      unreadByLabel,
      replaceLabels,
      listLabels,
      listProfiles,
      createProfile,
      updateProfile,
      deleteProfile,
      enqueueOp,
      listPendingOps,
      pendingOpsForMessages,
      claimPendingOp,
      ownsPendingOp,
      renewPendingOp,
      recordFailedOp,
      getFailedOp,
      recordCopyProgress,
      recordAppendedMessageId,
      listFailedOps,
      acknowledgeFailedOps,
      releasePendingOp,
      removePendingOp,
      failPendingOp,
      imageSenders: compose.imageSenders,
      setImageSender: compose.setImageSender,
      getDraft: compose.getDraft,
      draftByRemoteMessage: compose.draftByRemoteMessage,
      draftByProposal: compose.draftByProposal,
      putDraft: compose.putDraft,
      setDraftRemote: compose.setDraftRemote,
      setDraftOrganizationKey: compose.setDraftOrganizationKey,
      draftSaveState: compose.draftSaveState,
      setDraftSyncError: compose.setDraftSyncError,
      setDraftLocalOnly: compose.setDraftLocalOnly,
      deleteDraft: compose.deleteDraft,
      enqueueDraftSave: compose.enqueueDraftSave,
      dropSyncedDrafts: compose.dropSyncedDrafts,
      sendUncertain: (id) =>
        first(Schema.Struct({ key: Schema.String }))(
          sql`SELECT key FROM prefs WHERE key=${`send-uncertain:${id}`}`,
        ).pipe(Effect.map(Option.isSome)),
      setSendUncertain: (id, value) =>
        value
          ? run(
              sql`INSERT INTO prefs(key,value_json) VALUES(${`send-uncertain:${id}`},'true') ON CONFLICT(key) DO NOTHING`,
            )
          : run(sql`DELETE FROM prefs WHERE key=${`send-uncertain:${id}`}`),
      queuedSends: compose.queuedSends,
      putQueuedSend: compose.putQueuedSend,
      deleteQueuedSend: compose.deleteQueuedSend,
      prefs: compose.prefs,
      setPrefs: compose.setPrefs,
      ...signatureLibrary,
      ...makeUndoStore(sql),
      signatures: compose.signatures,
      setSignature: compose.setSignature,
      templates: compose.templates,
      saveTemplate: compose.saveTemplate,
      deleteTemplate: compose.deleteTemplate,
      ...contacts,
      setMessageWebLink: (id, url) => run(sql`UPDATE messages SET web_link=${url} WHERE id=${id}`),
      contactAlternatives: contacts.contactAlternatives,
      suggestContacts: compose.suggestContacts,
      hiddenContacts: compose.hiddenContacts,
      setContactHidden: compose.setContactHidden,
      audit,
      listAudit,
      agentWriteMode,
      setAgentWriteMode,
      insertProposal,
      listProposals,
      getProposal,
      setProposalStatus,
    });
  }),
);
