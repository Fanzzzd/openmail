/** Runs MIGRATIONS on the SqlClient the platform driver provides. */

import { Clock, Effect, Schema } from "effect";
import { MIGRATIONS, ROWID_REBUILD_MIGRATION } from "./migrations.js";
import { SqlClient } from "effect/sql";
import { isSqlError } from "effect/sql/SqlError";

/**
 * Splits a migration into statements. node:sqlite has no exec through the
 * Effect client, and `prepare` silently drops everything after the first
 * statement. A `;` ends a statement unless it sits in a string, a comment or
 * a CREATE TRIGGER body, which runs to its closing `END;`. A CASE ... END
 * right before a `;` inside a trigger body would confuse this; no migration
 * has one.
 */
export function splitStatements(script: string): string[] {
  const out: string[] = [];
  let start = 0;
  // The statement so far without comments and string contents, for the
  // trigger check.
  let code = "";
  let i = 0;
  while (i < script.length) {
    const c = script[i];
    const skipTo = (end: number) => (end === -1 ? script.length : end);
    if (c === "'" || c === '"' || c === "`") {
      // A doubled quote ('') reads as two adjacent strings, which is fine here.
      i = skipTo(script.indexOf(c, i + 1)) + 1;
      code += "''";
    } else if (c === "-" && script[i + 1] === "-") {
      i = skipTo(script.indexOf("\n", i));
    } else if (c === "/" && script[i + 1] === "*") {
      i = skipTo(script.indexOf("*/", i + 2)) + 2;
    } else {
      code += c;
      i++;
      if (c === ";" && !(isTrigger(code) && !/\bEND\s*;$/i.test(code))) {
        const statement = script.slice(start, i).trim();
        if (code.trim() !== ";") out.push(statement);
        start = i;
        code = "";
      }
    }
  }
  if (code.trim()) out.push(script.slice(start).trim());
  return out;
}

const isTrigger = (code: string) => /^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(code);

/** All migration runners use this boundary, outside their transaction. */
export function withMigrationForeignKeys<A, E, E2, R>(
  execute: (statement: string) => Effect.Effect<unknown, E>,
  work: Effect.Effect<A, E2, R>,
): Effect.Effect<A, E | E2, R> {
  return Effect.gen(function* () {
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ foreign_keys: Schema.Number })),
    )(yield* execute("PRAGMA foreign_keys")).pipe(Effect.orDie);
    const enabled = rows[0]?.foreign_keys ?? 1;
    yield* execute("PRAGMA foreign_keys = OFF");
    return yield* work.pipe(
      Effect.ensuring(execute(`PRAGMA foreign_keys = ${enabled}`).pipe(Effect.orDie)),
    );
  }).pipe(Effect.uninterruptible);
}

/** How long a statement waits for another connection's lock before SQLITE_BUSY. */
export const BUSY_TIMEOUT_MS = 5000;

const UserVersion = Schema.Struct({ user_version: Schema.Number });

/**
 * The database has migrations this build does not know: a newer OpenMail opened it. Running
 * against it could misread or corrupt tables, so every entry point refuses to open it.
 */
export class DatabaseTooNewError extends Error {
  constructor(
    readonly version: number,
    readonly supported: number = MIGRATIONS.length,
  ) {
    super("This library was opened by a newer OpenMail. Update OpenMail to open it.");
    this.name = "DatabaseTooNewError";
  }
}

/**
 * Runs pending migrations, one transaction each. The version is read inside
 * the transaction (BEGIN IMMEDIATE holds the write lock), so the app and the
 * CLI opening an old database at the same moment never run a step twice.
 */
