import { Provider } from "./domain.js";
import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { legacyScopes, OptionalService } from "./optional-services.js";
import { first, run } from "./sql-rows.js";

export function makeServiceStore(sql: SqlClient.SqlClient) {
  const disabledServices = (id: string) =>
    first(Schema.Struct({ disabled_json: Schema.fromJsonString(Schema.Array(OptionalService)) }))(
      sql`SELECT disabled_json FROM account_optional_services WHERE account_id=${id}`,
    ).pipe(Effect.map((row) => (Option.isSome(row) ? row.value.disabled_json : [])));
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
      if (Option.isNone(account) || account.value.provider === "imap") return [];
      yield* run(
        sql`INSERT INTO account_oauth_scopes(account_id,scopes_json) VALUES(${id},${JSON.stringify(legacyScopes(account.value.provider))}) ON CONFLICT(account_id) DO NOTHING`,
      );
      const recorded = yield* scopeRow(id);
      return Option.isSome(recorded) ? recorded.value.scopes_json : [];
    });
  return {
    grantedScopes,
    disabledServices,
    setServiceEnabled: (id: string, service: OptionalService, enabled: boolean) =>
      Effect.gen(function* () {
        const disabled = new Set(yield* disabledServices(id));
        if (enabled) disabled.delete(service);
        else disabled.add(service);
        yield* run(sql`INSERT INTO account_optional_services VALUES (${id},${JSON.stringify([...disabled])})
        ON CONFLICT(account_id) DO UPDATE SET disabled_json=excluded.disabled_json`);
      }),
  };
}
