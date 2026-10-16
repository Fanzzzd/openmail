import { Context, Effect, Schema } from "effect";
import { logWarning } from "../domain/diagnostic-log.js";
import type { Account } from "../domain/account.js";
import { KEYCHAIN_LOCKED_MESSAGE } from "../domain/errors.js";
import { sha256Hex } from "../platform/crypto.js";

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
  return logWarning("sync-failed", {
    _tag: "SyncFailedDiagnostic",
    reason: "sync-failed",
    provider: account.provider,
    failure: classifySyncFailure(error),
    scope,
    ...(error.status === undefined ? {} : { status: error.status }),
    accountHash: sha256Hex(account.id.toLowerCase()).slice(0, 16),
  } satisfies SyncFailedDiagnostic);
}

/**
 * A failed sync's error for a log the person reads in their own terminal, never a diagnostics
 * file. The message has addresses, URL queries and token-length runs replaced.
 */
export interface SyncFailureDetail {
  readonly provider: Account["provider"];
  readonly scope: SyncFailedDiagnostic["scope"];
  readonly failure: SyncFailureReason;
  readonly tag: string;
  readonly reason?: string;
  readonly status?: number;
  readonly message: string;
}

/** Receives every failed sync's error. The default drops it; `openmail sync` logs it on stderr. */
export const SyncFailureDetailLog = Context.Reference<
  (detail: SyncFailureDetail) => Effect.Effect<void>
>("openmail/SyncFailureDetailLog", { defaultValue: () => () => Effect.void });

/** The longest message a sync failure detail keeps. */
export const DETAIL_MESSAGE_MAX = 300;

/**
 * An error message on one line, without control or bidi characters, addresses (also
 * %40-encoded, with a display name before them), URL queries and fragments, or anything as
 * long as a token, cut to DETAIL_MESSAGE_MAX characters. It works on a slice of the message,
 * so a provider body of any size costs the same.
 */
export const redactErrorMessage = (message: string): string => {
  const slice = message.slice(0, DETAIL_MESSAGE_MAX * 2);
  const redacted = slice
    // C0 and C1 controls end the line or drive the terminal; bidi marks reorder it.
    .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]+/gu, " ")
    .replace(/%40/gi, "@")
    .replace(
      /(?:"[^"<>]*"|[^\s<>()"',;:@]+(?:[ \t]+[^\s<>()"',;:@]+){0,2})?[ \t]*<[^<>\s]*@[^<>\s]*>/g,
      "<address>",
    )
    .replace(/[^\s<>()"',;:]+@[^\s<>()"',;:]+/g, "<address>")
    .replace(/[?#][^\s)]*/g, (match, at: number, text: string) =>
      // A query or fragment follows a URL or path, never a space.
      at > 0 && !/\s/.test(text[at - 1] ?? " ") ? "" : match,
    )
    .replace(/[A-Za-z0-9+/=_.-]{40,}/g, "<redacted>")
    .replace(/ {2,}/g, " ")
    .trim();
  if (message.length <= slice.length && redacted.length <= DETAIL_MESSAGE_MAX) return redacted;
  // A token cut at the end could show its first characters, so the cut drops the last run.
  return `${redacted.slice(0, DETAIL_MESSAGE_MAX).replace(/[A-Za-z0-9+/=_.-]+$/, "")}…`;
};

export function syncFailureDetail(
  account: Pick<Account, "provider">,
  scope: SyncFailedDiagnostic["scope"],
  error: {
    readonly _tag: string;
    readonly message?: string | undefined;
    readonly status?: number | undefined;
    readonly reason?: string | undefined;
  },
): SyncFailureDetail {
  return {
    provider: account.provider,
    scope,
    failure: classifySyncFailure(error),
    tag: error._tag,
    ...(error.reason === undefined ? {} : { reason: error.reason }),
    ...(error.status === undefined ? {} : { status: error.status }),
    message: redactErrorMessage(error.message ?? ""),
  };
}
