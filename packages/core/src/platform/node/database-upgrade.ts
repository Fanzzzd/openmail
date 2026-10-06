import { existsSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export class DatabaseUpgradeSpaceError extends Error {
  constructor(readonly requiredBytes: number) {
    super(
      `Not enough free disk space to upgrade the local database. Free at least ${Math.ceil(requiredBytes / 1024 ** 2)} MiB and try again.`,
    );
    this.name = "DatabaseUpgradeSpaceError";
  }
}
/** Reads only metadata; the rebuild cannot start if its temporary copy will not fit. */
export function checkDatabaseUpgradeSpace(db: DatabaseSync, freeBytes?: number) {
  const file = db.prepare("SELECT file FROM pragma_database_list WHERE name='main'").get()?.file;
  if (typeof file !== "string" || !file || !existsSync(file)) return;
  const bytes =
    Number(db.prepare("PRAGMA page_count").get()?.page_count) *
    Number(db.prepare("PRAGMA page_size").get()?.page_size);
  const volume = statfsSync(dirname(file));
  if ((freeBytes ?? volume.bavail * volume.bsize) < bytes)
    throw new DatabaseUpgradeSpaceError(bytes);
}
