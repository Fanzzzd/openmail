/** Domain schemas for messages, threads, mailbox views and thread queries. */

import { Schema } from "effect";
import { DerivedChunk } from "../ai/media.js";

export const Address = Schema.Struct({
  name: Schema.String,
  address: Schema.String,
  /** Provider contact identity, only present on contact-source addresses. */
  contactKey: Schema.optionalKey(Schema.String),
  /** Organization metadata from a provider contact, used only for completion. */
  company: Schema.optionalKey(Schema.String),
});
export type Address = typeof Address.Type;

export const Attachment = Schema.Struct({
  filename: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
});
export type Attachment = typeof Attachment.Type;

const summaryFields = {
  id: Schema.String,
  accountId: Schema.String,
  threadId: Schema.String,
  subject: Schema.String,
  from: Address,
  date: Schema.Number,
  snippet: Schema.String,
  labels: Schema.Array(Schema.String),
  isUnread: Schema.Boolean,
  isStarred: Schema.Boolean,
  hasAttachments: Schema.Boolean,
};

export const MessageSummary = Schema.Struct(summaryFields);
export type MessageSummary = typeof MessageSummary.Type;

/** Plain visible text with UTF-16 ranges; consumers render marks, never snippet HTML. */
const searchMatchFields = {
  messageId: Schema.String,
  snippet: Schema.String,
  highlights: Schema.Array(Schema.Struct({ start: Schema.Int, end: Schema.Int })),
};
export const SearchMatch = Schema.Union([
  /** `sender` snippets are the sender's name and address. */
  Schema.Struct({ ...searchMatchFields, source: Schema.Literals(["body", "subject", "sender"]) }),
  /** The query matched an attachment's file name; the snippet is that name. */
  Schema.Struct({
    ...searchMatchFields,
    source: Schema.Literal("filename"),
    attachmentName: Schema.String,
    attachmentIndex: Schema.Int,
  }),
  Schema.Struct({
    ...searchMatchFields,
    source: Schema.Literal("attachment"),
    attachmentName: Schema.String,
    /** Null for an inline image; attachment indexes distinguish duplicate filenames. */
    attachmentIndex: Schema.NullOr(Schema.Int),
  }),
]);
export type SearchMatch = typeof SearchMatch.Type;

/** One row of a conversation list: the newest message of a thread in the view. */
export const ThreadSummary = Schema.Struct({
  ...summaryFields,
  /** Cached names only; showing attachments never downloads their content. */
  attachmentNames: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Messages in the whole thread, across mailboxes. */
  threadCount: Schema.Number,
  /** Distinct senders in the thread, oldest first. */
  participants: Schema.Array(Address),
  /**
   * To, then Cc and Bcc, of the row's message when the user wrote it: sent mail and drafts, which
   * a list names by the people they go to. Absent on other rows.
   */
  recipients: Schema.optionalKey(Schema.Array(Address)),
  derivedMatches: Schema.optionalKey(Schema.Array(DerivedChunk)),
  searchMatches: Schema.optionalKey(Schema.Array(SearchMatch)),
  /** Only on-device semantic ranking found it: no query word matched, so nothing is highlighted. */
  related: Schema.optionalKey(Schema.Boolean),
});
export type ThreadSummary = typeof ThreadSummary.Type;

export const MessageSecurity = Schema.Struct({
  dmarc: Schema.Literals(["pass", "fail", "unknown"]),
  spf: Schema.Literals(["pass", "fail", "unknown"]),
  dkim: Schema.Literals(["pass", "fail", "unknown"]),
  unsubscribe: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("mailto"), url: Schema.String }),
      Schema.Struct({ kind: Schema.Literal("post"), url: Schema.String }),
    ]),
  ),
});
export type MessageSecurity = typeof MessageSecurity.Type;

