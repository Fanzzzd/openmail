/**
 * The domain as Effect schemas. Every value that crosses a boundary (SQLite
 * rows, provider JSON, IPC, MCP tool calls) is decoded with one of these, and
 * the TypeScript types are derived from them.
 */
import { Schema } from "effect";

// Accounts

/** gmail and outlook use OAuth and their own APIs; imap covers iCloud, Yahoo, QQ, 163, Fastmail and any IMAP/SMTP server. */
export const Provider = Schema.Literals(["gmail", "outlook", "imap"]);
export type Provider = typeof Provider.Type;

/** Non-secret IMAP/SMTP settings. The password lives in the keychain. */
export const ImapSettings = Schema.Struct({
  /** Key into IMAP_PRESETS, or "custom". */
  preset: Schema.String,
  username: Schema.String,
  imapHost: Schema.String,
  imapPort: Schema.Int,
  smtpHost: Schema.String,
  smtpPort: Schema.Int,
  /** true: implicit TLS (993/465). false: STARTTLS. */
  smtpSecure: Schema.Boolean,
});
export type ImapSettings = typeof ImapSettings.Type;

export const Account = Schema.Struct({
  id: Schema.String,
  provider: Provider,
  email: Schema.String,
  enabled: Schema.optionalKey(Schema.Boolean),
  description: Schema.optionalKey(Schema.String),
  color: Schema.optionalKey(Schema.NullOr(Schema.String)),
  position: Schema.optionalKey(Schema.Int),
  createdAt: Schema.Number,
  lastSyncedAt: Schema.NullOr(Schema.Number),
  /** Error from the most recent sync, cleared by the next successful one. */
  lastSyncError: Schema.NullOr(Schema.String),
  profileId: Schema.NullOr(Schema.String),
  /** The provider rejected credentials or a mail scope. Optional settings scope errors stay in their screens. */
  needsReauth: Schema.Boolean,
  /** For imap accounts: which preset or server. Never contains the password. */
  imap: Schema.optionalKey(ImapSettings),
});
export type Account = typeof Account.Type;

export const AccountSettings = Schema.Struct({
  enabled: Schema.Boolean,
  description: Schema.String.check(Schema.isMaxLength(200)),
  color: Schema.NullOr(Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/))),
});
export type AccountSettings = typeof AccountSettings.Type;
export const AccountPlacement = Schema.Struct({
  profileId: Schema.NullOr(Schema.String),
  /** Insert before this account in the target profile; null appends. */
  beforeId: Schema.NullOr(Schema.String),
});
export type AccountPlacement = typeof AccountPlacement.Type;
export const accountName = (account: Account) => account.description?.trim() || account.email;

export const PROFILE_COLORS = [
  "blue",
  "violet",
  "rose",
  "orange",
  "amber",
  "emerald",
  "teal",
  "slate",
] as const;
export const ProfileColor = Schema.Literals(PROFILE_COLORS);
export type ProfileColor = typeof ProfileColor.Type;

/** A named group of accounts, like an Arc space. */
export const Profile = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** One emoji or short text shown on the switcher. */
  icon: Schema.String,
  color: ProfileColor,
  position: Schema.Number,
});
export type Profile = typeof Profile.Type;

export const ProfileInput = Schema.Struct({
  name: Schema.String,
  icon: Schema.String,
  color: ProfileColor,
});
export type ProfileInput = typeof ProfileInput.Type;

/** A Gmail user label, an Outlook custom folder or an IMAP folder. */
export const Label = Schema.Struct({
  accountId: Schema.String,
  /** The value that appears in `MessageSummary.labels`. */
  id: Schema.String,
  name: Schema.String,
  labelListVisibility: Schema.optionalKey(
    Schema.Literals(["labelShow", "labelShowIfUnread", "labelHide"]),
  ),
  messageListVisibility: Schema.optionalKey(Schema.Literals(["show", "hide"])),
  /** Background color from the provider, if it has one. */
  color: Schema.NullOr(Schema.String),
});
export type Label = typeof Label.Type;

// Messages

export const Address = Schema.Struct({
  name: Schema.String,
  address: Schema.String,
  /** Provider contact identity, only present on contact-source addresses. */
  contactKey: Schema.optionalKey(Schema.String),
});
export type Address = typeof Address.Type;

