import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { statfsSync } from "node:fs";
import { dirname } from "node:path";

let db;
let result = "failed";
let upgradeCommitted = false;
try {
  db = new DatabaseSync(workerData.file, { allowExtension: true });
  db.exec(
    "PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON; PRAGMA cache_size=-8192; PRAGMA synchronous=FULL",
  );
  // A peer writer may hold mail.db without using openmail's access lock.
  db.exec("BEGIN IMMEDIATE; ROLLBACK");
  const mode = db.prepare("PRAGMA auto_vacuum").get().auto_vacuum;
  if (workerData.kind === "upgrade") {
    const { applyNativeMigration } = await import(workerData.migrationModule);
    applyNativeMigration(db, workerData.script, workerData.version);
    upgradeCommitted = true;
  } else if (workerData.full) {
    for (const table of [
      "messages",
      "contact_candidates",
      "contact_organizations",
      "derived_chunks",
    ]) {
      const keys = db
        .prepare(
          `SELECT name FROM pragma_table_info('${table}') WHERE upper(type)='INTEGER' AND pk=1`,
        )
        .all();
      if (keys.length !== 1 || keys[0].name !== (table === "derived_chunks" ? "id" : "rowid")) {
        result = "unsafe";
        throw new Error("Unsafe rowids");
      }
    }
    const indexes = [
      "messages_fts",
      "derived_fts",
      "contact_candidates_fts",
      "contact_organizations_fts",
    ];
    for (const table of indexes) {
      try {
        db.exec(`INSERT INTO ${table}(${table},rank) VALUES('integrity-check',1)`);
      } catch (error) {
        if ((error.errcode & 0xff) === 5 || (error.errcode & 0xff) === 6) throw error;
        result = "unsafe";
        throw error;
      }
    }
    for (const table of ["messages_words", "derived_words"])
      db.exec(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`);
    if (mode === 0) {
      const volume = statfsSync(dirname(workerData.file));
      const bytes =
        db.prepare("PRAGMA page_count").get().page_count *
        db.prepare("PRAGMA page_size").get().page_size;
      if (volume.bavail * volume.bsize < 2 * bytes) {
        result = "low-disk";
        throw new Error("Not enough temporary space");
      }
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='derived_text_vectors'").get()) {
        const vectors = await import("sqlite-vec");
        db.loadExtension(
          vectors.getLoadablePath().replace(/([/\\])app\.asar([/\\])/u, "$1app.asar.unpacked$2"),
        );
      }
      db.exec("PRAGMA auto_vacuum=INCREMENTAL; VACUUM");
    } else {
      db.exec("PRAGMA auto_vacuum=INCREMENTAL; PRAGMA incremental_vacuum");
    }
    for (const table of indexes)
      db.exec(`INSERT INTO ${table}(${table},rank) VALUES('integrity-check',1)`);
  } else if (mode === 2) {
    // Drain the actual freelist. Large evictions do not wait for a fixed hourly quota.
    db.exec("PRAGMA incremental_vacuum");
  }
  const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  result = checkpoint.busy
    ? upgradeCommitted
      ? { _tag: "UpgradeCheckpointDeferred" }
      : "busy"
    : "done";
} catch (error) {
  if ((error.errcode & 0xff) === 5 || (error.errcode & 0xff) === 6)
    result = upgradeCommitted ? { _tag: "UpgradeCheckpointDeferred" } : "busy";
  if (error.name === "DatabaseUpgradeSpaceError") result = "low-disk";
} finally {
  db?.close();
}
// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker_threads port has no target origin.
parentPort.postMessage(result);
