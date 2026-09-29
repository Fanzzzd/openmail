/** Query helpers for the Store: decode rows with a schema, and die on SQL errors. */
import { Effect, Option, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";

type Query = Effect.Effect<ReadonlyArray<unknown>, SqlError>;

/** Runs a query and decodes every row. */
export function all<A, I>(schema: Schema.Codec<A, I>) {
  const decode = Schema.decodeUnknownEffect(Schema.Array(schema));
  return (query: Query): Effect.Effect<ReadonlyArray<A>> =>
    query.pipe(
      Effect.flatMap((rows) => decode(rows)),
      Effect.orDie,
    );
}

/** Runs a query and decodes the first row, if any. */
export function first<A, I>(schema: Schema.Codec<A, I>) {
  const rows = all(schema);
  return (query: Query): Effect.Effect<Option.Option<A>> =>
    Effect.map(rows(query), (r) => Option.fromNullishOr(r[0]));
}

export const run = (query: Effect.Effect<unknown, SqlError>): Effect.Effect<void> =>
  Effect.orDie(Effect.asVoid(query));
