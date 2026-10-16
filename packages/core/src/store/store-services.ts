import { Provider } from "../domain/account.js";
import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { legacyScopes, OptionalService } from "../providers/optional-services.js";
import { all, first, run } from "./sql-rows.js";

export function makeServiceStore(sql: SqlClient.SqlClient) {
  const switches = (id: string) =>
    first(
      Schema.Struct({
        disabled_json: Schema.fromJsonString(Schema.Array(OptionalService)),
        enabled_json: Schema.fromJsonString(Schema.Array(OptionalService)),
      }),
    )(
      sql`SELECT disabled_json, enabled_json FROM account_optional_services WHERE account_id=${id}`,
    ).pipe(
      Effect.map((row) =>
        Option.isSome(row)
          ? { disabled: row.value.disabled_json, enabled: row.value.enabled_json }
          : { disabled: [], enabled: [] },
      ),
    );
  const disabledServices = (id: string) => Effect.map(switches(id), (row) => row.disabled);
  /** Services the person turned on or connected. Untouched services are in neither list. */
  const enabledServices = (id: string) => Effect.map(switches(id), (row) => row.enabled);
  const scopeRow = (id: string) =>
    first(Schema.Struct({ scopes_json: Schema.fromJsonString(Schema.Array(Schema.String)) }))(
      sql`SELECT scopes_json FROM account_oauth_scopes WHERE account_id=${id}`,
    );
  /**
   * The scopes an account was granted. An OAuth account from before account_oauth_scopes has no
   * row; it gets the scopes every sign-in asked for then, from memory, so a read needs no write lock.
   */
  const grantedScopes = (id: string) =>
    Effect.gen(function* () {
      const known = yield* scopeRow(id);
      if (Option.isSome(known)) return known.value.scopes_json;
      const account = yield* first(Schema.Struct({ provider: Provider }))(
        sql`SELECT provider FROM accounts WHERE id=${id}`,
      );
      return Option.isSome(account) ? legacyScopes(account.value.provider) : [];
    });
  /**
   * Records the legacy grant for accounts without a row, so a later change to legacyScopes
   * keeps theirs. Reads first: with every row present it takes no write lock.
   */
  const recordLegacyScopes = Effect.gen(function* () {
    const missing = yield* all(Schema.Struct({ id: Schema.String, provider: Provider }))(
      sql`SELECT id, provider FROM accounts WHERE id NOT IN (SELECT account_id FROM account_oauth_scopes)`,
    );
    for (const account of missing) {
      const scopes = legacyScopes(account.provider);
      if (scopes.length > 0)
        yield* run(
          sql`INSERT INTO account_oauth_scopes(account_id,scopes_json) VALUES(${account.id},${JSON.stringify(scopes)}) ON CONFLICT(account_id) DO NOTHING`,
        );
    }
  });
  return {
    grantedScopes,
    recordLegacyScopes,
    disabledServices,
    enabledServices,
    setServiceEnabled: (id: string, service: OptionalService, enabled: boolean) =>
      Effect.gen(function* () {
        const current = yield* switches(id);
        const disabled = new Set(current.disabled);
        const on = new Set(current.enabled);
        if (enabled) {
          disabled.delete(service);
          on.add(service);
        } else {
          disabled.add(service);
          on.delete(service);
        }
        yield* run(sql`INSERT INTO account_optional_services (account_id, disabled_json, enabled_json)
        VALUES (${id},${JSON.stringify([...disabled])},${JSON.stringify([...on])})
        ON CONFLICT(account_id) DO UPDATE SET disabled_json=excluded.disabled_json, enabled_json=excluded.enabled_json`);
      }),
  };
}
