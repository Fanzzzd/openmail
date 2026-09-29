/**
 * Domain types the renderer uses, re-exported from core as types only so the
 * renderer bundle never pulls in core's runtime. Calls go through the RPC
 * group in `rpc.ts`.
 */
export type {
  Account,
  Address,
  AgentWriteMode,
  AuditEntry,
  Draft as StoredDraft,
  DraftInput,
  ImapConnectInput,
  Label,
  Language,
  MailboxEvent,
  MailError,
  MailOp,
  Message,
  Outcome,
  OutgoingAttachment,
  OutgoingMessage,
  Prefs,
  Profile,
  ProfileColor,
  ProfileInput,
  Proposal,
  Provider,
  Signature,
  SignatureKind,
  SyncProgress,
  SyncState,
  Template,
  TemplateInput,
  ThreadQuery,
  ThreadSummary,
  // The renderer calls mailbox views "Mailbox"; core names them MailboxView.
  MailboxView as Mailbox,
} from "@openmail/core/schema";
