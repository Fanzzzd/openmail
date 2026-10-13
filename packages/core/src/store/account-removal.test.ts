import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { IncomingMessage } from "../domain/domain.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { Store } from "./service.js";
import { StoreLive } from "./store.js";
import { AUDIT_LOG_ROWS } from "./store-policy.js";

const withStore = <A, E>(body: Effect.Effect<A, E, Store | SqlClient.SqlClient>) =>
  body.pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform()))));

const message = (providerId: string): IncomingMessage => ({
  providerId,
  threadId: "t1",
  subject: "Quarterly report",
  from: { name: "Alice", address: "alice@example.com" },
  to: [{ name: "Bob", address: "bob@example.com" }],
  cc: [],
  date: 1_000,
  snippet: "",
  bodyText: "numbers",
  bodyHtml: "",
  labels: ["INBOX", "SENT"],
  attachments: [],
  isUnread: true,
  isStarred: false,
});

const Name = Schema.Struct({ name: Schema.String });
const Column = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  notnull: Schema.Number,
  dflt_value: Schema.NullOr(Schema.String),
});
const ForeignKey = Schema.Struct({ table: Schema.String, from: Schema.String, to: Schema.String });
const Count = Schema.Struct({ n: Schema.Number });
const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.Array(schema));

/** Every ordinary table with an account_id column, read from the live schema. */
const accountTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* decode(Name)(
    yield* sql`SELECT m.name FROM sqlite_master m
      WHERE m.type='table' AND m.sql NOT LIKE 'CREATE VIRTUAL%'
        AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) c WHERE c.name='account_id')
      ORDER BY m.name`,
  )).map((row) => row.name);
});

const countFor = (table: string, account: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* decode(Count)(
      yield* sql`SELECT count(*) AS n FROM ${sql(table)} WHERE account_id=${account}`,
    );
    return row?.n ?? 0;
  });

/**
 * Adds a row for `account` to `table`. Foreign keys take a value from the
 * account's existing parent row; other required columns get a placeholder.
 */
const seed = (table: string, account: string, tables: readonly string[]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* decode(Column)(
      yield* sql`SELECT name,type,"notnull",dflt_value FROM pragma_table_info(${table})`,
    );
    const keys = yield* decode(ForeignKey)(
      yield* sql`SELECT "table","from","to" FROM pragma_foreign_key_list(${table})`,
    );
    const names: string[] = [];
    const values: unknown[] = [];
    for (const column of columns) {
      const key = keys.find((k) => k.from === column.name);
      if (column.name === "account_id") values.push(account);
      else if (key && key.table !== "accounts" && !tables.includes(key.table)) {
        // A parent outside the account, such as a proposal: optional here.
        if (column.notnull) values.push(null);
        else continue;
      } else if (key) {
        const [parent] = yield* decode(Schema.Struct({ v: Schema.Unknown }))(
          yield* sql`SELECT ${sql(key.to)} AS v FROM ${sql(key.table)}
            WHERE ${key.table === "accounts" ? sql`id` : sql`account_id`}=${account} LIMIT 1`,
        );
        values.push(parent?.v ?? null);
      } else if (column.notnull && column.dflt_value === null)
        values.push(
          /INT|REAL|NUM/i.test(column.type)
            ? 1
            : column.name.endsWith("_json")
              ? "{}"
              : `${account}/${table}-${column.name}`,
        );
      else continue;
      names.push(column.name);
    }
    yield* sql`INSERT OR IGNORE INTO ${sql(table)} ${sql.insert(
      Object.fromEntries(names.map((name, i) => [name, values[i]])),
    )}`;
  });

it.effect("removing an account leaves no row with its account_id in any table", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const gone = yield* store.upsertAccount("gmail", "gone@example.com");
      const kept = yield* store.upsertAccount("gmail", "kept@example.com");
      for (const account of [gone, kept]) {
        yield* store.upsertMessage(account.id, message("m1"));
        yield* store.snooze(`${account.id}/m1`, 9_000_000_000_000);
        yield* store.appendAudit({
          actor: { kind: "user", surface: "app" },
          accountId: account.id,
          action: "archive",
          detail: {},
        });
      }
      const tables = yield* accountTables;
      // A schema read that found nothing would pass vacuously.
      assert.include(tables, "audit_log");
      assert.include(tables, "messages");
      for (const table of tables) {
        for (const account of [gone, kept]) yield* seed(table, account.id, tables);
        assert.isAbove(yield* countFor(table, gone.id), 0, `no seeded row in ${table}`);
      }

      yield* store.removeAccount(gone.id);

      for (const table of tables) {
        assert.strictEqual(
          yield* countFor(table, gone.id),
          0,
          `${table} keeps the removed account`,
        );
        assert.isAbove(yield* countFor(table, kept.id), 0, `${table} lost the other account`);
      }
    }),
  ),
);

it.effect("removing an account drops its queued mobile sends", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const gone = yield* store.upsertAccount("gmail", "gone@example.com");
      const kept = yield* store.upsertAccount("gmail", "kept@example.com");
      for (const account of [gone, kept])
        yield* sql`INSERT INTO prefs (key,value_json) VALUES (${`mobile-outbox:${account.id}`},
          ${JSON.stringify({ id: account.id, accountId: account.id })})`;
      yield* store.removeAccount(gone.id);
      const rows = yield* decode(Schema.Struct({ key: Schema.String }))(
        yield* sql`SELECT key FROM prefs WHERE key LIKE 'mobile-outbox:%'`,
      );
      assert.deepStrictEqual(
        rows.map((row) => row.key),
        [`mobile-outbox:${kept.id}`],
      );
    }),
  ),
);

it.effect("the audit log keeps only its newest entries", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      for (let i = 0; i < AUDIT_LOG_ROWS + 25; i++)
        yield* store.appendAudit({
          actor: { kind: "user", surface: "app" },
          action: `a${i}`,
          detail: {},
        });
      const [count] = yield* decode(Count)(yield* sql`SELECT count(*) AS n FROM audit_log`);
      assert.strictEqual(count?.n, AUDIT_LOG_ROWS);
      const newest = yield* store.listAudit(1);
      assert.strictEqual(newest[0]?.action, `a${AUDIT_LOG_ROWS + 24}`);
      const [oldest] = yield* decode(Schema.Struct({ action: Schema.String }))(
        yield* sql`SELECT action FROM audit_log ORDER BY id LIMIT 1`,
      );
      assert.strictEqual(oldest?.action, "a25");
    }),
  ),
);
