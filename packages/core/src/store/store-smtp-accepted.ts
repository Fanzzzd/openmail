/**
 * The SMTP-accepted record a send writes after SMTP 250, and the claim a holder keeps on it while
 * it files the Sent copy. A live send and the sync retry (here or in another process) both claim
 * the record by token; whoever holds it files the copy and ends the record.
 */
import { Clock, Effect, Option, Schema } from "effect";
import { type SqlClient } from "effect/sql";
import { Buffer } from "../platform/bytes.js";
import type { Store } from "./service.js";
import { all, first, run } from "./sql-rows.js";

/** Raw MIME SMTP accepted, kept until its Sent copy is filed. */
const SMTP_ACCEPTED = "smtp-accepted:";
const SmtpAcceptedRow = Schema.Struct({
  key: Schema.String,
  value_json: Schema.fromJsonString(
    Schema.Struct({
      accountId: Schema.String,
      raw: Schema.String,
      at: Schema.Number,
      tries: Schema.optionalKey(Schema.Number),
      subject: Schema.optionalKey(Schema.String),
      sender: Schema.optionalKey(Schema.String),
      claim: Schema.optionalKey(Schema.NullOr(Schema.String)),
      claimedAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
      lastTryAt: Schema.optionalKey(Schema.Number),
    }),
  ),
});

/** A claim on an SMTP-accepted record older than this belongs to a process that died mid-send. */
export const SMTP_ACCEPTED_CLAIM_TTL = 2 * 60_000;
/** How often a holder renews its claim: four renewals fit in one TTL. */
export const SMTP_ACCEPTED_CLAIM_RENEW_MS = SMTP_ACCEPTED_CLAIM_TTL / 4;

const Key = Schema.Struct({ key: Schema.String });

export const makeSmtpAcceptedStore = ({ sql }: { sql: SqlClient.SqlClient }) => {
  /** The record is valid and `token` holds its claim. */
  const heldBy = (token: string) =>
    sql`json_valid(value_json) AND json_extract(value_json,'$.claim')=${token}`;
  return {
    smtpAccepted: all(SmtpAcceptedRow)(
      sql`SELECT key, value_json FROM prefs WHERE substr(key,1,${SMTP_ACCEPTED.length})=${SMTP_ACCEPTED} ORDER BY key`,
    ).pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          draftId: row.key.slice(SMTP_ACCEPTED.length),
          accountId: row.value_json.accountId,
          raw: new Uint8Array(Buffer.from(row.value_json.raw, "base64")),
          at: row.value_json.at,
          tries: row.value_json.tries ?? 0,
          lastTryAt: row.value_json.lastTryAt,
          subject: row.value_json.subject,
          sender: row.value_json.sender,
        })),
      ),
    ),
    markSmtpAccepted: (draftId, accountId, raw, claim) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        const value = JSON.stringify({
          accountId,
          raw: Buffer.from(raw).toString("base64"),
          at,
          ...(claim === undefined ? {} : { claim, claimedAt: at }),
        });
        yield* run(
          sql`INSERT INTO prefs(key,value_json) VALUES(${SMTP_ACCEPTED + draftId},${value}) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`,
        );
      }),
    claimSmtpAccepted: Effect.fn("Store.claimSmtpAccepted")(function* (
      draftId: string,
      token: string,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const row = yield* first(Key)(
        sql`UPDATE prefs SET value_json=json_set(value_json,'$.claim',${token},'$.claimedAt',${now})
        WHERE key=${SMTP_ACCEPTED + draftId} AND json_valid(value_json)
          AND (json_extract(value_json,'$.claim') IS NULL
            OR COALESCE(json_extract(value_json,'$.claimedAt'),0) < ${now - SMTP_ACCEPTED_CLAIM_TTL})
        RETURNING key`,
      );
      return Option.isSome(row);
    }),
    renewSmtpAccepted: Effect.fn("Store.renewSmtpAccepted")(function* (
      draftId: string,
      token: string,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const row = yield* first(Key)(
        sql`UPDATE prefs SET value_json=json_set(value_json,'$.claimedAt',${now})
        WHERE key=${SMTP_ACCEPTED + draftId} AND ${heldBy(token)} RETURNING key`,
      );
      return Option.isSome(row);
    }),
    releaseSmtpAccepted: (draftId, token) =>
      run(
        sql`UPDATE prefs SET value_json=json_remove(value_json,'$.claim','$.claimedAt')
        WHERE key=${SMTP_ACCEPTED + draftId} AND ${heldBy(token)}`,
      ),
    clearSmtpAccepted: (draftId, token) =>
      first(Key)(
        sql`DELETE FROM prefs WHERE key=${SMTP_ACCEPTED + draftId} AND ${heldBy(token)} RETURNING key`,
      ).pipe(Effect.map(Option.isSome)),
    noteSentCopyFailure: Effect.fn("Store.noteSentCopyFailure")(function* (
      draftId: string,
      message: { subject: string; sender: string },
      token: string,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const row = yield* first(Key)(
        sql`UPDATE prefs SET value_json=json_remove(json_set(value_json,
        '$.tries', COALESCE(json_extract(value_json,'$.tries'),0)+1,
        '$.lastTryAt', ${now},
        '$.subject', COALESCE(json_extract(value_json,'$.subject'),${message.subject}),
        '$.sender', COALESCE(json_extract(value_json,'$.sender'),${message.sender})),
        '$.claim','$.claimedAt')
      WHERE key=${SMTP_ACCEPTED + draftId} AND ${heldBy(token)} RETURNING key`,
      );
      return Option.isSome(row);
    }),
  } satisfies Pick<
    Store["Service"],
    | "smtpAccepted"
    | "markSmtpAccepted"
    | "claimSmtpAccepted"
    | "renewSmtpAccepted"
    | "releaseSmtpAccepted"
    | "clearSmtpAccepted"
    | "noteSentCopyFailure"
  >;
};
