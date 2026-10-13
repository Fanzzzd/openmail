import { Effect, Schema } from "effect";
import type { Account } from "./domain/domain.js";
import { KEYCHAIN_LOCKED_MESSAGE } from "./domain/errors.js";
import { sha256Hex } from "./platform/crypto.js";

/** Why a sync failed, as stored and shown. Provider response bodies never reach the UI. */
export const SyncFailureReason = Schema.Literals([
  "quota",
  "auth",
  "network",
  "server",
  "unknown",
  // IMAP/SMTP connection reasons, each with what to check.
  "dns",
  "refused",
  "no_response",
  "tls",
  "unsafe_login",
]);
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
  dns: "Can't find the mail server. Check the server name and your internet connection.",
  refused: "The mail server refused the connection. Check the port.",
  no_response:
    "The mail server didn't respond. Check the server name, the port and your internet connection.",
  tls: "Couldn't set up a secure connection to the mail server. Check the port and the encryption setting.",
  unsafe_login:
    "The server blocked the sign-in as unsafe. Turn on IMAP in your email's web settings, then sign in with the authorization code it generates.",
};

const CONNECTION_REASONS: Readonly<Record<string, SyncFailureReason>> = {
  dns: "dns",
  refused: "refused",
  timeout: "no_response",
  unreachable: "no_response",
  tls: "tls",
  unsafe_login: "unsafe_login",
};

export function classifySyncFailure(error: {
  readonly _tag: string;
  readonly status?: number | undefined;
  readonly reason?: string | undefined;
}): SyncFailureReason {
  if (error._tag === "AuthError") return "auth";
  if (error._tag !== "ProviderError") return "unknown";
  if (error.reason === "quota" || error.status === 429) return "quota";
  const connection =
    error.reason !== undefined && Object.hasOwn(CONNECTION_REASONS, error.reason)
      ? CONNECTION_REASONS[error.reason]
      : undefined;
  if (connection) return connection;
  if (error.status === 0 || error.reason === "connection") return "network";
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
