/**
 * What each provider can do, as plain data. Core validation, the desktop
 * renderer, the CLI and mobile read this table instead of comparing provider
 * names, so a control the UI shows is one core accepts. Each field answers one
 * question a caller asks; protocol details stay in the adapters.
 */
import type { Provider } from "../domain/account.js";
import type { MailOp } from "../domain/changes.js";
import { CATEGORIES, OUTLOOK_CATEGORIES, type INBOX_CATEGORIES } from "../domain/message.js";

/** Server filters (Gmail) or rules (Outlook). */
export interface RuleCapabilities {
  /** Rules carry a name the person types (Outlook rules). */
  readonly named: boolean;
  /** A free-text search query is a condition, and previews run it on the server. */
  readonly query: boolean;
  /** Size conditions are a multiple of this many bytes. */
  readonly sizeStep: number;
  /** "Not from chats" is a condition. */
  readonly excludeChats: boolean;
  /** Extra conditions and exceptions (except from, to, subject, attachment, and more). */
  readonly exceptions: boolean;
  /** Star is an action. */
  readonly star: boolean;
  /** "Always / never mark important" is an action. */
  readonly importanceLabel: boolean;
  /** Add and remove several labels, including system labels and categories. */
  readonly labelActions: boolean;
  /** Stop processing, set importance, assign categories and copy to folder. The server applies them to future mail only. */
  readonly serverOnlyActions: boolean;
  /** Where a preview finds matches: a server search, or rule evaluation over cached mail. */
  readonly preview: "server" | "cache";
  /** A deleted rule can be restored from its backup. */
  readonly recovery: boolean;
}

export interface ProviderCapabilities {
  /** Gmail labels stack on a message; Outlook and IMAP keep each message in one folder. */
  readonly organization: "labels" | "folders";
  /** Mark important writes to the server. */
  readonly important: boolean;
  /** The inbox split the account offers: Gmail categories or Outlook Focused/Other. */
  readonly inboxTabs: "categories" | "focused" | null;
  /** Named categories stack on a message next to its folder (Outlook). */
  readonly categories: boolean;
  /** A message can be copied into more folders (IMAP). */
  readonly copy: boolean;
  /** Label colour and visibility live on the server. Otherwise OpenMail keeps colours on this device. */
  readonly serverLabelStyle: boolean;
  /** A move gives the message a new server ID (IMAP UIDs), so undo cannot survive a restart. */
  readonly moveChangesId: boolean;
  /** Server filters or rules, or null when the account has none. */
  readonly rules: RuleCapabilities | null;
  /** Automatic replies, or null when OpenMail cannot edit them. */
  readonly vacation: {
    /** The reply can have its own subject. */
    readonly subject: boolean;
    /** A schedule can set only a start or only an end. */
    readonly openEnded: boolean;
    /** Who gets the reply: a "contacts only" switch, or separate internal and external audiences. */
    readonly audience: "contacts" | "internalExternal";
  } | null;
  /** Contacts, calendar and provider settings are optional OAuth grants. */
  readonly optionalServices: boolean;
  /** Invitations are answered and added through the provider calendar. Otherwise OpenMail replies by email. */
  readonly calendar: boolean;
  /** Send-as aliases come from the server. */
  readonly sendAs: boolean;
  /** How the person signs in, and so how they sign in again. */
  readonly signIn: "oauth" | "password";
  /** Sync holds one mail session per account. Pulls, writes and header upkeep take turns on it. */
  readonly sharedSession: boolean;
  /** A message can open in the provider's web app. */
  readonly webLink: boolean;
  /** Permanent deletion needs an extra OAuth scope. */
  readonly permanentDeleteScope: boolean;
  /** A forward is created on the server and carries the original attachments itself. */
  readonly serverForward: boolean;
}

const GMAIL: ProviderCapabilities = {
  organization: "labels",
  important: true,
  inboxTabs: "categories",
  categories: false,
  copy: false,
  serverLabelStyle: true,
  moveChangesId: false,
  rules: {
    named: false,
    query: true,
    sizeStep: 1,
    excludeChats: true,
    exceptions: false,
    star: true,
    importanceLabel: true,
    labelActions: true,
    serverOnlyActions: false,
    preview: "server",
    recovery: true,
  },
  vacation: { subject: true, openEnded: true, audience: "contacts" },
  optionalServices: true,
  calendar: true,
  sendAs: true,
  signIn: "oauth",
  sharedSession: false,
  webLink: true,
  permanentDeleteScope: true,
  serverForward: false,
};

const OUTLOOK: ProviderCapabilities = {
  organization: "folders",
  important: true,
  inboxTabs: "focused",
  categories: true,
  copy: false,
  serverLabelStyle: false,
  moveChangesId: false,
  rules: {
    named: true,
    query: false,
    sizeStep: 1024,
    excludeChats: false,
    exceptions: true,
    star: false,
    importanceLabel: false,
    labelActions: false,
    serverOnlyActions: true,
    preview: "cache",
    recovery: false,
  },
  vacation: { subject: false, openEnded: false, audience: "internalExternal" },
  optionalServices: true,
  calendar: true,
  sendAs: false,
  signIn: "oauth",
  sharedSession: false,
  webLink: true,
  permanentDeleteScope: false,
  serverForward: true,
};

const IMAP: ProviderCapabilities = {
  organization: "folders",
  important: false,
  inboxTabs: null,
  categories: false,
  copy: true,
  serverLabelStyle: false,
  moveChangesId: true,
  rules: null,
  vacation: null,
  optionalServices: false,
  calendar: false,
  sendAs: false,
  signIn: "password",
  sharedSession: true,
  webLink: false,
  permanentDeleteScope: false,
  serverForward: false,
};

const TABLE: Record<Provider, ProviderCapabilities> = {
  gmail: GMAIL,
  outlook: OUTLOOK,
  imap: IMAP,
};

export const providerCapabilities = (provider: Provider): ProviderCapabilities => TABLE[provider];

/** The category labels the inbox splits into, following the account's inbox tabs. */
export function inboxCategories(provider: Provider): readonly (typeof INBOX_CATEGORIES)[number][] {
  const tabs = TABLE[provider].inboxTabs;
  if (tabs === "categories") return CATEGORIES;
  return tabs === "focused" ? OUTLOOK_CATEGORIES : [];
}

/**
 * Whether the account can run this op at all. Core rejects an unsupported
 * classification, categories or copy op; it skips an unsupported important op,
 * the same way it skips a move to the folder a message is already in.
 */
export function supportsOp(capabilities: ProviderCapabilities, kind: MailOp["kind"]): boolean {
  switch (kind) {
    case "important":
      return capabilities.important;
    case "classification":
      return capabilities.inboxTabs === "focused";
    case "categories":
      return capabilities.categories;
    case "copy":
      return capabilities.copy;
    default:
      return true;
  }
}

/** A labelling op adds a label (Gmail) or moves the message to that folder. */
export const labelOpMoves = (capabilities: ProviderCapabilities, op: MailOp): boolean =>
  op.kind === "label" && op.value && capabilities.organization === "folders";

/** A provider that signs in through OAuth. */
export type OAuthProvider = Exclude<Provider, "imap">;

/** Narrows a provider to one that signs in through OAuth. */
export const oauthProvider = (provider: Provider): provider is OAuthProvider =>
  TABLE[provider].signIn === "oauth";

/** Narrows a sign-in input or account to the providers that sign in through OAuth. */
export const signsInWithOAuth = <T extends { readonly provider: Provider }>(
  value: T,
): value is Extract<T, { readonly provider: OAuthProvider }> => oauthProvider(value.provider);
