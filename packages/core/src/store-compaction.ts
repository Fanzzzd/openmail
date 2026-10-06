import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { CacheCompactionResult } from "./cache.js";
import type { CacheMaintenanceService } from "./platform/cache-storage.js";

// All implicit-rowid FTS content tables must have an explicit INTEGER
// PRIMARY KEY. Merely having a TEXT primary key is not a guarantee.
const ROWID_KEYS = [
  ["messages", "rowid"],
  ["contact_candidates", "rowid"],
  ["contact_organizations", "rowid"],
  ["derived_chunks", "id"],
] as const;
const FTS_TABLES = [
  "messages_fts",
  "derived_fts",
  "contact_candidates_fts",
  "contact_organizations_fts",
] as const;

/** Reserve the connection without a transaction: VACUUM cannot run in one. */
export function makeCompactionStore(sql: SqlClient.SqlClient, worker?: CacheMaintenanceService) {
  const maintenance = (full: boolean, readOnly: boolean): Effect.Effect<CacheCompactionResult> => {
    if (readOnly) return Effect.succeed("read-only");
    return Effect.gen(function* () {
      const connection = yield* sql.reserve;
      const execute = (statement: string) => connection.executeValuesUnprepared(statement, []);
      const files = yield* execute("SELECT file FROM pragma_database_list WHERE name='main'");
      const file = files[0]?.[0];
      if (typeof file === "string" && file)
        return yield* (
          worker?.run({ file, kind: "compact", full }) ?? Effect.succeed("unavailable" as const)
        );
      const mode = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Tuple([Schema.Number])))(
        yield* execute("PRAGMA auto_vacuum"),
      );
      if (full) {
        for (const [table, key] of ROWID_KEYS) {
          const keys = yield* execute(
            `SELECT name FROM pragma_table_info('${table}') WHERE upper(type)='INTEGER' AND pk=1`,
          );
          if (keys.length !== 1 || keys[0]?.[0] !== key) return "unsafe";
        }
        for (const table of FTS_TABLES) {
          const check = yield* Effect.result(
            execute(`INSERT INTO ${table}(${table},rank) VALUES('integrity-check',1)`),
          );
          if (check._tag === "Failure") return "unsafe";
        }
        for (const table of ["messages_words", "derived_words"])
          yield* execute(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`);
        yield* execute("PRAGMA auto_vacuum = INCREMENTAL");
        yield* execute(mode[0]?.[0] === 0 ? "VACUUM" : "PRAGMA incremental_vacuum");
        for (const table of FTS_TABLES)
          yield* execute(`INSERT INTO ${table}(${table},rank) VALUES('integrity-check',1)`);
      } else if (mode[0]?.[0] === 2) {
        yield* execute("PRAGMA incremental_vacuum");
      }
      yield* execute("PRAGMA wal_checkpoint(TRUNCATE)");
      return "done";
    }).pipe(
      Effect.scoped,
      Effect.uninterruptible,
      Effect.catch(() => Effect.succeed("failed" as const)),
    );
  };
  return {
    compactCache: (readOnly: boolean) => maintenance(true, readOnly),
    reclaimCachePages: maintenance(false, false).pipe(Effect.asVoid),
  };
}