export const Message = Schema.Struct({
  ...summaryFields,
  to: Schema.Array(Address),
  cc: Schema.Array(Address),
  bcc: Schema.optionalKey(Schema.Array(Address)),
  headers: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
  ),
  rfcMessageId: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(Schema.Number),
  /** RFC Reply-To targets; absent means unknown cached headers, [] means no Reply-To. */
  replyTo: Schema.optionalKey(Schema.Array(Address)),
  bodyText: Schema.String,
  bodyHtml: Schema.String,
  security: Schema.optionalKey(MessageSecurity),
  webLink: Schema.optionalKey(Schema.String),
  /** Calendar MIME part or provider meeting message; absent on older cached mail. */
  hasCalendar: Schema.optionalKey(Schema.Boolean),
  bodyCached: Schema.optionalKey(Schema.Boolean),
  /** Read-time cache fallback; never persisted or supplied by the provider. */
  bodyRefresh: Schema.optionalKey(Schema.Literal("failed")),
  attachments: Schema.Array(Attachment),
  /**
   * The local draft this message is the provider's copy of. It outlives the
   * message: Gmail and IMAP replace the message on every save, so a thread
   * read before the save still opens the draft by this id.
   */
  draftId: Schema.optionalKey(Schema.String),
});
export type Message = typeof Message.Type;

/** A message as a provider hands it over, keyed by the provider's own id. */
export const IncomingMessage = Schema.Struct({
  parentRfcMessageId: Schema.optionalKey(Schema.String),
  providerId: Schema.String,
  threadId: Schema.String,
  subject: Schema.String,
  from: Address,
  to: Schema.Array(Address),
  cc: Schema.Array(Address),
  bcc: Schema.optionalKey(Schema.Array(Address)),
  headers: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
  ),
  rfcMessageId: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(Schema.Number),
  replyTo: Schema.optionalKey(Schema.Array(Address)),
  date: Schema.Number,
  snippet: Schema.String,
  bodyText: Schema.String,
  bodyHtml: Schema.String,
  security: Schema.optionalKey(MessageSecurity),
  webLink: Schema.optionalKey(Schema.String),
  /** Calendar MIME part or provider meeting message; absent on older cached mail. */
  hasCalendar: Schema.optionalKey(Schema.Boolean),
  bodyCached: Schema.optionalKey(Schema.Boolean),
  labels: Schema.Array(Schema.String),
  attachments: Schema.Array(Attachment),
  isUnread: Schema.Boolean,
  isStarred: Schema.Boolean,
});
export type IncomingMessage = typeof IncomingMessage.Type;

/**
 * Cross-account views. Gmail labels and Outlook/IMAP folders both map onto
 * these; a message can sit in several (INBOX and STARRED at once). `all` is
 * every message outside spam and trash, as in Gmail.
 */
export const MAILBOXES = [
  "inbox",
  "snoozed",
  "important",
  "starred",
  "sent",
  "drafts",
  "spam",
  "trash",
  "all",
] as const;
/** Named MailboxView so it does not clash with the Mailbox service. */
export const MailboxView = Schema.Literals(MAILBOXES);
export type MailboxView = typeof MailboxView.Type;

/** Gmail inbox categories. Each is a system label on the message. */
export const CATEGORIES = [
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
] as const;
export type Category = (typeof CATEGORIES)[number];
/** Outlook inference classification shares Primary, with one secondary bucket. */
export const OUTLOOK_CATEGORIES = ["CATEGORY_PERSONAL", "CATEGORY_OTHER"] as const;
export const isOutlookClassification = (
  label: string,
): label is (typeof OUTLOOK_CATEGORIES)[number] =>
  OUTLOOK_CATEGORIES.some((category) => category === label);
export const INBOX_CATEGORIES = [...CATEGORIES, "CATEGORY_OTHER"] as const;
export const InferenceClassification = Schema.Literals(["focused", "other"]);
export type InferenceClassification = typeof InferenceClassification.Type;
/** Parsed search operators, shared by local queries and provider adapters. */
export const AttachmentType = Schema.Literals([
  "pdf",
  "image",
  "document",
  "spreadsheet",
  "presentation",
]);
export type AttachmentType = typeof AttachmentType.Type;

