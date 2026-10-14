/**
 * Domain schemas for accounts, profiles and labels. Every value that crosses a
 * boundary (SQLite rows, provider JSON, IPC, MCP tool calls) is decoded with a
 * schema from domain/, and the TypeScript types are derived from them.
 */

import { Schema } from "effect";
import { ReauthReason } from "./errors.js";

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
  /** Explicit trust configuration; no IMAP host or preset implies an authserv-id. */
  authservId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The name in From on sent mail and drafts. Absent sends the address alone. */
  senderName: Schema.optionalKey(Schema.String),
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
  /** Why the account needs a new sign-in. Absent while it does not, and for marks before migration 44. */
  reauthReason: Schema.optionalKey(ReauthReason),
  /** For imap accounts: which preset or server. Never contains the password. */
  imap: Schema.optionalKey(ImapSettings),
});
export type Account = typeof Account.Type;

export const AccountSettings = Schema.Struct({
  enabled: Schema.Boolean,
  imapAuthservId: Schema.optionalKey(
    Schema.NullOr(
      Schema.String.check(
        Schema.isMaxLength(253),
        Schema.isPattern(/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/),
      ),
    ),
  ),
  description: Schema.String.check(Schema.isMaxLength(200)),
  color: Schema.NullOr(Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/))),
  /** IMAP only: the name in From. Empty sends the address alone. */
  imapSenderName: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
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

/** A space name without surrounding blanks. Names are found by text, so they are stored trimmed. */
export const ProfileName = Schema.Trim.check(Schema.isMinLength(1));

export const ProfileInput = Schema.Struct({
  name: ProfileName,
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
