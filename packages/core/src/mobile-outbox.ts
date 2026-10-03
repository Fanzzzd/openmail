import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { attachmentBytes, attachmentProblem, type AttachmentProblem } from "./attachment-policy.js";
import type { OutgoingAttachment, Provider } from "./domain.js";
import { OutgoingMessage } from "./domain.js";
import { all, run } from "./sql-rows.js";

export const MOBILE_ATTACHMENT_LIMIT = 15 * 1024 * 1024;
export function mobileAttachmentProblem(
  provider: Provider,
  attachments: readonly OutgoingAttachment[],
): AttachmentProblem | { kind: "mobileSize" } | undefined {
  return (
    attachmentProblem(provider, attachments) ??
    (attachments.reduce((sum, file) => sum + attachmentBytes(file.content), 0) >
    MOBILE_ATTACHMENT_LIMIT
      ? { kind: "mobileSize" }
      : undefined)
  );
}

export const QueuedSend = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  message: OutgoingMessage,
  due: Schema.Finite,
  status: Schema.Literals(["waiting", "sending", "failed", "rejected"]),
});
export type QueuedSend = typeof QueuedSend.Type;
const Row = Schema.Struct({ value_json: Schema.fromJsonString(QueuedSend) });
/** Durable app send intents use existing preference storage. Sending claims survive restarts;
 * an interrupted or failed delivery needs human review instead of risking a duplicate. */
export function makeOutboxStore(sql: SqlClient.SqlClient) {
  const queuedSends = all(Row)(
    sql`SELECT value_json FROM prefs WHERE key LIKE 'mobile-outbox:%' ORDER BY key`,
  ).pipe(Effect.map((rows) => rows.map((row) => row.value_json)));
  const putQueuedSend = (item: QueuedSend) =>
    run(sql`INSERT INTO prefs (key,value_json)
    VALUES (${`mobile-outbox:${item.id}`},${JSON.stringify(item)})
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`);
  const deleteQueuedSend = (id: string) =>
    run(sql`DELETE FROM prefs WHERE key=${`mobile-outbox:${id}`}`);
  return { queuedSends, putQueuedSend, deleteQueuedSend };
}
