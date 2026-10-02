import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";

export const ToolCursor = Schema.String.check(Schema.isMaxLength(24_000)).annotate({
  description: "Opaque next_cursor from the same tool and filters. Omit for the first page.",
});
export const ToolBudget = Schema.Int.check(Schema.isBetween({ minimum: 2000, maximum: 24_000 }))
  .annotate({
    description:
      "Maximum JSON UTF-8 bytes, a conservative token bound. Default 12000; 2000 to 24000.",
  })
  .pipe(Schema.withDecodingDefaultKey(Effect.succeed(12_000)));
export const ToolLimit = (fallback = 25, maximum = 100) =>
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum }))
    .annotate({
      description: `Maximum rows, 1 to ${maximum}. Default ${fallback}. The byte budget may return fewer.`,
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(fallback)));
export const PageParameters = {
  cursor: Schema.optionalKey(ToolCursor),
  limit: ToolLimit(),
  token_budget: ToolBudget,
};
export const PageResult = { next_cursor: Schema.optionalKey(Schema.String) };

const Cursor = Schema.Struct({
  scope: Schema.String,
  offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 })),
  date: Schema.optionalKey(Schema.Finite),
  id: Schema.optionalKey(Schema.String),
});
export type PageCursor = typeof Cursor.Type;
export const cursorScope = (name: string, filters: unknown) =>
  createHash("sha256")
    .update(JSON.stringify([name, filters]))
    .digest("hex");
export const encodeCursor = (cursor: PageCursor) =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");
export function decodeCursor(raw: string | undefined, scope: string): PageCursor {
  if (!raw) return { scope, offset: 0 };
  const cursor = Schema.decodeUnknownSync(Schema.fromJsonString(Cursor))(
    Buffer.from(raw, "base64url").toString("utf8"),
  );
  if (cursor.scope !== scope) throw new Error("Cursor belongs to another tool or filters.");
  return cursor;
}
export const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
export const shortText = (text: string, max = 256) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** Keep complete rows and their ids. Reserve space for cursor and notice metadata. */
export function budgetRows<A>(rows: readonly A[], limit: number, budget: number): A[] {
  const kept: A[] = [];
  let used = 1000;
  for (const row of rows.slice(0, limit)) {
    const bytes = jsonBytes(row) + 1;
    if (used + bytes > budget) {
      if (!kept.length) throw new Error("One row exceeds token_budget. Increase the budget.");
      break;
    }
    kept.push(row);
    used += bytes;
  }
  return kept;
}
