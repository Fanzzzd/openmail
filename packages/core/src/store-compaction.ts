import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { CacheCompactionResult } from "./cache.js";

/** Reserve the connection without a transaction: VACUUM cannot run in one. */
export function makeCompactionStore(
  sql: SqlClient.SqlClient,
  worker?: import("./platform/cache-storage.js").CacheMaintenanceService,
) {
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
        // All implicit-rowid FTS content tables must have an explicit INTEGER
        // PRIMARY KEY. Merely having a TEXT primary key is not a guarantee.
        for (const table of [
          "messages",
          "contact_candidates",
          "contact_organizations",
          "derived_chunks",
        ]) {
          const keys = yield* execute(
            `SELECT name FROM pragma_table_info('${table}') WHERE upper(type)='INTEGER' AND pk=1`,
          );
          if (keys.length !== 1 || keys[0]?.[0] !== (table === "derived_chunks" ? "id" : "rowid"))
            return "unsafe";
        }
        for (const table of [
          "messages_fts",
          "derived_fts",
          "contact_candidates_fts",
          "contact_organizations_fts",
        ]) {
          const check = yield* Effect.result(
            execute(`INSERT INTO ${table}(${table},rank) VALUES('integrity-check',1)`),
          );
          if (check._tag === "Failure") return "unsafe";
        }
        for (const table of ["messages_words", "derived_words"])
          yield* execute(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`);
        if (mode[0]?.[0] === 0) {
          yield* execute("PRAGMA auto_vacuum = INCREMENTAL");
          yield* execute("VACUUM");
        } else {
          yield* execute("PRAGMA auto_vacuum = INCREMENTAL");
          yield* execute("PRAGMA incremental_vacuum");
        }
        for (const table of [
          "messages_fts",
          "derived_fts",
          "contact_candidates_fts",
          "contact_organizations_fts",
        ])
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
