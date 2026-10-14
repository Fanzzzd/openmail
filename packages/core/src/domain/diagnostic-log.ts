import { Effect, Schema } from "effect";

/**
 * A stable code for every warning and error log. The diagnostics file records the code and
 * never the message, so a log site without a code would reach it as `unclassified`.
 * `diagnostic-log.test.ts` fails when source code logs a warning or error without these helpers.
 */
export const LogCode = Schema.Literals([
  "header-backfill-failed",
  "history-backfill-failed",
  "sync-failed",
  "sync-crashed",
  "inbox-poll-failed",
  "flush-failed",
  "media-index-failed",
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

/** The code in a log line's annotations, or undefined. Any other annotation value is ignored. */
export function logCodeOf(annotations: unknown): LogCode | undefined {
  if (typeof annotations !== "object" || annotations === null) return undefined;
  if (!Object.hasOwn(annotations, LOG_CODE_ANNOTATION)) return undefined;
  const decoded = Schema.decodeUnknownOption(LogCode)(
    Reflect.get(annotations, LOG_CODE_ANNOTATION),
  );
  return decoded._tag === "Some" ? decoded.value : undefined;
}
