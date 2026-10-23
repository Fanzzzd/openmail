// Writes the 100k-message perf fixture (see docs/performance.md) to a database file the desktop
// app can open, for apps/desktop/scripts/perf-list.mjs. Build core first; takes about a minute.
//
//   OPENMAIL_PERF=1 node packages/core/scripts/write-perf-fixture.mjs /tmp/fixture-100k/mail.db
import { existsSync } from "node:fs";
import { Effect, Layer } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { databaseLayer } from "../dist/platform/node/db.js";
import { StoreLive } from "../dist/store/store.js";
import { NodeRuntime } from "../dist/platform/node/runtime.js";
import { seedMailbox } from "../dist/platform/node/fixtures/performance-mailbox.js";

if (process.env.OPENMAIL_PERF !== "1") throw new Error("Set OPENMAIL_PERF=1 to write the fixture.");
const file = process.argv[2];
if (!file) throw new Error("Usage: write-perf-fixture.mjs <mail.db>");
if (existsSync(file)) throw new Error(`${file} exists`);
const layer = StoreLive.pipe(
  Layer.provideMerge(
    databaseLayer(file).pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  ),
  Layer.provideMerge(NodeRuntime),
);
const phases = await Effect.runPromise(
  seedMailbox(100_000, { analyze: true }).pipe(Effect.provide(layer)),
);
process.stdout.write(`${JSON.stringify(phases)}\n`);
