import { applyNativeMigration } from "./migrations.js";
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
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { MIGRATIONS } from "../../db.js";
import {
  optionalParentChecks,
  quoteIdentifier,
  RECOVERY_TABLES,
  recoveryInsert,
  recoveryDataMigrations,
  sharedRecoveryColumns,
} from "../recovery-tables.js";

export { RECOVERY_TABLES } from "../recovery-tables.js";
export type CacheResetResult =
  | { kind: "reset" }
  | { kind: "recovered"; backup: string; copied: number; skipped: number };

export type QuickCheckResult = "ok" | "corrupt" | "unavailable";

/** SQLITE_CORRUPT and SQLITE_NOTADB mean a damaged file; other errors leave it unknown. */
const quickCheckResult = (
  reply: { readonly rows: readonly unknown[] } | { readonly errcode: unknown },
): QuickCheckResult => {
  if ("rows" in reply) {
    const [row] = reply.rows;
    return reply.rows.length === 1 &&
      typeof row === "object" &&
      row !== null &&
      "quick_check" in row &&
      row.quick_check === "ok"
      ? "ok"
      : "corrupt";
  }
  return typeof reply.errcode === "number" && [11, 26].includes(reply.errcode & 0xff)
    ? "corrupt"
    : "unavailable";
};

export function databaseQuickCheck(file: string): QuickCheckResult {
  if (!existsSync(file)) return "ok";
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return quickCheckResult({ rows: db.prepare("PRAGMA quick_check").all() });
  } catch (error) {
    return quickCheckResult({
      errcode:
        typeof error === "object" && error !== null && "errcode" in error ? error.errcode : null,
    });
  } finally {
    db?.close();
  }
}

/** A quick_check that has not answered by then is treated as unavailable: the recovery prompt. */
export const QUICK_CHECK_TIMEOUT_MS = 120_000;

/** The part of a worker thread the check uses; tests pass a fake. */
export interface QuickCheckWorker {
  once(event: "message" | "error" | "exit", listener: (value: unknown) => void): unknown;
  terminate(): Promise<unknown>;
}
const integrityWorker = (file: string): QuickCheckWorker =>
  new Worker(new URL("./integrity-worker.mjs", import.meta.url), {
    workerData: { file },
    execArgv: [],
  });

/**
 * The same check on a worker thread, so a caller's event loop keeps running. Falls back
 * inline when no worker starts. A worker that hangs, on a stalled disk say, is stopped
 * after `timeoutMs` and the result is "unavailable".
 */
export function databaseQuickCheckInWorker(
  file: string,
  {
    timeoutMs = QUICK_CHECK_TIMEOUT_MS,
    startWorker = integrityWorker,
  }: { timeoutMs?: number; startWorker?: (file: string) => QuickCheckWorker } = {},
): Promise<QuickCheckResult> {
  if (!existsSync(file)) return Promise.resolve("ok");
  let worker: QuickCheckWorker;
  try {
    worker = startWorker(file);
  } catch {
    return Promise.resolve(databaseQuickCheck(file));
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: QuickCheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().finally(() => resolve(result));
    };
    const timer = setTimeout(() => finish("unavailable"), timeoutMs);
    worker.once("message", (reply: unknown) =>
      finish(
        typeof reply === "object" && reply !== null && ("rows" in reply || "errcode" in reply)
          ? quickCheckResult(
              "rows" in reply && Array.isArray(reply.rows)
                ? { rows: reply.rows }
                : { errcode: "errcode" in reply ? reply.errcode : null },
            )
          : "unavailable",
      ),
    );
    // A worker that cannot start or dies early must not turn into a failed check.
    const inline = () => {
      if (!settled) finish(databaseQuickCheck(file));
    };
    worker.once("error", inline);
    worker.once("exit", inline);
  });
}

/** Salvage one row at a time; a broken page must not prevent later readable rows from copying. */
function copyTable(
  source: DatabaseSync,
  destination: DatabaseSync,
  table: (typeof RECOVERY_TABLES)[number],
) {
  let copied = 0;
  let skipped = 0;
  const quoted = quoteIdentifier(table);
  let targetColumns: Record<string, SQLOutputValue>[];
  let columns: string[];
  try {
    targetColumns = destination.prepare(`PRAGMA table_info(${quoted})`).all();
    columns = sharedRecoveryColumns(
      source.prepare(`PRAGMA table_info(${quoted})`).all(),
      targetColumns,
    );
  } catch {
    return { copied, skipped: 1 };
  }
  if (!columns.length) return { copied, skipped };
  const projection = columns.map(quoteIdentifier).join(",");
  const insert = destination.prepare(recoveryInsert(table, columns));
  const optionalParents = optionalParentChecks(
    targetColumns,
    destination.prepare(`PRAGMA foreign_key_list(${quoted})`).all(),
  ).map(({ column, query }) => ({ column, exists: destination.prepare(query) }));
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
    for (let i = 0; i < MIGRATIONS.length; i++)
      applyNativeMigration(destination, MIGRATIONS[i] ?? "", i + 1);
    destination.exec("PRAGMA foreign_keys=ON; BEGIN");
    if (source) {
      let sourceVersion = 0;
      try {
        sourceVersion = Number(source.prepare("PRAGMA user_version").get()?.user_version ?? 0);
      } catch (error) {
        if (!isDatabaseCorruption(error)) throw error;
      }
      for (const table of RECOVERY_TABLES) {
        const result = copyTable(source, destination, table);
        copied += result.copied;
        skipped += result.skipped;
      }
      for (const statement of recoveryDataMigrations(sourceVersion)) destination.exec(statement);
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
