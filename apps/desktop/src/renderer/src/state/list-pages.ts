import { Effect } from "effect";
import type { ThreadQuery, ThreadSummary } from "../../../shared/api";

export interface Loaded {
  threads: readonly ThreadSummary[];
  pages: number;
  requested: number;
  done: boolean;
}
/** Refresh the loaded extent in one query, keeping offscreen selections available. */
export function refreshPages<E>(
  query: ThreadQuery,
  previous: Loaded,
  read: (q: ThreadQuery) => Effect.Effect<readonly ThreadSummary[], E>,
) {
  const limit = previous.threads.length || (query.search ? 200 : 100);
  return read({ ...query, limit }).pipe(
    Effect.map((threads) => ({
      ...previous,
      threads,
      done: threads.length < limit || (previous.threads.length > 0 && previous.done),
    })),
  );
}
