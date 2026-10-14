import { Clock, Effect, Schema } from "effect";

/**
 * A stable code for every warning and error log. The diagnostics file records the code and
 * never the message, so a log site without a code would reach it as `unclassified`.
 * `scripts/repo-checks/src/diagnostic-log-sites.test.ts` fails when source code logs a warning or error without these helpers.
 */
export const LogCode = Schema.Literals([
  "header-backfill-failed",
  "history-backfill-failed",
  "sync-failed",
  "sync-crashed",
  "inbox-poll-failed",
  "flush-failed",
  "media-index-failed",
  "search-index-failed",
  "semantic-index-failed",
  "attachment-cache-unavailable",
  "attachment-cleanup-failed",
  "draft-organization-failed",
  "sent-archive-failed",
  "sent-copy-failed",
  "wal-checkpoint-deferred",
  "vector-search-unavailable",
  "browser-open-failed",
  "oauth-clients-file-invalid",
  "refresh-token-save-failed",
  "token-keepalive-failed",
  "snooze-wake-failed",
  "provider-failure",
  "reauth-required",
  "reconnect-sync-failed",
  "notification-action-failed",
  "thread-link-open-failed",
  "link-open-failed",
  "system-refresh-failed",
  "keychain-remove-failed",
  "token-revoke-failed",
  "planner-stats-skipped",
]);
export type LogCode = typeof LogCode.Type;

/** The log annotation that carries the code. */
export const LOG_CODE_ANNOTATION = "logCode";

/** `Effect.logWarning` with its diagnostics code attached. */
export const logWarning = (code: LogCode, ...message: ReadonlyArray<unknown>) =>
  Effect.logWarning(...message).pipe(Effect.annotateLogs(LOG_CODE_ANNOTATION, code));

/** `Effect.logError` with its diagnostics code attached. */
export const logError = (code: LogCode, ...message: ReadonlyArray<unknown>) =>
  Effect.logError(...message).pipe(Effect.annotateLogs(LOG_CODE_ANNOTATION, code));

/**
 * `logWarning` for a background loop that retries on its own: it writes at most once per
 * `intervalMs`, so a failure repeating every few seconds leaves one line, not thousands.
 */
export const throttledWarning = (code: LogCode, intervalMs = 10 * 60_000) => {
  let last = Number.NEGATIVE_INFINITY;
  return (...message: ReadonlyArray<unknown>) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => {
      if (now - last < intervalMs) return Effect.void;
      last = now;
      return logWarning(code, ...message);
    });
};

/** The code in a log line's annotations, or undefined. Any other annotation value is ignored. */
export function logCodeOf(annotations: unknown): LogCode | undefined {
  if (typeof annotations !== "object" || annotations === null) return undefined;
  if (!Object.hasOwn(annotations, LOG_CODE_ANNOTATION)) return undefined;
  const decoded = Schema.decodeUnknownOption(LogCode)(
    Reflect.get(annotations, LOG_CODE_ANNOTATION),
  );
  return decoded._tag === "Some" ? decoded.value : undefined;
}

/**
 * A planner statistics refresh that did not run: another process held the write lock, or the
 * database is read-only. Only the SQLite result code is recorded, never a path or message.
 */
export const PlannerStatsSkippedDiagnostic = Schema.Struct({
  _tag: Schema.Literal("PlannerStatsSkippedDiagnostic"),
  reason: Schema.Literal("planner-stats-skipped"),
  code: Schema.optionalKey(Schema.Int),
});
export type PlannerStatsSkippedDiagnostic = typeof PlannerStatsSkippedDiagnostic.Type;
