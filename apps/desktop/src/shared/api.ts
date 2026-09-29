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
  ImapConnectInput,
  Label,
  MailboxEvent,
  MailError,
  MailOp,
  Message,
  Outcome,
  OutgoingAttachment,
  OutgoingMessage,
  Profile,
  ProfileColor,
  ProfileInput,
  Proposal,
  Provider,
  SyncProgress,
  SyncState,
  ThreadQuery,
  ThreadSummary,
  // The renderer calls mailbox views "Mailbox"; core names them MailboxView.
  MailboxView as Mailbox,
} from "@openmail/core/schema";
