import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { databaseLayer, type DatabaseOptions } from "./db.js";
import { NodeSystem } from "./platform-node.js";

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
