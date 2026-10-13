/** Domain schemas for user preferences, signatures and templates. */

import { Schema, Struct } from "effect";
import { Address, type MessageSummary } from "./message.js";
import { ComposeFont, InlineImageSize } from "./changes.js";

export const UNDO_SEND_SECONDS = [0, 5, 10, 20, 30] as const;

export const LANGUAGES = [
  "system",
  "zh-CN",
  "en",
  "cs",
  "nl",
  "fr",
  "de",
  "it",
  "ja",
  "ru",
  "es",
] as const;
export type Language = (typeof LANGUAGES)[number];

// Reading settings

/** Seconds a thread stays open before it is marked read; "manual" never marks it. */
export const MARK_READ_DELAYS = [0, 1, 3, 5, "manual"] as const;
export type MarkReadDelay = (typeof MARK_READ_DELAYS)[number];

/** Seven text sizes for the reader, as a percentage of the normal size. */
export const READER_ZOOMS = [80, 90, 100, 110, 125, 150, 175] as const;
export type ReaderZoom = (typeof READER_ZOOMS)[number];

/**
 * When remote images load without asking: never, for authenticated known senders, or always.
 * Known trackers stay blocked in every mode.
 */
export const REMOTE_IMAGE_MODES = ["ask", "known", "always"] as const;
export type RemoteImageMode = (typeof REMOTE_IMAGE_MODES)[number];

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
/** Every toolbar action, in the default order. Reply and Forward follow Archive and Delete so they fit at 1280 px. */
export const TOOLBAR_ACTIONS = [
  "archive",
  "trash",
  "reply",
  "replyAll",
  "forward",
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
  "forwardAttachment",
  "openWindow",
] as const;
/**
 * The default order before Reply and Forward moved forward. A stored list equal to it was never
 * customised, so it reads as the current default; any other stored order is the person's own.
 */
export const LEGACY_TOOLBAR_ACTIONS: readonly (typeof TOOLBAR_ACTIONS)[number][] = [
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
];
export const ToolbarAction = Schema.Literals(TOOLBAR_ACTIONS);
export type ToolbarAction = typeof ToolbarAction.Type;
export const AttachmentSaveFolder = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ask") }),
  Schema.Struct({ kind: Schema.Literal("downloads") }),
  Schema.Struct({ kind: Schema.Literal("custom"), path: Schema.String }),
]);
export type AttachmentSaveFolder = typeof AttachmentSaveFolder.Type;

export const Prefs = Schema.Struct({
  remoteImages: Schema.Literals(REMOTE_IMAGE_MODES),
  /** Read only: true once a remote image mode is stored. */
  remoteImagesChosen: Schema.Boolean,
  cleanLinks: Schema.optionalKey(Schema.Boolean),
  spellcheck: Schema.Boolean,
  spellcheckLanguages: Schema.Array(Schema.String),
  defaultProfilesPrompted: Schema.Boolean,
  bodyCacheBytes: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(2 * 1024 ** 3),
  ),
  totalCacheBytes: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(100 * 1024 ** 3),
  ),
  attachmentCacheBytes: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(2 * 1024 ** 3),
  ),
  contactPhotos: Schema.Boolean,
  useAppleContacts: Schema.Boolean,
  emojiReplacement: Schema.Boolean,
  composeFormatBar: Schema.Boolean,
  composeMarkdownReplacement: Schema.Boolean,
  composeSmartLists: Schema.Boolean,
  inlineImageSize: InlineImageSize,
  composeFont: ComposeFont,
  updateChannel: Schema.Literals(["stable", "latest"]),
  updateAutoDownload: Schema.Boolean,
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
  signaturePosition: Schema.Literals(["above", "below"]),
  signatureSeparator: Schema.Boolean,
  signatureOrder: Schema.Array(Schema.String),
  quoteSelection: Schema.Literals(["ask", "always", "never"]),
  /** UI language. "system" follows the OS language. */
  language: Schema.Literals(LANGUAGES),
  markReadDelay: Schema.Literals(MARK_READ_DELAYS),
  nextSelection: Schema.Literals(["below", "above", "none"]),
  deleteKeyAction: Schema.Literals(["trash", "archive", "removeLabel", "ask"]),
  readingPanePosition: Schema.Literals(["right", "bottom"]),
  sidebarVisible: Schema.Boolean,
  toolbarVisible: Schema.Boolean,
  readingPaneVisible: Schema.Boolean,
  readerZoom: Schema.Literals(READER_ZOOMS),
  messageBackground: Schema.Literals(MESSAGE_BACKGROUNDS),
  attachmentSaveFolder: Schema.optionalKey(AttachmentSaveFolder),
  attachmentOpenFolder: Schema.optionalKey(Schema.Literals(["internal", "downloads"])),
  /** Group messages into conversations. Off lists every message on its own. */
  threadGrouping: Schema.Boolean,
  /** Message order inside an open conversation. */
  threadOrder: Schema.Literals(THREAD_ORDERS),
  shortcutSet: Schema.Literals(SHORTCUT_SETS),
  /** Missing accounts default to Primary (Outlook Focused). IMAP treats Primary as Inbox. */
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

/** The preferences a caller can change. `remoteImagesChosen` follows the stored mode. */
export const PrefsPatch = Schema.Struct(
  Struct.map(Struct.omit(Prefs.fields, ["remoteImagesChosen"]), Schema.optionalKey),
);
export type PrefsPatch = typeof PrefsPatch.Type;

export const DEFAULT_PREFS: Prefs = {
  remoteImages: "always",
  remoteImagesChosen: false,
  cleanLinks: true,
  spellcheck: true,
  spellcheckLanguages: [],
  defaultProfilesPrompted: false,
  bodyCacheBytes: 0,
  totalCacheBytes: 0,
  attachmentCacheBytes: 512 * 1024 ** 2,
  contactPhotos: true,
  useAppleContacts: false,
  emojiReplacement: true,
  composeFormatBar: true,
  composeMarkdownReplacement: true,
  composeSmartLists: true,
  inlineImageSize: "medium",
  composeFont: { family: "Arial", size: 14 },
  updateChannel: "stable",
  updateAutoDownload: true,
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
  signaturePosition: "above",
  signatureSeparator: true,
  signatureOrder: [],
  quoteSelection: "ask",
  language: "system",
  markReadDelay: 0,
  nextSelection: "below",
  deleteKeyAction: "trash",
  readingPanePosition: "right",
  sidebarVisible: true,
  toolbarVisible: true,
  readingPaneVisible: true,
  readerZoom: 100,
  messageBackground: "light",
  attachmentSaveFolder: { kind: "downloads" },
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
