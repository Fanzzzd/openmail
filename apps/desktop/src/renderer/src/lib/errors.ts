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
// Core's internal failures, written as what happened and what to do next.
const CALENDAR_LOAD_FAILED = msg`Couldn't load the calendar from the server. Try again in a few minutes.`;
const CONTACTS_LOAD_FAILED = msg`Couldn't load contacts from the server. Try again in a few minutes.`;
const UNDO_NEEDS_SERVER = msg`This can't be undone right now. Try again when you're online.`;
const AI_REQUEST_INVALID = msg`Couldn't prepare the AI request. Try again.`;
/**
 * Every message the main process lets through (shared/public-error-messages.ts) has a
 * translation here; errors.test.ts checks both ways, so no English core text reaches the UI.
 */
export const INPUT_ERRORS: Record<string, MessageDescriptor> = {
  "Enter a tailnet login such as name@github": msg`Enter a tailnet login such as name@github`,
  "Use a service name such as svc:openmail": msg`Use a service name such as svc:openmail`,
  "Too many tailnet logins": msg`Too many tailnet logins`,
  "This setting is only available on the Mac.": msg`This setting is only available on the Mac.`,
  "Remote access could not be changed.": msg`Couldn't change remote access. Try again.`,
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
  "Cannot edit a series with recurrence overrides": msg`Some occurrences of this series were changed, so the series can't be edited here. Edit it in your calendar.`,
  "Some rule conditions cannot be evaluated from cached mail": msg`Some filter conditions can't be checked against cached mail`,
  "This rule can only be applied to future mail on the server": msg`This filter can only be applied to future mail on the server`,
  "Unsupported server rule": msg`This server filter isn't supported`,
  "Remote writes are disabled in this read-only session": msg`Remote writes are disabled in this read-only session`,
  "Save an Anthropic API key in AI settings.": msg`Save an Anthropic API key in AI settings.`,
  "AI input could not be encoded.": AI_REQUEST_INVALID,
  "AI input budget exceeded. Ask about fewer messages.": msg`AI input budget exceeded. Ask about fewer messages.`,
  "AI request failed. Check your key and try again.": msg`AI request failed. Check your key and try again.`,
  "Anthropic rejected the API key. Check it in Settings → AI Access.": msg`Anthropic rejected the API key. Check it in Settings → AI Access.`,
  "Anthropic's rate limit was reached. Wait a minute, then try again.": msg`Anthropic's rate limit was reached. Wait a minute, then try again.`,
  "Can't reach Anthropic. Check your internet connection.": msg`Can't reach Anthropic. Check your internet connection.`,
  "AI stream ended before completion.": msg`AI stream ended before completion.`,
  "AI model is unavailable.": msg`AI model is unavailable.`,
  "AI request timed out.": msg`AI request timed out.`,
  "The thread changed. Summarize it again.": msg`The thread changed. Summarize it again.`,
  "Invalid AI compose request.": AI_REQUEST_INVALID,

  "Enter a single API key.": msg`Enter a single API key.`,
  "Invalid AI account settings.": msg`These AI settings aren't valid. Check them and try again.`,
  "Could not save the API key in the system keychain.": msg`Couldn't save the API key in the system keychain. Unlock the keychain and try again.`,
  "Turn on “Allow AI to read this account” for each selected account in Settings → AI Access.": msg`Turn on “Allow AI to read this account” for each selected account in Settings → AI Access.`,
  "Enable this account to open mail on the web": msg`Enable this account to open mail on the web`,
  "Enable this account to use its calendar": msg`Enable this account to use its calendar`,
  "This recurring event has a time zone Google Calendar cannot use": msg`This recurring event has a time zone Google Calendar cannot use`,
  "This recurring event has a time zone Outlook cannot use": msg`This recurring event has a time zone Outlook cannot use`,
  "This recurrence cannot be represented in Outlook": msg`This recurrence cannot be represented in Outlook`,
  "The selected message is no longer available.": msg`The selected message is no longer available.`,
  "This meeting link is not supported.": msg`This meeting link is not supported.`,
  "Invalid calendar event time": msg`This event's time isn't valid. Check the start and end.`,
  "Calendar pagination repeated a page": CALENDAR_LOAD_FAILED,
  "Invalid calendar pagination link": CALENDAR_LOAD_FAILED,
  "Recurring event creation is unavailable for this account": msg`Recurring event creation is unavailable for this account`,
  "Calendar access is unavailable for this account": msg`Calendar access is unavailable for this account`,
  "Calendar creation requires an in-app confirmation": msg`Calendar creation requires an in-app confirmation`,
  "This event is no longer available": msg`This event is no longer available`,
  "Invalid message link": msg`This message link isn't valid.`,
  "Enter a single access token": msg`Enter a single access token`,

  "This invitation cannot be answered by this account": msg`This invitation cannot be answered by this account`,
  "This meeting has been cancelled": msg`This meeting has been cancelled`,
  "Open this invitation in your calendar to add it before responding": msg`Open this invitation in your calendar to add it before responding`,
  "The calendar organizer does not match this invitation": msg`The calendar organizer does not match this invitation`,
  "Calendar responses require a user action": msg`Calendar responses require a user action`,
  "Cannot build calendar response": msg`Couldn't prepare a reply to this invitation. Respond from your calendar instead.`,
  "Calendar response was not sent": msg`Calendar response was not sent`,
  "This invitation has a newer update": msg`This invitation has a newer update`,
  "Only inbox messages can be snoozed": msg`Only inbox messages can be snoozed`,
  "Confirm deletion for this rule": msg`Confirm deletion for this filter`,
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

  "A folder cannot be moved inside itself": msg`A folder can't be moved inside itself.`,
  "A message needs at least one recipient.": msg`A message needs at least one recipient.`,
  "A signature needs a name and sending address": msg`A signature needs a name and a sending address.`,
  "AI output budget exceeded.": msg`The AI answer got too long. Ask a narrower question.`,
  "AI tool budget exceeded.": msg`The AI needed too many steps. Ask a narrower question.`,
  "Approve AI proposals in the app.": msg`Approve AI suggestions in the app.`,
  "Attachment exceeds the 32 MB reader limit": msg`This attachment is over 32 MB. Save it to open it.`,
  "Attachments and their containers exceed the 32 MB reader limit": msg`These attachments are over 32 MB together. Save them to open them.`,
  "Automatic triage is disabled.": msg`Automatic triage is off.`,
  "Automatic triage is paused.": msg`Automatic triage is paused.`,
  "Categories cannot be renamed, deleted or moved as folders.": msg`Categories can't be renamed, deleted or moved as folders.`,
  "Categories cannot be used as folders. Use the categories action.": msg`Categories can't be used as folders. Use the categories action.`,
  "Choose a destination from this account": msg`Choose a destination from this account`,
  "Choose a future reminder time.": msg`Choose a future reminder time`,
  "Choose a sent message to send again.": msg`Choose a sent message to send again.`,
  "Choose a server folder.": msg`Choose a server folder.`,
  "Choose a size in bytes and a comparison": msg`Choose a size in bytes and a comparison`,
  "Choose a valid favorite position": msg`Choose a valid favorite position`,
  "Choose each favorite once": msg`Choose each favorite once`,
  "Choose folders from this account.": msg`Choose folders from this account.`,
  "Choose messages from this account": msg`Choose messages from this account`,
  "Confirm deletion of this server rule": msg`Confirm deletion of this server filter`,
  "Confirm discarding the saved rule": msg`Confirm discarding the saved filter`,
  "Confirm permanent deletion in the app.": msg`Confirm permanent deletion in the app.`,
  "Contact group pagination repeated a page": CONTACTS_LOAD_FAILED,
  "Contact pagination repeated a page": CONTACTS_LOAD_FAILED,
  "Invalid contact pagination link": CONTACTS_LOAD_FAILED,
  "Drafts are never performed.": msg`Open the draft to send it.`,
  "Enable the account before sending": msg`Turn on the account before sending.`,
  "Enable the account before undoing this operation.": msg`Turn on the account before undoing this.`,
  "Enter a question and select accounts.": msg`Enter a question and select accounts.`,
  "Enter valid category names.": msg`Enter valid category names.`,
  "Finish pending changes for these messages before undoing.": msg`Wait for pending changes to these messages to sync, then undo.`,
  "Folder deletion repeated the same messages. Refresh and try again.": msg`Deleting the folder stalled on the same messages. Refresh and try again.`,
  "Folder pagination repeated a page.": msg`Couldn't load the folder list from the server. Try again in a few minutes.`,
  "IMAP accounts sign in again by adding the address with a new password.": msg`To sign in again, add the address again with its new password.`,
  "IMAP moves change message UIDs and cannot be undone after restarting. Move the message back manually.": msg`IMAP moves can't be undone after OpenMail restarts. Move the message back yourself.`,
  "Invalid AI suggestion.": msg`This AI suggestion can't be used. Dismiss it.`,
  "Invalid account settings": msg`These account settings aren't valid. Check them and try again.`,
  "Invalid attachment path": msg`Couldn't find this attachment. Open the message again.`,
  "Invalid draft label or keyword": msg`A label on this draft isn't valid. Remove it and save again.`,
  "MCP can only propose existing Gmail user labels for the same account.": msg`AI apps can only suggest existing Gmail labels of the same account.`,
  "MCP drafts support plain-text new messages and replies only.": msg`AI apps can only draft plain-text new messages and replies.`,
  "No account for the conversation.": msg`This conversation's account is no longer connected.`,
  "No message matches the given thread ids.": msg`These conversations are no longer available. Refresh the list.`,
  "Only Gmail requires an extra permanent deletion permission.": msg`Only Gmail needs an extra permission to delete permanently.`,
  "Only Trash or Spam can be emptied.": msg`Only Trash or Spam can be emptied.`,
  "Only archive and label proposals are available.": msg`Only archive and label suggestions are available.`,
  "Original attachments exceed the 30 MB compose limit.": msg`The original attachments are over 30 MB. Forward without them.`,
  "Original message exceeds the compose size limit.": msg`The original message is too large to include. Forward it as an attachment.`,
  "Outlook rule sizes must be a multiple of 1024 bytes": msg`Outlook filter sizes must be a multiple of 1024 bytes`,
  "Preview the rule again before confirming": msg`Preview the filter again before confirming`,
  "Proposals need 1 to 20 conversations.": msg`AI suggestions need 1 to 20 conversations.`,
  "Recovery draft id does not match": msg`Couldn't recover this draft. Close it and open it again.`,
  "Reminder time must be within the next year.": msg`Reminder time must be within the next year.`,
  "Reply message belongs to another account.": msg`The message you're replying to belongs to another account.`,
  "Restored operations expire after 24 hours.": msg`Actions older than 24 hours can't be undone.`,
  "Review AI suggestions in the app.": msg`Review AI suggestions in the app.`,
  "Rule recovery is available for Gmail": msg`Filter recovery is available for Gmail`,
  "Search groups are nested too deeply. Simplify your query.": msg`Search groups are nested too deeply. Simplify your query.`,
  "Select 1 to 256 attachments": msg`Select 1 to 256 attachments`,
  "Select at least one conversation.": msg`Select at least one conversation.`,
  "Select between 1 and 1,000 conversations.": msg`Select between 1 and 1,000 conversations.`,
  "Semantic search is unavailable.": msg`Semantic search isn't available right now.`,
  "Server folder verification is required before undo.": UNDO_NEEDS_SERVER,
  "Server verification is required before undo.": UNDO_NEEDS_SERVER,
  "Server visibility is available for Gmail labels": msg`Server visibility is available for Gmail labels`,
  "The assistant can only add user labels in Gmail.": msg`The assistant can only add user labels in Gmail.`,
  "The assistant can only propose drafts, labels and archive.": msg`The assistant can only suggest drafts, labels and archiving.`,
  "The destination account must belong to the target space": msg`The destination account must belong to the target space`,
  "The folder exceeds the operation limit of 100,000 messages.": msg`The folder has more than 100,000 messages, the most one action can change.`,
  "The message changed locally. This operation cannot be safely undone.": msg`The message changed since then, so this can't be undone safely.`,
  "The message changed on the server. This operation cannot be safely undone.": msg`The message changed on the server, so this can't be undone safely.`,
  "The new folder is not available yet": msg`The new folder isn't available yet. Try again in a moment.`,
  "The original destination folder no longer exists.": msg`The original folder no longer exists.`,
  "The provider did not return an official Outlook web link.": msg`Outlook didn't return a web link for this message. Open it in Outlook on the web.`,
  "The selected conversation is no longer available.": msg`The selected conversation is no longer available.`,
  "The selection exceeds 100,000 messages.": msg`The selection has more than 100,000 messages. Select fewer.`,
  "The signature belongs to another sending address or is unavailable": msg`This signature belongs to another sending address or is no longer available.`,
  "This account has no supported web mail link.": msg`This account has no web mail link.`,
  "This account is outside the selected accounts.": msg`This account is outside the selected accounts.`,
  "This draft was already discarded.": msg`This draft was already discarded.`,
  "This message is not a draft.": msg`This message isn't a draft.`,
  "This operation can no longer be undone.": msg`This can no longer be undone.`,
  "This organization action is unavailable for this account.": msg`This action isn't available for this account.`,
  "This rule has already been restored": msg`This filter has already been restored`,
  "This rule no longer exists": msg`This filter no longer exists`,
  "This rule uses conditions or actions the editor cannot preserve": msg`This filter uses conditions or actions the editor can't keep`,
  "This suggestion could not be applied.": msg`This suggestion couldn't be applied.`,
  "This suggestion is no longer available.": msg`This suggestion is no longer available.`,
  "Too many threads in a proposal.": msg`Too many conversations in one AI suggestion.`,
  "Use a PNG, JPEG, GIF or WebP image up to 8 MB": msg`Use a PNG, JPEG, GIF or WebP image up to 8 MB`,
  "Wait for pending changes to sync before changing the folder.": msg`Wait for pending changes to sync before changing the folder.`,
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
      const reason = DEVICE_REASONS[e.message] ?? INPUT_ERRORS[e.message];
      return i18n._(reason ?? msg`Something went wrong. Please try again.`);
    },
    PermanentError: (e) => i18n._(INPUT_ERRORS[e.message] ?? msg`The server refused this action.`),
    ProviderError: (e) => {
      const message = INPUT_ERRORS[e.message];
      if (message) return i18n._(message);
      const reason = e.reason ? CONNECTION_ERRORS[e.reason] : undefined;
      return i18n._(reason ?? msg`Can't reach the mail server right now.`);
    },
    // Main replaces other text with "the operation failed."; nothing reaches the UI untranslated.
    InvalidInput: (e) =>
      i18n._(INPUT_ERRORS[e.message] ?? msg`Something went wrong. Please try again.`),
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
