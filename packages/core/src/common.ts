// Shared core exports. Platform entries add their own adapters.
export * from "./compose/compose-text.js";
export * from "./compose/compose-body.js";
export { MODEL_KEY } from "./ai/secrets.js";
export * from "./domain/domain.js";
export * from "./domain/errors.js";
export * from "./reader/print.js";
export * from "./reader/reader-html.js";
export * from "./reader/reading.js";
export * from "./reader/trackers.js";
export { IMAP_PRESETS, ImapConnectInput, ImapPreset } from "./providers/imap/imap-presets.js";
export { Mailbox, MailboxEvent, type PerformError, SyncState } from "./mailbox/mailbox.js";
export { MailboxLive } from "./mailbox/mailbox-live.js";

export { AppConfig, Browser, type ClientConfig, Providers, Secrets } from "./services.js";
export {
  AgentIdentity,
  agentAccountGap,
  MailToolError,
  MailToolkit,
  MailToolkitLayer,
  ReadMailToolkit,
  ProposalMailToolkit,
} from "./tools/tools.js";

export * from "./domain/organization.js";
export * from "./search/search.js";

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

export { ProviderDiagnostic } from "./providers/provider-diagnostics.js";
export { SyncResetDiagnostic } from "./sync/sync-reset.js";

export * from "./search/search-snippets.js";
export * from "./app/remote-access.js";
