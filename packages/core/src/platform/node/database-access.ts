import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
    if (kind === "exclusive") db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
    else db.exec("BEGIN");
    db.prepare("SELECT name FROM sqlite_master").get();
  } catch {
    db.close();
    throw new DatabaseInUseError(kind);
  }
  return { release: () => db.close() };
}
