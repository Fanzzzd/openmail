import { Clock, Effect, Option, Schema } from "effect";
import { type SqlClient } from "effect/sql";
import { isSqlError } from "effect/sql/SqlError";
import { type MessageSummary, type NotificationBatch } from "../domain/domain.js";
import { type Store } from "../services.js";
import { all, first, run } from "./sql-rows.js";
import { type makeComposeStore } from "./store-compose.js";
import { SUMMARY_COLUMNS } from "./store-query.js";
import { NotificationActionRow, summaryRowFields, toSummary } from "./store-rows.js";
import { notificationEligible, profileNotificationsActive } from "../system.js";

const NOTIFICATION_RETENTION = 7 * 86_400_000;

const MAX_PENDING_NOTIFICATIONS = 1000;

const IMMEDIATE_NOTIFICATION_AGE = 5 * 60_000;
export const makeNotificationsStore = ({
  sql,
  compose,
  listAccounts,
}: {
  sql: SqlClient.SqlClient;
  compose: ReturnType<typeof makeComposeStore>;
  listAccounts: Store["Service"]["listAccounts"];
}) => {
  const pruneNotifications = (now: number) =>
    Effect.gen(function* () {
      yield* run(
        sql`DELETE FROM pending_notifications WHERE enqueued_at < ${now - NOTIFICATION_RETENTION}`,
      );
      yield* run(sql`DELETE FROM pending_notifications WHERE message_id IN (
        SELECT message_id FROM pending_notifications ORDER BY enqueued_at DESC,rowid DESC
        LIMIT -1 OFFSET ${MAX_PENDING_NOTIFICATIONS})`);
    });

  const enqueueNotification = (id: string, digest: boolean) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* run(sql`INSERT INTO pending_notifications (message_id,digest,enqueued_at)
          VALUES (${id},${digest ? 1 : 0},${now}) ON CONFLICT(message_id) DO NOTHING`);
          yield* pruneNotifications(now);
        }),
      )
      .pipe(Effect.catchIf(isSqlError, (error) => Effect.die(error)));

  const takeNotifications = (now: number) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* pruneNotifications(now);
          const pending = yield* all(
            Schema.Struct({
              ...summaryRowFields,
              digest: Schema.BooleanFromBit,
              enqueued_at: Schema.Number,
            }),
          )(sql`SELECT ${sql.literal(SUMMARY_COLUMNS)},n.digest,n.enqueued_at FROM pending_notifications n
              JOIN messages m ON m.id=n.message_id ORDER BY n.rowid`);
          const accounts = yield* listAccounts;
          const prefs = yield* compose.prefs;
          const batches = new Map<
            string,
            {
              kind: NotificationBatch["kind"];
              profileId: string | null;
              messages: MessageSummary[];
            }
          >();
          for (const entry of pending) {
            const message = toSummary(entry);
            const account = accounts.find((a) => a.id === message.accountId);
            if (account && notificationEligible(account, message, prefs)) {
              if (!profileNotificationsActive(account, prefs, new Date(now))) {
                if (!entry.digest)
                  yield* run(
                    sql`UPDATE pending_notifications SET digest=1 WHERE message_id=${message.id} AND digest=0`,
                  );
                continue;
              }
              const digest = entry.digest || now - entry.enqueued_at >= IMMEDIATE_NOTIFICATION_AGE;
              const kind = digest ? "digest" : "immediate";
              // A digest spans the Profile, including its multiple accounts.
              const key = JSON.stringify([kind, digest ? account.profileId : account.id]);
              const batch = batches.get(key) ?? {
                kind,
                profileId: account.profileId,
                messages: [],
              };
              batch.messages.push(message);
              batches.set(key, batch);
            }
            // Read, archived, disabled or delivered arrivals must never notify later.
            yield* run(sql`DELETE FROM pending_notifications WHERE message_id=${message.id}`);
          }
          return [...batches.values()];
        }),
      )
      .pipe(Effect.catchIf(isSqlError, (error) => Effect.die(error)));
  return {
    rememberNotificationActions: (id, actions) =>
      run(sql`INSERT INTO notification_buttons(message_id,actions_json)
        SELECT id, ${JSON.stringify(actions)} FROM messages WHERE id=${id}
        ON CONFLICT(message_id) DO UPDATE SET actions_json=excluded.actions_json`),
    notificationActions: (id) =>
      first(NotificationActionRow)(
        sql`SELECT actions_json AS actions FROM notification_buttons WHERE message_id=${id}`,
      ).pipe(
        Effect.map((row) =>
          Option.match(row, { onSome: (r) => r.actions, onNone: () => ["archive", "trash"] }),
        ),
      ),
    enqueueNotification,
    takeNotifications,
  } satisfies Pick<
    Store["Service"],
    | "rememberNotificationActions"
    | "notificationActions"
    | "enqueueNotification"
    | "takeNotifications"
  >;
};
