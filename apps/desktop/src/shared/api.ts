/**
 * Domain types the renderer uses, re-exported from core as types only so the
 * renderer bundle never pulls in core's runtime. Calls go through the RPC
 * group in `rpc.ts`.
 */
export type {
  DerivedChunk,
  Account,
  Address,
  AgentWriteMode,
  FailedOp,
  Draft as StoredDraft,
  DraftInput,
  ImapConnectInput,
  Label,
  Language,
  MailboxEvent,
  MailError,
  MailOp,
  Message,
  OutgoingAttachment,
  OutgoingMessage,
  Prefs,
  Profile,
  ProfileColor,
  ProfileInput,
  Proposal,
  Provider,
  NamedSignature,
  SyncProgress,
  SyncState,
  Template,
  ThreadQuery,
  ThreadSummary,
  // The renderer calls mailbox views "Mailbox"; core names them MailboxView.
  MailboxView as Mailbox,
} from "@openmail/core/schema";
