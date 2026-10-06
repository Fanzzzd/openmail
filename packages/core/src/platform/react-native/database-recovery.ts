import {
  Clock,
  Context,
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  Schema,
  Semaphore,
} from "effect";
import { SqlClient } from "effect/sql";
import type { DatabaseCapabilities } from "../../db.js";
import { AppPaths } from "../paths.js";
import { PlatformCrypto } from "../crypto.js";
import { RECOVERY_TABLES } from "../recovery-tables.js";
import { opSqliteLayer, type OpSqliteDatabase, type SqliteScalar } from "./sqlite.js";

export class MobileRecoveryError extends Schema.TaggedError<MobileRecoveryError>()(
  "MobileRecoveryError",
  {
    reason: Schema.Literals(["corrupt", "interrupted", "unavailable", "in-use"]),
    message: Schema.String,
  },
) {}
const Report = Schema.Struct({
  backup: Schema.String,
  fresh: Schema.String,
  copied: Schema.Int,
  skipped: Schema.Int,
});
const Receipt = Schema.Struct({
  ...Report.fields,
  acknowledged: Schema.optionalKey(Schema.Boolean),
});
export type MobileRecoveryReport = typeof Report.Type;
export type MobileDatabaseState =
  | { kind: "healthy" }
  | { kind: "corrupt" }
  | { kind: "interrupted" }
  | { kind: "recovered"; report: MobileRecoveryReport };
export class MobileDatabaseRecovery extends Context.Service<
  MobileDatabaseRecovery,
  {
    readonly inspect: (options?: {
      force?: boolean;
      background?: boolean;
    }) => Effect.Effect<MobileDatabaseState, MobileRecoveryError>;
    readonly open: (
      inspection?: MobileDatabaseState,
    ) => Effect.Effect<OpSqliteDatabase, MobileRecoveryError>;
    readonly rebuild: Effect.Effect<MobileRecoveryReport, MobileRecoveryError>;
    readonly acknowledge: Effect.Effect<void, MobileRecoveryError>;
  }
>()("openmail/MobileDatabaseRecovery") {}
export type MobileDatabaseOpener = (options: {
  name: string;
  location: string;
  readOnly: boolean;
}) => OpSqliteDatabase;
const suffixes = ["", "-wal", "-shm", "-journal"] as const;
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

// Native op-sqlite exposes sqlite3_errmsg as an Error, without a numeric SQLite code.
function corruption(error: unknown): boolean {
  return (
    error instanceof Error &&
    /database disk image is malformed|file is not a database|malformed database schema/i.test(
      error.message,
    )
  );
}
async function quickCheck(db: OpSqliteDatabase): Promise<"ok" | "corrupt"> {
  try {
    const { rows } = await db.execute("PRAGMA quick_check");
    return rows.length === 1 && rows[0]?.quick_check === "ok" ? "ok" : "corrupt";
  } catch (error) {
    if (corruption(error)) return "corrupt";
    throw error;
  }
}

