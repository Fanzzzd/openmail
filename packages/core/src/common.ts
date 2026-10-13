// Shared core exports. Platform entries add their own adapters.
export * from "./compose-text.js";
export * from "./compose-body.js";
export { MODEL_KEY } from "./secrets.js";
export * from "./domain/domain.js";
export * from "./domain/errors.js";
export * from "./print.js";
export * from "./reader-html.js";
export * from "./reading.js";
export * from "./trackers.js";
export { IMAP_PRESETS, ImapConnectInput, ImapPreset } from "./imap-presets.js";
export { Mailbox, MailboxEvent, type PerformError, SyncState } from "./mailbox.js";
export { MailboxLive } from "./mailbox-live.js";

export { AppConfig, Browser, type ClientConfig, Providers, Secrets } from "./services.js";
export {
  AgentIdentity,
  agentAccountGap,
  MailToolError,
  MailToolkit,
  MailToolkitLayer,
  ReadMailToolkit,
  ProposalMailToolkit,
} from "./tools.js";

export * from "./domain/organization.js";
export * from "./search.js";

export * from "./media.js";

export * from "./calendar.js";
export * from "./contacts.js";

export { deviceErrorReason, deviceFailure } from "./domain/device-errors.js";
export * from "./system.js";

export * from "./domain/cache.js";

export * from "./list-window.js";
export * from "./domain/folder-actions.js";

export * from "./updates.js";

export * from "./recipients.js";

export * from "./compose-sender.js";

export * from "./attachment-policy.js";

export * from "./attachment-view.js";
export * from "./tnef.js";

export * from "./attachment-filename.js";

export * from "./feedback.js";

export * from "./compose-extras.js";
export * from "./compose-images.js";
export * from "./update-feed.js";
export * from "./signatures.js";

export * from "./domain/categories.js";
export * from "./ai.js";
export { messageModelText } from "./visible-text.js";
export { ModelAnthropic, FakeModelLayer, type ModelOutput, type ModelRequest } from "./model.js";

export * from "./update-state.js";

export * from "./apple-contacts.js";

export * from "./platform/crypto.js";
export * from "./platform/paths.js";
export * from "./platform/mail-codec.js";
export * from "./platform/runtime.js";
export * from "./platform/cache-storage.js";

export * from "./attachment-import.js";
export * from "./reader-sanitize.js";

export * from "./sync-health.js";

export { ProviderDiagnostic } from "./provider-diagnostics.js";
export { SyncResetDiagnostic } from "./sync-reset.js";

export * from "./search-snippets.js";
export * from "./remote-access.js";
