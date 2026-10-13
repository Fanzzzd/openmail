import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { all, first } from "./sql-rows.js";

const LocalHealth = Schema.Struct({
  total: Schema.Number,
  cachedTotal: Schema.Number,
  unmirroredDraftTotal: Schema.Number,
  unread: Schema.Number,
  threads: Schema.Number,
  label: Schema.NullOr(Schema.String),
  pendingOps: Schema.Number,
});
export function makeSyncHealthStore(sql: SqlClient.SqlClient) {
  const syncHealthLocal = (accountId: string, scope: string, imap: boolean) => {
    // IMAP identities are UIDVALIDITY:UID:path. The rest after the first two
    // colons is the exact path, including any colons in that path.
    const path = sql.literal(
      "substr(m.provider_id, instr(m.provider_id, ':') + instr(substr(m.provider_id, instr(m.provider_id, ':') + 1), ':') + 1)",
    );
    const within = imap
      ? sql`${path}=${scope}`
      : sql`EXISTS(SELECT 1 FROM json_each(m.labels_json) WHERE value=${scope})`;
    const orphanDrafts =
      !imap && scope === "DRAFT"
        ? sql`(SELECT COUNT(DISTINCT d.remote_message_id) FROM drafts d
          WHERE d.account_id=${accountId} AND d.remote_message_id IS NOT NULL AND d.local_only=0 AND d.sync_error IS NULL
          AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.account_id=d.account_id AND m.provider_id=d.remote_message_id))`
        : sql.literal("0");
    return first(
      LocalHealth,
    )(sql`SELECT COUNT(*) AS cachedTotal, ${orphanDrafts} AS unmirroredDraftTotal, COUNT(*) + ${orphanDrafts} AS total, COALESCE(SUM(m.is_unread),0) AS unread, COUNT(DISTINCT m.thread_id) + ${orphanDrafts} AS threads,
      MIN(json_extract(m.labels_json,'$[0]')) AS label,
      (SELECT COUNT(*) FROM pending_ops p WHERE p.account_id=${accountId} AND p.provider_id IN (SELECT m.provider_id FROM messages m WHERE m.account_id=${accountId} AND ${within})) AS pendingOps
      FROM messages m WHERE m.account_id=${accountId} AND ${within}`).pipe(
      Effect.map(Option.getOrThrow),
    );
  };
  const syncHealthLabels = (accountId: string, observed: boolean) =>
    all(Schema.Struct({ id: Schema.String }))(
      sql`SELECT id FROM labels WHERE account_id=${accountId} ${observed ? sql`UNION SELECT DISTINCT j.value AS id FROM messages m,json_each(m.labels_json) j WHERE m.account_id=${accountId}` : sql.literal("")}`,
    ).pipe(Effect.map((rows) => rows.map((row) => row.id)));
  return { syncHealthLocal, syncHealthLabels };
}
