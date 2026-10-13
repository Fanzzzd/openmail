import { Schema } from "effect";

/** A thread shaped for a language model: plain text, quotes and signatures cut, ids kept for citing. */
export const ModelThread = Schema.Struct({
  threadId: Schema.String,
  accountId: Schema.String,
  subject: Schema.String,
  /** Absent in model context (read_thread), which leaves label ids out. */
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
  messages: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      from: Schema.String,
      to: Schema.Array(Schema.String),
      cc: Schema.Array(Schema.String),
      date: Schema.String,
      text: Schema.String,
      flags: Schema.optionalKey(
        Schema.Array(
          Schema.Literals([
            "hidden-text-removed",
            "plain-differs",
            "budget-exceeded",
            "quoted-text-removed",
          ]),
        ),
      ),
      quotedTextRemoved: Schema.optionalKey(Schema.Number),
      /** Attachment names. Absent in model context, which leaves them out. */
      attachments: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  /** Characters dropped to fit the budget. 0 when nothing was cut. */
  truncated: Schema.Number,
});
export type ModelThread = typeof ModelThread.Type;
