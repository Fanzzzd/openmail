import { applyNativeMigration } from "./migrations.js";
import { copyQuiescentDatabase } from "./database-copy.js";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MIGRATIONS } from "../../db/migrations.js";
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
  if (
    source &&
    copyQuiescentDatabase(source, target, {
      kind: "smoke",
      sourceConfig,
      targetConfig: join(directory, "config.json"),
    }) !== "copied"
  )
    throw new Error("Smoke inputs changed during copy. Close their writers and retry.");
  const db = new DatabaseSync(target);
  try {
    const row = db.prepare("PRAGMA user_version").get();
    const version = row?.["user_version"];
    if (typeof version !== "number" || version > MIGRATIONS.length)
      throw new Error("Unsupported smoke database version");
    for (let index = version; index < MIGRATIONS.length; index++)
      applyNativeMigration(db, MIGRATIONS[index] ?? "", index + 1);
    db.prepare(
      "INSERT INTO prefs(key,value_json) VALUES('markReadDelay','\"manual\"') ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
    ).run();
    db.prepare(
      "INSERT INTO prefs(key,value_json) VALUES('language','\"en\"') ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
    ).run();
    db.prepare(
      "INSERT INTO prefs(key,value_json) VALUES('defaultProfilesPrompted','true') ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
    ).run();
    // Stray swipes or Delete presses that reach the smoke window must not change mail.
    db.prepare(
      `INSERT INTO prefs(key,value_json) VALUES('swipeActions','{"leftShort":"none","leftLong":"none","rightShort":"none","rightLong":"none"}') ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`,
    ).run();
    db.prepare(
      "INSERT INTO prefs(key,value_json) VALUES('deleteKeyAction','\"ask\"') ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
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