export const Attachment = Schema.Struct({
  filename: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
});
export type Attachment = typeof Attachment.Type;

export { DerivedChunk, IndexingProgress } from "./media.js";
import { DerivedChunk } from "./media.js";

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

/** One row of a conversation list: the newest message of a thread in the view. */
export const ThreadSummary = Schema.Struct({
  ...summaryFields,
  /** Cached names only; showing attachments never downloads their content. */
  attachmentNames: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Messages in the whole thread, across mailboxes. */
  threadCount: Schema.Number,
  /** Distinct senders in the thread, oldest first. */
  participants: Schema.Array(Address),
  derivedMatches: Schema.optionalKey(Schema.Array(DerivedChunk)),
});
export type ThreadSummary = typeof ThreadSummary.Type;

export const Message = Schema.Struct({
  ...summaryFields,
  to: Schema.Array(Address),
  cc: Schema.Array(Address),
  bcc: Schema.optionalKey(Schema.Array(Address)),
  rfcMessageId: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(Schema.Number),
  /** RFC Reply-To targets; absent means unknown cached headers, [] means no Reply-To. */
  replyTo: Schema.optionalKey(Schema.Array(Address)),
  bodyText: Schema.String,
  bodyHtml: Schema.String,
  webLink: Schema.optionalKey(Schema.String),
  /** Calendar MIME part or provider meeting message; absent on older cached mail. */
  hasCalendar: Schema.optionalKey(Schema.Boolean),
  bodyCached: Schema.optionalKey(Schema.Boolean),
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
  providerId: Schema.String,
  threadId: Schema.String,
  subject: Schema.String,
  from: Address,
  to: Schema.Array(Address),
  cc: Schema.Array(Address),
  bcc: Schema.optionalKey(Schema.Array(Address)),
  rfcMessageId: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(Schema.Number),
  replyTo: Schema.optionalKey(Schema.Array(Address)),
  date: Schema.Number,
  snippet: Schema.String,
  bodyText: Schema.String,
  bodyHtml: Schema.String,
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

// Changes

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
  draftId: Schema.NullOr(Schema.String),
  messageId: Schema.NullOr(Schema.String),
});
export type DraftRemote = typeof DraftRemote.Type;

/** Draft changes waiting in the queue next to MailOps. */
export const DraftOp = Schema.Union([
  /** Push the draft's current content; the queue reads it when the op runs. */
  Schema.Struct({ kind: Schema.Literal("saveDraft"), draftId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("deleteDraft"), remote: DraftRemote }),
]);
export type DraftOp = typeof DraftOp.Type;

export const QueuedOp = Schema.Union([MailOp, DraftOp]);
export type QueuedOp = typeof QueuedOp.Type;

// Compose settings

export const UNDO_SEND_SECONDS = [0, 5, 10, 20, 30] as const;

export const LANGUAGES = ["system", "zh-CN", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

// Reading settings

/** Seconds a thread stays open before it is marked read; "manual" never marks it. */
export const MARK_READ_DELAYS = [0, 1, 3, 5, "manual"] as const;
export type MarkReadDelay = (typeof MARK_READ_DELAYS)[number];

/** Seven text sizes for the reader, as a percentage of the normal size. */
export const READER_ZOOMS = [80, 90, 100, 110, 125, 150, 175] as const;
export type ReaderZoom = (typeof READER_ZOOMS)[number];

/**
 * The background messages open on. Many HTML mails assume white, so "light"
 * keeps them white in dark mode; "theme" follows the app's appearance.
 */
export const MESSAGE_BACKGROUNDS = ["light", "theme"] as const;

export const THREAD_ORDERS = ["oldest", "newest"] as const;

export const SHORTCUT_SETS = ["mimestream", "gmail", "apple"] as const;
export const NotificationMode = Schema.Literals(["primary", "inbox", "off"]);
export type NotificationMode = typeof NotificationMode.Type;
/** Minutes after midnight in the computer's local time. Equal endpoints mean all day. */
export const QuietHours = Schema.Struct({
  enabled: Schema.Boolean,
  start: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1439 })),
  end: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1439 })),
});
export type QuietHours = typeof QuietHours.Type;

