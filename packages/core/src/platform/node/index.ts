// Node consumers share core exports without loading the mobile entry.
export {
  Account,
  Actor,
  Address,
  AgentIdentity,
  APPROVE_IN_APP,
  agentAccountGap,
  type AppLink,
  type ClientConfig,
  AttachmentAction,
  AttachmentActionResult,
  AuditEntry,
  Browser,
  Command,
  DEFAULT_ACTIVE_HOURS,
  DeviceError,
  IMAP_PRESETS,
  IncomingMessage,
  LOG_CODE_ANNOTATION,
  LogCode,
  type InferenceProcessLauncher,
  MAILBOXES,
  MENU_BAR_MAIL_LIMIT,
  MailToolError,
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
  PrefsPatch,
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
  COMPOSE_ATTACHMENT_LIMIT,
  deviceErrorReason,
  deviceFailure,
  dockUnreadCount,
  logCodeOf,
  logError,
  logWarning,
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
  unknownArguments,
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
export { DatabaseTooNewError } from "../../db/migrate.js";
