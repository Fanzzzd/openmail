import { Effect, Option, Schema } from "effect";
import { type SqlClient } from "effect/sql";
import { InvalidInput } from "./errors.js";
import { applyOpToLabels } from "./mail-ops.js";
import { type Store } from "./services.js";
import { all, first, run } from "./sql-rows.js";

import { type makeQueryStore } from "./store-query.js";

export const makeRemindersStore = ({
  sql,
  getAccount,
  getMessage,
  getThread,
  messageRef,
  hasLabel,
}: {
  sql: SqlClient.SqlClient;
  getAccount: Store["Service"]["getAccount"];
  getMessage: Store["Service"]["getMessage"];
  getThread: Store["Service"]["getThread"];
  messageRef: Store["Service"]["messageRef"];
  hasLabel: ReturnType<typeof makeQueryStore>["hasLabel"];
}) => {
  const snooze = Effect.fn("Store.snooze")(function* (id: string, due: number) {
    const message = yield* getMessage(id);
    const previous = yield* all(Schema.Struct({ id: Schema.String }))(
      sql`SELECT m.id FROM snoozed_messages s JOIN messages m ON m.account_id=s.account_id AND m.provider_id=s.provider_id WHERE s.account_id=${message.accountId} AND s.thread_id=${message.threadId}`,
    );
    const targets = (yield* getThread(id)).filter(
      (member) =>
        !member.labels.some((l) => ["DRAFT", "TRASH", "SPAM"].includes(l)) &&
        (member.labels.includes("INBOX") ||
          (member.labels.includes("SNOOZED") && previous.some((p) => member.id === p.id))),
    );
    if (!targets.length) yield* new InvalidInput({ message: "Only inbox messages can be snoozed" });
    yield* run(sql`INSERT INTO thread_reminders (account_id, thread_id, due_at, woken_at)
        VALUES (${message.accountId}, ${message.threadId}, ${due}, NULL)
        ON CONFLICT(account_id, thread_id) DO UPDATE SET due_at=excluded.due_at, woken_at=NULL, wake_pending=0`);
    yield* run(
      sql`DELETE FROM snoozed_messages WHERE account_id=${message.accountId} AND thread_id=${message.threadId}`,
    );
    const owner = yield* getAccount(message.accountId);
    for (const member of targets) {
      const { providerId } = yield* messageRef(member.id);
      yield* run(
        sql`INSERT INTO snoozed_messages (account_id, thread_id, provider_id) VALUES (${message.accountId}, ${message.threadId}, ${providerId})`,
      );
      const labels = [
        ...applyOpToLabels(
          member.labels.filter((l) => l !== "SNOOZED"),
          { kind: "archive" },
          owner.provider,
        ),
        "SNOOZED",
      ];
      yield* run(
        sql`UPDATE messages SET labels_json=${JSON.stringify(labels)} WHERE id=${member.id}`,
      );
    }
  });

  const reminderSnapshot: Store["Service"]["reminderSnapshot"] = (id) =>
    Effect.gen(function* () {
      const message = yield* getMessage(id);
      const reminder = yield* first(
        Schema.Struct({
          due_at: Schema.NullOr(Schema.Number),
          woken_at: Schema.NullOr(Schema.Number),
          wake_pending: Schema.BooleanFromBit,
        }),
      )(
        sql`SELECT due_at,woken_at,wake_pending FROM thread_reminders WHERE account_id=${message.accountId} AND thread_id=${message.threadId}`,
      );
      if (Option.isNone(reminder)) return Option.none();
      const members = yield* all(
        Schema.Struct({ provider_id: Schema.String, wake_pending: Schema.BooleanFromBit }),
      )(
        sql`SELECT provider_id,wake_pending FROM snoozed_messages WHERE account_id=${message.accountId} AND thread_id=${message.threadId}`,
      );
      return Option.some({
        accountId: message.accountId,
        threadId: message.threadId,
        dueAt: reminder.value.due_at,
        wokenAt: reminder.value.woken_at,
        wakePending: reminder.value.wake_pending,
        members: members.map((member) => ({
          providerId: member.provider_id,
          wakePending: member.wake_pending,
        })),
      });
    });

  const restoreReminder: Store["Service"]["restoreReminder"] = (snapshot) =>
    Effect.gen(function* () {
      yield* run(sql`INSERT INTO thread_reminders (account_id,thread_id,due_at,woken_at,wake_pending)
        VALUES (${snapshot.accountId},${snapshot.threadId},${snapshot.dueAt},${snapshot.wokenAt},${snapshot.wakePending ? 1 : 0})
        ON CONFLICT(account_id,thread_id) DO UPDATE SET due_at=excluded.due_at,woken_at=excluded.woken_at,wake_pending=excluded.wake_pending`);
      yield* run(
        sql`DELETE FROM snoozed_messages WHERE account_id=${snapshot.accountId} AND thread_id=${snapshot.threadId}`,
      );
      for (const member of snapshot.members) {
        yield* run(sql`INSERT INTO snoozed_messages (account_id,thread_id,provider_id,wake_pending)
          VALUES (${snapshot.accountId},${snapshot.threadId},${member.providerId},${member.wakePending ? 1 : 0})`);
        if (snapshot.dueAt !== null)
          yield* run(sql`UPDATE messages AS m SET labels_json=json_insert(labels_json,'$[#]','SNOOZED')
          WHERE account_id=${snapshot.accountId} AND provider_id=${member.providerId} AND NOT ${hasLabel("SNOOZED")}`);
      }
    });
  return { snooze, reminderSnapshot, restoreReminder } satisfies Pick<
    Store["Service"],
    "snooze" | "reminderSnapshot" | "restoreReminder"
  >;
};
