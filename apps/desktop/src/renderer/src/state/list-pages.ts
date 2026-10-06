import { Effect } from "effect";
import type { ThreadQuery, ThreadSummary } from "../../../shared/api";

export interface Loaded {
  threads: readonly ThreadSummary[];
  pages: number;
  requested: number;
  done: boolean;
  remoteDone?: boolean;
}

/** Ranked search order is not chronological. Grow and replace the candidate window. */
export function searchExtent<E>(
  query: ThreadQuery,
  pages: number,
  read: (q: ThreadQuery) => Effect.Effect<readonly ThreadSummary[], E>,
) {
  const limit = pages * 200;
  return read({ ...query, limit }).pipe(
    Effect.map((threads) => ({ threads, pages, requested: pages, done: threads.length < limit })),
  );
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

/** The deleted cursor is still a valid boundary, even after it disappears from the DB. */
export function pageAfterRemoval<E, R>(
  query: ThreadQuery,
  lastLoaded: Pick<ThreadSummary, "date" | "id">,
  read: (query: ThreadQuery) => Effect.Effect<readonly ThreadSummary[], E, R>,
) {
  return read({ ...query, before: lastLoaded.date, beforeId: lastLoaded.id, limit: 100 });
}
