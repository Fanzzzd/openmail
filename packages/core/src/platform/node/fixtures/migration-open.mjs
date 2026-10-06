// Node-only process fixture; pnpm test builds core before starting tests.
import { writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { databaseLayer } from "../../../../dist/platform/node/db.js";
import { NodeSystem } from "../../../../dist/platform/node/platform-node.js";

if (process.argv[3] === "hold") {
  const holder = new DatabaseSync(process.argv[2]);
  holder.exec("BEGIN IMMEDIATE");
  writeSync(1, "migration-lock-held\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6500);
  holder.exec("ROLLBACK");
  holder.close();
}
await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`PRAGMA user_version`;
    const version = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ user_version: Schema.Number }),
    )(rows[0]);
    writeSync(1, `ready:${version.user_version}\n`);
  }).pipe(
    Effect.provide(
      databaseLayer(process.argv[2], { vectorExtension: null }).pipe(Layer.provide(NodeSystem)),
    ),
    Effect.scoped,
  ),
);
