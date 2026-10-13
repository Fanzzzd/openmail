import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Cause, Effect, Exit, Layer } from "effect";
import { afterEach, expect, it } from "vitest";
import { DatabaseTooNewError, migrate } from "./migrate.js";
import { MIGRATIONS } from "./migrations.js";
import { databaseLayer } from "../platform/node/db.js";
import { NodeSystem } from "../platform/node/platform-node.js";
import { newerDatabaseVersion, resetLocalCache } from "../platform/node/diagnostics.js";

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

it("opening waits for a lock another process holds briefly instead of failing as locked", async () => {
  // The CLI flake: four CLI processes start on one file; the read-only inspection ran without
  // a busy timeout and died with "database is locked" while a sibling held the write lock.
  const directory = await mkdtemp(join(tmpdir(), "openmail-locked-"));
  directories.push(directory);
  const file = join(directory, "mail.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE t (x)");
  db.close();
  const holder = spawn(
    process.execPath,
    [
      "-e",
      `const { DatabaseSync } = require("node:sqlite");
       const db = new DatabaseSync(process.argv[1]);
       db.exec("BEGIN EXCLUSIVE; INSERT INTO t VALUES (1)");
       process.stdout.write("locked\\n");
       setTimeout(() => { db.exec("COMMIT"); db.close(); }, 400);`,
      file,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const closed = once(holder, "close");
  await once(holder.stdout, "data");
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Layer.build(databaseLayer(file, { vectorExtension: null }).pipe(Layer.provide(NodeSystem))),
    ),
  );
  await closed;
  expect(defectOf(exit)).toBeUndefined();
  expect(versionOf(file)).toBe(MIGRATIONS.length);
}, 30_000);

it("cache reset refuses a database a newer OpenMail migrated and leaves it unchanged", async () => {
  const file = await newerDatabase();
  const directory = join(file, "..");
  expect(newerDatabaseVersion(directory)).toBe(MIGRATIONS.length + 1);
  expect(() => resetLocalCache(directory)).toThrow(DatabaseTooNewError);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    expect(db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: MIGRATIONS.length + 1,
    });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='messages'").get()).toBe(
      undefined,
    );
  } finally {
    db.close();
  }
});
