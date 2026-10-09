import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { OAuthIssuers } from "./services.js";
import { first, run } from "./sql-rows.js";

const IssuerRow = Schema.Struct({ oauth_client_id: Schema.NullOr(Schema.String) });

/** `accounts.oauth_client_id` (migration 43). Removing the account removes it. */
export const makeOAuthIssuers = (sql: SqlClient.SqlClient): OAuthIssuers["Service"] => ({
  get: (accountId) =>
    first(IssuerRow)(sql`SELECT oauth_client_id FROM accounts WHERE id = ${accountId}`).pipe(
      Effect.map((row) => Option.flatMapNullishOr(row, (value) => value.oauth_client_id)),
      Effect.withSpan("OAuthIssuers.get"),
    ),
  set: (accountId, clientId) =>
    run(sql`UPDATE accounts SET oauth_client_id = ${clientId} WHERE id = ${accountId}`).pipe(
      Effect.withSpan("OAuthIssuers.set"),
    ),
});

export const OAuthIssuersSql: Layer.Layer<OAuthIssuers, never, SqlClient.SqlClient> = Layer.effect(
  OAuthIssuers,
  Effect.map(SqlClient.SqlClient, makeOAuthIssuers),
);
