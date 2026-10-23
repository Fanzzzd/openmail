import { Effect } from "effect";
import type { ThreadQuery, ThreadSummary } from "../../../shared/api";

/** Rows in one page of a date-ordered list. */
export const PAGE = 100;

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
/**
 * Refresh the loaded extent in one query, keeping offscreen selections available.
 *
 * `reach` is how many rows the list can show without paging: down to its window's last row or
 * its last selected row. A date-ordered list then reads only through the page after that row and
 * leaves the deeper pages to load again on scroll, so a refresh costs the same with 2,000 rows
 * loaded as with 100. Before, a list scrolled down 2,000 rows read and sent all of them (1.6 MB)
 * on every change. Ranked search keeps its whole window.
 */
export function refreshPages<E>(
  query: ThreadQuery,
  previous: Loaded,
  read: (q: ThreadQuery) => Effect.Effect<readonly ThreadSummary[], E>,
  reach?: number,
) {
  const loaded = previous.threads.length;
  const kept =
    reach === undefined || query.search !== undefined
      ? loaded
      : Math.min(loaded, (Math.floor(Math.max(0, reach) / PAGE) + 2) * PAGE);
  const limit = kept || (query.search ? 200 : PAGE);
  const trimmed = kept < loaded;
  return read({ ...query, limit }).pipe(
    Effect.map((threads) => ({
      ...previous,
      threads,
      pages: trimmed ? Math.ceil(kept / PAGE) : previous.pages,
      done: threads.length < limit || (!trimmed && loaded > 0 && previous.done),
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