export const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];
/** Local wall-clock minutes; equal endpoints mean the entire starting weekday. */
export const ActiveWindow = Schema.Struct({
  start: QuietHours.fields.start,
  end: QuietHours.fields.end,
});
export type ActiveWindow = typeof ActiveWindow.Type;
export const ActiveHours = Schema.Struct({
  enabled: Schema.Boolean,
  days: Schema.Struct({
    sunday: Schema.Array(ActiveWindow),
    monday: Schema.Array(ActiveWindow),
    tuesday: Schema.Array(ActiveWindow),
    wednesday: Schema.Array(ActiveWindow),
    thursday: Schema.Array(ActiveWindow),
    friday: Schema.Array(ActiveWindow),
    saturday: Schema.Array(ActiveWindow),
  }),
});
export type ActiveHours = typeof ActiveHours.Type;
export const DEFAULT_ACTIVE_HOURS: ActiveHours = {
  enabled: false,
  days: {
    sunday: [],
    monday: [{ start: 540, end: 1020 }],
    tuesday: [{ start: 540, end: 1020 }],
    wednesday: [{ start: 540, end: 1020 }],
    thursday: [{ start: 540, end: 1020 }],
    friday: [{ start: 540, end: 1020 }],
    saturday: [],
  },
};

export type NotificationBatch = {
  readonly kind: "immediate" | "digest";
  readonly profileId: string | null;
  readonly messages: readonly MessageSummary[];
};

/** App preferences, stored in core so the CLI and a mobile app see the same values. */
export const NotificationActions = Schema.Array(
  Schema.Literals(["archive", "trash", "read", "menu"]),
).check(Schema.isMaxLength(3));
export const SWIPE_ACTIONS = ["none", "archive", "trash", "read", "star", "snooze"] as const;
export const SwipeAction = Schema.Literals(SWIPE_ACTIONS);
export type SwipeAction = typeof SwipeAction.Type;
export const TOOLBAR_ACTIONS = [
  "archive",
  "trash",
  "spam",
  "snooze",
  "filter",
  "read",
  "star",
  "important",
  "move",
  "label",
  "removeLabel",
  "sendAgain",
  "reply",
  "replyAll",
  "forward",
  "forwardAttachment",
  "openWindow",
] as const;
export const ToolbarAction = Schema.Literals(TOOLBAR_ACTIONS);
export type ToolbarAction = typeof ToolbarAction.Type;
export const AttachmentSaveFolder = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ask") }),
  Schema.Struct({ kind: Schema.Literal("downloads") }),
  Schema.Struct({ kind: Schema.Literal("custom"), path: Schema.String }),
]);
export type AttachmentSaveFolder = typeof AttachmentSaveFolder.Type;

