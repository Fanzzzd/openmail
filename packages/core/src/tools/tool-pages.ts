import { Buffer } from "../platform/bytes.js";
import { sha256Hex } from "../platform/crypto.js";
import { Effect, Schema } from "effect";

const ToolCursor = Schema.String.check(Schema.isMaxLength(24_000)).annotate({
  description: "next_cursor from the last page, with the same filters.",
});
export const ToolBudget = Schema.Int.check(Schema.isBetween({ minimum: 2000, maximum: 24_000 }))
  .annotate({
    description: "Result size limit in UTF-8 JSON bytes. Default 12000.",
  })
  .pipe(Schema.withDecodingDefaultKey(Effect.succeed(12_000)));
export const ToolLimit = (fallback = 25, maximum = 100) =>
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum }))
    .annotate({
      description: `Default ${fallback}. token_budget may return fewer rows.`,
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
  sha256Hex(JSON.stringify([name, filters]));
export const encodeCursor = (cursor: PageCursor) =>
  Buffer.from(JSON.stringify(cursor))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
export function decodeCursor(raw: string | undefined, scope: string): PageCursor {
  if (!raw) return { scope, offset: 0 };
  const cursor = Schema.decodeUnknownSync(Schema.fromJsonString(Cursor))(
    Buffer.from(raw, "base64").toString("utf8"),
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
