import { Effect, Layer, Schema, Semaphore, Stream } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient, SqlConnection, SqlError, Statement } from "effect/sql";
import { DatabaseCapabilities, migrate } from "../../db/db.js";

// Structural op-sqlite port: core never imports React Native or its native modules.
export type SqliteScalar = string | number | boolean | null | ArrayBuffer | ArrayBufferView;
export interface OpSqliteDatabase {
  execute(
    query: string,
    params?: SqliteScalar[],
  ): Promise<{
    rows: Record<string, SqliteScalar>[];
    rowsAffected: number;
    insertId?: number;
  }>;
  executeRaw(
    query: string,
    params?: SqliteScalar[],
  ): Promise<{
    rawRows: SqliteScalar[][];
    columnNames: string[];
    rowsAffected: number;
    insertId?: number;
  }>;
  close(): void;
}

const scalar = (value: unknown): SqliteScalar => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  )
    return value;
  throw new Error("Unsupported op-sqlite bind parameter");
};
const sqlError = (cause: unknown) =>
  new SqlError.SqlError({
    reason: SqlError.classifySqliteError(cause, {
      message: "op-sqlite statement failed",
      operation: "execute",
    }),
  });
const Version = Schema.Struct({ version: Schema.String });

/** SQLite 3.34.0 introduced FTS5 trigram. Probe the actual build before migrating. */
export const validateSqlite = (db: OpSqliteDatabase) =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise({
      try: () => db.execute("SELECT sqlite_version() AS version"),
      catch: sqlError,
    });
    const { version } = yield* Schema.decodeUnknownEffect(Version)(rows.rows[0]).pipe(Effect.orDie);
    const [major = 0, minor = 0] = version.split(".").map(Number);
    if (major < 3 || (major === 3 && minor < 34)) {
      yield* Effect.die(new Error("Mobile requires SQLite >= 3.34.0 with FTS5 trigram"));
    }
    yield* Effect.tryPromise({
      try: async () => {
        await db.execute(
          "CREATE VIRTUAL TABLE temp.openmail_fts_probe USING fts5(text, tokenize='trigram')",
        );
        await db.execute("DROP TABLE temp.openmail_fts_probe");
        await db.execute("PRAGMA journal_mode = WAL");
      },
      catch: sqlError,
    });
  });

export const makeOpSqliteClient = (open: () => OpSqliteDatabase | Promise<OpSqliteDatabase>) =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: async () => open(), catch: sqlError }),
      (connection) => Effect.sync(() => connection.close()),
    );
    yield* validateSqlite(db).pipe(Effect.uninterruptible);
    const execute = (query: string, params: readonly unknown[]) =>
      Effect.tryPromise({
        try: () => db.execute(query, params.map(scalar)),
        catch: sqlError,
      }).pipe(Effect.uninterruptible);
    const executeRaw = (query: string, params: readonly unknown[]) =>
      Effect.tryPromise({
        try: () => db.executeRaw(query, params.map(scalar)),
        catch: sqlError,
      }).pipe(Effect.uninterruptible);
    const executeValues = (query: string, params: readonly unknown[]) =>
      executeRaw(query, params).pipe(Effect.map((result) => result.rawRows));
    const connection: SqlConnection.Connection = {
      execute: (query, params, transform) =>
        execute(query, params).pipe(
          Effect.map((result) => (transform ? transform(result.rows) : result.rows)),
        ),
      executeUnprepared: (query, params, transform) =>
        execute(query, params).pipe(
          Effect.map((result) => (transform ? transform(result.rows) : result.rows)),
        ),
      executeRaw: (query, params) =>
        executeRaw(query, params).pipe(
          Effect.map((result) =>
            result.columnNames.length
              ? result.rawRows.map((row) =>
                  Object.fromEntries(result.columnNames.map((name, index) => [name, row[index]])),
                )
              : { changes: result.rowsAffected, lastInsertRowid: result.insertId },
          ),
        ),
      executeValues,
      executeValuesUnprepared: executeValues,
      executeStream: () => Stream.die(new Error("op-sqlite streaming queries are unsupported")),
    };
    const acquirers = SqlClient.makeSqliteAcquirers({
      connection: Effect.succeed(connection),
      semaphore: yield* Semaphore.make(1),
    });
    return yield* SqlClient.make({
      ...acquirers,
      compiler: Statement.makeCompilerSqlite(),
      beginTransaction: "BEGIN IMMEDIATE",
      releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
      spanAttributes: [["db.system.name", "sqlite"]],
    });
  });

/** One scoped, serialized connection; the unchanged core migrations run before Store construction. */
export const opSqliteLayer = (open: () => OpSqliteDatabase | Promise<OpSqliteDatabase>) => {
  const client = Layer.effect(
    SqlClient.SqlClient,
    makeOpSqliteClient(open).pipe(Effect.orDie),
  ).pipe(Layer.provide(Reactivity.layer));
  return Layer.effect(
    DatabaseCapabilities,
    migrate.pipe(Effect.orDie, Effect.as(DatabaseCapabilities.of({ vectors: false }))),
  ).pipe(Layer.provideMerge(client));
};
