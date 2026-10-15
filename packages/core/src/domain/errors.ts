import { Schema } from "effect";

/**
 * Why an account needs a new sign-in. Only definitive answers produce one: an OAuth
 * error code, an IMAP login refusal, a 401 that survives a forced refresh, or a
 * missing keychain item. Stored on the account (migration 44) and in diagnostics.
 */
export const ReauthReason = Schema.Literals([
  "token_revoked",
  "testing_mode_expiry",
  "scope_missing",
  "client_mismatch",
  "keychain_missing",
  "imap_auth_failed",
]);
export type ReauthReason = typeof ReauthReason.Type;
export const isReauthReason = Schema.is(ReauthReason);

/**
 * Why a sign-in failed before there was an account to mark. Never stored on an
 * account: `cancelled` (the person closed the consent page or the app's sign-in),
 * `timeout` (no redirect in time), `account_mismatch` (a different address signed in).
 */
export const SignInFailure = Schema.Literals(["cancelled", "timeout", "account_mismatch"]);
export type SignInFailure = typeof SignInFailure.Type;

/** The message a keychain read failure carries; the UI shows it as "Keychain is locked". */
export const KEYCHAIN_LOCKED_MESSAGE = "The keychain is locked or unavailable";

/** A sync error, bare or as "accountId: message", that comes from a locked keychain. */
export const isKeychainLocked = (error: string | null) =>
  error !== null &&
  (error === KEYCHAIN_LOCKED_MESSAGE || error.endsWith(`: ${KEYCHAIN_LOCKED_MESSAGE}`));

/**
 * The provider rejected the stored credentials after token refresh. The account
 * is marked as needing a new sign-in and its queue pauses until then.
 */
export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  /** Unset when sign-in fails before an account exists (consent denied, timeout). */
  accountId: Schema.optionalKey(Schema.String),
  message: Schema.String,
  /** Unset means a provider 401 after a forced refresh, recorded as token_revoked. */
  reason: Schema.optionalKey(Schema.Union([ReauthReason, SignInFailure])),
  /** account_mismatch: the address that signed in, and the one the app asked for. */
  signedInAs: Schema.optionalKey(Schema.String),
  expected: Schema.optionalKey(Schema.String),
}) {}

/** A request the provider will never accept (unknown id, message gone). Not retried. */
export class PermanentError extends Schema.TaggedError<PermanentError>()("PermanentError", {
  message: Schema.String,
  imapReset: Schema.optionalKey(Schema.Struct({ path: Schema.String, uidValidity: Schema.String })),
}) {}

/**
 * A provider call that may work later: network down, 5xx, throttling after
 * retries ran out. Queued changes stay queued.
 */
export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  message: Schema.String,
  status: Schema.optionalKey(Schema.Number),
  /** `keychain`: the OS keychain could not be read (locked after sleep). Never a sign-in problem. */
  /**
   * `dns`, `tls`, `refused`, `timeout`, `unreachable` and `unsafe_login` classify an IMAP/SMTP
   * connection failure so the UI can say which setting to check. `quota` is a provider rate
   * limit (429, or Gmail's 403 rateLimitExceeded) that clears after a wait.
   */
  reason: Schema.optionalKey(
    Schema.Literals([
      "configuration",
      "connection",
      "keychain",
      "dns",
      "tls",
      "refused",
      "timeout",
      "unreachable",
      "unsafe_login",
      "quota",
    ]),
  ),
  deferred: Schema.optionalKey(Schema.Boolean),
  retryAfter: Schema.optionalKey(Schema.String),
  /**
   * The provider ids were stale (an IMAP folder got a new UIDVALIDITY) and the
   * server still has the mail under these ids. The queue renames them and retries.
   */
  remap: Schema.optionalKey(
    Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
  ),
}) {}

/** No OAuth client is registered for this provider yet. The app shows the setup step. */
export class ClientNotConfigured extends Schema.TaggedError<ClientNotConfigured>()(
  "ClientNotConfigured",
  { provider: Schema.Literals(["gmail", "outlook"]) },
) {}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  what: Schema.Literals([
    "account",
    "message",
    "proposal",
    "profile",
    "draft",
    "template",
    "signature",
    "attachment",
  ]),
  id: Schema.String,
}) {}

/**
 * Another process holds the database's write lock, and a write that should not wait long gave
 * up. Only agent_activity rows fail this way; other writes wait the full busy timeout.
 */
export class DatabaseBusy extends Schema.TaggedError<DatabaseBusy>()("DatabaseBusy", {
  message: Schema.String,
}) {}

/** The on-device text index cannot answer yet: turned off, model missing, or nothing indexed. */
export class IndexNotReady extends Schema.TaggedError<IndexNotReady>()("IndexNotReady", {
  message: Schema.String,
}) {}

/** Bad input from a person or an agent (invalid address, missing field). */
export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", {
  message: Schema.String,
  /** `too_many_proposals`: the agent's or all agents' pending proposals are at their limit. */
  reason: Schema.optionalKey(Schema.Literal("too_many_proposals")),
  /** For agents: the next step, when the message alone does not say how to fix the input. */
  hint: Schema.optionalKey(Schema.String),
}) {}

/** Missing optional settings permission. Normal mail sync remains available. */
export class SettingsScopeMissing extends Schema.TaggedError<SettingsScopeMissing>()(
  "SettingsScopeMissing",
  {
    accountId: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * Something failed on this computer, not at the mail server: printing,
 * writing a file, opening an attachment.
 */
export class DeviceError extends Schema.TaggedError<DeviceError>()("DeviceError", {
  message: Schema.String,
}) {}
/** Optional feature permissions never pause mail sync. */
export class FeatureScopeMissing extends Schema.TaggedError<FeatureScopeMissing>()(
  "FeatureScopeMissing",
  {
    accountId: Schema.String,
    feature: Schema.Literals([
      "calendar",
      "contacts",
      "settings",
      "permanentDelete",
      "focusedInbox",
    ]),
    message: Schema.String,
  },
) {}

/**
 * The draft was saved elsewhere (another window, the phone, an agent) after this editor
 * loaded it. The editor reloads `revision` and keeps its own text recoverable.
 */
export class DraftConflict extends Schema.TaggedError<DraftConflict>()("DraftConflict", {
  id: Schema.String,
  revision: Schema.Number,
}) {}

/** Submission completed ambiguously; a person must check Sent before retrying. */
export class SendUncertain extends Schema.TaggedError<SendUncertain>()("SendUncertain", {
  message: Schema.String,
}) {}

/** What a provider call can fail with. */
export type ProviderFailure = AuthError | PermanentError | ProviderError;

/** Every error Mailbox can fail with, as one schema for RPC and IPC boundaries. */
export const MailError = Schema.Union([
  AuthError,
  PermanentError,
  ProviderError,
  SendUncertain,
  ClientNotConfigured,
  NotFound,
  InvalidInput,
  SettingsScopeMissing,
  DeviceError,
  FeatureScopeMissing,
  DraftConflict,
]);
export type MailError = typeof MailError.Type;
