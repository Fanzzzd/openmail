import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Cause, Effect, Exit, Layer } from "effect";
import { afterEach, expect, it } from "vitest";
import { DatabaseTooNewError, migrate, MIGRATIONS } from "./db.js";
import { databaseLayer } from "./platform/node/db.js";
import { NodeSystem } from "./platform/node/platform-node.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A database a newer build migrated one step past this build's MIGRATIONS. */
async function newerDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "openmail-too-new-"));
  directories.push(directory);
  const file = join(directory, "mail.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE future (id INTEGER PRIMARY KEY)");
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  db.close();
  return file;
}

const defectOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

const versionOf = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Number(db.prepare("PRAGMA user_version").get()?.user_version);
  } finally {
    db.close();
  }
};

it("an older build refuses a database a newer OpenMail migrated and leaves it unchanged", async () => {
  const file = await newerDatabase();
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Layer.build(databaseLayer(file, { vectorExtension: null }).pipe(Layer.provide(NodeSystem))),
    ),
  );
  const error = defectOf(exit);
  expect(error).toBeInstanceOf(DatabaseTooNewError);
  expect(error instanceof Error && error.message).toBe(
    "This library was opened by a newer OpenMail. Update OpenMail to open it.",
  );
  expect(versionOf(file)).toBe(MIGRATIONS.length + 1);
});

it("migrate itself refuses a newer schema, so every platform's opener stops", async () => {
  const file = await newerDatabase();
  const exit = await Effect.runPromiseExit(
    migrate.pipe(Effect.provide(SqliteClient.layer({ filename: file }))),
  );
  const error = defectOf(exit);
  expect(error).toBeInstanceOf(DatabaseTooNewError);
  expect(error instanceof DatabaseTooNewError && error.version).toBe(MIGRATIONS.length + 1);
  expect(versionOf(file)).toBe(MIGRATIONS.length + 1);
});
