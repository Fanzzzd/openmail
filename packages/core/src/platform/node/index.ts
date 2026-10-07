// Node consumers share core exports without loading the mobile entry.
export {
  Account,
  Actor,
  Address,
  AgentIdentity,
  type AppLink,
  AttachmentAction,
  AttachmentActionResult,
  AuditEntry,
  Browser,
  Command,
  DEFAULT_ACTIVE_HOURS,
  DeviceError,
  IMAP_PRESETS,
  IncomingMessage,
  type InferenceProcessLauncher,
  MAILBOXES,
  MENU_BAR_MAIL_LIMIT,
  MailToolkit,
  MailToolkitLayer,
  Mailbox,
  MediaError,
  Message,
  Outcome,
  OutgoingAttachment,
  PROFILE_COLORS,
  type PerformError,
  Prefs,
  Proposal,
  ProposalMailToolkit,
  ProviderDiagnostic,
  ReadMailToolkit,
  SyncResetDiagnostic,
  SyncResult,
  type UpdateClient,
  type Vision,
  VisionResult,
  actorLabel,
  appleContactVCard,
  attachmentBytes,
  deviceErrorReason,
  dockUnreadCount,
  menuBarCountTitle,
  messageLink,
  notificationAction,
  notificationButtonActions,
  parseAppLink,
  printableThread,
  redactSyncHealth,
  resolveUpdateFeed,
  senderSearchQuery,
  spaceAccountIds,
  unavailableVision,
  updateVersionAllowed,
} from "../../common.js";
export { NodeMailbox } from "./layers.js";
export { dataDir } from "./paths.js";
export { NodeSystem, openInSystemBrowser } from "./platform-node.js";
export { makeNodeModels } from "./embeddings-node.js";
export * from "./diagnostics.js";
export { DatabaseInUseError } from "./database-access.js";
export { InterruptedRecoveryError, prepareDatabaseStartup } from "./recovery-files.js";
export { isSignedMacApp } from "./app-verifier.js";
export { prepareSmokeDatabase } from "./smoke.js";
export { createSmokeCleanup } from "./smoke-cleanup.js";
export {
  corpusCheck,
  createCorpusRunKeyFile,
  formatCorpusReport,
  CorpusCheckError,
  CORPUS_LIMITS,
  type CorpusCheckOptions,
  type CorpusExplainOptions,
  type CorpusScanOptions,
  type CorpusExplainReport,
  type CorpusReport,
} from "./corpus-check.js";

export { DatabaseUpgradeSpaceError } from "./database-upgrade.js";
