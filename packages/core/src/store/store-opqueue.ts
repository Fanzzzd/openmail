import { Cause, Clock, Effect, Option, Random, Schema } from "effect";
import { type SqlClient } from "effect/sql";
import { FailedOp } from "../domain/sync-status.js";
import type { QueuedOp } from "../domain/changes.js";
import { NotFound, ProviderError } from "../domain/errors.js";
import { JITTER } from "../sync/backoff.js";
import type { Store } from "./service.js";
import { all, first, run } from "./sql-rows.js";
import { Buffer } from "../platform/bytes.js";
import {
  CopyProgressRow,
  FailedOpDetailRow,
  Id,
  PendingOpRow,
  toPendingOps,
} from "./store-rows.js";
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

const PENDING_OP_COLUMNS =
  "id, account_id, provider_id, op_json, attempts, last_error, created_at, retry_at, rfc_message_id, progress_json, appended_message_id";

/** A claim on a queued op older than this belongs to a process that died mid-push. */
const CLAIM_TTL = 2 * 60_000;
/** A claim on an SMTP-accepted record older than this belongs to a process that died mid-send. */
export const SMTP_ACCEPTED_CLAIM_TTL = 2 * 60_000;

const progressFailure = (cause: Cause.Cause<unknown>) =>
  Cause.hasInterrupts(cause)
    ? Effect.interrupt
    : Effect.fail(
        new ProviderError({
          message: "Could not save operation progress. The change will be retried.",
        }),
      );
