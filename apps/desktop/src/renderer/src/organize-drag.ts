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
