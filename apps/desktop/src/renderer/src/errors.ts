import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Cause, Match } from "effect";
import type { AsyncResult } from "effect/reactivity";
import type { RpcClientError } from "effect/rpc";

import type { MailError } from "../../shared/api";

/** What an RPC call can fail with: the main process's typed errors, or the transport. */
export type AppError = MailError | RpcClientError.RpcClientError;

const NOT_FOUND = {
  account: msg`Can't find this account.`,
  proposal: msg`Can't find this proposal.`,
  message: msg`Can't find this message.`,
  profile: msg`Can't find this space.`,
  draft: msg`Can't find this draft.`,
  template: msg`Can't find this template.`,
  attachment: msg`Can't find this attachment.`,
} as const;
const INPUT_ERRORS: Record<string, MessageDescriptor> = {
  "Enable this account to open mail on the web": msg`Enable this account to open mail on the web`,
  "Enable this account to use its calendar": msg`Enable this account to use its calendar`,
  "This recurring event has a time zone Google Calendar cannot use": msg`This recurring event has a time zone Google Calendar cannot use`,
  "The selected message is no longer available.": msg`The selected message is no longer available.`,
  "This meeting link is not supported.": msg`This meeting link is not supported.`,
  "Invalid calendar event time": msg`Invalid calendar event time`,
  "Calendar pagination repeated a page": msg`Calendar pagination repeated a page`,
  "Invalid calendar pagination link": msg`Invalid calendar pagination link`,
  "Recurring event creation is unavailable for this account": msg`Recurring event creation is unavailable for this account`,
  "Calendar access is unavailable for this account": msg`Calendar access is unavailable for this account`,
  "Calendar creation requires an in-app confirmation": msg`Calendar creation requires an in-app confirmation`,
  "This event is no longer available": msg`This event is no longer available`,
  "Invalid message link": msg`Invalid message link`,
  "Enter a single access token": msg`Enter a single access token`,

  "This invitation cannot be answered by this account": msg`This invitation cannot be answered by this account`,
  "This meeting has been cancelled": msg`This meeting has been cancelled`,
  "Open this invitation in your calendar to add it before responding": msg`Open this invitation in your calendar to add it before responding`,
  "The calendar organizer does not match this invitation": msg`The calendar organizer does not match this invitation`,
  "Calendar responses require a user action": msg`Calendar responses require a user action`,
  "Cannot build calendar response": msg`Cannot build calendar response`,
  "Calendar response was not sent": msg`Calendar response was not sent`,
  "This invitation has a newer update": msg`This invitation has a newer update`,
  "Only inbox messages can be snoozed": msg`Only inbox messages can be snoozed`,
  "Confirm deletion for a filter with a search query": msg`Confirm deletion for a filter with a search query`,
  "Choose a user label or folder": msg`Choose a user label or folder`,
  "A label or folder needs a valid name": msg`A label or folder needs a valid name`,
  "Choose a parent folder from this account": msg`Choose a parent folder from this account`,
  "Unknown label or folder": msg`Unknown label or folder`,
  "Choose a future reminder time": msg`Choose a future reminder time`,
  "Choose a conversation": msg`Choose a conversation`,
  "Add at least one filter condition": msg`Add at least one filter condition`,
  "Choose at least one filter action": msg`Choose at least one filter action`,
  "Choose one destination for the filter": msg`Choose one destination for the filter`,
  "Choose a label or folder from this account": msg`Choose a label or folder from this account`,
  "Add an automatic reply message": msg`Add an automatic reply message`,
  "The end must be after the start": msg`The end must be after the start`,
  "Outlook scheduled replies need both dates": msg`Outlook scheduled replies need both dates`,
  "Outlook automatic replies do not support a custom subject": msg`Outlook automatic replies do not support a custom subject`,
  "Choose a verified send-as address for this account": msg`Choose a verified send-as address for this account`,
};
const DEVICE_REASONS: Record<string, MessageDescriptor> = {
  "no printers are available.": msg`no printers are available.`,
  "the operation failed.": msg`the operation failed.`,
};
const CLIENTS = { gmail: "Google", outlook: "Microsoft" } as const;

/**
 * One short sentence for the person, per error tag. Takes the `i18n` from
 * `useLingui()` in components, so the text follows a language switch.
 */
export function errorText(i18n: I18n, error: AppError): string {
  return Match.valueTags(error, {
    FeatureScopeMissing: (e) =>
      e.feature === "permanentDelete"
        ? i18n._(msg`Authorize permission to permanently delete mail in this Gmail account.`)
        : e.feature === "calendar"
          ? i18n._(msg`Sign in again to access your calendar.`)
          : i18n._(msg`Sign in again to sync server contacts.`),
    SettingsScopeMissing: () => i18n._(msg`Sign in again to enable filters and automatic replies.`),
    AuthError: (e) => i18n._(msg`The server rejected the sign-in. ${e.message}`),
    ClientNotConfigured: (e) => {
      const client = CLIENTS[e.provider];
      return i18n._(msg`The ${client} OAuth client is not set up yet.`);
    },
    NotFound: (e) => i18n._(NOT_FOUND[e.what]),
    DeviceError: (e) => {
      const reason = DEVICE_REASONS[e.message];
      return reason ? i18n._(reason) : e.message;
    },
    PermanentError: (e) => i18n._(msg`The server refused this action: ${e.message}`),
    ProviderError: (e) => i18n._(msg`Can't reach the mail server right now: ${e.message}`),
    InvalidInput: (e) => {
      const message = INPUT_ERRORS[e.message];
      return message ? i18n._(message) : e.message;
    },
    RpcClientError: () => i18n._(msg`Lost the connection to the background process.`),
  });
}

/** The typed error in `cause`, or a generic sentence for a defect or interruption. */
export function causeText<E extends AppError>(i18n: I18n, cause: Cause.Cause<E>): string {
  const error = Cause.findErrorOption(cause);
  return error._tag === "Some"
    ? errorText(i18n, error.value)
    : i18n._(msg`Something went wrong. Please try again.`);
}

/** Error text for a failed result; null while it has not failed. */
export function resultError<A, E extends AppError>(
  i18n: I18n,
  result: AsyncResult.AsyncResult<A, E>,
) {
  return result._tag === "Failure" ? causeText(i18n, result.cause) : null;
}

export function settingsScopeMissing<A, E extends AppError>(
  result: AsyncResult.AsyncResult<A, E>,
): boolean {
  if (result._tag !== "Failure") return false;
  const error = Cause.findErrorOption(result.cause);
  return error._tag === "Some" && error.value._tag === "SettingsScopeMissing";
}
