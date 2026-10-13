/** Domain schemas for changes: MailOp, outgoing messages, drafts and the queued ops pushed to providers. */

import { Schema } from "effect";
import { Address, InferenceClassification } from "./message.js";

/**
 * One change to one message. Labels follow Gmail's model; each provider maps
 * them onto its own (Outlook folders and flags, IMAP folders and flags).
 */
export const MailOp = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("read"), value: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("star"), value: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("important"), value: Schema.Boolean }),
  /** Leave the inbox, keep the message (Gmail archive, Outlook/IMAP Archive folder). */
  Schema.Struct({ kind: Schema.Literal("archive") }),
  /** Back to the inbox from archive, trash or spam. */
  Schema.Struct({ kind: Schema.Literal("inbox") }),
  Schema.Struct({ kind: Schema.Literal("trash") }),
  Schema.Struct({ kind: Schema.Literal("spam") }),
  Schema.Struct({
    kind: Schema.Literal("move"),
    labelId: Schema.String,
    removeLabelId: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("categories"),
    add: Schema.Array(Schema.String),
    remove: Schema.Array(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("classification"), value: InferenceClassification }),
  /** IMAP COPY keeps the original; server-generated copy ids are discovered by sync. */
  Schema.Struct({
    kind: Schema.Literal("copy"),
    labelIds: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  }),
  /** Add or remove a user label. On Outlook and IMAP, adding moves to that folder. */
  Schema.Struct({ kind: Schema.Literal("label"), labelId: Schema.String, value: Schema.Boolean }),
]);
export type MailOp = typeof MailOp.Type;

export const OutgoingAttachment = Schema.Struct({
  filename: Schema.String,
  mimeType: Schema.String,
  /** Base64 content. */
  content: Schema.String,
  /** Original message this attachment was copied from; local compose metadata. */
  sourceMessageId: Schema.optionalKey(Schema.String),
  /** Inline image referenced by cid: in the compose body. */
  contentId: Schema.optionalKey(Schema.String),
});
export type OutgoingAttachment = typeof OutgoingAttachment.Type;

export const ComposeMode = Schema.Literals(["new", "reply", "replyAll", "forward"]);
export type ComposeMode = typeof ComposeMode.Type;

export const DraftOrganization = Schema.Struct({
  labels: Schema.Array(Schema.String),
  starred: Schema.Boolean,
});
export type DraftOrganization = typeof DraftOrganization.Type;

export const COMPOSE_FONT_FAMILIES = [
  "Arial",
  "Helvetica",
  "Georgia",
  "Times New Roman",
  "Verdana",
  "Courier New",
] as const;
export const COMPOSE_FONT_SIZES = [12, 14, 16, 18, 24] as const;
export const ComposeFont = Schema.Struct({
  family: Schema.Literals(COMPOSE_FONT_FAMILIES),
  size: Schema.Literals(COMPOSE_FONT_SIZES),
});
export type ComposeFont = typeof ComposeFont.Type;
export const InlineImageSize = Schema.Literals(["small", "medium", "large", "original"]);
export type InlineImageSize = typeof InlineImageSize.Type;

