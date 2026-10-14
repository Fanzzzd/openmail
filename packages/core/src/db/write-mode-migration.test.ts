import { applyNativeMigration } from "../platform/node/migrations.js";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { DatabaseSync } from "node:sqlite";
import { databaseLayer, MIGRATIONS } from "../platform/node/db.js";
import { Store } from "../store/service.js";
import { StoreLive } from "../store/store.js";

it.effect("migration 50 turns the removed Organize directly mode into Ask me first", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "openmail-write-mode-" });
    const file = path.join(dir, "mail.db");
    yield* Effect.sync(() => {
      const db = new DatabaseSync(file);
      for (const migration of MIGRATIONS.slice(0, 49)) applyNativeMigration(db, migration);
      db.exec("PRAGMA user_version=49");
      db.exec(
        "INSERT INTO agent_policies(name,modify) VALUES('*','allow'),('claude','allow'),('codex','off')",
      );
      db.close();
    });
    yield* Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const rows = Schema.decodeUnknownSync(
        Schema.Array(Schema.Struct({ name: Schema.String, modify: Schema.String })),
      )(yield* sql`SELECT name, modify FROM agent_policies ORDER BY name`);
      assert.deepStrictEqual(rows, [
        { name: "*", modify: "propose" },
        { name: "claude", modify: "propose" },
        { name: "codex", modify: "off" },
      ]);
      assert.strictEqual(yield* store.agentWriteMode("someone"), "propose");
      assert.strictEqual(yield* store.agentWriteMode("codex"), "off");
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(databaseLayer(file)))));
  }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
);
