import {
  acquireDatabaseAccess,
  DatabaseInUseError,
  isDatabaseCorruption,
} from "./database-access.js";
import { cleanInterruptedRecovery, hasRecoveryArtifacts } from "./recovery-files.js";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./db.js";

/** User state from every migration. Cache/FTS/vector tables are intentionally rebuilt. */
export const RECOVERY_TABLES = [
  "profiles",
  "accounts",
  "agent_policies",
  "proposals",
  "drafts",
  "pending_ops",
  "prefs",
  "signatures",
  "named_signatures",
  "signature_defaults",
  "templates",
  "hidden_contacts",
  "image_senders",
  "label_preferences",
  "account_organization",
  "thread_reminders",
  "snoozed_messages",
  "send_as",
  "cache_windows",
  "account_oauth_scopes",
  "filter_restorations",
  "invite_responses",
  "audit_log",
] as const;
export type CacheResetResult =
  | { kind: "reset" }
  | { kind: "recovered"; backup: string; copied: number; skipped: number };
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

export function databaseQuickCheck(file: string): "ok" | "corrupt" | "unavailable" {
  if (!existsSync(file)) return "ok";
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare("PRAGMA quick_check").all();
    return rows.length === 1 && rows[0]?.quick_check === "ok" ? "ok" : "corrupt";
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "errcode" in error ? error.errcode : null;
    return typeof code === "number" && [11, 26].includes(code & 0xff) ? "corrupt" : "unavailable";
  } finally {
    db?.close();
  }
}

/** Salvage one row at a time; a broken page must not prevent later readable rows from copying. */
function copyTable(
  source: DatabaseSync,
  destination: DatabaseSync,
  table: (typeof RECOVERY_TABLES)[number],
) {
  let copied = 0;
  let skipped = 0;
  const quoted = identifier(table);
  let columns: string[];
  try {
    const target = new Set(
      destination
        .prepare(`PRAGMA table_info(${quoted})`)
        .all()
        .map((r) => r.name),
    );
    columns = source
      .prepare(`PRAGMA table_info(${quoted})`)
      .all()
      .flatMap((r) => (typeof r.name === "string" && target.has(r.name) ? [r.name] : []));
  } catch {
    return { copied, skipped: 1 };
  }
  if (!columns.length) return { copied, skipped };
  const projection = columns.map(identifier).join(",");
  const insert = destination.prepare(
    `INSERT INTO ${quoted} (${projection}) VALUES (${columns.map(() => "?").join(",")})`,
  );
  // Readable accounts/drafts can survive an unreadable optional profile/proposal.
  const nullable = new Set(
    destination
      .prepare(`PRAGMA table_info(${quoted})`)
      .all()
      .filter((c) => c.notnull === 0 && c.pk === 0)
      .map((c) => c.name),
  );
  const optionalParents = destination
    .prepare(`PRAGMA foreign_key_list(${quoted})`)
    .all()
    .flatMap((fk) => {
      if (
        typeof fk.from !== "string" ||
        typeof fk.table !== "string" ||
        typeof fk.to !== "string" ||
        !nullable.has(fk.from)
      )
        return [];
      return [
        {
          column: fk.from,
          exists: destination.prepare(
            `SELECT 1 FROM ${identifier(fk.table)} WHERE ${identifier(fk.to)}=?`,
          ),
        },
      ];
    });
  const copy = (row: ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>) => {
    if (!row) return;
    for (const parent of optionalParents) {
      const value = row[parent.column];
      if (value !== null && value !== undefined && !parent.exists.get(value)) {
        row[parent.column] = null;
        skipped++;
      }
    }
    try {
      insert.run(...columns.map((name) => row[name] ?? null));
      copied++;
    } catch {
      skipped++;
    }
  };
  let last = 0;
  try {
    for (const row of source
      .prepare(`SELECT rowid AS recovery_rowid,${projection} FROM ${quoted} ORDER BY rowid`)
      .iterate()) {
      if (typeof row.recovery_rowid === "number") last = row.recovery_rowid;
      copy(row);
    }
  } catch {
    // The rightmost B-tree leaf often survives a damaged interior/earlier leaf page.
    let maximum = last;
    try {
      const row = source.prepare(`SELECT MAX(rowid) AS maximum FROM ${quoted}`).get();
      if (typeof row?.maximum === "number") maximum = row.maximum;
    } catch {
      skipped++;
    }
    try {
      const read = source.prepare(`SELECT ${projection} FROM ${quoted} WHERE rowid=?`);
      for (let id = last + 1; id <= maximum; id++) {
        try {
          copy(read.get(id));
        } catch {
          skipped++;
        }
      }
    } catch {
      skipped++;
    }
  }
  return { copied, skipped };
}

