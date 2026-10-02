import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { CalendarInvite, InviteResponseRecord } from "./calendar.js";
import { all, first, run } from "./sql-rows.js";

/** Only explicit, successfully sent responses are recorded. Account/event identity scopes them. */
export function makeInviteStatusStore(sql: SqlClient.SqlClient) {
  return {
    cacheInvites: (messageId: string, invites: readonly CalendarInvite[]) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* run(sql`DELETE FROM calendar_invites WHERE message_id=${messageId}`);
            for (const invite of invites)
              yield* run(sql`INSERT INTO calendar_invites(message_id,invite_key,account_id,uid,sequence,message_date,invite_json)
            SELECT id,${`${invite.method}:${invite.key}`},account_id,${invite.uid},${invite.sequence},date,${JSON.stringify(invite)} FROM messages WHERE id=${messageId}`);
          }),
        )
        .pipe(Effect.orDie),
    cachedInvites: (accountId: string, uid: string) =>
      all(Schema.Struct({ invite_json: Schema.fromJsonString(CalendarInvite) }))(
        sql`SELECT invite_json FROM calendar_invites WHERE account_id=${accountId} AND uid=${uid}
          ORDER BY sequence DESC,message_date DESC,message_id DESC LIMIT 200`,
      ).pipe(Effect.map((rows) => rows.toReversed().map((row) => row.invite_json))),
    inviteSiblingIds: (accountId: string, uid: string, messageId: string) =>
      all(Schema.Struct({ message_id: Schema.String }))(
        sql`SELECT message_id FROM calendar_invites WHERE account_id=${accountId} AND uid=${uid} AND message_id!=${messageId}
          ORDER BY sequence DESC,message_date DESC LIMIT 50`,
      ).pipe(Effect.map((rows) => [...new Set(rows.map((row) => row.message_id))].slice(0, 20))),
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
