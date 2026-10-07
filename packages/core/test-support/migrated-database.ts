import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../src/db.js";
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
