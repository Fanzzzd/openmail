import { existsSync, statSync } from "node:fs";
import { checkDatabaseUpgradeSpace } from "./database-upgrade.js";
import { DatabaseSync } from "node:sqlite";
import { nodeCacheMaintenance } from "./cache-maintenance.js";
import { registerDatabaseLease } from "./database-access.js";
import { resolve } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, FileSystem, Layer, Path } from "effect";
import { SqlClient } from "effect/sql";
import { DatabaseCapabilities, migrate, migrateTo, MIGRATIONS } from "../../db.js";
import { openDatabaseAccess } from "./recovery-files.js";
export interface DatabaseOptions {
  /** Paint a responsive startup state before the rowid rewrite worker starts. */
  readonly onDatabaseUpgrade?: () => Promise<() => void>;
  /** Resolve the local extension. Passing null intentionally disables vectors. */
  readonly vectorExtension?: (() => string) | null;
}

export function databaseLayer(
  filename: string,
  options: DatabaseOptions = {},
): Layer.Layer<
  SqlClient.SqlClient | SqliteClient.SqliteClient | DatabaseCapabilities,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const ensureDir = Effect.gen(function* () {
    if (filename === ":memory:") return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* Effect.orDie(fs.makeDirectory(path.dirname(filename), { recursive: true }));
  });
  const initialize = Effect.gen(function* () {
    // Earlier migrations are small. The rowid rebuild uses a separate worker
    // before Store is exposed, while this connection stays reserved.
    const before = yield* SqlClient.SqlClient;
    const initial = yield* before`PRAGMA user_version`;
    yield* Effect.orDie(initial[0]?.user_version === 0 ? migrate : migrateTo(36));
    const version = yield* before`PRAGMA user_version`;
    if (filename !== ":memory:" && version[0]?.user_version === 36) {
      yield* Effect.sync(() => {
        const inspection = new DatabaseSync(filename, { readOnly: true });
        try {
          checkDatabaseUpgradeSpace(inspection);
        } finally {
          inspection.close();
        }
      });
      const dismiss = options.onDatabaseUpgrade
        ? yield* Effect.promise(options.onDatabaseUpgrade)
        : () => {
            /* No startup window or external lease to dismiss. */
          };
      yield* Effect.gen(function* () {
        yield* before.reserve;
        const deadline = Date.now() + 120_000;
        let waiting = false;
        let result;
        do {
          result = yield* nodeCacheMaintenance.run({
            file: resolve(filename),
            kind: "upgrade",
            script: MIGRATIONS[36] ?? "",
            version: 37,
          });
          if (result !== "busy") break;
          if (!waiting) {
            waiting = true;
            yield* Effect.logInfo("Waiting for another process to finish database migrations");
          }
          yield* Effect.sleep("100 millis");
        } while (Date.now() < deadline);
        if (result !== "done")
          yield* Effect.die(
            new Error(
              result === "busy"
                ? "The local database is busy. Close other OpenMail processes and try the upgrade again."
                : "Could not upgrade the local database. Check free disk space and try again.",
            ),
          );
      }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(dismiss)));
    }
    yield* Effect.orDie(migrate);
    const sqlite = yield* SqliteClient.SqliteClient;
    const sql = yield* SqlClient.SqlClient;
    const vectors = yield* Effect.gen(function* () {
      if (options.vectorExtension === null) return false;
      const path = options.vectorExtension
        ? yield* Effect.try(options.vectorExtension)
        : yield* Effect.tryPromise(async () => (await import("sqlite-vec")).getLoadablePath());
      // SQLite dlopen bypasses Electron's ASAR filesystem wrapper.
      yield* sqlite.loadExtension(
        path.replace(/([/\\])app\.asar([/\\])/u, "$1app.asar.unpacked$2"),
      );
      yield* sql`CREATE VIRTUAL TABLE IF NOT EXISTS derived_text_vectors USING vec0(embedding float[384])`;
      yield* sql`CREATE VIRTUAL TABLE IF NOT EXISTS derived_image_vectors USING vec0(embedding float[512])`;
      // A connection without vec0 can delete messages. Clean orphaned vectors
      // when a capable connection next opens the database.
      yield* sql`DELETE FROM derived_text_vectors WHERE rowid NOT IN (SELECT id FROM vector_items)`;
      yield* sql`DELETE FROM derived_image_vectors WHERE rowid NOT IN (SELECT id FROM vector_items)`;
      return true;
    }).pipe(
      Effect.catch(() =>
        Effect.logWarning("sqlite-vec unavailable; mail and media text search remain enabled").pipe(
          Effect.as(false),
        ),
      ),
    );
    return DatabaseCapabilities.of({ vectors });
  });
  return Layer.unwrap(
    Effect.gen(function* () {
      yield* ensureDir;
      if (filename !== ":memory:")
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const lease = openDatabaseAccess(filename);
            const unregister = registerDatabaseLease(resolve(filename), lease);
            return {
              release: () => {
                unregister();
                lease.release();
              },
            };
          }),
          (access) => Effect.sync(() => access.release()),
        );
      // Inspect before SqliteClient can switch journal mode or apply any DDL.
      if (filename !== ":memory:" && existsSync(filename) && statSync(filename).size > 0) {
        yield* Effect.sync(() => {
          const inspection = new DatabaseSync(filename, { readOnly: true });
          try {
            const version = Number(inspection.prepare("PRAGMA user_version").get()?.user_version);
            if (version > 0 && version <= 36) checkDatabaseUpgradeSpace(inspection);
          } finally {
            inspection.close();
          }
        });
      }
      return Layer.effect(DatabaseCapabilities, initialize.pipe(Effect.orDie)).pipe(
        Layer.provideMerge(SqliteClient.layer({ filename, busyTimeout: 5000 })),
      );
    }),
  );
}

export { MIGRATIONS, splitStatements, DatabaseCapabilities } from "../../db.js";
