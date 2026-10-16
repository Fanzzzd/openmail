import { Worker } from "node:worker_threads";
import { logError, logWarning } from "../../domain/diagnostic-log.js";
import { Effect, Schema } from "effect";
import { constVoid } from "effect/Function";
import { CacheCompactionResult } from "../../domain/cache.js";
import type { CacheMaintenanceRequest } from "../cache-storage.js";
import { exclusiveMaintenanceLease } from "./database-access.js";

/**
 * Why the worker failed: a SQL error, a corrupt file, a missing built migrations module, another
 * exception, or the worker itself crashed or sent something else. Disk space and a held lock
 * have their own results.
 */
const FailureReason = Schema.Literals([
  "sql",
  "corrupt",
  "missing-module",
  "error",
  "crash",
  "bad-reply",
]);
type FailureReason = typeof FailureReason.Type;
const MaintenanceFailed = Schema.Struct({
  _tag: Schema.Literal("MaintenanceFailed"),
  reason: FailureReason,
});
const WorkerReply = Schema.Union([
  CacheCompactionResult,
  Schema.Struct({ _tag: Schema.Literal("UpgradeCheckpointDeferred") }),
  MaintenanceFailed,
]);
type WorkerReply = typeof WorkerReply.Type;
const failed = (reason: FailureReason): WorkerReply => ({ _tag: "MaintenanceFailed", reason });

/** The caller reserves its SQL connection and sync/flush locks throughout this worker. */
export const nodeCacheMaintenance = {
  run: (request: CacheMaintenanceRequest) =>
    Effect.gen(function* () {
      // The upgrade caller already holds the only connection; compaction needs a lease.
      const release =
        request.kind === "upgrade"
          ? constVoid
          : yield* Effect.sync(() => exclusiveMaintenanceLease(request.file));
      if (!release) return "busy" as const;
      return yield* Effect.tryPromise(
        () =>
          new Promise<WorkerReply>((resolve, reject) => {
            const worker = new Worker(new URL("./cache-worker.mjs", import.meta.url), {
              workerData: {
                ...request,
                migrationModule: new URL(
                  "../../../dist/platform/node/migrations.js",
                  import.meta.url,
                ).href,
              },
              execArgv: [],
            });
            let settled = false;
            const finish = (result: WorkerReply) => {
              if (settled) return;
              settled = true;
              void worker.terminate().then(() => resolve(result), reject);
            };
            worker.once("message", (message: unknown) => {
              const decoded = Schema.decodeUnknownOption(WorkerReply)(message);
              finish(decoded._tag === "Some" ? decoded.value : failed("bad-reply"));
            });
            worker.once("error", () => finish(failed("crash")));
            worker.once("exit", () => {
              if (!settled) finish(failed("crash"));
            });
          }),
      ).pipe(
        Effect.catch(() => Effect.succeed(failed("crash"))),
        Effect.flatMap((reply) =>
          typeof reply === "string"
            ? Effect.succeed(reply)
            : reply._tag === "MaintenanceFailed"
              ? logError(
                  "database-maintenance-failed",
                  `Local database ${request.kind} worker failed: ${reply.reason}`,
                ).pipe(Effect.as("failed" as const))
              : logWarning(
                  "wal-checkpoint-deferred",
                  "Local database upgrade committed; WAL checkpoint deferred while another connection holds a read.",
                ).pipe(Effect.as("done" as const)),
        ),
        Effect.ensuring(Effect.sync(release)),
      );
    }).pipe(Effect.uninterruptible),
};
