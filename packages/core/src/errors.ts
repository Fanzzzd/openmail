import { Schema } from "effect";

/**
 * The provider rejected the stored credentials or lacks a scope. The account
 * is marked as needing a new sign-in and its queue pauses until then.
 */
export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  /** Unset when sign-in fails before an account exists (consent denied, timeout). */
  accountId: Schema.optionalKey(Schema.String),
  message: Schema.String,
}) {}

/** A request the provider will never accept (unknown id, message gone). Not retried. */
export class PermanentError extends Schema.TaggedError<PermanentError>()("PermanentError", {
  message: Schema.String,
}) {}

/**
 * A provider call that may work later: network down, 5xx, throttling after
 * retries ran out. Queued changes stay queued.
 */
export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  message: Schema.String,
  status: Schema.optionalKey(Schema.Number),
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

/** Bad input from a person or an agent (invalid address, missing field). */
export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", {
  message: Schema.String,
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
    feature: Schema.Literals(["calendar", "contacts", "permanentDelete"]),
    message: Schema.String,
  },
) {}

/** What a provider call can fail with. */
export type ProviderFailure = AuthError | PermanentError | ProviderError;

/** Every error Mailbox can fail with, as one schema for RPC and IPC boundaries. */
export const MailError = Schema.Union([
  AuthError,
  PermanentError,
  ProviderError,
  ClientNotConfigured,
  NotFound,
  InvalidInput,
  SettingsScopeMissing,
  DeviceError,
  FeatureScopeMissing,
]);
export type MailError = typeof MailError.Type;
