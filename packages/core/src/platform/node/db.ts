import { chmodSync, closeSync, existsSync, openSync, statSync } from "node:fs";
import { logWarning } from "../../domain/diagnostic-log.js";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, FileSystem, Layer, Path } from "effect";
import { constVoid } from "effect/Function";
import { SqlClient } from "effect/sql";
import { DatabaseCapabilities } from "../../db/capabilities.js";
import {
  BUSY_TIMEOUT_MS,
  DatabaseTooNewError,
  migrateTo,
  optimizeOnOpen,
} from "../../db/migrate.js";
import { MIGRATIONS, ROWID_REBUILD_MIGRATION } from "../../db/migrations.js";
import { nodeCacheMaintenance } from "./cache-maintenance.js";
import { registerDatabaseLease } from "./database-access.js";
import { checkDatabaseUpgradeSpace } from "./database-upgrade.js";
import { openDatabaseAccess } from "./recovery-files.js";

/** A separate read-only handle sees the file before SqliteClient changes journal mode or schema. */
function inspectReadOnly(filename: string, inspect: (db: DatabaseSync) => void) {
  // Another process may hold the lock briefly (a sibling CLI migrating or recovering the WAL);
  // wait like the main connection's busy timeout instead of failing with "database is locked".
  const inspection = new DatabaseSync(filename, { readOnly: true, timeout: 5000 });
  try {
    inspect(inspection);
  } finally {
    inspection.close();
  }
}

/**
 * mail.db is created before SQLite opens it so it never exists with the umask's
 * mode, and SQLite gives -wal, -shm and -journal the mode of the database.
 * Files left by older versions are tightened too. Runs after interrupted
 * recovery is handled, which treats a missing mail.db specially.
 */
function restrictDatabaseFiles(filename: string) {
  closeSync(openSync(filename, "a", 0o600));
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(`${filename}${suffix}`)) chmodSync(`${filename}${suffix}`, 0o600);
}

/** Retries a busy worker for up to two minutes; any other outcome than "done" is fatal. */
const upgradeRowidsInWorker = (filename: string) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 120_000;
    let waiting = false;
    let result;
    do {
      result = yield* nodeCacheMaintenance.run({
        file: resolve(filename),
        kind: "upgrade",
        script: MIGRATIONS[ROWID_REBUILD_MIGRATION] ?? "",
        version: ROWID_REBUILD_MIGRATION + 1,
      });
      if (result !== "busy") break;
      if (!waiting) {
        waiting = true;
        yield* Effect.logInfo("Waiting for another process to finish database migrations");
      }
      yield* Effect.sleep("100 millis");
    } while (Date.now() < deadline);
    // The worker logs why a "failed" upgrade failed; only "low-disk" is about space.
    if (result !== "done")
      yield* Effect.die(
        new Error(
          result === "busy"
            ? "The local database is busy. Close other OpenMail processes and try the upgrade again."
            : result === "low-disk"
              ? "Could not upgrade the local database. Check free disk space and try again."
              : "Could not upgrade the local database. Try again, and report a bug with the log if it keeps failing.",
        ),
      );
  });

export interface DatabaseOptions {
  /** Paint a responsive startup state before the rowid rewrite worker starts. */
  readonly onDatabaseUpgrade?: () => Promise<() => void>;
  /**
   * This process owns the mailbox (the desktop app): refresh planner statistics on every open.
   * Other openers (CLI, MCP) refresh them only after a migration or when none exist.
   */
  readonly plannerStatsOwner?: boolean;
  /** Resolve the local extension. Passing null intentionally disables vectors. */
  readonly vectorExtension?: (() => string) | null;
  /**
   * How long a statement waits for another process's write lock, from the end of the migrations
   * on. Defaults to BUSY_TIMEOUT_MS. Lock tests lengthen it so a regression that waits it out
   * stands far above the time a process takes to start.
   */
  readonly busyTimeoutMs?: number;
}

export function databaseLayer(
  filename: string,
  options: DatabaseOptions = {},
): Layer.Layer<
  SqlClient.SqlClient | SqliteClient.SqliteClient | DatabaseCapabilities,
  never,
  FileSystem.FileSystem | Path.Path
