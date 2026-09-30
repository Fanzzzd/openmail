import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { Address } from "./domain.js";
import type { ContactSync } from "./contacts.js";
import { mergeContacts } from "./contacts.js";
import { all, run } from "./sql-rows.js";

const SyncRow = Schema.Struct({
  account_id: Schema.String,
  refreshed_at: Schema.NullOr(Schema.Number),
  attempted_at: Schema.Number,
  error: Schema.NullOr(Schema.String),
  scope_missing: Schema.Number,
  count: Schema.Int,
});
export function makeContactStore(sql: SqlClient.SqlClient) {
  return {
    replaceServerContacts: Effect.fn("Store.replaceServerContacts")(function* (
      accountId: string,
      contacts: readonly Address[],
      now: number,
    ) {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* run(sql`DELETE FROM server_contacts WHERE account_id = ${accountId}`);
            for (const a of mergeContacts(contacts))
              yield* run(
                sql`INSERT INTO server_contacts (account_id, address, name) VALUES (${accountId}, ${a.address}, ${a.name})`,
              );
            yield* run(sql`INSERT INTO contact_sync (account_id, refreshed_at, attempted_at, error, scope_missing)
          VALUES (${accountId}, ${now}, ${now}, NULL, 0) ON CONFLICT(account_id) DO UPDATE SET
          refreshed_at=excluded.refreshed_at, attempted_at=excluded.attempted_at, error=NULL, scope_missing=0`);
          }),
        )
        .pipe(Effect.orDie);
    }),
    contactSync: all(SyncRow)(
      sql`SELECT s.*, (SELECT COUNT(*) FROM server_contacts c WHERE c.account_id=s.account_id) AS count FROM contact_sync s ORDER BY s.account_id`,
    ).pipe(
      Effect.map((rows): ContactSync[] =>
        rows.map((r) => ({
          accountId: r.account_id,
          refreshedAt: r.refreshed_at,
          attemptedAt: r.attempted_at,
          error: r.error,
          scopeMissing: r.scope_missing === 1,
          count: r.count,
        })),
      ),
    ),
    setContactSyncError: (accountId: string, now: number, error: string, scopeMissing: boolean) =>
      run(sql`INSERT INTO contact_sync (account_id, attempted_at, error, scope_missing) VALUES (${accountId}, ${now}, ${error}, ${scopeMissing ? 1 : 0})
      ON CONFLICT(account_id) DO UPDATE SET attempted_at=excluded.attempted_at, error=excluded.error, scope_missing=excluded.scope_missing`),
  };
}
