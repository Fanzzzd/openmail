import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../src/db/migrations.js";
import { applyNativeMigration } from "../src/platform/node/migrations.js";

let template: Uint8Array | undefined;

/** Build the real schema once per worker; each fixture writes its own independent copy. */
export function migratedDatabaseBytes(): Uint8Array {
  if (template) return new Uint8Array(template);
  const directory = mkdtempSync(join(tmpdir(), "openmail-schema-fixture-"));
  try {
    const file = join(directory, "template.db");
    const db = new DatabaseSync(file);
    try {
      // Fixtures inject IO failures explicitly; they do not test hardware durability.
      db.exec("PRAGMA synchronous=OFF; PRAGMA auto_vacuum=INCREMENTAL");
      for (const [index, migration] of MIGRATIONS.entries())
        applyNativeMigration(db, migration, index + 1);
    } finally {
      db.close();
    }
    template = readFileSync(file);
    return new Uint8Array(template);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Writes an independent copy of the migrated schema to `file`. */
export function writeMigratedDatabase(file: string): void {
  writeFileSync(file, migratedDatabaseBytes());
}

/**
 * Opens a copy of the real schema at `file` with user_version 0, like a fixture built from
 * bare migration scripts, so startup and recovery still replay every data migration.
 */
export function openUnversionedMigratedDatabase(file: string): DatabaseSync {
  writeMigratedDatabase(file);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA user_version=0");
  return db;
}