export const migrateTo = (targetVersion: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Per connection, and a no-op inside a transaction, so they go first. The
    // app, the CLI and a restarting app can share the file; wait for a lock
    // instead of failing at once.
    yield* sql.unsafe(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`).unprepared;
    yield* sql`PRAGMA journal_size_limit = 8388608`;
    yield* sql`PRAGMA foreign_keys = ON`;
    const initialVersion = yield* sql`PRAGMA user_version`;
    const opened = Number(initialVersion[0]?.user_version ?? 0);
    if (opened > MIGRATIONS.length) yield* Effect.die(new DatabaseTooNewError(opened));
    if (opened === 0) yield* sql`PRAGMA auto_vacuum=INCREMENTAL`;
    const step = sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql`PRAGMA user_version`;
        const { user_version: version } = yield* Schema.decodeUnknownEffect(UserVersion)(rows[0]);
        if (version >= targetVersion) return false;
        const migration = MIGRATIONS[version];
        if (migration === undefined) return false;
        for (const statement of splitStatements(migration)) yield* sql.unsafe(statement).unprepared;
        if (version === ROWID_REBUILD_MIGRATION) {
          const violations = yield* sql`PRAGMA foreign_key_check`;
          if (violations.length)
            return yield* Effect.die(new Error("Cache rowid migration violates foreign keys"));
        }
        yield* sql.unsafe(`PRAGMA user_version = ${version + 1}`).unprepared;
        return true;
      }),
    );
    const deadline = (yield* Clock.currentTimeMillis) + 120_000;
    let waiting = false;
    for (;;) {
      const rows = yield* sql`PRAGMA user_version`;
      const { user_version: version } = yield* Schema.decodeUnknownEffect(UserVersion)(rows[0]);
      if (version >= targetVersion) break;
      // Keep the FK boundary outside the transaction even if a peer advances
      // the version while we wait. Migration 37 preserves all rowids.
      const result = yield* Effect.result(
        withMigrationForeignKeys((statement) => sql.unsafe(statement).unprepared, step),
      );
      if (result._tag === "Success") {
        if (!result.success) break;
        continue;
      }
      const error = result.failure;
      if (
        !isSqlError(error) ||
        error.reason._tag !== "LockTimeoutError" ||
        (yield* Clock.currentTimeMillis) >= deadline
      )
        yield* Effect.fail(error);
      if (!waiting) {
        waiting = true;
        yield* Effect.logInfo("Waiting for another process to finish database migrations", {
          version,
          targetVersion,
          deadlineMs: 120_000,
        });
      }
      yield* Effect.sleep("100 millis");
    }
  });

/**
 * Refreshes planner statistics where SQLite thinks they are missing or stale.
 * Without them the planner can pick a date index over the thread index and
 * turn a thread page into a scan per row. `analysis_limit` bounds each ANALYZE
 * to a sample, so this costs milliseconds on a large mailbox. `0x10002` also
 * checks tables this connection has not queried yet, which is what a fresh
 * connection needs; the periodic call uses the default mask.
 *
 * ANALYZE needs the write lock. The connection is reserved so no other
 * statement runs with the short `busyTimeoutMs`, and the normal timeout is
 * restored afterwards. A busy or read-only database skips the refresh instead
 * of waiting behind another process's writer.
 */
export const optimizeQueryPlanner = (options: { mask?: number; busyTimeoutMs: number }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const connection = yield* sql.reserve;
    const run = (statement: string) => connection.executeUnprepared(statement, [], undefined);
    yield* run(`PRAGMA busy_timeout = ${options.busyTimeoutMs}`);
    yield* Effect.gen(function* () {
      yield* run("PRAGMA analysis_limit=400");
      yield* run(
        options.mask === undefined ? "PRAGMA optimize" : `PRAGMA optimize=${options.mask}`,
      );
    }).pipe(
      Effect.ignore,
      Effect.ensuring(run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`).pipe(Effect.ignore)),
    );
  }).pipe(Effect.scoped, Effect.ignore);

const hasPlannerStats = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1'`;
  return rows.length > 0;
});

/**
 * The on-open refresh, which never waits for a lock another process holds. It
 * runs when this open needs it: the process that owns the mailbox (the desktop
 * app) asks for it with `owner`, and any opener runs it after a schema change
 * or when no statistics exist yet. A CLI or MCP start on an analyzed database
 * skips it, so it never contends with the app for the write lock.
 */
export const optimizeOnOpen = (options: { owner: boolean; migrated: boolean }) =>
  Effect.gen(function* () {
    if (options.owner || options.migrated || !(yield* hasPlannerStats))
      yield* optimizeQueryPlanner({ mask: 0x10002, busyTimeoutMs: 0 });
  }).pipe(Effect.ignore);

/** Migrates and refreshes statistics as the mailbox owner does. */
export const migrate = migrateTo(MIGRATIONS.length).pipe(
  Effect.andThen(optimizeOnOpen({ owner: true, migrated: true })),
);