export const SearchCondition = Schema.Struct({
  subjectContains: Schema.optionalKey(Schema.String),
  mailingList: Schema.optionalKey(Schema.String),
  header: Schema.optionalKey(Schema.Struct({ name: Schema.String, value: Schema.String })),
  userLabels: Schema.optionalKey(Schema.Boolean),
  proximity: Schema.optionalKey(
    Schema.Struct({
      left: Schema.String,
      right: Schema.String,
      distance: Schema.Int,
      ordered: Schema.Boolean,
    }),
  ),
  from: Schema.optionalKey(Schema.String),
  to: Schema.optionalKey(Schema.String),
  cc: Schema.optionalKey(Schema.String),
  bcc: Schema.optionalKey(Schema.String),
  rfcMessageId: Schema.optionalKey(Schema.String),
  sizeLarger: Schema.optionalKey(Schema.Number),
  sizeSmaller: Schema.optionalKey(Schema.Number),
  drive: Schema.optionalKey(Schema.Boolean),
  anywhere: Schema.optionalKey(Schema.Boolean),
  subject: Schema.optionalKey(Schema.String),
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
  important: Schema.optionalKey(Schema.Boolean),
  attachment: Schema.optionalKey(Schema.Boolean),
  image: Schema.optionalKey(Schema.Boolean),
  attachmentText: Schema.optionalKey(Schema.Boolean),
  attachmentTypes: Schema.optionalKey(Schema.Array(AttachmentType)),
  unread: Schema.optionalKey(Schema.Boolean),
  starred: Schema.optionalKey(Schema.Boolean),
  filename: Schema.optionalKey(Schema.String),
  dateBefore: Schema.optionalKey(Schema.Number),
  dateAfter: Schema.optionalKey(Schema.Number),
});
export type SearchCondition = typeof SearchCondition.Type;
export const SearchCriteria = Schema.Struct({
  ...SearchCondition.fields,
  excluded: Schema.optionalKey(Schema.Array(SearchCondition)),
});
export type SearchCriteria = typeof SearchCriteria.Type;

/** A list or search over threads. `search` set means full-text search, newest first. */
export const ListFilters = Schema.Struct({
  enabled: Schema.Boolean,
  unread: Schema.Boolean,
  starred: Schema.Boolean,
  important: Schema.Boolean,
  inInbox: Schema.Boolean,
});
export type ListFilters = typeof ListFilters.Type;
export const DEFAULT_LIST_FILTERS: ListFilters = {
  enabled: false,
  unread: false,
  starred: false,
  important: false,
  inInbox: false,
};

export const ThreadQuery = Schema.Struct({
  mailbox: Schema.optionalKey(MailboxView),
  /** Limit to these accounts; unset means every account. */
  accountIds: Schema.optionalKey(Schema.Array(Schema.String)),
  /** A label or folder id, or a Gmail category. */
  label: Schema.optionalKey(Schema.String),
  unreadOnly: Schema.optionalKey(Schema.Boolean),
  starredOnly: Schema.optionalKey(Schema.Boolean),
  /** List conditions use OR; In Inbox intersects the result. Search operators retain AND. */
  listFilters: Schema.optionalKey(ListFilters),
  search: Schema.optionalKey(Schema.String),
  searchScope: Schema.optionalKey(Schema.Literals(["all", "folder"])),
  criteria: Schema.optionalKey(SearchCriteria),
  /** Cached provider hits, used by Mailbox to read authoritative search results. */
  messageIds: Schema.optionalKey(Schema.Array(Schema.String)),
  /** One row per message instead of per conversation (conversation grouping off). */
  flat: Schema.optionalKey(Schema.Boolean),
  /** Page cursor: the `date` of the oldest thread already shown. */
  before: Schema.optionalKey(Schema.Number),
  /** Tie-breaker at `before`, the id of the last row shown. */
  beforeId: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Int),
});
export type ThreadQuery = typeof ThreadQuery.Type;
