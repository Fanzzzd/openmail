import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { all, first, run } from "./sql-rows.js";
import {
  HeaderBackfillState,
  HeaderBackfillCandidate,
  type CachedHeaders,
  type HeaderPosition,
} from "./header-backfill.js";

const key = (account: string) => `sync-headers:${account}`;
const Candidate = HeaderBackfillCandidate;

export function makeHeaderBackfillStore(sql: SqlClient.SqlClient) {
  return {
    headerBackfillState: (account: string) =>
      first(Schema.Struct({ value_json: Schema.fromJsonString(HeaderBackfillState) }))(
        sql`SELECT value_json FROM prefs WHERE key=${key(account)}`,
      ).pipe(
        Effect.map((row): HeaderBackfillState =>
          Option.isSome(row) ? row.value.value_json : { kind: "running", after: null },
        ),
      ),
    saveHeaderBackfillState: (account: string, state: HeaderBackfillState) =>
      run(
        sql`INSERT INTO prefs(key,value_json) VALUES(${key(account)},${JSON.stringify(state)}) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`,
      ),
    headerBackfillCandidates: (
      account: string,
      after: typeof HeaderPosition.Type | null,
      limit: number,
    ) =>
      all(Candidate)(
        sql`SELECT id,date,provider_id AS providerId FROM messages WHERE account_id=${account}
        AND (rfc_message_id IS NULL OR headers_json IS NULL)
        AND ${after ? sql`(date<${after.date} OR (date=${after.date} AND id<${after.id}))` : sql.literal("1")}
        ORDER BY date DESC,id DESC LIMIT ${limit}`,
      ),
    // These columns do not participate in FTS, words, flags, label or body triggers.
    // Match both handles so an IMAP namespace reset/move cannot hydrate the wrong row.
    updateCachedHeaders: (
      account: string,
      row: Pick<typeof Candidate.Type, "id" | "providerId">,
      result: Extract<CachedHeaders, { kind: "headers" }>,
    ) =>
      run(
        sql`UPDATE messages SET rfc_message_id=COALESCE(rfc_message_id,${result.rfcMessageId}),headers_json=COALESCE(headers_json,${JSON.stringify(result.headers)})
        WHERE account_id=${account} AND id=${row.id} AND provider_id=${row.providerId}
        AND (rfc_message_id IS NULL OR headers_json IS NULL)`,
      ),
  };
}
