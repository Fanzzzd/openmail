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
