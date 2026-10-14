import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
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

it.effect("only the mailbox owner refreshes statistics on an analyzed database", () =>
  Effect.gen(function* () {
    const file = join(yield* temp, "mail.db");
    yield* open(file, { vectorExtension: null });
    assert.isAbove(statRows(file), 0, "a new database gets statistics on its first open");
    const clear = new DatabaseSync(file);
    clear.exec("DELETE FROM sqlite_stat1");
    clear.close();
    yield* open(file, { vectorExtension: null });
    assert.strictEqual(statRows(file), 0, "a CLI or MCP open skips PRAGMA optimize");
    yield* open(file, { vectorExtension: null, plannerStatsOwner: true });
    assert.isAbove(statRows(file), 0, "the desktop app refreshes on open");
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