export const OutgoingMessage = Schema.Struct({
  /** Local AI provenance survives editing, autosave and proposal approval. Never emitted as MIME. */
  agentOrigin: Schema.optionalKey(
    Schema.Struct({
      recipients: Schema.Array(Schema.String),
      replyTo: Schema.optionalKey(Schema.String),
    }),
  ),
  composeFont: Schema.optionalKey(ComposeFont),
  /** Verified Gmail send-as address; omitted uses the account address. */
  from: Schema.optionalKey(Address),
  to: Schema.Array(Address),
  cc: Schema.Array(Address),
  bcc: Schema.Array(Address),
  subject: Schema.String,
  /** Plain text; always present so every client can read it. */
  text: Schema.String,
  /** Rich compose HTML; normalized with its text alternative at draft/send boundaries. */
  html: Schema.optionalKey(Schema.String),
  /** Draft-only organization. Labels are Gmail user IDs, Outlook category names or IMAP keywords. */
  draftOrganization: Schema.optionalKey(DraftOrganization),
  /** Remote draft source, never rendered. Retained only while the body is unchanged. */
  originalHtml: Schema.optionalKey(Schema.String),
  /** Local compose notice; no removed text or transport marker is retained. */
  hiddenTextRemoved: Schema.optionalKey(Schema.Literal(true)),
  attachments: Schema.Array(OutgoingAttachment),
  /** An iTIP reply, rendered as a calendar alternative by the MIME send pipeline. */
  calendar: Schema.optionalKey(
    Schema.Struct({ method: Schema.Literal("REPLY"), content: Schema.String }),
  ),
  /** Local message id this replies to or forwards; sets threading headers. */
  inReplyTo: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(ComposeMode),
  /** `text` is Markdown. Core renders the HTML part at send time; `html` is ignored. */
  markdown: Schema.optionalKey(Schema.Boolean),
  /**
   * Forward `inReplyTo` as an attached .eml (message/rfc822) instead of
   * quoting it. Core fetches the original's raw MIME at send time.
   */
  forwardAsAttachment: Schema.optionalKey(Schema.Boolean),
  /** Explicit attachment list replaces Graph createForward inherited attachments. */
  includeOriginalAttachments: Schema.optionalKey(Schema.Boolean),
  signatureId: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type OutgoingMessage = typeof OutgoingMessage.Type;

// Drafts

/**
 * A draft is a local record keyed by its own id. The provider's copy is a
 * mirror that follows it through the change queue.
 */
export const Draft = Schema.Struct({
  /** Local id, "draft:<uuid>". The app picks it, so autosaves never create two. */
  id: Schema.String,
  accountId: Schema.String,
  message: OutgoingMessage,
  updatedAt: Schema.Number,
  /** Set when an agent wrote it. Sending approves the proposal, discarding rejects it. */
  proposalId: Schema.NullOr(Schema.Number),
  /** A copy exists on the provider. False until the first push lands. */
  synced: Schema.Boolean,
  syncError: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** A save remains queued and the enabled account can retry it automatically. */
  syncRetrying: Schema.optionalKey(Schema.Boolean),
  localOnly: Schema.optionalKey(Schema.Boolean),
});
export type Draft = typeof Draft.Type;

export const DraftInput = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  message: OutgoingMessage,
});
export type DraftInput = typeof DraftInput.Type;

/** Where the provider keeps a draft. Gmail has a draft id; Outlook and IMAP only a message id. */
export const DraftRemote = Schema.Struct({
  rfcMessageId: Schema.optionalKey(Schema.String),
  changeKey: Schema.optionalKey(Schema.String),
  lastWrittenAt: Schema.optionalKey(Schema.Number),
  draftId: Schema.NullOr(Schema.String),
  messageId: Schema.NullOr(Schema.String),
});
export type DraftRemote = typeof DraftRemote.Type;

export const DraftCreateState = Schema.Struct({
  messageId: Schema.String,
  attempted: Schema.Boolean,
  attemptedAt: Schema.optionalKey(Schema.Number),
  emptyLookups: Schema.optionalKey(Schema.Number),
});
export type DraftCreateState = typeof DraftCreateState.Type;

/** A send draft is separate from the user's autosaved draft. No attachment bytes or upload URLs. */
export const SendPreparationState = Schema.Union([
  Schema.Struct({ phase: Schema.Literal("creating"), messageId: Schema.String }),
  Schema.Struct({
    phase: Schema.Literal("preparing"),
    messageId: Schema.String,
    draftId: Schema.String,
  }),
  Schema.Struct({
    phase: Schema.Literal("sending"),
    messageId: Schema.String,
    draftId: Schema.String,
  }),
]);
export type SendPreparationState = typeof SendPreparationState.Type;

/** Draft changes waiting in the queue next to MailOps. */
export const DraftOp = Schema.Union([
  /** Push the draft's current content; the queue reads it when the op runs. */
  Schema.Struct({ kind: Schema.Literal("saveDraft"), draftId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("deleteDraft"), remote: DraftRemote }),
]);
export type DraftOp = typeof DraftOp.Type;

export const QueuedOp = Schema.Union([
  MailOp,
  DraftOp,
  Schema.Struct({ kind: Schema.Literal("reconcile") }),
]);
export type QueuedOp = typeof QueuedOp.Type;
