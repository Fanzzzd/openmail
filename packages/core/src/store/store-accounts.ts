import { Clock, Effect, Option, Schema } from "effect";
import { type SqlClient } from "effect/sql";
import { isSqlError } from "effect/sql/SqlError";
import {
  type Account,
  type AccountPlacement,
  type AccountSettings,
  type ImapSettings,
  Profile,
  type ProfileInput,
  type Provider,
} from "../domain/domain.js";
import { type AuthError, InvalidInput, NotFound } from "../domain/errors.js";
import { logReauth, reauthReason } from "../reauth.js";
import { type PlatformCrypto } from "../platform/crypto.js";
import { type Store } from "../services.js";
import { all, first, run } from "./sql-rows.js";
import { type makeMediaStore } from "./store-media.js";
import { accountId, AccountRow, Cursor, Next, toAccount } from "./store-rows.js";

const ReauthRow = Schema.Struct({
  provider: AccountRow.fields.provider,
  needs_reauth: AccountRow.fields.needs_reauth,
  reauth_reason: AccountRow.fields.reauth_reason,
});

export const makeAccountsStore = ({
  sql,
  crypto,
  media,
  purgeAccountProposals,
}: {
  sql: SqlClient.SqlClient;
  crypto: PlatformCrypto;
  media: ReturnType<typeof makeMediaStore>;
  purgeAccountProposals: Store["Service"]["purgeAccountProposals"];
}) => {
  // Accounts

  const accountRows = all(AccountRow);

  const ACCOUNT_COLUMNS = sql.literal(`id, provider, email, created_at, last_synced_at,
      COALESCE(last_sync_error,(SELECT poll_error FROM incoming_state WHERE account_id=accounts.id)) AS last_sync_error, profile_id, settings_json, needs_reauth, reauth_reason, enabled, description, color, position`);

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
    purgeAccountProposals(id).pipe(
      Effect.andThen(media.deleteVectorsForMessages(sql`m.account_id=${id}`)),
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
                sql`DELETE FROM prefs WHERE key IN (${`sync-reset:${id}`},${`sync-stale:${id}`},${`sync-headers:${id}`})`,
              );
              // No foreign key reaches these: audit_log has none, and a queued
              // mobile send keeps its account inside its JSON.
              yield* run(sql`DELETE FROM audit_log WHERE account_id=${id}`);
              yield* run(
                sql`DELETE FROM prefs WHERE key LIKE 'mobile-outbox:%' AND json_valid(value_json) AND json_extract(value_json,'$.accountId')=${id}`,
              );
              // Every other table with an account_id cascades from accounts,
              // directly or through messages and thread_reminders.
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

  const setImapSettings = Effect.fn("Store.setImapSettings")((id: string, settings: ImapSettings) =>
    run(sql`UPDATE accounts SET settings_json = ${JSON.stringify(settings)} WHERE id = ${id}`),
  );

  const markReauth = Effect.fn("Store.markReauth")(function* (id: string, error: AuthError) {
    const reason = reauthReason(error);
    const current = yield* first(ReauthRow)(
      sql`SELECT provider, needs_reauth, reauth_reason FROM accounts WHERE id = ${id}`,
    );
    if (Option.isNone(current)) return;
    if (current.value.needs_reauth && current.value.reauth_reason === reason) return;
    yield* run(
      sql`UPDATE accounts SET needs_reauth = 1, reauth_reason = ${reason} WHERE id = ${id}`,
    );
    yield* logReauth(current.value.provider, id, reason);
  });

  const clearReauth = Effect.fn("Store.clearReauth")((id: string) =>
    run(sql`UPDATE accounts SET needs_reauth = 0, reauth_reason = NULL WHERE id = ${id}`),
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
    ).pipe(Effect.map((row) => Option.match(row, { onNone: () => null, onSome: (r) => r.error })));

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
  return {
    listAccounts,
    getAccount,
    upsertAccount,
    removeAccount,
    setAccountProfile,
    setAccountSettings,
    moveAccount,
    setImapSettings,
    markReauth,
    clearReauth,
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
    saveSyncCursor,
    listProfiles,
    createProfile,
    updateProfile,
    deleteProfile,
  } satisfies Pick<
    Store["Service"],
    | "listAccounts"
    | "getAccount"
    | "upsertAccount"
    | "removeAccount"
    | "setAccountProfile"
    | "setAccountSettings"
    | "moveAccount"
    | "setImapSettings"
    | "markReauth"
    | "clearReauth"
    | "setGrantedScopes"
    | "setSyncError"
    | "getSyncCursor"
    | "beginInitialSync"
    | "finishInitialSync"
    | "notificationsReady"
    | "getInboxCursor"
    | "getInboxError"
    | "setInboxError"
    | "hasMessage"
    | "saveInboxCursor"
    | "observeIncoming"
    | "saveSyncCursor"
    | "listProfiles"
    | "createProfile"
    | "updateProfile"
    | "deleteProfile"
  >;
};