export const Prefs = Schema.Struct({
  contactPhotos: Schema.Boolean,
  emojiReplacement: Schema.Boolean,
  composeFormatBar: Schema.Boolean,
  composeMarkdownReplacement: Schema.Boolean,
  composeSmartLists: Schema.Boolean,
  inlineImageSize: InlineImageSize,
  composeFont: ComposeFont,
  updateChannel: Schema.Literals(["stable", "latest"]),
  labs: Schema.Struct({ markdown: Schema.Boolean, calendarDetection: Schema.Boolean }),
  swipeActions: Schema.Struct({
    leftShort: SwipeAction,
    leftLong: SwipeAction,
    rightShort: SwipeAction,
    rightLong: SwipeAction,
  }),
  toolbarActions: Schema.Array(ToolbarAction),
  messageListDensity: Schema.Literals(["dense", "compact", "default", "expanded"]),
  specialFolderBadges: Schema.Struct({
    starred: Schema.Boolean,
    drafts: Schema.Boolean,
    spam: Schema.Boolean,
  }),
  showMore: Schema.Boolean,
  /** How long Send waits so the person can take the message back. */
  undoSendSeconds: Schema.Literals(UNDO_SEND_SECONDS),
  /** Null follows the current view; otherwise use this account or verified alias. */
  defaultFrom: Schema.NullOr(Schema.Struct({ accountId: Schema.String, address: Schema.String })),
  /** Show names and full email addresses in recipient chips. */
  showFullRecipientAddresses: Schema.Boolean,
  replyFrom: Schema.Literals(["received", "default"]),
  quoteSelection: Schema.Literals(["ask", "always", "never"]),
  /** UI language. "system" follows the OS language. */
  language: Schema.Literals(LANGUAGES),
  markReadDelay: Schema.Literals(MARK_READ_DELAYS),
  nextSelection: Schema.Literals(["below", "above", "none"]),
  deleteKeyAction: Schema.Literals(["trash", "archive", "removeLabel", "ask"]),
  readingPanePosition: Schema.Literals(["right", "bottom"]),
  sidebarVisible: Schema.Boolean,
  readerZoom: Schema.Literals(READER_ZOOMS),
  messageBackground: Schema.Literals(MESSAGE_BACKGROUNDS),
  attachmentSaveFolder: Schema.optionalKey(AttachmentSaveFolder),
  attachmentOpenFolder: Schema.optionalKey(Schema.Literals(["internal", "downloads"])),
  /** Group messages into conversations. Off lists every message on its own. */
  threadGrouping: Schema.Boolean,
  /** Message order inside an open conversation. */
  threadOrder: Schema.Literals(THREAD_ORDERS),
  shortcutSet: Schema.Literals(SHORTCUT_SETS),
  /** Missing accounts default to Primary. Other providers treat Primary as Inbox. */
  notifications: Schema.Record(Schema.String, NotificationMode),
  /** Profile id to quiet hours; "all" covers accounts outside a profile. */
  quietHours: Schema.Record(Schema.String, QuietHours),
  /** A configured weekly schedule supersedes legacy daily quiet hours. */
  activeHours: Schema.Record(Schema.String, ActiveHours),
  menuBarUnreadCount: Schema.Boolean,
  showAccountLabels: Schema.Boolean,
  notificationActions: NotificationActions,
});
export type Prefs = typeof Prefs.Type;

export const DEFAULT_PREFS: Prefs = {
  contactPhotos: true,
  emojiReplacement: true,
  composeFormatBar: true,
  composeMarkdownReplacement: true,
  composeSmartLists: true,
  inlineImageSize: "medium",
  composeFont: { family: "Arial", size: 14 },
  updateChannel: "stable",
  labs: { markdown: true, calendarDetection: true },
  swipeActions: { leftShort: "archive", leftLong: "trash", rightShort: "read", rightLong: "star" },
  toolbarActions: [...TOOLBAR_ACTIONS],
  messageListDensity: "default",
  specialFolderBadges: { starred: true, drafts: true, spam: true },
  showMore: true,
  undoSendSeconds: 5,
  defaultFrom: null,
  showFullRecipientAddresses: false,
  replyFrom: "received",
  quoteSelection: "ask",
  language: "system",
  markReadDelay: 0,
  nextSelection: "below",
  deleteKeyAction: "trash",
  readingPanePosition: "right",
  sidebarVisible: true,
  readerZoom: 100,
  messageBackground: "light",
  attachmentSaveFolder: { kind: "ask" },
  attachmentOpenFolder: "internal",
  threadGrouping: true,
  threadOrder: "oldest",
  shortcutSet: "mimestream",
  notifications: {},
  quietHours: {},
  activeHours: {},
  menuBarUnreadCount: false,
  showAccountLabels: false,
  notificationActions: ["archive", "trash"],
};

/** Signatures differ for new messages and for replies and forwards. */
export const SignatureKind = Schema.Literals(["new", "reply"]);
export type SignatureKind = typeof SignatureKind.Type;

/** A local signature for one sending address. Empty text means none. */
export const Signature = Schema.Struct({
  address: Schema.String,
  kind: SignatureKind,
  text: Schema.String,
  html: Schema.optionalKey(Schema.String),
});
export type Signature = typeof Signature.Type;

/** Template text may use {first_name}, {last_name}, {name} and {email} of the first recipient. */
export const TemplateInput = Schema.Struct({
  name: Schema.String,
  subject: Schema.String,
  to: Schema.Array(Address),
  cc: Schema.Array(Address),
  bcc: Schema.optionalKey(Schema.Array(Address)),
  body: Schema.String,
});
export type TemplateInput = typeof TemplateInput.Type;

