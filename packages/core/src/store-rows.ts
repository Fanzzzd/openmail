import { Schema } from "effect";
import {
  type Account,
  Actor,
  Address,
  AgentWriteMode,
  Attachment,
  Command,
  FailedOp,
  ImapSettings,
  type Message,
  MessageSecurity,
  type MessageSummary,
  NotificationActions,
  type Proposal,
  Provider,
  QueuedOp,
} from "./domain.js";
import { DerivedChunk } from "./media.js";
import { cleanDisplayName } from "./message-security.js";
import { type PendingOp } from "./services.js";

// Decode SQLite JSON columns and bit flags at the IO boundary.
export const AccountRow = Schema.Struct({
  id: Schema.String,
  provider: Provider,
  email: Schema.String,
  created_at: Schema.Number,
  last_synced_at: Schema.NullOr(Schema.Number),
  last_sync_error: Schema.NullOr(Schema.String),
  profile_id: Schema.NullOr(Schema.String),
  settings_json: Schema.NullOr(Schema.fromJsonString(ImapSettings)),
  needs_reauth: Schema.BooleanFromBit,
  enabled: Schema.BooleanFromBit,
  description: Schema.String,
  color: Schema.NullOr(Schema.String),
  position: Schema.Int,
});

export const summaryRowFields = {
  id: Schema.String,
  account_id: Schema.String,
  thread_id: Schema.String,
  subject: Schema.String,
  from_name: Schema.String,
  from_addr: Schema.String,
  date: Schema.Number,
  snippet: Schema.String,
  labels_json: Schema.fromJsonString(Schema.Array(Schema.String)),
  attachments_json: Schema.fromJsonString(Schema.Array(Attachment)),
  is_unread: Schema.BooleanFromBit,
  is_starred: Schema.BooleanFromBit,
};

export const SummaryRow = Schema.Struct(summaryRowFields);

export const MessageRow = Schema.Struct({
  ...summaryRowFields,
  to_json: Schema.fromJsonString(Schema.Array(Address)),
  cc_json: Schema.fromJsonString(Schema.Array(Address)),
  bcc_json: Schema.fromJsonString(Schema.Array(Address)),
  headers_json: Schema.NullOr(
    Schema.fromJsonString(
      Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
    ),
  ),
  rfc_message_id: Schema.NullOr(Schema.String),
  message_size: Schema.NullOr(Schema.Number),
  reply_to_json: Schema.NullOr(Schema.fromJsonString(Schema.Array(Address))),
  body_text: Schema.String,
  body_html: Schema.String,
  security_json: Schema.NullOr(Schema.fromJsonString(MessageSecurity)),
  web_link: Schema.NullOr(Schema.String),
  draft_id: Schema.NullOr(Schema.String),
  calendar_hint: Schema.NullOr(Schema.BooleanFromBit),
  body_cached: Schema.BooleanFromBit,
});

export const MESSAGE_COLUMNS = `m.*, (SELECT d.id FROM drafts d
  WHERE d.account_id = m.account_id AND d.remote_message_id = m.provider_id) AS draft_id`;

export const ThreadRow = Schema.Struct({
  ...summaryRowFields,
  any_unread: Schema.BooleanFromBit,
  any_starred: Schema.BooleanFromBit,
  thread_count: Schema.Number,
  participants_json: Schema.fromJsonString(Schema.Array(Address)),
});

export const LabelRow = Schema.Struct({
  account_id: Schema.String,
  id: Schema.String,
  name: Schema.String,
  color: Schema.NullOr(Schema.String),
  label_list_visibility: Schema.NullOr(
    Schema.Literals(["labelShow", "labelShowIfUnread", "labelHide"]),
  ),
  message_list_visibility: Schema.NullOr(Schema.Literals(["show", "hide"])),
});

export const PendingOpRow = Schema.Struct({
  id: Schema.Number,
  account_id: Schema.String,
  provider_id: Schema.String,
  op_json: Schema.fromJsonString(QueuedOp),
  attempts: Schema.Number,
  last_error: Schema.NullOr(Schema.String),
  created_at: Schema.Number,
  retry_at: Schema.Number,
  rfc_message_id: Schema.NullOr(Schema.String),
  progress_json: Schema.fromJsonString(Schema.Array(Schema.String)),
  appended_message_id: Schema.NullOr(Schema.String),
});

export const AuditRow = Schema.Struct({
  at: Schema.Number,
  actor: Schema.String,
  account_id: Schema.NullOr(Schema.String),
  action: Schema.String,
  detail_json: Schema.fromJsonString(Schema.Unknown),
});

export const ProposalRow = Schema.Struct({
  id: Schema.Number,
  created_at: Schema.Number,
  actor_json: Schema.fromJsonString(Actor),
  command_json: Schema.fromJsonString(Command),
  status: Schema.Literals(["pending", "approved", "rejected"]),
});

export const Count = Schema.Struct({ key: Schema.String, n: Schema.Number });

