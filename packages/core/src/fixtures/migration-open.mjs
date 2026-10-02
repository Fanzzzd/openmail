// Node-only process fixture; pnpm test builds core before starting tests.
import { writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { databaseLayer } from "../../dist/db.js";
import { NodeSystem } from "../../dist/platform-node.js";

if (process.argv[3] === "hold") {
  // The saved method always receives its owning connection through .call.
  // oxlint-disable-next-line typescript/unbound-method
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    if (sql.startsWith("CREATE INDEX messages_thread_labels")) {
      writeSync(1, "migration-lock-held\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6500);
    }
    return prepare.call(this, sql);
  };
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
