import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { optimizeQueryPlanner } from "../db/migrate.js";
import type { AccountOpCounts } from "../domain/diagnostics-state.js";
import { all } from "./sql-rows.js";

const Version = Schema.Struct({ user_version: Schema.Number });
const OpCounts = Schema.Struct({
  account_id: Schema.String,
  pending: Schema.Number,
  retrying: Schema.Number,
  failed: Schema.Number,
});
const SendCounts = Schema.Struct({
  account_id: Schema.NullOr(Schema.String),
  sends: Schema.Number,
});

/** Counts for the diagnostics snapshot. No row content leaves this module. */
export function makeDiagnosticsStore(sql: SqlClient.SqlClient) {
  const diagnosticCounts = (now: number) =>
    Effect.gen(function* () {
      const version = yield* all(Version)(sql`PRAGMA user_version`);
      const ops = yield* all(OpCounts)(
        sql`SELECT account_id, COUNT(*) AS pending,
          COALESCE(SUM(retry_at > ${now}),0) AS retrying,
          COALESCE(SUM(attempts > 0 OR last_error IS NOT NULL),0) AS failed
        FROM pending_ops GROUP BY account_id`,
      );
      const sends = yield* all(SendCounts)(
        sql`SELECT json_extract(value_json,'$.accountId') AS account_id, COUNT(*) AS sends
        FROM prefs WHERE key LIKE 'mobile-outbox:%' GROUP BY 1`,
      );
      return {
        schemaVersion: version[0]?.user_version ?? 0,
        ops: new Map<string, AccountOpCounts>(ops.map((row) => [row.account_id, row])),
        queuedSends: new Map(
          sends.flatMap((row): [string, number][] =>
            row.account_id === null ? [] : [[row.account_id, row.sends]],
          ),
        ),
      };
    }).pipe(Effect.withSpan("Store.diagnosticCounts"));
  /** Cheap when statistics are current; the sync loop calls it hourly. */
  const refreshPlannerStats = optimizeQueryPlanner().pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.withSpan("Store.refreshPlannerStats"),
  );
  return { diagnosticCounts, refreshPlannerStats };
}
