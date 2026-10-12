import { SYSTEM_FOLDERS, systemFolderId, type MailOp } from "@openmail/core/schema";
import { Schema } from "effect";

export const MESSAGE_DRAG = "application/x-openmail-messages";
export const LABEL_DRAG = "application/x-openmail-label";
export const FAVORITE_DRAG = "application/x-openmail-favorite";
export const DragMessages = Schema.Struct({
  ids: Schema.Array(Schema.String),
  removeLabelId: Schema.NullOr(Schema.String),
  flat: Schema.Boolean,
});
export const DragLabel = Schema.Struct({ accountId: Schema.String, id: Schema.String });

export function decodeDrag<A>(schema: Schema.Decoder<A>, value: string): A | null {
  try {
    return Schema.decodeUnknownSync(schema)(JSON.parse(value));
  } catch {
    return null;
  }
}

/** A category target adds membership; it never supplies a physical folder destination. */
export function sidebarDropOperation(target: string, removeLabelId: string | null): MailOp | null {
  if (target.startsWith("category:"))
    return { kind: "categories", add: [target.slice(9)], remove: [] };
  const mailbox = SYSTEM_FOLDERS.find((id) => systemFolderId(id) === target);
  if (mailbox)
    return mailbox === "inbox" || mailbox === "trash" || mailbox === "spam"
      ? { kind: mailbox }
      : null;
  return {
    kind: "move",
    labelId: target,
    removeLabelId: removeLabelId?.startsWith("category:") ? null : removeLabelId,
  };
}
