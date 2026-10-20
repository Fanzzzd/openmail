/**
 * Moving from the search field to its results with the keyboard. Every path follows this rule.
 *
 * Down (no suggestions showing, text in the field) and Enter (the field's text already ran) ask
 * for the results of the text in the field. Down first runs the text, as Enter does, when it
 * changed since the last run. The request belongs to that text, and only the list of that text's
 * search answers it:
 *
 * - While that search's first page loads, or while it has no rows and its server search still
 *   runs, the request waits and focus stays in the field. The rows on screen meanwhile belong to
 *   the previous list, so they are never selected, focused or marked read. The list shows them
 *   dimmed and inert, so a click, a tap or Tab can't reach them either.
 * - Once rows arrive, a selected row among them stays selected and takes focus. Otherwise the
 *   first row becomes the keyboard selection and takes focus, as Down in the list makes it, and
 *   the Reading setting marks it read.
 * - With no rows, a failed load or an invalid search, nothing is selected and focus stays in the
 *   field.
 * - When the field's text changes before the answer (typing, a chip edit, Escape) or focus leaves
 *   the field, the request is dropped and nothing moves.
 *
 * Focus is therefore in the field or on the chosen row. It never lands on the page body or on a
 * list with nothing selected.
 */
import type { Selection } from "../../lib/selection";
import type { ThreadList } from "../../state/threads";

export interface ResultsRequest {
  /** The field's text when the request was made, after it ran. */
  readonly search: string;
  /** What had focus: the search field. */
  readonly from: Element | null;
}

export type ResultsEntry =
  | { readonly kind: "wait" }
  | { readonly kind: "drop" }
  /** `kept`: the row was already selected, so the selection stays as it is. */
  | { readonly kind: "enter"; readonly id: string; readonly kept: boolean };

export function resultsEntry(
  request: ResultsRequest,
  now: {
    readonly search: string;
    readonly active: Element | null;
    readonly list: Pick<
      ThreadList,
      "threads" | "loading" | "loadError" | "searchingServer" | "searchInputInvalid"
    >;
    readonly selection: Selection;
  },
): ResultsEntry {
  const { list, selection } = now;
  if (now.search !== request.search || now.active !== request.from) return { kind: "drop" };
  if (list.loadError || list.searchInputInvalid) return { kind: "drop" };
  if (list.loading) return { kind: "wait" };
  const first = list.threads[0];
  if (!first) return list.searchingServer ? { kind: "wait" } : { kind: "drop" };
  const ids = new Set(list.threads.map((row) => row.id));
  const kept =
    selection.focus !== null && ids.has(selection.focus)
      ? selection.focus
      : [...selection.ids].find((id) => ids.has(id));
  return kept
    ? { kind: "enter", id: kept, kept: true }
    : { kind: "enter", id: first.id, kept: false };
}
