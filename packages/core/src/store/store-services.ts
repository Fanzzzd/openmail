import { Provider } from "../domain/account.js";
import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { legacyScopes, OptionalService } from "../providers/optional-services.js";
import { first, run } from "./sql-rows.js";
import { providerCapabilities } from "../providers/capabilities.js";

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
  const grantedScopes = (id: string) =>
    Effect.gen(function* () {
      const known = yield* scopeRow(id);
      if (Option.isSome(known)) return known.value.scopes_json;
      const account = yield* first(Schema.Struct({ provider: Provider }))(
        sql`SELECT provider FROM accounts WHERE id=${id}`,
      );
      if (
        Option.isNone(account) ||
        providerCapabilities(account.value.provider).signIn === "password"
      )
        return [];
      yield* run(
        sql`INSERT INTO account_oauth_scopes(account_id,scopes_json) VALUES(${id},${JSON.stringify(legacyScopes(account.value.provider))}) ON CONFLICT(account_id) DO NOTHING`,
      );
      const recorded = yield* scopeRow(id);
      return Option.isSome(recorded) ? recorded.value.scopes_json : [];
    });
  return {
    grantedScopes,
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
