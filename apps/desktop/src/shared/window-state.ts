import { Schema } from "effect";
import { MailboxView } from "@openmail/core/schema";

export const WindowSelection = Schema.Struct({
  space: Schema.String,
  mailbox: MailboxView,
  accountId: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(
    Schema.Struct({ id: Schema.String, accountId: Schema.optionalKey(Schema.String) }),
  ),
  messageId: Schema.NullOr(Schema.String),
});
export type WindowSelection = typeof WindowSelection.Type;
export const SavedWindow = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literals(["main", "thread", "message", "compose"]),
  target: Schema.optionalKey(Schema.String),
  bounds: Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number,
    height: Schema.Number,
  }),
  maximized: Schema.Boolean,
  selection: Schema.optionalKey(WindowSelection),
});
export type SavedWindow = typeof SavedWindow.Type;

/** Unfinished recipient text is kept in memory while moving an editor to another window. */
export const ComposeRecipients = Schema.Struct({
  to: Schema.String,
  cc: Schema.String,
  bcc: Schema.String,
});
export type ComposeRecipients = typeof ComposeRecipients.Type;
