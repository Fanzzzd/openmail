/** Runs MIGRATIONS on the SqlClient the platform driver provides. */

import { Cause, Clock, Effect, Schema } from "effect";
import { type PlannerStatsSkippedDiagnostic, throttledWarning } from "../domain/diagnostic-log.js";
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
const BusyTimeout = Schema.Struct({ timeout: Schema.Number });

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

/** `PRAGMA optimize`'s default mask; bit 0x01 makes it list the ANALYZE statements instead. */
const OPTIMIZE_DEFAULT_MASK = 0xfffe;

/**
 * Refreshes planner statistics where SQLite thinks they are missing or stale.
 * Without them the planner can pick a date index over the thread index and
 * turn a thread page into a scan per row. `analysis_limit` bounds each ANALYZE
 * to a sample, so this costs milliseconds on a large mailbox. `0x10002` also
 * checks tables this connection has not queried yet, which is what a fresh
 * connection needs; the periodic call uses the default mask.
 *
 * Internal tables of FTS5 and vec0 are never analyzed, and statistics an older
 * version wrote for them are removed (they take effect from the next open). An
 * empty FTS5 index has 2 rows in its %_data table; with that count recorded the
 * planner reads every later segment lookup as a scan, and inserting 60k
 * messages slowed from 5 s to 4 minutes per 10k. Their internal statements
 * look rows up by key and need no statistics.
 *
 * ANALYZE needs the write lock. The connection is reserved so no other
 * statement runs with the short `busyTimeoutMs`, and the normal timeout is
 * restored afterwards. A busy or read-only database skips the refresh instead
 * of waiting behind another process's writer.
 */
export const optimizeQueryPlanner = (options: {
  mask?: number;
  busyTimeoutMs: number;
  /** Log a skipped refresh (planner-stats-skipped). Off where a busy database is expected. */
  report?: boolean;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const connection = yield* sql.reserve;
    const run = (statement: string) => connection.executeUnprepared(statement, [], undefined);
    const previous = yield* Schema.decodeUnknownEffect(Schema.Array(BusyTimeout))(
      yield* run("PRAGMA busy_timeout"),
    );
    const restore = previous[0]?.timeout ?? BUSY_TIMEOUT_MS;
    yield* run(`PRAGMA busy_timeout = ${options.busyTimeoutMs}`);
    yield* Effect.gen(function* () {
      yield* run("PRAGMA analysis_limit=400");
      const tables = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String })),
      )(yield* run("PRAGMA main.table_list"));
      // vec0 does not declare %_vector_chunksNN as a shadow table, so match the prefix too.
      const virtual = tables.filter((table) => table.type === "virtual").map((t) => `${t.name}_`);
      const internal = new Set(
        tables
          .filter(
            (table) =>
              table.type === "shadow" || virtual.some((prefix) => table.name.startsWith(prefix)),
          )
          .map((table) => table.name),
      );
      const planned = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ optimize: Schema.String })),
      )(yield* run(`PRAGMA optimize=${(options.mask ?? OPTIMIZE_DEFAULT_MASK) | 1}`));
      for (const { optimize } of planned) {
        const table = /^ANALYZE "main"\."((?:[^"]|"")+)"$/
          .exec(optimize)?.[1]
          ?.replaceAll('""', '"');
        if (table !== undefined && !internal.has(table))
          yield* run(`ANALYZE "main"."${table.replaceAll('"', '""')}"`);
      }
      if (internal.size && tables.some((table) => table.name === "sqlite_stat1"))
        yield* run(
          `DELETE FROM sqlite_stat1 WHERE tbl IN (SELECT value FROM json_each('${JSON.stringify([...internal]).replaceAll("'", "''")}'))`,
        );
    }).pipe(Effect.ensuring(run(`PRAGMA busy_timeout = ${restore}`).pipe(Effect.ignore)));
  }).pipe(
    Effect.scoped,
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : options.report === false
          ? Effect.void
          : plannerStatsSkipped({
              _tag: "PlannerStatsSkippedDiagnostic",
              reason: "planner-stats-skipped",
              ...sqliteCode(cause),
            } satisfies PlannerStatsSkippedDiagnostic),
    ),
  );

/** A refresh that is always busy or read-only shows up in diagnostics, once an hour at most. */
const plannerStatsSkipped = throttledWarning("planner-stats-skipped", 60 * 60_000);

/** The SQLite result code (5 busy, 8 read-only) in a failure, from node:sqlite's `errcode`. */
const sqliteCode = (cause: Cause.Cause<unknown>): { code?: number } => {
  const seen = new Set<unknown>();
  const find = (value: unknown): number | undefined => {
    if (typeof value !== "object" || value === null || seen.has(value)) return undefined;
    seen.add(value);
    const code = Reflect.get(value, "errcode");
    if (typeof code === "number" && Number.isSafeInteger(code)) return code;
    return find(Reflect.get(value, "cause"));
  };
  for (const reason of cause.reasons) {
    const code = find(
      Cause.isFailReason(reason)
        ? reason.error
        : Cause.isDieReason(reason)
          ? reason.defect
          : undefined,
    );
    if (code !== undefined) return { code };
  }
  return {};
};

/**
 * Whether the planner has statistics for `messages`. Opening a new mailbox records only the
 * small tables, so the check is for the table every list and search reads.
 */
export const plannerStatsPresent = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* sql`SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1'`).length) return false;
  return (yield* sql`SELECT 1 FROM sqlite_stat1 WHERE tbl = 'messages' LIMIT 1`).length > 0;
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
    if (options.owner || options.migrated || !(yield* plannerStatsPresent))
      // A CLI or MCP start next to the app's writer is expected to find it busy; only the
      // mailbox owner's skipped refresh is worth a diagnostics line.
      yield* optimizeQueryPlanner({ mask: 0x10002, busyTimeoutMs: 0, report: options.owner });
  }).pipe(Effect.ignore);

/** Migrates and refreshes statistics as the mailbox owner does. */
export const migrate = migrateTo(MIGRATIONS.length).pipe(
  Effect.andThen(optimizeOnOpen({ owner: true, migrated: true })),
);
