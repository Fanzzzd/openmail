// Schemas and errors with no Node dependencies, for code that runs in a
// browser (the desktop renderer, later the mobile app). `@openmail/core`
// itself pulls in node:sqlite, the keychain and IMAP.
export * from "./compose/compose-text.js";
export * from "./compose/compose-body.js";
export * from "./compose/compose-format.js";
export * from "./domain/account.js";
export * from "./domain/message.js";
export * from "./domain/changes.js";
export * from "./domain/prefs.js";
export * from "./domain/command.js";
export * from "./domain/sync-status.js";
export * from "./domain/errors.js";
export {
  storedSyncFailureReason,
  SYNC_FAILURE_TEXT,
  SyncFailureReason,
} from "./sync/sync-failure.js";
export { IMAP_PRESETS, ImapConnectInput, ImapPreset } from "./providers/imap/imap-presets.js";
export { Mailbox, MailboxEvent, SyncState } from "./mailbox/mailbox.js";
export { ModelThread } from "./ai/model-thread.js";
export { type HeldSend, holdSend } from "./mailbox/undo-send.js";
export * from "./reader/print.js";
export * from "./reader/reader-html.js";
export { READER_BASE_CSS, READER_COLOURS } from "./reader/reader-style.js";
export * from "./reader/reader-sanitize.js";
export * from "./reader/reading.js";
export * from "./reader/trackers.js";

export * from "./domain/organization.js";
export * from "./search/search.js";
export {
  parseSearchDate,
  quoteSearchValue,
  searchFolderValue,
  searchWords,
  unquoteSearchValue,
} from "./search/search-tokens.js";
export * from "./search/search-field.js";
export * from "./search/attachment-types.js";
export * from "./search/provider-search.js";
export * from "./search/search-match.js";
export * from "./search/fts.js";
export * from "./search/ranking.js";

export { htmlToText } from "./mime/mime.js";

export * from "./ai/media.js";
export * from "./calendar/calendar.js";
export * from "./contacts/contacts.js";

export { deviceErrorReason, deviceFailure } from "./domain/device-errors.js";
export * from "./app/system.js";
export * from "./domain/cache.js";

export * from "./app/list-window.js";

export * from "./domain/mail-ops.js";
export * from "./compose/recipients.js";

export * from "./compose/compose-sender.js";
export * from "./domain/folder-actions.js";

export * from "./mime/attachment-policy.js";

export * from "./compose/compose-find.js";

export * from "./mime/attachment-view.js";

export * from "./mime/attachment-filename.js";

export * from "./compose/compose-paste.js";
export * from "./app/feedback.js";
export * from "./compose/compose-extras.js";

export * from "./compose/signatures.js";

export * from "./domain/categories.js";
export * from "./ai/ai.js";
export * from "./app/update-state.js";
export * from "./compose/compose-ai.js";
export * from "./contacts/apple-contacts.js";

export * from "./reader/message-security.js";
export * from "./visible-text/visible-text.js";
export type { VisibleHtmlTextOptions } from "./visible-text/visible-text-context.js";

export * from "./reader/link-security.js";

export * from "./mime/attachment-import.js";

export * from "./providers/optional-services.js";

export * from "./sync/sync-health.js";
export { FolderStatus, HealthCounts } from "./sync/sync-records.js";

export { outlookPreviewUnavailable } from "./providers/outlook/outlook-rules.js";
export * from "./search/search-snippets.js";
export * from "./search/search-highlight.js";
export * from "./app/remote-access.js";