/** Preserve user state; message/FTS/vector caches are rebuilt by normal provider sync. */
async function copyTable(source: OpSqliteDatabase, target: OpSqliteDatabase, table: string) {
  let copied = 0;
  let skipped = 0;
  const quoted = identifier(table);
  const targetInfo = (await target.execute(`PRAGMA table_info(${quoted})`)).rows;
  let sourceInfo;
  try {
    sourceInfo = (await source.execute(`PRAGMA table_info(${quoted})`)).rows;
  } catch (error) {
    if (!corruption(error)) throw error;
    return { copied, skipped: 1 };
  }
  const names = new Set(targetInfo.map((column) => column.name));
  const columns = sourceInfo.flatMap((column) =>
    typeof column.name === "string" && names.has(column.name) ? [column.name] : [],
  );
  if (!columns.length) return { copied, skipped };
  const nullable = new Set(
    targetInfo
      .filter((column) => column.notnull === 0 && column.pk === 0)
      .map((column) => column.name),
  );
  const parents = (await target.execute(`PRAGMA foreign_key_list(${quoted})`)).rows.flatMap((fk) =>
    typeof fk.from === "string" &&
    typeof fk.table === "string" &&
    typeof fk.to === "string" &&
    nullable.has(fk.from)
      ? [
          {
            column: fk.from,
            query: `SELECT 1 FROM ${identifier(fk.table)} WHERE ${identifier(fk.to)}=?`,
          },
        ]
      : [],
  );
  const projection = columns.map(identifier).join(",");
  const insert = `INSERT INTO ${quoted} (${projection}) VALUES (${columns.map(() => "?").join(",")})`;
  const copy = async (row: Record<string, SqliteScalar>) => {
    for (const parent of parents) {
      const value = row[parent.column];
      if (
        value !== null &&
        value !== undefined &&
        !(await target.execute(parent.query, [value])).rows.length
      ) {
        row[parent.column] = null;
      }
    }
    try {
      await target.execute(
        insert,
        columns.map((name) => row[name] ?? null),
      );
      copied++;
    } catch (error) {
      // Only constraint failures are skippable. Storage/IO errors must abort installation.
      if (!(error instanceof Error) || !/constraint failed/i.test(error.message)) throw error;
      skipped++;
    }
  };
  let last = 0;
  try {
    for (;;) {
      const rows = (
        await source.execute(
          `SELECT rowid AS recovery_rowid,${projection} FROM ${quoted} WHERE rowid>? ORDER BY rowid LIMIT 128`,
          [last],
        )
      ).rows;
      if (!rows.length) break;
      for (const row of rows) {
        if (typeof row.recovery_rowid !== "number") throw new Error("Invalid recovery rowid");
        last = row.recovery_rowid;
        await copy(row);
      }
    }
  } catch (error) {
    if (!corruption(error)) throw error;
    skipped++;
    // Read later rows independently when a damaged B-tree page stops ordered scanning.
    let maximum;
    try {
      maximum = (await source.execute(`SELECT MAX(rowid) AS maximum FROM ${quoted}`)).rows[0]
        ?.maximum;
    } catch (readError) {
      if (!corruption(readError)) throw readError;
      return { copied, skipped: skipped + 1 };
    }
    if (typeof maximum === "number") {
      for (let id = last + 1; id <= maximum; id++) {
        let rows;
        try {
          rows = (await source.execute(`SELECT ${projection} FROM ${quoted} WHERE rowid=?`, [id]))
            .rows;
        } catch (readError) {
          if (!corruption(readError)) throw readError;
          skipped++;
          continue;
        }
        for (const row of rows) await copy(row);
      }
    }
  }
  return { copied, skipped };
}

const backupName = (name: string) => /^mail\.db\.corrupt-[\w-]+$/.test(name);
const Snapshot = Schema.Struct({
  backup: Schema.String,
  suffixes: Schema.Array(Schema.Literals(["", "-wal", "-shm", "-journal"])),
  createdAt: Schema.Number,
  phase: Schema.Literals(["preserved", "installed"]),
});
type Snapshot = typeof Snapshot.Type;
const ForegroundCheck = Schema.Struct({
  at: Schema.Int,
  result: Schema.Literals(["ok", "corrupt", "unavailable"]),
});
type ForegroundCheck = typeof ForegroundCheck.Type;
export const MOBILE_DATABASE_CHECK_MAX_AGE_MS = 30 * 60 * 1000;

