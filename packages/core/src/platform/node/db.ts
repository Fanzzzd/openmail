import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, FileSystem, Layer, Path } from "effect";
import { SqlClient } from "effect/sql";
import { DatabaseCapabilities, migrate } from "../../db.js";
import { openDatabaseAccess } from "./recovery-files.js";
export interface DatabaseOptions {
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
          Effect.sync(() => openDatabaseAccess(filename)),
          (access) => Effect.sync(() => access.release()),
        );
      return Layer.effect(DatabaseCapabilities, initialize).pipe(
        Layer.provideMerge(SqliteClient.layer({ filename, busyTimeout: 5000 })),
      );
    }),
  );
}

export { MIGRATIONS, splitStatements, DatabaseCapabilities } from "../../db.js";
