/** Tools for a message's attachments and the text indexed from them. */

import {
  MESSAGE_ID_HINT,
  MailToolError,
  MessageId,
  bounded,
  cursorFor,
  mailTool,
  page,
  pageScope,
  readOnly,
  toToolError,
  toolError,
} from "./tool-common.js";
import { Effect, Schema } from "effect";
import { PageParameters, PageResult, ToolInt, encodeCursor, shortText } from "./tool-pages.js";
import { Attachment } from "../domain/message.js";
import { DerivedChunk } from "../ai/media.js";
import type { HandlersFor, ToolContext } from "./tool-context.js";

export const ListAttachments = readOnly(
  mailTool("list_attachments", {
    description:
      "List a message's attachments with index, filename, type and size. Pass the index to attachment_text; no tool downloads files. Page with next_cursor.",
    parameters: Schema.Struct({ message_id: MessageId, ...PageParameters }),
    success: Schema.Struct({
      ...PageResult,
      attachments: Schema.Array(
        Schema.Struct({ ...Attachment.fields, message_id: Schema.String, index: ToolInt }),
      ),
    }),
    failure: MailToolError,
    failureMode: "return",
  }),
);
export const AttachmentText = readOnly(
  mailTool("attachment_text", {
    description:
      "Read text that on-device OCR or PDF extraction already produced for a message's attachments and images. Empty means nothing is indexed yet. Page with next_cursor.",
    parameters: Schema.Struct({
      message_id: MessageId,
      attachment_index: Schema.optionalKey(
        ToolInt.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
          description: "Only this attachment, by index from list_attachments.",
        }),
      ),
      ...PageParameters,
    }),
    success: Schema.Struct({
      ...PageResult,
      chunks: Schema.Array(Schema.Struct({ ...DerivedChunk.fields, text_offset: ToolInt })),
    }),
    failure: MailToolError,
    failureMode: "return",
  }),
);

export const attachmentHandlers = ({ mailbox, requireMessage }: ToolContext) => {
  return {
    list_attachments: (p) =>
      page(
        "list_attachments",
        p,
        Effect.andThen(
          requireMessage(p.message_id),
          mailbox.reading.thread(p.message_id).pipe(Effect.mapError(toToolError)),
        ).pipe(
          Effect.flatMap((messages) => {
            const message = messages.find((m) => m.id === p.message_id);
            return message
              ? Effect.succeed(
                  message.attachments.map((a, index) => ({
                    ...a,
                    filename: shortText(a.filename),
                    message_id: message.id,
                    index,
                  })),
                )
              : Effect.fail(
                  toolError("not_found", `No message with id ${p.message_id}.`, MESSAGE_ID_HINT),
                );
          }),
        ),
      ).pipe(Effect.map(({ items, ...rest }) => ({ ...rest, attachments: items }))),
    attachment_text: Effect.fnUntraced(function* (p) {
      const scope = pageScope("attachment_text", p);
      const cursor = yield* cursorFor(p.cursor, scope);
      yield* requireMessage(p.message_id);
      const rows = yield* mailbox.ai.derivedChunks(p.message_id);
      const candidates: (DerivedChunk & { text_offset: number })[] = [];
      let position = 0;
      outer: for (const row of rows) {
        if (
          row.source.kind === "body" ||
          (p.attachment_index !== undefined &&
            (row.source.kind !== "attachment" || row.source.index !== p.attachment_index))
        )
          continue;
        for (let offset = 0; offset < row.text.length; offset += 128) {
          if (position++ < cursor.offset) continue;
          candidates.push({
            ...row,
            source: { ...row.source, name: shortText(row.source.name) },
            text: row.text.slice(offset, offset + 128),
            text_offset: offset,
          });
          if (candidates.length > p.limit) break outer;
        }
      }
      const chunks = yield* bounded(candidates, p.limit, p.token_budget);
      return {
        chunks,
        ...(candidates.length > chunks.length
          ? { next_cursor: encodeCursor({ scope, offset: cursor.offset + chunks.length }) }
          : {}),
      };
    }),
  } satisfies HandlersFor<typeof ListAttachments | typeof AttachmentText>;
};
