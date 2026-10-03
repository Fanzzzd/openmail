import { copyFileSync, existsSync, statSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MIGRATIONS } from "../../db.js";
import { DatabaseSync } from "node:sqlite";

/** Copy a quiescent database, WAL and adjacent OAuth client config without modifying sources. */
export function prepareSmokeDatabase(
  source: string | undefined,
  directory: string,
): { accounts: number; messages: number } {
  if (source && !statSync(source).isFile()) throw new Error("Smoke source must be a database file");
  const target = join(directory, "mail.db");
  if (source && resolve(source) === resolve(target))
    throw new Error("Smoke database must be a separate copy");
  const sourceConfig = source ? join(dirname(source), "config.json") : undefined;
  if (
    sourceConfig &&
    existsSync(sourceConfig) &&
    resolve(sourceConfig) === resolve(join(directory, "config.json"))
  )
    throw new Error("Smoke configuration must be a separate copy");
  const files = source
    ? [
        { source, target },
        { source: `${source}-wal`, target: `${target}-wal` },
        ...(sourceConfig ? [{ source: sourceConfig, target: join(directory, "config.json") }] : []),
      ].filter((file) => existsSync(file.source))
    : [];
  const before = files.map((file) => statSync(file.source));
  for (const file of files) {
    copyFileSync(file.source, file.target);
    chmodSync(file.target, 0o600);
  }
  if (
    files.some((file, index) => {
      const after = statSync(file.source);
      const prior = before[index];
      return !prior || after.size !== prior.size || after.mtimeMs !== prior.mtimeMs;
    }) ||
    (source &&
      existsSync(`${source}-wal`) !== files.some((file) => file.source === `${source}-wal`)) ||
    (sourceConfig &&
      existsSync(sourceConfig) !== files.some((file) => file.source === sourceConfig))
  )
    throw new Error("Smoke inputs changed during copy. Close their writers and retry.");
  const db = new DatabaseSync(target);
  try {
    const row = db.prepare("PRAGMA user_version").get();
    const version = row?.["user_version"];
    if (typeof version !== "number" || version > MIGRATIONS.length)
      throw new Error("Unsupported smoke database version");
    for (let index = version; index < MIGRATIONS.length; index++) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(MIGRATIONS[index] ?? "");
        db.exec(`PRAGMA user_version=${index + 1}`);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    db.prepare(
      "INSERT INTO prefs(key,value_json) VALUES('markReadDelay','\"manual\"') ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
    ).run();
    db.prepare(
      "INSERT INTO prefs(key,value_json) VALUES('language','\"en\"') ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
    ).run();
    db.prepare(
      "INSERT INTO prefs(key,value_json) VALUES('defaultProfilesPrompted','true') ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
    ).run();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const accounts = db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE enabled=1").get()?.["n"];
    const messages = db.prepare("SELECT COUNT(*) AS n FROM messages").get()?.["n"];
    return {
      accounts: typeof accounts === "number" ? accounts : 0,
      messages: typeof messages === "number" ? messages : 0,
    };
  } finally {
    db.close();
  }
}