/** One service per process. Never install a replacement while a mailbox connection is open. */
export const mobileDatabaseRecoveryLayer = (openDatabase: MobileDatabaseOpener) =>
  Layer.effect(
    MobileDatabaseRecovery,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* Effect.flatMap(AppPaths, (paths) => paths.dataDirectory);
      const crypto = yield* PlatformCrypto;
      const clock = yield* Clock.Clock;
      const semaphore = yield* Semaphore.make(1);
      const file = `${root}/mail.db`;
      const marker = `${file}.recovery-state.json`;
      const receipt = `${file}.recovered.json`;
      const foregroundCheckFile = `${file}.foreground-check.json`;
      let lastMainCheck: ForegroundCheck | undefined;
      const run = Effect.runPromise;
      const exists = (path: string) => run(fs.exists(path));
      const remove = (path: string) => run(fs.remove(path, { force: true }));
      const names = () => run(fs.readDirectory(root));
      const open = (name: string, readOnly: boolean) =>
        openDatabase({ name, location: root, readOnly });
      const check = async (name: string) => {
        let db;
        let result: ForegroundCheck["result"] = "unavailable";
        try {
          db = open(name, true);
          result = await quickCheck(db);
          return result;
        } catch (error) {
          if (corruption(error)) {
            result = "corrupt";
            return result;
          }
          throw error;
        } finally {
          if (name === "mail.db") lastMainCheck = { at: clock.currentTimeMillisUnsafe(), result };
          db?.close();
        }
      };
      const atomicWrite = async (path: string, value: unknown) => {
        const temporary = `${path}.tmp`;
        try {
          await run(fs.writeFileString(temporary, JSON.stringify(value)));
          await run(fs.rename(temporary, path));
        } finally {
          await remove(temporary);
        }
      };
      const readReport = async (path: string) => {
        const report = Schema.decodeUnknownSync(Report)(
          JSON.parse(await run(fs.readFileString(path))),
        );
        if (!backupName(report.backup) || !/^mail\.db\.recovery-[\w-]+$/.test(report.fresh))
          throw new Error("Invalid recovery paths");
        return report;
      };
      const readReceipt = async () => {
        const value = Schema.decodeUnknownSync(Receipt)(
          JSON.parse(await run(fs.readFileString(receipt))),
        );
        if (!backupName(value.backup) || !/^mail\.db\.recovery-[\w-]+$/.test(value.fresh))
          throw new Error("Invalid recovery paths");
        return value;
      };
      const snapshots = async () => {
        const results: Snapshot[] = [];
        for (const name of await names()) {
          if (!/^mail\.db\.corrupt-[\w-]+\.json$/.test(name)) continue;
          try {
            const snapshot = Schema.decodeUnknownSync(Snapshot)(
              JSON.parse(await run(fs.readFileString(`${root}/${name}`))),
            );
            if (
              !backupName(snapshot.backup) ||
              name !== `${snapshot.backup}.json` ||
              !snapshot.suffixes.includes("")
            )
              continue;
            let complete = true;
            for (const suffix of snapshot.suffixes)
              if (!(await exists(`${root}/${snapshot.backup}${suffix}`))) complete = false;
            if (complete) results.push(snapshot);
          } catch {
            /* Incomplete metadata is an interrupted copy, never a reusable snapshot. */
          }
        }
        return results.toSorted((a, b) => b.createdAt - a.createdAt);
      };
      // An explicit backup is protected even if its completion metadata was lost.
      // Otherwise only complete copies are eligible while mail.db still exists.
      const prune = async (protectedBackup?: string, fresh?: string) => {
        const entries = await names();
        const candidates = entries
          .filter(
            (name) =>
              backupName(name) && !suffixes.slice(1).some((suffix) => name.endsWith(suffix)),
          )
          .toSorted();
        const live = await exists(file);
        let reportedBackup;
        try {
          const report = await readReceipt();
          if (await exists(`${root}/${report.backup}`)) reportedBackup = report.backup;
        } catch {
          /* A missing report cannot attest that an unclassified copy was complete. */
        }
        const complete = await snapshots();
        const currentOriginal = complete.find((snapshot) => snapshot.phase === "preserved");
        const preserved =
          protectedBackup ??
          currentOriginal?.backup ??
          reportedBackup ??
          complete[0]?.backup ??
          (!live ? candidates.at(-1) : undefined);
        const canRemoveFresh =
          live || (preserved !== undefined && (await exists(`${root}/${preserved}`)));
        for (const name of entries) {
          const base = name.replace(/(?:-wal|-shm|-journal|\.json(?:\.tmp)?)$/, "");
          if (backupName(base) && base !== preserved) await remove(`${root}/${name}`);
          if (
            canRemoveFresh &&
            /^mail\.db\.recovery-[\w-]+(?:-wal|-shm|-journal)?$/.test(name) &&
            name !== fresh &&
            !suffixes.slice(1).some((suffix) => name === `${fresh}${suffix}`)
          )
            await remove(`${root}/${name}`);
        }
        await remove(`${marker}.tmp`);
      };
      let connections = 0;
      let forcedCorrupt = false;
      let failedCheck = false;
      let cached: { state: MobileDatabaseState; at: number } | undefined;
      const remember = (state: MobileDatabaseState, at = clock.currentTimeMillisUnsafe()) => {
        cached = { state, at };
        failedCheck = state.kind === "corrupt" || state.kind === "interrupted";
        return state;
      };
      const freshCheck = (at: number) => {
        const age = clock.currentTimeMillisUnsafe() - at;
        return age >= 0 && age < MOBILE_DATABASE_CHECK_MAX_AGE_MS;
      };
      const persistForegroundCheck = async (record: ForegroundCheck | undefined) => {
        // A cache failure must not block a verified DB or leave an older success masking a failure.
        try {
          await (record ? atomicWrite(foregroundCheckFile, record) : remove(foregroundCheckFile));
        } catch {
          try {
            await remove(foregroundCheckFile);
          } catch {
            /* Storage is unavailable; check again when readable. */
          }
        }
      };
      const saveForegroundState = (state: MobileDatabaseState) =>
        persistForegroundCheck(
          state.kind === "healthy" || state.kind === "recovered"
            ? lastMainCheck?.result === "ok"
              ? lastMainCheck
              : undefined
            : {
                at: clock.currentTimeMillisUnsafe(),
                result: state.kind === "corrupt" ? "corrupt" : "unavailable",
              },
        );
      const readForegroundCheck = async () => {
        try {
          const record = Schema.decodeUnknownSync(ForegroundCheck)(
            JSON.parse(await run(fs.readFileString(foregroundCheckFile))),
          );
          return record.result === "ok" && freshCheck(record.at) ? record : null;
        } catch {
          return null;
        }
      };
      const attempt = <A>(fn: () => Promise<A>) =>
        Effect.tryPromise({
          try: fn,
          catch: (error) =>
            error instanceof MobileRecoveryError
              ? error
              : new MobileRecoveryError({
                  reason: "unavailable",
                  message: "The local database could not be verified or recovered",
                }),
        }).pipe(Effect.uninterruptible, semaphore.withPermits(1));
      const abandonMarker = async (): Promise<MobileDatabaseState> => {
        // Do not delete either candidate here. A user-requested retry cleans preparation leftovers.
        forcedCorrupt = true;
        cached = undefined;
        await remove(marker);
        const snapshot = (await snapshots())[0];
        if (snapshot)
          await atomicWrite(`${root}/${snapshot.backup}.json`, { ...snapshot, phase: "preserved" });
        return remember({ kind: "corrupt" });
      };
      const replacement = async (report: MobileRecoveryReport) => {
        const candidate = (await exists(`${root}/${report.fresh}`)) ? report.fresh : "mail.db";
        if (!(await exists(`${root}/${report.backup}`)) || !(await exists(`${root}/${candidate}`)))
          throw new MobileRecoveryError({
            reason: "corrupt",
            message: "The prepared database could not be verified",
          });
        let integrity;
        try {
          integrity = await check(candidate);
        } catch {
          throw new MobileRecoveryError({
            reason: "unavailable",
            message: "The prepared database is temporarily unavailable",
          });
        }
        if (integrity !== "ok")
          throw new MobileRecoveryError({
            reason: "corrupt",
            message: "The prepared database could not be verified",
          });
        return candidate;
      };
      const inspect = async (
        options: { force?: boolean; background?: boolean } = {},
      ): Promise<MobileDatabaseState> => {
        const stale = cached === undefined || !freshCheck(cached.at);
        const foregroundNeedsCheck =
          !options.background &&
          (cached?.state.kind === "healthy" || cached?.state.kind === "recovered") &&
          lastMainCheck?.result !== "ok";
        if (
          !options.force &&
          cached &&
          !foregroundNeedsCheck &&
          (!options.background || (!failedCheck && !stale))
        ) {
          if (!options.background) await saveForegroundState(cached.state);
          return cached.state;
        }
        const finish = async (state: MobileDatabaseState, at?: number) => {
          remember(state, at);
          if (!options.background) await saveForegroundState(state);
          return state;
        };
        try {
          // Invalidate the old success before a new foreground check can fail to persist on a full disk.
          if (!options.background) await remove(foregroundCheckFile);
          if (await exists(marker)) {
            let report;
            try {
              report = await readReport(marker);
            } catch {
              return await finish(await abandonMarker());
            }
            try {
              await replacement(report);
            } catch (error) {
              if (!(error instanceof MobileRecoveryError) || error.reason !== "corrupt")
                throw error;
              return await finish(await abandonMarker());
            }
            return await finish({ kind: "interrupted" });
          }
          if (forcedCorrupt) return await finish({ kind: "corrupt" });
          const snapshot = (await snapshots())[0];
          if (snapshot?.phase === "preserved") return await finish({ kind: "corrupt" });
          const present = await exists(file);
          if (!present && (snapshot || (await names()).some((name) => backupName(name))))
            return await finish({ kind: "corrupt" });
          const persisted =
            present && options.background && !options.force
              ? await readForegroundCheck()
              : undefined;
          if (present && !persisted && (await check("mail.db")) !== "ok")
            return await finish({ kind: "corrupt" });
          if (!present && (await exists(receipt))) return await finish({ kind: "corrupt" });
          if (await exists(receipt)) {
            const report = await readReceipt();
            if (!report.acknowledged)
              return await finish({ kind: "recovered", report }, persisted?.at);
          }
          return await finish({ kind: "healthy" }, persisted?.at);
        } catch (error) {
          failedCheck = true;
          cached = undefined;
          if (!options.background)
            await persistForegroundCheck({
              at: clock.currentTimeMillisUnsafe(),
              result: "unavailable",
            });
          throw error;
        }
      };
      const install = async (report: MobileRecoveryReport) => {
        let candidate;
        try {
          candidate = await replacement(report);
        } catch (error) {
          if (!(error instanceof MobileRecoveryError) || error.reason !== "corrupt") throw error;
          await abandonMarker();
          throw error;
        }
        if (candidate === report.fresh) {
          for (const suffix of suffixes) await remove(`${file}${suffix}`);
          try {
            await run(fs.rename(`${root}/${report.fresh}`, file));
          } catch {
            // The original is quarantined and the verified replacement must remain resumable.
            throw new MobileRecoveryError({
              reason: "unavailable",
              message: "The prepared database could not be installed yet",
            });
          }
        }
        let integrity;
        try {
          integrity = await check("mail.db");
        } catch {
          throw new MobileRecoveryError({
            reason: "unavailable",
            message: "The installed database is temporarily unavailable",
          });
        }
        if (integrity !== "ok") {
          await abandonMarker();
          throw new MobileRecoveryError({
            reason: "corrupt",
            message: "Rebuild the local database again",
          });
        }
        await atomicWrite(receipt, report);
        const snapshot = (await snapshots()).find((item) => item.backup === report.backup);
        if (snapshot)
          await atomicWrite(`${root}/${snapshot.backup}.json`, { ...snapshot, phase: "installed" });
        await remove(marker);
        forcedCorrupt = false;
        remember({ kind: "recovered", report });
        await saveForegroundState({ kind: "recovered", report });
        await prune(report.backup);
        return report;
      };
      const cleanFailedPreparation = async (
        protectedBackup?: string,
        fresh?: string,
        error?: unknown,
      ) => {
        if (forcedCorrupt) return;
        if (error instanceof MobileRecoveryError && error.reason === "unavailable") {
          failedCheck = true;
          cached = undefined;
          return;
        }
        if (fresh && (await exists(`${root}/${fresh}`))) await remove(marker);
        if (!(await exists(marker))) await prune(protectedBackup);
        failedCheck = true;
        cached = undefined;
      };
      return MobileDatabaseRecovery.of({
        inspect: (options) => attempt(() => inspect(options)),
        open: (inspection) =>
          attempt(async () => {
            const state =
              inspection !== undefined && inspection === cached?.state && !failedCheck
                ? inspection
                : await inspect({ background: true });
            if (state.kind === "corrupt" || state.kind === "interrupted")
              throw new MobileRecoveryError({
                reason: state.kind,
                message: "Local database recovery is required",
              });
            const db = open("mail.db", false);
            connections++;
            let closed = false;
            return {
              execute: (query, params) => db.execute(query, params),
              executeRaw: (query, params) => db.executeRaw(query, params),
              close: () => {
                if (!closed) {
                  db.close();
                  closed = true;
                  connections--;
                }
              },
            };
          }),
        acknowledge: attempt(async () => {
          if (await exists(receipt))
            await atomicWrite(receipt, { ...(await readReceipt()), acknowledged: true });
          if (cached?.state.kind === "recovered")
            cached = { ...cached, state: { kind: "healthy" } };
        }),
        rebuild: attempt(async () => {
          if (connections)
            throw new MobileRecoveryError({
              reason: "in-use",
              message: "Close the mailbox before recovery",
            });
          lastMainCheck = undefined;
          await persistForegroundCheck(undefined);
          if (await exists(marker)) {
            let report;
            try {
              report = await readReport(marker);
            } catch {
              await abandonMarker();
              throw new MobileRecoveryError({
                reason: "corrupt",
                message: "Rebuild the local database again",
              });
            }
            try {
              return await install(report);
            } catch (error) {
              await cleanFailedPreparation(report.backup, report.fresh, error);
              throw error;
            }
          }
          if ((await inspect({ force: true })).kind !== "corrupt")
            throw new Error("Recovery requires confirmed corruption");
          cached = undefined;
          forcedCorrupt = false;
          await prune();
          const previous = (await snapshots())[0];
          let snapshot =
            previous?.phase === "preserved" || !(await exists(file)) ? previous : undefined;
          const id = `${clock.currentTimeMillisUnsafe()}-${crypto.randomUUID()}`;
          const fresh = `mail.db.recovery-${id}`;
          try {
            if (!snapshot && !(await exists(file))) {
              const backup = (await names())
                .filter(
                  (name) =>
                    backupName(name) && !suffixes.slice(1).some((suffix) => name.endsWith(suffix)),
                )
                .toSorted()
                .at(-1);
              if (backup) {
                const present: (typeof suffixes)[number][] = [];
                for (const suffix of suffixes)
                  if (await exists(`${root}/${backup}${suffix}`)) present.push(suffix);
                snapshot = {
                  backup,
                  suffixes: present,
                  createdAt: clock.currentTimeMillisUnsafe(),
                  phase: "preserved",
                };
                await atomicWrite(`${root}/${backup}.json`, snapshot);
              }
            }
            if (!snapshot) {
              const backup = `mail.db.corrupt-${id}`;
              const present: (typeof suffixes)[number][] = [];
              for (const suffix of suffixes)
                if (await exists(`${file}${suffix}`)) {
                  await run(fs.copyFile(`${file}${suffix}`, `${root}/${backup}${suffix}`));
                  present.push(suffix);
                }
              if (!present.includes("")) throw new Error("No preserved database");
              const complete: Snapshot = {
                backup,
                suffixes: present,
                createdAt: clock.currentTimeMillisUnsafe(),
                phase: "preserved",
              };
              await atomicWrite(`${root}/${backup}.json`, complete);
              snapshot = complete;
              await prune(snapshot.backup);
            }
            let source: OpSqliteDatabase | undefined;
            let copied = 0;
            let skipped = 0;
            try {
              source = open(snapshot.backup, true);
            } catch (error) {
              if (!corruption(error)) throw error;
              skipped++;
            }
            let runtime:
              | ManagedRuntime.ManagedRuntime<SqlClient.SqlClient | DatabaseCapabilities, never>
              | undefined;
            try {
              const target = open(fresh, false);
              runtime = ManagedRuntime.make(opSqliteLayer(() => target));
              await runtime.runPromise(SqlClient.SqlClient);
              await target.execute("PRAGMA journal_mode=DELETE");
              await target.execute("BEGIN IMMEDIATE");
              if (source)
                for (const table of RECOVERY_TABLES) {
                  const result = await copyTable(source, target, table);
                  copied += result.copied;
                  skipped += result.skipped;
                }
              await target.execute(
                "UPDATE accounts SET sync_cursor=NULL,last_synced_at=NULL,last_sync_error=NULL",
              );
              await target.execute("COMMIT");
              if ((await quickCheck(target)) !== "ok") throw new Error("Invalid replacement");
            } finally {
              try {
                source?.close();
              } finally {
                await runtime?.dispose();
              }
            }
            const report = { backup: snapshot.backup, fresh, copied, skipped };
            await atomicWrite(marker, report);
            return await install(report);
          } catch (error) {
            // Keep rejected candidates for the fallback. Other caught failures release fresh disk space.
            await cleanFailedPreparation(snapshot?.backup, fresh, error);
            throw error;
          }
        }),
      });
    }),
  );