> {
  // The folder holding mail.db is created or tightened to owner-only before anything is written.
  // Errors stay PlatformErrors so the CLI can explain an unusable OPENMAIL_HOME.
  const ensureDir = Effect.gen(function* () {
    if (filename === ":memory:") return;
    const fs = yield* FileSystem.FileSystem;
    const folder = (yield* Path.Path).dirname(filename);
    yield* Effect.orDie(fs.makeDirectory(folder, { recursive: true, mode: 0o700 }));
    // A folder the user does not own keeps its mode; the files are still private.
    yield* fs.chmod(folder, 0o700).pipe(Effect.ignore);
  });
  const initialize = Effect.gen(function* () {
    // Earlier migrations are small. The rowid rebuild uses a separate worker
    // before Store is exposed, while this connection stays reserved.
    const before = yield* SqlClient.SqlClient;
    const initial = yield* before`PRAGMA user_version`;
    const opened = Number(initial[0]?.user_version ?? 0);
    yield* Effect.orDie(
      opened === 0 ? migrateTo(MIGRATIONS.length) : migrateTo(ROWID_REBUILD_MIGRATION),
    );
    const version = yield* before`PRAGMA user_version`;
    if (filename !== ":memory:" && version[0]?.user_version === ROWID_REBUILD_MIGRATION) {
      yield* Effect.sync(() => inspectReadOnly(filename, checkDatabaseUpgradeSpace));
      const dismiss = options.onDatabaseUpgrade
        ? yield* Effect.promise(options.onDatabaseUpgrade)
        : constVoid;
      yield* Effect.gen(function* () {
        yield* before.reserve;
        yield* upgradeRowidsInWorker(filename);
      }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(dismiss)));
    }
    yield* Effect.orDie(migrateTo(MIGRATIONS.length));
    // migrateTo sets BUSY_TIMEOUT_MS; the refresh below restores whatever is set here.
    if (options.busyTimeoutMs !== undefined && options.busyTimeoutMs !== BUSY_TIMEOUT_MS)
      yield* Effect.orDie(
        before.unsafe(`PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs)}`).unprepared,
      );
    yield* optimizeOnOpen({
      owner: options.plannerStatsOwner === true,
      migrated: opened < MIGRATIONS.length,
    });
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
      // Writes take the write lock, so they run only when there is work: a CLI
      // or MCP start must not wait for the app's writer on every open.
      const existing = yield* sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE name IN ('derived_text_vectors', 'derived_image_vectors')`;
      if (existing.length < 2) {
        yield* sql`CREATE VIRTUAL TABLE IF NOT EXISTS derived_text_vectors USING vec0(embedding float[384])`;
        yield* sql`CREATE VIRTUAL TABLE IF NOT EXISTS derived_image_vectors USING vec0(embedding float[512])`;
      }
      // A connection without vec0 can delete messages. Clean orphaned vectors
      // when a capable connection next opens the database.
      const orphans = yield* sql`SELECT 1 FROM derived_text_vectors
        WHERE rowid NOT IN (SELECT id FROM vector_items)
        UNION ALL SELECT 1 FROM derived_image_vectors
        WHERE rowid NOT IN (SELECT id FROM vector_items) LIMIT 1`;
      if (orphans.length > 0) {
        yield* sql`DELETE FROM derived_text_vectors WHERE rowid NOT IN (SELECT id FROM vector_items)`;
        yield* sql`DELETE FROM derived_image_vectors WHERE rowid NOT IN (SELECT id FROM vector_items)`;
      }
      return true;
    }).pipe(
      Effect.catch(() =>
        logWarning(
          "vector-search-unavailable",
          "sqlite-vec unavailable; mail and media text search remain enabled",
        ).pipe(Effect.as(false)),
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
            try {
              restrictDatabaseFiles(filename);
            } catch (error) {
              lease.release();
              throw error;
            }
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
        yield* Effect.sync(() =>
          inspectReadOnly(filename, (inspection) => {
            const version = Number(inspection.prepare("PRAGMA user_version").get()?.user_version);
            if (version > MIGRATIONS.length) throw new DatabaseTooNewError(version);
            if (version > 0 && version <= ROWID_REBUILD_MIGRATION)
              checkDatabaseUpgradeSpace(inspection);
          }),
        );
      }
      // Since 4.0.1 a failed open is a typed SqlError. Opening the local
      // database has no recovery path here, so it stays a defect as before.
      return Layer.effect(DatabaseCapabilities, initialize.pipe(Effect.orDie)).pipe(
        Layer.provideMerge(
          Layer.orDie(
            SqliteClient.layer({ filename, busyTimeout: options.busyTimeoutMs ?? BUSY_TIMEOUT_MS }),
          ),
        ),
      );
    }),
  );
}

export { MIGRATIONS } from "../../db/migrations.js";
export { splitStatements } from "../../db/migrate.js";
export { DatabaseCapabilities } from "../../db/capabilities.js";
