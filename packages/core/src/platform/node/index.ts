// The public surface of @openmail/core. Callers use Mailbox; the services and
// layers below it are exported for other platforms (mobile) and tests.
export * from "../../compose-text.js";
export * from "../../domain.js";
export * from "../../errors.js";
export * from "../../print.js";
export * from "../../reader-html.js";
export * from "../../reading.js";
export * from "../../trackers.js";
export { IMAP_PRESETS, ImapConnectInput, ImapPreset } from "../../imap-presets.js";
export {
  Mailbox,
  MailboxEvent,
  ModelThread,
  type PerformError,
  type AttachmentPartResult,
  type SignInError,
  SyncState,
} from "../../mailbox.js";
export { MailboxLive, type MailboxOptions } from "../../mailbox-live.js";
export { NodeMailbox, type NodeMailboxOptions, ProvidersLive } from "./layers.js";
export { dataDir, dataDirFor } from "./paths.js";
export { NodeSystem, openInSystemBrowser, SystemBrowser } from "./platform-node.js";
export { decide, type Decision } from "../../policy.js";
export {
  AppConfig,
  Browser,
  type Change,
  type ClientConfig,
  type ConnectInput,
  OAuth,
  type ProviderAdapter,
  Providers,
  Secrets,
  Store,
} from "../../services.js";
export { StoreLive } from "../../store.js";
export {
  AgentIdentity,
  MailToolkit,
  MailToolkitLayer,
  ReadMailToolkit,
  ProposalMailToolkit,
} from "../../tools.js";

export * from "../../organization.js";
export * from "../../search.js";

export * from "../../media.js";
export { Indexer, makeIndexer } from "../../indexer.js";
export * from "../../calendar.js";
export * from "../../contacts.js";

export { deviceErrorReason } from "../../device-errors.js";
export * from "../../system.js";
export { makeNodeModels } from "./embeddings-node.js";

export type { InferenceProcess, InferenceProcessLauncher } from "./inference-process.js";
export * from "../../cache.js";

export * from "../../list-window.js";
export * from "../../folder-actions.js";

export * from "../../updates.js";

export * from "../../recipients.js";

export * from "../../compose-sender.js";

export * from "../../attachment-policy.js";

export * from "../../attachment-view.js";
export * from "../../tnef.js";

export * from "../../attachment-filename.js";
export * from "./diagnostics.js";
export * from "../../feedback.js";
export { DatabaseInUseError } from "./database-access.js";
export { InterruptedRecoveryError, prepareDatabaseStartup } from "./recovery-files.js";

export * from "../../compose-extras.js";
export * from "./portable-helpers.js";
export * from "../../update-feed.js";
export * from "../../signatures.js";

export * from "../../categories.js";
export * from "../../ai.js";
export {
  Model,
  ModelAnthropic,
  FakeModelLayer,
  type ModelOutput,
  type ModelRequest,
} from "../../model.js";

export * from "../../update-state.js";

export * from "../../apple-contacts.js";

export { isSignedMacApp } from "./app-verifier.js";
export { NodeLayer, NodePlatform } from "./platform-node.js";

export * from "../../platform/crypto.js";
export * from "../../platform/paths.js";
export * from "../../platform/mail-codec.js";
export * from "../../platform/runtime.js";
export { prepareSmokeDatabase } from "./smoke.js";
export { createSmokeCleanup } from "./smoke-cleanup.js";

export { ProviderDiagnostic } from "../../provider-diagnostics.js";

export * from "../../sync-health.js";
export { SyncResetDiagnostic } from "../../sync-reset.js";