export const Template = Schema.Struct({
  id: Schema.String,
  ...TemplateInput.fields,
  updatedAt: Schema.Number,
});
export type Template = typeof Template.Type;

/**
 * Every change to mail or accounts is one of these values, so the same thing
 * can be checked by policy, parked as a proposal, audited and replayed.
 */
export const Command = Schema.Union([
  /** `threads` holds any message id of each thread; the whole thread changes. */
  Schema.Struct({
    kind: Schema.Literal("modify"),
    threads: Schema.Array(Schema.String),
    op: MailOp,
  }),
  Schema.Struct({
    kind: Schema.Literal("send"),
    accountId: Schema.String,
    message: OutgoingMessage,
    /** The saved draft this sends. It is removed locally and on the provider once sent. */
    draftId: Schema.optionalKey(Schema.String),
    /** Archive the thread of `inReplyTo` after sending (send and archive). */
    archive: Schema.optionalKey(Schema.Boolean),
  }),
  /** A message for a person to finish and send from the app. Agents only; it becomes a synced draft. */
  Schema.Struct({
    kind: Schema.Literal("draft"),
    accountId: Schema.String,
    message: OutgoingMessage,
  }),
  Schema.Struct({ kind: Schema.Literal("removeAccount"), accountId: Schema.String }),
]);
export type Command = typeof Command.Type;

/** Who asks for a command. Agents are models acting through MCP, rules or the built-in assistant. */
export const Actor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user"), surface: Schema.Literals(["app", "cli"]) }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    surface: Schema.Literals(["mcp", "rule", "assistant"]),
    /** MCP client name, rule name or model name; agent policies are keyed by it. */
    name: Schema.String,
    /** Why the agent wants this, shown when a person reviews the proposal. */
    rationale: Schema.optionalKey(Schema.String),
  }),
]);
export type Actor = typeof Actor.Type;

export function actorLabel(actor: Actor): string {
  return actor.kind === "user" ? `user:${actor.surface}` : `agent:${actor.surface}:${actor.name}`;
}

export const FlushResult = Schema.Struct({
  done: Schema.Number,
  failed: Schema.Number,
  /** Accounts that need a new sign-in before their changes can go through. */
  reauth: Schema.Array(Schema.String),
});
export type FlushResult = typeof FlushResult.Type;

/** An app operation's one-use, process-local undo handle. */
export const BatchResult = Schema.Struct({ undoId: Schema.String });
export type BatchResult = typeof BatchResult.Type;

/** What `perform` did with a command. */
export const Outcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("applied"), flush: Schema.optionalKey(FlushResult) }),
  Schema.Struct({ status: Schema.Literal("proposed"), proposalId: Schema.Number }),
  Schema.Struct({ status: Schema.Literal("denied"), reason: Schema.String }),
]);
export type Outcome = typeof Outcome.Type;

export const AgentWriteMode = Schema.Literals(["off", "propose", "allow"]);
export type AgentWriteMode = typeof AgentWriteMode.Type;

export const Proposal = Schema.Struct({
  id: Schema.Number,
  createdAt: Schema.Number,
  actor: Actor,
  command: Command,
  status: Schema.Literals(["pending", "approved", "rejected"]),
});
export type Proposal = typeof Proposal.Type;

export const AuditEntry = Schema.Struct({
  at: Schema.Number,
  /** actorLabel(): "user:app", "agent:mcp:claude-code" and so on. */
  actor: Schema.String,
  accountId: Schema.NullOr(Schema.String),
  action: Schema.String,
  detail: Schema.Unknown,
});
export type AuditEntry = typeof AuditEntry.Type;

// Sync

export const SyncProgress = Schema.Struct({
  accountId: Schema.String,
  fetched: Schema.Number,
  total: Schema.Number,
});
export type SyncProgress = typeof SyncProgress.Type;

export const SyncResult = Schema.Struct({
  accountId: Schema.String,
  changed: Schema.Number,
  deleted: Schema.Number,
  error: Schema.optionalKey(Schema.String),
  /** The provider rejected the credentials; the account needs a new sign-in. */
  needsReauth: Schema.optionalKey(Schema.Boolean),
});
export type SyncResult = typeof SyncResult.Type;