export const makeOpQueueStore = ({ sql }: { sql: SqlClient.SqlClient }) => {
  // Outgoing change queue

  const enqueueOp = Effect.fn("Store.enqueueOp")(function* (
    account: string,
    providerId: string,
    op: QueuedOp,
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* run(sql`INSERT INTO pending_ops (account_id, provider_id, op_json, created_at, rfc_message_id)
        VALUES (${account}, ${providerId}, ${JSON.stringify(op)}, ${now}, (SELECT rfc_message_id FROM messages WHERE account_id=${account} AND provider_id=${providerId} ORDER BY date DESC LIMIT 1))`);
  });

  const listPendingOps = all(PendingOpRow)(
    sql`SELECT ${sql.literal(PENDING_OP_COLUMNS)}
        FROM pending_ops ORDER BY id`,
  ).pipe(Effect.map(toPendingOps), Effect.withSpan("Store.listPendingOps"));

  const pendingOpsForMessages: Store["Service"]["pendingOpsForMessages"] = (
    ownerId,
    providerIds,
  ) =>
    providerIds.length === 0
      ? Effect.succeed([])
      : all(PendingOpRow)(
          sql`SELECT ${sql.literal(PENDING_OP_COLUMNS)}
          FROM pending_ops WHERE account_id=${ownerId} AND provider_id IN ${sql.in(providerIds)} ORDER BY id`,
        ).pipe(Effect.map(toPendingOps), Effect.withSpan("Store.pendingOpsForMessages"));

  const claimPendingOp = Effect.fn("Store.claimPendingOp")(function* (id: number, token: string) {
    const now = yield* Clock.currentTimeMillis;
    const row = yield* first(Id)(sql`UPDATE pending_ops SET claimed_at=${now}, claim_token=${token}
        WHERE id=${id} AND retry_at <= ${now} AND (claimed_at IS NULL OR claimed_at < ${now - CLAIM_TTL}) RETURNING id`);
    return Option.isSome(row);
  });

  const ownsPendingOp = (id: number, token: string) =>
    first(Id)(sql`SELECT id FROM pending_ops WHERE id=${id} AND claim_token=${token}`).pipe(
      Effect.map(Option.isSome),
    );

  const renewPendingOp = Effect.fn("Store.renewPendingOp")(function* (id: number, token: string) {
    const now = yield* Clock.currentTimeMillis;
    return Option.isSome(
      yield* first(Id)(
        sql`UPDATE pending_ops SET claimed_at=${now} WHERE id=${id} AND claim_token=${token} RETURNING id`,
      ),
    );
  });

  const claimCondition = (token?: string) =>
    token === undefined ? sql.literal("AND claim_token IS NULL") : sql`AND claim_token=${token}`;

  const removePendingOp = Effect.fn("Store.removePendingOp")((id: number, token?: string) =>
    run(sql`DELETE FROM pending_ops WHERE id=${id} ${claimCondition(token)}`),
  );

  const releasePendingOp = Effect.fn("Store.releasePendingOp")((id: number, token?: string) =>
    run(
      sql`UPDATE pending_ops SET claimed_at=NULL, claim_token=NULL WHERE id=${id} ${claimCondition(token)}`,
    ),
  );

  const failPendingOp = Effect.fn("Store.failPendingOp")(function* (
    id: number,
    error: string,
    token?: string,
    offline = false,
  ) {
    const now = yield* Clock.currentTimeMillis;
    // The attempt count lives in SQL, so the jitter factor is applied there.
    const factor = 1 - (yield* Random.next) * JITTER;
    yield* run(
      sql`UPDATE pending_ops SET retry_at=${now} + CAST(MIN(3600000, 5000 * (1 << MIN(attempts, 10))) * ${factor} AS INTEGER), retry_offline=${offline ? 1 : 0}, attempts=attempts+1, last_error=${error}, claimed_at=NULL, claim_token=NULL WHERE id=${id} ${claimCondition(token)}`,
    );
  });

  /** The network came back: ops that failed offline are due now and keep their attempt count. */
  const retryPendingOpsNow = Effect.fn("Store.retryPendingOpsNow")(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* run(
      sql`UPDATE pending_ops SET retry_at=${now} WHERE retry_offline=1 AND retry_at > ${now}`,
    );
  });

  const recordCopyProgress: Store["Service"]["recordCopyProgress"] = (
    id,
    token,
    destination,
    providerId,
    phase,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const row = yield* first(CopyProgressRow)(
            sql`SELECT progress_json FROM pending_ops WHERE id=${id} AND claim_token=${token}`,
          );
          const saved = yield* Option.match(row, {
            onNone: () =>
              Effect.fail(
                new ProviderError({
                  message: "The queued operation is no longer owned by this worker",
                }),
              ),
            onSome: (current) => Effect.succeed(current.progress_json),
          });
          const issued = JSON.stringify([providerId, destination]);
          const accepted = JSON.stringify([providerId, destination, "accepted"]);
          const progress = new Set(saved);
          if (phase === "clear") {
            progress.delete(issued);
            progress.delete(accepted);
          } else {
            progress.add(issued);
            if (phase === "accepted") progress.add(accepted);
          }
          yield* run(
            sql`UPDATE pending_ops SET progress_json=${JSON.stringify([...progress])} WHERE id=${id} AND claim_token=${token}`,
          );
        }),
      )
      .pipe(Effect.catchCause(progressFailure));

  const recordAppendedMessageId: Store["Service"]["recordAppendedMessageId"] = (
    id,
    token,
    messageId,
  ) =>
    first(Id)(
      sql`UPDATE pending_ops SET appended_message_id=${messageId} WHERE id=${id} AND claim_token=${token} RETURNING id`,
    ).pipe(
      Effect.flatMap((row) =>
        Option.isSome(row)
          ? Effect.void
          : Effect.fail(
              new ProviderError({
                message: "The queued draft is no longer owned by this worker",
              }),
            ),
      ),
      Effect.catchCause(progressFailure),
    );

  const recordFailedOp: Store["Service"]["recordFailedOp"] = Effect.fn("Store.recordFailedOp")(
    function* (entry) {
      const now = yield* Clock.currentTimeMillis;
      yield* run(sql`INSERT INTO failed_ops(account_id,provider_id,at,kind,reason,subject,sender,rejected_json)
        VALUES (${entry.accountId},${entry.providerId},${now},${entry.kind},${entry.reason},
          COALESCE(${entry.subject ?? null},(SELECT subject FROM messages WHERE account_id=${entry.accountId} AND provider_id=${entry.providerId} ORDER BY date DESC LIMIT 1),(SELECT json_extract(message_json,'$.subject') FROM drafts WHERE account_id=${entry.accountId} AND id=${entry.providerId})),
          COALESCE(${entry.sender ?? null},(SELECT from_addr FROM messages WHERE account_id=${entry.accountId} AND provider_id=${entry.providerId} ORDER BY date DESC LIMIT 1),(SELECT email FROM accounts WHERE id=${entry.accountId})),
          ${JSON.stringify(entry.rejected ?? [])})`);
    },
  );

  const FAILED_COLUMNS = sql.literal(
    "id,account_id AS accountId,provider_id AS providerId,at,kind,reason,subject,sender",
  );

  const listFailedOps = all(FailedOp)(
    sql`SELECT ${FAILED_COLUMNS} FROM failed_ops ORDER BY id DESC`,
  );

  const getFailedOp = Effect.fn("Store.getFailedOp")(function* (id: number) {
    const row = yield* first(FailedOpDetailRow)(
      sql`SELECT ${FAILED_COLUMNS},rejected_json FROM failed_ops WHERE id=${id}`,
    );
    if (Option.isNone(row)) return yield* new NotFound({ what: "draft", id: String(id) });
    const { rejected_json, ...notice } = row.value;
    return { notice, rejected: rejected_json };
  });

  const acknowledgeFailedOps = (ids: readonly number[]) =>
    ids.length ? run(sql`DELETE FROM failed_ops WHERE id IN ${sql.in(ids)}`) : Effect.void;
  return {
    enqueueOp,
    listPendingOps,
    pendingOpsForMessages,
    claimPendingOp,
    ownsPendingOp,
    renewPendingOp,
    recordFailedOp,
    getFailedOp,
    recordCopyProgress,
    recordAppendedMessageId,
    listFailedOps,
    acknowledgeFailedOps,
    releasePendingOp,
    removePendingOp,
    failPendingOp,
    retryPendingOpsNow,
    sendUncertain: (id) =>
      first(Schema.Struct({ key: Schema.String }))(
        sql`SELECT key FROM prefs WHERE key=${`send-uncertain:${id}`}`,
      ).pipe(Effect.map(Option.isSome)),
    setSendUncertain: (id, value) =>
      value
        ? run(
            sql`INSERT INTO prefs(key,value_json) VALUES(${`send-uncertain:${id}`},'true') ON CONFLICT(key) DO NOTHING`,
          )
        : run(sql`DELETE FROM prefs WHERE key=${`send-uncertain:${id}`}`),
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
      const row = yield* first(Schema.Struct({ key: Schema.String }))(
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
      yield* run(
        sql`UPDATE prefs SET value_json=json_set(value_json,'$.claimedAt',${now})
          WHERE key=${SMTP_ACCEPTED + draftId} AND json_valid(value_json)
            AND json_extract(value_json,'$.claim')=${token}`,
      );
    }),
    releaseSmtpAccepted: (draftId, token) =>
      run(
        sql`UPDATE prefs SET value_json=json_remove(value_json,'$.claim','$.claimedAt')
          WHERE key=${SMTP_ACCEPTED + draftId} AND json_valid(value_json)
            AND json_extract(value_json,'$.claim')=${token}`,
      ),
    clearSmtpAccepted: (draftId) =>
      run(sql`DELETE FROM prefs WHERE key=${SMTP_ACCEPTED + draftId}`),
    noteSentCopyFailure: Effect.fn("Store.noteSentCopyFailure")(function* (
      draftId: string,
      message: { subject: string; sender: string },
    ) {
      const now = yield* Clock.currentTimeMillis;
      const row = yield* first(Schema.Struct({ key: Schema.String }))(
        sql`UPDATE prefs SET value_json=json_remove(json_set(value_json,
          '$.tries', COALESCE(json_extract(value_json,'$.tries'),0)+1,
          '$.lastTryAt', ${now},
          '$.subject', COALESCE(json_extract(value_json,'$.subject'),${message.subject}),
          '$.sender', COALESCE(json_extract(value_json,'$.sender'),${message.sender})),
          '$.claim','$.claimedAt')
        WHERE key=${SMTP_ACCEPTED + draftId} AND json_valid(value_json) RETURNING key`,
      );
      return Option.isSome(row);
    }),
  } satisfies Pick<
    Store["Service"],
    | "enqueueOp"
    | "listPendingOps"
    | "pendingOpsForMessages"
    | "claimPendingOp"
    | "ownsPendingOp"
    | "renewPendingOp"
    | "recordFailedOp"
    | "getFailedOp"
    | "recordCopyProgress"
    | "recordAppendedMessageId"
    | "listFailedOps"
    | "acknowledgeFailedOps"
    | "releasePendingOp"
    | "removePendingOp"
    | "failPendingOp"
    | "retryPendingOpsNow"
    | "sendUncertain"
    | "setSendUncertain"
    | "smtpAccepted"
    | "markSmtpAccepted"
    | "claimSmtpAccepted"
    | "renewSmtpAccepted"
    | "releaseSmtpAccepted"
    | "clearSmtpAccepted"
    | "noteSentCopyFailure"
  >;
};
