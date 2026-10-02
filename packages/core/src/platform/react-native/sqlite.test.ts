import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Effect, Fiber, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { MIGRATIONS, migrate } from "../../db.js";
import { Store } from "../../services.js";
import { StoreLive } from "../../store.js";
import { IncomingMessage } from "../../domain.js";
import { opSqliteLayer, type OpSqliteDatabase, type SqliteScalar } from "./sqlite.js";

const bind = (value: SqliteScalar): SQLInputValue => {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return Number(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
};
// Same Promise API and result shapes as op-sqlite, backed by real node:sqlite.
function shim(): { open: () => OpSqliteDatabase; closed: () => boolean } {
  let closed = false;
  return {
    closed: () => closed,
    open: () => {
      const db = new DatabaseSync(":memory:");
      return {
        execute: async (query, params = []) => {
          const statement = db.prepare(query);
          if (statement.columns().length) {
            // SQLite's declared row result is an IO boundary.
            const rows = statement.all(...params.map(bind)) as Record<string, SqliteScalar>[];
            return { rows, rowsAffected: 0 };
          }
          const result = statement.run(...params.map(bind));
          return {
            rows: [],
            rowsAffected: Number(result.changes),
            insertId: Number(result.lastInsertRowid),
          };
        },
        executeRaw: async (query, params = []) => {
          const statement = db.prepare(query);
          const columns = statement.columns();
          if (!columns.length) {
            const result = statement.run(...params.map(bind));
            return {
              rawRows: [],
              columnNames: [],
              rowsAffected: Number(result.changes),
              insertId: Number(result.lastInsertRowid),
            };
          }
          const rows = statement.all(...params.map(bind)) as Record<string, SqliteScalar>[];
          return {
            rowsAffected: 0,
            columnNames: columns.map((column) => column.name),
            rawRows: rows.map((row) => columns.map((column) => row[column.name] ?? null)),
          };
        },
        close: () => {
          db.close();
          closed = true;
        },
      };
    },
  };
}
const Count = Schema.Struct({ n: Schema.Number });
const sample = (id: string, date = 1) =>
  Schema.decodeUnknownSync(IncomingMessage)({
    providerId: id,
    threadId: id,
    subject: "portable needle",
    from: { name: "Test", address: "a@example.test" },
    to: [],
    cc: [],
    date,
    snippet: "needle",
    bodyText: "mobile trigram needle",
    bodyHtml: "",
    labels: ["INBOX"],
    isUnread: true,
    isStarred: false,
    hasAttachments: false,
    attachments: [],
  });

describe("op-sqlite contract", () => {
  it("runs every unchanged migration, reopens migration idempotently, and supports FTS upserts and keyset paging", async () => {
    const db = shim();
    const layer = StoreLive.pipe(Layer.provideMerge(opSqliteLayer(db.open)));
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* Store;
        const versions = yield* sql`PRAGMA user_version`;
        expect(versions[0]).toEqual({ user_version: MIGRATIONS.length });
        yield* migrate;
        const account = yield* store.upsertAccount("gmail", "a@example.test");
        yield* store.upsertMessage(account.id, sample("one"));
        const ids = yield* sql`SELECT rowid FROM messages`;
        yield* store.upsertMessage(account.id, { ...sample("one"), bodyText: "updated needle" });
        expect(yield* sql`SELECT rowid FROM messages`).toEqual(ids);
        const count =
          yield* sql`SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'needle'`;
        expect(Schema.decodeUnknownSync(Count)(count[0]).n).toBe(1);
        yield* sql`INSERT INTO messages_fts(messages_fts) VALUES ('integrity-check')`;
        yield* store.upsertMessage(account.id, sample("two"));
        const first = yield* store.listThreads({
          accountIds: [account.id],
          label: "INBOX",
          limit: 1,
        });
        const last = first[0];
        if (!last) throw new Error("Missing first page");
        const next = yield* store.listThreads({
          accountIds: [account.id],
          label: "INBOX",
          limit: 1,
          before: last.date,
          beforeId: last.id,
        });
        expect(next).toHaveLength(1);
        expect(next[0]?.id).not.toBe(last.id);
      }).pipe(Effect.provide(layer), Effect.scoped),
    );
    expect(db.closed()).toBe(true);
  });

  it("rolls back failures and nested savepoints, and serializes concurrent transactions", async () => {
    const db = shim();
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE counter (n INTEGER NOT NULL)`;
        yield* sql`INSERT INTO counter VALUES (0)`;
        const failure = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE counter SET n = 100`;
              yield* Effect.fail("rollback");
            }),
          )
          .pipe(Effect.result);
        expect(failure._tag).toBe("Failure");
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE counter SET n = n + 1`;
            yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql`UPDATE counter SET n = 100`;
                  yield* Effect.fail("nested rollback");
                }),
              )
              .pipe(Effect.result);
          }),
        );
        yield* Effect.forEach(
          [1, 2, 3],
          () =>
            sql.withTransaction(
              Effect.gen(function* () {
                const before = yield* sql`SELECT n FROM counter`;
                const n = Schema.decodeUnknownSync(Count)(before[0]).n;
                yield* Effect.sleep("1 millis");
                yield* sql`UPDATE counter SET n = ${n + 1}`;
              }),
            ),
          { concurrency: "unbounded" },
        );
        expect(yield* sql`SELECT n FROM counter`).toEqual([{ n: 4 }]);
        expect(yield* sql`SELECT n FROM counter`.values).toEqual([[4]]);
        expect(yield* sql`SELECT n FROM counter WHERE n = 99`.raw).toEqual([]);
        expect(yield* sql`UPDATE counter SET n = n + 1`.raw).toMatchObject({ changes: 1 });
        expect(yield* sql`SELECT n FROM counter`.withoutTransform).toEqual([{ n: 5 }]);
      }).pipe(Effect.provide(opSqliteLayer(db.open)), Effect.scoped),
    );
    expect(db.closed()).toBe(true);
  });

  it("waits for an in-flight native statement before interrupt rollback and closing", async () => {
    const db = shim();
    let release: () => void = () => {
      throw new Error("Statement was not started");
    };
    let notify: () => void = () => {
      throw new Error("Statement waiter was not set");
    };
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const open = () => {
      const native = db.open();
      return {
        ...native,
        execute: async (query: string, params?: SqliteScalar[]) => {
          if (query.startsWith("INSERT INTO interrupt_test")) {
            notify();
            await waiting;
          }
          return native.execute(query, params);
        },
      };
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE interrupt_test (n INTEGER)`;
        const writer = yield* Effect.forkChild(
          sql.withTransaction(sql`INSERT INTO interrupt_test VALUES (1)`),
        );
        yield* Effect.promise(() => started);
        const interrupt = yield* Effect.forkChild(Fiber.interrupt(writer));
        yield* Effect.sleep("1 millis");
        yield* Effect.sync(release);
        yield* Fiber.join(interrupt);
        expect(yield* sql`SELECT n FROM interrupt_test`).toEqual([]);
      }).pipe(Effect.provide(opSqliteLayer(open)), Effect.scoped),
    );
    expect(db.closed()).toBe(true);
  });

  it("rolls back a COMMIT rejected by a deferred foreign key, then reuses the connection", async () => {
    const db = shim();
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE commit_parent (id INTEGER PRIMARY KEY)`;
        yield* sql`CREATE TABLE commit_child (id INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
        const result = yield* sql
          .withTransaction(sql`INSERT INTO commit_child VALUES (7)`)
          .pipe(Effect.exit);
        expect(result._tag).toBe("Failure");
        expect(yield* sql`SELECT id FROM commit_child`).toEqual([]);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO commit_parent VALUES (7)`;
            yield* sql`INSERT INTO commit_child VALUES (7)`;
          }),
        );
        expect(yield* sql`SELECT id FROM commit_child`).toEqual([{ id: 7 }]);
      }).pipe(Effect.provide(opSqliteLayer(db.open)), Effect.scoped),
    );
    expect(db.closed()).toBe(true);
  });

  it("recovers when a failed COMMIT already aborted the native transaction", async () => {
    const db = shim();
    let failCommit = false;
    const open = () => {
      const native = db.open();
      return {
        ...native,
        execute: async (query: string, params?: SqliteScalar[]) => {
          if (query === "COMMIT" && failCommit) {
            failCommit = false;
            await native.execute("ROLLBACK");
            throw new Error("SQLITE_FULL during COMMIT (transaction automatically rolled back)");
          }
          return native.execute(query, params);
        },
      };
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE commit_recovery (n INTEGER)`;
        failCommit = true;
        const result = yield* sql
          .withTransaction(sql`INSERT INTO commit_recovery VALUES (1)`)
          .pipe(Effect.exit);
        expect(result._tag).toBe("Failure");
        expect(yield* sql`SELECT n FROM commit_recovery`).toEqual([]);
        yield* sql.withTransaction(sql`INSERT INTO commit_recovery VALUES (2)`);
        expect(yield* sql`SELECT n FROM commit_recovery`).toEqual([{ n: 2 }]);
      }).pipe(Effect.provide(opSqliteLayer(open)), Effect.scoped),
    );
    expect(db.closed()).toBe(true);
  });

  it("closes the database when FTS5 trigram is unavailable", async () => {
    let closed = false;
    const failing: OpSqliteDatabase = {
      execute: async (query) => {
        if (query.startsWith("SELECT sqlite_version"))
          return { rows: [{ version: "3.53.4" }], rowsAffected: 0 };
        throw new Error("no such tokenizer: trigram");
      },
      executeRaw: () => Promise.reject(new Error("unused")),
      close: () => {
        closed = true;
      },
    };
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* SqlClient.SqlClient;
        }),
      ).pipe(Effect.provide(opSqliteLayer(() => failing)), Effect.exit),
    );
    expect(result._tag).toBe("Failure");
    expect(closed).toBe(true);
  });
});
