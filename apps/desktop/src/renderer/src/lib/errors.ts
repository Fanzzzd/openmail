import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Cause, Match } from "effect";
import type { AsyncResult } from "effect/reactivity";
import type { RpcClientError } from "effect/rpc";

import type { MailError } from "../../../shared/api";
import { isDesktop } from "./platform";

/** What an RPC call can fail with: the main process's typed errors, or the transport. */
export type AppError = MailError | RpcClientError.RpcClientError;

const NOT_FOUND = {
  account: msg`Can't find this account.`,
  proposal: msg`Can't find this proposal.`,
  message: msg`Can't find this message.`,
  profile: msg`Can't find this space.`,
  draft: msg`Can't find this draft.`,
  template: msg`Can't find this template.`,
  signature: msg`Can't find this signature.`,
  attachment: msg`Can't find this attachment.`,
} as const;
const OUTLOOK_UPLOAD_FAILED = msg`Outlook attachment upload failed. Try saving or sending again.`;
export const INPUT_ERRORS: Record<string, MessageDescriptor> = {
  "Enter a tailnet login such as name@github": msg`Enter a tailnet login such as name@github`,
  "Use a service name such as svc:openmail": msg`Use a service name such as svc:openmail`,
  "Too many tailnet logins": msg`Too many tailnet logins`,
  "This setting is only available on the Mac.": msg`This setting is only available on the Mac.`,
  "Remote access could not be changed.": msg`Remote access could not be changed.`,
  "Choose a message from another sender.": msg`Choose a message from another sender.`,
  "This message has no valid sender address.": msg`This message has no valid sender address.`,
  "Focused Inbox requires Outlook.": msg`Focused Inbox requires Outlook.`,
  "Outlook attachment upload failed. Try saving or sending again.": OUTLOOK_UPLOAD_FAILED,
  "Invalid Outlook upload session": OUTLOOK_UPLOAD_FAILED,
  "Invalid Outlook upload byte ranges": OUTLOOK_UPLOAD_FAILED,
  "Could not read Outlook upload progress": OUTLOOK_UPLOAD_FAILED,
  "Invalid Outlook upload response": OUTLOOK_UPLOAD_FAILED,
  "Outlook attachment upload made no progress": OUTLOOK_UPLOAD_FAILED,
  "Outlook attachment upload session expired repeatedly": OUTLOOK_UPLOAD_FAILED,
  "Attachments rejected before sending": msg`Attachments rejected before sending`,
  "Outlook.com messages are limited to 25 MB, including message text and attachments. Remove attachments before sending.": msg`Outlook.com messages are limited to 25 MB, including message text and attachments. Remove attachments before sending.`,
  "Outlook cannot upload attached messages of 3 MB or more. Remove this attachment before sending.": msg`Outlook cannot upload attached messages of 3 MB or more. Remove this attachment before sending.`,
  "Outlook message requests cannot exceed 4 MB": msg`Outlook message requests cannot exceed 4 MB`,
  "Outlook message requests cannot exceed 4 MB. Large attached messages cannot be uploaded as Outlook items.": msg`Outlook message requests cannot exceed 4 MB. Large attached messages cannot be uploaded as Outlook items.`,
  "Outlook file attachments cannot exceed 150 MB": msg`Outlook file attachments cannot exceed 150 MB`,
  "Repeat pattern must include the event start date": msg`Repeat pattern must include the event start date`,
  "This time is skipped or repeated by daylight saving. Enter a date and time with a UTC offset": msg`This time is skipped or repeated by daylight saving. Enter a date and time with a UTC offset`,

  "Date is ambiguous. Enter an explicit date and time": msg`Date is ambiguous. Enter an explicit date and time`,
  "Repeat end date must be on or after the event": msg`Repeat end date must be on or after the event`,
  "Cannot edit a series with recurrence overrides": msg`Cannot edit a series with recurrence overrides`,
  "Some rule conditions cannot be evaluated from cached mail": msg`Some rule conditions cannot be evaluated from cached mail`,
  "This rule can only be applied to future mail on the server": msg`This rule can only be applied to future mail on the server`,
  "Unsupported server rule": msg`Unsupported server rule`,
  "Remote writes are disabled in this read-only session": msg`Remote writes are disabled in this read-only session`,
  "Save an Anthropic API key in AI settings.": msg`Save an Anthropic API key in AI settings.`,
  "AI input could not be encoded.": msg`AI input could not be encoded.`,
  "AI input budget exceeded. Ask about fewer messages.": msg`AI input budget exceeded. Ask about fewer messages.`,
  "AI request failed. Check your key and try again.": msg`AI request failed. Check your key and try again.`,
  "Anthropic rejected the API key. Check it in Settings → AI Access.": msg`Anthropic rejected the API key. Check it in Settings → AI Access.`,
  "Anthropic's rate limit was reached. Wait a minute, then try again.": msg`Anthropic's rate limit was reached. Wait a minute, then try again.`,
  "Can't reach Anthropic. Check your internet connection.": msg`Can't reach Anthropic. Check your internet connection.`,
  "AI stream ended before completion.": msg`AI stream ended before completion.`,
  "AI model is unavailable.": msg`AI model is unavailable.`,
  "AI request timed out.": msg`AI request timed out.`,
  "The thread changed. Summarize it again.": msg`The thread changed. Summarize it again.`,
  "Invalid AI compose request.": msg`Invalid AI compose request.`,

  "Enter a single API key.": msg`Enter a single API key.`,
  "Invalid AI account settings.": msg`Invalid AI account settings.`,
  "Could not save the API key in the system keychain.": msg`Could not save the API key in the system keychain.`,
  "Turn on “Allow AI to read this account” for each selected account in Settings → AI Access.": msg`Turn on “Allow AI to read this account” for each selected account in Settings → AI Access.`,
  "Enable this account to open mail on the web": msg`Enable this account to open mail on the web`,
  "Enable this account to use its calendar": msg`Enable this account to use its calendar`,
  "This recurring event has a time zone Google Calendar cannot use": msg`This recurring event has a time zone Google Calendar cannot use`,
  "This recurring event has a time zone Outlook cannot use": msg`This recurring event has a time zone Outlook cannot use`,
  "This recurrence cannot be represented in Outlook": msg`This recurrence cannot be represented in Outlook`,
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
  "Confirm deletion for this rule": msg`Confirm deletion for this rule`,
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
const OPERATION_FAILED = msg`the operation failed.`;
const DEVICE_REASONS: Record<string, MessageDescriptor> = {
  "Contacts operation failed.": msg`Contacts operation failed.`,
  "no printers are available.": msg`no printers are available.`,
  "the operation failed.": OPERATION_FAILED,
};
export const OAUTH_CONFIGURATION_ERROR = msg`OAuth client not configured. Set it up before syncing.`;
const CLIENTS = { gmail: "Google", outlook: "Microsoft" } as const;

const NO_RESPONSE = msg`The mail server didn't respond. Check the server name, the port and your internet connection.`;

/** What to check when a mail server connection fails, by core's ProviderError reason. */
const CONNECTION_ERRORS: Partial<Record<string, MessageDescriptor>> = {
  configuration: OAUTH_CONFIGURATION_ERROR,
  dns: msg`Can't find the mail server. Check the server name and your internet connection.`,
  refused: msg`The mail server refused the connection. Check the port.`,
  timeout: NO_RESPONSE,
  unreachable: NO_RESPONSE,
  tls: msg`Couldn't set up a secure connection to the mail server. Check the port and the encryption setting.`,
  unsafe_login: msg`The server blocked the sign-in as unsafe. Turn on IMAP in your email's web settings, then sign in with the authorization code it generates.`,
};

/**
 * One short sentence for the person, per error tag. Takes the `i18n` from
 * `useLingui()` in components, so the text follows a language switch.
 */
export function errorText(i18n: I18n, error: AppError): string {
  return Match.valueTags(error, {
    FeatureScopeMissing: (e) =>
      e.feature === "focusedInbox"
        ? i18n._(msg`Sign in again to change Focused/Other.`)
        : e.feature === "permanentDelete"
          ? i18n._(msg`Authorize permission to permanently delete mail in this Gmail account.`)
          : e.feature === "calendar"
            ? i18n._(msg`Calendar access isn't granted for this account.`)
            : e.feature === "settings"
              ? i18n._(msg`Sign in again to enable filters and automatic replies.`)
              : i18n._(msg`Sign in again to sync server contacts.`),
    SettingsScopeMissing: () => i18n._(msg`Sign in again to enable filters and automatic replies.`),
    SendUncertain: () =>
      i18n._(
        msg({
          message: "This message may have been sent. Check Sent before sending it again.",
          comment: "Sent means the Sent mailbox.",
        }),
      ),
    AuthError: (e) => {
      if (e.reason === "cancelled") return i18n._(msg`Sign-in was cancelled.`);
      if (e.reason === "timeout")
        return i18n._(msg`Sign-in took too long. Try again and finish it in your browser.`);
      if (e.reason === "account_mismatch") {
        const signedInAs = e.signedInAs ?? "";
        const expected = e.expected ?? "";
        return i18n._(msg`You signed in as ${signedInAs}. Sign in with ${expected} to continue.`);
      }
      return i18n._(msg`The server rejected the sign-in.`);
    },
    ClientNotConfigured: (e) => {
      const client = CLIENTS[e.provider];
      return i18n._(msg`The ${client} OAuth client is not set up yet.`);
    },
    NotFound: (e) => i18n._(NOT_FOUND[e.what]),
    DeviceError: (e) => {
      const reason = DEVICE_REASONS[e.message];
      return reason ? i18n._(reason) : e.message;
    },
    PermanentError: (e) => i18n._(INPUT_ERRORS[e.message] ?? msg`The server refused this action.`),
    ProviderError: (e) => {
      const message = INPUT_ERRORS[e.message];
      if (message) return i18n._(message);
      const reason = e.reason ? CONNECTION_ERRORS[e.reason] : undefined;
      return i18n._(reason ?? msg`Can't reach the mail server right now.`);
    },
    InvalidInput: (e) => {
      const message = INPUT_ERRORS[e.message];
      return message
        ? i18n._(message)
        : e.message === "the operation failed."
          ? i18n._(msg`Something went wrong. Please try again.`)
          : e.message;
    },
    // In the web build the transport is the socket to the Mac, which can drop mid-request.
    RpcClientError: () =>
      isDesktop()
        ? i18n._(msg`Lost the connection to the background process.`)
        : i18n._(msg`Lost the connection to your Mac. Try again.`),
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

export function messageMissing<A, E extends AppError>(
  result: AsyncResult.AsyncResult<A, E>,
): boolean {
  if (result._tag !== "Failure") return false;
  const error = Cause.findErrorOption(result.cause);
  return error._tag === "Some" && error.value._tag === "NotFound" && error.value.what === "message";
}
