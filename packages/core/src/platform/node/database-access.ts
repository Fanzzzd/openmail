import { chmodSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { constVoid } from "effect/Function";

export class DatabaseInUseError extends Error {
  constructor(kind: "shared" | "exclusive" = "exclusive") {
    super(
      kind === "shared"
        ? "OpenMail is recovering or holding the database. Try opening it again shortly."
        : "Close other OpenMail processes (CLI/MCP) before recovering the database.",
    );
    this.name = "DatabaseInUseError";
  }
}
export const isDatabaseCorruption = (error: unknown) => {
  const code =
    typeof error === "object" && error !== null && "errcode" in error ? error.errcode : null;
  return typeof code === "number" && [11, 26].includes(code & 0xff);
};

/** A separate SQLite lock file survives a damaged mail.db header. OS locks release on process exit. */
export function acquireDatabaseAccess(file: string, kind: "shared" | "exclusive") {
  mkdirSync(dirname(file), { recursive: true });
  const lockFile = `${file}.access-lock`;
  const db = new DatabaseSync(lockFile);
  try {
    db.exec(`PRAGMA busy_timeout=${kind === "exclusive" ? 0 : 5000}`);
    chmodSync(lockFile, 0o600);
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='access_guard'").get())
      db.exec(
        "CREATE TABLE IF NOT EXISTS access_guard(id INTEGER PRIMARY KEY); INSERT OR IGNORE INTO access_guard VALUES(1)",
      );
    if (kind === "exclusive") db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
    else db.exec("BEGIN");
    db.prepare("SELECT id FROM access_guard").get();
  } catch {
    db.close();
    throw new DatabaseInUseError(kind);
  }
  const restoreShared = () => {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.exec("PRAGMA locking_mode=NORMAL; BEGIN; SELECT id FROM access_guard; COMMIT; BEGIN");
    db.prepare("SELECT id FROM access_guard").get();
    db.exec("PRAGMA busy_timeout=5000");
  };
  return {
    release: () => db.close(),
    tryExclusive: () => {
      // An exclusive lease already excludes every peer.
      if (kind !== "shared") return constVoid;
      db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE");
      try {
        // COMMIT acquires EXCLUSIVE, and exclusive mode retains it afterward.
        // A failed COMMIT keeps our original shared transaction intact.
        db.exec("PRAGMA user_version=1; COMMIT");
      } catch {
        restoreShared();
        return null;
      }
      return restoreShared;
    },
  };
}

const canonicalFile = (file: string) =>
  existsSync(file) ? realpathSync(file) : join(realpathSync(dirname(file)), basename(file));
const localLeases = new Map<string, Set<ReturnType<typeof acquireDatabaseAccess>>>();
export function registerDatabaseLease(
  file: string,
  lease: ReturnType<typeof acquireDatabaseAccess>,
) {
  file = canonicalFile(file);
  const leases = localLeases.get(file) ?? new Set();
  leases.add(lease);
  localLeases.set(file, leases);
  return () => {
    leases.delete(lease);
    if (!leases.size) localLeases.delete(file);
  };
}
export function exclusiveMaintenanceLease(file: string): (() => void) | null {
  file = canonicalFile(file);
  const leases = localLeases.get(file);
  if (leases && leases.size !== 1) return null;
  if (leases) return leases.values().next().value?.tryExclusive() ?? null;
  try {
    return acquireDatabaseAccess(file, "exclusive").release;
  } catch (error) {
    if (error instanceof DatabaseInUseError) return null;
    throw error;
  }
}
