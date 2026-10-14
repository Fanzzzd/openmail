import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Logger, References } from "effect";
import { TestClock } from "effect/testing";
import { logCodeOf } from "../../domain/diagnostic-log.js";
import { SqlClient } from "effect/sql";
import { databaseLayer, type DatabaseOptions } from "./db.js";
import { NodeSystem } from "./platform-node.js";
import { MemoryPlatform } from "./platform-memory.js";
import { traceQueries } from "./fixtures/performance-mailbox.js";
import { Store } from "../../store/service.js";
import { StoreLive } from "../../store/store.js";

const temp = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "openmail-optimize-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
);

/** Opens the database, reads the busy timeout the store will use, and closes it. */
const open = (file: string, options: DatabaseOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ timeout: number }>`PRAGMA busy_timeout`;
    return rows[0]?.timeout;
  }).pipe(Effect.provide(databaseLayer(file, options).pipe(Layer.provide(NodeSystem))));

const statRows = (file: string) => {
  const db = new DatabaseSync(file);
  try {
    return Number(db.prepare("SELECT COUNT(*) AS n FROM sqlite_stat1").get()?.n);
  } finally {
    db.close();
  }
};

// Every CLI and MCP start ran PRAGMA optimize and the vector table setup, which
// need the write lock, and waited the full 5 s busy timeout while the app was
// syncing.
it.effect("opening does not wait for a write lock another process holds", () =>
  Effect.gen(function* () {
    const file = join(yield* temp, "mail.db");
    yield* open(file, { plannerStatsOwner: true });
    const writer = new DatabaseSync(file);
    writer.exec("DELETE FROM sqlite_stat1; BEGIN IMMEDIATE");
    try {
      for (const plannerStatsOwner of [true, false]) {
        const started = performance.now();
        const timeout = yield* open(file, { plannerStatsOwner });
        assert.isBelow(performance.now() - started, 2000, `owner: ${plannerStatsOwner}`);
        assert.strictEqual(timeout, 5000, "the on-open refresh restores the busy timeout");
      }
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  }).pipe(Effect.scoped),
);

const resetStats = (file: string, rows: string) => {
  const db = new DatabaseSync(file);
  try {
    db.exec(`DELETE FROM sqlite_stat1; ${rows}`);
  } finally {
    db.close();
  }
};

it.effect("only the mailbox owner refreshes statistics on an analyzed database", () =>
  Effect.gen(function* () {
    const file = join(yield* temp, "mail.db");
    yield* open(file, { vectorExtension: null });
    assert.isAbove(statRows(file), 0, "a new database gets statistics on its first open");
    resetStats(file, "INSERT INTO sqlite_stat1(tbl,idx,stat) VALUES('messages',NULL,'1000')");
    yield* open(file, { vectorExtension: null });
    assert.strictEqual(statRows(file), 1, "a CLI or MCP open skips PRAGMA optimize");
    yield* open(file, { vectorExtension: null, plannerStatsOwner: true });
    assert.isAbove(statRows(file), 1, "the desktop app refreshes on open");
  }).pipe(Effect.scoped),
);

// A first CLI open on a new mailbox recorded statistics for two small tables only. Later opens
// saw sqlite_stat1 and skipped the refresh, so messages never got statistics without the app.
it.effect("an open without statistics for messages refreshes them", () =>
  Effect.gen(function* () {
    const file = join(yield* temp, "mail.db");
    yield* open(file, { vectorExtension: null });
    resetStats(file, "INSERT INTO sqlite_stat1(tbl,idx,stat) VALUES('prefs',NULL,'1')");
    yield* open(file, { vectorExtension: null });
    assert.isAbove(statRows(file), 1);
  }).pipe(Effect.scoped),
);

it.effect("a refresh that finds the database locked logs planner-stats-skipped with the code", () =>
  Effect.gen(function* () {
    const file = join(yield* temp, "mail.db");
    yield* open(file, { plannerStatsOwner: true });
    const logged: unknown[] = [];
    const logger = Logger.make((options) => {
      if (logCodeOf(options.fiber.getRef(References.CurrentLogAnnotations)))
        logged.push(...(Array.isArray(options.message) ? options.message : [options.message]));
    });
    // The warning is throttled to one an hour, and the first test here already logged one.
    yield* TestClock.adjust("2 hours");
    const writer = new DatabaseSync(file);
    writer.exec("DELETE FROM sqlite_stat1; BEGIN IMMEDIATE");
    try {
      // A CLI or MCP start next to the app's writer expects a busy database and stays quiet.
      for (const plannerStatsOwner of [false, true])
        yield* open(file, { plannerStatsOwner }).pipe(Effect.provide(Logger.layer([logger])));
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
    assert.deepStrictEqual(logged, [
      { _tag: "PlannerStatsSkippedDiagnostic", reason: "planner-stats-skipped", code: 5 },
    ]);
  }).pipe(Effect.scoped),
);

const shadowStats = (file: string) => {
  const db = new DatabaseSync(file);
  try {
    return db
      .prepare(
        "SELECT tbl FROM sqlite_stat1 WHERE tbl IN (SELECT name FROM pragma_table_list WHERE type='shadow') OR tbl LIKE 'derived\\_%vectors\\_%' ESCAPE '\\' ORDER BY tbl",
      )
      .all()
      .map((row) => String(row["tbl"]));
  } finally {
    db.close();
  }
};

// The on-open PRAGMA optimize analyzed the empty FTS5 %_data tables and recorded 2 rows. From
// then on every FTS5 segment lookup planned as a scan: seeding the 100k performance mailbox went
// from 5 s to 4 minutes per 10k messages and the job timed out.
it.effect("planner statistics never cover FTS5 or vec0 shadow tables", () =>
  Effect.gen(function* () {
    const file = join(yield* temp, "mail.db");
    yield* open(file, { plannerStatsOwner: true });
    assert.isAbove(statRows(file), 0);
    assert.deepStrictEqual(shadowStats(file), []);
    // An older version left one behind; the next refresh removes it.
    const db = new DatabaseSync(file);
    db.exec(
      "INSERT INTO sqlite_stat1(tbl,idx,stat) VALUES('messages_fts_data',NULL,'2'),('derived_text_vectors_vector_chunks00',NULL,'1')",
    );
    db.close();
    yield* open(file, { plannerStatsOwner: true });
    assert.deepStrictEqual(shadowStats(file), []);
    // A second open analyzes the vector tables the first one created after its refresh.
    yield* open(file, { plannerStatsOwner: true });
    assert.deepStrictEqual(shadowStats(file), []);
  }).pipe(Effect.scoped),
);

// Each upsertMessage ran a vec0 DELETE with a subquery, which scans the vector table, even
// though almost no message has vectors.
it.effect("storing a message without vectors does not touch the vector tables", () => {
  const statements: string[] = [];
  const trace = traceQueries((query) => {
    statements.push(query);
    return () => null;
  });
  return Effect.gen(function* () {
    const store = yield* Store;
    const account = yield* store.upsertAccount("gmail", "me@example.com");
    statements.length = 0;
    for (const i of [1, 2])
      yield* store.upsertMessage(account.id, {
        providerId: "p",
        threadId: "t",
        subject: `s${i}`,
        from: { name: "", address: "a@example.com" },
        to: [],
        cc: [],
        date: i,
        snippet: "",
        bodyText: `body ${i}`,
        bodyHtml: "",
        labels: ["INBOX"],
        attachments: [],
        isUnread: false,
        isStarred: false,
      });
    assert.deepStrictEqual(
      statements.filter((query) => /derived_(text|image)_vectors/.test(query)),
      [],
    );
  }).pipe(
    Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform()))),
    Effect.ensuring(Effect.sync(trace.restore)),
  );
});

// `openmail sync` ends with this refresh, so a mailbox the CLI fills gets statistics for it.
it.effect("the sync refresh records statistics for messages once the mailbox has mail", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const sql = yield* SqlClient.SqlClient;
    const account = yield* store.upsertAccount("gmail", "me@example.com");
    for (let i = 0; i < 50; i++)
      yield* store.upsertMessage(account.id, {
        providerId: `p${i}`,
        threadId: `t${i}`,
        subject: `s${i}`,
        from: { name: "", address: "a@example.com" },
        to: [],
        cc: [],
        date: i,
        snippet: "",
        bodyText: `body ${i}`,
        bodyHtml: "",
        labels: ["INBOX"],
        attachments: [],
        isUnread: false,
        isStarred: false,
      });
    yield* sql`DELETE FROM sqlite_stat1 WHERE tbl='messages'`;
    yield* store.listThreads({ limit: 5 });
    yield* store.refreshPlannerStats;
    assert.isAbove((yield* sql`SELECT 1 FROM sqlite_stat1 WHERE tbl='messages'`).length, 0);
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);
