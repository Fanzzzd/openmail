// Shared core exports. Platform entries add their own adapters.
export * from "./compose/compose-text.js";
export * from "./compose/compose-body.js";
export { composeLink, escapeComposeText } from "./compose/compose-nodes.js";
export { applyComposeSignature, composeTransportHtml } from "./compose/compose-transport.js";
export { MODEL_KEY } from "./ai/secrets.js";
export * from "./domain/account.js";
export * from "./domain/message.js";
export * from "./domain/changes.js";
export * from "./domain/prefs.js";
export * from "./domain/command.js";
export * from "./domain/sync-status.js";
export * from "./domain/diagnostics-state.js";
export * from "./domain/errors.js";
export * from "./domain/diagnostic-log.js";
export * from "./reader/print.js";
export * from "./reader/reader-html.js";
export * from "./reader/reading.js";
export * from "./reader/trackers.js";
export { IMAP_PRESETS, ImapConnectInput, ImapPreset } from "./providers/imap/imap-presets.js";
export { Mailbox, MailboxEvent, type PerformError, SyncState } from "./mailbox/mailbox.js";
export { MailboxLive } from "./mailbox/mailbox-live.js";

export { AppConfig, Browser, type ClientConfig, Secrets } from "./platform/auth.js";
export { Providers } from "./providers/adapter.js";
export {
  agentAccountGap,
  MailToolkit,
  MailToolkitLayer,
  ReadMailToolkit,
  ProposalMailToolkit,
} from "./tools/tools.js";
export { AgentIdentity } from "./tools/agent-identity.js";
export { MailToolError, unknownArguments } from "./tools/tool-common.js";
export { APPROVE_IN_APP } from "./mailbox/mailbox-apply.js";

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

export * from "./ai/media.js";

export * from "./calendar/calendar.js";
export * from "./contacts/contacts.js";

export { deviceErrorReason, deviceFailure } from "./domain/device-errors.js";
export * from "./app/system.js";

export * from "./domain/cache.js";

export * from "./app/list-window.js";
export * from "./domain/folder-actions.js";

export * from "./app/updates.js";

export * from "./compose/recipients.js";

export * from "./compose/compose-sender.js";

export * from "./mime/attachment-policy.js";

export * from "./mime/attachment-view.js";
export * from "./mime/tnef.js";

export * from "./mime/attachment-filename.js";

export * from "./app/feedback.js";

export * from "./compose/compose-extras.js";
export * from "./compose/compose-images.js";
export * from "./app/update-feed.js";
export * from "./compose/signatures.js";

export * from "./domain/categories.js";
export * from "./ai/ai.js";
export { messageModelText } from "./visible-text/visible-text.js";
export { ModelAnthropic, FakeModelLayer, type ModelOutput, type ModelRequest } from "./ai/model.js";

export * from "./app/update-state.js";

export * from "./contacts/apple-contacts.js";

export * from "./platform/crypto.js";
export * from "./platform/paths.js";
export * from "./platform/mail-codec.js";
export * from "./platform/runtime.js";
export * from "./platform/cache-storage.js";

export * from "./mime/attachment-import.js";
export * from "./reader/reader-sanitize.js";

export * from "./sync/sync-health.js";
export { FolderStatus, HealthCounts } from "./sync/sync-records.js";

export { ProviderDiagnostic } from "./providers/provider-diagnostics.js";
export { SyncResetDiagnostic } from "./sync/sync-reset.js";

export * from "./search/search-snippets.js";
export * from "./app/remote-access.js";