export const counts = (rows: ReadonlyArray<typeof Count.Type>): Record<string, number> =>
  Object.fromEntries(rows.map((r) => [r.key, r.n]));

export const Id = Schema.Struct({ id: Schema.Number });

export const MessageId = Schema.Struct({ id: Schema.String });

export const Ref = Schema.Struct({ account_id: Schema.String, provider_id: Schema.String });

export const ThreadKey = Schema.Struct({ account_id: Schema.String, thread_id: Schema.String });

export const Labels = Schema.Struct({ labels_json: SummaryRow.fields.labels_json });

export const LabelsAndProvider = Schema.Struct({
  labels_json: SummaryRow.fields.labels_json,
  provider: Provider,
});

export const Cursor = Schema.Struct({ sync_cursor: Schema.NullOr(Schema.String) });

export const Mode = Schema.Struct({ modify: AgentWriteMode });

export const Next = Schema.Struct({ next: Schema.Number });

export function toAccount(r: typeof AccountRow.Type): Account {
  return {
    id: r.id,
    provider: r.provider,
    email: r.email,
    createdAt: r.created_at,
    lastSyncedAt: r.last_synced_at,
    lastSyncError: r.last_sync_error,
    profileId: r.profile_id,
    needsReauth: r.needs_reauth,
    enabled: r.enabled,
    description: r.description,
    color: r.color,
    position: r.position,
    ...(r.settings_json ? { imap: r.settings_json } : {}),
  };
}

export function toSummary(r: typeof SummaryRow.Type): MessageSummary {
  return {
    id: r.id,
    accountId: r.account_id,
    threadId: r.thread_id,
    subject: r.subject,
    from: { name: cleanDisplayName(r.from_name), address: r.from_addr },
    date: r.date,
    snippet: r.snippet,
    labels: r.labels_json,
    isUnread: r.is_unread,
    isStarred: r.is_starred,
    hasAttachments: r.attachments_json.length > 0,
  };
}

export function toMessage(r: typeof MessageRow.Type): Message {
  return {
    ...toSummary(r),
    to: r.to_json,
    cc: r.cc_json,
    bcc: r.bcc_json,
    ...(r.headers_json === null ? {} : { headers: r.headers_json }),
    ...(r.rfc_message_id === null ? {} : { rfcMessageId: r.rfc_message_id }),
    ...(r.message_size === null ? {} : { size: r.message_size }),
    ...(r.reply_to_json === null ? {} : { replyTo: r.reply_to_json }),
    bodyText: r.body_text,
    bodyHtml: r.body_html,
    ...(r.security_json === null ? {} : { security: r.security_json }),
    ...(r.web_link === null ? {} : { webLink: r.web_link }),
    bodyCached: r.body_cached,
    attachments: r.attachments_json,
    ...(r.calendar_hint === null ? {} : { hasCalendar: r.calendar_hint }),
    ...(r.draft_id === null ? {} : { draftId: r.draft_id }),
  };
}

export function toProposal(r: typeof ProposalRow.Type): Proposal {
  return {
    id: r.id,
    createdAt: r.created_at,
    actor: r.actor_json,
    command: r.command_json,
    status: r.status,
  };
}

export function accountId(provider: Provider, email: string): string {
  return `${provider}:${email.toLowerCase()}`;
}

export const imapEpochKey = (account: string, folder: import("./services.js").ImapFolderIdentity) =>
  `imap-epoch:${JSON.stringify([account, folder.path, folder.uidValidity])}`;
export const Reminder = Schema.Struct({
  due_at: Schema.NullOr(Schema.Number),
  woken_at: Schema.NullOr(Schema.Number),
  wake_pending: Schema.BooleanFromBit,
});
export const REDACT_DECIDED = "command_json='{}',actor_json=json_remove(actor_json,'$.rationale')";

export const toPendingOps = (rows: readonly (typeof PendingOpRow.Type)[]) =>
  rows.map((r): PendingOp => ({
    id: r.id,
    accountId: r.account_id,
    providerId: r.provider_id,
    op: r.op_json,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: r.created_at,
    retryAt: r.retry_at,
    rfcMessageId: r.rfc_message_id,
    progress: r.progress_json,
    appendedMessageId: r.appended_message_id,
  }));

export const EpochRow = Schema.Struct({ epoch: Schema.fromJsonString(Schema.String) });

export const DerivedSearchRow = Schema.Struct({
  account_id: Schema.String,
  thread_id: Schema.String,
  provenance_json: Schema.fromJsonString(DerivedChunk),
});

export const CopyProgressRow = Schema.Struct({
  progress_json: Schema.fromJsonString(Schema.Array(Schema.String)),
});

export const FailedOpDetailRow = Schema.Struct({
  ...FailedOp.fields,
  rejected_json: Schema.fromJsonString(Schema.Array(Schema.String)),
});

export const NotificationActionRow = Schema.Struct({
  actions: Schema.fromJsonString(NotificationActions),
});
