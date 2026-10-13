import { Effect } from "effect";
import { uncertainWrite } from "./provider-retry.js";

/** Compare provider definitions without object-key or set ordering differences. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).toSorted().join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined && !(Array.isArray(item) && item.length === 0))
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const sameProviderWrite = (left: unknown, right: unknown): boolean =>
  canonical(left) === canonical(right);

/** A lost response is resolved by reading state, never by replaying the write. */
export function reconcileProviderWrite<A, E extends { readonly status?: number | undefined }>(
  write: Effect.Effect<A, E>,
  lookup: Effect.Effect<A | undefined, E>,
): Effect.Effect<A, E> {
  return write.pipe(
    Effect.catchIf(uncertainWrite, (error) =>
      lookup.pipe(
        Effect.flatMap((found) =>
          found === undefined ? Effect.fail(error) : Effect.succeed(found),
        ),
      ),
    ),
  );
}
