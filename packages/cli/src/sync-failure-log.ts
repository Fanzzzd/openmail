import { SyncFailedDiagnostic, SyncFailureDetailLog, logWarning } from "@openmail/core";
import type { SyncFailureDetail } from "@openmail/core/schema";
import { Effect, Logger, Schema } from "effect";

/**
 * Why an account did not sync, for --log-level: an unknown failure at warn, the rest at debug.
 * The CLI and the MCP server write no diagnostics file, and core already took addresses and
 * tokens out.
 */
const logSyncFailure = (detail: SyncFailureDetail) => {
  const line =
    [
      `${detail.provider} sync failed (${detail.scope}): ${detail.tag}`,
      ...(detail.reason === undefined ? [] : [`reason ${detail.reason}`]),
      ...(detail.status === undefined ? [] : [`status ${detail.status}`]),
    ].join(", ") + (detail.message ? `: ${detail.message}` : "");
  return detail.failure === "unknown" ? logWarning("sync-failed", line) : Effect.logDebug(line);
};

const isSyncFailedDiagnostic = Schema.is(SyncFailedDiagnostic);

/**
 * Runs `effect` with loggers that skip core's SyncFailedDiagnostic. That record holds fixed
 * fields for the app's diagnostics file, and the CLI writes none. logSyncFailure's line says the
 * same and why, so --log-level warn prints one line for each failed account.
 */
const withoutSyncFailedDiagnostic = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const loggers = yield* Logger.CurrentLoggers;
    const skipping = [...loggers].map((logger) =>
      Logger.make((options) => {
        const messages: readonly unknown[] = Array.isArray(options.message)
          ? options.message
          : [options.message];
        if (!messages.some(isSyncFailedDiagnostic)) logger.log(options);
      }),
    );
    return yield* effect.pipe(Effect.provideService(Logger.CurrentLoggers, new Set(skipping)));
  });

/**
 * Logs each failed sync in `effect` as one redacted line on stderr instead of core's
 * SyncFailedDiagnostic. `openmail sync` and every MCP entry point use it.
 */
export const withSyncFailureLog = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(SyncFailureDetailLog, logSyncFailure),
    withoutSyncFailedDiagnostic,
  );