export function rebuildCorruptDatabase(directory: string): CacheResetResult {
  const file = join(directory, "mail.db");
  const access = acquireDatabaseAccess(file, "exclusive");
  try {
    return rebuildUnderLock(directory);
  } finally {
    access.release();
  }
}
function rebuildUnderLock(directory: string): CacheResetResult {
  const file = join(directory, "mail.db");
  if (hasRecoveryArtifacts(file)) cleanInterruptedRecovery(file);
  const fresh = `${file}.recovery-${randomUUID()}`;
  const backup = `${file}.corrupt-${Date.now()}-${randomUUID()}`;
  let source: DatabaseSync | undefined;
  let copied = 0;
  let skipped = 0;
  try {
    source = new DatabaseSync(file);
    source.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
    source.prepare("SELECT name FROM sqlite_master").get();
  } catch (error) {
    if (!isDatabaseCorruption(error)) {
      source?.close();
      throw new DatabaseInUseError();
    }
    // The shared core lock file still excludes every CLI/MCP database layer.
    skipped++;
  }
  let destination: DatabaseSync | undefined;
  try {
    destination = new DatabaseSync(fresh);
    for (let i = 0; i < MIGRATIONS.length; i++) {
      destination.exec("BEGIN");
      destination.exec(MIGRATIONS[i] ?? "");
      destination.exec(`PRAGMA user_version=${i + 1}; COMMIT;`);
    }
    destination.exec("PRAGMA foreign_keys=ON; BEGIN");
    if (source)
      for (const table of RECOVERY_TABLES) {
        const result = copyTable(source, destination, table);
        copied += result.copied;
        skipped += result.skipped;
      }
    destination.exec(
      "UPDATE accounts SET sync_cursor=NULL,last_synced_at=NULL,last_sync_error=NULL; COMMIT;",
    );
    if (destination.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
      throw new Error("Recovered database failed integrity check");
  } catch (error) {
    destination?.close();
    source?.close();
    rmSync(fresh, { force: true });
    rmSync(`${fresh}-journal`, { force: true });
    throw error;
  }
  destination.close();
  chmodSync(fresh, 0o600);
  // The marker makes an interrupted swap visible even after fresh has been renamed.
  try {
    writeFileSync(
      `${file}.recovery-state.json`,
      JSON.stringify({
        backup: basename(backup),
        fresh: basename(fresh),
        device: statSync(file).dev,
        inode: statSync(file).ino,
      }),
      { mode: 0o600 },
    );
  } catch (error) {
    source?.close();
    rmSync(fresh, { force: true });
    throw error;
  }
  try {
    for (const suffix of ["-wal", "-shm", "-journal"])
      if (existsSync(`${file}${suffix}`)) renameSync(`${file}${suffix}`, `${backup}${suffix}`);
    linkSync(file, backup);
    // Closing a read-write WAL connection may checkpoint its old inode. Keep byte snapshots too.
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(`${backup}${suffix}`))
        copyFileSync(`${backup}${suffix}`, `${backup}${suffix}.preserved`);
    renameSync(fresh, file);
    source?.close();
    source = undefined;
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(`${backup}${suffix}.preserved`))
        renameSync(`${backup}${suffix}.preserved`, `${backup}${suffix}`);
    if (databaseQuickCheck(file) !== "ok")
      throw new Error("Recovered database failed integrity check");
    rmSync(`${file}.recovery-state.json`, { force: true });
  } catch (error) {
    source?.close();
    source = undefined;
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(`${backup}${suffix}.preserved`))
        renameSync(`${backup}${suffix}.preserved`, `${backup}${suffix}`);
    // The live pathname is never removed. Repair/clean a partially installed recovery under the same lock.
    if (hasRecoveryArtifacts(file)) cleanInterruptedRecovery(file);
    throw error;
  }
  return { kind: "recovered", backup, copied, skipped };
}
