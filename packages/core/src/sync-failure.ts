import { Effect, Schema } from "effect";
import type { Account } from "./domain.js";
import { KEYCHAIN_LOCKED_MESSAGE } from "./errors.js";
import { sha256Hex } from "./platform/crypto.js";

/** Why a sync failed, as stored and shown. Provider response bodies never reach the UI. */
export const SyncFailureReason = Schema.Literals(["quota", "auth", "network", "server", "unknown"]);
export type SyncFailureReason = typeof SyncFailureReason.Type;

/**
 * The fixed text stored as an account's sync error, one per reason. The desktop app translates
 * these; the CLI and MCP print them as they are.
 */
export const SYNC_FAILURE_TEXT: Readonly<Record<SyncFailureReason, string>> = {
  quota: "The mail provider is limiting requests. Sync will try again later.",
  auth: "The server rejected the sign-in.",
  network: "Can't reach the mail server right now.",
  server: "The mail server had a problem. Sync will try again later.",
  unknown: "Sync could not finish. It will retry automatically.",
};

const NETWORK_REASONS = new Set(["connection", "dns", "tls", "refused", "timeout", "unreachable"]);

export function classifySyncFailure(error: {
  readonly _tag: string;
  readonly status?: number | undefined;
  readonly reason?: string | undefined;
}): SyncFailureReason {
  if (error._tag === "AuthError") return "auth";
  if (error._tag !== "ProviderError") return "unknown";
  if (error.reason === "quota" || error.status === 429) return "quota";
  if (error.status === 0 || (error.reason !== undefined && NETWORK_REASONS.has(error.reason)))
    return "network";
  if (error.status !== undefined && error.status >= 500) return "server";
  return "unknown";
}

/** The stored text for a failure. A locked keychain keeps its own text, which the app detects. */
export function syncFailureText(error: {
  readonly _tag: string;
  readonly message?: string | undefined;
  readonly status?: number | undefined;
  readonly reason?: string | undefined;
}): string {
  if (error._tag === "ProviderError" && error.reason === "keychain") return KEYCHAIN_LOCKED_MESSAGE;
  return SYNC_FAILURE_TEXT[classifySyncFailure(error)];
}

/**
 * The reason for a stored sync error, or `unknown` for anything else, such as raw provider text
 * an older version stored.
 */
export function storedSyncFailureReason(text: string): SyncFailureReason {
  for (const reason of SyncFailureReason.literals)
    if (text === SYNC_FAILURE_TEXT[reason] || text.endsWith(`: ${SYNC_FAILURE_TEXT[reason]}`))
      return reason;
  return "unknown";
}

export const SyncFailedDiagnostic = Schema.Struct({
  _tag: Schema.Literal("SyncFailedDiagnostic"),
  reason: Schema.Literal("sync-failed"),
  provider: Schema.Literals(["gmail", "outlook", "imap"]),
  failure: SyncFailureReason,
  scope: Schema.Literals(["full", "inbox"]),
  status: Schema.optionalKey(Schema.Number),
  accountHash: Schema.String,
});
export type SyncFailedDiagnostic = typeof SyncFailedDiagnostic.Type;

/** Fixed fields only: no message, body, URL, folder or account address. */
export function logSyncFailed(
  account: Pick<Account, "id" | "provider">,
  scope: SyncFailedDiagnostic["scope"],
  error: {
    readonly _tag: string;
    readonly status?: number | undefined;
    readonly reason?: string | undefined;
  },
) {
  return Effect.logWarning({
    _tag: "SyncFailedDiagnostic",
    reason: "sync-failed",
    provider: account.provider,
    failure: classifySyncFailure(error),
    scope,
    ...(error.status === undefined ? {} : { status: error.status }),
    accountHash: sha256Hex(account.id.toLowerCase()).slice(0, 16),
  } satisfies SyncFailedDiagnostic);
}
