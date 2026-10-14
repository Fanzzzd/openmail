import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { databaseLayer } from "./db.js";
import { NodeSystem } from "./platform-node.js";

const mode = (path: string) => statSync(path).mode & 0o777;

const withUmask = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => process.umask(0o022)),
    () => effect,
    (previous) => Effect.sync(() => process.umask(previous)),
  );

const open = (file: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS probe(x)`;
    yield* sql`INSERT INTO probe VALUES (1)`;
    return [mode(file), mode(`${file}-wal`), mode(`${file}-shm`)];
  }).pipe(
    Effect.provide(databaseLayer(file, { vectorExtension: null }).pipe(Layer.provide(NodeSystem))),
  );

const temp = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "openmail-mode-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
);

// With umask 022 the folder came out 0755 and mail.db 0644, so any local
// account could read every cached message.
it.effect.skipIf(process.platform === "win32")(
  "a new database and its folder are private under umask 022",
  () =>
    withUmask(
      Effect.gen(function* () {
        const folder = join(yield* temp, "fresh", "OpenMail");
        const file = join(folder, "mail.db");
        assert.deepStrictEqual(yield* open(file), [0o600, 0o600, 0o600]);
        assert.strictEqual(mode(folder), 0o700);
      }),
    ).pipe(Effect.scoped),
);

it.effect.skipIf(process.platform === "win32")(
  "opening tightens a folder and files an older version left readable",
  () =>
    withUmask(
      Effect.gen(function* () {
        const folder = join(yield* temp, "OpenMail");
        const file = join(folder, "mail.db");
        mkdirSync(folder, { mode: 0o755 });
        chmodSync(folder, 0o755);
        yield* open(file);
        // Closing removes -wal and -shm; a crash would leave them behind.
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          if (suffix) writeFileSync(`${file}${suffix}`, "");
          chmodSync(`${file}${suffix}`, 0o644);
        }
        chmodSync(folder, 0o755);
        assert.deepStrictEqual(yield* open(file), [0o600, 0o600, 0o600]);
        assert.strictEqual(mode(`${file}-journal`), 0o600);
        assert.strictEqual(mode(folder), 0o700);
      }),
    ).pipe(Effect.scoped),
);
