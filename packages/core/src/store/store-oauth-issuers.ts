import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { OAuthIssuers } from "../platform/auth.js";
import { first, run } from "./sql-rows.js";

const IssuerRow = Schema.Struct({ oauth_client_id: Schema.NullOr(Schema.String) });
const IssuedRow = Schema.Struct({ oauth_issued_at: Schema.NullOr(Schema.Number) });

/**
 * `accounts.oauth_client_id` (migration 43) and `oauth_issued_at` (migration 44).
 * Removing the account removes both.
 */
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
  issuedAt: (accountId) =>
    first(IssuedRow)(sql`SELECT oauth_issued_at FROM accounts WHERE id = ${accountId}`).pipe(
      Effect.map((row) => Option.flatMapNullishOr(row, (value) => value.oauth_issued_at)),
      Effect.withSpan("OAuthIssuers.issuedAt"),
    ),
  setIssuedAt: (accountId, at) =>
    run(sql`UPDATE accounts SET oauth_issued_at = ${at} WHERE id = ${accountId}`).pipe(
      Effect.withSpan("OAuthIssuers.setIssuedAt"),
    ),
});

export const OAuthIssuersSql: Layer.Layer<OAuthIssuers, never, SqlClient.SqlClient> = Layer.effect(
  OAuthIssuers,
  Effect.map(SqlClient.SqlClient, makeOAuthIssuers),
);
