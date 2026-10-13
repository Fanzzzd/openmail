import { Effect, Schema } from "effect";

import type { Provider } from "../domain/domain.js";
import {
  AuthError,
  isReauthReason,
  KEYCHAIN_LOCKED_MESSAGE,
  ProviderError,
  ReauthReason,
} from "../domain/errors.js";
import { sha256Hex } from "../platform/crypto.js";

/**
 * OAuth error codes that settle the question: the grant or the client is gone, or the
 * provider wants the person back on the consent page. Everything else is retryable.
 * Sources: RFC 6749 §5.2, OpenID Connect Core §3.1.2.6.
 */
const DEFINITIVE_OAUTH_ERRORS: Readonly<Record<string, ReauthReason>> = {
  invalid_grant: "token_revoked",
  interaction_required: "token_revoked",
  invalid_client: "client_mismatch",
  unauthorized_client: "client_mismatch",
  consent_required: "scope_missing",
};

const OAuthErrorBody = Schema.fromJsonString(Schema.Struct({ error: Schema.String }));

/** The OAuth `error` code of a token endpoint response, or undefined when the body has none. */
export function oauthErrorCode(body: string): string | undefined {
  const decoded = Schema.decodeUnknownOption(OAuthErrorBody)(body);
  return decoded._tag === "Some" ? decoded.value.error : undefined;
}

/**
 * Maps a failed token endpoint response. Only the definitive OAuth codes become AuthError;
 * 5xx, 429, other 4xx and unparseable bodies stay retryable. The body never enters a message:
 * it can echo request parameters.
 */
export function tokenEndpointFailure(
  accountId: string,
  status: number,
  body: string,
): AuthError | ProviderError {
  const code = oauthErrorCode(body);
  const reason =
    code !== undefined && Object.hasOwn(DEFINITIVE_OAUTH_ERRORS, code)
      ? DEFINITIVE_OAUTH_ERRORS[code]
      : undefined;
  if (reason !== undefined && (status === 400 || status === 401))
    return new AuthError({ accountId, message: `Sign-in expired (${code})`, reason });
  return new ProviderError({
    message: `Token endpoint ${status}${code ? ` (${code})` : ""}`,
    status,
  });
}

/** RFC 5530 codes on a refused IMAP LOGIN that say "try later", not "wrong password". */
const TRANSIENT_LOGIN_CODES = new Set(["UNAVAILABLE", "INUSE", "LIMIT", "SERVERBUG"]);

/**
 * Server text on a refused LOGIN that means "too many sessions, try later". Gmail answers
 * `NO [ALERT] Too many simultaneous connections. (Failure)` when the account's 15-session cap
 * is reached; the password is fine.
 */
const TRANSIENT_LOGIN_TEXT = /too many simultaneous connections/i;

/**
 * Whether a login the server answered with a refusal is final. Node and mobile pass the
 * IMAP response code, the server's text and the SMTP reply code they have; 4xx SMTP (454)
 * means try later.
 */
export const isLoginRefusal = (reply: {
  readonly imapCode?: string | undefined;
  readonly smtpCode?: number | undefined;
  readonly text?: string | undefined;
}) =>
  !(reply.imapCode !== undefined && TRANSIENT_LOGIN_CODES.has(reply.imapCode.toUpperCase())) &&
  !(reply.text !== undefined && TRANSIENT_LOGIN_TEXT.test(reply.text)) &&
  !(reply.smtpCode !== undefined && reply.smtpCode < 500);

/** Google expires refresh tokens of apps in Testing status seven days after consent. */
const TESTING_MODE_MIN_MS = 6.5 * 86_400_000;

/** An invalid_grant from the built-in Google client at least 6.5 days after sign-in. */
export const isTestingModeExpiry = (issuedAt: number, now: number) =>
  now - issuedAt >= TESTING_MODE_MIN_MS;

/** A keep-alive refresh is due after this long without one, checked every KEEP_ALIVE_CHECK. */
export const KEEP_ALIVE_MAX_AGE_MS = 6 * 86_400_000;
export const KEEP_ALIVE_CHECK = "6 hours";

/**
 * The AuthError in a failed provider call: one already raised, or a 401 that survived
 * provider-http's forced refresh. Undefined for every other failure.
 */
export const authFailure = (
  accountId: string,
  error: { readonly status?: number | undefined; readonly message?: string | undefined },
): AuthError | undefined =>
  error instanceof AuthError
    ? error
    : error.status === 401
      ? new AuthError({ accountId, message: error.message ?? "Sign in again" })
      : undefined;

/** The reason to store when an AuthError marks an account. */
export const reauthReason = (error: AuthError): ReauthReason =>
  isReauthReason(error.reason) ? error.reason : "token_revoked";

/** Fixed fields only: provider, reason code and the account hash. Never a token or message. */
export const ReauthDiagnostic = Schema.Struct({
  _tag: Schema.Literal("ReauthDiagnostic"),
  provider: Schema.Literals(["gmail", "outlook", "imap"]),
  reason: ReauthReason,
  accountHash: Schema.String,
});
export type ReauthDiagnostic = typeof ReauthDiagnostic.Type;

export const logReauth = (provider: Provider, accountId: string, reason: ReauthReason) =>
  Effect.logWarning({
    _tag: "ReauthDiagnostic",
    provider,
    reason,
    accountHash: sha256Hex(accountId.toLowerCase()).slice(0, 16),
  } satisfies ReauthDiagnostic);

export const keychainLocked = () =>
  new ProviderError({ message: KEYCHAIN_LOCKED_MESSAGE, reason: "keychain" });
