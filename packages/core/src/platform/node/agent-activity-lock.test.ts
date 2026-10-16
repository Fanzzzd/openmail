import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { databaseLayer } from "./db.js";
import { NodeSystem } from "./platform-node.js";
import { MemoryPlatform } from "./platform-memory.js";
import { incoming } from "./testing.js";
import { Store } from "../../store/service.js";
import { StoreLive } from "../../store/store.js";

const temp = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "openmail-activity-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
);

// Every MCP tool call ended with this write. With another process holding the write lock it
// waited the 5 s busy timeout and failed the call as an internal server error.
it.effect("an agent_activity row gives up quickly on a held write lock and keeps the timeout", () =>
  Effect.gen(function* () {
    const file = join(yield* temp, "mail.db");
    const layer = StoreLive.pipe(
      Layer.provideMerge(databaseLayer(file, {}).pipe(Layer.provide(NodeSystem))),
      Layer.provideMerge(MemoryPlatform()),
    );
    yield* Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const entry = { client: "claude-code", tool: "search", ok: true };
      yield* store.appendAgentActivity(entry);
      const writer = new DatabaseSync(file);
      writer.exec("BEGIN IMMEDIATE");
      try {
        const started = performance.now();
        const failed = yield* Effect.flip(store.appendAgentActivity(entry));
        assert.strictEqual(failed._tag, "DatabaseBusy");
        assert.isBelow(performance.now() - started, 2000);
      } finally {
        writer.exec("ROLLBACK");
        writer.close();
      }
      const rows = yield* sql<{ timeout: number }>`PRAGMA busy_timeout`;
      assert.strictEqual(rows[0]?.timeout, 5000, "other statements keep the 5 s busy timeout");
      yield* store.appendAgentActivity(entry);
      assert.strictEqual((yield* store.listAgentActivity(10)).length, 2);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

// The search backfill opened a write transaction before it checked for work. With another
// process holding the write lock, each step froze the event loop for the 5 s busy timeout.
it.effect("search index steps read first and wait only briefly for a held write lock", () =>
  Effect.gen(function* () {
    const file = join(yield* temp, "mail.db");
    const layer = StoreLive.pipe(
      Layer.provideMerge(databaseLayer(file, {}).pipe(Layer.provide(NodeSystem))),
      Layer.provideMerge(MemoryPlatform()),
    );
    yield* Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("gmail", "me@example.com");
      yield* store.upsertMessage(account.id, incoming("one", { subject: "Hello" }));
      for (const step of [store.backfillWordIndex(), store.backfillSearchFlags()])
        while (!(yield* step).ready) yield* Effect.void;
      const writer = new DatabaseSync(file);
      writer.exec("BEGIN IMMEDIATE");
      try {
        let started = performance.now();
        // Nothing pending: no write transaction, so no wait at all.
        assert.deepStrictEqual(yield* store.backfillWordIndex(), { processed: 0, ready: true });
        assert.deepStrictEqual(yield* store.backfillSearchFlags(), { processed: 0, ready: true });
        assert.isBelow(performance.now() - started, 1000);
        // The new message's bigrams are pending, so this step has to write.
        started = performance.now();
        const failed = yield* Effect.flip(store.briefLockWait(store.indexBigrams()));
        assert.strictEqual(failed._tag, "DatabaseBusy");
        assert.isBelow(performance.now() - started, 1000);
      } finally {
        writer.exec("ROLLBACK");
        writer.close();
      }
      const rows = yield* sql<{ timeout: number }>`PRAGMA busy_timeout`;
      assert.strictEqual(rows[0]?.timeout, 5000, "other statements keep the 5 s busy timeout");
      assert.deepStrictEqual(yield* store.briefLockWait(store.indexBigrams()), {
        processed: 1,
        ready: true,
      });
      assert.deepStrictEqual(yield* store.indexBigrams(), { processed: 0, ready: true });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);
