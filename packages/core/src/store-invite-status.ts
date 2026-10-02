import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { InviteResponseRecord } from "./calendar.js";
import { first, run } from "./sql-rows.js";

/** Only explicit, successfully sent responses are recorded. Account/event identity scopes them. */
export function makeInviteStatusStore(sql: SqlClient.SqlClient) {
  return {
    inviteResponse: (
      key: Pick<InviteResponseRecord, "accountId" | "uid" | "organizer" | "recurrenceId">,
    ) =>
      first(Schema.Struct({ record_json: Schema.fromJsonString(InviteResponseRecord) }))(
        sql`SELECT record_json FROM invite_responses WHERE account_id=${key.accountId} AND uid=${key.uid} AND organizer=${key.organizer.toLowerCase()} AND recurrence_id=${key.recurrenceId}`,
      ).pipe(Effect.map((row) => (Option.isSome(row) ? row.value.record_json : null))),
    recordInviteResponse: (record: InviteResponseRecord) =>
      run(sql`INSERT INTO invite_responses(account_id,uid,organizer,recurrence_id,record_json)
        VALUES(${record.accountId},${record.uid},${record.organizer.toLowerCase()},${record.recurrenceId},${JSON.stringify(record)})
        ON CONFLICT(account_id,uid,organizer,recurrence_id) DO UPDATE SET record_json=excluded.record_json`),
  };
}
