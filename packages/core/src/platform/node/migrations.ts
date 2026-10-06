import { checkDatabaseUpgradeSpace } from "./database-upgrade.js";
import { Cause, Effect } from "effect";
import type { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, withMigrationForeignKeys } from "../../db.js";

/** Native maintenance, fixtures and smoke share core's FK-off rebuild boundary. */
export function applyNativeMigration(db: DatabaseSync, script: string, version?: number) {
  const rebuild = script === MIGRATIONS[36];
  if (rebuild) checkDatabaseUpgradeSpace(db);
  const transaction = Effect.sync(() => {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (
        version !== undefined &&
        Number(db.prepare("PRAGMA user_version").get()?.user_version) >= version
      ) {
        db.exec("COMMIT");
        return;
      }
      db.exec(script);
      if (rebuild && db.prepare("PRAGMA foreign_key_check").all().length)
        throw new Error("Cache rowid migration violates foreign keys");
      if (version !== undefined) db.exec(`PRAGMA user_version=${version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  const exit = Effect.runSyncExit(
    rebuild
      ? withMigrationForeignKeys(
          (statement) =>
            Effect.sync(() => {
              const prepared = db.prepare(statement);
              return prepared.columns().length ? prepared.all() : prepared.run();
            }),
          transaction,
        )
      : transaction,
  );
  if (exit._tag === "Failure") throw Cause.squash(exit.cause);
}
