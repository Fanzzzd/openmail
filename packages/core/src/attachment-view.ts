import { Schema } from "effect";

/** First index is the stored provider part; subsequent indices address container children. */
export const AttachmentPath = Schema.Array(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
).check(Schema.isMinLength(1), Schema.isMaxLength(8));
export const ReaderAttachment = Schema.Struct({
  path: AttachmentPath,
  filename: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
  embedded: Schema.Boolean,
  /** Invalid/unsupported TNEF stays saveable as the original file. */
  decodeError: Schema.Boolean,
});
export type ReaderAttachment = typeof ReaderAttachment.Type;
export const EmbeddedMessage = Schema.Struct({
  subject: Schema.String,
  from: Schema.String,
  to: Schema.String,
  cc: Schema.String,
  date: Schema.String,
  bodyHtml: Schema.String,
  attachments: Schema.Array(ReaderAttachment),
});
export type EmbeddedMessage = typeof EmbeddedMessage.Type;
export const AttachmentAction = Schema.Literals([
  "save",
  "open",
  "preview",
  "share",
  "copy",
  "drag",
]);
export type AttachmentAction = typeof AttachmentAction.Type;

export const AttachmentActionResult = Schema.Struct({
  count: Schema.Int,
  failures: Schema.Array(
    Schema.Struct({ path: AttachmentPath, filename: Schema.String, reason: Schema.String }),
  ),
});
export type AttachmentActionResult = typeof AttachmentActionResult.Type;
