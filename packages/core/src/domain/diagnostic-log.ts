import { Clock, Context, Effect, Schema } from "effect";
import { hmacSha256Hex, sha256Hex } from "../platform/crypto.js";

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
  "send-claim-renew-failed",
  "wal-checkpoint-deferred",
  "database-maintenance-failed",
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
  "agent-activity-dropped",
  "rpc-slow",
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

/**
 * The per-install secret that account and folder hashes in log records are keyed with. The
 * desktop app supplies the key from `diagnostics.key` (see `createLocalDiagnostics`). Every
 * other entry point (the CLI, MCP, mobile) keeps the default, which has no key, so their log
 * records carry no hash at all. No log line holds a value a guessed address can be checked
 * against.
 */
export const DiagnosticHashKey = Context.Reference<(() => string | undefined) | null>(
  "openmail/DiagnosticHashKey",
  { defaultValue: () => null },
);

/**
 * The 16-digit hash of an account ID or folder name under `key`: HMAC-SHA256 of the kind and
 * the value's SHA-256 prefix. The only place a log hash is computed; never log the inner prefix.
 */
export const keyedDiagnosticHash = (key: string, kind: "account" | "folder", value: string) =>
  hmacSha256Hex(
    key,
    `${kind}:${sha256Hex(kind === "account" ? value.toLowerCase() : value).slice(0, 16)}`,
  ).slice(0, 16);

/**
 * `accountHash` and `folderHash` for a log record, keyed with DiagnosticHashKey, or no fields
 * when no key was provided.
 */
export const diagnosticHashes = (of: { readonly account?: string; readonly folder?: string }) =>
  Effect.gen(function* () {
    const key = (yield* DiagnosticHashKey)?.();
    const hashes: { accountHash?: string; folderHash?: string } = {};
    if (key === undefined) return hashes;
    if (of.account !== undefined)
      hashes.accountHash = keyedDiagnosticHash(key, "account", of.account);
    if (of.folder !== undefined) hashes.folderHash = keyedDiagnosticHash(key, "folder", of.folder);
    return hashes;
  });
