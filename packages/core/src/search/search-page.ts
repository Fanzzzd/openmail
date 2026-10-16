/** Paging through search results that are read whole and shown a page at a time. */
import { sqliteTextCompare } from "../store/sql-rows.js";

/**
 * Where a search page stopped. A date-ordered result continues after the last row shown, its
 * `date` and `id`, like a list cursor: a message that disappears between pages (archived
 * elsewhere, then synced) skips nothing. Results ranked by relevance, such as attachment-text
 * matches, have no date order to continue from and keep a position, `offset`.
 */
export type SearchCursor = {
  readonly offset?: number;
  readonly date?: number;
  readonly id?: string;
};

type Row = { readonly date: number; readonly id: string };

/** The rows left to show, and the cursor after showing the first `shown` of them. */
export type SearchRest<A> = {
  readonly rows: readonly A[];
  readonly next: (shown: number) => SearchCursor | null;
};

/** List order: newest first, then the larger id, as SQLite compares text. */
const before = (a: Row, b: Row) =>
  a.date > b.date || (a.date === b.date && sqliteTextCompare(a.id, b.id) > 0);

/**
 * The rows after `cursor`, in result order, and the cursor for the page that shows the first
 * `shown` of them. Null when nothing is left after that page.
 */
export function searchRest<A extends Row>(rows: readonly A[], cursor: SearchCursor): SearchRest<A> {
  const { date, id, offset = 0 } = cursor;
  const last = date !== undefined && id !== undefined ? { date, id } : undefined;
  const keyed =
    last !== undefined ||
    (offset === 0 && rows.every((row, i) => i === 0 || before(rows[i - 1] ?? row, row)));
  const rest = last ? rows.filter((row) => before(last, row)) : rows.slice(offset);
  return {
    rows: rest,
    next: (shown) => {
      const end = rest[shown - 1];
      if (shown >= rest.length) return null;
      return keyed && end ? { date: end.date, id: end.id } : { offset: offset + shown };
    },
  };
}
